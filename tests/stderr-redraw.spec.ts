import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { installStderrRedraw } from '../src/terminal/stderr-redraw.ts'

function recordingStream() {
  const original = vi.fn(function (this: unknown, ..._args: unknown[]) {
    return false
  })
  const stream = { write: original as Writable['write'] }
  return { stream, original }
}

describe('native stderr redraw observation', () => {
  it('preserves chunk identity, encoding, receiver, backpressure and callback arguments', async () => {
    const { stream, original } = recordingStream()
    const redraw = vi.fn()
    const release = installStderrRedraw(stream, redraw)
    const bytes = Buffer.from([0, 255, 27, 65])
    const receiver = { owner: 'stderr' }
    const callbackReceiver = { owner: 'completion' }
    const callback = vi.fn()
    expect(Reflect.apply(stream.write, receiver, [bytes, 'latin1', callback])).toBe(false)
    expect(original.mock.contexts[0]).toBe(receiver)
    expect(original.mock.calls[0]![0]).toBe(bytes)
    expect(original.mock.calls[0]![1]).toBe('latin1')
    const completion = original.mock.calls[0]![2] as (...args: unknown[]) => void
    const failure = new Error('partial write')
    Reflect.apply(completion, callbackReceiver, [failure, 'detail'])
    expect(callback).toHaveBeenCalledExactlyOnceWith(failure, 'detail')
    expect(callback.mock.contexts[0]).toBe(callbackReceiver)
    expect(redraw).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(redraw).toHaveBeenCalledOnce()
    release()
    expect(stream.write).toBe(original)
  })

  it('observes each Writable overload, including callback-free diagnostics', async () => {
    const { stream, original } = recordingStream()
    const redraw = vi.fn()
    const release = installStderrRedraw(stream, redraw)
    const callback = vi.fn()
    stream.write('one', callback)
    stream.write('two')
    stream.write('three', 'utf8')
    stream.write('four', undefined)
    Reflect.apply(stream.write, stream, ['five', 'utf8', null])
    expect(redraw).not.toHaveBeenCalled()
    for (const args of original.mock.calls) {
      const complete = args.find(arg => typeof arg === 'function') as () => void
      complete()
    }
    expect(callback).toHaveBeenCalledExactlyOnceWith()
    await Promise.resolve()
    expect(redraw).toHaveBeenCalledTimes(5)
    release()
  })

  it.each([false, true])('preserves real Writable error events with caller callback=%s', async hasCallback => {
    const failure = new Error('native write failed')
    const stream = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) { callback(failure) },
    })
    const errorEvent = vi.fn()
    stream.on('error', errorEvent)
    const callback = vi.fn()
    const redraw = vi.fn()
    const release = installStderrRedraw(stream, redraw)
    const result = hasCallback ? stream.write('warning', callback) : stream.write('warning')
    expect(result).toBe(false)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(errorEvent).toHaveBeenCalledExactlyOnceWith(failure)
    if (hasCallback) expect(callback).toHaveBeenCalledExactlyOnceWith(failure)
    else expect(callback).not.toHaveBeenCalled()
    expect(redraw).toHaveBeenCalledOnce()
    release()
  })

  it('leaves invalid arguments and synchronous write failures to Writable', async () => {
    const stream = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    const original = vi.spyOn(stream, 'write')
    const redraw = vi.fn()
    const release = installStderrRedraw(stream, redraw)
    Reflect.apply(stream.write, stream, ['warning', 'utf8', 'invalid'])
    expect(original).toHaveBeenLastCalledWith('warning', 'utf8', 'invalid')
    expect(() => stream.write('warning', 'invalid' as BufferEncoding)).toThrow(/encoding/)
    await Promise.resolve()
    expect(redraw).not.toHaveBeenCalled()
    release()
    stream.destroy()
  })

  it('preserves callback exceptions and still requests an asynchronous repair', async () => {
    const { stream, original } = recordingStream()
    const redraw = vi.fn()
    const release = installStderrRedraw(stream, redraw)
    const failure = new Error('consumer failed')
    stream.write('warning', () => { throw failure })
    const completion = original.mock.calls[0]![1] as () => void
    expect(completion).toThrow(failure)
    expect(redraw).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(redraw).toHaveBeenCalledOnce()
    release()
  })

  it('does not overwrite later owners or redraw after disposal, including late completion', async () => {
    const { stream, original } = recordingStream()
    const redraw = vi.fn()
    const release = installStderrRedraw(stream, redraw)
    const callback = vi.fn()
    stream.write('queued', callback)
    stream.write('late', callback)
    const queued = original.mock.calls[0]![1] as () => void
    const late = original.mock.calls[1]![1] as () => void
    queued()
    const wrapped = stream.write
    const laterOwner: Writable['write'] = function (this: unknown, ...args: unknown[]) {
      return Reflect.apply(wrapped, this, args) as boolean
    }
    stream.write = laterOwner
    release()
    release()
    expect(stream.write).toBe(laterOwner)
    late()
    expect(stream.write('after', callback)).toBe(false)
    expect(original).toHaveBeenLastCalledWith('after', callback)
    expect(callback).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    expect(redraw).not.toHaveBeenCalled()
  })
})
