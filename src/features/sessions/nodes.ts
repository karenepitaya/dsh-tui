import {
  createFeatureSurfaceProjection,
  createFeatureDetailSurface,
  featureListViewport,
  featureSurfaceTextWidth,
  type FeatureSurfaceInvalidationListener,
  type FeatureSurfaceProjectContext,
  type FeatureSurfaceRowInput,
  type FeatureSurfaceTone,
  type FeatureSurfaceUiNode,
} from '../../presentation/feature-surface.ts'
import type { TranscriptRow } from '../../transcript/state.ts'
import {
  SESSIONS_CATALOG_RESOURCE_ID,
  SESSIONS_INSPECTION_RESOURCE_ID,
  projectSessionsCatalog,
  type SessionsCatalogState,
  type SessionsFeatureState,
  type SessionsInspectionState,
} from './machine.ts'
import type { SessionsFeatureStateSource } from './model.ts'
import type {
  SessionsCatalogRow,
  SessionsInspectionProjection,
} from './projectors.ts'

export interface SessionsNavigatorNode extends FeatureSurfaceUiNode {
  readonly kind: 'sessions.navigator'
  readonly featureId: 'sessions'
  readonly state: SessionsFeatureStateSource
  readonly catalogResourceId: 'sessions.catalog'
}

export interface SessionsContentNode extends FeatureSurfaceUiNode {
  readonly kind: 'sessions.content'
  readonly featureId: 'sessions'
  readonly state: SessionsFeatureStateSource
  readonly catalogResourceId: 'sessions.catalog'
}

export interface SessionsInspectorNode extends FeatureSurfaceUiNode {
  readonly kind: 'sessions.inspector'
  readonly featureId: 'sessions'
  readonly state: SessionsFeatureStateSource
  readonly catalogResourceId: 'sessions.catalog'
  readonly inspectionResourceId: 'sessions.inspection'
}

export type SessionsUiNode =
  | SessionsNavigatorNode
  | SessionsContentNode
  | SessionsInspectorNode

function onChanged(
  state: SessionsFeatureStateSource,
  listener: FeatureSurfaceInvalidationListener,
): () => void {
  return state.onChanged(() => { listener() })
}

function statePhase(
  context: FeatureSurfaceProjectContext,
  resourceId: string,
  fallback: SessionsCatalogState['phase'] | SessionsInspectionState['phase'],
): string {
  return context.resources.find(resource => resource.id === resourceId)?.phase ?? fallback
}

function phaseTone(phase: string): FeatureSurfaceTone {
  if (phase === 'failed') return 'danger'
  if (phase === 'loading' || phase === 'refreshing') return 'warning'
  if (phase === 'ready') return 'success'
  return 'muted'
}

function phaseLabel(phase: string): string {
  if (phase === 'loading') return 'loading'
  if (phase === 'refreshing') return 'refreshing'
  if (phase === 'failed') return 'stale'
  if (phase === 'ready') return 'ready'
  return 'idle'
}

function catalogRowStatus(row: SessionsCatalogRow): string {
  const parts: string[] = []
  if (row.liveStatus !== undefined) parts.push(row.liveStatus)
  if (row.relation === 'current') parts.push('current')
  else if (row.attached) parts.push('attached')
  if (row.isSubagent) parts.push('subagent')
  if (parts.length === 0) parts.push(row.durablePresence === 'observed' ? 'saved' : 'detached')
  return parts.join(' · ')
}

function operationRows(state: SessionsFeatureState): readonly FeatureSurfaceRowInput[] {
  switch (state.operation.phase) {
    case 'idle':
      return []
    case 'confirm-resume':
      return [{
        text: `Resume cold session ${state.operation.sessionId}? · Enter confirm · Esc back`,
        tone: 'warning',
        bold: true,
      }]
    case 'confirm-fork':
      return [{
        text: `Fork session ${state.operation.sessionId}? · Enter confirm · Esc back`,
        tone: 'warning',
        bold: true,
      }]
    case 'running': {
      const action = state.operation.action === 'fork'
        ? 'Forking'
        : state.operation.action === 'resume-cold' ? 'Resuming' : 'Switching'
      return [{
        text: `${action} ${state.operation.sessionId}… · Esc back (operation continues)`,
        tone: 'warning',
      }]
    }
    case 'failed':
      return [{
        text: `${state.operation.action} failed · ${state.operation.message} · Esc back`,
        tone: 'danger',
      }]
  }
}

function selectedActionHint(row: SessionsCatalogRow): string {
  if (row.relation === 'current') return 'Enter return to chat · f fork · j/k navigate'
  if (row.relation === 'other-live' && !row.isSubagent) {
    return 'Enter attach · f fork · j/k navigate'
  }
  return 'Enter inspect · f fork · j/k navigate'
}

function navigatorRows(
  context: FeatureSurfaceProjectContext,
  state: SessionsFeatureState,
): readonly FeatureSurfaceRowInput[] {
  const catalog = projectSessionsCatalog(state)
  const phase = statePhase(context, SESSIONS_CATALOG_RESOURCE_ID, state.catalog.phase)
  const header: FeatureSurfaceRowInput = {
    text: `SESSIONS  ${catalog.filteredCount}/${catalog.totalCount} · ${phaseLabel(phase)}`,
    tone: phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }
  const query: FeatureSurfaceRowInput = state.query.length === 0
    ? { text: '⌕ Filter sessions…', tone: 'muted', dim: true }
    : { text: `⌕ ${state.query}`, tone: 'info', bold: true }
  const capacity = Math.max(0, Math.floor(context.bounds.height) - 2)
  if (catalog.rows.length === 0) {
    const emptyText = state.catalog.phase === 'failed'
      ? `Catalog unavailable · ${state.catalog.message}`
      : state.query.length > 0
        ? 'No sessions match this query'
        : phase === 'loading'
          ? 'Loading session catalog…'
          : 'No sessions yet'
    return [header, query, { text: emptyText, tone: phaseTone(phase), dim: true }]
  }

  const visible = featureListViewport(catalog.rows, catalog.selectedIndex, capacity)
  return [header, query, ...visible.map((row) => {
    const selected = row.sessionId === catalog.selectedSessionId
    const includePath = context.bounds.width >= 42 && row.cwd !== undefined
    return {
      text: `${selected ? '›' : ' '} ${row.sessionId}  ${catalogRowStatus(row)}`
        + (includePath ? ` · ${row.cwd}` : ''),
      tone: row.liveStatus === 'running'
        ? 'success' as const
        : selected
          ? 'accent' as const
          : 'default' as const,
      bold: selected,
      dim: false,
      selected,
    }
  })]
}

function projectNavigator(
  state: SessionsFeatureStateSource,
  context: FeatureSurfaceProjectContext,
) {
  const snapshot = state.snapshot()
  const cursorPrefix = `⌕ ${snapshot.query}`
  const cursor = context.focus && context.mode === 'insert'
    ? { row: 1, column: featureSurfaceTextWidth(cursorPrefix) }
    : undefined
  return createFeatureSurfaceProjection(context, navigatorRows(context, snapshot), cursor)
}

function timestamp(value: number): string {
  if (!Number.isFinite(value)) return 'unknown'
  try {
    return new Date(value).toISOString()
  } catch {
    return String(value)
  }
}

function contentRows(
  context: FeatureSurfaceProjectContext,
  state: SessionsFeatureState,
): readonly FeatureSurfaceRowInput[] {
  const catalog = projectSessionsCatalog(state)
  const phase = statePhase(context, SESSIONS_CATALOG_RESOURCE_ID, state.catalog.phase)
  const selected = catalog.rows[catalog.selectedIndex]
  const rows: FeatureSurfaceRowInput[] = [{
    text: `SESSION  ${catalog.filteredCount} visible · ${phaseLabel(phase)}`,
    tone: phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }]
  if (selected === undefined) {
    rows.push({
      text: state.query.length > 0 ? `No match for “${state.query}”` : 'Select a session to inspect',
      tone: phaseTone(phase),
      dim: true,
    })
    return rows
  }

  rows.push({
    text: `› ${selected.sessionId}`,
    tone: selected.liveStatus === 'running' ? 'success' : 'accent',
    bold: true,
    selected: true,
  })
  if (selected.cwd !== undefined) rows.push({ text: selected.cwd, tone: 'info' })
  rows.push({
    text: `Status  ${catalogRowStatus(selected)}`,
    tone: selected.liveStatus === 'running' ? 'success' : 'default',
  })
  rows.push({
    text: `Storage  ${selected.durablePresence} · catalog ${catalog.durability}`,
    tone: catalog.durability === 'available' ? 'muted' : 'warning',
    dim: catalog.durability === 'available',
  })
  rows.push({ text: `Created  ${timestamp(selected.createdAt)}`, tone: 'muted', dim: true })
  if (selected.parentSessionId !== undefined) {
    rows.push({ text: `Parent  ${selected.parentSessionId}`, tone: 'muted' })
  }
  if (selected.creationAgentPreset !== undefined) {
    rows.push({ text: `Preset  ${selected.creationAgentPreset}`, tone: 'muted' })
  }
  if (state.catalog.phase === 'failed') {
    rows.push({ text: `Refresh failed · ${state.catalog.message}`, tone: 'danger' })
  }
  rows.push(...operationRows(state))
  if (context.focus && state.operation.phase === 'idle') {
    rows.push({ text: selectedActionHint(selected), tone: 'muted', dim: true })
  }
  return rows
}

function inspectionProjection(
  state: SessionsInspectionState,
): SessionsInspectionProjection | undefined {
  switch (state.phase) {
    case 'ready':
    case 'refreshing':
      return state.projection
    case 'loading':
    case 'failed':
      return state.previous
    case 'idle':
      return undefined
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

function inspectorRows(
  context: FeatureSurfaceProjectContext,
  state: SessionsFeatureState,
): readonly FeatureSurfaceRowInput[] {
  const phase = statePhase(
    context,
    SESSIONS_INSPECTION_RESOURCE_ID,
    state.inspection.phase,
  )
  const projection = inspectionProjection(state.inspection)
  const rows: FeatureSurfaceRowInput[] = [{
    text: `INSPECTOR  ${phaseLabel(phase)}`,
    tone: phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }]
  if (projection === undefined) {
    if (state.inspection.phase === 'loading') {
      rows.push({
        text: `› ${state.inspection.sessionId}`,
        tone: 'accent',
        bold: true,
        selected: true,
      })
      rows.push({ text: 'Replaying durable session events…', tone: 'warning', dim: true })
    } else if (state.inspection.phase === 'failed') {
      rows.push({ text: `Inspection failed · ${state.inspection.message}`, tone: 'danger' })
    } else {
      rows.push({ text: 'Press Enter on a session to inspect it', tone: 'muted', dim: true })
    }
    return rows
  }

  const session = projection.transcript.sessions[projection.sessionId]
  rows.push({
    text: `› ${projection.sessionId}`,
    tone: session?.agentStatus === 'running' ? 'success' : 'accent',
    bold: true,
    selected: true,
  })
  if (projection.header.cwd !== undefined) {
    rows.push({ text: projection.header.cwd, tone: 'info' })
  }
  if (session === undefined) {
    rows.push({ text: 'No projected transcript state', tone: 'warning' })
  } else {
    rows.push({
      text: `Agent  ${session.agentStatus}`,
      tone: session.agentStatus === 'running' ? 'success' : 'muted',
    })
    rows.push({
      text: `Transcript  ${countLabel(session.rows.length, 'row')} · ${countLabel(session.journal.length, 'event')}`,
      tone: 'default',
    })
    rows.push({
      text: `Work  ${countLabel(session.todos.length, 'todo')} · ${countLabel(session.replacements.length, 'replacement')}`,
      tone: 'muted',
    })
    const omitted = (session.omittedRowCount ?? 0) + (session.omittedReplacementCount ?? 0)
    if (omitted > 0) rows.push({ text: `${omitted} older projection items omitted`, tone: 'warning' })
    const preview = transcriptRowPreview(session.rows.at(-1))
    if (preview !== undefined) rows.push({ text: preview, tone: 'default' })
    if (session.compatibilityError !== undefined) {
      rows.push({
        text: `${session.compatibilityError.code} · ${session.compatibilityError.message}`,
        tone: 'danger',
      })
    }
  }
  if (state.inspection.phase === 'refreshing') {
    rows.push({ text: 'Refreshing inspection…', tone: 'warning', dim: true })
  } else if (state.inspection.phase === 'failed') {
    rows.push({ text: `Refresh failed · ${state.inspection.message}`, tone: 'danger' })
  }
  rows.push(...operationRows(state))
  if (context.focus && state.operation.phase === 'idle') {
    const selected = projectSessionsCatalog(state).rows.find(
      row => row.sessionId === projection.sessionId,
    )
    const canResume = selected?.relation === 'cold'
      && !selected.isSubagent
      && selected.durablePresence === 'observed'
      && projectSessionsCatalog(state).durability === 'available'
    rows.push({
      text: `${canResume ? 'a resume · ' : ''}f fork · r refresh · Esc back`,
      tone: 'muted',
      dim: true,
    })
  }
  return rows
}

export function createSessionsNavigatorNode(
  state: SessionsFeatureStateSource,
): SessionsNavigatorNode {
  return Object.freeze({
    kind: 'sessions.navigator',
    featureId: 'sessions',
    state,
    catalogResourceId: SESSIONS_CATALOG_RESOURCE_ID,
    project: (context: FeatureSurfaceProjectContext) => projectNavigator(state, context),
    onChanged: (listener: FeatureSurfaceInvalidationListener) => onChanged(state, listener),
  })
}

export function createSessionsContentNode(
  state: SessionsFeatureStateSource,
): SessionsContentNode {
  return Object.freeze({
    kind: 'sessions.content',
    featureId: 'sessions',
    state,
    catalogResourceId: SESSIONS_CATALOG_RESOURCE_ID,
    ...createFeatureDetailSurface({
      rows: context => contentRows(context, state.snapshot()),
      key: () => projectSessionsCatalog(state.snapshot()).selectedSessionId,
      hasContent: () => projectSessionsCatalog(state.snapshot()).selectedSessionId !== undefined,
      onChanged: listener => onChanged(state, listener),
    }),
  })
}

export function createSessionsInspectorNode(
  state: SessionsFeatureStateSource,
): SessionsInspectorNode {
  return Object.freeze({
    kind: 'sessions.inspector',
    featureId: 'sessions',
    state,
    catalogResourceId: SESSIONS_CATALOG_RESOURCE_ID,
    inspectionResourceId: SESSIONS_INSPECTION_RESOURCE_ID,
    ...createFeatureDetailSurface({
      rows: context => inspectorRows(context, state.snapshot()),
      key: () => inspectionProjection(state.snapshot().inspection)?.sessionId,
      hasContent: () => state.snapshot().inspection.phase !== 'idle',
      onChanged: listener => onChanged(state, listener),
    }),
  })
}
