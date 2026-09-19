import { KNOWN_SESSION_EVENT_TYPES, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {
  DurableDshEnvelope,
  SessionId,
  SurfaceOp,
  UiAssistantChunk,
  UiCompactionLifecycle,
  UiCompactionSummary,
  UiContentBlock,
  UiImageAttachmentRef,
  UiLlmFailure,
  UiLlmRetryScheduled,
  UiLlmRetryStarted,
  UiMessage,
  UiRequestAdapterDefaults,
  UiRequestCallConfig,
  UiRequestContext,
  UiRequestHeaderSnapshot,
  UiTodoItem,
} from '../runtime/events.ts'

const MAX_TIMER_DELAY_MS = 2_147_483_647

interface RawSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
  readonly sourceEventSeqs?: readonly number[]
}

interface DshMessageLike {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly content: readonly unknown[]
  readonly source: { readonly kind: string }
}

interface DurableBase {
  readonly plane: 'durable'
  readonly sessionId: SessionId
  readonly seq: number
  readonly time: number
  readonly ignorable?: true
  readonly sourceEventSeqs?: readonly number[]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sourceType(value: unknown): string {
  return isRecord(value) && typeof value.type === 'string' && value.type !== ''
    ? value.type
    : 'unknown'
}

function isSafeDimension(value: unknown, allowZero = false): value is number {
  return Number.isSafeInteger(value) && (allowZero ? Number(value) >= 0 : Number(value) > 0)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function optionalCommandId(
  value: Readonly<Record<string, unknown>>,
): { readonly sourceCommandId?: string } | undefined {
  if (value.sourceCommandId === undefined) return {}
  return isNonEmptyString(value.sourceCommandId)
    ? { sourceCommandId: value.sourceCommandId }
    : undefined
}

function normalizeCompactionLifecycle(value: unknown): UiCompactionLifecycle | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.compactionId)) return undefined
  const command = optionalCommandId(value)
  if (command === undefined) return undefined
  const turn = value.turn
  if (turn !== null && (!Number.isSafeInteger(turn) || Number(turn) < 0)) return undefined
  return {
    compactionId: value.compactionId,
    ...command,
    turn: turn as number | null,
  }
}

function normalizeCompactionSummary(value: unknown): UiCompactionSummary | undefined {
  if (!isRecord(value)
    || !isNonEmptyString(value.compactionId)
    || !isNonEmptyString(value.provider)
    || !isNonEmptyString(value.model)
    || !isRecord(value.shadowedRange)
    || !isSafeDimension(value.shadowedRange.start, true)
    || !isSafeDimension(value.shadowedRange.end, true)
    || !Array.isArray(value.shadowedSeqs)
    || value.shadowedSeqs.length === 0
    || !value.shadowedSeqs.every(seq => isSafeDimension(seq, true))
    || !isSafeDimension(value.shadowedTokenCount, true)) return undefined
  const command = optionalCommandId(value)
  if (command === undefined) return undefined
  return {
    compactionId: value.compactionId,
    ...command,
    shadowedRange: {
      start: value.shadowedRange.start,
      end: value.shadowedRange.end,
    },
    shadowedSeqs: [...value.shadowedSeqs],
    shadowedTokenCount: value.shadowedTokenCount,
    provider: value.provider,
    model: value.model,
  }
}

function normalizeLlmFailure(value: unknown): UiLlmFailure | undefined {
  if (!isRecord(value)
    || !isNonEmptyString(value.message)
    || !isNonEmptyString(value.code)
    || (value.status !== undefined
      && (!Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599))
    || (value.providerRetryAfterMs !== undefined
      && (typeof value.providerRetryAfterMs !== 'number'
        || !Number.isFinite(value.providerRetryAfterMs)
        || value.providerRetryAfterMs <= 0))
    || (value.requestId !== undefined && !isNonEmptyString(value.requestId))) {
    return undefined
  }
  return {
    message: value.message,
    code: value.code,
    ...(value.status === undefined ? {} : { status: Number(value.status) }),
    ...(value.providerRetryAfterMs === undefined
      ? {}
      : { providerRetryAfterMs: value.providerRetryAfterMs }),
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
  }
}

function normalizeLlmRetry(value: unknown): UiLlmRetryScheduled | undefined {
  if (!isRecord(value)
    || !isNonEmptyString(value.retryId)
    || !isSafeDimension(value.turn)
    || !isSafeDimension(value.step)
    || !isNonEmptyString(value.provider)
    || !isNonEmptyString(value.policyKey)
    || !isSafeDimension(value.retry)
    || typeof value.delayMs !== 'number'
    || !Number.isFinite(value.delayMs)
    || value.delayMs < 0
    || value.delayMs > MAX_TIMER_DELAY_MS) {
    return undefined
  }
  const failure = normalizeLlmFailure(value.failure)
  if (failure === undefined) return undefined
  const common = {
    retryId: value.retryId,
    turn: value.turn,
    step: value.step,
    provider: value.provider,
    policyKey: value.policyKey,
    retry: value.retry,
    delayMs: value.delayMs,
    failure,
  }
  if (value.mode === 'normal') {
    if (!isSafeDimension(value.maxRetries) || value.retry > value.maxRetries) return undefined
    return { ...common, mode: 'normal', maxRetries: value.maxRetries }
  }
  if (value.mode === 'always'
    && !Object.prototype.hasOwnProperty.call(value, 'maxRetries')) {
    return { ...common, mode: 'always' }
  }
  return undefined
}

function normalizeLlmRetryStarted(value: unknown): UiLlmRetryStarted | undefined {
  if (!isRecord(value)
    || !isNonEmptyString(value.retryId)
    || !isSafeDimension(value.turn)
    || !isSafeDimension(value.step)
    || !isSafeDimension(value.retry)) return undefined
  return {
    retryId: value.retryId,
    turn: value.turn,
    step: value.step,
    retry: value.retry,
  }
}

function normalizeRequestConfig(value: unknown): UiRequestCallConfig | undefined {
  if (!isRecord(value)
    || !isNonEmptyString(value.provider)
    || !isNonEmptyString(value.model)
    || (value.reasoningEffort !== undefined && !isNonEmptyString(value.reasoningEffort))
    || (value.temperature !== undefined
      && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature)))
    || (value.maxTokens !== undefined && !isSafeDimension(value.maxTokens))
    || (value.stop !== undefined
      && (!Array.isArray(value.stop) || !value.stop.every(item => typeof item === 'string')))) {
    return undefined
  }
  return {
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
    ...(value.stop === undefined ? {} : { stop: [...value.stop] }),
  }
}

function normalizeRequestAdapterDefaults(
  value: unknown,
): UiRequestAdapterDefaults | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)
    || (value.reasoningEffort !== undefined && value.reasoningEffort !== true)
    || (value.maxTokens !== undefined && value.maxTokens !== true)) return null
  return {
    ...(value.reasoningEffort === true ? { reasoningEffort: true as const } : {}),
    ...(value.maxTokens === true ? { maxTokens: true as const } : {}),
  }
}

function normalizeRequestHeader(value: unknown): UiRequestHeaderSnapshot | undefined {
  if (!isRecord(value)
    || (value.reason !== 'initial' && value.reason !== 'resume'
      && value.reason !== 'change' && value.reason !== 'series')
    || !isRecord(value.header)) return undefined
  const config = normalizeRequestConfig(value.header.config)
  const adapterDefaults = normalizeRequestAdapterDefaults(value.header.adapterDefaults)
  if (config === undefined || adapterDefaults === null) return undefined
  return {
    reason: value.reason,
    config,
    ...(adapterDefaults === undefined || Object.keys(adapterDefaults).length === 0
      ? {}
      : { adapterDefaults }),
  }
}

function normalizeRequestContext(value: unknown): UiRequestContext | undefined {
  if (!isRecord(value)
    || !isNonEmptyString(value.provider)
    || !isNonEmptyString(value.model)
    || (value.contextWindow !== undefined && !isSafeDimension(value.contextWindow))) return undefined
  return {
    provider: value.provider,
    model: value.model,
    ...(value.contextWindow === undefined ? {} : { contextWindow: value.contextWindow }),
  }
}

function normalizeImageAttachment(value: unknown): UiImageAttachmentRef | undefined {
  if (!isRecord(value)
    || typeof value.attachmentId !== 'string'
    || typeof value.mediaType !== 'string'
    || !isSafeDimension(value.bytes, true)
    || !isSafeDimension(value.width)
    || !isSafeDimension(value.height)) {
    return undefined
  }

  let originalDimensions: UiImageAttachmentRef['originalDimensions']
  if (isRecord(value.originalDimensions)
    && isSafeDimension(value.originalDimensions.width)
    && isSafeDimension(value.originalDimensions.height)) {
    originalDimensions = {
      width: value.originalDimensions.width,
      height: value.originalDimensions.height,
    }
  }

  return {
    attachmentId: value.attachmentId,
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(originalDimensions === undefined ? {} : { originalDimensions }),
  }
}

function unsupportedContent(value: unknown): UiContentBlock {
  return { type: 'unsupported', sourceType: sourceType(value) }
}

function normalizeContentBlock(value: unknown): UiContentBlock {
  if (!isRecord(value)) return unsupportedContent(value)
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string'
        ? { type: 'text', text: value.text }
        : unsupportedContent(value)
    case 'reasoning':
      return typeof value.text === 'string'
        ? { type: 'reasoning', text: value.text }
        : unsupportedContent(value)
    case 'image': {
      const attachment = normalizeImageAttachment(value.attachment)
      return attachment === undefined
        ? unsupportedContent(value)
        : { type: 'image', attachment }
    }
    case 'tool-call':
      return typeof value.id === 'string'
        && typeof value.name === 'string'
        && typeof value.arguments === 'string'
        ? {
            type: 'tool-call',
            id: value.id,
            name: value.name,
            arguments: value.arguments,
          }
        : unsupportedContent(value)
    default:
      return unsupportedContent(value)
  }
}

/** Normalize one live or durable stream chunk into the display-safe projection. */
export function normalizeAssistantChunk(value: unknown): UiAssistantChunk {
  if (!isRecord(value)) return { type: 'unsupported', sourceType: sourceType(value) }
  if ((value.type === 'text-delta' || value.type === 'reasoning-delta')
    && Number.isSafeInteger(value.index)
    && Number(value.index) >= 0
    && typeof value.text === 'string') {
    return {
      type: value.type,
      index: Number(value.index),
      text: value.text,
    }
  }
  return { type: 'unsupported', sourceType: sourceType(value) }
}

function normalizeMessage(message: DshMessageLike): UiMessage {
  return {
    id: message.id,
    role: message.role,
    sourceKind: message.source.kind,
    content: message.content.map(normalizeContentBlock),
  }
}

/** Project the official correlation envelope to the display-safe result payload. */
function normalizeToolResultMessage(message: DshMessageLike): {
  readonly message: UiMessage
  readonly isError?: boolean
} {
  const [block] = message.content
  const wrapped = message.content.length === 1
    && isRecord(block)
    && block.type === 'tool-result'
    && Array.isArray(block.content)
  const content = wrapped
    ? (block.content as readonly unknown[]).map(normalizeContentBlock)
    : message.content.map(normalizeContentBlock)
  return {
    message: {
      id: message.id,
      role: message.role,
      sourceKind: message.source.kind,
      content,
    },
    ...(wrapped && typeof block.isError === 'boolean' ? { isError: block.isError } : {}),
  }
}

function baseEnvelope(sessionId: SessionId, event: RawSessionEvent): DurableBase {
  return {
    plane: 'durable',
    sessionId,
    seq: event.seq,
    time: event.time,
    ...(event.ignorable === true ? { ignorable: true as const } : {}),
    ...(event.sourceEventSeqs === undefined
      ? {}
      : { sourceEventSeqs: [...event.sourceEventSeqs] }),
  }
}

function unsupported(base: DurableBase, sourceType: string): DurableDshEnvelope {
  return {
    ...base,
    type: 'session/unsupported',
    data: { sourceType },
  }
}

function withSurface(
  base: DurableBase,
  event: SessionEvent,
  sourceType: string,
  build: (surfaceOp: SurfaceOp) => DurableDshEnvelope,
): DurableDshEnvelope {
  if (!isSurfaceEvent(event)) return unsupported(base, `${sourceType}:missing-surface-op`)
  const op = event.surfaceOp
  return build(op === 'append'
    ? 'append'
    : { op: 'replace', start: op.startSeq, end: op.endSeq })
}

/**
 * Convert one frozen official DSH event into the product-owned M0 contract.
 * Every durable seq yields exactly one envelope, including known log-only and
 * future compatibility events, so replay never manufactures a false gap.
 */
export function convertSessionEvent(
  sessionId: SessionId,
  event: SessionEvent,
): DurableDshEnvelope {
  const raw = event as unknown as RawSessionEvent
  const base = baseEnvelope(sessionId, raw)

  switch (raw.type) {
    case 'turn/start': {
      const data = (event as SessionEvent<'turn/start'>).data
      return { ...base, type: 'turn/start', data }
    }
    case 'turn/end': {
      const data = (event as SessionEvent<'turn/end'>).data
      return { ...base, type: 'turn/end', data }
    }
    case 'step/start': {
      const data = (event as SessionEvent<'step/start'>).data
      return { ...base, type: 'step/start', data }
    }
    case 'step/end': {
      const data = (event as SessionEvent<'step/end'>).data
      return { ...base, type: 'step/end', data }
    }
    case 'user/message': {
      const typed = event as SessionEvent<'user/message'>
      return withSurface(base, typed, raw.type, surfaceOp => ({
        ...base,
        type: 'user/message',
        data: { message: normalizeMessage(typed.data), surfaceOp },
      }))
    }
    case 'assistant/message': {
      const typed = event as SessionEvent<'assistant/message'>
      return withSurface(base, typed, raw.type, surfaceOp => ({
        ...base,
        type: 'assistant/message',
        data: {
          turn: typed.data.turn,
          step: typed.data.step,
          message: normalizeMessage(typed.data.message),
          surfaceOp,
          ...(typed.data.usage === undefined ? {} : { usage: { ...typed.data.usage } }),
          ...(typed.data.interrupted === true ? { interrupted: true as const } : {}),
        },
      }))
    }
    case 'llm/retry': {
      const data = normalizeLlmRetry(raw.data)
      return data === undefined
        ? unsupported(base, `${raw.type}:malformed-data`)
        : { ...base, type: 'llm/retry', data }
    }
    case 'llm/retry-started': {
      const data = normalizeLlmRetryStarted(raw.data)
      return data === undefined
        ? unsupported(base, `${raw.type}:malformed-data`)
        : { ...base, type: 'llm/retry-started', data }
    }
    case 'request/header': {
      const data = normalizeRequestHeader(raw.data)
      return data === undefined
        ? unsupported(base, `${raw.type}:malformed-data`)
        : { ...base, type: 'request/header', data }
    }
    case 'request/context': {
      const data = normalizeRequestContext(raw.data)
      return data === undefined
        ? unsupported(base, `${raw.type}:malformed-data`)
        : { ...base, type: 'request/context', data }
    }
    case 'command/run': {
      const data = (event as SessionEvent<'command/run'>).data
      return {
        ...base,
        type: 'command/run',
        data: {
          commandId: data.commandId,
          name: data.name,
          ...(data.args === undefined ? {} : { args: data.args }),
          source: data.source,
        },
      }
    }
    case 'command/done': {
      const data = (event as SessionEvent<'command/done'>).data
      return {
        ...base,
        type: 'command/done',
        data: {
          commandId: data.commandId,
          kind: data.kind,
          ...(data.text === undefined ? {} : { text: data.text }),
          ...(data.sourceEventSeq === undefined
            ? {}
            : { sourceEventSeq: data.sourceEventSeq }),
        },
      }
    }
    case 'compaction/start': {
      const data = normalizeCompactionLifecycle(raw.data)
      return data === undefined
        ? unsupported(base, `${raw.type}:malformed-data`)
        : { ...base, type: 'compaction/start', data }
    }
    case 'compaction/summary': {
      const data = normalizeCompactionSummary(raw.data)
      return data === undefined
        ? unsupported(base, `${raw.type}:malformed-data`)
        : { ...base, type: 'compaction/summary', data }
    }
    case 'compaction/end': {
      const data = normalizeCompactionLifecycle(raw.data)
      if (data === undefined || !isRecord(raw.data)
        || (raw.data.error !== undefined && typeof raw.data.error !== 'string')) {
        return unsupported(base, `${raw.type}:malformed-data`)
      }
      return {
        ...base,
        type: 'compaction/end',
        data: {
          ...data,
          ...(raw.data.error === undefined ? {} : { error: raw.data.error }),
        },
      }
    }
    case 'compaction/prune':
      return {
        ...base,
        type: 'session/observed',
        data: { sourceType: raw.type, ignorable: raw.ignorable === true },
      }
    case 'tool/call': {
      const data = (event as SessionEvent<'tool/call'>).data
      return {
        ...base,
        type: 'tool/call',
        data: { ...data, callId: data.callId },
      }
    }
    case 'tool/result': {
      const typed = event as SessionEvent<'tool/result'>
      if (typed.data.message.source.kind !== 'tool') {
        return unsupported(base, `${raw.type}:invalid-tool-message`)
      }
      return withSurface(base, typed, raw.type, surfaceOp => ({
        ...base,
        type: 'tool/result',
        data: {
          turn: typed.data.turn,
          step: typed.data.step,
          callId: typed.data.message.source.callId,
          ...normalizeToolResultMessage(typed.data.message),
          surfaceOp,
          ...(typed.data.error === undefined ? {} : { error: typed.data.error }),
          ...(typed.data.meta === undefined ? {} : { meta: typed.data.meta }),
        },
      }))
    }
    case 'todo/write': {
      // The `todo/write` SessionEventMap entry is declaration-merged by
      // dsh-tool-todo, which this composition does not depend on; validate the
      // payload structurally instead of typing against the merged map.
      const data = raw.data
      if (!isRecord(data) || !Array.isArray(data.todos)) {
        return unsupported(base, `${raw.type}:malformed-data`)
      }
      return { ...base, type: 'todo/write', data: { todos: data.todos as readonly UiTodoItem[] } }
    }
    default:
      return KNOWN_SESSION_EVENT_TYPES.has(raw.type) || raw.ignorable === true
        ? {
            ...base,
            type: 'session/observed',
            data: { sourceType: raw.type, ignorable: raw.ignorable === true },
          }
        : unsupported(base, raw.type)
  }
}
