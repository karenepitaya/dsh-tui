import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, {
  SessionId,
  SessionSeq,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionQueryEngine, { type SessionTitleObservationResult } from '@deepseek-ai/dsh-session-query'
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
    version: 3,
    id: SessionId(id),
    createdAt,
    isSeeded: false,
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
  readonly titles?: (ids: readonly SessionId[], signal?: AbortSignal) => Promise<SessionTitleObservationResult[]>
} = {}): {
  readonly ctx: Context
  readonly records: QueryRecord[]
  readonly listQuery: ReturnType<typeof vi.fn>
  readonly getAgent: ReturnType<typeof vi.fn>
  readonly readTitles: ReturnType<typeof vi.fn>
  readonly catalog: DshSessionCatalog
} {
  const ctx = new Context()
  contexts.push(ctx)
  const records = options.records ?? []
  let observedRecords = records
  const listQuery = vi.fn(async (signal?: AbortSignal) => {
    observedRecords = await (options.list ?? (async () => [...records]))(signal)
    return observedRecords
  })
  const readTitles = vi.fn(options.titles ?? (async () => observedRecords.map(record => ({
    sessionId: record.header.id, status: 'fulfilled' as const, value: { session: record.header },
  }))))
  const getAgent = vi.fn((id: string) => {
    const status = options.statuses?.get(id)
    return status === undefined ? undefined : { status }
  })
  ctx.provide('sessionQuery', { listSessions: listQuery, readTitleSnapshots: readTitles } as never)
  ctx.provide('agents', { get: getAgent } as never)
  if (options.persistenceAvailable === true) {
    ctx.provide('sessionPersistence', {} as never)
  }
  return {
    ctx,
    records,
    listQuery,
    getAgent,
    readTitles,
    catalog: new DshSessionCatalog(ctx),
  }
}

function expectDeeplyFrozen(snapshot: SessionCatalogSnapshot): void {
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(snapshot.sessions)).toBe(true)
  expect(snapshot.sessions.every(Object.isFrozen)).toBe(true)
}

describe('official DSH session query catalog adapter', () => {
  it('keeps missing, rejected and mismatched title observations from hiding the catalog', async () => {
    const entries = ['missing', 'rejected', 'mismatched', 'titled'].map(id => record(header(id, 5), false, true))
    const bench = catalogHarness({ records: entries, titles: async () => [
      { sessionId: SessionId('rejected'), status: 'rejected', reason: new Error('unreadable') },
      { sessionId: SessionId('mismatched'), status: 'fulfilled', value: { session: header('mismatched', 9) } },
      { sessionId: SessionId('titled'), status: 'fulfilled', value: { session: header('titled', 5), title: {
        title: 'Recorded task', updatedAt: 7, eventSeq: SessionSeq(1), messageSeqs: [], source: { kind: 'user' },
      } } },
    ] })
    const result = await bench.catalog.listSessions()
    expect(result.sessions.map(entry => entry.sessionId)).toEqual(entries.map(entry => entry.header.id))
    expect(result.sessions.slice(0, 3).every(entry => entry.titleUnavailable === true)).toBe(true)
    expect(result.sessions[3]).toMatchObject({ title: 'Recorded task', titleUpdatedAt: 7 })
    expect(bench.readTitles).toHaveBeenCalledExactlyOnceWith(entries.map(entry => entry.header.id), undefined)

    bench.readTitles.mockRejectedValueOnce(new Error('batch unavailable'))
    await expect(bench.catalog.listSessions()).resolves.toMatchObject({
      sessions: entries.map(entry => ({ sessionId: entry.header.id, titleUnavailable: true })),
    })
  })

  it.each(['fulfilled', 'rejected'] as const)('preserves cancellation after a %s title batch settles', async (outcome) => {
    const reading = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<SessionTitleObservationResult[]>()
    const bench = catalogHarness({ records: [record(header('a', 1), false, true)], titles: async () => {
      reading.resolve()
      return pending.promise
    } })
    const abort = new AbortController()
    const result = bench.catalog.listSessions({ signal: abort.signal })
    await reading.promise
    const reason = { kind: 'catalog-closed' }
    abort.abort(reason)
    if (outcome === 'fulfilled') pending.resolve([])
    else pending.reject(new Error('backend failure after close'))
    await expect(result).rejects.toBe(reason)
    expect(bench.getAgent).not.toHaveBeenCalled()
  })

  it('reads recorded titles through the official query without creating an Agent or generating text', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(CatalogSessionQuery)
    ctx.provide('agents', { get: () => undefined } as never)
    const session = ctx.sessions.create(SessionId('titled'), { meta: { cwd: 'D:\\work' } })
    session.append('session/title', {
      title: 'Repair clipboard input', messageSeqs: [], source: { kind: 'user' },
    })
    const result = await new DshSessionCatalog(ctx).listSessions()
    expect(result.sessions[0]).toMatchObject({ title: 'Repair clipboard input' })
  })

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

  it('keeps Chat available while the optional SessionQuery service is absent', async () => {
    const missingQuery = new Context()
    contexts.push(missingQuery)
    missingQuery.provide('agents', { get: () => undefined } as never)
    const catalog = new DshSessionCatalog(missingQuery)

    await expect(catalog.listSessions()).resolves.toEqual({
      durability: 'unavailable',
      sessions: [],
    })

    const queryFiber = missingQuery.plugin((queryCtx) => {
      queryCtx.provide('sessionQuery', {
        listSessions: async () => [record(header('late-query', 1), false, true)],
      } as never)
    })
    await queryFiber
    await expect(catalog.listSessions()).resolves.toMatchObject({
      sessions: [{ sessionId: 'late-query' }],
    })

    await queryFiber.dispose()
    await expect(catalog.listSessions()).resolves.toEqual({
      durability: 'unavailable',
      sessions: [],
    })
  })

  it('fails clearly when the required Agent service is unavailable', () => {

    const missingAgents = new Context()
    contexts.push(missingAgents)
    missingAgents.provide('sessionQuery', { listSessions: async () => [] } as never)
    expect(() => new DshSessionCatalog(missingAgents)).toThrow(
      'DSH Agent service is unavailable',
    )
  })
})
