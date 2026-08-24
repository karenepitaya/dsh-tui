import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type SessionStore from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionCatalogDurability,
  SessionCatalogEntry,
  SessionCatalogListOptions,
  SessionCatalogPort,
  SessionCatalogSnapshot,
  SessionDurablePresence,
} from '../session/catalog-port.ts'
import { isDelegatedSession } from './session-eligibility.ts'

function copyEntry(
  header: SessionHeader,
  attached: boolean,
  durablePresence: SessionDurablePresence,
  liveStatus?: 'idle' | 'running',
): SessionCatalogEntry {
  return Object.freeze({
    sessionId: String(header.id),
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined
      ? {}
      : { parentSessionId: String(header.parentSession) }),
    isSubagent: isDelegatedSession(header),
    ...(header.agentPreset === undefined
      ? {}
      : { creationAgentPreset: header.agentPreset }),
    attached,
    durablePresence,
    ...(liveStatus === undefined ? {} : { liveStatus }),
  })
}

function compareEntries(left: SessionCatalogEntry, right: SessionCatalogEntry): number {
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
  // Map keys guarantee distinct ids here; `<` is raw UTF-16 code-unit order.
  return left.sessionId < right.sessionId ? -1 : 1
}

/** Official persistence-first/live-overlay adapter for read-only session discovery. */
export class DshSessionCatalog implements SessionCatalogPort {
  private readonly sessions: SessionStore
  private readonly agents: AgentRegistry

  constructor(private readonly ctx: Context) {
    const sessions = ctx.get('sessions')
    if (sessions === undefined) throw new Error('DSH Session service is unavailable')
    const agents = ctx.get('agents')
    if (agents === undefined) throw new Error('DSH Agent service is unavailable')
    this.sessions = sessions
    this.agents = agents
  }

  async listSessions(
    options: SessionCatalogListOptions = {},
  ): Promise<SessionCatalogSnapshot> {
    const signal = options.signal
    signal?.throwIfAborted()

    // Persistence is an optional capability. ctx.get() is required here: a
    // direct property read can fail across Cordis shadow/fiber boundaries.
    const persistence = this.ctx.get('sessionPersistence')
    let durability: SessionCatalogDurability
    let durableHeaders: readonly SessionHeader[]
    if (persistence === undefined) {
      durability = 'unavailable'
      durableHeaders = []
    } else {
      durability = 'available'
      durableHeaders = await persistence.list(signal)
      signal?.throwIfAborted()
    }

    // Take the live view only after the durable await, so a session that
    // attached during listing wins the merged row.
    const liveSessions = this.sessions.list()
    const entries = new Map<string, SessionCatalogEntry>()
    for (const header of durableHeaders) {
      const entry = copyEntry(header, false, 'observed')
      entries.set(entry.sessionId, entry)
    }
    for (const session of liveSessions) {
      const sessionId = String(session.id)
      const durablePresence: SessionDurablePresence = durability === 'unavailable'
        ? 'unavailable'
        : entries.has(sessionId)
          ? 'observed'
          : 'not-observed'
      const status = this.agents.get(session.id)?.status
      entries.set(
        sessionId,
        copyEntry(session.header, true, durablePresence, status),
      )
    }

    const sessions = Object.freeze([...entries.values()].sort(compareEntries))
    return Object.freeze({ durability, sessions })
  }
}
