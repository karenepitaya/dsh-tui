import type { AgentPresetCatalogEntry } from '../preset/catalog-port.ts'
import type { SessionModeSnapshot } from './port.ts'

export const MODE_PICKER_LIMIT = 8

export interface ModePickerState {
  readonly open: boolean
  readonly selectedModeId?: string
  /** Absolute index in the current roster. */
  readonly selectedIndex: number
}

export interface ModePickerRow {
  readonly id: string
  readonly trust: AgentPresetCatalogEntry['trust']
  readonly name?: string
  readonly description?: string
  readonly broken?: string
  readonly isCurrent: boolean
  readonly isDefault: boolean
}

export interface ModePickerView {
  readonly rows: readonly ModePickerRow[]
  readonly selectedIndex: number
  readonly selectedModeId?: string
  readonly offset: number
  readonly totalCount: number
  readonly current?: string
  readonly defaultId?: string
  readonly available: boolean
  readonly loading: boolean
  readonly selecting: boolean
  readonly locked: boolean
  readonly error?: string
}

export type ModePickerAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'refresh' }
  | { readonly type: 'enter' }
  | { readonly type: 'escape' }

export type ModePickerOutcome =
  | { readonly kind: 'selected'; readonly modeId: string }
  | {
      readonly kind: 'blocked'
      readonly reason:
        | 'unavailable'
        | 'selecting'
        | 'locked'
        | 'unchanged'
        | 'no-selection'
    }
  | {
      readonly kind: 'blocked'
      readonly reason: 'broken'
      readonly modeId: string
      readonly message: string
    }
  | { readonly kind: 'refresh-requested' }
  | { readonly kind: 'cancelled' }

export interface ModePickerTransition {
  readonly state: ModePickerState
  readonly outcome?: ModePickerOutcome
}

function sameState(left: ModePickerState, right: ModePickerState): boolean {
  return left.open === right.open
    && left.selectedModeId === right.selectedModeId
    && left.selectedIndex === right.selectedIndex
}

function stateAt(
  open: boolean,
  presets: readonly AgentPresetCatalogEntry[],
  selectedIndex: number,
): ModePickerState {
  const selected = presets[selectedIndex]
  return Object.freeze({
    open,
    ...(selected === undefined ? {} : { selectedModeId: selected.id }),
    selectedIndex: selected === undefined ? -1 : selectedIndex,
  })
}

function preferredIndex(snapshot: SessionModeSnapshot): number {
  const current = snapshot.current === undefined
    ? -1
    : snapshot.presets.findIndex(row => row.id === snapshot.current)
  if (current >= 0) return current
  const fallback = snapshot.defaultId === undefined
    ? -1
    : snapshot.presets.findIndex(row => row.id === snapshot.defaultId)
  if (fallback >= 0) return fallback
  const healthy = snapshot.presets.findIndex(row => row.broken === undefined)
  if (healthy >= 0) return healthy
  return snapshot.presets.length === 0 ? -1 : 0
}

function reconciledState(
  state: ModePickerState,
  snapshot: SessionModeSnapshot,
  forceOpen: boolean,
): ModePickerState {
  const stable = state.selectedModeId === undefined
    ? -1
    : snapshot.presets.findIndex(row => row.id === state.selectedModeId)
  const selectedIndex = stable >= 0 ? stable : preferredIndex(snapshot)
  const next = stateAt(forceOpen || state.open, snapshot.presets, selectedIndex)
  return sameState(state, next) ? state : next
}

export function createModePickerState(): ModePickerState {
  return Object.freeze({ open: false, selectedIndex: -1 })
}

export function openModePicker(
  state: ModePickerState,
  snapshot: SessionModeSnapshot,
): ModePickerState {
  return reconciledState(state, snapshot, true)
}

export function reconcileModePicker(
  state: ModePickerState,
  snapshot: SessionModeSnapshot,
): ModePickerState {
  return state.open ? reconciledState(state, snapshot, false) : state
}

function projectRow(
  entry: AgentPresetCatalogEntry,
  snapshot: SessionModeSnapshot,
): ModePickerRow {
  return Object.freeze({
    id: entry.id,
    trust: entry.trust,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.broken === undefined ? {} : { broken: entry.broken }),
    isCurrent: entry.id === snapshot.current,
    isDefault: entry.id === snapshot.defaultId,
  })
}

export function selectModePicker(
  state: ModePickerState,
  snapshot: SessionModeSnapshot,
): ModePickerView | undefined {
  if (!state.open) return undefined
  const reconciled = reconcileModePicker(state, snapshot)
  const maxOffset = Math.max(0, snapshot.presets.length - MODE_PICKER_LIMIT)
  const offset = reconciled.selectedIndex < 0
    ? 0
    : Math.min(
        maxOffset,
        Math.max(0, reconciled.selectedIndex - MODE_PICKER_LIMIT + 1),
      )
  const rows = Object.freeze(snapshot.presets
    .slice(offset, offset + MODE_PICKER_LIMIT)
    .map(entry => projectRow(entry, snapshot)))
  return Object.freeze({
    rows,
    selectedIndex: reconciled.selectedIndex < 0
      ? -1
      : reconciled.selectedIndex - offset,
    ...(reconciled.selectedModeId === undefined
      ? {}
      : { selectedModeId: reconciled.selectedModeId }),
    offset,
    totalCount: snapshot.presets.length,
    ...(snapshot.current === undefined ? {} : { current: snapshot.current }),
    ...(snapshot.defaultId === undefined ? {} : { defaultId: snapshot.defaultId }),
    available: snapshot.available,
    loading: snapshot.loading,
    selecting: snapshot.selecting,
    locked: snapshot.locked,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  })
}

function move(
  state: ModePickerState,
  snapshot: SessionModeSnapshot,
  direction: 'up' | 'down',
): ModePickerState {
  if (snapshot.presets.length === 0) return state
  const delta = direction === 'up' ? -1 : 1
  const selectedIndex = Math.min(
    snapshot.presets.length - 1,
    Math.max(0, state.selectedIndex + delta),
  )
  if (selectedIndex === state.selectedIndex) return state
  return stateAt(true, snapshot.presets, selectedIndex)
}

function selectionOutcome(
  state: ModePickerState,
  snapshot: SessionModeSnapshot,
): ModePickerTransition {
  if (!snapshot.available) {
    return { state, outcome: { kind: 'blocked', reason: 'unavailable' } }
  }
  if (snapshot.selecting) {
    return { state, outcome: { kind: 'blocked', reason: 'selecting' } }
  }
  if (snapshot.locked) {
    return { state, outcome: { kind: 'blocked', reason: 'locked' } }
  }
  const selected = snapshot.presets[state.selectedIndex]
  if (selected === undefined) {
    return { state, outcome: { kind: 'blocked', reason: 'no-selection' } }
  }
  if (selected.broken !== undefined) {
    return {
      state,
      outcome: {
        kind: 'blocked',
        reason: 'broken',
        modeId: selected.id,
        message: selected.broken,
      },
    }
  }
  if (selected.id === snapshot.current) {
    return { state, outcome: { kind: 'blocked', reason: 'unchanged' } }
  }
  return {
    state: Object.freeze({ ...state, open: false }),
    outcome: { kind: 'selected', modeId: selected.id },
  }
}

export function applyModePickerAction(
  state: ModePickerState,
  snapshot: SessionModeSnapshot,
  action: ModePickerAction,
): ModePickerTransition {
  if (!state.open) return { state }
  const reconciled = reconcileModePicker(state, snapshot)
  switch (action.type) {
    case 'move-up':
      return { state: move(reconciled, snapshot, 'up') }
    case 'move-down':
      return { state: move(reconciled, snapshot, 'down') }
    case 'refresh':
      return { state: reconciled, outcome: { kind: 'refresh-requested' } }
    case 'escape':
      return {
        state: Object.freeze({ ...reconciled, open: false }),
        outcome: { kind: 'cancelled' },
      }
    case 'enter':
      return selectionOutcome(reconciled, snapshot)
  }
}
