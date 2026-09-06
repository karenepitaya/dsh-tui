import type { SemanticPaletteInput } from './semantic-colors.ts'

/**
 * Product-owned contract for the v1 Theme Config shape.
 *
 * The retained UI toolkit still consumes this legacy shape, while the semantic
 * color engine accepts it through `mapLegacyThemeConfig`. Keeping the contract
 * here prevents product preferences from depending on the rendering layer.
 */
export const DSH_TUI_THEME_PRESETS = Object.freeze([
  'auto',
  'cordis',
  'mono',
] as const)

export type DshTuiThemePreset = typeof DSH_TUI_THEME_PRESETS[number]

export const DSH_TUI_ANSI_COLORS = Object.freeze([
  'default',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
] as const)

export type DshTuiAnsiColor = typeof DSH_TUI_ANSI_COLORS[number]

export const DSH_TUI_SEMANTIC_ROLES = Object.freeze([
  'primary',
  'accent',
  'muted',
  'user',
  'assistant',
  'reasoning',
  'tool',
  'command',
  'dashboard',
  'activity',
  'interaction',
  'composer',
  'telemetry',
  'success',
  'warning',
  'error',
  'border',
  'code',
] as const)

export type DshTuiSemanticRole = typeof DSH_TUI_SEMANTIC_ROLES[number]

export type DshTuiThemeColors = Readonly<Partial<Record<
  DshTuiSemanticRole,
  DshTuiAnsiColor
>>>

export interface DshTuiThemeConfig {
  readonly preset?: DshTuiThemePreset
  /** New semantic RGB/ANSI palette. Explicit entries override legacy `colors`. */
  readonly palette?: SemanticPaletteInput
  /** Retained ANSI-only compatibility input for existing Cordis rows. */
  readonly colors?: DshTuiThemeColors
}
