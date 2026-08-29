import type {
  SessionPermissionOption,
  SessionPermissionSnapshot,
} from './port.ts'

export const PERMISSION_PICKER_LIMIT = 8

export interface PermissionPickerState {
  readonly open: boolean
  readonly selectedValue?: string
  /** Absolute index in the current projection order. */
  readonly selectedIndex: number
}

export interface PermissionPickerRow extends SessionPermissionOption {
  readonly isCurrent: boolean
}

export interface PermissionPickerView {
  readonly rows: readonly PermissionPickerRow[]
  readonly selectedIndex: number
  readonly selectedValue?: string
  readonly offset: number
  readonly totalCount: number
  readonly currentValue?: string
  readonly available: boolean
  readonly writable: boolean
  readonly stale: boolean
  readonly generation: number
  readonly selecting: boolean
  readonly error?: string
}

export type PermissionPickerAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'enter' }
  | { readonly type: 'escape' }

export type PermissionPickerOutcome =
  | { readonly kind: 'selected'; readonly value: string }
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
  const next = stateAt(forceOpen || state.open, snapshot.options, selectedIndex)
  return sameState(state, next) ? state : next
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
    available: snapshot.available,
    writable: snapshot.writable,
    stale: snapshot.stale,
    generation: snapshot.generation,
    selecting: snapshot.selecting,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
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
  return { state, outcome: { kind: 'selected', value: selected.value } }
}

export function applyPermissionPickerAction(
  state: PermissionPickerState,
  snapshot: SessionPermissionSnapshot,
  action: PermissionPickerAction,
): PermissionPickerTransition {
  if (!state.open) return { state }
  const reconciled = reconcilePermissionPicker(state, snapshot)
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
  }
}
