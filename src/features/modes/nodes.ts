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
import type { ModesFeaturePhase, ModesFeatureState } from './machine.ts'
import type { ModesFeatureStateSource } from './model.ts'
import { projectModesChoices } from './projectors.ts'

export interface ModesContentNode extends FeatureSurfaceUiNode {
  readonly kind: 'modes.content'
  readonly featureId: 'modes'
  readonly resourceId: 'modes.catalog'
  readonly state: ModesFeatureStateSource
}

function actionHint(state: ModesFeatureState): string {
  if (state.snapshot?.locked === true) return '/new in Chat to choose another mode · R refresh'
  if (state.snapshot?.available !== true) return 'R retry · check mode settings'
  if (state.selecting || state.snapshot.selecting) return 'Changing mode…'
  const selected = projectModesChoices(state.snapshot)[state.selectedIndex]
  if (selected === undefined) return 'R retry · check mode settings'
  if (selected.broken !== undefined) return '↑↓ choose another mode · R refresh'
  return selected.isCurrent ? '↑↓ choose another mode · R refresh' : '↑↓ mode · Enter choose · R refresh'
}

function phaseOf(
  state: ModesFeatureState,
  context: FeatureSurfaceProjectContext,
): ModesFeaturePhase {
  if (state.phase !== 'idle') return state.phase
  return context.resources.find(candidate => candidate.id === 'modes.catalog')?.phase ?? 'idle'
}

function toneOf(phase: ModesFeaturePhase): FeatureSurfaceTone {
  if (phase === 'failed') return 'danger'
  if (phase === 'loading' || phase === 'refreshing') return 'warning'
  if (phase === 'ready') return 'success'
  return 'muted'
}

function rows(
  state: ModesFeatureState,
  context: FeatureSurfaceProjectContext,
): readonly FeatureSurfaceRowInput[] {
  const phase = phaseOf(state, context)
  const choices = projectModesChoices(state.snapshot)
  const result: FeatureSurfaceRowInput[] = [{
    text: `${choices.length} preset${choices.length === 1 ? '' : 's'}`
      + (phase === 'loading' || phase === 'refreshing' ? ` · ${phase}…` : ''),
    tone: phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }]

  if (state.snapshot?.locked === true) {
    result.push({ text: 'Session started · mode locked · /new to choose another', tone: 'warning' })
  }
  const selectedChoice = choices[state.selectedIndex]
  if (selectedChoice !== undefined) {
    result.push({ text: selectedChoice.description ?? 'No purpose description supplied', tone: 'info' })
  }
  if (state.snapshot?.current !== undefined && context.bounds.height >= 8) {
    result.push({
      text: `CURRENT  ${state.snapshot.current}`,
      tone: 'success',
      bold: true,
    })
  }
  if (state.snapshot?.available === false) {
    result.push({ text: 'Unavailable · DSH AgentPresets is not active', tone: 'warning' })
  }
  if (state.error !== undefined) {
    result.push({ text: `Last operation failed · ${state.error}`, tone: 'danger' })
  }
  if (choices.length === 0) {
    result.push({
      text: phase === 'loading' || phase === 'refreshing'
        ? 'Loading Agent presets…'
        : 'No Agent modes available · R retry; check preset settings',
      tone: toneOf(phase),
      dim: true,
    })
    return result
  }

  const capacity = Math.max(0, Math.floor(context.bounds.height) - result.length)
  for (const choice of featureListViewport(choices, state.selectedIndex, capacity)) {
    const selected = choice.id === state.selectedModeId
    const markers = [
      choice.isCurrent ? 'current' : undefined,
      choice.isDefault ? 'default' : undefined,
      choice.broken === undefined ? undefined : 'broken',
    ].filter((value): value is string => value !== undefined)
    result.push({
      text: choiceText(choice.name + (markers.length === 0 ? '' : ` · ${markers.join('/')}`), selected),
      tone: choice.broken !== undefined
        ? 'danger'
        : choice.isCurrent
          ? 'success'
          : selected ? 'accent' : 'default',
      bold: selected,
      dim: false,
      selected,
    })
  }
  return result
}

export function createModesContentNode(
  state: ModesFeatureStateSource,
): ModesContentNode {
  return Object.freeze({
    kind: 'modes.content',
    featureId: 'modes',
    resourceId: 'modes.catalog',
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
