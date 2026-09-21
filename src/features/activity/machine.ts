import {
  applyActivityCenterAction,
  createActivityCenterState,
  openActivityCenter,
  reconcileActivityCenter,
  rejectActivityCenter,
  resolveActivityCenter,
  selectActivityCenter,
  type ActivityCenterAction,
  type ActivityCenterState,
  type ActivityCenterView,
} from '../../activity/center.ts'
import type {
  SessionDelegationAction,
  SessionDelegationSnapshot,
} from '../../activity/delegation-port.ts'
import type {
  SessionJobAction,
  SessionJobsSnapshot,
} from '../../activity/port.ts'
import {
  detachDelegationSnapshot,
  detachJobsSnapshot,
} from './projectors.ts'

export const ACTIVITY_RESOURCE_ID = 'activity.snapshots'

export type ActivityRefreshPhase = 'idle' | 'refreshing' | 'failed'

export interface ActivityFeatureState {
  readonly center: ActivityCenterState
  readonly jobs: SessionJobsSnapshot
  readonly delegation: SessionDelegationSnapshot
  readonly refresh: ActivityRefreshPhase
  readonly feedError?: string
}

export type ActivityFeatureEvent =
  | { readonly type: 'surface.opened' }
  | { readonly type: 'surface.closed' }
  | { readonly type: 'jobs.changed'; readonly snapshot: SessionJobsSnapshot }
  | {
      readonly type: 'delegation.changed'
      readonly snapshot: SessionDelegationSnapshot
    }
  | { readonly type: 'feed.failed'; readonly message: string }
  | { readonly type: 'center.action'; readonly action: ActivityCenterAction }
  | { readonly type: 'refresh.started' }
  | { readonly type: 'refresh.succeeded' }
  | { readonly type: 'refresh.failed'; readonly message: string }
  | { readonly type: 'refresh.duplicated' }
  | { readonly type: 'stop.resolved'; readonly message: string }
  | { readonly type: 'stop.rejected'; readonly message: string }

export type ActivityFeatureEffect =
  | {
      readonly type: 'job.action'
      readonly action: SessionJobAction
      readonly successMessage: string
    }
  | {
      readonly type: 'delegation.action'
      readonly action: SessionDelegationAction
      readonly successMessage: string
    }
  | { readonly type: 'delegation.refresh' }
  | { readonly type: 'delegation.refresh-cancel' }

export interface ActivityFeatureTransition {
  readonly state: ActivityFeatureState
  readonly effects: readonly ActivityFeatureEffect[]
}

const NO_EFFECTS: readonly ActivityFeatureEffect[] = Object.freeze([])

const EMPTY_JOBS_SNAPSHOT: SessionJobsSnapshot = Object.freeze({
  available: false,
  generation: 0,
  jobs: Object.freeze([]),
})

const EMPTY_DELEGATION_SNAPSHOT: SessionDelegationSnapshot = Object.freeze({
  available: false,
  generation: 0,
  loading: false,
  subagentsAvailable: false,
  subagents: Object.freeze([]),
  workflows: Object.freeze([]),
})

function transition(
  state: ActivityFeatureState,
  effects: readonly ActivityFeatureEffect[] = NO_EFFECTS,
): ActivityFeatureTransition {
  return Object.freeze({ state, effects: Object.freeze([...effects]) })
}

function unchanged(state: ActivityFeatureState): ActivityFeatureTransition {
  return Object.freeze({ state, effects: NO_EFFECTS })
}

function withSnapshots(
  state: ActivityFeatureState,
  jobs: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
): ActivityFeatureState {
  return Object.freeze({
    center: reconcileActivityCenter(state.center, jobs, delegation),
    jobs,
    delegation,
    refresh: state.refresh,
  })
}

/* v8 ignore next 3 -- exported discriminated unions are exhausted below. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Activity Feature value: ${String(value)}`)
}

export function createActivityFeatureState(): ActivityFeatureState {
  return Object.freeze({
    center: createActivityCenterState(),
    jobs: EMPTY_JOBS_SNAPSHOT,
    delegation: EMPTY_DELEGATION_SNAPSHOT,
    refresh: 'idle',
  })
}

/** Read-only projection of the embedded pure Activity Center machine. */
export function projectActivityCenter(
  state: ActivityFeatureState,
): ActivityCenterView | undefined {
  return selectActivityCenter(state.center, state.jobs, state.delegation)
}

export function transitionActivityFeature(
  state: ActivityFeatureState,
  event: ActivityFeatureEvent,
): ActivityFeatureTransition {
  switch (event.type) {
    case 'surface.opened': {
      if (state.center.open) return unchanged(state)
      const center = openActivityCenter(state.center, state.jobs, state.delegation)
      const prewarm = state.delegation.subagentsAvailable
        && !state.delegation.loading
        && state.delegation.subagents.length === 0
      const { feedError: _cleared, ...rest } = state
      return transition(
        Object.freeze({ ...rest, center }),
        prewarm ? [Object.freeze({ type: 'delegation.refresh' as const })] : NO_EFFECTS,
      )
    }
    case 'surface.closed': {
      if (!state.center.open && state.refresh === 'idle' && state.feedError === undefined) {
        return unchanged(state)
      }
      const next: ActivityFeatureState = Object.freeze({
        center: createActivityCenterState(),
        jobs: state.jobs,
        delegation: state.delegation,
        refresh: 'idle',
      })
      return transition(
        next,
        state.refresh === 'refreshing'
          ? [Object.freeze({ type: 'delegation.refresh-cancel' as const })]
          : NO_EFFECTS,
      )
    }
    case 'jobs.changed':
      return transition(withSnapshots(
        state,
        detachJobsSnapshot(event.snapshot),
        state.delegation,
      ))
    case 'delegation.changed':
      return transition(withSnapshots(
        state,
        state.jobs,
        detachDelegationSnapshot(event.snapshot),
      ))
    case 'feed.failed':
      return transition(Object.freeze({ ...state, feedError: event.message }))
    case 'center.action': {
      const result = applyActivityCenterAction(
        state.center,
        state.jobs,
        state.delegation,
        event.action,
      )
      const next = result.state === state.center
        ? state
        : Object.freeze({ ...state, center: result.state })
      const outcome = result.outcome
      if (outcome === undefined || outcome.kind === 'cancelled') return transition(next)
      if (outcome.kind === 'refresh-delegation') {
        return transition(next, [Object.freeze({ type: 'delegation.refresh' as const })])
      }
      if (outcome.kind === 'job-action') {
        return transition(next, [Object.freeze({
          type: 'job.action' as const,
          action: outcome.action,
          successMessage: outcome.successMessage,
        })])
      }
      return transition(next, [Object.freeze({
        type: 'delegation.action' as const,
        action: outcome.action,
        successMessage: outcome.successMessage,
      })])
    }
    case 'refresh.started':
      return state.refresh === 'refreshing'
        ? unchanged(state)
        : transition(Object.freeze({ ...state, refresh: 'refreshing' }))
    case 'refresh.succeeded':
      return state.refresh === 'idle'
        ? unchanged(state)
        : transition(Object.freeze({ ...state, refresh: 'idle' }))
    case 'refresh.failed':
      return transition(Object.freeze({
        ...state,
        refresh: 'failed',
        center: rejectActivityCenter(
          state.center,
          `Subagent refresh failed: ${event.message}`,
        ),
      }))
    case 'refresh.duplicated':
      return transition(Object.freeze({
        ...state,
        center: resolveActivityCenter(
          state.center,
          'Subagent catalog refresh is already running.',
        ),
      }))
    case 'stop.resolved':
      return transition(Object.freeze({
        ...state,
        center: resolveActivityCenter(state.center, event.message),
      }))
    case 'stop.rejected':
      return transition(Object.freeze({
        ...state,
        center: rejectActivityCenter(state.center, event.message),
      }))
    /* v8 ignore next 2 -- ActivityFeatureEvent is exhausted above. */
    default:
      return assertNever(event)
  }
}
