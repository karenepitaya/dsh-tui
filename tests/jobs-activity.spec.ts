import { describe, expect, it } from 'vitest'
import {
  applyJobsActivityAction,
  createJobsActivityState,
  openJobsActivity,
  reconcileJobsActivity,
  rejectJobsActivity,
  resolveJobsActivity,
  selectJobsActivity,
} from '../src/activity/jobs-activity.ts'
import type { SessionJobsSnapshot } from '../src/activity/port.ts'

const SNAPSHOT: SessionJobsSnapshot = {
  available: true,
  generation: 3,
  jobs: [
    {
      id: 'bash-1',
      kind: 'bash',
      label: 'pnpm test',
      status: 'completed',
      detail: 'exit code: 0',
      startedAt: 100,
      finishedAt: 120,
      reported: false,
    },
    {
      id: 'subagent-1',
      kind: 'subagent',
      label: 'Review the adapter',
      status: 'running',
      startedAt: 200,
      reported: false,
    },
  ],
}

describe('Jobs Activity surface state', () => {
  it('opens on the newest job, renders newest-first rows, and supports an empty registry', () => {
    const closed = createJobsActivityState()
    expect(selectJobsActivity(closed, SNAPSHOT)).toBeUndefined()
    expect(openJobsActivity(closed, { ...SNAPSHOT, available: false })).toBe(closed)

    const opened = openJobsActivity(closed, SNAPSHOT)
    expect(selectJobsActivity(opened, SNAPSHOT)).toMatchObject({
      selectedIndex: 0,
      confirmKill: false,
      rows: [
        { id: 'subagent-1', status: 'running', selected: true },
        { id: 'bash-1', status: 'completed', selected: false },
      ],
    })

    const empty = { available: true, generation: 3, jobs: [] } as const
    const emptyOpen = openJobsActivity(closed, empty)
    expect(selectJobsActivity(emptyOpen, empty)).toEqual({
      rows: [],
      selectedIndex: -1,
      confirmKill: false,
    })
    expect(reconcileJobsActivity(opened, empty)).toEqual({
      open: true,
      generation: 3,
      confirmKill: false,
      error: undefined,
      notice: undefined,
    })
  })

  it('moves by stable job identity and emits a two-step kill action', () => {
    let state = openJobsActivity(createJobsActivityState(), SNAPSHOT)
    expect(applyJobsActivityAction(state, SNAPSHOT, { type: 'move-up' }).state).toBe(state)

    state = applyJobsActivityAction(state, SNAPSHOT, { type: 'move-down' }).state
    expect(selectJobsActivity(state, SNAPSHOT)?.selectedIndex).toBe(1)
    const terminal = applyJobsActivityAction(state, SNAPSHOT, { type: 'request-kill' })
    expect(terminal.state.error).toContain('already completed')

    const stopping: SessionJobsSnapshot = {
      ...SNAPSHOT,
      jobs: SNAPSHOT.jobs.map(job => job.id === 'subagent-1'
        ? { ...job, status: 'stopping' as const }
        : job),
    }
    expect(applyJobsActivityAction(
      openJobsActivity(createJobsActivityState(), stopping),
      stopping,
      { type: 'request-kill' },
    ).state.error).toContain('already stopping')

    state = applyJobsActivityAction(terminal.state, SNAPSHOT, { type: 'move-up' }).state
    expect(state.error).toBeUndefined()
    state = applyJobsActivityAction(state, SNAPSHOT, { type: 'request-kill' }).state
    expect(selectJobsActivity(state, SNAPSHOT)?.confirmKill).toBe(true)
    expect(applyJobsActivityAction(state, SNAPSHOT, { type: 'move-down' }).state).toBe(state)

    const confirmed = applyJobsActivityAction(state, SNAPSHOT, { type: 'enter' })
    expect(confirmed.outcome).toEqual({
      kind: 'execute',
      action: {
        kind: 'kill',
        ref: { id: 'subagent-1', startedAt: 200, generation: 3 },
      },
      successMessage: 'Stop requested for subagent-1',
    })

    const backedOut = applyJobsActivityAction(state, SNAPSHOT, { type: 'escape' })
    expect(backedOut.state.confirmKill).toBe(false)
    expect(backedOut.outcome).toBeUndefined()
    const closed = applyJobsActivityAction(backedOut.state, SNAPSHOT, { type: 'escape' })
    expect(closed.state).toEqual(createJobsActivityState())
    expect(closed.outcome).toEqual({ kind: 'cancelled' })
  })

  it('reconciles settlement, removal, and registry replacement without stale actions', () => {
    const open = openJobsActivity(createJobsActivityState(), SNAPSHOT)
    const confirming = applyJobsActivityAction(
      open,
      SNAPSHOT,
      { type: 'request-kill' },
    ).state
    const settled: SessionJobsSnapshot = {
      ...SNAPSHOT,
      jobs: SNAPSHOT.jobs.map(job => job.id === 'subagent-1'
        ? { ...job, status: 'killed' as const, finishedAt: 220 }
        : job),
    }
    const reconciled = reconcileJobsActivity(confirming, settled)
    expect(reconciled.confirmKill).toBe(false)
    expect(selectJobsActivity(reconciled, settled)?.rows[0]?.status).toBe('killed')

    const removed = reconcileJobsActivity(reconciled, {
      ...settled,
      jobs: settled.jobs.slice(0, 1),
    })
    expect(selectJobsActivity(removed, { ...settled, jobs: settled.jobs.slice(0, 1) }))
      .toMatchObject({ selectedIndex: 0, rows: [{ id: 'bash-1' }] })

    const replacement = reconcileJobsActivity(removed, {
      available: true,
      generation: 4,
      jobs: [{ ...SNAPSHOT.jobs[1]!, id: 'subagent-1', startedAt: 300 }],
    })
    expect(replacement).toMatchObject({
      generation: 4,
      confirmKill: false,
      target: { id: 'subagent-1', startedAt: 300, generation: 4 },
    })
    expect(reconcileJobsActivity(replacement, {
      available: false,
      generation: 5,
      jobs: [],
    })).toEqual(createJobsActivityState())
  })

  it('contains action errors and clears them after a successful request', () => {
    const closed = createJobsActivityState()
    expect(rejectJobsActivity(closed, 'ignored')).toBe(closed)
    expect(resolveJobsActivity(closed, 'ignored')).toBe(closed)

    const open = openJobsActivity(closed, SNAPSHOT)
    const rejected = rejectJobsActivity(open, 'stale job reference')
    expect(selectJobsActivity(rejected, SNAPSHOT)?.error).toBe('stale job reference')
    const resolved = resolveJobsActivity(rejected, 'Stop requested for subagent-1')
    expect(selectJobsActivity(resolved, SNAPSHOT)).toMatchObject({
      confirmKill: false,
      notice: 'Stop requested for subagent-1',
    })

    const noTarget = openJobsActivity(closed, {
      available: true,
      generation: 3,
      jobs: [],
    })
    expect(applyJobsActivityAction(closed, SNAPSHOT, { type: 'enter' }).state).toBe(closed)
    expect(applyJobsActivityAction(noTarget, {
      available: true,
      generation: 3,
      jobs: [],
    }, { type: 'move-up' }).state).toBe(noTarget)
    expect(applyJobsActivityAction(noTarget, {
      available: true,
      generation: 3,
      jobs: [],
    }, { type: 'request-kill' }).state).toBe(noTarget)
    expect(applyJobsActivityAction(noTarget, {
      available: true,
      generation: 3,
      jobs: [],
    }, { type: 'enter' }).state).toBe(noTarget)

    const staleTarget = {
      ...open,
      target: { id: 'missing', startedAt: -1, generation: 3 },
    }
    expect(applyJobsActivityAction(
      staleTarget,
      SNAPSHOT,
      { type: 'move-down' },
    ).state.target?.id).toBe('bash-1')
  })
})
