import {
  CURSOR_MARKER,
  getKeybindings,
  KeybindingsManager,
  ProcessTerminal,
  setKeybindings,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type Terminal as PiTerminal,
} from '@earendil-works/pi-tui'
import type { TerminalViewport, UiFrame } from '../ui/frame.ts'
import { ConversationRoot } from '../ui/conversation.ts'
import {
  createDshTuiTheme,
  type DshTuiTheme,
} from '../ui/theme.ts'
import {
  TerminalInputDecoder,
  mapTerminalPacket,
  type TerminalInputDecoderOptions,
  type TerminalInputPacket,
} from './input-decoder.ts'
import type { TerminalInputAction } from './input.ts'
import { decodeTerminalInput } from './input.ts'

const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'
export const TERMINAL_RECOVERY_SEQUENCE =
  '\x1b[?2026l\x1b[0m\x1b[?2004l'
  + '\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l'
  + '\x1b[?7h\x1b[?1049l\x1b[?25h'
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
  readonly theme?: DshTuiTheme
}

interface ManagedPiTerminal extends PiTerminal {
  setCallbacks(callbacks: TerminalDriverCallbacks): void
  setProductInputThroughTui(enabled: boolean): void
  setBeforeResize(callback: (() => void) | undefined): void
  dispatchTuiInput(data: string): void
  handoff(callbacks: TerminalDriverCallbacks): void
  setQuiescing(): void
  assertInteractive(): void
  emergencyRestore(): void
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

function safePastedInput(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '�')
}

function stripSgrStyles(data: string): string {
  return data.replace(/\u001b\[[0-9;:]*m/gu, '')
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

  constructor(
    private readonly onInput: (data: string) => void,
    private readonly theme: DshTuiTheme,
    private readonly options: {
      readonly dimAll?: boolean
      readonly renderCursor?: boolean
    } = {},
  ) {}

  setFrame(frame: UiFrame): void {
    this.frame = frame
  }

  invalidate(): void {}

  handleInput(data: string): void {
    this.onInput(data)
  }

  render(width: number): string[] {
    const frame = this.frame
    if (frame === undefined) return []
    const boundedWidth = terminalDimension(width, 1)
    return frame.lines.map((source, row) => {
      const line = truncateToWidth(safeFrameLine(source), boundedWidth, '')
      const projected = this.options.renderCursor !== false && frame.cursor?.row === row
        ? insertCursor(line, frame.cursor.column, boundedWidth)
        : line
      const style = frame.lineStyles?.[row]
      if (style === undefined) {
        return this.options.dimAll === true ? this.theme.dim(projected) : projected
      }
      const filled = style.fill === true
        ? projected + ' '.repeat(Math.max(0, boundedWidth - visibleWidth(projected)))
        : projected
      const painted = this.theme.paint(style.tone, filled)
      const backed = style.background === undefined
        ? painted
        : this.theme.background(style.background, painted)
      const emphasized = style.bold === true ? this.theme.bold(backed) : backed
      const inverted = style.inverse === true ? this.theme.inverse(emphasized) : emphasized
      return style.dim === true || this.options.dimAll === true
        ? this.theme.dim(inverted)
        : inverted
    })
  }
}

function packetData(packet: TerminalInputPacket): string | undefined {
  switch (packet.type) {
    case 'text': return packet.alt === true ? '\x1b' + packet.text : packet.text
    case 'control': return String.fromCharCode(packet.byte)
    case 'sequence': return packet.data
    case 'escape': return '\x1b'
    case 'paste': return '\x1b[200~' + safePastedInput(packet.text) + '\x1b[201~'
    case 'paste-rejected':
    case 'unknown': return undefined
  }
}

/**
 * Production terminal owner. Pi's ProcessTerminal performs the keyboard
 * protocol negotiation that makes modified keys distinguishable on real
 * terminals, including Windows Terminal.
 */
export class DshProcessTerminal extends ProcessTerminal implements ManagedPiTerminal {
  private callbacks: TerminalDriverCallbacks | undefined
  private piInput: ((data: string) => void) | undefined
  private piResize: ResizeListener | undefined
  private beforeResize: (() => void) | undefined
  private started = false
  private quiescing = false
  private recoveryWritten = false

  constructor(private readonly styleEnabled = true) {
    super()
  }

  setCallbacks(callbacks: TerminalDriverCallbacks): void {
    this.callbacks = callbacks
  }

  setProductInputThroughTui(_enabled: boolean): void {}

  setBeforeResize(callback: (() => void) | undefined): void {
    this.beforeResize = callback
  }

  dispatchTuiInput(data: string): void {
    if (!this.started || this.quiescing) return
    const action = decodeTerminalInput(data)
    if (action.type !== 'ignored') this.callbacks?.onInput(action)
  }

  handoff(callbacks: TerminalDriverCallbacks): void {
    this.callbacks = callbacks
  }

  setQuiescing(): void {
    this.quiescing = true
  }

  assertInteractive(): void {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true
      || process.stdin.setRawMode === undefined) {
      throw new Error('DSH-TUI requires an interactive TTY with raw-mode input')
    }
  }

  override start(onInput: (data: string) => void, onResize: ResizeListener): void {
    if (this.started) throw new Error('terminal is already started')
    this.started = true
    this.piInput = onInput
    this.piResize = onResize
    try {
      super.start(this.handlePiInput, this.handlePiResize)
    } catch (error: unknown) {
      this.emergencyRestore()
      throw error
    }
  }

  override stop(): void {
    if (!this.started) return
    this.started = false
    this.piInput = undefined
    this.piResize = undefined
    super.stop()
  }

  override write(data: string): void {
    process.stdout.write(this.styleEnabled ? data : stripSgrStyles(data))
  }

  emergencyRestore(): void {
    this.stop()
    if (this.recoveryWritten) return
    this.recoveryWritten = true
    try {
      process.stdout.write(TERMINAL_RECOVERY_SEQUENCE)
    } catch {
      // Recovery is best-effort after a partially initialized terminal.
    }
  }

  private readonly handlePiInput = (data: string): void => {
    if (!this.started) return
    if (this.quiescing) {
      const action = decodeTerminalInput(data)
      if (action.type === 'interrupt') this.callbacks?.onInput(action)
      return
    }
    this.piInput?.(data)
  }

  private readonly handlePiResize = (): void => {
    if (!this.started) return
    this.beforeResize?.()
    this.callbacks?.onResize({ columns: this.columns, rows: this.rows })
    if (this.started) this.piResize?.()
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
  private productInputThroughTui = false
  private beforeResize: (() => void) | undefined

  constructor(
    private readonly input: TerminalByteInput,
    private readonly output: TerminalOutput,
    decoderOptions: TerminalInputDecoderOptions,
    private readonly styleEnabled = true,
  ) {
    this.decoder = new TerminalInputDecoder(decoderOptions)
    const escape = decoderTimeout(decoderOptions.escapeTimeoutMs, 30)
    const sequence = decoderTimeout(decoderOptions.sequenceTimeoutMs, 100)
    this.expiryDelays = [...new Set([escape, sequence])].sort((left, right) => left - right)
  }

  setCallbacks(callbacks: TerminalDriverCallbacks): void {
    this.callbacks = callbacks
  }

  setProductInputThroughTui(enabled: boolean): void {
    this.productInputThroughTui = enabled
  }

  setBeforeResize(callback: (() => void) | undefined): void {
    this.beforeResize = callback
  }

  dispatchTuiInput(data: string): void {
    if (!this.started || this.quiescing) return
    const action = decodeTerminalInput(data)
    if (action.type !== 'ignored') this.callbacks?.onInput(action)
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
    this.output.write(this.styleEnabled ? data : stripSgrStyles(data))
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
    this.beforeResize?.()
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
      if (!this.productInputThroughTui && action.type !== 'ignored') {
        this.callbacks?.onInput(action)
      }
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
  private readonly terminal: ManagedPiTerminal
  private readonly component: FrameComponent
  private readonly backdrop: FrameComponent
  private readonly conversation: ConversationRoot
  private readonly tui: TuiAltScreen
  private currentState: TerminalDriverState = 'idle'
  private lastTitle: string | undefined
  private previousKeybindings: KeybindingsManager | undefined
  private conversationKeybindings: KeybindingsManager | undefined
  private flatKeybindings: KeybindingsManager | undefined
  private fullscreenOverlay: OverlayHandle | undefined
  private secondaryOverlay: OverlayHandle | undefined
  private secondaryOverlaySignature: string | undefined
  private lastConversationFrame: UiFrame | undefined
  private surface: 'flat' | 'conversation' = 'flat'

  constructor(options: PiTerminalDriverOptions = {}) {
    const input = options.input ?? process.stdin as unknown as TerminalByteInput
    const output = options.output ?? process.stdout as unknown as TerminalOutput
    const theme = options.theme ?? createDshTuiTheme()
    const injectedIo = options.input !== undefined
      || options.output !== undefined
      || options.decoder !== undefined
    this.terminal = injectedIo
      ? new RawBytePiTerminal(
          input,
          output,
          options.decoder ?? {},
          theme.styleEnabled,
        )
      : new DshProcessTerminal(theme.styleEnabled)
    this.terminal.setProductInputThroughTui(true)
    this.component = new FrameComponent(
      data => this.terminal.dispatchTuiInput(data),
      theme,
    )
    this.backdrop = new FrameComponent(
      /* v8 ignore next -- the dim backdrop is never focusable; the overlay owns all input. */
      data => this.terminal.dispatchTuiInput(data),
      theme,
      { dimAll: true, renderCursor: false },
    )
    this.conversation = new ConversationRoot(
      theme,
      data => this.terminal.dispatchTuiInput(data),
    )
    this.terminal.setBeforeResize(() => this.conversation.captureBeforeResize())
    this.tui = new TuiAltScreen(
      this.terminal,
      true,
      options.logDirectory ?? process.cwd(),
      {
        mouse: true,
        searchMatchStyle: text => theme.underline(theme.paint('accent', text)),
        searchCurrentMatchStyle: text => theme.bold(theme.paint('accent', text)),
      },
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
    this.installKeybindings()
    try {
      this.tui.start()
      this.tui.setFocus(this.component)
      this.currentState = 'running'
    } catch (error: unknown) {
      this.currentState = 'restored'
      this.terminal.emergencyRestore()
      this.restoreKeybindings()
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
    const title = safeTitle(frame.title)
    if (title !== this.lastTitle) {
      this.terminal.setTitle(title)
      this.lastTitle = title
    }
    if (frame.conversation !== undefined) {
      this.activateKeybindings('conversation')
      this.conversation.setSurface(frame.conversation)
      this.lastConversationFrame = frame
      const closingOverlay = this.fullscreenOverlay !== undefined
        || this.secondaryOverlay !== undefined
      this.fullscreenOverlay?.hide()
      this.fullscreenOverlay = undefined
      this.secondaryOverlay?.hide()
      this.secondaryOverlay = undefined
      this.secondaryOverlaySignature = undefined
      if (this.surface !== 'conversation' || closingOverlay) {
        this.surface = 'conversation'
        this.tui.setLayoutRoot(this.conversation.component)
      }
      if (!this.tui.hasOverlay()) this.tui.setFocus(this.conversation.focusTarget)
      this.tui.renderNow()
      if (this.conversation.restoreAfterLayout()) this.tui.renderNow()
      return
    }
    this.activateKeybindings('flat')
    this.component.setFrame(frame)
    if (
      frame.overlay !== undefined
      && this.surface === 'conversation'
      && this.lastConversationFrame !== undefined
    ) {
      this.fullscreenOverlay?.hide()
      this.fullscreenOverlay = undefined
      this.backdrop.setFrame(this.lastConversationFrame)
      this.tui.setLayoutRoot(this.backdrop)
      const signature = JSON.stringify(frame.overlay)
      if (this.secondaryOverlay === undefined || signature !== this.secondaryOverlaySignature) {
        this.secondaryOverlay?.hide()
        this.secondaryOverlay = this.tui.showOverlay(this.component, {
          anchor: frame.overlay.anchor,
          width: frame.overlay.width,
          maxHeight: frame.overlay.maxHeight,
          margin: frame.overlay.margin,
        })
        this.secondaryOverlaySignature = signature
      } else {
        this.secondaryOverlay.focus()
      }
      this.tui.renderNow()
      return
    }
    this.secondaryOverlay?.hide()
    this.secondaryOverlay = undefined
    this.secondaryOverlaySignature = undefined
    if (this.surface === 'conversation') {
      this.conversation.deactivate()
      if (this.fullscreenOverlay === undefined) {
        // Pi routes mouse selection and scrollbar input through the base
        // layout before consulting overlay focus. Mount the flat frame below
        // the capturing overlay so hidden transcript state cannot be moved.
        this.tui.setLayoutRoot(this.component)
        this.fullscreenOverlay = this.tui.showOverlay(this.component, {
          anchor: 'top-left',
          width: '100%',
          maxHeight: '100%',
          margin: 0,
        })
      } else {
        this.fullscreenOverlay.focus()
      }
    } else {
      this.tui.setLayoutRoot(this.component)
      this.tui.setFocus(this.component)
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
      this.fullscreenOverlay?.hide()
      this.fullscreenOverlay = undefined
      this.secondaryOverlay?.hide()
      this.secondaryOverlay = undefined
      this.secondaryOverlaySignature = undefined
      this.lastConversationFrame = undefined
      this.conversation.dispose()
      this.tui.setLayoutRoot(undefined)
      this.terminal.emergencyRestore()
      this.restoreKeybindings()
    }
  }

  private installKeybindings(): void {
    const conversation = new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.altScreen.search': 'ctrl+f',
      'tui.altScreen.searchClose': ['escape', 'ctrl+c'],
      'tui.altScreen.top': 'ctrl+home',
      'tui.altScreen.bottom': 'ctrl+end',
    })
    const flat = new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.altScreen.pageUp': [],
      'tui.altScreen.pageDown': [],
      'tui.altScreen.halfPageUp': [],
      'tui.altScreen.halfPageDown': [],
      'tui.altScreen.lineUp': [],
      'tui.altScreen.lineDown': [],
      'tui.altScreen.previousPrompt': [],
      'tui.altScreen.nextPrompt': [],
      'tui.altScreen.search': [],
      'tui.altScreen.searchNext': [],
      'tui.altScreen.searchPrevious': [],
      'tui.altScreen.searchClose': [],
      'tui.altScreen.top': [],
      'tui.altScreen.bottom': [],
    })
    this.previousKeybindings = getKeybindings()
    this.conversationKeybindings = conversation
    this.flatKeybindings = flat
    setKeybindings(flat)
  }

  private activateKeybindings(surface: 'flat' | 'conversation'): void {
    const keybindings = surface === 'conversation'
      ? this.conversationKeybindings
      : this.flatKeybindings
    if (keybindings !== undefined && getKeybindings() !== keybindings) {
      setKeybindings(keybindings)
    }
  }

  private restoreKeybindings(): void {
    const conversation = this.conversationKeybindings
    const flat = this.flatKeybindings
    const previous = this.previousKeybindings
    this.conversationKeybindings = undefined
    this.flatKeybindings = undefined
    this.previousKeybindings = undefined
    const current = getKeybindings()
    if (
      previous !== undefined
      && (current === conversation || current === flat)
    ) {
      setKeybindings(previous)
    }
  }
}
