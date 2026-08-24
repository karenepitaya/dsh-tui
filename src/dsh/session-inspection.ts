import type { Context } from '@deepseek-ai/cordis'
import {
  SessionId,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import {
  SessionInspectionError,
  type SessionInspectionHeader,
  type SessionInspectionPort,
  type SessionInspectionRequest,
  type SessionInspectionSnapshot,
} from '../session/inspection-port.ts'
import type { DurableDshEnvelope } from '../runtime/events.ts'
import { convertSessionEvent } from './session-event-adapter.ts'
import { isDelegatedSession } from './session-eligibility.ts'

export const SESSION_INSPECTION_COPY_BATCH = 256

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve) })
}

function copyHeader(header: SessionHeader): SessionInspectionHeader {
  return Object.freeze({
    sessionId: String(header.id),
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined
      ? {}
      : { parentSessionId: String(header.parentSession) }),
    ...(header.seedLength === undefined ? {} : { seedLength: header.seedLength }),
    isSubagent: isDelegatedSession(header),
    ...(header.delegationDepth === undefined
      ? {}
      : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined
      ? {}
      : { creationAgentPreset: header.agentPreset }),
  })
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return Object.freeze(value)
}

function copyEvent(
  sessionId: string,
  event: Parameters<typeof convertSessionEvent>[1],
): DurableDshEnvelope {
  return deepFreeze(structuredClone(convertSessionEvent(sessionId, event)))
}

async function copyEvents(
  sessionId: string,
  source: readonly Parameters<typeof convertSessionEvent>[1][],
  signal: AbortSignal,
): Promise<readonly DurableDshEnvelope[]> {
  const events: DurableDshEnvelope[] = []
  for (const [index, event] of source.entries()) {
    if (index > 0 && index % SESSION_INSPECTION_COPY_BATCH === 0) {
      await yieldToEventLoop()
    }
    signal.throwIfAborted()
    events.push(copyEvent(sessionId, event))
  }
  signal.throwIfAborted()
  return Object.freeze(events)
}

/** Product-owned, non-publishing adapter over official persistence.inspect(). */
export class DshSessionInspection implements SessionInspectionPort {
  constructor(private readonly ctx: Context) {}

  async inspectSession(
    request: SessionInspectionRequest,
  ): Promise<SessionInspectionSnapshot> {
    request.signal.throwIfAborted()
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new SessionInspectionError(
        'unavailable',
        'DSH Session persistence service is unavailable',
      )
    }

    const id = SessionId(request.sessionId)
    let inspection: Awaited<ReturnType<typeof persistence.inspect>>
    try {
      inspection = await persistence.inspect(id, request.signal)
    } catch (error: unknown) {
      request.signal.throwIfAborted()
      throw error
    }
    request.signal.throwIfAborted()

    if (inspection.meta.id !== id) {
      throw new SessionInspectionError(
        'identity-mismatch',
        `inspected session "${inspection.meta.id}" does not match "${id}"`,
      )
    }

    const events = await copyEvents(
      request.sessionId,
      inspection.events,
      request.signal,
    )
    return Object.freeze({
      header: copyHeader(inspection.meta),
      events,
    })
  }
}
