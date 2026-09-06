import {
  createFeatureSurfaceProjection,
  createFeatureDetailSurface,
  featureListViewport,
  type FeatureSurfaceInvalidationListener,
  type FeatureSurfaceProjectContext,
  type FeatureSurfaceRowInput,
  type FeatureSurfaceTone,
  type FeatureSurfaceUiNode,
} from '../../presentation/feature-surface.ts'
import type { SessionSkillEntry } from '../../skill/port.ts'
import type { SkillsFeaturePhase, SkillsFeatureState } from './machine.ts'
import type { SkillsFeatureStateSource } from './model.ts'
import {
  describeSkillResource,
  projectSkillsCatalog,
} from './projectors.ts'

export interface SkillsNavigatorNode extends FeatureSurfaceUiNode {
  readonly kind: 'skills.navigator'
  readonly featureId: 'skills'
  readonly resourceId: 'skills.catalog'
  readonly state: SkillsFeatureStateSource
}

export interface SkillsContentNode extends FeatureSurfaceUiNode {
  readonly kind: 'skills.content'
  readonly featureId: 'skills'
  readonly resourceId: 'skills.catalog'
  readonly state: SkillsFeatureStateSource
}

export type SkillsUiNode = SkillsNavigatorNode | SkillsContentNode

function phaseOf(
  state: SkillsFeatureState,
  context: FeatureSurfaceProjectContext,
): SkillsFeaturePhase {
  if (state.phase !== 'idle') return state.phase
  return context.resources.find(candidate => candidate.id === 'skills.catalog')?.phase ?? 'idle'
}

function phaseTone(phase: SkillsFeaturePhase): FeatureSurfaceTone {
  switch (phase) {
    case 'failed': return 'danger'
    case 'loading':
    case 'refreshing': return 'warning'
    case 'ready': return 'success'
    case 'idle': return 'muted'
    /* v8 ignore next 2 -- SkillsFeaturePhase is exhausted above. */
    default: return assertNever(phase)
  }
}

function navigatorRows(
  state: SkillsFeatureState,
  context: FeatureSurfaceProjectContext,
): readonly FeatureSurfaceRowInput[] {
  const phase = phaseOf(state, context)
  const projection = projectSkillsCatalog(state.snapshot, state.query)
  const rows: FeatureSurfaceRowInput[] = [
    {
      text: `SKILLS  ${projection.rows.length}/${projection.totalCount} · ${phase}`,
      tone: phase === 'failed' ? 'danger' : 'accent',
      bold: true,
    },
    {
      text: state.query.length === 0
        ? 'FILTER  i to search · r to refresh'
        : `FILTER  ${state.query}`,
      tone: state.query.length === 0 ? 'muted' : 'info',
    },
  ]
  if (state.snapshot?.stale === true) {
    rows.push({ text: 'Showing last known catalog while discovery refreshes', tone: 'warning' })
  }
  if (state.error !== undefined) {
    rows.push({ text: `Last refresh failed · ${state.error}`, tone: 'danger' })
  }
  if (projection.rows.length === 0) {
    rows.push({
      text: phase === 'loading' || phase === 'refreshing'
        ? 'Discovering user-invocable skills…'
        : state.snapshot?.available === false
          ? 'Skills are unavailable in this Agent composition'
          : state.query.length === 0
            ? 'No user-invocable skills were discovered'
            : 'No skills match the current filter',
      tone: phaseTone(phase),
      dim: true,
    })
    return rows
  }

  const capacity = Math.max(0, Math.floor(context.bounds.height) - rows.length)
  const visible = featureListViewport(projection.rows, state.selectedIndex, capacity)
  rows.push(...visible.map((entry) => {
    const selected = entry.name === state.selectedName
    return {
      text: `${selected ? '›' : ' '} ${entry.name} · ${entry.description}`,
      tone: selected ? 'accent' as const : 'default' as const,
      bold: selected,
      dim: false,
      selected,
    }
  }))
  return rows
}

function resourceLabel(entry: SessionSkillEntry): string | undefined {
  const resource = describeSkillResource(entry)
  return resource === undefined
    ? undefined
    : `${entry.resourceBase?.kind.toUpperCase()}  ${resource}`
}

function contentRows(
  state: SkillsFeatureState,
  context: FeatureSurfaceProjectContext,
): readonly FeatureSurfaceRowInput[] {
  const phase = phaseOf(state, context)
  const projection = projectSkillsCatalog(state.snapshot, state.query)
  const selected = projection.rows[state.selectedIndex]
  if (selected === undefined) {
    return [{
      text: phase === 'loading' || phase === 'refreshing'
        ? 'Loading skill details…'
        : 'Select a skill to inspect its details',
      tone: phaseTone(phase),
      dim: true,
    }]
  }
  const resource = resourceLabel(selected)
  return [
    { text: selected.name, tone: 'accent', bold: true },
    { text: selected.description, tone: 'default' },
    ...(selected.whenToUse === undefined
      ? []
      : [
          { text: 'WHEN TO USE', tone: 'muted', bold: true } as const,
          { text: selected.whenToUse, tone: 'default' as const },
        ]),
    { text: `SOURCE  ${selected.source}`, tone: 'info' },
    { text: `PROVIDER  ${selected.provider}`, tone: 'info' },
    {
      text: selected.modelInvocable
        ? 'INVOCATION  user + model'
        : 'INVOCATION  user only',
      tone: selected.modelInvocable ? 'success' : 'muted',
    },
    ...(resource === undefined ? [] : [{ text: resource, tone: 'muted' as const }]),
  ]
}

function onChanged(
  state: SkillsFeatureStateSource,
  listener: FeatureSurfaceInvalidationListener,
): () => void {
  return state.onChanged(() => { listener() })
}

export function createSkillsNavigatorNode(
  state: SkillsFeatureStateSource,
): SkillsNavigatorNode {
  return Object.freeze({
    kind: 'skills.navigator',
    featureId: 'skills',
    resourceId: 'skills.catalog',
    state,
    project: (context: FeatureSurfaceProjectContext) => createFeatureSurfaceProjection(
      context,
      navigatorRows(state.snapshot(), context),
    ),
    onChanged: (listener: FeatureSurfaceInvalidationListener) => onChanged(state, listener),
  })
}

export function createSkillsContentNode(
  state: SkillsFeatureStateSource,
): SkillsContentNode {
  return Object.freeze({
    kind: 'skills.content',
    featureId: 'skills',
    resourceId: 'skills.catalog',
    state,
    ...createFeatureDetailSurface({
      rows: context => contentRows(state.snapshot(), context),
      key: () => state.snapshot().selectedName,
      hasContent: () => state.snapshot().selectedName !== undefined,
      onChanged: listener => onChanged(state, listener),
    }),
  })
}

/* v8 ignore next 3 -- SkillsFeaturePhase is exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Skills Feature phase: ${String(value)}`)
}
