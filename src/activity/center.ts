import type {
  SessionDelegationAction,
  SessionDelegationSnapshot,
  SessionSubagent,
  SessionWorkflowRun,
  SessionWorkflowStatus,
} from './delegation-port.ts'
import type {
  SessionJob,
  SessionJobAction,
  SessionJobsSnapshot,
} from './port.ts'

export type ActivityCenterTab = 'jobs' | 'subagents' | 'workflows'

export interface ActivityCenterState {
  readonly open: boolean
  readonly tab: ActivityCenterTab
  readonly targets: Readonly<Record<ActivityCenterTab, string | undefined>>
  readonly confirmStop: boolean
  readonly error: string | undefined
  readonly notice: string | undefined
}

export interface ActivityCenterTabView {
  readonly id: ActivityCenterTab
  readonly label: string
  readonly count: number
  readonly live: number
  readonly selected: boolean
}

export interface ActivityCenterRow {
  readonly key: string
  readonly title: string
  readonly meta: string
  readonly status: string
  readonly statusTone: SessionWorkflowStatus | 'stopping' | 'killed' | 'idle' | 'ready' | 'inactive' | 'diagnostic'
  readonly depth: number
  readonly selected: boolean
  readonly stoppable: boolean
  readonly detail: readonly string[]
}

export interface ActivityCenterView {
  readonly tab: ActivityCenterTab
  readonly tabs: readonly ActivityCenterTabView[]
  readonly rows: readonly ActivityCenterRow[]
  readonly selectedIndex: number
  readonly confirmStop: boolean
  readonly loading: boolean
  readonly subagentsAvailable: boolean
  readonly error?: string
  readonly notice?: string
}

export type ActivityCenterAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'tab-next' }
  | { readonly type: 'tab-previous' }
  | { readonly type: 'request-stop' }
  | { readonly type: 'refresh' }
  | { readonly type: 'enter' }
  | { readonly type: 'escape' }

export type ActivityCenterOutcome =
  | {
      readonly kind: 'job-action'
      readonly action: SessionJobAction
      readonly successMessage: string
    }
  | {
      readonly kind: 'delegation-action'
      readonly action: SessionDelegationAction
      readonly successMessage: string
    }
  | { readonly kind: 'refresh-delegation' }
  | { readonly kind: 'cancelled' }

export interface ActivityCenterTransition {
  readonly state: ActivityCenterState
  readonly outcome?: ActivityCenterOutcome
}

const TABS: readonly ActivityCenterTab[] = ['jobs', 'subagents', 'workflows']

function emptyTargets(): Readonly<Record<ActivityCenterTab, string | undefined>> {
  return { jobs: undefined, subagents: undefined, workflows: undefined }
}

export function createActivityCenterState(): ActivityCenterState {
  return {
    open: false,
    tab: 'jobs',
    targets: emptyTargets(),
    confirmStop: false,
    error: undefined,
    notice: undefined,
  }
}

function jobKey(job: SessionJob): string {
  return `job:${job.id.length}:${job.id}:${job.startedAt}`
}

function subagentKey(subagent: SessionSubagent): string {
  return `subagent:${subagent.id.length}:${subagent.id}:${subagent.parentId}`
}

function workflowKey(workflow: SessionWorkflowRun): string {
  return `workflow:${workflow.id.length}:${workflow.id}`
}

function jobs(snapshot: SessionJobsSnapshot): readonly SessionJob[] {
  return [...snapshot.jobs].reverse()
}

function keysFor(
  tab: ActivityCenterTab,
  jobsSnapshot: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
): readonly string[] {
  switch (tab) {
    case 'jobs': return jobs(jobsSnapshot).map(jobKey)
    case 'subagents': return delegation.subagents.map(subagentKey)
    case 'workflows': return delegation.workflows.map(workflowKey)
  }
}

function reconcileTarget(
  state: ActivityCenterState,
  jobsSnapshot: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
): ActivityCenterState {
  if (!state.open) return state
  const keys = keysFor(state.tab, jobsSnapshot, delegation)
  const target = state.targets[state.tab]
  if (target !== undefined && keys.includes(target)) return state
  const next = keys[0]
  if (target === next && !state.confirmStop) return state
  return {
    ...state,
    targets: { ...state.targets, [state.tab]: next },
    confirmStop: false,
    error: undefined,
  }
}

export function openActivityCenter(
  state: ActivityCenterState,
  jobsSnapshot: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
): ActivityCenterState {
  const open = {
    ...state,
    open: true,
    confirmStop: false,
    error: undefined,
    notice: undefined,
  }
  return reconcileTarget(open, jobsSnapshot, delegation)
}

export function reconcileActivityCenter(
  state: ActivityCenterState,
  jobsSnapshot: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
): ActivityCenterState {
  return reconcileTarget(state, jobsSnapshot, delegation)
}

function workflowMemberCount(run: SessionWorkflowRun): number {
  return run.phases.reduce((count, phase) => count + phase.members.length, 0)
}

function workflowDetail(run: SessionWorkflowRun): readonly string[] {
  if (run.phases.length === 0) return ['No workflow members were published.']
  return run.phases.map((phase) => {
    const label = phase.phase === null
      ? 'Unassigned'
      : phase.phase === '' ? '(empty phase)' : phase.phase
    const complete = phase.members.filter(member => member.status === 'completed').length
    const live = phase.members.filter(member => member.status === 'running').length
    return `${label} · ${complete}/${phase.members.length} complete${live === 0 ? '' : ` · ${live} running`}`
  })
}

function rowsFor(
  state: ActivityCenterState,
  jobsSnapshot: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
): readonly ActivityCenterRow[] {
  const target = state.targets[state.tab]
  if (state.tab === 'jobs') {
    return jobs(jobsSnapshot).map(job => ({
      key: jobKey(job),
      title: job.label,
      meta: `${job.id} · ${job.kind}`,
      status: job.status,
      statusTone: job.status,
      depth: 0,
      selected: target === jobKey(job),
      stoppable: job.status === 'running',
      detail: [
        ...(job.detail === undefined ? [] : [job.detail]),
        ...(job.ownerSession === undefined ? [] : [`Owner ${job.ownerSession}`]),
      ],
    }))
  }
  if (state.tab === 'subagents') {
    return delegation.subagents.map(subagent => ({
      key: subagentKey(subagent),
      title: subagent.label ?? subagent.id,
      meta: `${subagent.id} · ${subagent.mode}`,
      status: subagent.status,
      statusTone: subagent.status,
      depth: Math.max(0, subagent.depth - 1),
      selected: target === subagentKey(subagent),
      stoppable: subagent.interruptible,
      detail: [
        `Parent ${subagent.parentId}`,
        ...(subagent.diagnosticReason === undefined
          ? []
          : [`Diagnostic ${subagent.diagnosticReason}`]),
      ],
    }))
  }
  return delegation.workflows.map(run => ({
    key: workflowKey(run),
    title: run.name,
    meta: `${run.id} · ${workflowMemberCount(run)} agents`,
    status: run.status,
    statusTone: run.status,
    depth: 0,
    selected: target === workflowKey(run),
    stoppable: false,
    detail: workflowDetail(run),
  }))
}

function liveJobs(snapshot: SessionJobsSnapshot): number {
  return snapshot.jobs.filter(job => job.status === 'running' || job.status === 'stopping').length
}

function liveSubagents(snapshot: SessionDelegationSnapshot): number {
  return snapshot.subagents.filter(agent => agent.status === 'running').length
}

function liveWorkflows(snapshot: SessionDelegationSnapshot): number {
  return snapshot.workflows.filter(run => run.status === 'running').length
}

export function selectActivityCenter(
  state: ActivityCenterState,
  jobsSnapshot: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
): ActivityCenterView | undefined {
  const reconciled = reconcileTarget(state, jobsSnapshot, delegation)
  if (!reconciled.open) return undefined
  const rows = rowsFor(reconciled, jobsSnapshot, delegation)
  const selectedIndex = rows.findIndex(row => row.selected)
  const counts = {
    jobs: jobsSnapshot.jobs.length,
    subagents: delegation.subagents.length,
    workflows: delegation.workflows.length,
  }
  const live = {
    jobs: liveJobs(jobsSnapshot),
    subagents: liveSubagents(delegation),
    workflows: liveWorkflows(delegation),
  }
  return {
    tab: reconciled.tab,
    tabs: TABS.map(id => ({
      id,
      label: id === 'jobs' ? 'Jobs' : id === 'subagents' ? 'Subagents' : 'Workflows',
      count: counts[id],
      live: live[id],
      selected: id === reconciled.tab,
    })),
    rows,
    selectedIndex,
    confirmStop: reconciled.confirmStop,
    loading: delegation.loading,
    subagentsAvailable: delegation.subagentsAvailable,
    ...(reconciled.error === undefined && delegation.error === undefined
      ? {}
      : { error: reconciled.error ?? delegation.error! }),
    ...(reconciled.notice === undefined ? {} : { notice: reconciled.notice }),
  }
}

function move(
  state: ActivityCenterState,
  jobsSnapshot: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
  delta: -1 | 1,
): ActivityCenterState {
  if (state.confirmStop) return state
  const keys = keysFor(state.tab, jobsSnapshot, delegation)
  if (keys.length === 0) return state
  const current = keys.indexOf(state.targets[state.tab]!)
  const index = Math.min(keys.length - 1, Math.max(0, current + delta))
  const target = keys[index]!
  if (target === state.targets[state.tab] && state.error === undefined && state.notice === undefined) {
    return state
  }
  return {
    ...state,
    targets: { ...state.targets, [state.tab]: target },
    error: undefined,
    notice: undefined,
  }
}

function cycleTab(state: ActivityCenterState, delta: -1 | 1): ActivityCenterState {
  if (state.confirmStop) return state
  const current = TABS.indexOf(state.tab)
  const index = (current + delta + TABS.length) % TABS.length
  return {
    ...state,
    tab: TABS[index]!,
    confirmStop: false,
    error: undefined,
    notice: undefined,
  }
}

function stopError(state: ActivityCenterState, message: string): ActivityCenterState {
  return { ...state, confirmStop: false, error: message, notice: undefined }
}

function requestStop(
  state: ActivityCenterState,
  jobsSnapshot: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
): ActivityCenterState {
  const selected = rowsFor(state, jobsSnapshot, delegation).find(row => row.selected)
  if (selected === undefined) return state
  if (state.tab === 'workflows') {
    return stopError(
      state,
      'Workflow runs are observed from the parent Session and expose no independent cancel authority.',
    )
  }
  if (!selected.stoppable) {
    return stopError(state, `${state.tab === 'jobs' ? 'Job' : 'Subagent'} ${selected.status} cannot be stopped.`)
  }
  return { ...state, confirmStop: true, error: undefined, notice: undefined }
}

function confirmedOutcome(
  state: ActivityCenterState,
  jobsSnapshot: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
): ActivityCenterOutcome | undefined {
  // `applyActivityCenterAction()` reconciles the selected target before a
  // confirmation can reach this helper.
  const target = state.targets[state.tab]!
  if (state.tab === 'jobs') {
    const job = jobs(jobsSnapshot).find(candidate => jobKey(candidate) === target)!
    return {
      kind: 'job-action',
      action: {
        kind: 'kill',
        ref: { id: job.id, startedAt: job.startedAt, generation: jobsSnapshot.generation },
      },
      successMessage: `Stop requested for ${job.id}`,
    }
  }
  if (state.tab === 'subagents') {
    const child = delegation.subagents.find(candidate => subagentKey(candidate) === target)!
    return {
      kind: 'delegation-action',
      action: {
        kind: 'interrupt-subagent',
        ref: {
          id: child.id,
          parentId: child.parentId,
          generation: delegation.generation,
        },
      },
      successMessage: `Interrupt requested for ${child.id}`,
    }
  }
  return undefined
}

export function applyActivityCenterAction(
  state: ActivityCenterState,
  jobsSnapshot: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
  action: ActivityCenterAction,
): ActivityCenterTransition {
  const reconciled = reconcileTarget(state, jobsSnapshot, delegation)
  if (!reconciled.open) return { state: reconciled }
  switch (action.type) {
    case 'escape':
      if (reconciled.confirmStop) {
        return { state: { ...reconciled, confirmStop: false } }
      }
      return { state: createActivityCenterState(), outcome: { kind: 'cancelled' } }
    case 'move-up':
      return { state: move(reconciled, jobsSnapshot, delegation, -1) }
    case 'move-down':
      return { state: move(reconciled, jobsSnapshot, delegation, 1) }
    case 'tab-next':
      return { state: reconcileTarget(cycleTab(reconciled, 1), jobsSnapshot, delegation) }
    case 'tab-previous':
      return { state: reconcileTarget(cycleTab(reconciled, -1), jobsSnapshot, delegation) }
    case 'request-stop':
      return { state: requestStop(reconciled, jobsSnapshot, delegation) }
    case 'refresh':
      return { state: reconciled, outcome: { kind: 'refresh-delegation' } }
    case 'enter': {
      if (!reconciled.confirmStop) return { state: reconciled }
      const outcome = confirmedOutcome(reconciled, jobsSnapshot, delegation)
      return outcome === undefined ? { state: reconciled } : { state: reconciled, outcome }
    }
  }
}

export function rejectActivityCenter(
  state: ActivityCenterState,
  message: string,
): ActivityCenterState {
  return state.open
    ? { ...state, confirmStop: false, error: message, notice: undefined }
    : state
}

export function resolveActivityCenter(
  state: ActivityCenterState,
  message: string,
): ActivityCenterState {
  return state.open
    ? { ...state, confirmStop: false, error: undefined, notice: message }
    : state
}
