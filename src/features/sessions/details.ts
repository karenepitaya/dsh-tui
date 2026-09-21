import type { SessionCatalogSnapshot } from '../../session/catalog-port.ts'
import type { TranscriptRow } from '../../transcript/state.ts'
import {
  projectSessionsCatalogSnapshot,
  type SessionsCatalogRow,
  type SessionsInspectionProjection,
} from './projectors.ts'
import type { SessionsFeatureState } from './machine.ts'
import { catalogRowStatus, sessionLabel, sessionTimestamp } from './nodes.ts'

export interface SessionsDetailField {
  readonly id: string
  readonly label: string
  readonly value: string
}

export interface SessionDetailsView {
  readonly title: string
  readonly fields: readonly SessionsDetailField[]
  readonly message?: string
  readonly messageTone?: 'warning' | 'error'
}

function field(id: string, label: string, value: string): SessionsDetailField {
  return Object.freeze({ id, label, value })
}

function catalogSnapshotOf(state: SessionsFeatureState): SessionCatalogSnapshot | undefined {
  switch (state.catalog.phase) {
    case 'idle':
    case 'loading':
      return undefined
    case 'ready':
    case 'refreshing':
    case 'failed':
      return state.catalog.snapshot
  }
}

function inspectionSessionIdOf(state: SessionsFeatureState): string | undefined {
  switch (state.inspection.phase) {
    case 'idle':
      return undefined
    case 'ready':
      return state.inspection.projection.sessionId
    case 'loading':
    case 'refreshing':
    case 'failed':
      return state.inspection.sessionId
  }
}

function inspectionProjectionOf(state: SessionsFeatureState): SessionsInspectionProjection | undefined {
  switch (state.inspection.phase) {
    case 'idle':
      return undefined
    case 'loading':
    case 'failed':
      return state.inspection.previous
    case 'ready':
    case 'refreshing':
      return state.inspection.projection
  }
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function messageText(row: Extract<TranscriptRow, { kind: 'user' | 'assistant' }>): string {
  return row.message.content.flatMap((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return [block.text]
    if (block.type === 'image') return [`[image ${block.attachment.name ?? block.attachment.attachmentId}]`]
    if (block.type === 'tool-call') return [`[tool ${block.name}]`]
    return [`[${block.sourceType}]`]
  }).join(' ')
}

function transcriptRowPreview(row: TranscriptRow | undefined): string | undefined {
  if (row === undefined) return undefined
  switch (row.kind) {
    case 'user':
      return `You  ${messageText(row)}`
    case 'assistant':
      return `Assistant  ${messageText(row)}`
    case 'assistant-draft':
      return `Assistant  ${row.text}`
    case 'tool':
      return `Tool  ${row.name ?? row.callId}`
    case 'command':
      return `Command  /${row.name ?? row.commandId} · ${row.status}`
  }
}

function catalogFields(
  selected: SessionsCatalogRow,
  durability: SessionCatalogSnapshot['durability'],
): SessionsDetailField[] {
  return [
    field('id', 'ID', selected.sessionId),
    ...(selected.cwd === undefined ? [] : [field('path', 'Path', selected.cwd)]),
    field('status', 'Status', catalogRowStatus(selected)),
    field('created', 'Created', sessionTimestamp(selected.createdAt)),
    field('storage', 'Storage', `${selected.durablePresence} · catalog ${durability}`),
    ...(selected.titleUpdatedAt === undefined
      ? []
      : [field('titleUpdated', 'Title updated', sessionTimestamp(selected.titleUpdatedAt))]),
    ...(selected.parentSessionId === undefined
      ? []
      : [field('parent', 'Parent', selected.parentSessionId)]),
    ...(selected.creationAgentPreset === undefined
      ? []
      : [field('preset', 'Preset', selected.creationAgentPreset)]),
  ]
}

function inspectionFields(projection: SessionsInspectionProjection): SessionsDetailField[] {
  const session = projection.transcript.sessions[projection.sessionId]
  if (session === undefined) return [field('agent', 'Agent', 'No projected transcript state')]
  const omitted = (session.omittedRowCount ?? 0) + (session.omittedReplacementCount ?? 0)
  const preview = transcriptRowPreview(session.rows.at(-1))
  return [
    field('agent', 'Agent', session.agentStatus),
    field('transcript', 'Transcript', `${countLabel(session.rows.length, 'row')} · ${countLabel(session.journal.length, 'event')}`),
    field('work', 'Work', `${countLabel(session.todos.length, 'todo')} · ${countLabel(session.replacements.length, 'replacement')}`),
    ...(omitted > 0 ? [field('omitted', 'Omitted', `${omitted} older projection items omitted`)] : []),
    ...(preview === undefined ? [] : [field('lastActivity', 'Last activity', preview)]),
    ...(session.compatibilityError === undefined
      ? []
      : [field('compatibility', 'Compatibility', `${session.compatibilityError.code} · ${session.compatibilityError.message}`)]),
  ]
}

/** Catalog facts plus the live inspection projection for the selected session, as plain display data. */
export function projectSessionDetails(
  state: SessionsFeatureState,
): SessionDetailsView | undefined {
  const catalog = projectSessionsCatalogSnapshot(
    catalogSnapshotOf(state),
    state.query,
    state.selection,
    state.navigation.sessionId,
  )
  const selected = catalog.rows[catalog.selectedIndex]
  if (selected === undefined) return undefined
  const inspected = inspectionSessionIdOf(state) === selected.sessionId
  const projection = inspected ? inspectionProjectionOf(state) : undefined
  const message = !inspected
    ? {}
    : state.inspection.phase === 'loading'
      ? { message: 'Replaying durable session events…', messageTone: 'warning' as const }
      : state.inspection.phase === 'refreshing'
        ? { message: 'Refreshing inspection…', messageTone: 'warning' as const }
        : state.inspection.phase === 'failed'
          ? { message: `Inspection failed · ${state.inspection.message}`, messageTone: 'error' as const }
          : {}
  return Object.freeze({
    title: sessionLabel(selected),
    fields: Object.freeze([
      ...catalogFields(selected, catalog.durability),
      ...(projection === undefined ? [] : inspectionFields(projection)),
    ]),
    ...message,
  })
}
