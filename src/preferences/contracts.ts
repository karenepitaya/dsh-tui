import type { DshTuiThemeConfig } from '../theme/contracts.ts'

export const DSH_TUI_SETTINGS_NAMESPACE = 'dsh-tui'
export const DSH_TUI_PREFERENCES_VERSION = 1 as const

export type DshTuiDensity = 'compact' | 'comfortable'
export type DshTuiNavigationKeys = 'arrows' | 'vim' | 'both'
export type DshTuiLayoutMode = 'auto' | 'single' | 'split'
export type DshTuiDefaultTranscriptMode = 'compact' | 'verbose'

export interface DshTuiPreferencesV1 {
  readonly version: 1
  readonly theme: DshTuiThemeConfig
  readonly density: DshTuiDensity
  readonly navigationKeys: DshTuiNavigationKeys
  readonly reducedMotion: boolean
  readonly layoutMode: DshTuiLayoutMode
  readonly defaultTranscriptMode: DshTuiDefaultTranscriptMode
}

export const DEFAULT_DSH_TUI_PREFERENCES: DshTuiPreferencesV1 = Object.freeze({
  version: DSH_TUI_PREFERENCES_VERSION,
  theme: Object.freeze({ preset: 'auto' }),
  density: 'compact',
  navigationKeys: 'both',
  reducedMotion: false,
  layoutMode: 'auto',
  defaultTranscriptMode: 'compact',
})
