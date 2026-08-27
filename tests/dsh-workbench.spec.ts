import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DshSessionWorkbench } from '../src/dsh/workbench.ts'
import type {
  SessionWorkbenchGoal,
  SessionWorkbenchGoalAction,
  SessionWorkbenchPlan,
  SessionWorkbenchTodo,
} from '../src/workbench/port.ts'

interface FakeGoalService {
  readonly edit: ReturnType<typeof vi.fn>
  readonly pause: ReturnType<typeof vi.fn>
  readonly resume: ReturnType<typeof vi.fn>
  readonly clear: ReturnType<typeof vi.fn>
}

function fakeGoalService(): FakeGoalService {
  return {
    edit: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clear: vi.fn(),
  }
}

function actionContext(options: {
  readonly root?: FakeGoalService
  readonly scoped?: FakeGoalService
} = {}): {
  readonly ctx: Context
  readonly agent: Agent
  readonly serviceFor: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
} {
  const agent = { id: 'agent-goal-actions' } as unknown as Agent
  const serviceFor = vi.fn(() => options.scoped)
  const dispose = vi.fn(async () => {})
  const ctx = {
    get: vi.fn((key: string) => {
      if (key === 'agentPresets') return { serviceFor }
      if (key === 'goals') return options.root
      return undefined
    }),
    inject: vi.fn(() => ({ dispose })),
    logger: { error: vi.fn() },
  } as unknown as Context
  return { ctx, agent, serviceFor, dispose }
}

const identitySchema = {
  parse<T>(value: T): T {
    return structuredClone(value)
  },
}

const GOAL: SessionWorkbenchGoal = {
  id: 'goal-1',
  revision: 2,
  objective: 'Ship the first-party workbench',
  phase: 'blocked',
  blockedReason: { code: 'review', message: 'Waiting for review' },
  maxGoalRounds: 8,
  roundsStarted: 3,
  createdAt: 10,
  updatedAt: 20,
}

const ACTIVE_GOAL: SessionWorkbenchGoal = {
  id: GOAL.id,
  revision: GOAL.revision,
  objective: GOAL.objective,
  phase: 'active',
  maxGoalRounds: GOAL.maxGoalRounds,
  roundsStarted: GOAL.roundsStarted,
  createdAt: GOAL.createdAt,
  updatedAt: GOAL.updatedAt,
}

const PLAN: SessionWorkbenchPlan = { active: true, pending: false }
const TODOS: readonly SessionWorkbenchTodo[] = [
  { content: 'Adapt official projections', status: 'completed' },
  { content: 'Render the mission rail', status: 'in_progress' },
  { content: 'Run official acceptance', status: 'pending' },
]

function registerWorkbenchContract(
  ctx: Context,
  projectedGoal: SessionWorkbenchGoal = GOAL,
): void {
  const registry = ctx.sessionProjections
  registry.register({
    key: 'goal',
    stateSchema: identitySchema,
    init: () => null,
    apply: (state: unknown, event: SessionEvent) => (
      event.type === 'turn/start'
        ? {
            goal: {
              id: projectedGoal.id,
              revision: projectedGoal.revision,
              objective: projectedGoal.objective,
              phase: projectedGoal.phase,
              ...(projectedGoal.blockedReason === undefined
                ? {}
                : { blockedReason: projectedGoal.blockedReason }),
              maxGoalRounds: projectedGoal.maxGoalRounds,
            },
            roundsStarted: projectedGoal.roundsStarted,
            createdAt: projectedGoal.createdAt,
            updatedAt: projectedGoal.updatedAt,
          }
        : state
    ),
    wire: { viewSchema: identitySchema, view: (state: unknown) => state },
    stateVersion: 0,
  } as never)
  registry.register({
    key: 'plan',
    stateSchema: identitySchema,
    init: (): SessionWorkbenchPlan => ({ active: false, pending: false }),
    apply: (state: SessionWorkbenchPlan, event: SessionEvent) => (
      event.type === 'turn/start' ? PLAN : state
    ),
    wire: { viewSchema: identitySchema, view: (state: SessionWorkbenchPlan) => state },
    stateVersion: 0,
  } as never)
  registry.register({
    key: 'todos',
    stateSchema: identitySchema,
    init: () => null,
    apply: (state: unknown, event: SessionEvent) => (
      event.type === 'turn/start' ? TODOS : state
    ),
    wire: { viewSchema: identitySchema, view: (state: unknown) => state },
    stateVersion: 0,
  } as never)
}

async function harness(
  projectedGoal: SessionWorkbenchGoal = GOAL,
): Promise<{ readonly ctx: Context; readonly session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  registerWorkbenchContract(ctx, projectedGoal)
  return { ctx, session: ctx.sessions.create() }
}

describe('official DSH workbench projection adapter', () => {
  it('detaches the official whole-value projections into product-owned state', async () => {
    const { ctx, session } = await harness()
    const workbench = new DshSessionWorkbench(ctx, session)

    try {
      expect(workbench.workbenchSnapshot()).toEqual({
        available: true,
        asOfSeq: -1,
        goal: null,
        plan: { active: false, pending: false },
        todos: null,
      })

      session.append('turn/start', { turn: 1 })
      const snapshot = workbench.workbenchSnapshot()
      expect(snapshot).toEqual({
        available: true,
        asOfSeq: 0,
        goal: GOAL,
        plan: PLAN,
        todos: TODOS,
      })

      ;(snapshot.goal as { objective: string }).objective = 'mutated by view'
      ;(snapshot.todos![1] as { content: string }).content = 'mutated by view'
      expect(workbench.workbenchSnapshot().goal?.objective).toBe(GOAL.objective)
      expect(workbench.workbenchSnapshot().todos?.[1]?.content).toBe(TODOS[1]!.content)
    } finally {
      workbench.disposeWorkbench()
      await ctx.fiber.dispose()
    }
  })

  it('rehydrates durable workbench state when the adapter binds after session events', async () => {
    const { ctx, session } = await harness(ACTIVE_GOAL)
    session.append('turn/start', { turn: 1 })
    const workbench = new DshSessionWorkbench(ctx, session)

    try {
      expect(workbench.workbenchSnapshot()).toEqual({
        available: true,
        asOfSeq: 0,
        goal: ACTIVE_GOAL,
        plan: PLAN,
        todos: TODOS,
      })
    } finally {
      workbench.disposeWorkbench()
      await ctx.fiber.dispose()
    }
  })

  it('reports capability absence without inventing local goal, plan, or todo state', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const workbench = new DshSessionWorkbench(ctx, ctx.sessions.create())

    expect(workbench.workbenchSnapshot()).toEqual({ available: false, asOfSeq: -1 })
    workbench.disposeWorkbench()
    await ctx.fiber.dispose()
  })

  it('reacts only to this session workbench keys and contains observer failures', async () => {
    const { ctx, session } = await harness()
    const other = ctx.sessions.create()
    const workbench = new DshSessionWorkbench(ctx, session)
    let observed = 0
    workbench.onWorkbenchChanged(() => { throw new Error('view failed') })
    const stop = workbench.onWorkbenchChanged(() => { observed += 1 })

    other.append('turn/start', { turn: 1 })
    expect(observed).toBe(0)
    session.append('turn/start', { turn: 1 })
    expect(observed).toBeGreaterThan(0)

    const beforeStop = observed
    stop()
    stop()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(observed).toBe(beforeStop)

    workbench.disposeWorkbench()
    workbench.disposeWorkbench()
    expect(workbench.workbenchSnapshot()).toEqual({ available: false })
    expect(workbench.onWorkbenchChanged(() => { observed += 1 })()).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('attaches late, reuses one registry listener, and contains late cleanup', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const workbench = new DshSessionWorkbench(ctx, session)
    let observed = 0
    workbench.onWorkbenchChanged(() => { observed += 1 })

    expect(workbench.workbenchSnapshot()).toEqual({ available: false })
    await ctx.plugin(SessionProjectionRegistry)
    registerWorkbenchContract(ctx)
    session.append('turn/start', { turn: 1 })
    expect(workbench.workbenchSnapshot().goal?.id).toBe(GOAL.id)
    expect(observed).toBeGreaterThan(0)
    workbench.disposeWorkbench()
    await ctx.fiber.dispose()

    const stopChanged = vi.fn()
    const registry = {
      onChanged: vi.fn(() => stopChanged),
      snapshot: vi.fn(() => ({ values: {}, asOfSeq: -1 })),
    } as unknown as SessionProjectionRegistry
    const cleanupFailure = new Error('projection binding cleanup failed')
    const dispose = vi.fn(() => Promise.reject(cleanupFailure))
    const logError = vi.fn()
    let activate: ((projectionCtx: Context) => unknown) | undefined
    const fake = {
      get: () => registry,
      inject: (_deps: unknown, callback: (projectionCtx: Context) => unknown) => {
        activate = callback
        return { dispose }
      },
      logger: { error: logError },
    } as unknown as Context
    const reused = new DshSessionWorkbench(fake, {} as Session)
    let releaseNotifications = 0
    reused.onWorkbenchChanged(() => { releaseNotifications += 1 })

    expect(registry.onChanged).toHaveBeenCalledOnce()
    const release = activate?.({ sessionProjections: registry } as Context) as (() => void) | undefined
    expect(release).toBeTypeOf('function')
    expect(registry.onChanged).toHaveBeenCalledOnce()
    release?.()
    release?.()
    expect(reused.workbenchSnapshot()).toEqual({ available: false })
    expect(releaseNotifications).toBe(1)
    reused.disposeWorkbench()
    expect(stopChanged).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => activate?.({ sessionProjections: registry } as Context)).not.toThrow()
    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledExactlyOnceWith(cleanupFailure)
    })
  })
})

describe('official DSH Goal action adapter', () => {
  const ref = { id: 'goal-action', revision: 7 }

  it('prefers the exact Agent-scoped Goal service and forwards every CAS mutation', () => {
    const root = fakeGoalService()
    const scoped = fakeGoalService()
    const { ctx, agent, serviceFor } = actionContext({ root, scoped })
    const workbench = new DshSessionWorkbench(ctx, {} as Session, agent)
    const actions: readonly SessionWorkbenchGoalAction[] = [
      { kind: 'edit', ref, objective: 'Revised objective' },
      { kind: 'pause', ref },
      { kind: 'resume', ref },
      { kind: 'clear', ref },
    ]

    for (const action of actions) expect(workbench.runGoalAction(action)).toEqual({ accepted: true })

    expect(serviceFor).toHaveBeenCalledTimes(4)
    expect(serviceFor).toHaveBeenCalledWith(agent, 'goals')
    expect(scoped.edit).toHaveBeenCalledExactlyOnceWith(
      agent,
      ref,
      { objective: 'Revised objective' },
    )
    expect(scoped.pause).toHaveBeenCalledExactlyOnceWith(agent, ref)
    expect(scoped.resume).toHaveBeenCalledExactlyOnceWith(agent, ref)
    expect(scoped.clear).toHaveBeenCalledExactlyOnceWith(agent, ref)
    expect(root.edit).not.toHaveBeenCalled()
    expect(root.pause).not.toHaveBeenCalled()
    expect(root.resume).not.toHaveBeenCalled()
    expect(root.clear).not.toHaveBeenCalled()
  })

  it('falls back to the root service and contains official or non-Error failures', () => {
    const root = fakeGoalService()
    const stale = Object.assign(new Error('Goal revision is stale.'), { code: 'goal-stale' })
    root.pause.mockImplementationOnce(() => { throw stale })
    root.clear.mockImplementationOnce(() => { throw 'clear exploded' })
    const { ctx, agent, serviceFor } = actionContext({ root })
    const workbench = new DshSessionWorkbench(ctx, {} as Session, agent)

    expect(workbench.runGoalAction({ kind: 'pause', ref })).toEqual({
      accepted: false,
      code: 'goal-stale',
      message: 'Goal revision is stale.',
    })
    expect(workbench.runGoalAction({ kind: 'clear', ref })).toEqual({
      accepted: false,
      code: 'goal-action-failed',
      message: 'clear exploded',
    })
    expect(serviceFor).toHaveBeenCalledWith(agent, 'goals')
    expect(root.pause).toHaveBeenCalledWith(agent, ref)
    expect(root.clear).toHaveBeenCalledWith(agent, ref)
  })

  it('fails closed without a live Agent, a composed Goal service, or an open adapter', () => {
    const root = fakeGoalService()
    const withoutAgent = actionContext({ root })
    const noAgent = new DshSessionWorkbench(withoutAgent.ctx, {} as Session)
    expect(noAgent.runGoalAction({ kind: 'pause', ref })).toMatchObject({
      accepted: false,
      code: 'goal-capability-unavailable',
      message: expect.stringContaining('no live Agent'),
    })

    const withoutService = actionContext()
    const noService = new DshSessionWorkbench(
      withoutService.ctx,
      {} as Session,
      withoutService.agent,
    )
    expect(noService.runGoalAction({ kind: 'pause', ref })).toMatchObject({
      accepted: false,
      code: 'goal-capability-unavailable',
      message: expect.stringContaining('does not provide'),
    })

    const open = actionContext({ root })
    const disposed = new DshSessionWorkbench(open.ctx, {} as Session, open.agent)
    disposed.disposeWorkbench()
    expect(disposed.runGoalAction({ kind: 'pause', ref })).toMatchObject({
      accepted: false,
      code: 'workbench-closed',
    })
    expect(open.dispose).toHaveBeenCalledOnce()
  })
})
