import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  applicationScopeHost,
  requireApplicationScopeHost,
  runtimeSessionScope,
  runtimeSessionScopeOf,
} from '../src/lifecycle/application-scope-host.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import { SessionCapabilityFactoryRegistry } from '../src/runtime/session-capability.ts'
import type { DshRuntimeEventItem } from '../src/runtime/delivery.ts'
import type { DshRuntimePort } from '../src/runtime/port.ts'
import {
  DIFF_WORKSPACE_CAPABILITY,
  SESSION_AGENT_STATUS_CAPABILITY,
  type SessionAgentStatusPort,
} from '../src/runtime/session-capabilities.ts'
import type { DiffWorkspacePort } from '../src/features/diff/port.ts'
import {
  DshInteractionHub,
  type DshInteractionSession,
} from '../src/dsh/interaction-hub.ts'
import type { DshModelSelectionHub } from '../src/dsh/model-selection.ts'
import type { DshAgentRuntimePort } from '../src/dsh/runtime-port.ts'
import { DshCommandSession } from '../src/dsh/command-session.ts'
import { DshSessionPortComposer } from '../src/dsh/session-port-composer.ts'
import {
  createDshSessionCapabilityFactories,
  DSH_SESSION_AGENT_STATUS,
  DSH_SESSION_COMMANDS,
  DSH_SESSION_JOBS,
  DshSessionCorePort,
} from '../src/dsh/session-capability-factories.ts'

function agent(sessionId = 'capability-session'): Agent {
  return {
    id: sessionId,
    session: { id: sessionId },
  } as unknown as Agent
}

function interaction(sessionId = 'capability-session') {
  const stream = Object.freeze({}) as AsyncIterable<never>
  const port = {
    sessionId,
    interactions: vi.fn(() => stream),
    respond: vi.fn(() => ({ accepted: true as const })),
    disposeInteractions: vi.fn(),
    clearSessionApprovals: vi.fn(() => 2),
  }
  return { port: port as unknown as DshInteractionSession, stream, methods: port }
}

describe('DSH session capability core', () => {
  it('keeps exact Agent identity adapter-private and delegates the attached core', async () => {
    const exactAgent = agent()
    const interactionPort = interaction()
    const core = new DshSessionCorePort(exactAgent, interactionPort.port)
    expect(core.sessionId).toBe('capability-session')
    expect(core.ownsAgentLifecycle).toBe(true)
    expect(core.requireAgent()).toBe(exactAgent)
    expect(core.clearSessionApprovals()).toBe(2)
    expect(interactionPort.methods.clearSessionApprovals).toHaveBeenCalledExactlyOnceWith()
    expect(() => core.events()).toThrow('runtime is not attached')

    const otherRuntime = { sessionId: 'other' } as DshAgentRuntimePort
    expect(() => core.attachRuntime(otherRuntime)).toThrow('identity is inconsistent')

    const eventStream = Object.freeze({}) as AsyncIterable<DshRuntimeEventItem>
    const runtime = {
      sessionId: 'capability-session',
      ownsAgentLifecycle: false,
      events: vi.fn(() => eventStream),
      submit: vi.fn(async () => ({ inputId: 'input-1' })),
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } satisfies DshRuntimePort
    core.attachRuntime(runtime as unknown as DshAgentRuntimePort)
    expect(() => core.attachRuntime(runtime as unknown as DshAgentRuntimePort)).toThrow(
      'already attached',
    )
    expect(core.ownsAgentLifecycle).toBe(false)

    const eventOptions = { afterSeq: 2 }
    expect(core.events(eventOptions)).toBe(eventStream)
    expect(runtime.events).toHaveBeenCalledWith(eventOptions)
    const input = { text: 'hello' }
    await expect(core.submit(input, 'followup')).resolves.toEqual({ inputId: 'input-1' })
    const submitOptions = { signal: new AbortController().signal }
    await expect(core.submit(input, 'steer', submitOptions)).resolves.toEqual({
      inputId: 'input-1',
    })
    expect(runtime.submit).toHaveBeenNthCalledWith(1, input, 'followup')
    expect(runtime.submit).toHaveBeenNthCalledWith(2, input, 'steer', submitOptions)
    const cause = { kind: 'user' as const }
    core.cancel(cause, { keepInbox: true })
    expect(runtime.cancel).toHaveBeenCalledWith(cause, { keepInbox: true })
    await core.whenIdle()
    await core.flush()

    const interactionOptions = { signal: new AbortController().signal }
    expect(core.interactions(interactionOptions)).toBe(interactionPort.stream)
    const response = {
      id: 'question:1',
      kind: 'question' as const,
      outcome: { kind: 'cancelled' as const },
    }
    expect(core.respond(response)).toEqual({ accepted: true })
    core.disposeInteractions()
    expect(interactionPort.methods.disposeInteractions).toHaveBeenCalledOnce()
    interactionPort.methods.disposeInteractions.mockClear()

    const firstDispose = core.dispose()
    expect(core.dispose()).toBe(firstDispose)
    await firstDispose
    expect(interactionPort.methods.disposeInteractions).toHaveBeenCalledOnce()
    expect(runtime.dispose).toHaveBeenCalledOnce()
    expect(() => core.requireAgent()).toThrow('no longer active')
  })

  it('aggregates both core cleanup failures and supports disposal before runtime attach', async () => {
    const detachedInteraction = interaction('detached')
    const detached = new DshSessionCorePort(agent('detached'), detachedInteraction.port)
    await expect(detached.dispose()).resolves.toBeUndefined()

    const interactionFailure = new Error('interaction failed')
    const runtimeFailure = new Error('runtime failed')
    const brokenInteraction = interaction('broken')
    brokenInteraction.methods.disposeInteractions.mockImplementation(() => {
      throw interactionFailure
    })
    const broken = new DshSessionCorePort(agent('broken'), brokenInteraction.port)
    broken.attachRuntime({
      sessionId: 'broken',
      ownsAgentLifecycle: true,
      dispose: vi.fn(async () => { throw runtimeFailure }),
    } as unknown as DshAgentRuntimePort)

    await expect(broken.dispose()).rejects.toMatchObject({
      errors: [interactionFailure, runtimeFailure],
      message: 'DSH session core disposal failed',
    })
  })
})

describe('DSH session capability provider set', () => {
  it('aggregates optional-fiber and baseline registration disposal failures', async () => {
    const fiberFailure = new Error('optional fiber disposal failed')
    const registrationFailure = new Error('baseline registration disposal failed')
    const callbacks: Array<(ctx: Context) => void | (() => Promise<void>)> = []
    let fiberIndex = 0
    const ctx = {
      inject: vi.fn((_requirements, activate) => {
        callbacks.push(activate)
        const index = fiberIndex
        fiberIndex += 1
        return Object.assign(Promise.resolve(), {
          dispose: vi.fn(async () => {
            if (index === 0) throw fiberFailure
          }),
        })
      }),
    } as unknown as Context
    let registrationIndex = 0
    const registry = {
      register: vi.fn((entry) => {
        const index = registrationIndex
        registrationIndex += 1
        return {
          tokenId: entry.token.id,
          active: true,
          release: vi.fn(async () => {
            if (index === 0) throw registrationFailure
          }),
        }
      }),
    } as unknown as SessionCapabilityFactoryRegistry<DshSessionCorePort>
    const providers = createDshSessionCapabilityFactories(
      ctx,
      { attach: vi.fn() } as unknown as DshModelSelectionHub,
    )
    const registration = providers.register(registry)
    await registration.ready

    expect(callbacks).toHaveLength(2)
    expect(registration.active).toBe(true)
    const disposing = registration.dispose()
    expect(registration.dispose()).toBe(disposing)
    await expect(disposing).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'DSH session capability factory registration disposal failed',
      errors: [
        fiberFailure,
        expect.objectContaining({
          name: 'AggregateError',
          message: 'DSH session capability factory group disposal failed',
          errors: [registrationFailure],
        }),
      ],
    })
    expect(registration.active).toBe(false)
  })

  it('rolls back partial factory registration without masking the primary error', async () => {
    const primary = new Error('second factory registration failed')
    const rollbackFailure = new Error('partial registration rollback failed')
    const release = vi.fn(async () => { throw rollbackFailure })
    let calls = 0
    const registry = {
      register: vi.fn((entry) => {
        calls += 1
        if (calls === 2) throw primary
        return { tokenId: entry.token.id, active: true, release }
      }),
    } as unknown as SessionCapabilityFactoryRegistry<DshSessionCorePort>
    const ctx = {
      inject: vi.fn(() => Object.assign(Promise.resolve(), {
        dispose: vi.fn(async () => {}),
      })),
    } as unknown as Context
    const providers = createDshSessionCapabilityFactories(
      ctx,
      { attach: vi.fn() } as unknown as DshModelSelectionHub,
    )

    expect(() => providers.register(registry)).toThrow(primary)
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  })

  it('keeps optional injections generation-safe and ignores activation after owner disposal', async () => {
    const callbacks: Array<(ctx: Context) => void | (() => Promise<void>)> = []
    const fibers: Array<Promise<void> & { dispose(): Promise<void> }> = []
    const ctx = {
      inject: vi.fn((_requirements, activate) => {
        callbacks.push(activate)
        const fiber = Object.assign(Promise.resolve(), {
          dispose: vi.fn(async () => {}),
        })
        fibers.push(fiber)
        return fiber
      }),
    } as unknown as Context
    const releases: Array<ReturnType<typeof vi.fn>> = []
    const registry = {
      register: vi.fn((entry) => {
        const release = vi.fn(async () => {})
        releases.push(release)
        return { tokenId: entry.token.id, active: true, release }
      }),
    } as unknown as SessionCapabilityFactoryRegistry<DshSessionCorePort>
    const providers = createDshSessionCapabilityFactories(
      ctx,
      { attach: vi.fn() } as unknown as DshModelSelectionHub,
    )
    const registration = providers.register(registry)
    await registration.ready

    const firstCleanup = callbacks[0]?.(ctx)
    const duplicateCleanup = callbacks[0]?.(ctx)
    expect(firstCleanup).toEqual(expect.any(Function))
    expect(duplicateCleanup).toEqual(expect.any(Function))
    await (firstCleanup as () => Promise<void>)()
    await (duplicateCleanup as () => Promise<void>)()

    await registration.dispose()
    expect(registration.active).toBe(false)
    expect(callbacks[1]?.(ctx)).toBeUndefined()
    expect(fibers.every(fiber => vi.mocked(fiber.dispose).mock.calls.length === 1)).toBe(true)
    expect(releases.every(release => release.mock.calls.length === 1)).toBe(true)
  })

  it('projects exact-Agent status and owns observers with the capability lease', async () => {
    const ctx = new Context()
    const exactAgent = Object.assign(agent('status-factory'), { status: 'idle' as 'idle' | 'running' })
    const otherAgent = Object.assign(agent('other-status'), { status: 'idle' as 'idle' | 'running' })
    const providers = createDshSessionCapabilityFactories(
      ctx,
      { attach: vi.fn() } as unknown as DshModelSelectionHub,
    )
    const statusFactory = providers.factories.find(
      entry => entry.token.id === SESSION_AGENT_STATUS_CAPABILITY.id,
    )
    expect(statusFactory?.token).toBe(DSH_SESSION_AGENT_STATUS)

    const core = new DshSessionCorePort(exactAgent, interaction('status-factory').port)
    const scopes = new ScopeManager('status-factory-test')
    const lease = await statusFactory!.create({
      core,
      scope: scopes.createSession('status-factory'),
    })
    const status = lease.value as SessionAgentStatusPort
    expect(status.snapshot()).toEqual({ status: 'idle' })
    const changed = vi.fn()
    const stop = status.onChanged(changed)
    ctx.emit('agent/status', { agent: otherAgent, status: 'running' })
    expect(changed).not.toHaveBeenCalled()

    exactAgent.status = 'running'
    ctx.emit('agent/status', { agent: exactAgent, status: 'running' })
    expect(changed).toHaveBeenCalledOnce()
    expect(status.snapshot()).toEqual({ status: 'running' })
    stop()
    stop()
    exactAgent.status = 'idle'
    ctx.emit('agent/status', { agent: exactAgent, status: 'idle' })
    expect(changed).toHaveBeenCalledOnce()

    const afterRelease = vi.fn()
    status.onChanged(afterRelease)
    await lease.release()
    ctx.emit('agent/status', { agent: exactAgent, status: 'running' })
    expect(afterRelease).not.toHaveBeenCalled()
    expect(() => status.snapshot()).toThrow('no longer active')

    await core.dispose()
    await scopes.dispose()
    await ctx.fiber.dispose()
  })

  it('constructs the Diff adapter lazily and stops it with its capability lease', async () => {
    const ctx = new Context()
    const providers = createDshSessionCapabilityFactories(
      ctx,
      { attach: vi.fn() } as unknown as DshModelSelectionHub,
    )
    const diffFactory = providers.factories.find(
      entry => entry.token.id === DIFF_WORKSPACE_CAPABILITY.id,
    )
    expect(diffFactory?.token).toBe(DIFF_WORKSPACE_CAPABILITY)

    const attached = interaction('diff-factory')
    const core = new DshSessionCorePort(agent('diff-factory'), attached.port)
    const events = vi.fn((options = {}) => (async function* () {
      options.onCaughtUp?.({ lastSeq: -1, status: 'idle' })
    })())
    const runtime = {
      sessionId: 'diff-factory',
      ownsAgentLifecycle: false,
      events,
      submit: vi.fn(async () => ({ inputId: 'unused' })),
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } satisfies DshRuntimePort
    core.attachRuntime(runtime)
    const scopes = new ScopeManager('diff-factory-test')
    const lease = await diffFactory!.create({
      core,
      scope: scopes.createSession('diff-factory'),
    })
    const workspace = lease.value as DiffWorkspacePort
    expect(events).not.toHaveBeenCalled()

    await expect(workspace.describeCurrent({
      signal: new AbortController().signal,
    })).resolves.toBeNull()
    expect(events).toHaveBeenCalledOnce()
    await lease.release()
    await expect(workspace.describeCurrent({
      signal: new AbortController().signal,
    })).rejects.toThrow('disposed')

    await core.dispose()
    await scopes.dispose()
    await ctx.fiber.dispose()
  })

  it('contributes optional factories only while their Cordis service is available', async () => {
    const ctx = new Context()
    ctx.provide('commands', {
      list: () => [],
      execute: () => Promise.resolve(undefined),
    } as never)
    const scopes = new ScopeManager('dynamic-optional-factory-test')
    const registry = new SessionCapabilityFactoryRegistry<DshSessionCorePort>(scopes.app)
    const providers = createDshSessionCapabilityFactories(
      ctx,
      { attach: vi.fn() } as unknown as DshModelSelectionHub,
    )
    const registration = providers.register(registry)
    await registration.ready

    expect(registry.size).toBe(9)
    const exactAgent = Object.assign(agent('dynamic-optional'), { ctx })
    const core = new DshSessionCorePort(exactAgent, interaction('dynamic-optional').port)
    const binding = registry.bind(
      core,
      scopes.createSession('dynamic-optional'),
    )
    await expect(binding.acquire(DSH_SESSION_JOBS)).rejects.toMatchObject({
      code: 'unregistered-token',
    })

    const jobs = {
      attachController: vi.fn(() => () => {}),
      onJobsChanged: vi.fn(() => () => {}),
      list: vi.fn(() => []),
    }
    const jobsRow = ctx.plugin({
      name: 'test-optional-jobs',
      provide: 'jobs',
      apply(serviceCtx: Context) {
        serviceCtx.provide('jobs', jobs as never)
      },
    })
    await jobsRow
    await vi.waitFor(() => expect(registry.size).toBe(10))

    const jobLease = await binding.acquire(DSH_SESSION_JOBS)
    expect(jobLease.value.jobsSnapshot()).toMatchObject({
      available: true,
      jobs: [],
    })
    const invalidated = Promise.resolve(jobLease.invalidated)
    await jobsRow.dispose()
    await invalidated
    expect(() => jobLease.value).toThrow('no longer available')
    await expect(binding.acquire(DSH_SESSION_JOBS)).rejects.toMatchObject({
      code: 'capability-unavailable',
    })
    expect(registry.size).toBe(9)

    const projectionsRow = ctx.plugin({
      name: 'test-optional-session-projections',
      provide: 'sessionProjections',
      apply(serviceCtx: Context) {
        serviceCtx.provide('sessionProjections', {} as never)
      },
    })
    await projectionsRow
    await vi.waitFor(() => expect(registry.size).toBe(11))
    await projectionsRow.dispose()
    expect(registry.size).toBe(9)

    await registration.dispose()
    await binding.release()
    await registry.dispose()
    await scopes.dispose()
    await ctx.fiber.dispose()
  })

  it('is immutable, creates one owned command value, and rejects a disposed core identity', async () => {
    const ctx = new Context()
    ctx.provide('commands', {
      list: () => [],
      execute: () => Promise.resolve(undefined),
    } as never)
    const attached = interaction()
    const core = new DshSessionCorePort(agent(), attached.port)
    const providers = createDshSessionCapabilityFactories(
      ctx,
      { attach: vi.fn() } as unknown as DshModelSelectionHub,
    )
    expect(Object.isFrozen(providers)).toBe(true)
    expect(Object.isFrozen(providers.factories)).toBe(true)
    expect(providers.factories).toHaveLength(12)
    expect(providers.factories[0]?.token).toBe(DSH_SESSION_COMMANDS)

    const scopes = new ScopeManager('factory-test')
    const disposeCommands = vi.spyOn(DshCommandSession.prototype, 'disposeCommands')
    const commandLease = await providers.factories[0]!.create({
      core,
      scope: scopes.createSession('command'),
    })
    // The provider lease itself is idempotent; the session registry remains
    // the only caller in production.
    await commandLease.release()
    await commandLease.release()
    expect(disposeCommands).toHaveBeenCalledOnce()

    await core.dispose()
    expect(() => providers.factories[0]!.create({
      core,
      scope: scopes.createSession('disposed-core'),
    })).toThrow('no longer active')
    await scopes.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps the core session usable when an optional factory throws', async () => {
    const ctx = new Context()
    ctx.provide('userQuestions', {
      registerProvider: () => () => {},
    } as never)
    const interactionHub = new DshInteractionHub(ctx)
    const scopes = new ScopeManager('optional-failure-test')
    const registry = new SessionCapabilityFactoryRegistry<DshSessionCorePort>(scopes.app)
    const rawFailure = new Error('optional commands failed')
    const createCommands = vi.fn(() => { throw rawFailure })
    registry.register({
      token: DSH_SESSION_COMMANDS,
      create: createCommands,
    }, { ownerId: 'test.optional-failure', generation: 1 })
    const composer = new DshSessionPortComposer(
      interactionHub,
      {
        appScope: scopes.app,
        createRuntimeSessionScope: label => scopes.createSession(label),
      },
      registry,
    )
    const exactAgent = agent('optional-failure')
    const prepared = await composer.prepare(
      exactAgent,
      composer.createSessionScope('optional-failure'),
    )
    expect(createCommands).not.toHaveBeenCalled()
    const eventStream = Object.freeze({}) as AsyncIterable<DshRuntimeEventItem>
    const runtime = {
      sessionId: exactAgent.session.id,
      ownsAgentLifecycle: false,
      events: vi.fn(() => eventStream),
      submit: vi.fn(async () => ({ inputId: 'input-1' })),
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } satisfies DshRuntimePort

    const session = await composer.completeSession(prepared, runtime)
    expect(createCommands).not.toHaveBeenCalled()
    expect(session.core.sessionId).toBe('optional-failure')
    const port = await session.asLegacyPort()
    expect(createCommands).toHaveBeenCalledOnce()
    expect(port.listCommands()).toEqual([])
    expect(port.sessionId).toBe('optional-failure')
    const releasing = session.release()
    expect(session.release()).toBe(releasing)
    await releasing
    await port.dispose()
    expect(runtime.dispose).toHaveBeenCalledOnce()

    await registry.dispose()
    interactionHub.dispose()
    await scopes.dispose()
    await ctx.fiber.dispose()
  })
})

describe('internal application scope seam', () => {
  it('resolves the kernel host and exposes only an optional session-scope carrier', async () => {
    const scopes = new ScopeManager('host-test')
    const host = {
      appScope: scopes.app,
      createRuntimeSessionScope: (label: string) => scopes.createSession(label),
    }
    const provider = { [applicationScopeHost]: () => host }
    expect(requireApplicationScopeHost(provider)).toBe(host)
    expect(() => requireApplicationScopeHost(undefined)).toThrow(
      'does not expose its application scope host',
    )
    const sessionScope = scopes.createSession('visible')
    expect(runtimeSessionScopeOf({ [runtimeSessionScope]: sessionScope })).toBe(sessionScope)
    expect(runtimeSessionScopeOf(undefined)).toBeUndefined()
    await scopes.dispose()
  })
})
