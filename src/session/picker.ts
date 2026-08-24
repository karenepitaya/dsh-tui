import type {
  SessionCatalogEntry,
  SessionCatalogSnapshot,
} from './catalog-port.ts'

export const SESSION_PICKER_LIMIT = 8

export interface SessionPickerState {
  readonly open: boolean
  /** Stable identity used when a refreshed catalog reorders its rows. */
  readonly selectedSessionId?: string
  /** Last absolute index, used only to clamp when the selected identity disappears. */
  readonly selectedIndex: number
}

export type SessionPickerRelation = 'current' | 'cold' | 'other-live'

export interface SessionPickerRow {
  readonly sessionId: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSessionId?: string
  readonly isSubagent: boolean
  readonly creationAgentPreset?: string
  readonly attached: boolean
  readonly durablePresence: SessionCatalogEntry['durablePresence']
  readonly liveStatus?: NonNullable<SessionCatalogEntry['liveStatus']>
  readonly relation: SessionPickerRelation
}

export interface SessionPickerView {
  readonly durability: SessionCatalogSnapshot['durability']
  readonly rows: readonly SessionPickerRow[]
  /** Selected index within the bounded `rows` window. */
  readonly selectedIndex: number
  readonly selectedSessionId?: string
  readonly offset: number
  readonly totalCount: number
}

export type SessionPickerAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'escape' }
  | { readonly type: 'enter' }

export type SessionPickerOutcome =
  | { readonly kind: 'dismissed' }
  | {
      readonly kind: 'noop'
      readonly reason: 'already-current'
      readonly sessionId: string
    }
  | { readonly kind: 'noop'; readonly reason: 'no-selection' }
  | {
      readonly kind: 'read-only'
      readonly reason: 'session-switch-not-implemented'
      readonly sessionId: string
      readonly relation: Exclude<SessionPickerRelation, 'current'>
    }

export interface SessionPickerTransition {
  readonly state: SessionPickerState
  readonly outcome?: SessionPickerOutcome
}

function stateAt(
  open: boolean,
  sessions: readonly SessionCatalogEntry[],
  selectedIndex: number,
): SessionPickerState {
  const selected = sessions[selectedIndex]
  return Object.freeze({
    open,
    ...(selected === undefined ? {} : { selectedSessionId: selected.sessionId }),
    selectedIndex: selected === undefined ? -1 : selectedIndex,
  })
}

function sameSelection(
  state: SessionPickerState,
  next: SessionPickerState,
): boolean {
  return state.open === next.open
    && state.selectedSessionId === next.selectedSessionId
    && state.selectedIndex === next.selectedIndex
}

function currentIndex(
  snapshot: SessionCatalogSnapshot,
  currentSessionId: string | undefined,
): number {
  return currentSessionId === undefined
    ? -1
    : snapshot.sessions.findIndex(entry => entry.sessionId === currentSessionId)
}

function clampedIndex(index: number, count: number): number {
  if (count === 0) return -1
  return Math.min(count - 1, Math.max(0, index))
}

export function createSessionPickerState(): SessionPickerState {
  return Object.freeze({ open: false, selectedIndex: -1 })
}

export function openSessionPicker(
  state: SessionPickerState,
  snapshot: SessionCatalogSnapshot,
  currentSessionId?: string,
): SessionPickerState {
  const stableIndex = state.selectedSessionId === undefined
    ? -1
    : snapshot.sessions.findIndex(entry => entry.sessionId === state.selectedSessionId)
  const preferredIndex = stableIndex >= 0
    ? stableIndex
    : currentIndex(snapshot, currentSessionId)
  const selectedIndex = preferredIndex >= 0
    ? preferredIndex
    : clampedIndex(state.selectedIndex, snapshot.sessions.length)
  const fallbackIndex = selectedIndex >= 0
    ? selectedIndex
    : clampedIndex(0, snapshot.sessions.length)
  const next = stateAt(true, snapshot.sessions, fallbackIndex)
  return sameSelection(state, next) ? state : next
}

export function reconcileSessionPicker(
  state: SessionPickerState,
  snapshot: SessionCatalogSnapshot,
  currentSessionId?: string,
): SessionPickerState {
  if (!state.open) return state
  const stableIndex = state.selectedSessionId === undefined
    ? -1
    : snapshot.sessions.findIndex(entry => entry.sessionId === state.selectedSessionId)
  const firstIndex = state.selectedIndex < 0
    ? currentIndex(snapshot, currentSessionId)
    : state.selectedIndex
  const selectedIndex = stableIndex >= 0
    ? stableIndex
    : clampedIndex(firstIndex, snapshot.sessions.length)
  const fallbackIndex = selectedIndex >= 0
    ? selectedIndex
    : clampedIndex(0, snapshot.sessions.length)
  const next = stateAt(true, snapshot.sessions, fallbackIndex)
  return sameSelection(state, next) ? state : next
}

function relationOf(
  entry: SessionCatalogEntry,
  currentSessionId: string | undefined,
): SessionPickerRelation {
  if (entry.sessionId === currentSessionId) return 'current'
  return entry.attached ? 'other-live' : 'cold'
}

function detachedRow(
  entry: SessionCatalogEntry,
  currentSessionId: string | undefined,
): SessionPickerRow {
  return Object.freeze({
    sessionId: entry.sessionId,
    createdAt: entry.createdAt,
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    ...(entry.parentSessionId === undefined ? {} : { parentSessionId: entry.parentSessionId }),
    isSubagent: entry.isSubagent,
    ...(entry.creationAgentPreset === undefined
      ? {}
      : { creationAgentPreset: entry.creationAgentPreset }),
    attached: entry.attached,
    durablePresence: entry.durablePresence,
    ...(entry.liveStatus === undefined ? {} : { liveStatus: entry.liveStatus }),
    relation: relationOf(entry, currentSessionId),
  })
}

export function selectSessionPicker(
  state: SessionPickerState,
  snapshot: SessionCatalogSnapshot,
  currentSessionId?: string,
): SessionPickerView | undefined {
  if (!state.open) return undefined
  const reconciled = reconcileSessionPicker(state, snapshot, currentSessionId)
  const maxOffset = Math.max(0, snapshot.sessions.length - SESSION_PICKER_LIMIT)
  const offset = reconciled.selectedIndex < 0
    ? 0
    : Math.min(
        maxOffset,
        Math.max(0, reconciled.selectedIndex - SESSION_PICKER_LIMIT + 1),
      )
  const rows = Object.freeze(snapshot.sessions
    .slice(offset, offset + SESSION_PICKER_LIMIT)
    .map(entry => detachedRow(entry, currentSessionId)))
  return Object.freeze({
    durability: snapshot.durability,
    rows,
    selectedIndex: reconciled.selectedIndex < 0
      ? -1
      : reconciled.selectedIndex - offset,
    ...(reconciled.selectedSessionId === undefined
      ? {}
      : { selectedSessionId: reconciled.selectedSessionId }),
    offset,
    totalCount: snapshot.sessions.length,
  })
}

function moveSelection(
  state: SessionPickerState,
  snapshot: SessionCatalogSnapshot,
  direction: 'up' | 'down',
): SessionPickerState {
  if (state.selectedIndex < 0) return state
  const delta = direction === 'up' ? -1 : 1
  const selectedIndex = clampedIndex(
    state.selectedIndex + delta,
    snapshot.sessions.length,
  )
  if (selectedIndex === state.selectedIndex) return state
  return stateAt(true, snapshot.sessions, selectedIndex)
}

export function applySessionPickerAction(
  state: SessionPickerState,
  snapshot: SessionCatalogSnapshot,
  currentSessionId: string | undefined,
  action: SessionPickerAction,
): SessionPickerTransition {
  if (!state.open) return { state }
  const reconciled = reconcileSessionPicker(state, snapshot, currentSessionId)
  switch (action.type) {
    case 'move-up':
      return { state: moveSelection(reconciled, snapshot, 'up') }
    case 'move-down':
      return { state: moveSelection(reconciled, snapshot, 'down') }
    case 'escape':
      return {
        state: Object.freeze({ ...reconciled, open: false }),
        outcome: { kind: 'dismissed' },
      }
    case 'enter': {
      const selected = snapshot.sessions[reconciled.selectedIndex]
      if (selected === undefined) {
        return { state: reconciled, outcome: { kind: 'noop', reason: 'no-selection' } }
      }
      const relation = relationOf(selected, currentSessionId)
      return relation === 'current'
        ? {
            state: reconciled,
            outcome: {
              kind: 'noop',
              reason: 'already-current',
              sessionId: selected.sessionId,
            },
          }
        : {
            state: reconciled,
            outcome: {
              kind: 'read-only',
              reason: 'session-switch-not-implemented',
              sessionId: selected.sessionId,
              relation,
            },
          }
    }
  }
}
