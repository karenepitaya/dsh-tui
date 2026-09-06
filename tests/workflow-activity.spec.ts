import { describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  foldWorkflowActivity,
  projectWorkflowActivity,
  reduceWorkflowActivity,
  workflowPhaseKey,
  type WorkflowActivityEvent,
} from '../src/activity/workflow-activity.ts'
import { adaptDshWorkflowActivityEvent } from '../src/dsh/workflow-activity-adapter.ts'

function event(
  session: Session,
  type: Parameters<Session['append']>[0],
  data: never,
): WorkflowActivityEvent {
  const durable = session.append(type, data)
  const adapted = adaptDshWorkflowActivityEvent(durable)
  if (adapted === undefined) throw new Error(`unsupported workflow test event: ${durable.type}`)
  return adapted
}

function workflowEvents(session: Session): readonly WorkflowActivityEvent[] {
  return session.events.flatMap((durable) => {
    const adapted = adaptDshWorkflowActivityEvent(durable)
    return adapted === undefined ? [] : [adapted]
  })
}

describe('durable Workflow activity projection', () => {
  it('preserves absent and empty phase identities without collisions', () => {
    expect(workflowPhaseKey(null)).toBe('missing')
    expect(workflowPhaseKey('')).toBe('value:0:')
    expect(workflowPhaseKey('ab')).toBe('value:2:ab')
    expect(new Set([
      workflowPhaseKey(null),
      workflowPhaseKey(''),
      workflowPhaseKey('missing'),
    ])).toHaveLength(3)
  })

  it('folds committed run/member lifecycles and projects newest-first phase groups', () => {
    const session = Session.create(SessionId('workflow-fold'))
    event(session, 'turn/start', { turn: 1 } as never)
    event(session, 'step/start', { turn: 1, step: 1 } as never)
    event(session, 'tool-workflow/run-start', {
      runId: 'run-a', name: 'Review',
    } as never)
    event(session, 'tool-workflow/agent-start', {
      runId: 'run-a', seq: 1, label: 'API', childId: SessionId('child-a'),
    } as never)
    event(session, 'tool-workflow/agent-start', {
      runId: 'run-a', seq: 4, label: 'API 2', childId: SessionId('child-d'),
    } as never)
    event(session, 'tool-workflow/agent-start', {
      runId: 'run-a', seq: 2, label: 'UI', phase: '', childId: SessionId('child-b'),
    } as never)
    event(session, 'tool-workflow/agent-start', {
      runId: 'run-a', seq: 3, label: 'Tests', phase: 'verify', childId: SessionId('child-c'),
    } as never)
    event(session, 'tool-workflow/agent-end', {
      runId: 'run-a', seq: 1, outcome: 'completed',
    } as never)
    event(session, 'tool-workflow/agent-end', {
      runId: 'run-a', seq: 2, outcome: 'cancelled',
    } as never)
    event(session, 'tool-workflow/agent-end', {
      runId: 'run-a', seq: 3, outcome: 'failed',
    } as never)
    event(session, 'tool-workflow/run-end', {
      runId: 'run-a', stopReason: 'completed',
    } as never)
    event(session, 'tool-workflow/run-start', {
      runId: 'run-b', name: 'Ship',
    } as never)
    event(session, 'tool-workflow/run-end', {
      runId: 'run-b', stopReason: 'cancelled',
    } as never)
    event(session, 'tool-workflow/run-start', {
      runId: 'run-c', name: 'Audit',
    } as never)
    event(session, 'tool-workflow/run-end', {
      runId: 'run-c', stopReason: 'error',
    } as never)

    const projected = projectWorkflowActivity(foldWorkflowActivity(workflowEvents(session)))
    expect(projected.map(run => [run.id, run.status])).toEqual([
      ['run-c', 'failed'],
      ['run-b', 'cancelled'],
      ['run-a', 'completed'],
    ])
    expect(projected[2]?.phases).toEqual([
      {
        key: 'missing', phase: null,
        members: [{
          seq: 1, label: 'API', childId: 'child-a', status: 'completed',
        }, {
          seq: 4, label: 'API 2', childId: 'child-d', status: 'running',
        }],
      },
      {
        key: 'value:0:', phase: '',
        members: [{
          seq: 2, label: 'UI', childId: 'child-b', status: 'cancelled',
        }],
      },
      {
        key: 'value:6:verify', phase: 'verify',
        members: [{
          seq: 3, label: 'Tests', childId: 'child-c', status: 'failed',
        }],
      },
    ])
  })

  it('ignores duplicate and orphan records while preserving reducer identity', () => {
    const session = Session.create(SessionId('workflow-idempotent'))
    let state = foldWorkflowActivity([])
    const unrelated = {
      seq: 0,
      type: 'future/durable-event',
      data: {},
    } as unknown as SessionEvent
    expect(adaptDshWorkflowActivityEvent(unrelated)).toBeUndefined()
    const unknownProductEvent = {
      seq: 0,
      type: 'future/workflow-event',
      data: {},
    } as unknown as WorkflowActivityEvent
    expect(reduceWorkflowActivity(state, unknownProductEvent)).toBe(state)

    const start = event(session, 'tool-workflow/run-start', {
      runId: 'run-a', name: 'One',
    } as never)
    state = reduceWorkflowActivity(state, start)
    expect(reduceWorkflowActivity(state, event(session, 'tool-workflow/run-start', {
      runId: 'run-a', name: 'Duplicate',
    } as never))).toBe(state)
    expect(reduceWorkflowActivity(state, event(session, 'tool-workflow/agent-start', {
      runId: 'missing', seq: 1, label: 'orphan', childId: SessionId('child-x'),
    } as never))).toBe(state)

    const memberStart = event(session, 'tool-workflow/agent-start', {
      runId: 'run-a', seq: 1, label: 'worker', childId: SessionId('child-a'),
    } as never)
    state = reduceWorkflowActivity(state, memberStart)
    expect(reduceWorkflowActivity(state, memberStart)).toBe(state)
    expect(reduceWorkflowActivity(state, event(session, 'tool-workflow/agent-end', {
      runId: 'run-a', seq: 99, outcome: 'completed',
    } as never))).toBe(state)

    const memberEnd = event(session, 'tool-workflow/agent-end', {
      runId: 'run-a', seq: 1, outcome: 'completed',
    } as never)
    state = reduceWorkflowActivity(state, memberEnd)
    expect(reduceWorkflowActivity(state, memberEnd)).toBe(state)
    expect(reduceWorkflowActivity(state, event(session, 'tool-workflow/run-end', {
      runId: 'missing', stopReason: 'completed',
    } as never))).toBe(state)

    const runEnd = event(session, 'tool-workflow/run-end', {
      runId: 'run-a', stopReason: 'completed',
    } as never)
    state = reduceWorkflowActivity(state, runEnd)
    expect(reduceWorkflowActivity(state, runEnd)).toBe(state)
  })

  it('interrupts only open runs owned by the closing step or turn', () => {
    const session = Session.create(SessionId('workflow-interruption'))
    let state = foldWorkflowActivity([])
    state = reduceWorkflowActivity(state, event(session, 'turn/start', { turn: 3 } as never))
    state = reduceWorkflowActivity(state, event(session, 'step/start', {
      turn: 3, step: 2,
    } as never))
    state = reduceWorkflowActivity(state, event(session, 'tool-workflow/run-start', {
      runId: 'step-run', name: 'Step run',
    } as never))
    state = reduceWorkflowActivity(state, event(session, 'tool-workflow/agent-start', {
      runId: 'step-run', seq: 1, label: 'worker', childId: SessionId('step-child'),
    } as never))
    state = reduceWorkflowActivity(state, event(session, 'tool-workflow/agent-start', {
      runId: 'step-run', seq: 2, label: 'done', childId: SessionId('done-child'),
    } as never))
    state = reduceWorkflowActivity(state, event(session, 'tool-workflow/agent-end', {
      runId: 'step-run', seq: 2, outcome: 'completed',
    } as never))

    const unrelatedStep = event(session, 'step/end', { turn: 3, step: 1 } as never)
    expect(reduceWorkflowActivity(state, unrelatedStep)).toBe(state)
    state = reduceWorkflowActivity(state, event(session, 'step/end', {
      turn: 3, step: 2,
    } as never))
    expect(projectWorkflowActivity(state)[0]).toMatchObject({
      status: 'interrupted',
      phases: [{ members: [{ status: 'interrupted' }, { status: 'completed' }] }],
    })

    state = reduceWorkflowActivity(state, event(session, 'tool-workflow/run-start', {
      runId: 'turn-run', name: 'Turn run',
    } as never))
    const unrelatedTurn = event(session, 'turn/end', {
      turn: 2, reason: { kind: 'completed' },
    } as never)
    expect(reduceWorkflowActivity(state, unrelatedTurn)).toBe(state)
    state = reduceWorkflowActivity(state, event(session, 'turn/end', {
      turn: 3, reason: { kind: 'completed' },
    } as never))
    expect(projectWorkflowActivity(state).find(run => run.id === 'turn-run')?.status)
      .toBe('interrupted')

    const detached = reduceWorkflowActivity(foldWorkflowActivity([]), event(
      session,
      'tool-workflow/run-start',
      { runId: 'detached', name: 'Detached' } as never,
    ))
    expect(reduceWorkflowActivity(detached, event(session, 'turn/end', {
      turn: 99, reason: { kind: 'completed' },
    } as never))).toBe(detached)

    let openStep = reduceWorkflowActivity(foldWorkflowActivity([]), event(
      session,
      'turn/start',
      { turn: 7 } as never,
    ))
    openStep = reduceWorkflowActivity(openStep, event(session, 'step/start', {
      turn: 7, step: 1,
    } as never))
    const closedTurn = reduceWorkflowActivity(openStep, event(session, 'turn/end', {
      turn: 7, reason: { kind: 'completed' },
    } as never))
    expect(closedTurn).toMatchObject({ turn: undefined, step: undefined })
  })
})
