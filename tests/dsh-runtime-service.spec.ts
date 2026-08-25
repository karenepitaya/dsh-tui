import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DshCommandSession } from '../src/dsh/command-session.ts'
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
    await expect(owner.service.open({
      mode: 'create',
      sessionId: session.id,
    })).rejects.toThrow('interaction owner identity is inconsistent')
    expect(disposeCommands).toHaveBeenCalledOnce()

    await owner.dispose()
    await ctx.fiber.dispose()
  })
})
