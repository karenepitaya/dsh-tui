import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, {
  SessionId,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import {
  DshSessionCatalog,
  type SessionCatalogSnapshot,
} from '../src/internal.ts'

interface QueryRecord {
  readonly header: SessionHeader
  readonly live: boolean
  readonly persisted: boolean
}

class CatalogSessionQuery extends SessionQueryEngine {
  override async searchSessions(): Promise<never> {
    throw new Error('full-text search is not used by the catalog contract test')
  }

  override async searchEvents(): Promise<never> {
    throw new Error('full-text search is not used by the catalog contract test')
  }
}

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

function record(
  meta: SessionHeader,
  live: boolean,
  persisted: boolean,
): QueryRecord {
  return { header: meta, live, persisted }
}

function catalogHarness(options: {
  readonly records?: QueryRecord[]
  readonly statuses?: ReadonlyMap<string, Agent['status']>
  readonly list?: (signal?: AbortSignal) => Promise<QueryRecord[]>
  readonly persistenceAvailable?: boolean
} = {}): {
  readonly ctx: Context
  readonly records: QueryRecord[]
  readonly listQuery: ReturnType<typeof vi.fn>
  readonly getAgent: ReturnType<typeof vi.fn>
  readonly catalog: DshSessionCatalog
} {
  const ctx = new Context()
  contexts.push(ctx)
  const records = options.records ?? []
  const listQuery = vi.fn(options.list ?? (async () => [...records]))
  const getAgent = vi.fn((id: string) => {
    const status = options.statuses?.get(id)
    return status === undefined ? undefined : { status }
  })
  ctx.provide('sessionQuery', { listSessions: listQuery } as never)
  ctx.provide('agents', { get: getAgent } as never)
  if (options.persistenceAvailable === true) {
    ctx.provide('sessionPersistence', {} as never)
  }
  return {
    ctx,
    records,
    listQuery,
    getAgent,
    catalog: new DshSessionCatalog(ctx),
  }
}

function expectDeeplyFrozen(snapshot: SessionCatalogSnapshot): void {
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(snapshot.sessions)).toBe(true)
  expect(snapshot.sessions.every(Object.isFrozen)).toBe(true)
}

describe('official DSH session query catalog adapter', () => {
  it('binds to the official SessionQueryEngine service through Cordis', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(CatalogSessionQuery)
    ctx.provide('agents', {
      get: (id: string) => id === 'official-live' ? { status: 'running' } : undefined,
    } as never)
    const session = ctx.sessions.create(SessionId('official-live'), {
      meta: { cwd: 'D:\\official' },
    })

    const catalog = new DshSessionCatalog(ctx)

    await expect(catalog.listSessions()).resolves.toEqual({
      durability: 'unavailable',
      sessions: [{
        sessionId: 'official-live',
        createdAt: session.header.createdAt,
        cwd: 'D:\\official',
        isSubagent: false,
        attached: true,
        durablePresence: 'unavailable',
        liveStatus: 'running',
      }],
    })
  })

  it('projects a detached live-only snapshot when persistence is unavailable', async () => {
    const source = header('live-only', 20, {
      cwd: 'D:\\work',
      parentSession: SessionId('parent'),
      delegationDepth: 1,
      agentPreset: 'researcher',
    })
    const bench = catalogHarness({
      records: [
        record(source, true, false),
        record(header('no-agent', 10), true, false),
      ],
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
    expect(bench.listQuery).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(bench.getAgent).toHaveBeenCalledTimes(2)

    ;(source as { cwd?: string }).cwd = 'D:\\mutated'
    bench.records.splice(0)
    expect(snapshot.sessions[0]?.cwd).toBe('D:\\work')
    expect(snapshot.sessions).toHaveLength(2)
  })

  it('preserves the official query order and overlays only exact live Agent status', async () => {
    const listing = Promise.withResolvers<QueryRecord[]>()
    const list = vi.fn((_signal?: AbortSignal) => listing.promise)
    const bench = catalogHarness({
      statuses: new Map([
        ['same', 'idle'],
        ['live-new', 'running'],
      ]),
      list,
      persistenceAvailable: true,
    })
    const snapshotPromise = bench.catalog.listSessions()

    expect(list).toHaveBeenCalledWith(undefined)
    expect(bench.getAgent).not.toHaveBeenCalled()

    const coldA = header('A', 100, { origin: 'subagent' })
    listing.resolve([
      record(
        header('same', 300, { cwd: 'D:\\live', agentPreset: 'live-preset' }),
        true,
        true,
      ),
      record(header('live-new', 200), true, false),
      record(coldA, false, true),
      record(header('B', 100), false, true),
      record(header('a', 100, {
        parentSession: SessionId('fork-source'),
        agentPreset: 'cold-preset',
      }), false, true),
    ])

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
    expect(bench.getAgent).toHaveBeenCalledTimes(2)

    ;(coldA as { createdAt: number }).createdAt = 999
    expect(snapshot.sessions[2]?.createdAt).toBe(100)
  })

  it('propagates SessionQuery failures and AbortSignal reasons by identity', async () => {
    const failure = { kind: 'query-failed' }
    const failedList = vi.fn(() => Promise.reject(failure))
    const failed = catalogHarness({ list: failedList })

    await failed.catalog.listSessions().then(
      () => { throw new Error('expected listSessions to reject') },
      error => { expect(error).toBe(failure) },
    )

    const beforeReason = { kind: 'cancel-before' }
    const before = new AbortController()
    before.abort(beforeReason)
    await failed.catalog.listSessions({ signal: before.signal }).then(
      () => { throw new Error('expected listSessions to reject') },
      error => { expect(error).toBe(beforeReason) },
    )
    expect(failedList).toHaveBeenCalledTimes(1)

    const listing = Promise.withResolvers<QueryRecord[]>()
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
    expect(pending.getAgent).not.toHaveBeenCalled()
  })

  it('retains observed durable evidence across a non-atomic capability diagnostic', async () => {
    const bench = catalogHarness({
      records: [record(header('persisted-during-query', 1), false, true)],
    })

    await expect(bench.catalog.listSessions()).resolves.toEqual({
      durability: 'unavailable',
      sessions: [{
        sessionId: 'persisted-during-query',
        createdAt: 1,
        isSubagent: false,
        attached: false,
        durablePresence: 'observed',
      }],
    })
    expect(bench.getAgent).not.toHaveBeenCalled()
  })

  it('fails clearly when required SessionQuery or Agent services are unavailable', () => {
    const missingQuery = new Context()
    contexts.push(missingQuery)
    missingQuery.provide('agents', { get: () => undefined } as never)
    expect(() => new DshSessionCatalog(missingQuery)).toThrow(
      'DSH Session query service is unavailable',
    )

    const missingAgents = new Context()
    contexts.push(missingAgents)
    missingAgents.provide('sessionQuery', { listSessions: async () => [] } as never)
    expect(() => new DshSessionCatalog(missingAgents)).toThrow(
      'DSH Agent service is unavailable',
    )
  })
})
