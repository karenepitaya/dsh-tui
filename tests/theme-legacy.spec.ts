import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  DSH_TUI_ANSI_COLORS as PRODUCT_ANSI_COLORS,
  DSH_TUI_SEMANTIC_ROLES as PRODUCT_THEME_ROLES,
  DSH_TUI_THEME_PRESETS as PRODUCT_THEME_PRESETS,
  type DshTuiThemeConfig as ProductThemeConfig,
} from '../src/theme/contracts.ts'
import { mapLegacyThemeConfig } from '../src/theme/legacy.ts'
import {
  compileSemanticTheme,
  projectSemanticTheme,
} from '../src/theme/semantic-colors.ts'
import {
  DSH_TUI_ANSI_COLORS as UI_ANSI_COLORS,
  DSH_TUI_SEMANTIC_ROLES as UI_THEME_ROLES,
  DSH_TUI_THEME_PRESETS as UI_THEME_PRESETS,
  type DshTuiThemeConfig as UiThemeConfig,
} from '../src/ui/theme.ts'

describe('legacy DSH-TUI theme mapping', () => {
  it('keeps the product-owned v1 contract compatible with the retained UI config', () => {
    expect(PRODUCT_THEME_PRESETS).toEqual(UI_THEME_PRESETS)
    expect(PRODUCT_ANSI_COLORS).toEqual(UI_ANSI_COLORS)
    expect(PRODUCT_THEME_ROLES).toEqual(UI_THEME_ROLES)
    expect(Object.isFrozen(PRODUCT_THEME_PRESETS)).toBe(true)
    expect(Object.isFrozen(PRODUCT_ANSI_COLORS)).toBe(true)
    expect(Object.isFrozen(PRODUCT_THEME_ROLES)).toBe(true)
    expectTypeOf<ProductThemeConfig>().toMatchTypeOf<UiThemeConfig>()
    expectTypeOf<UiThemeConfig>().toMatchTypeOf<ProductThemeConfig>()
  })

  it('maps every legacy semantic role onto the new product palette', () => {
    const mapped = mapLegacyThemeConfig({
      preset: 'cordis',
      colors: {
        primary: 'white',
        accent: 'cyanBright',
        muted: 'gray',
        user: 'blueBright',
        assistant: 'magentaBright',
        reasoning: 'magenta',
        tool: 'yellowBright',
        command: 'cyan',
        dashboard: 'blue',
        activity: 'green',
        interaction: 'whiteBright',
        composer: 'blackBright',
        telemetry: 'cyanBright',
        success: 'greenBright',
        warning: 'yellow',
        error: 'redBright',
        border: 'default',
        code: 'green',
      },
    })
    expect(mapped).toEqual({
      colorMode: 'auto',
      palette: {
        foreground: 'white',
        accent: 'cyanBright',
        muted: 'gray',
        userBarForeground: 'blueBright',
        assistant: 'magentaBright',
        reasoning: 'magenta',
        tool: 'yellowBright',
        command: 'cyan',
        dashboard: 'blue',
        activity: 'green',
        interaction: 'whiteBright',
        composer: 'blackBright',
        telemetry: 'cyanBright',
        success: 'greenBright',
        warning: 'yellow',
        error: 'redBright',
        border: 'default',
        code: 'green',
      },
    })
    const projected = projectSemanticTheme(
      compileSemanticTheme(mapped),
      { colorLevel: 'ansi16' },
    )
    expect(projected.styles.foreground).toMatchObject({ kind: 'ansi16', index: 7 })
    expect(projected.styles.userBarForeground).toMatchObject({ kind: 'ansi16', index: 12 })
    expect(projected.styles.border.kind).toBe('default')
  })

  it('maps legacy mono and empty configurations without mutable shared state', () => {
    const mono = mapLegacyThemeConfig({ preset: 'mono', colors: { error: 'red' } })
    const empty = mapLegacyThemeConfig()
    const auto = mapLegacyThemeConfig({ preset: 'auto' })
    const emptyColors = mapLegacyThemeConfig({ colors: {} })

    expect(mono).toEqual({ colorMode: 'mono', palette: { error: 'red' } })
    expect(empty).toEqual({ colorMode: 'auto' })
    expect(auto).toEqual({ colorMode: 'auto' })
    expect(emptyColors).toEqual({ colorMode: 'auto' })
    expect(Object.isFrozen(mono)).toBe(true)
    expect(Object.isFrozen(mono.palette)).toBe(true)
    expect(empty).not.toBe(auto)
  })

  it('lets the semantic palette override mapped legacy colors', () => {
    const mapped = mapLegacyThemeConfig({
      colors: { primary: 'white', accent: 'red' },
      palette: { foreground: '#102030', accent: '#abcdef' },
    })

    expect(mapped).toEqual({
      colorMode: 'auto',
      palette: { foreground: '#102030', accent: '#abcdef' },
    })
    const projected = projectSemanticTheme(
      compileSemanticTheme(mapped),
      { colorLevel: 'truecolor' },
    )
    expect(projected.styles.foreground).toMatchObject({
      kind: 'truecolor',
      rgb: '#102030',
    })
    expect(projected.styles.accent).toMatchObject({
      kind: 'truecolor',
      rgb: '#abcdef',
    })
  })

  it('ignores unknown runtime legacy keys rather than leaking them forward', () => {
    const mapped = mapLegacyThemeConfig({
      colors: {
        primary: 'white',
        secret: 'red',
      },
    } as never)
    expect(mapped).toEqual({
      colorMode: 'auto',
      palette: { foreground: 'white' },
    })
    expect(JSON.stringify(mapped)).not.toContain('secret')
  })
})
