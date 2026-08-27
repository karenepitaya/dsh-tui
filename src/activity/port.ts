/** Product-owned copy of the official background-job lifecycle vocabulary. */
export type SessionJobStatus =
  | 'running'
  | 'stopping'
  | 'completed'
  | 'killed'
  | 'failed'

/** Detached, non-consuming view of one Harness job. */
export interface SessionJob {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly ownerSession?: string
  readonly status: SessionJobStatus
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly reported: boolean
}

/** Exact registry generation and registration instance targeted by an action. */
export interface SessionJobRef {
  readonly id: string
  readonly startedAt: number
  readonly generation: number
}

export interface SessionJobsSnapshot {
  readonly available: boolean
  readonly generation: number
  readonly jobs: readonly SessionJob[]
}

export type SessionJobAction = {
  readonly kind: 'kill'
  readonly ref: SessionJobRef
  readonly reason?: string
}

export type SessionJobActionReceipt =
  | {
      readonly accepted: true
      readonly outcome: 'requested' | 'already-finished'
    }
  | {
      readonly accepted: false
      readonly code: string
      readonly message: string
    }

/** Optional live Jobs capability carried by one exact Agent lease. */
export interface SessionJobsPort {
  jobsSnapshot(): SessionJobsSnapshot
  onJobsChanged(listener: () => void): () => void
  runJobAction(action: SessionJobAction): SessionJobActionReceipt
  disposeJobs(): void
}

const UNAVAILABLE_JOBS_SNAPSHOT: SessionJobsSnapshot = Object.freeze({
  available: false,
  generation: 0,
  jobs: Object.freeze([]),
})

/** Compatibility seam for Agent compositions without the official Jobs service. */
export function createUnavailableSessionJobsPort(): SessionJobsPort {
  return {
    jobsSnapshot: () => UNAVAILABLE_JOBS_SNAPSHOT,
    onJobsChanged: () => () => {},
    runJobAction: () => ({
      accepted: false,
      code: 'jobs-capability-unavailable',
      message: 'Background Jobs are unavailable in this Agent composition.',
    }),
    disposeJobs: () => {},
  }
}
