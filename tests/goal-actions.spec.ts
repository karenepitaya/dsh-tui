import { describe, expect, it } from 'vitest'
import {
  applyGoalActionSurfaceAction,
  createGoalActionSurfaceState,
  goalActionTarget,
  openGoalActionSurface,
  reconcileGoalActionSurface,
  reduceGoalActionSurfaceEditor,
  rejectGoalActionSurface,
  selectGoalActionSurface,
} from '../src/workbench/goal-actions.ts'
import type {
  SessionWorkbenchGoal,
  SessionWorkbenchSnapshot,
} from '../src/workbench/port.ts'

const ACTIVE: SessionWorkbenchGoal = {
  id: 'goal-1',
  revision: 2,
  objective: 'Ship the action surface',
  phase: 'active',
  maxGoalRounds: 8,
  roundsStarted: 3,
  createdAt: 10,
  updatedAt: 20,
}

function snapshot(goal: SessionWorkbenchGoal | null | undefined = ACTIVE): SessionWorkbenchSnapshot {
  return {
    available: true,
    ...(goal === undefined ? {} : { goal }),
  }
}

describe('Goal action surface state', () => {
  it('opens on a current Goal, selects contextual rows, and reconciles exact revisions', () => {
    const closed = createGoalActionSurfaceState()
    expect(goalActionTarget(snapshot())).toBe(ACTIVE)
    expect(goalActionTarget(snapshot(null))).toBeUndefined()
    expect(goalActionTarget(snapshot({ ...ACTIVE, phase: 'complete' }))).toBeUndefined()
    expect(openGoalActionSurface(closed, snapshot(null))).toBe(closed)

    const opened = openGoalActionSurface(closed, snapshot())
    expect(selectGoalActionSurface(opened, snapshot())).toMatchObject({
      stage: 'menu',
      selectedIndex: 0,
      editor: { text: 'Pause goal' },
      actions: [
        { kind: 'pause' },
        { kind: 'edit' },
        { kind: 'clear' },
      ],
    })
    expect(selectGoalActionSurface(
      { ...opened, selectedIndex: 99 },
      snapshot(),
    )?.editor.text).toBe('')
    expect(reconcileGoalActionSurface(opened, snapshot())).toBe(opened)
    expect(reconcileGoalActionSurface(closed, snapshot())).toBe(closed)

    const revised = { ...ACTIVE, revision: 3, phase: 'paused' as const }
    const reconciled = reconcileGoalActionSurface(opened, snapshot(revised))
    expect(reconciled).toMatchObject({
      open: true,
      stage: 'menu',
      targetRevision: 3,
    })
    expect(selectGoalActionSurface(reconciled, snapshot(revised))?.actions.map(row => row.kind))
      .toEqual(['resume', 'edit', 'clear'])
    expect(reconcileGoalActionSurface(reconciled, snapshot(null))).toEqual(closed)
    expect(selectGoalActionSurface(closed, snapshot())).toBeUndefined()
    expect(selectGoalActionSurface(opened, snapshot(null))).toBeUndefined()
  })

  it('navigates safely and emits pause, resume, edit, and confirmed clear CAS actions', () => {
    let state = openGoalActionSurface(createGoalActionSurfaceState(), snapshot())
    const staleSelection = { ...state, selectedIndex: 99 }
    expect(applyGoalActionSurfaceAction(
      staleSelection,
      snapshot(),
      { type: 'enter' },
    )).toEqual({ state: staleSelection })
    expect(applyGoalActionSurfaceAction(state, snapshot(), { type: 'move-up' }).state).toBe(state)
    expect(applyGoalActionSurfaceAction(state, snapshot(), { type: 'enter' }).outcome).toEqual({
      kind: 'execute',
      action: { kind: 'pause', ref: { id: 'goal-1', revision: 2 } },
      successMessage: 'Goal paused',
    })

    state = applyGoalActionSurfaceAction(state, snapshot(), { type: 'move-down' }).state
    expect(selectGoalActionSurface(state, snapshot())?.editor.text).toBe('Edit objective')
    state = applyGoalActionSurfaceAction(state, snapshot(), { type: 'enter' }).state
    expect(state.stage).toBe('edit')
    expect(selectGoalActionSurface(state, snapshot())).toMatchObject({
      stage: 'edit',
      editor: { text: '' },
    })
    expect(applyGoalActionSurfaceAction(state, snapshot(), { type: 'move-down' }).state).toBe(state)

    let edit = applyGoalActionSurfaceAction(state, snapshot(), { type: 'enter' })
    expect(edit.state.error).toContain('nonblank')
    state = reduceGoalActionSurfaceEditor(edit.state, { type: 'insert', text: '' })
    expect(state.error).toBeUndefined()
    state = reduceGoalActionSurfaceEditor(state, { type: 'insert', text: '  New objective  ' })
    edit = applyGoalActionSurfaceAction(state, snapshot(), { type: 'enter' })
    expect(edit.outcome).toEqual({
      kind: 'execute',
      action: {
        kind: 'edit',
        ref: { id: 'goal-1', revision: 2 },
        objective: 'New objective',
      },
      successMessage: 'Goal objective updated',
    })
    expect(reduceGoalActionSurfaceEditor(state, { type: 'insert', text: '' })).toBe(state)

    state = applyGoalActionSurfaceAction(state, snapshot(), { type: 'escape' }).state
    expect(state.stage).toBe('menu')
    state = applyGoalActionSurfaceAction(state, snapshot(), { type: 'move-down' }).state
    expect(state.selectedIndex).toBe(2)
    state = applyGoalActionSurfaceAction(state, snapshot(), { type: 'move-down' }).state
    expect(state.selectedIndex).toBe(2)
    state = applyGoalActionSurfaceAction(state, snapshot(), { type: 'enter' }).state
    expect(selectGoalActionSurface(state, snapshot())).toMatchObject({
      stage: 'confirm-clear',
      editor: { text: 'Confirm clear' },
    })
    expect(applyGoalActionSurfaceAction(state, snapshot(), { type: 'move-up' }).state).toBe(state)
    expect(applyGoalActionSurfaceAction(state, snapshot(), { type: 'enter' }).outcome).toEqual({
      kind: 'execute',
      action: { kind: 'clear', ref: { id: 'goal-1', revision: 2 } },
      successMessage: 'Goal cleared',
    })

    const paused = snapshot({ ...ACTIVE, phase: 'blocked', revision: 4 })
    state = openGoalActionSurface(createGoalActionSurfaceState(), paused)
    expect(applyGoalActionSurfaceAction(state, paused, { type: 'enter' }).outcome).toEqual({
      kind: 'execute',
      action: { kind: 'resume', ref: { id: 'goal-1', revision: 4 } },
      successMessage: 'Goal resumed',
    })
  })

  it('backs out, closes, and retains actionable errors only while open', () => {
    const closed = createGoalActionSurfaceState()
    expect(applyGoalActionSurfaceAction(closed, snapshot(), { type: 'enter' }).state).toBe(closed)
    const inconsistent = { ...openGoalActionSurface(closed, snapshot()), targetRevision: 2 }
    expect(applyGoalActionSurfaceAction(inconsistent, snapshot(null), { type: 'enter' }).state)
      .toEqual(closed)

    let state = openGoalActionSurface(closed, snapshot())
    state = applyGoalActionSurfaceAction(state, snapshot(), { type: 'move-down' }).state
    state = applyGoalActionSurfaceAction(state, snapshot(), { type: 'move-down' }).state
    state = applyGoalActionSurfaceAction(state, snapshot(), { type: 'enter' }).state
    state = applyGoalActionSurfaceAction(state, snapshot(), { type: 'escape' }).state
    expect(state.stage).toBe('menu')

    const rejected = rejectGoalActionSurface(state, 'stale revision')
    expect(rejected.error).toBe('stale revision')
    expect(selectGoalActionSurface(rejected, snapshot())?.error).toBe('stale revision')
    expect(rejectGoalActionSurface(closed, 'ignored')).toBe(closed)
    expect(reduceGoalActionSurfaceEditor(rejected, { type: 'insert', text: 'ignored' })).toBe(rejected)

    const cancelled = applyGoalActionSurfaceAction(rejected, snapshot(), { type: 'escape' })
    expect(cancelled.state).toEqual(closed)
    expect(cancelled.outcome).toEqual({ kind: 'cancelled' })
  })
})
