import colorsApi from 'picocolors'

export const DSH_TUI_THEME_PRESETS = [
  'auto',
  'cordis',
  'mono',
] as const

export type DshTuiThemePreset = typeof DSH_TUI_THEME_PRESETS[number]

export const DSH_TUI_ANSI_COLORS = [
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
] as const

export type DshTuiAnsiColor = typeof DSH_TUI_ANSI_COLORS[number]

export const DSH_TUI_SEMANTIC_ROLES = [
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
] as const

export type DshTuiSemanticRole = typeof DSH_TUI_SEMANTIC_ROLES[number]

export interface DshTuiThemeColors {
  readonly primary?: DshTuiAnsiColor
  readonly accent?: DshTuiAnsiColor
  readonly muted?: DshTuiAnsiColor
  readonly user?: DshTuiAnsiColor
  readonly assistant?: DshTuiAnsiColor
  readonly reasoning?: DshTuiAnsiColor
  readonly tool?: DshTuiAnsiColor
  readonly command?: DshTuiAnsiColor
  readonly dashboard?: DshTuiAnsiColor
  readonly activity?: DshTuiAnsiColor
  readonly interaction?: DshTuiAnsiColor
  readonly composer?: DshTuiAnsiColor
  readonly telemetry?: DshTuiAnsiColor
  readonly success?: DshTuiAnsiColor
  readonly warning?: DshTuiAnsiColor
  readonly error?: DshTuiAnsiColor
  readonly border?: DshTuiAnsiColor
  readonly code?: DshTuiAnsiColor
}

export interface DshTuiThemeConfig {
  readonly preset?: DshTuiThemePreset
  readonly colors?: DshTuiThemeColors
}

export interface DshTuiThemeCapabilities {
  readonly colorSupported: boolean
  readonly noColor: boolean
  readonly dumbTerminal: boolean
}

type ResolvedThemeColors = Readonly<Required<DshTuiThemeColors>>
type ThemeFormatter = (value: string | number | null | undefined) => string

export interface DshTuiTheme {
  readonly preset: Exclude<DshTuiThemePreset, 'auto'>
  readonly colorEnabled: boolean
  readonly styleEnabled: boolean
  readonly colors: ResolvedThemeColors
  paint(role: DshTuiSemanticRole, value: string): string
  bold(value: string): string
  dim(value: string): string
  inverse(value: string): string
  italic(value: string): string
  underline(value: string): string
}

const CORDIS_COLORS: ResolvedThemeColors = Object.freeze({
  primary: 'white',
  accent: 'cyanBright',
  muted: 'gray',
  user: 'cyanBright',
  assistant: 'blueBright',
  reasoning: 'magenta',
  tool: 'yellowBright',
  command: 'cyan',
  dashboard: 'cyan',
  activity: 'blue',
  interaction: 'magentaBright',
  composer: 'blueBright',
  telemetry: 'cyanBright',
  success: 'greenBright',
  warning: 'yellowBright',
  error: 'redBright',
  border: 'gray',
  code: 'green',
})

const MONO_COLORS: ResolvedThemeColors = Object.freeze({
  primary: 'default',
  accent: 'default',
  muted: 'default',
  user: 'default',
  assistant: 'default',
  reasoning: 'default',
  tool: 'default',
  command: 'default',
  dashboard: 'default',
  activity: 'default',
  interaction: 'default',
  composer: 'default',
  telemetry: 'default',
  success: 'default',
  warning: 'default',
  error: 'default',
  border: 'default',
  code: 'default',
})

export function detectDshTuiThemeCapabilities(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  isTTY = process.stdout.isTTY === true,
  platform: NodeJS.Platform = process.platform,
): DshTuiThemeCapabilities {
  const noColor = env.NO_COLOR !== undefined
  const dumbTerminal = env.TERM === 'dumb'
  const forceColor = env.FORCE_COLOR
  const colorSupported = forceColor === undefined
    ? platform === 'win32' || isTTY || env.CI !== undefined
    : forceColor !== '0'
  return Object.freeze({ colorSupported, noColor, dumbTerminal })
}

export function createDshTuiTheme(
  config: DshTuiThemeConfig = {},
  capabilities: DshTuiThemeCapabilities = detectDshTuiThemeCapabilities(),
): DshTuiTheme {
  const requestedPreset = config.preset ?? 'auto'
  const colorAllowed = !capabilities.noColor && !capabilities.dumbTerminal
  const colorEnabled = colorAllowed && requestedPreset !== 'mono'
    && (requestedPreset === 'cordis' || capabilities.colorSupported)
  const styleEnabled = !capabilities.dumbTerminal
  const preset: DshTuiTheme['preset'] = colorEnabled ? 'cordis' : 'mono'
  const base = preset === 'cordis' ? CORDIS_COLORS : MONO_COLORS
  const colors = Object.freeze({ ...base, ...config.colors })
  const colorFormatters = colorsApi.createColors(colorEnabled)
  const styleFormatters = colorsApi.createColors(styleEnabled)

  return Object.freeze({
    preset,
    colorEnabled,
    styleEnabled,
    colors,
    paint: (role: DshTuiSemanticRole, value: string): string => {
      return formatterFor(colorFormatters, colors[role])(value)
    },
    bold: (value: string): string => styleFormatters.bold(value),
    dim: (value: string): string => styleFormatters.dim(value),
    inverse: (value: string): string => styleFormatters.inverse(value),
    italic: (value: string): string => styleFormatters.italic(value),
    underline: (value: string): string => styleFormatters.underline(value),
  })
}

function formatterFor(
  formatters: ReturnType<typeof colorsApi.createColors>,
  color: DshTuiAnsiColor,
): ThemeFormatter {
  if (color === 'default') return String
  return formatters[color]
}
