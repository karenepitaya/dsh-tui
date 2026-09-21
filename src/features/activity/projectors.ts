import type {
  SessionDelegationSnapshot,
  SessionSubagent,
  SessionWorkflowRun,
} from '../../activity/delegation-port.ts'
import type {
  SessionJob,
  SessionJobsSnapshot,
} from '../../activity/port.ts'

function detachJob(job: SessionJob): SessionJob {
  return Object.freeze({
    id: job.id,
    kind: job.kind,
    label: job.label,
    ...(job.ownerSession === undefined ? {} : { ownerSession: job.ownerSession }),
    status: job.status,
    ...(job.detail === undefined ? {} : { detail: job.detail }),
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    reported: job.reported,
  })
}

/** Detach the exact-lease Jobs view before retaining it in Feature state. */
export function detachJobsSnapshot(snapshot: SessionJobsSnapshot): SessionJobsSnapshot {
  return Object.freeze({
    available: snapshot.available,
    generation: snapshot.generation,
    jobs: Object.freeze(snapshot.jobs.map(detachJob)),
  })
}

function detachSubagent(subagent: SessionSubagent): SessionSubagent {
  return Object.freeze({
    id: subagent.id,
    parentId: subagent.parentId,
    depth: subagent.depth,
    mode: subagent.mode,
    ...(subagent.label === undefined ? {} : { label: subagent.label }),
    status: subagent.status,
    hasChildren: subagent.hasChildren,
    interruptible: subagent.interruptible,
    ...(subagent.diagnosticReason === undefined
      ? {}
      : { diagnosticReason: subagent.diagnosticReason }),
  })
}

function detachWorkflow(run: SessionWorkflowRun): SessionWorkflowRun {
  return Object.freeze({
    id: run.id,
    name: run.name,
    status: run.status,
    startSeq: run.startSeq,
    phases: Object.freeze(run.phases.map(phase => Object.freeze({
      key: phase.key,
      phase: phase.phase,
      members: Object.freeze(phase.members.map(member => Object.freeze({ ...member }))),
    }))),
  })
}

/** Detach the exact-lease delegation view before retaining it in Feature state. */
export function detachDelegationSnapshot(
  snapshot: SessionDelegationSnapshot,
): SessionDelegationSnapshot {
  return Object.freeze({
    available: snapshot.available,
    generation: snapshot.generation,
    loading: snapshot.loading,
    subagentsAvailable: snapshot.subagentsAvailable,
    subagents: Object.freeze(snapshot.subagents.map(detachSubagent)),
    workflows: Object.freeze(snapshot.workflows.map(detachWorkflow)),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  })
}
