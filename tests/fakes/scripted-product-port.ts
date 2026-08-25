import type { DshTuiProductPort } from '../../src/app/controller.ts'
import type {
  DshCommandDescriptor,
  DshCommandExecution,
  DshParsedCommand,
} from '../../src/command/port.ts'
import type {
  InteractionEventOptions,
  InteractionReceipt,
  InteractionResponse,
  InteractionSnapshot,
} from '../../src/interaction/port.ts'
import type {
  DshDurableEvent,
  DshTuiEvent,
  RuntimeDshEnvelope,
  UiMessage,
} from '../../src/runtime/events.ts'
import type {
  CancelCause,
  Delivery,
  RuntimeEventOptions,
  SubmitInput,
  SubmitResult,
} from '../../src/runtime/port.ts'
import type {
  DshTuiModelSelection,
  SessionModelSelectOptions,
  SessionModelSnapshot,
} from '../../src/model/port.ts'

export type ScriptedConPtyScenario = 'controller-flow' | 'controller-force'

export const SCRIPTED_ASSISTANT_TEXT = 'durable assistant complete'
export const SCRIPTED_TOOL_NAME = 'inspect'
export const SCRIPTED_DURABLE_SEQS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const

export interface ScriptedProductPortOptions {
  readonly scenario: ScriptedConPtyScenario
  readonly expectedPrompt: string
  readonly trace: (message: string) => void
  readonly onProgress?: () => void
}

interface QueueWaiter<T> {
  readonly resolve: (result: IteratorResult<T>) => void
}

class AsyncQueue<T> {
  private readonly values: T[] = []
  private readonly waiters: QueueWaiter<T>[] = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter.resolve({ done: false, value })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.values.length = 0
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined })
    }
  }

  async *iterate(
    signal: AbortSignal | undefined,
    onConsumed: (value: T) => void,
  ): AsyncIterable<T> {
    const onAbort = (): void => { this.close() }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) onAbort()
    try {
      while (true) {
        const next = await this.next()
        if (next.done) return
        yield next.value
        onConsumed(next.value)
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => { this.waiters.push({ resolve }) })
  }
}

function message(id: string, role: UiMessage['role'], text: string, sourceKind: string): UiMessage {
  return { id, role, sourceKind, content: [{ type: 'text', text }] }
}

function runtime(
  sessionId: string,
  ordinal: number,
  type: RuntimeDshEnvelope['type'],
  status: 'idle' | 'running' = 'idle',
): RuntimeDshEnvelope {
  const common = {
    plane: 'runtime' as const,
    sessionId,
    sourceId: 'conpty-live',
    ordinal,
    time: 2_000 + ordinal,
  }
  if (type === 'agent/disposed') return { ...common, type, data: {} }
  return { ...common, type, data: { status } }
}

function scriptedDurables(prompt: string): readonly DshDurableEvent[] {
  return [
    { type: 'turn/start', data: { turn: 0 } },
    {
      type: 'user/message',
      data: {
        message: message('user-0', 'user', prompt, 'user'),
        surfaceOp: 'append',
      },
    },
    { type: 'step/start', data: { turn: 0, step: 0 } },
    {
      type: 'assistant/chunk',
      data: {
        turn: 0,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: 'durable assistant draft' },
      },
    },
    {
      type: 'tool/call',
      data: {
        turn: 0,
        step: 0,
        callId: 'call-inspect',
        name: SCRIPTED_TOOL_NAME,
        arguments: '{}',
      },
    },
    {
      type: 'tool/result',
      data: {
        turn: 0,
        step: 0,
        callId: 'call-inspect',
        message: message('tool-0', 'assistant', 'inspection complete', 'tool'),
        surfaceOp: 'append',
      },
    },
    {
      type: 'assistant/message',
      data: {
        turn: 0,
        step: 0,
        message: message('assistant-0', 'assistant', SCRIPTED_ASSISTANT_TEXT, 'model'),
        surfaceOp: 'append',
      },
    },
    { type: 'step/end', data: { turn: 0, step: 0 } },
    { type: 'turn/end', data: { turn: 0, reason: 'complete' } },
  ]
}

export class ScriptedProductPort implements DshTuiProductPort {
  readonly sessionId = 'conpty-session'
  readonly ownsAgentLifecycle = true
  readonly submitted: { readonly input: SubmitInput; readonly delivery: Delivery }[] = []
  readonly cancellations: CancelCause[] = []
  readonly consumedDurableSeqs: number[] = []
  readonly lifecycle: string[] = []
  disposeInteractionsCount = 0
  whenIdleCount = 0
  flushCount = 0
  disposeCount = 0
  finalIdleObserved = false

  private readonly eventQueue = new AsyncQueue<DshTuiEvent>()
  private readonly interactionQueue = new AsyncQueue<InteractionSnapshot>()
  private readonly initialRuntime: Promise<void>
  private resolveInitialRuntime!: () => void
  private interactionsDisposed = false
  private runtimeDisposed = false
  private readonly blockedIdle = new Promise<void>(() => {})

  constructor(private readonly options: ScriptedProductPortOptions) {
    this.initialRuntime = new Promise(resolve => { this.resolveInitialRuntime = resolve })
    this.eventQueue.push(runtime(this.sessionId, 0, 'agent/created', 'idle'))
    this.interactionQueue.push({
      type: 'interaction/snapshot',
      sessionId: this.sessionId,
      pending: [],
    })
  }

  async *events(options?: RuntimeEventOptions): AsyncIterable<DshTuiEvent> {
    options?.onCaughtUp?.({ lastSeq: -1, status: 'idle' })
    yield* this.eventQueue.iterate(options?.signal, event => this.consumeEvent(event))
  }

  interactions(options?: InteractionEventOptions): AsyncIterable<InteractionSnapshot> {
    return this.interactionQueue.iterate(options?.signal, () => this.progress())
  }

  listCommands(): readonly DshCommandDescriptor[] {
    return []
  }

  parseCommand(line: string): DshParsedCommand | undefined {
    const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
    const name = match?.[1]
    return name === undefined ? undefined : { name, rawInput: line.slice(match![0].length) }
  }

  executeCommand(
    _line: string,
    _signal: AbortSignal,
  ): Promise<DshCommandExecution | undefined> {
    return Promise.resolve(undefined)
  }

  onCommandsChanged(_listener: () => void): () => void {
    return () => {}
  }

  disposeCommands(): void {}

  modelSnapshot(): SessionModelSnapshot {
    return {
      routable: false,
      writable: false,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
    }
  }

  refreshModels(_signal?: AbortSignal): Promise<void> {
    return Promise.resolve()
  }

  selectModel(
    _selection: DshTuiModelSelection,
    _options?: SessionModelSelectOptions,
  ): Promise<void> {
    return Promise.reject(new Error('scripted product model selection is unavailable'))
  }

  onModelsChanged(_listener: () => void): () => void {
    return () => {}
  }

  disposeModels(): void {}

  async submit(input: SubmitInput, delivery: Delivery): Promise<SubmitResult> {
    this.submitted.push({ input, delivery })
    this.options.trace(
      `SUBMIT count=${this.submitted.length} delivery=${delivery} text_hex=${Buffer.from(input.text).toString('hex')}`,
    )
    if (this.submitted.length !== 1) throw new Error('scripted ConPTY port received duplicate submit')
    if (input.text !== this.options.expectedPrompt) {
      throw new Error('scripted ConPTY port received the wrong UTF-8 prompt')
    }
    if (delivery !== 'followup') {
      throw new Error(`scripted ConPTY port expected followup delivery, received ${delivery}`)
    }

    this.eventQueue.push(runtime(this.sessionId, 1, 'agent/status', 'running'))
    for (const [seq, event] of scriptedDurables(input.text).entries()) {
      this.eventQueue.push({
        plane: 'durable',
        sessionId: this.sessionId,
        seq,
        time: 1_000 + seq,
        ...event,
      } as DshTuiEvent)
    }
    this.eventQueue.push(runtime(this.sessionId, 2, 'agent/status', 'idle'))
    return { inputId: 'conpty-input-1' }
  }

  cancel(cause: CancelCause): void {
    this.cancellations.push(cause)
    this.options.trace(`LIFECYCLE cancel-agent kind=${cause.kind}`)
  }

  async whenIdle(): Promise<void> {
    this.whenIdleCount += 1
    this.recordLifecycle('when-idle')
    if (this.options.scenario === 'controller-force') {
      this.options.trace('WHEN_IDLE_BLOCKED')
      await this.blockedIdle
    }
  }

  async flush(): Promise<void> {
    this.flushCount += 1
    this.recordLifecycle('flush-session')
  }

  async dispose(): Promise<void> {
    if (this.runtimeDisposed) return
    this.runtimeDisposed = true
    this.disposeCount += 1
    this.recordLifecycle('dispose-runtime')
    this.eventQueue.close()
    this.interactionQueue.close()
  }

  respond(_response: InteractionResponse): InteractionReceipt {
    return { accepted: false, reason: 'not-pending' }
  }

  disposeInteractions(): void {
    if (this.interactionsDisposed) return
    this.interactionsDisposed = true
    this.disposeInteractionsCount += 1
    this.recordLifecycle('settle-interactions')
    this.interactionQueue.close()
  }

  waitForInitialRuntime(): Promise<void> {
    return this.initialRuntime
  }

  private consumeEvent(event: DshTuiEvent): void {
    if (event.plane === 'durable') {
      this.consumedDurableSeqs.push(event.seq)
      this.options.trace(`DURABLE_CONSUMED ${event.seq}`)
    } else if (event.type === 'agent/created') {
      this.options.trace('RUNTIME_IDLE_OBSERVED initial')
      this.resolveInitialRuntime()
    } else if (event.type === 'agent/status' && event.data.status === 'idle') {
      this.finalIdleObserved = true
      this.options.trace('RUNTIME_IDLE_OBSERVED final')
    }
    this.progress()
  }

  private recordLifecycle(phase: string): void {
    this.lifecycle.push(phase)
    this.options.trace(`LIFECYCLE ${phase}`)
    this.progress()
  }

  private progress(): void {
    this.options.onProgress?.()
  }
}
