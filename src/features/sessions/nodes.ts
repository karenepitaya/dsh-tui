import { choiceText } from '../../presentation/control-projection.ts'
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
  if (phase === 'loading') return ' · loading'
  if (phase === 'refreshing') return ' · refreshing'
  if (phase === 'failed') return ' · refresh failed'
  return ''
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

function sessionLabel(row: SessionsCatalogRow): string {
  return row.title?.trim() || 'Untitled session'
}

function localCreatedAt(value: number): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'unknown date'
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

function selectedActionHint(row: SessionsCatalogRow, state: SessionsFeatureState): string {
  if (row.relation === 'current') return 'Enter return to chat · f fork · / search'
  if (row.relation === 'other-live' && !row.isSubagent && state.navigation.sessionId !== undefined) {
    return 'Enter attach · f fork · / search'
  }
  if (row.durablePresence !== 'observed' || projectSessionsCatalog(state).durability !== 'available') {
    return 'Durable history unavailable · R refresh'
  }
  return 'Enter inspect · f fork · / search'
}

function actionHint(state: SessionsFeatureState, inspector = false): string {
  const operation = state.operation.phase
  if (state.navigation.busy) return 'Wait for the current session operation · R refresh'
  if (operation === 'confirm-resume' || operation === 'confirm-fork') return 'Enter confirm'
  if (operation === 'running') return 'Operation continues until settled'
  if (operation === 'failed') return 'Return to the catalog to retry'
  const catalog = projectSessionsCatalog(state)
  const selected = catalog.rows[catalog.selectedIndex]
  if (selected === undefined) return '/ search · R refresh'
  if (!inspector) return selectedActionHint(selected, state)
  const canResume = state.inspection.phase === 'ready'
    && state.inspection.projection.sessionId === selected.sessionId
    && selected.relation === 'cold' && !selected.isSubagent
    && selected.durablePresence === 'observed' && catalog.durability === 'available'
  return `${canResume ? 'a resume · ' : ''}f fork · R refresh`
}

function navigatorRows(
  context: FeatureSurfaceProjectContext,
  state: SessionsFeatureState,
): readonly FeatureSurfaceRowInput[] {
  const catalog = projectSessionsCatalog(state)
  const phase = statePhase(context, SESSIONS_CATALOG_RESOURCE_ID, state.catalog.phase)
  const header: FeatureSurfaceRowInput = {
    text: `${catalog.filteredCount}/${catalog.totalCount} matching${phaseLabel(phase)}`,
    tone: phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }
  const query: FeatureSurfaceRowInput = state.query.length === 0
    ? { text: '⌕ Filter sessions…', tone: 'muted', dim: true }
    : { text: `⌕ ${state.query}`, tone: 'info', bold: true }
  const availableRows = Math.max(0, Math.floor(context.bounds.height) - 2)
  const rowsPerSession = availableRows >= 2 ? 2 : 1
  const capacity = Math.floor(availableRows / rowsPerSession)
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
  return [header, query, ...visible.flatMap((row): FeatureSurfaceRowInput[] => {
    const selected = row.sessionId === catalog.selectedSessionId
    const label: FeatureSurfaceRowInput = {
      text: choiceText(`${sessionLabel(row)} · ${catalogRowStatus(row)}`, selected),
      tone: row.liveStatus === 'running'
        ? 'success' as const
        : selected
          ? 'accent' as const
          : 'default' as const,
      bold: selected,
      dim: false,
      selected,
    }
    const directory = row.cwd?.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'No working directory'
    return rowsPerSession === 1 ? [label] : [label, {
      text: `  ${directory} · ${localCreatedAt(row.createdAt)}`,
      tone: 'muted', dim: true,
    }]
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
  return Object.freeze({
    ...createFeatureSurfaceProjection(context, navigatorRows(context, snapshot), cursor),
    actionHint: actionHint(snapshot) + ' · Tab details',
  })
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
  const rows: FeatureSurfaceRowInput[] = []
  if (selected === undefined) {
    rows.push({
      text: state.query.length > 0 ? `No match for “${state.query}”` : 'Select a session to inspect',
      tone: phaseTone(phase),
      dim: true,
    })
    return rows
  }

  rows.push({
    text: `› ${sessionLabel(selected)}`,
    tone: selected.liveStatus === 'running' ? 'success' : 'accent',
    bold: true,
    selected: true,
  })
  if (selected.cwd !== undefined) rows.push({ text: selected.cwd, tone: 'info' })
  if (selected.titleUnavailable === true) {
    rows.push({ text: 'Title unavailable · R refresh', tone: 'warning' })
  }
  rows.push({
    text: `Status  ${catalogRowStatus(selected)}`,
    tone: selected.liveStatus === 'running' ? 'success' : 'default',
  })
  rows.push({ text: `Created  ${context.focus ? timestamp(selected.createdAt) : localCreatedAt(selected.createdAt)}`, tone: 'muted', dim: true })
  if (context.focus) {
    rows.push({ text: `ID  ${selected.sessionId}`, tone: 'muted', dim: true })
    rows.push({
      text: `Storage  ${selected.durablePresence} · catalog ${catalog.durability}`,
      tone: catalog.durability === 'available' ? 'muted' : 'warning',
      dim: catalog.durability === 'available',
    })
    if (selected.titleUpdatedAt !== undefined) {
      rows.push({ text: `Title updated  ${timestamp(selected.titleUpdatedAt)}`, tone: 'muted', dim: true })
    }
    if (selected.parentSessionId !== undefined) {
      rows.push({ text: `Parent  ${selected.parentSessionId}`, tone: 'muted' })
    }
    if (selected.creationAgentPreset !== undefined) {
      rows.push({ text: `Preset  ${selected.creationAgentPreset}`, tone: 'muted' })
    }
  } else if (catalog.durability !== 'available' || selected.durablePresence !== 'observed') {
    rows.push({ text: 'Saved history unavailable · R refresh', tone: 'warning' })
  }
  if (state.catalog.phase === 'failed') {
    rows.push({ text: `Refresh failed · ${state.catalog.message}`, tone: 'danger' })
  }
  rows.push(...operationRows(state))
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

function inspectorRows(state: SessionsFeatureState): readonly FeatureSurfaceRowInput[] {
  const projection = inspectionProjection(state.inspection)
  const rows: FeatureSurfaceRowInput[] = []
  if (projection === undefined) {
    if (state.inspection.phase === 'loading') {
      rows.push({
        text: `› ${inspectionLabel(state, state.inspection.sessionId)}`,
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
  const label = inspectionLabel(state, projection.sessionId)
  rows.push({
    text: `› ${label}`,
    tone: session?.agentStatus === 'running' ? 'success' : 'accent',
    bold: true,
    selected: true,
  })
  if (label !== projection.sessionId) rows.push({ text: `ID  ${projection.sessionId}`, tone: 'muted', dim: true })
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
  return rows
}

function inspectionLabel(state: SessionsFeatureState, sessionId: string): string {
  const entry = 'snapshot' in state.catalog
    ? state.catalog.snapshot?.sessions.find(candidate => candidate.sessionId === sessionId)
    : undefined
  return entry?.title?.trim() || sessionId
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
  const detail = createFeatureDetailSurface({
    rows: context => contentRows(context, state.snapshot()),
    key: () => projectSessionsCatalog(state.snapshot()).selectedSessionId,
    hasContent: () => projectSessionsCatalog(state.snapshot()).selectedSessionId !== undefined,
    onChanged: listener => onChanged(state, listener),
  })
  return Object.freeze({
    kind: 'sessions.content',
    featureId: 'sessions',
    state,
    catalogResourceId: SESSIONS_CATALOG_RESOURCE_ID,
    ...detail,
    project: (context: FeatureSurfaceProjectContext) => Object.freeze({ ...detail.project(context), actionHint: actionHint(state.snapshot()) }),
  })
}

export function createSessionsInspectorNode(
  state: SessionsFeatureStateSource,
): SessionsInspectorNode {
  const detail = createFeatureDetailSurface({
    rows: () => inspectorRows(state.snapshot()),
    key: () => inspectionProjection(state.snapshot().inspection)?.sessionId,
    hasContent: () => state.snapshot().inspection.phase !== 'idle',
    onChanged: listener => onChanged(state, listener),
  })
  return Object.freeze({
    kind: 'sessions.inspector',
    featureId: 'sessions',
    state,
    catalogResourceId: SESSIONS_CATALOG_RESOURCE_ID,
    inspectionResourceId: SESSIONS_INSPECTION_RESOURCE_ID,
    ...detail,
    project: (context: FeatureSurfaceProjectContext) => Object.freeze({ ...detail.project(context), actionHint: actionHint(state.snapshot(), true) }),
  })
}
