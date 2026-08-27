import type {
  SessionWorkbenchGoal,
  SessionWorkbenchGoalAction,
  SessionWorkbenchSnapshot,
} from './port.ts'
import {
  createPromptEditorState,
  reducePromptEditor,
  type PromptEditorAction,
  type PromptEditorState,
} from '../ui/prompt-editor.ts'

export type GoalActionSurfaceStage = 'menu' | 'edit' | 'confirm-clear'
export type GoalActionMenuKind = 'edit' | 'pause' | 'resume' | 'clear'

export interface GoalActionMenuRow {
  readonly kind: GoalActionMenuKind
  readonly label: string
  readonly description: string
}

/** Session-local state for the keyboard GoalBar equivalent. */
export interface GoalActionSurfaceState {
  readonly open: boolean
  readonly stage: GoalActionSurfaceStage
  readonly targetId?: string
  readonly targetRevision?: number
  readonly selectedIndex: number
  readonly editor: PromptEditorState
  readonly error: string | undefined
}

export interface GoalActionSurfaceView {
  readonly stage: GoalActionSurfaceStage
  readonly goal: SessionWorkbenchGoal
  readonly actions: readonly GoalActionMenuRow[]
  readonly selectedIndex: number
  readonly editor: PromptEditorState
  readonly error?: string
}

export type GoalActionSurfaceAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'enter' }
  | { readonly type: 'escape' }

export type GoalActionSurfaceOutcome =
  | {
      readonly kind: 'execute'
      readonly action: SessionWorkbenchGoalAction
      readonly successMessage: string
    }
  | { readonly kind: 'cancelled' }

export interface GoalActionSurfaceTransition {
  readonly state: GoalActionSurfaceState
  readonly outcome?: GoalActionSurfaceOutcome
}

const MENU_ROWS = {
  edit: {
    kind: 'edit',
    label: 'Edit objective',
    description: 'Replace the objective through the official Goal service.',
  },
  pause: {
    kind: 'pause',
    label: 'Pause goal',
    description: 'Stop automatic continuation and keep the durable goal.',
  },
  resume: {
    kind: 'resume',
    label: 'Resume goal',
    description: 'Arm automatic continuation from the current revision.',
  },
  clear: {
    kind: 'clear',
    label: 'Clear goal',
    description: 'Write the official tombstone while retaining session history.',
  },
} as const satisfies Record<GoalActionMenuKind, GoalActionMenuRow>

/** Current non-complete Goal that exposes GoalBar actions. */
export function goalActionTarget(
  snapshot: SessionWorkbenchSnapshot,
): SessionWorkbenchGoal | undefined {
  const goal = snapshot.goal
  return goal == null || goal.phase === 'complete' ? undefined : goal
}

function rowsFor(goal: SessionWorkbenchGoal): readonly GoalActionMenuRow[] {
  if (goal.phase === 'active') {
    return [MENU_ROWS.pause, MENU_ROWS.edit, MENU_ROWS.clear]
  }
  return [MENU_ROWS.resume, MENU_ROWS.edit, MENU_ROWS.clear]
}

function targetState(
  goal: SessionWorkbenchGoal,
  selectedIndex = 0,
): GoalActionSurfaceState {
  const actions = rowsFor(goal)
  const index = Math.min(actions.length - 1, Math.max(0, selectedIndex))
  return {
    open: true,
    stage: 'menu',
    targetId: goal.id,
    targetRevision: goal.revision,
    selectedIndex: index,
    editor: createPromptEditorState(),
    error: undefined,
  }
}

export function createGoalActionSurfaceState(): GoalActionSurfaceState {
  return {
    open: false,
    stage: 'menu',
    selectedIndex: 0,
    editor: createPromptEditorState(),
    error: undefined,
  }
}

export function openGoalActionSurface(
  state: GoalActionSurfaceState,
  snapshot: SessionWorkbenchSnapshot,
): GoalActionSurfaceState {
  const goal = goalActionTarget(snapshot)
  if (goal === undefined) return state
  return targetState(goal, state.selectedIndex)
}

export function reconcileGoalActionSurface(
  state: GoalActionSurfaceState,
  snapshot: SessionWorkbenchSnapshot,
): GoalActionSurfaceState {
  if (!state.open) return state
  const goal = goalActionTarget(snapshot)
  if (goal === undefined) return createGoalActionSurfaceState()
  if (state.targetId === goal.id && state.targetRevision === goal.revision) return state
  return targetState(goal, state.selectedIndex)
}

function displayEditor(
  state: GoalActionSurfaceState,
  actions: readonly GoalActionMenuRow[],
): PromptEditorState {
  if (state.stage === 'edit') return state.editor
  const text = state.stage === 'confirm-clear'
    ? 'Confirm clear'
    : actions[state.selectedIndex]?.label ?? ''
  return createPromptEditorState(text)
}

export function selectGoalActionSurface(
  state: GoalActionSurfaceState,
  snapshot: SessionWorkbenchSnapshot,
): GoalActionSurfaceView | undefined {
  const goal = goalActionTarget(snapshot)
  if (goal === undefined) return undefined
  const reconciled = reconcileGoalActionSurface(state, snapshot)
  if (!reconciled.open) return undefined
  const actions = rowsFor(goal)
  return {
    stage: reconciled.stage,
    goal,
    actions,
    selectedIndex: reconciled.selectedIndex,
    editor: displayEditor(reconciled, actions),
    ...(reconciled.error === undefined ? {} : { error: reconciled.error }),
  }
}

function goalRef(goal: SessionWorkbenchGoal): { readonly id: string; readonly revision: number } {
  return { id: goal.id, revision: goal.revision }
}

function executeOutcome(
  action: SessionWorkbenchGoalAction,
  successMessage: string,
): GoalActionSurfaceOutcome {
  return { kind: 'execute', action, successMessage }
}

function selectMenuAction(
  state: GoalActionSurfaceState,
  goal: SessionWorkbenchGoal,
): GoalActionSurfaceTransition {
  const selected = rowsFor(goal)[state.selectedIndex]
  if (selected === undefined) return { state }
  const ref = goalRef(goal)
  switch (selected.kind) {
    case 'edit':
      return {
        state: {
          ...state,
          stage: 'edit',
          editor: createPromptEditorState(),
          error: undefined,
        },
      }
    case 'clear':
      return { state: { ...state, stage: 'confirm-clear', error: undefined } }
    case 'pause':
      return {
        state,
        outcome: executeOutcome({ kind: 'pause', ref }, 'Goal paused'),
      }
    case 'resume':
      return {
        state,
        outcome: executeOutcome({ kind: 'resume', ref }, 'Goal resumed'),
      }
  }
}

function submitEdit(
  state: GoalActionSurfaceState,
  goal: SessionWorkbenchGoal,
): GoalActionSurfaceTransition {
  const objective = state.editor.text.trim()
  if (objective === '') {
    return { state: { ...state, error: 'Replacement objective must be nonblank.' } }
  }
  return {
    state,
    outcome: executeOutcome(
      { kind: 'edit', ref: goalRef(goal), objective },
      'Goal objective updated',
    ),
  }
}

export function applyGoalActionSurfaceAction(
  state: GoalActionSurfaceState,
  snapshot: SessionWorkbenchSnapshot,
  action: GoalActionSurfaceAction,
): GoalActionSurfaceTransition {
  const goal = goalActionTarget(snapshot)
  if (goal === undefined) {
    return { state: reconcileGoalActionSurface(state, snapshot) }
  }
  const reconciled = reconcileGoalActionSurface(state, snapshot)
  if (!reconciled.open) return { state: reconciled }

  if (action.type === 'escape') {
    if (reconciled.stage === 'menu') {
      return {
        state: createGoalActionSurfaceState(),
        outcome: { kind: 'cancelled' },
      }
    }
    return { state: targetState(goal, reconciled.selectedIndex) }
  }

  if (reconciled.stage === 'edit') {
    return action.type === 'enter' ? submitEdit(reconciled, goal) : { state: reconciled }
  }
  if (reconciled.stage === 'confirm-clear') {
    return action.type === 'enter'
      ? {
          state: reconciled,
          outcome: executeOutcome(
            { kind: 'clear', ref: goalRef(goal) },
            'Goal cleared',
          ),
        }
      : { state: reconciled }
  }
  if (action.type === 'enter') return selectMenuAction(reconciled, goal)

  const delta = action.type === 'move-up' ? -1 : 1
  const actions = rowsFor(goal)
  const selectedIndex = Math.min(
    actions.length - 1,
    Math.max(0, reconciled.selectedIndex + delta),
  )
  if (selectedIndex === reconciled.selectedIndex && reconciled.error === undefined) {
    return { state: reconciled }
  }
  return { state: { ...reconciled, selectedIndex, error: undefined } }
}

export function reduceGoalActionSurfaceEditor(
  state: GoalActionSurfaceState,
  action: PromptEditorAction,
): GoalActionSurfaceState {
  if (!state.open || state.stage !== 'edit') return state
  const editor = reducePromptEditor(state.editor, action)
  if (editor === state.editor && state.error === undefined) return state
  return { ...state, editor, error: undefined }
}

export function rejectGoalActionSurface(
  state: GoalActionSurfaceState,
  message: string,
): GoalActionSurfaceState {
  return state.open ? { ...state, error: message } : state
}
