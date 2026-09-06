import type {
  DshTuiDefaultTranscriptMode,
  DshTuiDensity,
  DshTuiLayoutMode,
  DshTuiNavigationKeys,
  DshTuiPreferencesV1,
} from '../../preferences/contracts.ts'
import {
  serializePreferencesV1,
} from '../../preferences/codec.ts'
import type { DshTuiThemePreset } from '../../theme/contracts.ts'
import type {
  DshTuiPreferencesApplicationStatus,
} from '../../preferences/port.ts'

export const SETTINGS_FIELD_IDS = Object.freeze([
  'theme',
  'density',
  'navigationKeys',
  'reducedMotion',
  'layoutMode',
  'defaultTranscriptMode',
] as const)

export type SettingsFieldId = typeof SETTINGS_FIELD_IDS[number]
export type SettingsCycleDirection = 'previous' | 'next'

export interface SettingsFeatureSnapshot {
  readonly status: DshTuiPreferencesApplicationStatus
  readonly revision: number
  readonly preferences: DshTuiPreferencesV1
}

export interface SettingsPreferenceRow {
  readonly id: SettingsFieldId
  readonly label: string
  readonly value: string
}

const THEME_PRESETS: readonly DshTuiThemePreset[] = Object.freeze([
  'auto',
  'cordis',
  'mono',
])
const DENSITIES: readonly DshTuiDensity[] = Object.freeze([
  'compact',
  'comfortable',
])
const NAVIGATION_KEYS: readonly DshTuiNavigationKeys[] = Object.freeze([
  'arrows',
  'vim',
  'both',
])
const LAYOUT_MODES: readonly DshTuiLayoutMode[] = Object.freeze([
  'auto',
  'single',
  'split',
])
const TRANSCRIPT_MODES: readonly DshTuiDefaultTranscriptMode[] = Object.freeze([
  'compact',
  'verbose',
])

const LABELS: Readonly<Record<SettingsFieldId, string>> = Object.freeze({
  theme: 'Theme',
  density: 'Density',
  navigationKeys: 'Navigation keys',
  reducedMotion: 'Reduced motion',
  layoutMode: 'Layout',
  defaultTranscriptMode: 'Transcript default',
})

function detachStatus(
  status: DshTuiPreferencesApplicationStatus,
): DshTuiPreferencesApplicationStatus {
  return Object.freeze({
    available: status.available,
    writable: status.writable,
    documentBacked: status.documentBacked,
  })
}

/** Detach the official Settings projection before retaining it in Feature state. */
export function detachSettingsFeatureSnapshot(
  snapshot: SettingsFeatureSnapshot,
): SettingsFeatureSnapshot {
  return Object.freeze({
    status: detachStatus(snapshot.status),
    revision: snapshot.revision,
    preferences: serializePreferencesV1(snapshot.preferences),
  })
}

function valueLabel(id: SettingsFieldId, preferences: DshTuiPreferencesV1): string {
  switch (id) {
    case 'theme':
      return ({ auto: 'Auto', cordis: 'Cordis', mono: 'Monochrome' })[
        preferences.theme.preset ?? 'auto'
      ]
    case 'density':
      return preferences.density === 'compact' ? 'Compact' : 'Comfortable'
    case 'navigationKeys':
      return ({ arrows: 'Arrow keys', vim: 'Vim', both: 'Arrow keys + Vim' })[
        preferences.navigationKeys
      ]
    case 'reducedMotion':
      return preferences.reducedMotion ? 'On' : 'Off'
    case 'layoutMode':
      return ({ auto: 'Auto', single: 'Single pane', split: 'Split pane' })[
        preferences.layoutMode
      ]
    case 'defaultTranscriptMode':
      return preferences.defaultTranscriptMode === 'compact' ? 'Compact' : 'Verbose'
    /* v8 ignore next 2 -- SettingsFieldId is exhausted above. */
    default:
      return assertNever(id)
  }
}

export function projectSettingsRows(
  preferences: DshTuiPreferencesV1,
): readonly SettingsPreferenceRow[] {
  return Object.freeze(SETTINGS_FIELD_IDS.map(id => Object.freeze({
    id,
    label: LABELS[id],
    value: valueLabel(id, preferences),
  })))
}

function cycle<T>(
  values: readonly T[],
  current: T,
  direction: SettingsCycleDirection,
): T {
  const currentIndex = values.indexOf(current)
  const normalizedIndex = currentIndex < 0 ? 0 : currentIndex
  const delta = direction === 'previous' ? -1 : 1
  return values[(normalizedIndex + delta + values.length) % values.length]!
}

/** Produce a complete, schema-clean v1 document for one semantic row edit. */
export function cycleSettingsPreference(
  preferences: DshTuiPreferencesV1,
  id: SettingsFieldId,
  direction: SettingsCycleDirection,
): DshTuiPreferencesV1 {
  let next: DshTuiPreferencesV1
  switch (id) {
    case 'theme':
      next = {
        ...preferences,
        theme: {
          ...preferences.theme,
          preset: cycle(THEME_PRESETS, preferences.theme.preset ?? 'auto', direction),
        },
      }
      break
    case 'density':
      next = { ...preferences, density: cycle(DENSITIES, preferences.density, direction) }
      break
    case 'navigationKeys':
      next = {
        ...preferences,
        navigationKeys: cycle(NAVIGATION_KEYS, preferences.navigationKeys, direction),
      }
      break
    case 'reducedMotion':
      next = { ...preferences, reducedMotion: !preferences.reducedMotion }
      break
    case 'layoutMode':
      next = {
        ...preferences,
        layoutMode: cycle(LAYOUT_MODES, preferences.layoutMode, direction),
      }
      break
    case 'defaultTranscriptMode':
      next = {
        ...preferences,
        defaultTranscriptMode: cycle(
          TRANSCRIPT_MODES,
          preferences.defaultTranscriptMode,
          direction,
        ),
      }
      break
    /* v8 ignore next 2 -- SettingsFieldId is exhausted above. */
    default:
      return assertNever(id)
  }
  return serializePreferencesV1(next)
}

/* v8 ignore next 3 -- exported discriminated unions are exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Settings field: ${String(value)}`)
}
