import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Command } from 'commander'
import type { DshTuiFeatureService } from '../src/kernel/feature-service.ts'
import type { DshTuiRuntimeService } from '../src/runtime/service.ts'
import type {
  DshTuiControllerOptions,
  DshTuiProductPort,
} from '../src/app/controller.ts'
import { DshTuiController } from '../src/app/controller.ts'
import { DshTuiFeatureHost } from '../src/app/feature-host.ts'
import { DshTuiProductRunner } from '../src/app/runner.ts'
import type { DshTuiSessionPort } from '../src/runtime/tui-session-port.ts'
import { runtimeSessionCapabilities } from '../src/runtime/runtime-session.ts'
import { runtimeSessionScope } from '../src/lifecycle/application-scope-host.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import {
  PiTerminalDriver,
  type TerminalDriver,
} from '../src/terminal/driver.ts'
import {
  apply as applyProduct,
  consumeProductTask,
  createDshTuiProductEnvironment,
  inject,
  mountDshTuiProduct as mountProduct,
  name,
  provide,
  type DshTuiProductEnvironment,
  type DshTuiProductMountDependencies,
  type DshTuiProductMountOptions,
} from '../src/product.ts'
import { parseDshTuiProductStartup } from '../src/composition/product-plugin.ts'
import { createDshTuiTheme } from '../src/ui/theme.ts'
import { DEFAULT_DSH_TUI_PREFERENCES, type DshTuiPreferencesV1 } from '../src/preferences/contracts.ts'
import type { DshTuiPreferencesApplicationPort } from '../src/preferences/port.ts'

let productEnvironment = createDshTuiProductEnvironment()

afterEach(() => {
  productEnvironment = createDshTuiProductEnvironment()
  vi.restoreAllMocks()
})

function setProductEnvironment(
  overrides: Partial<DshTuiProductEnvironment>,
): void {
  productEnvironment = createDshTuiProductEnvironment({
    ...productEnvironment,
    ...overrides,
  })
}

function apply(
  ctx: Context,
  options: DshTuiProductMountOptions = {},
): void {
  applyProduct(ctx, options, productEnvironment)
}

function mountDshTuiProduct(
  ctx: Context,
  options: DshTuiProductMountOptions = {},
  dependencies?: DshTuiProductMountDependencies,
) {
  return mountProduct(ctx, options, dependencies, productEnvironment)
}

interface FeatureObservers {
  unload?: Parameters<DshTuiFeatureService['onActiveFeatureUnloaded']>[0]
  failure?: Parameters<DshTuiFeatureService['onRequiredFeatureFailure']>[0]
}

function featureService(
  order: string[],
  observers: FeatureObservers = {},
): DshTuiFeatureService {
  const ready = Promise.resolve([])
  return {
    ready,
    start: vi.fn(async () => {
      order.push('features:start')
      return []
    }),
    onActiveFeatureUnloaded: vi.fn((listener) => {
      order.push('features:subscribe-unload')
      observers.unload = listener
      return () => { order.push('features:unsubscribe-unload') }
    }),
    onRequiredFeatureFailure: vi.fn((listener) => {
      order.push('features:subscribe-failure')
      observers.failure = listener
      return () => { order.push('features:unsubscribe-failure') }
    }),
    registerFeature: vi.fn(() => { throw new Error('not used') }),
    registerCapability: vi.fn(() => ({ tokenId: 'dsh-tui.session.navigation/v1', active: true, release: vi.fn(async () => {}) })),
    activateRoute: vi.fn(async () => []),
    activateCommand: vi.fn(async () => []),
    activateFeature: vi.fn(async () => { throw new Error('not used') }),
    status: vi.fn(),
    contributionsFor: vi.fn(),
    listActiveContributions: vi.fn(() => []),
  } as unknown as DshTuiFeatureService
}

function runtimeService(order: string[]): {
  readonly service: DshTuiRuntimeService
  readonly release: ReturnType<typeof vi.fn>
  readonly activate: ReturnType<typeof vi.fn>
} {
  const release = vi.fn(async () => {})
  const port = {
    sessionId: 'product-session',
    dispose: release,
  } as unknown as DshTuiSessionPort
  const activate = vi.fn(async () => {
    order.push('runtime:activate')
    return { port, release }
  })
  const open = vi.fn(async () => {
    order.push('runtime:open')
    return port
  })
  return {
    release,
    activate,
    service: {
      catalog: {} as never,
      activation: { activateSession: activate },
      inspection: {} as never,
      fork: {} as never,
      presets: {} as never,
      providers: {} as never,
      settings: {} as never,
      pluginInventory: {} as never,
      openSession: vi.fn(async () => {
        order.push('runtime:open')
        return {
          core: {} as never,
          capabilities: {
            acquire: vi.fn(async () => { throw new Error('not used') }),
          },
          [runtimeSessionCapabilities]: undefined,
          asLegacyPort: vi.fn(async () => port),
          release,
        }
      }),
      openLegacy: open,
      open,
    },
  }
}

function provideDependencies(
  ctx: Context,
  order: string[],
  options: {
    readonly omit?: 'features' | 'legacy' | 'runtime' | 'args' | 'exit'
    readonly observers?: FeatureObservers
    readonly args?: readonly string[]
    readonly appExit?: (code: number) => void
  } = {},
): ReturnType<typeof runtimeService> {
  const runtime = runtimeService(order)
  if (options.omit !== 'features') {
    ctx.provide('dshTuiFeatures', featureService(order, options.observers))
  }
  if (options.omit !== 'legacy') {
    ctx.provide('dshTuiLegacyChat', Object.freeze({ featureId: 'legacy.chat' }))
  }
  if (options.omit !== 'runtime') ctx.provide('dshTui', runtime.service)
  if (options.omit !== 'args') {
    ctx.provide('cmdlineArgs', { get: () => options.args ?? [] })
  }
  if (options.omit !== 'exit') ctx.provide('appExit', options.appExit ?? vi.fn())
  return runtime
}

function createProductSeams(order: string[]): DshTuiProductEnvironment {
  const terminal: TerminalDriver = {
    state: 'idle',
    viewport: { columns: 100, rows: 30 },
    start: vi.fn(),
    handoff: vi.fn(),
    render: vi.fn(),
    stopAcceptingInput: vi.fn(),
    restore: vi.fn(),
  }
  const createTerminal = vi.fn(() => {
    order.push('terminal:create')
    return terminal
  })
  const createController = vi.fn((options: DshTuiControllerOptions) => {
    let state: 'idle' | 'running' | 'stopped' = 'idle'
    let finish!: (result: {
      readonly ok: true
      readonly reason: 'user'
      readonly shutdown: { readonly mode: 'graceful'; readonly issues: readonly [] }
    }) => void
    const completion = new Promise<{
      readonly ok: true
      readonly reason: 'user'
      readonly shutdown: { readonly mode: 'graceful'; readonly issues: readonly [] }
    }>((resolve) => { finish = resolve })
    return {
      get state() { return state },
      start: async () => {
        order.push('controller:start')
        state = 'running'
        await options.featureSession?.activate(options.session, terminal.viewport)
      },
      requestExit: async () => {
        if (state !== 'stopped') {
          state = 'stopped'
          await options.featureSession?.deactivate()
          await options.sessionRelease?.()
          terminal.restore()
          finish({
            ok: true,
            reason: 'user',
            shutdown: { mode: 'graceful', issues: [] },
          })
        }
        return await completion
      },
      wait: () => completion,
    }
  })
  const process = {
    on: vi.fn((event) => { order.push(`process:subscribe-${event}`) }),
    removeListener: vi.fn((event) => { order.push(`process:unsubscribe-${event}`) }),
  }
  return createDshTuiProductEnvironment({
    createTerminal,
    createController,
    process,
    forceExit: vi.fn(),
    reportError: vi.fn(),
  })
}

function installProductSeams(order: string[]): void {
  productEnvironment = createProductSeams(order)
}

describe('independent Product Cordis row', () => {
  it.each([false, true])('releases a Session whose legacy projection fails (cleanup failure: %s)', async cleanupFails => {
    const ctx = new Context()
    const order: string[] = []
    const runtime = provideDependencies(ctx, order)
    installProductSeams(order)
    const release = vi.fn(async () => { if (cleanupFails) throw new Error('cleanup failed') })
    vi.mocked(runtime.service.openSession).mockResolvedValue({
      core: {} as never, capabilities: {} as never,
      asLegacyPort: async () => { throw new Error('projection failed') },
      release,
    } as never)
    const mounted = mountDshTuiProduct(ctx, { startup: { mode: 'create' } })!
    await mounted.completion
    expect(release).toHaveBeenCalledOnce()
    expect(productEnvironment.createTerminal).not.toHaveBeenCalled()
    expect(productEnvironment.reportError).toHaveBeenCalledWith(
      cleanupFails ? 'dsh-tui: DSH-TUI Product session binding cleanup failed\n' : 'dsh-tui: projection failed\n',
    )
    await mounted.dispose()
    await ctx.fiber.dispose()
  })

  it('applies saved preferences before terminal creation and observes updates without reopening the Session', async () => {
    const ctx = new Context()
    const order: string[] = []
    const runtime = provideDependencies(ctx, order)
    installProductSeams(order)
    let notify!: () => void
    let saved: DshTuiPreferencesV1 = { ...DEFAULT_DSH_TUI_PREFERENCES, theme: { preset: 'mono' } }
    const read = vi.fn(async () => ({ revision: 1, preferences: saved }))
    const stop = vi.fn()
    const preferences: DshTuiPreferencesApplicationPort = {
      status: () => ({ available: true, writable: true, documentBacked: true }),
      read,
      write: async () => { throw new Error('not used') },
      onChanged: listener => { notify = listener; return stop },
    }
    ctx.provide('dshTuiPreferences', preferences)
    const mounted = mountDshTuiProduct(ctx, { startup: { mode: 'create' } })!
    await vi.waitFor(() => expect(productEnvironment.createController).toHaveBeenCalledOnce())
    expect(productEnvironment.createTerminal).toHaveBeenCalledWith({ theme: expect.objectContaining({ preset: 'mono' }) })
    const terminal = vi.mocked(productEnvironment.createTerminal).mock.results[0]!.value as TerminalDriver
    const updateTheme = vi.fn()
    terminal.updateTheme = updateTheme
    const controllerOptions = vi.mocked(productEnvironment.createController).mock.calls[0]![0]
    const reflow = vi.spyOn(controllerOptions.featureSession!, 'themeChanged')
    saved = { ...saved, density: 'comfortable' }
    notify()
    await vi.waitFor(() => expect(controllerOptions.preferences?.snapshot().density).toBe('comfortable'))
    expect(updateTheme).not.toHaveBeenCalled()
    expect(reflow).not.toHaveBeenCalled()
    const navigationHandler = vi.fn()
    vi.mocked(ctx.get('dshTuiFeatures')!.listActiveContributions).mockReturnValue([{
      featureId: 'probe', provenance: { authority: 'extension', required: false },
      contributions: {
        routes: [{ id: 'probe', value: { kind: 'workspace', featureId: 'probe', pane: 'navigator' } }],
        commands: [{ id: 'navigation.move', value: { handle: navigationHandler } }],
      },
    }])
    await controllerOptions.features!.openRoute('probe')
    saved = { ...saved, navigationKeys: 'arrows' }
    notify()
    await vi.waitFor(() => expect(controllerOptions.preferences?.snapshot().navigationKeys).toBe('arrows'))
    await controllerOptions.features!.dispatchTerminalAction({ type: 'insert', text: 'j' }).completion
    expect(navigationHandler).not.toHaveBeenCalled()
    await controllerOptions.features!.dispatchTerminalAction({ type: 'move-down' }).completion
    expect(navigationHandler).toHaveBeenCalledOnce()
    expect(reflow).not.toHaveBeenCalled()
    saved = { ...saved, theme: { preset: 'cordis' } }
    notify()
    await vi.waitFor(() => expect(updateTheme).toHaveBeenCalledOnce())
    expect(reflow).toHaveBeenCalledOnce()
    saved = { ...saved, layoutMode: 'single' }
    notify()
    await vi.waitFor(() => expect(reflow).toHaveBeenCalledTimes(2))
    expect(updateTheme).toHaveBeenCalledOnce()
    expect(runtime.service.openSession).toHaveBeenCalledOnce()
    read.mockRejectedValueOnce(new Error('read failure'))
    notify()
    await vi.waitFor(() => expect(productEnvironment.reportError).toHaveBeenCalledWith('dsh-tui preferences: read failure\n'))
    await mounted.dispose()
    expect(stop).toHaveBeenCalledOnce()
    notify()
    expect(runtime.release).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('registers and releases the application navigation capability even if its release fails', async () => {
    const ctx = new Context()
    const order: string[] = []
    provideDependencies(ctx, order)
    installProductSeams(order)
    const features = ctx.get('dshTuiFeatures')!
    const release = vi.fn(async () => { throw new Error('navigation release failed') })
    vi.mocked(features.registerCapability).mockReturnValue({ tokenId: 'dsh-tui.session.navigation/v1', active: true, release })
    const mounted = mountDshTuiProduct(ctx, { startup: { mode: 'create' }, lifecycle: 'external' })!
    await vi.waitFor(() => expect(productEnvironment.createController).toHaveBeenCalledOnce())
    const factory = vi.mocked(features.registerCapability).mock.calls[0]![0]
    expect(factory.token.id).toBe('dsh-tui.session.navigation/v1')
    const lease = await factory.create({} as never)
    expect(lease.value).toBe(vi.mocked(productEnvironment.createController).mock.calls[0]![0].sessionNavigation)
    await lease.release()
    await expect(mounted.dispose()).rejects.toMatchObject({ errors: [new Error('navigation release failed')] })
    expect(release).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('creates a fresh immutable environment for each Product mount boundary', () => {
    const first = createDshTuiProductEnvironment()
    const second = createDshTuiProductEnvironment()

    expect(first).not.toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(second)).toBe(true)
  })

  it('keeps explicit Product environments isolated across two Cordis contexts', async () => {
    const firstOrder: string[] = []
    const secondOrder: string[] = []
    const firstContext = new Context()
    const secondContext = new Context()
    provideDependencies(firstContext, firstOrder)
    provideDependencies(secondContext, secondOrder)
    const firstEnvironment = createProductSeams(firstOrder)
    const secondEnvironment = createProductSeams(secondOrder)

    const firstMount = mountProduct(
      firstContext,
      { startup: { mode: 'create', sessionId: 'first' } },
      undefined,
      firstEnvironment,
    )
    const secondMount = mountProduct(
      secondContext,
      { startup: { mode: 'create', sessionId: 'second' } },
      undefined,
      secondEnvironment,
    )
    if (firstMount === undefined || secondMount === undefined) {
      throw new Error('expected both Product mounts')
    }
    await vi.waitFor(() => {
      expect(firstEnvironment.createController).toHaveBeenCalledOnce()
      expect(secondEnvironment.createController).toHaveBeenCalledOnce()
    })

    expect(firstEnvironment.createTerminal).toHaveBeenCalledOnce()
    expect(secondEnvironment.createTerminal).toHaveBeenCalledOnce()
    expect(firstOrder.filter(entry => entry === 'terminal:create')).toHaveLength(1)
    expect(secondOrder.filter(entry => entry === 'terminal:create')).toHaveLength(1)

    await Promise.all([firstMount.dispose(), secondMount.dispose()])
    await Promise.all([firstContext.fiber.dispose(), secondContext.fiber.dispose()])
  })

  it('leaves Product disposal to an external composition owner when requested', async () => {
    const order: string[] = []
    const ctx = new Context()
    provideDependencies(ctx, order)
    const environment = createProductSeams(order)
    const mounted = mountProduct(
      ctx,
      { startup: { mode: 'create' }, lifecycle: 'external' },
      undefined,
      environment,
    )
    if (mounted === undefined) throw new Error('expected product mount')
    await vi.waitFor(() => expect(environment.createController).toHaveBeenCalledOnce())

    await ctx.fiber.dispose()
    expect(environment.process.removeListener).not.toHaveBeenCalled()

    await mounted.dispose()
    expect(environment.process.removeListener).toHaveBeenCalled()
  })

  it('exports the stable row metadata', () => {
    expect(name).toBe('dsh-tui-product')
    expect(inject).toEqual([
      'dshTuiFeatures',
      'dshTuiLegacyChat',
      'dshTui',
      'dshTuiPreferences',
      'cmdlineArgs',
      'appExit',
    ])
    expect(provide).toBe('dshTuiProduct')
  })

  it.each([
    ['features', 'dshTuiFeatures'],
    ['legacy', 'dshTuiLegacyChat'],
    ['runtime', 'dshTui'],
    ['args', 'cmdlineArgs'],
    ['exit', 'appExit'],
  ] as const)(
    'allocates no product resource while the %s dependency is missing',
    async (omit, serviceName) => {
    const order: string[] = []
    const ctx = new Context()
    provideDependencies(ctx, order, { omit })
    installProductSeams(order)

    expect(() => mountDshTuiProduct(ctx, {
      startup: { mode: 'create' },
    })).toThrow(serviceName)
    expect(productEnvironment.createTerminal).not.toHaveBeenCalled()
    expect(productEnvironment.createController).not.toHaveBeenCalled()
    expect(order).toEqual([])

    await ctx.fiber.dispose()
    },
  )

  it('rejects a duplicate mount before allocating a second terminal', async () => {
    const order: string[] = []
    const ctx = new Context()
    provideDependencies(ctx, order)
    installProductSeams(order)

    const mounted = mountDshTuiProduct(ctx, { startup: { mode: 'create' } })
    if (mounted === undefined) throw new Error('expected product mount')
    await vi.waitFor(() => expect(productEnvironment.createTerminal).toHaveBeenCalledOnce())

    expect(() => mountDshTuiProduct(ctx, {
      startup: { mode: 'create' },
    })).toThrow('already mounted')
    expect(productEnvironment.createTerminal).toHaveBeenCalledOnce()

    await mounted.dispose()
    await ctx.fiber.dispose()
  })

  it('subscribes lifecycle recovery before feature start and session open', async () => {
    const order: string[] = []
    const ctx = new Context()
    provideDependencies(ctx, order)
    installProductSeams(order)

    const mounted = mountDshTuiProduct(ctx, { startup: { mode: 'create' } })
    if (mounted === undefined) throw new Error('expected product mount')
    await vi.waitFor(() => expect(order).toContain('controller:start'))

    const start = order.indexOf('features:start')
    const open = order.indexOf('runtime:open')
    for (const event of [
      'features:subscribe-unload',
      'features:subscribe-failure',
      'process:subscribe-SIGHUP',
      'process:subscribe-SIGBREAK',
      'process:subscribe-exit',
    ]) {
      expect(order.indexOf(event)).toBeGreaterThanOrEqual(0)
      expect(order.indexOf(event)).toBeLessThan(start)
      expect(order.indexOf(event)).toBeLessThan(open)
    }
    expect(ctx.get('dshTuiProduct')).toBe(mounted)

    await mounted.dispose()
    await ctx.fiber.dispose()
  })

  it('prefers a pre-resolved startup request and forwards the Product theme', async () => {
    const order: string[] = []
    const ctx = new Context()
    provideDependencies(ctx, order, { args: ['--resume', 'ignored'] })
    installProductSeams(order)
    const resolveStartup = vi.fn(() => {
      throw new Error('pre-resolved startup must win')
    })

    const mounted = mountDshTuiProduct(ctx, {
      startup: {
        mode: 'create',
        sessionId: 'pre-resolved',
        cwd: ' D:\\Projects ',
        agentPreset: 'standard',
      },
      resolveStartup,
      theme: { preset: 'mono' },
    })
    if (mounted === undefined) throw new Error('expected product mount')
    await vi.waitFor(() => expect(productEnvironment.createTerminal).toHaveBeenCalledOnce())

    expect(resolveStartup).not.toHaveBeenCalled()
    expect(productEnvironment.createTerminal).toHaveBeenCalledWith({
      theme: expect.objectContaining({
        preset: 'mono',
        colorLevel: 'mono',
        semantic: expect.objectContaining({ colorLevel: 'mono' }),
      }),
    })
    const controllerOptions = vi.mocked(productEnvironment.createController).mock.calls[0]?.[0]
    if (controllerOptions === undefined) throw new Error('expected Controller options')
    await controllerOptions.application.forceExit()
    expect(productEnvironment.forceExit).toHaveBeenCalledExactlyOnceWith(130)

    await mounted.dispose()
    await ctx.fiber.dispose()
  })

  it('returns without allocating resources when an explicit startup resolver declines', async () => {
    const order: string[] = []
    const ctx = new Context()
    provideDependencies(ctx, order, { args: ['--resume', 'must-not-parse'] })
    installProductSeams(order)
    const resolveStartup = vi.fn(() => undefined)

    expect(mountDshTuiProduct(ctx, { resolveStartup })).toBeUndefined()
    expect(resolveStartup).toHaveBeenCalledExactlyOnceWith(ctx)
    expect(ctx.get('dshTuiProduct')).toBeUndefined()
    expect(productEnvironment.createTerminal).not.toHaveBeenCalled()
    expect(order).toEqual([])

    await ctx.fiber.dispose()
  })

  it('accepts an explicit dependency bridge for a same-fiber root composer', async () => {
    const order: string[] = []
    const ctx = new Context()
    const runtime = runtimeService(order)
    const features = featureService(order)
    installProductSeams(order)

    const mounted = mountDshTuiProduct(
      ctx,
      { startup: { mode: 'create', sessionId: 'root-composed' } },
      {
        features,
        legacyChat: { featureId: 'legacy.chat' },
        runtime: runtime.service,
        cmdlineArgs: { get: () => [] },
        appExit: vi.fn(),
      },
    )
    if (mounted === undefined) throw new Error('expected product mount')
    await vi.waitFor(() => expect(runtime.service.openSession).toHaveBeenCalledOnce())
    expect(ctx.get('dshTuiProduct')).toBe(mounted)

    await mounted.dispose()
    await ctx.fiber.dispose()
  })

  it('lets the Controller transact Session Features after port projection and before release', async () => {
    const order: string[] = []
    const ctx = new Context()
    const scopes = new ScopeManager('product-session-feature-test')
    const sessionScope = scopes.createSession('session')
    const runtime = runtimeService(order)
    const acquire = vi.fn(async () => { throw new Error('not used') })
    const port = {
      sessionId: 'bound-session',
      dispose: vi.fn(async () => {}),
      [runtimeSessionScope]: sessionScope,
      [runtimeSessionCapabilities]: { acquire } as never,
    } as unknown as DshTuiSessionPort
    const featureRelease = vi.fn(async () => { order.push('features:release-session') })
    const bindSession = vi.fn(async () => {
      order.push('features:bind-session')
      return { active: true, release: featureRelease }
    })
    const features = {
      ...featureService(order),
      bindSession,
    } as unknown as DshTuiFeatureService
    const runtimeRelease = vi.fn(async () => { order.push('runtime:release-session') })
    runtime.service.openSession = vi.fn(async () => ({
      core: {} as never,
      capabilities: { acquire } as never,
      [runtimeSessionScope]: sessionScope,
      [runtimeSessionCapabilities]: { acquire } as never,
      asLegacyPort: vi.fn(async () => {
        order.push('runtime:project-legacy')
        return port
      }),
      release: runtimeRelease,
    }))
    installProductSeams(order)

    const mounted = mountDshTuiProduct(
      ctx,
      { startup: { mode: 'create', sessionId: 'bound-session' } },
      {
        features,
        legacyChat: { featureId: 'legacy.chat' },
        runtime: runtime.service,
        cmdlineArgs: { get: () => [] },
        appExit: vi.fn(),
      },
    )
    if (mounted === undefined) throw new Error('expected product mount')
    await vi.waitFor(() => expect(productEnvironment.createController).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(bindSession).toHaveBeenCalledOnce())

    const controllerOptions = vi.mocked(productEnvironment.createController).mock.calls[0]?.[0]
    if (controllerOptions?.featureSession === undefined) {
      throw new Error('expected Controller Feature Session transaction')
    }
    expect(controllerOptions.session).toBe(port)
    expect((controllerOptions.session as unknown as {
      readonly [runtimeSessionScope]: unknown
      readonly [runtimeSessionCapabilities]: unknown
    })[runtimeSessionScope]).toBe(sessionScope)
    expect((controllerOptions.session as unknown as {
      readonly [runtimeSessionCapabilities]: unknown
    })[runtimeSessionCapabilities]).toEqual({ acquire })
    expect(bindSession).toHaveBeenCalledWith({
      scope: sessionScope,
      capabilities: expect.objectContaining({ resolve: expect.any(Function) }),
    })
    expect(order.indexOf('runtime:project-legacy')).toBeLessThan(
      order.indexOf('controller:start'),
    )
    expect(order.indexOf('controller:start')).toBeLessThan(
      order.indexOf('features:bind-session'),
    )

    const deactivate = vi.spyOn(controllerOptions.featureSession, 'deactivate')
    await mounted.dispose()
    expect(deactivate).toHaveBeenCalledOnce()
    expect(deactivate.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeRelease.mock.invocationCallOrder[0]!,
    )
    expect(order.indexOf('features:release-session')).toBeLessThan(
      order.indexOf('runtime:release-session'),
    )
    await scopes.dispose()
    await ctx.fiber.dispose()
  })

  it('uses the DSH-free parser from the Cordis apply entrypoint', async () => {
    const order: string[] = []
    const ctx = new Context()
    provideDependencies(ctx, order, {
      args: ['--session-id', 'parsed-session', '--agent-preset', 'standard'],
    })
    installProductSeams(order)

    apply(ctx)
    const mounted = ctx.get('dshTuiProduct')
    if (mounted === undefined) throw new Error('expected product mount')
    await vi.waitFor(() => expect(productEnvironment.createController).toHaveBeenCalledOnce())

    expect(productEnvironment.createController).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ sessionId: 'product-session' }),
      }),
    )

    await mounted.dispose()
    await ctx.fiber.dispose()
  })

  it.each([
    [undefined],
    [{ provider: 'route', model: 'opaque', reasoningEffort: 'high' }],
  ] as const)(
    'routes resume startup through SessionActivation with selection %j',
    async (selection) => {
      const order: string[] = []
      const ctx = new Context()
      const runtime = provideDependencies(ctx, order)
      installProductSeams(order)

      const mounted = mountDshTuiProduct(ctx, {
        startup: {
          mode: 'resume',
          sessionId: 'durable-session',
          ...(selection === undefined ? {} : { selection }),
        },
      })
      if (mounted === undefined) throw new Error('expected product mount')
      await vi.waitFor(() => expect(runtime.activate).toHaveBeenCalledOnce())

      expect(runtime.service.openSession).not.toHaveBeenCalled()
      expect(runtime.activate).toHaveBeenCalledWith({
        intent: 'resume-cold',
        sessionId: 'durable-session',
        signal: expect.any(AbortSignal),
        ...(selection === undefined ? {} : { selection }),
      })

      await mounted.dispose()
      await ctx.fiber.dispose()
    },
  )

  it('forwards lifecycle notifications only while the Product is active', async () => {
    const order: string[] = []
    const observers: FeatureObservers = {}
    const ctx = new Context()
    provideDependencies(ctx, order, { observers })
    installProductSeams(order)
    const unload = vi.spyOn(
      DshTuiFeatureHost.prototype,
      'handleActiveFeatureUnloaded',
    ).mockResolvedValue()
    const fatal = vi.spyOn(
      DshTuiProductRunner.prototype,
      'requestFatalFailure',
    ).mockResolvedValue()

    const mounted = mountDshTuiProduct(ctx, { startup: { mode: 'create' } })
    if (mounted === undefined) throw new Error('expected product mount')
    const unloadEvent = {
      type: 'active-feature-unloaded',
      featureId: 'sessions',
      fallbackRoute: 'chat',
      restoreFocus: true,
    } as const
    const failure = new Error('required feature failed')
    const failureEvent = {
      type: 'required-feature-failure',
      featureId: 'legacy.chat',
      reason: 'activation',
      error: failure,
    } as const
    if (observers.unload === undefined || observers.failure === undefined) {
      throw new Error('expected lifecycle observers')
    }

    await observers.unload(unloadEvent)
    await observers.failure(failureEvent)
    expect(unload).toHaveBeenCalledExactlyOnceWith(unloadEvent)
    expect(fatal).toHaveBeenCalledExactlyOnceWith(failure)

    await mounted.dispose()
    await observers.unload(unloadEvent)
    await observers.failure(failureEvent)
    expect(unload).toHaveBeenCalledOnce()
    expect(fatal).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('contains Feature startup failure before allocating a terminal', async () => {
    const order: string[] = []
    const exits: number[] = []
    const ctx = new Context()
    provideDependencies(ctx, order, {
      appExit: code => { exits.push(code) },
    })
    const features = ctx.get('dshTuiFeatures')
    if (features === undefined) throw new Error('expected Feature service')
    vi.mocked(features.start).mockRejectedValueOnce(
      new Error('\u001b[31mfeature startup\nfailed'),
    )
    installProductSeams(order)

    const mounted = mountDshTuiProduct(ctx, { startup: { mode: 'create' } })
    if (mounted === undefined) throw new Error('expected product mount')
    await mounted.completion

    expect(productEnvironment.createTerminal).not.toHaveBeenCalled()
    expect(productEnvironment.createController).not.toHaveBeenCalled()
    expect(productEnvironment.reportError).toHaveBeenCalledWith(
      'dsh-tui: feature startup failed\n',
    )
    expect(exits).toEqual([1])

    await mounted.dispose()
    await ctx.fiber.dispose()
  })

  it('does not start the Runner when disposed while Feature startup is pending', async () => {
    const order: string[] = []
    const ctx = new Context()
    const runtime = provideDependencies(ctx, order)
    const features = ctx.get('dshTuiFeatures')
    if (features === undefined) throw new Error('expected Feature service')
    let releaseFeatures!: () => void
    vi.mocked(features.start).mockImplementationOnce(() => new Promise((resolve) => {
      releaseFeatures = () => { resolve([]) }
    }))
    installProductSeams(order)

    const mounted = mountDshTuiProduct(ctx, { startup: { mode: 'create' } })
    if (mounted === undefined) throw new Error('expected product mount')
    const firstDispose = mounted.dispose()
    expect(mounted.dispose()).toBe(firstDispose)
    releaseFeatures()
    await Promise.all([firstDispose, mounted.completion])

    expect(runtime.service.openSession).not.toHaveBeenCalled()
    expect(productEnvironment.createTerminal).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('ignores a late Feature startup rejection after Product disposal', async () => {
    const order: string[] = []
    const ctx = new Context()
    const runtime = provideDependencies(ctx, order)
    const features = ctx.get('dshTuiFeatures')
    if (features === undefined) throw new Error('expected Feature service')
    let rejectFeatures!: (error: unknown) => void
    vi.mocked(features.start).mockImplementationOnce(() => new Promise((_, reject) => {
      rejectFeatures = reject
    }))
    installProductSeams(order)

    const mounted = mountDshTuiProduct(ctx, { startup: { mode: 'create' } })
    if (mounted === undefined) throw new Error('expected product mount')
    await mounted.dispose()
    rejectFeatures(new Error('late Feature failure'))
    await mounted.completion

    expect(runtime.service.openSession).not.toHaveBeenCalled()
    expect(productEnvironment.reportError).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('uses the Cordis environment and never starts a terminal after a pending preference read is disposed', async () => {
    const ctx = new Context()
    const order: string[] = []
    const runtime = provideDependencies(ctx, order)
    installProductSeams(order)
    ctx.provide('dshTuiProductEnvironment', productEnvironment)
    let resolveRead!: (value: { revision: number; preferences: typeof DEFAULT_DSH_TUI_PREFERENCES }) => void
    const read = vi.fn(() => new Promise(resolve => { resolveRead = resolve }))
    const stop = vi.fn()
    ctx.provide('dshTuiPreferences', { read, onChanged: () => stop } as unknown as DshTuiPreferencesApplicationPort)
    applyProduct(ctx, { startup: { mode: 'create' } })
    const mounted = ctx.get('dshTuiProduct')!
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    await mounted.dispose()
    resolveRead({ revision: 1, preferences: DEFAULT_DSH_TUI_PREFERENCES })
    await mounted.completion
    expect(stop).toHaveBeenCalledOnce()
    expect(runtime.service.openSession).not.toHaveBeenCalled()
    expect(productEnvironment.createTerminal).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('aggregates Product-owned disposal failures', async () => {
    const order: string[] = []
    const ctx = new Context()
    provideDependencies(ctx, order)
    installProductSeams(order)
    const processFailure = new Error('process listener cleanup failed')
    const runnerFailure = new Error('runner cleanup failed')
    const sessionFailure = new Error('Feature Session cleanup failed')
    const hostFailure = new Error('Feature host cleanup failed')
    setProductEnvironment({
      process: {
        ...productEnvironment.process,
        removeListener: vi.fn(() => {
          throw processFailure
        }),
      },
    })

    const mounted = mountDshTuiProduct(ctx, { startup: { mode: 'create' } })
    if (mounted === undefined) throw new Error('expected product mount')
    await vi.waitFor(() => expect(productEnvironment.createController).toHaveBeenCalledOnce())
    const featureSession = vi.mocked(productEnvironment.createController).mock.calls[0]?.[0]
      .featureSession
    if (featureSession === undefined) throw new Error('expected Feature Session runtime')
    vi.spyOn(mounted.runner, 'dispose').mockRejectedValue(runnerFailure)
    vi.spyOn(featureSession, 'dispose').mockRejectedValue(sessionFailure)
    vi.spyOn(DshTuiFeatureHost.prototype, 'dispose').mockImplementation(() => {
      throw hostFailure
    })

    const disposal = mounted.dispose()
    await expect(disposal).rejects.toMatchObject({
      message: 'dsh-tui product disposal failed',
      errors: [processFailure, runnerFailure, sessionFailure, hostFailure],
    })
  })

  it('uses bounded default process seams and contains task reporting failures', async () => {
    const environment = createDshTuiProductEnvironment()
    const terminal = environment.createTerminal({
      theme: createDshTuiTheme({ preset: 'mono' }),
    })
    expect(terminal).toBeInstanceOf(PiTerminalDriver)
    terminal.restore()

    const controllerTerminal: TerminalDriver = {
      state: 'idle',
      viewport: { columns: 80, rows: 24 },
      start: () => {},
      handoff: () => {},
      render: () => {},
      stopAcceptingInput: () => {},
      restore: () => {},
    }
    const controller = environment.createController({
      session: { sessionId: 'seam-session' } as unknown as DshTuiProductPort,
      catalog: {
        listSessions: async () => ({ durability: 'unavailable', sessions: [] }),
      },
      terminal: controllerTerminal,
      application: { requestExit: () => {}, forceExit: () => {} },
    })
    expect(controller).toBeInstanceOf(DshTuiController)
    expect(environment.process).toBe(process)

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    environment.reportError('probe')
    expect(stderr).toHaveBeenCalledWith('probe')

    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`)
    })
    expect(() => environment.forceExit(130)).toThrow('exit 130')
    expect(exit).toHaveBeenCalledExactlyOnceWith(130)

    const report = vi.fn()
    consumeProductTask(
      Promise.reject(new Error('\u001b[31munexpected\nfailure')),
      report,
    )
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(
      'dsh-tui: unexpected product task rejection: unexpected failure\n',
    ))

    const brokenReporter = vi.fn(() => {
      throw new Error('stderr unavailable')
    })
    consumeProductTask(Promise.reject(new Error('contained')), brokenReporter)
    await new Promise<void>(resolve => { queueMicrotask(resolve) })
  })
})

describe('DSH-free Product startup parser', () => {
  it.each([
    {
      args: [],
      expected: { mode: 'create', agentPreset: 'standard' },
    },
    {
      args: [
        '--session-id', ' session ',
        '--cwd', ' D:\\Projects ',
        '--agent-preset', ' custom ',
        '--provider', ' route ',
        '--model', ' opaque ',
        '--reasoning-effort', ' high ',
      ],
      expected: {
        mode: 'create',
        sessionId: 'session',
        cwd: 'D:\\Projects',
        agentPreset: 'custom',
        selection: {
          provider: 'route',
          model: 'opaque',
          reasoningEffort: 'high',
        },
      },
    },
    {
      args: ['--resume', ' durable '],
      expected: { mode: 'resume', sessionId: 'durable' },
    },
    {
      args: [
        '--resume', 'durable',
        '--provider', 'route',
        '--model', 'opaque',
      ],
      expected: {
        mode: 'resume',
        sessionId: 'durable',
        selection: { provider: 'route', model: 'opaque' },
      },
    },
  ])('parses $args without importing the DSH launcher', ({ args, expected }) => {
    const appExit = vi.fn()

    expect(parseDshTuiProductStartup(args, appExit)).toEqual(expected)
    expect(appExit).not.toHaveBeenCalled()
  })

  it.each([
    [['--provider', 'route']],
    [['--model', 'opaque']],
    [['--reasoning-effort', 'high']],
    [['--resume', 'id', '--session-id', 'other']],
    [['--resume', 'id', '--cwd', 'D:\\Projects']],
    [['--resume', 'id', '--agent-preset', 'standard']],
    [['--session-id', ' ']],
    [['--unknown']],
  ])('contains invalid arguments %j through AppExit', (args) => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const appExit = vi.fn()

    expect(parseDshTuiProductStartup(args, appExit)).toBeUndefined()
    expect(appExit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('routes Commander help through AppExit without creating a startup request', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const appExit = vi.fn()

    expect(parseDshTuiProductStartup(['--help'], appExit)).toBeUndefined()
    expect(appExit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('does not disguise a non-Commander parser failure', () => {
    const failure = new Error('parser invariant failed')
    vi.spyOn(Command.prototype, 'parse').mockImplementationOnce(() => {
      throw failure
    })

    expect(() => parseDshTuiProductStartup([], vi.fn())).toThrow(failure)
  })
})
