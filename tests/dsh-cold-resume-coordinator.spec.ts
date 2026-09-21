import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  AgentSetupCommit,
  ModelSelection,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import {
  DshColdResumeBusyError,
  DshColdResumeCoordinator,
  DshColdResumeExternalWinnerError,
  DshColdResumeSemanticDriftError,
} from '../src/dsh/cold-resume-coordinator.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function inspectionOf(session: Session): SessionInspection {
  return {
    meta: session.header,
    inheritedEventCount: session.inheritedEventCount,
    events: session.snapshotEvents(),
  }
}

function persistedSession(id: string, model: string): Session {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    isSeeded: false,
    cwd: 'D:\\workspace',
    agentPreset: 'standard',
  })
  session.append('request/header', {
    reason: 'initial',
    header: { config: { provider: 'persisted-provider', model } },
  })
  return session
}

function fallbackSession(id: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    isSeeded: false,
    cwd: 'D:\\workspace',
  })
}

function liveAgent(ctx: Context, session: Session): Agent {
  const agent = {
    id: session.id,
    options: { provider: 'external-provider', model: 'external-model' },
    session,
    status: 'idle',
    ctx,
    followup: () => {},
    steer: () => {},
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  const agentCtx = ctx.extend({ agent })
  Object.assign(agent, { ctx: agentCtx })
  return agent
}

interface SuccessfulResumeHooks {
  readonly afterPublish?: (agent: Agent) => void
  readonly beforeCommit?: (agent: Agent, commit: AgentSetupCommit | void) => void
  readonly handleAgent?: (agent: Agent) => Agent
  readonly keepPublishedOnDispose?: boolean
  readonly mountSource?: (id: string) => AgentPreset
  readonly onAgentContext?: (agentCtx: Context) => void
  readonly omitSetupAgent?: boolean
  readonly onCurrentSelection?: () => void
  readonly onRoots?: () => void
  readonly roots?: (agents: readonly Agent[]) => readonly Agent[]
}

function provideSuccessfulResumeServices(
  ctx: Context,
  inspectImplementation: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<SessionInspection>,
  preparedSession: () => Session,
  beforeDispose?: () => Promise<void>,
  hooks: SuccessfulResumeHooks = {},
) {
  const liveAgents = new Map<string, Agent>()
  const liveSessions = new Map<string, Session>()
  const mounted = new WeakMap<Context, string>()
  let currentSelection: ModelSelection | undefined = {
    provider: 'default-provider',
    model: 'default-model',
  }
  let defaultPresetId = 'standard'
  let globalTools: string[] = []
  const inspect = vi.fn(inspectImplementation)
  const mount = vi.fn(async (agentCtx: Context, id: string) => {
    mounted.set(agentCtx, id)
    return hooks.mountSource?.(id) ?? {
      id,
      trust: 'system' as const,
      path: `D:\\presets\\${id}\\agent.cordis.yml`,
    }
  })
  const handles: AgentHandle[] = []
  const resume = vi.fn(async (options: ResumeAgentOptions): Promise<AgentHandle> => {
    const session = preparedSession()
    const agent = {
      id: session.id,
      options: { ...options.agentOptions },
      session,
      status: 'idle',
      ctx,
      followup: () => {},
      steer: () => {},
      cancel: () => {},
      whenIdle: () => Promise.resolve(),
    } as unknown as Agent
    const agentCtx = hooks.omitSetupAgent
      ? ctx.extend({})
      : createScope(ctx, agent).ctx.extend({ agent })
    Object.assign(agent, { ctx: agentCtx })
    hooks.onAgentContext?.(agentCtx)
    // 0.1.5 dropped `Context.agent`: the unpublished Agent reaches setup only
    // as the second AgentSetup argument, so the omitted-exposure failure mode
    // is a setup call without it.
    const commit = hooks.omitSetupAgent
      ? await options.setup?.(agentCtx, undefined as never)
      : await options.setup?.(agentCtx, agent)
    hooks.beforeCommit?.(agent, commit)
    commit?.commit()
    liveSessions.set(session.id, session)
    liveAgents.set(agent.id, agent)
    hooks.afterPublish?.(agent)
    const handle: AgentHandle = {
      agent: hooks.handleAgent?.(agent) ?? agent,
      dispose: vi.fn(async () => {
        await beforeDispose?.()
        if (hooks.keepPublishedOnDispose !== true) {
          if (liveAgents.get(agent.id) === agent) liveAgents.delete(agent.id)
          if (liveSessions.get(session.id) === session) liveSessions.delete(session.id)
        }
      }),
    }
    handles.push(handle)
    return handle
  })

  ctx.provide('loader', { await: () => Promise.resolve() } as never)
  ctx.provide('tools', {
    schemas: () => globalTools.map(name => ({ name })),
  } as never)
  ctx.provide('sessionPersistence', {
    open: async (
      id: SessionId,
      _access: 'read' | 'write',
      options?: { signal?: AbortSignal },
    ) => {
      const inspection = await inspect(id, options?.signal)
      return {
        id,
        header: inspection.meta,
        inheritedEventCount: inspection.inheritedEventCount,
        read: async () => ({ eventState: 'detached', events: inspection.events }),
        close: async () => {},
      }
    },
  } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => {
      hooks.onCurrentSelection?.()
      return currentSelection
    },
  } as never)
  ctx.provide('agentPresets', {
    get defaultId() { return defaultPresetId },
    resolve: async (id: string) => ({
      id,
      trust: 'system' as const,
      path: `D:\\presets\\${id}\\agent.cordis.yml`,
    }),
    mount,
    composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
  } as never)
  ctx.provide('sessions', {
    get: (id: string) => liveSessions.get(id),
    flush: () => Promise.resolve(true),
  } as never)
  ctx.provide('agents', {
    get: (id: string) => liveAgents.get(id),
    roots: () => {
      hooks.onRoots?.()
      const agents = [...liveAgents.values()]
      return hooks.roots?.(agents) ?? agents
    },
    resume,
  } as never)
  return {
    handles,
    inspect,
    liveAgents,
    liveSessions,
    mount,
    resume,
    setCurrentSelection: (selection: ModelSelection | undefined) => {
      currentSelection = selection
    },
    setDefaultPresetId: (id: string) => { defaultPresetId = id },
    setGlobalTools: (names: readonly string[]) => { globalTools = [...names] },
  }
}

function toolChangeListenerCount(ctx: Context): number {
  return ctx.fiber.getEffects().filter(
    effect => effect.label === 'ctx.on("tools/change")',
  ).length
}

function modelSelectionListenerCount(ctx: Context): number {
  return ctx.fiber.getEffects().filter(
    effect => effect.label === 'ctx.on("system-prompt/assemble")'
      || effect.label === 'ctx.on("agent/request")',
  ).length
}

describe('DshColdResumeCoordinator', () => {
  it('installs scoped guidance before cold-resume publication and releases it with ownership', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    const session = persistedSession('guidance-resume', 'historic-model')
    const service = provideSuccessfulResumeServices(
      ctx,
      async () => inspectionOf(session),
      () => Session.create(
        session.id,
        session.snapshotEvents(),
        session.header,
        session.inheritedEventCount,
      ),
    )
    const coordinator = new DshColdResumeCoordinator(ctx)
    const acquired = await coordinator.acquireOwned({
      sessionId: session.id,
      signal: new AbortController().signal,
      setup: async agentCtx => {
        expect(service.liveAgents.size).toBe(0)
        expect((await ctx.systemPrompt.assemble({ scope: scopeOf(agentCtx)! })).sections)
          .toContainEqual(expect.objectContaining({ name: 'dsh-tui:agent-guidance' }))
        expect((await ctx.systemPrompt.assemble()).sections)
          .not.toContainEqual(expect.objectContaining({ name: 'dsh-tui:agent-guidance' }))
      },
    })
    const agent = acquired.agent
    await acquired.dispose()
    expect((await ctx.systemPrompt.assemble({ scope: agent })).sections)
      .not.toContainEqual(expect.objectContaining({ name: 'dsh-tui:agent-guidance' }))
    await coordinator.dispose()
  })

  it('fails without required services, a default model, or an isolated preset profile', async () => {
    const missingServices = new Context()
    contexts.push(missingServices)
    const missingCoordinator = new DshColdResumeCoordinator(missingServices)
    await expect(missingCoordinator.acquireOwned({
      sessionId: 'missing-services',
      signal: new AbortController().signal,
    })).rejects.toThrow('services are unavailable')
    expect(missingCoordinator.isReserved('missing-services')).toBe(false)

    const noModel = new Context()
    contexts.push(noModel)
    const noModelSession = persistedSession('missing-model', 'historic-model')
    const noModelBench = provideSuccessfulResumeServices(
      noModel,
      async () => inspectionOf(noModelSession),
      () => noModelSession,
    )
    noModelBench.setCurrentSelection(undefined)
    const noModelCoordinator = new DshColdResumeCoordinator(noModel)
    await expect(noModelCoordinator.acquireOwned({
      sessionId: noModelSession.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('model selection is unavailable')
    expect(noModelCoordinator.isReserved(noModelSession.id)).toBe(false)
    expect(toolChangeListenerCount(noModel)).toBe(0)

    const globalToolContext = new Context()
    contexts.push(globalToolContext)
    const globalToolSession = persistedSession('global-tool', 'historic-model')
    const globalToolBench = provideSuccessfulResumeServices(
      globalToolContext,
      async () => inspectionOf(globalToolSession),
      () => globalToolSession,
    )
    globalToolBench.setGlobalTools(['late-global'])
    const globalToolCoordinator = new DshColdResumeCoordinator(globalToolContext)
    await expect(globalToolCoordinator.acquireOwned({
      sessionId: globalToolSession.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('global tools outside an Agent scope: late-global')
    expect(globalToolCoordinator.isReserved(globalToolSession.id)).toBe(false)
    expect(toolChangeListenerCount(globalToolContext)).toBe(0)
  })

  it('classifies complete eligible roots already present or published during planning', async () => {
    const existingContext = new Context()
    contexts.push(existingContext)
    const existingSession = persistedSession('existing-root', 'historic-model')
    const existingBench = provideSuccessfulResumeServices(
      existingContext,
      async () => inspectionOf(existingSession),
      () => existingSession,
    )
    const existingAgent = liveAgent(existingContext, existingSession)
    existingBench.liveAgents.set(existingAgent.id, existingAgent)
    existingBench.liveSessions.set(existingSession.id, existingSession)
    const existingCoordinator = new DshColdResumeCoordinator(existingContext)

    const existingError = await existingCoordinator.acquireOwned({
      sessionId: existingSession.id,
      signal: new AbortController().signal,
    }).then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(existingError).toBeInstanceOf(DshColdResumeExternalWinnerError)
    expect((existingError as DshColdResumeExternalWinnerError).sessionId)
      .toBe(existingSession.id)
    expect((existingError as DshColdResumeExternalWinnerError).cause)
      .toBeInstanceOf(Error)
    expect(existingBench.inspect).not.toHaveBeenCalled()
    expect(existingBench.resume).not.toHaveBeenCalled()
    expect(existingCoordinator.isReserved(existingSession.id)).toBe(false)
    expect(toolChangeListenerCount(existingContext)).toBe(0)

    const planningContext = new Context()
    contexts.push(planningContext)
    const planningSession = persistedSession('planning-root', 'historic-model')
    let publishDuringPlanning = (): void => {}
    const planningBench = provideSuccessfulResumeServices(
      planningContext,
      async () => inspectionOf(planningSession),
      () => planningSession,
      undefined,
      { onCurrentSelection: () => { publishDuringPlanning() } },
    )
    const planningAgent = liveAgent(planningContext, planningSession)
    publishDuringPlanning = () => {
      planningBench.liveAgents.set(planningAgent.id, planningAgent)
      planningBench.liveSessions.set(planningSession.id, planningSession)
    }
    const planningCoordinator = new DshColdResumeCoordinator(planningContext)
    const planningError = await planningCoordinator.acquireOwned({
      sessionId: planningSession.id,
      signal: new AbortController().signal,
    }).then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(planningError).toBeInstanceOf(DshColdResumeExternalWinnerError)
    expect((planningError as DshColdResumeExternalWinnerError).cause)
      .toMatchObject({ message: 'an exact live Agent/Session was published before resume setup' })
    expect(planningBench.inspect).toHaveBeenCalledOnce()
    expect(planningBench.resume).not.toHaveBeenCalled()
    expect(planningCoordinator.isReserved(planningSession.id)).toBe(false)
    expect(toolChangeListenerCount(planningContext)).toBe(0)
  })

  it('does not classify delegated, non-root, or mismatched occupancies as winners', async () => {
    const delegatedContext = new Context()
    contexts.push(delegatedContext)
    const delegatedId = SessionId('delegated-occupancy')
    const delegatedSession = Session.create(delegatedId, undefined, {
      version: SESSION_FORMAT_VERSION,
      id: delegatedId,
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 1,
    })
    const delegatedBench = provideSuccessfulResumeServices(
      delegatedContext,
      async () => inspectionOf(delegatedSession),
      () => delegatedSession,
    )
    const delegatedAgent = liveAgent(delegatedContext, delegatedSession)
    delegatedBench.liveAgents.set(delegatedAgent.id, delegatedAgent)
    delegatedBench.liveSessions.set(delegatedSession.id, delegatedSession)
    const delegatedCoordinator = new DshColdResumeCoordinator(delegatedContext)
    const delegatedError = await delegatedCoordinator.acquireOwned({
      sessionId: delegatedSession.id,
      signal: new AbortController().signal,
    }).then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(delegatedError).not.toBeInstanceOf(DshColdResumeExternalWinnerError)
    expect(delegatedError).toMatchObject({
      message: 'DSH-TUI cannot resume subagent session "delegated-occupancy"',
    })
    expect(delegatedBench.resume).not.toHaveBeenCalled()

    const nonRootContext = new Context()
    contexts.push(nonRootContext)
    const nonRootSession = persistedSession('non-root-occupancy', 'historic-model')
    const nonRootBench = provideSuccessfulResumeServices(
      nonRootContext,
      async () => inspectionOf(nonRootSession),
      () => nonRootSession,
      undefined,
      { roots: () => [] },
    )
    const nonRootAgent = liveAgent(nonRootContext, nonRootSession)
    nonRootBench.liveAgents.set(nonRootAgent.id, nonRootAgent)
    nonRootBench.liveSessions.set(nonRootSession.id, nonRootSession)
    const nonRootCoordinator = new DshColdResumeCoordinator(nonRootContext)
    const nonRootError = await nonRootCoordinator.acquireOwned({
      sessionId: nonRootSession.id,
      signal: new AbortController().signal,
    }).then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(nonRootError).not.toBeInstanceOf(DshColdResumeExternalWinnerError)
    expect(nonRootError).toMatchObject({
      message: 'DSH cold resume unpublished authority changed for "non-root-occupancy"',
    })
    expect(nonRootBench.resume).toHaveBeenCalledOnce()

    const mismatchContext = new Context()
    contexts.push(mismatchContext)
    const mismatchSession = persistedSession('mismatched-occupancy', 'historic-model')
    const mismatchBench = provideSuccessfulResumeServices(
      mismatchContext,
      async () => inspectionOf(mismatchSession),
      () => mismatchSession,
    )
    const mismatchAgent = liveAgent(mismatchContext, mismatchSession)
    mismatchBench.liveAgents.set(mismatchAgent.id, mismatchAgent)
    mismatchBench.liveSessions.set(
      mismatchSession.id,
      Session.create(mismatchSession.id),
    )
    const mismatchCoordinator = new DshColdResumeCoordinator(mismatchContext)
    const mismatchError = await mismatchCoordinator.acquireOwned({
      sessionId: mismatchSession.id,
      signal: new AbortController().signal,
    }).then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(mismatchError).not.toBeInstanceOf(DshColdResumeExternalWinnerError)
    expect(mismatchError).toMatchObject({
      message: 'DSH cold resume unpublished authority changed for "mismatched-occupancy"',
    })
    expect(mismatchBench.resume).toHaveBeenCalledOnce()
  })

  it('never mistakes its own candidate publication for an external winner', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('self-published', 'historic-model')
    const publishFailure = new Error('official resume rejected after candidate publication')
    const bench = provideSuccessfulResumeServices(
      ctx,
      async () => inspectionOf(session),
      () => session,
      undefined,
      { afterPublish: () => { throw publishFailure } },
    )
    const coordinator = new DshColdResumeCoordinator(ctx)

    await expect(coordinator.acquireOwned({
      sessionId: session.id,
      signal: new AbortController().signal,
    })).rejects.toBe(publishFailure)
    expect(coordinator.isReserved(session.id)).toBe(false)
    expect(bench.liveAgents.get(session.id)?.session).toBe(session)
    expect(bench.liveSessions.get(session.id)).toBe(session)
    bench.liveAgents.delete(session.id)
    bench.liveSessions.delete(session.id)
  })

  it('replans once when the prepared recovery semantics drift before publication', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const inspectedA = persistedSession('cold', 'model-a')
    const preparedB = persistedSession('cold', 'model-b')
    const liveAgents = new Map<string, Agent>()
    const liveSessions = new Map<string, Session>()
    const mounted = new WeakMap<Context, string>()
    const inspect = vi.fn()
      .mockResolvedValueOnce(inspectionOf(inspectedA))
      .mockResolvedValueOnce(inspectionOf(preparedB))
    const mount = vi.fn(async (agentCtx: Context, id: string) => {
      mounted.set(agentCtx, id)
      return {
        id,
        trust: 'system' as const,
        path: `D:\\presets\\${id}\\agent.cordis.yml`,
      }
    })
    const downstreamCommit = vi.fn()
    const downstreamSetup = vi.fn((): AgentSetupCommit => ({
      commit: downstreamCommit,
    }))
    const handles: AgentHandle[] = []
    let resumeCall = 0
    const resume = vi.fn(async (options: ResumeAgentOptions): Promise<AgentHandle> => {
      resumeCall += 1
      const session = preparedB
      const agent = {
        id: session.id,
        options: { ...options.agentOptions },
        session,
        status: 'idle',
        ctx,
        followup: () => {},
        steer: () => {},
        cancel: () => {},
        whenIdle: () => Promise.resolve(),
      } as unknown as Agent
      const agentCtx = ctx.extend({ agent })
      Object.assign(agent, { ctx: agentCtx })
      const commit = await options.setup?.(agentCtx, agent)
      commit?.commit()
      liveSessions.set(session.id, session)
      liveAgents.set(agent.id, agent)
      const handle: AgentHandle = {
        agent,
        dispose: vi.fn(async () => {
          liveAgents.delete(agent.id)
          liveSessions.delete(session.id)
        }),
      }
      handles.push(handle)
      return handle
    })

    ctx.provide('loader', { await: () => Promise.resolve() } as never)
    ctx.provide('tools', { schemas: () => [] } as never)
    ctx.provide('sessionPersistence', {
    open: async (
      id: SessionId,
      _access: 'read' | 'write',
      options?: { signal?: AbortSignal },
    ) => {
      const inspection = await inspect(id, options?.signal)
      return {
        id,
        header: inspection.meta,
        inheritedEventCount: inspection.inheritedEventCount,
        read: async () => ({ eventState: 'detached', events: inspection.events }),
        close: async () => {},
      }
    },
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
      mount,
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
    const handle = await coordinator.acquireOwned({
      sessionId: 'cold',
      signal: new AbortController().signal,
      setup: downstreamSetup,
    })

    expect(inspect).toHaveBeenCalledTimes(2)
    expect(resume).toHaveBeenCalledTimes(2)
    expect(resume.mock.calls.map(([options]) => options.agentOptions)).toEqual([
      { provider: 'persisted-provider', model: 'model-a' },
      { provider: 'persisted-provider', model: 'model-b' },
    ])
    expect(mount).toHaveBeenCalledOnce()
    expect(downstreamSetup).toHaveBeenCalledOnce()
    expect(downstreamCommit).toHaveBeenCalledOnce()
    expect(handles).toHaveLength(1)
    expect(handle.agent.options).toMatchObject({ model: 'model-b' })
    await expect(coordinator.acquireOwned({
      sessionId: 'cold',
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DshColdResumeBusyError)
    expect(resume).toHaveBeenCalledTimes(2)

    await handle.dispose()
    expect(liveAgents).toEqual(new Map())
    expect(liveSessions).toEqual(new Map())
  })

  it('waits for a same-id leader without sharing its owned handle', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('single-flight', 'historic-model')
    const inspectStarted = Promise.withResolvers<void>()
    const releaseInspection = Promise.withResolvers<void>()
    let inspectCall = 0
    const bench = provideSuccessfulResumeServices(
      ctx,
      async () => {
        inspectCall += 1
        if (inspectCall === 1) {
          inspectStarted.resolve()
          await releaseInspection.promise
        }
        return inspectionOf(session)
      },
      () => session,
    )
    const coordinator = new DshColdResumeCoordinator(ctx)
    const leader = coordinator.acquireOwned({
      sessionId: 'single-flight',
      signal: new AbortController().signal,
    })
    await inspectStarted.promise
    const follower = coordinator.acquireOwned({
      sessionId: 'single-flight',
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    expect(bench.inspect).toHaveBeenCalledOnce()
    expect(bench.resume).not.toHaveBeenCalled()

    releaseInspection.resolve()
    const leaderHandle = await leader
    await expect(follower).rejects.toBeInstanceOf(DshColdResumeBusyError)
    expect(bench.inspect).toHaveBeenCalledOnce()
    expect(bench.resume).toHaveBeenCalledOnce()
    expect(bench.handles).toHaveLength(1)

    await leaderHandle.dispose()
    const nextHandle = await coordinator.acquireOwned({
      sessionId: 'single-flight',
      signal: new AbortController().signal,
    })
    expect(nextHandle).not.toBe(leaderHandle)
    expect(bench.resume).toHaveBeenCalledTimes(2)
    expect(bench.handles).toHaveLength(2)
    await nextHandle.dispose()
  })

  it('keeps the same-id ledger closed throughout owned disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('dispose-window', 'historic-model')
    const releaseDispose = Promise.withResolvers<void>()
    const bench = provideSuccessfulResumeServices(
      ctx,
      async () => inspectionOf(session),
      () => session,
      () => releaseDispose.promise,
    )
    const installModel = vi.fn()
    const coordinator = new DshColdResumeCoordinator(
      ctx,
      { install: installModel } as never,
    )
    const first = await coordinator.acquireOwned({
      sessionId: 'dispose-window',
      signal: new AbortController().signal,
    })

    const disposing = first.dispose()
    expect(first.dispose()).toBe(disposing)
    const waiting = coordinator.acquireOwned({
      sessionId: 'dispose-window',
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    expect(bench.inspect).toHaveBeenCalledOnce()
    expect(bench.resume).toHaveBeenCalledOnce()

    releaseDispose.resolve()
    await disposing
    const second = await waiting
    expect(second.agent).not.toBe(first.agent)
    expect(bench.inspect).toHaveBeenCalledTimes(2)
    expect(bench.resume).toHaveBeenCalledTimes(2)
    expect(installModel).toHaveBeenCalledTimes(2)
    expect(bench.handles[0]?.dispose).toHaveBeenCalledOnce()
    await second.dispose()
  })

  it('fails after one bounded retry when recovery semantics keep changing', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const inspectedA = persistedSession('moving', 'model-a')
    const inspectedB = persistedSession('moving', 'model-b')
    const prepared = [
      persistedSession('moving', 'model-b'),
      persistedSession('moving', 'model-c'),
    ]
    const inspections = [inspectedA, inspectedB]
    const inspect = vi.fn(async (_id: SessionId, _signal?: AbortSignal) => {
      const session = inspections.shift()!
      return inspectionOf(session)
    })
    const mount = vi.fn()
    const downstreamSetup = vi.fn()
    let resumeCall = 0
    const resume = vi.fn(async (options: ResumeAgentOptions): Promise<AgentHandle> => {
      const session = prepared[resumeCall++]!
      const agent = {
        id: session.id,
        options: { ...options.agentOptions },
        session,
        status: 'idle',
        ctx,
      } as unknown as Agent
      const agentCtx = ctx.extend({ agent })
      Object.assign(agent, { ctx: agentCtx })
      await options.setup?.(agentCtx, agent)
      throw new Error('setup unexpectedly accepted continuous drift')
    })
    ctx.provide('tools', { schemas: () => [] } as never)
    ctx.provide('sessionPersistence', {
    open: async (
      id: SessionId,
      _access: 'read' | 'write',
      options?: { signal?: AbortSignal },
    ) => {
      const inspection = await inspect(id, options?.signal)
      return {
        id,
        header: inspection.meta,
        inheritedEventCount: inspection.inheritedEventCount,
        read: async () => ({ eventState: 'detached', events: inspection.events }),
        close: async () => {},
      }
    },
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
      mount,
      composedPreset: () => undefined,
    } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('agents', {
      get: () => undefined,
      roots: () => [],
      resume,
    } as never)

    const coordinator = new DshColdResumeCoordinator(ctx)
    await expect(coordinator.acquireOwned({
      sessionId: 'moving',
      signal: new AbortController().signal,
      setup: downstreamSetup,
    })).rejects.toBeInstanceOf(DshColdResumeSemanticDriftError)
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(resume).toHaveBeenCalledTimes(2)
    expect(mount).not.toHaveBeenCalled()
    expect(downstreamSetup).not.toHaveBeenCalled()
  })

  it('rejects missing or mismatched unpublished Agents before publication', async () => {
    const missingAgentContext = new Context()
    contexts.push(missingAgentContext)
    const missingAgentSession = persistedSession('missing-agent', 'historic-model')
    const missingAgentBench = provideSuccessfulResumeServices(
      missingAgentContext,
      async () => inspectionOf(missingAgentSession),
      () => missingAgentSession,
      undefined,
      { omitSetupAgent: true },
    )
    const missingAgentCoordinator = new DshColdResumeCoordinator(missingAgentContext)
    // Harness 0.1.5 dropped `Context.agent`; a resume that never hands the
    // unpublished Agent to setup now fails the coordinator's candidate guard
    // with a TypeError instead of the old typed "did not expose" message.
    await expect(missingAgentCoordinator.acquireOwned({
      sessionId: missingAgentSession.id,
      signal: new AbortController().signal,
    })).rejects.toThrow(TypeError)
    expect(missingAgentBench.mount).not.toHaveBeenCalled()
    expect(missingAgentCoordinator.isReserved(missingAgentSession.id)).toBe(false)

    const wrongIdentityContext = new Context()
    contexts.push(wrongIdentityContext)
    const expected = persistedSession('expected-agent', 'historic-model')
    const wrong = persistedSession('wrong-agent', 'historic-model')
    const wrongIdentityBench = provideSuccessfulResumeServices(
      wrongIdentityContext,
      async () => inspectionOf(expected),
      () => wrong,
    )
    const wrongIdentityCoordinator = new DshColdResumeCoordinator(wrongIdentityContext)
    await expect(wrongIdentityCoordinator.acquireOwned({
      sessionId: expected.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('prepared the wrong Agent/Session')
    expect(wrongIdentityBench.mount).not.toHaveBeenCalled()
    expect(wrongIdentityCoordinator.isReserved(expected.id)).toBe(false)
  })

  it('bounds mounted-source drift and rolls back a different returned Agent with overrides', async () => {
    const mountContext = new Context()
    contexts.push(mountContext)
    const mountSession = persistedSession('mount-drift', 'historic-model')
    const attemptContexts: Context[] = []
    const mountBench = provideSuccessfulResumeServices(
      mountContext,
      async () => inspectionOf(mountSession),
      () => mountSession,
      undefined,
      {
        mountSource: id => ({
          id,
          trust: 'user',
          path: `D:\\changed\\${id}\\agent.cordis.yml`,
        }),
        onAgentContext: agentCtx => { attemptContexts.push(agentCtx) },
      },
    )
    const mountCoordinator = new DshColdResumeCoordinator(mountContext)
    await expect(mountCoordinator.acquireOwned({
      sessionId: mountSession.id,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DshColdResumeSemanticDriftError)
    expect(mountBench.resume).toHaveBeenCalledTimes(2)
    expect(mountBench.mount).toHaveBeenCalledTimes(2)
    expect(mountBench.handles).toEqual([])
    expect(attemptContexts).toHaveLength(2)
    expect(attemptContexts.map(modelSelectionListenerCount)).toEqual([0, 0])

    const returnedContext = new Context()
    contexts.push(returnedContext)
    const returnedSession = persistedSession('returned-agent', 'historic-model')
    const returnedBench = provideSuccessfulResumeServices(
      returnedContext,
      async () => inspectionOf(returnedSession),
      () => returnedSession,
      undefined,
      {
        handleAgent: agent => ({ ...agent }) as Agent,
      },
    )
    const returnedCoordinator = new DshColdResumeCoordinator(returnedContext)
    await expect(returnedCoordinator.acquireOwned({
      sessionId: returnedSession.id,
      signal: new AbortController().signal,
      selection: {
        provider: 'explicit-provider',
        model: 'explicit-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
      maxTokens: 4242,
    })).rejects.toThrow('returned a different Agent')
    expect(returnedBench.resume).toHaveBeenCalledOnce()
    expect(returnedBench.resume.mock.calls[0]?.[0].agentOptions).toEqual({
      provider: 'explicit-provider',
      model: 'explicit-model',
      maxTokens: 4242,
    })
    expect(returnedBench.handles[0]?.dispose).toHaveBeenCalledOnce()
    expect(returnedBench.liveAgents).toEqual(new Map())
    expect(returnedBench.liveSessions).toEqual(new Map())
    expect(returnedCoordinator.isReserved(returnedSession.id)).toBe(false)
  })

  it('detects a replaced exact-flight ledger during unpublished setup', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('replaced-flight', 'historic-model')
    const bench = provideSuccessfulResumeServices(
      ctx,
      async () => inspectionOf(session),
      () => session,
    )
    const coordinator = new DshColdResumeCoordinator(ctx)
    const flights = (coordinator as unknown as {
      readonly flights: Map<string, unknown>
    }).flights
    const replacement = { owner: 'test-sentinel' }

    await expect(coordinator.acquireOwned({
      sessionId: session.id,
      signal: new AbortController().signal,
      setup: () => {
        flights.set(session.id, replacement)
      },
    })).rejects.toThrow('unpublished authority changed')

    expect(flights.get(session.id)).toBe(replacement)
    expect(bench.handles).toEqual([])
    expect(toolChangeListenerCount(ctx)).toBe(0)
    flights.delete(session.id)
  })

  it('rechecks default model and preset fallbacks on both sides of downstream commit', async () => {
    for (const [suffix, changedSelection] of [
      ['missing', undefined],
      ['changed', { provider: 'changed-provider', model: 'changed-model' }],
    ] as const) {
      const ctx = new Context()
      contexts.push(ctx)
      const session = fallbackSession(`default-model-${suffix}`)
      const bench = provideSuccessfulResumeServices(
        ctx,
        async () => inspectionOf(session),
        () => session,
      )
      const coordinator = new DshColdResumeCoordinator(ctx)
      await expect(coordinator.acquireOwned({
        sessionId: session.id,
        signal: new AbortController().signal,
        setup: () => ({
          commit: () => { bench.setCurrentSelection(changedSelection) },
        }),
      })).rejects.toThrow('default model changed before resume publication')
      expect(bench.handles).toEqual([])
      expect(coordinator.isReserved(session.id)).toBe(false)
    }

    const presetContext = new Context()
    contexts.push(presetContext)
    const presetSession = fallbackSession('default-preset-changed')
    const presetBench = provideSuccessfulResumeServices(
      presetContext,
      async () => inspectionOf(presetSession),
      () => presetSession,
    )
    const presetCoordinator = new DshColdResumeCoordinator(presetContext)
    await expect(presetCoordinator.acquireOwned({
      sessionId: presetSession.id,
      signal: new AbortController().signal,
      setup: () => ({
        commit: () => { presetBench.setDefaultPresetId('changed-default') },
      }),
    })).rejects.toThrow('default preset changed before resume publication')
    expect(presetBench.handles).toEqual([])
    expect(presetCoordinator.isReserved(presetSession.id)).toBe(false)
  })

  it('quarantines an exact published survivor when rollback rejects', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('rollback-survivor', 'historic-model')
    const rollbackFailure = new Error('raw rollback rejected')
    const bench = provideSuccessfulResumeServices(
      ctx,
      async () => inspectionOf(session),
      () => session,
      async () => { throw rollbackFailure },
      {
        afterPublish: (agent) => {
          Object.assign(agent.options, { model: 'tampered-after-publication' })
        },
      },
    )
    const coordinator = new DshColdResumeCoordinator(ctx)

    const error = await coordinator.acquireOwned({
      sessionId: 'rollback-survivor',
      signal: new AbortController().signal,
    }).then(
      () => undefined,
      reason => reason as unknown,
    )

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: 'DSH cold resume publication changed for "rollback-survivor"',
      }),
      rollbackFailure,
    ])
    expect(bench.handles[0]?.dispose).toHaveBeenCalledOnce()
    expect(bench.liveAgents.get(session.id)).toBe(bench.handles[0]?.agent)
    expect(bench.liveSessions.get(session.id)).toBe(session)
    expect(coordinator.isReserved(session.id)).toBe(true)
    expect(toolChangeListenerCount(ctx)).toBe(1)

    await expect(coordinator.acquireOwned({
      sessionId: session.id,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DshColdResumeBusyError)
    expect(bench.inspect).toHaveBeenCalledOnce()
    expect(bench.resume).toHaveBeenCalledOnce()
    await expect(coordinator.dispose()).rejects.toThrow('coordinator disposal failed')
    expect(coordinator.isReserved(session.id)).toBe(true)
    expect(toolChangeListenerCount(ctx)).toBe(1)
  })

  it('releases quarantine only when a rejecting rollback removed both exact registry edges', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('rollback-removed', 'historic-model')
    const rollbackFailure = new Error('rollback reported failure after teardown')
    let bench!: ReturnType<typeof provideSuccessfulResumeServices>
    bench = provideSuccessfulResumeServices(
      ctx,
      async () => inspectionOf(session),
      () => session,
      async () => {
        bench.liveAgents.clear()
        bench.liveSessions.clear()
        throw rollbackFailure
      },
      {
        afterPublish: (agent) => {
          Object.assign(agent.options, { model: 'tampered-after-publication' })
        },
      },
    )
    const coordinator = new DshColdResumeCoordinator(ctx)

    const error = await coordinator.acquireOwned({
      sessionId: session.id,
      signal: new AbortController().signal,
    }).then(
      () => undefined,
      reason => reason as unknown,
    )

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[1]).toBe(rollbackFailure)
    expect(coordinator.isReserved(session.id)).toBe(false)
    expect(toolChangeListenerCount(ctx)).toBe(0)
    expect(bench.handles[0]?.dispose).toHaveBeenCalledOnce()
  })

  it('quarantines a resolved-but-incomplete handoff rollback after an outer abort', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('handoff-abort', 'historic-model')
    const requestAbort = new AbortController()
    const abortReason = new Error('abort between publication and handoff')
    let queued = false
    const bench = provideSuccessfulResumeServices(
      ctx,
      async () => inspectionOf(session),
      () => session,
      undefined,
      {
        keepPublishedOnDispose: true,
        onRoots: () => {
          if (queued) return
          queued = true
          queueMicrotask(() => { requestAbort.abort(abortReason) })
        },
      },
    )
    const coordinator = new DshColdResumeCoordinator(ctx)

    const error = await coordinator.acquireOwned({
      sessionId: session.id,
      signal: requestAbort.signal,
    }).then(
      () => undefined,
      reason => reason as unknown,
    )

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).message).toContain(
      'cancelled before handoff and rollback failed',
    )
    expect((error as AggregateError).errors[0]).toBe(abortReason)
    expect((error as AggregateError).errors[1]).toEqual(expect.objectContaining({
      message: 'DSH cold resume disposal left Agent/Session live for "handoff-abort"',
    }))
    expect(bench.handles[0]?.dispose).toHaveBeenCalledOnce()
    expect(coordinator.isReserved(session.id)).toBe(true)
    expect(toolChangeListenerCount(ctx)).toBe(1)
    await expect(coordinator.acquireOwned({
      sessionId: session.id,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DshColdResumeBusyError)
  })

  it('keeps an incomplete owned disposal reserved and lets a waiting follower abort exactly', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('incomplete-dispose', 'historic-model')
    const bench = provideSuccessfulResumeServices(
      ctx,
      async () => inspectionOf(session),
      () => session,
      undefined,
      { keepPublishedOnDispose: true },
    )
    const coordinator = new DshColdResumeCoordinator(ctx)
    const handle = await coordinator.acquireOwned({
      sessionId: session.id,
      signal: new AbortController().signal,
    })

    await expect(handle.dispose()).rejects.toThrow(
      'disposal left Agent/Session live for "incomplete-dispose"',
    )
    expect(coordinator.isReserved(session.id)).toBe(true)
    const followerAbort = new AbortController()
    const followerReason = new Error('stop waiting for incomplete disposal')
    const follower = coordinator.acquireOwned({
      sessionId: session.id,
      signal: followerAbort.signal,
    })
    await Promise.resolve()
    followerAbort.abort(followerReason)
    await expect(follower).rejects.toBe(followerReason)
    expect(bench.inspect).toHaveBeenCalledOnce()
    expect(bench.resume).toHaveBeenCalledOnce()
  })

  it('does not delete a replacement reservation while releasing an old owned handle', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('replacement-release', 'historic-model')
    const bench = provideSuccessfulResumeServices(
      ctx,
      async () => inspectionOf(session),
      () => session,
    )
    const coordinator = new DshColdResumeCoordinator(ctx)
    const handle = await coordinator.acquireOwned({
      sessionId: session.id,
      signal: new AbortController().signal,
    })
    const flights = (coordinator as unknown as {
      readonly flights: Map<string, unknown>
    }).flights
    const replacement = { owner: 'replacement' }
    flights.set(session.id, replacement)

    await handle.dispose()
    expect(bench.liveAgents).toEqual(new Map())
    expect(bench.liveSessions).toEqual(new Map())
    expect(flights.get(session.id)).toBe(replacement)
    expect(toolChangeListenerCount(ctx)).toBe(0)
    flights.delete(session.id)
  })

  it('keeps an aborted flight until a late owned handle is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('late-abort', 'historic-model')
    const liveAgents = new Map<string, Agent>()
    const liveSessions = new Map<string, Session>()
    const mounted = new WeakMap<Context, string>()
    const firstResumeStarted = Promise.withResolvers<void>()
    const lateResult = Promise.withResolvers<AgentHandle>()
    const lateDisposeStarted = Promise.withResolvers<void>()
    const releaseLateDispose = Promise.withResolvers<void>()
    const inspect = vi.fn(async (_id: SessionId, _signal?: AbortSignal) => inspectionOf(session))
    let resumeCall = 0

    function agentFor(options: ResumeAgentOptions): Agent {
      const agent = {
        id: session.id,
        options: { ...options.agentOptions },
        session,
        status: 'idle',
        ctx,
        followup: () => {},
        steer: () => {},
        cancel: () => {},
        whenIdle: () => Promise.resolve(),
      } as unknown as Agent
      const agentCtx = ctx.extend({ agent })
      Object.assign(agent, { ctx: agentCtx })
      return agent
    }

    const resume = vi.fn(async (options: ResumeAgentOptions): Promise<AgentHandle> => {
      resumeCall += 1
      if (resumeCall === 1) {
        firstResumeStarted.resolve()
        return await lateResult.promise
      }
      const agent = agentFor(options)
      const commit = await options.setup?.(agent.ctx, agent)
      commit?.commit()
      liveAgents.set(agent.id, agent)
      liveSessions.set(agent.session.id, agent.session)
      return {
        agent,
        dispose: vi.fn(async () => {
          liveAgents.delete(agent.id)
          liveSessions.delete(agent.session.id)
        }),
      }
    })
    ctx.provide('tools', { schemas: () => [] } as never)
    ctx.provide('sessionPersistence', {
    open: async (
      id: SessionId,
      _access: 'read' | 'write',
      options?: { signal?: AbortSignal },
    ) => {
      const inspection = await inspect(id, options?.signal)
      return {
        id,
        header: inspection.meta,
        inheritedEventCount: inspection.inheritedEventCount,
        read: async () => ({ eventState: 'detached', events: inspection.events }),
        close: async () => {},
      }
    },
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
    const leaderAbort = new AbortController()
    const abortReason = new Error('cancel late resume')
    const leader = coordinator.acquireOwned({
      sessionId: 'late-abort',
      signal: leaderAbort.signal,
    })
    await firstResumeStarted.promise
    const follower = coordinator.acquireOwned({
      sessionId: 'late-abort',
      signal: new AbortController().signal,
    })
    leaderAbort.abort(abortReason)

    const lateAgent = agentFor({
      resumeSessionId: SessionId('late-abort'),
      agentOptions: { provider: 'persisted-provider', model: 'historic-model' },
    })
    liveAgents.set(lateAgent.id, lateAgent)
    liveSessions.set(lateAgent.session.id, lateAgent.session)
    const lateDispose = vi.fn(async () => {
      lateDisposeStarted.resolve()
      await releaseLateDispose.promise
      liveAgents.delete(lateAgent.id)
      liveSessions.delete(lateAgent.session.id)
    })
    lateResult.resolve({ agent: lateAgent, dispose: lateDispose })
    await lateDisposeStarted.promise
    expect(resume).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalledOnce()

    releaseLateDispose.resolve()
    await expect(leader).rejects.toBe(abortReason)
    const followerHandle = await follower
    expect(lateDispose).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledTimes(2)
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(followerHandle.agent).not.toBe(lateAgent)
    await followerHandle.dispose()
  })

  it('aborts and joins an in-flight acquisition during coordinator disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const inspectStarted = Promise.withResolvers<void>()
    const inspect = vi.fn(async (_id: string, signal?: AbortSignal) => {
      inspectStarted.resolve()
      return await new Promise<SessionInspection>((_resolve, reject) => {
        const onAbort = (): void => { reject(signal?.reason) }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    })
    ctx.provide('tools', { schemas: () => [] } as never)
    ctx.provide('sessionPersistence', {
    open: async (
      id: SessionId,
      _access: 'read' | 'write',
      options?: { signal?: AbortSignal },
    ) => {
      const inspection = await inspect(id, options?.signal)
      return {
        id,
        header: inspection.meta,
        inheritedEventCount: inspection.inheritedEventCount,
        read: async () => ({ eventState: 'detached', events: inspection.events }),
        close: async () => {},
      }
    },
  } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'p', model: 'm' }),
    } as never)
    ctx.provide('agentPresets', { defaultId: 'standard' } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('agents', { get: () => undefined } as never)

    const coordinator = new DshColdResumeCoordinator(ctx)
    const acquisition = coordinator.acquireOwned({
      sessionId: 'host-dispose',
      signal: new AbortController().signal,
    })
    await inspectStarted.promise
    const firstDispose = coordinator.dispose()
    expect(coordinator.dispose()).toBe(firstDispose)
    await expect(acquisition).rejects.toThrow('coordinator disposed')
    await expect(firstDispose).resolves.toBeUndefined()
    await expect(coordinator.acquireOwned({
      sessionId: 'after-dispose',
      signal: new AbortController().signal,
    })).rejects.toThrow('coordinator is disposed')
  })

  it('aggregates a non-host acquisition failure observed while disposing', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('dispose-acquisition-error', 'historic-model')
    const inspectStarted = Promise.withResolvers<void>()
    const inspection = Promise.withResolvers<SessionInspection>()
    provideSuccessfulResumeServices(
      ctx,
      async () => {
        inspectStarted.resolve()
        return await inspection.promise
      },
      () => session,
    )
    const coordinator = new DshColdResumeCoordinator(ctx)
    const acquisitionFailure = new Error('inspect ignored host abort then failed')
    const acquisition = coordinator.acquireOwned({
      sessionId: session.id,
      signal: new AbortController().signal,
    })
    await inspectStarted.promise

    const disposal = coordinator.dispose()
    inspection.reject(acquisitionFailure)
    await expect(acquisition).rejects.toBe(acquisitionFailure)
    const error = await disposal.then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([acquisitionFailure])
    expect(coordinator.isReserved(session.id)).toBe(false)
  })

  it('aggregates bootstrap-scope and standalone-scope disposal failures', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const coordinator = new DshColdResumeCoordinator(ctx)
    const primary = new Error('bootstrap failed')
    const bootstrapScopeFailure = new Error('bootstrap scope disposal failed')
    const rollback = vi.fn(async () => {})
    type RollbackProbe = {
      rollbackBootstrapScope(
        error: unknown,
        bootstrap: { rollback(): Promise<void> },
        scope: { dispose(reason?: unknown): Promise<void> },
        message: string,
      ): Promise<never>
      ownedScopes: { dispose(reason?: unknown): Promise<void> }
    }
    const probe = coordinator as unknown as RollbackProbe
    const bootstrapError = await probe.rollbackBootstrapScope(
      primary,
      { rollback },
      { dispose: vi.fn(async () => { throw bootstrapScopeFailure }) },
      'bootstrap rollback failed',
    ).then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(bootstrapError).toBeInstanceOf(AggregateError)
    expect((bootstrapError as AggregateError).errors).toEqual([
      primary,
      bootstrapScopeFailure,
    ])
    expect(rollback).toHaveBeenCalledOnce()

    const standaloneScopeFailure = new Error('standalone scope disposal failed')
    const actualOwnedScopes = probe.ownedScopes
    probe.ownedScopes = {
      dispose: vi.fn(async () => { throw standaloneScopeFailure }),
    }
    const disposalError = await coordinator.dispose().then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(disposalError).toBeInstanceOf(AggregateError)
    expect((disposalError as AggregateError).errors).toEqual([standaloneScopeFailure])

    probe.ownedScopes = actualOwnedScopes
    await actualOwnedScopes.dispose('test cleanup after injected failure')
  })

  it('releases an already-owned handle exactly once during coordinator disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const session = persistedSession('dispose-owned', 'historic-model')
    const bench = provideSuccessfulResumeServices(
      ctx,
      async () => inspectionOf(session),
      () => session,
    )
    const coordinator = new DshColdResumeCoordinator(ctx)
    const handle = await coordinator.acquireOwned({
      sessionId: 'dispose-owned',
      signal: new AbortController().signal,
    })

    await coordinator.dispose()
    expect(bench.handles[0]?.dispose).toHaveBeenCalledOnce()
    expect(coordinator.isReserved('dispose-owned')).toBe(false)
    await handle.dispose()
    expect(bench.handles[0]?.dispose).toHaveBeenCalledOnce()
  })
})
