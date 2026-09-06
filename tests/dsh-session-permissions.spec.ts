import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DshSessionPermissions } from '../src/dsh/session-permissions.ts'
import type { PermissionConfirmation } from '../src/permission/port.ts'

const identitySchema = {
  parse<T>(value: T): T {
    return structuredClone(value)
  },
}

const contexts: Context[] = []

function confirmation(port: DshSessionPermissions): { readonly confirmation: PermissionConfirmation } {
  const snapshot = port.permissionSnapshot()
  return { confirmation: {
    fromValue: snapshot.currentValue!, toValue: 'danger-full-access', generation: snapshot.generation,
  } }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function registerPermissionProjection(ctx: Context): void {
  ctx.sessionProjections.register({
    key: 'permissions',
    stateSchema: identitySchema,
    init: () => 'workspace-write',
    apply: (state: string, event: SessionEvent): string => (
      event.type === 'session/title' ? event.data.title : state
    ),
    wire: {
      viewSchema: identitySchema,
      view: (currentValue: string) => ({
        options: [
          {
            value: 'workspace-write',
            name: 'Workspace write',
            description: 'Write in the workspace and ask before wider access.',
          },
          {
            value: 'danger-full-access',
            name: 'Full access',
            description: 'Full file access without approval prompts.',
          },
          {
            value: 'review-only',
            name: 'Review only',
          },
          ...(currentValue === 'custom'
            ? [{
                value: 'custom',
                name: 'Custom',
                description: 'Current settings do not match a preset.',
              }]
            : []),
        ],
        currentValue,
      }),
    },
    stateVersion: 0,
  } as never)
}

async function harness(options: {
  readonly permissionCommand?: boolean
  readonly projection?: boolean
  readonly registry?: boolean
} = {}): Promise<{
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly execute: ReturnType<typeof vi.fn>
  readonly setLiveAgent: (agent: Agent | undefined) => void
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  if (options.registry !== false) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  if (options.projection !== false && options.registry !== false) registerPermissionProjection(ctx)
  const session = ctx.sessions.create(SessionId('permission-session'))
  const agent = {
    id: session.id,
    session,
    ctx: new Context(),
    status: 'idle',
  } as unknown as Agent
  contexts.push(agent.ctx)
  let liveAgent: Agent | undefined = agent
  ctx.provide('agents', { get: () => liveAgent } as never)
  const specs: Record<string, { sandbox: string; approval: string }> = {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    'review-only': { sandbox: 'read-only', approval: 'never' },
  }
  let selected = 'workspace-write'
  ctx.provide('sandboxPolicy' as never, { resolve: () => ({ mode: specs[selected]!.sandbox }) } as never)
  ctx.provide('approval' as never, {
    overrideOf: () => specs[selected]!.approval,
    config: { policy: 'ask' },
  } as never)
  ctx.provide('permissionPresets' as never, { resolve: (value: string) => specs[value] } as never)
  const execute = vi.fn(({ agent: scope, rawInput }: {
    readonly agent: Agent
    readonly rawInput: string
  }) => {
    expect(scope).toBe(agent)
    const value = rawInput.trim()
    if (value !== 'workspace-write' && value !== 'danger-full-access' && value !== 'review-only') {
      return { kind: 'error' as const, text: `unknown preset ${value}` }
    }
    selected = value
    scope.session.append('session/title', {
      title: value,
      messageSeqs: [],
      source: { kind: 'user' },
    })
    return { kind: 'success' as const, text: `preset ${value}` }
  })
  if (options.permissionCommand !== false) {
    ctx.commands.register({
      name: 'permission',
      description: 'Switch permission preset',
      input: { hint: '<preset>' },
      handler: execute,
    })
  }
  return {
    ctx,
    session,
    agent,
    execute,
    setLiveAgent: value => { liveAgent = value },
  }
}

describe('DSH exact-Agent permission adapter', () => {
  it('attaches a late projection registry and avoids duplicate subscriptions during injection', async () => {
    const late = await harness({ registry: false })
    const waiting = new DshSessionPermissions(late.ctx, late.agent)
    expect(waiting.permissionSnapshot().available).toBe(false)
    await late.ctx.plugin(SessionProjectionRegistry)
    registerPermissionProjection(late.ctx)
    late.ctx.emit('commands/change')
    await vi.waitFor(() => { expect(waiting.permissionSnapshot().available).toBe(true) })
    waiting.disposePermissions()

    const active = await harness()
    const registry = active.ctx.get('sessionProjections')!
    const get = active.ctx.get.bind(active.ctx)
    vi.spyOn(active.ctx, 'get').mockImplementation(((name: string) => (
      name === 'sessionProjections' ? registry : get(name as never)
    )) as never)
    const subscribe = vi.spyOn(registry, 'onChanged')
    vi.spyOn(active.ctx, 'inject').mockImplementation((_names, callback) => {
      const release = (callback as (ctx: Context) => () => void)({ sessionProjections: registry } as Context)
      return { dispose: async () => { release() } } as never
    })
    const port = new DshSessionPermissions(active.ctx, active.agent)
    expect(subscribe).toHaveBeenCalledTimes(1)
    port.disposePermissions()
  })

  it('allows a known narrowing and rejects stale or mismatched widening confirmations', async () => {
    const { ctx, agent, execute } = await harness()
    const port = new DshSessionPermissions(ctx, agent)
    const proof = confirmation(port).confirmation
    for (const invalid of [
      { ...proof, fromValue: 'other' },
      { ...proof, toValue: 'other' },
      { ...proof, generation: proof.generation + 1 },
    ]) {
      await expect(port.selectPermission('danger-full-access', { confirmation: invalid }))
        .rejects.toThrow('confirmation is stale')
    }
    expect(execute).not.toHaveBeenCalled()
    await port.selectPermission('review-only')
    expect(port.permissionSnapshot().currentPermission).toEqual({ sandboxMode: 'read-only', approvalPolicy: 'never' })
    await expect(port.selectPermission('workspace-write')).rejects.toThrow('explicit confirmation')
    const signal = new AbortController()
    signal.abort()
    await expect(port.selectPermission('danger-full-access', { ...confirmation(port), signal: signal.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fails closed when official metadata disappears or changes before the write', async () => {
    const { ctx, agent, execute } = await harness()
    const port = new DshSessionPermissions(ctx, agent)
    const get = ctx.get.bind(ctx)
    const lookup = vi.spyOn(ctx, 'get').mockImplementation(((name: string) => name === 'sandboxPolicy'
      ? { resolve: () => ({ mode: 'read-only' }) }
      : get(name as never)) as never)
    await expect(port.selectPermission('danger-full-access', confirmation(port))).rejects.toThrow('policy changed')
    expect(execute).not.toHaveBeenCalled()
    lookup.mockImplementation(((name: string) => name === 'sandboxPolicy' ? undefined : get(name as never)) as never)
    ctx.emit('commands/change')
    await expect(port.selectPermission('danger-full-access', confirmation(port))).rejects.toThrow('metadata is unavailable')
    lookup.mockImplementation(((name: string) => name === 'permissionPresets' ? undefined : get(name as never)) as never)
    ctx.emit('commands/change')
    await expect(port.selectPermission('danger-full-access', confirmation(port))).rejects.toThrow('metadata is unavailable')
    lookup.mockRestore()
    ctx.emit('commands/change')
    vi.spyOn(ctx, 'get').mockImplementation(((name: string) => name === 'permissionPresets'
      ? { resolve: () => ({ sandbox: 'read-only', approval: 'never' }) }
      : get(name as never)) as never)
    await expect(port.selectPermission('danger-full-access', confirmation(port))).rejects.toThrow('policy changed')
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses an unconfirmed permission widening before the official command', async () => {
    const { ctx, agent, execute } = await harness()
    const port = new DshSessionPermissions(ctx, agent)
    await expect(port.selectPermission('danger-full-access')).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('projects detached options and marks official custom as current-only', async () => {
    const { ctx, agent, session } = await harness()
    const port = new DshSessionPermissions(ctx, agent)

    const initial = port.permissionSnapshot()
    expect(initial).toMatchObject({
      available: true,
      writable: true,
      stale: false,
      generation: 0,
      selecting: false,
      currentValue: 'workspace-write',
      currentPermission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
      options: [
        {
          value: 'workspace-write',
          name: 'Workspace write',
          description: 'Write in the workspace and ask before wider access.',
          selectable: true,
          permission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
        },
        {
          value: 'danger-full-access',
          name: 'Full access',
          description: 'Full file access without approval prompts.',
          selectable: true,
          permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
        },
        {
          value: 'review-only',
          name: 'Review only',
          selectable: true,
          permission: { sandboxMode: 'read-only', approvalPolicy: 'never' },
        },
      ],
    })
    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(initial.options)).toBe(true)
    expect(Object.isFrozen(initial.options[0])).toBe(true)

    session.append('session/title', {
      title: 'custom',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    expect(port.permissionSnapshot()).toMatchObject({
      currentValue: 'custom',
      options: [
        { value: 'workspace-write', selectable: true },
        { value: 'danger-full-access', selectable: true },
        { value: 'review-only', selectable: true },
        { value: 'custom', selectable: false },
      ],
    })
  })

  it('executes the exact official command and publishes selection transitions', async () => {
    const { ctx, agent, execute } = await harness()
    const port = new DshSessionPermissions(ctx, agent)
    const listener = vi.fn()
    port.onPermissionsChanged(listener)

    const controller = new AbortController()
    await port.selectPermission('danger-full-access', { signal: controller.signal, ...confirmation(port) })

    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agent,
      rawInput: ' danger-full-access',
      signal: controller.signal,
    }))
    expect(port.permissionSnapshot()).toMatchObject({
      currentValue: 'danger-full-access',
      selecting: false,
    })
    expect(listener).toHaveBeenCalled()
    expect(port.permissionSnapshot().generation).toBeGreaterThanOrEqual(2)

    await expect(port.selectPermission('danger-full-access'))
      .rejects.toThrow('already uses')
    await expect(port.selectPermission('custom')).rejects.toThrow('current-only')
    await expect(port.selectPermission('unknown')).rejects.toThrow('not advertised')
  })

  it('retains the last-good projection when observation fails or Agent identity changes', async () => {
    const { ctx, agent, setLiveAgent } = await harness()
    const port = new DshSessionPermissions(ctx, agent)
    const snapshot = vi.spyOn(ctx.sessionProjections, 'snapshot')
    snapshot.mockImplementationOnce(() => { throw new Error('projection failed') })

    ctx.emit('agent-preset/selected', agent.id, 'standard')
    expect(port.permissionSnapshot()).toMatchObject({
      available: true,
      stale: true,
      error: 'projection failed',
      currentValue: 'workspace-write',
    })
    await expect(port.selectPermission('danger-full-access'))
      .rejects.toThrow('projection is stale')

    setLiveAgent(undefined)
    ctx.emit('agent-preset/selected', agent.id, 'standard')
    expect(port.permissionSnapshot()).toMatchObject({
      available: true,
      stale: true,
      error: expect.stringContaining('no longer the live Agent'),
      currentValue: 'workspace-write',
    })
  })

  it('contains official command admission, settlement, and dynamic-service failures', async () => {
    const { ctx, agent } = await harness()
    const port = new DshSessionPermissions(ctx, agent)
    const execute = vi.spyOn(ctx.commands, 'execute')
    const list = vi.spyOn(ctx.commands, 'list')

    list.mockReturnValueOnce([])
    await expect(port.selectPermission('danger-full-access', confirmation(port)))
      .rejects.toThrow('write command is unavailable')
    expect(port.permissionSnapshot()).toMatchObject({ selecting: false })

    execute.mockResolvedValueOnce(undefined)
    await expect(port.selectPermission('danger-full-access', confirmation(port)))
      .rejects.toThrow('was not admitted')

    execute.mockResolvedValueOnce({
      result: { kind: 'error', text: 'preset denied' },
    } as never)
    await expect(port.selectPermission('danger-full-access', confirmation(port)))
      .rejects.toThrow('preset denied')

    execute.mockRejectedValueOnce('transport failed')
    await expect(port.selectPermission('danger-full-access', confirmation(port)))
      .rejects.toBe('transport failed')
    expect(port.permissionSnapshot()).toMatchObject({
      selecting: false,
      error: 'transport failed',
    })

    let settle: ((value: unknown) => void) | undefined
    execute.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }) as never)
    const pending = port.selectPermission('danger-full-access', confirmation(port))
    await vi.waitFor(() => {
      expect(port.permissionSnapshot().selecting).toBe(true)
    })
    await expect(port.selectPermission('danger-full-access'))
      .rejects.toThrow('already running')
    settle?.({ result: { kind: 'success', text: 'preset danger-full-access' } })
    await pending

    const originalGet = ctx.get.bind(ctx)
    vi.spyOn(ctx, 'get').mockImplementation(((name: string) => (
      name === 'commands' ? undefined : originalGet(name as never)
    )) as never)
    await expect(port.selectPermission('danger-full-access', confirmation(port)))
      .rejects.toThrow('command service is unavailable')
    ctx.emit('commands/change')
    expect(port.permissionSnapshot().writable).toBe(false)
  })

  it('filters projection changes and contains observer and injected-fiber cleanup failures', async () => {
    const { ctx, agent, session } = await harness()
    const otherProjection = {
      key: 'other-permission-test',
      stateSchema: identitySchema,
      init: () => '',
      apply: (state: string, event: SessionEvent) => (
        event.type === 'session/title' ? event.data.title : state
      ),
      wire: { viewSchema: identitySchema, view: (value: string) => value },
      stateVersion: 0,
    }
    ctx.sessionProjections.register(otherProjection as never)
    const injectFailure = new Error('projection binding cleanup failed')
    vi.spyOn(ctx, 'inject').mockReturnValue({
      dispose: vi.fn(async () => { throw injectFailure }),
    } as never)
    const logError = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const port = new DshSessionPermissions(ctx, agent)
    const listener = vi.fn(() => { throw new Error('observer failed') })
    port.onPermissionsChanged(listener)

    const other = ctx.sessions.create(SessionId('permission-other-session'))
    other.append('session/title', {
      title: 'danger-full-access',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    session.append('session/title', {
      title: 'danger-full-access',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    ctx.emit('agent-preset/selected', SessionId('different-session'), 'standard')
    ctx.emit('commands/change')
    expect(listener).toHaveBeenCalled()

    port.disposePermissions()
    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith(injectFailure)
    })
  })

  it('reports missing projection/write ownership and contains disposal callbacks', async () => {
    const noProjection = await harness({ projection: false })
    const unavailable = new DshSessionPermissions(noProjection.ctx, noProjection.agent)
    expect(unavailable.permissionSnapshot()).toMatchObject({
      available: false,
      writable: true,
      options: [],
    })
    await expect(unavailable.selectPermission('workspace-write'))
      .rejects.toThrow('unavailable')

    const noCommand = await harness({ permissionCommand: false })
    const readOnly = new DshSessionPermissions(noCommand.ctx, noCommand.agent)
    expect(readOnly.permissionSnapshot()).toMatchObject({
      available: true,
      writable: false,
    })
    await expect(readOnly.selectPermission('danger-full-access'))
      .rejects.toThrow('write command is unavailable')

    const listener = vi.fn()
    const late = readOnly.onPermissionsChanged(listener)
    late()
    late()
    readOnly.disposePermissions()
    readOnly.disposePermissions()
    expect(readOnly.permissionSnapshot()).toEqual({
      available: false,
      writable: false,
      stale: false,
      generation: readOnly.permissionSnapshot().generation,
      selecting: false,
      options: [],
    })
    expect(() => readOnly.onPermissionsChanged(listener)).toThrow('disposed')
    await expect(readOnly.selectPermission('workspace-write')).rejects.toThrow('disposed')
    expect(() => noCommand.ctx.emit('commands/change')).not.toThrow()
    expect(() => noCommand.ctx.emit(
      'agent-preset/selected',
      noCommand.agent.id,
      'standard',
    )).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })
})
