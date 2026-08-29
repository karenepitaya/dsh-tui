import { describe, expect, it, vi } from 'vitest'
import {
  DshTuiProductRunner,
  sanitizeDshTuiProductError,
  type DshTuiControllerPort,
  type DshTuiOpenRequest,
  type DshTuiStartupRequest,
} from '../src/app/runner.ts'
import type {
  DshTuiApplicationPort,
  DshTuiControllerOptions,
  DshTuiControllerResult,
  DshTuiControllerState,
  DshTuiProductPort,
} from '../src/app/controller.ts'
import type { TerminalDriver } from '../src/terminal/driver.ts'
import type { SessionCatalogPort } from '../src/session/catalog-port.ts'
import type {
  ActivatedSessionLease,
  SessionActivationPort,
} from '../src/session/activation-port.ts'
import type { SessionInspectionPort } from '../src/session/inspection-port.ts'
import type { SessionForkPort } from '../src/session/fork-port.ts'
import type { ProviderConnectionPort } from '../src/provider/port.ts'

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

const cleanResult: DshTuiControllerResult = {
  ok: true,
  reason: 'user',
  shutdown: { mode: 'graceful', issues: [] },
}

const forcedResult: DshTuiControllerResult = {
  ok: false,
  reason: 'forced',
  shutdown: { mode: 'forced', issues: [] },
}

class FakeController implements DshTuiControllerPort {
  state: DshTuiControllerState = 'idle'
  readonly start = vi.fn(async () => { this.state = 'running' })
  readonly requestExit = vi.fn(async (_reason: 'user' | 'signal') => {
    this.state = 'stopping'
    if (this.finishOnExit) this.finish(cleanResult)
    return await this.result.promise
  })
  readonly wait = vi.fn(() => this.result.promise)
  private readonly result = deferred<DshTuiControllerResult>()

  constructor(
    readonly application: DshTuiApplicationPort,
    private readonly finishOnExit = false,
  ) {}

  finish(result: DshTuiControllerResult): void {
    this.state = 'stopped'
    this.result.resolve(result)
  }
}

function fakeSession(dispose = vi.fn(async () => {})): DshTuiProductPort {
  return {
    sessionId: 'runner-session',
    dispose,
  } as unknown as DshTuiProductPort
}

function fakeTerminal(restore = vi.fn()): TerminalDriver {
  return {
    state: 'idle',
    viewport: { columns: 80, rows: 24 },
    start: vi.fn(),
    handoff: vi.fn(),
    render: vi.fn(),
    stopAcceptingInput: vi.fn(),
    restore,
  }
}

function fakeCatalog(): SessionCatalogPort {
  return {
    listSessions: vi.fn(async () => ({
      durability: 'unavailable' as const,
      sessions: [],
    })),
  }
}

function fakeActivation(): SessionActivationPort {
  return {
    activateSession: vi.fn(async () => {
      throw new Error('activation was not expected')
    }),
  }
}

function fakeInspection(): SessionInspectionPort {
  return {
    inspectSession: vi.fn(async () => {
      throw new Error('inspection was not expected')
    }),
  }
}

function fakeFork(): SessionForkPort {
  return {
    forkSession: vi.fn(async () => {
      throw new Error('fork was not expected')
    }),
  }
}

function fakeProviders(): ProviderConnectionPort {
  return {
    list: vi.fn(async () => ({ providers: [], writable: true })),
    connect: vi.fn(async () => ({ status: 'connected' as const })),
    disconnect: vi.fn(async () => undefined),
    onChanged: vi.fn(() => () => undefined),
  }
}

interface ProductHarness {
  readonly runner: DshTuiProductRunner
  readonly catalog: SessionCatalogPort
  readonly activation: SessionActivationPort
  readonly inspection: SessionInspectionPort
  readonly fork: SessionForkPort
  readonly session: DshTuiProductPort
  readonly terminal: TerminalDriver
  readonly open: ReturnType<typeof vi.fn>
  readonly createTerminal: ReturnType<typeof vi.fn>
  readonly createController: ReturnType<typeof vi.fn>
  readonly exits: number[]
  readonly forced: number[]
  readonly reports: string[]
  readonly ownerDisposals: string[]
  controller(): FakeController
}

function productHarness(options: {
  readonly startup?: DshTuiStartupRequest
  readonly catalog?: SessionCatalogPort
  readonly activation?: SessionActivationPort
  readonly inspection?: SessionInspectionPort
  readonly fork?: SessionForkPort
  readonly providers?: ProviderConnectionPort
  readonly open?: (
    request: DshTuiOpenRequest,
  ) => Promise<DshTuiProductPort | ActivatedSessionLease>
  readonly createTerminal?: () => TerminalDriver
  readonly createController?: (options: DshTuiControllerOptions) => DshTuiControllerPort
  readonly appExit?: (code: number) => void
  readonly reportError?: (message: string) => void
} = {}): ProductHarness {
  const catalog = options.catalog ?? fakeCatalog()
  const activation = options.activation ?? fakeActivation()
  const inspection = options.inspection ?? fakeInspection()
  const fork = options.fork ?? fakeFork()
  const session = fakeSession()
  const terminal = fakeTerminal()
  const exits: number[] = []
  const forced: number[] = []
  const reports: string[] = []
  const ownerDisposals: string[] = []
  let controller: FakeController | undefined
  const openSession = options.open ?? (async () => session)
  const open = vi.fn(async (request: DshTuiOpenRequest) => {
    const opened = await openSession(request)
    if ('port' in opened) return opened
    return {
      port: opened,
      release: () => opened.dispose(),
    }
  })
  const createTerminal = vi.fn(options.createTerminal ?? (() => terminal))
  const controllerFactory = options.createController ?? ((controllerOptions) => (
    new FakeController(controllerOptions.application)
  ))
  const createController = vi.fn((controllerOptions: DshTuiControllerOptions) => {
    const created = controllerFactory(controllerOptions)
    if (created instanceof FakeController) controller = created
    return created
  })
  const runner = new DshTuiProductRunner({
    startup: options.startup ?? {
      mode: 'create',
      sessionId: 'runner-session',
      cwd: 'D:\\work',
      agentPreset: 'standard',
    },
    catalog,
    activation,
    inspection,
    fork,
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    open,
    createTerminal,
    createController,
    appExit: options.appExit ?? (code => { exits.push(code) }),
    forceExit: code => { forced.push(code) },
    reportError: options.reportError ?? (message => { reports.push(message) }),
    disposeOwner: () => { ownerDisposals.push('owner') },
  })
  return {
    runner,
    catalog,
    activation,
    inspection,
    fork,
    session,
    terminal,
    open,
    createTerminal,
    createController,
    exits,
    forced,
    reports,
    ownerDisposals,
    controller: () => {
      if (controller === undefined) throw new Error('controller was not created')
      return controller
    },
  }
}

async function reachController(harness: ProductHarness): Promise<FakeController> {
  await vi.waitFor(() => expect(harness.createController).toHaveBeenCalledOnce())
  return harness.controller()
}

describe('assembled product runner', () => {
  it('defaults a preset-less create to Standard without opening a selector surface', async () => {
    const harness = productHarness({
      startup: { mode: 'create', sessionId: 'runner-session', cwd: 'D:\\work' },
    })

    const running = harness.runner.start()
    const controller = await reachController(harness)
    const openRequest = harness.open.mock.calls[0]?.[0] as DshTuiOpenRequest
    const controllerOptions = harness.createController.mock.calls[0]?.[0]

    expect(openRequest).toMatchObject({
      mode: 'create',
      sessionId: 'runner-session',
      cwd: 'D:\\work',
      agentPreset: 'standard',
    })
    expect(openRequest).not.toHaveProperty('agentPresetPlan')
    expect(harness.open.mock.invocationCallOrder[0])
      .toBeLessThan(harness.createTerminal.mock.invocationCallOrder[0]!)
    expect(controllerOptions?.terminal).toBe(harness.terminal)
    expect(controllerOptions?.terminalStartMode).toBeUndefined()

    controller.finish(cleanResult)
    await running
    await harness.runner.dispose()
  })

  it.each([
    {
      name: 'an explicit create preset',
      startup: {
        mode: 'create',
        sessionId: 'explicit-session',
        agentPreset: 'code',
      } as const,
    },
    {
      name: 'a resume request',
      startup: {
        mode: 'resume',
        sessionId: 'resume-session',
      } as const,
    },
  ])('opens $name without a pre-session mode surface', async ({ startup }) => {
    const harness = productHarness({ startup })
    const running = harness.runner.start()
    const controller = await reachController(harness)

    expect(harness.open.mock.calls[0]?.[0]).not.toHaveProperty('agentPresetPlan')
    expect(harness.createController.mock.calls[0]?.[0].terminalStartMode).toBeUndefined()

    controller.finish(cleanResult)
    await running
    await harness.runner.dispose()
  })

  it('publishes the initial activated lease without collapsing its release capability', async () => {
    const session = fakeSession()
    const release = vi.fn(async () => {})
    const activated = { port: session, release }
    const harness = productHarness({
      open: async () => activated,
    })

    const running = harness.runner.start()
    const controller = await reachController(harness)
    const options = harness.createController.mock.calls[0]?.[0] as
      DshTuiControllerOptions & { readonly sessionRelease?: () => Promise<void> }

    expect(options.session).toBe(session)
    expect(options.sessionRelease).toBe(release)

    controller.finish(cleanResult)
    await running
    await harness.runner.dispose()
  })

  it('releases an unpublished initial lease when setup fails before the Controller owns it', async () => {
    const sessionDispose = vi.fn(async () => {})
    const session = fakeSession(sessionDispose)
    const release = vi.fn(async () => {})
    const harness = productHarness({
      open: async () => ({ port: session, release }),
      createTerminal: () => { throw new Error('terminal failed after activation') },
    })

    await harness.runner.start()

    expect(release).toHaveBeenCalledOnce()
    expect(sessionDispose).not.toHaveBeenCalled()
    expect(harness.reports).toEqual(['dsh-tui: terminal failed after activation\n'])
    await harness.runner.dispose()
    expect(release).toHaveBeenCalledOnce()
  })

  it('opens, starts, waits, and requests one clean host exit without a dispose cycle', async () => {
    const disposeCatalog = vi.fn()
    const catalog = Object.assign(fakeCatalog(), { dispose: disposeCatalog })
    const providers = fakeProviders()
    const harness = productHarness({ catalog, providers })
    const running = harness.runner.start()
    const controller = await reachController(harness)
    const openRequest = harness.open.mock.calls[0]?.[0] as DshTuiOpenRequest

    expect(openRequest).toMatchObject({
      mode: 'create',
      sessionId: 'runner-session',
      cwd: 'D:\\work',
    })
    expect(openRequest.signal.aborted).toBe(false)
    expect(harness.open).toHaveBeenCalledOnce()
    expect(harness.createTerminal).toHaveBeenCalledOnce()
    expect(harness.createController).toHaveBeenCalledOnce()
    expect(harness.createController.mock.calls[0]?.[0].catalog).toBe(harness.catalog)
    expect(harness.createController.mock.calls[0]?.[0].activation).toBe(harness.activation)
    expect(harness.createController.mock.calls[0]?.[0].inspection).toBe(harness.inspection)
    expect(harness.createController.mock.calls[0]?.[0].providers).toBe(providers)
    expect(controller.start).toHaveBeenCalledOnce()

    await controller.application.requestExit()
    expect(harness.exits).toEqual([])
    controller.finish(cleanResult)
    await running
    expect(harness.exits).toEqual([0])
    const requestHostExit = (harness.runner as unknown as {
      requestHostExit(code: number): void
    }).requestHostExit
    requestHostExit.call(harness.runner, 1)
    expect(harness.exits).toEqual([0])

    await harness.runner.dispose()
    await harness.runner.dispose()
    expect(controller.requestExit).not.toHaveBeenCalled()
    expect(disposeCatalog).not.toHaveBeenCalled()
    expect(harness.ownerDisposals).toEqual(['owner'])
  })

  it('maps fatal and forced controller results to sanitized 1 and returned-force 130 exits', async () => {
    const fatal = productHarness()
    const fatalRun = fatal.runner.start()
    const fatalController = await reachController(fatal)
    fatalController.finish({
      ok: false,
      reason: 'fatal',
      error: new Error('\u001b]0;owned\u0007bad\nnext\u001b[31m'),
      shutdown: { mode: 'graceful', issues: [] },
    })
    await fatalRun
    expect(fatal.exits).toEqual([1])
    expect(fatal.reports).toHaveLength(1)
    expect(fatal.reports[0]).toBe('dsh-tui: bad next\n')
    expect(fatal.reports[0]).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u)
    await fatal.runner.dispose()

    const forced = productHarness()
    const forcedRun = forced.runner.start()
    const forcedController = await reachController(forced)
    await forcedController.application.forceExit()
    expect(forced.forced).toEqual([130])
    forcedController.finish(forcedResult)
    await forcedRun
    expect(forced.exits).toEqual([130])
    await forced.runner.dispose()

    const missingFatalError = productHarness()
    const missingFatalRun = missingFatalError.runner.start()
    const missingFatalController = await reachController(missingFatalError)
    missingFatalController.finish({
      ok: false,
      reason: 'fatal',
      shutdown: { mode: 'graceful', issues: [] },
    })
    await missingFatalRun
    expect(missingFatalError.reports).toEqual([
      'dsh-tui: controller failed without an error\n',
    ])
    expect(missingFatalError.exits).toEqual([1])
    await missingFatalError.runner.dispose()
  })

  it('on root disposal requests shutdown only while the controller is running', async () => {
    const harness = productHarness({
      createController: (options) => new FakeController(options.application, true),
    })
    const running = harness.runner.start()
    const controller = await reachController(harness)

    await harness.runner.dispose()
    await running

    expect(controller.requestExit).toHaveBeenCalledExactlyOnceWith('signal')
    expect(controller.wait).toHaveBeenCalled()
    expect(harness.exits).toEqual([])
    expect(harness.ownerDisposals).toEqual(['owner'])
  })

  it.each(['stopping', 'stopped'] as const)(
    'waits without requesting another exit when the controller is %s',
    async (state) => {
      const harness = productHarness()
      const running = harness.runner.start()
      const controller = await reachController(harness)
      controller.state = state
      const disposing = harness.runner.dispose()
      controller.finish(cleanResult)

      await disposing
      await running
      expect(controller.requestExit).not.toHaveBeenCalled()
      expect(controller.wait).toHaveBeenCalled()
      expect(harness.exits).toEqual([])
    },
  )

  it('aborts startup in progress and disposes a late session without constructing a terminal', async () => {
    const opened = deferred<DshTuiProductPort>()
    let signal: AbortSignal | undefined
    const lateDispose = vi.fn(async () => {})
    const lateSession = fakeSession(lateDispose)
    const harness = productHarness({
      open: async (request) => {
        signal = request.signal
        return await opened.promise
      },
    })
    const running = harness.runner.start()
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledOnce())
    const disposing = harness.runner.dispose()

    expect(signal?.aborted).toBe(true)
    opened.resolve(lateSession)
    await disposing
    await running

    expect(lateDispose).toHaveBeenCalledOnce()
    expect(harness.createTerminal).not.toHaveBeenCalled()
    expect(harness.createController).not.toHaveBeenCalled()
    expect(harness.exits).toEqual([])
    expect(harness.ownerDisposals).toEqual(['owner'])
  })

  it('rolls back when disposal is reentered from terminal construction', async () => {
    let harness!: ProductHarness
    harness = productHarness({
      createTerminal: () => {
        void harness.runner.dispose()
        return harness.terminal
      },
    })

    await harness.runner.start()
    await harness.runner.dispose()

    expect(harness.session.dispose).toHaveBeenCalledOnce()
    expect(harness.terminal.restore).toHaveBeenCalledOnce()
    expect(harness.createController).not.toHaveBeenCalled()
    expect(harness.exits).toEqual([])
  })

  it('rolls back an idle controller when disposal is reentered from its factory', async () => {
    let harness!: ProductHarness
    harness = productHarness({
      createController: (options) => {
        const controller = new FakeController(options.application)
        void harness.runner.dispose()
        return controller
      },
    })

    await harness.runner.start()
    await harness.runner.dispose()

    expect(harness.controller().start).not.toHaveBeenCalled()
    expect(harness.controller().requestExit).not.toHaveBeenCalled()
    expect(harness.session.dispose).toHaveBeenCalledOnce()
    expect(harness.terminal.restore).toHaveBeenCalledOnce()
    expect(harness.exits).toEqual([])
  })

  it('stops startup when host disposal begins while controller.start is pending', async () => {
    let harness!: ProductHarness
    harness = productHarness({
      createController: (options) => {
        const controller = new FakeController(options.application, true)
        controller.start.mockImplementation(async () => {
          controller.state = 'running'
          void harness.runner.dispose()
        })
        return controller
      },
    })

    await harness.runner.start()
    await harness.runner.dispose()

    expect(harness.controller().requestExit).toHaveBeenCalledExactlyOnceWith('signal')
    expect(harness.exits).toEqual([])
    expect(harness.ownerDisposals).toEqual(['owner'])
  })

  it('contains an open rejection delivered after host disposal starts', async () => {
    const opened = deferred<DshTuiProductPort>()
    const harness = productHarness({ open: async () => await opened.promise })
    const running = harness.runner.start()
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledOnce())
    const disposing = harness.runner.dispose()
    opened.reject(new Error('aborted open'))

    await expect(running).resolves.toBeUndefined()
    await disposing

    expect(harness.reports).toEqual([])
    expect(harness.exits).toEqual([])
    expect(harness.ownerDisposals).toEqual(['owner'])
  })

  it.each([
    {
      name: 'open',
      make: () => productHarness({
        open: async () => { throw '\u001b[31mopen\nfailed' },
      }),
      expectedSessionDisposals: 0,
      expectedTerminalRestores: 0,
    },
    {
      name: 'terminal',
      make: () => productHarness({
        createTerminal: () => { throw new Error('terminal failed') },
      }),
      expectedSessionDisposals: 1,
      expectedTerminalRestores: 0,
    },
    {
      name: 'controller factory',
      make: () => productHarness({
        createController: () => { throw new Error('controller failed') },
      }),
      expectedSessionDisposals: 1,
      expectedTerminalRestores: 1,
    },
  ])('fails closed when $name setup fails', async ({
    make,
    expectedSessionDisposals,
    expectedTerminalRestores,
  }) => {
    const harness = make()

    await harness.runner.start()

    expect(harness.exits).toEqual([1])
    expect(harness.reports).toHaveLength(1)
    expect(harness.session.dispose).toHaveBeenCalledTimes(expectedSessionDisposals)
    expect(harness.terminal.restore).toHaveBeenCalledTimes(expectedTerminalRestores)
    await harness.runner.dispose()
    expect(harness.ownerDisposals).toEqual(['owner'])
  })

  it('cleans up after controller.start rejects and reports the original failure', async () => {
    const harness = productHarness({
      createController: (options) => {
        const controller = new FakeController(options.application)
        controller.start.mockImplementation(async () => {
          throw new Error('start failed')
        })
        return controller
      },
    })

    await harness.runner.start()

    expect(harness.exits).toEqual([1])
    expect(harness.reports).toEqual(['dsh-tui: start failed\n'])
    expect(harness.session.dispose).toHaveBeenCalledOnce()
    expect(harness.terminal.restore).toHaveBeenCalledOnce()
    await harness.runner.dispose()
  })

  it('owns cleanup before start and rejects a duplicate start', async () => {
    const unopened = productHarness()
    await unopened.runner.dispose()
    expect(unopened.ownerDisposals).toEqual(['owner'])

    const started = productHarness()
    const running = started.runner.start()
    await reachController(started)
    expect(() => started.runner.start()).toThrow('already started')
    started.controller().finish(cleanResult)
    await running
    await started.runner.dispose()
  })

  it('contains a host signal before startup and ignores later signals after disposal', async () => {
    const harness = productHarness()

    harness.runner.requestSignalExit()
    harness.runner.requestSignalExit()
    expect(harness.createTerminal).not.toHaveBeenCalled()
    await harness.runner.start()

    expect(harness.exits).toEqual([0])
    expect(harness.session.dispose).toHaveBeenCalledOnce()
    await harness.runner.dispose()
    harness.runner.requestSignalExit()
    expect(harness.exits).toEqual([0])
  })

  it('reports cleanup failure while cancelling startup and exits fatally', async () => {
    const harness = productHarness({
      open: async () => ({
        port: fakeSession(),
        release: async () => { throw new Error('cancel cleanup failed') },
      }),
    })

    harness.runner.requestSignalExit()
    await harness.runner.start()

    expect(harness.reports).toEqual([
      'dsh-tui: product cleanup failed: session: cancel cleanup failed\n',
    ])
    expect(harness.exits).toEqual([1])
    await harness.runner.dispose()
  })

  it('contains a synchronous clean-exit failure while cancelling startup', async () => {
    const appExit = vi.fn(() => { throw new Error('cancel exit failed') })
    const harness = productHarness({ appExit })

    harness.runner.requestSignalExit()
    await harness.runner.start()

    expect(appExit).toHaveBeenCalledExactlyOnceWith(0)
    expect(harness.reports).toEqual(['dsh-tui: cancel exit failed\n'])
    await harness.runner.dispose()
  })

  it('treats an open rejection delivered after startup cancellation as clean cancellation', async () => {
    const harness = productHarness({
      open: async () => { throw new Error('late aborted open') },
    })

    harness.runner.requestSignalExit()
    await harness.runner.start()

    expect(harness.reports).toEqual([])
    expect(harness.exits).toEqual([0])
    await harness.runner.dispose()
  })

  it('suppresses host exit when disposal begins during startup-cancellation cleanup', async () => {
    let harness!: ProductHarness
    harness = productHarness({
      open: async () => ({
        port: fakeSession(),
        release: async () => { void harness.runner.dispose() },
      }),
    })

    harness.runner.requestSignalExit()
    await harness.runner.start()
    await harness.runner.dispose()

    expect(harness.exits).toEqual([])
    expect(harness.reports).toEqual([])
    expect(harness.ownerDisposals).toEqual(['owner'])
  })

  it('routes an active host signal through controller shutdown and restores the terminal immediately', async () => {
    const harness = productHarness()
    const running = harness.runner.start()
    const controller = await reachController(harness)

    harness.runner.requestSignalExit()
    expect(controller.requestExit).toHaveBeenCalledExactlyOnceWith('signal')
    expect(harness.terminal.stopAcceptingInput).toHaveBeenCalledOnce()
    expect(harness.terminal.restore).toHaveBeenCalledOnce()

    controller.finish(cleanResult)
    await running
    await harness.runner.dispose()
  })

  it('keeps idle-controller and restored-terminal signal guards fail closed', async () => {
    const harness = productHarness()
    const idleController = new FakeController({ requestExit: vi.fn(), forceExit: vi.fn() })
    const internal = harness.runner as unknown as {
      controller: DshTuiControllerPort | undefined
      terminal: TerminalDriver | undefined
    }
    internal.controller = idleController
    internal.terminal = harness.terminal

    harness.runner.requestSignalExit()
    expect(idleController.requestExit).not.toHaveBeenCalled()
    expect(harness.terminal.restore).toHaveBeenCalledOnce()

    ;(harness.terminal as unknown as { state: TerminalDriver['state'] }).state = 'restored'
    harness.runner.restoreTerminalNow()
    expect(harness.terminal.restore).toHaveBeenCalledOnce()
    await harness.runner.dispose()
  })

  it('contains signal-request and synchronous terminal-recovery failures', async () => {
    const harness = productHarness()
    const running = harness.runner.start()
    const controller = await reachController(harness)
    vi.mocked(controller.requestExit).mockRejectedValueOnce(new Error('signal exit failed'))
    vi.mocked(harness.terminal.stopAcceptingInput)
      .mockImplementationOnce(() => { throw new Error('stop input failed') })
    vi.mocked(harness.terminal.restore)
      .mockImplementationOnce(() => { throw new Error('restore failed') })

    harness.runner.requestSignalExit()
    await vi.waitFor(() => expect(harness.reports).toEqual([
      'dsh-tui: stop input failed\n',
      'dsh-tui: restore failed\n',
      'dsh-tui: signal exit failed\n',
    ]))

    controller.finish(cleanResult)
    await running
    await harness.runner.dispose()
  })

  it('normalizes unknown and empty untrusted errors', () => {
    expect(sanitizeDshTuiProductError({ toString: () => '\u0000plain\tvalue' }))
      .toBe('plain value')
    expect(sanitizeDshTuiProductError('\u001b[31m\u0000')).toBe('unknown error')
  })

  it('contains an untrusted error whose coercion itself throws', () => {
    const hostile = new Proxy({}, {
      getPrototypeOf: () => { throw new Error('prototype trap') },
      get: () => { throw new Error('string trap') },
    })

    expect(sanitizeDshTuiProductError(hostile)).toBe('unknown error')
  })

  it('preserves primary and rollback failures without rejecting the product task', async () => {
    const dispose = vi.fn(async () => {
      throw new Error('\u001b[31msession\ncleanup')
    })
    const restore = vi.fn(() => {
      throw new Error('\u0000terminal cleanup')
    })
    const session = fakeSession(dispose)
    const terminal = fakeTerminal(restore)
    const harness = productHarness({
      open: async () => session,
      createTerminal: () => terminal,
      createController: () => { throw new Error('controller primary') },
    })

    await expect(harness.runner.start()).resolves.toBeUndefined()

    expect(dispose).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
    expect(harness.reports).toEqual([
      'dsh-tui: controller primary\n',
      'dsh-tui: product cleanup failed: session: session cleanup; terminal: terminal cleanup\n',
    ])
    expect(harness.exits).toEqual([1])
    await harness.runner.dispose()
  })

  it('contains a failing error-report seam after cleanup', async () => {
    const reportError = vi.fn(() => { throw new Error('stderr failed') })
    const harness = productHarness({
      createTerminal: () => { throw new Error('terminal primary') },
      reportError,
    })

    await expect(harness.runner.start()).resolves.toBeUndefined()

    expect(reportError).toHaveBeenCalledOnce()
    expect(harness.session.dispose).toHaveBeenCalledOnce()
    expect(harness.exits).toEqual([1])
    await harness.runner.dispose()
  })

  it('does not cycle when synchronous appExit triggers root disposal', async () => {
    let harness!: ProductHarness
    const appExit = vi.fn(() => { void harness.runner.dispose() })
    harness = productHarness({ appExit })
    const running = harness.runner.start()
    const controller = await reachController(harness)
    controller.finish(cleanResult)

    await running
    await harness.runner.dispose()

    expect(appExit).toHaveBeenCalledExactlyOnceWith(0)
    expect(harness.forced).toEqual([])
    expect(harness.ownerDisposals).toEqual(['owner'])
  })

  it('reports a synchronous appExit failure without issuing a second exit', async () => {
    const appExit = vi.fn(() => { throw new Error('exit failed') })
    const harness = productHarness({ appExit })
    const running = harness.runner.start()
    const controller = await reachController(harness)
    controller.finish(cleanResult)

    await running

    expect(appExit).toHaveBeenCalledExactlyOnceWith(0)
    expect(harness.reports).toEqual(['dsh-tui: exit failed\n'])
    await harness.runner.dispose()
  })

  it('contains a synchronous fatal-exit failure after reporting setup failure', async () => {
    const appExit = vi.fn(() => { throw new Error('fatal exit failed') })
    const harness = productHarness({
      createTerminal: () => { throw new Error('terminal setup failed') },
      appExit,
    })

    await expect(harness.runner.start()).resolves.toBeUndefined()

    expect(appExit).toHaveBeenCalledExactlyOnceWith(1)
    expect(harness.reports).toEqual([
      'dsh-tui: terminal setup failed\n',
      'dsh-tui: fatal exit failed\n',
    ])
    await harness.runner.dispose()
  })
})
