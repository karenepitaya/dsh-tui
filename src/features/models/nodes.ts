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
import { modelEffortChoices, projectModelRows } from './projectors.ts'
import { selectedModelsChoice, type ModelsFeaturePhase, type ModelsFeatureState } from './machine.ts'
import type { ModelsFeatureStateSource } from './model.ts'

export interface ModelsContentNode extends FeatureSurfaceUiNode {
  readonly kind: 'models.content'
  readonly featureId: 'models'
  readonly resourceId: 'models.catalog'
  readonly state: ModelsFeatureStateSource
}

function phaseOf(
  state: ModelsFeatureState,
  context: FeatureSurfaceProjectContext,
): ModelsFeaturePhase {
  if (state.phase !== 'idle') return state.phase
  const resource = context.resources.find(candidate => candidate.id === 'models.catalog')
  return resource?.phase ?? 'idle'
}

function phaseTone(phase: ModelsFeaturePhase): FeatureSurfaceTone {
  if (phase === 'failed') return 'danger'
  if (phase === 'loading' || phase === 'refreshing') return 'warning'
  if (phase === 'ready') return 'success'
  return 'muted'
}

function currentRows(state: ModelsFeatureState): readonly FeatureSurfaceRowInput[] {
  const current = state.snapshot?.current
  if (current === undefined) return []
  return [
    {
      text: `CURRENT  ${current.provider} / ${current.model}`,
      tone: state.snapshot?.routable === true ? 'success' : 'warning',
      bold: true,
    },
    {
      text: `Active reasoning  ${current.reasoningEffort ?? 'provider default'}`,
      tone: 'info',
    },
  ]
}

function rows(
  state: ModelsFeatureState,
  context: FeatureSurfaceProjectContext,
): readonly FeatureSurfaceRowInput[] {
  const phase = phaseOf(state, context)
  const choices = projectModelRows(state.snapshot)
  const selectedChoice = selectedModelsChoice(state)
  const result: FeatureSurfaceRowInput[] = [{
    text: `${choices.length} model${choices.length === 1 ? '' : 's'}`
      + (phase === 'loading' || phase === 'refreshing' ? ` · ${phase}…` : ''),
    tone: phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }]
  if (selectedChoice !== undefined) {
    const options = modelEffortChoices(state.snapshot, selectedChoice)
    result.push({
      text: `Reasoning  ${selectedChoice.reasoningEffortName}`
        + (options.length > 1 ? ' · ←/→ change' : ' · fixed'),
      tone: 'info',
    })
  }
  if (context.bounds.height >= 9 && choices.length > 0) {
    result.push(...currentRows(state))
  }

  if (state.error !== undefined) {
    result.push({ text: `Last operation failed · ${state.error}`, tone: 'danger' })
  }
  if (state.snapshot?.writable === false) {
    result.push({ text: 'Read-only · this Agent is owned by another Host', tone: 'warning' })
  }
  for (const failure of state.snapshot?.failures ?? []) {
    result.push({ text: `${failure.provider} · ${failure.message}`, tone: 'danger', dim: true })
  }
  if (choices.length === 0) {
    result.push({
      text: phase === 'loading' || phase === 'refreshing'
        ? 'Loading provider model catalogs…'
        : 'No models available · R retry; check provider settings',
      tone: phaseTone(phase),
      dim: true,
    })
    return result
  }

  const capacity = Math.max(0, Math.floor(context.bounds.height) - result.length)
  const visible = featureListViewport(choices, state.selectedIndex, capacity)
  result.push(...visible.map((choice) => {
    const selected = choice.provider === selectedChoice?.provider && choice.model === selectedChoice.model
    const markers = [
      choice.isCurrent ? 'current' : undefined,
      choice.isDefault ? 'default' : undefined,
      !choice.catalogued ? 'retained' : undefined,
      !choice.routable ? 'unroutable' : undefined,
    ].filter((value): value is string => value !== undefined)
    return {
      text: choiceText(`${choice.modelName} · ${choice.providerName}`
        + (markers.length === 0 ? '' : ` · ${markers.join('/')}`), selected),
      tone: !choice.routable
        ? 'warning' as const
        : choice.isCurrent
          ? 'success' as const
          : selected ? 'accent' as const : 'default' as const,
      bold: selected,
      dim: false,
      selected,
    }
  }))
  return result
}

function actionHint(state: ModelsFeatureState): string {
  const selected = selectedModelsChoice(state)
  if (selected === undefined) return 'R retry · check provider settings'
  if (state.snapshot?.writable !== true) return 'Read-only · R refresh'
  if (state.agentStatus?.status !== 'idle') return 'Wait for Agent to be idle · R refresh'
  if (state.selecting || state.snapshot.selecting) return 'Applying model…'
  if (!selected.routable) return '↑↓ choose an available model · R refresh'
  return '↑↓ model'
    + (modelEffortChoices(state.snapshot, selected).length > 1 ? ' · ←→ reasoning' : '')
    + ' · Enter apply · Ctrl+S default'
}

export function createModelsContentNode(
  state: ModelsFeatureStateSource,
): ModelsContentNode {
  return Object.freeze({
    kind: 'models.content',
    featureId: 'models',
    resourceId: 'models.catalog',
    state,
    project: (context: FeatureSurfaceProjectContext) => {
      const snapshot = state.snapshot()
      return Object.freeze({
        ...createFeatureSurfaceProjection(context, rows(snapshot, context)),
        actionHint: actionHint(snapshot),
      })
    },
    onChanged: (listener: FeatureSurfaceInvalidationListener) => (
      state.onChanged(() => { listener() })
    ),
  })
}
