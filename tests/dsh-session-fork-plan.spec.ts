import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  planDshSessionFork,
} from '../src/dsh/session-fork-plan.ts'

function event(seq: number, type: string): SessionEvent {
  const data = type === 'turn/start'
    ? { turn: 1 }
    : type === 'turn/end'
      ? { turn: 1, reason: { kind: 'completed' } }
      : { value: type }
  return { seq, time: seq + 1, type, data } as SessionEvent
}

describe('planDshSessionFork', () => {
  it('forks the last completed turn and keeps trailing between-turn events', () => {
    const events = [
      event(0, 'turn/start'),
      event(1, 'user/message'),
      event(2, 'turn/end'),
      event(3, 'session/title'),
      event(4, 'turn/start'),
      event(5, 'user/message'),
    ]

    const plan = planDshSessionFork('source', events)

    expect(plan.boundarySeq).toBe(2)
    expect(plan.seed.map(item => item.seq)).toEqual([0, 1, 2, 3])
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.seed)).toBe(true)
  })

  it('maps an in-turn anchor forward to that turn end', () => {
    const events = [
      event(0, 'turn/start'),
      event(1, 'user/message'),
      event(2, 'turn/end'),
      { ...event(3, 'turn/start'), data: { turn: 2 } } as SessionEvent,
      event(4, 'user/message'),
      { ...event(5, 'turn/end'), data: { turn: 2, reason: { kind: 'completed' } } } as SessionEvent,
    ]

    expect(planDshSessionFork('source', events, 4).seed.map(item => item.seq))
      .toEqual([0, 1, 2, 3, 4, 5])
  })

  it('uses the last completed turn for a past-end anchor', () => {
    const events = [
      event(0, 'turn/start'),
      event(1, 'turn/end'),
      event(2, 'session/title'),
    ]

    expect(planDshSessionFork('source', events, 99)).toMatchObject({
      boundarySeq: 1,
      seed: events,
    })
  })

  it('rejects an anchor inside a turn that has not completed', () => {
    const events = [
      event(0, 'turn/start'),
      event(1, 'user/message'),
    ]

    expect(() => planDshSessionFork('source', events, 1)).toThrowError(
      expect.objectContaining({
        code: 'turn-open',
        sourceSessionId: 'source',
      }),
    )
  })

  it('rejects a source with no completed turn and malformed anchors', () => {
    expect(() => planDshSessionFork('empty', [])).toThrowError(
      expect.objectContaining({
        code: 'no-completed-turn',
      }),
    )
    for (const atSeq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => planDshSessionFork('source', [event(0, 'turn/end')], atSeq))
        .toThrowError(expect.objectContaining({
          code: 'invalid-anchor',
        }))
    }
  })
})
