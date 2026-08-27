import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  DshColdResumeCoordinator,
  DshColdResumeExternalWinnerError,
} from '../src/dsh/cold-resume-coordinator.ts'
import {
  DshColdSessionActivation,
  DshSessionActivation,
} from '../src/dsh/cold-session-activation.ts'
import {
  DshInteractionHub,
  type DshInteractionSession,
} from '../src/dsh/interaction-hub.ts'
import { DshCommandSession } from '../src/dsh/command-session.ts'
import { DshAgentRuntimePort } from '../src/dsh/runtime-port.ts'

const resources: Array<{ readonly ctx: Context; readonly hub: DshInteractionHub }> = []

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.hub.dispose()
    await resource.ctx.fiber.dispose()
  }
})

function createAgent(
  ctx: Context,
  id: string,
  header: Partial<SessionHeader> = {},
): {
  readonly session: Session
  readonly agent: Agent
} {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: 1,
    cwd: 'D:\\workspace',
    agentPreset: 'standard',
    ...header,
  })
  const agent = {
    id: sessionId,
    options: { provider: 'provider', model: 'model' },
    session,
    status: 'idle',
    ctx,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  const agentCtx = ctx.extend({ agent })
  Object.assign(agent, { ctx: agentCtx })
  return { session, agent }
}

function coordinatorStub(
  acquireOwned: DshColdResumeCoordinator['acquireOwned'],
  isReserved: (sessionId: string) => boolean = () => false,
): DshColdResumeCoordinator {
  return { acquireOwned, isReserved } as unknown as DshColdResumeCoordinator
}

describe('DshColdSessionActivation', () => {
  it('arms commands and interaction before publication and returns one owned lease', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const sessionId = SessionId('cold-owned')
    const session = Session.create(sessionId, undefined, {
      version: 0,
      id: sessionId,
      createdAt: 1,
      cwd: 'D:\\workspace',
      agentPreset: 'standard',
    })
    session.append('request/header', {
      reason: 'initial',
      header: { config: { provider: 'persisted-provider', model: 'historic-model' } },
    })
    const liveAgents = new Map<string, Agent>()
    const liveSessions = new Map<string, Session>()
    const mounted = new WeakMap<Context, string>()
    const disposeHandle = vi.fn(async () => {
      liveAgents.delete(sessionId)
      liveSessions.delete(sessionId)
    })
    const registerProvider = vi.fn(() => vi.fn())
    const resume = vi.fn(async (options: ResumeAgentOptions): Promise<AgentHandle> => {
      const agent = {
        id: session.id,
        options: { ...options.agentOptions },
        session,
        status: 'idle',
        ctx,
        followup: vi.fn(),
        steer: vi.fn(),
        cancel: vi.fn(),
        whenIdle: () => Promise.resolve(),
      } as unknown as Agent
      const agentCtx = ctx.extend({ agent })
      Object.assign(agent, { ctx: agentCtx })
      const commit = await options.setup?.(agentCtx)
      expect(registerProvider).toHaveBeenCalledOnce()
      commit?.commit()
      liveAgents.set(agent.id, agent)
      liveSessions.set(session.id, session)
      return { agent, dispose: disposeHandle }
    })

    ctx.provide('tools', { schemas: () => [] } as never)
    ctx.provide('commands', {
      list: () => [{ name: 'inspect', description: 'Inspect session' }],
      execute: () => Promise.resolve(undefined),
    } as never)
    ctx.provide('userQuestions', { registerProvider } as never)
    ctx.provide('sessionPersistence', {
      inspect: async () => ({ meta: session.header, events: session.events }),
    } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
    } as never)
    ctx.provide('agentPresets', {
      defaultId: 'standard',
      resolve: async (id: string) => ({
        id,
        trust: 'system' as const,
        path: `D:\\presets\\${id}\\agent.cordis.yml`,
      }),
      mount: async (agentCtx: Context, id: string) => {
        mounted.set(agentCtx, id)
        return {
          id,
          trust: 'system' as const,
          path: `D:\\presets\\${id}\\agent.cordis.yml`,
        }
      },
      composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
    } as never)
    ctx.provide('sessions', {
      get: (id: string) => liveSessions.get(id),
      flush: () => Promise.resolve(true),
    } as never)
    ctx.provide('agents', {
      get: (id: string) => liveAgents.get(id),
      roots: () => [...liveAgents.values()],
      resume,
    } as never)

    const coordinator = new DshColdResumeCoordinator(ctx)
    const activation = new DshColdSessionActivation(ctx, hub, coordinator)
    const lease = await activation.activateSession({
      intent: 'resume-cold',
      sessionId,
      signal: new AbortController().signal,
    })

    expect(lease.port.sessionId).toBe(sessionId)
    expect(lease.port.listCommands()).toEqual([{
      name: 'inspect',
      description: 'Inspect session',
    }])
    expect(resume).toHaveBeenCalledOnce()
    expect(coordinator.isReserved(sessionId)).toBe(true)
    await expect(activation.activateSession({
      intent: 'resume-cold',
      sessionId,
      signal: new AbortController().signal,
    })).rejects.toThrow('already owned by DSH-TUI')
    expect(resume).toHaveBeenCalledOnce()
    expect(registerProvider).toHaveBeenCalledOnce()

    const firstRelease = lease.release()
    expect(lease.release()).toBe(firstRelease)
    await firstRelease
    expect(disposeHandle).toHaveBeenCalledOnce()
    expect(coordinator.isReserved(sessionId)).toBe(false)
  })

  it('adopts an exact external root winner as borrowed without owning its teardown', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const sessionId = SessionId('external-winner')
    const session = Session.create(sessionId, undefined, {
      version: 0,
      id: sessionId,
      createdAt: 1,
      cwd: 'D:\\workspace',
      agentPreset: 'standard',
    })
    const followup = vi.fn()
    const external = {
      id: session.id,
      options: { provider: 'external-provider', model: 'external-model' },
      session,
      status: 'idle',
      ctx,
      followup,
      steer: vi.fn(),
      cancel: vi.fn(),
      whenIdle: () => Promise.resolve(),
    } as unknown as Agent
    const externalCtx = ctx.extend({ agent: external })
    Object.assign(external, { ctx: externalCtx })
    let currentAgent: Agent | undefined
    let currentSession: Session | undefined
    const externalDispose = vi.fn()
    const registerProvider = vi.fn(() => vi.fn())
    const resumeFailure = new Error('Agent registry collision')
    const resume = vi.fn(async () => {
      currentAgent = external
      currentSession = session
      throw resumeFailure
    })

    ctx.provide('tools', { schemas: () => [] } as never)
    ctx.provide('commands', {
      list: () => [],
      execute: () => Promise.resolve(undefined),
    } as never)
    ctx.provide('userQuestions', { registerProvider } as never)
    ctx.provide('sessionPersistence', {
      inspect: async () => ({ meta: session.header, events: session.events }),
    } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
    } as never)
    ctx.provide('agentPresets', {
      defaultId: 'standard',
      resolve: async (id: string) => ({
        id,
        trust: 'system' as const,
        path: `D:\\presets\\${id}\\agent.cordis.yml`,
      }),
      mount: vi.fn(),
      composedPreset: () => undefined,
    } as never)
    ctx.provide('sessions', {
      get: (id: string) => id === sessionId ? currentSession : undefined,
      flush: () => Promise.resolve(true),
    } as never)
    ctx.provide('agents', {
      get: (id: string) => id === sessionId ? currentAgent : undefined,
      roots: () => currentAgent === undefined ? [] : [currentAgent],
      resume,
      dispose: externalDispose,
    } as never)

    const coordinator = new DshColdResumeCoordinator(ctx)
    const activation = new DshColdSessionActivation(ctx, hub, coordinator)
    const lease = await activation.activateSession({
      intent: 'resume-cold',
      sessionId,
      signal: new AbortController().signal,
    })
    await lease.port.submit({ text: 'borrow winner' }, 'followup')
    expect(followup).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
    expect(registerProvider).toHaveBeenCalledOnce()
    expect(coordinator.isReserved(sessionId)).toBe(false)

    await lease.release()
    expect(externalDispose).not.toHaveBeenCalled()
    expect(currentAgent).toBe(external)
    expect(currentSession).toBe(session)
  })

  it('rejects the wrong activation intent before touching services', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const activation = new DshColdSessionActivation(
      ctx,
      hub,
      new DshColdResumeCoordinator(ctx),
    )
    await expect(activation.activateSession({
      intent: 'attach-live',
      sessionId: 'wrong-intent',
      signal: new AbortController().signal,
    })).rejects.toThrow('cold activation cannot satisfy "attach-live"')
  })
})

describe('cold activation failure boundaries', () => {
  it('dispatches both explicit intents without inferring a fallback path', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const acquireOwned = vi.fn(async () => {
      throw new Error('coordinator must not be reached')
    })
    const activation = new DshSessionActivation(
      ctx,
      hub,
      coordinatorStub(acquireOwned),
    )

    await expect(activation.activateSession({
      intent: 'attach-live',
      sessionId: 'dispatch-live',
      signal: new AbortController().signal,
    })).rejects.toThrow('Agent service is unavailable')
    await expect(activation.activateSession({
      intent: 'resume-cold',
      sessionId: 'dispatch-cold',
      signal: new AbortController().signal,
    })).rejects.toThrow('Session service is unavailable')
    expect(acquireOwned).not.toHaveBeenCalled()
  })

  it('preserves the setup error when no unpublished Agent or external winner exists', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const getAgent = vi.fn(() => undefined)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('agents', { get: getAgent } as never)
    const acquireOwned = vi.fn(async (
      request: Parameters<DshColdResumeCoordinator['acquireOwned']>[0],
    ): Promise<AgentHandle> => {
      await request.setup?.(ctx.extend({}))
      throw new Error('setup unexpectedly accepted a missing Agent')
    })
    const activation = new DshColdSessionActivation(
      ctx,
      hub,
      coordinatorStub(acquireOwned),
    )

    await expect(activation.activateSession({
      intent: 'resume-cold',
      sessionId: 'missing-unpublished-agent',
      signal: new AbortController().signal,
    })).rejects.toThrow('did not expose its unpublished Agent')
    expect(getAgent).not.toHaveBeenCalled()
  })

  it('rolls back an owned handle when coordinator setup did not run', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const { agent } = createAgent(ctx, 'setup-not-run')
    const dispose = vi.fn(async () => {})
    ctx.provide('sessions', { get: () => undefined } as never)
    const acquireOwned = vi.fn(async (): Promise<AgentHandle> => ({ agent, dispose }))
    const activation = new DshColdSessionActivation(
      ctx,
      hub,
      coordinatorStub(acquireOwned),
    )

    await expect(activation.activateSession({
      intent: 'resume-cold',
      sessionId: agent.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('cold interaction setup did not run')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('aggregates a post-acquire abort with its single handle rollback failure', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const { agent } = createAgent(ctx, 'abort-after-acquire')
    const abort = new AbortController()
    const abortReason = new Error('abort after owned acquisition')
    const handleFailure = new Error('owned handle rollback failed')
    const dispose = vi.fn(async () => { throw handleFailure })
    ctx.provide('sessions', { get: () => undefined } as never)
    const acquireOwned = vi.fn(async (): Promise<AgentHandle> => {
      abort.abort(abortReason)
      return { agent, dispose }
    })
    const activation = new DshColdSessionActivation(
      ctx,
      hub,
      coordinatorStub(acquireOwned),
    )

    const error = await activation.activateSession({
      intent: 'resume-cold',
      sessionId: agent.id,
      signal: abort.signal,
    }).then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).message).toBe(
      'DSH cold activation and rollback failed',
    )
    expect((error as AggregateError).errors).toEqual([abortReason, handleFailure])
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('aggregates command, interaction, and runtime rollback errors in ownership order', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const activation = new DshColdSessionActivation(
      ctx,
      hub,
      coordinatorStub(vi.fn()),
    )
    type RollbackProbe = {
      rollback(
        commands: Pick<DshCommandSession, 'disposeCommands'> | undefined,
        interaction: Pick<DshInteractionSession, 'disposeInteractions'> | undefined,
        runtime: Pick<DshAgentRuntimePort, 'dispose'> | undefined,
        handle: Pick<AgentHandle, 'dispose'> | undefined,
        models?: { disposeModels(): void },
        context?: { disposeContext(): void },
        workbench?: { disposeWorkbench(): void },
        jobs?: { disposeJobs(): void },
      ): Promise<unknown | undefined>
    }
    const rollback = (activation as unknown as RollbackProbe).rollback.bind(activation)
    const commandFailure = new Error('command cleanup failed')
    const interactionFailure = new Error('interaction cleanup failed')
    const modelFailure = new Error('model cleanup failed')
    const contextFailure = new Error('context cleanup failed')
    const workbenchFailure = new Error('workbench cleanup failed')
    const jobsFailure = new Error('jobs cleanup failed')
    const runtimeFailure = new Error('runtime cleanup failed')
    const commands = {
      disposeCommands: vi.fn(() => { throw commandFailure }),
    }
    const interaction = {
      disposeInteractions: vi.fn(() => { throw interactionFailure }),
    }
    const runtime = {
      dispose: vi.fn(async () => { throw runtimeFailure }),
    }
    const models = {
      disposeModels: vi.fn(() => { throw modelFailure }),
    }
    const context = {
      disposeContext: vi.fn(() => { throw contextFailure }),
    }
    const workbench = {
      disposeWorkbench: vi.fn(() => { throw workbenchFailure }),
    }
    const jobs = {
      disposeJobs: vi.fn(() => { throw jobsFailure }),
    }
    const handle = { dispose: vi.fn(async () => {}) }

    await expect(rollback(undefined, undefined, undefined, undefined, undefined)).resolves.toBeUndefined()
    const error = await rollback(
      commands,
      interaction,
      runtime,
      handle,
      models,
      context,
      workbench,
      jobs,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).message).toBe(
      'DSH cold activation rollback failed',
    )
    expect((error as AggregateError).errors).toEqual([
      commandFailure,
      interactionFailure,
      modelFailure,
      contextFailure,
      workbenchFailure,
      jobsFailure,
      runtimeFailure,
    ])
    expect(commands.disposeCommands).toHaveBeenCalledOnce()
    expect(interaction.disposeInteractions).toHaveBeenCalledOnce()
    expect(models.disposeModels).toHaveBeenCalledOnce()
    expect(context.disposeContext).toHaveBeenCalledOnce()
    expect(workbench.disposeWorkbench).toHaveBeenCalledOnce()
    expect(jobs.disposeJobs).toHaveBeenCalledOnce()
    expect(runtime.dispose).toHaveBeenCalledOnce()
    expect(handle.dispose).not.toHaveBeenCalled()
  })

  it('preserves an abort that occurs before external-winner adoption', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const abort = new AbortController()
    const abortReason = new Error('abort before adoption')
    const getAgent = vi.fn(() => undefined)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('agents', { get: getAgent } as never)
    const acquireOwned = vi.fn(async () => {
      abort.abort(abortReason)
      throw new Error('resume lost the race')
    })
    const activation = new DshColdSessionActivation(
      ctx,
      hub,
      coordinatorStub(acquireOwned),
    )

    await expect(activation.activateSession({
      intent: 'resume-cold',
      sessionId: 'abort-before-adoption',
      signal: abort.signal,
    })).rejects.toBe(abortReason)
    expect(getAgent).not.toHaveBeenCalled()
  })

  it('does not adopt a live root after an unclassified coordinator failure', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const { session, agent } = createAgent(ctx, 'unclassified-failure')
    const acquireFailure = new Error('preset resolution failed')
    const registerProvider = vi.fn(() => vi.fn())
    ctx.provide('tools', { schemas: () => [] } as never)
    ctx.provide('commands', {
      list: () => [],
      execute: () => Promise.resolve(undefined),
    } as never)
    ctx.provide('userQuestions', { registerProvider } as never)
    ctx.provide('sessions', {
      get: (id: string) => id === session.id ? session : undefined,
      flush: () => Promise.resolve(true),
    } as never)
    ctx.provide('agents', {
      get: (id: string) => id === agent.id ? agent : undefined,
      roots: () => [agent],
    } as never)
    const acquireOwned = vi.fn(async () => { throw acquireFailure })
    const activation = new DshColdSessionActivation(
      ctx,
      hub,
      coordinatorStub(acquireOwned),
    )

    await expect(activation.activateSession({
      intent: 'resume-cold',
      sessionId: session.id,
      signal: new AbortController().signal,
    })).rejects.toBe(acquireFailure)
    expect(registerProvider).not.toHaveBeenCalled()
  })

  it('preserves a classified race when the external winner disappears before adoption', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const getAgent = vi.fn(() => undefined)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('agents', { get: getAgent } as never)
    const cause = new Error('registry collision')
    const race = new DshColdResumeExternalWinnerError('vanished-winner', cause)
    const activation = new DshColdSessionActivation(
      ctx,
      hub,
      coordinatorStub(vi.fn(async () => { throw race })),
    )

    await expect(activation.activateSession({
      intent: 'resume-cold',
      sessionId: 'vanished-winner',
      signal: new AbortController().signal,
    })).rejects.toBe(race)
    expect(getAgent).toHaveBeenCalledExactlyOnceWith('vanished-winner')
  })

  it('aggregates a classified race with delegated external live-adoption rejection', async () => {
    const ctx = new Context()
    const hub = new DshInteractionHub(ctx)
    resources.push({ ctx, hub })
    const { session, agent } = createAgent(ctx, 'external-delegated', {
      delegationDepth: 1,
    })
    const acquireFailure = new Error('resume registry collision')
    ctx.provide('sessions', {
      get: (id: string) => id === session.id ? session : undefined,
    } as never)
    ctx.provide('agents', {
      get: (id: string) => id === agent.id ? agent : undefined,
      roots: () => [agent],
    } as never)
    const race = new DshColdResumeExternalWinnerError(session.id, acquireFailure)
    const acquireOwned = vi.fn(async () => { throw race })
    const activation = new DshColdSessionActivation(
      ctx,
      hub,
      coordinatorStub(acquireOwned),
    )

    const error = await activation.activateSession({
      intent: 'resume-cold',
      sessionId: session.id,
      signal: new AbortController().signal,
    }).then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).message).toContain(
      'cold resume and external live adoption failed',
    )
    expect((error as AggregateError).errors[0]).toBe(race)
    expect(race.cause).toBe(acquireFailure)
    expect((error as AggregateError).errors[1]).toBeInstanceOf(Error)
    expect(((error as AggregateError).errors[1] as Error).message).toContain(
      'cannot activate subagent session',
    )
  })
})
