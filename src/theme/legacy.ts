import {
  DSH_TUI_SEMANTIC_ROLES,
  type DshTuiSemanticRole,
  type DshTuiThemeColors,
  type DshTuiThemeConfig,
} from './contracts.ts'
import type {
  SemanticColorInput,
  SemanticColorRole,
  SemanticPaletteInput,
  SemanticThemeConfig,
} from './semantic-colors.ts'
import { SEMANTIC_COLOR_ROLES } from './semantic-colors.ts'

export type LegacyDshTuiThemeColors = DshTuiThemeColors
export type LegacyDshTuiThemeConfig = DshTuiThemeConfig

const LEGACY_ROLE_MAP: Readonly<Record<
  typeof DSH_TUI_SEMANTIC_ROLES[number],
  SemanticColorRole
>> = Object.freeze({
  primary: 'foreground',
  accent: 'accent',
  muted: 'muted',
  user: 'userBarForeground',
  assistant: 'assistant',
  reasoning: 'reasoning',
  tool: 'tool',
  command: 'command',
  dashboard: 'dashboard',
  activity: 'activity',
  interaction: 'interaction',
  composer: 'composer',
  telemetry: 'telemetry',
  success: 'success',
  warning: 'warning',
  error: 'error',
  border: 'border',
  code: 'code',
})

/** Keep retained render roles as an adapter over the product semantic palette. */
export function mapLegacyThemeRole(
  role: DshTuiSemanticRole,
): SemanticColorRole {
  return LEGACY_ROLE_MAP[role]
}

/** Structurally accepts the existing Config.theme value without importing it. */
export function mapLegacyThemeConfig(
  config: LegacyDshTuiThemeConfig = {},
): SemanticThemeConfig {
  const colorMode = config.preset === 'mono' ? 'mono' : 'auto'
  const palette: Partial<Record<SemanticColorRole, SemanticColorInput>> = {}
  if (config.colors !== undefined) {
    for (const legacyRole of DSH_TUI_SEMANTIC_ROLES) {
      const semanticRole = mapLegacyThemeRole(legacyRole)
      const value = config.colors[legacyRole]
      if (value !== undefined) palette[semanticRole] = value
    }
  }
  for (const semanticRole of SEMANTIC_COLOR_ROLES) {
    const value = config.palette?.[semanticRole]
    if (value !== undefined) palette[semanticRole] = value
  }
  return Object.keys(palette).length === 0
    ? Object.freeze({ colorMode })
    : Object.freeze({
        colorMode,
        palette: Object.freeze(palette) as SemanticPaletteInput,
      })
}
