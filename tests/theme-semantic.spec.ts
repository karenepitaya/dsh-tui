import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEMANTIC_PALETTE,
  SEMANTIC_COLOR_ROLES,
  compileSemanticTheme,
  projectSemanticColor,
  projectSemanticTheme,
} from '../src/theme/semantic-colors.ts'

const ESC = '\u001b['

describe('semantic color engine', () => {
  it('defines a complete immutable semantic palette', () => {
    expect(SEMANTIC_COLOR_ROLES).toEqual([
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
    ])
    expect(Object.keys(DEFAULT_SEMANTIC_PALETTE)).toEqual(SEMANTIC_COLOR_ROLES)
    expect(DEFAULT_SEMANTIC_PALETTE).toEqual({
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
    expect(Object.isFrozen(SEMANTIC_COLOR_ROLES)).toBe(true)
    expect(Object.isFrozen(DEFAULT_SEMANTIC_PALETTE)).toBe(true)
  })

  it('compiles RGB hex and legacy ANSI names into one capability-neutral palette', () => {
    const compiled = compileSemanticTheme({
      palette: {
        foreground: '#112233',
        error: 'redBright',
        border: 'default',
      },
    })
    expect(compiled.colorMode).toBe('auto')
    expect(compiled.colors.foreground).toEqual({
      kind: 'rgb',
      red: 17,
      green: 34,
      blue: 51,
    })
    expect(compiled.colors.error).toEqual({
      kind: 'rgb',
      red: 255,
      green: 0,
      blue: 0,
      legacyIndex: 9,
    })
    expect(compiled.colors.border).toEqual({ kind: 'default' })
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.colors)).toBe(true)
    expect(Object.isFrozen(compiled.colors.foreground)).toBe(true)
  })

  it('emits truecolor foreground and background SGR deterministically', () => {
    const theme = projectSemanticTheme(compileSemanticTheme({
      palette: {
        error: '#ff0000',
        userBarBackground: '#112233',
        border: 'default',
      },
    }), { colorLevel: 'truecolor' })

    expect(theme.colorLevel).toBe('truecolor')
    expect(theme.styles.error).toMatchObject({
      kind: 'truecolor',
      rgb: '#ff0000',
      foregroundOpen: `${ESC}38;2;255;0;0m`,
      backgroundOpen: `${ESC}48;2;255;0;0m`,
    })
    expect(theme.paint('error', 'boom')).toBe(
      `${ESC}38;2;255;0;0mboom${ESC}39m`,
    )
    expect(theme.paintBackground('userBarBackground', ' prompt ')).toBe(
      `${ESC}48;2;17;34;51m prompt ${ESC}49m`,
    )
    expect(theme.paint('border', 'line')).toBe('line')
    expect(theme.paint('error', '')).toBe('')
    expect(Object.isFrozen(theme)).toBe(true)
    expect(Object.isFrozen(theme.styles)).toBe(true)
    expect(Object.isFrozen(theme.styles.error)).toBe(true)
  })

  it('uses exact legacy indexes and nearest xterm-256 colors', () => {
    const compiled = compileSemanticTheme({
      palette: {
        error: '#ff0000',
        warning: 'red',
        success: '#00ff00',
        muted: '#080808',
      },
    })
    const first = projectSemanticTheme(compiled, { colorLevel: 'ansi256' })
    const second = projectSemanticTheme(compiled, { colorLevel: 'ansi256' })

    expect(first.styles.error).toMatchObject({ kind: 'ansi256', index: 9 })
    expect(first.styles.warning).toMatchObject({ kind: 'ansi256', index: 1 })
    expect(first.styles.success).toMatchObject({ kind: 'ansi256', index: 10 })
    expect(first.styles.muted).toMatchObject({ kind: 'ansi256', index: 232 })
    expect(first.paint('warning', 'warn')).toBe(`${ESC}38;5;1mwarn${ESC}39m`)
    expect(first.paintBackground('success', 'ok')).toBe(`${ESC}48;5;10mok${ESC}49m`)
    expect(second.styles).toEqual(first.styles)
  })

  it('downgrades to deterministic ANSI-16 foreground and background codes', () => {
    const theme = projectSemanticTheme(compileSemanticTheme({
      palette: {
        error: '#ff0000',
        warning: '#808000',
        success: 'greenBright',
      },
    }), { colorLevel: 'ansi16' })

    expect(theme.styles.error).toMatchObject({ kind: 'ansi16', index: 9 })
    expect(theme.styles.warning).toMatchObject({ kind: 'ansi16', index: 3 })
    expect(theme.styles.success).toMatchObject({ kind: 'ansi16', index: 10 })
    expect(theme.paint('error', 'error')).toBe(`${ESC}91merror${ESC}39m`)
    expect(theme.paint('warning', 'warning')).toBe(`${ESC}33mwarning${ESC}39m`)
    expect(theme.paintBackground('error', 'deleted')).toBe(
      `${ESC}101mdeleted${ESC}49m`,
    )
    expect(theme.paintBackground('warning', 'changed')).toBe(
      `${ESC}43mchanged${ESC}49m`,
    )
  })

  it('preserves semantic hue instead of washing the calm palette into ANSI whites', () => {
    const theme = projectSemanticTheme(
      compileSemanticTheme(),
      { colorLevel: 'ansi16' },
    )

    expect(theme.styles).toMatchObject({
      foreground: { kind: 'ansi16', index: 15 },
      muted: { kind: 'ansi16', index: 8 },
      accent: { kind: 'ansi16', index: 12 },
      error: { kind: 'ansi16', index: 9 },
      success: { kind: 'ansi16', index: 10 },
      warning: { kind: 'ansi16', index: 11 },
      userBarBackground: { kind: 'ansi16', index: 4 },
      border: { kind: 'ansi16', index: 4 },
      diffAddBackground: { kind: 'ansi16', index: 2 },
      diffDeleteBackground: { kind: 'ansi16', index: 1 },
    })
  })

  it('covers every ANSI-16 grayscale and hue bucket deterministically', () => {
    const index = (color: `#${string}`): number | undefined => (
      projectSemanticColor(color, { colorLevel: 'ansi16' }).index
    )

    expect(index('#000000')).toBe(0)
    expect(index('#101010')).toBe(0)
    expect(index('#cccccc')).toBe(7)
    expect(index('#00ffff')).toBe(14)
    expect(index('#0000ff')).toBe(12)
    expect(index('#ff00ff')).toBe(13)
  })

  it('emits no ANSI in mono and lets an explicit mono theme override capability', () => {
    const compiled = compileSemanticTheme()
    const mono = projectSemanticTheme(compiled, { colorLevel: 'mono' })
    expect(mono.paint('error', 'plain')).toBe('plain')
    expect(mono.paintBackground('diffAddBackground', '+ line')).toBe('+ line')
    expect(JSON.stringify(mono)).not.toContain('\u001b')
    expect(new Set(Object.values(mono.styles).map(style => style.kind))).toEqual(
      new Set(['mono']),
    )

    const forced = projectSemanticTheme(
      compileSemanticTheme({ colorMode: 'mono', palette: { error: '#ff0000' } }),
      { colorLevel: 'truecolor' },
    )
    expect(forced.colorLevel).toBe('mono')
    expect(forced.paint('error', 'still plain')).toBe('still plain')
    expect(projectSemanticColor('#ff0000', { colorLevel: 'truecolor' }, 'mono'))
      .toMatchObject({ kind: 'mono' })
  })

  it('reprojects styles without reading configuration or loading a resource', () => {
    let configurationReads = 0
    let resourceLoads = 0
    const config = {
      get palette() {
        configurationReads += 1
        return { accent: '#7aa2f7' as const }
      },
    }
    const compiled = compileSemanticTheme(config)
    const before = JSON.stringify(compiled)
    const ansi16 = projectSemanticTheme(compiled, { colorLevel: 'ansi16' })
    const truecolor = projectSemanticTheme(compiled, { colorLevel: 'truecolor' })

    expect(configurationReads).toBe(1)
    expect(resourceLoads).toBe(0)
    expect(JSON.stringify(compiled)).toBe(before)
    expect(ansi16.styles.accent.kind).toBe('ansi16')
    expect(truecolor.styles.accent.kind).toBe('truecolor')
    resourceLoads += 0
  })

  it('rejects invalid modes, roles, and color inputs', () => {
    expect(() => compileSemanticTheme({ colorMode: 'forced' as never }))
      .toThrow('Invalid semantic color mode: forced')
    expect(() => compileSemanticTheme({
      palette: { unknown: '#ffffff' } as never,
    })).toThrow('Unknown semantic color role: unknown')
    expect(() => compileSemanticTheme({
      palette: { error: '#fff' as never },
    })).toThrow('Invalid color input: #fff')
    expect(() => compileSemanticTheme({
      palette: { error: 'ultraviolet' as never },
    })).toThrow('Invalid color input: ultraviolet')
    expect(() => compileSemanticTheme({
      palette: { error: 42 as never },
    })).toThrow('Invalid color input: 42')
  })
})
