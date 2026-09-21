import { choiceText } from '../../presentation/control-projection.ts'
import {
  createFeatureSurfaceProjection,
  featureListViewport,
  featureSurfaceTextWidth,
  type FeatureSurfaceInvalidationListener,
  type FeatureSurfaceProjectContext,
  type FeatureSurfaceRowInput,
  type FeatureSurfaceTone,
  type FeatureSurfaceUiNode,
} from '../../presentation/feature-surface.ts'
import {
  SESSIONS_CATALOG_RESOURCE_ID,
  projectSessionsCatalog,
  type SessionsFeatureState,
} from './machine.ts'
import type { SessionsFeatureStateSource } from './model.ts'
import type { SessionsCatalogRow } from './projectors.ts'

export interface SessionsNavigatorNode extends FeatureSurfaceUiNode {
  readonly kind: 'sessions.navigator'
  readonly featureId: 'sessions'
  readonly state: SessionsFeatureStateSource
  readonly catalogResourceId: 'sessions.catalog'
}

export type SessionsUiNode = SessionsNavigatorNode

function onChanged(
  state: SessionsFeatureStateSource,
  listener: FeatureSurfaceInvalidationListener,
): () => void {
  return state.onChanged(() => { listener() })
}

function statePhase(
  context: FeatureSurfaceProjectContext,
  fallback: string,
): string {
  return context.resources.find(resource => resource.id === SESSIONS_CATALOG_RESOURCE_ID)?.phase ?? fallback
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

export function catalogRowStatus(row: SessionsCatalogRow): string {
  const parts: string[] = []
  if (row.liveStatus !== undefined) parts.push(row.liveStatus)
  if (row.relation === 'current') parts.push('current')
  else if (row.attached) parts.push('attached')
  if (row.isSubagent) parts.push('subagent')
  if (parts.length === 0) parts.push(row.durablePresence === 'observed' ? 'saved' : 'detached')
  return parts.join(' · ')
}

export function sessionLabel(row: SessionsCatalogRow): string {
  return row.title?.trim() || 'Untitled session'
}

export function localCreatedAt(value: number): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'unknown date'
}

export function sessionTimestamp(value: number): string {
  if (!Number.isFinite(value)) return 'unknown'
  try {
    return new Date(value).toISOString()
  } catch {
    return String(value)
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

function actionHint(state: SessionsFeatureState): string {
  const operation = state.operation.phase
  if (state.navigation.busy) return 'Wait for the current session operation · R refresh'
  if (operation === 'confirm-resume' || operation === 'confirm-fork') return 'Enter confirm'
  if (operation === 'running') return 'Operation continues until settled'
  if (operation === 'failed') return 'Return to the catalog to retry'
  const catalog = projectSessionsCatalog(state)
  const selected = catalog.rows[catalog.selectedIndex]
  if (selected === undefined) return '/ search · R refresh'
  return selectedActionHint(selected, state)
}

function navigatorRows(
  context: FeatureSurfaceProjectContext,
  state: SessionsFeatureState,
): readonly FeatureSurfaceRowInput[] {
  const catalog = projectSessionsCatalog(state)
  const phase = statePhase(context, state.catalog.phase)
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
    actionHint: actionHint(snapshot),
  })
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
