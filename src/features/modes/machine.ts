import type { SessionModeSnapshot } from '../../mode/port.ts'
import {
  detachModesSnapshot,
  projectModesChoices,
  type ModesChoice,
} from './projectors.ts'

export type ModesFeaturePhase = 'idle' | 'loading' | 'ready' | 'refreshing' | 'failed'

export interface ModesRequestStamp {
  readonly scopeEpoch: number
  readonly requestId: number
}

export interface ModesFeatureState {
  readonly phase: ModesFeaturePhase
  readonly selectedIndex: number
  readonly selectedModeId?: string
  readonly snapshot?: SessionModeSnapshot
  readonly request?: ModesRequestStamp
  readonly selecting: boolean
  readonly selectionRequestId?: number
  readonly pendingModeId?: string
  readonly error?: string
}

export type ModesFeatureEvent =
  | { readonly type: 'load.started'; readonly request: ModesRequestStamp }
  | {
      readonly type: 'load.succeeded'
      readonly request: ModesRequestStamp
      readonly snapshot: SessionModeSnapshot
    }
  | { readonly type: 'load.failed'; readonly request: ModesRequestStamp; readonly message: string }
  | { readonly type: 'refresh.requested' }
  | { readonly type: 'snapshot.changed'; readonly snapshot: SessionModeSnapshot }
  | { readonly type: 'snapshot.failed'; readonly message: string }
  | { readonly type: 'selection.move'; readonly direction: 'up' | 'down' }
  | { readonly type: 'selection.blocked'; readonly message: string }
  | { readonly type: 'selection.started'; readonly requestId: number; readonly modeId: string }
  | {
      readonly type: 'selection.succeeded'
      readonly requestId: number
      readonly snapshot: SessionModeSnapshot
    }
  | {
      readonly type: 'selection.failed'
      readonly requestId: number
      readonly message: string
      readonly snapshot?: SessionModeSnapshot
    }

export type ModesFeatureEffect = {
  readonly type: 'resource.refresh'
  readonly resourceId: 'modes.catalog'
}

export interface ModesFeatureTransition {
  readonly state: ModesFeatureState
  readonly effects: readonly ModesFeatureEffect[]
}

interface StateShape {
  phase: ModesFeaturePhase
  selectedIndex: number
  selectedModeId: string | undefined
  snapshot: SessionModeSnapshot | undefined
  request: ModesRequestStamp | undefined
  selecting: boolean
  selectionRequestId: number | undefined
  pendingModeId: string | undefined
  error: string | undefined
}

const NO_EFFECTS: readonly ModesFeatureEffect[] = Object.freeze([])

function shapeOf(state: ModesFeatureState): StateShape {
  return {
    phase: state.phase,
    selectedIndex: state.selectedIndex,
    selectedModeId: state.selectedModeId,
    snapshot: state.snapshot,
    request: state.request,
    selecting: state.selecting,
    selectionRequestId: state.selectionRequestId,
    pendingModeId: state.pendingModeId,
    error: state.error,
  }
}

function freezeState(shape: StateShape): ModesFeatureState {
  const request = shape.request === undefined
    ? undefined
    : Object.freeze({ ...shape.request })
  return Object.freeze({
    phase: shape.phase,
    selectedIndex: shape.selectedIndex,
    ...(shape.selectedModeId === undefined ? {} : { selectedModeId: shape.selectedModeId }),
    ...(shape.snapshot === undefined ? {} : { snapshot: shape.snapshot }),
    ...(request === undefined ? {} : { request }),
    selecting: shape.selecting,
    ...(shape.selectionRequestId === undefined
      ? {}
      : { selectionRequestId: shape.selectionRequestId }),
    ...(shape.pendingModeId === undefined ? {} : { pendingModeId: shape.pendingModeId }),
    ...(shape.error === undefined ? {} : { error: shape.error }),
  })
}

function changed(
  state: ModesFeatureState,
  patch: Partial<StateShape>,
  effects: readonly ModesFeatureEffect[] = NO_EFFECTS,
): ModesFeatureTransition {
  return Object.freeze({
    state: freezeState({ ...shapeOf(state), ...patch }),
    effects: Object.freeze([...effects]),
  })
}

function unchanged(state: ModesFeatureState): ModesFeatureTransition {
  return Object.freeze({ state, effects: NO_EFFECTS })
}

function sameRequest(
  left: ModesRequestStamp | undefined,
  right: ModesRequestStamp,
): boolean {
  return left?.scopeEpoch === right.scopeEpoch && left.requestId === right.requestId
}

function preferredIndex(choices: readonly ModesChoice[], snapshot: SessionModeSnapshot): number {
  const current = choices.findIndex(choice => choice.id === snapshot.current)
  if (current >= 0) return current
  const defaultChoice = choices.findIndex(choice => (
    choice.id === snapshot.defaultId && choice.broken === undefined
  ))
  if (defaultChoice >= 0) return defaultChoice
  const healthy = choices.findIndex(choice => choice.broken === undefined)
  return healthy >= 0 ? healthy : choices.length === 0 ? -1 : 0
}

function reconciledSelection(
  selectedModeId: string | undefined,
  snapshot: SessionModeSnapshot,
): Pick<StateShape, 'selectedIndex' | 'selectedModeId'> {
  const choices = projectModesChoices(snapshot)
  const stable = selectedModeId === undefined
    ? -1
    : choices.findIndex(choice => choice.id === selectedModeId)
  const selectedIndex = stable >= 0 ? stable : preferredIndex(choices, snapshot)
  return { selectedIndex, selectedModeId: choices[selectedIndex]?.id }
}

export function createModesFeatureState(): ModesFeatureState {
  return freezeState({
    phase: 'idle',
    selectedIndex: -1,
    selectedModeId: undefined,
    snapshot: undefined,
    request: undefined,
    selecting: false,
    selectionRequestId: undefined,
    pendingModeId: undefined,
    error: undefined,
  })
}

export function selectedModesChoice(state: ModesFeatureState): ModesChoice | undefined {
  return projectModesChoices(state.snapshot)[state.selectedIndex]
}

export function transitionModesFeature(
  state: ModesFeatureState,
  event: ModesFeatureEvent,
): ModesFeatureTransition {
  switch (event.type) {
    case 'load.started':
      return changed(state, {
        phase: state.snapshot === undefined ? 'loading' : 'refreshing',
        request: event.request,
        error: undefined,
      })
    case 'load.succeeded': {
      if (!sameRequest(state.request, event.request)) return unchanged(state)
      const snapshot = detachModesSnapshot(event.snapshot)
      return changed(state, {
        phase: snapshot.error === undefined ? 'ready' : 'failed',
        snapshot,
        request: undefined,
        error: snapshot.error,
        ...reconciledSelection(state.selectedModeId, snapshot),
      })
    }
    case 'load.failed':
      return sameRequest(state.request, event.request)
        ? changed(state, { phase: 'failed', request: undefined, error: event.message })
        : unchanged(state)
    case 'refresh.requested':
      return changed(state, {}, [Object.freeze({
        type: 'resource.refresh',
        resourceId: 'modes.catalog',
      })])
    case 'snapshot.changed': {
      const snapshot = detachModesSnapshot(event.snapshot)
      const pending = state.phase === 'loading' || state.phase === 'refreshing'
      return changed(state, {
        phase: pending ? state.phase : snapshot.error === undefined ? 'ready' : 'failed',
        snapshot,
        error: pending ? state.error : snapshot.error,
        ...reconciledSelection(state.selectedModeId, snapshot),
      })
    }
    case 'snapshot.failed':
      return changed(state, { phase: 'failed', error: event.message })
    case 'selection.move': {
      const choices = projectModesChoices(state.snapshot)
      if (choices.length === 0) return unchanged(state)
      const delta = event.direction === 'up' ? -1 : 1
      const selectedIndex = Math.max(
        0,
        Math.min(choices.length - 1, state.selectedIndex + delta),
      )
      if (selectedIndex === state.selectedIndex) return unchanged(state)
      return changed(state, {
        selectedIndex,
        selectedModeId: choices[selectedIndex]!.id,
        error: undefined,
      })
    }
    case 'selection.blocked':
      return changed(state, { error: event.message })
    case 'selection.started':
      return changed(state, {
        selecting: true,
        selectionRequestId: event.requestId,
        pendingModeId: event.modeId,
        error: undefined,
      })
    case 'selection.succeeded': {
      if (state.selectionRequestId !== event.requestId) return unchanged(state)
      const snapshot = detachModesSnapshot(event.snapshot)
      return changed(state, {
        phase: snapshot.error === undefined ? 'ready' : 'failed',
        snapshot,
        selecting: false,
        selectionRequestId: undefined,
        pendingModeId: undefined,
        error: snapshot.error,
        ...reconciledSelection(state.selectedModeId, snapshot),
      })
    }
    case 'selection.failed': {
      if (state.selectionRequestId !== event.requestId) return unchanged(state)
      const snapshot = event.snapshot === undefined
        ? state.snapshot
        : detachModesSnapshot(event.snapshot)
      return changed(state, {
        phase: 'failed',
        snapshot,
        selecting: false,
        selectionRequestId: undefined,
        pendingModeId: undefined,
        error: event.message,
        ...(snapshot === undefined ? {} : reconciledSelection(state.selectedModeId, snapshot)),
      })
    }
    /* v8 ignore next 2 -- ModesFeatureEvent is exhausted above. */
    default:
      return assertNever(event)
  }
}

/* v8 ignore next 3 -- exported discriminated union is exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Modes Feature event: ${String(value)}`)
}

