import { describe, expect, it } from 'vitest'
import {
  DSH_TUI_ANSI_COLORS,
  createDshTuiTheme,
  detectDshTuiThemeCapabilities,
  type DshTuiThemeCapabilities,
} from '../src/ui/theme.ts'

const colorTerminal: DshTuiThemeCapabilities = {
  colorSupported: true,
  noColor: false,
  dumbTerminal: false,
  colorLevel: 'truecolor',
}

const ansi16Terminal: DshTuiThemeCapabilities = {
  ...colorTerminal,
  colorLevel: 'ansi16',
}

describe('DSH-TUI semantic theme', () => {
  it('projects the calm semantic palette into the retained UI theme', () => {
    const theme = createDshTuiTheme({ preset: 'auto' }, colorTerminal)

    expect(theme.preset).toBe('cordis')
    expect(theme.colorEnabled).toBe(true)
    expect(theme.styleEnabled).toBe(true)
    expect(theme.colorLevel).toBe('truecolor')
    expect(theme.semantic.styles).toMatchObject({
      foreground: { kind: 'truecolor', rgb: '#d8dee9' },
      assistant: { kind: 'truecolor', rgb: '#d8dee9' },
      reasoning: { kind: 'truecolor', rgb: '#78839a' },
      tool: { kind: 'truecolor', rgb: '#7aa2f7' },
      activity: { kind: 'truecolor', rgb: '#7aa2f7' },
      interaction: { kind: 'truecolor', rgb: '#e0af68' },
    })
    expect(theme.paint(
      'assistant',
      `A ${theme.paint('error', 'bad')} Z`,
    )).toBe(
      '\u001b[38;2;216;222;233mA '
      + '\u001b[38;2;247;118;142mbad'
      + '\u001b[38;2;216;222;233m Z\u001b[39m',
    )
  })

  it('keeps mono output free of SGR even when semantic overrides are present', () => {
    const theme = createDshTuiTheme({
      preset: 'mono',
      colors: { error: 'redBright' },
    }, colorTerminal)

    expect(theme.preset).toBe('mono')
    expect(theme.colorEnabled).toBe(false)
    expect(theme.styleEnabled).toBe(true)
    expect(theme.colorLevel).toBe('mono')
    expect(theme.semantic.styles.error.kind).toBe('mono')
    expect(theme.paint('error', 'failure')).toBe('failure')
    expect(theme.bold('failure')).toBe('\u001b[1mfailure\u001b[22m')
  })

  it('lets NO_COLOR disable colors without disabling safe emphasis', () => {
    const theme = createDshTuiTheme(
      { preset: 'cordis', colors: { accent: 'magentaBright' } },
      { ...colorTerminal, noColor: true },
    )

    expect(theme).toMatchObject({
      preset: 'mono',
      colorEnabled: false,
      styleEnabled: true,
      colorLevel: 'mono',
    })
    expect(theme.paint('accent', 'DSH')).toBe('DSH')
    expect(theme.italic('thinking')).toBe('\u001b[3mthinking\u001b[23m')
  })

  it('lets TERM=dumb disable every SGR formatter', () => {
    const theme = createDshTuiTheme(
      { preset: 'cordis' },
      { ...colorTerminal, dumbTerminal: true },
    )

    expect(theme).toMatchObject({
      preset: 'mono',
      colorEnabled: false,
      styleEnabled: false,
      colorLevel: 'mono',
    })
    expect(theme.paint('accent', 'DSH')).toBe('DSH')
    expect(theme.bold('DSH')).toBe('DSH')
    expect(theme.inverse('DSH')).toBe('DSH')
    expect(theme.underline('DSH')).toBe('DSH')
  })

  it('maps legacy Theme Config overrides into the projected semantic palette', () => {
    const theme = createDshTuiTheme({
      preset: 'cordis',
      colors: {
        accent: 'magentaBright',
        border: 'default',
      },
    }, ansi16Terminal)

    expect(theme.colorLevel).toBe('ansi16')
    expect(theme.semantic.styles.accent).toMatchObject({
      kind: 'ansi16',
      index: 13,
    })
    expect(theme.paint('accent', 'model')).toBe(
      '\u001b[95mmodel\u001b[39m',
    )
    expect(theme.paint('border', '|')).toBe('|')
    expect(Object.isFrozen(theme)).toBe(true)
    expect(Object.isFrozen(theme.semantic)).toBe(true)
    expect(Object.isFrozen(theme.semantic.styles)).toBe(true)
  })

  it('applies semantic RGB palette entries ahead of legacy Theme Config colors', () => {
    const theme = createDshTuiTheme({
      preset: 'cordis',
      colors: { accent: 'red', border: 'yellow' },
      palette: { accent: '#123456', border: '#abcdef' },
    }, colorTerminal)

    expect(theme.semantic.styles.accent).toMatchObject({
      kind: 'truecolor',
      rgb: '#123456',
    })
    expect(theme.semantic.styles.border).toMatchObject({
      kind: 'truecolor',
      rgb: '#abcdef',
    })
    expect(theme.paint('accent', 'model')).toBe(
      '\u001b[38;2;18;52;86mmodel\u001b[39m',
    )
  })

  it('exposes safe text styles and exercises default process capabilities', () => {
    const theme = createDshTuiTheme({ preset: 'cordis' }, colorTerminal)

    expect(theme.bold('bold')).toBe('\u001b[1mbold\u001b[22m')
    expect(theme.dim('dim')).toBe('\u001b[2mdim\u001b[22m')
    expect(theme.inverse('selected')).toBe('\u001b[7mselected\u001b[27m')
    expect(theme.italic('italic')).toBe('\u001b[3mitalic\u001b[23m')
    expect(theme.underline('link')).toBe('\u001b[4mlink\u001b[24m')
    expect(theme.background('black', 'card')).toBe(
      '\u001b[48;2;0;0;0mcard\u001b[49m',
    )
    expect(theme.background('gray', 'card')).toBe(
      '\u001b[48;2;128;128;128mcard\u001b[49m',
    )
    expect(theme.background('cyanBright', 'card')).toBe(
      '\u001b[48;2;0;255;255mcard\u001b[49m',
    )
    expect(theme.paintBackground('userBarBackground', 'prompt')).toBe(
      '\u001b[48;2;48;54;77mprompt\u001b[49m',
    )
    for (const color of DSH_TUI_ANSI_COLORS) {
      expect(theme.background(color, 'surface')).toContain('surface')
    }

    const detected = detectDshTuiThemeCapabilities()
    expect(detected).toEqual({
      colorSupported: expect.any(Boolean),
      noColor: expect.any(Boolean),
      dumbTerminal: expect.any(Boolean),
      colorLevel: expect.stringMatching(/^(truecolor|ansi256|ansi16|mono)$/u),
    })
    const defaultTheme = createDshTuiTheme()
    expect(defaultTheme.colorEnabled).toBeTypeOf('boolean')
    expect(defaultTheme.styleEnabled).toBeTypeOf('boolean')
  })

  it('detects truecolor, ANSI-256, ANSI-16, and mono capability branches', () => {
    expect(detectDshTuiThemeCapabilities({}, false, 'win32')).toMatchObject({
      colorSupported: true,
      noColor: false,
      dumbTerminal: false,
      colorLevel: 'truecolor',
    })
    expect(detectDshTuiThemeCapabilities({ COLORTERM: 'truecolor' }, true, 'linux'))
      .toMatchObject({ colorSupported: true, colorLevel: 'truecolor' })
    expect(detectDshTuiThemeCapabilities({ TERM: 'xterm-256color' }, true, 'linux'))
      .toMatchObject({ colorSupported: true, colorLevel: 'ansi256' })
    expect(detectDshTuiThemeCapabilities({}, true, 'linux'))
      .toMatchObject({ colorSupported: true, colorLevel: 'ansi16' })
    expect(detectDshTuiThemeCapabilities({ CI: '1' }, false, 'linux'))
      .toMatchObject({ colorSupported: true, colorLevel: 'ansi16' })
    expect(detectDshTuiThemeCapabilities({}, false, 'linux'))
      .toMatchObject({ colorSupported: false, colorLevel: 'mono' })
    expect(detectDshTuiThemeCapabilities({ FORCE_COLOR: '1' }, false, 'linux'))
      .toMatchObject({ colorSupported: true, colorLevel: 'ansi16' })
    expect(detectDshTuiThemeCapabilities({ FORCE_COLOR: '2' }, false, 'linux'))
      .toMatchObject({ colorSupported: true, colorLevel: 'ansi256' })
    expect(detectDshTuiThemeCapabilities({ FORCE_COLOR: '3' }, false, 'linux'))
      .toMatchObject({ colorSupported: true, colorLevel: 'truecolor' })
    expect(detectDshTuiThemeCapabilities({ FORCE_COLOR: '0' }, true, 'win32'))
      .toMatchObject({ colorSupported: false, colorLevel: 'mono' })
    expect(detectDshTuiThemeCapabilities({
      NO_COLOR: '',
      TERM: 'dumb',
    }, true, 'win32')).toMatchObject({
      noColor: true,
      dumbTerminal: true,
      colorLevel: 'mono',
    })
  })

  it('keeps unsupported auto terminals monochrome without an explicit preset', () => {
    const theme = createDshTuiTheme({}, {
      colorSupported: false,
      noColor: false,
      dumbTerminal: false,
    })

    expect(theme).toMatchObject({
      preset: 'mono',
      colorEnabled: false,
      styleEnabled: true,
      colorLevel: 'mono',
    })
  })

  it('preserves the explicit cordis preset for legacy boolean capabilities', () => {
    const theme = createDshTuiTheme({ preset: 'cordis' }, {
      colorSupported: false,
      noColor: false,
      dumbTerminal: false,
    })

    expect(theme).toMatchObject({
      preset: 'cordis',
      colorEnabled: true,
      colorLevel: 'ansi16',
    })

    const auto = createDshTuiTheme({ preset: 'auto' }, {
      colorSupported: true,
      noColor: false,
      dumbTerminal: false,
    })
    expect(auto).toMatchObject({
      preset: 'cordis',
      colorEnabled: true,
      colorLevel: 'ansi16',
    })
  })

  it('uses one compiled palette across every terminal degradation level', () => {
    const levels = ['truecolor', 'ansi256', 'ansi16', 'mono'] as const
    const projected = levels.map(colorLevel => createDshTuiTheme(
      { preset: 'auto', colors: { accent: 'blueBright' } },
      {
        colorSupported: colorLevel !== 'mono',
        noColor: false,
        dumbTerminal: false,
        colorLevel,
      },
    ))

    expect(projected.map(theme => theme.colorLevel)).toEqual(levels)
    expect(projected[0]!.semantic.styles.accent).toMatchObject({
      kind: 'truecolor',
      rgb: '#0000ff',
    })
    expect(projected[1]!.semantic.styles.accent).toMatchObject({
      kind: 'ansi256',
      index: 12,
    })
    expect(projected[2]!.semantic.styles.accent).toMatchObject({
      kind: 'ansi16',
      index: 12,
    })
    expect(projected[3]!.semantic.styles.accent.kind).toBe('mono')
  })
})
