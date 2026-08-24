import { describe, expect, it } from 'vitest'
import {
  TerminalInputDecoder,
  mapTerminalPacket,
  type TerminalInputPacket,
} from '../src/internal.ts'

function textOf(packets: readonly TerminalInputPacket[]): string {
  return packets
    .filter((packet): packet is Extract<TerminalInputPacket, { type: 'text' }> => packet.type === 'text')
    .map(packet => packet.text)
    .join('')
}

describe('byte-oriented terminal input decoder', () => {
  it('decodes UTF-8 identically across every chunk partition', () => {
    const bytes = Buffer.from('你🙂e\u0301')
    for (let split = 0; split <= bytes.length; split += 1) {
      const decoder = new TerminalInputDecoder()
      const packets = [
        ...decoder.push(bytes.subarray(0, split), 0),
        ...decoder.push(bytes.subarray(split), 1),
        ...decoder.end(),
      ]
      expect(textOf(packets)).toBe('你🙂e\u0301')
    }
  })

  it('flushes malformed UTF-8 before a control byte', () => {
    const decoder = new TerminalInputDecoder()
    expect(decoder.push(Uint8Array.of(0xe4), 0)).toEqual([])
    const packets = decoder.push(Uint8Array.of(0x03), 1)
    expect(packets).toEqual([
      { type: 'text', text: '�' },
      { type: 'control', byte: 0x03 },
    ])
    expect(mapTerminalPacket(packets[1]!)).toEqual({ type: 'interrupt' })
  })

  it('reassembles split CSI and expires only a lone ESC as Escape', () => {
    const csi = new TerminalInputDecoder()
    expect(csi.push(Uint8Array.of(0x1b), 0)).toEqual([])
    expect(csi.push(Buffer.from('['), 1)).toEqual([])
    const packets = csi.push(Buffer.from('D'), 2)
    expect(packets).toEqual([{ type: 'sequence', data: '\x1b[D' }])
    expect(mapTerminalPacket(packets[0]!)).toEqual({ type: 'move-left' })

    const escape = new TerminalInputDecoder({ escapeTimeoutMs: 30 })
    escape.push(Uint8Array.of(0x1b), 10)
    expect(escape.expire(39)).toEqual([])
    const expired = escape.expire(40)
    expect(expired).toEqual([{ type: 'escape' }])
    expect(mapTerminalPacket(expired[0]!)).toEqual({ type: 'escape' })
  })

  it('drops incomplete and oversized control sequences without leaking text', () => {
    const timed = new TerminalInputDecoder({ sequenceTimeoutMs: 20 })
    timed.push(Buffer.from('\x1b[12'), 0)
    expect(timed.expire(20)).toEqual([{ type: 'unknown', reason: 'timeout' }])
    expect(timed.push(Buffer.from('x'), 21)).toEqual([{ type: 'text', text: 'x' }])

    const bounded = new TerminalInputDecoder({ maxSequenceBytes: 4 })
    const tooLong = bounded.push(Buffer.from('\x1b[12345'), 0)
    expect(tooLong).toEqual([{ type: 'unknown', reason: 'too-long' }])
    expect(bounded.push(Buffer.from('~z'), 1)).toEqual([{ type: 'text', text: 'z' }])
  })

  it('keeps Ctrl+C literal inside paste and resumes controls after its end marker', () => {
    const decoder = new TerminalInputDecoder()
    expect(decoder.push(Buffer.from('\x1b[20'), 0)).toEqual([])
    expect(decoder.push(Buffer.from('0~你'), 1)).toEqual([])
    const packets = decoder.push(Buffer.concat([
      Uint8Array.of(0x03),
      Buffer.from('好\x1b[201~'),
      Uint8Array.of(0x03),
    ]), 2)
    expect(packets).toEqual([
      { type: 'paste', text: '你\x03好' },
      { type: 'control', byte: 0x03 },
    ])
    expect(mapTerminalPacket(packets[0]!)).toEqual({ type: 'insert', text: '你\x03好' })
    expect(mapTerminalPacket(packets[1]!)).toEqual({ type: 'interrupt' })
  })

  it('discards oversized and unterminated paste without reinterpreting its body', () => {
    const bounded = new TerminalInputDecoder({ maxPasteBytes: 3 })
    expect(bounded.push(Buffer.from('\x1b[200~abcd'), 0)).toEqual([])
    expect(bounded.push(Buffer.from('\x03\x1b[201~x'), 1)).toEqual([
      { type: 'paste-rejected', reason: 'too-large' },
      { type: 'text', text: 'x' },
    ])

    const unfinished = new TerminalInputDecoder()
    unfinished.push(Buffer.from('\x1b[200~pending'), 0)
    expect(unfinished.end()).toEqual([{ type: 'paste-rejected', reason: 'unterminated' }])
  })

  it('consumes OSC and ST-terminated control strings', () => {
    const decoder = new TerminalInputDecoder()
    expect(decoder.push(Buffer.from('\x1b]0;owned'), 0)).toEqual([])
    expect(decoder.push(Buffer.from('\x07x\x1bPignored'), 1)).toEqual([{ type: 'text', text: 'x' }])
    expect(decoder.push(Buffer.from('\x1b\\y'), 2)).toEqual([{ type: 'text', text: 'y' }])

    const timed = new TerminalInputDecoder({ sequenceTimeoutMs: 5 })
    timed.push(Buffer.from('\x1b]unfinished'), 0)
    expect(timed.expire(5)).toEqual([{ type: 'unknown', reason: 'timeout' }])
  })

  it('preserves Alt text packets and defines end/reset settlement', () => {
    const ascii = new TerminalInputDecoder()
    expect(ascii.push(Buffer.from('\x1ba'), 0)).toEqual([{ type: 'text', text: 'a', alt: true }])
    expect(mapTerminalPacket({ type: 'text', text: 'a', alt: true })).toEqual({ type: 'ignored' })

    const unicode = new TerminalInputDecoder()
    expect(unicode.push(Buffer.from('\x1b你'), 0)).toEqual([{ type: 'text', text: '你', alt: true }])

    const ground = new TerminalInputDecoder()
    ground.push(Uint8Array.of(0xf0), 0)
    expect(ground.end()).toEqual([{ type: 'text', text: '�' }])

    const escape = new TerminalInputDecoder()
    escape.push(Uint8Array.of(0x1b), 0)
    expect(escape.end()).toEqual([{ type: 'escape' }])

    const sequence = new TerminalInputDecoder()
    sequence.push(Buffer.from('\x1b['), 0)
    expect(sequence.end()).toEqual([{ type: 'unknown', reason: 'invalid' }])

    const reset = new TerminalInputDecoder()
    reset.push(Buffer.from('\x1b[12'), 0)
    reset.reset()
    expect(reset.push(Buffer.from('ok'), 1)).toEqual([{ type: 'text', text: 'ok' }])
    expect(mapTerminalPacket({ type: 'unknown', reason: 'invalid' })).toEqual({ type: 'ignored' })
    expect(mapTerminalPacket({ type: 'paste-rejected', reason: 'too-large' })).toEqual({ type: 'ignored' })
  })

  it('preserves controls while rejecting malformed escape and UTF-8 sequences', () => {
    const repeatedEscape = new TerminalInputDecoder()
    expect(repeatedEscape.push(Uint8Array.of(0x1b, 0x1b), 0)).toEqual([{ type: 'escape' }])
    expect(repeatedEscape.end()).toEqual([{ type: 'escape' }])

    const ss3 = new TerminalInputDecoder()
    expect(ss3.push(Buffer.from('\x1bOD'), 0)).toEqual([{ type: 'sequence', data: '\x1bOD' }])

    const escapedControl = new TerminalInputDecoder()
    expect(escapedControl.push(Uint8Array.of(0x1b, 0x03), 0)).toEqual([
      { type: 'unknown', reason: 'invalid' },
      { type: 'control', byte: 0x03 },
    ])

    const interruptedCsi = new TerminalInputDecoder()
    expect(interruptedCsi.push(Uint8Array.of(0x1b, 0x5b, 0x03), 0)).toEqual([
      { type: 'unknown', reason: 'invalid' },
      { type: 'control', byte: 0x03 },
    ])

    const invalidAltStart = new TerminalInputDecoder()
    expect(invalidAltStart.push(Uint8Array.of(0x1b, 0x80), 0)).toEqual([
      { type: 'unknown', reason: 'invalid' },
    ])

    const invalidAltContinuation = new TerminalInputDecoder()
    expect(invalidAltContinuation.push(Uint8Array.of(0x1b, 0xe4, 0x78), 0)).toEqual([
      { type: 'unknown', reason: 'invalid' },
      { type: 'text', text: 'x' },
    ])

    const invalidAltScalar = new TerminalInputDecoder()
    expect(invalidAltScalar.push(Uint8Array.of(0x1b, 0xe0, 0x80, 0x80), 0)).toEqual([
      { type: 'unknown', reason: 'invalid' },
    ])

    const validAlt = new TerminalInputDecoder()
    expect(validAlt.push(Buffer.from('\x1bé\x1b🙂'), 0)).toEqual([
      { type: 'text', text: 'é🙂', alt: true },
    ])
  })

  it('bounds every pending state and settles discard modes explicitly', () => {
    const clampedEscape = new TerminalInputDecoder({
      escapeTimeoutMs: 0,
      sequenceTimeoutMs: 0,
      maxSequenceBytes: 0,
      maxPasteBytes: 0,
    })
    expect(clampedEscape.push(Uint8Array.of(0x1b), 0)).toEqual([])
    expect(clampedEscape.expire(0)).toEqual([])
    expect(clampedEscape.expire(1)).toEqual([{ type: 'escape' }])

    const clampedSequence = new TerminalInputDecoder({ maxSequenceBytes: 0 })
    expect(clampedSequence.push(Buffer.from('\x1b[12'), 0)).toEqual([
      { type: 'unknown', reason: 'too-long' },
    ])
    expect(clampedSequence.push(Buffer.from('~x'), 1)).toEqual([{ type: 'text', text: 'x' }])

    const oversizedControl = new TerminalInputDecoder({ maxSequenceBytes: 4 })
    expect(oversizedControl.push(Buffer.from('\x1b]abcd\x07x'), 0)).toEqual([
      { type: 'unknown', reason: 'too-long' },
      { type: 'text', text: 'x' },
    ])

    const discardedPaste = new TerminalInputDecoder({ maxPasteBytes: 0 })
    expect(discardedPaste.push(Buffer.from('\x1b[200~ab'), 0)).toEqual([])
    expect(discardedPaste.end()).toEqual([{ type: 'paste-rejected', reason: 'too-large' }])

    const markerRestart = new TerminalInputDecoder()
    expect(markerRestart.push(Buffer.from('\x1b[200~a\x1b\x1b[201~'), 0)).toEqual([
      { type: 'paste', text: 'a\x1b' },
    ])

    expect(new TerminalInputDecoder().expire(Number.POSITIVE_INFINITY)).toEqual([])
    expect(mapTerminalPacket({ type: 'text', text: 'plain' })).toEqual({ type: 'insert', text: 'plain' })
  })

  it('expires incomplete SS3 and Alt sequences without leaking their bytes', () => {
    const ss3 = new TerminalInputDecoder({ sequenceTimeoutMs: 5 })
    ss3.push(Buffer.from('\x1bO'), 0)
    expect(ss3.expire(5)).toEqual([{ type: 'unknown', reason: 'timeout' }])

    const alt = new TerminalInputDecoder({ sequenceTimeoutMs: 5 })
    alt.push(Uint8Array.of(0x1b, 0xf0), 0)
    expect(alt.expire(5)).toEqual([{ type: 'unknown', reason: 'timeout' }])
  })
})
