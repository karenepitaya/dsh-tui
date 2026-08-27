import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DshSessionJobs } from '../src/dsh/jobs.ts'
import type { SessionJob } from '../src/activity/port.ts'

const JOB: SessionJob = {
  id: 'bash-1',
  kind: 'bash',
  label: 'pnpm test',
  ownerSession: 'agent-jobs',
  status: 'running',
  startedAt: 100,
  reported: false,
}

function harness() {
  let changed: ((owner: Agent | undefined) => void) | undefined
  let activate: ((jobsContext: Context) => unknown) | undefined
  const stopController = vi.fn()
  const stopChanged = vi.fn()
  const dispose = vi.fn(async () => {})
  const logError = vi.fn()
  const registry = {
    attachController: vi.fn(() => stopController),
    onJobsChanged: vi.fn((listener: (owner: Agent | undefined) => void) => {
      changed = listener
      return stopChanged
    }),
    list: vi.fn(() => [JOB]),
    get: vi.fn(() => JOB),
    kill: vi.fn(() => 'requested' as const),
    read: vi.fn(),
  }
  const ctx = {
    get: vi.fn((key: string) => key === 'jobs' ? registry : undefined),
    inject: vi.fn((_deps: unknown, callback: (jobsContext: Context) => unknown) => {
      activate = callback
      return { dispose }
    }),
    logger: { error: logError },
  } as unknown as Context
  const agent = { id: 'agent-jobs', ctx } as unknown as Agent
  return {
    agent,
    registry,
    stopController,
    stopChanged,
    dispose,
    logError,
    changed: (owner: Agent | undefined) => changed?.(owner),
    activate: () => activate?.({ jobs: registry } as unknown as Context),
  }
}

describe('official DSH Jobs adapter', () => {
  it('attaches a controller in the exact Agent scope and returns detached snapshots', () => {
    const { agent, registry } = harness()
    const jobs = new DshSessionJobs(agent)

    expect(registry.attachController).toHaveBeenCalledExactlyOnceWith('dsh-tui')
    expect(registry.onJobsChanged).toHaveBeenCalledOnce()
    expect(jobs.jobsSnapshot()).toEqual({
      available: true,
      generation: 1,
      jobs: [JOB],
    })
    expect(registry.list).toHaveBeenCalledWith(agent)

    const detached = jobs.jobsSnapshot()
    ;(detached.jobs[0] as { label: string }).label = 'mutated by view'
    expect(jobs.jobsSnapshot().jobs[0]?.label).toBe(JOB.label)
    expect(registry.read).not.toHaveBeenCalled()

    const unowned: SessionJob = {
      id: JOB.id,
      kind: JOB.kind,
      label: JOB.label,
      status: JOB.status,
      startedAt: JOB.startedAt,
      reported: JOB.reported,
    }
    registry.list.mockReturnValueOnce([{
      ...unowned,
      detail: 'exit code: 0',
      finishedAt: 120,
    }])
    const unownedSnapshot = jobs.jobsSnapshot().jobs[0]
    expect(unownedSnapshot).toMatchObject({
      detail: 'exit code: 0',
      finishedAt: 120,
    })
    expect(unownedSnapshot).not.toHaveProperty('ownerSession')
  })

  it('observes only this Agent or shared jobs and contains view failures', () => {
    const { agent, changed } = harness()
    const jobs = new DshSessionJobs(agent)
    const other = { id: 'other-agent' } as Agent
    let observed = 0
    jobs.onJobsChanged(() => { throw new Error('view failed') })
    const stop = jobs.onJobsChanged(() => { observed += 1 })

    changed(other)
    expect(observed).toBe(0)
    changed(agent)
    changed(undefined)
    expect(observed).toBe(2)
    stop()
    stop()
    changed(agent)
    expect(observed).toBe(2)
  })

  it('kills only the exact registry generation and registration instance', () => {
    const { agent, registry } = harness()
    const jobs = new DshSessionJobs(agent)
    const ref = { id: JOB.id, startedAt: JOB.startedAt, generation: 1 }

    expect(jobs.runJobAction({ kind: 'kill', ref })).toEqual({
      accepted: true,
      outcome: 'requested',
    })
    expect(registry.get).toHaveBeenCalledWith(JOB.id, agent)
    expect(registry.kill).toHaveBeenCalledExactlyOnceWith(
      JOB.id,
      agent,
      'Stopped from DSH-TUI Activity.',
    )
    expect(registry.read).not.toHaveBeenCalled()

    expect(jobs.runJobAction({
      kind: 'kill',
      ref: { ...ref, generation: 0 },
    })).toMatchObject({ accepted: false, code: 'job-reference-stale' })
    registry.get.mockReturnValueOnce({ ...JOB, startedAt: 101 })
    expect(jobs.runJobAction({ kind: 'kill', ref })).toMatchObject({
      accepted: false,
      code: 'job-reference-stale',
    })
    expect(registry.kill).toHaveBeenCalledTimes(1)
  })

  it('contains registry failures and reports capability loss or closure', async () => {
    const { agent, registry, activate, stopChanged, stopController, dispose } = harness()
    const jobs = new DshSessionJobs(agent)
    const ref = { id: JOB.id, startedAt: JOB.startedAt, generation: 1 }
    const failure = Object.assign(new Error('job belongs to another session'), {
      code: 'job-access-denied',
    })
    registry.get.mockImplementationOnce(() => { throw failure })
    expect(jobs.runJobAction({ kind: 'kill', ref })).toEqual({
      accepted: false,
      code: 'job-access-denied',
      message: failure.message,
    })
    registry.get.mockImplementationOnce(() => { throw 'lookup exploded' })
    expect(jobs.runJobAction({ kind: 'kill', ref })).toEqual({
      accepted: false,
      code: 'job-action-failed',
      message: 'lookup exploded',
    })

    const release = activate() as (() => void) | undefined
    release?.()
    release?.()
    expect(stopChanged).toHaveBeenCalledOnce()
    expect(stopController).toHaveBeenCalledOnce()
    expect(jobs.jobsSnapshot()).toEqual({ available: false, generation: 2, jobs: [] })
    expect(jobs.runJobAction({ kind: 'kill', ref })).toMatchObject({
      accepted: false,
      code: 'jobs-capability-unavailable',
    })

    jobs.disposeJobs()
    jobs.disposeJobs()
    expect(dispose).toHaveBeenCalledOnce()
    expect(jobs.runJobAction({ kind: 'kill', ref })).toMatchObject({
      accepted: false,
      code: 'jobs-closed',
    })
    await Promise.resolve()
  })

  it('contains a late binding and asynchronous Cordis cleanup after disposal', async () => {
    const cleanupFailure = new Error('jobs binding cleanup failed')
    const { agent, activate, dispose, logError } = harness()
    dispose.mockRejectedValueOnce(cleanupFailure)
    const jobs = new DshSessionJobs(agent)

    jobs.disposeJobs()
    expect(jobs.jobsSnapshot()).toEqual({ available: false, generation: 2, jobs: [] })
    expect(jobs.onJobsChanged(() => { throw new Error('late') })()).toBeUndefined()
    expect(() => activate()).not.toThrow()
    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledExactlyOnceWith(cleanupFailure)
    })
  })
})
