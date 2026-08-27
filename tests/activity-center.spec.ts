import { describe, expect, it } from 'vitest'
import {
  applyActivityCenterAction,
  createActivityCenterState,
  openActivityCenter,
  reconcileActivityCenter,
  rejectActivityCenter,
  resolveActivityCenter,
  selectActivityCenter,
  type ActivityCenterState,
} from '../src/activity/center.ts'
import type { SessionDelegationSnapshot } from '../src/activity/delegation-port.ts'
import { createUnavailableSessionDelegationPort } from '../src/activity/delegation-port.ts'
import type { SessionJobsSnapshot } from '../src/activity/port.ts'

const JOBS: SessionJobsSnapshot = {
  available: true,
  generation: 7,
  jobs: [
    {
      id: 'job-done', kind: 'bash', label: 'Build', status: 'completed',
      detail: 'exit code 0', ownerSession: 'root', startedAt: 1, finishedAt: 2,
      reported: true,
    },
    {
      id: 'job-live', kind: 'subagent', label: 'Review', status: 'running',
      startedAt: 3, reported: false,
    },
  ],
}

const DELEGATION: SessionDelegationSnapshot = {
  available: true,
  generation: 9,
  loading: false,
  subagentsAvailable: true,
  subagents: [
    {
      id: 'child-live', parentId: 'root', depth: 1, mode: 'continuable',
      label: 'Live child', status: 'running', hasChildren: true, interruptible: true,
    },
    {
      id: 'child-cold', parentId: 'child-live', depth: 2, mode: 'one-shot',
      status: 'inactive', hasChildren: false, interruptible: false,
    },
    {
      id: 'child-bad', parentId: 'root', depth: 1, mode: 'diagnostic',
      status: 'diagnostic', hasChildren: false, interruptible: false,
      diagnosticReason: 'corrupt',
    },
  ],
  workflows: [
    {
      id: 'run-live', name: 'Parallel review', status: 'running', startSeq: 4,
      phases: [
        {
          key: 'missing', phase: null,
          members: [{
            seq: 1, label: 'API', childId: 'child-live', status: 'running',
          }],
        },
        {
          key: 'value:0:', phase: '',
          members: [{
            seq: 2, label: 'UI', childId: 'child-cold', status: 'completed',
          }],
        },
        {
          key: 'value:6:verify', phase: 'verify',
          members: [{
            seq: 3, label: 'Tests', childId: 'child-cold', status: 'failed',
          }],
        },
      ],
    },
    {
      id: 'run-empty', name: 'No members', status: 'completed', startSeq: 1,
      phases: [],
    },
  ],
}

describe('Activity Center state and authority routing', () => {
  it('opens with stable newest-first Job selection and detached detail rows', () => {
    const closed = createActivityCenterState()
    expect(selectActivityCenter(closed, JOBS, DELEGATION)).toBeUndefined()
    const open = openActivityCenter(closed, JOBS, DELEGATION)
    const view = selectActivityCenter(open, JOBS, DELEGATION)
    expect(view).toMatchObject({
      tab: 'jobs', selectedIndex: 0, confirmStop: false,
      tabs: [
        { id: 'jobs', count: 2, live: 1, selected: true },
        { id: 'subagents', count: 3, live: 1, selected: false },
        { id: 'workflows', count: 2, live: 1, selected: false },
      ],
      rows: [
        { title: 'Review', status: 'running', selected: true, stoppable: true },
        {
          title: 'Build', status: 'completed', selected: false,
          detail: ['exit code 0', 'Owner root'],
        },
      ],
    })
    expect(openActivityCenter({ ...open, error: 'old', notice: 'old' }, JOBS, DELEGATION))
      .toMatchObject({ open: true, error: undefined, notice: undefined })
  })

  it('moves selection, rejects terminal Jobs, and emits exact confirmed Job refs', () => {
    let state = openActivityCenter(createActivityCenterState(), JOBS, DELEGATION)
    expect(applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'move-up' }).state)
      .toBe(state)
    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'move-down' }).state
    expect(selectActivityCenter(state, JOBS, DELEGATION)?.selectedIndex).toBe(1)
    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'request-stop' }).state
    expect(state.error).toBe('Job completed cannot be stopped.')

    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'move-up' }).state
    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'request-stop' }).state
    expect(state.confirmStop).toBe(true)
    expect(applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'move-down' }).state)
      .toBe(state)
    expect(applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'tab-next' }).state)
      .toBe(state)
    expect(applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'enter' }).outcome)
      .toEqual({
        kind: 'job-action',
        action: {
          kind: 'kill',
          ref: { id: 'job-live', startedAt: 3, generation: 7 },
        },
        successMessage: 'Stop requested for job-live',
      })
  })

  it('cycles tabs, renders hierarchy/phase detail, and keeps Workflow control read-only', () => {
    let state = openActivityCenter(createActivityCenterState(), JOBS, DELEGATION)
    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'tab-next' }).state
    let view = selectActivityCenter(state, JOBS, DELEGATION)!
    expect(view.tab).toBe('subagents')
    expect(view.rows).toMatchObject([
      {
        title: 'Live child', depth: 0, status: 'running', stoppable: true,
        detail: ['Parent root'],
      },
      {
        title: 'child-cold', depth: 1, status: 'inactive', stoppable: false,
        detail: ['Parent child-live'],
      },
      {
        title: 'child-bad', status: 'diagnostic',
        detail: ['Parent root', 'Diagnostic corrupt'],
      },
    ])

    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'request-stop' }).state
    const confirmed = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'enter' })
    expect(confirmed.outcome).toEqual({
      kind: 'delegation-action',
      action: {
        kind: 'interrupt-subagent',
        ref: { id: 'child-live', parentId: 'root', generation: 9 },
      },
      successMessage: 'Interrupt requested for child-live',
    })

    state = { ...confirmed.state, confirmStop: false }
    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'tab-next' }).state
    view = selectActivityCenter(state, JOBS, DELEGATION)!
    expect(view.tab).toBe('workflows')
    expect(view.rows[0]).toMatchObject({
      title: 'Parallel review', meta: 'run-live · 3 agents', status: 'running',
      detail: [
        'Unassigned · 0/1 complete · 1 running',
        '(empty phase) · 1/1 complete',
        'verify · 0/1 complete',
      ],
    })
    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'move-down' }).state
    expect(selectActivityCenter(state, JOBS, DELEGATION)?.rows[1]?.detail)
      .toEqual(['No workflow members were published.'])
    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'request-stop' }).state
    expect(state.error).toContain('no independent cancel authority')

    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'tab-next' }).state
    expect(state.tab).toBe('jobs')
    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'tab-previous' }).state
    expect(state.tab).toBe('workflows')
  })

  it('reconciles disappearing rows, refreshes, backs out, and contains notices/errors', () => {
    const closed = createActivityCenterState()
    expect(reconcileActivityCenter(closed, JOBS, DELEGATION)).toBe(closed)
    expect(rejectActivityCenter(closed, 'ignored')).toBe(closed)
    expect(resolveActivityCenter(closed, 'ignored')).toBe(closed)
    expect(applyActivityCenterAction(closed, JOBS, DELEGATION, { type: 'enter' }).state)
      .toBe(closed)

    let state = openActivityCenter(closed, JOBS, DELEGATION)
    expect(applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'refresh' }).outcome)
      .toEqual({ kind: 'refresh-delegation' })
    state = rejectActivityCenter(state, 'stale')
    expect(selectActivityCenter(state, JOBS, DELEGATION)?.error).toBe('stale')
    state = resolveActivityCenter(state, 'refreshed')
    expect(selectActivityCenter(state, JOBS, DELEGATION)?.notice).toBe('refreshed')

    const onlyDone: SessionJobsSnapshot = { ...JOBS, jobs: JOBS.jobs.slice(0, 1) }
    state = reconcileActivityCenter(state, onlyDone, DELEGATION)
    expect(selectActivityCenter(state, onlyDone, DELEGATION)?.rows[0]?.title).toBe('Build')
    state = applyActivityCenterAction(state, onlyDone, DELEGATION, { type: 'request-stop' }).state
    const backedOut = applyActivityCenterAction(
      { ...state, confirmStop: true },
      onlyDone,
      DELEGATION,
      { type: 'escape' },
    )
    expect(backedOut.state.confirmStop).toBe(false)
    const dismissed = applyActivityCenterAction(backedOut.state, onlyDone, DELEGATION, {
      type: 'escape',
    })
    expect(dismissed.state).toEqual(createActivityCenterState())
    expect(dismissed.outcome).toEqual({ kind: 'cancelled' })
  })

  it('handles empty tabs and stale confirmations without manufacturing authority', () => {
    const noJobs: SessionJobsSnapshot = { available: false, generation: 0, jobs: [] }
    const empty: SessionDelegationSnapshot = {
      available: false,
      generation: 0,
      loading: true,
      subagentsAvailable: false,
      subagents: [],
      workflows: [],
      error: 'catalog unavailable',
    }
    let state = openActivityCenter(createActivityCenterState(), noJobs, empty)
    expect(selectActivityCenter(state, noJobs, empty)).toMatchObject({
      selectedIndex: -1,
      rows: [],
      loading: true,
      subagentsAvailable: false,
      error: 'catalog unavailable',
    })
    expect(applyActivityCenterAction(state, noJobs, empty, { type: 'move-down' }).state)
      .toBe(state)
    expect(applyActivityCenterAction(state, noJobs, empty, { type: 'request-stop' }).state)
      .toBe(state)
    const impossible = {
      ...state,
      confirmStop: true,
    } satisfies ActivityCenterState
    expect(applyActivityCenterAction(impossible, noJobs, empty, { type: 'enter' }).outcome)
      .toBeUndefined()

    state = applyActivityCenterAction(state, noJobs, empty, { type: 'tab-next' }).state
    expect(selectActivityCenter(state, noJobs, empty)?.tab).toBe('subagents')
    state = applyActivityCenterAction(state, noJobs, empty, { type: 'request-stop' }).state
    expect(state.confirmStop).toBe(false)
  })

  it('starts movement from an absent target and rejects non-live Subagent stops', () => {
    let state: ActivityCenterState = {
      ...createActivityCenterState(),
      open: true,
      tab: 'jobs',
    }
    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'move-down' }).state
    expect(selectActivityCenter(state, JOBS, DELEGATION)?.selectedIndex).toBe(1)

    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'tab-next' }).state
    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'move-down' }).state
    state = applyActivityCenterAction(state, JOBS, DELEGATION, { type: 'request-stop' }).state
    expect(state.error).toBe('Subagent inactive cannot be stopped.')

    const workflowConfirm: ActivityCenterState = {
      ...state,
      tab: 'workflows',
      targets: { ...state.targets, workflows: 'workflow:8:run-live' },
      confirmStop: true,
    }
    expect(applyActivityCenterAction(
      workflowConfirm,
      JOBS,
      DELEGATION,
      { type: 'enter' },
    ).outcome).toBeUndefined()
  })

  it('provides a complete inert delegation compatibility seam', async () => {
    const port = createUnavailableSessionDelegationPort()
    expect(port.delegationSnapshot()).toEqual({
      available: false,
      generation: 0,
      loading: false,
      subagentsAvailable: false,
      subagents: [],
      workflows: [],
    })
    await expect(port.refreshDelegation()).resolves.toBeUndefined()
    const stop = port.onDelegationChanged(() => {})
    expect(stop()).toBeUndefined()
    expect(port.runDelegationAction({
      kind: 'interrupt-subagent',
      ref: { id: 'missing', parentId: 'root', generation: 0 },
    })).toMatchObject({ accepted: false, code: 'delegation-capability-unavailable' })
    expect(port.disposeDelegation()).toBeUndefined()
  })
})
