import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type SessionId as OfficialSessionId } from '@deepseek-ai/dsh-session'
import type { UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'
import { DshLiveSessionActivation } from '../src/dsh/session-activation.ts'
import { DshInteractionHub } from '../src/dsh/interaction-hub.ts'

interface LiveAgent {
  readonly agent: Agent
  readonly followup: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly whenIdle: ReturnType<typeof vi.fn>
}

interface ActivationBench {
  readonly ctx: Context
  readonly hub: DshInteractionHub
  readonly activation: DshLiveSessionActivation
  readonly id: OfficialSessionId
  readonly live: LiveAgent
  readonly getAgent: ReturnType<typeof vi.fn>
  readonly roots: ReturnType<typeof vi.fn>
  readonly resume: ReturnType<typeof vi.fn>
  readonly getSession: ReturnType<typeof vi.fn>
  readonly flush: ReturnType<typeof vi.fn>
  readonly listCommands: ReturnType<typeof vi.fn>
  readonly registerProvider: ReturnType<typeof vi.fn>
  readonly unregisterProvider: () => void
  setAgent(agent: Agent | undefined): void
  setSession(session: Session | undefined): void
  setRoots(agents: readonly Agent[]): void
  setGlobalTools(names: readonly string[]): void
  setRegisterProvider(
    register: (provider: UserQuestionProvider) => () => void,
  ): void
}

const resources: Array<{
  readonly ctx: Context
  readonly hub: DshInteractionHub
}> = []

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.hub.dispose()
    await resource.ctx.fiber.dispose()
  }
})

function createLiveAgent(ctx: Context, session: Session): LiveAgent {
  const followup = vi.fn()
  const cancel = vi.fn()
  const whenIdle = vi.fn(() => Promise.resolve())
  const agent = {
    id: session.id,
    options: {},
    session,
    inbox: {},
    status: 'idle',
    ctx,
    followup,
    steer: vi.fn(),
    cancel,
    whenIdle,
    runMaintenance: () => Promise.reject(new Error('not used')),
    send: () => {},
    inject: () => {},
  } as unknown as Agent
  return { agent, followup, cancel, whenIdle }
}

function createBench(rawId = 'activation-root'): ActivationBench {
  const ctx = new Context()
  const id = SessionId(rawId)
  const session = Session.create(id)
  const live = createLiveAgent(ctx, session)
  let currentAgent: Agent | undefined = live.agent
  let currentSession: Session | undefined = session
  let currentRoots: readonly Agent[] = [live.agent]
  let globalTools: readonly string[] = []
  let register: (provider: UserQuestionProvider) => () => void

  const getAgent = vi.fn((candidate: OfficialSessionId) => (
    candidate === id ? currentAgent : undefined
  ))
  const roots = vi.fn(() => [...currentRoots])
  const resume = vi.fn(() => Promise.reject(new Error('resume must not be called')))
  const getSession = vi.fn((candidate: OfficialSessionId) => (
    candidate === id ? currentSession : undefined
  ))
  const flush = vi.fn(() => Promise.resolve(true))
  const listCommands = vi.fn((agent: Agent) => [{
    name: agent === currentAgent ? 'inspect' : 'stale',
    description: 'Inspect the exact live Agent',
  }])
  const unregisterProvider = vi.fn()
  register = () => () => { unregisterProvider() }
  const registerProvider = vi.fn((provider: UserQuestionProvider) => register(provider))

  ctx.provide('agents', { get: getAgent, roots, resume } as never)
  ctx.provide('sessions', { get: getSession, flush } as never)
  ctx.provide('tools', {
    schemas: () => globalTools.map(name => ({ name })),
  } as never)
  ctx.provide('commands', {
    list: listCommands,
    execute: () => Promise.resolve(undefined),
  } as never)
  ctx.provide('userQuestions', { registerProvider } as never)

  const hub = new DshInteractionHub(ctx)
  const activation = new DshLiveSessionActivation(ctx, hub)
  resources.push({ ctx, hub })
  return {
    ctx,
    hub,
    activation,
    id,
    live,
    getAgent,
    roots,
    resume,
    getSession,
    flush,
    listCommands,
    registerProvider,
    unregisterProvider,
    setAgent: agent => { currentAgent = agent },
    setSession: next => { currentSession = next },
    setRoots: agents => { currentRoots = agents },
    setGlobalTools: names => { globalTools = [...names] },
    setRegisterProvider: next => { register = next },
  }
}

function runtimeListenerCount(ctx: Context): number {
  const labels = new Set([
    'ctx.on("session/event")',
    'ctx.on("agent/status")',
    'ctx.on("agent/disposed")',
  ])
  return ctx.fiber.getEffects().filter(effect => labels.has(effect.label)).length - 1
}

function toolChangeListenerCount(ctx: Context): number {
  return ctx.fiber.getEffects().filter(
    effect => effect.label === 'ctx.on("tools/change")',
  ).length
}

describe('official live-session activation', () => {
  it('refuses to reinterpret an explicit cold-resume intent as a borrowed attach', async () => {
    const bench = createBench('activation-intent')
    await expect(bench.activation.activateSession({
      intent: 'resume-cold',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('live activation cannot satisfy "resume-cold"')
    expect(bench.getAgent).not.toHaveBeenCalled()
    expect(bench.resume).not.toHaveBeenCalled()
  })

  it('composes exact borrowed runtime, interaction, and command ports', async () => {
    const bench = createBench()
    const abort = new AbortController()

    const lease = await bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: abort.signal,
    })

    expect(bench.getAgent).toHaveBeenCalledWith(bench.id)
    expect(bench.roots).toHaveBeenCalledTimes(2)
    expect(bench.getSession).toHaveBeenCalledWith(bench.id)
    expect(bench.resume).not.toHaveBeenCalled()
    expect(lease.port.sessionId).toBe(bench.id)
    expect(lease.port.ownsAgentLifecycle).toBe(false)
    expect(lease.port.listCommands()).toEqual([{
      name: 'inspect',
      description: 'Inspect the exact live Agent',
    }])
    expect(bench.listCommands).toHaveBeenCalledWith(bench.live.agent)

    await lease.port.submit({ text: 'continue' }, 'followup')
    expect(() => lease.port.cancel({ kind: 'parent' })).toThrow(
      'cannot cancel an Agent owned by another Host',
    )
    await lease.port.whenIdle()
    await lease.port.flush()
    expect(bench.live.followup).toHaveBeenCalledOnce()
    expect(bench.live.cancel).not.toHaveBeenCalled()
    expect(bench.live.whenIdle).toHaveBeenCalledOnce()
    expect(bench.flush).toHaveBeenCalledWith(bench.live.agent.session)

    const events = lease.port.events()[Symbol.asyncIterator]()
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'agent/created', sessionId: bench.id },
    })
    const eventWait = events.next()
    const interactions = lease.port.interactions()[Symbol.asyncIterator]()
    await expect(interactions.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'interaction/snapshot', sessionId: bench.id, pending: [] },
    })
    const interactionWait = interactions.next()
    const changed = vi.fn()
    lease.port.onCommandsChanged(changed)
    expect(runtimeListenerCount(bench.ctx)).toBe(3)
    expect(toolChangeListenerCount(bench.ctx)).toBe(1)
    expect(() => { bench.ctx.emit('tools/change') }).not.toThrow()

    const firstRelease = lease.release()
    const secondRelease = lease.release()
    expect(secondRelease).toBe(firstRelease)
    await firstRelease
    await expect(eventWait).resolves.toEqual({ done: true, value: undefined })
    await expect(interactionWait).resolves.toEqual({ done: true, value: undefined })
    bench.ctx.emit('commands/change')

    expect(bench.live.cancel).not.toHaveBeenCalled()
    expect(bench.getAgent.mock.results.at(-1)?.value).toBe(bench.live.agent)
    expect(bench.unregisterProvider).toHaveBeenCalledOnce()
    expect(changed).not.toHaveBeenCalled()
    expect(runtimeListenerCount(bench.ctx)).toBe(0)
    expect(toolChangeListenerCount(bench.ctx)).toBe(0)
  })

  it('rejects a borrowed activation before publication when global tools leaked', async () => {
    const bench = createBench('activation-global-tool-leak')
    bench.setGlobalTools(['global-shell'])

    await expect(bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })).rejects.toThrow(/global tools.*global-shell/i)

    expect(bench.registerProvider).not.toHaveBeenCalled()
    expect(runtimeListenerCount(bench.ctx)).toBe(0)
    expect(toolChangeListenerCount(bench.ctx)).toBe(0)
  })

  it('releases borrowed isolation when the external Agent is disposed', async () => {
    const bench = createBench('activation-agent-disposed')
    const lease = await bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })
    expect(toolChangeListenerCount(bench.ctx)).toBe(1)

    bench.ctx.emit('agent/disposed', { agent: bench.live.agent })
    expect(toolChangeListenerCount(bench.ctx)).toBe(0)

    const firstRelease = lease.release()
    const secondRelease = lease.release()
    expect(secondRelease).toBe(firstRelease)
    await firstRelease
    expect(toolChangeListenerCount(bench.ctx)).toBe(0)
  })

  it('re-resolves the exact registry Agent on every activation', async () => {
    const bench = createBench('activation-replaced')
    const first = await bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })
    await first.release()

    const replacementSession = Session.create(bench.id)
    const replacement = createLiveAgent(bench.ctx, replacementSession)
    bench.setAgent(replacement.agent)
    bench.setSession(replacementSession)
    bench.setRoots([replacement.agent])

    const second = await bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })
    await second.port.submit({ text: 'replacement' }, 'followup')

    expect(bench.getAgent).toHaveBeenCalledTimes(4)
    expect(bench.live.followup).not.toHaveBeenCalled()
    expect(replacement.followup).toHaveBeenCalledOnce()
    expect(bench.registerProvider).toHaveBeenCalledTimes(2)
    await second.release()
    expect(bench.unregisterProvider).toHaveBeenCalledTimes(2)
  })

  it('rejects depth-only delegated sessions even if the runtime registry reports them as roots', async () => {
    const bench = createBench('activation-subagent')
    const base = Session.create(bench.id)
    const session = Session.create(bench.id, [], {
      ...base.header,
      delegationDepth: 1,
    })
    const subagent = createLiveAgent(bench.ctx, session)
    bench.setAgent(subagent.agent)
    bench.setSession(session)
    bench.setRoots([subagent.agent])

    await expect(bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('cannot activate subagent session')

    expect(bench.roots).not.toHaveBeenCalled()
    expect(bench.registerProvider).not.toHaveBeenCalled()
    expect(bench.resume).not.toHaveBeenCalled()
  })

  it('rejects a live non-root Agent and an Agent/Session transition', async () => {
    const nonRoot = createBench('activation-child')
    nonRoot.setRoots([])
    await expect(nonRoot.activation.activateSession({
      intent: 'attach-live',
      sessionId: nonRoot.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('is not a live root Agent')
    expect(nonRoot.getSession).not.toHaveBeenCalled()

    const mismatched = createBench('activation-mismatch')
    mismatched.setSession(Session.create(mismatched.id))
    await expect(mismatched.activation.activateSession({
      intent: 'attach-live',
      sessionId: mismatched.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('Agent/Session identity is transitioning')

    expect(nonRoot.registerProvider).not.toHaveBeenCalled()
    expect(mismatched.registerProvider).not.toHaveBeenCalled()
    expect(nonRoot.resume).not.toHaveBeenCalled()
    expect(mismatched.resume).not.toHaveBeenCalled()
  })

  it('distinguishes live-Session transition from deliberately blocked cold activation', async () => {
    const transitioning = createBench('activation-transition')
    transitioning.setAgent(undefined)
    await expect(transitioning.activation.activateSession({
      intent: 'attach-live',
      sessionId: transitioning.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('live Session exists without a live Agent')

    const cold = createBench('activation-cold')
    cold.setAgent(undefined)
    cold.setSession(undefined)
    await expect(cold.activation.activateSession({
      intent: 'attach-live',
      sessionId: cold.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('cold activation is blocked until model/preset restore')

    expect(transitioning.roots).not.toHaveBeenCalled()
    expect(cold.roots).not.toHaveBeenCalled()
    expect(transitioning.resume).not.toHaveBeenCalled()
    expect(cold.resume).not.toHaveBeenCalled()
  })

  it('honors abort before lookup and after reentrant live assembly', async () => {
    const before = createBench('activation-abort-before')
    const beforeAbort = new AbortController()
    const beforeReason = new Error('cancel before activation')
    beforeAbort.abort(beforeReason)
    await expect(before.activation.activateSession({
      intent: 'attach-live',
      sessionId: before.id,
      signal: beforeAbort.signal,
    })).rejects.toBe(beforeReason)
    expect(before.getAgent).not.toHaveBeenCalled()

    const after = createBench('activation-abort-after')
    const afterAbort = new AbortController()
    const afterReason = new Error('cancel assembled activation')
    after.setRegisterProvider(() => {
      afterAbort.abort(afterReason)
      return () => { after.unregisterProvider() }
    })
    await expect(after.activation.activateSession({
      intent: 'attach-live',
      sessionId: after.id,
      signal: afterAbort.signal,
    })).rejects.toBe(afterReason)

    expect(after.unregisterProvider).toHaveBeenCalledOnce()
    expect(after.live.cancel).not.toHaveBeenCalled()
    expect(after.resume).not.toHaveBeenCalled()
    expect(runtimeListenerCount(after.ctx)).toBe(0)
    expect(toolChangeListenerCount(after.ctx)).toBe(0)
  })

  it('rolls back when exact live ownership changes during interaction attachment', async () => {
    for (const transition of ['agent', 'session', 'root'] as const) {
      const bench = createBench(`activation-${transition}-race`)
      bench.setRegisterProvider(() => {
        if (transition === 'agent') {
          const replacementSession = Session.create(bench.id)
          const replacement = createLiveAgent(bench.ctx, replacementSession)
          bench.setAgent(replacement.agent)
          bench.setSession(replacementSession)
          bench.setRoots([replacement.agent])
        } else if (transition === 'session') {
          bench.setSession(Session.create(bench.id))
        } else {
          bench.setRoots([])
        }
        return () => { bench.unregisterProvider() }
      })

      await expect(bench.activation.activateSession({
        intent: 'attach-live',
        sessionId: bench.id,
        signal: new AbortController().signal,
      })).rejects.toThrow('live ownership changed during activation')

      expect(bench.unregisterProvider).toHaveBeenCalledOnce()
      expect(bench.live.cancel).not.toHaveBeenCalled()
      expect(bench.resume).not.toHaveBeenCalled()
      expect(runtimeListenerCount(bench.ctx)).toBe(0)
      expect(toolChangeListenerCount(bench.ctx)).toBe(0)
    }
  })

  it('rolls back borrowed runtime resources when interaction attachment fails', async () => {
    const bench = createBench('activation-attach-failure')
    const failure = new Error('provider registration failed')
    bench.setRegisterProvider(() => { throw failure })

    await expect(bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })).rejects.toBe(failure)

    expect(bench.live.cancel).not.toHaveBeenCalled()
    expect(bench.unregisterProvider).not.toHaveBeenCalled()
    expect(runtimeListenerCount(bench.ctx)).toBe(0)
    expect(toolChangeListenerCount(bench.ctx)).toBe(0)

    bench.setRegisterProvider(() => () => { bench.unregisterProvider() })
    const retry = await bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })
    await retry.release()
    expect(bench.unregisterProvider).toHaveBeenCalledOnce()
  })

  it('stops borrowed isolation when runtime port construction fails', async () => {
    const bench = createBench('activation-runtime-construction-failure')
    const failure = new Error('runtime listener registration failed')
    bench.ctx.on('internal/listener', (name) => {
      if (name === 'session/event') throw failure
    })

    await expect(bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })).rejects.toBe(failure)

    expect(bench.registerProvider).not.toHaveBeenCalled()
    expect(runtimeListenerCount(bench.ctx)).toBe(0)
    expect(toolChangeListenerCount(bench.ctx)).toBe(0)
  })

  it('fails before lookup when either official live service is unavailable', async () => {
    const missingAgents = new Context()
    const missingAgentsHub = new DshInteractionHub(missingAgents)
    resources.push({ ctx: missingAgents, hub: missingAgentsHub })
    await expect(new DshLiveSessionActivation(missingAgents, missingAgentsHub).activateSession({
      intent: 'attach-live',
      sessionId: 'missing-agents',
      signal: new AbortController().signal,
    })).rejects.toThrow('Agent service is unavailable')

    const missingSessions = new Context()
    missingSessions.provide('agents', {} as never)
    const missingSessionsHub = new DshInteractionHub(missingSessions)
    resources.push({ ctx: missingSessions, hub: missingSessionsHub })
    await expect(new DshLiveSessionActivation(missingSessions, missingSessionsHub).activateSession({
      intent: 'attach-live',
      sessionId: 'missing-sessions',
      signal: new AbortController().signal,
    })).rejects.toThrow('Session service is unavailable')
  })
})
