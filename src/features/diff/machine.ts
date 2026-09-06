import type { Direction } from '../../navigation/commands.ts'
import type { DiffProjection } from './projectors.ts'

export interface DiffSelection {
  readonly fileIndex: number
  readonly hunkIndex: number
  readonly lineIndex: number
  readonly horizontalOffset: number
}

interface DiffFeatureStateBase {
  readonly selection: DiffSelection
  readonly collapsedHunkIds: readonly string[]
}

export type DiffFeatureState =
  | DiffFeatureStateBase & {
      readonly phase: 'idle' | 'empty'
      readonly projection: null
      readonly error: null
    }
  | DiffFeatureStateBase & {
      readonly phase: 'loading'
      readonly projection: DiffProjection | null
      readonly error: null
    }
  | DiffFeatureStateBase & {
      readonly phase: 'ready'
      readonly projection: DiffProjection
      readonly error: null
    }
  | DiffFeatureStateBase & {
      readonly phase: 'failed'
      readonly projection: DiffProjection | null
      readonly error: unknown
    }

export type DiffFeatureEvent =
  | { readonly type: 'load-started' }
  | { readonly type: 'load-empty' }
  | { readonly type: 'load-succeeded'; readonly projection: DiffProjection }
  | { readonly type: 'load-failed'; readonly error: unknown }
  | { readonly type: 'move'; readonly direction: Direction }
  | {
      readonly type: 'page'
      readonly direction: 'up' | 'down'
      readonly size?: number
    }
  | { readonly type: 'move-hunk'; readonly direction: 'previous' | 'next' }
  | { readonly type: 'toggle-collapse' }
  | { readonly type: 'reset' }

export type DiffFeatureEffect =
  | { readonly type: 'view-invalidated' }
  | {
      readonly type: 'ensure-selection-visible'
      readonly selection: DiffSelection
    }

export interface DiffFeatureTransition {
  readonly state: DiffFeatureState
  readonly effects: readonly DiffFeatureEffect[]
}

const EMPTY_COLLAPSED: readonly string[] = Object.freeze([])
const EMPTY_EFFECTS: readonly DiffFeatureEffect[] = Object.freeze([])
const ORIGIN: DiffSelection = Object.freeze({
  fileIndex: 0,
  hunkIndex: 0,
  lineIndex: 0,
  horizontalOffset: 0,
})

export function createDiffFeatureState(): DiffFeatureState {
  return freezeState({
    phase: 'idle',
    projection: null,
    error: null,
    selection: ORIGIN,
    collapsedHunkIds: EMPTY_COLLAPSED,
  })
}

export function transitionDiffFeature(
  state: DiffFeatureState,
  event: DiffFeatureEvent,
): DiffFeatureTransition {
  switch (event.type) {
    case 'load-started':
      return changed(freezeState({
        phase: 'loading',
        projection: state.projection,
        error: null,
        selection: state.selection,
        collapsedHunkIds: state.collapsedHunkIds,
      }), [invalidate()])
    case 'load-empty':
      return changed(freezeState({
        phase: 'empty',
        projection: null,
        error: null,
        selection: ORIGIN,
        collapsedHunkIds: EMPTY_COLLAPSED,
      }), [invalidate()])
    case 'load-succeeded': {
      const sameDocument = state.projection?.digest === event.projection.digest
      const selection = sameDocument
        ? clampSelection(state.selection, event.projection)
        : firstSelection(event.projection)
      const collapsedHunkIds = sameDocument
        ? retainCollapsed(state.collapsedHunkIds, event.projection)
        : EMPTY_COLLAPSED
      return changed(freezeState({
        phase: 'ready',
        projection: event.projection,
        error: null,
        selection,
        collapsedHunkIds,
      }), [invalidate()])
    }
    case 'load-failed':
      return changed(freezeState({
        phase: 'failed',
        projection: state.projection,
        error: event.error,
        selection: state.selection,
        collapsedHunkIds: state.collapsedHunkIds,
      }), [invalidate()])
    case 'move':
      return move(state, event.direction)
    case 'page':
      return movePage(state, event.direction, event.size)
    case 'move-hunk':
      return moveHunk(state, event.direction)
    case 'toggle-collapse':
      return toggleCollapse(state)
    case 'reset':
      return changed(createDiffFeatureState(), [invalidate()])
    /* v8 ignore next 2 -- DiffFeatureEvent is exhausted above. */
    default:
      return assertNever(event)
  }
}

function move(state: DiffFeatureState, direction: Direction): DiffFeatureTransition {
  const projection = state.projection
  if (projection === null) return unchanged(state)
  if (direction === 'left' || direction === 'right') {
    return moveHorizontal(state, projection, direction)
  }
  const next = moveVertical(
    state.selection,
    projection,
    state.collapsedHunkIds,
    direction === 'up' ? -1 : 1,
  )
  return withSelection(state, next)
}

function movePage(
  state: DiffFeatureState,
  direction: 'up' | 'down',
  requestedSize: number | undefined,
): DiffFeatureTransition {
  const projection = state.projection
  if (projection === null) return unchanged(state)
  const size = requestedSize === undefined || !Number.isFinite(requestedSize)
    ? 10
    : Math.max(1, Math.floor(requestedSize))
  let selection = state.selection
  for (let index = 0; index < size; index += 1) {
    const next = moveVertical(
      selection,
      projection,
      state.collapsedHunkIds,
      direction === 'up' ? -1 : 1,
    )
    if (sameSelection(next, selection)) break
    selection = next
  }
  return withSelection(state, selection)
}

function moveHunk(
  state: DiffFeatureState,
  direction: 'previous' | 'next',
): DiffFeatureTransition {
  const projection = state.projection
  if (projection === null) return unchanged(state)
  const positions = hunkPositions(projection)
  if (positions.length === 0) return unchanged(state)
  const current = positions.findIndex(position => (
    position.fileIndex === state.selection.fileIndex
      && position.hunkIndex === state.selection.hunkIndex
  ))
  const nextIndex = Math.max(
    0,
    Math.min(positions.length - 1, current + (direction === 'previous' ? -1 : 1)),
  )
  const position = positions[nextIndex]!
  return withSelection(state, Object.freeze({
    ...state.selection,
    ...position,
    lineIndex: 0,
  }))
}

function toggleCollapse(state: DiffFeatureState): DiffFeatureTransition {
  const projection = state.projection
  if (projection === null) return unchanged(state)
  const hunk = selectedHunk(projection, state.selection)
  if (hunk === undefined) return unchanged(state)
  const collapsed = new Set(state.collapsedHunkIds)
  if (collapsed.has(hunk.id)) collapsed.delete(hunk.id)
  else collapsed.add(hunk.id)
  const next = freezeState({
    ...state,
    selection: Object.freeze({ ...state.selection, lineIndex: 0 }),
    collapsedHunkIds: Object.freeze([...collapsed]),
  } as DiffFeatureState)
  return changed(next, [invalidate(), ensureVisible(next.selection)])
}

function moveHorizontal(
  state: DiffFeatureState,
  projection: DiffProjection,
  direction: 'left' | 'right',
): DiffFeatureTransition {
  const hunk = selectedHunk(projection, state.selection)
  if (hunk === undefined) return unchanged(state)
  const isCollapsed = state.collapsedHunkIds.includes(hunk.id)
  if (direction === 'left' && !isCollapsed) return toggleCollapse(state)
  if (direction === 'right' && isCollapsed) return toggleCollapse(state)
  const horizontalOffset = direction === 'left'
    ? Math.max(0, state.selection.horizontalOffset - 1)
    : state.selection.horizontalOffset + 1
  return withSelection(state, Object.freeze({ ...state.selection, horizontalOffset }))
}

function moveVertical(
  selection: DiffSelection,
  projection: DiffProjection,
  collapsedHunkIds: readonly string[],
  delta: -1 | 1,
): DiffSelection {
  const positions = visibleLinePositions(projection, collapsedHunkIds)
  if (positions.length === 0) return selection
  const current = positions.findIndex(position => sameLogicalPosition(position, selection))
  const normalizedCurrent = current < 0 ? 0 : current
  const next = positions[Math.max(0, Math.min(positions.length - 1, normalizedCurrent + delta))]!
  return Object.freeze({ ...selection, ...next })
}

interface LogicalPosition {
  readonly fileIndex: number
  readonly hunkIndex: number
  readonly lineIndex: number
}

function visibleLinePositions(
  projection: DiffProjection,
  collapsedHunkIds: readonly string[],
): readonly LogicalPosition[] {
  return projection.files.flatMap((file, fileIndex) => (
    file.hunks.flatMap((hunk, hunkIndex) => {
      const count = collapsedHunkIds.includes(hunk.id) ? 1 : Math.max(1, hunk.lines.length)
      return Array.from({ length: count }, (_, lineIndex) => ({ fileIndex, hunkIndex, lineIndex }))
    })
  ))
}

function hunkPositions(projection: DiffProjection): readonly Omit<LogicalPosition, 'lineIndex'>[] {
  return projection.files.flatMap((file, fileIndex) => (
    file.hunks.map((_hunk, hunkIndex) => ({ fileIndex, hunkIndex }))
  ))
}

function firstSelection(projection: DiffProjection): DiffSelection {
  const first = hunkPositions(projection)[0]
  return first === undefined ? ORIGIN : Object.freeze({ ...ORIGIN, ...first })
}

function clampSelection(selection: DiffSelection, projection: DiffProjection): DiffSelection {
  const fileIndex = Math.max(0, Math.min(projection.files.length - 1, selection.fileIndex))
  const file = projection.files[fileIndex]
  if (file === undefined) return ORIGIN
  const hunkIndex = Math.max(0, Math.min(file.hunks.length - 1, selection.hunkIndex))
  const hunk = file.hunks[hunkIndex]
  if (hunk === undefined) return Object.freeze({ ...selection, fileIndex, hunkIndex: 0, lineIndex: 0 })
  return Object.freeze({
    ...selection,
    fileIndex,
    hunkIndex,
    lineIndex: Math.max(0, Math.min(Math.max(0, hunk.lines.length - 1), selection.lineIndex)),
  })
}

function retainCollapsed(
  ids: readonly string[],
  projection: DiffProjection,
): readonly string[] {
  const available = projection.files.flatMap(file => file.hunks.map(hunk => hunk.id))
  return Object.freeze(ids.filter(id => available.includes(id)))
}

function selectedHunk(projection: DiffProjection, selection: DiffSelection) {
  return projection.files[selection.fileIndex]?.hunks[selection.hunkIndex]
}

function withSelection(
  state: DiffFeatureState,
  selection: DiffSelection,
): DiffFeatureTransition {
  if (sameSelection(state.selection, selection)) return unchanged(state)
  const next = freezeState({ ...state, selection } as DiffFeatureState)
  return changed(next, [invalidate(), ensureVisible(next.selection)])
}

function sameLogicalPosition(left: LogicalPosition, right: DiffSelection): boolean {
  return left.fileIndex === right.fileIndex
    && left.hunkIndex === right.hunkIndex
    && left.lineIndex === right.lineIndex
}

function sameSelection(left: DiffSelection, right: DiffSelection): boolean {
  return sameLogicalPosition(left, right)
    && left.horizontalOffset === right.horizontalOffset
}

function freezeState(state: DiffFeatureState): DiffFeatureState {
  return Object.freeze({
    ...state,
    selection: Object.freeze({ ...state.selection }),
    collapsedHunkIds: Object.freeze([...state.collapsedHunkIds]),
  })
}

function changed(
  state: DiffFeatureState,
  effects: readonly DiffFeatureEffect[],
): DiffFeatureTransition {
  return Object.freeze({ state, effects: Object.freeze([...effects]) })
}

function unchanged(state: DiffFeatureState): DiffFeatureTransition {
  return Object.freeze({ state, effects: EMPTY_EFFECTS })
}

function invalidate(): DiffFeatureEffect {
  return Object.freeze({ type: 'view-invalidated' })
}

function ensureVisible(selection: DiffSelection): DiffFeatureEffect {
  return Object.freeze({ type: 'ensure-selection-visible', selection })
}

/* v8 ignore next 3 -- all public Diff events are exhausted in transitionDiffFeature. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Diff event: ${String(value)}`)
}
