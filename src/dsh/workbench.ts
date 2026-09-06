import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
// Type-only: exposes the optional agent-scoped GoalService on Context.
import type {} from '@deepseek-ai/dsh-goal'
import type {
  SessionWorkbenchGoal,
  SessionWorkbenchGoalAction,
  SessionWorkbenchGoalActionReceipt,
  SessionWorkbenchGoalBlockReason,
  SessionWorkbenchGoalPhase,
  SessionWorkbenchPlan,
  SessionWorkbenchPort,
  SessionWorkbenchSnapshot,
  SessionWorkbenchTodo,
  SessionWorkbenchTodoStatus,
} from '../workbench/port.ts'

interface DshGoalSnapshot {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly phase: SessionWorkbenchGoalPhase
  readonly blockedReason?: SessionWorkbenchGoalBlockReason
  readonly maxGoalRounds: number
}

interface DshGoalProjection {
  readonly goal: DshGoalSnapshot
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
}

interface DshTodoItem {
  readonly content: string
  readonly status: SessionWorkbenchTodoStatus
}

/** Adapter-owned declaration of the stable official workbench projection surface. */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    readonly plan: SessionWorkbenchPlan
    readonly todos: DshTodoItem[] | null
  }
}

const WORKBENCH_PROJECTION_KEYS: readonly string[] = Object.freeze(['goal', 'plan', 'todos'])

function cloneGoal(value: DshGoalProjection): SessionWorkbenchGoal {
  const goal = value.goal
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    ...(goal.blockedReason === undefined
      ? {}
      : { blockedReason: { ...goal.blockedReason } }),
    maxGoalRounds: goal.maxGoalRounds,
    roundsStarted: value.roundsStarted,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function clonePlan(value: SessionWorkbenchPlan): SessionWorkbenchPlan {
  return { active: value.active, pending: value.pending }
}

function cloneTodos(value: readonly DshTodoItem[]): readonly SessionWorkbenchTodo[] {
  return value.map(item => ({ content: item.content, status: item.status }))
}

/** Same-process anti-corruption layer over Harness's official Session projections. */
export class DshSessionWorkbench implements SessionWorkbenchPort {
  private registry: SessionProjectionRegistry | undefined
  private readonly listeners = new Set<() => void>()
  private stopProjection: (() => void) | undefined
  private readonly stopRegistryBinding: () => void
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly session: Session,
    private readonly agent?: Agent,
  ) {
    const activeRegistry = ctx.get('sessionProjections')
    if (activeRegistry !== undefined) this.attach(activeRegistry)

    const projectionFiber = ctx.inject(['sessionProjections'], (projectionCtx) => {
      if (this.disposed) return
      return this.attach(projectionCtx.sessionProjections)
    })
    this.stopRegistryBinding = () => {
      void projectionFiber.dispose().catch(error => ctx.logger.error(error))
    }
  }

  private attach(registry: SessionProjectionRegistry): () => void {
    if (this.registry === registry) return this.stopProjection!

    this.stopProjection?.()
    this.registry = registry
    let active = true
    const stopChanged = registry.onChanged((changedSession, key) => {
      if (
        this.disposed
        || changedSession !== this.session
        || !WORKBENCH_PROJECTION_KEYS.includes(key)
      ) return
      this.notify()
    })
    const release = () => {
      if (!active) return
      active = false
      stopChanged()
      this.stopProjection = undefined
      this.registry = undefined
      if (!this.disposed) this.notify()
    }
    this.stopProjection = release
    this.notify()
    return release
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A view observer cannot veto the official projection drive.
      }
    }
  }

  workbenchSnapshot(): SessionWorkbenchSnapshot {
    if (this.disposed || this.registry === undefined) return { available: false }
    const snapshot = this.registry.snapshot(this.session)
    const goal = snapshot.values.goal
    const plan = snapshot.values.plan
    const todos = snapshot.values.todos
    const available = goal !== undefined || plan !== undefined || todos !== undefined
    return {
      available,
      asOfSeq: snapshot.asOfSeq,
      ...(goal === undefined
        ? {}
        : { goal: goal === null ? null : cloneGoal(goal) }),
      ...(plan === undefined ? {} : { plan: clonePlan(plan) }),
      ...(todos === undefined
        ? {}
        : { todos: todos === null ? null : cloneTodos(todos) }),
    }
  }

  onWorkbenchChanged(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  runGoalAction(action: SessionWorkbenchGoalAction): SessionWorkbenchGoalActionReceipt {
    if (this.disposed) {
      return {
        accepted: false,
        code: 'workbench-closed',
        message: 'The Session workbench is closed.',
      }
    }
    const agent = this.agent
    if (agent === undefined) {
      return {
        accepted: false,
        code: 'goal-capability-unavailable',
        message: 'This Session lease has no live Agent for Goal actions.',
      }
    }
    const presets = this.ctx.get('agentPresets')
    const goals = presets?.serviceFor(agent, 'goals') ?? this.ctx.get('goals')
    if (goals === undefined) {
      return {
        accepted: false,
        code: 'goal-capability-unavailable',
        message: 'This Agent composition does not provide the official Goal service.',
      }
    }
    const ref = action.ref as Parameters<typeof goals.pause>[1]
    try {
      switch (action.kind) {
        case 'edit':
          goals.edit(agent, ref, { objective: action.objective })
          break
        case 'pause':
          goals.pause(agent, ref)
          break
        case 'resume':
          goals.resume(agent, ref)
          break
        case 'clear':
          goals.clear(agent, ref)
          break
      }
      return { accepted: true }
    } catch (error: unknown) {
      const record = typeof error === 'object' && error !== null
        ? error as { readonly code?: unknown }
        : undefined
      return {
        accepted: false,
        code: typeof record?.code === 'string' ? record.code : 'goal-action-failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  disposeWorkbench(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopProjection?.()
    this.stopRegistryBinding()
    this.listeners.clear()
  }
}
