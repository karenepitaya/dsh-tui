import type {
  ActivityCenterRow,
  ActivityCenterTab,
  ActivityCenterView,
} from '../../activity/center.ts'
import { choiceText } from '../../presentation/control-projection.ts'
import {
  createFeatureDetailSurface,
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

export interface ActivityInspectorNode extends FeatureSurfaceUiNode {
  readonly kind: 'activity.inspector'
  readonly featureId: 'activity'
  readonly state: ActivityFeatureStateSource
  readonly resourceId: 'activity.snapshots'
}

export type ActivityUiNode =
  | ActivityNavigatorNode
  | ActivityInspectorNode

function onChanged(
  state: ActivityFeatureStateSource,
  listener: FeatureSurfaceInvalidationListener,
): () => void {
  return state.onChanged(() => { listener() })
}

function statusMarker(status: string): string {
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

function lineage(depth: number): string {
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

function emptyText(tab: ActivityCenterTab): string {
  if (tab === 'jobs') return 'No background Jobs in this Session.'
  if (tab === 'subagents') return 'No durable Subagent descendants.'
  return 'No top-level Workflow runs in this Session.'
}

function authorityOf(tab: ActivityCenterTab): string {
  if (tab === 'jobs') return 'JobRegistry'
  if (tab === 'subagents') return 'SubagentRuntime'
  return 'Session events'
}

function controlOf(view: ActivityCenterView, selected: ActivityCenterRow | undefined): string {
  if (selected === undefined) return 'No operation selected'
  if (view.tab === 'workflows') return 'Read-only from parent Session'
  if (selected.stoppable) return view.tab === 'jobs' ? 'Stop available' : 'Interrupt available'
  return 'No live stop authority'
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
    { text: 'Enter confirm · Esc back', tone: 'warning', dim: true },
  ]
}

function actionHint(view: ActivityCenterView | undefined): string {
  if (view?.confirmStop === true) return 'Enter confirm · Esc back'
  return '[/] tabs · j/k move · K stop · R refresh · Esc back'
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
      { text: emptyText(view.tab), tone: 'muted', dim: true },
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
      text: choiceText(`${lineage(row.depth)}${statusMarker(row.status)} ${row.title}`, row.selected),
      tone: row.selected ? 'accent' : rowTone(row),
      bold: row.selected,
      dim: !row.selected && row.statusTone === 'inactive',
      selected: row.selected,
    })),
    ...confirm,
  ]
}

function inspectorRows(state: ActivityFeatureState): readonly FeatureSurfaceRowInput[] {
  const view = projectActivityCenter(state)
  const selected = view?.rows[view.selectedIndex]
  if (view === undefined || selected === undefined) {
    return [{ text: 'No operation selected', tone: 'muted', dim: true }]
  }
  const control = controlOf(view, selected)
  const rows: FeatureSurfaceRowInput[] = [
    {
      text: `Selected operation  ${selected.title}`,
      tone: 'accent',
      bold: true,
      selected: true,
    },
    { text: `State  ${selected.status}`, tone: rowTone(selected), bold: true },
    { text: `Identity  ${selected.meta}`, tone: 'default' },
    { text: `Authority  ${authorityOf(view.tab)}`, tone: 'info', bold: true },
    {
      text: `Control  ${control}`,
      tone: selected.stoppable ? 'success' : view.tab === 'workflows' ? 'warning' : 'muted',
      bold: selected.stoppable || view.tab === 'workflows',
    },
    ...selected.detail.map(line => ({
      text: `Trace  ${line}`,
      tone: 'muted' as const,
      dim: true,
    })),
  ]
  rows.push(...bandRows(view, state.feedError), ...confirmRows(view))
  return rows
}

function selectedKey(state: ActivityFeatureState): string | undefined {
  const view = projectActivityCenter(state)
  const selected = view?.rows[view.selectedIndex]
  return view === undefined || selected === undefined
    ? undefined
    : `${view.tab}:${selected.key}`
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

export function createActivityInspectorNode(
  state: ActivityFeatureStateSource,
): ActivityInspectorNode {
  const detail = createFeatureDetailSurface({
    rows: () => inspectorRows(state.snapshot()),
    key: () => selectedKey(state.snapshot()),
    hasContent: () => selectedKey(state.snapshot()) !== undefined,
    onChanged: listener => onChanged(state, listener),
  })
  return Object.freeze({
    kind: 'activity.inspector',
    featureId: 'activity',
    state,
    resourceId: ACTIVITY_RESOURCE_ID,
    ...detail,
    project: (context: FeatureSurfaceProjectContext) => Object.freeze({
      title: 'Activity detail',
      ...detail.project(context),
      actionHint: actionHint(projectActivityCenter(state.snapshot())),
    }),
  })
}
