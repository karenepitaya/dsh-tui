import colorsApi from 'picocolors'
import {
  DSH_TUI_ANSI_COLORS,
  DSH_TUI_SEMANTIC_ROLES,
  DSH_TUI_THEME_PRESETS,
  type DshTuiAnsiColor,
  type DshTuiSemanticRole,
  type DshTuiThemeColors,
  type DshTuiThemeConfig,
  type DshTuiThemePreset,
} from '../theme/contracts.ts'
import {
  mapLegacyThemeConfig,
  mapLegacyThemeRole,
} from '../theme/legacy.ts'
import {
  DEFAULT_SEMANTIC_PALETTE,
  compileSemanticTheme,
  paintProjectedColor,
  projectSemanticColor,
  projectSemanticTheme,
  type ProjectedSemanticTheme,
  type SemanticColorRole,
  type TerminalColorLevel,
} from '../theme/semantic-colors.ts'

export {
  DSH_TUI_ANSI_COLORS,
  DSH_TUI_SEMANTIC_ROLES,
  DSH_TUI_THEME_PRESETS,
}
export type {
  DshTuiAnsiColor,
  DshTuiSemanticRole,
  DshTuiThemeColors,
  DshTuiThemeConfig,
  DshTuiThemePreset,
}

export interface DshTuiThemeCapabilities {
  readonly colorSupported: boolean
  readonly noColor: boolean
  readonly dumbTerminal: boolean
  /** Omitted by legacy callers that only know whether color is available. */
  readonly colorLevel?: TerminalColorLevel
}

type ResolvedThemeColors = Readonly<Required<DshTuiThemeColors>>

export interface DshTuiTheme {
  readonly preset: Exclude<DshTuiThemePreset, 'auto'>
  readonly colorEnabled: boolean
  readonly styleEnabled: boolean
  readonly colorLevel: TerminalColorLevel
  /** Capability-projected source of truth for every semantic role. */
  readonly semantic: ProjectedSemanticTheme
  /** ANSI-16 compatibility view; rendering uses `semantic`, not this view. */
  readonly colors: ResolvedThemeColors
  paint(role: DshTuiSemanticRole, value: string): string
  paintBackground(role: SemanticColorRole, value: string): string
  /** Retained adapter for legacy modal rows that still provide a raw ANSI color. */
  background(color: DshTuiAnsiColor, value: string): string
  bold(value: string): string
  dim(value: string): string
  inverse(value: string): string
  italic(value: string): string
  underline(value: string): string
}

const ANSI16_COLOR_NAMES = Object.freeze([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
] as const satisfies readonly DshTuiAnsiColor[])

function forcedColorLevel(value: string | undefined): TerminalColorLevel | undefined {
  if (value === undefined) return undefined
  switch (value) {
    case '0': return 'mono'
    case '2': return 'ansi256'
    case '3': return 'truecolor'
    default: return 'ansi16'
  }
}

function detectedColorLevel(
  env: Readonly<NodeJS.ProcessEnv>,
  isTTY: boolean,
  platform: NodeJS.Platform,
): TerminalColorLevel {
  const forced = forcedColorLevel(env.FORCE_COLOR)
  if (forced !== undefined) return forced

  const colorTerm = env.COLORTERM?.toLowerCase()
  const term = env.TERM?.toLowerCase()
  if (colorTerm === 'truecolor' || colorTerm === '24bit'
    || term?.includes('truecolor') === true
    || term?.includes('24bit') === true
    || term?.includes('direct') === true) {
    return 'truecolor'
  }
  // Modern Windows virtual terminals support 24-bit SGR and the retained
  // product historically enabled color there even when stdout metadata lagged.
  if (platform === 'win32') return 'truecolor'
  if (term?.includes('256color') === true) return 'ansi256'
  return isTTY || env.CI !== undefined ? 'ansi16' : 'mono'
}

export function detectDshTuiThemeCapabilities(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  isTTY = process.stdout.isTTY === true,
  platform: NodeJS.Platform = process.platform,
): DshTuiThemeCapabilities {
  const noColor = env.NO_COLOR !== undefined
  const dumbTerminal = env.TERM === 'dumb'
  const colorLevel = noColor || dumbTerminal
    ? 'mono'
    : detectedColorLevel(env, isTTY, platform)
  return Object.freeze({
    colorSupported: colorLevel !== 'mono',
    noColor,
    dumbTerminal,
    colorLevel,
  })
}

function resolveColorLevel(
  config: DshTuiThemeConfig,
  capabilities: DshTuiThemeCapabilities,
): TerminalColorLevel {
  if (config.preset === 'mono' || capabilities.noColor || capabilities.dumbTerminal) {
    return 'mono'
  }
  if (capabilities.colorLevel !== undefined) return capabilities.colorLevel
  if (capabilities.colorSupported) return 'ansi16'
  // Preserve the old explicit `cordis` behavior for callers using the legacy
  // boolean capability shape; detected capabilities always carry a level.
  return config.preset === 'cordis' ? 'ansi16' : 'mono'
}

function compatibilityColors(config: DshTuiThemeConfig): ResolvedThemeColors {
  const semanticConfig = mapLegacyThemeConfig(config)
  const colors: Partial<Record<DshTuiSemanticRole, DshTuiAnsiColor>> = {}
  for (const role of DSH_TUI_SEMANTIC_ROLES) {
    const semanticRole = mapLegacyThemeRole(role)
    const input = semanticConfig.palette?.[semanticRole]
      ?? DEFAULT_SEMANTIC_PALETTE[semanticRole]
    const projected = projectSemanticColor(input, { colorLevel: 'ansi16' })
    if (projected.kind === 'default') {
      colors[role] = 'default'
      continue
    }
    const index = projected.index
    /* v8 ignore next -- a non-default ANSI-16 projection always owns an index. */
    if (index === undefined) throw new Error('ANSI-16 projection is missing its index')
    colors[role] = ANSI16_COLOR_NAMES[index]!
  }
  return Object.freeze(colors) as ResolvedThemeColors
}

function compatibilityBackgrounds(
  colorLevel: TerminalColorLevel,
): Readonly<Record<DshTuiAnsiColor, ReturnType<typeof projectSemanticColor>>> {
  const backgrounds: Partial<Record<
    DshTuiAnsiColor,
    ReturnType<typeof projectSemanticColor>
  >> = {}
  for (const color of DSH_TUI_ANSI_COLORS) {
    backgrounds[color] = projectSemanticColor(color, { colorLevel })
  }
  return Object.freeze(backgrounds) as Readonly<Record<
    DshTuiAnsiColor,
    ReturnType<typeof projectSemanticColor>
  >>
}

export function createDshTuiTheme(
  config: DshTuiThemeConfig = {},
  capabilities: DshTuiThemeCapabilities = detectDshTuiThemeCapabilities(),
): DshTuiTheme {
  const colorLevel = resolveColorLevel(config, capabilities)
  const semantic = projectSemanticTheme(
    compileSemanticTheme(mapLegacyThemeConfig(config)),
    { colorLevel },
  )
  const colorEnabled = semantic.colorLevel !== 'mono'
  const styleEnabled = !capabilities.dumbTerminal
  const styleFormatters = colorsApi.createColors(styleEnabled)
  const backgrounds = compatibilityBackgrounds(semantic.colorLevel)

  return Object.freeze({
    preset: colorEnabled ? 'cordis' : 'mono',
    colorEnabled,
    styleEnabled,
    colorLevel: semantic.colorLevel,
    semantic,
    colors: compatibilityColors(config),
    paint: (role: DshTuiSemanticRole, value: string): string => {
      return semantic.paint(mapLegacyThemeRole(role), value)
    },
    paintBackground: (role: SemanticColorRole, value: string): string => {
      return semantic.paintBackground(role, value)
    },
    background: (color: DshTuiAnsiColor, value: string): string => {
      return paintProjectedColor(backgrounds[color], value, 'background')
    },
    bold: (value: string): string => styleFormatters.bold(value),
    dim: (value: string): string => styleFormatters.dim(value),
    inverse: (value: string): string => styleFormatters.inverse(value),
    italic: (value: string): string => styleFormatters.italic(value),
    underline: (value: string): string => styleFormatters.underline(value),
  })
}
