import { FormWorkspace, type FormWorkspaceModel } from 'pi-tui-orbs'
import type { FeatureSurfaceRuntimeSnapshot } from '../app/feature-surface-runtime.ts'
import {
  projectModesChoices,
  type ModesFeatureState,
  type ModesFeatureStateSource,
  type ModesContentNode,
} from '../features/modes/index.ts'
import { formWorkspaceStrings } from './form-workspace-strings.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'

export interface ModesFrameOptions {
  readonly uiLanguage?: string
  readonly deferLayout?: boolean
}

/** The Feature-owned state source rides its content-region node, the same seam the host's detail scroller uses. */
export function modesStateSource(
  snapshot: FeatureSurfaceRuntimeSnapshot,
): ModesFeatureStateSource | undefined {
  const contribution = snapshot.host.slots.contributions.find(candidate => (
    candidate.featureId === 'modes' && candidate.value.role === 'content'
  ))
  const node = contribution?.value.node as ModesContentNode | null | undefined
  return node?.kind === 'modes.content' ? node.state : undefined
}

function statusMessage(state: ModesFeatureState): { text: string; tone: 'error' | 'warning' | 'muted' } | undefined {
  if (state.selecting || state.snapshot?.selecting === true) {
    return { text: 'Changing mode…', tone: 'warning' }
  }
  if (state.error !== undefined) {
    return { text: `Last operation failed · ${state.error}`, tone: 'error' }
  }
  if (state.snapshot?.locked === true) {
    // The lock notice and the current mode are independent facts: the old
    // renderer showed both, so the message keeps the current mode visible.
    const current = state.snapshot.current
    return {
      text: 'Session started · mode locked · /new to choose another'
        + (current === undefined ? '' : ` · Current ${current}`),
      tone: 'warning',
    }
  }
  if (state.snapshot?.available === false) {
    return { text: 'Unavailable · DSH AgentPresets is not active', tone: 'warning' }
  }
  if (state.snapshot?.current !== undefined) {
    return { text: `Current ${state.snapshot.current}`, tone: 'muted' }
  }
  return undefined
}

/** DSH-owned copy stops here; Orbs owns the list and footer layout. */
export function modesFormModel(
  state: ModesFeatureState,
  viewport: TerminalViewport,
  options: ModesFrameOptions = {},
): FormWorkspaceModel {
  const choices = projectModesChoices(state.snapshot)
  const strings = formWorkspaceStrings(options.uiLanguage)
  const message = statusMessage(state)
  const loading = state.phase === 'loading' || state.phase === 'refreshing'
  return {
    height: Math.max(1, Math.floor(viewport.rows)),
    header: 'Modes',
    categories: [{ id: 'modes', label: `Modes ${choices.length}` }],
    activeCategoryId: 'modes',
    focus: 'content',
    searchHidden: true,
    actions: [],
    groups: [],
    dirtyCount: 0,
    body: {
      kind: 'list',
      items: choices.map((choice) => {
        const badge = [
          choice.isCurrent ? 'current' : undefined,
          choice.isDefault ? 'default' : undefined,
          choice.broken === undefined ? undefined : 'broken',
        ].filter((marker): marker is string => marker !== undefined).join('/')
        return {
          id: choice.id,
          label: choice.name,
          value: choice.trust,
          ...(badge === '' ? {} : { badge }),
          ...(choice.isCurrent
            ? { tone: 'success' as const }
            : choice.isDefault
              ? { tone: 'accent' as const }
              : {}),
          ...(choice.description === undefined ? {} : { description: choice.description }),
        }
      }),
      selectedIndex: Math.max(0, state.selectedIndex),
      emptyMessage: loading
        ? 'Loading Agent presets…'
        : 'No Agent modes available · R retry; check preset settings',
    },
    ...(message === undefined ? {} : { message: message.text, messageTone: message.tone }),
    help: '↑↓ select · Enter choose · r refresh · q back',
    ...(strings === undefined ? {} : { strings }),
  }
}

/** Mirrors the settings dual path: retained drivers consume the model, snapshots use plain lines. */
export function renderModesFrame(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  viewport: TerminalViewport,
  options: ModesFrameOptions = {},
): UiFrame | undefined {
  const source = modesStateSource(snapshot)
  if (source === undefined) return undefined
  const bounded = {
    columns: Math.max(1, Math.floor(viewport.columns)),
    rows: Math.max(1, Math.floor(viewport.rows)),
  }
  const model = modesFormModel(source.snapshot(), bounded, options)
  if (options.deferLayout === true) {
    return { title: 'Modes', viewport: bounded, lines: [], formWorkspace: model }
  }
  const component = new FormWorkspace(model)
  const lines = component.render(bounded.columns)
  const cursor = component.getCursor()
  return {
    title: 'Modes',
    viewport: bounded,
    lines,
    formWorkspace: model,
    ...(cursor === undefined ? {} : { cursor }),
  }
}
