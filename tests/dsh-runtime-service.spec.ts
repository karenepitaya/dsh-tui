import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DshCommandSession } from '../src/dsh/command-session.ts'
import { DshProviderConnection } from '../src/dsh/provider-connection.ts'
import { provideDshTuiRuntime } from '../src/dsh/runtime-service.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DSH TUI runtime service setup rollback', () => {
  it('releases command setup when the unpublished interaction owner is inconsistent', async () => {
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
        await options.setup?.(agentCtx)
        throw new Error('setup unexpectedly accepted an inconsistent Agent')
      },
    } as never)

    const owner = provideDshTuiRuntime(ctx)
    expect(owner.service.providers).toBeInstanceOf(DshProviderConnection)
    await expect(owner.service.open({
      mode: 'create',
      sessionId: session.id,
    })).rejects.toThrow('interaction owner identity is inconsistent')
    expect(disposeCommands).toHaveBeenCalledOnce()

    await owner.dispose()
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
    ctx.provide('userQuestions', {
      registerProvider: () => () => {},
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
        const commit = await options.setup?.(agentCtx)
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
    const port = await owner.service.open({
      mode: 'create',
      sessionId: 'runtime-service-tools',
    })

    expect(port.toolsSnapshot()).toMatchObject({
      available: true,
      stale: false,
      tools: [{ name: 'read', requiredParameterNames: ['path'] }],
    })
    expect(schemas.mock.calls.some(([scope]) => scope === liveAgent)).toBe(true)

    await port.dispose()
    await owner.dispose()
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
    ctx.provide('userQuestions', {
      registerProvider: () => () => {},
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
        const commit = await options.setup?.(agentCtx)
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
      seed: source.events,
      meta: {
        cwd: 'D:\\fork-workspace',
        parentSession: source.id,
        seedLength: 2,
        agentPreset: 'standard',
      },
      agentOptions: { provider: 'route', model: 'model' },
    })
    await lease.release()
    await owner.dispose()
    await ctx.fiber.dispose()
  })
})
