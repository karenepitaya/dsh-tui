import { KNOWN_SESSION_EVENT_TYPES, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {
  DurableDshEnvelope,
  SessionId,
  SurfaceOp,
  UiMessage,
} from '../runtime/events.ts'

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

function normalizeMessage(message: DshMessageLike): UiMessage {
  return {
    id: message.id,
    role: message.role,
    sourceKind: message.source.kind,
    content: message.content,
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
  return isSurfaceEvent(event)
    ? build(event.surfaceOp)
    : unsupported(base, `${sourceType}:missing-surface-op`)
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
  const raw = event as SessionEvent & RawSessionEvent
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
    case 'assistant/chunk': {
      const data = (event as SessionEvent<'assistant/chunk'>).data
      return { ...base, type: 'assistant/chunk', data }
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
          message: normalizeMessage(typed.data.message),
          surfaceOp,
          ...(typed.data.error === undefined ? {} : { error: typed.data.error }),
          ...(typed.data.meta === undefined ? {} : { meta: typed.data.meta }),
        },
      }))
    }
    case 'todo/write': {
      const data = (event as SessionEvent<'todo/write'>).data
      return { ...base, type: 'todo/write', data }
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
