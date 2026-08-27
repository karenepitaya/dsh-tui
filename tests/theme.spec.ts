import { describe, expect, it } from 'vitest'
import {
  createDshTuiTheme,
  detectDshTuiThemeCapabilities,
  type DshTuiThemeCapabilities,
} from '../src/ui/theme.ts'

const colorTerminal: DshTuiThemeCapabilities = {
  colorSupported: true,
  noColor: false,
  dumbTerminal: false,
}

describe('DSH-TUI semantic theme', () => {
  it('resolves auto to the Cordis palette and restores an outer nested color', () => {
    const theme = createDshTuiTheme({ preset: 'auto' }, colorTerminal)

    expect(theme.preset).toBe('cordis')
    expect(theme.colorEnabled).toBe(true)
    expect(theme.styleEnabled).toBe(true)
    expect(theme.colors.assistant).toBe('blueBright')
    expect(theme.colors).toMatchObject({
      dashboard: 'cyan',
      activity: 'blue',
      interaction: 'magentaBright',
      composer: 'blueBright',
      telemetry: 'cyanBright',
    })
    expect(theme.paint(
      'assistant',
      `A ${theme.paint('error', 'bad')} Z`,
    )).toBe(
      '\u001b[94mA \u001b[91mbad\u001b[94m Z\u001b[39m',
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
    expect(theme.colors.error).toBe('redBright')
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
    })
    expect(theme.paint('accent', 'DSH')).toBe('DSH')
    expect(theme.bold('DSH')).toBe('DSH')
    expect(theme.inverse('DSH')).toBe('DSH')
    expect(theme.underline('DSH')).toBe('DSH')
  })

  it('applies semantic overrides after the preset and freezes resolved state', () => {
    const theme = createDshTuiTheme({
      preset: 'cordis',
      colors: {
        accent: 'magentaBright',
        border: 'default',
      },
    }, colorTerminal)

    expect(theme.colors.accent).toBe('magentaBright')
    expect(theme.paint('accent', 'model')).toBe(
      '\u001b[95mmodel\u001b[39m',
    )
    expect(theme.paint('border', '|')).toBe('|')
    expect(Object.isFrozen(theme)).toBe(true)
    expect(Object.isFrozen(theme.colors)).toBe(true)
    expect(() => {
      ;(theme.colors as { accent: string }).accent = 'red'
    }).toThrow()
  })

  it('exposes safe text styles and exercises default process capabilities', () => {
    const theme = createDshTuiTheme({ preset: 'cordis' }, colorTerminal)

    expect(theme.bold('bold')).toBe('\u001b[1mbold\u001b[22m')
    expect(theme.dim('dim')).toBe('\u001b[2mdim\u001b[22m')
    expect(theme.inverse('selected')).toBe('\u001b[7mselected\u001b[27m')
    expect(theme.italic('italic')).toBe('\u001b[3mitalic\u001b[23m')
    expect(theme.underline('link')).toBe('\u001b[4mlink\u001b[24m')

    const detected = detectDshTuiThemeCapabilities()
    expect(detected).toEqual({
      colorSupported: expect.any(Boolean),
      noColor: expect.any(Boolean),
      dumbTerminal: expect.any(Boolean),
    })
    const defaultTheme = createDshTuiTheme()
    expect(defaultTheme.colorEnabled).toBeTypeOf('boolean')
    expect(defaultTheme.styleEnabled).toBeTypeOf('boolean')
  })

  it('detects platform, TTY, CI, and FORCE_COLOR capability branches', () => {
    expect(detectDshTuiThemeCapabilities({}, false, 'win32')).toMatchObject({
      colorSupported: true,
      noColor: false,
      dumbTerminal: false,
    })
    expect(detectDshTuiThemeCapabilities({}, true, 'linux').colorSupported).toBe(true)
    expect(detectDshTuiThemeCapabilities({ CI: '1' }, false, 'linux').colorSupported).toBe(true)
    expect(detectDshTuiThemeCapabilities({}, false, 'linux').colorSupported).toBe(false)
    expect(detectDshTuiThemeCapabilities({ FORCE_COLOR: '1' }, false, 'linux').colorSupported).toBe(true)
    expect(detectDshTuiThemeCapabilities({ FORCE_COLOR: '0' }, true, 'win32').colorSupported).toBe(false)
    expect(detectDshTuiThemeCapabilities({
      NO_COLOR: '',
      TERM: 'dumb',
    }, true, 'win32')).toMatchObject({
      noColor: true,
      dumbTerminal: true,
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
    })
  })
})
