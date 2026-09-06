import type {
  CapabilityLease,
  CapabilityToken,
  MaybePromise,
} from './capability.ts'
import type {
  FeatureCreateContext,
  FeatureContributions,
  FeatureFactory,
  FeatureInstance,
  FeatureScope,
  ResolvedFeatureDependency,
} from './feature.ts'
import {
  FeatureRegistry,
  type FeatureRegistrationProvenance,
  type RegisteredFeatureSnapshot,
  type RegisteredFeatureFactory,
} from './feature-registry.ts'
import { normalizeFeatureContributions } from './feature-contribution-normalizer.ts'
import type {
  ResourceScope,
  ScopeManager,
} from '../lifecycle/scope-manager.ts'

/** The factory receives resolved declared values, never the ambient resolver. */
export type FeatureFactoryContext = FeatureCreateContext

export interface FeatureCapabilityResolver {
  resolve<TValue>(
    token: CapabilityToken<TValue>,
    scope: ResourceScope,
  ): MaybePromise<CapabilityLease<TValue>>
}

export type FeatureRuntimeState = 'inactive' | 'activating' | 'active' | 'unavailable'

export interface FeatureStatus {
  readonly featureId: string
  readonly state: FeatureRuntimeState
  readonly error?: unknown
}

export interface ActiveFeatureContributions {
  readonly featureId: string
  readonly provenance: FeatureRegistrationProvenance
  readonly contributions: FeatureContributions
}

export interface ActiveFeatureUnloadedEvent {
  readonly type: 'active-feature-unloaded'
  readonly featureId: string
  readonly fallbackRoute: 'chat'
  readonly restoreFocus: true
}

export interface RequiredFeatureFailureEvent {
  readonly type: 'required-feature-failure'
  readonly featureId: string
  readonly reason: 'activation' | 'capability-invalidated'
  readonly error: unknown
}

export interface FeatureSupervisorOptions {
  readonly registry: FeatureRegistry
  readonly scopeManager: ScopeManager
  /** This supervisor owns exactly one Feature lifetime domain. */
  readonly featureScope?: FeatureScope
  readonly sessionScope?: ResourceScope
  readonly capabilities: FeatureCapabilityResolver
  readonly normalizeContributions?: FeatureContributionNormalizer
  /** Session supervisors emit recovery semantics when their lifetime ends. */
  readonly notifyActiveFeatureUnloadedOnRelease?: boolean
  readonly onActiveFeatureUnloaded?: (
    event: ActiveFeatureUnloadedEvent,
  ) => MaybePromise<void>
  readonly onRequiredFeatureFailure?: (
    event: RequiredFeatureFailureEvent,
  ) => MaybePromise<void>
}

export type FeatureContributionNormalizer = (
  factory: RegisteredFeatureSnapshot,
  contributions: FeatureContributions,
  provenance: FeatureRegistrationProvenance,
) => MaybePromise<FeatureContributions>

export class FeatureActivationError extends Error {
  readonly featureId: string
  readonly required: boolean

  constructor(featureId: string, required: boolean, cause: unknown) {
    super(`Feature "${featureId}" failed to activate`, { cause })
    this.name = 'FeatureActivationError'
    this.featureId = featureId
    this.required = required
  }
}

interface ActiveFeatureRecord {
  readonly featureId: string
  readonly factory: RegisteredFeatureFactory
  readonly snapshot: RegisteredFeatureSnapshot
  readonly provenance: FeatureRegistrationProvenance
  readonly instance: FeatureInstance
  readonly contributions: FeatureContributions
  readonly capabilityLeases: readonly CapabilityLease<unknown>[]
  release: () => Promise<void>
}

export class FeatureSupervisor {
  readonly #registry: FeatureRegistry
  readonly #scopeManager: ScopeManager
  readonly #featureScope: FeatureScope
  readonly #sessionScope: ResourceScope | undefined
  readonly #capabilities: FeatureCapabilityResolver
  readonly #normalizeContributions: FeatureContributionNormalizer | undefined
  readonly #notifyActiveFeatureUnloadedOnRelease: boolean
  readonly #onActiveFeatureUnloaded: (
    event: ActiveFeatureUnloadedEvent,
  ) => MaybePromise<void>
  readonly #onRequiredFeatureFailure: (
    event: RequiredFeatureFailureEvent,
  ) => MaybePromise<void>
  readonly #states = new Map<string, FeatureStatus>()
  readonly #active = new Map<string, ActiveFeatureRecord>()
  readonly #activationOrder: ActiveFeatureRecord[] = []
  readonly #activationTasks = new Map<string, Promise<FeatureStatus>>()
  readonly #retirementTasks = new Map<string, Promise<void>>()
  readonly #unloadNotified = new WeakSet<ActiveFeatureRecord>()
  readonly #requiredFailureNotified = new WeakSet<ActiveFeatureRecord>()
  readonly #stopObservingRegistry: () => void
  #disposed = false
  #disposeTask: Promise<void> | undefined

  constructor(options: FeatureSupervisorOptions) {
    this.#registry = options.registry
    this.#scopeManager = options.scopeManager
    this.#featureScope = options.featureScope ?? 'application'
    this.#sessionScope = options.sessionScope
    if (this.#featureScope === 'session' && this.#sessionScope === undefined) {
      throw new Error('Session Feature supervisor requires an active session scope')
    }
    if (this.#sessionScope !== undefined) {
      assertOwnedActiveSessionScope(this.#sessionScope, this.#scopeManager)
    }
    this.#capabilities = options.capabilities
    this.#normalizeContributions = options.normalizeContributions
    this.#notifyActiveFeatureUnloadedOnRelease =
      options.notifyActiveFeatureUnloadedOnRelease ?? false
    this.#onActiveFeatureUnloaded = options.onActiveFeatureUnloaded ?? (() => {})
    this.#onRequiredFeatureFailure = options.onRequiredFeatureFailure ?? (() => {})
    this.#stopObservingRegistry = this.#registry.onUnregistered(
      factory => this.#beginFactoryRetirement(factory),
    )
  }

  status(featureId: string): FeatureStatus | undefined {
    if (this.#disposed) return undefined
    const state = this.#states.get(featureId)
    if (state !== undefined) return state
    const snapshot = this.#registry.snapshotOf(featureId)
    if (snapshot === undefined || snapshot.manifest.scope !== this.#featureScope) return undefined
    return { featureId, state: 'inactive' }
  }

  contributionsFor(featureId: string): FeatureContributions | undefined {
    return this.#active.get(featureId)?.contributions
  }

  listActiveContributions(): readonly ActiveFeatureContributions[] {
    return Object.freeze(this.#activationOrder.map(record => Object.freeze({
        featureId: record.featureId,
        provenance: record.provenance,
        contributions: record.contributions,
      })))
  }

  async start(): Promise<readonly FeatureStatus[]> {
    return this.#activateMatching(snapshot => snapshot.manifest.activation === 'eager', false)
  }

  async activateCommand(commandId: string): Promise<readonly FeatureStatus[]> {
    return this.#activateMatching(snapshot => snapshot.manifest.activation === 'on-command'
      && snapshot.declarations.commands.includes(commandId), true)
  }

  async activateRoute(route: string): Promise<readonly FeatureStatus[]> {
    return this.#activateMatching(snapshot => snapshot.manifest.activation === 'on-route'
      && snapshot.declarations.routes.includes(route), true)
  }

  async activateFeature(featureId: string): Promise<FeatureStatus> {
    return this.#activateFeature(featureId, true)
  }

  async #activateFeature(
    featureId: string,
    notifyRequiredFailure: boolean,
  ): Promise<FeatureStatus> {
    this.#assertUsable()
    let factory = this.#requireManagedFeature(featureId)
    const retirement = this.#retirementTasks.get(featureId)
    if (retirement !== undefined) {
      try {
        await retirement
      } catch {
        // The unregistering caller observes retirement failures. A replacement
        // factory may still activate once ownership has been torn down.
      }
      this.#assertUsable()
      factory = this.#requireManagedFeature(featureId)
    }
    const active = this.#states.get(featureId)
    if (active?.state === 'active') return active
    if (active?.state === 'unavailable') {
      const snapshot = this.#registry.snapshotOf(featureId)
      if (snapshot?.manifest.required === true) {
        throw new FeatureActivationError(featureId, true, active.error)
      }
      return active
    }
    const pending = this.#activationTasks.get(featureId)
    if (pending !== undefined) return pending

    let resolveTask!: (status: FeatureStatus) => void
    let rejectTask!: (error: unknown) => void
    const task = new Promise<FeatureStatus>((resolve, reject) => {
      resolveTask = resolve
      rejectTask = reject
    })
    this.#activationTasks.set(featureId, task)
    void this.#activateFactory(factory, notifyRequiredFailure).then(resolveTask, rejectTask)
    try {
      return await task
    } finally {
      this.#activationTasks.delete(featureId)
    }
  }

  dispose(): Promise<void> {
    this.#disposeTask ??= this.#runDispose()
    return this.#disposeTask
  }

  async #activateMatching(
    predicate: (snapshot: RegisteredFeatureSnapshot) => boolean,
    notifyRequiredFailure: boolean,
  ): Promise<readonly FeatureStatus[]> {
    this.#assertUsable()
    const results: FeatureStatus[] = []
    for (const factory of this.#registry.list()) {
      const snapshot = requireFactorySnapshot(this.#registry, factory)
      if (snapshot.manifest.scope === this.#featureScope && predicate(snapshot)) {
        results.push(await this.#activateFeature(snapshot.manifest.id, notifyRequiredFailure))
      }
    }
    return results
  }

  async #activateFactory(
    factory: RegisteredFeatureFactory,
    notifyRequiredFailure: boolean,
  ): Promise<FeatureStatus> {
    const snapshot = requireFactorySnapshot(this.#registry, factory)
    const provenance = requireFactoryProvenance(this.#registry, factory)
    const { manifest } = snapshot
    const state: FeatureStatus = { featureId: manifest.id, state: 'activating' }
    this.#states.set(manifest.id, state)
    const capabilityLeases: CapabilityLease<unknown>[] = []
    let instance: FeatureInstance | undefined
    let disposableInstance: Pick<FeatureInstance, 'dispose'> | undefined
    try {
      const featureScope = this.#scopeFor(manifest.scope)
      const dependencies: ResolvedFeatureDependency[] = []
      for (const token of manifest.requires) {
        const capabilityScope = this.#scopeFor(token.scope)
        const lease = await this.#capabilities.resolve(token, capabilityScope)
        capabilityLeases.push(lease)
        dependencies.push(Object.freeze({ token, value: lease.value }))
        this.#assertUsable()
      }
      const context: FeatureFactoryContext = Object.freeze({
        scope: featureScope,
        dependencies: Object.freeze(dependencies),
      })
      const typedFactory = factory as FeatureFactory
      const candidate: unknown = await typedFactory.create(context)
      if (hasFeatureDisposer(candidate)) disposableInstance = candidate
      instance = requireFeatureInstance(candidate)
      const structurallyNormalized = normalizeFeatureContributions(
        snapshot,
        instance.contributions,
      )
      const contributions = this.#normalizeContributions === undefined
        ? structurallyNormalized
        : normalizeFeatureContributions(
            snapshot,
            await this.#normalizeContributions(
              snapshot,
              structurallyNormalized,
              provenance,
            ),
          )
      if (this.#disposed) throw new Error('Feature supervisor is disposed')
      let record!: ActiveFeatureRecord
      let releaseTask: Promise<void> | undefined
      record = {
        featureId: manifest.id,
        factory,
        snapshot,
        provenance,
        instance,
        contributions,
        capabilityLeases,
        release: () => {
          releaseTask ??= this.#releaseRecord(record)
          return releaseTask
        },
      }
      featureScope.defer(() => record.release())
      this.#active.set(manifest.id, record)
      this.#activationOrder.push(record)
      const activated: FeatureStatus = { featureId: manifest.id, state: 'active' }
      this.#states.set(manifest.id, activated)
      for (const lease of capabilityLeases) {
        if (lease.invalidated !== undefined) {
          void Promise.resolve(lease.invalidated).then(
            () => this.#handleCapabilityInvalidated(record),
            () => this.#handleCapabilityInvalidated(record),
          )
        }
      }
      return activated
    } catch (error: unknown) {
      let failure = error
      try {
        await disposeOwned(disposableInstance, capabilityLeases)
      } catch (cleanupError: unknown) {
        failure = new AggregateError([error, cleanupError], `Feature "${manifest.id}" activation cleanup failed`)
      }
      const unavailable: FeatureStatus = {
        featureId: manifest.id,
        state: 'unavailable',
        error: failure,
      }
      this.#states.set(manifest.id, unavailable)
      if (manifest.required) {
        const activationError = new FeatureActivationError(manifest.id, true, failure)
        if (notifyRequiredFailure) {
          this.#notifyRequiredFeatureFailure({
            type: 'required-feature-failure',
            featureId: manifest.id,
            reason: 'activation',
            error: activationError,
          })
        }
        throw activationError
      }
      return unavailable
    }
  }

  #scopeFor(scope: 'application' | 'session'): ResourceScope {
    if (scope === 'application') return this.#scopeManager.app
    /* v8 ignore next 3 -- session supervisors require this scope at construction. */
    if (this.#sessionScope === undefined) {
      throw new Error('Session-scoped feature or capability requires a session scope')
    }
    assertOwnedActiveSessionScope(this.#sessionScope, this.#scopeManager)
    return this.#sessionScope
  }

  async #releaseRecord(record: ActiveFeatureRecord): Promise<void> {
    const errors: unknown[] = []
    try {
      await disposeOwned(record.instance, record.capabilityLeases)
    } catch (error: unknown) {
      errors.push(error)
    }
    /* v8 ignore else -- a record release is coalesced and only its exact publication can call here. */
    if (this.#active.get(record.featureId) === record) {
      this.#active.delete(record.featureId)
    }
    const activationIndex = this.#activationOrder.indexOf(record)
    /* v8 ignore else -- every published active record is inserted into activationOrder atomically. */
    if (activationIndex >= 0) this.#activationOrder.splice(activationIndex, 1)
    if (!this.#disposed && this.#active.get(record.featureId) === undefined) {
      const replacement = this.#registry.snapshotOf(record.featureId)
      if (replacement?.manifest.scope === this.#featureScope) {
        this.#states.set(record.featureId, { featureId: record.featureId, state: 'inactive' })
      } else {
        this.#states.delete(record.featureId)
      }
    }
    if (this.#notifyActiveFeatureUnloadedOnRelease) {
      try {
        await this.#notifyActiveFeatureUnloaded(record)
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, `Feature "${record.featureId}" disposal failed`)
    }
  }

  #beginFactoryRetirement(factory: RegisteredFeatureFactory): Promise<void> {
    const snapshot = requireFactorySnapshot(this.#registry, factory)
    if (snapshot.manifest.scope !== this.#featureScope) return Promise.resolve()
    const featureId = snapshot.manifest.id
    const previous = this.#retirementTasks.get(featureId)
    const task = previous === undefined
      ? this.#handleFactoryUnregistered(factory)
      : previous.catch(() => {}).then(() => this.#handleFactoryUnregistered(factory))
    this.#retirementTasks.set(featureId, task)
    void task.finally(() => {
      if (this.#retirementTasks.get(featureId) === task) {
        this.#retirementTasks.delete(featureId)
      }
    }).catch(() => {})
    return task
  }

  async #handleFactoryUnregistered(factory: RegisteredFeatureFactory): Promise<void> {
    const featureId = requireFactorySnapshot(this.#registry, factory).manifest.id
    const activation = this.#activationTasks.get(featureId)
    if (activation !== undefined) {
      try {
        await activation
      } catch {
        // Required activation failure is already represented by supervisor state.
      }
    }
    const record = this.#active.get(featureId)
    if (record?.factory !== factory) {
      const replacement = this.#registry.snapshotOf(featureId)
      if (!this.#disposed && replacement?.manifest.scope === this.#featureScope) {
        this.#states.set(featureId, { featureId, state: 'inactive' })
      } else {
        this.#states.delete(featureId)
      }
      return
    }

    const errors: unknown[] = []
    try {
      await record.release()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await this.#notifyActiveFeatureUnloaded(record)
    } catch (error: unknown) {
      errors.push(error)
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, `Feature "${featureId}" unload failed`)
    }
  }

  async #handleCapabilityInvalidated(record: ActiveFeatureRecord): Promise<void> {
    if (this.#disposed || this.#active.get(record.featureId) !== record) return
    const errors: unknown[] = []
    try {
      await record.release()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await this.#notifyActiveFeatureUnloaded(record)
    } catch (error: unknown) {
      errors.push(error)
    }
    if (!this.#disposed && this.#registry.get(record.featureId) === record.factory) {
      const error = errors.length === 0
        ? new Error(`Feature "${record.featureId}" lost a required capability`)
        : new AggregateError(errors, `Feature "${record.featureId}" capability invalidation failed`)
      this.#states.set(record.featureId, {
        featureId: record.featureId,
        state: 'unavailable',
        error,
      })
      if (record.snapshot.manifest.required
        && !this.#requiredFailureNotified.has(record)) {
        this.#requiredFailureNotified.add(record)
        this.#notifyRequiredFeatureFailure({
          type: 'required-feature-failure',
          featureId: record.featureId,
          reason: 'capability-invalidated',
          error,
        })
      }
    }
  }

  #notifyRequiredFeatureFailure(event: RequiredFeatureFailureEvent): void {
    try {
      void Promise.resolve(this.#onRequiredFeatureFailure(event)).catch(() => {})
    } catch {
      // Fatal notification is containment-only. The original Feature failure
      // remains observable through activation/status without a second rejection.
    }
  }

  async #notifyActiveFeatureUnloaded(record: ActiveFeatureRecord): Promise<void> {
    if (this.#unloadNotified.has(record)) return
    this.#unloadNotified.add(record)
    await this.#onActiveFeatureUnloaded({
      type: 'active-feature-unloaded',
      featureId: record.featureId,
      fallbackRoute: 'chat',
      restoreFocus: true,
    })
  }

  async #runDispose(): Promise<void> {
    this.#disposed = true
    this.#stopObservingRegistry()
    await Promise.allSettled([...this.#activationTasks.values()])
    await Promise.allSettled([...this.#retirementTasks.values()])
    const errors: unknown[] = []
    const records = [...this.#activationOrder].reverse()
    for (const record of records) {
      try {
        await record.release()
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    this.#states.clear()
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'Feature supervisor disposal failed')
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error('Feature supervisor is disposed')
  }

  #requireManagedFeature(featureId: string): RegisteredFeatureFactory {
    const factory = this.#registry.get(featureId)
    if (factory === undefined) throw new Error(`Feature "${featureId}" is not registered`)
    const snapshot = requireFactorySnapshot(this.#registry, factory)
    if (snapshot.manifest.scope !== this.#featureScope) {
      throw new Error(
        `Feature "${featureId}" belongs to the ${snapshot.manifest.scope} supervisor`,
      )
    }
    return factory
  }
}

async function disposeOwned(
  instance: Pick<FeatureInstance, 'dispose'> | undefined,
  capabilityLeases: readonly CapabilityLease<unknown>[],
): Promise<void> {
  const errors: unknown[] = []
  if (instance !== undefined) {
    try {
      await instance.dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  for (let index = capabilityLeases.length - 1; index >= 0; index -= 1) {
    try {
      await capabilityLeases[index]!.release()
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  if (errors.length !== 0) {
    throw new AggregateError(errors, 'Feature-owned resources failed to dispose')
  }
}

function requireFeatureInstance(value: unknown): FeatureInstance {
  if (value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || !('contributions' in value)
    || value.contributions === null
    || typeof value.contributions !== 'object'
    || Array.isArray(value.contributions)
    || typeof (value as Partial<FeatureInstance>).dispose !== 'function') {
    throw new TypeError('Feature factory returned an invalid instance')
  }
  return value as FeatureInstance
}

function hasFeatureDisposer(
  value: unknown,
): value is Pick<FeatureInstance, 'dispose'> {
  return value !== null
    && typeof value === 'object'
    && typeof (value as Partial<FeatureInstance>).dispose === 'function'
}

function requireFactorySnapshot(
  registry: FeatureRegistry,
  factory: RegisteredFeatureFactory,
): RegisteredFeatureSnapshot {
  const snapshot = registry.snapshotOf(factory)
  /* v8 ignore next 3 -- registry listeners and list() only expose registered identities. */
  if (snapshot === undefined) {
    throw new Error('Registered feature has no immutable snapshot')
  }
  return snapshot
}

function requireFactoryProvenance(
  registry: FeatureRegistry,
  factory: RegisteredFeatureFactory,
): FeatureRegistrationProvenance {
  const provenance = registry.provenanceOf(factory)
  /* v8 ignore next 3 -- registry listeners and list() only expose registered identities. */
  if (provenance === undefined) {
    throw new Error('Registered feature has no registration provenance')
  }
  return provenance
}

function assertOwnedActiveSessionScope(
  scope: ResourceScope,
  manager: ScopeManager,
): void {
  if (scope.kind !== 'session'
    || scope.parent !== manager.app
    || scope.disposed
    || scope.signal.aborted) {
    throw new Error(
      'Feature supervisor requires an active session scope owned by its scope manager',
    )
  }
}
