import { describe, expect, it } from 'vitest'
import {
  createUiState,
  reduceUiEvent,
  replayUiEvents,
  selectSession,
  setUiPhase,
  type DurableDshEnvelope,
  type SessionUiState,
  type UiState,
} from '../src/internal.ts'
import { durable, message, runtime } from './fixtures.ts'
import { applyToolPresentation } from '../src/transcript/reducer.ts'

function apply(events: readonly DurableDshEnvelope[], sessionId = 'session-a'): UiState {
  let state = selectSession(createUiState(), sessionId)
  for (const event of events) state = reduceUiEvent(state, event)
  return state
}

function session(state: UiState, sessionId = 'session-a'): SessionUiState {
  const value = state.sessions[sessionId]
  if (value === undefined) throw new Error(`missing session ${sessionId}`)
  return value
}

function conversation(): DurableDshEnvelope[] {
  return [
    durable(0, { type: 'turn/start', data: { turn: 1 } }),
    durable(1, { type: 'step/start', data: { turn: 1, step: 1 } }),
    durable(2, {
      type: 'user/message',
      data: { message: message('u1', 'user', 'hello'), surfaceOp: 'append' },
    }),
    durable(3, {
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } },
    }),
    durable(4, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: message('a1', 'assistant', 'hi'),
        surfaceOp: 'append',
        usage: { inputTokens: 2, outputTokens: 1 },
      },
    }),
    durable(5, { type: 'step/end', data: { turn: 1, step: 1 } }),
    durable(6, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
  ]
}

describe('transcript reducer convergence', () => {
  it('ignores an unmatched retry-started event without fabricating history', () => {
    const projected = session(apply([
      durable(0, {
        type: 'llm/retry-started',
        data: { retryId: 'missing', turn: 1, step: 1, retry: 1 },
      }),
    ]))

    expect(projected.llmAttempts).toBeUndefined()
  })

  it('folds retry recovery from durable events and discards failed partial output', () => {
    const events = [
      durable(0, { type: 'turn/start', data: { turn: 1 } }),
      durable(1, { type: 'step/start', data: { turn: 1, step: 1 } }),
      durable(2, {
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'discarded first attempt' },
        },
      }),
      durable(3, {
        type: 'llm/retry',
        data: {
          retryId: 'retry-a',
          turn: 1,
          step: 1,
          provider: 'deepseek-official',
          mode: 'normal',
          policyKey: 'normal-policy',
          retry: 1,
          maxRetries: 5,
          delayMs: 500,
          failure: { message: 'server unavailable', code: 'SERVER', status: 503 },
        },
      }),
      durable(4, {
        type: 'llm/retry-started',
        data: { retryId: 'retry-a', turn: 1, step: 1, retry: 1 },
      }),
      durable(5, {
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'discarded second attempt' },
        },
      }),
      durable(6, {
        type: 'llm/retry',
        data: {
          retryId: 'retry-a',
          turn: 1,
          step: 1,
          provider: 'deepseek-official',
          mode: 'normal',
          policyKey: 'normal-policy',
          retry: 2,
          maxRetries: 5,
          delayMs: 1_000,
          failure: {
            message: 'provider busy',
            code: 'RATE_LIMIT',
            providerRetryAfterMs: 1_000,
          },
        },
      }),
      durable(7, {
        type: 'llm/retry-started',
        data: { retryId: 'retry-a', turn: 1, step: 1, retry: 2 },
      }),
      durable(8, {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: message('assistant-recovered', 'assistant', 'recovered response'),
          surfaceOp: 'append',
        },
      }),
      durable(9, { type: 'step/end', data: { turn: 1, step: 1 } }),
      durable(10, {
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ] satisfies DurableDshEnvelope[]

    const projected = session(apply(events))
    expect(projected.rows).toHaveLength(1)
    expect(projected.rows[0]).toMatchObject({
      kind: 'assistant',
      message: { content: [{ type: 'text', text: 'recovered response' }] },
    })
    expect(JSON.stringify(projected.rows)).not.toContain('discarded')
    expect(projected.llmAttempts).toMatchObject({
      chains: [{
        retryId: 'retry-a',
        turn: 1,
        step: 1,
        phase: 'recovered',
        provider: 'deepseek-official',
        mode: 'normal',
        maxRetries: 5,
        finalSeq: 8,
        attempts: [
          {
            retry: 1,
            scheduledSeq: 3,
            startedSeq: 4,
            delayMs: 500,
            failure: { code: 'SERVER', status: 503 },
          },
          {
            retry: 2,
            scheduledSeq: 6,
            startedSeq: 7,
            delayMs: 1_000,
            failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 1_000 },
          },
        ],
      }],
    })
    expect(projected.llmAttempts?.activeRetryId).toBeUndefined()
    expect(session(replayUiEvents('session-a', events))).toEqual(projected)
  })

  it('separates provider-policy chains and settles a cancelled backoff without inventing a start', () => {
    const projected = session(apply([
      durable(0, { type: 'turn/start', data: { turn: 4 } }),
      durable(1, { type: 'step/start', data: { turn: 4, step: 2 } }),
      durable(2, {
        type: 'llm/retry',
        data: {
          retryId: 'retry-route-a',
          turn: 4,
          step: 2,
          provider: 'route-a',
          mode: 'normal',
          policyKey: 'route-a-policy',
          retry: 1,
          maxRetries: 2,
          delayMs: 10,
          failure: { message: 'route a failed', code: 'TRANSPORT' },
        },
      }),
      durable(3, {
        type: 'llm/retry-started',
        data: { retryId: 'retry-route-a', turn: 4, step: 2, retry: 1 },
      }),
      durable(4, {
        type: 'llm/retry',
        data: {
          retryId: 'retry-route-b',
          turn: 4,
          step: 2,
          provider: 'route-b',
          mode: 'always',
          policyKey: 'route-b-policy',
          retry: 1,
          delayMs: 20,
          failure: { message: 'route b failed', code: 'AUTH' },
        },
      }),
      durable(5, { type: 'step/end', data: { turn: 4, step: 2 } }),
      durable(6, {
        type: 'turn/end',
        data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } },
      }),
    ]))

    expect(projected.llmAttempts?.chains).toMatchObject([
      {
        retryId: 'retry-route-a',
        provider: 'route-a',
        phase: 'rerouted',
        finalSeq: 4,
      },
      {
        retryId: 'retry-route-b',
        provider: 'route-b',
        mode: 'always',
        phase: 'cancelled',
        finalSeq: 6,
        attempts: [{ retry: 1, scheduledSeq: 4 }],
      },
    ])
    expect(projected.llmAttempts?.chains[1]?.attempts[0]).not.toHaveProperty('startedSeq')
    expect(projected.llmAttempts?.activeRetryId).toBeUndefined()
  })

  it('marks a started retry chain failed when the official turn ends in error', () => {
    const projected = session(apply([
      durable(0, { type: 'turn/start', data: { turn: 1 } }),
      durable(1, { type: 'step/start', data: { turn: 1, step: 1 } }),
      durable(2, {
        type: 'llm/retry',
        data: {
          retryId: 'retry-failed',
          turn: 1,
          step: 1,
          provider: 'mock',
          mode: 'normal',
          policyKey: 'normal',
          retry: 1,
          maxRetries: 1,
          delayMs: 5,
          failure: { message: 'first failure', code: 'SERVER' },
        },
      }),
      durable(3, {
        type: 'llm/retry-started',
        data: { retryId: 'retry-failed', turn: 1, step: 1, retry: 1 },
      }),
      durable(4, { type: 'step/end', data: { turn: 1, step: 1 } }),
      durable(5, {
        type: 'turn/end',
        data: {
          turn: 1,
          reason: { kind: 'error', error: { message: 'second failure', code: 'SERVER' } },
        },
      }),
    ]))

    expect(projected.llmAttempts?.chains[0]).toMatchObject({
      retryId: 'retry-failed',
      phase: 'failed',
      finalSeq: 5,
    })
  })

  it('tracks the official compaction lifecycle and correlates its summary to /compact', () => {
    const state = apply([
      durable(0, {
        type: 'command/run',
        data: {
          commandId: 'command-compact',
          name: 'compact',
          source: { kind: 'user' },
        },
      }),
      durable(1, {
        type: 'compaction/start',
        data: {
          compactionId: 'compaction-1',
          sourceCommandId: 'command-compact',
          turn: null,
        },
      }),
      durable(2, {
        type: 'compaction/summary',
        data: {
          compactionId: 'compaction-1',
          sourceCommandId: 'command-compact',
          shadowedRange: { start: 4, end: 9 },
          shadowedSeqs: [4, 5, 7, 9],
          shadowedTokenCount: 12_400,
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
        },
      }),
      durable(3, {
        type: 'compaction/end',
        data: {
          compactionId: 'compaction-1',
          sourceCommandId: 'command-compact',
          turn: null,
        },
      }),
      durable(4, {
        type: 'command/done',
        data: {
          commandId: 'command-compact',
          kind: 'success',
          text: 'Compacted 4 history items (~12400 tokens).',
          sourceEventSeq: 2,
        },
      }),
    ])

    expect(session(state).compaction).toEqual({
      compactionId: 'compaction-1',
      sourceCommandId: 'command-compact',
      phase: 'completed',
      startSeq: 1,
      summarySeq: 2,
      endSeq: 3,
      shadowedItemCount: 4,
      shadowedTokenCount: 12_400,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    })
    expect(session(state).rows[0]).toMatchObject({
      kind: 'command',
      commandId: 'command-compact',
      status: 'success',
      compaction: {
        compactionId: 'compaction-1',
        shadowedItemCount: 4,
        shadowedTokenCount: 12_400,
      },
    })
  })

  it('keeps compaction state coherent across optional, unmatched, and failed lifecycle events', () => {
    const noCommandStart = apply([
      durable(0, {
        type: 'compaction/start',
        data: { compactionId: 'compaction-no-command', turn: 2 },
      }),
    ])
    expect(session(noCommandStart).compaction).toEqual({
      compactionId: 'compaction-no-command',
      phase: 'running',
      startSeq: 0,
    })

    const unmatchedSummary = reduceUiEvent(noCommandStart, durable(1, {
      type: 'compaction/summary',
      data: {
        compactionId: 'compaction-unmatched',
        shadowedRange: { start: 0, end: 2 },
        shadowedSeqs: [0, 2],
        shadowedTokenCount: 40,
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
      },
    }))
    expect(session(unmatchedSummary).compaction).toMatchObject({
      compactionId: 'compaction-unmatched',
      phase: 'running',
      startSeq: 1,
      summarySeq: 1,
    })

    const missingCommandRow = reduceUiEvent(unmatchedSummary, durable(2, {
      type: 'compaction/summary',
      data: {
        compactionId: 'compaction-unmatched',
        sourceCommandId: 'command-missing',
        shadowedRange: { start: 0, end: 3 },
        shadowedSeqs: [0, 2, 3],
        shadowedTokenCount: 60,
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
      },
    }))
    expect(session(missingCommandRow).rows).toEqual([])

    const failed = reduceUiEvent(missingCommandRow, durable(3, {
      type: 'compaction/end',
      data: {
        compactionId: 'compaction-failed-before-start',
        turn: null,
        error: 'provider unavailable',
      },
    }))
    expect(session(failed).compaction).toEqual({
      compactionId: 'compaction-failed-before-start',
      phase: 'failed',
      startSeq: 3,
      endSeq: 3,
      error: 'provider unavailable',
    })

    const inheritedCommand = apply([
      durable(0, {
        type: 'compaction/start',
        data: {
          compactionId: 'compaction-inherited-command',
          sourceCommandId: 'command-inherited',
          turn: null,
        },
      }),
      durable(1, {
        type: 'compaction/summary',
        data: {
          compactionId: 'compaction-inherited-command',
          shadowedRange: { start: 0, end: 1 },
          shadowedSeqs: [0, 1],
          shadowedTokenCount: 20,
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
        },
      }),
      durable(2, {
        type: 'compaction/end',
        data: { compactionId: 'compaction-inherited-command', turn: null },
      }),
    ])
    expect(session(inheritedCommand).compaction).toMatchObject({
      sourceCommandId: 'command-inherited',
      phase: 'completed',
      startSeq: 0,
      summarySeq: 1,
      endSeq: 2,
    })
  })

  it('converges for every replay/live split and ignores overlap duplicates', () => {
    const events = conversation()
    const expected = replayUiEvents('session-a', events)

    for (let split = 0; split <= events.length; split += 1) {
      let actual = selectSession(createUiState(), 'session-a')
      for (const event of events.slice(0, split)) actual = reduceUiEvent(actual, event)
      for (const event of events) actual = reduceUiEvent(actual, event)
      expect(session(actual)).toEqual(session(expected))
    }

    expect(session(expected).rows.map(row => row.kind)).toEqual(['user', 'assistant'])
    expect(session(expected).journal).toHaveLength(events.length)
    expect(session(expected).openTurn).toBeUndefined()
    expect(session(expected).openStep).toBeUndefined()
    expect(session(expected).lastTurnEnd).toEqual({
      turn: 1,
      reason: { kind: 'completed' },
    })
  })

  it('buffers a durable gap and drains it when missing events arrive', () => {
    const events = conversation().slice(0, 3)
    let state = selectSession(createUiState(), 'session-a')
    state = reduceUiEvent(state, events[2]!)
    expect(session(state).journal).toHaveLength(0)
    expect(Object.keys(session(state).pendingBySeq)).toEqual(['2'])

    const buffered = state
    state = reduceUiEvent(state, events[2]!)
    expect(session(state)).toBe(session(buffered))

    state = reduceUiEvent(state, events[0]!)
    expect(session(state).journal).toHaveLength(1)
    state = reduceUiEvent(state, events[1]!)
    expect(session(state).journal.map(event => event.seq)).toEqual([0, 1, 2])
    expect(session(state).rows).toHaveLength(1)
    expect(session(state).pendingBySeq).toEqual({})
  })

  it('keeps plugin-authored runtime context out of the human conversation', () => {
    const state = apply([
      durable(0, {
        type: 'user/message',
        data: {
          message: message(
            'runtime-context',
            'user',
            'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
            'plugin',
          ),
          surfaceOp: 'append',
        },
      }),
      durable(1, {
        type: 'user/message',
        data: {
          message: message('human', 'user', 'hello', 'user'),
          surfaceOp: 'append',
        },
      }),
    ])

    expect(session(state).journal).toHaveLength(2)
    expect(session(state).rows).toHaveLength(1)
    expect(session(state).rows[0]).toMatchObject({
      kind: 'user',
      message: { id: 'human', sourceKind: 'user' },
    })
  })

  it('fails loudly for conflicting applied and buffered duplicates', () => {
    const first = durable(0, { type: 'turn/start', data: { turn: 1 } })
    const conflict = durable(0, { type: 'turn/start', data: { turn: 2 } })
    let state = apply([first])
    state = reduceUiEvent(state, conflict)
    expect(session(state).compatibilityError?.code).toBe('CONFLICTING_DUPLICATE')
    expect(session(state).journal[0]).toEqual(first)

    let buffered = selectSession(createUiState(), 'session-a')
    buffered = reduceUiEvent(buffered, durable(2, {
      type: 'turn/start',
      data: { turn: 1 },
    }))
    buffered = reduceUiEvent(buffered, durable(2, {
      type: 'turn/start',
      data: { turn: 2 },
    }))
    expect(session(buffered).compatibilityError?.code).toBe('CONFLICTING_DUPLICATE')
  })

  it('records invalid sequences and required unknown events as compatibility errors', () => {
    let state = selectSession(createUiState(), 'session-a')
    state = reduceUiEvent(state, durable(-1, {
      type: 'session/observed',
      data: { sourceType: 'bad-seq', ignorable: true },
    }))
    expect(session(state).compatibilityError).toMatchObject({ code: 'INVALID_SEQUENCE' })

    const unsupported = apply([
      durable(0, {
        type: 'session/unsupported',
        data: { sourceType: 'plugin/required-new-contract' },
      }),
      durable(1, { type: 'turn/start', data: { turn: 1 } }),
    ])
    expect(session(unsupported).compatibilityError).toMatchObject({
      code: 'UNSUPPORTED_REQUIRED_EVENT',
    })
    expect(session(unsupported).journal).toHaveLength(1)
    expect(session(unsupported).pendingBySeq).toEqual({})
  })
})

describe('transcript projection rules', () => {
  it('keeps presenter annotations outside durable duplicate comparison', () => {
    const call = durable(0, {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'presentation-call',
        name: 'read',
        arguments: '{"path":"a.ts"}',
      },
    })
    let state = selectSession(createUiState(), 'session-a')
    state = reduceUiEvent(state, call)
    state = applyToolPresentation(state, call, {
      for: 'call',
      view: {
        phase: 'call',
        card: 'generic',
        title: 'Read a.ts',
        kind: 'read',
      },
    })
    expect(session(state).rows[0]).toMatchObject({
      callPresentation: { title: 'Read a.ts' },
    })

    state = reduceUiEvent(state, call)
    state = applyToolPresentation(state, call, { for: 'call', view: null })
    expect(session(state).journal).toEqual([call])
    expect(session(state).compatibilityError).toBeUndefined()
    expect(session(state).rows[0]).not.toHaveProperty('callPresentation')
  })

  it('preserves paired call presentation and applies or clears result presentation', () => {
    const call = durable(0, {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'presented-result',
        name: 'read',
        arguments: '{"path":"a.ts"}',
      },
    })
    const result = durable(1, {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        callId: 'presented-result',
        message: message('result-1', 'user', 'done', 'tool'),
        surfaceOp: 'append',
      },
    })
    let state = apply([call])
    state = applyToolPresentation(state, call, {
      for: 'call',
      view: {
        phase: 'call',
        card: 'generic',
        title: 'Read a.ts',
      },
    })
    state = reduceUiEvent(state, result)
    expect(session(state).rows[0]).toMatchObject({
      callPresentation: { title: 'Read a.ts' },
    })

    state = applyToolPresentation(state, result, {
      for: 'result',
      view: {
        phase: 'result',
        card: 'generic',
        title: 'Read complete',
      },
    })
    expect(session(state).rows[0]).toMatchObject({
      resultPresentation: { title: 'Read complete' },
    })

    state = applyToolPresentation(state, result, { for: 'result', view: null })
    expect(session(state).rows[0]).not.toHaveProperty('resultPresentation')
  })

  it('ignores annotations that cannot match an existing durable Tool row', () => {
    const call = durable(0, {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'missing-presentation-row',
        name: 'read',
        arguments: '{}',
      },
    })
    const result = durable(1, {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        callId: 'missing-presentation-row',
        message: message('missing-result', 'user', 'done', 'tool'),
        surfaceOp: 'append',
      },
    })
    const callAnnotation = { for: 'call' as const, view: null }
    const empty = createUiState()

    expect(applyToolPresentation(empty, call, undefined)).toBe(empty)
    expect(applyToolPresentation(empty, runtime(0, {
      type: 'agent/created',
      data: { status: 'idle' },
    }), callAnnotation)).toBe(empty)
    expect(applyToolPresentation(empty, durable(0, {
      type: 'turn/start',
      data: { turn: 1 },
    }), callAnnotation)).toBe(empty)
    expect(applyToolPresentation(empty, call, callAnnotation)).toBe(empty)

    const selected = selectSession(empty, 'session-a')
    expect(applyToolPresentation(selected, call, callAnnotation)).toBe(selected)
    expect(applyToolPresentation(selected, call, { for: 'result', view: null })).toBe(selected)
    expect(applyToolPresentation(selected, result, { for: 'call', view: null })).toBe(selected)
  })

  it('treats chunks as durable facts and reconciles a draft with the final message', () => {
    let state = apply([
      durable(0, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } },
      }),
      durable(1, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'b' } },
      }),
    ])
    expect(session(state).journal).toHaveLength(2)
    expect(session(state).rows[0]).toMatchObject({
      kind: 'assistant-draft',
      firstSeq: 0,
      chunks: [{ seq: 0 }, { seq: 1 }],
    })

    state = reduceUiEvent(state, durable(2, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: message('a1', 'assistant', 'authoritative'),
        surfaceOp: 'append',
        interrupted: true,
      },
    }))
    expect(session(state).rows).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        seq: 2,
        interrupted: true,
        message: message('a1', 'assistant', 'authoritative'),
      }),
    ])
  })

  it('journals stream control chunks without projecting duplicate draft text', () => {
    const events = [
      durable(0, {
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'unsupported', sourceType: 'block-start' },
        },
      }),
      durable(1, {
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
        },
      }),
      durable(2, {
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'unsupported', sourceType: 'block-end' },
        },
      }),
      durable(3, {
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 1, text: 'answer' },
        },
      }),
      durable(4, {
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'unsupported', sourceType: 'finish' },
        },
      }),
    ]

    const live = apply(events)
    const replay = replayUiEvents('session-a', events)
    expect(session(live)).toEqual(session(replay))
    expect(session(live).journal).toHaveLength(events.length)
    expect(session(live).rows).toEqual([{
      kind: 'assistant-draft',
      key: 'draft:1:1',
      firstSeq: 1,
      turn: 1,
      step: 1,
      chunks: [
        { seq: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } },
        { seq: 3, chunk: { type: 'text-delta', index: 1, text: 'answer' } },
      ],
    }])
  })

  it('keeps replacements model-only and removes an obsolete matching draft', () => {
    const state = apply([
      durable(0, {
        type: 'user/message',
        data: { message: message('u1', 'user', 'visible'), surfaceOp: 'append' },
      }),
      durable(1, {
        type: 'assistant/chunk',
        data: {
          turn: 9,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'summary' },
        },
      }),
      durable(2, {
        type: 'assistant/message',
        data: {
          turn: 9,
          step: 1,
          message: message('summary', 'assistant', 'replacement'),
          surfaceOp: { op: 'replace', start: 0, end: 0 },
        },
      }),
      durable(3, {
        type: 'user/message',
        data: {
          message: message('u-copy', 'user', 'copy'),
          surfaceOp: { op: 'replace', start: 0, end: 0 },
        },
      }),
      durable(4, {
        type: 'tool/result',
        data: {
          turn: 9,
          step: 1,
          callId: 'replace-tool',
          message: message('tr-copy', 'user', 'copy', 'tool'),
          surfaceOp: { op: 'replace', start: 0, end: 0 },
        },
      }),
    ])
    expect(session(state).rows).toEqual([
      expect.objectContaining({ kind: 'user', message: message('u1', 'user', 'visible') }),
    ])
    expect(session(state).replacements.map(item => item.eventType)).toEqual([
      'assistant/message',
      'user/message',
      'tool/result',
    ])
  })

  it('does not create an empty final assistant row', () => {
    const state = apply([
      durable(0, {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: message('empty', 'assistant', ''),
          surfaceOp: 'append',
          usage: { inputTokens: 1, outputTokens: 0 },
        },
      }),
    ])
    expect(session(state).rows).toEqual([])
  })

  it('correlates tool calls/results by turn, step, and callId', () => {
    const state = apply([
      durable(0, {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'same', name: 'read', arguments: '{}' },
      }),
      durable(1, {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          callId: 'same',
          message: message('tr1', 'user', 'ok', 'tool'),
          surfaceOp: 'append',
          meta: { path: 'a' },
        },
      }),
      durable(2, {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 2,
          callId: 'same',
          message: message('tr2', 'user', 'failed', 'tool'),
          surfaceOp: 'append',
          error: { name: 'ToolError', code: 'FAILED' },
        },
      }),
      durable(3, {
        type: 'tool/call',
        data: { turn: 1, step: 2, callId: 'same', name: 'write', arguments: '{"x":1}' },
      }),
    ])
    const tools = session(state).rows.filter(row => row.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({
      key: 'tool:1:1:same',
      callSeq: 0,
      resultSeq: 1,
      name: 'read',
      meta: { path: 'a' },
    })
    expect(tools[1]).toMatchObject({
      key: 'tool:1:2:same',
      callSeq: 3,
      resultSeq: 2,
      name: 'write',
      error: { code: 'FAILED' },
    })
  })

  it('keeps a todo snapshot through turn/end and clears it on the next turn/start', () => {
    const standing = apply([
      durable(0, {
        type: 'session/observed',
        data: { sourceType: 'request/header', ignorable: false },
      }),
      durable(1, {
        type: 'todo/write',
        data: { todos: [{ content: 'M0', status: 'in_progress' }] },
      }),
    ])
    expect(session(standing).journal).toHaveLength(2)
    expect(session(standing).rows).toEqual([])
    expect(session(standing).todos).toEqual([{ content: 'M0', status: 'in_progress' }])

    const ended = reduceUiEvent(standing, durable(2, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    }))
    expect(session(ended).todos).toEqual([{ content: 'M0', status: 'in_progress' }])

    const next = reduceUiEvent(ended, durable(3, {
      type: 'turn/start',
      data: { turn: 2 },
    }))
    expect(session(next).todos).toEqual([])
  })

  it('folds a command run and done into one durable row without creating a turn', () => {
    const events = [
      durable(0, {
        type: 'session/observed',
        data: { sourceType: 'goal/updated', ignorable: false },
      }),
      durable(1, {
        type: 'command/run',
        data: {
          commandId: 'command-goal',
          name: 'goal',
          args: ' ship M4',
          source: { kind: 'user' },
        },
      }),
      durable(2, {
        type: 'command/done',
        data: {
          commandId: 'command-goal',
          kind: 'success',
          text: 'Goal updated',
          sourceEventSeq: 0,
        },
      }),
    ] satisfies DurableDshEnvelope[]

    const live = apply(events)
    const replay = replayUiEvents('session-a', events)
    expect(session(live)).toEqual(session(replay))
    expect(session(live).rows).toEqual([{
      kind: 'command',
      key: 'command:command-goal',
      commandId: 'command-goal',
      status: 'success',
      runSeq: 1,
      name: 'goal',
      args: ' ship M4',
      source: { kind: 'user' },
      doneSeq: 2,
      text: 'Goal updated',
      sourceEventSeq: 0,
    }])
    expect(session(live).openTurn).toBeUndefined()
    expect(session(live).openStep).toBeUndefined()
    expect(session(live).lastTurnEnd).toBeUndefined()
    expect(session(live).agentStatus).toBe('idle')
  })

  it('keeps absent command args absent and exposes a done-without-run diagnostic', () => {
    const running = apply([
      durable(0, {
        type: 'command/run',
        data: {
          commandId: 'command-feedback',
          name: 'feedback',
          source: { kind: 'user' },
        },
      }),
    ])
    expect(session(running).rows[0]).toMatchObject({
      kind: 'command',
      status: 'running',
      runSeq: 0,
      name: 'feedback',
    })
    expect(session(running).rows[0]).not.toHaveProperty('args')

    const recordedEmpty = apply([
      durable(0, {
        type: 'command/run',
        data: {
          commandId: 'command-empty',
          name: 'plan',
          args: '',
          source: { kind: 'user' },
        },
      }),
    ])
    expect(session(recordedEmpty).rows[0]).toHaveProperty('args', '')

    const orphan = replayUiEvents('session-a', [
      durable(0, {
        type: 'command/done',
        data: {
          commandId: 'command-orphan',
          kind: 'error',
          text: 'handler failed',
        },
      }),
    ])
    expect(session(orphan).rows).toEqual([{
      kind: 'command',
      key: 'command:command-orphan',
      commandId: 'command-orphan',
      status: 'error',
      doneSeq: 0,
      text: 'handler failed',
      protocolDiagnostics: { doneWithoutRun: true },
    }])
    expect(session(orphan).compatibilityError).toBeUndefined()
    expect(session(orphan).agentStatus).toBe('idle')

    const lateRun = reduceUiEvent(orphan, durable(1, {
      type: 'command/run',
      data: {
        commandId: 'command-orphan',
        name: 'late',
        source: { kind: 'user' },
      },
    }))
    expect(session(lateRun).rows[0]).toMatchObject({
      status: 'error',
      runSeq: 1,
      name: 'late',
      doneSeq: 0,
      protocolDiagnostics: { doneWithoutRun: true },
    })
  })

  it('pairs interleaved commands by commandId and distinguishes their outcomes', () => {
    const state = apply([
      durable(0, {
        type: 'command/run',
        data: {
          commandId: 'command-first',
          name: 'first',
          source: { kind: 'user' },
        },
      }),
      durable(1, {
        type: 'command/run',
        data: {
          commandId: 'command-second',
          name: 'second',
          source: { kind: 'user' },
        },
      }),
      durable(2, {
        type: 'command/done',
        data: {
          commandId: 'command-second',
          kind: 'error',
          text: 'second failed',
        },
      }),
      durable(3, {
        type: 'command/done',
        data: {
          commandId: 'command-first',
          kind: 'success',
          text: 'first completed',
        },
      }),
    ])

    expect(session(state).rows).toEqual([
      expect.objectContaining({
        commandId: 'command-first',
        status: 'success',
        runSeq: 0,
        doneSeq: 3,
      }),
      expect.objectContaining({
        commandId: 'command-second',
        status: 'error',
        runSeq: 1,
        doneSeq: 2,
      }),
    ])
  })

  it('settles out-of-order arrivals by durable seq and handles duplicate lifecycle ids deterministically', () => {
    const ordered = [
      durable(0, {
        type: 'session/observed',
        data: { sourceType: 'before-command', ignorable: true },
      }),
      durable(1, {
        type: 'command/run',
        data: {
          commandId: 'command-buffered',
          name: 'plan',
          source: { kind: 'user' },
        },
      }),
      durable(2, {
        type: 'command/done',
        data: { commandId: 'command-buffered', kind: 'success' },
      }),
    ] satisfies DurableDshEnvelope[]
    let outOfOrder = selectSession(createUiState(), 'session-a')
    outOfOrder = reduceUiEvent(outOfOrder, ordered[2]!)
    outOfOrder = reduceUiEvent(outOfOrder, ordered[1]!)
    outOfOrder = reduceUiEvent(outOfOrder, ordered[0]!)
    expect(session(outOfOrder)).toEqual(session(replayUiEvents('session-a', ordered)))
    expect(session(outOfOrder).rows[0]).not.toHaveProperty('protocolDiagnostics')

    const duplicate = apply([
      durable(0, {
        type: 'command/run',
        data: {
          commandId: 'command-duplicate',
          name: 'first',
          args: ' original',
          source: { kind: 'user' },
        },
      }),
      durable(1, {
        type: 'command/run',
        data: {
          commandId: 'command-duplicate',
          name: 'second',
          args: ' replacement',
          source: { kind: 'user' },
        },
      }),
      durable(2, {
        type: 'command/done',
        data: {
          commandId: 'command-duplicate',
          kind: 'success',
          text: 'first result',
        },
      }),
      durable(3, {
        type: 'command/done',
        data: {
          commandId: 'command-duplicate',
          kind: 'error',
          text: 'replacement result',
        },
      }),
    ])
    expect(session(duplicate).rows).toEqual([{
      kind: 'command',
      key: 'command:command-duplicate',
      commandId: 'command-duplicate',
      status: 'success',
      runSeq: 0,
      name: 'first',
      args: ' original',
      source: { kind: 'user' },
      doneSeq: 2,
      text: 'first result',
      protocolDiagnostics: {
        duplicateRun: true,
        duplicateDone: true,
      },
    }])
    expect(session(duplicate).compatibilityError).toBeUndefined()
  })
})

describe('session and live lifecycle isolation', () => {
  it('keeps background session events isolated and selects without data loss', () => {
    let state = selectSession(createUiState(), 'session-a')
    state = reduceUiEvent(state, durable(0, {
      type: 'user/message',
      data: { message: message('b1', 'user', 'for B'), surfaceOp: 'append' },
    }, 'session-b'))
    expect(session(state, 'session-a').rows).toEqual([])
    expect(session(state, 'session-b').rows).toHaveLength(1)
    expect(state.activeSessionId).toBe('session-a')

    state = selectSession(state, 'session-b')
    expect(state.activeSessionId).toBe('session-b')
    expect(session(state, 'session-b').rows).toHaveLength(1)
    expect(setUiPhase(state, 'stopping').phase).toBe('stopping')
  })

  it('rejects stale and duplicate live lifecycle updates', () => {
    let state = selectSession(createUiState(), 'session-a')
    state = reduceUiEvent(state, runtime(0, {
      type: 'agent/status',
      data: { status: 'running' },
    }))
    expect(session(state).agentStatus).toBe('idle')

    state = reduceUiEvent(state, runtime(1, {
      type: 'agent/created',
      data: { status: 'running' },
    }))
    state = reduceUiEvent(state, runtime(2, {
      type: 'agent/status',
      data: { status: 'idle' },
    }))
    state = reduceUiEvent(state, runtime(2, {
      type: 'agent/status',
      data: { status: 'running' },
    }))
    expect(session(state).agentStatus).toBe('idle')

    state = reduceUiEvent(state, runtime(0, {
      type: 'agent/created',
      data: { status: 'running' },
    }, 'session-a', 'live-new'))
    state = reduceUiEvent(state, runtime(3, {
      type: 'agent/status',
      data: { status: 'running' },
    }, 'session-a', 'live-a'))
    expect(session(state).agentStatus).toBe('running')
    expect(session(state).liveSourceId).toBe('live-new')

    state = reduceUiEvent(state, runtime(4, {
      type: 'agent/disposed',
      data: {},
    }, 'session-a', 'live-a'))
    expect(session(state).agentStatus).toBe('running')
    expect(session(state).liveSourceId).toBe('live-new')

    state = reduceUiEvent(state, runtime(1, {
      type: 'agent/disposed',
      data: {},
    }, 'session-a', 'live-new'))
    expect(session(state).agentStatus).toBe('disposed')
    expect(session(state).liveSourceId).toBeUndefined()

    state = reduceUiEvent(state, runtime(2, {
      type: 'agent/status',
      data: { status: 'idle' },
    }, 'session-a', 'live-new'))
    expect(session(state).agentStatus).toBe('disposed')
  })
})
