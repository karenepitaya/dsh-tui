import type {
  SessionJob,
  SessionJobAction,
  SessionJobRef,
  SessionJobsSnapshot,
} from './port.ts'

export interface JobsActivityState {
  readonly open: boolean
  readonly generation: number
  readonly target?: SessionJobRef
  readonly confirmKill: boolean
  readonly error: string | undefined
  readonly notice: string | undefined
}

export interface JobsActivityRow extends SessionJob {
  readonly selected: boolean
}

export interface JobsActivityView {
  readonly rows: readonly JobsActivityRow[]
  readonly selectedIndex: number
  readonly confirmKill: boolean
  readonly error?: string
  readonly notice?: string
}

export type JobsActivityAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'request-kill' }
  | { readonly type: 'enter' }
  | { readonly type: 'escape' }

export type JobsActivityOutcome =
  | {
      readonly kind: 'execute'
      readonly action: SessionJobAction
      readonly successMessage: string
    }
  | { readonly kind: 'cancelled' }

export interface JobsActivityTransition {
  readonly state: JobsActivityState
  readonly outcome?: JobsActivityOutcome
}

function displayJobs(snapshot: SessionJobsSnapshot): readonly SessionJob[] {
  return [...snapshot.jobs].reverse()
}

function refFor(job: SessionJob, generation: number): SessionJobRef {
  return { id: job.id, startedAt: job.startedAt, generation }
}

function sameRegistration(job: SessionJob, ref: SessionJobRef | undefined): boolean {
  return ref !== undefined && job.id === ref.id && job.startedAt === ref.startedAt
}

function targetState(snapshot: SessionJobsSnapshot): JobsActivityState {
  const target = displayJobs(snapshot)[0]
  return {
    open: true,
    generation: snapshot.generation,
    ...(target === undefined ? {} : { target: refFor(target, snapshot.generation) }),
    confirmKill: false,
    error: undefined,
    notice: undefined,
  }
}

export function createJobsActivityState(): JobsActivityState {
  return {
    open: false,
    generation: 0,
    confirmKill: false,
    error: undefined,
    notice: undefined,
  }
}

export function openJobsActivity(
  state: JobsActivityState,
  snapshot: SessionJobsSnapshot,
): JobsActivityState {
  return snapshot.available ? targetState(snapshot) : state
}

export function reconcileJobsActivity(
  state: JobsActivityState,
  snapshot: SessionJobsSnapshot,
): JobsActivityState {
  if (!state.open) return state
  if (!snapshot.available) return createJobsActivityState()
  if (state.generation !== snapshot.generation) return targetState(snapshot)

  const rows = displayJobs(snapshot)
  const selected = rows.find(job => sameRegistration(job, state.target))
  if (selected === undefined) {
    const target = rows[0]
    if (target === undefined && state.target === undefined) return state
    if (target === undefined) {
      return {
        open: state.open,
        generation: state.generation,
        confirmKill: false,
        error: undefined,
        notice: state.notice,
      }
    }
    return {
      ...state,
      target: refFor(target, snapshot.generation),
      confirmKill: false,
      error: undefined,
    }
  }
  if (state.confirmKill && selected.status !== 'running') {
    return { ...state, confirmKill: false }
  }
  return state
}

export function selectJobsActivity(
  state: JobsActivityState,
  snapshot: SessionJobsSnapshot,
): JobsActivityView | undefined {
  const reconciled = reconcileJobsActivity(state, snapshot)
  if (!reconciled.open) return undefined
  const jobs = displayJobs(snapshot)
  const selectedIndex = jobs.findIndex(job => sameRegistration(job, reconciled.target))
  return {
    rows: jobs.map((job, index) => ({ ...job, selected: index === selectedIndex })),
    selectedIndex,
    confirmKill: reconciled.confirmKill,
    ...(reconciled.error === undefined ? {} : { error: reconciled.error }),
    ...(reconciled.notice === undefined ? {} : { notice: reconciled.notice }),
  }
}

function moveSelection(
  state: JobsActivityState,
  snapshot: SessionJobsSnapshot,
  delta: -1 | 1,
): JobsActivityState {
  if (state.confirmKill) return state
  const jobs = displayJobs(snapshot)
  if (jobs.length === 0) return state
  const current = jobs.findIndex(job => sameRegistration(job, state.target))
  const selectedIndex = Math.min(
    jobs.length - 1,
    Math.max(0, current + delta),
  )
  if (
    selectedIndex === current
    && state.error === undefined
    && state.notice === undefined
  ) return state
  return {
    ...state,
    target: refFor(jobs[selectedIndex]!, snapshot.generation),
    error: undefined,
    notice: undefined,
  }
}

function requestKill(
  state: JobsActivityState,
  snapshot: SessionJobsSnapshot,
): JobsActivityState {
  const job = displayJobs(snapshot).find(candidate => sameRegistration(candidate, state.target))
  if (job === undefined) return state
  if (job.status !== 'running') {
    const description = job.status === 'stopping'
      ? 'already stopping'
      : `already ${job.status}`
    return {
      ...state,
      confirmKill: false,
      error: `Job ${job.id} is ${description}.`,
      notice: undefined,
    }
  }
  return {
    ...state,
    confirmKill: true,
    error: undefined,
    notice: undefined,
  }
}

export function applyJobsActivityAction(
  state: JobsActivityState,
  snapshot: SessionJobsSnapshot,
  action: JobsActivityAction,
): JobsActivityTransition {
  const reconciled = reconcileJobsActivity(state, snapshot)
  if (!reconciled.open) return { state: reconciled }

  if (action.type === 'escape') {
    if (reconciled.confirmKill) {
      return { state: { ...reconciled, confirmKill: false } }
    }
    return {
      state: createJobsActivityState(),
      outcome: { kind: 'cancelled' },
    }
  }
  if (action.type === 'move-up') {
    return { state: moveSelection(reconciled, snapshot, -1) }
  }
  if (action.type === 'move-down') {
    return { state: moveSelection(reconciled, snapshot, 1) }
  }
  if (action.type === 'request-kill') {
    return { state: requestKill(reconciled, snapshot) }
  }
  if (!reconciled.confirmKill || reconciled.target === undefined) {
    return { state: reconciled }
  }
  return {
    state: reconciled,
    outcome: {
      kind: 'execute',
      action: { kind: 'kill', ref: reconciled.target },
      successMessage: `Stop requested for ${reconciled.target.id}`,
    },
  }
}

export function rejectJobsActivity(
  state: JobsActivityState,
  message: string,
): JobsActivityState {
  return state.open
    ? { ...state, confirmKill: false, error: message, notice: undefined }
    : state
}

export function resolveJobsActivity(
  state: JobsActivityState,
  message: string,
): JobsActivityState {
  return state.open
    ? { ...state, confirmKill: false, error: undefined, notice: message }
    : state
}
