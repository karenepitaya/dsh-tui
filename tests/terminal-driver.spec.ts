import { EventEmitter } from 'node:events'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getKeybindings,
  Key,
  KeybindingsManager,
  matchesKey,
  ProcessTerminal,
  setKeybindings,
  TUI_KEYBINDINGS,
} from '@earendil-works/pi-tui'
import {
  DshProcessTerminal,
  PiTerminalDriver,
  RawBytePiTerminal,
  TERMINAL_RECOVERY_SEQUENCE,
} from '../src/terminal/driver.ts'
import type { TerminalInputAction } from '../src/terminal/input.ts'
import type { UiFrame } from '../src/ui/frame.ts'
import type { ConversationSurface } from '../src/ui/conversation.ts'
import { createDshTuiTheme } from '../src/ui/theme.ts'

class FakeInput extends EventEmitter {
  readonly rawModes: boolean[] = []
  readonly lifecycle: string[] = []
  isTTY = true
  isRaw = false

  setRawMode(enabled: boolean): this {
    this.rawModes.push(enabled)
    this.isRaw = enabled
    return this
  }

  resume(): this {
    this.lifecycle.push('resume')
    return this
  }

  pause(): this {
    this.lifecycle.push('pause')
    return this
  }

  data(chunk: Uint8Array | string): void {
    this.emit('data', chunk)
  }
}

class FakeOutput extends EventEmitter {
  readonly writes: string[] = []
  isTTY = true
  columns = 20
  rows = 5
  failOnWrite: ((data: string) => boolean) | undefined

  write(data: string): boolean {
    if (this.failOnWrite?.(data) === true) throw new Error('write failed')
    this.writes.push(data)
    return true
  }

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
}

interface LayoutBoxLike {
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly children: readonly LayoutBoxLike[]
  readonly scrollView?: unknown
}

function findLayoutBox(
  box: LayoutBoxLike | undefined,
  predicate: (candidate: LayoutBoxLike) => boolean,
): LayoutBoxLike | undefined {
  if (box === undefined || predicate(box)) return box
  for (const child of box.children) {
    const found = findLayoutBox(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

function frame(overrides: Partial<UiFrame> = {}): UiFrame {
  return {
    title: 'DSH-TUI',
    viewport: { columns: 20, rows: 5 },
    lines: ['header', '你🙂 prompt', '', '', 'footer'],
    cursor: { row: 1, column: 4 },
    ...overrides,
  }
}

function conversationSurface(overrides: Partial<ConversationSurface> = {}): ConversationSurface {
  return {
    sessionId: 'conversation-a',
    bindingEpoch: 1,
    header: 'DSH-TUI · conversation-a · idle',
    nodes: [{
      kind: 'assistant',
      key: 'assistant:1:1',
      revision: '1',
      text: 'answer',
    }],
    composer: 'draft',
    composerColumn: 3,
    composerPrefix: '> ',
    footer: 'Ctrl+F search',
    reasoningExpanded: false,
    ...overrides,
  }
}

function conversationFrame(): UiFrame {
  return frame({
    conversation: {
      sessionId: 'session-a',
      bindingEpoch: 1,
      header: 'DSH-TUI · session-a',
      nodes: [{
        kind: 'user',
        key: 'event:1',
        revision: '1',
        text: 'searchable transcript',
      }],
      composer: '',
      composerColumn: 0,
      composerPrefix: '> ',
      footer: 'Ctrl+F search',
      reasoningExpanded: false,
    },
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PiTerminalDriver', () => {
  it('delegates production keyboard negotiation to pi-tui ProcessTerminal', () => {
    const driver = new PiTerminalDriver()
    const terminal = (driver as unknown as { terminal: unknown }).terminal
    expect(terminal).toBeInstanceOf(DshProcessTerminal)
  })

  it('adapts the negotiated process terminal without bypassing product actions', () => {
    let processInput: ((data: string) => void) | undefined
    let processResize: (() => void) | undefined
    const superStart = vi.spyOn(ProcessTerminal.prototype, 'start')
      .mockImplementation((onInput, onResize) => {
        processInput = onInput
        processResize = onResize
      })
    const superStop = vi.spyOn(ProcessTerminal.prototype, 'stop').mockImplementation(() => {})
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const actions: TerminalInputAction[] = []
    const lifecycle: string[] = []
    const terminal = new DshProcessTerminal(false)

    terminal.setCallbacks({
      onInput: action => actions.push(action),
      onResize: viewport => lifecycle.push(`product:${viewport.columns}x${viewport.rows}`),
    })
    terminal.setProductInputThroughTui(true)
    terminal.setBeforeResize(() => lifecycle.push('before'))
    terminal.dispatchTuiInput('ignored-before-start')
    terminal.start(
      data => lifecycle.push(`pi-input:${data}`),
      () => lifecycle.push('pi-resize'),
    )
    expect(() => terminal.start(() => {}, () => {})).toThrow('already started')

    terminal.dispatchTuiInput('')
    terminal.dispatchTuiInput('typed')
    processInput?.('raw')
    processResize?.()
    expect(actions).toContainEqual({ type: 'insert', text: 'typed' })
    expect(lifecycle).toContain('pi-input:raw')
    expect(lifecycle).toContain('before')
    expect(lifecycle).toContain('pi-resize')

    terminal.stop()
    terminal.handoff({
      onInput: action => actions.push(action),
      onResize: () => terminal.stop(),
    })
    terminal.start(
      data => lifecycle.push(`pi-input-2:${data}`),
      () => lifecycle.push('pi-resize-2'),
    )
    terminal.setQuiescing()
    terminal.dispatchTuiInput('ignored-while-quiescing')
    processInput?.('not-an-interrupt')
    processInput?.('\x03')
    expect(actions.at(-1)).toEqual({ type: 'interrupt' })
    processResize?.()
    expect(lifecycle).not.toContain('pi-resize-2')
    processInput?.('ignored-after-stop')
    processResize?.()
    terminal.stop()

    terminal.write('\x1b[31mplain\x1b[0m')
    new DshProcessTerminal(true).write('\x1b[31mstyled\x1b[0m')
    expect(write.mock.calls.map(call => String(call[0])).join('')).toContain('plain')
    expect(write.mock.calls.map(call => String(call[0])).join('')).not.toContain('\x1b[31mplain')
    expect(write.mock.calls.map(call => String(call[0])).join('')).toContain('\x1b[31mstyled')

    terminal.emergencyRestore()
    terminal.emergencyRestore()
    expect(write.mock.calls.map(call => String(call[0])).join('')).toContain(TERMINAL_RECOVERY_SEQUENCE)
    expect(superStart).toHaveBeenCalledTimes(2)
    expect(superStop).toHaveBeenCalledTimes(2)

    write.mockImplementationOnce(() => { throw new Error('closed stdout') })
    expect(() => new DshProcessTerminal().emergencyRestore()).not.toThrow()
  })

  it('restores a process terminal when pi startup fails', () => {
    vi.spyOn(ProcessTerminal.prototype, 'start').mockImplementation(() => {
      throw new Error('pi startup failed')
    })
    const stop = vi.spyOn(ProcessTerminal.prototype, 'stop').mockImplementation(() => {})
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const terminal = new DshProcessTerminal()

    expect(() => terminal.start(() => {}, () => {})).toThrow('pi startup failed')
    expect(stop).toHaveBeenCalledOnce()
    expect(write.mock.calls.map(call => String(call[0])).join('')).toContain(TERMINAL_RECOVERY_SEQUENCE)
  })

  it('preflights every process TTY capability before pi owns the terminal', () => {
    const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const setRawMode = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode')
    const define = (target: object, key: string, value: unknown): void => {
      Object.defineProperty(target, key, { configurable: true, value })
    }
    const restore = (target: object, key: string, descriptor: PropertyDescriptor | undefined): void => {
      if (descriptor === undefined) delete (target as Record<string, unknown>)[key]
      else Object.defineProperty(target, key, descriptor)
    }

    try {
      const terminal = new DshProcessTerminal()
      define(process.stdin, 'isTTY', false)
      expect(() => terminal.assertInteractive()).toThrow('interactive TTY')
      define(process.stdin, 'isTTY', true)
      define(process.stdout, 'isTTY', false)
      expect(() => terminal.assertInteractive()).toThrow('interactive TTY')
      define(process.stdout, 'isTTY', true)
      define(process.stdin, 'setRawMode', undefined)
      expect(() => terminal.assertInteractive()).toThrow('interactive TTY')
      define(process.stdin, 'setRawMode', () => {})
      expect(() => terminal.assertInteractive()).not.toThrow()
    } finally {
      restore(process.stdin, 'isTTY', stdinIsTty)
      restore(process.stdout, 'isTTY', stdoutIsTty)
      restore(process.stdin, 'setRawMode', setRawMode)
    }
  })

  it('owns raw byte input and pairs terminal lifecycle state', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const actions: TerminalInputAction[] = []
    const viewports: unknown[] = []
    const driver = new PiTerminalDriver({ input, output })

    expect(driver.state).toBe('idle')
    expect(driver.viewport).toEqual({ columns: 20, rows: 5 })
    driver.start({
      onInput: action => actions.push(action),
      onResize: viewport => viewports.push(viewport),
    })

    expect(driver.state).toBe('running')
    expect(input.rawModes).toEqual([true])
    expect(input.lifecycle).toEqual(['resume'])
    expect(input.listenerCount('data')).toBe(1)
    expect(output.listenerCount('resize')).toBe(1)
    expect(output.writes.join('')).toContain('\x1b[?1049h')
    expect(output.writes.join('')).toContain('\x1b[?2004h')
    expect(output.writes.join('')).toContain('\x1b[?25l')

    input.data(Buffer.from('你'))
    input.data(Uint8Array.of(0x03))
    expect(actions).toEqual([
      { type: 'insert', text: '你' },
      { type: 'interrupt' },
    ])

    driver.stopAcceptingInput()
    expect(driver.state).toBe('quiescing')
    input.data(Buffer.from('ignored'))
    input.data(Uint8Array.of(0x03))
    expect(actions.at(-1)).toEqual({ type: 'interrupt' })
    expect(actions).toHaveLength(3)

    output.resize(11, 3)
    expect(viewports).toEqual([{ columns: 11, rows: 3 }])
    expect(driver.viewport).toEqual({ columns: 11, rows: 3 })

    driver.restore()
    const restoredOutput = output.writes.join('')
    expect(driver.state).toBe('restored')
    expect(input.rawModes).toEqual([true, false])
    expect(input.lifecycle).toEqual(['resume', 'pause'])
    expect(input.listenerCount('data')).toBe(0)
    expect(output.listenerCount('resize')).toBe(0)
    expect(restoredOutput).toContain('\x1b[?2026l')
    expect(restoredOutput).toContain('\x1b[0m')
    expect(restoredOutput).toContain('\x1b[?2004l')
    expect(restoredOutput).toContain('\x1b[?1049l')
    expect(restoredOutput).toContain('\x1b[?25h')
    expect(restoredOutput).toContain('\x1b[?1000l')
    expect(restoredOutput).toContain('\x1b[?1002l')
    expect(restoredOutput).toContain('\x1b[?1003l')
    expect(restoredOutput).toContain('\x1b[?1004l')
    expect(restoredOutput).toContain('\x1b[?1006l')
    expect(restoredOutput).toContain(TERMINAL_RECOVERY_SEQUENCE)

    const writeCount = output.writes.length
    driver.restore()
    expect(output.writes).toHaveLength(writeCount)
  })

  it('scopes viewport keybindings and keeps search input out of product input', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const actions: TerminalInputAction[] = []
    const previousKeybindings = getKeybindings()
    const driver = new PiTerminalDriver({ input, output })

    driver.start({ onInput: action => actions.push(action), onResize: () => {} })
    driver.render(conversationFrame())
    const activeKeybindings = getKeybindings()
    expect(activeKeybindings).not.toBe(previousKeybindings)
    expect(activeKeybindings.getKeys('tui.altScreen.search')).toContain('ctrl+f')
    expect(activeKeybindings.getKeys('tui.altScreen.top')).toEqual(['ctrl+home'])
    expect(activeKeybindings.getKeys('tui.altScreen.bottom')).toEqual(['ctrl+end'])

    const searchable = frame({
      lines: ['needle needle', '', '', '', 'footer'],
      conversation: conversationSurface({
        nodes: [{
          kind: 'assistant',
          key: 'assistant:search',
          revision: '1',
          text: 'needle needle',
        }],
      }),
    })
    driver.render(searchable)
    input.data(Buffer.from('\x06'))
    input.data(Buffer.from('needle'))
    driver.render(searchable)
    input.data(Buffer.from('\r'))
    input.data(Uint8Array.of(0x03))
    expect(actions).toEqual([])

    input.data(Buffer.from('\x1b[H'))
    input.data(Buffer.from('\x1b[F'))
    expect(actions).toEqual([
      { type: 'move-home' },
      { type: 'move-end' },
    ])

    driver.restore()
    expect(getKeybindings()).toBe(previousKeybindings)
    expect(matchesKey('\x06', Key.ctrl('f'))).toBe(true)
  })

  it('sanitizes bracketed paste before a focused search input can render it', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const actions: TerminalInputAction[] = []
    const driver = new PiTerminalDriver({ input, output })
    const searchable = conversationFrame()

    driver.start({ onInput: action => actions.push(action), onResize: () => {} })
    driver.render(searchable)
    input.data(Buffer.from('\x06'))
    input.data(Buffer.from(
      '\x1b[200~'
      + '\x1b]52;c;clipboard-target\x07'
      + 'safe'
      + '\x1b]8;;javascript:link-target\x1b\\click\x1b]8;;\x1b\\'
      + '\x1b_payload-target\x1b\\'
      + '\x1b[201~',
    ))
    driver.render(searchable)

    const writes = output.writes.join('')
    expect(writes).toContain('safeclick')
    expect(writes).not.toContain('clipboard-target')
    expect(writes).not.toContain('link-target')
    expect(writes).not.toContain('payload-target')
    expect(actions).toEqual([])
    driver.restore()
  })

  it('routes conversation composer input while isolating search and survives resize/flat switching', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    output.columns = 36
    output.rows = 6
    const actions: TerminalInputAction[] = []
    const viewports: unknown[] = []
    const driver = new PiTerminalDriver({ input, output })
    driver.start({
      onInput: action => actions.push(action),
      onResize: viewport => viewports.push(viewport),
    })

    driver.render(frame({
      viewport: { columns: 36, rows: 6 },
      lines: Array.from({ length: 6 }, () => ''),
      conversation: conversationSurface(),
    }))
    input.data(Buffer.from('中'))
    expect(actions).toEqual([{ type: 'insert', text: '中' }])

    input.data(Buffer.from('\x06'))
    input.data(Buffer.from('needle'))
    input.data(Buffer.from('\r'))
    input.data(Uint8Array.of(0x03))
    expect(actions).toEqual([{ type: 'insert', text: '中' }])

    output.resize(24, 5)
    expect(viewports).toEqual([{ columns: 24, rows: 5 }])
    driver.render(frame({
      viewport: { columns: 24, rows: 5 },
      lines: Array.from({ length: 5 }, () => ''),
      conversation: conversationSurface({
        nodes: [
          ...conversationSurface().nodes,
          {
            kind: 'assistant',
            key: 'assistant:2:1',
            revision: '2',
            text: 'late output',
          },
        ],
      }),
    }))
    const longA = conversationSurface({
      nodes: Array.from({ length: 12 }, (_, index) => ({
        kind: 'assistant' as const,
        key: `assistant:${index}:1`,
        revision: String(index),
        text: `message ${index}`,
      })),
    })
    driver.render(frame({
      viewport: { columns: 24, rows: 5 },
      lines: Array.from({ length: 5 }, () => ''),
      conversation: longA,
    }))
    const internals = driver as unknown as {
      conversation: { scroll: { scrollTo(top: number, options: { disableFollow: boolean }): void } }
      tui: { renderNow(): void }
    }
    internals.conversation.scroll.scrollTo(0, { disableFollow: true })
    driver.render(frame({
      viewport: { columns: 24, rows: 5 },
      lines: Array.from({ length: 5 }, () => ''),
      conversation: conversationSurface({
        sessionId: 'conversation-b',
        bindingEpoch: 2,
        nodes: longA.nodes.map(node => ({ ...node, key: `b:${node.key}` })),
      }),
    }))
    const renderNow = vi.spyOn(internals.tui, 'renderNow')
    driver.render(frame({
      viewport: { columns: 24, rows: 5 },
      lines: Array.from({ length: 5 }, () => ''),
      conversation: { ...longA, bindingEpoch: 3 },
    }))
    expect(renderNow).toHaveBeenCalledTimes(2)

    driver.render(frame({
      viewport: { columns: 24, rows: 5 },
      lines: ['flat header', 'flat body', '', '', 'flat footer'],
    }))
    driver.render(frame({
      viewport: { columns: 24, rows: 5 },
      lines: ['flat header 2', 'flat body', '', '', 'flat footer'],
    }))

    expect(output.writes.join('')).toContain('conversation-a')
    expect(output.writes.join('')).toContain('flat header')
    driver.restore()
  })

  it('routes PageUp, wheel, and scrollbar drag to the transcript but not through a fullscreen overlay', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    output.columns = 40
    output.rows = 8
    const actions: TerminalInputAction[] = []
    const driver = new PiTerminalDriver({ input, output })
    const longSurface = conversationSurface({
      nodes: Array.from({ length: 24 }, (_, index) => ({
        kind: 'assistant' as const,
        key: `assistant:${index}:1`,
        revision: String(index),
        text: `message ${index}`,
      })),
    })
    const longFrame = frame({
      viewport: { columns: 40, rows: 8 },
      lines: Array.from({ length: 8 }, () => ''),
      conversation: longSurface,
    })
    driver.start({ onInput: action => actions.push(action), onResize: () => {} })
    driver.render(longFrame)

    const internals = driver as unknown as {
      conversation: { scroll: { scrollTop: number } }
      tui: { currentLayout?: { root: LayoutBoxLike } }
    }
    const atEnd = internals.conversation.scroll.scrollTop
    expect(atEnd).toBeGreaterThan(0)

    input.data(Buffer.from('\x1b[5~'))
    const afterPageUp = internals.conversation.scroll.scrollTop
    expect(afterPageUp).toBeLessThan(atEnd)
    input.data(Buffer.from('\x1b[<64;10;3M'))
    expect(internals.conversation.scroll.scrollTop).toBeLessThan(afterPageUp)
    expect(actions).toEqual([])

    driver.render(longFrame)
    const scrollBox = findLayoutBox(
      internals.tui.currentLayout?.root,
      box => box.scrollView === internals.conversation.scroll,
    )
    expect(scrollBox).toBeDefined()
    const trackHeight = scrollBox!.rect.height
    const contentHeight = scrollBox!.children[0]?.rect.height ?? 0
    const thumbHeight = Math.max(
      Math.min(2, trackHeight),
      Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
    )
    const maxScrollTop = Math.max(0, contentHeight - trackHeight)
    const maxThumbTop = trackHeight - thumbHeight
    const thumbOffset = maxScrollTop === 0
      ? 0
      : Math.round((internals.conversation.scroll.scrollTop / maxScrollTop) * maxThumbTop)
    const mouseColumn = scrollBox!.rect.x + scrollBox!.rect.width
    const thumbRow = scrollBox!.rect.y + thumbOffset + 1
    const targetRow = scrollBox!.rect.y + 1
    input.data(Buffer.from(`\x1b[<0;${mouseColumn};${thumbRow}M`))
    input.data(Buffer.from(`\x1b[<32;${mouseColumn};${targetRow}M`))
    input.data(Buffer.from(`\x1b[<0;${mouseColumn};${targetRow}m`))
    expect(internals.conversation.scroll.scrollTop).toBe(0)

    driver.render(frame({
      viewport: { columns: 40, rows: 8 },
      lines: ['SESSION PICKER', '', '', '', '', '', '', 'Esc close'],
    }))
    input.data(Buffer.from('\x1b[<65;10;3M'))
    expect(internals.conversation.scroll.scrollTop).toBe(0)
    driver.render(longFrame)
    expect(internals.conversation.scroll.scrollTop).toBe(0)
    driver.restore()
  })

  it('keeps header/composer/footer deterministic in 1/2/3-row conversation viewports', async () => {
    for (const rows of [1, 2, 3]) {
      const input = new FakeInput()
      const output = new FakeOutput()
      output.columns = 30
      output.rows = rows
      const driver = new PiTerminalDriver({ input, output })
      const terminal = new HeadlessTerminal({
        cols: 30,
        rows,
        allowProposedApi: true,
      })
      driver.start({ onInput: () => {}, onResize: () => {} })
      driver.render(frame({
        viewport: { columns: 30, rows },
        lines: Array.from({ length: rows }, () => ''),
        conversation: conversationSurface({
          header: 'DSH-TUI · tiny · idle',
          composer: '草稿',
          composerColumn: 2,
          composerPrefix: '> ',
          footer: 'Ctrl+F search',
        }),
      }))
      await writeHeadless(terminal, output.writes.join(''))

      expect(lineAt(terminal, 0)).toContain('DSH-TUI · tiny · idle')
      expect(Array.from({ length: rows }, (_, row) => lineAt(terminal, row)).join('\n'))
        .not.toContain('answer')
      if (rows === 2) expect(lineAt(terminal, 1)).toContain('> 草稿')
      if (rows >= 3) {
        expect(lineAt(terminal, 1)).toContain('Ctrl+F search')
        expect(lineAt(terminal, 2)).toContain('> 草稿')
      }

      driver.restore()
      terminal.dispose()
    }
  })

  it('does not overwrite a later global keybinding owner during restore', () => {
    const previous = getKeybindings()
    const input = new FakeInput()
    const output = new FakeOutput()
    const driver = new PiTerminalDriver({ input, output })
    const laterOwner = new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.altScreen.search': 'ctrl+g',
    })

    try {
      driver.start({ onInput: () => {}, onResize: () => {} })
      setKeybindings(laterOwner)
      driver.restore()
      expect(getKeybindings()).toBe(laterOwner)
    } finally {
      driver.restore()
      setKeybindings(previous)
    }
  })

  it('drops focused-component input before start and after quiescing', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const actions: TerminalInputAction[] = []
    const terminal = new RawBytePiTerminal(input, output, {})
    terminal.setCallbacks({ onInput: action => actions.push(action), onResize: () => {} })

    terminal.dispatchTuiInput('before')
    terminal.start(() => {}, () => {})
    terminal.setQuiescing()
    terminal.dispatchTuiInput('after')
    expect(actions).toEqual([])
    terminal.stop()
  })

  it('strips SGR styling when the selected terminal theme disables styles', () => {
    const output = new FakeOutput()
    const terminal = new RawBytePiTerminal(new FakeInput(), output, {}, false)
    terminal.write('\x1b[31;1mred\x1b[0m plain')
    expect(output.writes).toEqual(['red plain'])
  })

  it('captures a fullscreen surface above the conversation and restores transcript search afterwards', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const actions: TerminalInputAction[] = []
    const driver = new PiTerminalDriver({ input, output })

    driver.start({ onInput: action => actions.push(action), onResize: () => {} })
    driver.render(conversationFrame())
    driver.render(frame({ lines: ['SESSION PICKER', '', '', '', 'Esc close'] }))

    input.data(Buffer.from('\x06'))
    input.data(Buffer.from('picker-query'))
    expect(actions).toEqual([{ type: 'insert', text: 'picker-query' }])

    actions.length = 0
    driver.render(conversationFrame())
    input.data(Buffer.from('\x06'))
    input.data(Buffer.from('transcript-query'))
    input.data(Uint8Array.of(0x03))
    expect(actions).toEqual([])

    input.data(Uint8Array.of(0x03))
    expect(actions).toEqual([{ type: 'interrupt' }])
    driver.restore()
  })

  it('keeps a fixed secondary overlay independent from retained conversation layout', async () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    output.columns = 60
    output.rows = 16
    const terminal = new HeadlessTerminal({
      cols: 60,
      rows: 16,
      allowProposedApi: true,
    })
    const actions: TerminalInputAction[] = []
    const driver = new PiTerminalDriver({
      input,
      output,
      theme: createDshTuiTheme(
        { preset: 'cordis' },
        { colorSupported: true, noColor: false, dumbTerminal: false },
      ),
    })
    const surface = conversationSurface({
      nodes: Array.from({ length: 30 }, (_, index) => ({
        kind: 'assistant' as const,
        key: `assistant:overlay:${index}`,
        revision: String(index),
        text: `retained message ${index}`,
      })),
    })
    const conversation = frame({
      viewport: { columns: 60, rows: 16 },
      lines: [
        surface.header,
        '',
        'retained message 29',
        ...Array.from({ length: 11 }, () => ''),
        surface.footer,
        '> draft',
      ],
      conversation: surface,
    })

    driver.start({ onInput: action => actions.push(action), onResize: () => {} })
    driver.render(conversation)
    await writeHeadless(terminal, output.writes.join(''))
    let consumed = output.writes.length
    const retainedHeader = lineAt(terminal, 0)
    const retainedFooter = lineAt(terminal, 14)
    const retainedComposer = lineAt(terminal, 15)
    const internals = driver as unknown as {
      backdrop: unknown
      conversation: {
        component: unknown
        setSurface(next: ConversationSurface): void
        scroll: { readonly scrollTop: number }
      }
      secondaryOverlay?: {
        isFocused(): boolean
      }
      tui: { currentLayout?: { root: { component: unknown } } }
    }
    const initialScrollTop = internals.conversation.scroll.scrollTop
    const setSurface = vi.spyOn(internals.conversation, 'setSurface')
    setSurface.mockClear()
    const overlay = frame({
      viewport: { columns: 60, rows: 16 },
      lines: [
        '╭─ FLOATING PANEL ─╮',
        '│ selected         │',
        '│                  │',
        '│                  │',
        '│                  │',
        '│                  │',
        '│                  │',
        '╰──────────────────╯',
      ],
      lineStyles: [
        { tone: 'accent', bold: true },
        { tone: 'accent', inverse: true, fill: true },
      ],
      overlay: {
        kind: 'compact',
        anchor: 'center',
        width: 24,
        maxHeight: 8,
        margin: 1,
      },
    })

    driver.render(overlay)
    await writeHeadless(terminal, output.writes.slice(consumed).join(''))
    consumed = output.writes.length
    const firstVisible = Array.from({ length: 16 }, (_, row) => lineAt(terminal, row))
    const firstOverlayTop = firstVisible.findIndex(line => line.includes('FLOATING PANEL'))
    const firstOverlayBottom = firstVisible.findIndex((line, row) => (
      row > firstOverlayTop && line.includes('╰')
    ))
    const firstHandle = internals.secondaryOverlay
    expect(firstHandle?.isFocused()).toBe(true)
    expect(internals.tui.currentLayout?.root.component).toBe(internals.backdrop)
    expect(internals.conversation.scroll.scrollTop).toBe(initialScrollTop)
    expect(setSurface).not.toHaveBeenCalled()
    expect(output.writes.join('')).toContain('FLOATING PANEL')
    expect(output.writes.join('')).toContain('\x1b[7m')
    expect(firstOverlayTop).toBeGreaterThan(0)
    expect(firstOverlayBottom).toBeGreaterThan(firstOverlayTop)
    expect(lineAt(terminal, 0)).toBe(retainedHeader)
    expect(lineAt(terminal, 14)).toBe(retainedFooter)
    expect(lineAt(terminal, 15)).toBe(retainedComposer)
    expect(firstVisible[2]).toContain('retained message 29')

    driver.render({
      ...overlay,
      lines: overlay.lines.map(line => line.replace('selected', 'updated ')),
    })
    await writeHeadless(terminal, output.writes.slice(consumed).join(''))
    consumed = output.writes.length
    const updatedVisible = Array.from({ length: 16 }, (_, row) => lineAt(terminal, row))
    const updatedOverlayTop = updatedVisible.findIndex(line => line.includes('FLOATING PANEL'))
    const updatedOverlayBottom = updatedVisible.findIndex((line, row) => (
      row > updatedOverlayTop && line.includes('╰')
    ))
    expect(internals.secondaryOverlay).toBe(firstHandle)
    expect(internals.conversation.scroll.scrollTop).toBe(initialScrollTop)
    expect(setSurface).not.toHaveBeenCalled()
    expect(updatedOverlayTop).toBe(firstOverlayTop)
    expect(updatedOverlayBottom).toBe(firstOverlayBottom)
    expect(updatedVisible[0]).toBe(retainedHeader)
    expect(updatedVisible[14]).toBe(retainedFooter)
    expect(updatedVisible[15]).toBe(retainedComposer)

    driver.render({
      ...overlay,
      overlay: { ...overlay.overlay!, width: 26 },
    })
    expect(internals.secondaryOverlay).not.toBe(firstHandle)
    expect(setSurface).not.toHaveBeenCalled()

    input.data(Buffer.from('x'))
    expect(actions).toEqual([{ type: 'insert', text: 'x' }])
    driver.render(conversation)
    expect(setSurface).toHaveBeenCalledOnce()
    expect(internals.secondaryOverlay).toBeUndefined()
    expect(internals.tui.currentLayout?.root.component).toBe(internals.conversation.component)
    driver.restore()
    terminal.dispose()
  })

  it('hands callbacks off without restarting terminal I/O and clears pending input', () => {
    vi.useFakeTimers({ now: 100 })
    const input = new FakeInput()
    const output = new FakeOutput()
    const firstActions: TerminalInputAction[] = []
    const firstViewports: unknown[] = []
    const nextActions: TerminalInputAction[] = []
    const nextViewports: unknown[] = []
    const driver = new PiTerminalDriver({
      input,
      output,
      decoder: { escapeTimeoutMs: 30, sequenceTimeoutMs: 100 },
    })

    driver.start({
      onInput: action => firstActions.push(action),
      onResize: viewport => firstViewports.push(viewport),
    })
    input.data(Buffer.from('before'))
    input.data(Uint8Array.of(0x1b))
    const writesBeforeHandoff = [...output.writes]

    driver.handoff({
      onInput: action => nextActions.push(action),
      onResize: viewport => nextViewports.push(viewport),
    })

    expect(driver.state).toBe('running')
    expect(input.rawModes).toEqual([true])
    expect(input.lifecycle).toEqual(['resume'])
    expect(input.listenerCount('data')).toBe(1)
    expect(output.listenerCount('resize')).toBe(1)
    expect(output.writes).toEqual(writesBeforeHandoff)
    expect(output.writes.join('').match(/\x1b\[\?1049h/gu)).toHaveLength(1)
    expect(output.writes.join('')).not.toContain('\x1b[?1049l')

    vi.advanceTimersByTime(100)
    input.data(Buffer.from('after'))
    output.resize(31, 7)

    expect(firstActions).toEqual([{ type: 'insert', text: 'before' }])
    expect(firstViewports).toEqual([])
    expect(nextActions).toEqual([{ type: 'insert', text: 'after' }])
    expect(nextViewports).toEqual([{ columns: 31, rows: 7 }])
    driver.restore()
    expect(input.rawModes).toEqual([true, false])
    expect(input.lifecycle).toEqual(['resume', 'pause'])
  })

  it('rejects callback handoff outside the running state', () => {
    const driver = new PiTerminalDriver({
      input: new FakeInput(),
      output: new FakeOutput(),
    })
    const callbacks = { onInput: () => {}, onResize: () => {} }

    expect(() => driver.handoff(callbacks)).toThrow('only hand off while running')
    driver.start(callbacks)
    driver.stopAcceptingInput()
    expect(() => driver.handoff(callbacks)).toThrow('only hand off while running')
    driver.restore()
    expect(() => driver.handoff(callbacks)).toThrow('only hand off while running')
  })

  it('expires a lone Escape while preserving split control sequences', () => {
    vi.useFakeTimers({ now: 100 })
    const input = new FakeInput()
    const output = new FakeOutput()
    const actions: TerminalInputAction[] = []
    const driver = new PiTerminalDriver({
      input,
      output,
      decoder: { escapeTimeoutMs: 30, sequenceTimeoutMs: 100 },
    })
    driver.start({ onInput: action => actions.push(action), onResize: () => {} })

    input.data(Uint8Array.of(0x1b))
    vi.advanceTimersByTime(29)
    expect(actions).toEqual([])
    vi.advanceTimersByTime(1)
    expect(actions).toEqual([{ type: 'escape' }])

    input.data(Buffer.from('\x1b['))
    vi.advanceTimersByTime(30)
    expect(actions).toHaveLength(1)
    input.data(Buffer.from('D'))
    expect(actions.at(-1)).toEqual({ type: 'move-left' })
    driver.restore()
  })

  it('recognizes a forced ETX in quiescing even inside an unfinished paste', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const actions: TerminalInputAction[] = []
    const driver = new PiTerminalDriver({ input, output })
    driver.start({ onInput: action => actions.push(action), onResize: () => {} })

    input.data(Buffer.from('\x1b[200~unfinished'))
    expect(actions).toEqual([])
    driver.stopAcceptingInput()
    input.data(Uint8Array.of(0x03))
    expect(actions).toEqual([{ type: 'interrupt' }])
    driver.restore()
  })

  it('re-evaluates quiescing between packets from the same raw chunk', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const actions: TerminalInputAction[] = []
    const driver = new PiTerminalDriver({ input, output })
    driver.start({
      onInput: action => {
        actions.push(action)
        if (action.type === 'insert') driver.stopAcceptingInput()
      },
      onResize: () => {},
    })

    input.data(Buffer.concat([
      Buffer.from('a'),
      Uint8Array.of(0x03),
      Buffer.from('dropped'),
    ]))
    expect(actions).toEqual([
      { type: 'insert', text: 'a' },
      { type: 'interrupt' },
    ])
    expect(driver.state).toBe('quiescing')
    driver.restore()
  })

  it('renders a bounded frame and sanitizes the terminal title', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const driver = new PiTerminalDriver({ input, output })
    driver.start({ onInput: () => {}, onResize: () => {} })

    driver.render(frame({
      title: 'safe\x1b]0;owned\x07\n',
      lines: ['012345678901234567890123', '你🙂 prompt', '', '', 'footer'],
    }))
    const rendered = output.writes.join('')
    expect(rendered).toContain('\x1b]0;safe\x07')
    expect(rendered).not.toContain('owned')
    expect(rendered).not.toContain('012345678901234567890123')
    expect(rendered).toContain('01234567890123456789')
    const writes = output.writes.length
    driver.render(frame({ cursor: { row: 0, column: 15 }, lines: ['x\n', '', '', '', ''] }))
    driver.render(frame({ cursor: { row: 0, column: -1 }, lines: ['x', '', '', '', ''] }))
    driver.render(frame({
      lines: ['accent', 'warning', 'plain', '', ''],
      lineStyles: [
        { tone: 'accent', bold: true, dim: true },
        { tone: 'warning', bold: false, dim: false },
      ],
    }))
    driver.render(frame({
      lines: ['safe \x1b]8;;https://evil.invalid\x07owned-line\x1b]8;;\x07 \x00\u009b31m', '', '', '', ''],
    }))
    expect(output.writes.slice(writes).join('')).toContain('x')
    expect(output.writes.slice(writes).join('')).not.toContain('evil.invalid')
    expect(output.writes.slice(writes).join('')).not.toContain('\x00')
    expect(output.writes.slice(writes).join('')).not.toContain('\u009b')
    ;(driver as unknown as { component: { invalidate(): void } }).component.invalidate()
    driver.restore()
  })

  it('implements the complete public Pi Terminal primitive surface', async () => {
    vi.useFakeTimers({ now: 0 })
    const input = new FakeInput()
    input.isRaw = true
    const output = new FakeOutput()
    const actions: TerminalInputAction[] = []
    const piInput: string[] = []
    const terminal = new RawBytePiTerminal(input, output, {
      escapeTimeoutMs: 30,
      sequenceTimeoutMs: 100,
      maxSequenceBytes: 8,
      maxPasteBytes: 4,
    })
    terminal.setCallbacks({ onInput: action => actions.push(action), onResize: () => {} })
    terminal.assertInteractive()
    terminal.start(data => piInput.push(data), () => {})
    expect(() => terminal.start(() => {}, () => {})).toThrow('already started')

    expect(terminal.kittyProtocolActive).toBe(false)
    terminal.moveBy(2)
    terminal.moveBy(-3)
    terminal.moveBy(0)
    terminal.clearLine()
    terminal.clearFromCursor()
    terminal.clearScreen()
    terminal.setProgress(true)
    terminal.setProgress(false)
    await terminal.drainInput()
    expect(output.writes.join('')).toContain('\x1b[2B\x1b[3A')
    expect(output.writes.join('')).toContain('\x1b[K\x1b[J\x1b[2J\x1b[H')
    expect(output.writes.join('')).toContain('\x1b]9;4;3\x07\x1b]9;4;0\x07')

    input.data('\x1ba')
    input.data(Uint8Array.of(0x00))
    input.data(Buffer.from('\x1b[D'))
    input.data(Buffer.from('\x1b[200~abc\x1b[201~'))
    input.data(Buffer.from('\x1b[123456789~'))
    input.data(Buffer.from('\x1b[200~abcde\x1b[201~'))
    input.data(Buffer.from('z'))
    vi.advanceTimersByTime(100)
    input.data(Uint8Array.of(0x1b))
    vi.advanceTimersByTime(30)

    expect(piInput).toContain('\x1ba')
    expect(piInput).toContain('\x00')
    expect(piInput).toContain('\x1b[D')
    expect(piInput).toContain('\x1b[200~abc\x1b[201~')
    expect(piInput).toContain('\x1b')
    expect(actions).toContainEqual({ type: 'move-left' })
    expect(actions).toContainEqual({ type: 'insert', text: 'abc' })
    expect(actions).toContainEqual({ type: 'escape' })

    const staleData = input.listeners('data')[0] as (data: Uint8Array) => void
    const staleResize = output.listeners('resize')[0] as () => void
    terminal.stop()
    staleData(Buffer.from('ignored'))
    staleResize()
    terminal.emergencyRestore()
    terminal.emergencyRestore()
    expect(input.rawModes).toEqual([true, true])
  })

  it('preflights TTYs and restores a partially-started terminal best-effort', () => {
    const nonTtyInput = new FakeInput()
    const nonTtyOutput = new FakeOutput()
    nonTtyInput.isTTY = false
    const nonTty = new PiTerminalDriver({ input: nonTtyInput, output: nonTtyOutput })
    expect(() => nonTty.start({ onInput: () => {}, onResize: () => {} }))
      .toThrow('interactive TTY')
    expect(nonTtyOutput.writes).toEqual([])

    const input = new FakeInput()
    const output = new FakeOutput()
    let failed = false
    output.failOnWrite = data => {
      if (!failed && data.includes('\x1b[?2004h')) {
        failed = true
        return true
      }
      return false
    }
    const driver = new PiTerminalDriver({ input, output })
    expect(() => driver.start({ onInput: () => {}, onResize: () => {} }))
      .toThrow('write failed')
    expect(driver.state).toBe('restored')
    expect(input.rawModes).toEqual([true, false])
    expect(input.lifecycle).toContain('pause')
    expect(output.writes.join('')).toContain('\x1b[?1049l')
    expect(() => driver.restore()).not.toThrow()

    const outputNonTtyInput = new FakeInput()
    const outputNonTty = new FakeOutput()
    outputNonTty.isTTY = false
    expect(() => new PiTerminalDriver({ input: outputNonTtyInput, output: outputNonTty })
      .start({ onInput: () => {}, onResize: () => {} })).toThrow('interactive TTY')

    const noRawInput = new FakeInput()
    Object.defineProperty(noRawInput, 'setRawMode', { value: undefined })
    expect(() => new PiTerminalDriver({ input: noRawInput, output: new FakeOutput() })
      .start({ onInput: () => {}, onResize: () => {} })).toThrow('interactive TTY')
  })

  it('contains Pi teardown failures and stops a resize callback that restores', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const driver = new PiTerminalDriver({ input, output })
    driver.start({ onInput: () => {}, onResize: () => driver.restore() })
    const staleResize = output.listeners('resize')[0] as () => void
    output.resize(10, 2)
    expect(driver.state).toBe('restored')
    expect(() => staleResize()).not.toThrow()

    const inputRestoreInput = new FakeInput()
    const inputRestoreOutput = new FakeOutput()
    const inputRestore = new PiTerminalDriver({
      input: inputRestoreInput,
      output: inputRestoreOutput,
    })
    inputRestore.start({ onInput: () => inputRestore.restore(), onResize: () => {} })
    inputRestoreInput.data(Buffer.from('q'))
    expect(inputRestore.state).toBe('restored')

    const failingInput = new FakeInput()
    const failingOutput = new FakeOutput()
    const failing = new PiTerminalDriver({ input: failingInput, output: failingOutput })
    failing.start({ onInput: () => {}, onResize: () => {} })
    failingOutput.failOnWrite = () => true
    expect(() => failing.restore()).not.toThrow()
    expect(failingInput.rawModes).toEqual([true, false])
  })

  it('defines idle/restored guards and default process bindings', () => {
    const driver = new PiTerminalDriver()
    expect(driver.viewport.columns).toBeGreaterThan(0)
    expect(driver.viewport.rows).toBeGreaterThan(0)
    expect(() => driver.render(frame())).toThrow('not running')
    driver.stopAcceptingInput()
    driver.restore()
    expect(driver.state).toBe('restored')
    expect(() => driver.start({ onInput: () => {}, onResize: () => {} })).toThrow('restarted')
    expect(() => driver.render(frame())).toThrow('not running')

    const input = new FakeInput()
    const output = new FakeOutput()
    output.columns = Number.NaN
    output.rows = Number.POSITIVE_INFINITY
    expect(new PiTerminalDriver({ input, output }).viewport).toEqual({ columns: 80, rows: 24 })
  })

  it('lands Pi output in a headless VT and leaves the alternate buffer on restore', async () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    output.columns = 20
    output.rows = 5
    const driver = new PiTerminalDriver({ input, output })
    const terminal = new HeadlessTerminal({
      cols: 20,
      rows: 5,
      allowProposedApi: true,
    })

    driver.start({ onInput: () => {}, onResize: () => {} })
    driver.render(frame())
    let consumed = 0
    await writeHeadless(terminal, output.writes.join(''))
    consumed = output.writes.length

    expect(terminal.buffer.active.type).toBe('alternate')
    expect(terminal.modes.bracketedPasteMode).toBe(true)
    expect(lineAt(terminal, 0)).toBe('header')
    expect(lineAt(terminal, 1)).toContain('你🙂 prompt')
    expect(terminal.buffer.active.cursorY).toBe(1)
    expect(terminal.buffer.active.cursorX).toBe(4)

    driver.restore()
    await writeHeadless(terminal, output.writes.slice(consumed).join(''))
    expect(terminal.buffer.active.type).toBe('normal')
    expect(terminal.modes.bracketedPasteMode).toBe(false)
    terminal.dispose()
  })
})

function lineAt(terminal: HeadlessTerminal, row: number): string {
  return terminal.buffer.active.getLine(row)?.translateToString(true) ?? ''
}

async function writeHeadless(terminal: HeadlessTerminal, data: string): Promise<void> {
  await new Promise<void>(resolve => terminal.write(data, resolve))
}
