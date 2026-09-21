import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { FormWorkspace, type FormWorkspaceModel, type FormWorkspaceRole } from 'pi-tui-orbs'
import { stripTerminalSequences, visibleWidth } from '../src/terminal/text-layout.ts'
import { createDshTuiTheme, type DshTuiThemeCapabilities } from '../src/ui/theme.ts'
import { createFormWorkspaceTheme } from '../src/ui/form-workspace-theme.ts'
import { ThemeBinding } from '../src/ui/theme-binding.ts'

const capabilities: DshTuiThemeCapabilities = { colorSupported: true, noColor: false, dumbTerminal: false, colorLevel: 'truecolor' }
const roles: readonly FormWorkspaceRole[] = ['canvas', 'sidebar', 'panel', 'control', 'text', 'title', 'muted', 'border',
  'accent', 'success', 'focus', 'selected', 'button', 'primary', 'warning', 'error', 'disabled']

describe('Settings workspace theme', () => {
  it('distinguishes configured status from the cursor and inherits the shared success palette', async () => {
    const main = createDshTuiTheme({}, capabilities)
    const theme = createFormWorkspaceTheme(main)
    const terminal = new Terminal({ cols: 8, rows: 3, allowProposedApi: true })
    try {
      await new Promise<void>(resolve => terminal.write([
        theme.paint('success', 'C'), theme.paint('focus', 'F'), main.paint('success', 'S'),
      ].join('\r\n'), resolve))
      const cell = (row: number) => terminal.buffer.active.getLine(row)!.getCell(0)!
      expect(cell(0).getFgColor()).toBe(cell(2).getFgColor())
      expect(cell(0).getFgColor()).not.toBe(cell(1).getFgColor())
      expect(cell(1).getBgColor()).not.toBe(cell(0).getBgColor())
    } finally { terminal.dispose() }
  })
  it.each([undefined, '#dd88cc'] as const)('uses the same accent as the main page, including a custom palette (%s)', async accent => {
    const main = createDshTuiTheme({ palette: accent === undefined ? {} : { accent } }, capabilities)
    const settings = createFormWorkspaceTheme(main)
    const terminal = new Terminal({ cols: 8, rows: 3, allowProposedApi: true })
    try {
      await new Promise<void>(resolve => terminal.write([
        main.paint('accent', 'M'), settings.paint('accent', 'S'), settings.paint('primary', 'P'),
      ].join('\r\n'), resolve))
      const mainAccent = terminal.buffer.active.getLine(0)!.getCell(0)!.getFgColor()
      expect(terminal.buffer.active.getLine(1)!.getCell(0)!.getFgColor()).toBe(mainAccent)
      expect(terminal.buffer.active.getLine(2)!.getCell(0)!.getBgColor()).toBe(mainAccent)
    } finally {
      terminal.dispose()
    }
  })

  it('uses the live shared palette for surfaces, text and feedback instead of a Settings palette', async () => {
    const binding = new ThemeBinding(createDshTuiTheme({}, capabilities))
    const settings = createFormWorkspaceTheme(binding.value)
    binding.update(createDshTuiTheme({ palette: {
      foreground: '#ffeedd', muted: '#bbaacc', accent: '#dd88cc',
      panelBackground: '#112233', inputBackground: '#223344',
      inactiveSelectionBackground: '#334455', selectionBackground: '#445566',
      warning: '#ffaa00', error: '#ff0099',
    } }, capabilities))
    const samples = ['canvas', 'sidebar', 'panel', 'control', 'selected', 'muted', 'warning', 'error'] as const
    const terminal = new Terminal({ cols: 8, rows: samples.length, allowProposedApi: true })
    try {
      await new Promise<void>(resolve => terminal.write(samples.map(role => settings.paint(role, 'X')).join('\r\n'), resolve))
      const cells = samples.map((_, row) => terminal.buffer.active.getLine(row)!.getCell(0)!)
      expect(cells.slice(0, 5).map(cell => cell.getBgColor())).toEqual([0x112233, 0x223344, 0x223344, 0x334455, 0x445566])
      expect(cells.map(cell => cell.getFgColor())).toEqual([0xffeedd, 0xffeedd, 0xffeedd, 0xffeedd, 0xdd88cc, 0xbbaacc, 0xffaa00, 0xff0099])
    } finally {
      terminal.dispose()
    }
  })

  it.each(['truecolor', 'ansi256', 'ansi16'] as const)('projects every role into the terminal %s capability without changing text or font', colorLevel => {
    const theme = createFormWorkspaceTheme(createDshTuiTheme({}, { ...capabilities, colorLevel }))
    for (const role of roles) {
      const painted = theme.paint(role, '设置 q 退出')
      expect(stripTerminalSequences(painted)).toBe('设置 q 退出')
      expect(visibleWidth(painted)).toBe(11)
      expect(painted.replace(/\x1b\[[\d;]*m/g, '')).toBe('设置 q 退出')
      if (colorLevel === 'truecolor') expect(painted).toContain('\x1b[38;2;')
      else if (colorLevel === 'ansi256') {
        expect(painted).toContain('\x1b[38;5;')
        expect(painted).not.toContain(';2;')
      } else {
        expect(painted).toMatch(/\x1b\[(?:3[0-7]|9[0-7])m/)
        expect(painted).not.toMatch(/\x1b\[(?:38|48);/)
      }
    }
    for (const role of ['canvas', 'sidebar', 'panel', 'control', 'selected', 'button', 'primary'] as const) {
      expect(theme.paint(role, ' ')).toMatch(colorLevel === 'truecolor' ? /\x1b\[48;2;/
        : colorLevel === 'ansi256' ? /\x1b\[48;5;/ : /\x1b\[(?:4[0-7]|10[0-7])m/)
    }
  })

  it('keeps mono readable through emphasis while emitting no foreground or background colors', () => {
    const theme = createFormWorkspaceTheme(createDshTuiTheme({ preset: 'mono' }, capabilities))
    for (const role of roles) {
      const painted = theme.paint(role, '设置 q 退出')
      expect(painted.replace(/\x1b\[(?:1|22|4|24|7|27)m/g, '')).toBe('设置 q 退出')
    }
    expect(theme.paint('title', '设置')).toContain('\x1b[1m')
    expect(theme.paint('focus', '设置')).toContain('\x1b[4m')
    for (const role of ['selected', 'primary'] as const) expect(theme.paint(role, '设置')).toContain('\x1b[7m')
    expect(theme.paint('muted', 'q 退出')).toBe('q 退出')
  })

  it('respects NO_COLOR and dumb terminals without adding independent style control sequences', () => {
    for (const terminalCapabilities of [{ ...capabilities, noColor: true }, { ...capabilities, dumbTerminal: true }]) {
      const theme = createFormWorkspaceTheme(createDshTuiTheme({}, terminalCapabilities))
      for (const role of roles) {
        const painted = theme.paint(role, 'q 退出')
        expect(painted).not.toMatch(/\x1b\[(?:[349]\d|10\d)(?:;|m)/)
        if (terminalCapabilities.dumbTerminal) expect(painted).toBe('q 退出')
      }
    }
  })

  it('restores each background and foreground after framework resets and nested panels', async () => {
    const theme = createFormWorkspaceTheme(createDshTuiTheme({}, capabilities))
    const painted = theme.paint('canvas', 'a\x1b[0m' + theme.paint('panel', 'b\x1b[0mc') + 'd')
    const terminal = new Terminal({ cols: 8, rows: 1, allowProposedApi: true })
    try {
      await new Promise<void>(resolve => terminal.write(painted, resolve))
      const cells = Array.from({ length: 4 }, (_, column) => terminal.buffer.active.getLine(0)!.getCell(column)!)
      expect(cells.map(cell => cell.getChars()).join('')).toBe('abcd')
      expect(cells.map(cell => cell.getBgColor())).toEqual([0x191c22, 0x242830, 0x242830, 0x191c22])
      expect(cells.map(cell => cell.getFgColor())).toEqual([0xd8dee9, 0xd8dee9, 0xd8dee9, 0xd8dee9])
    } finally {
      terminal.dispose()
    }
  })

  it('paints every cell of the real workspace and keeps the quit hint visible on the filled background', async () => {
    const model: FormWorkspaceModel = { height: 24, activeCategoryId: 'general',
      categories: [{ id: 'general', label: '通用' }], focus: 'content', selectedFieldId: 'theme', dirtyCount: 0, writable: true, actions: [],
      help: 'Enter 修改   q 退出', groups: [{ id: 'appearance', title: '外观', fields: [{ id: 'theme', label: '主题',
        description: '选择界面的配色。', control: { kind: 'text', value: '自动' } }] }] }
    const theme = createFormWorkspaceTheme(createDshTuiTheme({}, capabilities))
    const lines = new FormWorkspace(model, theme).render(100)
    const terminal = new Terminal({ cols: 100, rows: 24, allowProposedApi: true })
    try {
      await new Promise<void>(resolve => terminal.write(lines.join('\r\n'), resolve))
      for (let row = 0; row < 24; row++) for (let column = 0; column < 100; column++) {
        expect(terminal.buffer.active.getLine(row)!.getCell(column)!.isBgDefault(), `background at ${column},${row}`).toBe(false)
      }
      const quitRow = lines.findIndex(line => stripTerminalSequences(line).includes('q 退出'))
      expect(quitRow).toBeGreaterThanOrEqual(0)
      expect(terminal.buffer.active.getLine(quitRow)!.translateToString()).toContain('q 退出')
      const column = visibleWidth(stripTerminalSequences(lines[quitRow]!).split('q 退出')[0]!)
      const cell = terminal.buffer.active.getLine(quitRow)!.getCell(column)!
      expect(cell.getFgColor()).not.toBe(cell.getBgColor())
    } finally {
      terminal.dispose()
    }
  })
})
