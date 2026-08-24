import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import {
  isToolPresentationView,
  type ToolPresentationPhase,
  type ToolPresentationView,
} from '../presentation/types.ts'

const DEFAULT_PENDING_CALL_LIMIT = 256

interface PendingToolCall {
  readonly name: string
  readonly args: unknown
}

interface ToolResultBlock {
  readonly content: unknown
  readonly isError?: boolean
}

export type DshToolPresentationAnnotation =
  | {
      readonly for: 'call'
      /** Explicit null means the durable tool fact must use the generic fallback. */
      readonly view: Extract<ToolPresentationView, { phase: 'call' }> | null
    }
  | {
      readonly for: 'result'
      /** Explicit null means the durable tool fact must use the generic fallback. */
      readonly view: Extract<ToolPresentationView, { phase: 'result' }> | null
    }

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function productView(
  phase: 'call',
  value: unknown,
): Extract<ToolPresentationView, { phase: 'call' }> | null
function productView(
  phase: 'result',
  value: unknown,
): Extract<ToolPresentationView, { phase: 'result' }> | null
function productView(
  phase: ToolPresentationPhase,
  value: unknown,
): ToolPresentationView | null {
  if (!isRecord(value)) return null
  const candidate = { ...value, phase }
  return isToolPresentationView(candidate) ? candidate : null
}

function resultBlock(event: SessionEvent<'tool/result'>): ToolResultBlock | undefined {
  const [value] = event.data.message.content
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined
  return value as unknown as ToolResultBlock
}

/**
 * Live-Agent bridge from durable DSH tool facts to product-owned render intents.
 * One instance belongs to one event iterator, so reconnect and afterSeq windows
 * cannot accidentally reuse pairing state from another consumer.
 */
export class DshToolPresentationProjector {
  private readonly pendingCalls = new Map<string, PendingToolCall>()

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly maxPendingCalls = DEFAULT_PENDING_CALL_LIMIT,
  ) {
    if (!Number.isSafeInteger(maxPendingCalls) || maxPendingCalls <= 0) {
      throw new RangeError('DSH tool presentation pending-call limit must be positive')
    }
  }

  project(event: SessionEvent): DshToolPresentationAnnotation | undefined {
    if (event.type === 'tool/call') return this.projectCall(event)
    if (event.type === 'tool/result') return this.projectResult(event)
    return undefined
  }

  private projectCall(
    event: SessionEvent<'tool/call'>,
  ): DshToolPresentationAnnotation {
    const { callId, name, arguments: rawArguments } = event.data
    let args: unknown
    try {
      args = JSON.parse(rawArguments)
    } catch {
      this.pendingCalls.delete(callId)
      return { for: 'call', view: null }
    }
    this.remember(callId, { name, args })
    try {
      const definition = this.ctx.get('tools')?.get(name, this.agent)
      const view = definition?.presentCall?.(args)
      return { for: 'call', view: productView('call', view) }
    } catch {
      return { for: 'call', view: null }
    }
  }

  private projectResult(
    event: SessionEvent<'tool/result'>,
  ): DshToolPresentationAnnotation {
    const callId = event.data.message.source.callId
    const call = this.pendingCalls.get(callId)
    this.pendingCalls.delete(callId)
    if (call === undefined) return { for: 'result', view: null }

    try {
      const block = resultBlock(event)
      if (block === undefined) return { for: 'result', view: null }
      const definition = this.ctx.get('tools')?.get(call.name, this.agent)
      const result: ToolResult = {
        content: block.content as ToolResult['content'],
        isError: block.isError === true,
        ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
      }
      const view = definition?.presentResult?.(call.args, result)
      return { for: 'result', view: productView('result', view) }
    } catch {
      return { for: 'result', view: null }
    }
  }

  private remember(callId: string, call: PendingToolCall): void {
    this.pendingCalls.delete(callId)
    while (this.pendingCalls.size >= this.maxPendingCalls) {
      const oldest = this.pendingCalls.keys().next()
      /* v8 ignore next -- a positive bound and non-empty Map guarantee one oldest key. */
      if (oldest.done) break
      this.pendingCalls.delete(oldest.value)
    }
    this.pendingCalls.set(callId, call)
  }
}
