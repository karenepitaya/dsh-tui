import type {
  ActivityCenterRow,
  ActivityCenterTab,
  ActivityCenterView,
} from '../../activity/center.ts'
import { choiceText } from '../../presentation/control-projection.ts'
import {
  createFeatureSurfaceProjection,
  featureListViewport,
  type FeatureSurfaceInvalidationListener,
  type FeatureSurfaceProjectContext,
  type FeatureSurfaceRowInput,
  type FeatureSurfaceTone,
  type FeatureSurfaceUiNode,
} from '../../presentation/feature-surface.ts'
import {
  ACTIVITY_RESOURCE_ID,
  projectActivityCenter,
  type ActivityFeatureState,
} from './machine.ts'
import type { ActivityFeatureStateSource } from './model.ts'

export interface ActivityNavigatorNode extends FeatureSurfaceUiNode {
  readonly kind: 'activity.navigator'
  readonly featureId: 'activity'
  readonly state: ActivityFeatureStateSource
  readonly resourceId: 'activity.snapshots'
}

export type ActivityUiNode = ActivityNavigatorNode

function onChanged(
  state: ActivityFeatureStateSource,
  listener: FeatureSurfaceInvalidationListener,
): () => void {
  return state.onChanged(() => { listener() })
}

export function activityStatusMarker(status: string): string {
  switch (status) {
    case 'running': return '●'
    case 'stopping': return '◌'
    case 'completed': return '✓'
    case 'idle': return '○'
    case 'ready': return '◇'
    case 'inactive': return '·'
    case 'cancelled': return '■'
    case 'killed': return '■'
    case 'interrupted': return '!'
    case 'failed': return '×'
    case 'diagnostic': return '?'
    default: return '·'
  }
}

export function activityLineage(depth: number): string {
  const clamped = Math.min(4, depth)
  return clamped === 0 ? '' : `${'│ '.repeat(clamped - 1)}└─`
}

function rowTone(row: ActivityCenterRow): FeatureSurfaceTone {
  switch (row.statusTone) {
    case 'running':
    case 'completed': return 'success'
    case 'failed':
    case 'diagnostic': return 'danger'
    case 'stopping':
    case 'cancelled':
    case 'killed':
    case 'interrupted': return 'warning'
    case 'idle':
    case 'ready': return 'info'
    case 'inactive': return 'muted'
  }
}

function tabStrip(view: ActivityCenterView): string {
  return view.tabs.map((tab) => {
    const live = tab.live === 0 ? '' : ` · ${tab.live} LIVE`
    const label = `${tab.label.toUpperCase()} ${tab.count}${live}`
    return tab.selected ? `▰ ${label}` : label
  }).join('  │  ')
}

export function activityEmptyText(tab: ActivityCenterTab): string {
  if (tab === 'jobs') return 'No background Jobs in this Session.'
  if (tab === 'subagents') return 'No durable Subagent descendants.'
  return 'No top-level Workflow runs in this Session.'
}

function bandRows(
  view: ActivityCenterView,
  feedError: string | undefined,
): readonly FeatureSurfaceRowInput[] {
  const rows: FeatureSurfaceRowInput[] = []
  if (view.loading) rows.push({ text: 'Refreshing Subagent catalog…', tone: 'warning', bold: true })
  if (view.tab === 'subagents' && !view.subagentsAvailable) {
    rows.push({
      text: 'Subagent service is not mounted in this Agent composition.',
      tone: 'warning',
    })
  }
  if (feedError !== undefined) rows.push({ text: `Feed error: ${feedError}`, tone: 'danger', bold: true })
  if (view.error !== undefined) rows.push({ text: `Error: ${view.error}`, tone: 'danger', bold: true })
  if (view.notice !== undefined) rows.push({ text: `Notice: ${view.notice}`, tone: 'success' })
  return rows
}

function confirmRows(view: ActivityCenterView): readonly FeatureSurfaceRowInput[] {
  if (!view.confirmStop) return []
  const selected = view.rows[view.selectedIndex]
  if (selected === undefined) return []
  return [
    { text: `Stop ${selected.title}?`, tone: 'warning', bold: true },
    { text: 'Enter confirm', tone: 'warning', dim: true },
  ]
}

function actionHint(view: ActivityCenterView | undefined): string {
  if (view?.confirmStop === true) return 'Enter confirm'
  return '[/] tabs · j/k move · Enter details · K stop · R refresh'
}

function navigatorRows(
  context: FeatureSurfaceProjectContext,
  state: ActivityFeatureState,
): readonly FeatureSurfaceRowInput[] {
  const view = projectActivityCenter(state)
  if (view === undefined) {
    return [{ text: 'Opening Activity Center…', tone: 'muted', dim: true }]
  }
  const header: FeatureSurfaceRowInput = { text: tabStrip(view), tone: 'accent', bold: true }
  const bands = bandRows(view, state.feedError)
  const confirm = confirmRows(view)
  if (view.rows.length === 0) {
    return [
      header,
      ...bands,
      { text: activityEmptyText(view.tab), tone: 'muted', dim: true },
      ...confirm,
    ]
  }
  const capacity = Math.max(
    0,
    Math.floor(context.bounds.height) - 1 - bands.length - confirm.length,
  )
  const visible = featureListViewport(view.rows, view.selectedIndex, capacity)
  return [
    header,
    ...bands,
    ...visible.map((row): FeatureSurfaceRowInput => ({
      text: choiceText(`${activityLineage(row.depth)}${activityStatusMarker(row.status)} ${row.title}`, row.selected),
      tone: row.selected ? 'accent' : rowTone(row),
      bold: row.selected,
      dim: !row.selected && row.statusTone === 'inactive',
      selected: row.selected,
    })),
    ...confirm,
  ]
}

export function createActivityNavigatorNode(
  state: ActivityFeatureStateSource,
): ActivityNavigatorNode {
  return Object.freeze({
    kind: 'activity.navigator',
    featureId: 'activity',
    state,
    resourceId: ACTIVITY_RESOURCE_ID,
    project: (context: FeatureSurfaceProjectContext) => Object.freeze({
      title: 'Activity',
      ...createFeatureSurfaceProjection(context, navigatorRows(context, state.snapshot())),
      actionHint: actionHint(projectActivityCenter(state.snapshot())),
    }),
    onChanged: (listener: FeatureSurfaceInvalidationListener) => onChanged(state, listener),
  })
}
