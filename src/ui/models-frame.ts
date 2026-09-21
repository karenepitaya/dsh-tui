import { FormWorkspace, type FormWorkspaceModel } from 'pi-tui-orbs'
import type { FeatureSurfaceRuntimeSnapshot } from '../app/feature-surface-runtime.ts'
import {
  modelEffortChoices,
  projectModelRows,
  selectedModelsChoice,
  type ModelsFeatureState,
  type ModelsFeatureStateSource,
  type ModelsContentNode,
} from '../features/models/index.ts'
import { formWorkspaceStrings } from './form-workspace-strings.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'

export interface ModelsFrameOptions {
  readonly uiLanguage?: string
  readonly deferLayout?: boolean
}

/** The Feature-owned state source rides its content-region node, the same seam the host's detail scroller uses. */
export function modelsStateSource(
  snapshot: FeatureSurfaceRuntimeSnapshot,
): ModelsFeatureStateSource | undefined {
  const contribution = snapshot.host.slots.contributions.find(candidate => (
    candidate.featureId === 'models' && candidate.value.role === 'content'
  ))
  const node = contribution?.value.node as ModelsContentNode | null | undefined
  return node?.kind === 'models.content' ? node.state : undefined
}

function statusMessage(state: ModelsFeatureState): { text: string; tone: 'error' | 'warning' | 'muted' } | undefined {
  if (state.selecting || state.snapshot?.selecting === true) {
    return { text: 'Applying model…', tone: 'warning' }
  }
  if (state.error !== undefined) {
    return { text: `Last operation failed · ${state.error}`, tone: 'error' }
  }
  if (state.snapshot?.writable === false) {
    return { text: 'Read-only · this Agent is owned by another Host', tone: 'warning' }
  }
  const failures = state.snapshot?.failures ?? []
  if (failures.length > 0) {
    return {
      text: failures.map(failure => `${failure.provider} · ${failure.message}`).join(' · '),
      tone: 'error',
    }
  }
  if (state.agentStatus !== undefined && state.agentStatus.status !== 'idle') {
    return { text: 'Wait for the Agent to be idle · R refresh', tone: 'muted' }
  }
  const current = state.snapshot?.current
  if (current !== undefined) {
    return {
      text: `Current ${current.provider} / ${current.model} · ${current.reasoningEffort ?? 'provider default'}`,
      tone: 'muted',
    }
  }
  return undefined
}

/** DSH-owned copy stops here; Orbs owns the list and footer layout. */
export function modelsFormModel(
  state: ModelsFeatureState,
  viewport: TerminalViewport,
  options: ModelsFrameOptions = {},
): FormWorkspaceModel {
  const choices = projectModelRows(state.snapshot)
  const selectedChoice = selectedModelsChoice(state)
  const selectedRow = choices[Math.max(0, Math.min(choices.length - 1, state.selectedIndex))]
  const selectedModelsChoiceOfModel = selectedRow !== undefined
    && selectedChoice !== undefined
    && selectedChoice.provider === selectedRow.provider
    && selectedChoice.model === selectedRow.model
    ? selectedRow.key
    : undefined
  const strings = formWorkspaceStrings(options.uiLanguage)
  const message = statusMessage(state)
  const loading = state.phase === 'loading' || state.phase === 'refreshing'
  return {
    height: Math.max(1, Math.floor(viewport.rows)),
    header: 'Models',
    categories: [{ id: 'models', label: `Models ${choices.length}` }],
    activeCategoryId: 'models',
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
          choice.catalogued ? undefined : 'retained',
          choice.routable ? undefined : 'unroutable',
        ].filter((marker): marker is string => marker !== undefined).join('/')
        // The selected route's reasoning effort is the ←/→ edit target and
        // stays visible even when the catalog supplies its own description.
        // Rows are model-level representatives, so selection matches by model
        // identity (the list row) and the effort name comes from the
        // Feature's selected effort-level choice.
        const selected = choice.key === selectedModelsChoiceOfModel
        const description = selected
          && modelEffortChoices(state.snapshot, choice).length > 1
          ? `Reasoning ${selectedChoice?.reasoningEffortName ?? choice.reasoningEffortName}`
          : choice.description
        return {
          id: choice.key,
          label: choice.modelName,
          value: choice.providerName,
          ...(badge === '' ? {} : { badge }),
          ...(choice.isCurrent
            ? { tone: 'success' as const }
            : choice.isDefault
              ? { tone: 'accent' as const }
              : {}),
          ...(description === undefined ? {} : { description }),
        }
      }),
      selectedIndex: Math.max(0, state.selectedIndex),
      emptyMessage: loading
        ? 'Loading provider model catalogs…'
        : 'No models available · R retry; check provider settings',
    },
    ...(message === undefined ? {} : { message: message.text, messageTone: message.tone }),
    help: '↑↓ select · ←→ reasoning · Enter apply · Ctrl+S default · r refresh · q back',
    ...(strings === undefined ? {} : { strings }),
  }
}

/** Mirrors the settings dual path: retained drivers consume the model, snapshots use plain lines. */
export function renderModelsFrame(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  viewport: TerminalViewport,
  options: ModelsFrameOptions = {},
): UiFrame | undefined {
  const source = modelsStateSource(snapshot)
  if (source === undefined) return undefined
  const bounded = {
    columns: Math.max(1, Math.floor(viewport.columns)),
    rows: Math.max(1, Math.floor(viewport.rows)),
  }
  const model = modelsFormModel(source.snapshot(), bounded, options)
  if (options.deferLayout === true) {
    return { title: 'Models', viewport: bounded, lines: [], formWorkspace: model }
  }
  const component = new FormWorkspace(model)
  const lines = component.render(bounded.columns)
  const cursor = component.getCursor()
  return {
    title: 'Models',
    viewport: bounded,
    lines,
    formWorkspace: model,
    ...(cursor === undefined ? {} : { cursor }),
  }
}
