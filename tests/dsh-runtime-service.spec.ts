import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DshCommandSession } from '../src/dsh/command-session.ts'
import { DshInteractionSession } from '../src/dsh/interaction-hub.ts'
import { DshProviderConnection } from '../src/dsh/provider-connection.ts'
import { DshSettingsCatalog } from '../src/dsh/settings-catalog.ts'
import { DshPluginInventory } from '../src/dsh/plugin-inventory.ts'
import { DshAgentRuntimePort } from '../src/dsh/runtime-port.ts'
import { snapshotSessionEvents } from '../src/dsh/session-events.ts'
import { provideDshTuiRuntime } from '../src/dsh/runtime-service.ts'
import { DshSessionTools } from '../src/dsh/session-tools.ts'
import {
  DSH_SESSION_COMMANDS,
  DSH_SESSION_TOOLS,
} from '../src/dsh/session-capability-factories.ts'
import {
  SessionCapabilityFactoryRegistry,
  type SessionCapabilityLease,
} from '../src/runtime/session-capability.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import { runtimeSessionScopeOf } from '../src/lifecycle/application-scope-host.ts'
import { SESSION_TOOLS_CAPABILITY } from '../src/runtime/session-capabilities.ts'
import { runtimeSessionCapabilitiesOf } from '../src/runtime/runtime-session.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DSH TUI runtime service setup rollback', () => {
  it('rejects an inconsistent unpublished core before creating capabilities', async () => {
    const ctx = new Context()
    const mounted = new WeakMap<Context, string>()
    const preset = (id: string) => ({
      id,
      trust: 'system' as const,
      path: `D:\\presets\\${id}\\agent.cordis.yml`,
    })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'model' }),
    } as never)
    ctx.provide('agentPresets', {
      defaultId: 'standard',
      resolve: async (id?: string) => preset(id ?? 'standard'),
      mount: async (agentCtx: Context, id?: string) => {
        const resolved = id ?? 'standard'
        mounted.set(agentCtx, resolved)
        return preset(resolved)
      },
      composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
    } as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('sessionQuery', { listSessions: async () => [] } as never)
    ctx.provide('commands', {
      list: () => [],
      execute: () => Promise.resolve(undefined),
    } as never)
    ctx.provide('tools', { schemas: () => [] } as never)

    const session = Session.create(SessionId('runtime-service-session'))
    const disposeCommands = vi.spyOn(DshCommandSession.prototype, 'disposeCommands')
    const disposeSettings = vi.spyOn(DshSettingsCatalog.prototype, 'disposeSettings')
    const disposePluginInventory = vi.spyOn(
      DshPluginInventory.prototype,
      'disposePluginInventory',
    )
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions) => {
        const agent = {
          id: SessionId('different-agent-id'),
          options: {},
          session,
          inbox: {},
          status: 'idle',
          ctx,
          cancel: vi.fn(),
          whenIdle: () => Promise.resolve(),
          runMaintenance: () => Promise.reject(new Error('not used')),
          send: vi.fn(),
          followup: vi.fn(),
          steer: vi.fn(),
          inject: vi.fn(),
        } as unknown as Agent
        const agentCtx = ctx.extend({ agent })
        Object.assign(agent, { ctx: agentCtx })
        await options.setup?.(agentCtx, agent)
        throw new Error('setup unexpectedly accepted an inconsistent Agent')
      },
    } as never)

    const owner = provideDshTuiRuntime(ctx)
    expect(owner.service.providers).toBeInstanceOf(DshProviderConnection)
    expect(owner.service.settings).toBeInstanceOf(DshSettingsCatalog)
    expect(owner.service.pluginInventory).toBeInstanceOf(DshPluginInventory)
    await expect(owner.service.open({
      mode: 'create',
      sessionId: session.id,
    })).rejects.toThrow('interaction owner identity is inconsistent')
    expect(disposeCommands).not.toHaveBeenCalled()

    await owner.dispose()
    expect(disposeSettings).toHaveBeenCalledOnce()
    expect(disposePluginInventory).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('creates the exact-Agent tool catalog only after Agent publication', async () => {
    const ctx = new Context()
    const mounted = new WeakMap<Context, string>()
    const preset = (id: string) => ({
      id,
      trust: 'system' as const,
      path: `D:\\presets\\${id}\\agent.cordis.yml`,
    })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'model' }),
    } as never)
    ctx.provide('agentPresets', {
      defaultId: 'standard',
      resolve: async (id?: string) => preset(id ?? 'standard'),
      mount: async (agentCtx: Context, id?: string) => {
        const resolved = id ?? 'standard'
        mounted.set(agentCtx, resolved)
        return preset(resolved)
      },
      composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
    } as never)
    ctx.provide('sessions', { flush: vi.fn() } as never)
    ctx.provide('sessionQuery', { listSessions: async () => [] } as never)
    ctx.provide('commands', {
      list: () => [],
      execute: () => Promise.resolve(undefined),
    } as never)

    let liveAgent: Agent | undefined
    const schemas = vi.fn((scope?: Agent) => {
      if (scope === undefined) return []
      if (scope !== liveAgent) throw new Error('tools observed unpublished Agent')
      return [{
        name: 'read',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }]
    })
    ctx.provide('tools', { schemas } as never)
    ctx.provide('agents', {
      get: (id: string) => liveAgent?.id === id ? liveAgent : undefined,
      create: async (options: CreateAgentOptions) => {
        const session = Session.create(options.sessionId)
        const agent = {
          id: options.sessionId,
          options: options.agentOptions,
          session,
          inbox: {},
          status: 'idle',
          ctx,
          cancel: vi.fn(),
          whenIdle: () => Promise.resolve(),
          runMaintenance: () => Promise.reject(new Error('not used')),
          send: vi.fn(),
          followup: vi.fn(),
          steer: vi.fn(),
          inject: vi.fn(),
        } as unknown as Agent
        const agentCtx = ctx.extend({ agent })
        Object.assign(agent, { ctx: agentCtx })
        const commit = await options.setup?.(agentCtx, agent)
        commit?.commit()
        liveAgent = agent
        return {
          agent,
          dispose: async () => {
            liveAgent = undefined
            await agentCtx.fiber.dispose()
          },
        }
      },
    } as never)

    const owner = provideDshTuiRuntime(ctx)
    const lease = await owner.service.openSession({
      mode: 'create',
      sessionId: 'runtime-service-tools',
    })

    expect(lease.core.sessionId).toBe('runtime-service-tools')
    expect(runtimeSessionCapabilitiesOf(lease)).toBe(lease.capabilities)
    expect(schemas.mock.calls.every(([scope]) => scope === undefined)).toBe(true)
    const tools = await lease.capabilities.acquire(SESSION_TOOLS_CAPABILITY)
    expect(tools.value.toolsSnapshot()).toMatchObject({
      available: true,
      stale: false,
      tools: [{ name: 'read', requiredParameterNames: ['path'] }],
    })
    expect(schemas.mock.calls.some(([scope]) => scope === liveAgent)).toBe(true)
    const port = await lease.asLegacyPort()
    expect(runtimeSessionCapabilitiesOf(port)).toBe(lease.capabilities)
    expect(port.toolsSnapshot()).toStrictEqual(tools.value.toolsSnapshot())

    await tools.release()
    const releasing = lease.release()
    expect(lease.release()).toBe(releasing)
    await releasing
    await port.dispose()
    await owner.dispose()
    await ctx.fiber.dispose()
  })

  it('binds real opens to the app capability registry and releases the core last', async () => {
    const ctx = new Context()
    const mounted = new WeakMap<Context, string>()
    const preset = (id: string) => ({
      id,
      trust: 'system' as const,
      path: `D:\\presets\\${id}\\agent.cordis.yml`,
    })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'model' }),
    } as never)
    ctx.provide('agentPresets', {
      defaultId: 'standard',
      resolve: async (id?: string) => preset(id ?? 'standard'),
      mount: async (agentCtx: Context, id?: string) => {
        const resolved = id ?? 'standard'
        mounted.set(agentCtx, resolved)
        return preset(resolved)
      },
      composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
    } as never)
    ctx.provide('sessions', { flush: vi.fn() } as never)
    ctx.provide('sessionQuery', { listSessions: async () => [] } as never)
    ctx.provide('commands', {
      list: () => [],
      execute: () => Promise.resolve(undefined),
    } as never)
    ctx.provide('tools', { schemas: () => [] } as never)

    let liveAgent: Agent | undefined
    ctx.provide('agents', {
      get: (id: string) => liveAgent?.id === id ? liveAgent : undefined,
      create: async (options: CreateAgentOptions) => {
        const session = Session.create(options.sessionId)
        const agent = {
          id: options.sessionId,
          options: options.agentOptions,
          session,
          inbox: {},
          status: 'idle',
          ctx,
          cancel: vi.fn(),
          whenIdle: () => Promise.resolve(),
          runMaintenance: () => Promise.reject(new Error('not used')),
          send: vi.fn(),
          followup: vi.fn(),
          steer: vi.fn(),
          inject: vi.fn(),
        } as unknown as Agent
        const agentCtx = ctx.extend({ agent })
        Object.assign(agent, { ctx: agentCtx })
        const commit = await options.setup?.(agentCtx, agent)
        commit?.commit()
        liveAgent = agent
        return {
          agent,
          dispose: async () => {
            liveAgent = undefined
            await agentCtx.fiber.dispose()
          },
        }
      },
    } as never)

    const bind = vi.spyOn(SessionCapabilityFactoryRegistry.prototype, 'bind')
    const scopes = new ScopeManager('shared-kernel-test')
    const owner = provideDshTuiRuntime(ctx, {
      appScope: scopes.app,
      createRuntimeSessionScope: label => scopes.createSession(label),
    })
    const port = await owner.service.open({
      mode: 'create',
      sessionId: 'runtime-service-capabilities',
    })

    expect(bind).toHaveBeenCalledOnce()
    const binding = bind.mock.results[0]!.value as SessionCapabilityLease
    expect(binding.scope.parent).toBe(scopes.app)
    expect(runtimeSessionScopeOf(port)).toBe(binding.scope)
    const [firstCommands, secondCommands, tools] = await Promise.all([
      binding.acquire(DSH_SESSION_COMMANDS),
      binding.acquire(DSH_SESSION_COMMANDS),
      binding.acquire(DSH_SESSION_TOOLS),
    ])
    expect(firstCommands.value).toBe(secondCommands.value)

    const order: string[] = []
    const disposeTools = DshSessionTools.prototype.disposeTools
    vi.spyOn(DshSessionTools.prototype, 'disposeTools').mockImplementation(function (
      this: DshSessionTools,
    ) {
      order.push('tools')
      return disposeTools.call(this)
    })
    const disposeCommands = DshCommandSession.prototype.disposeCommands
    vi.spyOn(DshCommandSession.prototype, 'disposeCommands').mockImplementation(function (
      this: DshCommandSession,
    ) {
      order.push('commands')
      return disposeCommands.call(this)
    })
    const disposeInteractions = DshInteractionSession.prototype.disposeInteractions
    vi.spyOn(DshInteractionSession.prototype, 'disposeInteractions').mockImplementation(function (
      this: DshInteractionSession,
    ) {
      order.push('interaction-core')
      return disposeInteractions.call(this)
    })
    const disposeRuntime = DshAgentRuntimePort.prototype.dispose
    vi.spyOn(DshAgentRuntimePort.prototype, 'dispose').mockImplementation(function (
      this: DshAgentRuntimePort,
    ) {
      order.push('runtime-core')
      return disposeRuntime.call(this)
    })

    await firstCommands.release()
    await secondCommands.release()
    await tools.release()
    await port.dispose()

    expect(order.indexOf('tools')).toBeLessThan(order.indexOf('commands'))
    expect(order.slice(-2)).toEqual(['interaction-core', 'runtime-core'])
    await owner.dispose()
    expect(scopes.app.disposed).toBe(false)
    await scopes.dispose()
    await ctx.fiber.dispose()
  })

  it('routes the fork service through the internal official Agent composer', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const mounted = new WeakMap<Context, string>()
    const preset = (id: string) => ({
      id,
      trust: 'system' as const,
      path: `D:\\presets\\${id}\\agent.cordis.yml`,
    })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'model' }),
    } as never)
    ctx.provide('agentPresets', {
      defaultId: 'standard',
      resolve: async (id?: string) => preset(id ?? 'standard'),
      mount: async (agentCtx: Context, id?: string) => {
        const resolved = id ?? 'standard'
        mounted.set(agentCtx, resolved)
        return preset(resolved)
      },
      composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
    } as never)
    ctx.provide('sessionQuery', { listSessions: async () => [] } as never)
    ctx.provide('commands', {
      list: () => [],
      execute: () => Promise.resolve(undefined),
    } as never)
    ctx.provide('tools', { schemas: () => [] } as never)

    const source = ctx.sessions.create(SessionId('runtime-service-fork-source'), {
      meta: { cwd: 'D:\\fork-workspace' },
    })
    source.append('turn/start', { turn: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const created: CreateAgentOptions[] = []
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions) => {
        created.push(options)
        const session = Session.create(options.sessionId)
        const agent = {
          id: options.sessionId,
          options: options.agentOptions,
          session,
          inbox: {},
          status: 'idle',
          ctx,
          cancel: vi.fn(),
          whenIdle: () => Promise.resolve(),
          runMaintenance: () => Promise.reject(new Error('not used')),
          send: vi.fn(),
          followup: vi.fn(),
          steer: vi.fn(),
          inject: vi.fn(),
        } as unknown as Agent
        const agentCtx = ctx.extend({ agent })
        Object.assign(agent, { ctx: agentCtx })
        const commit = await options.setup?.(agentCtx, agent)
        commit?.commit()
        return {
          agent,
          dispose: () => agentCtx.fiber.dispose(),
        }
      },
    } as never)

    const owner = provideDshTuiRuntime(ctx)
    const lease = await owner.service.fork.forkSession({
      sourceSessionId: source.id,
      signal: new AbortController().signal,
    })

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      seed: snapshotSessionEvents(source),
      meta: {
        cwd: 'D:\\fork-workspace',
        parentSession: source.id,
        isSeeded: true,
        agentPreset: 'standard',
      },
      inheritedEventCount: 2,
      agentOptions: { provider: 'route', model: 'model' },
    })
    await lease.release()
    await owner.dispose()
    await ctx.fiber.dispose()
  })
})
