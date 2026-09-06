import { describe, expect, it } from 'vitest'
import {
  SessionRuntimeMemory,
  type SessionRuntimeMemoryKey,
  type SessionRuntimeSnapshot,
} from '../src/session/runtime-memory.ts'

function key(
  sessionId: string,
  bindingEpoch: number,
): SessionRuntimeMemoryKey {
  return { sessionId, bindingEpoch }
}

function snapshot(
  text: string,
  transcriptViewMode: 'compact' | 'verbose' = 'compact',
): SessionRuntimeSnapshot {
  return {
    draft: { text, cursor: Array.from(text).length },
    attachments: [{
      name: `${text}.png`,
      mediaType: 'image/png',
      bytes: 3,
      data: new Uint8Array([1, 2, 3]),
    }],
    scrollAnchor: {
      nodeKey: `assistant:${text}`,
      intraVisualLine: 2,
      ordinal: 4,
    },
    transcriptViewMode,
  }
}

describe('SessionRuntimeMemory', () => {
  it('saves and restores the complete state for one exact binding', () => {
    const memory = new SessionRuntimeMemory()
    const binding = key('session-a', 7)
    const state = snapshot('draft', 'verbose')

    memory.save(binding, state)

    expect(memory.size).toBe(1)
    expect(memory.restore(binding)).toEqual(state)
  })

  it('isolates sessions and binding epochs while replacing only an exact key', () => {
    const memory = new SessionRuntimeMemory()
    const firstEpoch = key('shared', 1)
    const secondEpoch = key('shared', 2)
    const delimiterSession = key('shared:1', 2)

    memory.save(firstEpoch, snapshot('first'))
    memory.save(secondEpoch, snapshot('second'))
    memory.save(delimiterSession, snapshot('delimiter'))
    memory.save(firstEpoch, snapshot('replacement', 'verbose'))

    expect(memory.size).toBe(3)
    expect(memory.restore(firstEpoch)?.draft.text).toBe('replacement')
    expect(memory.restore(firstEpoch)?.transcriptViewMode).toBe('verbose')
    expect(memory.restore(secondEpoch)?.draft.text).toBe('second')
    expect(memory.restore(delimiterSession)?.draft.text).toBe('delimiter')
    expect(memory.restore(key('shared', 3))).toBeUndefined()
    expect(memory.restore(key('missing', 1))).toBeUndefined()
  })

  it('copies mutable attachment bytes and snapshot containers at both boundaries', () => {
    const memory = new SessionRuntimeMemory()
    const binding = key('copy-boundary', 1)
    const state = snapshot('original')
    const sourceBytes = state.attachments[0]!.data

    memory.save(binding, state)
    sourceBytes[0] = 9

    const restored = memory.restore(binding)!
    restored.attachments[0]!.data[1] = 8

    expect(restored.attachments[0]!.data).toEqual(new Uint8Array([1, 8, 3]))
    expect(memory.restore(binding)?.attachments[0]!.data)
      .toEqual(new Uint8Array([1, 2, 3]))
    expect(restored).not.toBe(state)
    expect(restored.draft).not.toBe(state.draft)
    expect(restored.attachments).not.toBe(state.attachments)
    expect(restored.attachments[0]).not.toBe(state.attachments[0])
    expect(restored.scrollAnchor).not.toBe(state.scrollAnchor)
    expect(Object.isFrozen(restored)).toBe(true)
    expect(Object.isFrozen(restored.draft)).toBe(true)
    expect(Object.isFrozen(restored.attachments)).toBe(true)
    expect(Object.isFrozen(restored.attachments[0])).toBe(true)
    expect(Object.isFrozen(restored.scrollAnchor)).toBe(true)
  })

  it('supports a missing scroll anchor without inventing one', () => {
    const memory = new SessionRuntimeMemory()
    const binding = key('following-tail', 1)
    const state: SessionRuntimeSnapshot = {
      ...snapshot('tail'),
      scrollAnchor: undefined,
    }

    memory.save(binding, state)

    expect(memory.restore(binding)?.scrollAnchor).toBeUndefined()
  })

  it('releases one binding, one session, or the whole application explicitly', () => {
    const memory = new SessionRuntimeMemory()
    const first = key('session-a', 1)
    const second = key('session-a', 2)
    const other = key('session-b', 1)
    const transient = key('transient', 1)
    memory.save(first, snapshot('first'))
    memory.save(second, snapshot('second'))
    memory.save(other, snapshot('other'))
    memory.save(transient, snapshot('transient'))

    expect(memory.delete(first)).toBe(true)
    expect(memory.delete(first)).toBe(false)
    expect(memory.delete(key('missing', 1))).toBe(false)
    expect(memory.delete(transient)).toBe(true)
    expect(memory.size).toBe(2)
    expect(memory.clearSession('session-a')).toBe(1)
    expect(memory.clearSession('session-a')).toBe(0)
    expect(memory.restore(second)).toBeUndefined()
    expect(memory.restore(other)?.draft.text).toBe('other')

    memory.clear()
    expect(memory.size).toBe(0)
    expect(memory.restore(other)).toBeUndefined()
    memory.clear()
    expect(memory.size).toBe(0)
  })

  it('does not share or persist state between application instances', () => {
    const firstApplication = new SessionRuntimeMemory()
    const secondApplication = new SessionRuntimeMemory()
    const binding = key('same-session', 1)
    firstApplication.save(binding, snapshot('first application'))

    expect(secondApplication.size).toBe(0)
    expect(secondApplication.restore(binding)).toBeUndefined()
  })
})
