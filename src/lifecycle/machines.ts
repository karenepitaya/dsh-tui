export interface LifecycleTransition<State, Effect> {
  readonly state: State
  readonly effects: readonly Effect[]
}

function unchanged<State, Effect>(state: State): LifecycleTransition<State, Effect> {
  return { state, effects: [] }
}

function unknownLifecycleEvent(event: never): never {
  throw new Error(`unknown lifecycle event: ${String((event as { type?: unknown }).type)}`)
}

export type ApplicationLifecycleState =
  | { readonly phase: 'booting' }
  | { readonly phase: 'running' }
  | { readonly phase: 'stopping'; readonly reason: unknown }
  | { readonly phase: 'stopped' }
  | { readonly phase: 'failed'; readonly error: unknown }

export type ApplicationLifecycleEvent =
  | { readonly type: 'boot' }
  | { readonly type: 'ready' }
  | { readonly type: 'stop'; readonly reason: unknown }
  | { readonly type: 'stopped' }
  | { readonly type: 'fail'; readonly error: unknown }

export type ApplicationLifecycleEffect =
  | { readonly type: 'boot-application' }
  | { readonly type: 'dispose-application'; readonly reason: unknown }

export function createApplicationLifecycleState(): ApplicationLifecycleState {
  return { phase: 'stopped' }
}

export function transitionApplicationLifecycle(
  state: ApplicationLifecycleState,
  event: ApplicationLifecycleEvent,
): LifecycleTransition<ApplicationLifecycleState, ApplicationLifecycleEffect> {
  switch (event.type) {
    case 'boot':
      if (state.phase !== 'stopped') return unchanged(state)
      return {
        state: { phase: 'booting' },
        effects: [{ type: 'boot-application' }],
      }
    case 'ready':
      if (state.phase !== 'booting') return unchanged(state)
      return { state: { phase: 'running' }, effects: [] }
    case 'stop':
      if (state.phase !== 'booting' && state.phase !== 'running') return unchanged(state)
      return {
        state: { phase: 'stopping', reason: event.reason },
        effects: [{ type: 'dispose-application', reason: event.reason }],
      }
    case 'stopped':
      if (state.phase !== 'stopping' && state.phase !== 'failed') return unchanged(state)
      return { state: { phase: 'stopped' }, effects: [] }
    case 'fail':
      if (state.phase === 'stopping') {
        return { state: { phase: 'failed', error: event.error }, effects: [] }
      }
      if (state.phase !== 'booting' && state.phase !== 'running') return unchanged(state)
      return {
        state: { phase: 'failed', error: event.error },
        effects: [{ type: 'dispose-application', reason: event.error }],
      }
    default:
      return unknownLifecycleEvent(event)
  }
}

export type SessionLifecycleState =
  | { readonly phase: 'closed' }
  | { readonly phase: 'opening'; readonly sessionId: string }
  | { readonly phase: 'hydrating'; readonly sessionId: string; readonly epoch: number }
  | { readonly phase: 'ready'; readonly sessionId: string; readonly epoch: number }
  | {
    readonly phase: 'switching'
    readonly sessionId: string
    readonly previousSessionId: string
    readonly epoch: number
  }
  | { readonly phase: 'closing'; readonly sessionId: string; readonly reason: unknown }
  | { readonly phase: 'failed'; readonly sessionId: string; readonly error: unknown }

type OwnedSessionLifecycleState = Extract<
  SessionLifecycleState,
  { readonly phase: 'opening' | 'hydrating' | 'ready' | 'switching' }
>

const OWNED_SESSION_PHASES: readonly SessionLifecycleState['phase'][] = [
  'opening',
  'hydrating',
  'ready',
  'switching',
]

function isOwnedSessionState(state: SessionLifecycleState): state is OwnedSessionLifecycleState {
  return OWNED_SESSION_PHASES.includes(state.phase)
}

export type SessionLifecycleEvent =
  | { readonly type: 'open'; readonly sessionId: string }
  | { readonly type: 'opened'; readonly epoch: number }
  | { readonly type: 'hydrated' }
  | { readonly type: 'switch'; readonly targetSessionId: string }
  | { readonly type: 'switched'; readonly epoch: number }
  | { readonly type: 'close'; readonly reason: unknown }
  | { readonly type: 'closed' }
  | { readonly type: 'fail'; readonly error: unknown }

export type SessionLifecycleEffect =
  | { readonly type: 'open-session'; readonly sessionId: string }
  | { readonly type: 'hydrate-session'; readonly sessionId: string }
  | {
    readonly type: 'switch-session'
    readonly previousSessionId: string
    readonly sessionId: string
  }
  | { readonly type: 'close-session'; readonly sessionId: string; readonly reason: unknown }

export function createSessionLifecycleState(): SessionLifecycleState {
  return { phase: 'closed' }
}

export function transitionSessionLifecycle(
  state: SessionLifecycleState,
  event: SessionLifecycleEvent,
): LifecycleTransition<SessionLifecycleState, SessionLifecycleEffect> {
  switch (event.type) {
    case 'open':
      if (state.phase !== 'closed') return unchanged(state)
      return {
        state: { phase: 'opening', sessionId: event.sessionId },
        effects: [{ type: 'open-session', sessionId: event.sessionId }],
      }
    case 'opened':
      if (state.phase !== 'opening') return unchanged(state)
      return {
        state: { phase: 'hydrating', sessionId: state.sessionId, epoch: event.epoch },
        effects: [{ type: 'hydrate-session', sessionId: state.sessionId }],
      }
    case 'hydrated':
      if (state.phase !== 'hydrating') return unchanged(state)
      return {
        state: { phase: 'ready', sessionId: state.sessionId, epoch: state.epoch },
        effects: [],
      }
    case 'switch':
      if (state.phase !== 'ready') return unchanged(state)
      return {
        state: {
          phase: 'switching',
          sessionId: event.targetSessionId,
          previousSessionId: state.sessionId,
          epoch: state.epoch,
        },
        effects: [{
          type: 'switch-session',
          previousSessionId: state.sessionId,
          sessionId: event.targetSessionId,
        }],
      }
    case 'switched':
      if (state.phase !== 'switching') return unchanged(state)
      return {
        state: { phase: 'hydrating', sessionId: state.sessionId, epoch: event.epoch },
        effects: [{ type: 'hydrate-session', sessionId: state.sessionId }],
      }
    case 'close':
      if (!isOwnedSessionState(state)) return unchanged(state)
      return {
        state: { phase: 'closing', sessionId: state.sessionId, reason: event.reason },
        effects: [{ type: 'close-session', sessionId: state.sessionId, reason: event.reason }],
      }
    case 'closed':
      if (state.phase !== 'closing' && state.phase !== 'failed') return unchanged(state)
      return { state: { phase: 'closed' }, effects: [] }
    case 'fail':
      if (isOwnedSessionState(state)) {
        return {
          state: { phase: 'failed', sessionId: state.sessionId, error: event.error },
          effects: [{
            type: 'close-session',
            sessionId: state.sessionId,
            reason: event.error,
          }],
        }
      }
      if (state.phase !== 'closing') return unchanged(state)
      return {
        state: { phase: 'failed', sessionId: state.sessionId, error: event.error },
        effects: [],
      }
    default:
      return unknownLifecycleEvent(event)
  }
}

export type FeatureLifecycleState =
  | { readonly phase: 'registered'; readonly featureId: string }
  | { readonly phase: 'inactive'; readonly featureId: string }
  | { readonly phase: 'activating'; readonly featureId: string }
  | { readonly phase: 'active'; readonly featureId: string }
  | { readonly phase: 'suspended'; readonly featureId: string }
  | { readonly phase: 'disposing'; readonly featureId: string; readonly reason: unknown }
  | { readonly phase: 'disposed'; readonly featureId: string }
  | { readonly phase: 'failed'; readonly featureId: string; readonly error: unknown }

type OwnedFeatureLifecycleState = Extract<
  FeatureLifecycleState,
  { readonly phase: 'registered' | 'inactive' | 'activating' | 'active' | 'suspended' | 'failed' }
>

type RunningFeatureLifecycleState = Extract<
  FeatureLifecycleState,
  { readonly phase: 'activating' | 'active' | 'suspended' }
>

const OWNED_FEATURE_PHASES: readonly FeatureLifecycleState['phase'][] = [
  'registered',
  'inactive',
  'activating',
  'active',
  'suspended',
  'failed',
]

const RUNNING_FEATURE_PHASES: readonly FeatureLifecycleState['phase'][] = [
  'activating',
  'active',
  'suspended',
]

function isOwnedFeatureState(state: FeatureLifecycleState): state is OwnedFeatureLifecycleState {
  return OWNED_FEATURE_PHASES.includes(state.phase)
}

function isRunningFeatureState(state: FeatureLifecycleState): state is RunningFeatureLifecycleState {
  return RUNNING_FEATURE_PHASES.includes(state.phase)
}

export type FeatureLifecycleEvent =
  | { readonly type: 'mount' }
  | { readonly type: 'activate' }
  | { readonly type: 'activated' }
  | { readonly type: 'suspend' }
  | { readonly type: 'resume' }
  | { readonly type: 'dispose'; readonly reason: unknown }
  | { readonly type: 'disposed' }
  | { readonly type: 'fail'; readonly error: unknown }

export type FeatureLifecycleEffect =
  | { readonly type: 'activate-feature'; readonly featureId: string }
  | { readonly type: 'suspend-feature'; readonly featureId: string }
  | { readonly type: 'resume-feature'; readonly featureId: string }
  | { readonly type: 'dispose-feature'; readonly featureId: string; readonly reason: unknown }

export function createFeatureLifecycleState(featureId: string): FeatureLifecycleState {
  return { phase: 'registered', featureId }
}

export function transitionFeatureLifecycle(
  state: FeatureLifecycleState,
  event: FeatureLifecycleEvent,
): LifecycleTransition<FeatureLifecycleState, FeatureLifecycleEffect> {
  switch (event.type) {
    case 'mount':
      if (state.phase !== 'registered') return unchanged(state)
      return { state: { phase: 'inactive', featureId: state.featureId }, effects: [] }
    case 'activate':
      if (state.phase !== 'inactive') return unchanged(state)
      return {
        state: { phase: 'activating', featureId: state.featureId },
        effects: [{ type: 'activate-feature', featureId: state.featureId }],
      }
    case 'activated':
      if (state.phase !== 'activating') return unchanged(state)
      return { state: { phase: 'active', featureId: state.featureId }, effects: [] }
    case 'suspend':
      if (state.phase !== 'active') return unchanged(state)
      return {
        state: { phase: 'suspended', featureId: state.featureId },
        effects: [{ type: 'suspend-feature', featureId: state.featureId }],
      }
    case 'resume':
      if (state.phase !== 'suspended') return unchanged(state)
      return {
        state: { phase: 'active', featureId: state.featureId },
        effects: [{ type: 'resume-feature', featureId: state.featureId }],
      }
    case 'dispose':
      if (!isOwnedFeatureState(state)) return unchanged(state)
      return {
        state: { phase: 'disposing', featureId: state.featureId, reason: event.reason },
        effects: [{
          type: 'dispose-feature',
          featureId: state.featureId,
          reason: event.reason,
        }],
      }
    case 'disposed':
      if (state.phase !== 'disposing' && state.phase !== 'failed') return unchanged(state)
      return { state: { phase: 'disposed', featureId: state.featureId }, effects: [] }
    case 'fail':
      if (isRunningFeatureState(state)) {
        return {
          state: { phase: 'failed', featureId: state.featureId, error: event.error },
          effects: [{
            type: 'dispose-feature',
            featureId: state.featureId,
            reason: event.error,
          }],
        }
      }
      if (state.phase !== 'disposing') return unchanged(state)
      return {
        state: { phase: 'failed', featureId: state.featureId, error: event.error },
        effects: [],
      }
    default:
      return unknownLifecycleEvent(event)
  }
}

export type TurnLifecycleState =
  | { readonly phase: 'ready' }
  | { readonly phase: 'submitted'; readonly turn: number }
  | { readonly phase: 'waiting'; readonly turn: number }
  | { readonly phase: 'tool'; readonly turn: number }
  | { readonly phase: 'streaming'; readonly turn: number }
  | { readonly phase: 'cancelling'; readonly turn: number; readonly reason: unknown }
  | { readonly phase: 'settled'; readonly turn: number; readonly result: TurnSettlement }

export type TurnSettlement =
  | { readonly status: 'completed' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly error: unknown }

type PendingTurnLifecycleState = Extract<
  TurnLifecycleState,
  { readonly phase: 'submitted' | 'waiting' | 'tool' | 'streaming' | 'cancelling' }
>

type CancellableTurnLifecycleState = Extract<
  TurnLifecycleState,
  { readonly phase: 'submitted' | 'waiting' | 'tool' | 'streaming' }
>

const PENDING_TURN_PHASES: readonly TurnLifecycleState['phase'][] = [
  'submitted',
  'waiting',
  'tool',
  'streaming',
  'cancelling',
]

const CANCELLABLE_TURN_PHASES: readonly TurnLifecycleState['phase'][] = [
  'submitted',
  'waiting',
  'tool',
  'streaming',
]

function isPendingTurnState(state: TurnLifecycleState): state is PendingTurnLifecycleState {
  return PENDING_TURN_PHASES.includes(state.phase)
}

function isCancellableTurnState(state: TurnLifecycleState): state is CancellableTurnLifecycleState {
  return CANCELLABLE_TURN_PHASES.includes(state.phase)
}

export type TurnLifecycleEvent =
  | { readonly type: 'submit'; readonly turn: number }
  | { readonly type: 'accepted' }
  | { readonly type: 'tool' }
  | { readonly type: 'wait' }
  | { readonly type: 'stream' }
  | { readonly type: 'complete' }
  | { readonly type: 'cancel'; readonly reason: unknown }
  | { readonly type: 'cancelled' }
  | { readonly type: 'fail'; readonly error: unknown }
  | { readonly type: 'reset' }

export type TurnLifecycleEffect =
  | { readonly type: 'submit-turn'; readonly turn: number }
  | { readonly type: 'cancel-turn'; readonly turn: number; readonly reason: unknown }

export function createTurnLifecycleState(): TurnLifecycleState {
  return { phase: 'ready' }
}

export function transitionTurnLifecycle(
  state: TurnLifecycleState,
  event: TurnLifecycleEvent,
): LifecycleTransition<TurnLifecycleState, TurnLifecycleEffect> {
  switch (event.type) {
    case 'submit':
      if (state.phase !== 'ready') return unchanged(state)
      return {
        state: { phase: 'submitted', turn: event.turn },
        effects: [{ type: 'submit-turn', turn: event.turn }],
      }
    case 'accepted':
      if (state.phase !== 'submitted') return unchanged(state)
      return { state: { phase: 'waiting', turn: state.turn }, effects: [] }
    case 'tool':
      if (state.phase !== 'waiting' && state.phase !== 'streaming') return unchanged(state)
      return { state: { phase: 'tool', turn: state.turn }, effects: [] }
    case 'wait':
      if (state.phase !== 'tool') return unchanged(state)
      return { state: { phase: 'waiting', turn: state.turn }, effects: [] }
    case 'stream':
      if (state.phase !== 'waiting' && state.phase !== 'tool') return unchanged(state)
      return { state: { phase: 'streaming', turn: state.turn }, effects: [] }
    case 'complete':
      if (!isPendingTurnState(state)) return unchanged(state)
      return {
        state: { phase: 'settled', turn: state.turn, result: { status: 'completed' } },
        effects: [],
      }
    case 'cancel':
      if (!isCancellableTurnState(state)) return unchanged(state)
      return {
        state: { phase: 'cancelling', turn: state.turn, reason: event.reason },
        effects: [{ type: 'cancel-turn', turn: state.turn, reason: event.reason }],
      }
    case 'cancelled':
      if (state.phase !== 'cancelling') return unchanged(state)
      return {
        state: { phase: 'settled', turn: state.turn, result: { status: 'cancelled' } },
        effects: [],
      }
    case 'fail':
      if (!isPendingTurnState(state)) return unchanged(state)
      return {
        state: {
          phase: 'settled',
          turn: state.turn,
          result: { status: 'failed', error: event.error },
        },
        effects: [],
      }
    case 'reset':
      if (state.phase !== 'settled') return unchanged(state)
      return { state: { phase: 'ready' }, effects: [] }
    default:
      return unknownLifecycleEvent(event)
  }
}

export type ResourceLifecycleState =
  | { readonly phase: 'idle'; readonly epoch: number }
  | { readonly phase: 'loading'; readonly epoch: number; readonly requestId: number }
  | { readonly phase: 'ready'; readonly epoch: number; readonly requestId: number }
  | { readonly phase: 'refreshing'; readonly epoch: number; readonly requestId: number }
  | {
    readonly phase: 'failed'
    readonly epoch: number
    readonly requestId: number
    readonly hasLastGood: boolean
    readonly error: unknown
  }
  | { readonly phase: 'disposed'; readonly epoch: number }

type PendingResourceLifecycleState = Extract<
  ResourceLifecycleState,
  { readonly phase: 'loading' | 'refreshing' }
>

const PENDING_RESOURCE_PHASES: readonly ResourceLifecycleState['phase'][] = [
  'loading',
  'refreshing',
]

function isPendingResourceState(
  state: ResourceLifecycleState,
): state is PendingResourceLifecycleState {
  return PENDING_RESOURCE_PHASES.includes(state.phase)
}

export type ResourceLifecycleEvent =
  | { readonly type: 'load'; readonly requestId: number }
  | { readonly type: 'resolved'; readonly requestId: number }
  | { readonly type: 'rejected'; readonly requestId: number; readonly error: unknown }
  | { readonly type: 'dispose'; readonly reason: unknown }

export type ResourceLifecycleEffect =
  | { readonly type: 'load-resource'; readonly requestId: number }
  | { readonly type: 'cancel-resource-load'; readonly requestId: number }
  | { readonly type: 'dispose-resource'; readonly reason: unknown }

export function createResourceLifecycleState(epoch: number): ResourceLifecycleState {
  return { phase: 'idle', epoch }
}

export function transitionResourceLifecycle(
  state: ResourceLifecycleState,
  event: ResourceLifecycleEvent,
): LifecycleTransition<ResourceLifecycleState, ResourceLifecycleEffect> {
  switch (event.type) {
    case 'load': {
      if (state.phase === 'disposed') return unchanged(state)
      if (state.phase === 'idle') {
        return {
          state: { phase: 'loading', epoch: state.epoch, requestId: event.requestId },
          effects: [{ type: 'load-resource', requestId: event.requestId }],
        }
      }
      if (event.requestId <= state.requestId) return unchanged(state)
      if (state.phase === 'ready') {
        return {
          state: { phase: 'refreshing', epoch: state.epoch, requestId: event.requestId },
          effects: [{ type: 'load-resource', requestId: event.requestId }],
        }
      }
      if (state.phase === 'failed') {
        return {
          state: {
            phase: state.hasLastGood ? 'refreshing' : 'loading',
            epoch: state.epoch,
            requestId: event.requestId,
          },
          effects: [{ type: 'load-resource', requestId: event.requestId }],
        }
      }
      return {
        state: { phase: state.phase, epoch: state.epoch, requestId: event.requestId },
        effects: [
          { type: 'cancel-resource-load', requestId: state.requestId },
          { type: 'load-resource', requestId: event.requestId },
        ],
      }
    }
    case 'resolved':
      if (!isPendingResourceState(state) || event.requestId !== state.requestId) {
        return unchanged(state)
      }
      return {
        state: { phase: 'ready', epoch: state.epoch, requestId: state.requestId },
        effects: [],
      }
    case 'rejected':
      if (!isPendingResourceState(state) || event.requestId !== state.requestId) {
        return unchanged(state)
      }
      return {
        state: {
          phase: 'failed',
          epoch: state.epoch,
          requestId: state.requestId,
          hasLastGood: state.phase === 'refreshing',
          error: event.error,
        },
        effects: [],
      }
    case 'dispose':
      if (state.phase === 'disposed') return unchanged(state)
      if (isPendingResourceState(state)) {
        return {
          state: { phase: 'disposed', epoch: state.epoch },
          effects: [
            { type: 'cancel-resource-load', requestId: state.requestId },
            { type: 'dispose-resource', reason: event.reason },
          ],
        }
      }
      return {
        state: { phase: 'disposed', epoch: state.epoch },
        effects: [{ type: 'dispose-resource', reason: event.reason }],
      }
    default:
      return unknownLifecycleEvent(event)
  }
}
