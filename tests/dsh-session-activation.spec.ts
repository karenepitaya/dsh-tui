import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type SessionId as OfficialSessionId } from '@deepseek-ai/dsh-session'
import { DshLiveSessionActivation } from '../src/dsh/session-activation.ts'
import {
  DshInteractionHub,
  type DshInteractionOwner,
  type DshInteractionSession,
} from '../src/dsh/interaction-hub.ts'
import type { DshModelSelectionHub } from '../src/dsh/model-selection.ts'
import { createUnavailableSessionModelPort } from '../src/model/port.ts'
import {
  createDshSessionPortComposerFixture,
  type DshSessionPortComposerFixture,
} from './fakes/dsh-session-port-composer.ts'

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
  readonly attach: ReturnType<typeof vi.fn>
  readonly detach: ReturnType<typeof vi.fn>
  setAgent(agent: Agent | undefined): void
  setSession(session: Session | undefined): void
  setRoots(agents: readonly Agent[]): void
  setGlobalTools(names: readonly string[]): void
  setAttachHook(
    hook: ((proceed: () => DshInteractionSession) => DshInteractionSession) | undefined,
  ): void
}

const resources: Array<{
  readonly ctx: Context
  readonly hub: DshInteractionHub
}> = []
const composerFixtures: DshSessionPortComposerFixture[] = []

afterEach(async () => {
  await Promise.all(composerFixtures.splice(0).map(fixture => fixture.dispose()))
  for (const resource of resources.splice(0)) {
    resource.hub.dispose()
    await resource.ctx.fiber.dispose()
  }
})

function sessionComposer(
  ctx: Context,
  hub: DshInteractionHub,
  modelHub?: DshModelSelectionHub,
) {
  const fixture = createDshSessionPortComposerFixture(ctx, hub, modelHub)
  composerFixtures.push(fixture)
  return fixture.composer
}

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
  let attachHook:
    | ((proceed: () => DshInteractionSession) => DshInteractionSession)
    | undefined

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

  ctx.provide('agents', { get: getAgent, roots, resume } as never)
  ctx.provide('sessions', { get: getSession, flush } as never)
  ctx.provide('tools', {
    schemas: () => globalTools.map(name => ({
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: {} },
    })),
  } as never)
  ctx.provide('commands', {
    list: listCommands,
    execute: () => Promise.resolve(undefined),
  } as never)

  const hub = new DshInteractionHub(ctx)
  const originalAttach = hub.attach.bind(hub)
  const originalDetach = hub.detach.bind(hub)
  const attach = vi.fn((owner: DshInteractionOwner): DshInteractionSession => {
    const proceed = (): DshInteractionSession => originalAttach(owner)
    return attachHook === undefined ? proceed() : attachHook(proceed)
  })
  const detach = vi.fn((session: DshInteractionSession): void => { originalDetach(session) })
  hub.attach = attach as typeof hub.attach
  hub.detach = detach as typeof hub.detach
  const activation = new DshLiveSessionActivation(ctx, sessionComposer(ctx, hub))
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
    attach,
    detach,
    setAgent: agent => { currentAgent = agent },
    setSession: next => { currentSession = next },
    setRoots: agents => { currentRoots = agents },
    setGlobalTools: names => { globalTools = [...names] },
    setAttachHook: next => { attachHook = next },
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
    expect(lease.port.delegationSnapshot!()).toMatchObject({
      available: true,
      subagentsAvailable: false,
      subagents: [],
      workflows: [],
    })
    expect(runtimeListenerCount(bench.ctx)).toBe(6)
    expect(toolChangeListenerCount(bench.ctx)).toBe(2)
    expect(lease.port.toolsSnapshot!()).toMatchObject({
      available: true,
      stale: false,
      tools: [],
    })
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
    expect(bench.detach).toHaveBeenCalledOnce()
    expect(changed).not.toHaveBeenCalled()
    expect(runtimeListenerCount(bench.ctx)).toBe(0)
    expect(toolChangeListenerCount(bench.ctx)).toBe(0)
  })

  it('attaches a borrowed live Agent without running unpublished bootstrap', async () => {
    const bench = createBench('activation-no-bootstrap')
    const install = vi.fn(() => {
      throw new Error('live attach must not install model selection')
    })
    const attach = vi.fn(() => createUnavailableSessionModelPort())
    const activation = new DshLiveSessionActivation(
      bench.ctx,
      sessionComposer(bench.ctx, bench.hub, { install, attach } as never),
      { install, attach } as never,
    )

    const lease = await activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })

    expect(install).not.toHaveBeenCalled()
    expect(attach).toHaveBeenCalledExactlyOnceWith(bench.live.agent)
    expect(bench.resume).not.toHaveBeenCalled()
    expect(lease.port.ownsAgentLifecycle).toBe(false)
    await lease.release()
    expect(bench.live.cancel).not.toHaveBeenCalled()
  })

  it('rejects a borrowed activation before publication when global tools leaked', async () => {
    const bench = createBench('activation-global-tool-leak')
    bench.setGlobalTools(['global-shell'])

    await expect(bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })).rejects.toThrow(/global tools.*global-shell/i)

    expect(bench.attach).not.toHaveBeenCalled()
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
    expect(toolChangeListenerCount(bench.ctx)).toBe(2)

    bench.ctx.emit('agent/disposed', { agent: bench.live.agent })
    expect(toolChangeListenerCount(bench.ctx)).toBe(1)

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

    // Activation plus the exact-Agent Tool and Permission adapters each
    // revalidate the registry identity for both leases.
    expect(bench.getAgent).toHaveBeenCalledTimes(8)
    expect(bench.live.followup).not.toHaveBeenCalled()
    expect(replacement.followup).toHaveBeenCalledOnce()
    expect(bench.attach).toHaveBeenCalledTimes(2)
    await second.release()
    expect(bench.detach).toHaveBeenCalledTimes(2)
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
    expect(bench.attach).not.toHaveBeenCalled()
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

    expect(nonRoot.attach).not.toHaveBeenCalled()
    expect(mismatched.attach).not.toHaveBeenCalled()
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
    after.setAttachHook((proceed) => {
      const attached = proceed()
      afterAbort.abort(afterReason)
      return attached
    })
    await expect(after.activation.activateSession({
      intent: 'attach-live',
      sessionId: after.id,
      signal: afterAbort.signal,
    })).rejects.toBe(afterReason)

    expect(after.detach).toHaveBeenCalledOnce()
    expect(after.live.cancel).not.toHaveBeenCalled()
    expect(after.resume).not.toHaveBeenCalled()
    expect(runtimeListenerCount(after.ctx)).toBe(0)
    expect(toolChangeListenerCount(after.ctx)).toBe(0)
  })

  it('rolls back when exact live ownership changes during interaction attachment', async () => {
    for (const transition of ['agent', 'session', 'root'] as const) {
      const bench = createBench(`activation-${transition}-race`)
      bench.setAttachHook((proceed) => {
        const attached = proceed()
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
        return attached
      })

      await expect(bench.activation.activateSession({
        intent: 'attach-live',
        sessionId: bench.id,
        signal: new AbortController().signal,
      })).rejects.toThrow('live ownership changed during activation')

      expect(bench.detach).toHaveBeenCalledOnce()
      expect(bench.live.cancel).not.toHaveBeenCalled()
      expect(bench.resume).not.toHaveBeenCalled()
      expect(runtimeListenerCount(bench.ctx)).toBe(0)
      expect(toolChangeListenerCount(bench.ctx)).toBe(0)
    }
  })

  it('rolls back borrowed runtime resources when interaction attachment fails', async () => {
    const bench = createBench('activation-attach-failure')
    const failure = new Error('provider registration failed')
    bench.setAttachHook(() => { throw failure })

    await expect(bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })).rejects.toBe(failure)

    expect(bench.live.cancel).not.toHaveBeenCalled()
    expect(bench.detach).not.toHaveBeenCalled()
    expect(runtimeListenerCount(bench.ctx)).toBe(0)
    expect(toolChangeListenerCount(bench.ctx)).toBe(0)

    bench.setAttachHook(undefined)
    const retry = await bench.activation.activateSession({
      intent: 'attach-live',
      sessionId: bench.id,
      signal: new AbortController().signal,
    })
    await retry.release()
    expect(bench.detach).toHaveBeenCalledOnce()
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

    expect(bench.attach).not.toHaveBeenCalled()
    expect(runtimeListenerCount(bench.ctx)).toBe(0)
    expect(toolChangeListenerCount(bench.ctx)).toBe(0)
  })

  it('fails before lookup when either official live service is unavailable', async () => {
    const missingAgents = new Context()
    const missingAgentsHub = new DshInteractionHub(missingAgents)
    resources.push({ ctx: missingAgents, hub: missingAgentsHub })
    await expect(new DshLiveSessionActivation(
      missingAgents,
      sessionComposer(missingAgents, missingAgentsHub),
    ).activateSession({
      intent: 'attach-live',
      sessionId: 'missing-agents',
      signal: new AbortController().signal,
    })).rejects.toThrow('Agent service is unavailable')

    const missingSessions = new Context()
    missingSessions.provide('agents', {} as never)
    const missingSessionsHub = new DshInteractionHub(missingSessions)
    resources.push({ ctx: missingSessions, hub: missingSessionsHub })
    await expect(new DshLiveSessionActivation(
      missingSessions,
      sessionComposer(missingSessions, missingSessionsHub),
    ).activateSession({
      intent: 'attach-live',
      sessionId: 'missing-sessions',
      signal: new AbortController().signal,
    })).rejects.toThrow('Session service is unavailable')
  })
})
