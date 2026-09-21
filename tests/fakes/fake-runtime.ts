import type {
  AgentStatus,
  CancelCause,
  Delivery,
  DshRuntimePort,
  DshTuiEvent,
  DurableDshEnvelope,
  RuntimeEventOptions,
  SessionId,
  SubmitInput,
  SubmitResult,
} from '../../src/internal.ts'

class AsyncEventQueue {
  private readonly values: DshTuiEvent[] = []
  private readonly waiters: ((result: IteratorResult<DshTuiEvent>) => void)[] = []
  private closed = false

  push(value: DshTuiEvent): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter({ done: false, value })
  }

  next(): Promise<IteratorResult<DshTuiEvent>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => this.waiters.push(resolve))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined })
    }
  }
}

export class FakeRuntimePort implements DshRuntimePort {
  readonly ownsAgentLifecycle = true
  readonly submitted: { input: SubmitInput; delivery: Delivery }[] = []
  readonly cancellations: { cause: CancelCause; keepInbox: boolean }[] = []
  flushCount = 0
  disposeCount = 0
  onSubscriberAttached: (() => void) | undefined

  private readonly history: DurableDshEnvelope[] = []
  private readonly queues = new Set<AsyncEventQueue>()
  private disposed = false
  private status: AgentStatus = 'idle'

  constructor(readonly sessionId: SessionId) {}

  emit(event: DshTuiEvent): void {
    if (event.plane === 'durable') {
      if (event.seq !== this.history.length) {
        throw new Error(`fake durable seq must be ${this.history.length}`)
      }
      this.history.push(event)
    } else if (event.type === 'agent/disposed') {
      this.status = 'disposed'
    } else if (event.type === 'agent/created' || event.type === 'agent/status') {
      this.status = event.data.status
    }
    for (const queue of this.queues) queue.push(event)
  }

  async *events(options: RuntimeEventOptions = {}): AsyncIterable<DshTuiEvent> {
    if (this.disposed) throw new Error('runtime is disposed')
    const queue = new AsyncEventQueue()
    this.queues.add(queue)
    const signal = options.signal
    const onAbort = () => queue.close()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) queue.close()
    this.onSubscriberAttached?.()

    let lastSeq = options.afterSeq ?? -1
    try {
      for (const event of this.history) {
        if (event.seq <= lastSeq) continue
        lastSeq = event.seq
        yield event
      }
      if (signal?.aborted) return
      options.onCaughtUp?.({
        lastSeq: this.history.at(-1)?.seq ?? -1,
        status: this.status,
      })
      while (true) {
        const next = await queue.next()
        if (next.done) return
        const event = next.value
        if (event.plane === 'durable') {
          if (event.seq <= lastSeq) continue
          lastSeq = event.seq
        }
        yield event
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.queues.delete(queue)
      queue.close()
    }
  }

  async submit(input: SubmitInput, delivery: Delivery): Promise<SubmitResult> {
    if (this.disposed) throw new Error('runtime is disposed')
    this.submitted.push({ input, delivery })
    return { inputId: `input-${this.submitted.length}` }
  }

  cancel(cause: CancelCause, options?: { readonly keepInbox?: boolean }): void {
    this.cancellations.push({ cause, keepInbox: options?.keepInbox === true })
  }

  async whenIdle(): Promise<void> {}

  async flush(): Promise<void> {
    this.flushCount += 1
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.disposeCount += 1
    for (const queue of this.queues) queue.close()
  }
}
