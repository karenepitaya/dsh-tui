import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  SessionId,
  type Session,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import {
  DshSessionCatalog,
  type SessionCatalogSnapshot,
} from '../src/internal.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function header(
  id: string,
  createdAt: number,
  extra: Partial<SessionHeader> = {},
): SessionHeader {
  return {
    version: 0,
    id: SessionId(id),
    createdAt,
    ...extra,
  }
}

function live(meta: SessionHeader): Session {
  return { id: meta.id, header: meta } as Session
}

function catalogHarness(options: {
  readonly live?: Session[]
  readonly statuses?: ReadonlyMap<string, Agent['status']>
  readonly list?: (signal?: AbortSignal) => Promise<SessionHeader[]>
} = {}): {
  readonly ctx: Context
  readonly live: Session[]
  readonly listLive: ReturnType<typeof vi.fn>
  readonly getAgent: ReturnType<typeof vi.fn>
  readonly catalog: DshSessionCatalog
} {
  const ctx = new Context()
  contexts.push(ctx)
  const sessions = options.live ?? []
  const listLive = vi.fn(() => [...sessions])
  const getAgent = vi.fn((id: string) => {
    const status = options.statuses?.get(id)
    return status === undefined ? undefined : { status }
  })
  ctx.provide('sessions', { list: listLive } as never)
  ctx.provide('agents', { get: getAgent } as never)
  if (options.list !== undefined) {
    ctx.provide('sessionPersistence', { list: options.list } as never)
  }
  return {
    ctx,
    live: sessions,
    listLive,
    getAgent,
    catalog: new DshSessionCatalog(ctx),
  }
}

function expectDeeplyFrozen(snapshot: SessionCatalogSnapshot): void {
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(snapshot.sessions)).toBe(true)
  expect(snapshot.sessions.every(Object.isFrozen)).toBe(true)
}

describe('official DSH session catalog adapter', () => {
  it('returns a detached live-only snapshot when persistence is unavailable', async () => {
    const source = header('live-only', 20, {
      cwd: 'D:\\work',
      parentSession: SessionId('parent'),
      delegationDepth: 1,
      agentPreset: 'researcher',
    })
    const bench = catalogHarness({
      live: [live(source), live(header('no-agent', 10))],
      statuses: new Map([['live-only', 'running']]),
    })

    const snapshot = await bench.catalog.listSessions()

    expect(snapshot).toEqual({
      durability: 'unavailable',
      sessions: [{
        sessionId: 'live-only',
        createdAt: 20,
        cwd: 'D:\\work',
        parentSessionId: 'parent',
        isSubagent: true,
        creationAgentPreset: 'researcher',
        attached: true,
        durablePresence: 'unavailable',
        liveStatus: 'running',
      }, {
        sessionId: 'no-agent',
        createdAt: 10,
        isSubagent: false,
        attached: true,
        durablePresence: 'unavailable',
      }],
    })
    expectDeeplyFrozen(snapshot)
    expect(bench.listLive).toHaveBeenCalledOnce()
    expect(bench.getAgent).toHaveBeenCalledTimes(2)

    ;(source as { cwd?: string }).cwd = 'D:\\mutated'
    bench.live.splice(0)
    expect(snapshot.sessions[0]?.cwd).toBe('D:\\work')
    expect(snapshot.sessions).toHaveLength(2)
  })

  it('reads persistence first, then overlays the post-await live registry', async () => {
    const listing = Promise.withResolvers<SessionHeader[]>()
    const list = vi.fn((_signal?: AbortSignal) => listing.promise)
    const bench = catalogHarness({
      statuses: new Map([
        ['same', 'idle'],
        ['live-new', 'running'],
      ]),
      list,
    })
    const snapshotPromise = bench.catalog.listSessions()

    expect(list).toHaveBeenCalledWith(undefined)
    expect(bench.listLive).not.toHaveBeenCalled()

    const coldSame = header('same', 1, { cwd: 'D:\\cold' })
    const coldA = header('A', 100, { origin: 'subagent' })
    const coldB = header('B', 100)
    const coldLower = header('a', 100, {
      parentSession: SessionId('fork-source'),
      agentPreset: 'cold-preset',
    })
    bench.live.push(
      live(header('same', 300, { cwd: 'D:\\live', agentPreset: 'live-preset' })),
      live(header('live-new', 200)),
    )
    listing.resolve([coldLower, coldSame, coldA, coldB])

    const snapshot = await snapshotPromise

    expect(snapshot).toEqual({
      durability: 'available',
      sessions: [{
        sessionId: 'same',
        createdAt: 300,
        cwd: 'D:\\live',
        isSubagent: false,
        creationAgentPreset: 'live-preset',
        attached: true,
        durablePresence: 'observed',
        liveStatus: 'idle',
      }, {
        sessionId: 'live-new',
        createdAt: 200,
        isSubagent: false,
        attached: true,
        durablePresence: 'not-observed',
        liveStatus: 'running',
      }, {
        sessionId: 'A',
        createdAt: 100,
        isSubagent: true,
        attached: false,
        durablePresence: 'observed',
      }, {
        sessionId: 'B',
        createdAt: 100,
        isSubagent: false,
        attached: false,
        durablePresence: 'observed',
      }, {
        sessionId: 'a',
        createdAt: 100,
        parentSessionId: 'fork-source',
        isSubagent: false,
        creationAgentPreset: 'cold-preset',
        attached: false,
        durablePresence: 'observed',
      }],
    })
    expectDeeplyFrozen(snapshot)
    expect(bench.listLive).toHaveBeenCalledOnce()
    expect(bench.getAgent).toHaveBeenCalledTimes(2)

    ;(coldA as { createdAt: number }).createdAt = 999
    expect(snapshot.sessions[2]?.createdAt).toBe(100)
  })

  it('propagates persistence failures and AbortSignal reasons by identity', async () => {
    const failure = { kind: 'storage-offline' }
    const failedList = vi.fn(() => Promise.reject(failure))
    const failed = catalogHarness({ list: failedList })

    await failed.catalog.listSessions().then(
      () => { throw new Error('expected listSessions to reject') },
      error => { expect(error).toBe(failure) },
    )
    expect(failed.listLive).not.toHaveBeenCalled()

    const beforeReason = { kind: 'cancel-before' }
    const before = new AbortController()
    before.abort(beforeReason)
    await failed.catalog.listSessions({ signal: before.signal }).then(
      () => { throw new Error('expected listSessions to reject') },
      error => { expect(error).toBe(beforeReason) },
    )
    expect(failedList).toHaveBeenCalledTimes(1)

    const listing = Promise.withResolvers<SessionHeader[]>()
    const pendingList = vi.fn((_signal?: AbortSignal) => listing.promise)
    const pending = catalogHarness({ list: pendingList })
    const during = new AbortController()
    const pendingSnapshot = pending.catalog.listSessions({ signal: during.signal })
    expect(pendingList).toHaveBeenCalledWith(during.signal)

    const duringReason = { kind: 'cancel-during' }
    during.abort(duringReason)
    listing.resolve([])
    await pendingSnapshot.then(
      () => { throw new Error('expected listSessions to reject') },
      error => { expect(error).toBe(duringReason) },
    )
    expect(pending.listLive).not.toHaveBeenCalled()
  })

  it('fails clearly when required live registries are unavailable', () => {
    const missingSessions = new Context()
    contexts.push(missingSessions)
    missingSessions.provide('agents', { get: () => undefined } as never)
    expect(() => new DshSessionCatalog(missingSessions)).toThrow(
      'DSH Session service is unavailable',
    )

    const missingAgents = new Context()
    contexts.push(missingAgents)
    missingAgents.provide('sessions', { list: () => [] } as never)
    expect(() => new DshSessionCatalog(missingAgents)).toThrow(
      'DSH Agent service is unavailable',
    )
  })
})
