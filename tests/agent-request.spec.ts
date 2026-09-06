import { describe, expect, it } from 'vitest'
import {
  acceptAgentRequest,
  beginAgentRequest,
  isAgentRequestActive,
  reduceAgentRequestEvent,
  rejectAgentRequest,
  requestAgentCancellation,
  settleAgentRequestCancellation,
  settleAgentRequestFromTurnEnd,
  type AgentRequestLifecycleState,
} from '../src/presentation/agent-request.ts'
import { durable, message, runtime } from './fixtures.ts'

describe('agent request lifecycle projection', () => {
  it('keeps failure accounting per turn and ignores surface replacements', () => {
    expect(reduceAgentRequestEvent({ ...beginAgentRequest(undefined, 1), turn: 1 }, durable(0, {
      type: 'turn/start', data: { turn: 1 },
    }))!.toolFailures).toBe(0)
    const failed = reduceAgentRequestEvent(beginAgentRequest(undefined, 1), durable(1, {
      type: 'tool/result',
      data: {
        turn: 1, step: 1, callId: 'failed', isError: true,
        message: message('failed-result', 'user', 'unavailable', 'tool'), surfaceOp: 'append',
      },
    }))!
    expect(failed.toolFailures).toBe(1)
    const queued = beginAgentRequest(failed, 2)
    expect(queued.toolFailures).toBe(1)
    expect(reduceAgentRequestEvent(queued, durable(2, {
      type: 'turn/start', data: { turn: 1 },
    }))!.toolFailures).toBe(1)
    expect(settleAgentRequestFromTurnEnd(failed, { kind: 'completed' }).description)
      .toBe('Request complete · 1 tool failure')
    expect(settleAgentRequestFromTurnEnd(failed, { kind: 'error' }).description)
      .toBe('Request failed')
    const nextTurn = reduceAgentRequestEvent(queued, durable(3, {
      type: 'turn/start', data: { turn: 2 },
    }))!
    expect(nextTurn.toolFailures).toBe(0)
    expect(settleAgentRequestFromTurnEnd(nextTurn, { kind: 'completed' }).description)
      .toBe('Request complete')
    expect(reduceAgentRequestEvent(nextTurn, durable(4, {
      type: 'tool/result',
      data: {
        turn: 2, step: 1, callId: 'replacement', isError: true,
        message: message('replacement', 'user', 'context', 'tool'),
        surfaceOp: { op: 'replace', start: 0, end: 1 },
      },
    }))).toBe(nextTurn)
  })

  it('uses explicit tool outcomes and preserves two failures after another execution succeeds', () => {
    let state = reduceAgentRequestEvent(undefined, durable(0, {
      type: 'turn/start', data: { turn: 1 },
    }))!
    for (let step = 1; step <= 3; step += 1) {
      state = reduceAgentRequestEvent(state, durable(step * 2 - 1, {
        type: 'tool/call',
        data: { turn: 1, step, callId: `call-${step}`, name: 'read', arguments: '{}' },
      }))!
      const result = durable(step * 2, {
        type: 'tool/result',
        data: {
          turn: 1, step, callId: `call-${step}`, isError: step === 1,
          ...(step === 2 ? { error: { name: 'ToolError', code: 'FAILED' } } : {}),
          message: message(`result-${step}`, 'user', 'Error is a documented word', 'tool'),
          surfaceOp: 'append',
        },
      })
      state = reduceAgentRequestEvent(state, result)!
      expect(state.description).toBe(step < 3
        ? 'Tool failed'
        : 'Reviewing tool result')
      expect(reduceAgentRequestEvent(state, result)).toBe(state)
    }
    state = reduceAgentRequestEvent(state, durable(7, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
    }))!
    expect(state).toMatchObject({
      phase: 'succeeded', description: 'Request complete · 2 tool failures',
    })
  })

  it.each(['ABORTED', 'ABORTED_BEFORE_DISPATCH'])('distinguishes tool cancellation %s', code => {
    const started = reduceAgentRequestEvent(undefined, durable(0, {
      type: 'turn/start', data: { turn: 1 },
    }))!
    const cancelled = reduceAgentRequestEvent(started, durable(1, {
      type: 'tool/result',
      data: {
        turn: 1, step: 1, callId: 'cancelled', isError: true,
        error: { name: 'AbortError', code },
        message: message('cancelled-result', 'user', 'cancelled', 'tool'),
        surfaceOp: 'append',
      },
    }))!
    expect(cancelled.description).toBe('Tool cancelled')
    expect(reduceAgentRequestEvent(cancelled, durable(2, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } },
    }))).toMatchObject({ phase: 'cancelled', description: 'Request cancelled' })
  })

  it('bridges local submit through reasoning, retry, tools, response, and completion', () => {
    let state = beginAgentRequest(undefined, 1)
    expect(state).toMatchObject({ phase: 'submitted', description: 'Submitting prompt' })
    expect(isAgentRequestActive(state)).toBe(true)

    state = acceptAgentRequest(state, 1, 'input-1')!
    expect(state.phase).toBe('waiting')
    state = reduceAgentRequestEvent(state, durable(0, {
      type: 'turn/start',
      data: { turn: 1 },
    }))!
    expect(state.turn).toBe(1)
    state = reduceAgentRequestEvent(state, durable(1, {
      type: 'user/message',
      data: {
        message: message('input-1', 'user', 'hello'),
        surfaceOp: 'append',
      },
    }))!
    expect(state).toMatchObject({ phase: 'waiting', pendingInputs: [], accepted: true })

    state = reduceAgentRequestEvent(state, durable(2, {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: 'private trace' },
      },
    }))!
    expect(state).toMatchObject({
      phase: 'reasoning',
      description: 'Working through the request',
    })

    state = reduceAgentRequestEvent(state, durable(3, {
      type: 'llm/retry',
      data: {
        retryId: 'retry-1',
        turn: 1,
        step: 1,
        provider: 'test',
        mode: 'normal',
        policyKey: 'default',
        retry: 0,
        maxRetries: 2,
        delayMs: 10,
        failure: { message: 'temporary', code: 'TEMP' },
      },
    }))!
    expect(state.description).toBe('Retrying request · attempt 1')
    state = reduceAgentRequestEvent(state, durable(4, {
      type: 'llm/retry-started',
      data: { retryId: 'retry-1', turn: 1, step: 1, retry: 0 },
    }))!
    expect(state.description).toBe('Requesting again')

    state = reduceAgentRequestEvent(state, durable(5, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' },
    }), {
      for: 'call',
      view: { phase: 'call', card: 'generic', title: 'Reading package.json', kind: 'read' },
    })!
    expect(state).toMatchObject({ phase: 'tool', description: 'Reading package.json' })
    state = reduceAgentRequestEvent(state, durable(6, {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        callId: 'call-1',
        message: message('tool-1', 'user', 'large private result', 'tool'),
        surfaceOp: 'append',
      },
    }))!
    expect(state.description).toBe('Reviewing tool result')

    state = reduceAgentRequestEvent(state, durable(7, {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 2,
        chunk: { type: 'text-delta', index: 0, text: 'answer' },
      },
    }))!
    expect(state).toMatchObject({ phase: 'responding', description: 'Writing response' })
    state = reduceAgentRequestEvent(state, durable(8, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    }))!
    expect(state).toMatchObject({
      phase: 'succeeded', description: 'Request complete', turn: 1,
    })
    expect(isAgentRequestActive(state)).toBe(false)
  })

  it('settles an event-gap cancellation when runtime returns to idle', () => {
    let state = requestAgentCancellation(beginAgentRequest(undefined, 1))
    state = reduceAgentRequestEvent(state, runtime(0, {
      type: 'agent/status',
      data: { status: 'idle' },
    }))!
    expect(state).toMatchObject({ phase: 'cancelled', description: 'Request cancelled' })
  })

  it('drops an accepted queued input on cancellation without contaminating the next request', () => {
    let state = acceptAgentRequest(beginAgentRequest(undefined, 1), 1, 'input-1')!
    state = requestAgentCancellation(state)
    expect(state).toMatchObject({ pendingInputs: [], cancelRequested: true })
    state = reduceAgentRequestEvent(state, runtime(0, {
      type: 'agent/status',
      data: { status: 'idle' },
    }))!
    expect(state).toMatchObject({ phase: 'cancelled', pendingInputs: [], accepted: false })

    state = acceptAgentRequest(beginAgentRequest(state, 2), 2, 'input-2')!
    expect(state.turn).toBeUndefined()
    state = reduceAgentRequestEvent(state, durable(0, {
      type: 'user/message',
      data: {
        message: message('input-2', 'user', 'next request'),
        surfaceOp: 'append',
      },
    }))!
    state = reduceAgentRequestEvent(state, durable(1, {
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'completed' } },
    }))!
    expect(state).toMatchObject({
      phase: 'succeeded',
      turn: 2,
      pendingInputs: [],
      accepted: false,
      cancelRequested: false,
    })
  })

  it('does not reopen a completed request for standalone compaction messages', () => {
    let state = acceptAgentRequest(beginAgentRequest(undefined, 1), 1, 'input-1', true)!
    state = reduceAgentRequestEvent(state, durable(0, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    }))!
    expect(state.phase).toBe('succeeded')

    const completed = state
    state = reduceAgentRequestEvent(state, durable(1, {
      type: 'compaction/start',
      data: { compactionId: 'compact-1', sourceCommandId: 'command-1', turn: null },
    }))!
    state = reduceAgentRequestEvent(state, durable(2, {
      type: 'user/message',
      data: {
        message: message('checkpoint-1', 'user', 'compacted context', 'plugin'),
        surfaceOp: { op: 'replace', start: 0, end: 0 },
      },
    }))!
    state = reduceAgentRequestEvent(state, durable(3, {
      type: 'compaction/end',
      data: { compactionId: 'compact-1', sourceCommandId: 'command-1', turn: null },
    }))!
    state = reduceAgentRequestEvent(state, durable(4, {
      type: 'command/done',
      data: { commandId: 'command-1', kind: 'success', sourceEventSeq: 2 },
    }))!
    expect(state).toBe(completed)
    expect(isAgentRequestActive(state)).toBe(false)

    state = reduceAgentRequestEvent(state, durable(5, {
      type: 'turn/start',
      data: { turn: 2 },
    }))!
    expect(state).toMatchObject({ phase: 'waiting', description: 'Starting request' })
    expect(isAgentRequestActive(state)).toBe(true)
  })

  it('keeps queued ownership explicit across acceptance, rejection, and cancellation', () => {
    expect(isAgentRequestActive(undefined)).toBe(false)
    const completed = settleAgentRequestFromTurnEnd(
      beginAgentRequest(undefined, 1),
      { kind: 'completed' },
    )
    expect(isAgentRequestActive(completed)).toBe(false)

    let active = reduceAgentRequestEvent(beginAgentRequest(undefined, 2), durable(0, {
      type: 'turn/start',
      data: { turn: 7 },
    }))!
    active = acceptAgentRequest(active, 2, 'input-2')!
    const queued = beginAgentRequest(active, 3)
    expect(queued).toMatchObject({
      phase: 'submitted',
      accepted: true,
      turn: 7,
      pendingInputs: [{ ticket: 2, inputId: 'input-2' }, { ticket: 3 }],
    })

    const activeWithoutTurn = beginAgentRequest(beginAgentRequest(undefined, 4), 5)
    expect(activeWithoutTurn).not.toHaveProperty('turn')
    const restarted = beginAgentRequest(completed, 6)
    expect(restarted).toMatchObject({ accepted: false, pendingInputs: [{ ticket: 6 }] })
    expect(restarted).not.toHaveProperty('turn')

    expect(acceptAgentRequest(undefined, 1, 'missing')).toBeUndefined()
    expect(acceptAgentRequest(queued, 99, 'missing')).toBe(queued)
    expect(acceptAgentRequest(queued, 3, 'already-seen', true)).toMatchObject({
      pendingInputs: [{ ticket: 2, inputId: 'input-2' }],
    })
    expect(acceptAgentRequest(queued, 3, 'input-3')).toMatchObject({
      pendingInputs: [{ ticket: 2, inputId: 'input-2' }, { ticket: 3, inputId: 'input-3' }],
    })

    const locallyQueued = beginAgentRequest(beginAgentRequest(undefined, 10), 11)
    expect(rejectAgentRequest(locallyQueued, 10, false)).toMatchObject({
      phase: 'waiting',
      accepted: false,
      pendingInputs: [{ ticket: 11 }],
    })
    expect(rejectAgentRequest(queued, 3, false)).toMatchObject({
      phase: 'waiting',
      accepted: true,
      pendingInputs: [{ ticket: 2, inputId: 'input-2' }],
    })
    expect(rejectAgentRequest(undefined, 12, true)).toMatchObject({
      phase: 'waiting',
      accepted: true,
      pendingInputs: [],
    })
    expect(rejectAgentRequest(beginAgentRequest(undefined, 13), 13, false)).toMatchObject({
      phase: 'failed',
      description: 'Prompt was not sent',
      accepted: false,
    })

    const cancelling = requestAgentCancellation(activeWithoutTurn, false)
    expect(cancelling).toMatchObject({ accepted: false, cancelRequested: true })
    expect(settleAgentRequestCancellation(cancelling, 'Stopped by operator')).toMatchObject({
      phase: 'cancelled',
      description: 'Stopped by operator',
      accepted: false,
      cancelRequested: false,
    })
  })

  it('projects every runtime transition without reviving terminal state accidentally', () => {
    const disposed = runtime(0, { type: 'agent/disposed', data: {} })
    expect(reduceAgentRequestEvent(undefined, disposed)).toBeUndefined()

    const submitted = beginAgentRequest(undefined, 1)
    expect(reduceAgentRequestEvent(submitted, disposed)).toMatchObject({
      phase: 'failed',
      description: 'Agent stopped',
      accepted: false,
    })
    expect(reduceAgentRequestEvent(requestAgentCancellation(submitted), disposed)).toMatchObject({
      phase: 'cancelled',
      description: 'Agent stopped',
    })

    const idleCreated = runtime(1, { type: 'agent/created', data: { status: 'idle' } })
    expect(reduceAgentRequestEvent(undefined, idleCreated)).toBeUndefined()
    expect(reduceAgentRequestEvent(submitted, idleCreated)).toBe(submitted)

    const createdRunning = runtime(2, { type: 'agent/created', data: { status: 'running' } })
    expect(reduceAgentRequestEvent(undefined, createdRunning)).toMatchObject({
      phase: 'waiting',
      description: 'Starting request',
      accepted: true,
    })
    expect(reduceAgentRequestEvent(submitted, createdRunning)).toMatchObject({
      phase: 'submitted',
      accepted: true,
    })
    const terminal = settleAgentRequestFromTurnEnd(submitted, { kind: 'completed' })
    expect(reduceAgentRequestEvent(terminal, createdRunning)).toMatchObject({
      phase: 'waiting',
      description: 'Starting request',
      accepted: true,
    })

    const idle = runtime(3, { type: 'agent/status', data: { status: 'idle' } })
    expect(reduceAgentRequestEvent(undefined, idle)).toBeUndefined()
    expect(reduceAgentRequestEvent(terminal, idle)).toBe(terminal)
    expect(reduceAgentRequestEvent(submitted, idle)).toMatchObject({
      phase: 'failed',
      description: 'Request stopped',
      accepted: false,
    })
  })

  it('uses safe bounded Tool descriptions for every annotation shape', () => {
    const state = beginAgentRequest(undefined, 1)
    const call = (name: string) => durable(0, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name, arguments: '{}' },
    })

    expect(reduceAgentRequestEvent(state, call('  \r\n  '))).toMatchObject({
      phase: 'tool',
      description: 'Running tool',
    })
    expect(reduceAgentRequestEvent(state, call('fallback'), {
      for: 'call',
      view: null,
    })).toMatchObject({ description: 'fallback' })
    expect(reduceAgentRequestEvent(state, call('result annotation fallback'), {
      for: 'result',
      view: null,
    })).toMatchObject({ description: 'result annotation fallback' })
    expect(reduceAgentRequestEvent(state, call('ignored'), {
      for: 'call',
      view: {
        phase: 'call',
        card: 'generic',
        title: '  Read\r\npackage \u0001  ',
      },
    })).toMatchObject({ description: 'Read package �' })

    const longTitle = 'x'.repeat(97)
    expect(reduceAgentRequestEvent(state, call('ignored'), {
      for: 'call',
      view: { phase: 'call', card: 'generic', title: longTitle },
    })).toMatchObject({ description: `${'x'.repeat(95)}…` })
  })

  it('maps all durable terminal reasons to stable public status text', () => {
    const state = requestAgentCancellation(beginAgentRequest(undefined, 1), false)
    const cases: readonly [unknown, string, string][] = [
      [{ kind: 'completed' }, 'succeeded', 'Request complete'],
      [{ kind: 'interrupted' }, 'cancelled', 'Request cancelled'],
      [{ kind: 'aborted' }, 'cancelled', 'Request cancelled'],
      [{ kind: 'error' }, 'failed', 'Request failed'],
      [{ kind: 'blocked' }, 'failed', 'Request blocked'],
      [{ kind: 'max-tokens' }, 'failed', 'Response reached the token limit'],
      [null, 'failed', 'Request ended: unknown'],
      [{ kind: 42 }, 'failed', 'Request ended: unknown'],
      [{ kind: ' \r\n ' }, 'failed', 'Request ended: unknown'],
      [{ kind: 'z'.repeat(97) }, 'failed', `Request ended: ${'z'.repeat(95)}…`],
    ]
    for (const [reason, phase, description] of cases) {
      expect(settleAgentRequestFromTurnEnd(state, reason)).toMatchObject({
        phase,
        description,
        pendingInputs: [],
        accepted: false,
        cancelRequested: false,
      })
    }
  })

  it('covers durable step, message, Tool result, queue, and ignored-event semantics', () => {
    const active = acceptAgentRequest(beginAgentRequest(undefined, 1), 1, 'input-1')!
    expect(reduceAgentRequestEvent(undefined, durable(0, {
      type: 'session/observed',
      data: { sourceType: 'ignored', ignorable: true },
    }))).toBeUndefined()
    const terminal = settleAgentRequestFromTurnEnd(active, { kind: 'completed' })
    expect(reduceAgentRequestEvent(terminal, durable(1, {
      type: 'session/observed',
      data: { sourceType: 'ignored', ignorable: true },
    }))).toBe(terminal)

    const started = reduceAgentRequestEvent(terminal, durable(2, {
      type: 'turn/start',
      data: { turn: 9 },
    }))!
    expect(started).toMatchObject({ phase: 'waiting', turn: 9, accepted: true })
    expect(reduceAgentRequestEvent(started, durable(3, {
      type: 'turn/start',
      data: { turn: 10 },
    }))).toMatchObject({ turn: 10 })
    expect(reduceAgentRequestEvent(started, durable(4, {
      type: 'step/start',
      data: { turn: 9, step: 1 },
    }))).toMatchObject({ description: 'Preparing next step', turn: 9 })
    expect(reduceAgentRequestEvent(started, durable(5, {
      type: 'step/end',
      data: { turn: 9, step: 1 },
    }))).toMatchObject({ description: 'Preparing next step', turn: 9 })

    const replacedUser = durable(6, {
      type: 'user/message',
      data: {
        message: message('replacement', 'user', 'context'),
        surfaceOp: { op: 'replace', start: 0, end: 0 },
      },
    })
    expect(reduceAgentRequestEvent(started, replacedUser)).toBe(started)
    expect(reduceAgentRequestEvent(started, durable(7, {
      type: 'user/message',
      data: {
        message: message('plugin-input', 'user', 'context', 'plugin'),
        surfaceOp: 'append',
      },
    }))).toBe(started)

    const correlated: AgentRequestLifecycleState = {
      ...started,
      pendingInputs: [
        { ticket: 1 },
        { ticket: 2, inputId: 'other-input' },
        { ticket: 3, inputId: 'input-1' },
      ],
    }
    expect(reduceAgentRequestEvent(correlated, durable(8, {
      type: 'user/message',
      data: { message: message('input-1', 'user', 'hello'), surfaceOp: 'append' },
    }))).toMatchObject({
      description: 'Understanding request',
      pendingInputs: [{ ticket: 1 }, { ticket: 2, inputId: 'other-input' }],
    })

    const textChunk = durable(9, {
      type: 'assistant/chunk',
      data: { turn: 9, step: 1, chunk: { type: 'text-delta', index: 0, text: 'answer' } },
    })
    const responding = reduceAgentRequestEvent(started, textChunk)!
    expect(responding).toMatchObject({ phase: 'responding', description: 'Writing response' })
    expect(reduceAgentRequestEvent(started, durable(10, {
      type: 'assistant/chunk',
      data: { turn: 9, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'private' } },
    }))).toMatchObject({ phase: 'reasoning' })
    expect(reduceAgentRequestEvent(responding, durable(11, {
      type: 'assistant/chunk',
      data: { turn: 9, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'later' } },
    }))).toBe(responding)
    expect(reduceAgentRequestEvent(started, durable(12, {
      type: 'assistant/chunk',
      data: { turn: 9, step: 1, chunk: { type: 'unsupported', sourceType: 'block-end' } },
    }))).toBe(started)

    expect(reduceAgentRequestEvent(started, durable(13, {
      type: 'assistant/message',
      data: {
        turn: 9,
        step: 1,
        message: message('answer', 'assistant', 'final answer'),
        surfaceOp: 'append',
      },
    }))).toMatchObject({ phase: 'responding', description: 'Writing response' })
    expect(reduceAgentRequestEvent(started, durable(14, {
      type: 'assistant/message',
      data: {
        turn: 9,
        step: 1,
        message: {
          id: 'tool-message',
          role: 'assistant',
          sourceKind: 'model',
          content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
        },
        surfaceOp: 'append',
      },
    }))).toMatchObject({ phase: 'waiting', description: 'Preparing tool call' })
    expect(reduceAgentRequestEvent(started, durable(15, {
      type: 'assistant/message',
      data: {
        turn: 9,
        step: 1,
        message: {
          id: 'reasoning-only',
          role: 'assistant',
          sourceKind: 'model',
          content: [{ type: 'reasoning', text: 'private' }],
        },
        surfaceOp: 'append',
      },
    }))).toBe(started)

    expect(reduceAgentRequestEvent(started, durable(16, {
      type: 'tool/result',
      data: {
        turn: 9,
        step: 1,
        callId: 'call-1',
        message: message('tool-ok', 'user', 'ok', 'tool'),
        surfaceOp: 'append',
      },
    }))).toMatchObject({ description: 'Reviewing tool result' })
    expect(reduceAgentRequestEvent(started, durable(17, {
      type: 'tool/result',
      data: {
        turn: 9,
        step: 1,
        callId: 'call-1',
        message: message('tool-failed', 'user', 'failed', 'tool'),
        surfaceOp: 'append',
        error: { name: 'ToolError', code: 'FAILED' },
      },
    }))).toMatchObject({ description: 'Tool failed' })
    expect(reduceAgentRequestEvent(started, durable(18, {
      type: 'session/observed',
      data: { sourceType: 'ignored', ignorable: true },
    }))).toBe(started)

    expect(reduceAgentRequestEvent(requestAgentCancellation(started), durable(19, {
      type: 'turn/end',
      data: { turn: 9, reason: { kind: 'completed' } },
    }))).toMatchObject({ phase: 'cancelled', turn: 9 })
    const queued: AgentRequestLifecycleState = {
      ...started,
      turn: 9,
      pendingInputs: [{ ticket: 2, inputId: 'queued-input' }],
    }
    const waiting = reduceAgentRequestEvent(queued, durable(20, {
      type: 'turn/end',
      data: { turn: 9, reason: { kind: 'completed' } },
    }))!
    expect(waiting).toMatchObject({
      phase: 'waiting',
      description: 'Waiting for queued prompt',
      pendingInputs: [{ ticket: 2, inputId: 'queued-input' }],
    })
    expect(waiting).not.toHaveProperty('turn')
  })
})
