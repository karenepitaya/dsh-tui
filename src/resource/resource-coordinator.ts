import type {
  ResourceScope,
  ResourceScopeKind,
  ScopeDisposer,
} from '../lifecycle/scope-manager.ts'

export type ResourceActivation = 'eager' | 'on-open' | 'on-visible' | 'manual'
export type ResourceCachePolicy = 'none' | 'last-good'
export type ResourcePhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'refreshing'
  | 'failed'

export interface ResourceLoadContext<T> {
  readonly scope: ResourceScope
  readonly signal: AbortSignal
  readonly requestId: number
  readonly previous: T | undefined
}

export interface ResourceWatchContext {
  readonly scope: ResourceScope
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

export interface ResourceDefinition<T> {
  readonly key: string
  readonly lifetime: ResourceScopeKind
  readonly activation: ResourceActivation
  readonly cachePolicy: ResourceCachePolicy
  readonly load: (context: ResourceLoadContext<T>) => T | Promise<T>
  readonly watch?: (context: ResourceWatchContext) => void | ScopeDisposer
}

export interface ResourceSnapshot<T> {
  readonly phase: ResourcePhase
  readonly requestId: number
  readonly scopeEpoch: number
  readonly value?: T
  readonly lastGood?: T
  readonly error?: unknown
}

export type ResourceSnapshotListener<T> = (snapshot: ResourceSnapshot<T>) => void

interface ActiveRequest<T> {
  readonly requestId: number
  readonly abort: AbortController
  readonly task: Promise<ResourceSnapshot<T>>
  readonly detachScopeAbort: () => void
}

interface ResourceEntry<T> {
  readonly scope: ResourceScope
  readonly scopeEpoch: number
  readonly definition: ResourceDefinition<T>
  requestId: number
  snapshot: ResourceSnapshot<T>
  active: ActiveRequest<T> | undefined
  watching: boolean
  stopWatch: ScopeDisposer | undefined
  hasLastGood: boolean
  lastGood: T | undefined
  released: boolean
  readonly listeners: Set<ResourceSnapshotListener<T>>
}

type UnknownEntry = ResourceEntry<unknown>

function idleSnapshot<T>(scope: ResourceScope): ResourceSnapshot<T> {
  return Object.freeze({
    phase: 'idle',
    requestId: 0,
    scopeEpoch: scope.epoch,
  })
}

/**
 * Coordinates lazy resources inside explicit scopes.
 *
 * The coordinator owns no process-global registry. Cache identity is exactly
 * `(scope object, definition.key)`, and every entry is released by that scope.
 */
export class ResourceCoordinator {
  private readonly entries = new WeakMap<ResourceScope, Map<string, UnknownEntry>>()

  /** Read or register a scoped resource without activating its loader. */
  get<T>(
    scope: ResourceScope,
    definition: ResourceDefinition<T>,
  ): ResourceSnapshot<T> {
    return this.entry(scope, definition).snapshot
  }

  /** Observe future state changes without activating the resource. */
  subscribe<T>(
    scope: ResourceScope,
    definition: ResourceDefinition<T>,
    listener: ResourceSnapshotListener<T>,
  ): () => void {
    const entry = this.entry(scope, definition)
    entry.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      entry.listeners.delete(listener)
    }
  }

  /** Load once; concurrent callers for the same scoped key share one task. */
  activate<T>(
    scope: ResourceScope,
    definition: ResourceDefinition<T>,
  ): Promise<ResourceSnapshot<T>> {
    const entry = this.entry(scope, definition)
    if (!this.startWatch(entry)) return Promise.resolve(entry.snapshot)
    if (entry.active !== undefined) return entry.active.task
    if (entry.snapshot.phase !== 'idle') return Promise.resolve(entry.snapshot)
    return this.startLoad(entry)
  }

  /** Supersede any active request; only this request id may publish a result. */
  refresh<T>(
    scope: ResourceScope,
    definition: ResourceDefinition<T>,
  ): Promise<ResourceSnapshot<T>> {
    const entry = this.entry(scope, definition)
    if (!this.startWatch(entry)) return Promise.resolve(entry.snapshot)
    entry.active?.abort.abort(`resource ${definition.key} refresh superseded`)
    entry.active?.detachScopeAbort()
    return this.startLoad(entry)
  }

  /** Release one activated definition without disposing its containing scope. */
  release<T>(
    scope: ResourceScope,
    definition: ResourceDefinition<T>,
  ): Promise<void> {
    const entry = this.entries.get(scope)?.get(definition.key)
    if (entry === undefined) return Promise.resolve()
    if (entry.definition !== definition) {
      throw new Error(
        `resource ${definition.key} is already defined in ${scope.kind} scope`,
      )
    }
    return this.releaseEntry(entry)
  }

  private entry<T>(
    scope: ResourceScope,
    definition: ResourceDefinition<T>,
  ): ResourceEntry<T> {
    this.assertCompatible(scope, definition)
    let scoped = this.entries.get(scope)
    const existing = scoped?.get(definition.key)
    if (existing !== undefined) {
      if (existing.definition !== definition) {
        throw new Error(
          `resource ${definition.key} is already defined in ${scope.kind} scope`,
        )
      }
      return existing as ResourceEntry<T>
    }

    scoped ??= new Map()
    this.entries.set(scope, scoped)
    const created: ResourceEntry<T> = {
      scope,
      scopeEpoch: scope.epoch,
      definition,
      requestId: 0,
      snapshot: idleSnapshot(scope),
      active: undefined,
      watching: false,
      stopWatch: undefined,
      hasLastGood: false,
      lastGood: undefined,
      released: false,
      listeners: new Set(),
    }
    scoped.set(definition.key, created as UnknownEntry)
    scope.defer(() => this.releaseEntry(created))
    return created
  }

  private assertCompatible<T>(
    scope: ResourceScope,
    definition: ResourceDefinition<T>,
  ): void {
    if (scope.disposed || scope.signal.aborted) {
      throw new Error(`${scope.kind} scope is disposed`)
    }
    if (scope.kind !== definition.lifetime) {
      throw new Error(
        `resource ${definition.key} requires ${definition.lifetime} scope, received ${scope.kind} scope`,
      )
    }
  }

  private startWatch<T>(entry: ResourceEntry<T>): boolean {
    if (entry.watching) return true
    entry.watching = true
    const watch = entry.definition.watch
    if (watch === undefined) return true
    try {
      const stop = watch({
        scope: entry.scope,
        signal: entry.scope.signal,
        invalidate: () => {
          if (entry.released || entry.scope.disposed) return
          void this.refresh(entry.scope, entry.definition)
        },
      })
      if (stop !== undefined) entry.stopWatch = stop
      return true
    } catch (error: unknown) {
      entry.watching = false
      entry.snapshot = this.errorSnapshot(entry, error)
      this.publish(entry)
      return false
    }
  }

  private startLoad<T>(entry: ResourceEntry<T>): Promise<ResourceSnapshot<T>> {
    const requestId = ++entry.requestId
    const abort = new AbortController()
    const onScopeAbort = (): void => { abort.abort(entry.scope.signal.reason) }
    const detachScopeAbort = (): void => {
      entry.scope.signal.removeEventListener('abort', onScopeAbort)
    }
    entry.scope.signal.addEventListener('abort', onScopeAbort, { once: true })
    const keepLastGood = entry.definition.cachePolicy === 'last-good'
      && entry.hasLastGood
    entry.snapshot = keepLastGood
      ? Object.freeze({
          phase: 'refreshing',
          requestId,
          scopeEpoch: entry.scopeEpoch,
          value: entry.lastGood as T,
          lastGood: entry.lastGood as T,
        })
      : Object.freeze({
          phase: 'loading',
          requestId,
          scopeEpoch: entry.scopeEpoch,
        })
    this.publish(entry)

    let task!: Promise<ResourceSnapshot<T>>
    task = Promise.resolve()
      .then(() => entry.definition.load({
        scope: entry.scope,
        signal: abort.signal,
        requestId,
        previous: entry.hasLastGood ? entry.lastGood : undefined,
      }))
      .then(
        value => this.commitValue(entry, requestId, value),
        (error: unknown) => this.commitError(entry, requestId, error),
      )
      .finally(() => {
        detachScopeAbort()
        if (entry.active?.requestId === requestId) entry.active = undefined
      })
    entry.active = { requestId, abort, task, detachScopeAbort }
    return task
  }

  private commitValue<T>(
    entry: ResourceEntry<T>,
    requestId: number,
    value: T,
  ): ResourceSnapshot<T> {
    if (!this.isCurrent(entry, requestId)) return entry.snapshot
    entry.hasLastGood = entry.definition.cachePolicy === 'last-good'
    entry.lastGood = entry.hasLastGood ? value : undefined
    entry.snapshot = Object.freeze({
      phase: 'ready',
      requestId,
      scopeEpoch: entry.scopeEpoch,
      value,
      ...(entry.hasLastGood ? { lastGood: value } : {}),
    })
    this.publish(entry)
    return entry.snapshot
  }

  private commitError<T>(
    entry: ResourceEntry<T>,
    requestId: number,
    error: unknown,
  ): ResourceSnapshot<T> {
    if (!this.isCurrent(entry, requestId)) return entry.snapshot
    entry.snapshot = this.errorSnapshot(entry, error)
    this.publish(entry)
    return entry.snapshot
  }

  private errorSnapshot<T>(
    entry: ResourceEntry<T>,
    error: unknown,
  ): ResourceSnapshot<T> {
    const retain = entry.definition.cachePolicy === 'last-good' && entry.hasLastGood
    return Object.freeze({
      phase: 'failed',
      requestId: entry.requestId,
      scopeEpoch: entry.scopeEpoch,
      error,
      ...(retain
        ? { value: entry.lastGood as T, lastGood: entry.lastGood as T }
        : {}),
    })
  }

  private isCurrent<T>(entry: ResourceEntry<T>, requestId: number): boolean {
    return !entry.released
      && !entry.scope.disposed
      && entry.scope.epoch === entry.scopeEpoch
      && entry.requestId === requestId
      && entry.active?.requestId === requestId
  }

  private publish<T>(entry: ResourceEntry<T>): void {
    for (const listener of [...entry.listeners]) {
      try {
        listener(entry.snapshot)
      } catch {
        // Presentation listeners cannot poison resource state or loader ownership.
      }
    }
  }

  private async releaseEntry<T>(entry: ResourceEntry<T>): Promise<void> {
    if (entry.released) return
    entry.released = true
    const active = entry.active
    entry.active = undefined
    active?.abort.abort(`resource ${entry.definition.key} scope disposed`)
    active?.detachScopeAbort()
    const stop = entry.stopWatch
    entry.stopWatch = undefined
    entry.listeners.clear()
    this.entries.get(entry.scope)?.delete(entry.definition.key)
    await stop?.()
  }
}
