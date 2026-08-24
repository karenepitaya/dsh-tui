import { describe, expect, it, vi } from 'vitest'
import type {
  AgentPresetCatalogEntry,
  AgentPresetCatalogPort,
  AgentPresetCatalogSnapshot,
  ListAgentPresetsOptions,
} from '../src/preset/catalog-port.ts'
import { selectStartupPreset } from '../src/app/startup-preset-selector.ts'
import type {
  TerminalDriver,
  TerminalDriverCallbacks,
  TerminalDriverState,
} from '../src/terminal/driver.ts'
import type { TerminalInputAction } from '../src/terminal/input.ts'
import type { TerminalViewport, UiFrame } from '../src/ui/frame.ts'

vi.mock('../src/ui/frame.ts', () => ({
  renderStartupPresetFrame: (panel: unknown, viewport: TerminalViewport): UiFrame => ({
    title: 'Startup presets',
    viewport,
    lines: [JSON.stringify(panel)],
  }),
}))

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function preset(
  id: string,
  overrides: Partial<AgentPresetCatalogEntry> = {},
): AgentPresetCatalogEntry {
  return Object.freeze({
    id,
    trust: 'system',
    sourcePath: `D:\\presets\\${id}\\agent.yml`,
    isDefault: false,
    ...overrides,
  })
}

function snapshot(
  presets: readonly AgentPresetCatalogEntry[],
  defaultId = 'standard',
): AgentPresetCatalogSnapshot {
  return Object.freeze({ defaultId, presets: Object.freeze([...presets]) })
}

interface CatalogRequest {
  readonly signal: AbortSignal | undefined
  readonly result: Deferred<AgentPresetCatalogSnapshot>
}

class FakeCatalog implements AgentPresetCatalogPort {
  readonly requests: CatalogRequest[] = []

  constructor(private readonly timeline?: string[]) {}

  listPresets(options?: ListAgentPresetsOptions): Promise<AgentPresetCatalogSnapshot> {
    this.timeline?.push('catalog:list')
    const result = deferred<AgentPresetCatalogSnapshot>()
    this.requests.push({ signal: options?.signal, result })
    return result.promise
  }
}

class FakeTerminal implements TerminalDriver {
  private callbacks: TerminalDriverCallbacks | undefined
  private currentState: TerminalDriverState = 'idle'
  private currentViewport: TerminalViewport = { columns: 60, rows: 12 }
  readonly frames: UiFrame[] = []
  startCount = 0
  handoffCount = 0
  stopCount = 0
  restoreCount = 0
  throwOnStart: unknown
  throwOnRender: unknown
  throwAfterRender: unknown
  onStart: (() => void) | undefined
  onRender: (() => void) | undefined

  constructor(private readonly timeline?: string[]) {}

  get state(): TerminalDriverState {
    return this.currentState
  }

  get viewport(): TerminalViewport {
    return this.currentViewport
  }

  start(callbacks: TerminalDriverCallbacks): void {
    this.startCount += 1
    this.timeline?.push('terminal:start')
    if (this.throwOnStart !== undefined) throw this.throwOnStart
    this.callbacks = callbacks
    this.currentState = 'running'
    this.onStart?.()
  }

  handoff(callbacks: TerminalDriverCallbacks): void {
    this.handoffCount += 1
    this.callbacks = callbacks
  }

  render(frame: UiFrame): void {
    if (this.throwOnRender !== undefined) throw this.throwOnRender
    this.onRender?.()
    if (this.throwAfterRender !== undefined) throw this.throwAfterRender
    const panel = JSON.parse(frame.lines[0]!) as { loading?: boolean }
    this.timeline?.push(`terminal:render:${panel.loading === true ? 'loading' : 'ready'}`)
    this.frames.push(frame)
  }

  stopAcceptingInput(): void {
    this.stopCount += 1
    this.currentState = 'quiescing'
  }

  restore(): void {
    this.restoreCount += 1
    this.currentState = 'restored'
  }

  input(action: TerminalInputAction): void {
    this.callbacks?.onInput(action)
  }

  resize(viewport: TerminalViewport): void {
    this.currentViewport = viewport
    this.callbacks?.onResize(viewport)
  }

  capturedCallbacks(): TerminalDriverCallbacks | undefined {
    return this.callbacks
  }
}

interface RenderedPanel {
  readonly view?: {
    readonly selectedPresetId?: string
    readonly rows: readonly { readonly id: string }[]
  }
  readonly loading: boolean
  readonly loaded: boolean
  readonly error?: string
  readonly notice?: string
}

function panelAt(terminal: FakeTerminal, index = -1): RenderedPanel {
  const frame = index < 0 ? terminal.frames.at(index) : terminal.frames[index]
  if (frame === undefined) throw new Error('expected a rendered frame')
  return JSON.parse(frame.lines[0]!) as RenderedPanel
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition was not reached')
}

describe('startup preset selector lifecycle', () => {
  it('renders loading before discovery and returns an exact selected terminal lease', async () => {
    const timeline: string[] = []
    const catalog = new FakeCatalog(timeline)
    const terminal = new FakeTerminal(timeline)
    const requestCancel = vi.fn()
    const reportFatal = vi.fn()
    const signal = new AbortController()
    const selecting = selectStartupPreset({
      catalog,
      terminal,
      signal: signal.signal,
      requestCancel,
      reportFatal,
    })

    expect(timeline).toEqual([
      'terminal:start',
      'terminal:render:loading',
      'catalog:list',
    ])
    expect(panelAt(terminal, 0)).toMatchObject({
      loading: true,
      loaded: false,
    })
    expect(panelAt(terminal, 0).view).toBeUndefined()

    catalog.requests[0]!.result.resolve(snapshot([
      preset('standard', { isDefault: true }),
      preset('minimal'),
    ]))
    await waitFor(() => panelAt(terminal).loaded && !panelAt(terminal).loading)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    const result = await selecting

    expect(result.kind).toBe('selected')
    if (result.kind !== 'selected') throw new Error('expected selected result')
    expect(result.lease.plan).toEqual({
      id: 'minimal',
      trust: 'system',
      sourcePath: 'D:\\presets\\minimal\\agent.yml',
    })
    expect(panelAt(terminal).notice).toMatch(/Starting.*minimal/iu)
    expect(terminal.state).toBe('running')
    expect(terminal.startCount).toBe(1)
    expect(terminal.stopCount).toBe(0)
    expect(terminal.restoreCount).toBe(0)

    const frameCount = terminal.frames.length
    terminal.input({ type: 'move-up' })
    expect(terminal.frames).toHaveLength(frameCount)
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'interrupt' })
    expect(requestCancel).toHaveBeenCalledTimes(2)
    terminal.resize({ columns: 44, rows: 9 })
    expect(terminal.frames.at(-1)?.viewport).toEqual({ columns: 44, rows: 9 })

    const callbacks = terminal.capturedCallbacks()!
    result.lease.release()
    result.lease.release()
    const releasedFrameCount = terminal.frames.length
    callbacks.onInput({ type: 'interrupt' })
    callbacks.onResize({ columns: 45, rows: 10 })
    expect(requestCancel).toHaveBeenCalledTimes(2)
    expect(terminal.frames).toHaveLength(releasedFrameCount)
    expect(reportFatal).not.toHaveBeenCalled()
  })

  it('fences stale refreshes and retains the last good roster on refresh failure', async () => {
    const catalog = new FakeCatalog()
    const terminal = new FakeTerminal()
    const selecting = selectStartupPreset({
      catalog,
      terminal,
      signal: new AbortController().signal,
      requestCancel: () => {},
      reportFatal: () => {},
    })
    catalog.requests[0]!.result.resolve(snapshot([
      preset('standard', { isDefault: true }),
      preset('minimal'),
    ]))
    await waitFor(() => panelAt(terminal).loaded)

    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => catalog.requests.length === 2)
    terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => catalog.requests.length === 3)
    expect(catalog.requests[1]!.signal?.aborted).toBe(true)

    catalog.requests[2]!.result.resolve(snapshot([
      preset('standard', { isDefault: true }),
      preset('code'),
    ]))
    await waitFor(() => panelAt(terminal).view?.rows.some(row => row.id === 'code') === true)
    catalog.requests[1]!.result.resolve(snapshot([preset('stale', { isDefault: true })], 'stale'))
    await Promise.resolve()
    expect(panelAt(terminal).view?.rows.map(row => row.id)).toEqual(['standard', 'code'])

    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => catalog.requests.length === 4)
    catalog.requests[3]!.result.reject(new Error('refresh exploded\nnext'))
    await waitFor(() => panelAt(terminal).error !== undefined)
    expect(panelAt(terminal)).toMatchObject({
      loaded: true,
      loading: false,
      error: 'refresh exploded next',
    })
    expect(panelAt(terminal).view?.rows.map(row => row.id)).toEqual(['standard', 'code'])

    terminal.input({ type: 'submit' })
    const result = await selecting
    expect(result.kind).toBe('selected')
    if (result.kind === 'selected') result.lease.release()
  })

  it('keeps broken and empty selections open with an actionable notice', async () => {
    const catalog = new FakeCatalog()
    const terminal = new FakeTerminal()
    const requestCancel = vi.fn()
    const selecting = selectStartupPreset({
      catalog,
      terminal,
      signal: new AbortController().signal,
      requestCancel,
      reportFatal: () => {},
    })
    let settled = false
    void selecting.then(() => { settled = true }, () => { settled = true })
    catalog.requests[0]!.result.resolve(snapshot([
      preset('broken', {
        isDefault: true,
        broken: 'composition cannot be loaded',
      }),
    ], 'broken'))
    await waitFor(() => panelAt(terminal).loaded)

    terminal.input({ type: 'submit' })
    expect(panelAt(terminal).notice).toContain('composition cannot be loaded')
    expect(settled).toBe(false)

    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => catalog.requests.length === 2)
    catalog.requests[1]!.result.resolve(snapshot([], 'missing'))
    await waitFor(() => panelAt(terminal).view?.rows.length === 0)
    terminal.input({ type: 'submit' })
    expect(panelAt(terminal).notice).toMatch(/No.*preset/iu)
    expect(settled).toBe(false)

    terminal.input({ type: 'escape' })
    await expect(selecting).resolves.toEqual({ kind: 'cancelled' })
    expect(requestCancel).toHaveBeenCalledOnce()
    expect(terminal.restoreCount).toBe(0)
  })

  it('aborts and joins ignored roster work before returning cancelled', async () => {
    const catalog = new FakeCatalog()
    const terminal = new FakeTerminal()
    const controller = new AbortController()
    const selecting = selectStartupPreset({
      catalog,
      terminal,
      signal: controller.signal,
      requestCancel: () => {},
      reportFatal: () => {},
    })
    let settled = false
    void selecting.then(() => { settled = true }, () => { settled = true })

    controller.abort()
    expect(catalog.requests[0]!.signal?.aborted).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(false)
    catalog.requests[0]!.result.resolve(snapshot([preset('late')], 'late'))

    await expect(selecting).resolves.toEqual({ kind: 'cancelled' })
    expect(terminal.state).toBe('running')
    expect(terminal.restoreCount).toBe(0)
  })

  it('contains a cancellation that aborts reentrantly and an abort during terminal start', async () => {
    const catalog = new FakeCatalog()
    const terminal = new FakeTerminal()
    const controller = new AbortController()
    const requestCancel = vi.fn(() => controller.abort())
    const selecting = selectStartupPreset({
      catalog,
      terminal,
      signal: controller.signal,
      requestCancel,
      reportFatal: () => {},
    })
    terminal.input({ type: 'interrupt' })
    catalog.requests[0]!.result.resolve(snapshot([]))
    await expect(selecting).resolves.toEqual({ kind: 'cancelled' })
    expect(requestCancel).toHaveBeenCalledOnce()

    const duringStartCatalog = new FakeCatalog()
    const duringStartTerminal = new FakeTerminal()
    const duringStartAbort = new AbortController()
    duringStartTerminal.onStart = () => duringStartAbort.abort()
    await expect(selectStartupPreset({
      catalog: duringStartCatalog,
      terminal: duringStartTerminal,
      signal: duringStartAbort.signal,
      requestCancel: () => {},
      reportFatal: () => {},
    })).resolves.toEqual({ kind: 'cancelled' })
    expect(duringStartCatalog.requests).toHaveLength(0)
    expect(duringStartTerminal.frames).toHaveLength(0)
    expect(duringStartTerminal.restoreCount).toBe(0)
  })

  it('handles pre-abort plus unloaded and empty picker input without side effects', async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    const preAbortTerminal = new FakeTerminal()
    await expect(selectStartupPreset({
      catalog: new FakeCatalog(),
      terminal: preAbortTerminal,
      signal: preAborted.signal,
      requestCancel: () => {},
      reportFatal: () => {},
    })).resolves.toEqual({ kind: 'cancelled' })
    expect(preAbortTerminal.startCount).toBe(0)

    const pendingCatalog = new FakeCatalog()
    const pendingTerminal = new FakeTerminal()
    const pendingAbort = new AbortController()
    const pending = selectStartupPreset({
      catalog: pendingCatalog,
      terminal: pendingTerminal,
      signal: pendingAbort.signal,
      requestCancel: () => {},
      reportFatal: () => {},
    })
    pendingTerminal.input({ type: 'backspace' })
    pendingTerminal.input({ type: 'move-up' })
    pendingTerminal.input({ type: 'submit' })
    pendingTerminal.resize({ columns: 52, rows: 10 })
    expect(panelAt(pendingTerminal).notice).toContain('not loaded')
    pendingAbort.abort()
    pendingCatalog.requests[0]!.result.resolve(snapshot([]))
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })

    const emptyCatalog = new FakeCatalog()
    const emptyTerminal = new FakeTerminal()
    const empty = selectStartupPreset({
      catalog: emptyCatalog,
      terminal: emptyTerminal,
      signal: new AbortController().signal,
      requestCancel: () => {},
      reportFatal: () => {},
    })
    emptyCatalog.requests[0]!.result.resolve(snapshot([], 'missing'))
    await waitFor(() => panelAt(emptyTerminal).loaded)
    emptyTerminal.input({ type: 'move-up' })
    emptyTerminal.input({ type: 'submit' })
    expect(panelAt(emptyTerminal).notice).toContain('No agent preset')
    emptyTerminal.input({ type: 'escape' })
    await expect(empty).resolves.toEqual({ kind: 'cancelled' })
  })

  it('normalizes non-Error refresh failures and fences an aborted rejection', async () => {
    const catalog = new FakeCatalog()
    const terminal = new FakeTerminal()
    const selecting = selectStartupPreset({
      catalog,
      terminal,
      signal: new AbortController().signal,
      requestCancel: () => {},
      reportFatal: () => {},
    })
    catalog.requests[0]!.result.reject('plain failure')
    await waitFor(() => panelAt(terminal).error === 'plain failure')

    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => catalog.requests.length === 2)
    catalog.requests[1]!.result.reject({
      toString: () => { throw new Error('cannot stringify') },
    })
    await waitFor(() => panelAt(terminal).error === 'Agent preset refresh failed')

    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => catalog.requests.length === 3)
    catalog.requests[2]!.result.reject(new Error(''))
    await waitFor(() => panelAt(terminal).error === 'Agent preset refresh failed')

    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => catalog.requests.length === 4)
    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => catalog.requests.length === 5)
    catalog.requests[3]!.result.reject(new Error('stale rejected refresh'))
    catalog.requests[4]!.result.resolve(snapshot([
      preset('standard', { isDefault: true }),
    ]))
    await waitFor(() => panelAt(terminal).loaded)
    terminal.input({ type: 'submit' })
    const result = await selecting
    if (result.kind === 'selected') result.lease.release()
  })

  it('cancels while selection waits for an abort-ignoring refresh', async () => {
    const catalog = new FakeCatalog()
    const terminal = new FakeTerminal()
    const requestCancel = vi.fn()
    const selecting = selectStartupPreset({
      catalog,
      terminal,
      signal: new AbortController().signal,
      requestCancel,
      reportFatal: () => {},
    })
    catalog.requests[0]!.result.resolve(snapshot([
      preset('standard', { isDefault: true }),
    ]))
    await waitFor(() => panelAt(terminal).loaded)
    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => catalog.requests.length === 2)
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-up' })
    terminal.resize({ columns: 49, rows: 8 })
    terminal.input({ type: 'escape' })
    expect(catalog.requests[1]!.signal?.aborted).toBe(true)
    catalog.requests[1]!.result.resolve(snapshot([preset('late')], 'late'))

    await expect(selecting).resolves.toEqual({ kind: 'cancelled' })
    expect(requestCancel).toHaveBeenCalledOnce()

    const reentrantCatalog = new FakeCatalog()
    const reentrantTerminal = new FakeTerminal()
    const reentrantAbort = new AbortController()
    const reentrant = selectStartupPreset({
      catalog: reentrantCatalog,
      terminal: reentrantTerminal,
      signal: reentrantAbort.signal,
      requestCancel: () => {},
      reportFatal: () => {},
    })
    reentrantCatalog.requests[0]!.result.resolve(snapshot([
      preset('standard', { isDefault: true }),
    ]))
    await waitFor(() => panelAt(reentrantTerminal).loaded)
    reentrantTerminal.onRender = () => reentrantAbort.abort()
    reentrantTerminal.input({ type: 'insert', text: 'R' })
    await expect(reentrant).resolves.toEqual({ kind: 'cancelled' })
    expect(reentrantCatalog.requests).toHaveLength(1)
  })

  it('rejects async render and requestCancel failures after joining roster work', async () => {
    const renderCatalog = new FakeCatalog()
    const renderTerminal = new FakeTerminal()
    const renderFailure = selectStartupPreset({
      catalog: renderCatalog,
      terminal: renderTerminal,
      signal: new AbortController().signal,
      requestCancel: () => {},
      reportFatal: () => {},
    })
    renderTerminal.throwOnRender = new Error('roster render failed')
    renderCatalog.requests[0]!.result.resolve(snapshot([
      preset('standard', { isDefault: true }),
    ]))
    await expect(renderFailure).rejects.toThrow('roster render failed')

    const cancelCatalog = new FakeCatalog()
    const cancelTerminal = new FakeTerminal()
    const cancelFailure = selectStartupPreset({
      catalog: cancelCatalog,
      terminal: cancelTerminal,
      signal: new AbortController().signal,
      requestCancel: () => { throw new Error('cancel callback failed') },
      reportFatal: () => {},
    })
    cancelTerminal.input({ type: 'escape' })
    cancelCatalog.requests[0]!.result.resolve(snapshot([]))
    await expect(cancelFailure).rejects.toThrow('cancel callback failed')
  })

  it('does not let cancellation settlement swallow a reentrant roster render failure', async () => {
    const catalog = new FakeCatalog()
    const terminal = new FakeTerminal()
    const controller = new AbortController()
    const reportFatal = vi.fn()
    const selecting = selectStartupPreset({
      catalog,
      terminal,
      signal: controller.signal,
      requestCancel: () => {},
      reportFatal,
    })

    terminal.onRender = () => controller.abort()
    terminal.throwAfterRender = new Error('render failed after cancellation')
    catalog.requests[0]!.result.resolve(snapshot([
      preset('standard', { isDefault: true }),
    ]))

    await expect(selecting).rejects.toThrow('render failed after cancellation')
    expect(reportFatal).not.toHaveBeenCalled()
  })

  it('rejects startup/render failures but reports render failure after selection', async () => {
    const startCatalog = new FakeCatalog()
    const startTerminal = new FakeTerminal()
    startTerminal.throwOnStart = new Error('start failed')
    await expect(selectStartupPreset({
      catalog: startCatalog,
      terminal: startTerminal,
      signal: new AbortController().signal,
      requestCancel: () => {},
      reportFatal: () => {},
    })).rejects.toThrow('start failed')
    expect(startTerminal.restoreCount).toBe(0)

    const renderCatalog = new FakeCatalog()
    const renderTerminal = new FakeTerminal()
    renderTerminal.throwOnRender = new Error('initial render failed')
    await expect(selectStartupPreset({
      catalog: renderCatalog,
      terminal: renderTerminal,
      signal: new AbortController().signal,
      requestCancel: () => {},
      reportFatal: () => {},
    })).rejects.toThrow('initial render failed')
    expect(renderCatalog.requests).toHaveLength(0)
    expect(renderTerminal.restoreCount).toBe(0)

    const selectedCatalog = new FakeCatalog()
    const selectedTerminal = new FakeTerminal()
    const reportFatal = vi.fn(() => { throw new Error('report failure') })
    const selected = selectStartupPreset({
      catalog: selectedCatalog,
      terminal: selectedTerminal,
      signal: new AbortController().signal,
      requestCancel: () => {},
      reportFatal,
    })
    selectedCatalog.requests[0]!.result.resolve(snapshot([
      preset('standard', { isDefault: true }),
    ]))
    await waitFor(() => panelAt(selectedTerminal).loaded)
    selectedTerminal.input({ type: 'submit' })
    const result = await selected
    expect(result.kind).toBe('selected')
    selectedTerminal.throwOnRender = new Error('late render failed')
    expect(() => selectedTerminal.resize({ columns: 41, rows: 7 })).not.toThrow()
    expect(reportFatal).toHaveBeenCalledWith(expect.objectContaining({
      message: 'late render failed',
    }))
    if (result.kind === 'selected') result.lease.release()
  })
})
