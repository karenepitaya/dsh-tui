/**
 * One-consumer notification queue with a hard capacity of one.
 *
 * A wake carries no payload: consumers must rescan their authoritative state.
 * This makes repeated producer notifications safe to conflate without losing
 * any durable fact from that state.
 */
export class WakeQueue {
  private pending = false
  private waiter: ((result: IteratorResult<void>) => void) | undefined
  private closed = false

  get pendingCount(): 0 | 1 {
    return this.pending ? 1 : 0
  }

  wake(): void {
    if (this.closed) return
    const waiter = this.waiter
    if (waiter === undefined) {
      this.pending = true
      return
    }
    this.waiter = undefined
    waiter({ done: false, value: undefined })
  }

  next(): Promise<IteratorResult<void>> {
    if (this.pending) {
      this.pending = false
      return Promise.resolve({ done: false, value: undefined })
    }
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => { this.waiter = resolve })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const waiter = this.waiter
    if (waiter === undefined) return
    this.waiter = undefined
    waiter({ done: true, value: undefined })
  }
}
