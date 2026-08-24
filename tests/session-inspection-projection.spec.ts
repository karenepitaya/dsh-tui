import { describe, expect, it } from 'vitest'
import {
  SESSION_INSPECTION_REPLAY_BATCH,
  projectSessionInspection,
  type DurableDshEnvelope,
  type SessionInspectionSnapshot,
} from '../src/internal.ts'
import { durable, message } from './fixtures.ts'

function snapshot(
  events: readonly DurableDshEnvelope[],
): SessionInspectionSnapshot {
  return {
    header: {
      sessionId: 'inspected',
      createdAt: 1,
      isSubagent: false,
    },
    events,
  }
}

describe('session inspection projection', () => {
  it('replays a detached snapshot through the durable transcript reducer', async () => {
    const result = await projectSessionInspection(snapshot([
      durable(0, { type: 'turn/start', data: { turn: 1 } }, 'inspected'),
      durable(1, { type: 'step/start', data: { turn: 1, step: 1 } }, 'inspected'),
      durable(2, {
        type: 'user/message',
        data: {
          message: message('user', 'user', 'read-only history'),
          surfaceOp: 'append',
        },
      }, 'inspected'),
    ]), new AbortController().signal)

    expect(result.activeSessionId).toBe('inspected')
    expect(result.sessions.inspected?.rows).toMatchObject([{
      kind: 'user',
      seq: 2,
      message: { content: [{ type: 'text', text: 'read-only history' }] },
    }])
  })

  it('returns an empty selected projection and preserves pre-abort identity', async () => {
    const empty = await projectSessionInspection(snapshot([]), new AbortController().signal)
    expect(empty.activeSessionId).toBe('inspected')
    expect(empty.sessions.inspected?.rows).toEqual([])

    const abort = new AbortController()
    const reason = { kind: 'cancel-before-projection' }
    abort.abort(reason)
    await projectSessionInspection(snapshot([]), abort.signal).then(
      () => { throw new Error('expected projection to reject') },
      error => { expect(error).toBe(reason) },
    )
  })

  it('yields at the batch boundary and observes cancellation before publishing', async () => {
    const events = Array.from(
      { length: SESSION_INSPECTION_REPLAY_BATCH + 1 },
      (_, seq) => durable(seq, {
        type: 'turn/start',
        data: { turn: seq },
      }, 'inspected'),
    )
    const abort = new AbortController()
    const reason = new Error('cancel long replay')
    setImmediate(() => { abort.abort(reason) })

    await projectSessionInspection(snapshot(events), abort.signal).then(
      () => { throw new Error('expected projection to reject') },
      error => { expect(error).toBe(reason) },
    )
  })

  it('fails closed on cross-session events and required compatibility failures', async () => {
    await expect(projectSessionInspection(snapshot([
      durable(0, {
        type: 'user/message',
        data: {
          message: message('wrong-session', 'user', 'must not project'),
          surfaceOp: 'append',
        },
      }, 'wrong-session'),
    ]), new AbortController().signal)).rejects.toThrow(
      'Inspection event 0 session "wrong-session" does not match snapshot session "inspected"',
    )

    await expect(projectSessionInspection(snapshot([
      durable(0, {
        type: 'session/unsupported',
        data: { sourceType: 'plugin/required-new-contract' },
      }, 'inspected'),
      durable(1, { type: 'turn/start', data: { turn: 1 } }, 'inspected'),
    ]), new AbortController().signal)).rejects.toThrow(
      'UNSUPPORTED_REQUIRED_EVENT: required DSH session event "plugin/required-new-contract" is unsupported',
    )
  })
})
