import { describe, expect, it } from 'vitest'
import {
  activeLlmAttemptChain,
  projectLlmRetry,
  projectLlmRetryStarted,
  selectAttemptPanel,
  settleLlmAttemptMessage,
  settleLlmAttemptTurn,
  type DurableDshEnvelope,
  type LlmAttemptChain,
  type SessionLlmAttemptState,
} from '../src/internal.ts'
import { durable, message } from './fixtures.ts'

type RetryEnvelope = Extract<DurableDshEnvelope, { type: 'llm/retry' }>
type RetryStartedEnvelope = Extract<DurableDshEnvelope, { type: 'llm/retry-started' }>
type AssistantEnvelope = Extract<DurableDshEnvelope, { type: 'assistant/message' }>
type TurnEndEnvelope = Extract<DurableDshEnvelope, { type: 'turn/end' }>

function retry(
  seq: number,
  retryId: string,
  options: {
    readonly turn?: number
    readonly step?: number
    readonly retry?: number
    readonly provider?: string
    readonly policyKey?: string
    readonly delayMs?: number
  } = {},
): RetryEnvelope {
  const attempt = options.retry ?? 1
  return durable(seq, {
    type: 'llm/retry',
    data: {
      retryId,
      turn: options.turn ?? 1,
      step: options.step ?? 1,
      provider: options.provider ?? 'deepseek-official',
      mode: 'normal',
      policyKey: options.policyKey ?? 'normal-policy',
      retry: attempt,
      maxRetries: 100,
      delayMs: options.delayMs ?? 500,
      failure: { message: `failure ${attempt}`, code: 'SERVER' },
    },
  }) as RetryEnvelope
}

function alwaysRetry(seq: number, retryId: string): RetryEnvelope {
  return durable(seq, {
    type: 'llm/retry',
    data: {
      retryId,
      turn: 1,
      step: 1,
      provider: 'fallback',
      mode: 'always',
      policyKey: 'always-policy',
      retry: 1,
      delayMs: 1_500,
      failure: { message: 'fallback failed', code: 'TRANSPORT' },
    },
  }) as RetryEnvelope
}

function started(
  seq: number,
  retryId: string,
  attempt = 1,
): RetryStartedEnvelope {
  return durable(seq, {
    type: 'llm/retry-started',
    data: { retryId, turn: 1, step: 1, retry: attempt },
  }) as RetryStartedEnvelope
}

function assistant(
  seq: number,
  turn = 1,
  step = 1,
  interrupted = false,
): AssistantEnvelope {
  return durable(seq, {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: message(`assistant-${seq}`, 'assistant', 'recovered'),
      surfaceOp: 'append',
      ...(interrupted ? { interrupted: true } : {}),
    },
  }) as AssistantEnvelope
}

function turnEnd(seq: number, turn: number, reason: unknown): TurnEndEnvelope {
  return durable(seq, {
    type: 'turn/end',
    data: { turn, reason },
  }) as TurnEndEnvelope
}

function chain(
  retryId: string,
  overrides: Partial<LlmAttemptChain> = {},
): LlmAttemptChain {
  return {
    retryId,
    turn: 1,
    step: 1,
    phase: 'backoff',
    provider: 'deepseek-official',
    mode: 'normal',
    policyKey: 'normal-policy',
    maxRetries: 5,
    attempts: [{
      retry: 1,
      scheduledSeq: 1,
      scheduledAt: 1_001,
      delayMs: 500,
      failure: { message: 'failed', code: 'SERVER' },
    }],
    ...overrides,
  }
}

describe('official LLM attempt projection', () => {
  it('bounds repeated attempts and chain history while retaining omission counts', () => {
    let repeated: SessionLlmAttemptState | undefined
    for (let attempt = 1; attempt <= 66; attempt += 1) {
      repeated = projectLlmRetry(repeated, retry(attempt, 'retry-repeated', { retry: attempt }))
    }
    const boundedRepeated = repeated!
    expect(boundedRepeated.chains).toHaveLength(1)
    expect(boundedRepeated.chains[0]?.attempts).toHaveLength(64)
    expect(boundedRepeated.chains[0]?.attempts[0]?.retry).toBe(3)
    expect(boundedRepeated.chains[0]?.omittedAttemptCount).toBe(2)
    const retainedAttemptOmissions = projectLlmRetry({
      chains: [chain('retry-retained', { omittedAttemptCount: 3 })],
      activeRetryId: 'retry-retained',
    }, retry(67, 'retry-retained', { retry: 2 }))
    expect(retainedAttemptOmissions.chains[0]?.omittedAttemptCount).toBe(3)

    let manyChains: SessionLlmAttemptState | undefined
    for (let index = 1; index <= 18; index += 1) {
      manyChains = projectLlmRetry(manyChains, retry(index, `retry-${index}`, { turn: index }))
    }
    const boundedChains = manyChains!
    expect(boundedChains.chains).toHaveLength(16)
    expect(boundedChains.chains[0]?.retryId).toBe('retry-3')
    expect(boundedChains.omittedChainCount).toBe(2)
    const retainedChainOmissions = projectLlmRetry({
      chains: [chain('retry-retained-chain')],
      activeRetryId: 'retry-retained-chain',
      omittedChainCount: 4,
    }, retry(68, 'retry-retained-chain', { retry: 2 }))
    expect(retainedChainOmissions.omittedChainCount).toBe(4)
    expect(projectLlmRetry(undefined, alwaysRetry(70, 'retry-always')).chains[0]).not.toHaveProperty(
      'maxRetries',
    )
  })

  it('distinguishes a provider reroute from a same-provider policy replacement', () => {
    const initialRoute = projectLlmRetry(undefined, retry(1, 'route-a'))
    const rerouted = projectLlmRetry(
      initialRoute,
      retry(2, 'route-b', { provider: 'fallback', policyKey: 'fallback-policy' }),
    )
    expect(rerouted.chains[0]).toMatchObject({ phase: 'rerouted', finalSeq: 2 })

    const initialPolicy = projectLlmRetry(undefined, retry(3, 'policy-a'))
    const reconfigured = projectLlmRetry(
      initialPolicy,
      retry(4, 'policy-b', { policyKey: 'replacement-policy' }),
    )
    expect(reconfigured.chains[0]).toMatchObject({ phase: 'reconfigured', finalSeq: 4 })

    for (const state of [
      { chains: [chain('terminal', { phase: 'failed' })], activeRetryId: 'terminal' },
      { chains: [chain('other-turn', { turn: 2 })], activeRetryId: 'other-turn' },
      { chains: [chain('other-step', { step: 2 })], activeRetryId: 'other-step' },
      { chains: [chain('orphan')], activeRetryId: 'missing' },
    ] satisfies SessionLlmAttemptState[]) {
      const projected = projectLlmRetry(state, retry(5, `next-${state.activeRetryId}`))
      expect(projected.chains[0]?.phase).not.toBe('rerouted')
      expect(projected.chains[0]?.phase).not.toBe('reconfigured')
    }
  })

  it('ignores stale starts and messages, then settles the exact live chain', () => {
    expect(projectLlmRetryStarted(undefined, started(1, 'missing'))).toBeUndefined()
    const empty: SessionLlmAttemptState = { chains: [] }
    expect(projectLlmRetryStarted(empty, started(2, 'missing'))).toBe(empty)
    const withoutAttempt: SessionLlmAttemptState = {
      chains: [chain('known', { attempts: [] })],
      activeRetryId: 'known',
    }
    expect(projectLlmRetryStarted(withoutAttempt, started(3, 'known'))).toBe(withoutAttempt)

    const scheduled = projectLlmRetry(undefined, retry(4, 'known'))
    expect(projectLlmRetryStarted(scheduled, started(5, 'other'))).toBe(scheduled)
    const requesting = projectLlmRetryStarted(scheduled, started(6, 'known'))!
    expect(requesting.chains[0]).toMatchObject({
      phase: 'requesting',
      attempts: [{ startedSeq: 6, startedAt: 1_006 }],
    })

    expect(settleLlmAttemptMessage(undefined, assistant(7))).toBeUndefined()
    const orphan: SessionLlmAttemptState = { chains: [chain('known')], activeRetryId: 'missing' }
    expect(settleLlmAttemptMessage(orphan, assistant(8))).toBe(orphan)
    const terminal: SessionLlmAttemptState = {
      chains: [chain('known', { phase: 'failed' })],
      activeRetryId: 'known',
    }
    expect(settleLlmAttemptMessage(terminal, assistant(9))).toBe(terminal)
    expect(settleLlmAttemptMessage(requesting, assistant(10, 2, 1))).toBe(requesting)
    expect(settleLlmAttemptMessage(requesting, assistant(11, 1, 2))).toBe(requesting)

    const interrupted = settleLlmAttemptMessage(requesting, assistant(12, 1, 1, true))!
    expect(interrupted).toBe(requesting)
    const cancelled = settleLlmAttemptTurn(interrupted, turnEnd(13, 1, { kind: 'aborted' }))!
    expect(cancelled.activeRetryId).toBeUndefined()
    expect(cancelled).toMatchObject({
      chains: [{ phase: 'cancelled', finalSeq: 13 }],
    })

    const recovered = settleLlmAttemptMessage(requesting, assistant(14))!
    expect(recovered.activeRetryId).toBeUndefined()
    expect(recovered.chains[0]).toMatchObject({ phase: 'recovered', finalSeq: 14 })
    expect(activeLlmAttemptChain(recovered)).toBeUndefined()
  })

  it('settles terminal turns without disturbing an unrelated active chain', () => {
    expect(settleLlmAttemptTurn(undefined, turnEnd(1, 1, null))).toBeUndefined()
    const unchanged: SessionLlmAttemptState = {
      chains: [chain('terminal', { phase: 'failed' }), chain('other-turn', { turn: 2 })],
    }
    expect(settleLlmAttemptTurn(unchanged, turnEnd(2, 1, { kind: 'completed' }))).toBe(unchanged)

    const mixed: SessionLlmAttemptState = {
      chains: [chain('active-other-turn', { turn: 2 }), chain('settle-now')],
      activeRetryId: 'active-other-turn',
    }
    const failed = settleLlmAttemptTurn(mixed, turnEnd(3, 1, null))!
    expect(failed.activeRetryId).toBe('active-other-turn')
    expect(failed.chains[1]).toMatchObject({ phase: 'failed', finalSeq: 3 })

    const noActive: SessionLlmAttemptState = { chains: [chain('complete-now')] }
    expect(settleLlmAttemptTurn(noActive, turnEnd(4, 1, { kind: 'completed' }))?.chains[0])
      .toMatchObject({ phase: 'recovered', finalSeq: 4 })
    const cancelled: SessionLlmAttemptState = {
      chains: [chain('cancel-now')],
      activeRetryId: 'cancel-now',
    }
    expect(settleLlmAttemptTurn(cancelled, turnEnd(5, 1, { kind: 'aborted' }))?.chains[0])
      .toMatchObject({ phase: 'cancelled', finalSeq: 5 })
  })

  it('projects the attempt panel with the default latest selection', () => {
    expect(selectAttemptPanel(undefined)).toEqual({
      rows: [],
      selectedIndex: -1,
      selectedAttemptIndex: -1,
      omittedChainCount: 0,
    })

    const attempts: SessionLlmAttemptState = {
      chains: [
        chain('older'),
        chain('latest', {
          phase: 'recovered',
          attempts: [
            {
              retry: 1,
              scheduledSeq: 10,
              scheduledAt: 1_010,
              delayMs: 500,
              failure: { message: 'first', code: 'SERVER', requestId: 'request-first' },
            },
            {
              retry: 2,
              scheduledSeq: 11,
              scheduledAt: 1_011,
              delayMs: 750,
              failure: { message: 'second', code: 'RATE_LIMIT', requestId: 'request-second' },
            },
          ],
        }),
      ],
      omittedChainCount: 3,
    }
    const view = selectAttemptPanel(attempts)
    expect(view.selectedIndex).toBe(0)
    expect(view.selected?.retryId).toBe('latest')
    expect(view.selectedAttemptIndex).toBe(1)
    expect(view.selectedAttempt?.failure.requestId).toBe('request-second')
    expect(view.omittedChainCount).toBe(3)

    const active: SessionLlmAttemptState = {
      chains: [chain('older'), chain('latest')],
      activeRetryId: 'older',
    }
    expect(selectAttemptPanel(active).selected?.retryId).toBe('older')

    const withEmptyChain: SessionLlmAttemptState = {
      chains: [chain('with-attempt'), chain('without-attempt', { attempts: [] })],
    }
    const emptySelection = selectAttemptPanel(withEmptyChain)
    expect(emptySelection.selected?.retryId).toBe('without-attempt')
    expect(emptySelection.selectedAttemptIndex).toBe(-1)
    expect(emptySelection.selectedAttempt).toBeUndefined()
  })
})
