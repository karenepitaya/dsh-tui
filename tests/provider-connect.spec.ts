import { describe, expect, it, vi } from 'vitest'
import {
  ProviderAuthorizationDeclinedError,
  type ProviderAuthorizationInteraction,
  type ProviderConnectionEntry,
  type ProviderConnectionPort,
  type ProviderConnectionSnapshot,
} from '../src/provider/port.ts'
import { ProviderConnectController } from '../src/provider/connect-controller.ts'
import { renderProviderConnectFrame } from '../src/ui/frame.ts'

const deepseek = (overrides: Partial<ProviderConnectionEntry> = {}): ProviderConnectionEntry => ({
  id: 'deepseek-official',
  name: 'DeepSeek',
  active: true,
  configured: true,
  connected: false,
  credential: { kind: 'missing', configured: false, writable: true },
  methods: [{ id: 'api-key', label: 'Enter API key' }],
  canDisconnect: false,
  ...overrides,
})

const anthropic = (overrides: Partial<ProviderConnectionEntry> = {}): ProviderConnectionEntry => ({
  id: 'anthropic',
  name: 'Anthropic',
  active: false,
  configured: false,
  connected: false,
  credential: { kind: 'missing', configured: false, writable: true },
  methods: [
    { id: 'oauth', label: 'Sign in with Anthropic' },
    { id: 'api-key', label: 'Enter API key' },
  ],
  canDisconnect: false,
  ...overrides,
})

function snapshot(providers: readonly ProviderConnectionEntry[]): ProviderConnectionSnapshot {
  return { providers, writable: true }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function drain(controller: ProviderConnectController): Promise<void> {
  do {
    await controller.waitForIdle()
    await settle()
  } while (controller.pendingCount > 0)
}

describe('ProviderConnectController', () => {
  it('navigates the directory and complete details without starting an authorization flow', async () => {
    let viewport = { columns: 80, rows: 8 }
    const port: ProviderConnectionPort = {
      list: vi.fn(async () => snapshot([deepseek({ credential: { kind: 'reference', configured: true, writable: true, source: 'Long source details '.repeat(200) } }), anthropic()])),
      connect: vi.fn(async () => ({ status: 'connected' as const })),
      disconnect: vi.fn(async () => undefined), onChanged: vi.fn(() => () => undefined),
    }
    const controller = new ProviderConnectController(port, vi.fn(), () => viewport)
    controller.open()
    await drain(controller)
    expect(controller.view()?.navigation?.focus).toBe('list')
    controller.handleInput({ type: 'page-up' })
    controller.handleInput({ type: 'insert', text: 'j' })
    expect(controller.view()?.selectedProviderIndex).toBe(1)
    controller.handleInput({ type: 'insert', text: 'k' })
    controller.handleInput({ type: 'insert', text: 'l' })
    expect(controller.view()?.navigation?.focus).toBe('details')
    controller.handleInput({ type: 'page-down' })
    expect(controller.view()?.navigation?.detailOffset).toBeGreaterThan(0)
    for (let index = 0; index < 100; index += 1) controller.handleInput({ type: 'page-down' })
    const bottom = controller.view()!.navigation!.detailOffset
    controller.handleInput({ type: 'move-up' })
    expect(controller.view()?.navigation?.detailOffset).toBe(bottom - 1)
    viewport = { columns: 140, rows: 16 }
    controller.handleInput({ type: 'page-down' })
    expect(controller.view()!.navigation!.detailOffset).toBeLessThan(bottom)
    controller.handleInput({ type: 'complete', reverse: true })
    expect(controller.view()?.navigation?.focus).toBe('list')
    controller.handleInput({ type: 'insert', text: 'd', paste: true })
    expect(controller.view()?.stage).toBe('providers')
    expect(port.connect).not.toHaveBeenCalled()
    expect(port.disconnect).not.toHaveBeenCalled()
    controller.handleInput({ type: 'escape' })
    expect(controller.view()).toBeUndefined()
  })
  it('drives an official secret authorization without rendering or logging the secret', async () => {
    let current = snapshot([deepseek(), anthropic()])
    let interaction: ProviderAuthorizationInteraction | undefined
    const promptStarted = deferred<void>()
    const connect = vi.fn(async (
      provider: string,
      method: string,
      surface: ProviderAuthorizationInteraction,
    ) => {
      expect(provider).toBe('anthropic')
      expect(method).toBe('api-key')
      interaction = surface
      surface.notify({ message: 'Use the official Anthropic authorization flow' })
      promptStarted.resolve()
      const key = await surface.prompt({ kind: 'secret', message: 'Anthropic API key' })
      expect(key).toBe('sk-super-secret')
      current = snapshot([deepseek(), anthropic({
        active: true,
        configured: true,
        connected: true,
        credential: { kind: 'api-key', configured: true, writable: true },
        canDisconnect: true,
      })])
      return { status: 'connected' as const }
    })
    const port: ProviderConnectionPort = {
      list: vi.fn(async () => current),
      connect,
      disconnect: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
    }
    const controller = new ProviderConnectController(port, vi.fn())

    controller.open()
    await controller.waitForIdle()
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'submit' })
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'submit' })
    await promptStarted.promise
    await settle()

    expect(interaction).toBeDefined()
    controller.handleInput({ type: 'insert', text: 'sk-super-secret' })
    const frame = renderProviderConnectFrame(controller.view()!, { columns: 100, rows: 12 })
    expect(frame.lines.join('\n')).not.toContain('sk-super-secret')
    expect(frame.lines.join('\n')).toContain('••••')

    controller.handleInput({ type: 'submit' })
    await controller.waitForIdle()
    expect(connect).toHaveBeenCalledOnce()
    expect(controller.view()?.providers[1]?.connected).toBe(true)
  })

  it('declines a pending official prompt and cancels the attempt', async () => {
    const declined = deferred<void>()
    const port: ProviderConnectionPort = {
      list: vi.fn(async () => snapshot([anthropic({ methods: [{ id: 'oauth', label: 'OAuth' }] })])),
      connect: vi.fn(async (_provider, _method, surface) => {
        try {
          await surface.prompt({ kind: 'text', message: 'Paste browser code' })
        } catch (error) {
          expect(error).toBeInstanceOf(ProviderAuthorizationDeclinedError)
          declined.resolve()
          return { status: 'cancelled' as const }
        }
        throw new Error('prompt unexpectedly resolved')
      }),
      disconnect: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
    }
    const controller = new ProviderConnectController(port, vi.fn())

    controller.open()
    await controller.waitForIdle()
    controller.handleInput({ type: 'submit' })
    controller.handleInput({ type: 'submit' })
    await settle()
    controller.handleInput({ type: 'escape' })
    await declined.promise
    await controller.waitForIdle()

    expect(controller.view()?.stage).toBe('providers')
    expect(controller.view()?.notice).toContain('cancelled')
  })

  it('queues topology refreshes, retains selection by id, and disposes the subscription', async () => {
    const first = deferred<ProviderConnectionSnapshot>()
    const second = deferred<ProviderConnectionSnapshot>()
    let changed: (() => void) | undefined
    const stop = vi.fn()
    const list = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const port: ProviderConnectionPort = {
      list,
      connect: vi.fn(async () => ({ status: 'connected' as const })),
      disconnect: vi.fn(async () => undefined),
      onChanged: vi.fn((listener) => {
        changed = listener
        return stop
      }),
    }
    const invalidate = vi.fn()
    const controller = new ProviderConnectController(port, invalidate)

    expect(controller.view()).toBeUndefined()
    expect(controller.isOpen).toBe(false)
    controller.handleInput({ type: 'submit' })
    controller.open()
    controller.open()
    expect(controller.isOpen).toBe(true)
    expect(controller.pendingCount).toBe(1)
    expect(controller.view()?.loading).toBe(true)
    await settle()
    changed?.()
    changed?.()
    expect(list).toHaveBeenCalledOnce()

    first.resolve(snapshot([deepseek(), anthropic()]))
    for (let attempt = 0; attempt < 5 && list.mock.calls.length < 2; attempt += 1) {
      await settle()
    }
    expect(list).toHaveBeenCalledTimes(2)
    controller.handleInput({ type: 'move-down' })
    second.resolve(snapshot([anthropic()]))
    await drain(controller)

    expect(controller.view()?.providers.map(item => item.id)).toEqual(['anthropic'])
    expect(controller.view()?.selectedProviderIndex).toBe(0)
    controller.close()
    controller.close()
    expect(stop).toHaveBeenCalledOnce()
    expect(controller.view()).toBeUndefined()
    const calls = list.mock.calls.length
    changed?.()
    expect(list).toHaveBeenCalledTimes(calls)

    controller.open()
    controller.quiesce()
    expect(controller.isOpen).toBe(false)
    expect(invalidate).toHaveBeenCalled()
  })

  it('reports directory failures and suppresses stale refresh settlements after close', async () => {
    const stale = deferred<ProviderConnectionSnapshot>()
    const staleFailure = deferred<ProviderConnectionSnapshot>()
    const list = vi.fn()
      .mockImplementationOnce(() => { throw new Error('offline') })
      .mockRejectedValueOnce('wire-down')
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(staleFailure.promise)
    const port: ProviderConnectionPort = {
      list,
      connect: vi.fn(async () => ({ status: 'connected' as const })),
      disconnect: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
    }
    const controller = new ProviderConnectController(port, vi.fn())

    controller.open()
    await drain(controller)
    expect(controller.view()?.error).toBe('Provider directory unavailable: offline')
    controller.handleInput({ type: 'insert', text: 'R' })
    await drain(controller)
    expect(controller.view()?.error).toBe('Provider directory unavailable: wire-down')
    controller.handleInput({ type: 'insert', text: 'r' })
    await settle()
    controller.close('test close')
    stale.resolve(snapshot([anthropic()]))
    await drain(controller)
    expect(controller.view()).toBeUndefined()

    controller.open()
    await settle()
    controller.close('second close')
    staleFailure.reject(new Error('late failure'))
    await drain(controller)
    expect(controller.view()).toBeUndefined()
  })

  it('covers empty, methodless, and bounded provider navigation states', async () => {
    let current = snapshot([])
    let changed: (() => void) | undefined
    const port: ProviderConnectionPort = {
      list: vi.fn(async () => current),
      connect: vi.fn(async () => ({ status: 'connected' as const })),
      disconnect: vi.fn(async () => undefined),
      onChanged: vi.fn((listener) => {
        changed = listener
        return () => undefined
      }),
    }
    const controller = new ProviderConnectController(port, vi.fn())
    controller.open()
    await drain(controller)

    controller.handleInput({ type: 'move-up' })
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toBe('No Provider is available')
    controller.handleInput({ type: 'insert', text: 'd' })
    expect(controller.view()?.error).toBe('No Provider is available')
    controller.handleInput({ type: 'insert', text: 'x' })
    controller.handleInput({ type: 'ignored' })

    current = snapshot([
      deepseek({ methods: [] }),
      anthropic(),
    ])
    changed?.()
    await drain(controller)
    controller.handleInput({ type: 'move-up' })
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toContain('exposes no connection method')
    controller.handleInput({ type: 'insert', text: 'd' })
    expect(controller.view()?.error).toContain('no removable local connection')

    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.stage).toBe('methods')
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'move-down' })
    expect(controller.view()?.selectedMethodIndex).toBe(1)
    controller.handleInput({ type: 'move-up' })
    expect(controller.view()?.selectedMethodIndex).toBe(0)
    current = snapshot([anthropic({ methods: [] })])
    changed?.()
    await drain(controller)
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.stage).toBe('methods')
    current = snapshot([])
    changed?.()
    await drain(controller)
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.stage).toBe('methods')
    controller.handleInput({ type: 'escape' })
    expect(controller.view()?.stage).toBe('providers')
    controller.handleInput({ type: 'interrupt' })
    expect(controller.isOpen).toBe(false)
  })

  it('confirms disconnect, reports failures, and handles a provider disappearing before confirmation', async () => {
    let current = snapshot([anthropic({
      active: true,
      configured: true,
      connected: true,
      credential: { kind: 'oauth', configured: true, writable: true },
      canDisconnect: true,
    })])
    let changed: (() => void) | undefined
    const disconnect = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => { throw new Error('locked') })
      .mockRejectedValueOnce('denied')
    const port: ProviderConnectionPort = {
      list: vi.fn(async () => current),
      connect: vi.fn(async () => ({ status: 'connected' as const })),
      disconnect,
      onChanged: vi.fn((listener) => {
        changed = listener
        return () => undefined
      }),
    }
    const controller = new ProviderConnectController(port, vi.fn())
    controller.open()
    await drain(controller)

    controller.handleInput({ type: 'insert', text: 'd' })
    expect(controller.view()?.stage).toBe('confirm-disconnect')
    controller.handleInput({ type: 'ignored' })
    controller.handleInput({ type: 'escape' })
    controller.handleInput({ type: 'insert', text: 'd' })
    controller.handleInput({ type: 'submit' })
    await drain(controller)
    expect(controller.view()?.notice).toContain('disconnected locally')

    controller.handleInput({ type: 'insert', text: 'd' })
    controller.handleInput({ type: 'submit' })
    await drain(controller)
    expect(controller.view()?.error).toBe('Disconnect failed: locked')

    controller.handleInput({ type: 'insert', text: 'd' })
    controller.handleInput({ type: 'submit' })
    await drain(controller)
    expect(controller.view()?.error).toBe('Disconnect failed: denied')

    controller.handleInput({ type: 'insert', text: 'd' })
    current = snapshot([])
    changed?.()
    await drain(controller)
    controller.handleInput({ type: 'submit' })
    expect(disconnect).toHaveBeenCalledTimes(3)
    controller.handleInput({ type: 'interrupt' })
    expect(controller.view()?.stage).toBe('providers')
  })

  it('reports connected, cancelled, Error, and non-Error connection settlements', async () => {
    const connect = vi.fn()
      .mockResolvedValueOnce({ status: 'connected' as const })
      .mockResolvedValueOnce({ status: 'cancelled' as const })
      .mockImplementationOnce(() => { throw new Error('bad grant') })
      .mockRejectedValueOnce('bad wire')
    const port: ProviderConnectionPort = {
      list: vi.fn(async () => snapshot([deepseek()])),
      connect,
      disconnect: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
    }
    const controller = new ProviderConnectController(port, vi.fn())
    controller.open()
    await drain(controller)

    for (const expected of [
      'DeepSeek connected',
      'DeepSeek connection cancelled',
      'Connection failed: bad grant',
      'Connection failed: bad wire',
    ]) {
      controller.handleInput({ type: 'submit' })
      controller.handleInput({ type: 'submit' })
      await drain(controller)
      expect(controller.view()?.notice ?? controller.view()?.error).toBe(expected)
    }
  })

  it('aborts a working connection and ignores late notices and prompts after close', async () => {
    const pending = deferred<{ readonly status: 'cancelled' }>()
    let interaction: ProviderAuthorizationInteraction | undefined
    let signal: AbortSignal | undefined
    const port: ProviderConnectionPort = {
      list: vi.fn(async () => snapshot([deepseek()])),
      connect: vi.fn((_provider, _method, surface, options) => {
        interaction = surface
        signal = options?.signal
        return pending.promise
      }),
      disconnect: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
    }
    const controller = new ProviderConnectController(port, vi.fn())
    controller.open()
    await drain(controller)
    controller.handleInput({ type: 'submit' })
    controller.handleInput({ type: 'submit' })
    await settle()
    expect(controller.pendingCount).toBe(1)

    controller.handleInput({ type: 'ignored' })
    controller.handleInput({ type: 'escape' })
    controller.handleInput({ type: 'interrupt' })
    expect(signal?.aborted).toBe(true)
    expect(controller.view()?.notice).toBe('Cancelling Provider connection')
    controller.close()
    interaction?.notify({ message: 'late' })
    await expect(interaction?.prompt({ kind: 'text', message: 'late code' }))
      .rejects.toBeInstanceOf(ProviderAuthorizationDeclinedError)
    pending.reject(new Error('cancelled by signal'))
    await drain(controller)
    expect(controller.view()).toBeUndefined()

    const late = deferred<{ readonly status: 'connected' }>()
    const lateController = new ProviderConnectController({
      ...port,
      connect: vi.fn(() => late.promise),
    }, vi.fn())
    lateController.open()
    await drain(lateController)
    lateController.handleInput({ type: 'submit' })
    lateController.handleInput({ type: 'submit' })
    await settle()
    lateController.close()
    late.resolve({ status: 'connected' })
    await drain(lateController)
    expect(lateController.view()).toBeUndefined()
  })

  it('aborts a disconnect and suppresses a late successful settlement after close', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const signals: AbortSignal[] = []
    const connected = anthropic({
      active: true,
      configured: true,
      connected: true,
      credential: { kind: 'oauth', configured: true, writable: true },
      canDisconnect: true,
    })
    const disconnect = vi.fn((_provider: string, options?: { readonly signal?: AbortSignal }) => {
      if (options?.signal !== undefined) signals.push(options.signal)
      return disconnect.mock.calls.length === 1 ? first.promise : second.promise
    })
    const port: ProviderConnectionPort = {
      list: vi.fn(async () => snapshot([connected])),
      connect: vi.fn(async () => ({ status: 'connected' as const })),
      disconnect,
      onChanged: vi.fn(() => () => undefined),
    }
    const controller = new ProviderConnectController(port, vi.fn())
    controller.open()
    await drain(controller)

    controller.handleInput({ type: 'insert', text: 'd' })
    controller.handleInput({ type: 'submit' })
    await settle()
    controller.handleInput({ type: 'ignored' })
    controller.handleInput({ type: 'escape' })
    expect(signals[0]?.aborted).toBe(true)
    first.reject(new Error('aborted disconnect'))
    await drain(controller)
    expect(controller.view()?.error).toBeUndefined()

    controller.handleInput({ type: 'insert', text: 'd' })
    controller.handleInput({ type: 'submit' })
    await settle()
    controller.close()
    second.resolve()
    await drain(controller)
    expect(controller.view()).toBeUndefined()
  })

  it('routes text editor actions, validates blank answers, and handles withdrawn prompts', async () => {
    const promptAbort = new AbortController()
    const answerSeen = deferred<string>()
    const port: ProviderConnectionPort = {
      list: vi.fn(async () => snapshot([deepseek()])),
      connect: vi.fn(async (_provider, _method, surface) => {
        const answer = await surface.prompt({
          kind: 'text',
          message: 'Paste browser code',
          signal: promptAbort.signal,
        })
        answerSeen.resolve(answer)
        return { status: 'connected' as const }
      }),
      disconnect: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
    }
    const controller = new ProviderConnectController(port, vi.fn())
    controller.open()
    await drain(controller)
    controller.handleInput({ type: 'submit' })
    controller.handleInput({ type: 'submit' })
    await settle()

    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toBe('Answer cannot be blank')
    controller.handleInput({ type: 'newline' })
    controller.handleInput({ type: 'insert', text: ' abc ' })
    controller.handleInput({ type: 'move-left' })
    controller.handleInput({ type: 'move-right' })
    controller.handleInput({ type: 'move-home' })
    controller.handleInput({ type: 'move-end' })
    controller.handleInput({ type: 'backspace' })
    controller.handleInput({ type: 'move-home' })
    controller.handleInput({ type: 'delete' })
    controller.handleInput({ type: 'move-end' })
    controller.handleInput({ type: 'submit' })
    await expect(answerSeen.promise).resolves.toBe('abc')
    await drain(controller)

    const withdrawn = deferred<void>()
    const withdrawingPort: ProviderConnectionPort = {
      ...port,
      connect: vi.fn(async (_provider, _method, surface) => {
        await expect(surface.prompt({
          kind: 'text', message: 'Temporary', signal: promptAbort.signal,
        })).rejects.toThrow('withdrawn')
        withdrawn.resolve()
        return { status: 'cancelled' as const }
      }),
    }
    const withdrawing = new ProviderConnectController(withdrawingPort, vi.fn())
    withdrawing.open()
    await drain(withdrawing)
    withdrawing.handleInput({ type: 'submit' })
    withdrawing.handleInput({ type: 'submit' })
    await settle()
    promptAbort.abort()
    await withdrawn.promise
    await drain(withdrawing)
    expect(withdrawing.view()?.notice).toContain('cancelled')
  })

  it('answers select prompts, validates empty choices, and keeps only the newest eight notices', async () => {
    const choices: string[] = []
    const port: ProviderConnectionPort = {
      list: vi.fn(async () => snapshot([deepseek()])),
      connect: vi.fn(async (_provider, _method, surface) => {
        for (let index = 0; index < 10; index += 1) {
          surface.notify({ message: `notice-${index}` })
        }
        choices.push(await surface.prompt({
          kind: 'select',
          message: 'Account',
          options: [
            { id: 'first', label: 'First' },
            { id: 'second', label: 'Second' },
          ],
        }))
        return { status: 'connected' as const }
      }),
      disconnect: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
    }
    const controller = new ProviderConnectController(port, vi.fn())
    controller.open()
    await drain(controller)
    controller.handleInput({ type: 'submit' })
    controller.handleInput({ type: 'submit' })
    await settle()
    expect(controller.view()?.notices.map(item => item.message)).toEqual([
      'notice-2', 'notice-3', 'notice-4', 'notice-5',
      'notice-6', 'notice-7', 'notice-8', 'notice-9',
    ])
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'move-up' })
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'ignored' })
    controller.handleInput({ type: 'submit' })
    await drain(controller)
    expect(choices).toEqual(['second'])

    const emptyPort: ProviderConnectionPort = {
      ...port,
      connect: vi.fn(async (_provider, _method, surface) => {
        try {
          await surface.prompt({ kind: 'select', message: 'None', options: [] })
        } catch (error) {
          expect(error).toBeInstanceOf(ProviderAuthorizationDeclinedError)
          return { status: 'cancelled' as const }
        }
        throw new Error('empty selection unexpectedly resolved')
      }),
    }
    const empty = new ProviderConnectController(emptyPort, vi.fn())
    empty.open()
    await drain(empty)
    empty.handleInput({ type: 'submit' })
    empty.handleInput({ type: 'submit' })
    await settle()
    empty.handleInput({ type: 'submit' })
    expect(empty.view()?.error).toBe('No authorization option is available')
    empty.handleInput({ type: 'interrupt' })
    await drain(empty)
    expect(empty.view()?.notice).toContain('cancelled')
  })

  it('replaces an outstanding prompt with the provider newest question', async () => {
    const firstRejected = deferred<void>()
    const answerSeen = deferred<string>()
    const port: ProviderConnectionPort = {
      list: vi.fn(async () => snapshot([deepseek()])),
      connect: vi.fn(async (_provider, _method, surface) => {
        const first = surface.prompt({ kind: 'text', message: 'First' })
        const second = surface.prompt({ kind: 'text', message: 'Second' })
        await expect(first).rejects.toBeInstanceOf(ProviderAuthorizationDeclinedError)
        firstRejected.resolve()
        answerSeen.resolve(await second)
        return { status: 'connected' as const }
      }),
      disconnect: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
    }
    const controller = new ProviderConnectController(port, vi.fn())
    controller.open()
    await drain(controller)
    controller.handleInput({ type: 'submit' })
    controller.handleInput({ type: 'submit' })
    await firstRejected.promise
    expect(controller.view()?.prompt?.message).toBe('Second')
    controller.handleInput({ type: 'insert', text: 'latest' })
    controller.handleInput({ type: 'submit' })
    await expect(answerSeen.promise).resolves.toBe('latest')
    await drain(controller)
  })
})
