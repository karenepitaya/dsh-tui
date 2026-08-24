/** One-consumer async queue that conflates backlog to its newest value. */
export class LatestValueQueue<T> {
  private value: T | undefined
  private waiter: ((result: IteratorResult<T>) => void) | undefined
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiter
    if (waiter === undefined) {
      this.value = value
      return
    }
    this.waiter = undefined
    waiter({ done: false, value })
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.value
    if (value !== undefined) {
      this.value = undefined
      return Promise.resolve({ done: false, value })
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
