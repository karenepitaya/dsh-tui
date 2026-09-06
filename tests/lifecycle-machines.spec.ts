import { describe, expect, it } from 'vitest'
import {
  createApplicationLifecycleState,
  createFeatureLifecycleState,
  createResourceLifecycleState,
  createSessionLifecycleState,
  createTurnLifecycleState,
  transitionApplicationLifecycle,
  transitionFeatureLifecycle,
  transitionResourceLifecycle,
  transitionSessionLifecycle,
  transitionTurnLifecycle,
  type ApplicationLifecycleEvent,
  type FeatureLifecycleEvent,
  type ResourceLifecycleEvent,
  type SessionLifecycleEvent,
  type TurnLifecycleEvent,
} from '../src/lifecycle/machines.ts'

describe('application lifecycle machine', () => {
  it('starts, becomes ready, and stops through explicit effects', () => {
    const stopped = createApplicationLifecycleState()
    const booting = transitionApplicationLifecycle(stopped, { type: 'boot' })
    expect(booting).toEqual({
      state: { phase: 'booting' },
      effects: [{ type: 'boot-application' }],
    })
    const running = transitionApplicationLifecycle(booting.state, { type: 'ready' })
    expect(running).toEqual({ state: { phase: 'running' }, effects: [] })
    const stopping = transitionApplicationLifecycle(running.state, {
      type: 'stop', reason: 'user',
    })
    expect(stopping).toEqual({
      state: { phase: 'stopping', reason: 'user' },
      effects: [{ type: 'dispose-application', reason: 'user' }],
    })
    expect(transitionApplicationLifecycle(stopping.state, { type: 'stopped' }))
      .toEqual({ state: { phase: 'stopped' }, effects: [] })
  })

  it('contains startup, runtime, and disposal failures without duplicate cleanup', () => {
    const startupError = new Error('startup')
    const startup = transitionApplicationLifecycle(
      { phase: 'booting' },
      { type: 'fail', error: startupError },
    )
    expect(startup).toEqual({
      state: { phase: 'failed', error: startupError },
      effects: [{ type: 'dispose-application', reason: startupError }],
    })
    expect(transitionApplicationLifecycle(startup.state, { type: 'stopped' }))
      .toEqual({ state: { phase: 'stopped' }, effects: [] })

    const runtimeError = new Error('runtime')
    expect(transitionApplicationLifecycle(
      { phase: 'running' },
      { type: 'fail', error: runtimeError },
    )).toEqual({
      state: { phase: 'failed', error: runtimeError },
      effects: [{ type: 'dispose-application', reason: runtimeError }],
    })

    const disposalError = new Error('dispose')
    expect(transitionApplicationLifecycle(
      { phase: 'stopping', reason: 'user' },
      { type: 'fail', error: disposalError },
    )).toEqual({
      state: { phase: 'failed', error: disposalError },
      effects: [],
    })
  })

  it('no-ops valid events in illegal phases and rejects unknown events', () => {
    const stopped = createApplicationLifecycleState()
    const noOp = transitionApplicationLifecycle(stopped, { type: 'ready' })
    expect(noOp.state).toBe(stopped)
    expect(noOp.effects).toEqual([])
    expect(transitionApplicationLifecycle(stopped, { type: 'stop', reason: 'early' }).state)
      .toBe(stopped)
    expect(transitionApplicationLifecycle(stopped, { type: 'stopped' }).state).toBe(stopped)
    expect(transitionApplicationLifecycle({ phase: 'running' }, { type: 'boot' }).state)
      .toEqual({ phase: 'running' })
    expect(transitionApplicationLifecycle(stopped, { type: 'fail', error: 'bad' }).state)
      .toBe(stopped)
    expect(() => transitionApplicationLifecycle(
      stopped,
      { type: 'unknown' } as unknown as ApplicationLifecycleEvent,
    )).toThrow('unknown lifecycle event')
  })
})

describe('session lifecycle machine', () => {
  it('opens, hydrates, becomes ready, switches, and closes one session', () => {
    const closed = createSessionLifecycleState()
    const opening = transitionSessionLifecycle(closed, {
      type: 'open', sessionId: 'session-a',
    })
    expect(opening).toEqual({
      state: { phase: 'opening', sessionId: 'session-a' },
      effects: [{ type: 'open-session', sessionId: 'session-a' }],
    })
    const hydrating = transitionSessionLifecycle(opening.state, {
      type: 'opened', epoch: 7,
    })
    expect(hydrating).toEqual({
      state: { phase: 'hydrating', sessionId: 'session-a', epoch: 7 },
      effects: [{ type: 'hydrate-session', sessionId: 'session-a' }],
    })
    const ready = transitionSessionLifecycle(hydrating.state, { type: 'hydrated' })
    expect(ready).toEqual({
      state: { phase: 'ready', sessionId: 'session-a', epoch: 7 },
      effects: [],
    })
    const switching = transitionSessionLifecycle(ready.state, {
      type: 'switch', targetSessionId: 'session-b',
    })
    expect(switching).toEqual({
      state: {
        phase: 'switching',
        sessionId: 'session-b',
        previousSessionId: 'session-a',
        epoch: 7,
      },
      effects: [{
        type: 'switch-session',
        previousSessionId: 'session-a',
        sessionId: 'session-b',
      }],
    })
    const closing = transitionSessionLifecycle(switching.state, {
      type: 'close', reason: 'switch',
    })
    expect(closing).toEqual({
      state: { phase: 'closing', sessionId: 'session-b', reason: 'switch' },
      effects: [{ type: 'close-session', sessionId: 'session-b', reason: 'switch' }],
    })
    expect(transitionSessionLifecycle(closing.state, { type: 'closed' }))
      .toEqual({ state: { phase: 'closed' }, effects: [] })
  })

  it('hydrates the target after a completed switch', () => {
    const switching = {
      phase: 'switching',
      sessionId: 'session-b',
      previousSessionId: 'session-a',
      epoch: 7,
    } as const
    const hydrating = transitionSessionLifecycle(switching, {
      type: 'switched', epoch: 8,
    })
    expect(hydrating).toEqual({
      state: { phase: 'hydrating', sessionId: 'session-b', epoch: 8 },
      effects: [{ type: 'hydrate-session', sessionId: 'session-b' }],
    })
    expect(transitionSessionLifecycle(hydrating.state, { type: 'hydrated' }).state)
      .toEqual({ phase: 'ready', sessionId: 'session-b', epoch: 8 })
  })

  it('closes failed owned work exactly once', () => {
    const error = new Error('lost')
    const failed = transitionSessionLifecycle(
      { phase: 'opening', sessionId: 'session-a' },
      { type: 'fail', error },
    )
    expect(failed).toEqual({
      state: { phase: 'failed', sessionId: 'session-a', error },
      effects: [{ type: 'close-session', sessionId: 'session-a', reason: error }],
    })
    expect(transitionSessionLifecycle(failed.state, { type: 'closed' }))
      .toEqual({ state: { phase: 'closed' }, effects: [] })

    const closingFailure = transitionSessionLifecycle(
      { phase: 'closing', sessionId: 'session-a', reason: 'cancel' },
      { type: 'fail', error },
    )
    expect(closingFailure.effects).toEqual([])
    expect(closingFailure.state).toEqual({ phase: 'failed', sessionId: 'session-a', error })
  })

  it('no-ops invalid phase changes and rejects unknown events', () => {
    const closed = createSessionLifecycleState()
    for (const event of [
      { type: 'opened', epoch: 1 },
      { type: 'hydrated' },
      { type: 'switch', targetSessionId: 'session-b' },
      { type: 'switched', epoch: 2 },
      { type: 'close', reason: 'none' },
      { type: 'closed' },
      { type: 'fail', error: 'none' },
    ] as const) {
      expect(transitionSessionLifecycle(closed, event).state).toBe(closed)
    }
    expect(transitionSessionLifecycle(
      { phase: 'ready', sessionId: 'session-a', epoch: 1 },
      { type: 'open', sessionId: 'session-b' },
    ).state).toEqual({ phase: 'ready', sessionId: 'session-a', epoch: 1 })
    expect(() => transitionSessionLifecycle(
      closed,
      { type: 'unknown' } as unknown as SessionLifecycleEvent,
    )).toThrow('unknown lifecycle event')
  })
})

describe('feature lifecycle machine', () => {
  it('mounts, activates, suspends, resumes, and disposes a feature', () => {
    const registered = createFeatureLifecycleState('sessions')
    const inactive = transitionFeatureLifecycle(registered, { type: 'mount' })
    expect(inactive).toEqual({
      state: { phase: 'inactive', featureId: 'sessions' }, effects: [],
    })
    const activating = transitionFeatureLifecycle(inactive.state, { type: 'activate' })
    expect(activating.effects).toEqual([{ type: 'activate-feature', featureId: 'sessions' }])
    const active = transitionFeatureLifecycle(activating.state, { type: 'activated' })
    const suspended = transitionFeatureLifecycle(active.state, { type: 'suspend' })
    expect(suspended).toEqual({
      state: { phase: 'suspended', featureId: 'sessions' },
      effects: [{ type: 'suspend-feature', featureId: 'sessions' }],
    })
    const resumed = transitionFeatureLifecycle(suspended.state, { type: 'resume' })
    expect(resumed).toEqual({
      state: { phase: 'active', featureId: 'sessions' },
      effects: [{ type: 'resume-feature', featureId: 'sessions' }],
    })
    const disposing = transitionFeatureLifecycle(resumed.state, {
      type: 'dispose', reason: 'unregistered',
    })
    expect(disposing.effects).toEqual([
      { type: 'dispose-feature', featureId: 'sessions', reason: 'unregistered' },
    ])
    expect(transitionFeatureLifecycle(disposing.state, { type: 'disposed' }))
      .toEqual({ state: { phase: 'disposed', featureId: 'sessions' }, effects: [] })
  })

  it('releases a failed feature and supports disposal from every owned phase', () => {
    const failure = new Error('activate')
    for (const phase of ['activating', 'active', 'suspended'] as const) {
      const failed = transitionFeatureLifecycle(
        { phase, featureId: 'diff' },
        { type: 'fail', error: failure },
      )
      expect(failed).toEqual({
        state: { phase: 'failed', featureId: 'diff', error: failure },
        effects: [{ type: 'dispose-feature', featureId: 'diff', reason: failure }],
      })
    }
    expect(transitionFeatureLifecycle(
      { phase: 'disposing', featureId: 'diff', reason: 'close' },
      { type: 'fail', error: failure },
    )).toEqual({
      state: { phase: 'failed', featureId: 'diff', error: failure }, effects: [],
    })

    for (const state of [
      { phase: 'registered', featureId: 'diff' },
      { phase: 'inactive', featureId: 'diff' },
      { phase: 'activating', featureId: 'diff' },
      { phase: 'active', featureId: 'diff' },
      { phase: 'suspended', featureId: 'diff' },
      { phase: 'failed', featureId: 'diff', error: failure },
    ] as const) {
      expect(transitionFeatureLifecycle(state, { type: 'dispose', reason: 'close' }).state)
        .toEqual({ phase: 'disposing', featureId: 'diff', reason: 'close' })
    }
    expect(transitionFeatureLifecycle(
      { phase: 'failed', featureId: 'diff', error: failure },
      { type: 'disposed' },
    ).state).toEqual({ phase: 'disposed', featureId: 'diff' })
  })

  it('no-ops invalid feature transitions and rejects unknown events', () => {
    const registered = createFeatureLifecycleState('sessions')
    for (const event of [
      { type: 'activate' },
      { type: 'activated' },
      { type: 'suspend' },
      { type: 'resume' },
      { type: 'disposed' },
      { type: 'fail', error: 'none' },
    ] as const) {
      expect(transitionFeatureLifecycle(registered, event).state).toBe(registered)
    }
    expect(transitionFeatureLifecycle(
      { phase: 'disposed', featureId: 'sessions' },
      { type: 'dispose', reason: 'again' },
    ).state).toEqual({ phase: 'disposed', featureId: 'sessions' })
    expect(transitionFeatureLifecycle(
      { phase: 'disposed', featureId: 'sessions' },
      { type: 'mount' },
    ).state).toEqual({ phase: 'disposed', featureId: 'sessions' })
    expect(() => transitionFeatureLifecycle(
      registered,
      { type: 'unknown' } as unknown as FeatureLifecycleEvent,
    )).toThrow('unknown lifecycle event')
  })
})

describe('turn lifecycle machine', () => {
  it('moves through submitted, waiting, tool, streaming, cancelling, and settled', () => {
    const ready = createTurnLifecycleState()
    const submitted = transitionTurnLifecycle(ready, { type: 'submit', turn: 3 })
    expect(submitted).toEqual({
      state: { phase: 'submitted', turn: 3 },
      effects: [{ type: 'submit-turn', turn: 3 }],
    })
    const waiting = transitionTurnLifecycle(submitted.state, { type: 'accepted' })
    expect(waiting.state).toEqual({ phase: 'waiting', turn: 3 })
    const tool = transitionTurnLifecycle(waiting.state, { type: 'tool' })
    expect(tool.state).toEqual({ phase: 'tool', turn: 3 })
    expect(transitionTurnLifecycle(tool.state, { type: 'wait' }).state)
      .toEqual({ phase: 'waiting', turn: 3 })
    const streaming = transitionTurnLifecycle(tool.state, { type: 'stream' })
    expect(streaming.state).toEqual({ phase: 'streaming', turn: 3 })
    expect(transitionTurnLifecycle(streaming.state, { type: 'tool' }).state)
      .toEqual({ phase: 'tool', turn: 3 })
    const cancelling = transitionTurnLifecycle(streaming.state, {
      type: 'cancel', reason: 'user',
    })
    expect(cancelling).toEqual({
      state: { phase: 'cancelling', turn: 3, reason: 'user' },
      effects: [{ type: 'cancel-turn', turn: 3, reason: 'user' }],
    })
    const settled = transitionTurnLifecycle(cancelling.state, { type: 'cancelled' })
    expect(settled.state).toEqual({
      phase: 'settled', turn: 3, result: { status: 'cancelled' },
    })
    expect(transitionTurnLifecycle(settled.state, { type: 'reset' }))
      .toEqual({ state: { phase: 'ready' }, effects: [] })
  })

  it('settles an active or cancelling turn when completion wins the race', () => {
    for (const state of [
      { phase: 'submitted', turn: 1 },
      { phase: 'waiting', turn: 2 },
      { phase: 'tool', turn: 3 },
      { phase: 'streaming', turn: 4 },
      { phase: 'cancelling', turn: 5, reason: 'user' },
    ] as const) {
      expect(transitionTurnLifecycle(state, { type: 'complete' }).state).toEqual({
        phase: 'settled', turn: state.turn, result: { status: 'completed' },
      })
    }
    expect(transitionTurnLifecycle(
      { phase: 'waiting', turn: 2 },
      { type: 'stream' },
    ).state).toEqual({ phase: 'streaming', turn: 2 })
  })

  it('settles failures and no-ops invalid events', () => {
    const failure = new Error('turn')
    for (const state of [
      { phase: 'submitted', turn: 1 },
      { phase: 'waiting', turn: 2 },
      { phase: 'tool', turn: 3 },
      { phase: 'streaming', turn: 4 },
      { phase: 'cancelling', turn: 5, reason: 'user' },
    ] as const) {
      expect(transitionTurnLifecycle(state, { type: 'fail', error: failure }).state)
        .toEqual({
          phase: 'settled',
          turn: state.turn,
          result: { status: 'failed', error: failure },
        })
    }

    const ready = createTurnLifecycleState()
    for (const event of [
      { type: 'accepted' },
      { type: 'tool' },
      { type: 'wait' },
      { type: 'stream' },
      { type: 'complete' },
      { type: 'cancel', reason: 'none' },
      { type: 'cancelled' },
      { type: 'fail', error: 'none' },
      { type: 'reset' },
    ] as const) {
      expect(transitionTurnLifecycle(ready, event).state).toBe(ready)
    }
    expect(transitionTurnLifecycle(
      { phase: 'waiting', turn: 1 },
      { type: 'submit', turn: 2 },
    ).state).toEqual({ phase: 'waiting', turn: 1 })
    expect(() => transitionTurnLifecycle(
      ready,
      { type: 'unknown' } as unknown as TurnLifecycleEvent,
    )).toThrow('unknown lifecycle event')
  })
})

describe('resource lifecycle machine', () => {
  it('loads, refreshes with last-good data, and resolves the latest request', () => {
    const idle = createResourceLifecycleState(9)
    const loading = transitionResourceLifecycle(idle, { type: 'load', requestId: 1 })
    expect(loading).toEqual({
      state: { phase: 'loading', epoch: 9, requestId: 1 },
      effects: [{ type: 'load-resource', requestId: 1 }],
    })
    const ready = transitionResourceLifecycle(loading.state, {
      type: 'resolved', requestId: 1,
    })
    expect(ready.state).toEqual({ phase: 'ready', epoch: 9, requestId: 1 })
    const refreshing = transitionResourceLifecycle(ready.state, {
      type: 'load', requestId: 2,
    })
    expect(refreshing.state).toEqual({ phase: 'refreshing', epoch: 9, requestId: 2 })
    expect(transitionResourceLifecycle(refreshing.state, {
      type: 'resolved', requestId: 2,
    }).state).toEqual({ phase: 'ready', epoch: 9, requestId: 2 })
  })

  it('cancels superseded requests and rejects stale completions as no-ops', () => {
    const loading = { phase: 'loading', epoch: 2, requestId: 1 } as const
    const latest = transitionResourceLifecycle(loading, { type: 'load', requestId: 2 })
    expect(latest).toEqual({
      state: { phase: 'loading', epoch: 2, requestId: 2 },
      effects: [
        { type: 'cancel-resource-load', requestId: 1 },
        { type: 'load-resource', requestId: 2 },
      ],
    })
    expect(transitionResourceLifecycle(latest.state, {
      type: 'resolved', requestId: 1,
    }).state).toBe(latest.state)
    expect(transitionResourceLifecycle(latest.state, {
      type: 'rejected', requestId: 1, error: 'old',
    }).state).toBe(latest.state)
    expect(transitionResourceLifecycle(latest.state, {
      type: 'load', requestId: 2,
    }).state).toBe(latest.state)

    const refreshing = { phase: 'refreshing', epoch: 2, requestId: 3 } as const
    expect(transitionResourceLifecycle(refreshing, {
      type: 'load', requestId: 4,
    })).toEqual({
      state: { phase: 'refreshing', epoch: 2, requestId: 4 },
      effects: [
        { type: 'cancel-resource-load', requestId: 3 },
        { type: 'load-resource', requestId: 4 },
      ],
    })
  })

  it('distinguishes failures with and without last-good data', () => {
    const firstError = new Error('initial')
    expect(transitionResourceLifecycle(
      { phase: 'loading', epoch: 1, requestId: 1 },
      { type: 'rejected', requestId: 1, error: firstError },
    ).state).toEqual({
      phase: 'failed', epoch: 1, requestId: 1, hasLastGood: false, error: firstError,
    })
    const refreshError = new Error('refresh')
    const failed = transitionResourceLifecycle(
      { phase: 'refreshing', epoch: 1, requestId: 2 },
      { type: 'rejected', requestId: 2, error: refreshError },
    )
    expect(failed.state).toEqual({
      phase: 'failed', epoch: 1, requestId: 2, hasLastGood: true, error: refreshError,
    })
    expect(transitionResourceLifecycle(failed.state, {
      type: 'load', requestId: 3,
    }).state).toEqual({ phase: 'refreshing', epoch: 1, requestId: 3 })
    expect(transitionResourceLifecycle(
      {
        phase: 'failed',
        epoch: 1,
        requestId: 2,
        hasLastGood: false,
        error: refreshError,
      },
      { type: 'load', requestId: 3 },
    ).state).toEqual({ phase: 'loading', epoch: 1, requestId: 3 })
  })

  it('cancels pending work on dispose and no-ops terminal or invalid events', () => {
    expect(transitionResourceLifecycle(
      { phase: 'loading', epoch: 1, requestId: 7 },
      { type: 'dispose', reason: 'surface closed' },
    )).toEqual({
      state: { phase: 'disposed', epoch: 1 },
      effects: [
        { type: 'cancel-resource-load', requestId: 7 },
        { type: 'dispose-resource', reason: 'surface closed' },
      ],
    })
    for (const state of [
      { phase: 'idle', epoch: 1 },
      { phase: 'ready', epoch: 1, requestId: 1 },
      { phase: 'failed', epoch: 1, requestId: 1, hasLastGood: false, error: 'x' },
    ] as const) {
      expect(transitionResourceLifecycle(state, { type: 'dispose', reason: 'close' }))
        .toEqual({
          state: { phase: 'disposed', epoch: 1 },
          effects: [{ type: 'dispose-resource', reason: 'close' }],
        })
    }
    const disposed = { phase: 'disposed', epoch: 1 } as const
    for (const event of [
      { type: 'load', requestId: 8 },
      { type: 'resolved', requestId: 8 },
      { type: 'rejected', requestId: 8, error: 'late' },
      { type: 'dispose', reason: 'again' },
    ] as const) {
      expect(transitionResourceLifecycle(disposed, event).state).toBe(disposed)
    }
    expect(transitionResourceLifecycle(
      { phase: 'ready', epoch: 1, requestId: 3 },
      { type: 'resolved', requestId: 3 },
    ).state).toEqual({ phase: 'ready', epoch: 1, requestId: 3 })
    expect(transitionResourceLifecycle(
      { phase: 'failed', epoch: 1, requestId: 3, hasLastGood: false, error: 'x' },
      { type: 'rejected', requestId: 3, error: 'again' },
    ).state.phase).toBe('failed')
    expect(() => transitionResourceLifecycle(
      disposed,
      { type: 'unknown' } as unknown as ResourceLifecycleEvent,
    )).toThrow('unknown lifecycle event')
  })
})
