import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type SessionId as OfficialSessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentDescendantListEntry,
  SubagentRuntime,
} from '@deepseek-ai/dsh-subagent'
import { DshSessionDelegation } from '../src/dsh/delegation-activity.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept
    reject = deny
  })
  return { promise, resolve, reject }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function createAgent(
  ctx: Context,
  id: string,
  parentSession?: OfficialSessionId,
  status: 'idle' | 'running' = 'idle',
): Agent {
  const base = Session.create(SessionId(id))
  const session = parentSession === undefined
    ? base
    : Session.create(base.id, [], { ...base.header, parentSession })
  return {
    id: session.id,
    options: {},
    session,
    inbox: {},
    status,
    ctx,
    followup: () => {},
    steer: () => {},
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: () => Promise.reject(new Error('not used')),
    send: () => {},
    inject: () => {},
  } as unknown as Agent
}

function child(
  id: string,
  parentId: string,
  options: {
    readonly depth?: number
    readonly mode?: 'one-shot' | 'continuable'
    readonly activity?: 'running' | 'inactive'
    readonly label?: string
    readonly hasChildren?: boolean
  } = {},
): SubagentDescendantListEntry {
  return {
    kind: 'child',
    id: SessionId(id),
    parentId: SessionId(parentId),
    depth: options.depth ?? 1,
    mode: options.mode ?? 'continuable',
    activity: options.activity ?? 'running',
    hasChildren: options.hasChildren ?? false,
    ...(options.label === undefined ? {} : { label: options.label }),
  } as SubagentDescendantListEntry
}

function diagnostic(
  id: string,
  parentId: string,
  reason: 'corrupt' | 'unsupported' | 'unavailable' = 'corrupt',
): SubagentDescendantListEntry {
  return {
    kind: 'diagnostic',
    id: SessionId(id),
    parentId: SessionId(parentId),
    depth: 1,
    reason,
  }
}

function createService(
  entries: readonly SubagentDescendantListEntry[] = [],
): {
  readonly service: SubagentRuntime
  readonly listDescendants: ReturnType<typeof vi.fn>
  readonly interrupt: ReturnType<typeof vi.fn>
} {
  const listDescendants = vi.fn(() => Promise.resolve([...entries]))
  const interrupt = vi.fn()
  return {
    service: { listDescendants, interrupt } as unknown as SubagentRuntime,
    listDescendants,
    interrupt,
  }
}

function setup(
  entries: readonly SubagentDescendantListEntry[] = [],
  options: {
    readonly provideService?: boolean
    readonly seedUnrelatedHistory?: boolean
  } = {},
) {
  const ctx = new Context()
  contexts.push(ctx)
  const root = createAgent(ctx, 'root')
  if (options.seedUnrelatedHistory === true) {
    root.session.append('turn/start', { turn: 0 })
    root.session.append('session/title', {
      title: 'Seed title',
      messageSeqs: [],
      source: { kind: 'user' },
    })
  }
  const live = new Map<string, Agent>()
  ctx.provide('agents', {
    get: (id: OfficialSessionId) => live.get(String(id)),
  } as never)
  const fake = createService(entries)
  const release = options.provideService === false
    ? undefined
    : ctx.provide('subagents', fake.service)
  const adapter = new DshSessionDelegation(ctx, root)
  return { ctx, root, live, fake, release, adapter }
}

async function waitForRefresh(listDescendants: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(listDescendants).toHaveBeenCalled())
  await Promise.resolve()
}

describe('DshSessionDelegation rc.2 adapter', () => {
  it('projects the exact descendant tree and uses only ancestor-authorized interrupt', async () => {
    const entries = [
      child('live-child', 'root', { label: 'Live', hasChildren: true }),
      child('ready-child', 'root', { label: 'Ready' }),
      child('nested-one-shot', 'live-child', {
        depth: 2, mode: 'one-shot', activity: 'inactive',
      }),
      child('running-one-shot', 'root', { mode: 'one-shot' }),
      diagnostic('damaged-child', 'root'),
    ]
    const bench = setup(entries)
    const liveChild = createAgent(bench.ctx, 'live-child', bench.root.id, 'running')
    bench.live.set('live-child', liveChild)
    const goodListener = vi.fn()
    bench.adapter.onDelegationChanged(() => { throw new Error('observer failed') })
    const unsubscribe = bench.adapter.onDelegationChanged(goodListener)
    await waitForRefresh(bench.fake.listDescendants)

    const snapshot = bench.adapter.delegationSnapshot()
    expect(bench.fake.listDescendants).toHaveBeenCalledWith(bench.root.id, expect.any(AbortSignal))
    expect(snapshot).toMatchObject({
      available: true,
      loading: false,
      subagentsAvailable: true,
      subagents: [
        {
          id: 'live-child', status: 'running', mode: 'continuable',
          interruptible: true, hasChildren: true,
        },
        { id: 'ready-child', status: 'ready', interruptible: false },
        { id: 'nested-one-shot', status: 'inactive', mode: 'one-shot' },
        { id: 'running-one-shot', status: 'running', interruptible: false },
        {
          id: 'damaged-child', status: 'diagnostic', mode: 'diagnostic',
          diagnosticReason: 'corrupt',
        },
      ],
    })
    expect(goodListener).toHaveBeenCalled()

    expect(bench.adapter.runDelegationAction({
      kind: 'interrupt-subagent',
      ref: {
        id: 'live-child', parentId: 'root', generation: snapshot.generation,
      },
    })).toEqual({ accepted: true, outcome: 'requested' })
    expect(bench.fake.interrupt).toHaveBeenCalledExactlyOnceWith(
      SessionId('live-child'),
      { kind: 'ancestor', agent: bench.root },
    )

    unsubscribe()
    unsubscribe()
    const before = goodListener.mock.calls.length
    bench.ctx.emit('agent/status', { agent: liveChild, status: 'running' })
    expect(goodListener).toHaveBeenCalledTimes(before)
  })

  it('folds only the parent Session durable Workflow stream and interrupts unclosed records', async () => {
    const bench = setup([], {
      provideService: false,
      seedUnrelatedHistory: true,
    })
    const foreign = Session.create(SessionId('foreign'))
    const listener = vi.fn()
    bench.adapter.onDelegationChanged(listener)

    const foreignStart = foreign.append('tool-workflow/run-start', {
      runId: 'foreign-run', name: 'Foreign',
    } as never)
    bench.ctx.emit('session/event', foreign, foreignStart)
    expect(bench.adapter.delegationSnapshot().workflows).toEqual([])

    const turn = bench.root.session.append('turn/start', { turn: 1 })
    bench.ctx.emit('session/event', bench.root.session, turn)
    const step = bench.root.session.append('step/start', { turn: 1, step: 1 })
    bench.ctx.emit('session/event', bench.root.session, step)
    const start = bench.root.session.append('tool-workflow/run-start', {
      runId: 'parent-run', name: 'Parent durable run',
    } as never)
    bench.ctx.emit('session/event', bench.root.session, start)
    const duplicateStart = bench.root.session.append('tool-workflow/run-start', {
      runId: 'parent-run', name: 'Duplicate durable run',
    } as never)
    bench.ctx.emit('session/event', bench.root.session, duplicateStart)
    const member = bench.root.session.append('tool-workflow/agent-start', {
      runId: 'parent-run', seq: 1, label: 'Child', childId: SessionId('child'),
    } as never)
    bench.ctx.emit('session/event', bench.root.session, member)
    const unrelated = { seq: 99, type: 'unrelated', data: {} } as never
    bench.ctx.emit('session/event', bench.root.session, unrelated)
    const close = bench.root.session.append('step/end', { turn: 1, step: 1 })
    bench.ctx.emit('session/event', bench.root.session, close)

    expect(bench.adapter.delegationSnapshot().workflows).toEqual([
      expect.objectContaining({
        id: 'parent-run', status: 'interrupted',
        phases: [expect.objectContaining({
          members: [expect.objectContaining({ status: 'interrupted' })],
        })],
      }),
    ])
    expect(listener).toHaveBeenCalledTimes(5)
    await expect(bench.adapter.refreshDelegation()).resolves.toBeUndefined()
  })

  it('rejects stale, missing, diagnostic, and non-live control references', async () => {
    const bench = setup([
      child('idle-child', 'root'),
      child('one-shot', 'root', { mode: 'one-shot' }),
      diagnostic('diagnostic', 'root', 'unavailable'),
    ])
    await waitForRefresh(bench.fake.listDescendants)
    const generation = bench.adapter.delegationSnapshot().generation

    expect(bench.adapter.runDelegationAction({
      kind: 'interrupt-subagent',
      ref: { id: 'idle-child', parentId: 'root', generation: generation - 1 },
    })).toMatchObject({ accepted: false, code: 'subagent-reference-stale' })
    expect(bench.adapter.runDelegationAction({
      kind: 'interrupt-subagent',
      ref: { id: 'missing', parentId: 'root', generation },
    })).toMatchObject({
      accepted: false,
      code: 'subagent-reference-stale',
      message: 'That child is no longer in this Session tree.',
    })
    expect(bench.adapter.runDelegationAction({
      kind: 'interrupt-subagent',
      ref: { id: 'one-shot', parentId: 'root', generation },
    })).toMatchObject({ accepted: false, code: 'subagent-not-interruptible' })
    expect(bench.adapter.runDelegationAction({
      kind: 'interrupt-subagent',
      ref: { id: 'diagnostic', parentId: 'root', generation },
    })).toMatchObject({ accepted: false, code: 'subagent-not-interruptible' })
    expect(bench.adapter.runDelegationAction({
      kind: 'interrupt-subagent',
      ref: { id: 'idle-child', parentId: 'root', generation },
    })).toEqual({ accepted: true, outcome: 'already-idle' })

    bench.release?.()
    await Promise.resolve()
    expect(bench.adapter.delegationSnapshot()).toMatchObject({
      subagentsAvailable: false,
      subagents: [],
    })
    expect(bench.adapter.runDelegationAction({
      kind: 'interrupt-subagent',
      ref: { id: 'idle-child', parentId: 'root', generation },
    })).toMatchObject({ accepted: false, code: 'subagent-capability-unavailable' })
  })

  it('contains service failures and preserves exact error codes from interrupt', async () => {
    const bench = setup([child('child', 'root')])
    await waitForRefresh(bench.fake.listDescendants)
    const running = createAgent(bench.ctx, 'child', bench.root.id, 'running')
    bench.live.set('child', running)
    let generation = bench.adapter.delegationSnapshot().generation

    const coded = Object.assign(new Error('not your child'), { code: 'UNAUTHORIZED' })
    bench.fake.interrupt.mockImplementationOnce(() => { throw coded })
    expect(bench.adapter.runDelegationAction({
      kind: 'interrupt-subagent',
      ref: { id: 'child', parentId: 'root', generation },
    })).toEqual({
      accepted: false,
      code: 'UNAUTHORIZED',
      message: 'not your child',
    })
    bench.fake.interrupt.mockImplementationOnce(() => { throw 'plain failure' })
    expect(bench.adapter.runDelegationAction({
      kind: 'interrupt-subagent',
      ref: { id: 'child', parentId: 'root', generation },
    })).toEqual({
      accepted: false,
      code: 'subagent-action-failed',
      message: 'plain failure',
    })

    bench.fake.listDescendants.mockRejectedValueOnce(
      Object.assign(new Error('catalog exploded'), { code: 'CATALOG_BROKEN' }),
    )
    await expect(bench.adapter.refreshDelegation()).rejects.toThrow('catalog exploded')
    expect(bench.adapter.delegationSnapshot().error).toBe('CATALOG_BROKEN: catalog exploded')

    bench.fake.listDescendants.mockRejectedValueOnce('string catalog failure')
    await expect(bench.adapter.refreshDelegation()).rejects.toBe('string catalog failure')
    expect(bench.adapter.delegationSnapshot().error)
      .toBe('subagent-list-failed: string catalog failure')
    generation = bench.adapter.delegationSnapshot().generation
    expect(generation).toBeGreaterThan(0)
  })

  it('supersedes catalog reads, forwards caller abort, and ignores detached results', async () => {
    const first = deferred<SubagentDescendantListEntry[]>()
    const second = deferred<SubagentDescendantListEntry[]>()
    const bench = setup([], { provideService: false })
    bench.fake.listDescendants
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const release = bench.ctx.provide('subagents', bench.fake.service)
    await vi.waitFor(() => expect(bench.fake.listDescendants).toHaveBeenCalledTimes(1))

    const newer = bench.adapter.refreshDelegation()
    await vi.waitFor(() => expect(bench.fake.listDescendants).toHaveBeenCalledTimes(2))
    second.resolve([child('new-child', 'root')])
    await newer
    first.resolve([child('old-child', 'root')])
    await Promise.resolve()
    expect(bench.adapter.delegationSnapshot().subagents.map(entry => entry.id))
      .toEqual(['new-child'])

    const pending = deferred<SubagentDescendantListEntry[]>()
    bench.fake.listDescendants.mockImplementationOnce((_id, signal: AbortSignal) => {
      signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true })
      return pending.promise
    })
    const abort = new AbortController()
    const aborted = bench.adapter.refreshDelegation(abort.signal)
    await vi.waitFor(() => expect(bench.fake.listDescendants).toHaveBeenCalledTimes(3))
    abort.abort(new Error('caller cancelled'))
    await expect(aborted).rejects.toThrow('caller cancelled')

    const detached = deferred<SubagentDescendantListEntry[]>()
    bench.fake.listDescendants.mockImplementationOnce(() => detached.promise)
    const detachedRefresh = bench.adapter.refreshDelegation()
    await vi.waitFor(() => expect(bench.fake.listDescendants).toHaveBeenCalledTimes(4))
    release()
    detached.resolve([child('detached-child', 'root')])
    await detachedRefresh
    expect(bench.adapter.delegationSnapshot().subagents).toEqual([])
  })

  it('reacts to related lifecycle edges, coalesces refreshes, and disposes idempotently', async () => {
    const bench = setup([child('known', 'root')])
    await waitForRefresh(bench.fake.listDescendants)
    const baseline = bench.fake.listDescendants.mock.calls.length

    const unrelated = createAgent(bench.ctx, 'unrelated')
    bench.ctx.emit('agent/created', { agent: bench.root })
    bench.ctx.emit('agent/created', { agent: unrelated })
    bench.ctx.emit('agent/disposed', { agent: unrelated })
    bench.ctx.emit('agent/status', { agent: unrelated, status: 'idle' })
    await Promise.resolve()
    expect(bench.fake.listDescendants).toHaveBeenCalledTimes(baseline)

    const known = createAgent(bench.ctx, 'known', bench.root.id)
    const nested = createAgent(bench.ctx, 'nested', SessionId('known'))
    bench.ctx.emit('agent/created', { agent: known })
    bench.ctx.emit('agent/disposed', { agent: nested })
    bench.ctx.emit('subagent/start', {} as never)
    bench.ctx.emit('subagent/end', {} as never)
    await vi.waitFor(() => expect(bench.fake.listDescendants).toHaveBeenCalledTimes(baseline + 1))

    const lateListener = vi.fn()
    bench.adapter.disposeDelegation()
    bench.adapter.disposeDelegation()
    expect(bench.adapter.delegationSnapshot()).toMatchObject({
      available: false,
      loading: false,
      subagentsAvailable: false,
      subagents: [],
      workflows: [],
    })
    expect(bench.adapter.runDelegationAction({
      kind: 'interrupt-subagent',
      ref: { id: 'known', parentId: 'root', generation: 1 },
    })).toMatchObject({ accepted: false, code: 'delegation-closed' })
    expect(bench.adapter.onDelegationChanged(lateListener)()).toBeUndefined()
    await expect(bench.adapter.refreshDelegation()).resolves.toBeUndefined()
    bench.ctx.emit('subagent/start', {} as never)
    await Promise.resolve()
    expect(lateListener).not.toHaveBeenCalled()
  })

  it('contains queued and in-flight refresh completion after disposal', async () => {
    const queued = setup([])
    queued.adapter.disposeDelegation()
    await Promise.resolve()
    expect(queued.fake.listDescendants).not.toHaveBeenCalled()

    const pending = deferred<SubagentDescendantListEntry[]>()
    const active = setup([])
    await waitForRefresh(active.fake.listDescendants)
    active.fake.listDescendants.mockImplementationOnce(() => pending.promise)
    const refresh = active.adapter.refreshDelegation()
    await vi.waitFor(() => expect(active.fake.listDescendants).toHaveBeenCalledTimes(2))
    active.adapter.disposeDelegation()
    pending.resolve([child('late', 'root')])
    await refresh
    expect(active.adapter.delegationSnapshot().subagents).toEqual([])
  })
})
