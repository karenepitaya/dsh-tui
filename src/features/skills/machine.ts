import type { SessionSkillsSnapshot } from '../../skill/port.ts'
import {
  detachSkillsSnapshot,
  projectSkillsCatalog,
} from './projectors.ts'

export const SKILLS_RESOURCE_ID = 'skills.catalog'
export const SKILLS_DETAIL_ROUTE_ID = 'skills.detail'

export type SkillsFeaturePhase = 'idle' | 'loading' | 'refreshing' | 'ready' | 'failed'

export interface SkillsRequestStamp {
  readonly scopeEpoch: number
  readonly requestId: number
}

export interface SkillsFeatureState {
  readonly phase: SkillsFeaturePhase
  readonly query: string
  readonly selectedIndex: number
  readonly selectedName?: string
  readonly snapshot?: SessionSkillsSnapshot
  readonly request?: SkillsRequestStamp
  readonly error?: string
}

export type SkillsFeatureEvent =
  | { readonly type: 'load.started'; readonly request: SkillsRequestStamp }
  | {
      readonly type: 'load.succeeded'
      readonly request: SkillsRequestStamp
      readonly snapshot: SessionSkillsSnapshot
    }
  | {
      readonly type: 'load.failed'
      readonly request: SkillsRequestStamp
      readonly message: string
    }
  | { readonly type: 'snapshot.changed'; readonly snapshot: SessionSkillsSnapshot }
  | { readonly type: 'snapshot.failed'; readonly message: string }
  | { readonly type: 'query.changed'; readonly query: string }
  | {
      readonly type: 'selection.move'
      readonly direction: 'up' | 'down'
      readonly amount?: number
    }
  | { readonly type: 'selection.activated' }
  | { readonly type: 'refresh.requested' }

export type SkillsFeatureEffect =
  | { readonly type: 'resource.refresh'; readonly resourceId: typeof SKILLS_RESOURCE_ID }
  | { readonly type: 'route.open'; readonly routeId: typeof SKILLS_DETAIL_ROUTE_ID }

export interface SkillsFeatureTransition {
  readonly state: SkillsFeatureState
  readonly effects: readonly SkillsFeatureEffect[]
}

interface StateShape {
  phase: SkillsFeaturePhase
  query: string
  selectedIndex: number
  selectedName: string | undefined
  snapshot: SessionSkillsSnapshot | undefined
  request: SkillsRequestStamp | undefined
  error: string | undefined
}

const NO_EFFECTS: readonly SkillsFeatureEffect[] = Object.freeze([])

function shapeOf(state: SkillsFeatureState): StateShape {
  return {
    phase: state.phase,
    query: state.query,
    selectedIndex: state.selectedIndex,
    selectedName: state.selectedName,
    snapshot: state.snapshot,
    request: state.request,
    error: state.error,
  }
}

function freezeState(shape: StateShape): SkillsFeatureState {
  const request = shape.request === undefined
    ? undefined
    : Object.freeze({ ...shape.request })
  return Object.freeze({
    phase: shape.phase,
    query: shape.query,
    selectedIndex: shape.selectedIndex,
    ...(shape.selectedName === undefined ? {} : { selectedName: shape.selectedName }),
    ...(shape.snapshot === undefined ? {} : { snapshot: shape.snapshot }),
    ...(request === undefined ? {} : { request }),
    ...(shape.error === undefined ? {} : { error: shape.error }),
  })
}

function transition(
  state: SkillsFeatureState,
  patch: Partial<StateShape> = {},
  effects: readonly SkillsFeatureEffect[] = NO_EFFECTS,
): SkillsFeatureTransition {
  const next = Object.keys(patch).length === 0
    ? state
    : freezeState({ ...shapeOf(state), ...patch })
  return Object.freeze({ state: next, effects: Object.freeze([...effects]) })
}

function sameRequest(
  left: SkillsRequestStamp | undefined,
  right: SkillsRequestStamp,
): boolean {
  return left?.scopeEpoch === right.scopeEpoch && left.requestId === right.requestId
}

function reconcileSelection(
  selectedName: string | undefined,
  snapshot: SessionSkillsSnapshot | undefined,
  query: string,
): Pick<StateShape, 'selectedIndex' | 'selectedName'> {
  const rows = projectSkillsCatalog(snapshot, query).rows
  const stable = selectedName === undefined
    ? -1
    : rows.findIndex(entry => entry.name === selectedName)
  const selectedIndex = stable >= 0 ? stable : rows.length === 0 ? -1 : 0
  return { selectedIndex, selectedName: rows[selectedIndex]?.name }
}

export function createSkillsFeatureState(): SkillsFeatureState {
  return freezeState({
    phase: 'idle',
    query: '',
    selectedIndex: -1,
    selectedName: undefined,
    snapshot: undefined,
    request: undefined,
    error: undefined,
  })
}

export function selectedSkill(state: SkillsFeatureState) {
  return projectSkillsCatalog(state.snapshot, state.query).rows[state.selectedIndex]
}

export function transitionSkillsFeature(
  state: SkillsFeatureState,
  event: SkillsFeatureEvent,
): SkillsFeatureTransition {
  switch (event.type) {
    case 'load.started':
      return transition(state, {
        phase: state.snapshot === undefined ? 'loading' : 'refreshing',
        request: event.request,
        error: undefined,
      })
    case 'load.succeeded': {
      if (!sameRequest(state.request, event.request)) return transition(state)
      const snapshot = detachSkillsSnapshot(event.snapshot)
      return transition(state, {
        phase: snapshot.error === undefined ? 'ready' : 'failed',
        snapshot,
        request: undefined,
        error: snapshot.error,
        ...reconcileSelection(state.selectedName, snapshot, state.query),
      })
    }
    case 'load.failed':
      return sameRequest(state.request, event.request)
        ? transition(state, {
            phase: 'failed',
            request: undefined,
            error: event.message,
          })
        : transition(state)
    case 'snapshot.changed': {
      const snapshot = detachSkillsSnapshot(event.snapshot)
      const loading = state.phase === 'loading' || state.phase === 'refreshing'
      return transition(state, {
        phase: loading ? state.phase : snapshot.error === undefined ? 'ready' : 'failed',
        snapshot,
        error: loading ? state.error : snapshot.error,
        ...reconcileSelection(state.selectedName, snapshot, state.query),
      })
    }
    case 'snapshot.failed':
      return transition(state, { phase: 'failed', error: event.message })
    case 'query.changed':
      return event.query === state.query
        ? transition(state)
        : transition(state, {
            query: event.query,
            ...reconcileSelection(state.selectedName, state.snapshot, event.query),
          })
    case 'selection.move': {
      const rows = projectSkillsCatalog(state.snapshot, state.query).rows
      if (rows.length === 0) return transition(state)
      const requestedAmount = event.amount ?? 1
      const amount = Number.isFinite(requestedAmount)
        ? Math.max(1, Math.floor(requestedAmount))
        : 1
      const delta = event.direction === 'up' ? -amount : amount
      const selectedIndex = Math.max(
        0,
        Math.min(rows.length - 1, state.selectedIndex + delta),
      )
      if (selectedIndex === state.selectedIndex) return transition(state)
      return transition(state, {
        selectedIndex,
        selectedName: rows[selectedIndex]!.name,
      })
    }
    case 'selection.activated':
      return selectedSkill(state) === undefined
        ? transition(state)
        : transition(state, {}, [Object.freeze({
            type: 'route.open',
            routeId: SKILLS_DETAIL_ROUTE_ID,
          })])
    case 'refresh.requested':
      return transition(state, {}, [Object.freeze({
        type: 'resource.refresh',
        resourceId: SKILLS_RESOURCE_ID,
      })])
    /* v8 ignore next 2 -- SkillsFeatureEvent is exhausted above. */
    default:
      return assertNever(event)
  }
}

/* v8 ignore next 3 -- exported discriminated unions are exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Skills Feature event: ${String(value)}`)
}
