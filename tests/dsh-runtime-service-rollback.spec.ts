import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  createScopes: vi.fn(),
  createFactories: vi.fn(),
  openRuntime: vi.fn(),
  officialSelection: vi.fn((selection: unknown) => selection),
}))

function value<T>(key: string): T {
  return mocked.values.get(key) as T
}

vi.mock('../src/lifecycle/application-scope-host.ts', () => ({
  createStandaloneApplicationScopeHost: mocked.createScopes,
}))

vi.mock('../src/runtime/session-capability.ts', () => ({
  SessionCapabilityFactoryRegistry: function MockSessionCapabilityFactoryRegistry() {
    return value('registry')
  },
}))

vi.mock('../src/dsh/agent-preset-catalog.ts', () => ({
  DshAgentPresetCatalog: function MockDshAgentPresetCatalog() { return value('presets') },
}))

vi.mock('../src/dsh/cold-resume-coordinator.ts', () => ({
  DshColdResumeCoordinator: function MockDshColdResumeCoordinator() {
    return value('coordinator')
  },
}))

vi.mock('../src/dsh/cold-session-activation.ts', () => ({
  DshSessionActivation: function MockDshSessionActivation() { return value('activation') },
}))

vi.mock('../src/dsh/interaction-hub.ts', () => ({
  DshInteractionHub: function MockDshInteractionHub() { return value('interactionHub') },
}))

vi.mock('../src/dsh/runtime-port.ts', () => ({
  openDshRuntimePort: mocked.openRuntime,
}))

vi.mock('../src/dsh/session-catalog.ts', () => ({
  DshSessionCatalog: function MockDshSessionCatalog() { return value('catalog') },
}))

vi.mock('../src/dsh/session-inspection.ts', () => ({
  DshSessionInspection: function MockDshSessionInspection() { return value('inspection') },
}))

vi.mock('../src/dsh/session-fork.ts', () => ({
  DshSessionFork: function MockDshSessionFork() { return value('fork') },
}))

vi.mock('../src/dsh/provider-connection.ts', () => ({
  DshProviderConnection: function MockDshProviderConnection() { return value('providers') },
}))

vi.mock('../src/dsh/settings-catalog.ts', () => ({
  DshSettingsCatalog: function MockDshSettingsCatalog() { return value('settings') },
}))

vi.mock('../src/dsh/plugin-inventory.ts', () => ({
  DshPluginInventory: function MockDshPluginInventory() { return value('pluginInventory') },
}))

vi.mock('../src/dsh/model-selection.ts', () => ({
  DshModelSelectionHub: function MockDshModelSelectionHub() { return value('modelHub') },
  officialModelSelection: mocked.officialSelection,
}))

vi.mock('../src/dsh/session-capability-factories.ts', () => ({
  createDshSessionCapabilityFactories: mocked.createFactories,
  DshSessionCorePort: class MockDshSessionCorePort {},
}))

vi.mock('../src/dsh/session-port-composer.ts', () => ({
  DshSessionPortComposer: function MockDshSessionPortComposer() { return value('composer') },
}))

import { provideDshTuiRuntime } from '../src/dsh/runtime-service.ts'

interface Fixture {
  readonly ctx: Context
  readonly scopes: { readonly appScope: object; readonly dispose: ReturnType<typeof vi.fn> }
  readonly sessionScope: { readonly dispose: ReturnType<typeof vi.fn> }
  readonly registration: { readonly ready: Promise<void>; readonly dispose: ReturnType<typeof vi.fn> }
  readonly registry: { readonly dispose: ReturnType<typeof vi.fn> }
  readonly composer: {
    readonly createSessionScope: ReturnType<typeof vi.fn>
    readonly prepare: ReturnType<typeof vi.fn>
    readonly completeSession: ReturnType<typeof vi.fn>
    readonly release: ReturnType<typeof vi.fn>
    readonly disposeSessions: ReturnType<typeof vi.fn>
  }
  readonly coordinator: { readonly dispose: ReturnType<typeof vi.fn> }
  readonly interactionHub: { readonly dispose: ReturnType<typeof vi.fn> }
  readonly modelHub: { readonly dispose: ReturnType<typeof vi.fn> }
  readonly settings: { readonly disposeSettings: ReturnType<typeof vi.fn> }
  readonly pluginInventory: { readonly disposePluginInventory: ReturnType<typeof vi.fn> }
}

function fixture(): Fixture {
  const sessionScope = { dispose: vi.fn(async () => {}) }
  const scopes = { appScope: {}, dispose: vi.fn(async () => {}) }
  const registration = { ready: Promise.resolve(), dispose: vi.fn(async () => {}) }
  const registry = { dispose: vi.fn(async () => {}) }
  const composer = {
    createSessionScope: vi.fn(() => sessionScope),
    prepare: vi.fn(async () => Object.freeze({ exact: true })),
    completeSession: vi.fn(),
    release: vi.fn(async () => {}),
    disposeSessions: vi.fn(async () => {}),
  }
  const coordinator = { dispose: vi.fn(async () => {}) }
  const interactionHub = { dispose: vi.fn() }
  const modelHub = { dispose: vi.fn(async () => {}) }
  const settings = { disposeSettings: vi.fn(async () => {}) }
  const pluginInventory = { disposePluginInventory: vi.fn(async () => {}) }
  const factories = { register: vi.fn(() => registration) }
  const ctx = { provide: vi.fn() } as unknown as Context

  mocked.values.set('registry', registry)
  mocked.values.set('composer', composer)
  mocked.values.set('coordinator', coordinator)
  mocked.values.set('interactionHub', interactionHub)
  mocked.values.set('modelHub', modelHub)
  mocked.values.set('settings', settings)
  mocked.values.set('pluginInventory', pluginInventory)
  for (const key of ['catalog', 'activation', 'inspection', 'fork', 'presets', 'providers']) {
    mocked.values.set(key, Object.freeze({ key }))
  }
  mocked.createScopes.mockReturnValue(scopes)
  mocked.createFactories.mockReturnValue(factories)

  return {
    ctx,
    scopes,
    sessionScope,
    registration,
    registry,
    composer,
    coordinator,
    interactionHub,
    modelHub,
    settings,
    pluginInventory,
  }
}

function internalOptions(sessionId: string) {
  return { mode: 'create' as const, sessionId }
}

describe('DSH runtime service rollback boundaries', () => {
  beforeEach(() => {
    mocked.values.clear()
    mocked.createScopes.mockReset()
    mocked.createFactories.mockReset()
    mocked.openRuntime.mockReset()
    mocked.officialSelection.mockClear()
  })

  it('aggregates every independently owned runtime disposal failure', async () => {
    const state = fixture()
    const failures = [
      new Error('sessions'),
      new Error('coordinator'),
      new Error('factories'),
      new Error('registry'),
      new Error('interactions'),
      new Error('models'),
      new Error('settings'),
      new Error('plugins'),
      new Error('scopes'),
    ]
    state.composer.disposeSessions.mockRejectedValueOnce(failures[0])
    state.coordinator.dispose.mockRejectedValueOnce(failures[1])
    state.registration.dispose.mockRejectedValueOnce(failures[2])
    state.registry.dispose.mockRejectedValueOnce(failures[3])
    state.interactionHub.dispose.mockImplementationOnce(() => { throw failures[4] })
    state.modelHub.dispose.mockRejectedValueOnce(failures[5])
    state.settings.disposeSettings.mockRejectedValueOnce(failures[6])
    state.pluginInventory.disposePluginInventory.mockRejectedValueOnce(failures[7])
    state.scopes.dispose.mockRejectedValueOnce(failures[8])

    const owner = provideDshTuiRuntime(state.ctx)

    await expect(owner.dispose()).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'DSH-TUI runtime owner disposal failed',
      errors: failures,
    })
  })

  it('rejects setup contexts that omit the unpublished Agent', async () => {
    const state = fixture()
    mocked.openRuntime.mockImplementationOnce(async (_ctx, options) => {
      await options.setup({ agent: undefined })
      throw new Error('unreachable')
    })
    const owner = provideDshTuiRuntime(state.ctx)

    await expect(owner.service.openSession({ mode: 'create' }))
      .rejects.toThrow('did not expose its unpublished Agent')
    expect(state.sessionScope.dispose).toHaveBeenCalledOnce()
  })

  it('aggregates owned scope and runtime cleanup when setup never ran', async () => {
    const state = fixture()
    const scopeFailure = new Error('scope cleanup failed')
    const runtimeFailure = new Error('runtime cleanup failed')
    const runtime = { dispose: vi.fn(async () => { throw runtimeFailure }) }
    state.sessionScope.dispose.mockRejectedValueOnce(scopeFailure)
    mocked.openRuntime.mockResolvedValueOnce(runtime)
    const owner = provideDshTuiRuntime(state.ctx)

    await expect(owner.service.openSession(internalOptions('setup-skipped'))).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'DSH session open and rollback failed',
      errors: [
        expect.objectContaining({ message: 'DSH interaction setup did not run' }),
        scopeFailure,
        runtimeFailure,
      ],
    })
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })

  it('aggregates a prepared-session release failure before runtime ownership transfers', async () => {
    const state = fixture()
    const primary = new Error('runtime open failed')
    const releaseFailure = new Error('prepared cleanup failed')
    const agent = Object.freeze({ id: 'prepared-agent' })
    mocked.openRuntime.mockImplementationOnce(async (_ctx, options) => {
      await options.setup({}, agent)
      throw primary
    })
    state.composer.release.mockRejectedValueOnce(releaseFailure)
    const owner = provideDshTuiRuntime(state.ctx)

    await expect(owner.service.openSession(internalOptions('prepared-failure'))).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'DSH session open and rollback failed',
      errors: [primary, releaseFailure],
    })
    expect(state.composer.prepare).toHaveBeenCalledWith(agent, state.sessionScope)
  })

  it('leaves rollback to the composer once session completion starts', async () => {
    const state = fixture()
    const completionFailure = new Error('completion failed')
    const runtime = { dispose: vi.fn(async () => {}) }
    mocked.openRuntime.mockImplementationOnce(async (_ctx, options) => {
      await options.setup({}, Object.freeze({ id: 'completion-agent' }) as never)
      return runtime
    })
    state.composer.completeSession.mockRejectedValueOnce(completionFailure)
    const owner = provideDshTuiRuntime(state.ctx)

    await expect(owner.service.openSession(internalOptions('completion-failure')))
      .rejects.toBe(completionFailure)
    expect(state.composer.release).not.toHaveBeenCalled()
    expect(state.sessionScope.dispose).not.toHaveBeenCalled()
    expect(runtime.dispose).not.toHaveBeenCalled()
  })

  it('releases failed legacy projections and aggregates a release failure', async () => {
    const state = fixture()
    const projectionFailure = new Error('legacy projection failed')
    const releaseFailure = new Error('legacy release failed')
    const successfulRelease = vi.fn(async () => {})
    const failedRelease = vi.fn(async () => { throw releaseFailure })
    const runtime = { dispose: vi.fn(async () => {}) }
    mocked.openRuntime.mockImplementation(async (_ctx, options) => {
      await options.setup({}, Object.freeze({ id: 'legacy-agent' }) as never)
      return runtime
    })
    state.composer.completeSession
      .mockResolvedValueOnce({
        asLegacyPort: vi.fn(async () => { throw projectionFailure }),
        release: successfulRelease,
      })
      .mockResolvedValueOnce({
        asLegacyPort: vi.fn(async () => { throw projectionFailure }),
        release: failedRelease,
      })
    const owner = provideDshTuiRuntime(state.ctx)

    await expect(owner.service.openLegacy(internalOptions('legacy-release')))
      .rejects.toBe(projectionFailure)
    expect(successfulRelease).toHaveBeenCalledWith('DSH legacy session open failed')
    await expect(owner.service.open(internalOptions('legacy-aggregate'))).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'DSH legacy session open and rollback failed',
      errors: [projectionFailure, releaseFailure],
    })
  })
})
