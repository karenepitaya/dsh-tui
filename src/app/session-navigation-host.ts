import type {
  SessionNavigationCancellation,
  SessionNavigationPort,
  SessionNavigationRequest,
  SessionNavigationSnapshot,
} from '../session/navigation-port.ts'

interface NavigationBinding {
  readonly port: SessionNavigationPort
  readonly abort: AbortController
  pending: boolean
  pendingCancellation?: SessionNavigationCancellation
}

/** App-scoped bridge to the current Controller, never a process-wide singleton. */
export class SessionNavigationHost implements SessionNavigationPort {
  private current: NavigationBinding | undefined

  bind(port: SessionNavigationPort): () => void {
    if (this.current !== undefined) throw new Error('Session navigation is already bound')
    const binding: NavigationBinding = { port, abort: new AbortController(), pending: false }
    this.current = binding
    return () => {
      if (this.current !== binding) return
      this.current = undefined
      const reason = new Error('Session navigation Controller was unbound')
      const cancellation = binding.pendingCancellation
      delete binding.pendingCancellation
      try {
        cancellation?.cancel(reason)
      } catch {
        // Product cancellation still proceeds if an optional Feature sink rejects notification.
      }
      binding.abort.abort(reason)
    }
  }

  snapshot(): SessionNavigationSnapshot {
    const binding = this.current
    if (binding === undefined) return Object.freeze({ busy: true })
    const snapshot = binding.port.snapshot()
    return Object.freeze({ ...snapshot, busy: binding.pending || snapshot.busy })
  }

  /** Product-side Shell cancellation; deliberately absent from the Feature capability. */
  cancelPending(reason: unknown): boolean {
    const binding = this.current
    const cancellation = binding?.pendingCancellation
    if (binding === undefined || cancellation === undefined) return false
    delete binding.pendingCancellation
    try {
      cancellation.cancel(reason)
      return true
    } catch {
      return false
    }
  }

  async navigate(request: SessionNavigationRequest): Promise<void> {
    request.signal.throwIfAborted()
    const binding = this.current
    if (binding === undefined) throw new Error('Session navigation is unavailable')
    if (this.snapshot().busy) throw new Error('Session navigation is busy')
    binding.pending = true
    const cancellation = request.cancellation
    if (cancellation !== undefined) binding.pendingCancellation = cancellation
    const clearCancelledOwner = (): void => {
      if (binding.pendingCancellation === cancellation) delete binding.pendingCancellation
    }
    request.signal.addEventListener('abort', clearCancelledOwner, { once: true })
    const signal = AbortSignal.any([request.signal, binding.abort.signal])
    try {
      await binding.port.navigate({ ...request, signal })
      signal.throwIfAborted()
    } finally {
      request.signal.removeEventListener('abort', clearCancelledOwner)
      clearCancelledOwner()
      binding.pending = false
    }
  }
}
