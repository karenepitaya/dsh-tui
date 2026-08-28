import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DshSessionSkills } from '../src/dsh/session-skills.ts'

interface RegistryOptions {
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly scope?: Agent
}

interface RegistrySkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: {
    readonly modelInvocable: boolean
    readonly userInvocable: boolean
  }
  readonly source: string
  readonly provider: string
  readonly resourceBase?:
    | { readonly kind: 'directory'; readonly path: string }
    | { readonly kind: 'url'; readonly url: string }
    | { readonly kind: 'opaque'; readonly description: string }
}

interface Registry {
  snapshot(options: RegistryOptions): Promise<{
    readonly skills: readonly RegistrySkill[]
    readonly complete: boolean
  }>
}

interface SkillContext {
  provide(name: 'skills', service: Registry): void
  emit(name: 'skills/change'): void
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function registrySkill(
  name: string,
  overrides: Partial<RegistrySkill> = {},
): RegistrySkill {
  return {
    name,
    description: `${name} description`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'workspace',
    provider: 'filesystem',
    ...overrides,
  }
}

function registry(
  result: {
    readonly skills: readonly RegistrySkill[]
    readonly complete: boolean
  } | ((options: RegistryOptions) => Promise<{
    readonly skills: readonly RegistrySkill[]
    readonly complete: boolean
  }>),
): Registry & { readonly snapshot: ReturnType<typeof vi.fn> } {
  const implementation = typeof result === 'function'
    ? result
    : async () => result
  return { snapshot: vi.fn(implementation) }
}

function setup(options: {
  readonly rootRegistry?: Registry
  readonly scopedRegistry?: () => Registry | undefined
  readonly cwd?: string
  readonly provideAgents?: boolean
} = {}): {
  readonly ctx: Context
  readonly agent: Agent
  readonly setLiveAgent: (agent: Agent | undefined) => void
} {
  const ctx = new Context()
  contexts.push(ctx)
  const agentCtx = new Context()
  contexts.push(agentCtx)
  const id = SessionId('skills-session')
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: 1,
    agentPreset: 'standard',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  })
  const agent = {
    id,
    session,
    ctx: agentCtx,
    status: 'idle',
  } as unknown as Agent
  let liveAgent: Agent | undefined = agent
  if (options.provideAgents !== false) {
    ctx.provide('agents', { get: () => liveAgent } as never)
  }
  if (options.rootRegistry !== undefined) {
    (ctx as unknown as SkillContext).provide('skills', options.rootRegistry)
  }
  if (options.scopedRegistry !== undefined) {
    ctx.provide('agentPresets', {
      serviceFor: (_agent: Agent, name: string) => (
        name === 'skills' ? options.scopedRegistry?.() : undefined
      ),
    } as never)
  }
  return { ctx, agent, setLiveAgent: value => { liveAgent = value } }
}

describe('DSH scoped Session skills adapter', () => {
  it('passes exact cwd, signal, and live Agent scope while projecting only user skills', async () => {
    const catalog = registry({
      complete: true,
      skills: [
        registrySkill('directory', {
          whenToUse: 'When files need review',
          resourceBase: { kind: 'directory', path: 'D:\\skills\\directory' },
        }),
        registrySkill('remote', {
          invocation: { modelInvocable: false, userInvocable: true },
          resourceBase: { kind: 'url', url: 'https://skills.example/remote' },
        }),
        registrySkill('opaque', {
          resourceBase: { kind: 'opaque', description: 'bundled resource' },
        }),
        registrySkill('model-only', {
          invocation: { modelInvocable: true, userInvocable: false },
        }),
      ],
    })
    const { ctx, agent } = setup({ rootRegistry: catalog, cwd: 'D:\\workspace' })
    const port = new DshSessionSkills(ctx, agent)
    const listener = vi.fn()
    const stop = port.onSkillsChanged(listener)
    const signal = new AbortController().signal

    await port.refreshSkills(signal)

    expect(catalog.snapshot).toHaveBeenCalledExactlyOnceWith({
      cwd: 'D:\\workspace',
      signal,
      scope: agent,
    })
    const view = port.skillsSnapshot()
    expect(view).toMatchObject({
      available: true,
      loading: false,
      complete: true,
      stale: false,
      skills: [
        {
          name: 'directory',
          whenToUse: 'When files need review',
          modelInvocable: true,
          resourceBase: { kind: 'directory', path: 'D:\\skills\\directory' },
        },
        {
          name: 'remote',
          modelInvocable: false,
          resourceBase: { kind: 'url', url: 'https://skills.example/remote' },
        },
        {
          name: 'opaque',
          resourceBase: { kind: 'opaque', description: 'bundled resource' },
        },
      ],
    })
    expect(view.skills.map(item => item.name)).not.toContain('model-only')
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.skills)).toBe(true)
    expect(Object.isFrozen(view.skills[0])).toBe(true)
    expect(Object.isFrozen(view.skills[0]?.resourceBase)).toBe(true)
    expect(listener).toHaveBeenCalled()

    const calls = listener.mock.calls.length
    stop()
    stop()
    ;(ctx as unknown as SkillContext).emit('skills/change')
    expect(listener).toHaveBeenCalledTimes(calls)
    expect(port.skillsSnapshot()).toMatchObject({ complete: false, stale: true })
    ;(ctx as unknown as SkillContext).emit('skills/change')
  })

  it('retains the last complete catalog across incomplete discovery and refresh errors', async () => {
    const catalog = registry({ complete: true, skills: [registrySkill('stable')] })
    const { ctx, agent } = setup({ rootRegistry: catalog })
    const port = new DshSessionSkills(ctx, agent)
    await port.refreshSkills()

    catalog.snapshot.mockResolvedValueOnce({ complete: false, skills: [registrySkill('partial')] })
    await port.refreshSkills()
    expect(port.skillsSnapshot()).toMatchObject({
      complete: false,
      stale: true,
      skills: [{ name: 'partial' }, { name: 'stable' }],
    })

    catalog.snapshot.mockRejectedValueOnce(new Error('filesystem unavailable'))
    await expect(port.refreshSkills()).rejects.toThrow('filesystem unavailable')
    expect(port.skillsSnapshot()).toMatchObject({
      loading: false,
      complete: false,
      stale: true,
      error: 'filesystem unavailable',
      skills: [{ name: 'partial' }, { name: 'stable' }],
    })

    catalog.snapshot.mockRejectedValueOnce('string failure')
    await expect(port.refreshSkills()).rejects.toBe('string failure')
    expect(port.skillsSnapshot().error).toBe('string failure')
  })

  it('exposes usable candidates from cold incomplete discovery without treating them as authoritative', async () => {
    const catalog = registry({ complete: false, skills: [
      registrySkill('partial-user'),
      registrySkill('partial-model-only', {
        invocation: { modelInvocable: true, userInvocable: false },
      }),
    ] })
    const { ctx, agent } = setup({ rootRegistry: catalog })
    const port = new DshSessionSkills(ctx, agent)

    await port.refreshSkills()

    expect(port.skillsSnapshot()).toMatchObject({
      complete: false,
      stale: true,
      skills: [{ name: 'partial-user' }],
    })

    catalog.snapshot.mockResolvedValueOnce({
      complete: false,
      skills: [registrySkill('new-partial-user')],
    })
    await port.refreshSkills()
    expect(port.skillsSnapshot().skills.map(skill => skill.name)).toEqual(['new-partial-user'])
  })

  it('resolves the scoped registry on every refresh and clears cross-mode catalog state', async () => {
    const root = registry({ complete: true, skills: [registrySkill('root')] })
    const standard = registry({ complete: true, skills: [registrySkill('standard-skill')] })
    const minimal = registry({ complete: true, skills: [registrySkill('minimal-skill')] })
    let scoped: Registry | undefined = standard
    const { ctx, agent } = setup({
      rootRegistry: root,
      scopedRegistry: () => scoped,
    })
    const port = new DshSessionSkills(ctx, agent)
    const listener = vi.fn()
    port.onSkillsChanged(listener)

    await port.refreshSkills()
    expect(port.skillsSnapshot().skills.map(skill => skill.name)).toEqual(['standard-skill'])
    expect(root.snapshot).not.toHaveBeenCalled()

    const beforeForeign = listener.mock.calls.length
    ctx.emit('agent-preset/selected', SessionId('foreign'), 'minimal')
    expect(listener).toHaveBeenCalledTimes(beforeForeign)

    scoped = minimal
    ctx.emit('agent-preset/selected', agent.id, 'minimal')
    expect(port.skillsSnapshot()).toMatchObject({ complete: false, skills: [] })
    await port.refreshSkills()
    expect(port.skillsSnapshot().skills.map(skill => skill.name)).toEqual(['minimal-skill'])

    scoped = undefined
    ctx.emit('agent-preset/selected', agent.id, 'standard')
    await port.refreshSkills()
    expect(port.skillsSnapshot().skills.map(skill => skill.name)).toEqual(['root'])
  })

  it('retries if mode composition swaps registries during discovery', async () => {
    let scoped: Registry | undefined
    let selectMinimal = (): void => {}
    const second = registry({ complete: true, skills: [registrySkill('second')] })
    const first = registry(async () => {
      scoped = second
      selectMinimal()
      return { complete: true, skills: [registrySkill('obsolete')] }
    })
    scoped = first
    const { ctx, agent } = setup({ scopedRegistry: () => scoped })
    selectMinimal = () => { ctx.emit('agent-preset/selected', agent.id, 'minimal') }
    const port = new DshSessionSkills(ctx, agent)

    await port.refreshSkills()
    expect(first.snapshot).toHaveBeenCalledOnce()
    expect(second.snapshot).toHaveBeenCalledOnce()
    expect(port.skillsSnapshot().skills.map(skill => skill.name)).toEqual(['second'])
  })

  it('does not treat unstable Cordis service facades as a mode change', async () => {
    const snapshot = vi.fn(async () => ({
      complete: true,
      skills: [registrySkill('facade-skill')],
    }))
    const { ctx, agent } = setup({
      scopedRegistry: () => ({ snapshot }),
    })
    const port = new DshSessionSkills(ctx, agent)

    await port.refreshSkills()

    expect(snapshot).toHaveBeenCalledOnce()
    expect(port.skillsSnapshot()).toMatchObject({
      complete: true,
      skills: [{ name: 'facade-skill' }],
    })
  })

  it('reports unavailable compositions without calling discovery', async () => {
    const { ctx, agent } = setup()
    ctx.provide('agentPresets', { defaultId: 'standard' } as never)
    const port = new DshSessionSkills(ctx, agent)
    expect(port.skillsSnapshot()).toMatchObject({
      available: false,
      loading: false,
      complete: true,
      stale: false,
      skills: [],
    })
    await expect(port.refreshSkills()).resolves.toBeUndefined()
    expect(port.skillsSnapshot().generation).toBeGreaterThan(0)
  })

  it('contains cancellation, stale Agent identity, disposal, and listener teardown', async () => {
    const gate = Promise.withResolvers<{
      readonly skills: readonly RegistrySkill[]
      readonly complete: boolean
    }>()
    const catalog = registry(async () => gate.promise)
    const { ctx, agent, setLiveAgent } = setup({ rootRegistry: catalog })
    const port = new DshSessionSkills(ctx, agent)
    const listener = vi.fn()
    port.onSkillsChanged(listener)

    const aborted = new AbortController()
    const reason = new Error('cancel before refresh')
    aborted.abort(reason)
    await expect(port.refreshSkills(aborted.signal)).rejects.toBe(reason)

    const inFlightAbort = new AbortController()
    const inFlight = port.refreshSkills(inFlightAbort.signal)
    await Promise.resolve()
    inFlightAbort.abort(new Error('cancel discovery'))
    gate.resolve({ complete: true, skills: [registrySkill('late')] })
    await expect(inFlight).rejects.toThrow('cancel discovery')

    setLiveAgent(undefined)
    await expect(port.refreshSkills()).rejects.toThrow('no longer the live Agent')
    setLiveAgent(agent)
    port.disposeSkills()
    port.disposeSkills()
    expect(port.skillsSnapshot()).toMatchObject({ available: false, skills: [] })
    expect(() => port.onSkillsChanged(listener)).toThrow('disposed')
    await expect(port.refreshSkills()).rejects.toThrow('disposed')
    ;(ctx as unknown as SkillContext).emit('skills/change')
  })

  it('fails clearly when the official Agent service is absent', async () => {
    const catalog = registry({ complete: true, skills: [] })
    const { ctx, agent } = setup({ rootRegistry: catalog, provideAgents: false })
    const port = new DshSessionSkills(ctx, agent)
    await expect(port.refreshSkills()).rejects.toThrow('Agent service is unavailable')
  })

  it('contains a registry result that settles after disposal', async () => {
    const gate = Promise.withResolvers<{
      readonly skills: readonly RegistrySkill[]
      readonly complete: boolean
    }>()
    const catalog = registry(async () => gate.promise)
    const { ctx, agent } = setup({ rootRegistry: catalog })
    const port = new DshSessionSkills(ctx, agent)
    const refresh = port.refreshSkills()
    await Promise.resolve()
    port.disposeSkills()
    gate.resolve({ complete: true, skills: [] })
    await expect(refresh).resolves.toBeUndefined()
  })

  it('ignores an already-queued skills/change callback after listener disposal', () => {
    const catalog = registry({ complete: true, skills: [] })
    const { agent } = setup({ rootRegistry: catalog })
    const callbacks = new Map<string, (...args: unknown[]) => void>()
    const fakeCtx = {
      get(name: string): unknown {
        if (name === 'skills') return catalog
        if (name === 'agents') return { get: () => agent }
        return undefined
      },
      on(name: string, listener: (...args: unknown[]) => void): () => boolean {
        callbacks.set(name, listener)
        return () => true
      },
    } as unknown as Context
    const port = new DshSessionSkills(fakeCtx, agent)
    port.disposeSkills()
    expect(() => callbacks.get('skills/change')?.()).not.toThrow()
  })
})
