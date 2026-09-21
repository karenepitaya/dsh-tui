import {
  selectActivityCenter,
  type ActivityCenterRow,
  type ActivityCenterTab,
} from '../../activity/center.ts'
import type { ActivityFeatureState } from './machine.ts'

export interface ActivityDetailField {
  readonly id: string
  readonly label: string
  readonly value: string
}

export interface ActivityDetailsView {
  readonly title: string
  readonly fields: readonly ActivityDetailField[]
}

function authorityOf(tab: ActivityCenterTab): string {
  if (tab === 'jobs') return 'JobRegistry'
  if (tab === 'subagents') return 'SubagentRuntime'
  return 'Session events'
}

function controlOf(tab: ActivityCenterTab, selected: ActivityCenterRow): string {
  if (tab === 'workflows') return 'Read-only from parent Session'
  if (selected.stoppable) return tab === 'jobs' ? 'Stop available' : 'Interrupt available'
  return 'No live stop authority'
}

function field(id: string, label: string, value: string): ActivityDetailField {
  return Object.freeze({ id, label, value })
}

/** Read-only inspector content for the selected operation, as plain display data. */
export function projectActivityDetails(
  state: ActivityFeatureState,
): ActivityDetailsView | undefined {
  const view = selectActivityCenter(state.center, state.jobs, state.delegation)
  const selected = view?.rows[view.selectedIndex]
  if (view === undefined || selected === undefined) return undefined
  return Object.freeze({
    title: selected.title,
    fields: Object.freeze([
      field('state', 'State', selected.status),
      field('identity', 'Identity', selected.meta),
      field('authority', 'Authority', authorityOf(view.tab)),
      field('control', 'Control', controlOf(view.tab, selected)),
      ...(selected.detail.length === 0
        ? []
        : [field('trace', 'Trace', selected.detail.join('\n'))]),
    ]),
  })
}
