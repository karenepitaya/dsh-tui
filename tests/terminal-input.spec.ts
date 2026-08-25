import { describe, expect, it } from 'vitest'
import { decodeTerminalInput } from '../src/terminal/input.ts'

describe('terminal input decoding', () => {
  it('maps text and complete bracketed paste to editor insertions', () => {
    expect(decodeTerminalInput('你')).toEqual({ type: 'insert', text: '你' })
    expect(decodeTerminalInput('\x1b[200~a\r\nb\x1b[201~')).toEqual({
      type: 'insert',
      text: 'a\r\nb',
    })
  })

  it.each([
    ['\r', { type: 'submit' }],
    ['\x1b[13;2u', { type: 'newline' }],
    ['\x03', { type: 'interrupt' }],
    ['\x13', { type: 'save-default' }],
    ['\x14', { type: 'toggle-reasoning' }],
    ['\x7f', { type: 'backspace' }],
    ['\x1b[3~', { type: 'delete' }],
    ['\x1b[D', { type: 'move-left' }],
    ['\x1b[C', { type: 'move-right' }],
    ['\x1b[A', { type: 'move-up' }],
    ['\x1b[B', { type: 'move-down' }],
    ['\t', { type: 'complete' }],
    ['\x1b[H', { type: 'move-home' }],
    ['\x1b[F', { type: 'move-end' }],
    ['\x1b', { type: 'escape' }],
  ] as const)('maps %j to %j', (data, expected) => {
    expect(decodeTerminalInput(data)).toEqual(expected)
  })

  it('ignores empty, control, and unknown escape input', () => {
    expect(decodeTerminalInput('')).toEqual({ type: 'ignored' })
    expect(decodeTerminalInput('\x1b[200~unfinished')).toEqual({ type: 'ignored' })
    expect(decodeTerminalInput('\x00')).toEqual({ type: 'ignored' })
    expect(decodeTerminalInput('\x1b[999~')).toEqual({ type: 'ignored' })
  })
})
