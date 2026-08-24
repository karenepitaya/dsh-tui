import { decodeTerminalInput, type TerminalInputAction } from './input.ts'

export type TerminalInputPacket =
  | { readonly type: 'text'; readonly text: string; readonly alt?: true }
  | { readonly type: 'control'; readonly byte: number }
  | { readonly type: 'sequence'; readonly data: string }
  | { readonly type: 'escape' }
  | { readonly type: 'paste'; readonly text: string }
  | { readonly type: 'paste-rejected'; readonly reason: 'too-large' | 'unterminated' }
  | { readonly type: 'unknown'; readonly reason: 'invalid' | 'timeout' | 'too-long' }

export interface TerminalInputDecoderOptions {
  readonly escapeTimeoutMs?: number
  readonly sequenceTimeoutMs?: number
  readonly maxSequenceBytes?: number
  readonly maxPasteBytes?: number
}

type DecoderMode =
  | 'ground'
  | 'escape'
  | 'csi'
  | 'ss3'
  | 'control-string'
  | 'alt-text'
  | 'paste'
  | 'paste-discard'

const ESC = 0x1b
const BEL = 0x07
const ST_FINAL = 0x5c
const PASTE_START = '\x1b[200~'
const PASTE_END_BYTES = Uint8Array.from(Buffer.from('\x1b[201~'))

function timeout(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback))
}

function limit(value: number | undefined, fallback: number, minimum: number): number {
  return Math.max(minimum, Math.floor(value ?? fallback))
}

function utf8Length(first: number): number {
  if (first >= 0xc2 && first <= 0xdf) return 2
  if (first >= 0xe0 && first <= 0xef) return 3
  if (first >= 0xf0 && first <= 0xf4) return 4
  return 0
}

export class TerminalInputDecoder {
  private readonly escapeTimeoutMs: number
  private readonly sequenceTimeoutMs: number
  private readonly maxSequenceBytes: number
  private readonly maxPasteBytes: number
  private mode: DecoderMode = 'ground'
  private textDecoder = new TextDecoder()
  private sequence: number[] = []
  private sequenceDiscarded = false
  private deadline = Number.POSITIVE_INFINITY
  private controlAllowsBel = false
  private controlSawEsc = false
  private altExpected = 0
  private pasteBytes: number[] = []
  private pasteMatch = 0

  constructor(options: TerminalInputDecoderOptions = {}) {
    this.escapeTimeoutMs = timeout(options.escapeTimeoutMs, 30)
    this.sequenceTimeoutMs = timeout(options.sequenceTimeoutMs, 100)
    this.maxSequenceBytes = limit(options.maxSequenceBytes, 256, 3)
    this.maxPasteBytes = limit(options.maxPasteBytes, 4 * 1024 * 1024, 1)
  }

  push(chunk: Uint8Array, nowMs: number): readonly TerminalInputPacket[] {
    const packets = [...this.expire(nowMs)]
    for (const byte of chunk) this.consume(byte, nowMs, packets)
    return packets
  }

  expire(nowMs: number): readonly TerminalInputPacket[] {
    if (nowMs < this.deadline) return []
    if (this.mode === 'escape') {
      this.toGround()
      return [{ type: 'escape' }]
    }
    if (this.mode === 'csi' || this.mode === 'ss3'
      || this.mode === 'control-string' || this.mode === 'alt-text') {
      this.toGround()
      return [{ type: 'unknown', reason: 'timeout' }]
    }
    return []
  }

  end(): readonly TerminalInputPacket[] {
    const packets: TerminalInputPacket[] = []
    if (this.mode === 'ground') {
      this.flushText(packets)
    } else if (this.mode === 'escape') {
      packets.push({ type: 'escape' })
    } else if (this.mode === 'paste') {
      packets.push({ type: 'paste-rejected', reason: 'unterminated' })
    } else if (this.mode === 'paste-discard') {
      packets.push({ type: 'paste-rejected', reason: 'too-large' })
    } else {
      packets.push({ type: 'unknown', reason: 'invalid' })
    }
    this.reset()
    return packets
  }

  reset(): void {
    this.mode = 'ground'
    this.textDecoder = new TextDecoder()
    this.sequence = []
    this.sequenceDiscarded = false
    this.deadline = Number.POSITIVE_INFINITY
    this.controlAllowsBel = false
    this.controlSawEsc = false
    this.altExpected = 0
    this.pasteBytes = []
    this.pasteMatch = 0
  }

  private consume(byte: number, nowMs: number, packets: TerminalInputPacket[]): void {
    switch (this.mode) {
      case 'ground': return this.consumeGround(byte, nowMs, packets)
      case 'escape': return this.consumeEscape(byte, nowMs, packets)
      case 'csi': return this.consumeSequence(byte, nowMs, packets, 'csi')
      case 'ss3': return this.consumeSequence(byte, nowMs, packets, 'ss3')
      case 'control-string': return this.consumeControlString(byte, nowMs, packets)
      case 'alt-text': return this.consumeAltText(byte, nowMs, packets)
      case 'paste': return this.consumePaste(byte, packets)
      case 'paste-discard': return this.consumePasteDiscard(byte, packets)
    }
  }

  private consumeGround(byte: number, nowMs: number, packets: TerminalInputPacket[]): void {
    if (byte === ESC) {
      this.flushText(packets)
      this.mode = 'escape'
      this.sequence = [ESC]
      this.deadline = nowMs + this.escapeTimeoutMs
      return
    }
    if (byte <= 0x1f || byte === 0x7f) {
      this.flushText(packets)
      packets.push({ type: 'control', byte })
      return
    }
    this.emitText(packets, this.textDecoder.decode(Uint8Array.of(byte), { stream: true }))
  }

  private consumeEscape(byte: number, nowMs: number, packets: TerminalInputPacket[]): void {
    if (byte === ESC) {
      packets.push({ type: 'escape' })
      this.deadline = nowMs + this.escapeTimeoutMs
      return
    }
    if (byte === 0x5b || byte === 0x4f) {
      this.mode = byte === 0x5b ? 'csi' : 'ss3'
      this.sequence.push(byte)
      this.deadline = nowMs + this.sequenceTimeoutMs
      return
    }
    if (byte === 0x5d || byte === 0x50 || byte === 0x5f || byte === 0x5e || byte === 0x58) {
      this.mode = 'control-string'
      this.controlAllowsBel = byte === 0x5d
      this.controlSawEsc = false
      this.sequence.push(byte)
      this.deadline = nowMs + this.sequenceTimeoutMs
      return
    }
    if (byte <= 0x1f || byte === 0x7f) {
      packets.push({ type: 'unknown', reason: 'invalid' })
      this.toGround()
      this.consumeGround(byte, nowMs, packets)
      return
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      this.emitText(packets, String.fromCharCode(byte), true)
      this.toGround()
      return
    }
    const expected = utf8Length(byte)
    if (expected === 0) {
      packets.push({ type: 'unknown', reason: 'invalid' })
      this.toGround()
      return
    }
    this.mode = 'alt-text'
    this.sequence = [byte]
    this.altExpected = expected
    this.deadline = nowMs + this.sequenceTimeoutMs
  }

  private consumeSequence(
    byte: number,
    nowMs: number,
    packets: TerminalInputPacket[],
    kind: 'csi' | 'ss3',
  ): void {
    this.deadline = nowMs + this.sequenceTimeoutMs

    if (this.sequenceDiscarded) {
      if (byte >= 0x40 && byte <= 0x7e) this.toGround()
      return
    }

    this.sequence.push(byte)
    if (this.sequence.length > this.maxSequenceBytes) {
      packets.push({ type: 'unknown', reason: 'too-long' })
      this.sequence = []
      this.sequenceDiscarded = true
      return
    }

    if (byte >= 0x40 && byte <= 0x7e) {
      const data = Buffer.from(this.sequence).toString('ascii')
      if (kind === 'csi' && data === PASTE_START) {
        this.mode = 'paste'
        this.sequence = []
        this.deadline = Number.POSITIVE_INFINITY
        this.pasteBytes = []
        this.pasteMatch = 0
        return
      }
      packets.push({ type: 'sequence', data })
      this.toGround()
      return
    }

    if (byte < 0x20 || byte > 0x3f) {
      packets.push({ type: 'unknown', reason: 'invalid' })
      this.toGround()
      this.consumeGround(byte, nowMs, packets)
    }
  }

  private consumeControlString(
    byte: number,
    nowMs: number,
    packets: TerminalInputPacket[],
  ): void {
    this.deadline = nowMs + this.sequenceTimeoutMs
    const terminatedByBel = this.controlAllowsBel && byte === BEL
    const terminatedBySt = this.controlSawEsc && byte === ST_FINAL
    if (terminatedByBel || terminatedBySt) {
      this.toGround()
      return
    }

    this.controlSawEsc = byte === ESC
    if (this.sequenceDiscarded) return

    this.sequence.push(byte)
    if (this.sequence.length > this.maxSequenceBytes) {
      packets.push({ type: 'unknown', reason: 'too-long' })
      this.sequence = []
      this.sequenceDiscarded = true
    }
  }

  private consumeAltText(byte: number, nowMs: number, packets: TerminalInputPacket[]): void {
    if (byte < 0x80 || byte > 0xbf) {
      packets.push({ type: 'unknown', reason: 'invalid' })
      this.toGround()
      this.consumeGround(byte, nowMs, packets)
      return
    }

    this.sequence.push(byte)
    this.deadline = nowMs + this.sequenceTimeoutMs
    if (this.sequence.length < this.altExpected) return

    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(this.sequence))
      this.emitText(packets, text, true)
    } catch {
      packets.push({ type: 'unknown', reason: 'invalid' })
    }
    this.toGround()
  }

  private consumePaste(byte: number, packets: TerminalInputPacket[]): void {
    this.pasteBytes.push(byte)
    this.updatePasteMatch(byte)
    if (this.pasteMatch === PASTE_END_BYTES.length) {
      this.pasteBytes.splice(-PASTE_END_BYTES.length)
      packets.push({
        type: 'paste',
        text: new TextDecoder().decode(Uint8Array.from(this.pasteBytes)),
      })
      this.toGround()
      return
    }

    const confirmedBytes = this.pasteBytes.length - this.pasteMatch
    if (confirmedBytes > this.maxPasteBytes) {
      this.mode = 'paste-discard'
      this.pasteBytes = []
    }
  }

  private consumePasteDiscard(byte: number, packets: TerminalInputPacket[]): void {
    this.updatePasteMatch(byte)
    if (this.pasteMatch === PASTE_END_BYTES.length) {
      packets.push({ type: 'paste-rejected', reason: 'too-large' })
      this.toGround()
    }
  }

  private updatePasteMatch(byte: number): void {
    if (byte === PASTE_END_BYTES[this.pasteMatch]) {
      this.pasteMatch += 1
      return
    }
    this.pasteMatch = byte === PASTE_END_BYTES[0] ? 1 : 0
  }

  private flushText(packets: TerminalInputPacket[]): void {
    this.emitText(packets, this.textDecoder.decode())
    this.textDecoder = new TextDecoder()
  }

  private emitText(packets: TerminalInputPacket[], text: string, alt?: true): void {
    if (text === '') return
    const last = packets.at(-1)
    if (last?.type === 'text' && last.alt === alt) {
      packets[packets.length - 1] = alt
        ? { type: 'text', text: last.text + text, alt: true }
        : { type: 'text', text: last.text + text }
      return
    }
    packets.push(alt ? { type: 'text', text, alt: true } : { type: 'text', text })
  }

  private toGround(): void {
    this.mode = 'ground'
    this.sequence = []
    this.sequenceDiscarded = false
    this.deadline = Number.POSITIVE_INFINITY
    this.controlAllowsBel = false
    this.controlSawEsc = false
    this.altExpected = 0
    this.pasteBytes = []
    this.pasteMatch = 0
  }
}

export function mapTerminalPacket(packet: TerminalInputPacket): TerminalInputAction {
  switch (packet.type) {
    case 'text':
      return packet.alt ? { type: 'ignored' } : { type: 'insert', text: packet.text }
    case 'control':
      return decodeTerminalInput(String.fromCharCode(packet.byte))
    case 'sequence':
      return decodeTerminalInput(packet.data)
    case 'escape':
      return { type: 'escape' }
    case 'paste':
      return { type: 'insert', text: packet.text }
    case 'paste-rejected':
    case 'unknown':
      return { type: 'ignored' }
  }
}
