import type { DshTuiPreferencesV1 } from '../../preferences/contracts.ts'
import {
  SETTINGS_FIELD_IDS,
  cycleSettingsPreference,
  detachSettingsFeatureSnapshot,
  type SettingsCycleDirection,
  type SettingsFeatureSnapshot,
} from './projectors.ts'

export const SETTINGS_RESOURCE_ID = 'settings.preferences'

export type SettingsFeaturePhase = 'idle' | 'loading' | 'refreshing' | 'ready' | 'failed'

export interface SettingsRequestStamp {
  readonly scopeEpoch: number
  readonly requestId: number
}

export interface SettingsFeatureState {
  readonly phase: SettingsFeaturePhase
  readonly selectedIndex: number
  readonly snapshot?: SettingsFeatureSnapshot
  readonly request?: SettingsRequestStamp
  readonly saving: boolean
  readonly editing: boolean
  readonly writeRequestId?: number
  readonly pendingPreferences?: DshTuiPreferencesV1
  readonly error?: string
}

export type SettingsFeatureEvent =
  | { readonly type: 'load.started'; readonly request: SettingsRequestStamp }
  | {
      readonly type: 'load.succeeded'
      readonly request: SettingsRequestStamp
      readonly snapshot: SettingsFeatureSnapshot
    }
  | {
      readonly type: 'load.failed'
      readonly request: SettingsRequestStamp
      readonly message: string
    }
  | { readonly type: 'refresh.requested' }
  | { readonly type: 'selection.move'; readonly direction: 'up' | 'down' }
  | { readonly type: 'editing.toggle' }
  | { readonly type: 'editing.reset' }
  | {
      readonly type: 'preference.cycle'
      readonly direction: SettingsCycleDirection
      readonly requestId: number
    }
  | {
      readonly type: 'save.succeeded'
      readonly requestId: number
      readonly snapshot: SettingsFeatureSnapshot
    }
  | {
      readonly type: 'save.failed'
      readonly requestId: number
      readonly message: string
    }

export type SettingsFeatureEffect =
  | {
      readonly type: 'resource.refresh'
      readonly resourceId: typeof SETTINGS_RESOURCE_ID
    }
  | {
      readonly type: 'preferences.write'
      readonly requestId: number
      readonly expectedRevision: number
      readonly preferences: DshTuiPreferencesV1
    }

export interface SettingsFeatureTransition {
  readonly state: SettingsFeatureState
  readonly effects: readonly SettingsFeatureEffect[]
}

interface StateShape {
  phase: SettingsFeaturePhase
  selectedIndex: number
  snapshot: SettingsFeatureSnapshot | undefined
  request: SettingsRequestStamp | undefined
  saving: boolean
  editing: boolean
  writeRequestId: number | undefined
  pendingPreferences: DshTuiPreferencesV1 | undefined
  error: string | undefined
}

const NO_EFFECTS: readonly SettingsFeatureEffect[] = Object.freeze([])

function shapeOf(state: SettingsFeatureState): StateShape {
  return {
    phase: state.phase,
    selectedIndex: state.selectedIndex,
    snapshot: state.snapshot,
    request: state.request,
    saving: state.saving,
    editing: state.editing,
    writeRequestId: state.writeRequestId,
    pendingPreferences: state.pendingPreferences,
    error: state.error,
  }
}

function freezeState(shape: StateShape): SettingsFeatureState {
  const request = shape.request === undefined
    ? undefined
    : Object.freeze({ ...shape.request })
  return Object.freeze({
    phase: shape.phase,
    selectedIndex: shape.selectedIndex,
    ...(shape.snapshot === undefined ? {} : { snapshot: shape.snapshot }),
    ...(request === undefined ? {} : { request }),
    saving: shape.saving,
    editing: shape.editing,
    ...(shape.writeRequestId === undefined ? {} : { writeRequestId: shape.writeRequestId }),
    ...(shape.pendingPreferences === undefined
      ? {}
      : { pendingPreferences: shape.pendingPreferences }),
    ...(shape.error === undefined ? {} : { error: shape.error }),
  })
}

function transition(
  state: SettingsFeatureState,
  patch: Partial<StateShape> = {},
  effects: readonly SettingsFeatureEffect[] = NO_EFFECTS,
): SettingsFeatureTransition {
  const next = Object.keys(patch).length === 0
    ? state
    : freezeState({ ...shapeOf(state), ...patch })
  return Object.freeze({ state: next, effects: Object.freeze([...effects]) })
}

function sameRequest(
  left: SettingsRequestStamp | undefined,
  right: SettingsRequestStamp,
): boolean {
  return left?.scopeEpoch === right.scopeEpoch && left.requestId === right.requestId
}

function newestSnapshot(
  current: SettingsFeatureSnapshot | undefined,
  incoming: SettingsFeatureSnapshot,
): SettingsFeatureSnapshot {
  return current !== undefined && current.revision > incoming.revision
    ? current
    : detachSettingsFeatureSnapshot(incoming)
}

export function createSettingsFeatureState(): SettingsFeatureState {
  return freezeState({
    phase: 'idle',
    selectedIndex: 0,
    snapshot: undefined,
    request: undefined,
    saving: false,
    editing: false,
    writeRequestId: undefined,
    pendingPreferences: undefined,
    error: undefined,
  })
}

export function visibleSettingsPreferences(
  state: SettingsFeatureState,
): DshTuiPreferencesV1 | undefined {
  return state.pendingPreferences ?? state.snapshot?.preferences
}

export function transitionSettingsFeature(
  state: SettingsFeatureState,
  event: SettingsFeatureEvent,
): SettingsFeatureTransition {
  switch (event.type) {
    case 'load.started':
      return transition(state, {
        phase: state.snapshot === undefined ? 'loading' : 'refreshing',
        request: event.request,
        error: undefined,
      })
    case 'load.succeeded':
      return sameRequest(state.request, event.request)
        ? transition(state, {
            phase: 'ready',
            snapshot: newestSnapshot(state.snapshot, event.snapshot),
            request: undefined,
            error: undefined,
          })
        : transition(state)
    case 'load.failed':
      return sameRequest(state.request, event.request)
        ? transition(state, {
            phase: 'failed',
            request: undefined,
            error: event.message,
          })
        : transition(state)
    case 'refresh.requested':
      return transition(state, {}, [Object.freeze({
        type: 'resource.refresh',
        resourceId: SETTINGS_RESOURCE_ID,
      })])
    case 'editing.toggle': {
      if (state.editing) return transition(state, { editing: false })
      const snapshot = state.snapshot
      if (snapshot === undefined) return transition(state, { error: 'Preferences are not loaded' })
      if (!snapshot.status.available) return transition(state, { error: 'DSH Settings service is unavailable' })
      if (!snapshot.status.writable) return transition(state, { error: 'DSH Settings is read-only' })
      return transition(state, { editing: true, error: undefined })
    }
    case 'editing.reset':
      return state.editing ? transition(state, { editing: false }) : transition(state)
    case 'selection.move': {
      const delta = event.direction === 'up' ? -1 : 1
      const selectedIndex = Math.max(
        0,
        Math.min(SETTINGS_FIELD_IDS.length - 1, state.selectedIndex + delta),
      )
      return selectedIndex === state.selectedIndex
        ? transition(state)
        : transition(state, { selectedIndex, editing: false, error: undefined })
    }
    case 'preference.cycle': {
      const snapshot = state.snapshot
      if (snapshot === undefined) {
        return transition(state, { error: 'Preferences are not loaded' })
      }
      if (!snapshot.status.available) {
        return transition(state, { error: 'DSH Settings service is unavailable' })
      }
      if (!snapshot.status.writable) {
        return transition(state, { error: 'DSH Settings is read-only' })
      }
      if (state.saving) {
        return transition(state, { error: 'A preference update is already running' })
      }
      const preferences = cycleSettingsPreference(
        snapshot.preferences,
        SETTINGS_FIELD_IDS[state.selectedIndex]!,
        event.direction,
      )
      return transition(state, {
        saving: true,
        writeRequestId: event.requestId,
        pendingPreferences: preferences,
        error: undefined,
      }, [Object.freeze({
        type: 'preferences.write',
        requestId: event.requestId,
        expectedRevision: snapshot.revision,
        preferences,
      })])
    }
    case 'save.succeeded':
      return state.writeRequestId === event.requestId
        ? transition(state, {
            phase: 'ready',
            snapshot: newestSnapshot(state.snapshot, event.snapshot),
            saving: false,
            writeRequestId: undefined,
            pendingPreferences: undefined,
            error: undefined,
          })
        : transition(state)
    case 'save.failed':
      return state.writeRequestId === event.requestId
        ? transition(state, {
            phase: 'failed',
            saving: false,
            writeRequestId: undefined,
            pendingPreferences: undefined,
            error: event.message,
          })
        : transition(state)
    /* v8 ignore next 2 -- SettingsFeatureEvent is exhausted above. */
    default:
      return assertNever(event)
  }
}

/* v8 ignore next 3 -- exported discriminated unions are exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Settings Feature event: ${String(value)}`)
}
