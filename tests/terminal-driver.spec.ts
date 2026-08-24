import { EventEmitter } from 'node:events'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PiTerminalDriver,
  RawBytePiTerminal,
  TERMINAL_RECOVERY_SEQUENCE,
} from '../src/terminal/driver.ts'
import type { TerminalInputAction } from '../src/terminal/input.ts'
import type { UiFrame } from '../src/ui/frame.ts'

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

function frame(overrides: Partial<UiFrame> = {}): UiFrame {
  return {
    title: 'DSH-TUI',
    viewport: { columns: 20, rows: 5 },
    lines: ['header', '你🙂 prompt', '', '', 'footer'],
    cursor: { row: 1, column: 4 },
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PiTerminalDriver', () => {
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
    expect(restoredOutput).toContain(TERMINAL_RECOVERY_SEQUENCE)

    const writeCount = output.writes.length
    driver.restore()
    expect(output.writes).toHaveLength(writeCount)
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
