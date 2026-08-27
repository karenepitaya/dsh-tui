import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  ToolWorkflowAgentEndData,
  ToolWorkflowAgentStartData,
} from '@deepseek-ai/dsh-tool-workflow/types'
import type {
  SessionWorkflowMember,
  SessionWorkflowPhase,
  SessionWorkflowRun,
  SessionWorkflowStatus,
} from './delegation-port.ts'

interface WorkflowLocation {
  readonly turn: number
  readonly step?: number
}

interface WorkflowMemberState extends Omit<ToolWorkflowAgentStartData, 'runId'> {
  readonly status: SessionWorkflowStatus
}

interface WorkflowRunState {
  readonly id: string
  readonly name: string
  readonly startSeq: number
  readonly location?: WorkflowLocation
  readonly status: SessionWorkflowStatus
  readonly members: readonly WorkflowMemberState[]
}

/** Product-owned fold state; no Harness UI or mutable runtime object crosses this seam. */
export interface WorkflowActivityState {
  readonly turn: number | undefined
  readonly step: WorkflowLocation | undefined
  readonly runs: readonly WorkflowRunState[]
}

export function workflowPhaseKey(phase: string | null): string {
  return phase === null ? 'missing' : `value:${phase.length}:${phase}`
}

function runStatus(stopReason: 'completed' | 'cancelled' | 'error'): SessionWorkflowStatus {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'error': return 'failed'
  }
}

function memberStatus(outcome: 'completed' | 'cancelled' | 'failed'): SessionWorkflowStatus {
  return outcome
}

function interruptRun(run: WorkflowRunState): WorkflowRunState {
  if (run.status !== 'running') return run
  return {
    ...run,
    status: 'interrupted',
    members: run.members.map(member => member.status === 'running'
      ? { ...member, status: 'interrupted' }
      : member),
  }
}

function updateRun(
  state: WorkflowActivityState,
  id: string,
  update: (run: WorkflowRunState) => WorkflowRunState,
): WorkflowActivityState {
  const index = state.runs.findIndex(run => run.id === id)
  if (index < 0) return state
  const current = state.runs[index]!
  const next = update(current)
  if (next === current) return state
  return {
    ...state,
    runs: state.runs.map((run, runIndex) => runIndex === index ? next : run),
  }
}

function updateMemberEnd(
  run: WorkflowRunState,
  data: ToolWorkflowAgentEndData,
): WorkflowRunState {
  const index = run.members.findIndex(member => member.seq === data.seq)
  if (index < 0) return run
  const member = run.members[index]!
  const status = memberStatus(data.outcome)
  if (member.status === status) return run
  return {
    ...run,
    members: run.members.map((candidate, memberIndex) => memberIndex === index
      ? { ...candidate, status }
      : candidate),
  }
}

function updateMemberStart(
  run: WorkflowRunState,
  data: ToolWorkflowAgentStartData,
): WorkflowRunState {
  if (run.members.some(member => member.seq === data.seq)) return run
  const member: WorkflowMemberState = {
    seq: data.seq,
    label: data.label,
    ...(data.phase === undefined ? {} : { phase: data.phase }),
    childId: data.childId,
    status: 'running',
  }
  return { ...run, members: [...run.members, member] }
}

function closeRuns(
  state: WorkflowActivityState,
  predicate: (run: WorkflowRunState) => boolean,
): readonly WorkflowRunState[] {
  let changed = false
  const runs = state.runs.map((run) => {
    if (!predicate(run)) return run
    const next = interruptRun(run)
    changed ||= next !== run
    return next
  })
  return changed ? runs : state.runs
}

/** Fold one committed Session event; unrelated events preserve object identity. */
export function reduceWorkflowActivity(
  state: WorkflowActivityState,
  event: SessionEvent,
): WorkflowActivityState {
  switch (event.type) {
    case 'turn/start':
      return { ...state, turn: event.data.turn, step: undefined }
    case 'step/start':
      return {
        ...state,
        turn: event.data.turn,
        step: { turn: event.data.turn, step: event.data.step },
      }
    case 'tool-workflow/run-start': {
      const id = String(event.data.runId)
      if (state.runs.some(run => run.id === id)) return state
      const location = state.step ?? (state.turn === undefined
        ? undefined
        : { turn: state.turn })
      return {
        ...state,
        runs: [...state.runs, {
          id,
          name: event.data.name,
          startSeq: event.seq,
          ...(location === undefined ? {} : { location }),
          status: 'running',
          members: [],
        }],
      }
    }
    case 'tool-workflow/agent-start':
      return updateRun(
        state,
        String(event.data.runId),
        run => updateMemberStart(run, event.data),
      )
    case 'tool-workflow/agent-end':
      return updateRun(
        state,
        String(event.data.runId),
        run => updateMemberEnd(run, event.data),
      )
    case 'tool-workflow/run-end':
      return updateRun(state, String(event.data.runId), run => {
        const status = runStatus(event.data.stopReason)
        return run.status === status ? run : { ...run, status }
      })
    case 'step/end': {
      const runs = closeRuns(state, run => (
        run.location?.turn === event.data.turn
        && run.location.step === event.data.step
      ))
      const step = state.step?.turn === event.data.turn
        && state.step.step === event.data.step
        ? undefined
        : state.step
      if (runs === state.runs && step === state.step) return state
      return { ...state, runs, step }
    }
    case 'turn/end': {
      const runs = closeRuns(state, run => run.location?.turn === event.data.turn)
      const turn = state.turn === event.data.turn ? undefined : state.turn
      const step = state.step?.turn === event.data.turn ? undefined : state.step
      if (runs === state.runs && turn === state.turn && step === state.step) return state
      return { ...state, runs, turn, step }
    }
    default:
      return state
  }
}

export function foldWorkflowActivity(
  events: readonly SessionEvent[],
): WorkflowActivityState {
  return events.reduce(reduceWorkflowActivity, {
    turn: undefined,
    step: undefined,
    runs: [],
  })
}

function projectPhases(members: readonly WorkflowMemberState[]): readonly SessionWorkflowPhase[] {
  const phases = new Map<string, { phase: string | null; members: SessionWorkflowMember[] }>()
  for (const member of members) {
    const phase = member.phase === undefined ? null : member.phase
    const key = workflowPhaseKey(phase)
    let group = phases.get(key)
    if (group === undefined) {
      group = { phase, members: [] }
      phases.set(key, group)
    }
    group.members.push({
      seq: member.seq,
      label: member.label,
      childId: String(member.childId),
      status: member.status,
    })
  }
  return [...phases].map(([key, group]) => ({
    key,
    phase: group.phase,
    members: group.members,
  }))
}

/** Newest-first detached Workflow activity for presentation. */
export function projectWorkflowActivity(
  state: WorkflowActivityState,
): readonly SessionWorkflowRun[] {
  return [...state.runs].reverse().map(run => ({
    id: run.id,
    name: run.name,
    status: run.status,
    startSeq: run.startSeq,
    phases: projectPhases(run.members),
  }))
}
