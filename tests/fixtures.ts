import type {
  DshDurableEvent,
  DurableDshEnvelope,
  RuntimeDshEnvelope,
  UiMessage,
} from '../src/internal.ts'

export function message(
  id: string,
  role: UiMessage['role'],
  text: string,
  sourceKind = role === 'user' ? 'user' : 'model',
): UiMessage {
  return {
    id,
    role,
    sourceKind,
    content: text === '' ? [] : [{ type: 'text', text }],
  }
}

export function durable(
  seq: number,
  event: DshDurableEvent,
  sessionId = 'session-a',
): DurableDshEnvelope {
  return {
    plane: 'durable',
    sessionId,
    seq,
    time: 1_000 + seq,
    ...event,
  }
}

export function runtime(
  ordinal: number,
  event: Omit<RuntimeDshEnvelope, 'plane' | 'sessionId' | 'sourceId' | 'ordinal' | 'time'>,
  sessionId = 'session-a',
  sourceId = 'live-a',
): RuntimeDshEnvelope {
  return {
    plane: 'runtime',
    sessionId,
    sourceId,
    ordinal,
    time: 2_000 + ordinal,
    ...event,
  } as RuntimeDshEnvelope
}
