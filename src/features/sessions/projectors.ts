import type {
  SessionCatalogEntry,
  SessionCatalogSnapshot,
} from '../../session/catalog-port.ts'
import {
  projectSessionInspection,
} from '../../session/inspection-projection.ts'
import type {
  SessionInspectionHeader,
  SessionInspectionSnapshot,
} from '../../session/inspection-port.ts'
import type { UiState } from '../../transcript/state.ts'
import { matchesSessionCatalogQuery } from '../../session/catalog-filter.ts'

export interface SessionsCatalogSelection {
  readonly index: number
  readonly sessionId?: string
}

export type SessionsCatalogRelation = 'current' | 'cold' | 'other-live'

export interface SessionsCatalogRow {
  readonly sessionId: string
  readonly createdAt: number
  readonly title?: string
  readonly titleUpdatedAt?: number
  readonly titleUnavailable?: boolean
  readonly cwd?: string
  readonly parentSessionId?: string
  readonly isSubagent: boolean
  readonly creationAgentPreset?: string
  readonly attached: boolean
  readonly durablePresence: SessionCatalogEntry['durablePresence']
  readonly liveStatus?: NonNullable<SessionCatalogEntry['liveStatus']>
  readonly relation: SessionsCatalogRelation
}

export interface SessionsCatalogProjection {
  readonly durability: SessionCatalogSnapshot['durability']
  readonly query: string
  readonly rows: readonly SessionsCatalogRow[]
  readonly selectedIndex: number
  readonly selectedSessionId?: string
  readonly totalCount: number
  readonly filteredCount: number
}

export interface SessionsInspectionProjection {
  readonly sessionId: string
  readonly header: SessionInspectionHeader
  readonly transcript: UiState
}

function detachedCatalogEntry(entry: SessionCatalogEntry): SessionCatalogEntry {
  return Object.freeze({
    sessionId: entry.sessionId,
    createdAt: entry.createdAt,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.titleUpdatedAt === undefined ? {} : { titleUpdatedAt: entry.titleUpdatedAt }),
    ...(entry.titleUnavailable === undefined ? {} : { titleUnavailable: entry.titleUnavailable }),
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    ...(entry.parentSessionId === undefined
      ? {}
      : { parentSessionId: entry.parentSessionId }),
    isSubagent: entry.isSubagent,
    ...(entry.creationAgentPreset === undefined
      ? {}
      : { creationAgentPreset: entry.creationAgentPreset }),
    attached: entry.attached,
    durablePresence: entry.durablePresence,
    ...(entry.liveStatus === undefined ? {} : { liveStatus: entry.liveStatus }),
  })
}

function detachedCatalogRow(
  entry: SessionCatalogEntry,
  currentSessionId: string | undefined,
): SessionsCatalogRow {
  const detached = detachedCatalogEntry(entry)
  return Object.freeze({
    ...detached,
    relation: detached.sessionId === currentSessionId
      ? 'current'
      : detached.attached ? 'other-live' : 'cold',
  })
}

/** Detach adapter-owned arrays before keeping them as disposable Feature state. */
export function detachSessionsCatalogSnapshot(
  snapshot: SessionCatalogSnapshot,
): SessionCatalogSnapshot {
  return Object.freeze({
    durability: snapshot.durability,
    sessions: Object.freeze(snapshot.sessions.map(detachedCatalogEntry)),
  })
}

function clampedIndex(index: number, count: number): number {
  if (count === 0) return -1
  return Math.min(count - 1, Math.max(0, index))
}

export function projectSessionsCatalogSnapshot(
  snapshot: SessionCatalogSnapshot | undefined,
  query: string,
  selection: SessionsCatalogSelection,
  currentSessionId?: string,
): SessionsCatalogProjection {
  const allRows = snapshot?.sessions ?? []
  const rows = Object.freeze(allRows
    .map(entry => detachedCatalogRow(entry, currentSessionId))
    .filter(row => matchesSessionCatalogQuery(row, query)))
  const stableIndex = selection.sessionId === undefined
    ? -1
    : rows.findIndex(row => row.sessionId === selection.sessionId)
  const selectedIndex = stableIndex >= 0
    ? stableIndex
    : clampedIndex(selection.index, rows.length)
  const selected = rows[selectedIndex]
  return Object.freeze({
    durability: snapshot?.durability ?? 'unavailable',
    query,
    rows,
    selectedIndex,
    ...(selected === undefined ? {} : { selectedSessionId: selected.sessionId }),
    totalCount: allRows.length,
    filteredCount: rows.length,
  })
}

function detachedInspectionHeader(
  header: SessionInspectionHeader,
): SessionInspectionHeader {
  return Object.freeze({
    sessionId: header.sessionId,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSessionId === undefined
      ? {}
      : { parentSessionId: header.parentSessionId }),
    ...(header.seedLength === undefined ? {} : { seedLength: header.seedLength }),
    isSubagent: header.isSubagent,
    ...(header.delegationDepth === undefined
      ? {}
      : { delegationDepth: header.delegationDepth }),
    ...(header.creationAgentPreset === undefined
      ? {}
      : { creationAgentPreset: header.creationAgentPreset }),
  })
}

/** Replay inspection through the durable transcript reducer, never a parallel UI reducer. */
export async function projectSessionsInspection(
  snapshot: SessionInspectionSnapshot,
  signal: AbortSignal,
): Promise<SessionsInspectionProjection> {
  const transcript = await projectSessionInspection(snapshot, signal)
  signal.throwIfAborted()
  return Object.freeze({
    sessionId: snapshot.header.sessionId,
    header: detachedInspectionHeader(snapshot.header),
    transcript,
  })
}
