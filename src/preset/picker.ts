import type {
  AgentPresetCatalogEntry,
  AgentPresetCatalogSnapshot,
  AgentPresetSelectionPlan,
} from './catalog-port.ts'

export const STARTUP_PRESET_PICKER_LIMIT = 8

export interface StartupPresetPickerState {
  readonly open: boolean
  /** Stable identity retained while a refreshed roster reorders its rows. */
  readonly selectedPresetId?: string
  /** Last absolute index; `-1` means there is no currently valid row. */
  readonly selectedIndex: number
}

/** Presentation-only projection. Authority-only `sourcePath` is deliberately absent. */
export interface StartupPresetPickerRow {
  readonly id: string
  readonly trust: AgentPresetCatalogEntry['trust']
  readonly name?: string
  readonly description?: string
  readonly broken?: string
  readonly isDefault: boolean
}

export interface StartupPresetPickerView {
  readonly rows: readonly StartupPresetPickerRow[]
  /** Selected index within the bounded `rows` window. */
  readonly selectedIndex: number
  readonly selectedPresetId?: string
  readonly offset: number
  readonly totalCount: number
  readonly defaultId: string
  readonly defaultMissing: boolean
}

export type StartupPresetPickerAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'refresh' }
  | { readonly type: 'enter' }
  | { readonly type: 'escape' }

export type StartupPresetPickerOutcome =
  | { readonly kind: 'selected'; readonly plan: AgentPresetSelectionPlan }
  | {
      readonly kind: 'blocked'
      readonly reason: 'broken'
      readonly presetId: string
      readonly message: string
    }
  | {
      readonly kind: 'blocked'
      readonly reason: 'selection-missing'
      readonly presetId: string
    }
  | { readonly kind: 'blocked'; readonly reason: 'no-selection' }
  | { readonly kind: 'refresh-requested' }
  | { readonly kind: 'cancelled' }

export interface StartupPresetPickerTransition {
  readonly state: StartupPresetPickerState
  readonly outcome?: StartupPresetPickerOutcome
}

function sameState(
  state: StartupPresetPickerState,
  next: StartupPresetPickerState,
): boolean {
  return state.open === next.open
    && state.selectedPresetId === next.selectedPresetId
    && state.selectedIndex === next.selectedIndex
}

function stateAt(
  open: boolean,
  presets: readonly AgentPresetCatalogEntry[],
  selectedIndex: number,
): StartupPresetPickerState {
  const selected = presets[selectedIndex]
  return Object.freeze({
    open,
    ...(selected === undefined ? {} : { selectedPresetId: selected.id }),
    selectedIndex: selected === undefined ? -1 : selectedIndex,
  })
}

function initialIndex(snapshot: AgentPresetCatalogSnapshot): number {
  const defaultIndex = snapshot.presets.findIndex(row => row.id === snapshot.defaultId)
  if (defaultIndex >= 0) return defaultIndex
  const healthyIndex = snapshot.presets.findIndex(row => row.broken === undefined)
  if (healthyIndex >= 0) return healthyIndex
  return snapshot.presets.length === 0 ? -1 : 0
}

function clampedIndex(index: number, count: number): number {
  return Math.min(count - 1, Math.max(0, index))
}

function invalidatedSelection(
  state: StartupPresetPickerState,
  presetId: string,
): StartupPresetPickerState {
  const next = Object.freeze({
    open: true,
    selectedPresetId: presetId,
    selectedIndex: -1,
  })
  return sameState(state, next) ? state : next
}

export function createStartupPresetPickerState(): StartupPresetPickerState {
  return Object.freeze({ open: false, selectedIndex: -1 })
}

export function openStartupPresetPicker(
  state: StartupPresetPickerState,
  snapshot: AgentPresetCatalogSnapshot,
): StartupPresetPickerState {
  const stableIndex = state.selectedPresetId === undefined
    ? -1
    : snapshot.presets.findIndex(row => row.id === state.selectedPresetId)
  const selectedIndex = stableIndex >= 0 ? stableIndex : initialIndex(snapshot)
  const next = stateAt(true, snapshot.presets, selectedIndex)
  return sameState(state, next) ? state : next
}

export function reconcileStartupPresetPicker(
  state: StartupPresetPickerState,
  snapshot: AgentPresetCatalogSnapshot,
): StartupPresetPickerState {
  if (!state.open) return state
  const selectedPresetId = state.selectedPresetId
  if (selectedPresetId === undefined) {
    const next = stateAt(true, snapshot.presets, initialIndex(snapshot))
    return sameState(state, next) ? state : next
  }
  const stableIndex = snapshot.presets.findIndex(row => row.id === selectedPresetId)
  if (stableIndex < 0) return invalidatedSelection(state, selectedPresetId)
  const next = stateAt(true, snapshot.presets, stableIndex)
  return sameState(state, next) ? state : next
}

function projectRow(entry: AgentPresetCatalogEntry): StartupPresetPickerRow {
  return Object.freeze({
    id: entry.id,
    trust: entry.trust,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.broken === undefined ? {} : { broken: entry.broken }),
    isDefault: entry.isDefault,
  })
}

export function selectStartupPresetPicker(
  state: StartupPresetPickerState,
  snapshot: AgentPresetCatalogSnapshot,
): StartupPresetPickerView | undefined {
  if (!state.open) return undefined
  const reconciled = reconcileStartupPresetPicker(state, snapshot)
  const maxOffset = Math.max(
    0,
    snapshot.presets.length - STARTUP_PRESET_PICKER_LIMIT,
  )
  const offset = reconciled.selectedIndex < 0
    ? 0
    : Math.min(
        maxOffset,
        Math.max(
          0,
          reconciled.selectedIndex - STARTUP_PRESET_PICKER_LIMIT + 1,
        ),
      )
  const rows = Object.freeze(snapshot.presets
    .slice(offset, offset + STARTUP_PRESET_PICKER_LIMIT)
    .map(projectRow))
  return Object.freeze({
    rows,
    selectedIndex: reconciled.selectedIndex < 0
      ? -1
      : reconciled.selectedIndex - offset,
    ...(reconciled.selectedPresetId === undefined
      ? {}
      : { selectedPresetId: reconciled.selectedPresetId }),
    offset,
    totalCount: snapshot.presets.length,
    defaultId: snapshot.defaultId,
    defaultMissing: !snapshot.presets.some(row => row.id === snapshot.defaultId),
  })
}

function moveSelection(
  state: StartupPresetPickerState,
  snapshot: AgentPresetCatalogSnapshot,
  direction: 'up' | 'down',
): StartupPresetPickerState {
  if (snapshot.presets.length === 0) return state
  if (state.selectedIndex < 0) {
    return stateAt(true, snapshot.presets, initialIndex(snapshot))
  }
  const delta = direction === 'up' ? -1 : 1
  const selectedIndex = clampedIndex(
    state.selectedIndex + delta,
    snapshot.presets.length,
  )
  if (selectedIndex === state.selectedIndex) return state
  return stateAt(true, snapshot.presets, selectedIndex)
}

function closePicker(state: StartupPresetPickerState): StartupPresetPickerState {
  return Object.freeze({ ...state, open: false })
}

export function applyStartupPresetPickerAction(
  state: StartupPresetPickerState,
  snapshot: AgentPresetCatalogSnapshot,
  action: StartupPresetPickerAction,
): StartupPresetPickerTransition {
  if (!state.open) return { state }

  if (action.type === 'enter') {
    const presetId = state.selectedPresetId
    if (presetId === undefined) {
      return {
        state: reconcileStartupPresetPicker(state, snapshot),
        outcome: { kind: 'blocked', reason: 'no-selection' },
      }
    }
    const selectedIndex = snapshot.presets.findIndex(row => row.id === presetId)
    if (selectedIndex < 0) {
      return {
        state: invalidatedSelection(state, presetId),
        outcome: { kind: 'blocked', reason: 'selection-missing', presetId },
      }
    }
    const selected = snapshot.presets[selectedIndex]!
    const current = stateAt(true, snapshot.presets, selectedIndex)
    if (selected.broken !== undefined) {
      return {
        state: sameState(state, current) ? state : current,
        outcome: {
          kind: 'blocked',
          reason: 'broken',
          presetId: selected.id,
          message: selected.broken,
        },
      }
    }
    return {
      state: closePicker(current),
      outcome: {
        kind: 'selected',
        plan: Object.freeze({
          id: selected.id,
          trust: selected.trust,
          sourcePath: selected.sourcePath,
        }),
      },
    }
  }

  const reconciled = reconcileStartupPresetPicker(state, snapshot)
  switch (action.type) {
    case 'move-up':
      return { state: moveSelection(reconciled, snapshot, 'up') }
    case 'move-down':
      return { state: moveSelection(reconciled, snapshot, 'down') }
    case 'refresh':
      return { state: reconciled, outcome: { kind: 'refresh-requested' } }
    case 'escape':
      return { state: closePicker(reconciled), outcome: { kind: 'cancelled' } }
  }
}
