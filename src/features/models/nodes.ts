import {
  createFeatureSurfaceProjection,
  featureListViewport,
  type FeatureSurfaceInvalidationListener,
  type FeatureSurfaceProjectContext,
  type FeatureSurfaceRowInput,
  type FeatureSurfaceTone,
  type FeatureSurfaceUiNode,
} from '../../presentation/feature-surface.ts'
import { projectModelsChoices } from './projectors.ts'
import type { ModelsFeaturePhase, ModelsFeatureState } from './machine.ts'
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
      text: `REASONING  ${current.reasoningEffort ?? 'provider default'}`,
      tone: 'info',
    },
  ]
}

function rows(
  state: ModelsFeatureState,
  context: FeatureSurfaceProjectContext,
): readonly FeatureSurfaceRowInput[] {
  const phase = phaseOf(state, context)
  const choices = projectModelsChoices(state.snapshot)
  const result: FeatureSurfaceRowInput[] = [{
    text: `MODELS  ${choices.length} route${choices.length === 1 ? '' : 's'} · ${phase}`
      + (choices.length === 0 ? '' : ' · Enter switch · Ctrl+S default · R refresh'),
    tone: phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }, ...currentRows(state)]

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
        : 'No catalogued model routes',
      tone: phaseTone(phase),
      dim: true,
    })
    return result
  }

  const capacity = Math.max(0, Math.floor(context.bounds.height) - result.length)
  const visible = featureListViewport(choices, state.selectedIndex, capacity)
  result.push(...visible.map((choice) => {
    const selected = choice.key === state.selectedKey
    const markers = [
      choice.isCurrent ? 'current' : undefined,
      choice.isDefault ? 'default' : undefined,
      !choice.catalogued ? 'retained' : undefined,
      !choice.routable ? 'unroutable' : undefined,
    ].filter((value): value is string => value !== undefined)
    return {
      text: `${selected ? '›' : ' '} ${choice.providerName} [${choice.provider}]`
        + ` · ${choice.modelName} [${choice.model}]`
        + ` · ${choice.reasoningEffortName}`
        + (markers.length === 0 ? '' : ` · ${markers.join('/')}`),
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

export function createModelsContentNode(
  state: ModelsFeatureStateSource,
): ModelsContentNode {
  return Object.freeze({
    kind: 'models.content',
    featureId: 'models',
    resourceId: 'models.catalog',
    state,
    project: (context: FeatureSurfaceProjectContext) => createFeatureSurfaceProjection(
      context,
      rows(state.snapshot(), context),
    ),
    onChanged: (listener: FeatureSurfaceInvalidationListener) => (
      state.onChanged(() => { listener() })
    ),
  })
}
