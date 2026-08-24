import { describe, expect, it, vi } from 'vitest'
import { durable } from './fixtures.ts'
import { FakeRuntimePort } from './fakes/fake-runtime.ts'

describe('DshRuntimePort replay/live handoff', () => {
  it('subscribes before replay and yields a handoff append exactly once', async () => {
    const port = new FakeRuntimePort('session-a')
    port.emit(durable(0, {
      type: 'session/observed',
      data: { sourceType: 'session/end-seed', ignorable: false },
    }))
    port.onSubscriberAttached = () => {
      port.onSubscriberAttached = undefined
      port.emit(durable(1, {
        type: 'turn/start',
        data: { turn: 1 },
      }))
    }

    const abort = new AbortController()
    const onCaughtUp = vi.fn()
    const iterator = port.events({
      signal: abort.signal,
      onCaughtUp,
    })[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { seq: 0 } })
    await expect(iterator.next()).resolves.toMatchObject({ value: { seq: 1 } })
    const waiting = iterator.next()
    await vi.waitFor(() => {
      expect(onCaughtUp).toHaveBeenCalledExactlyOnceWith({
        lastSeq: 1,
        status: 'idle',
      })
    })
    abort.abort()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
  })

  it('reports the current runtime status at the fake replay boundary', async () => {
    const port = new FakeRuntimePort('session-a')
    port.emit({
      plane: 'runtime',
      sessionId: 'session-a',
      sourceId: 'live-a',
      ordinal: 0,
      time: 1,
      type: 'agent/status',
      data: { status: 'running' },
    })
    const abort = new AbortController()
    const onCaughtUp = vi.fn()
    const iterator = port.events({
      signal: abort.signal,
      onCaughtUp,
    })[Symbol.asyncIterator]()
    const waiting = iterator.next()

    await vi.waitFor(() => {
      expect(onCaughtUp).toHaveBeenCalledExactlyOnceWith({
        lastSeq: -1,
        status: 'running',
      })
    })
    abort.abort()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
  })

  it('supports cursors, runtime events, delivery, cancellation, flush, and disposal', async () => {
    const port = new FakeRuntimePort('session-a')
    port.emit(durable(0, {
      type: 'session/observed',
      data: { sourceType: 'seed', ignorable: true },
    }))
    const abort = new AbortController()
    const iterator = port.events({ afterSeq: 0, signal: abort.signal })[Symbol.asyncIterator]()
    const nextEvent = iterator.next()
    await Promise.resolve()
    port.emit({
      plane: 'runtime',
      sessionId: 'session-a',
      sourceId: 'live-a',
      ordinal: 0,
      time: 1,
      type: 'agent/created',
      data: { status: 'idle' },
    })
    await expect(nextEvent).resolves.toMatchObject({
      value: { plane: 'runtime', type: 'agent/created' },
    })

    await expect(port.submit({ text: 'one' }, 'followup')).resolves.toEqual({ inputId: 'input-1' })
    await expect(port.submit({ text: 'two' }, 'steer')).resolves.toEqual({ inputId: 'input-2' })
    port.cancel({ kind: 'user' })
    port.cancel({ kind: 'hook', reason: 'test' }, { keepInbox: true })
    await port.whenIdle()
    await port.flush()
    await port.dispose()
    await port.dispose()

    expect(port.submitted).toHaveLength(2)
    expect(port.cancellations).toEqual([
      { cause: { kind: 'user' }, keepInbox: false },
      { cause: { kind: 'hook', reason: 'test' }, keepInbox: true },
    ])
    expect(port.flushCount).toBe(1)
    expect(port.disposeCount).toBe(1)
    await expect(port.submit({ text: 'late' }, 'followup')).rejects.toThrow('runtime is disposed')
    expect(() => port.emit(durable(1, {
      type: 'session/observed',
      data: { sourceType: 'gap', ignorable: true },
    }))).not.toThrow()
    await expect(async () => {
      for await (const _event of port.events()) {
        // unreachable
      }
    }).rejects.toThrow('runtime is disposed')
  })

  it('rejects a non-contiguous fake durable log', () => {
    const port = new FakeRuntimePort('session-a')
    expect(() => port.emit(durable(2, {
      type: 'session/observed',
      data: { sourceType: 'bad', ignorable: true },
    }))).toThrow('fake durable seq must be 0')
  })
})
