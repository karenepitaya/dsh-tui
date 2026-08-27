import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { DshSessionMode } from '../src/dsh/agent-mode.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function setup(seedTurn = false, provideAgents = true): {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly recompose: ReturnType<typeof vi.fn>
  readonly list: ReturnType<typeof vi.fn>
  readonly setLiveAgent: (value: Agent | undefined) => void
} {
  const ctx = new Context()
  contexts.push(ctx)
  const session = Session.create(SessionId('mode-session'))
  if (seedTurn) session.append('turn/start', { turn: 0 })
  const agentCtx = new Context()
  contexts.push(agentCtx)
  const agent = {
    id: session.id,
    session,
    ctx: agentCtx,
    status: 'idle',
  } as unknown as Agent
  let liveAgent: Agent | undefined = agent
  let current = 'standard'
  const roster: AgentPreset[] = [
    {
      id: 'standard',
      trust: 'system',
      path: 'D:\\presets\\standard\\agent.cordis.yml',
      name: 'Standard',
    },
    {
      id: 'code',
      trust: 'system',
      path: 'D:\\presets\\code\\agent.cordis.yml',
      name: 'PTC Mode',
    },
    {
      id: 'broken',
      trust: 'user',
      path: 'D:\\presets\\broken\\agent.cordis.yml',
      description: 'Broken user composition',
      broken: 'invalid composition',
    },
  ]
  const list = vi.fn(async () => roster)
  const recompose = vi.fn(async (_agentCtx: Context, id: string) => {
    const preset = roster.find(item => item.id === id)
    if (preset === undefined) throw new Error(`unknown preset ${id}`)
    current = preset.id
    return preset
  })
  ctx.provide('agentPresets', {
    defaultId: 'standard',
    list,
    recompose,
    composedPreset: () => current,
  } as never)
  if (provideAgents) {
    ctx.provide('agents', {
      get: () => liveAgent,
    } as never)
  }
  return {
    ctx,
    agent,
    session,
    recompose,
    list,
    setLiveAgent: value => { liveAgent = value },
  }
}

describe('official DSH Agent mode adapter', () => {
  it('degrades to an unavailable seam without the AgentPresets service', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agentCtx = new Context()
    contexts.push(agentCtx)
    const session = Session.create(SessionId('mode-unavailable'))
    const agent = {
      id: session.id,
      session,
      ctx: agentCtx,
      status: 'idle',
    } as unknown as Agent
    const mode = new DshSessionMode(ctx, agent)

    expect(mode.modeSnapshot()).toEqual({
      available: false,
      loading: false,
      selecting: false,
      locked: false,
      presets: [],
    })
    await expect(mode.refreshModes()).rejects.toThrow(
      'DSH AgentPresets service is unavailable',
    )
    expect(() => mode.selectMode('code')).toThrow(
      'DSH AgentPresets service is unavailable',
    )
  })

  it('refreshes a detached roster and reports current/default/lock state', async () => {
    const { ctx, agent, list } = setup()
    const mode = new DshSessionMode(ctx, agent)
    const listener = vi.fn()
    const stop = mode.onModesChanged(listener)

    expect(mode.modeSnapshot()).toMatchObject({
      available: true,
      current: 'standard',
      defaultId: 'standard',
      loading: false,
      selecting: false,
      locked: false,
      presets: [],
    })
    await mode.refreshModes()
    const refreshed = mode.modeSnapshot()
    expect(refreshed.presets.map(item => item.id)).toEqual(['standard', 'code', 'broken'])
    expect(refreshed.presets[2]).toMatchObject({
      description: 'Broken user composition',
      broken: 'invalid composition',
    })
    expect(refreshed.presets[0]).not.toBe((await list.mock.results[0]!.value)[0])
    expect(Object.isFrozen(refreshed)).toBe(true)
    expect(Object.isFrozen(refreshed.presets)).toBe(true)
    expect(listener).toHaveBeenCalled()

    stop()
    stop()
    mode.disposeModes()
  })

  it('recomposes the exact blank Agent and records the durable commit afterward', async () => {
    const { ctx, agent, session, recompose } = setup()
    const mode = new DshSessionMode(ctx, agent)
    const listener = vi.fn()
    mode.onModesChanged(listener)

    await mode.selectMode('code')

    expect(recompose).toHaveBeenCalledWith(agent.ctx, 'code')
    expect(session.events.at(-1)).toMatchObject({
      type: 'agent-preset/selected',
      data: { agentPreset: 'code' },
    })
    expect(mode.modeSnapshot()).toMatchObject({ current: 'code', selecting: false })
    expect(listener).toHaveBeenCalled()
  })

  it('locks after turn/start and rejects a stale Agent identity', async () => {
    const locked = setup(true)
    const lockedMode = new DshSessionMode(locked.ctx, locked.agent)
    expect(lockedMode.modeSnapshot().locked).toBe(true)
    await expect(lockedMode.selectMode('code')).rejects.toThrow(
      'has already started; its Agent mode is fixed',
    )
    expect(locked.recompose).not.toHaveBeenCalled()

    const stale = setup()
    stale.setLiveAgent(undefined)
    await expect(new DshSessionMode(stale.ctx, stale.agent).selectMode('code'))
      .rejects.toThrow('is no longer the live Agent')
    expect(stale.recompose).not.toHaveBeenCalled()

    const unavailable = setup(false, false)
    await expect(new DshSessionMode(unavailable.ctx, unavailable.agent).selectMode('code'))
      .rejects.toThrow('DSH Agent service is unavailable')
    expect(unavailable.recompose).not.toHaveBeenCalled()
  })

  it('leaves the old mode and log untouched when recomposition fails', async () => {
    const { ctx, agent, session, recompose } = setup()
    recompose.mockRejectedValueOnce(new Error('broken composition'))
    const mode = new DshSessionMode(ctx, agent)

    await expect(mode.selectMode('code')).rejects.toThrow('broken composition')
    expect(mode.modeSnapshot()).toMatchObject({ current: 'standard', selecting: false })
    expect(session.events).toEqual([])
  })

  it('serializes switches and cancels only before a queued commit starts', async () => {
    const { ctx, agent, session, recompose } = setup()
    const firstGate = Promise.withResolvers<void>()
    recompose.mockImplementationOnce(async (_agentCtx: Context, id: string) => {
      await firstGate.promise
      return {
        id,
        trust: 'system',
        path: `D:\\presets\\${id}\\agent.cordis.yml`,
      }
    })
    const mode = new DshSessionMode(ctx, agent)
    const first = mode.selectMode('code')
    const abort = new AbortController()
    const queued = mode.selectMode('standard', { signal: abort.signal })
    abort.abort(new Error('cancel queued switch'))
    await Promise.resolve()
    expect(recompose).toHaveBeenCalledTimes(1)

    firstGate.resolve()
    await first
    await expect(queued).rejects.toThrow('cancel queued switch')
    expect(recompose).toHaveBeenCalledTimes(1)
    expect(session.events).toHaveLength(1)

    const inFlightGate = Promise.withResolvers<void>()
    recompose.mockImplementationOnce(async (_agentCtx: Context, id: string) => {
      inFlightGate.resolve()
      await Promise.resolve()
      return {
        id,
        trust: 'system',
        path: `D:\\presets\\${id}\\agent.cordis.yml`,
      }
    })
    const inFlightAbort = new AbortController()
    const inFlight = mode.selectMode('standard', { signal: inFlightAbort.signal })
    await inFlightGate.promise
    inFlightAbort.abort(new Error('too late to cancel commit'))
    await expect(inFlight).resolves.toBeUndefined()
    expect(session.events.at(-1)).toMatchObject({
      type: 'agent-preset/selected',
      data: { agentPreset: 'standard' },
    })
  })

  it('keeps refresh errors local, honors cancellation, and ignores foreign events', async () => {
    const { ctx, agent, list } = setup()
    const mode = new DshSessionMode(ctx, agent)
    const listener = vi.fn()
    mode.onModesChanged(listener)
    await mode.refreshModes(new AbortController().signal)
    list.mockRejectedValueOnce(new Error('roster unavailable'))
    await expect(mode.refreshModes()).rejects.toThrow('roster unavailable')
    expect(mode.modeSnapshot()).toMatchObject({
      loading: false,
      error: 'roster unavailable',
    })

    list.mockRejectedValueOnce('string roster failure')
    await expect(mode.refreshModes()).rejects.toBe('string roster failure')
    expect(mode.modeSnapshot().error).toBe('string roster failure')

    const before = listener.mock.calls.length
    ctx.emit('agent-preset/selected', SessionId('foreign'), 'code')
    expect(listener).toHaveBeenCalledTimes(before)
    ctx.emit('agent-preset/selected', agent.id, 'code')
    expect(listener).toHaveBeenCalledTimes(before + 1)

    const aborted = new AbortController()
    const reason = new Error('cancel refresh')
    aborted.abort(reason)
    await expect(mode.refreshModes(aborted.signal)).rejects.toBe(reason)
  })

  it('disposes idempotently and refuses new work', async () => {
    const { ctx, agent, list } = setup()
    const mode = new DshSessionMode(ctx, agent)
    const listener = vi.fn()
    mode.onModesChanged(listener)
    const roster = Promise.withResolvers<AgentPreset[]>()
    list.mockImplementationOnce(() => roster.promise)
    const pendingRefresh = mode.refreshModes()
    await Promise.resolve()
    mode.disposeModes()
    roster.resolve([])
    await pendingRefresh
    mode.disposeModes()
    expect(mode.modeSnapshot().available).toBe(false)
    expect(() => mode.onModesChanged(listener)).toThrow('Agent mode port is disposed')
    await expect(mode.refreshModes()).rejects.toThrow('Agent mode port is disposed')
    expect(() => mode.selectMode('code')).toThrow('Agent mode port is disposed')
  })
})
