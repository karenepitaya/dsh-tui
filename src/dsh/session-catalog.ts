import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type {
  SessionQueryEngine,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
import type {
  SessionCatalogDurability,
  SessionCatalogEntry,
  SessionCatalogListOptions,
  SessionCatalogPort,
  SessionCatalogSnapshot,
  SessionDurablePresence,
} from '../session/catalog-port.ts'
import { isDelegatedSession } from './session-eligibility.ts'

type SessionCatalogQuery = Pick<SessionQueryEngine, 'listSessions'>

function copyEntry(
  record: SessionRecord,
  durablePresence: SessionDurablePresence,
  liveStatus?: 'idle' | 'running',
): SessionCatalogEntry {
  const header: SessionHeader = record.header
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
    attached: record.live,
    durablePresence,
    ...(liveStatus === undefined ? {} : { liveStatus }),
  })
}

/**
 * Narrow anti-corruption adapter from DSH SessionQuery records to the stable
 * product-owned catalog port. Query merging, conflicts, errors, and ordering
 * remain owned by the official service.
 */
export class DshSessionCatalog implements SessionCatalogPort {
  private readonly query: SessionCatalogQuery
  private readonly agents: AgentRegistry

  constructor(private readonly ctx: Context) {
    const query = ctx.get('sessionQuery')
    if (query === undefined) throw new Error('DSH Session query service is unavailable')
    const agents = ctx.get('agents')
    if (agents === undefined) throw new Error('DSH Agent service is unavailable')
    this.query = query
    this.agents = agents
  }

  async listSessions(
    options: SessionCatalogListOptions = {},
  ): Promise<SessionCatalogSnapshot> {
    const signal = options.signal
    signal?.throwIfAborted()

    const records = await this.query.listSessions(signal)
    signal?.throwIfAborted()

    // SessionQuery owns the atomic durable/live observation. This capability
    // bit only preserves the existing product contract and is intentionally a
    // best-effort, non-atomic diagnostic.
    const durability: SessionCatalogDurability = this.ctx.get('sessionPersistence') === undefined
      ? 'unavailable'
      : 'available'
    const sessions = Object.freeze(records.map((record) => {
      const presence: SessionDurablePresence = record.persisted
        ? 'observed'
        : durability === 'available'
          ? 'not-observed'
          : 'unavailable'
      const status = record.live
        ? this.agents.get(record.header.id)?.status
        : undefined
      return copyEntry(record, presence, status)
    }))
    return Object.freeze({ durability, sessions })
  }
}
