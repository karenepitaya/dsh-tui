import {
  createPromptEditorState,
  reducePromptEditor,
  type PromptEditorAction,
  type PromptEditorState,
} from '../ui/prompt-editor.ts'
import type {
  SessionToolEntry,
  SessionToolGroup,
  SessionToolsSnapshot,
} from './port.ts'
import type { LegacyDirectoryState } from '../navigation/legacy-directory.ts'

export interface ToolBrowserState extends LegacyDirectoryState {
  readonly open: boolean
  readonly query: PromptEditorState
  readonly selectedName?: string
  readonly selectedIndex: number
}

export interface ToolBrowserGroup {
  readonly id: SessionToolGroup
  readonly label: string
  readonly count: number
}

export interface ToolBrowserView extends LegacyDirectoryState {
  readonly query: PromptEditorState
  readonly rows: readonly SessionToolEntry[]
  readonly selectedIndex: number
  readonly selected?: SessionToolEntry
  readonly groups: readonly ToolBrowserGroup[]
  readonly totalCount: number
  readonly available: boolean
  readonly stale: boolean
  readonly generation: number
  readonly error?: string
}

export type ToolBrowserAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'edit'; readonly action: PromptEditorAction }
  | { readonly type: 'escape' }

export interface ToolBrowserTransition {
  readonly state: ToolBrowserState
  readonly outcome?: { readonly kind: 'cancelled' }
}

const GROUP_LABELS: Readonly<Record<SessionToolGroup, string>> = Object.freeze({
  core: 'Core',
  mcp: 'MCP',
  transport: 'Code transport',
})

const GROUP_ORDER = ['core', 'mcp', 'transport'] as const

function wordsOf(value: string): readonly string[] {
  return value.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
}

function matches(tool: SessionToolEntry, query: string): boolean {
  const words = wordsOf(query)
  if (words.length === 0) return true
  const haystack = [
    tool.name,
    tool.description,
    GROUP_LABELS[tool.group],
    ...tool.parameterNames,
  ].join(' ').toLocaleLowerCase()
  return words.every(word => haystack.includes(word))
}

function filteredTools(
  snapshot: SessionToolsSnapshot,
  query: PromptEditorState,
): readonly SessionToolEntry[] {
  return Object.freeze(snapshot.tools.filter(tool => matches(tool, query.text)))
}

function stateAt(
  open: boolean,
  query: PromptEditorState,
  rows: readonly SessionToolEntry[],
  selectedIndex: number,
): ToolBrowserState {
  const selected = rows[selectedIndex]
  return Object.freeze({
    open,
    query,
    ...(selected === undefined ? {} : { selectedName: selected.name }),
    selectedIndex: selected === undefined ? -1 : selectedIndex,
  })
}

function reconcile(
  state: ToolBrowserState,
  snapshot: SessionToolsSnapshot,
  forceOpen: boolean,
): ToolBrowserState {
  const rows = filteredTools(snapshot, state.query)
  const stable = state.selectedName === undefined
    ? -1
    : rows.findIndex(row => row.name === state.selectedName)
  const selectedIndex = stable >= 0 ? stable : rows.length === 0 ? -1 : 0
  const next = { ...stateAt(forceOpen || state.open, state.query, rows, selectedIndex),
    ...(state.navigation === undefined ? {} : { navigation: state.navigation }) }
  if (
    next.open === state.open
    && next.query === state.query
    && next.selectedName === state.selectedName
    && next.selectedIndex === state.selectedIndex
  ) return state
  return next
}

export function createToolBrowserState(): ToolBrowserState {
  return Object.freeze({
    open: false,
    query: createPromptEditorState(),
    selectedIndex: -1,
  })
}

export function openToolBrowser(
  state: ToolBrowserState,
  snapshot: SessionToolsSnapshot,
): ToolBrowserState {
  const opening = state.open
    ? state
    : Object.freeze({
        open: false,
        query: createPromptEditorState(),
        selectedIndex: -1,
      })
  return reconcile(opening, snapshot, true)
}

export function reconcileToolBrowser(
  state: ToolBrowserState,
  snapshot: SessionToolsSnapshot,
): ToolBrowserState {
  return state.open ? reconcile(state, snapshot, false) : state
}

export function selectToolBrowser(
  state: ToolBrowserState,
  snapshot: SessionToolsSnapshot,
): ToolBrowserView | undefined {
  if (!state.open) return undefined
  const reconciled = reconcileToolBrowser(state, snapshot)
  const rows = filteredTools(snapshot, reconciled.query)
  const groups = Object.freeze(GROUP_ORDER.map(id => Object.freeze({
    id,
    label: GROUP_LABELS[id],
    count: rows.filter(row => row.group === id).length,
  })))
  const selected = rows[reconciled.selectedIndex]
  return Object.freeze({
    query: reconciled.query,
    ...(reconciled.navigation === undefined ? {} : { navigation: reconciled.navigation }),
    rows,
    selectedIndex: reconciled.selectedIndex,
    ...(selected === undefined ? {} : { selected }),
    groups,
    totalCount: snapshot.tools.length,
    available: snapshot.available,
    stale: snapshot.stale,
    generation: snapshot.generation,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  })
}

function move(
  state: ToolBrowserState,
  snapshot: SessionToolsSnapshot,
  direction: 'up' | 'down',
): ToolBrowserState {
  const rows = filteredTools(snapshot, state.query)
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

export function applyToolBrowserAction(
  state: ToolBrowserState,
  snapshot: SessionToolsSnapshot,
  action: ToolBrowserAction,
): ToolBrowserTransition {
  if (!state.open) return { state }
  const reconciled = reconcileToolBrowser(state, snapshot)
  switch (action.type) {
    case 'move-up':
    case 'move-down':
      return {
        state: move(
          reconciled,
          snapshot,
          action.type === 'move-up' ? 'up' : 'down',
        ),
      }
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
  }
}
