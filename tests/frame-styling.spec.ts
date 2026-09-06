import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { paintFrameLine } from '../src/terminal/frame-styling.ts'
import { createDshTuiTheme } from '../src/ui/theme.ts'

const theme = createDshTuiTheme({}, {
  colorSupported: true, noColor: false, dumbTerminal: false, colorLevel: 'truecolor',
})

describe('bounded frame styling', () => {
  it('keeps selected navigator styling inside its region and diff color inside its pane', () => {
    const line = paintFrameLine('NAV   +正文', 12, theme, undefined, [
      { column: 0, width: 5, style: { tone: 'accent', inverse: true, fill: true } },
      { column: 6, width: 6, style: { tone: 'success', backgroundRole: 'diffAddBackground' } },
    ])
    expect(stripTerminalSequences(line)).toBe('NAV   +正文 ')
    expect(visibleWidth(line)).toBe(12)
    expect(line).toContain(theme.inverse(theme.paint('accent', 'NAV  ')))
    expect(line).toContain(theme.paintBackground('diffAddBackground', theme.paint('success', '+正文 ')))
    expect(line).not.toContain(theme.inverse(theme.paint('accent', 'NAV   +正文 ')))
  })

  it('lets an overlay replace only its own columns without splitting CJK cells', () => {
    const line = paintFrameLine('导航 +diff', 12, theme, { tone: 'muted', fill: true }, [
      { column: 0, width: 12, style: { tone: 'success' } },
      { column: 5, width: 5, style: { tone: 'warning', bold: true } },
    ])
    expect(stripTerminalSequences(line)).toBe('导航 +diff  ')
    expect(line).toContain(theme.bold(theme.paint('warning', '+diff')))
    expect(visibleWidth(line)).toBe(12)
  })

  it('bounds spans, preserves legacy styling, and dims once', () => {
    expect(paintFrameLine('x', 4, theme)).toBe('x')
    expect(paintFrameLine('x', 4, theme, { tone: 'error', background: 'black', fill: true, bold: true, dim: true, inverse: true }))
      .toBe(theme.dim(theme.inverse(theme.bold(theme.background('black', theme.paint('error', 'x   '))))))
    expect(paintFrameLine('x', 4, theme, undefined, [], true)).toBe(theme.dim('x'))
    const clipped = paintFrameLine('abc', 4, theme, undefined, [
      { column: -2, width: 4, style: { tone: 'success' } },
      { column: 9, width: 2, style: { tone: 'error' } },
      { column: 0, width: 0, style: { tone: 'error' } },
    ])
    expect(stripTerminalSequences(clipped)).toBe('abc ')
    expect(clipped).toContain(theme.paint('success', 'ab'))
    expect(paintFrameLine('abc', 4, theme, undefined, [
      { column: 0, width: 4, style: { tone: 'muted' } },
    ], true)).toBe(theme.dim(theme.paint('muted', 'abc ')))
  })
})
