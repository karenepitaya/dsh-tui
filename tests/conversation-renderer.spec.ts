import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { Terminal } from '@xterm/headless'
import { createAgentRequestRuntime, AGENT_REQUEST_TICK_MS } from 'pi-tui-orbs/agent-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalLayoutBudget } from '../src/presentation/approval-layout.ts'
import { buildApprovalDock } from '../src/ui/approval-dock.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import { ConversationRoot, layoutConversationComposer, type ConversationSurface } from '../src/ui/conversation.ts'
import { createDshTuiTheme } from '../src/ui/theme.ts'
import type { PendingApprovalInteraction } from '../src/interaction/port.ts'

const theme = createDshTuiTheme({ preset: 'cordis' }, {
  colorSupported: true, colorLevel: 'truecolor', noColor: false, dumbTerminal: false,
})
const base: ConversationSurface = {
  sessionId: 'session', bindingEpoch: 1, header: 'header', nodes: [],
  composer: '', composerColumn: 0, composerPrefix: '> ', composerBoxed: true,
  footer: '', reasoningExpanded: false,
}
const item: PendingApprovalInteraction = {
  kind: 'approval', id: 'request', sessionId: 'session', approvalId: 'audit', callId: 'call', toolName: 'pwsh',
  evidence: { source: 'tool/call', arguments: 'echo "exact arguments"', cwd: 'D:/work',
    currentPermission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
    requestedPermission: { kind: 'tool-call' }, missing: [] },
}
function dock(columns: number, rows: number) {
  return buildApprovalDock(item, { type: 'interaction/snapshot', sessionId: 'session', pending: [item] },
    { kind: 'approval', interactionId: 'request', editor: createPromptEditorState() }, columns, rows)
}
async function screen(lines: readonly string[], columns: number, rows = lines.length) {
  const terminal = new Terminal({ cols: columns, rows, allowProposedApi: true })
  await new Promise<void>(resolve => terminal.write(lines.map((line, index) =>
    `\u001b[${index + 1};1H${line.replaceAll(CURSOR_MARKER, '')}`).join(''), resolve))
  return terminal
}
afterEach(() => vi.useRealTimers())

describe('retained conversation screen contract', () => {
  it('does not shrink the inline decision rows at any inspectable retained height', () => {
    const root = new ConversationRoot(theme, () => {})
    for (const rows of [13, 14, 15, 18, 21, 30]) {
      const approval = dock(80, approvalLayoutBudget({ columns: 80, rows }).dockRows)
      root.setSurface({ ...base, dock: approval, composerDisabled: true, composerMaxRows: 6,
        composer: 'one\ntwo\nthree\nfour\nfive\nsix', composerColumn: 27,
        footer: 'obsolete footer must not steal decision rows',
        dashboard: { label: 'GOAL', lines: [{ text: 'goal', tone: 'primary' }] },
        statusline: { text: 'status', tone: 'muted' },
        nodes: [{ kind: 'assistant', key: 'answer', revision: '1', text: 'history\n'.repeat(50) }] })
      const frame = renderLayoutFrame(root.component, 80, rows, () => {})
      const plain = frame.lines.map(stripTerminalSequences)
      expect(plain.join('\n'), `height ${rows}`).toContain('1 Allow once')
      expect(plain.join('\n'), `height ${rows}`).toContain('› 2 Reject')
      expect(plain.join('\n'), `height ${rows}`).toContain('Esc reject')
      expect(frame.lines.join('\n')).not.toContain(CURSOR_MARKER)
      expect(frame.lines).toHaveLength(rows)
      expect(plain.indexOf(plain.find(line => line.includes('Esc reject'))!))
        .toBeLessThan(plain.indexOf(`╭${'─'.repeat(78)}╮`))
    }
    root.dispose()
  })

  it('keeps four-to-ten-row compact approvals inspectable without cursor or cropped decisions', async () => {
    for (const rows of [4, 5, 6, 7, 8, 9, 10]) {
      const budget = approvalLayoutBudget({ columns: 80, rows })
      expect(budget.compactOnly).toBe(true)
      const approval = dock(80, budget.dockRows)
      const terminal = await screen(approval.lines, 80, rows)
      const actual = Array.from({ length: rows }, (_, row) => terminal.buffer.active.getLine(row)!.translateToString(true))
      expect(actual.at(-2)).toContain('› 2 Reject')
      expect(actual.at(-1)).toContain('Esc reject')
      expect(actual.join('\n')).not.toContain('PROMPT')
      terminal.dispose()
    }
  })

  it('shares composer row measurement and attachment placement with the flat projection', () => {
    const root = new ConversationRoot(theme, () => {})
    const attachments = [{ name: '图.png', mediaType: 'image/png' as const, bytes: 400 }]
    for (const rows of [1, 2, 3, 4, 6]) {
      root.setSurface({ ...base, composer: 'first\nsecond\nthird\nfourth', composerColumn: 25,
        composerMaxRows: rows, attachments })
      const actual = root.focusTarget.render(40)
      const expected = layoutConversationComposer('first\nsecond\nthird\nfourth', 25, '> ', '', true, 40, rows, attachments)
      expect(actual).toHaveLength(expected.lines.length)
      expect(actual.length).toBeLessThanOrEqual(rows)
      expect(actual.map(line => stripTerminalSequences(line.replaceAll(CURSOR_MARKER, '')))).toEqual(expected.lines)
      expect(actual.join('\n').includes('IMAGES')).toBe(rows >= 4)
      expect(actual.filter(line => line.includes(CURSOR_MARKER))).toHaveLength(1)
    }
    root.dispose()
  })

  it('paints every composer and inline approval cell including trailing padding', async () => {
    const root = new ConversationRoot(theme, () => {})
    const approval = dock(60, 8)
    for (const [width, maxRows] of [[60, 6], [60, 1], [8, 6]]) {
      root.setSurface({ ...base, composer: '中', composerColumn: 1, composerMaxRows: maxRows!, dock: approval })
      const composer = root.focusTarget.render(width!)
      const terminal = await screen(composer, width!)
      const expected = Number.parseInt(theme.semantic.styles.inputBackground.rgb!.slice(1), 16)
      for (let row = 0; row < composer.length; row += 1) {
        expect(visibleWidth(composer[row]!)).toBe(width)
        for (let column = 0; column < width!; column += 1) {
          expect(terminal.buffer.active.getLine(row)!.getCell(column)!.getBgColor()).toBe(expected)
        }
      }
      terminal.dispose()
    }
    const internals = root as unknown as { dock: { render(width: number): string[] } }
    const terminal = await screen(internals.dock.render(60), 60)
    const expected = Number.parseInt(theme.semantic.styles.panelBackground.rgb!.slice(1), 16)
    for (let row = 0; row < approval.lines.length; row += 1) {
      for (let column = 0; column < 60; column += 1) expect(terminal.buffer.active.getLine(row)!.getCell(column)!.getBgColor()).toBe(expected)
    }
    terminal.dispose()
    root.dispose()
  })

  it('hides only the composer cursor during approval and keeps controller key routing live', () => {
    const input = vi.fn()
    const root = new ConversationRoot(theme, input)
    root.setSurface({ ...base, composer: 'saved draft', composerDisabled: true })
    expect(root.focusTarget.render(50).join('\n')).not.toContain(CURSOR_MARKER)
    root.focusTarget.handleInput?.('\r')
    expect(input).toHaveBeenCalledWith('\r')
    root.setSurface({ ...base, composer: 'saved draft' })
    expect(root.focusTarget.render(50).join('\n')).toContain(CURSOR_MARKER)
    root.dispose()
  })

  it('stops request motion when the first answer projection clears request activity', () => {
    vi.useFakeTimers()
    const requestRender = vi.fn()
    const runtime = createAgentRequestRuntime({ requestRender, motion: 'full', glyphs: 'unicode', color: 'never', isTTY: true })
    const root = new ConversationRoot(theme, () => {}, runtime)
    root.setSurface({ ...base, agentRequest: { phase: 'reasoning', description: 'Thinking' } })
    renderLayoutFrame(root.component, 60, 15, () => {})
    expect(vi.getTimerCount()).toBe(1)
    root.setSurface({ ...base, nodes: [{ kind: 'assistant-draft', key: 'draft', revision: '1', text: '首' }] })
    const frame = renderLayoutFrame(root.component, 60, 15, () => {})
    expect(stripTerminalSequences(frame.lines.join('\n'))).toContain('首')
    expect(vi.getTimerCount()).toBe(0)
    requestRender.mockClear()
    vi.advanceTimersByTime(AGENT_REQUEST_TICK_MS * 3)
    expect(requestRender).not.toHaveBeenCalled()
    root.dispose()
    runtime.dispose()
  })
})
