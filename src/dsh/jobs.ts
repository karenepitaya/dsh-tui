import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobRegistry, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type {
  SessionJob,
  SessionJobAction,
  SessionJobActionReceipt,
  SessionJobsPort,
  SessionJobsSnapshot,
} from '../activity/port.ts'

const DEFAULT_KILL_REASON = 'Stopped from DSH-TUI Activity.'

function cloneJob(job: JobSnapshot): SessionJob {
  return {
    id: String(job.id),
    kind: String(job.kind),
    label: job.label,
    ...(job.ownerSession === undefined
      ? {}
      : { ownerSession: String(job.ownerSession) }),
    status: job.status,
    ...(job.detail === undefined ? {} : { detail: job.detail }),
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    reported: job.reported,
  }
}

/** Agent-scoped anti-corruption layer over Harness's live JobRegistry. */
export class DshSessionJobs implements SessionJobsPort {
  private registry: JobRegistry | undefined
  private readonly listeners = new Set<() => void>()
  private stopRegistry: (() => void) | undefined
  private readonly stopRegistryBinding: () => void
  private generation = 0
  private disposed = false

  constructor(private readonly agent: Agent) {
    const ctx = agent.ctx
    const activeRegistry = ctx.get('jobs')
    if (activeRegistry !== undefined) this.attach(activeRegistry)

    const registryFiber = ctx.inject(['jobs'], (jobsContext) => {
      if (this.disposed) return
      return this.attach(jobsContext.jobs)
    })
    this.stopRegistryBinding = () => {
      void registryFiber.dispose().catch(error => ctx.logger.error(error))
    }
  }

  private attach(registry: JobRegistry): () => void {
    if (this.registry === registry) return this.stopRegistry!

    this.stopRegistry?.()
    this.registry = registry
    this.generation += 1
    let active = true
    const stopController = registry.attachController('dsh-tui')
    const stopChanged = registry.onJobsChanged((owner) => {
      if (
        this.disposed
        || (owner !== undefined && owner !== this.agent)
      ) return
      this.notify()
    })
    const release = () => {
      if (!active) return
      active = false
      stopChanged()
      stopController()
      this.registry = undefined
      this.stopRegistry = undefined
      this.generation += 1
      if (!this.disposed) this.notify()
    }
    this.stopRegistry = release
    this.notify()
    return release
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A view observer cannot veto an official job lifecycle commit.
      }
    }
  }

  jobsSnapshot(): SessionJobsSnapshot {
    const registry = this.registry
    if (this.disposed || registry === undefined) {
      return { available: false, generation: this.generation, jobs: [] }
    }
    return {
      available: true,
      generation: this.generation,
      jobs: registry.list(this.agent).map(cloneJob),
    }
  }

  onJobsChanged(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  runJobAction(action: SessionJobAction): SessionJobActionReceipt {
    if (this.disposed) {
      return {
        accepted: false,
        code: 'jobs-closed',
        message: 'The Session Jobs adapter is closed.',
      }
    }
    const registry = this.registry
    if (registry === undefined) {
      return {
        accepted: false,
        code: 'jobs-capability-unavailable',
        message: 'This Agent composition does not provide the official Jobs service.',
      }
    }
    if (action.ref.generation !== this.generation) {
      return {
        accepted: false,
        code: 'job-reference-stale',
        message: 'The Jobs registry changed; select the job again.',
      }
    }

    try {
      const id = action.ref.id as JobId
      const current = registry.get(id, this.agent)
      if (current.startedAt !== action.ref.startedAt) {
        return {
          accepted: false,
          code: 'job-reference-stale',
          message: 'That job id now refers to a different registration.',
        }
      }
      return {
        accepted: true,
        outcome: registry.kill(
          id,
          this.agent,
          action.reason ?? DEFAULT_KILL_REASON,
        ),
      }
    } catch (error: unknown) {
      const record = typeof error === 'object' && error !== null
        ? error as { readonly code?: unknown }
        : undefined
      return {
        accepted: false,
        code: typeof record?.code === 'string' ? record.code : 'job-action-failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  disposeJobs(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopRegistry?.()
    this.stopRegistryBinding()
    this.listeners.clear()
  }
}
