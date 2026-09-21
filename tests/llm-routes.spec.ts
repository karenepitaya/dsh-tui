import { describe, expect, it } from 'vitest'
import {
  projectRequestContext,
  projectRequestHeader,
  selectRoutePanel,
  type SessionRequestRouteState,
} from '../src/llm/routes.ts'
import type { DurableDshEnvelope } from '../src/runtime/events.ts'

function header(
  seq: number,
  provider: string,
  model: string,
  reason: 'initial' | 'resume' | 'change' = 'change',
): Extract<DurableDshEnvelope, { type: 'request/header' }> {
  return {
    plane: 'durable',
    sessionId: 'session-a',
    seq,
    time: 1_000 + seq,
    type: 'request/header',
    data: {
      reason,
      config: { provider, model },
    },
  }
}

function context(
  seq: number,
  provider: string,
  model: string,
  contextWindow?: number,
): Extract<DurableDshEnvelope, { type: 'request/context' }> {
  return {
    plane: 'durable',
    sessionId: 'session-a',
    seq,
    time: 1_000 + seq,
    type: 'request/context',
    data: {
      provider,
      model,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    },
  }
}

describe('official request route projection', () => {
  it('correlates route capacity without inventing per-call request records', () => {
    let state: SessionRequestRouteState | undefined
    state = projectRequestContext(state, context(0, 'provider-a', 'model-a', 64_000))
    state = projectRequestHeader(state, header(1, 'provider-a', 'model-a', 'initial'))
    state = projectRequestHeader(state, {
      ...header(2, 'provider-a', 'model-a'),
      data: {
        reason: 'change',
        config: {
          provider: 'provider-a',
          model: 'model-a',
          reasoningEffort: 'high',
          maxTokens: 8_192,
          temperature: 0.2,
          stop: ['END'],
        },
        adapterDefaults: { reasoningEffort: true, maxTokens: true },
      },
    })
    state = projectRequestHeader(state, header(3, 'provider-b', 'model-b'))

    expect(state.epochs).toHaveLength(3)
    expect(state.epochs[0]).toMatchObject({
      headerSeq: 1,
      context: { contextWindow: 64_000, contextSeq: 0 },
    })
    expect(state.epochs[1]).toMatchObject({
      config: {
        reasoningEffort: 'high',
        maxTokens: 8_192,
        temperature: 0.2,
        stop: ['END'],
      },
      adapterDefaults: { reasoningEffort: true, maxTokens: true },
      context: { contextWindow: 64_000 },
    })
    expect(state.epochs[2]).not.toHaveProperty('context')

    state = projectRequestContext(state, context(4, 'provider-b', 'model-b', 256_000))
    expect(state.epochs[2]).toMatchObject({
      context: { contextWindow: 256_000, contextSeq: 4, contextTime: 1_004 },
    })
  })

  it('bounds route history and records omitted epochs', () => {
    let state: SessionRequestRouteState | undefined
    for (let seq = 0; seq < 34; seq += 1) {
      state = projectRequestHeader(state, header(seq, 'provider', `model-${seq}`))
    }
    expect(state?.epochs).toHaveLength(32)
    expect(state?.epochs[0]?.headerSeq).toBe(2)
    expect(state?.omittedEpochCount).toBe(2)

    const retained: SessionRequestRouteState = {
      epochs: state!.epochs,
      omittedEpochCount: 5,
    }
    expect(projectRequestHeader(retained, header(34, 'provider', 'model-34')).omittedEpochCount)
      .toBe(6)

    const sparseRetained: SessionRequestRouteState = {
      epochs: retained.epochs.slice(0, 1),
      omittedEpochCount: 5,
    }
    expect(projectRequestHeader(sparseRetained, header(35, 'provider', 'model-35')).omittedEpochCount)
      .toBe(5)
  })

  it('keeps unmatched and capacity-less context truthful', () => {
    const initial = projectRequestHeader(undefined, header(0, 'provider-a', 'model-a', 'initial'))
    const unmatched = projectRequestContext(initial, context(1, 'provider-b', 'model-b'))
    expect(unmatched.epochs[0]).not.toHaveProperty('context')
    expect(unmatched.latestContext).toMatchObject({ provider: 'provider-b', model: 'model-b' })

    const matched = projectRequestHeader(unmatched, header(2, 'provider-b', 'model-b'))
    expect(matched.epochs[1]?.context).toEqual({
      provider: 'provider-b',
      model: 'model-b',
      contextSeq: 1,
      contextTime: 1_001,
    })
  })
})

describe('request route projection', () => {
  const routes: SessionRequestRouteState = {
    epochs: [
      projectRequestHeader(undefined, header(1, 'provider-a', 'model-a', 'initial')).epochs[0]!,
      projectRequestHeader(undefined, header(2, 'provider-b', 'model-b')).epochs[0]!,
    ],
    omittedEpochCount: 3,
  }

  it('projects the latest epoch as the default selection', () => {
    expect(selectRoutePanel(routes)).toMatchObject({
      selectedIndex: 0,
      selected: { headerSeq: 2 },
      omittedEpochCount: 3,
    })
    expect(selectRoutePanel(undefined)).toMatchObject({
      rows: [],
      selectedIndex: -1,
    })
    expect(selectRoutePanel(undefined).selected).toBeUndefined()
  })
})
