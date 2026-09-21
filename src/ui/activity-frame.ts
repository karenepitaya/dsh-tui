import { FormWorkspace, type FormWorkspaceModel } from 'pi-tui-orbs'
import type { FeatureSurfaceRuntimeSnapshot } from '../app/feature-surface-runtime.ts'
import {
  activityEmptyText,
  activityLineage,
  activityStatusMarker,
  projectActivityCenter,
  projectActivityDetails,
  type ActivityFeatureState,
  type ActivityFeatureStateSource,
  type ActivityNavigatorNode,
} from '../features/activity/index.ts'
import { formWorkspaceStrings } from './form-workspace-strings.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'

export interface ActivityFrameOptions {
  readonly uiLanguage?: string
  readonly deferLayout?: boolean
}

/** The Feature-owned state source rides its navigator-region node, the same seam the host's detail scroller uses. */
export function activityStateSource(
  snapshot: FeatureSurfaceRuntimeSnapshot,
): ActivityFeatureStateSource | undefined {
  const contribution = snapshot.host.slots.contributions.find(candidate => (
    candidate.featureId === 'activity' && candidate.value.role === 'navigator'
  ))
  const node = contribution?.value.node as ActivityNavigatorNode | null | undefined
  return node?.kind === 'activity.navigator' ? node.state : undefined
}

/** DSH-owned copy stops here; Orbs owns the list, detail modal and stop confirmation layout. */
export function activityFormModel(
  state: ActivityFeatureState,
  viewport: TerminalViewport,
  options: ActivityFrameOptions = {},
): FormWorkspaceModel {
  const view = projectActivityCenter(state)
  const strings = formWorkspaceStrings(options.uiLanguage)
  const tab = view?.tab ?? 'jobs'
  const selected = view?.rows[view.selectedIndex]
  const message = state.feedError !== undefined ? { text: `Feed error: ${state.feedError}`, tone: 'error' as const }
    : view?.error !== undefined ? { text: `Error: ${view.error}`, tone: 'error' as const }
    : view?.notice !== undefined ? { text: `Notice: ${view.notice}`, tone: 'muted' as const }
    : view?.tab === 'subagents' && !view.subagentsAvailable
      ? { text: 'Subagent service is not mounted in this Agent composition.', tone: 'warning' as const }
    : view?.loading === true
      ? { text: 'Refreshing Subagent catalog…', tone: 'warning' as const }
      : undefined
  const modal: FormWorkspaceModel['modal'] = view?.confirmStop === true && selected !== undefined
    ? {
        kind: 'confirmation',
        title: `Stop ${selected.title}?`,
        lines: [`${selected.meta} · ${selected.status}`],
        actions: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'confirm', label: 'Stop' },
        ],
        selectedIndex: 1,
        hint: 'Enter confirm · Esc / q cancel',
      }
    : state.details === undefined
      ? undefined
      : (() => {
          const details = projectActivityDetails(state)
          if (details === undefined) return undefined
          const selectedField = details.fields[
            Math.max(0, Math.min(details.fields.length - 1, state.details!.fieldIndex))
          ]
          return {
            kind: 'form' as const,
            title: details.title,
            groups: [{
              id: 'details',
              title: details.title,
              fields: details.fields.map(entry => ({
                id: entry.id,
                label: entry.label,
                control: { kind: 'text' as const, value: entry.value },
                readonly: true,
              })),
            }],
            ...(selectedField === undefined ? {} : { selectedFieldId: selectedField.id }),
            hint: '↑↓ move · Enter / Esc / q close',
          }
        })()
  return {
    height: Math.max(1, Math.floor(viewport.rows)),
    header: 'Activity',
    categories: view === undefined
      ? [
          { id: 'jobs', label: `Jobs ${state.jobs.jobs.length}` },
          { id: 'subagents', label: `Subagents ${state.delegation.subagents.length}` },
          { id: 'workflows', label: `Workflows ${state.delegation.workflows.length}` },
        ]
      : view.tabs.map(entry => ({
          id: entry.id,
          label: `${entry.label} ${entry.count}${entry.live === 0 ? '' : ` · ${entry.live} live`}`,
        })),
    activeCategoryId: tab,
    focus: 'content',
    searchHidden: true,
    actions: [],
    groups: [],
    dirtyCount: 0,
    body: {
      kind: 'list',
      items: (view?.rows ?? []).map(row => ({
        id: row.key,
        label: `${activityStatusMarker(row.status)} ${activityLineage(row.depth)}${row.title}`,
        value: row.status,
        description: row.meta,
        ...(row.stoppable ? { badge: 'live', tone: 'accent' as const } : {}),
      })),
      selectedIndex: Math.max(0, view?.selectedIndex ?? 0),
      emptyMessage: view === undefined ? 'Opening Activity Center…' : activityEmptyText(tab),
    },
    ...(message === undefined ? {} : { message: message.text, messageTone: message.tone }),
    help: '[/] tabs · ↑↓ select · Enter details · K stop · r refresh · q back',
    ...(strings === undefined ? {} : { strings }),
    ...(modal === undefined ? {} : { modal }),
  }
}

/** Mirrors the settings dual path: retained drivers consume the model, snapshots use plain lines. */
export function renderActivityFrame(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  viewport: TerminalViewport,
  options: ActivityFrameOptions = {},
): UiFrame | undefined {
  const source = activityStateSource(snapshot)
  if (source === undefined) return undefined
  const bounded = {
    columns: Math.max(1, Math.floor(viewport.columns)),
    rows: Math.max(1, Math.floor(viewport.rows)),
  }
  const model = activityFormModel(source.snapshot(), bounded, options)
  if (options.deferLayout === true) {
    return { title: 'Activity', viewport: bounded, lines: [], formWorkspace: model }
  }
  const component = new FormWorkspace(model)
  const lines = component.render(bounded.columns)
  const cursor = component.getCursor()
  return {
    title: 'Activity',
    viewport: bounded,
    lines,
    formWorkspace: model,
    ...(cursor === undefined ? {} : { cursor }),
  }
}
