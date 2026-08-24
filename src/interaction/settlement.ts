export class InteractionSettlementError extends Error {
  constructor(
    message: string,
    readonly code: 'DUPLICATE_ID' | 'REGISTRY_DISPOSED',
  ) {
    super(message)
    this.name = 'InteractionSettlementError'
  }
}

interface Pending<T> {
  readonly resolve: (value: T) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

export interface InteractionFallbacks<T> {
  readonly aborted: T
  readonly disposed: T
}

/**
 * Owns the non-serializable promise side of question/approval interactions.
 * Entries are deleted before resolution, so abort, answer, and disposal race
 * to exactly one outcome.
 */
export class InteractionSettlement<T> {
  private readonly pending = new Map<string, Pending<T>>()
  private disposed = false

  constructor(private readonly fallbacks: InteractionFallbacks<T>) {}

  get pendingCount(): number {
    return this.pending.size
  }

  open(id: string, signal?: AbortSignal): Promise<T> {
    if (this.disposed) {
      throw new InteractionSettlementError(
        'cannot open an interaction after registry disposal',
        'REGISTRY_DISPOSED',
      )
    }
    if (this.pending.has(id)) {
      throw new InteractionSettlementError(
        `interaction "${id}" already exists`,
        'DUPLICATE_ID',
      )
    }

    return new Promise<T>((resolve) => {
      const onAbort = signal === undefined
        ? undefined
        : () => {
            this.settleKnown(id, this.fallbacks.aborted)
          }
      this.pending.set(id, {
        resolve,
        ...(signal === undefined ? {} : { signal }),
        ...(onAbort === undefined ? {} : { onAbort }),
      })
      if (signal !== undefined && onAbort !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }
    })
  }

  resolve(id: string, value: T): boolean {
    if (!this.pending.has(id)) return false
    this.settleKnown(id, value)
    return true
  }

  abort(id: string): boolean {
    if (!this.pending.has(id)) return false
    this.settleKnown(id, this.fallbacks.aborted)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const id of [...this.pending.keys()]) {
      this.settleKnown(id, this.fallbacks.disposed)
    }
  }

  private settleKnown(id: string, value: T): void {
    const entry = this.pending.get(id)!
    this.pending.delete(id)
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    entry.resolve(value)
  }
}
