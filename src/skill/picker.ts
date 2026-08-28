import {
  createPromptEditorState,
  reducePromptEditor,
  type PromptEditorAction,
  type PromptEditorState,
} from '../ui/prompt-editor.ts'
import type { SessionSkillEntry, SessionSkillsSnapshot } from './port.ts'

export interface SkillPickerState {
  readonly open: boolean
  readonly query: PromptEditorState
  readonly selectedName?: string
  readonly selectedIndex: number
}

export interface SkillPickerView {
  readonly query: PromptEditorState
  readonly rows: readonly SessionSkillEntry[]
  readonly selectedIndex: number
  readonly selectedName?: string
  readonly totalCount: number
  readonly available: boolean
  readonly loading: boolean
  readonly complete: boolean
  readonly stale: boolean
  readonly error?: string
}

export type SkillPickerAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'edit'; readonly action: PromptEditorAction }
  | { readonly type: 'pick' }
  | { readonly type: 'escape' }

export type SkillPickerOutcome =
  | { readonly kind: 'picked'; readonly name: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'blocked'; readonly reason: 'unavailable' | 'no-selection' }

export interface SkillPickerTransition {
  readonly state: SkillPickerState
  readonly outcome?: SkillPickerOutcome
}

function normalizedWords(value: string): readonly string[] {
  return value.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
}

function matches(entry: SessionSkillEntry, query: string): boolean {
  const words = normalizedWords(query)
  if (words.length === 0) return true
  const haystack = [
    entry.name,
    entry.description,
    entry.whenToUse,
    entry.source,
    entry.provider,
  ].filter((value): value is string => value !== undefined).join(' ').toLocaleLowerCase()
  return words.every(word => haystack.includes(word))
}

function filteredSkills(
  snapshot: SessionSkillsSnapshot,
  query: PromptEditorState,
): readonly SessionSkillEntry[] {
  return Object.freeze(snapshot.skills.filter(entry => matches(entry, query.text)))
}

function stateAt(
  open: boolean,
  query: PromptEditorState,
  rows: readonly SessionSkillEntry[],
  selectedIndex: number,
): SkillPickerState {
  const selected = rows[selectedIndex]
  return Object.freeze({
    open,
    query,
    ...(selected === undefined ? {} : { selectedName: selected.name }),
    selectedIndex: selected === undefined ? -1 : selectedIndex,
  })
}

function reconcile(
  state: SkillPickerState,
  snapshot: SessionSkillsSnapshot,
  forceOpen: boolean,
): SkillPickerState {
  const rows = filteredSkills(snapshot, state.query)
  const stable = state.selectedName === undefined
    ? -1
    : rows.findIndex(row => row.name === state.selectedName)
  const selectedIndex = stable >= 0 ? stable : rows.length === 0 ? -1 : 0
  const next = stateAt(forceOpen || state.open, state.query, rows, selectedIndex)
  if (
    next.open === state.open
    && next.query === state.query
    && next.selectedName === state.selectedName
    && next.selectedIndex === state.selectedIndex
  ) return state
  return next
}

export function createSkillPickerState(): SkillPickerState {
  return Object.freeze({
    open: false,
    query: createPromptEditorState(),
    selectedIndex: -1,
  })
}

export function openSkillPicker(
  state: SkillPickerState,
  snapshot: SessionSkillsSnapshot,
): SkillPickerState {
  const opening = state.open
    ? state
    : Object.freeze({
        open: false,
        query: createPromptEditorState(),
        selectedIndex: -1,
      })
  return reconcile(opening, snapshot, true)
}

export function reconcileSkillPicker(
  state: SkillPickerState,
  snapshot: SessionSkillsSnapshot,
): SkillPickerState {
  return state.open ? reconcile(state, snapshot, false) : state
}

export function selectSkillPicker(
  state: SkillPickerState,
  snapshot: SessionSkillsSnapshot,
): SkillPickerView | undefined {
  if (!state.open) return undefined
  const reconciled = reconcileSkillPicker(state, snapshot)
  const rows = filteredSkills(snapshot, reconciled.query)
  return Object.freeze({
    query: reconciled.query,
    rows,
    selectedIndex: reconciled.selectedIndex,
    ...(reconciled.selectedName === undefined ? {} : { selectedName: reconciled.selectedName }),
    totalCount: snapshot.skills.length,
    available: snapshot.available,
    loading: snapshot.loading,
    complete: snapshot.complete,
    stale: snapshot.stale,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  })
}

function move(
  state: SkillPickerState,
  snapshot: SessionSkillsSnapshot,
  direction: 'up' | 'down',
): SkillPickerState {
  const rows = filteredSkills(snapshot, state.query)
  if (rows.length === 0) return state
  const delta = direction === 'up' ? -1 : 1
  const selectedIndex = Math.min(
    rows.length - 1,
    Math.max(0, state.selectedIndex + delta),
  )
  return selectedIndex === state.selectedIndex
    ? state
    : stateAt(true, state.query, rows, selectedIndex)
}

export function applySkillPickerAction(
  state: SkillPickerState,
  snapshot: SessionSkillsSnapshot,
  action: SkillPickerAction,
): SkillPickerTransition {
  if (!state.open) return { state }
  const reconciled = reconcileSkillPicker(state, snapshot)
  switch (action.type) {
    case 'move-up':
    case 'move-down':
      return { state: move(reconciled, snapshot, action.type === 'move-up' ? 'up' : 'down') }
    case 'edit': {
      const query = reducePromptEditor(reconciled.query, action.action)
      if (query === reconciled.query) return { state: reconciled }
      return {
        state: reconcile({
          open: reconciled.open,
          query,
          selectedIndex: -1,
        }, snapshot, false),
      }
    }
    case 'escape':
      return {
        state: Object.freeze({ ...reconciled, open: false }),
        outcome: { kind: 'cancelled' },
      }
    case 'pick': {
      if (!snapshot.available) {
        return { state: reconciled, outcome: { kind: 'blocked', reason: 'unavailable' } }
      }
      const selected = filteredSkills(snapshot, reconciled.query)[reconciled.selectedIndex]
      if (selected === undefined) {
        return { state: reconciled, outcome: { kind: 'blocked', reason: 'no-selection' } }
      }
      return {
        state: Object.freeze({ ...reconciled, open: false }),
        outcome: { kind: 'picked', name: selected.name },
      }
    }
  }
}
