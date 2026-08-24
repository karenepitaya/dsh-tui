import {
  CURSOR_MARKER,
  TuiAltScreen,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Terminal as PiTerminal,
} from '@earendil-works/pi-tui'
import type { TerminalViewport, UiFrame } from '../ui/frame.ts'
import {
  TerminalInputDecoder,
  mapTerminalPacket,
  type TerminalInputDecoderOptions,
  type TerminalInputPacket,
} from './input-decoder.ts'
import type { TerminalInputAction } from './input.ts'

const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'
export const TERMINAL_RECOVERY_SEQUENCE =
  '\x1b[?2026l\x1b[0m\x1b[?2004l\x1b[?7h\x1b[?1049l\x1b[?25h'
const PROGRESS_ACTIVE = '\x1b]9;4;3\x07'
const PROGRESS_CLEAR = '\x1b]9;4;0\x07'

export type TerminalDriverState = 'idle' | 'running' | 'quiescing' | 'restored'

export interface TerminalDriverCallbacks {
  readonly onInput: (action: TerminalInputAction) => void
  readonly onResize: (viewport: TerminalViewport) => void
}

export interface TerminalDriver {
  readonly state: TerminalDriverState
  readonly viewport: TerminalViewport
  start(callbacks: TerminalDriverCallbacks): void
  handoff(callbacks: TerminalDriverCallbacks): void
  render(frame: UiFrame): void
  stopAcceptingInput(): void
  restore(): void
}

type RawDataListener = (chunk: Uint8Array | string) => void
type ResizeListener = () => void

export interface TerminalByteInput {
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  setRawMode?(enabled: boolean): unknown
  resume(): unknown
  pause(): unknown
  on(event: 'data', listener: RawDataListener): unknown
  removeListener(event: 'data', listener: RawDataListener): unknown
}

export interface TerminalOutput {
  readonly isTTY?: boolean
  readonly columns?: number
  readonly rows?: number
  write(data: string): unknown
  on(event: 'resize', listener: ResizeListener): unknown
  removeListener(event: 'resize', listener: ResizeListener): unknown
}

export interface PiTerminalDriverOptions {
  readonly input?: TerminalByteInput
  readonly output?: TerminalOutput
  readonly decoder?: TerminalInputDecoderOptions
  readonly logDirectory?: string
}

function terminalDimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined
    ? Math.max(1, Math.floor(value))
    : fallback
}

function decoderTimeout(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback))
}

function safeTitle(title: string): string {
  return stripTerminalSequences(title)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
}

function safeFrameLine(line: string): string {
  return stripTerminalSequences(line)
    .replace(/[\r\n]/gu, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, '�')
}

function insertCursor(line: string, column: number, width: number): string {
  const clamped = Math.max(0, Math.min(width - 1, Math.floor(column)))
  const lineWidth = visibleWidth(line)
  if (clamped >= lineWidth) {
    return line + ' '.repeat(clamped - lineWidth) + CURSOR_MARKER
  }
  const left = sliceByColumn(line, 0, clamped, true)
  const right = sliceByColumn(line, clamped, Math.max(0, width - clamped), true)
  return left + CURSOR_MARKER + right
}

class FrameComponent implements Component {
  private frame: UiFrame | undefined

  setFrame(frame: UiFrame): void {
    this.frame = frame
  }

  invalidate(): void {}

  render(width: number): string[] {
    const frame = this.frame
    if (frame === undefined) return []
    const boundedWidth = terminalDimension(width, 1)
    return frame.lines.map((source, row) => {
      const line = truncateToWidth(safeFrameLine(source), boundedWidth, '')
      return frame.cursor?.row === row
        ? insertCursor(line, frame.cursor.column, boundedWidth)
        : line
    })
  }
}

function packetData(packet: TerminalInputPacket): string | undefined {
  switch (packet.type) {
    case 'text': return packet.alt === true ? '\x1b' + packet.text : packet.text
    case 'control': return String.fromCharCode(packet.byte)
    case 'sequence': return packet.data
    case 'escape': return '\x1b'
    case 'paste': return '\x1b[200~' + packet.text + '\x1b[201~'
    case 'paste-rejected':
    case 'unknown': return undefined
  }
}

export class RawBytePiTerminal implements PiTerminal {
  private readonly decoder: TerminalInputDecoder
  private readonly expiryDelays: readonly number[]
  private piInput: ((data: string) => void) | undefined
  private piResize: ResizeListener | undefined
  private callbacks: TerminalDriverCallbacks | undefined
  private wasRaw = false
  private started = false
  private quiescing = false
  private recoveryWritten = false
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private expiryIndex = 0

  constructor(
    private readonly input: TerminalByteInput,
    private readonly output: TerminalOutput,
    decoderOptions: TerminalInputDecoderOptions,
  ) {
    this.decoder = new TerminalInputDecoder(decoderOptions)
    const escape = decoderTimeout(decoderOptions.escapeTimeoutMs, 30)
    const sequence = decoderTimeout(decoderOptions.sequenceTimeoutMs, 100)
    this.expiryDelays = [...new Set([escape, sequence])].sort((left, right) => left - right)
  }

  setCallbacks(callbacks: TerminalDriverCallbacks): void {
    this.callbacks = callbacks
  }

  handoff(callbacks: TerminalDriverCallbacks): void {
    this.clearExpiry()
    this.decoder.reset()
    this.callbacks = callbacks
  }

  setQuiescing(): void {
    this.quiescing = true
    this.clearExpiry()
    this.decoder.reset()
  }

  assertInteractive(): void {
    if (this.input.isTTY !== true || this.output.isTTY !== true
      || this.input.setRawMode === undefined) {
      throw new Error('DSH-TUI requires an interactive TTY with raw-mode input')
    }
  }

  start(onInput: (data: string) => void, onResize: ResizeListener): void {
    if (this.started) throw new Error('terminal is already started')
    this.wasRaw = this.input.isRaw === true
    this.started = true
    this.piInput = onInput
    this.piResize = onResize
    this.decoder.reset()
    try {
      this.input.setRawMode!(true)
      this.output.write(ENABLE_BRACKETED_PASTE)
      this.output.on('resize', this.handleResize)
      this.input.on('data', this.handleData)
      this.input.resume()
    } catch (error: unknown) {
      this.emergencyRestore()
      throw error
    }
  }

  stop(): void {
    this.stopIo()
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.output.write(data)
  }

  get columns(): number {
    return terminalDimension(this.output.columns, 80)
  }

  get rows(): number {
    return terminalDimension(this.output.rows, 24)
  }

  get kittyProtocolActive(): boolean {
    return false
  }

  moveBy(lines: number): void {
    if (lines > 0) this.write(`\x1b[${lines}B`)
    if (lines < 0) this.write(`\x1b[${-lines}A`)
  }

  hideCursor(): void {
    this.write('\x1b[?25l')
  }

  showCursor(): void {
    this.write('\x1b[?25h')
  }

  clearLine(): void {
    this.write('\x1b[K')
  }

  clearFromCursor(): void {
    this.write('\x1b[J')
  }

  clearScreen(): void {
    this.write('\x1b[2J\x1b[H')
  }

  setTitle(title: string): void {
    this.write('\x1b]0;' + safeTitle(title) + '\x07')
  }

  setProgress(active: boolean): void {
    this.write(active ? PROGRESS_ACTIVE : PROGRESS_CLEAR)
  }

  emergencyRestore(): void {
    this.stopIo()
    if (this.recoveryWritten) return
    this.recoveryWritten = true
    this.tryOperation(() => this.output.write(TERMINAL_RECOVERY_SEQUENCE))
  }

  private readonly handleData: RawDataListener = (chunk): void => {
    if (!this.started) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    if (this.quiescing) {
      for (const byte of bytes) {
        if (byte === 0x03) this.callbacks?.onInput({ type: 'interrupt' })
      }
      return
    }
    this.dispatch(this.decoder.push(bytes, Date.now()))
    if (!this.quiescing) this.scheduleExpiry()
  }

  private readonly handleResize: ResizeListener = (): void => {
    if (!this.started) return
    this.callbacks?.onResize({ columns: this.columns, rows: this.rows })
    if (this.started) this.piResize?.()
  }

  private dispatch(packets: readonly TerminalInputPacket[]): void {
    for (const packet of packets) {
      const action = mapTerminalPacket(packet)
      if (this.quiescing) {
        if (action.type === 'interrupt') this.callbacks?.onInput(action)
        continue
      }
      const data = packetData(packet)
      if (data !== undefined) this.piInput?.(data)
      if (action.type !== 'ignored') this.callbacks?.onInput(action)
    }
  }

  private scheduleExpiry(): void {
    this.clearExpiry()
    this.expiryIndex = 0
    this.scheduleNextExpiry(0)
  }

  private scheduleNextExpiry(previousDelay: number): void {
    const deadline = this.expiryDelays[this.expiryIndex]
    if (deadline === undefined || !this.started) return
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined
      const packets = this.decoder.expire(Date.now())
      this.dispatch(packets)
      if (packets.length === 0) {
        this.expiryIndex += 1
        this.scheduleNextExpiry(deadline)
      }
    }, Math.max(1, deadline - previousDelay))
    this.expiryTimer.unref?.()
  }

  private clearExpiry(): void {
    if (this.expiryTimer === undefined) return
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
  }

  private stopIo(): void {
    if (!this.started) return
    this.started = false
    this.clearExpiry()
    this.decoder.reset()
    this.tryOperation(() => this.input.removeListener('data', this.handleData))
    this.tryOperation(() => this.output.removeListener('resize', this.handleResize))
    this.piInput = undefined
    this.piResize = undefined
    this.tryOperation(() => this.output.write(DISABLE_BRACKETED_PASTE))
    this.tryOperation(() => this.input.pause())
    this.tryOperation(() => this.input.setRawMode?.(this.wasRaw))
  }

  private tryOperation(operation: () => unknown): void {
    try {
      operation()
    } catch {
      // Terminal recovery is deliberately best-effort and continues each step.
    }
  }
}

export class PiTerminalDriver implements TerminalDriver {
  private readonly terminal: RawBytePiTerminal
  private readonly component = new FrameComponent()
  private readonly tui: TuiAltScreen
  private currentState: TerminalDriverState = 'idle'
  private lastTitle: string | undefined

  constructor(options: PiTerminalDriverOptions = {}) {
    const input = options.input ?? process.stdin as unknown as TerminalByteInput
    const output = options.output ?? process.stdout as unknown as TerminalOutput
    this.terminal = new RawBytePiTerminal(input, output, options.decoder ?? {})
    this.tui = new TuiAltScreen(
      this.terminal,
      true,
      options.logDirectory ?? process.cwd(),
      { mouse: false },
    )
    this.tui.setLayoutRoot(this.component)
  }

  get state(): TerminalDriverState {
    return this.currentState
  }

  get viewport(): TerminalViewport {
    return { columns: this.terminal.columns, rows: this.terminal.rows }
  }

  start(callbacks: TerminalDriverCallbacks): void {
    if (this.currentState !== 'idle') throw new Error('terminal driver cannot be restarted')
    this.terminal.assertInteractive()
    this.terminal.setCallbacks(callbacks)
    try {
      this.tui.start()
      this.currentState = 'running'
    } catch (error: unknown) {
      this.currentState = 'restored'
      this.terminal.emergencyRestore()
      throw error
    }
  }

  handoff(callbacks: TerminalDriverCallbacks): void {
    if (this.currentState !== 'running') throw new Error('terminal driver can only hand off while running')
    this.terminal.handoff(callbacks)
  }

  render(frame: UiFrame): void {
    if (this.currentState !== 'running' && this.currentState !== 'quiescing') {
      throw new Error('terminal driver is not running')
    }
    this.component.setFrame(frame)
    const title = safeTitle(frame.title)
    if (title !== this.lastTitle) {
      this.terminal.setTitle(title)
      this.lastTitle = title
    }
    this.tui.renderNow()
  }

  stopAcceptingInput(): void {
    if (this.currentState !== 'running') return
    this.currentState = 'quiescing'
    this.terminal.setQuiescing()
  }

  restore(): void {
    if (this.currentState === 'restored') return
    if (this.currentState === 'idle') {
      this.currentState = 'restored'
      return
    }
    this.currentState = 'restored'
    try {
      this.tui.stop({ preserveScreen: true })
    } catch {
      // The unconditional recovery sequence below covers partial Pi teardown.
    } finally {
      this.terminal.emergencyRestore()
    }
  }
}
