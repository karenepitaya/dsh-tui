import type {
  PermissionConfirmation,
  PermissionPolicy,
  SessionPermissionOption,
  SessionPermissionSnapshot,
} from './port.ts'
import { permissionWidens } from './policy.ts'
import type { LegacyDirectoryState } from '../navigation/legacy-directory.ts'

export interface PermissionPickerConfirmation extends PermissionConfirmation {
  readonly currentPermission: PermissionPolicy
  readonly targetPermission: PermissionPolicy
  /** Cancel is selected initially; confirmation requires a deliberate move. */
  readonly selectedIndex: 0 | 1
}

export const PERMISSION_PICKER_LIMIT = 8

export interface PermissionPickerState extends LegacyDirectoryState {
  readonly open: boolean
  readonly selectedValue?: string
  /** Absolute index in the current projection order. */
  readonly selectedIndex: number
  readonly confirmation?: PermissionPickerConfirmation
}

export interface PermissionPickerRow extends SessionPermissionOption {
  readonly isCurrent: boolean
}

export interface PermissionPickerView extends LegacyDirectoryState {
  readonly rememberedApprovalCount?: number
  readonly rows: readonly PermissionPickerRow[]
  readonly selectedIndex: number
  readonly selectedValue?: string
  readonly offset: number
  readonly totalCount: number
  readonly currentValue?: string
  readonly currentPermission?: PermissionPolicy
  readonly available: boolean
  readonly writable: boolean
  readonly stale: boolean
  readonly generation: number
  readonly selecting: boolean
  readonly error?: string
  readonly confirmation?: PermissionPickerConfirmation
}

export type PermissionPickerAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'enter' }
  | { readonly type: 'escape' }
  | { readonly type: 'confirm-previous' }
  | { readonly type: 'confirm-next' }

export type PermissionPickerOutcome =
  | { readonly kind: 'selected'; readonly value: string; readonly confirmation?: PermissionConfirmation }
  | { readonly kind: 'confirmation-required'; readonly value: string }
  | {
      readonly kind: 'blocked'
      readonly reason:
        | 'unavailable'
        | 'stale'
        | 'read-only'
        | 'selecting'
        | 'unchanged'
        | 'current-only'
        | 'no-selection'
        | 'missing-policy'
    }
  | { readonly kind: 'cancelled' }

export interface PermissionPickerTransition {
  readonly state: PermissionPickerState
  readonly outcome?: PermissionPickerOutcome
}

function sameState(
  left: PermissionPickerState,
  right: PermissionPickerState,
): boolean {
  return left.open === right.open
    && left.selectedValue === right.selectedValue
    && left.selectedIndex === right.selectedIndex
    && left.confirmation === right.confirmation
}

function stateAt(
  open: boolean,
  options: readonly SessionPermissionOption[],
  selectedIndex: number,
): PermissionPickerState {
  const selected = options[selectedIndex]
  return Object.freeze({
    open,
    ...(selected === undefined ? {} : { selectedValue: selected.value }),
    selectedIndex: selected === undefined ? -1 : selectedIndex,
  })
}

function preferredIndex(snapshot: SessionPermissionSnapshot): number {
  const current = snapshot.currentValue === undefined
    ? -1
    : snapshot.options.findIndex(option => option.value === snapshot.currentValue)
  if (current >= 0) return current
  const selectable = snapshot.options.findIndex(option => option.selectable)
  if (selectable >= 0) return selectable
  return snapshot.options.length === 0 ? -1 : 0
}

function reconciledState(
  state: PermissionPickerState,
  snapshot: SessionPermissionSnapshot,
  forceOpen: boolean,
): PermissionPickerState {
  const stable = state.selectedValue === undefined
    ? -1
    : snapshot.options.findIndex(option => option.value === state.selectedValue)
  const selectedIndex = stable >= 0 ? stable : preferredIndex(snapshot)
  const next = { ...stateAt(forceOpen || state.open, snapshot.options, selectedIndex),
    ...(state.navigation === undefined ? {} : { navigation: state.navigation }) }
  const confirmation = state.confirmation
  const retained = confirmation !== undefined
    && confirmation.generation === snapshot.generation
    && confirmation.fromValue === snapshot.currentValue
    && confirmation.toValue === next.selectedValue
    ? { ...next, confirmation }
    : next
  return sameState(state, retained) ? state : retained
}

export function createPermissionPickerState(): PermissionPickerState {
  return Object.freeze({ open: false, selectedIndex: -1 })
}

export function openPermissionPicker(
  state: PermissionPickerState,
  snapshot: SessionPermissionSnapshot,
): PermissionPickerState {
  return reconciledState(state, snapshot, true)
}

export function reconcilePermissionPicker(
  state: PermissionPickerState,
  snapshot: SessionPermissionSnapshot,
): PermissionPickerState {
  return state.open ? reconciledState(state, snapshot, false) : state
}

function projectRow(
  option: SessionPermissionOption,
  snapshot: SessionPermissionSnapshot,
): PermissionPickerRow {
  return Object.freeze({
    value: option.value,
    name: option.name,
    ...(option.description === undefined ? {} : { description: option.description }),
    selectable: option.selectable,
    ...(option.permission === undefined ? {} : { permission: option.permission }),
    isCurrent: option.value === snapshot.currentValue,
  })
}

export function selectPermissionPicker(
  state: PermissionPickerState,
  snapshot: SessionPermissionSnapshot,
): PermissionPickerView | undefined {
  if (!state.open) return undefined
  const reconciled = reconcilePermissionPicker(state, snapshot)
  const maxOffset = Math.max(0, snapshot.options.length - PERMISSION_PICKER_LIMIT)
  const offset = reconciled.selectedIndex < 0
    ? 0
    : Math.min(
        maxOffset,
        Math.max(0, reconciled.selectedIndex - PERMISSION_PICKER_LIMIT + 1),
      )
  const rows = Object.freeze(snapshot.options
    .slice(offset, offset + PERMISSION_PICKER_LIMIT)
    .map(option => projectRow(option, snapshot)))
  return Object.freeze({
    rows,
    ...(reconciled.navigation === undefined ? {} : { navigation: reconciled.navigation }),
    selectedIndex: reconciled.selectedIndex < 0
      ? -1
      : reconciled.selectedIndex - offset,
    ...(reconciled.selectedValue === undefined
      ? {}
      : { selectedValue: reconciled.selectedValue }),
    offset,
    totalCount: snapshot.options.length,
    ...(snapshot.currentValue === undefined
      ? {}
      : { currentValue: snapshot.currentValue }),
    ...(snapshot.currentPermission === undefined ? {} : { currentPermission: snapshot.currentPermission }),
    available: snapshot.available,
    writable: snapshot.writable,
    stale: snapshot.stale,
    generation: snapshot.generation,
    selecting: snapshot.selecting,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    ...(reconciled.confirmation === undefined ? {} : { confirmation: reconciled.confirmation }),
  })
}

function move(
  state: PermissionPickerState,
  snapshot: SessionPermissionSnapshot,
  direction: 'up' | 'down',
): PermissionPickerState {
  if (snapshot.options.length === 0) return state
  const delta = direction === 'up' ? -1 : 1
  const selectedIndex = Math.min(
    snapshot.options.length - 1,
    Math.max(0, state.selectedIndex + delta),
  )
  return selectedIndex === state.selectedIndex
    ? state
    : stateAt(true, snapshot.options, selectedIndex)
}

function selectionOutcome(
  state: PermissionPickerState,
  snapshot: SessionPermissionSnapshot,
): PermissionPickerTransition {
  if (!snapshot.available) {
    return { state, outcome: { kind: 'blocked', reason: 'unavailable' } }
  }
  if (snapshot.stale) {
    return { state, outcome: { kind: 'blocked', reason: 'stale' } }
  }
  if (!snapshot.writable) {
    return { state, outcome: { kind: 'blocked', reason: 'read-only' } }
  }
  if (snapshot.selecting) {
    return { state, outcome: { kind: 'blocked', reason: 'selecting' } }
  }
  const selected = snapshot.options[state.selectedIndex]
  if (selected === undefined) {
    return { state, outcome: { kind: 'blocked', reason: 'no-selection' } }
  }
  if (!selected.selectable) {
    return { state, outcome: { kind: 'blocked', reason: 'current-only' } }
  }
  if (selected.value === snapshot.currentValue) {
    return { state, outcome: { kind: 'blocked', reason: 'unchanged' } }
  }
  const currentPermission = snapshot.currentPermission
  const targetPermission = selected.permission
  if (currentPermission === undefined || targetPermission === undefined || snapshot.currentValue === undefined) {
    return { state, outcome: { kind: 'blocked', reason: 'missing-policy' } }
  }
  if (permissionWidens(currentPermission, targetPermission)) {
    const confirmation = state.confirmation
    if (confirmation === undefined) {
      return {
        state: { ...state, confirmation: Object.freeze({
          fromValue: snapshot.currentValue,
          toValue: selected.value,
          generation: snapshot.generation,
          currentPermission,
          targetPermission,
          selectedIndex: 0,
        }) },
        outcome: { kind: 'confirmation-required', value: selected.value },
      }
    }
    if (confirmation.selectedIndex === 0) {
      return { state: stateAt(true, snapshot.options, state.selectedIndex) }
    }
    return { state, outcome: { kind: 'selected', value: selected.value, confirmation: {
      fromValue: confirmation.fromValue,
      toValue: confirmation.toValue,
      generation: confirmation.generation,
    } } }
  }
  return { state, outcome: { kind: 'selected', value: selected.value } }
}

export function applyPermissionPickerAction(
  state: PermissionPickerState,
  snapshot: SessionPermissionSnapshot,
  action: PermissionPickerAction,
): PermissionPickerTransition {
  if (!state.open) return { state }
  const reconciled = reconcilePermissionPicker(state, snapshot)
  if (reconciled.confirmation !== undefined) {
    if (action.type === 'escape') {
      return { state: stateAt(true, snapshot.options, reconciled.selectedIndex) }
    }
    if (action.type !== 'enter') {
      const selectedIndex = action.type === 'move-up' || action.type === 'confirm-previous' ? 0 : 1
      return { state: { ...reconciled, confirmation: { ...reconciled.confirmation, selectedIndex } } }
    }
  }
  switch (action.type) {
    case 'move-up':
      return { state: move(reconciled, snapshot, 'up') }
    case 'move-down':
      return { state: move(reconciled, snapshot, 'down') }
    case 'escape':
      return {
        state: Object.freeze({ ...reconciled, open: false }),
        outcome: { kind: 'cancelled' },
      }
    case 'enter':
      return selectionOutcome(reconciled, snapshot)
    case 'confirm-previous':
    case 'confirm-next':
      return { state: reconciled }
  }
}
