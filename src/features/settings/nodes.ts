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
  visibleSettingsPreferences,
  type SettingsFeaturePhase,
  type SettingsFeatureState,
} from './machine.ts'
import type { SettingsFeatureStateSource } from './model.ts'
import { projectSettingsRows } from './projectors.ts'

export interface SettingsContentNode extends FeatureSurfaceUiNode {
  readonly kind: 'settings.content'
  readonly featureId: 'settings'
  readonly resourceId: 'settings.preferences'
  readonly state: SettingsFeatureStateSource
}

function phaseOf(
  state: SettingsFeatureState,
  context: FeatureSurfaceProjectContext,
): SettingsFeaturePhase {
  if (state.phase !== 'idle') return state.phase
  return context.resources.find(candidate => candidate.id === 'settings.preferences')?.phase
    ?? 'idle'
}

function phaseTone(phase: SettingsFeaturePhase): FeatureSurfaceTone {
  if (phase === 'failed') return 'danger'
  if (phase === 'loading' || phase === 'refreshing') return 'warning'
  if (phase === 'ready') return 'success'
  return 'muted'
}

function rows(
  state: SettingsFeatureState,
  context: FeatureSurfaceProjectContext,
): readonly FeatureSurfaceRowInput[] {
  const phase = phaseOf(state, context)
  const result: FeatureSurfaceRowInput[] = [{
    text: `SETTINGS  dsh-tui · ${phase} · ${state.editing ? 'EDITING · ←/→ change · Enter finish' : 'Enter edit'}`,
    tone: phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }]
  const snapshot = state.snapshot
  if (snapshot === undefined) {
    result.push({
      text: phase === 'loading' || phase === 'refreshing'
        ? 'Loading preferences…'
        : 'Preferences have not been loaded',
      tone: phaseTone(phase),
      dim: true,
    })
  } else {
    const source = snapshot.status.documentBacked
      ? `Official DSH Settings document · revision ${snapshot.revision}`
      : `In-memory Settings provider · revision ${snapshot.revision}`
    result.push({
      text: snapshot.status.available
        ? source
        : 'Defaults and Cordis row values · Settings service unavailable',
      tone: snapshot.status.available ? 'info' : 'warning',
      dim: true,
    })
    if (snapshot.status.available && !snapshot.status.writable) {
      result.push({ text: 'Read-only · user preferences cannot be updated', tone: 'warning' })
    }
  }
  if (state.error !== undefined) {
    result.push({ text: `Last operation failed · ${state.error}`, tone: 'danger' })
  }
  const preferences = visibleSettingsPreferences(state)
  if (preferences !== undefined) {
    const preferenceRows = projectSettingsRows(preferences)
    const capacity = Math.max(0, context.bounds.height - result.length - 1)
    for (const [index, row] of featureListViewport([...preferenceRows.entries()], state.selectedIndex, capacity)) {
      const selected = index === state.selectedIndex
      result.push({
        text: `${selected ? '›' : ' '} ${row.label.padEnd(20)} ${row.value}`
          + (selected && state.saving ? ' · Saving…' : ''),
        tone: selected ? state.saving ? 'warning' : 'accent' : 'default',
        bold: selected,
        dim: false,
        selected,
      })
    }
  }
  result.push({
    text: state.editing
      ? '←/→ change value · Enter finish · Esc back (started saves finish)'
      : 'j/k select · Enter edit · r refresh · Esc back',
    tone: 'muted',
    dim: true,
  })
  return result
}

export function createSettingsContentNode(
  state: SettingsFeatureStateSource,
): SettingsContentNode {
  return Object.freeze({
    kind: 'settings.content',
    featureId: 'settings',
    resourceId: 'settings.preferences',
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
