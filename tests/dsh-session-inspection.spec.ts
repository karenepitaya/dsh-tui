import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  SessionId,
  type SessionEvent,
  type SessionHeader,
  type SessionId as OfficialSessionId,
} from '@deepseek-ai/dsh-session'
import {
  DshSessionInspection,
  SESSION_INSPECTION_COPY_BATCH,
  SessionInspectionError,
  type SessionInspectionSnapshot,
} from '../src/internal.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function header(
  id: string,
  createdAt = 1,
  extra: Partial<SessionHeader> = {},
): SessionHeader {
  return {
    version: 0,
    id: SessionId(id),
    createdAt,
    ...extra,
  }
}

function inspectionHarness(
  inspectImplementation: (
    id: OfficialSessionId,
    signal?: AbortSignal,
  ) => Promise<{ readonly meta: SessionHeader; readonly events: readonly SessionEvent[] }>,
): {
  readonly adapter: DshSessionInspection
  readonly inspect: ReturnType<typeof vi.fn>
  readonly load: ReturnType<typeof vi.fn>
  readonly prepare: ReturnType<typeof vi.fn>
  readonly resume: ReturnType<typeof vi.fn>
} {
  const ctx = new Context()
  contexts.push(ctx)
  const inspect = vi.fn(inspectImplementation)
  const load = vi.fn(() => Promise.reject(new Error('load must not be called')))
  const prepare = vi.fn(() => Promise.reject(new Error('prepare must not be called')))
  const resume = vi.fn(() => Promise.reject(new Error('resume must not be called')))
  ctx.provide('sessionPersistence', { inspect, load, prepare } as never)
  ctx.provide('agents', { resume } as never)
  return {
    adapter: new DshSessionInspection(ctx),
    inspect,
    load,
    prepare,
    resume,
  }
}

function expectDeeplyFrozen(snapshot: SessionInspectionSnapshot): void {
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(snapshot.header)).toBe(true)
  expect(Object.isFrozen(snapshot.events)).toBe(true)
  expect(snapshot.events.every(event => (
    Object.isFrozen(event)
    && Object.isFrozen(event.data)
    && (event.sourceEventSeqs === undefined || Object.isFrozen(event.sourceEventSeqs))
  ))).toBe(true)
}

describe('official DSH session inspection adapter', () => {
  it('inspects the exact id, converts every event, and returns a detached frozen snapshot', async () => {
    const meta = header('inspection-rich', 42, {
      cwd: 'D:\\work',
      parentSession: SessionId('parent'),
      seedLength: 2,
      delegationDepth: 1,
      agentPreset: 'researcher',
    })
    const startData = { turn: 1 }
    const nestedChunk = {
      type: 'text-delta',
      index: 0,
      text: 'original',
    }
    const chunkData = { turn: 1, step: 1, chunk: nestedChunk }
    const events = [{
      type: 'turn/start',
      seq: 0,
      time: 10,
      data: startData,
      sourceEventSeqs: [7],
    }, {
      type: 'assistant/chunk',
      seq: 1,
      time: 11,
      data: chunkData,
    }, {
      type: 'turn/end',
      seq: 2,
      time: 12,
      data: { turn: 1, reason: { kind: 'completed' } },
    }] as unknown as SessionEvent[]
    const bench = inspectionHarness(() => Promise.resolve({ meta, events }))
    const abort = new AbortController()

    const snapshot = await bench.adapter.inspectSession({
      sessionId: 'inspection-rich',
      signal: abort.signal,
    })

    expect(bench.inspect).toHaveBeenCalledExactlyOnceWith(
      SessionId('inspection-rich'),
      abort.signal,
    )
    expect(snapshot).toEqual({
      header: {
        sessionId: 'inspection-rich',
        createdAt: 42,
        cwd: 'D:\\work',
        parentSessionId: 'parent',
        seedLength: 2,
        isSubagent: true,
        delegationDepth: 1,
        creationAgentPreset: 'researcher',
      },
      events: [{
        plane: 'durable',
        sessionId: 'inspection-rich',
        seq: 0,
        time: 10,
        sourceEventSeqs: [7],
        type: 'turn/start',
        data: { turn: 1 },
      }, {
        plane: 'durable',
        sessionId: 'inspection-rich',
        seq: 1,
        time: 11,
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: {
            type: 'text-delta',
            index: 0,
            text: 'original',
          },
        },
      }, {
        plane: 'durable',
        sessionId: 'inspection-rich',
        seq: 2,
        time: 12,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      }],
    })
    expectDeeplyFrozen(snapshot)
    const frozenChunk = (
      snapshot.events[1]?.data as unknown as {
        readonly chunk: {
          readonly text: string
        }
      }
    ).chunk
    expect(Object.isFrozen(frozenChunk)).toBe(true)
    expect(() => { (frozenChunk as { text: string }).text = 'mutated' }).toThrow(TypeError)
    expect(Object.isFrozen(meta)).toBe(false)
    expect(Object.isFrozen(startData)).toBe(false)
    expect(Object.isFrozen(chunkData)).toBe(false)

    ;(meta as { cwd?: string }).cwd = 'D:\\mutated'
    startData.turn = 99
    nestedChunk.text = 'mutated'
    ;(chunkData as { chunk: unknown }).chunk = { text: 'mutated' }
    events.splice(0)
    expect(snapshot.header.cwd).toBe('D:\\work')
    expect(snapshot.events).toHaveLength(3)
    expect(snapshot.events[0]?.data).toEqual({ turn: 1 })
    expect(snapshot.events[1]?.data).toEqual({
      turn: 1,
      step: 1,
      chunk: {
        type: 'text-delta',
        index: 0,
        text: 'original',
      },
    })
    expect(bench.load).not.toHaveBeenCalled()
    expect(bench.prepare).not.toHaveBeenCalled()
    expect(bench.resume).not.toHaveBeenCalled()
  })

  it('returns a frozen minimal root snapshot and preserves upstream failure identity', async () => {
    const failure = { kind: 'storage-offline' }
    const bench = inspectionHarness(vi.fn()
      .mockResolvedValueOnce({ meta: header('minimal'), events: [] })
      .mockRejectedValueOnce(failure))

    const snapshot = await bench.adapter.inspectSession({
      sessionId: 'minimal',
      signal: new AbortController().signal,
    })
    expect(snapshot).toEqual({
      header: {
        sessionId: 'minimal',
        createdAt: 1,
        isSubagent: false,
      },
      events: [],
    })
    expectDeeplyFrozen(snapshot)

    await bench.adapter.inspectSession({
      sessionId: 'minimal',
      signal: new AbortController().signal,
    }).then(
      () => { throw new Error('expected inspectSession to reject') },
      error => { expect(error).toBe(failure) },
    )
    expect(bench.load).not.toHaveBeenCalled()
    expect(bench.prepare).not.toHaveBeenCalled()
    expect(bench.resume).not.toHaveBeenCalled()
  })

  it('preserves AbortSignal reasons before and after official inspection', async () => {
    const inspected = Promise.withResolvers<{
      readonly meta: SessionHeader
      readonly events: readonly SessionEvent[]
    }>()
    const bench = inspectionHarness(() => inspected.promise)

    const before = new AbortController()
    const beforeReason = { kind: 'cancel-before' }
    before.abort(beforeReason)
    await bench.adapter.inspectSession({
      sessionId: 'abort-before',
      signal: before.signal,
    }).then(
      () => { throw new Error('expected pre-aborted inspection to reject') },
      error => { expect(error).toBe(beforeReason) },
    )
    expect(bench.inspect).not.toHaveBeenCalled()

    const after = new AbortController()
    const pending = bench.adapter.inspectSession({
      sessionId: 'abort-after',
      signal: after.signal,
    })
    expect(bench.inspect).toHaveBeenCalledExactlyOnceWith(
      SessionId('abort-after'),
      after.signal,
    )
    const afterReason = new Error('cancel after inspect')
    after.abort(afterReason)
    inspected.resolve({ meta: header('abort-after'), events: [] })
    await pending.then(
      () => { throw new Error('expected post-aborted inspection to reject') },
      error => { expect(error).toBe(afterReason) },
    )
  })

  it('yields during large snapshot copying and preserves cancellation identity', async () => {
    const events = Array.from({ length: SESSION_INSPECTION_COPY_BATCH + 1 }, (_, seq) => ({
      type: 'turn/start',
      seq,
      time: seq,
      data: { turn: seq },
    })) as unknown as SessionEvent[]
    const bench = inspectionHarness(() => Promise.resolve({
      meta: header('abort-copy'),
      events,
    }))
    const abort = new AbortController()
    const reason = { kind: 'cancel-during-copy' }
    const pending = bench.adapter.inspectSession({
      sessionId: 'abort-copy',
      signal: abort.signal,
    })
    setImmediate(() => { abort.abort(reason) })

    await pending.then(
      () => { throw new Error('expected copying inspection to reject') },
      error => { expect(error).toBe(reason) },
    )
    expect(bench.load).not.toHaveBeenCalled()
    expect(bench.prepare).not.toHaveBeenCalled()
    expect(bench.resume).not.toHaveBeenCalled()
  })

  it('fails closed on an inspection header id mismatch', async () => {
    const bench = inspectionHarness(() => Promise.resolve({
      meta: header('wrong-id'),
      events: [null as never],
    }))

    await bench.adapter.inspectSession({
      sessionId: 'requested-id',
      signal: new AbortController().signal,
    }).then(
      () => { throw new Error('expected identity mismatch to reject') },
      error => {
        expect(error).toBeInstanceOf(SessionInspectionError)
        expect(error).toMatchObject({
          code: 'identity-mismatch',
          message: 'inspected session "wrong-id" does not match "requested-id"',
        })
      },
    )
    expect(bench.load).not.toHaveBeenCalled()
    expect(bench.prepare).not.toHaveBeenCalled()
    expect(bench.resume).not.toHaveBeenCalled()
  })

  it('classifies only an unavailable persistence capability as an adapter error', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new DshSessionInspection(ctx)

    await adapter.inspectSession({
      sessionId: 'unavailable',
      signal: new AbortController().signal,
    }).then(
      () => { throw new Error('expected unavailable inspection to reject') },
      error => {
        expect(error).toBeInstanceOf(SessionInspectionError)
        expect(error).toMatchObject({
          code: 'unavailable',
          message: 'DSH Session persistence service is unavailable',
        })
      },
    )
  })
})
