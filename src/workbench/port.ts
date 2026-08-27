/** Product-owned durable Goal lifecycle shown by the TUI workbench. */
export type SessionWorkbenchGoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

export interface SessionWorkbenchGoalBlockReason {
  readonly code: string
  readonly message: string
}

/** Detached view of the official whole Goal projection. */
export interface SessionWorkbenchGoal {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly phase: SessionWorkbenchGoalPhase
  readonly blockedReason?: SessionWorkbenchGoalBlockReason
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Exact official Goal revision targeted by a first-party TUI action. */
export interface SessionWorkbenchGoalRef {
  readonly id: string
  readonly revision: number
}

/** Goal mutations exposed by the official Web GoalBar and mirrored by the TUI. */
export type SessionWorkbenchGoalAction =
  | {
      readonly kind: 'edit'
      readonly ref: SessionWorkbenchGoalRef
      readonly objective: string
    }
  | { readonly kind: 'pause'; readonly ref: SessionWorkbenchGoalRef }
  | { readonly kind: 'resume'; readonly ref: SessionWorkbenchGoalRef }
  | { readonly kind: 'clear'; readonly ref: SessionWorkbenchGoalRef }

/** Settled same-process Goal mutation; projection updates remain the view truth. */
export type SessionWorkbenchGoalActionReceipt =
  | { readonly accepted: true }
  | {
      readonly accepted: false
      readonly code: string
      readonly message: string
    }

/** Logged Plan-mode state; pending means the selected target is not committed yet. */
export interface SessionWorkbenchPlan {
  readonly active: boolean
  readonly pending: boolean
}

export type SessionWorkbenchTodoStatus = 'pending' | 'in_progress' | 'completed'

/** One item from the official whole todo/write list. */
export interface SessionWorkbenchTodo {
  readonly content: string
  readonly status: SessionWorkbenchTodoStatus
}

/**
 * Detached view of the official Session projections. Missing fields mean the
 * corresponding Harness capability is not composed; null is its real empty value.
 */
export interface SessionWorkbenchSnapshot {
  readonly available: boolean
  readonly asOfSeq?: number
  readonly goal?: SessionWorkbenchGoal | null
  readonly plan?: SessionWorkbenchPlan
  readonly todos?: readonly SessionWorkbenchTodo[] | null
}

/** Optional workbench projection capability carried by one live Session lease. */
export interface SessionWorkbenchPort {
  workbenchSnapshot(): SessionWorkbenchSnapshot
  onWorkbenchChanged(listener: () => void): () => void
  runGoalAction(action: SessionWorkbenchGoalAction): SessionWorkbenchGoalActionReceipt
  disposeWorkbench(): void
}

const UNAVAILABLE_WORKBENCH_SNAPSHOT: SessionWorkbenchSnapshot = Object.freeze({
  available: false,
})

/** Compatibility seam for profiles without Goal, Plan, or Todo projections. */
export function createUnavailableSessionWorkbenchPort(): SessionWorkbenchPort {
  return {
    workbenchSnapshot: () => UNAVAILABLE_WORKBENCH_SNAPSHOT,
    onWorkbenchChanged: () => () => {},
    runGoalAction: () => ({
      accepted: false,
      code: 'goal-capability-unavailable',
      message: 'Goal actions are unavailable in this Session composition.',
    }),
    disposeWorkbench: () => {},
  }
}
