export type ResourceScopeKind =
  | 'app'
  | 'session'
  | 'surface'
  | 'overlay'
  | 'request'
  | 'motion'

export type ScopeDisposer = () => void | Promise<void>

type ScopeEntry = {
  active: boolean
  readonly release: () => Promise<void>
  readonly detach: () => void
}

const CHILD_KINDS: Readonly<Record<ResourceScopeKind, readonly ResourceScopeKind[]>> =
  Object.freeze({
    app: ['session'],
    session: ['surface', 'request'],
    surface: ['overlay', 'request', 'motion'],
    overlay: ['request', 'motion'],
    request: ['motion'],
    motion: [],
  })

/**
 * A hierarchical owner for abortable work and cleanup callbacks.
 *
 * Scopes never use process-global state. Each ScopeManager allocates its own
 * epochs, so two Cordis/application compositions remain completely isolated.
 */
export class ResourceScope {
  readonly id: string
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly entries = new Set<ScopeEntry>()
  private disposeTask: Promise<void> | undefined
  private parentAbortListener: (() => void) | undefined
  private parentOwnerEntry: ScopeEntry | undefined

  constructor(
    private readonly manager: ScopeManager,
    readonly kind: ResourceScopeKind,
    readonly epoch: number,
    readonly label: string,
    readonly parent: ResourceScope | undefined,
  ) {
    this.id = `${kind}:${epoch}:${label}`
    this.signal = this.controller.signal
    if (parent !== undefined) {
      const onParentAbort = (): void => {
        this.abort(parent.signal.reason)
      }
      this.parentAbortListener = onParentAbort
      parent.signal.addEventListener('abort', onParentAbort, { once: true })
    }
  }

  get disposed(): boolean {
    return this.disposeTask !== undefined
  }

  child(kind: ResourceScopeKind, label: string): ResourceScope {
    this.assertActive()
    if (!CHILD_KINDS[this.kind].includes(kind)) {
      throw new Error(`${this.kind} scope cannot own ${kind} scope`)
    }
    const child = this.manager.createScope(kind, label, this)
    child.parentOwnerEntry = this.own(() => child.dispose(this.signal.reason))
    return child
  }

  /** Register an owned resource and return an idempotent early-release hook. */
  defer(disposer: ScopeDisposer): () => Promise<void> {
    this.assertActive()
    return this.own(disposer).release
  }

  private own(disposer: ScopeDisposer): ScopeEntry {
    let releaseTask: Promise<void> | undefined
    const entry: ScopeEntry = {
      active: true,
      detach: () => {
        if (!entry.active) return
        entry.active = false
        this.entries.delete(entry)
      },
      release: () => {
        if (releaseTask !== undefined) return releaseTask
        if (!entry.active) return Promise.resolve()
        entry.detach()
        releaseTask = (async () => { await disposer() })()
        return releaseTask
      },
    }
    this.entries.add(entry)
    return entry
  }

  dispose(reason: unknown = `${this.kind} scope disposed`): Promise<void> {
    this.disposeTask ??= this.runDispose(reason)
    return this.disposeTask
  }

  /**
   * Broadcast cancellation without running owned cleanup yet. The eventual
   * dispose() call remains the single cleanup authority.
   */
  abort(reason: unknown = `${this.kind} scope aborted`): void {
    if (!this.signal.aborted) this.controller.abort(reason)
  }

  private async runDispose(reason: unknown): Promise<void> {
    this.abort(reason)
    this.detachParentAbortListener()
    const errors: unknown[] = []
    for (const entry of [...this.entries].reverse()) {
      try {
        await entry.release()
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    this.entries.clear()
    this.parentOwnerEntry?.detach()
    this.parentOwnerEntry = undefined
    if (errors.length !== 0) {
      throw new AggregateError(errors, `${this.kind} scope disposal failed`)
    }
  }

  private detachParentAbortListener(): void {
    const listener = this.parentAbortListener
    this.parentAbortListener = undefined
    if (listener !== undefined) this.parent?.signal.removeEventListener('abort', listener)
  }

  private assertActive(): void {
    if (this.disposeTask !== undefined || this.signal.aborted) {
      throw new Error(`${this.kind} scope is disposed`)
    }
  }
}

/** Application-local scope factory and root owner. */
export class ScopeManager {
  readonly app: ResourceScope
  private nextEpoch = 0

  constructor(label = 'app') {
    this.app = this.createScope('app', label, undefined)
  }

  createSession(label: string): ResourceScope {
    return this.app.child('session', label)
  }

  dispose(reason: unknown = 'application scope disposed'): Promise<void> {
    return this.app.dispose(reason)
  }

  abort(reason: unknown = 'application scope aborted'): void {
    this.app.abort(reason)
  }

  /** @internal Scope construction stays manager-local to avoid global identity. */
  createScope(
    kind: ResourceScopeKind,
    label: string,
    parent: ResourceScope | undefined,
  ): ResourceScope {
    return new ResourceScope(this, kind, ++this.nextEpoch, label, parent)
  }
}
