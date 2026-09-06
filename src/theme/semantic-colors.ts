import {
  DSH_TUI_ANSI_COLORS,
  type DshTuiAnsiColor,
} from './contracts.ts'

export const SEMANTIC_COLOR_ROLES = Object.freeze([
  'foreground',
  'muted',
  'emphasis',
  'accent',
  'error',
  'success',
  'warning',
  'userBarForeground',
  'userBarBackground',
  'panelBackground',
  'inputBackground',
  'selectionBackground',
  'inactiveSelectionBackground',
  'assistant',
  'reasoning',
  'tool',
  'command',
  'dashboard',
  'activity',
  'interaction',
  'composer',
  'telemetry',
  'border',
  'code',
  'diffAdd',
  'diffAddBackground',
  'diffDelete',
  'diffDeleteBackground',
] as const)

export type SemanticColorRole = typeof SEMANTIC_COLOR_ROLES[number]

export const LEGACY_ANSI_COLOR_NAMES = DSH_TUI_ANSI_COLORS
export type LegacyAnsiColorName = DshTuiAnsiColor
export type HexColor = `#${string}`
export type SemanticColorInput = HexColor | LegacyAnsiColorName
export type SemanticColorMode = 'auto' | 'mono'
export type TerminalColorLevel = 'truecolor' | 'ansi256' | 'ansi16' | 'mono'

export type SemanticPaletteInput = Readonly<Partial<Record<
  SemanticColorRole,
  SemanticColorInput
>>>

export interface SemanticThemeConfig {
  readonly colorMode?: SemanticColorMode
  readonly palette?: SemanticPaletteInput
}

export const DEFAULT_SEMANTIC_PALETTE: Readonly<Record<
  SemanticColorRole,
  SemanticColorInput
>> = Object.freeze({
  foreground: '#d8dee9',
  muted: '#78839a',
  emphasis: '#f2f4f8',
  accent: '#7aa2f7',
  error: '#f7768e',
  success: '#9ece6a',
  warning: '#e0af68',
  userBarForeground: '#f2f4f8',
  userBarBackground: '#30364d',
  panelBackground: '#191c22',
  inputBackground: '#242830',
  selectionBackground: '#304567',
  inactiveSelectionBackground: '#2b3039',
  assistant: '#d8dee9',
  reasoning: '#78839a',
  tool: '#7aa2f7',
  command: '#7aa2f7',
  dashboard: '#7aa2f7',
  activity: '#7aa2f7',
  interaction: '#e0af68',
  composer: '#d8dee9',
  telemetry: '#78839a',
  border: '#3b4261',
  code: '#9ece6a',
  diffAdd: '#9ece6a',
  diffAddBackground: '#203627',
  diffDelete: '#f7768e',
  diffDeleteBackground: '#3b2028',
})

export type ParsedSemanticColor =
  | { readonly kind: 'default' }
  | {
      readonly kind: 'rgb'
      readonly red: number
      readonly green: number
      readonly blue: number
      readonly legacyIndex?: number
    }

export interface CompiledSemanticTheme {
  readonly colorMode: SemanticColorMode
  readonly colors: Readonly<Record<SemanticColorRole, ParsedSemanticColor>>
}

export interface TerminalColorCapabilities {
  readonly colorLevel: TerminalColorLevel
}

export interface ProjectedColorStyle {
  readonly kind: TerminalColorLevel | 'default'
  readonly foregroundOpen: string
  readonly foregroundClose: string
  readonly backgroundOpen: string
  readonly backgroundClose: string
  readonly rgb?: HexColor
  readonly index?: number
}

export interface ProjectedSemanticTheme {
  readonly colorLevel: TerminalColorLevel
  readonly styles: Readonly<Record<SemanticColorRole, ProjectedColorStyle>>
  paint(role: SemanticColorRole, value: string): string
  paintBackground(role: SemanticColorRole, value: string): string
}

interface RgbColor {
  readonly red: number
  readonly green: number
  readonly blue: number
}

interface IndexedRgbColor extends RgbColor {
  readonly index: number
}

const ANSI16_RGB: readonly IndexedRgbColor[] = Object.freeze([
  Object.freeze({ index: 0, red: 0, green: 0, blue: 0 }),
  Object.freeze({ index: 1, red: 128, green: 0, blue: 0 }),
  Object.freeze({ index: 2, red: 0, green: 128, blue: 0 }),
  Object.freeze({ index: 3, red: 128, green: 128, blue: 0 }),
  Object.freeze({ index: 4, red: 0, green: 0, blue: 128 }),
  Object.freeze({ index: 5, red: 128, green: 0, blue: 128 }),
  Object.freeze({ index: 6, red: 0, green: 128, blue: 128 }),
  Object.freeze({ index: 7, red: 192, green: 192, blue: 192 }),
  Object.freeze({ index: 8, red: 128, green: 128, blue: 128 }),
  Object.freeze({ index: 9, red: 255, green: 0, blue: 0 }),
  Object.freeze({ index: 10, red: 0, green: 255, blue: 0 }),
  Object.freeze({ index: 11, red: 255, green: 255, blue: 0 }),
  Object.freeze({ index: 12, red: 0, green: 0, blue: 255 }),
  Object.freeze({ index: 13, red: 255, green: 0, blue: 255 }),
  Object.freeze({ index: 14, red: 0, green: 255, blue: 255 }),
  Object.freeze({ index: 15, red: 255, green: 255, blue: 255 }),
])

const LEGACY_COLOR_INDEX: Readonly<Record<Exclude<LegacyAnsiColorName, 'default'>, number>> = Object.freeze({
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  gray: 8,
  blackBright: 8,
  redBright: 9,
  greenBright: 10,
  yellowBright: 11,
  blueBright: 12,
  magentaBright: 13,
  cyanBright: 14,
  whiteBright: 15,
})

function createAnsi256Palette(): readonly IndexedRgbColor[] {
  const palette: IndexedRgbColor[] = [...ANSI16_RGB]
  const levels = [0, 95, 135, 175, 215, 255] as const
  for (const red of levels) {
    for (const green of levels) {
      for (const blue of levels) {
        palette.push(Object.freeze({ index: palette.length, red, green, blue }))
      }
    }
  }
  for (let offset = 0; offset < 24; offset += 1) {
    const value = 8 + offset * 10
    palette.push(Object.freeze({ index: palette.length, red: value, green: value, blue: value }))
  }
  return Object.freeze(palette)
}

const ANSI256_RGB = createAnsi256Palette()
const HEX_COLOR = Object.freeze(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu)
const EMPTY_STYLE_PART = ''

const MONO_STYLE: ProjectedColorStyle = Object.freeze({
  kind: 'mono',
  foregroundOpen: EMPTY_STYLE_PART,
  foregroundClose: EMPTY_STYLE_PART,
  backgroundOpen: EMPTY_STYLE_PART,
  backgroundClose: EMPTY_STYLE_PART,
})

const DEFAULT_STYLE: ProjectedColorStyle = Object.freeze({
  kind: 'default',
  foregroundOpen: EMPTY_STYLE_PART,
  foregroundClose: EMPTY_STYLE_PART,
  backgroundOpen: EMPTY_STYLE_PART,
  backgroundClose: EMPTY_STYLE_PART,
})

function rgb(red: number, green: number, blue: number, legacyIndex?: number): ParsedSemanticColor {
  return Object.freeze({
    kind: 'rgb',
    red,
    green,
    blue,
    ...(legacyIndex === undefined ? {} : { legacyIndex }),
  })
}

function parseColor(value: unknown): ParsedSemanticColor {
  if (value === 'default') return Object.freeze({ kind: 'default' })
  if (typeof value !== 'string') throw new Error(`Invalid color input: ${String(value)}`)
  if (Object.hasOwn(LEGACY_COLOR_INDEX, value)) {
    const legacyIndex = LEGACY_COLOR_INDEX[value as keyof typeof LEGACY_COLOR_INDEX]
    const exact = ANSI16_RGB[legacyIndex]!
    return rgb(exact.red, exact.green, exact.blue, legacyIndex)
  }
  const match = HEX_COLOR.exec(value)
  if (match === null) throw new Error(`Invalid color input: ${value}`)
  return rgb(
    Number.parseInt(match[1]!, 16),
    Number.parseInt(match[2]!, 16),
    Number.parseInt(match[3]!, 16),
  )
}

export function compileSemanticTheme(
  config: SemanticThemeConfig = {},
): CompiledSemanticTheme {
  const colorMode = config.colorMode ?? 'auto'
  if (colorMode !== 'auto' && colorMode !== 'mono') {
    throw new Error(`Invalid semantic color mode: ${String(colorMode)}`)
  }
  const palette = config.palette ?? {}
  const unknownRole = Object.keys(palette).find(role => (
    !(SEMANTIC_COLOR_ROLES as readonly string[]).includes(role)
  ))
  if (unknownRole !== undefined) {
    throw new Error(`Unknown semantic color role: ${unknownRole}`)
  }
  const colors: Partial<Record<SemanticColorRole, ParsedSemanticColor>> = {}
  for (const role of SEMANTIC_COLOR_ROLES) {
    colors[role] = parseColor(palette[role] ?? DEFAULT_SEMANTIC_PALETTE[role])
  }
  return Object.freeze({
    colorMode,
    colors: Object.freeze(colors) as Readonly<Record<SemanticColorRole, ParsedSemanticColor>>,
  })
}

function distanceSquared(left: RgbColor, right: RgbColor): number {
  const red = left.red - right.red
  const green = left.green - right.green
  const blue = left.blue - right.blue
  return red * red + green * green + blue * blue
}

function nearestIndex(color: RgbColor, palette: readonly IndexedRgbColor[]): number {
  let bestIndex = palette[0]!.index
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of palette) {
    const distance = distanceSquared(color, candidate)
    if (distance < bestDistance) {
      bestIndex = candidate.index
      bestDistance = distance
    }
  }
  return bestIndex
}

/**
 * ANSI-16 entries are terminal-defined semantic hues, not a faithful RGB
 * gamut. Preserve hue and intensity here; Euclidean RGB distance otherwise
 * maps calm pastel status colors to white or gray and erases their meaning.
 */
function nearestAnsi16Index(color: RgbColor): number {
  const maximum = Math.max(color.red, color.green, color.blue)
  const minimum = Math.min(color.red, color.green, color.blue)
  const value = maximum / 255
  const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum

  if (value <= 0.18) return 0
  if (saturation < 0.24) {
    if (value < 0.75) return 8
    if (value < 0.9) return 7
    return 15
  }

  const delta = maximum - minimum
  let hue: number
  if (maximum === color.red) {
    hue = 60 * (((color.green - color.blue) / delta) % 6)
  } else if (maximum === color.green) {
    hue = 60 * ((color.blue - color.red) / delta + 2)
  } else {
    hue = 60 * ((color.red - color.green) / delta + 4)
  }
  if (hue < 0) hue += 360

  const base = hue < 30 || hue >= 330
    ? 1
    : hue < 80
      ? 3
      : hue < 150
        ? 2
        : hue < 210
          ? 6
          : hue < 270
            ? 4
            : 5
  return value >= 0.75 ? base + 8 : base
}

function hex(color: RgbColor): HexColor {
  const part = (value: number): string => value.toString(16).padStart(2, '0')
  return `#${part(color.red)}${part(color.green)}${part(color.blue)}`
}

function ansi16Code(index: number, background: boolean): number {
  if (index < 8) return (background ? 40 : 30) + index
  return (background ? 100 : 90) + index - 8
}

function projectedStyle(
  kind: Exclude<TerminalColorLevel, 'mono'>,
  color: Extract<ParsedSemanticColor, { kind: 'rgb' }>,
  index?: number,
): ProjectedColorStyle {
  switch (kind) {
    case 'truecolor':
      return Object.freeze({
        kind,
        rgb: hex(color),
        foregroundOpen: `\u001b[38;2;${color.red};${color.green};${color.blue}m`,
        foregroundClose: '\u001b[39m',
        backgroundOpen: `\u001b[48;2;${color.red};${color.green};${color.blue}m`,
        backgroundClose: '\u001b[49m',
      })
    case 'ansi256':
      return Object.freeze({
        kind,
        index: index!,
        foregroundOpen: `\u001b[38;5;${index!}m`,
        foregroundClose: '\u001b[39m',
        backgroundOpen: `\u001b[48;5;${index!}m`,
        backgroundClose: '\u001b[49m',
      })
    case 'ansi16':
      return Object.freeze({
        kind,
        index: index!,
        foregroundOpen: `\u001b[${ansi16Code(index!, false)}m`,
        foregroundClose: '\u001b[39m',
        backgroundOpen: `\u001b[${ansi16Code(index!, true)}m`,
        backgroundClose: '\u001b[49m',
      })
  }
}

function projectColor(
  color: ParsedSemanticColor,
  level: TerminalColorLevel,
): ProjectedColorStyle {
  if (level === 'mono') return MONO_STYLE
  if (color.kind === 'default') return DEFAULT_STYLE
  if (level === 'truecolor') return projectedStyle(level, color)
  const index = color.legacyIndex ?? (level === 'ansi256'
    ? nearestIndex(color, ANSI256_RGB)
    : nearestAnsi16Index(color))
  return projectedStyle(level, color, index)
}

function wrap(
  style: ProjectedColorStyle,
  value: string,
  layer: 'foreground' | 'background',
): string {
  if (value === '') return ''
  const open = layer === 'foreground' ? style.foregroundOpen : style.backgroundOpen
  if (open === '') return value
  const close = layer === 'foreground' ? style.foregroundClose : style.backgroundClose
  // Every nested foreground/background formatter closes the same SGR layer.
  // Re-open this style after an inner close so semantic spans compose like the
  // retained picocolors API did instead of leaking the terminal default.
  return `${open}${value.replaceAll(close, open)}${close}`
}

/** Project a compatibility color through the same terminal capability path. */
export function projectSemanticColor(
  input: SemanticColorInput,
  capabilities: TerminalColorCapabilities,
  colorMode: SemanticColorMode = 'auto',
): ProjectedColorStyle {
  const level = colorMode === 'mono' ? 'mono' : capabilities.colorLevel
  return projectColor(parseColor(input), level)
}

/** Paint an already projected color without duplicating SGR composition rules. */
export function paintProjectedColor(
  style: ProjectedColorStyle,
  value: string,
  layer: 'foreground' | 'background' = 'foreground',
): string {
  return wrap(style, value, layer)
}

export function projectSemanticTheme(
  compiled: CompiledSemanticTheme,
  capabilities: TerminalColorCapabilities,
): ProjectedSemanticTheme {
  const colorLevel = compiled.colorMode === 'mono' ? 'mono' : capabilities.colorLevel
  const styles: Partial<Record<SemanticColorRole, ProjectedColorStyle>> = {}
  for (const role of SEMANTIC_COLOR_ROLES) {
    styles[role] = projectColor(compiled.colors[role], colorLevel)
  }
  const frozenStyles = Object.freeze(styles) as Readonly<Record<
    SemanticColorRole,
    ProjectedColorStyle
  >>
  return Object.freeze({
    colorLevel,
    styles: frozenStyles,
    paint: (role: SemanticColorRole, value: string): string => {
      return paintProjectedColor(frozenStyles[role], value, 'foreground')
    },
    paintBackground: (role: SemanticColorRole, value: string): string => {
      return paintProjectedColor(frozenStyles[role], value, 'background')
    },
  })
}
