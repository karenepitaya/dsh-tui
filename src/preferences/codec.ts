import {
  DSH_TUI_ANSI_COLORS,
  DSH_TUI_SEMANTIC_ROLES,
  DSH_TUI_THEME_PRESETS,
  type DshTuiAnsiColor,
  type DshTuiThemeColors,
  type DshTuiThemeConfig,
  type DshTuiThemePreset,
} from '../theme/contracts.ts'
import {
  SEMANTIC_COLOR_ROLES,
  type SemanticColorInput,
  type SemanticPaletteInput,
} from '../theme/semantic-colors.ts'
import {
  DEFAULT_DSH_TUI_PREFERENCES,
  DSH_TUI_PREFERENCES_VERSION,
  type DshTuiDefaultTranscriptMode,
  type DshTuiDensity,
  type DshTuiLayoutMode,
  type DshTuiNavigationKeys,
  type DshTuiPreferencesV1,
  type DshTuiUiLanguage,
} from './contracts.ts'

export interface DshTuiPreferenceOverrides {
  readonly version?: 1
  readonly theme?: DshTuiThemeConfig
  readonly density?: DshTuiDensity
  readonly navigationKeys?: DshTuiNavigationKeys
  readonly reducedMotion?: boolean
  readonly layoutMode?: DshTuiLayoutMode
  readonly defaultTranscriptMode?: DshTuiDefaultTranscriptMode
  readonly uiLanguage?: DshTuiUiLanguage
}

type UnknownKeyPolicy = 'drop' | 'reject'

const ROOT_KEYS: readonly string[] = Object.freeze([
  'version',
  'theme',
  'density',
  'navigationKeys',
  'reducedMotion',
  'layoutMode',
  'defaultTranscriptMode',
  'uiLanguage',
])
const THEME_KEYS: readonly string[] = Object.freeze(['preset', 'palette', 'colors'])
const THEME_PRESETS: readonly string[] = Object.freeze([...DSH_TUI_THEME_PRESETS])
const THEME_COLOR_ROLES: readonly string[] = Object.freeze([...DSH_TUI_SEMANTIC_ROLES])
const ANSI_COLORS: readonly string[] = Object.freeze([...DSH_TUI_ANSI_COLORS])
const SEMANTIC_ROLES: readonly string[] = Object.freeze([...SEMANTIC_COLOR_ROLES])
const DENSITIES: readonly string[] = Object.freeze(['compact', 'comfortable'])
const NAVIGATION_KEYS: readonly string[] = Object.freeze(['arrows', 'vim', 'both'])
const LAYOUT_MODES: readonly string[] = Object.freeze(['auto', 'single', 'split'])
const TRANSCRIPT_MODES: readonly string[] = Object.freeze(['compact', 'verbose'])
const UI_LANGUAGES: readonly string[] = Object.freeze(['en', 'zh'])

function record(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(message)
  }
  return value as Readonly<Record<string, unknown>>
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  policy: UnknownKeyPolicy,
  message: (key: string) => string,
): void {
  if (policy === 'drop') return
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(message(unknown))
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly string[],
  name: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Invalid ${name}: ${String(value)}`)
  }
  return value as T
}

function parseThemeColors(
  value: unknown,
  policy: UnknownKeyPolicy,
): DshTuiThemeColors {
  const source = record(value, 'Theme colors must be an object')
  rejectUnknownKeys(
    source,
    THEME_COLOR_ROLES,
    policy,
    key => `Unknown theme color role: ${key}`,
  )
  const colors: Record<string, DshTuiAnsiColor> = {}
  for (const role of DSH_TUI_SEMANTIC_ROLES) {
    if (!Object.hasOwn(source, role)) continue
    colors[role] = enumValue<DshTuiAnsiColor>(
      source[role],
      ANSI_COLORS,
      `theme color for ${role}`,
    )
  }
  return Object.freeze(colors) as DshTuiThemeColors
}

function semanticColor(value: unknown, role: string): SemanticColorInput {
  if (typeof value !== 'string') {
    throw new Error(`Invalid semantic theme color for ${role}: ${String(value)}`)
  }
  if (ANSI_COLORS.includes(value) || /^#[\da-f]{6}$/iu.test(value)) {
    return value as SemanticColorInput
  }
  throw new Error(`Invalid semantic theme color for ${role}: ${value}`)
}

function parseSemanticPalette(
  value: unknown,
  policy: UnknownKeyPolicy,
): SemanticPaletteInput {
  const source = record(value, 'Theme palette must be an object')
  rejectUnknownKeys(
    source,
    SEMANTIC_ROLES,
    policy,
    key => `Unknown semantic theme color role: ${key}`,
  )
  const palette: Partial<Record<typeof SEMANTIC_COLOR_ROLES[number], SemanticColorInput>> = {}
  for (const role of SEMANTIC_COLOR_ROLES) {
    if (!Object.hasOwn(source, role)) continue
    palette[role] = semanticColor(source[role], role)
  }
  return Object.freeze(palette)
}

function parseTheme(value: unknown, policy: UnknownKeyPolicy): DshTuiThemeConfig {
  const source = record(value, 'Theme preference must be an object')
  rejectUnknownKeys(
    source,
    THEME_KEYS,
    policy,
    key => `Unknown theme preference key: ${key}`,
  )
  const preset = Object.hasOwn(source, 'preset')
    ? enumValue<DshTuiThemePreset>(source.preset, THEME_PRESETS, 'theme preset')
    : undefined
  const palette = Object.hasOwn(source, 'palette')
    ? parseSemanticPalette(source.palette, policy)
    : undefined
  const colors = Object.hasOwn(source, 'colors')
    ? parseThemeColors(source.colors, policy)
    : undefined
  return Object.freeze({
    ...(preset === undefined ? {} : { preset }),
    ...(palette === undefined ? {} : { palette }),
    ...(colors === undefined ? {} : { colors }),
  })
}

function checkVersion(source: Readonly<Record<string, unknown>>): void {
  if (!Object.hasOwn(source, 'version')) return
  if (source.version !== DSH_TUI_PREFERENCES_VERSION) {
    throw new Error(
      `Unsupported preference version ${String(source.version)}; current version is 1`,
    )
  }
}

export function parsePreferenceOverrides(
  value: unknown,
  policy: UnknownKeyPolicy,
): DshTuiPreferenceOverrides {
  const source = record(value, 'Preference overrides must be an object')
  rejectUnknownKeys(source, ROOT_KEYS, policy, key => `Unknown preference key: ${key}`)
  checkVersion(source)

  const result: {
    version?: 1
    theme?: DshTuiThemeConfig
    density?: DshTuiDensity
    navigationKeys?: DshTuiNavigationKeys
    reducedMotion?: boolean
    layoutMode?: DshTuiLayoutMode
    defaultTranscriptMode?: DshTuiDefaultTranscriptMode
    uiLanguage?: DshTuiUiLanguage
  } = {}
  if (Object.hasOwn(source, 'version')) result.version = 1
  if (Object.hasOwn(source, 'theme')) result.theme = parseTheme(source.theme, policy)
  if (Object.hasOwn(source, 'density')) {
    result.density = enumValue(source.density, DENSITIES, 'density')
  }
  if (Object.hasOwn(source, 'navigationKeys')) {
    result.navigationKeys = enumValue(
      source.navigationKeys,
      NAVIGATION_KEYS,
      'navigation keys',
    )
  }
  if (Object.hasOwn(source, 'reducedMotion')) {
    if (typeof source.reducedMotion !== 'boolean') {
      throw new Error(`Invalid reduced motion: ${String(source.reducedMotion)}`)
    }
    result.reducedMotion = source.reducedMotion
  }
  if (Object.hasOwn(source, 'layoutMode')) {
    result.layoutMode = enumValue(source.layoutMode, LAYOUT_MODES, 'layout mode')
  }
  if (Object.hasOwn(source, 'defaultTranscriptMode')) {
    result.defaultTranscriptMode = enumValue(
      source.defaultTranscriptMode,
      TRANSCRIPT_MODES,
      'default transcript mode',
    )
  }
  if (Object.hasOwn(source, 'uiLanguage')) {
    result.uiLanguage = enumValue(source.uiLanguage, UI_LANGUAGES, 'UI language')
  }
  return Object.freeze(result)
}

function mergeTheme(
  base: DshTuiThemeConfig,
  override: DshTuiThemeConfig | undefined,
): DshTuiThemeConfig {
  if (override === undefined) return base
  const colors = base.colors === undefined && override.colors === undefined
    ? undefined
    : Object.freeze({ ...base.colors, ...override.colors })
  const palette = base.palette === undefined && override.palette === undefined
    ? undefined
    : Object.freeze({ ...base.palette, ...override.palette })
  const preset = override.preset ?? base.preset
  return Object.freeze({
    /* v8 ignore next -- every merged preferences theme inherits the default auto preset. */
    ...(preset === undefined ? {} : { preset }),
    ...(palette === undefined ? {} : { palette }),
    ...(colors === undefined ? {} : { colors }),
  })
}

function applyOverrides(
  base: DshTuiPreferencesV1,
  override: DshTuiPreferenceOverrides,
): DshTuiPreferencesV1 {
  return Object.freeze({
    version: 1,
    theme: mergeTheme(base.theme, override.theme),
    density: override.density ?? base.density,
    navigationKeys: override.navigationKeys ?? base.navigationKeys,
    reducedMotion: override.reducedMotion ?? base.reducedMotion,
    layoutMode: override.layoutMode ?? base.layoutMode,
    defaultTranscriptMode: override.defaultTranscriptMode ?? base.defaultTranscriptMode,
    uiLanguage: override.uiLanguage ?? base.uiLanguage,
  })
}

export function mergePreferenceLayers(
  row: DshTuiPreferenceOverrides,
  user: DshTuiPreferenceOverrides,
): DshTuiPreferencesV1 {
  return applyOverrides(applyOverrides(DEFAULT_DSH_TUI_PREFERENCES, row), user)
}

const REQUIRED_ROOT_KEYS = [
  'version',
  'theme',
  'density',
  'navigationKeys',
  'reducedMotion',
  'layoutMode',
  'defaultTranscriptMode',
  'uiLanguage',
] as const

export function serializePreferencesV1(value: unknown): DshTuiPreferencesV1 {
  const source = record(value, 'Preferences must be an object')
  for (const key of REQUIRED_ROOT_KEYS) {
    if (!Object.hasOwn(source, key)) throw new Error(`Missing preference key: ${key}`)
  }
  const parsed = parsePreferenceOverrides(source, 'reject')
  return applyOverrides(DEFAULT_DSH_TUI_PREFERENCES, parsed)
}
