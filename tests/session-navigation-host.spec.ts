import { describe, expect, it, vi } from 'vitest'
import { SessionNavigationHost } from '../src/app/session-navigation-host.ts'

describe('application Session navigation host', () => {
  const request = () => ({
    kind: 'activate' as const, sessionId: 'next', intent: 'attach-live' as const,
    signal: new AbortController().signal,
  })

  it('isolates bindings and refuses inactive, busy, and aborted work', async () => {
    const host = new SessionNavigationHost()
    const other = new SessionNavigationHost()
    expect(host.snapshot()).toEqual({ busy: true })
    expect(host.cancelPending(new Error('nothing pending'))).toBe(false)
    await expect(host.navigate(request())).rejects.toThrow('unavailable')
    const navigate = vi.fn(async () => {})
    const port = { snapshot: () => ({ sessionId: 'first', busy: false }), navigate }
    const stop = host.bind(port)
    expect(() => host.bind(port)).toThrow('already bound')
    expect(other.snapshot()).toEqual({ busy: true })
    await host.navigate(request())
    expect(navigate).toHaveBeenCalledOnce()
    expect(host.cancelPending(new Error('already settled'))).toBe(false)
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    await expect(host.navigate({ ...request(), signal: abort.signal })).rejects.toThrow('cancelled')
    stop()
    stop()
    expect(host.snapshot()).toEqual({ busy: true })
    host.bind({ ...port, snapshot: () => ({ busy: true }) })
    await expect(host.navigate(request())).rejects.toThrow('busy')
  })

  it('cancels an in-flight operation when its Controller is unbound and does not affect a replacement', async () => {
    const host = new SessionNavigationHost()
    let signal: AbortSignal | undefined
    let release!: () => void
    const stop = host.bind({
      snapshot: () => ({ sessionId: 'old', busy: false }),
      navigate: async request => { signal = request.signal; await new Promise<void>(resolve => { release = resolve }) },
    })
    const owner = new AbortController()
    const cancel = vi.fn((reason: unknown) => { owner.abort(reason) })
    const task = host.navigate({
      ...request(), signal: owner.signal, cancellation: { cancel },
    })
    expect(host.snapshot().busy).toBe(true)
    await expect(host.navigate(request())).rejects.toThrow('busy')
    stop()
    expect(cancel).toHaveBeenCalledOnce()
    expect(owner.signal.aborted).toBe(true)
    expect(signal?.aborted).toBe(true)
    host.bind({ snapshot: () => ({ sessionId: 'new', busy: false }), navigate: async () => {} })
    release()
    await expect(task).rejects.toThrow('unbound')
    expect(host.snapshot()).toEqual({ sessionId: 'new', busy: false })
    await host.navigate(request())
  })

  it('contains throwing cancellation sinks during explicit cancellation and unbind', async () => {
    const first = new SessionNavigationHost()
    const firstPending = Promise.withResolvers<void>()
    first.bind({
      snapshot: () => ({ sessionId: 'first', busy: false }),
      navigate: async () => { await firstPending.promise },
    })
    const firstTask = first.navigate({
      ...request(),
      cancellation: { cancel: () => { throw new Error('sink failed') } },
    })
    expect(first.cancelPending(new Error('Shell cancelled'))).toBe(false)
    firstPending.resolve()
    await firstTask

    const second = new SessionNavigationHost()
    const secondPending = Promise.withResolvers<void>()
    let forwardedSignal: AbortSignal | undefined
    const stop = second.bind({
      snapshot: () => ({ sessionId: 'second', busy: false }),
      navigate: async navigation => {
        forwardedSignal = navigation.signal
        await secondPending.promise
      },
    })
    const secondTask = second.navigate({
      ...request(),
      cancellation: { cancel: () => { throw new Error('unbind sink failed') } },
    })
    stop()
    expect(forwardedSignal?.aborted).toBe(true)
    secondPending.resolve()
    await expect(secondTask).rejects.toThrow('unbound')
  })

  it('propagates a Shell cancellation to the pending request owner', async () => {
    const host = new SessionNavigationHost()
    const pending = Promise.withResolvers<void>()
    let forwardedSignal: AbortSignal | undefined
    host.bind({
      snapshot: () => ({ sessionId: 'current', busy: false }),
      navigate: async request => {
        forwardedSignal = request.signal
        await pending.promise
      },
    })
    const owner = new AbortController()
    const task = host.navigate({
      ...request(),
      signal: owner.signal,
      cancellation: { cancel: reason => { owner.abort(reason) } },
    })
    const reason = new Error('cancelled from Shell')

    expect(host.cancelPending(reason)).toBe(true)
    expect(host.cancelPending(reason)).toBe(false)
    expect(owner.signal.aborted).toBe(true)
    expect(forwardedSignal?.aborted).toBe(true)

    pending.resolve()
    await expect(task).rejects.toThrow('cancelled from Shell')
    expect(host.snapshot()).toEqual({ sessionId: 'current', busy: false })
  })
})
