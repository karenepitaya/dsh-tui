import type { DshTuiModelSelection, SessionModelSnapshot } from '../../model/port.ts'
import type { SessionAgentStatusSnapshot } from '../../runtime/session-capabilities.ts'
import {
  detachModelsSnapshot,
  modelsChoiceKey,
  projectModelsChoices,
  type ModelsChoice,
} from './projectors.ts'

export type ModelsFeaturePhase = 'idle' | 'loading' | 'refreshing' | 'ready' | 'failed'

export interface ModelsRequestStamp {
  readonly scopeEpoch: number
  readonly requestId: number
}

export interface ModelsFeatureState {
  readonly phase: ModelsFeaturePhase
  readonly selectedIndex: number
  readonly selectedKey?: string
  readonly snapshot?: SessionModelSnapshot
  readonly agentStatus?: SessionAgentStatusSnapshot
  readonly request?: ModelsRequestStamp
  readonly selecting: boolean
  readonly selectionRequestId?: number
  readonly pendingSelection?: DshTuiModelSelection
  readonly error?: string
}

export type ModelsFeatureEvent =
  | { readonly type: 'load.started'; readonly request: ModelsRequestStamp }
  | {
      readonly type: 'load.succeeded'
      readonly request: ModelsRequestStamp
      readonly snapshot: SessionModelSnapshot
    }
  | {
      readonly type: 'load.failed'
      readonly request: ModelsRequestStamp
      readonly message: string
    }
  | { readonly type: 'snapshot.changed'; readonly snapshot: SessionModelSnapshot }
  | { readonly type: 'snapshot.failed'; readonly message: string }
  | { readonly type: 'status.changed'; readonly status: SessionAgentStatusSnapshot }
  | { readonly type: 'refresh.requested' }
  | { readonly type: 'selection.move'; readonly direction: 'up' | 'down' }
  | { readonly type: 'selection.blocked'; readonly message: string }
  | {
      readonly type: 'selection.started'
      readonly requestId: number
      readonly selection: DshTuiModelSelection
    }
  | {
      readonly type: 'selection.succeeded'
      readonly requestId: number
      readonly snapshot: SessionModelSnapshot
    }
  | {
      readonly type: 'selection.failed'
      readonly requestId: number
      readonly message: string
      readonly snapshot?: SessionModelSnapshot
    }

export interface ModelsFeatureTransition {
  readonly state: ModelsFeatureState
  readonly effects: readonly ModelsFeatureEffect[]
}

export type ModelsFeatureEffect = Readonly<{
  type: 'resource.refresh'
  resourceId: 'models.catalog'
}>

interface StateShape {
  phase: ModelsFeaturePhase
  selectedIndex: number
  selectedKey: string | undefined
  snapshot: SessionModelSnapshot | undefined
  agentStatus: SessionAgentStatusSnapshot | undefined
  request: ModelsRequestStamp | undefined
  selecting: boolean
  selectionRequestId: number | undefined
  pendingSelection: DshTuiModelSelection | undefined
  error: string | undefined
}

function freezeSelection(
  selection: DshTuiModelSelection | undefined,
): DshTuiModelSelection | undefined {
  if (selection === undefined) return undefined
  return Object.freeze({
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
  })
}

function shapeOf(state: ModelsFeatureState): StateShape {
  return {
    phase: state.phase,
    selectedIndex: state.selectedIndex,
    selectedKey: state.selectedKey,
    snapshot: state.snapshot,
    agentStatus: state.agentStatus,
    request: state.request,
    selecting: state.selecting,
    selectionRequestId: state.selectionRequestId,
    pendingSelection: state.pendingSelection,
    error: state.error,
  }
}

function freezeState(shape: StateShape): ModelsFeatureState {
  const request = shape.request === undefined
    ? undefined
    : Object.freeze({ ...shape.request })
  const pendingSelection = freezeSelection(shape.pendingSelection)
  const agentStatus = shape.agentStatus === undefined
    ? undefined
    : Object.freeze({ status: shape.agentStatus.status })
  return Object.freeze({
    phase: shape.phase,
    selectedIndex: shape.selectedIndex,
    ...(shape.selectedKey === undefined ? {} : { selectedKey: shape.selectedKey }),
    ...(shape.snapshot === undefined ? {} : { snapshot: shape.snapshot }),
    ...(agentStatus === undefined ? {} : { agentStatus }),
    ...(request === undefined ? {} : { request }),
    selecting: shape.selecting,
    ...(shape.selectionRequestId === undefined
      ? {}
      : { selectionRequestId: shape.selectionRequestId }),
    ...(pendingSelection === undefined ? {} : { pendingSelection }),
    ...(shape.error === undefined ? {} : { error: shape.error }),
  })
}

function changed(
  state: ModelsFeatureState,
  patch: Partial<StateShape>,
  effects: readonly ModelsFeatureEffect[] = Object.freeze([]),
): ModelsFeatureTransition {
  return Object.freeze({
    state: freezeState({ ...shapeOf(state), ...patch }),
    effects,
  })
}

function unchanged(
  state: ModelsFeatureState,
  effects: readonly ModelsFeatureEffect[] = Object.freeze([]),
): ModelsFeatureTransition {
  return Object.freeze({ state, effects })
}

function sameRequest(
  left: ModelsRequestStamp | undefined,
  right: ModelsRequestStamp,
): boolean {
  return left?.scopeEpoch === right.scopeEpoch && left.requestId === right.requestId
}

function preferredChoiceIndex(
  choices: readonly ModelsChoice[],
  snapshot: SessionModelSnapshot,
): number {
  const currentKey = snapshot.current === undefined
    ? undefined
    : modelsChoiceKey(snapshot.current)
  const exactCurrent = currentKey === undefined
    ? -1
    : choices.findIndex(choice => choice.key === currentKey)
  if (exactCurrent >= 0) return exactCurrent
  if (snapshot.current !== undefined) {
    return choices.findIndex(choice => (
      choice.provider === snapshot.current?.provider
      && choice.model === snapshot.current.model
      && choice.isReasoningDefault
    ))
  }
  const defaultKey = snapshot.defaultSelection === undefined
    ? undefined
    : modelsChoiceKey(snapshot.defaultSelection)
  const exactDefault = defaultKey === undefined
    ? -1
    : choices.findIndex(choice => choice.key === defaultKey)
  if (exactDefault >= 0) return exactDefault
  return choices.length === 0 ? -1 : 0
}

function reconcileSelection(
  selectedKey: string | undefined,
  snapshot: SessionModelSnapshot,
): Pick<StateShape, 'selectedIndex' | 'selectedKey'> {
  const choices = projectModelsChoices(snapshot)
  const stable = selectedKey === undefined
    ? -1
    : choices.findIndex(choice => choice.key === selectedKey)
  const selectedIndex = stable >= 0 ? stable : preferredChoiceIndex(choices, snapshot)
  const selected = choices[selectedIndex]
  return {
    selectedIndex,
    selectedKey: selected?.key,
  }
}

export function createModelsFeatureState(): ModelsFeatureState {
  return freezeState({
    phase: 'idle',
    selectedIndex: -1,
    selectedKey: undefined,
    snapshot: undefined,
    agentStatus: undefined,
    request: undefined,
    selecting: false,
    selectionRequestId: undefined,
    pendingSelection: undefined,
    error: undefined,
  })
}

export function selectedModelsChoice(
  state: ModelsFeatureState,
): ModelsChoice | undefined {
  return projectModelsChoices(state.snapshot)[state.selectedIndex]
}

export function transitionModelsFeature(
  state: ModelsFeatureState,
  event: ModelsFeatureEvent,
): ModelsFeatureTransition {
  switch (event.type) {
    case 'load.started':
      return changed(state, {
        phase: state.snapshot === undefined ? 'loading' : 'refreshing',
        request: event.request,
        error: undefined,
      })
    case 'load.succeeded': {
      if (!sameRequest(state.request, event.request)) return unchanged(state)
      const snapshot = detachModelsSnapshot(event.snapshot)
      return changed(state, {
        phase: 'ready',
        snapshot,
        request: undefined,
        error: undefined,
        ...reconcileSelection(state.selectedKey, snapshot),
      })
    }
    case 'load.failed':
      return sameRequest(state.request, event.request)
        ? changed(state, {
            phase: 'failed',
            request: undefined,
            error: event.message,
          })
        : unchanged(state)
    case 'snapshot.changed': {
      const snapshot = detachModelsSnapshot(event.snapshot)
      const loading = state.phase === 'loading' || state.phase === 'refreshing'
      return changed(state, {
        phase: loading ? state.phase : snapshot.error === undefined ? 'ready' : 'failed',
        snapshot,
        error: loading ? state.error : snapshot.error,
        ...reconcileSelection(state.selectedKey, snapshot),
      })
    }
    case 'snapshot.failed':
      return changed(state, { phase: 'failed', error: event.message })
    case 'status.changed':
      return changed(state, { agentStatus: event.status })
    case 'refresh.requested':
      return unchanged(state, Object.freeze([Object.freeze({
        type: 'resource.refresh',
        resourceId: 'models.catalog',
      })]))
    case 'selection.move': {
      const choices = projectModelsChoices(state.snapshot)
      if (choices.length === 0) return unchanged(state)
      const delta = event.direction === 'up' ? -1 : 1
      const selectedIndex = Math.max(
        0,
        Math.min(choices.length - 1, state.selectedIndex + delta),
      )
      if (selectedIndex === state.selectedIndex) return unchanged(state)
      return changed(state, {
        selectedIndex,
        selectedKey: choices[selectedIndex]!.key,
      })
    }
    case 'selection.started':
      return changed(state, {
        selecting: true,
        selectionRequestId: event.requestId,
        pendingSelection: event.selection,
        error: undefined,
      })
    case 'selection.blocked':
      return changed(state, { error: event.message })
    case 'selection.succeeded': {
      if (state.selectionRequestId !== event.requestId) return unchanged(state)
      const snapshot = detachModelsSnapshot(event.snapshot)
      return changed(state, {
        phase: 'ready',
        snapshot,
        selecting: false,
        selectionRequestId: undefined,
        pendingSelection: undefined,
        error: undefined,
        ...reconcileSelection(state.selectedKey, snapshot),
      })
    }
    case 'selection.failed': {
      if (state.selectionRequestId !== event.requestId) return unchanged(state)
      const snapshot = event.snapshot === undefined
        ? state.snapshot
        : detachModelsSnapshot(event.snapshot)
      return changed(state, {
        phase: 'failed',
        snapshot,
        selecting: false,
        selectionRequestId: undefined,
        pendingSelection: undefined,
        error: event.message,
        ...(snapshot === undefined ? {} : reconcileSelection(state.selectedKey, snapshot)),
      })
    }
    /* v8 ignore next 2 -- ModelsFeatureEvent is exhausted above. */
    default:
      return assertNever(event)
  }
}

/* v8 ignore next 3 -- exported discriminated unions are exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Models Feature event: ${String(value)}`)
}
