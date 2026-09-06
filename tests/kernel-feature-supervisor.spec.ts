import { describe, expect, it, vi } from 'vitest'
import { ScopeManager, type ResourceScope } from '../src/lifecycle/scope-manager.ts'
import {
  createCapabilityToken,
  type CapabilityLease,
  type CapabilityToken,
} from '../src/kernel/capability.ts'
import {
  FEATURE_API_VERSION,
  type FeatureActivation,
  type FeatureContributionDeclarations,
  type FeatureContributions,
  type FeatureFactory,
  type FeatureManifest,
  type FeatureScope,
} from '../src/kernel/feature.ts'
import { FeatureRegistry } from '../src/kernel/feature-registry.ts'
import {
  FeatureActivationError,
  FeatureSupervisor,
  type FeatureCapabilityResolver,
  type FeatureFactoryContext,
} from '../src/kernel/feature-supervisor.ts'
import { CapabilityRegistry } from '../src/kernel/capability-registry.ts'

interface FactoryFixture {
  readonly factory: FeatureFactory
  readonly create: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
}

function factory(options: {
  readonly id: string
  readonly scope?: FeatureScope
  readonly activation?: FeatureActivation
  readonly required?: boolean
  readonly requires?: FeatureManifest['requires']
  readonly declarations?: FeatureContributionDeclarations
  readonly contributions?: FeatureContributions
  readonly createError?: Error
  readonly disposeError?: Error
  readonly disposalLog?: string[]
}): FactoryFixture {
  const dispose = vi.fn(() => {
    options.disposalLog?.push(options.id)
    if (options.disposeError !== undefined) throw options.disposeError
  })
  const create = vi.fn((context: FeatureFactoryContext) => {
    if (options.createError !== undefined) throw options.createError
    return {
      contributions: options.contributions ?? {},
      dispose,
      context,
    }
  })
  const value: FeatureFactory = {
    manifest: {
      id: options.id,
      apiVersion: FEATURE_API_VERSION,
      scope: options.scope ?? 'application',
      activation: options.activation ?? 'eager',
      required: options.required ?? true,
      requires: options.requires ?? [],
    },
    create,
  }
  return {
    factory: options.declarations === undefined
      ? value
      : { ...value, declarations: options.declarations },
    create,
    dispose,
  }
}

class TestCapabilityResolver implements FeatureCapabilityResolver {
  readonly calls: { readonly id: string; readonly scope: ResourceScope }[] = []
  readonly releases: string[] = []

  constructor(private readonly values: ReadonlyMap<string, unknown> = new Map()) {}

  resolve<TValue>(
    token: CapabilityToken<TValue>,
    scope: ResourceScope,
  ): CapabilityLease<TValue> {
    this.calls.push({ id: token.id, scope })
    if (!this.values.has(token.id)) throw new Error(`Missing capability ${token.id}`)
    return {
      value: this.values.get(token.id) as TValue,
      release: () => {
        this.releases.push(token.id)
      },
    }
  }
}

describe('FeatureSupervisor', () => {
  it('activates eager, command, and route features once in their declared scopes', async () => {
    const registry = new FeatureRegistry()
    const manager = new ScopeManager('test')
    const session = manager.createSession('session-a')
    const resolver = new TestCapabilityResolver()
    const eager = factory({
      id: 'chat',
      declarations: { routes: ['chat'] },
      contributions: { routes: [{ id: 'chat', value: 'CHAT' }] },
    })
    const command = factory({
      id: 'commands',
      scope: 'session',
      activation: 'on-command',
      declarations: { commands: ['open-settings'] },
      contributions: { commands: [{ id: 'open-settings', value: 'COMMAND' }] },
    })
    const route = factory({
      id: 'settings',
      scope: 'session',
      activation: 'on-route',
      declarations: {
        routes: ['settings'],
        surfaces: [{ slot: 'main', cardinality: 'multiple' }],
      },
      contributions: { surfaces: [{ id: 'settings', slot: 'main', value: 'SURFACE' }] },
    })
    registry.register(eager.factory)
    registry.register(command.factory)
    registry.register(route.factory)
    const applicationSupervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      capabilities: resolver,
    })
    const sessionSupervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      featureScope: 'session',
      sessionScope: session,
      capabilities: resolver,
    })

    expect(applicationSupervisor.listActiveContributions()).toEqual([])
    expect(applicationSupervisor.status('chat')).toEqual({ featureId: 'chat', state: 'inactive' })
    expect(applicationSupervisor.status('commands')).toBeUndefined()
    expect(sessionSupervisor.status('chat')).toBeUndefined()
    expect(sessionSupervisor.status('commands')).toEqual({
      featureId: 'commands',
      state: 'inactive',
    })
    await applicationSupervisor.start()
    await sessionSupervisor.start()
    expect(eager.create).toHaveBeenCalledTimes(1)
    expect(command.create).not.toHaveBeenCalled()
    expect(route.create).not.toHaveBeenCalled()
    expect(eager.create.mock.calls[0]?.[0].scope).toBe(manager.app)

    await applicationSupervisor.activateCommand('open-settings')
    expect(command.create).not.toHaveBeenCalled()
    await sessionSupervisor.activateCommand('unknown')
    await Promise.all([
      sessionSupervisor.activateCommand('open-settings'),
      sessionSupervisor.activateCommand('open-settings'),
    ])
    await sessionSupervisor.activateRoute('settings')
    await sessionSupervisor.activateRoute('settings')

    expect(command.create).toHaveBeenCalledTimes(1)
    expect(route.create).toHaveBeenCalledTimes(1)
    expect(command.create.mock.calls[0]?.[0].scope).toBe(session)
    expect(route.create.mock.calls[0]?.[0].scope).toBe(session)
    expect(applicationSupervisor.listActiveContributions().map(entry => entry.featureId)).toEqual([
      'chat',
    ])
    expect(sessionSupervisor.listActiveContributions().map(entry => entry.featureId)).toEqual([
      'commands', 'settings',
    ])
    expect(sessionSupervisor.contributionsFor('missing')).toBeUndefined()
    expect(sessionSupervisor.contributionsFor('settings')).toBe(
      sessionSupervisor.listActiveContributions()[1]?.contributions,
    )
    await sessionSupervisor.dispose()
    await applicationSupervisor.dispose()
  })

  it('resolves only declared requirements and passes values without an ambient getter', async () => {
    const application = createCapabilityToken<{ root: string }>('dsh.application/v1', 'application')
    const sessionToken = createCapabilityToken<{ id: string }>('dsh.session/v1', 'session')
    const undeclared = createCapabilityToken<{ secret: string }>('dsh.undeclared/v1', 'session')
    const resolver = new TestCapabilityResolver(new Map([
      [application.id, { root: 'D:\\Projects' }],
      [sessionToken.id, { id: 'session-a' }],
      [undeclared.id, { secret: 'hidden' }],
    ]))
    const registry = new FeatureRegistry()
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const fixture = factory({
      id: 'conversation',
      scope: 'session',
      requires: [application, sessionToken],
    })
    registry.register(fixture.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      featureScope: 'session',
      sessionScope: session,
      capabilities: resolver,
    })

    await supervisor.start()
    const context = fixture.create.mock.calls[0]?.[0] as FeatureFactoryContext

    expect(context.dependencies.map(item => [item.token.id, item.value])).toEqual([
      [application.id, { root: 'D:\\Projects' }],
      [sessionToken.id, { id: 'session-a' }],
    ])
    expect('get' in context.dependencies).toBe(false)
    expect(Object.isFrozen(context.dependencies)).toBe(true)
    expect(resolver.calls).toEqual([
      { id: application.id, scope: manager.app },
      { id: sessionToken.id, scope: session },
    ])

    await supervisor.dispose()
    expect(resolver.releases).toEqual([sessionToken.id, application.id])
  })

  it('statefully contains optional failures but throws required failures', async () => {
    const registry = new FeatureRegistry()
    const manager = new ScopeManager()
    const resolver = new TestCapabilityResolver()
    const optional = factory({
      id: 'optional',
      required: false,
      createError: new Error('optional failed'),
    })
    const healthy = factory({ id: 'healthy' })
    registry.register(optional.factory)
    registry.register(healthy.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      capabilities: resolver,
    })

    await supervisor.start()
    expect(supervisor.status('optional')).toMatchObject({
      state: 'unavailable',
      error: expect.objectContaining({ message: 'optional failed' }),
    })
    expect(supervisor.status('healthy')).toMatchObject({ state: 'active' })
    expect(supervisor.listActiveContributions().map(item => item.featureId)).toEqual(['healthy'])
    await expect(supervisor.activateFeature('optional')).resolves.toMatchObject({
      state: 'unavailable',
    })

    const requiredRegistry = new FeatureRegistry()
    requiredRegistry.register(factory({
      id: 'required',
      createError: new Error('required failed'),
    }).factory)
    const requiredSupervisor = new FeatureSupervisor({
      registry: requiredRegistry,
      scopeManager: new ScopeManager(),
      capabilities: resolver,
    })
    await expect(requiredSupervisor.start()).rejects.toEqual(
      expect.objectContaining<Partial<FeatureActivationError>>({
        name: 'FeatureActivationError',
        featureId: 'required',
        required: true,
      }),
    )
    await expect(requiredSupervisor.activateFeature('required')).rejects.toBeInstanceOf(
      FeatureActivationError,
    )
    await supervisor.dispose()
    await requiredSupervisor.dispose()
  })

  it('contains optional factories whose runtime contributions exceed their declarations', async () => {
    const registry = new FeatureRegistry()
    const fixture = factory({
      id: 'optional-rogue',
      required: false,
      declarations: { routes: ['declared.route'] },
      contributions: { routes: [{ id: 'undeclared.route', value: true }] },
    })
    registry.register(fixture.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })

    await supervisor.start()

    expect(supervisor.status('optional-rogue')).toMatchObject({
      state: 'unavailable',
      error: expect.objectContaining({ code: 'undeclared-contribution' }),
    })
    expect(supervisor.listActiveContributions()).toEqual([])
    expect(fixture.dispose).toHaveBeenCalledTimes(1)
    await supervisor.dispose()
  })

  it('fails required factories whose runtime contributions exceed their declarations', async () => {
    const registry = new FeatureRegistry()
    const fixture = factory({
      id: 'required-rogue',
      declarations: { commands: ['declared.command'] },
      contributions: { commands: [{ id: 'undeclared.command', value: true }] },
    })
    registry.register(fixture.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })

    await expect(supervisor.start()).rejects.toEqual(expect.objectContaining({
      name: 'FeatureActivationError',
      featureId: 'required-rogue',
      required: true,
      cause: expect.objectContaining({ code: 'undeclared-contribution' }),
    }))
    expect(supervisor.listActiveContributions()).toEqual([])
    expect(fixture.dispose).toHaveBeenCalledTimes(1)
    await supervisor.dispose()
  })

  it('runs the product normalizer on a structural snapshot and republishes a frozen copy', async () => {
    const registry = new FeatureRegistry()
    const rawValue = { source: true }
    const rawContributions = {
      routes: [{ id: 'route.main', value: rawValue }],
    }
    const fixture = factory({
      id: 'normalized',
      required: false,
      declarations: { routes: ['route.main'] },
      contributions: rawContributions,
    })
    registry.register(fixture.factory, { authority: 'core' })
    const normalizedValue = { normalized: true }
    const normalizeContributions = vi.fn((_snapshot, contributions, provenance) => {
      expect(Object.isFrozen(contributions)).toBe(true)
      expect(Object.isFrozen(contributions.routes)).toBe(true)
      expect(Object.isFrozen(contributions.routes?.[0])).toBe(true)
      expect(provenance).toEqual({ authority: 'core', required: false })
      return { routes: [{ id: 'route.main', value: normalizedValue }] }
    })
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
      normalizeContributions,
    })

    await supervisor.start()
    rawContributions.routes[0]!.id = 'mutated.route'
    rawContributions.routes.push({ id: 'route.main', value: rawValue })

    expect(normalizeContributions).toHaveBeenCalledOnce()
    expect(normalizeContributions.mock.calls[0]?.[0]).toBe(registry.snapshotOf(fixture.factory))
    const published = supervisor.contributionsFor('normalized')
    expect(published).toEqual({ routes: [{ id: 'route.main', value: normalizedValue }] })
    expect(Object.isFrozen(published)).toBe(true)
    expect(Object.isFrozen(published?.routes)).toBe(true)
    expect(Object.isFrozen(published?.routes?.[0])).toBe(true)
    expect(Object.isFrozen(supervisor.listActiveContributions())).toBe(true)
    expect(Object.isFrozen(supervisor.listActiveContributions()[0])).toBe(true)
    await supervisor.dispose()
  })

  it('uses registration-time trigger metadata after the source factory mutates', async () => {
    const commands = ['command.open']
    const fixture = factory({
      id: 'lazy-snapshot',
      activation: 'on-command',
      declarations: { commands },
      contributions: { commands: [{ id: 'command.open', value: true }] },
    })
    const registry = new FeatureRegistry()
    registry.register(fixture.factory)
    commands[0] = 'command.mutated'
    ;(fixture.factory.manifest as unknown as {
      activation: FeatureActivation
    }).activation = 'eager'
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })

    await supervisor.start()
    expect(fixture.create).not.toHaveBeenCalled()
    await supervisor.activateCommand('command.mutated')
    expect(fixture.create).not.toHaveBeenCalled()
    await supervisor.activateCommand('command.open')
    expect(fixture.create).toHaveBeenCalledOnce()
    await supervisor.dispose()
  })

  it('contains optional product normalizer output that widens the declaration contract', async () => {
    const registry = new FeatureRegistry()
    const fixture = factory({
      id: 'product-rogue',
      required: false,
      declarations: { routes: ['route.main'] },
      contributions: { routes: [{ id: 'route.main', value: true }] },
    })
    registry.register(fixture.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
      normalizeContributions: async () => ({
        routes: [{ id: 'route.widened', value: true }],
      }),
    })

    await supervisor.start()

    expect(supervisor.status('product-rogue')).toMatchObject({
      state: 'unavailable',
      error: expect.objectContaining({ code: 'undeclared-contribution' }),
    })
    expect(fixture.dispose).toHaveBeenCalledOnce()
    await supervisor.dispose()
  })

  it('reports missing registration, wrong-scope activation, and disposed supervisor use', async () => {
    const registry = new FeatureRegistry()
    registry.register(factory({
      id: 'session-only',
      scope: 'session',
      required: false,
    }).factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })

    await expect(supervisor.activateFeature('missing')).rejects.toThrowError(
      'Feature "missing" is not registered',
    )
    await supervisor.start()
    expect(supervisor.status('session-only')).toBeUndefined()
    await expect(supervisor.activateFeature('session-only')).rejects.toThrowError(
      'Feature "session-only" belongs to the session supervisor',
    )
    await supervisor.dispose()
    await expect(supervisor.start()).rejects.toThrowError('Feature supervisor is disposed')
  })

  it('requires a session scope only for a session supervisor', () => {
    expect(() => new FeatureSupervisor({
      registry: new FeatureRegistry(),
      scopeManager: new ScopeManager(),
      featureScope: 'session',
      capabilities: new TestCapabilityResolver(),
    })).toThrowError('Session Feature supervisor requires an active session scope')
  })

  it('rejects session scopes outside the configured manager and scopes that are no longer active', async () => {
    const registry = new FeatureRegistry()
    const manager = new ScopeManager()
    const foreignManager = new ScopeManager()
    const disposedSession = manager.createSession('disposed')
    await disposedSession.dispose()

    const invalidScopes = [
      manager.app,
      foreignManager.createSession('foreign'),
      disposedSession,
    ]
    for (const sessionScope of invalidScopes) {
      expect(() => new FeatureSupervisor({
        registry,
        scopeManager: manager,
        featureScope: 'session',
        sessionScope,
        capabilities: new TestCapabilityResolver(),
      })).toThrowError('Feature supervisor requires an active session scope owned by its scope manager')
    }

    const activeSession = manager.createSession('active-then-disposed')
    const lazy = factory({
      id: 'lazy-session',
      scope: 'session',
      activation: 'on-command',
      required: false,
      declarations: { commands: ['lazy-session'] },
    })
    registry.register(lazy.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      featureScope: 'session',
      sessionScope: activeSession,
      capabilities: new TestCapabilityResolver(),
    })
    await activeSession.dispose()

    await expect(supervisor.activateFeature('lazy-session')).resolves.toMatchObject({
      state: 'unavailable',
      error: expect.objectContaining({
        message: 'Feature supervisor requires an active session scope owned by its scope manager',
      }),
    })
    expect(lazy.create).not.toHaveBeenCalled()
    await supervisor.dispose()

    await manager.dispose()
    await foreignManager.dispose()
  })

  it('fails closed when factories return malformed feature instances', async () => {
    const registry = new FeatureRegistry()
    const partialDispose = vi.fn()
    registry.register({
      manifest: {
        id: 'null-instance',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      create: () => null as unknown as ReturnType<FeatureFactory['create']>,
    })
    registry.register({
      manifest: {
        id: 'invalid-contributions',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      create: () => ({ contributions: null, dispose: partialDispose }) as unknown as Awaited<ReturnType<FeatureFactory['create']>>,
    })
    registry.register({
      manifest: {
        id: 'missing-dispose',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      create: () => ({ contributions: {} }) as unknown as Awaited<ReturnType<FeatureFactory['create']>>,
    })
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })

    await supervisor.start()

    for (const featureId of ['null-instance', 'invalid-contributions', 'missing-dispose']) {
      expect(supervisor.status(featureId)).toMatchObject({
        state: 'unavailable',
        error: expect.objectContaining({ message: 'Feature factory returned an invalid instance' }),
      })
    }
    expect(partialDispose).toHaveBeenCalledTimes(1)
    expect(supervisor.listActiveContributions()).toEqual([])
    await supervisor.dispose()
  })

  it('notifies a post-start required activation failure once without double-reporting initial readiness', async () => {
    const initialRegistry = new FeatureRegistry()
    initialRegistry.register(factory({
      id: 'initial-required',
      createError: new Error('initial failed'),
    }).factory)
    const initialFailure = vi.fn()
    const initial = new FeatureSupervisor({
      registry: initialRegistry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
      onRequiredFeatureFailure: initialFailure,
    })

    await expect(initial.start()).rejects.toBeInstanceOf(FeatureActivationError)
    expect(initialFailure).not.toHaveBeenCalled()
    await initial.dispose()

    const registry = new FeatureRegistry()
    const requiredFailure = vi.fn(() => Promise.reject(new Error('observer failed')))
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
      onRequiredFeatureFailure: requiredFailure,
    })
    await supervisor.start()
    registry.register(factory({
      id: 'late-required',
      createError: new Error('late failed'),
    }).factory)

    await expect(supervisor.activateFeature('late-required'))
      .rejects.toBeInstanceOf(FeatureActivationError)
    await expect(supervisor.activateFeature('late-required'))
      .rejects.toBeInstanceOf(FeatureActivationError)
    expect(requiredFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'required-feature-failure',
      featureId: 'late-required',
      reason: 'activation',
      error: expect.any(FeatureActivationError),
    }))
    await supervisor.dispose()

    const silentRegistry = new FeatureRegistry()
    const silent = new FeatureSupervisor({
      registry: silentRegistry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })
    await silent.start()
    silentRegistry.register(factory({
      id: 'silent-required',
      createError: new Error('silent failed'),
    }).factory)
    await expect(silent.activateFeature('silent-required'))
      .rejects.toBeInstanceOf(FeatureActivationError)
    await silent.dispose()
  })

  it('waits for an in-flight activation and prevents publication after disposal begins', async () => {
    let finishCreate!: (instance: {
      readonly contributions: FeatureContributions
      dispose(): void
    }) => void
    const createTask = new Promise<{
      readonly contributions: FeatureContributions
      dispose(): void
    }>(resolve => {
      finishCreate = resolve
    })
    const registry = new FeatureRegistry()
    const create = vi.fn(() => createTask)
    const dispose = vi.fn()
    registry.register({
      manifest: {
        id: 'slow-optional',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      declarations: { routes: ['late'] },
      create,
    })
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })

    const starting = supervisor.start()
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    let disposalSettled = false
    const disposing = supervisor.dispose().then(() => {
      disposalSettled = true
    })
    await Promise.resolve()
    expect(disposalSettled).toBe(false)

    finishCreate({ contributions: { routes: [{ id: 'late', value: true }] }, dispose })
    await starting
    await disposing

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(supervisor.status('slow-optional')).toBeUndefined()
    expect(supervisor.listActiveContributions()).toEqual([])
  })

  it('does not call a feature factory after disposal begins during dependency resolution', async () => {
    const token = createCapabilityToken<{ ready: true }>('runtime.slow-dependency/v1', 'application')
    let finishResolution!: (lease: CapabilityLease<{ ready: true }>) => void
    const resolution = new Promise<CapabilityLease<{ ready: true }>>(resolve => {
      finishResolution = resolve
    })
    const capabilityRelease = vi.fn()
    const resolveCall = vi.fn()
    const capabilities: FeatureCapabilityResolver = {
      resolve<TValue>(): Promise<CapabilityLease<TValue>> {
        resolveCall()
        return resolution as unknown as Promise<CapabilityLease<TValue>>
      },
    }
    const registry = new FeatureRegistry()
    const fixture = factory({
      id: 'waiting-on-dependency',
      required: false,
      requires: [token],
    })
    registry.register(fixture.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities,
    })

    const starting = supervisor.start()
    await vi.waitFor(() => expect(resolveCall).toHaveBeenCalledTimes(1))
    const disposing = supervisor.dispose()
    finishResolution({ value: { ready: true }, release: capabilityRelease })
    await starting
    await disposing

    expect(fixture.create).not.toHaveBeenCalled()
    expect(capabilityRelease).toHaveBeenCalledTimes(1)
  })

  it('tracks activation before invoking plugin code so reentrant disposal waits for rollback', async () => {
    const log: string[] = []
    const registry = new FeatureRegistry()
    let supervisor!: FeatureSupervisor
    let disposing!: Promise<void>
    registry.register({
      manifest: {
        id: 'reentrant-dispose',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      create: () => {
        disposing = supervisor.dispose().then(() => {
          log.push('supervisor')
        })
        return {
          contributions: {},
          dispose: () => {
            log.push('instance')
          },
        }
      },
    })
    supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })

    await supervisor.start()
    await disposing

    expect(log).toEqual(['instance', 'supervisor'])
    expect(supervisor.listActiveContributions()).toEqual([])
  })

  it('coalesces scope and supervisor disposal around one in-flight instance cleanup', async () => {
    let finishDispose!: () => void
    const instanceDispose = vi.fn(() => new Promise<void>(resolve => {
      finishDispose = resolve
    }))
    const registry = new FeatureRegistry()
    registry.register({
      manifest: {
        id: 'shared-cleanup',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create: () => ({ contributions: {}, dispose: instanceDispose }),
    })
    const manager = new ScopeManager()
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      capabilities: new TestCapabilityResolver(),
    })
    await supervisor.start()

    const disposingScope = manager.dispose()
    await vi.waitFor(() => expect(instanceDispose).toHaveBeenCalledTimes(1))
    let supervisorSettled = false
    const disposingSupervisor = supervisor.dispose().then(() => {
      supervisorSettled = true
    })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(supervisorSettled).toBe(false)

    finishDispose()
    await disposingSupervisor
    await disposingScope
    expect(instanceDispose).toHaveBeenCalledTimes(1)
  })

  it('disposes features in reverse order, follows session lifetime, and is idempotent', async () => {
    const log: string[] = []
    const registry = new FeatureRegistry()
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const first = factory({ id: 'first', disposalLog: log })
    const second = factory({ id: 'second', disposalLog: log })
    const scoped = factory({
      id: 'scoped',
      scope: 'session',
      disposalLog: log,
      declarations: { resources: ['session'] },
      contributions: { resources: [{ id: 'session', value: true }] },
    })
    registry.register(first.factory)
    registry.register(second.factory)
    registry.register(scoped.factory)
    const applicationSupervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      capabilities: new TestCapabilityResolver(),
    })
    const sessionSupervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      featureScope: 'session',
      sessionScope: session,
      capabilities: new TestCapabilityResolver(),
    })
    await applicationSupervisor.start()
    await sessionSupervisor.start()

    await session.dispose('session closed')
    expect(scoped.dispose).toHaveBeenCalledTimes(1)
    expect(sessionSupervisor.contributionsFor('scoped')).toBeUndefined()
    await sessionSupervisor.dispose()
    await sessionSupervisor.dispose()
    await applicationSupervisor.dispose()
    await applicationSupervisor.dispose()

    expect(log).toEqual(['scoped', 'second', 'first'])
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(second.dispose).toHaveBeenCalledTimes(1)
  })

  it('aggregates instance and capability cleanup failures without leaking active contributions', async () => {
    const token = createCapabilityToken<{ value: true }>('broken.resource/v1', 'application')
    const capabilities: FeatureCapabilityResolver = {
      resolve<TValue>(): CapabilityLease<TValue> {
        return {
          value: { value: true } as TValue,
          release: () => {
            throw new Error('capability release failed')
          },
        }
      },
    }
    const registry = new FeatureRegistry()
    registry.register(factory({
      id: 'broken-dispose',
      requires: [token],
      disposeError: new Error('instance dispose failed'),
    }).factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities,
    })
    await supervisor.start()

    await expect(supervisor.dispose()).rejects.toThrowError('Feature supervisor disposal failed')
    expect(supervisor.listActiveContributions()).toEqual([])
  })

  it('combines activation and rollback failures for an optional feature', async () => {
    const token = createCapabilityToken<{ value: true }>('rollback.resource/v1', 'application')
    const capabilities: FeatureCapabilityResolver = {
      resolve<TValue>(): CapabilityLease<TValue> {
        return {
          value: { value: true } as TValue,
          release: () => {
            throw new Error('rollback failed')
          },
        }
      },
    }
    const registry = new FeatureRegistry()
    registry.register(factory({
      id: 'broken-activation',
      required: false,
      requires: [token],
      createError: new Error('create failed'),
    }).factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities,
    })

    await supervisor.start()

    expect(supervisor.status('broken-activation')).toMatchObject({
      state: 'unavailable',
      error: expect.any(AggregateError),
    })
    await supervisor.dispose()
  })

  it('disposes an unregistered active feature and emits navigation recovery semantics', async () => {
    const registry = new FeatureRegistry()
    const fixture = factory({
      id: 'settings',
      declarations: { surfaces: [{ slot: 'main', cardinality: 'multiple' }] },
      contributions: { surfaces: [{ id: 'settings', slot: 'main', value: true }] },
    })
    const lease = registry.register(fixture.factory)
    const events: unknown[] = []
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
      onActiveFeatureUnloaded: event => {
        events.push(event)
      },
    })
    await supervisor.start()

    await lease.release()
    await lease.release()

    expect(fixture.dispose).toHaveBeenCalledTimes(1)
    expect(supervisor.contributionsFor('settings')).toBeUndefined()
    expect(supervisor.status('settings')).toBeUndefined()
    expect(events).toEqual([{
      type: 'active-feature-unloaded',
      featureId: 'settings',
      fallbackRoute: 'chat',
      restoreFocus: true,
    }])
    await supervisor.dispose()
  })

  it('uses a no-op recovery callback and ignores an inactive factory unload', async () => {
    const registry = new FeatureRegistry()
    const active = factory({ id: 'active' })
    const lazy = factory({
      id: 'lazy',
      activation: 'on-command',
      declarations: { commands: ['lazy'] },
    })
    const activeLease = registry.register(active.factory)
    const lazyLease = registry.register(lazy.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })
    await supervisor.start()

    await lazyLease.release()
    await activeLease.release()

    expect(active.dispose).toHaveBeenCalledTimes(1)
    expect(lazy.dispose).not.toHaveBeenCalled()
    await supervisor.dispose()
  })

  it('contains session-lifetime recovery failures while releasing active Features', async () => {
    const registry = new FeatureRegistry()
    const manager = new ScopeManager()
    const session = manager.createSession('recovery-failure')
    const fixture = factory({ id: 'session.recovery-failure', scope: 'session' })
    registry.register(fixture.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      featureScope: 'session',
      sessionScope: session,
      capabilities: new TestCapabilityResolver(),
      notifyActiveFeatureUnloadedOnRelease: true,
      onActiveFeatureUnloaded: () => { throw new Error('recovery failed') },
    })
    await supervisor.start()

    await expect(supervisor.dispose()).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Feature supervisor disposal failed',
    })
    expect(fixture.dispose).toHaveBeenCalledOnce()
    await session.dispose().catch(() => {})
    await manager.dispose().catch(() => {})
  })

  it('waits for in-flight activation before handling registration release', async () => {
    let finishCreate!: (instance: {
      readonly contributions: FeatureContributions
      dispose(): void
    }) => void
    const createTask = new Promise<{
      readonly contributions: FeatureContributions
      dispose(): void
    }>(resolve => {
      finishCreate = resolve
    })
    const registry = new FeatureRegistry()
    const create = vi.fn(() => createTask)
    const dispose = vi.fn()
    const lease = registry.register({
      manifest: {
        id: 'slow',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create,
    })
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })

    const starting = supervisor.start()
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const unloading = lease.release()
    finishCreate({ contributions: {}, dispose })
    await starting
    await unloading

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(supervisor.status('slow')).toBeUndefined()
    await supervisor.dispose()
  })

  it('contains an in-flight required activation failure during registration release', async () => {
    let failCreate!: (error: Error) => void
    const createTask = new Promise<never>((_resolve, reject) => {
      failCreate = reject
    })
    const registry = new FeatureRegistry()
    const create = vi.fn(() => createTask)
    const lease = registry.register({
      manifest: {
        id: 'slow-failure',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create,
    })
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })

    const starting = supervisor.start()
    const expectedFailure = expect(starting).rejects.toBeInstanceOf(FeatureActivationError)
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const unloading = lease.release()
    failCreate(new Error('late failure'))
    await expectedFailure
    await unloading

    expect(supervisor.status('slow-failure')).toBeUndefined()
    await supervisor.dispose()
  })

  it('still emits unload recovery when feature disposal and callback both fail', async () => {
    const registry = new FeatureRegistry()
    const fixture = factory({
      id: 'broken-unload',
      disposeError: new Error('dispose failed'),
    })
    const lease = registry.register(fixture.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
      onActiveFeatureUnloaded: () => {
        throw new Error('recovery failed')
      },
    })
    await supervisor.start()

    await expect(lease.release()).rejects.toThrowError('Feature "broken-unload" unload failed')

    expect(fixture.dispose).toHaveBeenCalledTimes(1)
    expect(supervisor.contributionsFor('broken-unload')).toBeUndefined()
    await supervisor.dispose()
  })

  it('deactivates a feature when an independently owned capability disappears', async () => {
    const token = createCapabilityToken<{ connected: true }>(
      'runtime.independent-provider/v1',
      'application',
    )
    const capabilities = new CapabilityRegistry()
    const providerRelease = vi.fn()
    const registration = capabilities.register({
      token,
      create: () => ({ value: { connected: true }, release: providerRelease }),
    })
    const registry = new FeatureRegistry()
    const feature = factory({ id: 'dependent', required: false, requires: [token] })
    registry.register(feature.factory)
    const events: string[] = []
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities,
      onActiveFeatureUnloaded: event => {
        events.push(event.featureId)
      },
    })
    await supervisor.start()

    await registration.release()
    await vi.waitFor(() => expect(feature.dispose).toHaveBeenCalledTimes(1))

    expect(providerRelease).toHaveBeenCalledTimes(1)
    expect(supervisor.contributionsFor('dependent')).toBeUndefined()
    expect(supervisor.status('dependent')).toMatchObject({
      featureId: 'dependent',
      state: 'unavailable',
      error: expect.objectContaining({
        message: 'Feature "dependent" lost a required capability',
      }),
    })
    expect(events).toEqual(['dependent'])
    await supervisor.dispose()
  })

  it('notifies once when an active required feature loses a capability and contains observer failure', async () => {
    const token = createCapabilityToken<{ connected: true }>(
      'runtime.required-provider/v1',
      'application',
    )
    const capabilities = new CapabilityRegistry()
    const registration = capabilities.register({
      token,
      create: () => ({ value: { connected: true }, release: vi.fn() }),
    })
    const registry = new FeatureRegistry()
    const feature = factory({ id: 'required-dependent', requires: [token] })
    registry.register(feature.factory)
    const requiredFailure = vi.fn(() => { throw new Error('observer failed') })
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities,
      onRequiredFeatureFailure: requiredFailure,
    })
    await supervisor.start()

    await registration.release()
    await vi.waitFor(() => expect(requiredFailure).toHaveBeenCalledTimes(1))

    expect(requiredFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'required-feature-failure',
      featureId: 'required-dependent',
      reason: 'capability-invalidated',
      error: expect.any(Error),
    }))
    expect(supervisor.status('required-dependent')).toMatchObject({
      state: 'unavailable',
    })
    await supervisor.dispose()
  })

  it('serializes same-id replacement behind asynchronous retirement', async () => {
    let finishOldDispose!: () => void
    const oldDispose = vi.fn(() => new Promise<void>(resolve => {
      finishOldDispose = resolve
    }))
    const replacementDispose = vi.fn()
    const replacementCreate = vi.fn(() => ({
      contributions: { routes: [{ id: 'replacement', value: true }] },
      dispose: replacementDispose,
    }))
    const registry = new FeatureRegistry()
    const oldLease = registry.register({
      manifest: {
        id: 'reloadable',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      declarations: { routes: ['old'] },
      create: () => ({
        contributions: { routes: [{ id: 'old', value: true }] },
        dispose: oldDispose,
      }),
    }, { authority: 'core' })
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })
    await supervisor.start()

    const retiring = oldLease.release()
    await vi.waitFor(() => expect(oldDispose).toHaveBeenCalledTimes(1))
    registry.register({
      manifest: {
        id: 'reloadable',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      declarations: { routes: ['replacement'] },
      create: replacementCreate,
    })
    const activatingReplacement = supervisor.activateFeature('reloadable')

    await Promise.resolve()
    expect(replacementCreate).not.toHaveBeenCalled()
    expect(supervisor.listActiveContributions()).toHaveLength(1)
    expect(supervisor.listActiveContributions()[0]?.provenance).toEqual({
      authority: 'core',
      required: false,
    })

    finishOldDispose()
    await retiring
    await activatingReplacement

    expect(replacementCreate).toHaveBeenCalledTimes(1)
    expect(supervisor.status('reloadable')).toEqual({
      featureId: 'reloadable',
      state: 'active',
    })
    expect(supervisor.listActiveContributions()).toEqual([{
      featureId: 'reloadable',
      provenance: { authority: 'extension', required: false },
      contributions: { routes: [{ id: 'replacement', value: true }] },
    }])
    await supervisor.dispose()
    expect(replacementDispose).toHaveBeenCalledTimes(1)
  })

  it('does not retain session state when a hot replacement changes Feature scope', async () => {
    let finishDispose!: () => void
    const dispose = vi.fn(() => new Promise<void>(resolve => {
      finishDispose = resolve
    }))
    const registry = new FeatureRegistry()
    const old = registry.register({
      manifest: {
        id: 'scope-changing',
        apiVersion: FEATURE_API_VERSION,
        scope: 'session',
        activation: 'eager',
        required: false,
        requires: [],
      },
      create: () => ({ contributions: {}, dispose }),
    })
    const manager = new ScopeManager()
    const session = manager.createSession('scope-changing')
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      featureScope: 'session',
      sessionScope: session,
      capabilities: new TestCapabilityResolver(),
    })
    await supervisor.start()

    const retirement = old.release()
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    registry.register(factory({ id: 'scope-changing', activation: 'on-command', declarations: {
      commands: ['scope-changing.open'],
    } }).factory)
    finishDispose()
    await retirement

    expect(supervisor.status('scope-changing')).toBeUndefined()
    expect(supervisor.listActiveContributions()).toEqual([])
    await supervisor.dispose()
    await manager.dispose()
  })

  it('treats a rejected capability invalidation signal as provider loss', async () => {
    const token = createCapabilityToken<{ ready: true }>('runtime.rejected-signal/v1', 'application')
    let rejectInvalidation!: (error: Error) => void
    const invalidated = new Promise<void>((_resolve, reject) => {
      rejectInvalidation = reject
    })
    const release = vi.fn()
    const registry = new FeatureRegistry()
    const feature = factory({ id: 'rejected-signal-consumer', required: false, requires: [token] })
    registry.register(feature.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: {
        resolve<TValue>(): CapabilityLease<TValue> {
          return { value: { ready: true } as TValue, invalidated, release }
        },
      },
    })
    await supervisor.start()

    rejectInvalidation(new Error('provider signal failed'))
    await vi.waitFor(() => expect(feature.dispose).toHaveBeenCalledTimes(1))

    expect(release).toHaveBeenCalledTimes(1)
    expect(supervisor.status('rejected-signal-consumer')).toMatchObject({
      state: 'unavailable',
    })
    await supervisor.dispose()
  })

  it('contains cleanup and recovery failures during capability invalidation', async () => {
    const token = createCapabilityToken<{ ready: true }>('runtime.broken-provider/v1', 'application')
    const capabilities = new CapabilityRegistry()
    const registration = capabilities.register({
      token,
      create: () => ({ value: { ready: true }, release: vi.fn() }),
    })
    const registry = new FeatureRegistry()
    const feature = factory({
      id: 'broken-capability-consumer',
      required: false,
      requires: [token],
      disposeError: new Error('instance cleanup failed'),
    })
    registry.register(feature.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities,
      onActiveFeatureUnloaded: () => {
        throw new Error('recovery failed')
      },
    })
    await supervisor.start()

    await registration.release()
    await vi.waitFor(() => expect(supervisor.status('broken-capability-consumer')).toMatchObject({
      state: 'unavailable',
      error: expect.objectContaining({
        message: 'Feature "broken-capability-consumer" capability invalidation failed',
      }),
    }))
    expect(feature.dispose).toHaveBeenCalledTimes(1)
    await supervisor.dispose()
  })

  it('coalesces capability loss with feature unregister recovery', async () => {
    const token = createCapabilityToken<{ ready: true }>('runtime.concurrent-loss/v1', 'application')
    const capabilities = new CapabilityRegistry()
    const capabilityRegistration = capabilities.register({
      token,
      create: () => ({ value: { ready: true }, release: vi.fn() }),
    })
    const registry = new FeatureRegistry()
    const feature = factory({ id: 'concurrent-loss', required: false, requires: [token] })
    const featureRegistration = registry.register(feature.factory)
    const recovery = vi.fn()
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities,
      onActiveFeatureUnloaded: recovery,
    })
    await supervisor.start()

    const results = await Promise.allSettled([
      capabilityRegistration.release(),
      featureRegistration.release(),
    ])
    expect(results.every(result => result.status === 'fulfilled')).toBe(true)
    expect(feature.dispose).toHaveBeenCalledTimes(1)
    expect(recovery).toHaveBeenCalledTimes(1)
    expect(supervisor.status('concurrent-loss')).toBeUndefined()
    await supervisor.dispose()
  })

  it('queues a second unregister behind a failed retirement without tearing state', async () => {
    let rejectDispose!: (error: Error) => void
    const oldDispose = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectDispose = reject
    }))
    const registry = new FeatureRegistry()
    const oldLease = registry.register({
      manifest: {
        id: 'queued-retirement',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      create: () => ({ contributions: {}, dispose: oldDispose }),
    })
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })
    await supervisor.start()

    const firstRetirement = oldLease.release()
    await vi.waitFor(() => expect(oldDispose).toHaveBeenCalledTimes(1))
    const replacementLease = registry.register(factory({ id: 'queued-retirement' }).factory)
    const secondRetirement = replacementLease.release()
    rejectDispose(new Error('old retirement failed'))

    await expect(firstRetirement).rejects.toThrow('Feature "queued-retirement" unload failed')
    await expect(secondRetirement).resolves.toBeUndefined()
    expect(supervisor.status('queued-retirement')).toBeUndefined()
    expect(supervisor.listActiveContributions()).toEqual([])
    await supervisor.dispose()
  })

  it('publishes replacement inactivity after an old activation fails during unregister', async () => {
    let rejectCreate!: (error: Error) => void
    const createTask = new Promise<never>((_resolve, reject) => {
      rejectCreate = reject
    })
    const registry = new FeatureRegistry()
    const oldLease = registry.register({
      manifest: {
        id: 'failed-replacement',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create: () => createTask,
    })
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: new TestCapabilityResolver(),
    })
    const starting = supervisor.start()
    const expectedFailure = expect(starting).rejects.toBeInstanceOf(FeatureActivationError)
    const retiring = oldLease.release()
    registry.register(factory({ id: 'failed-replacement', activation: 'on-command', declarations: {
      commands: ['replacement.open'],
    } }).factory)
    rejectCreate(new Error('old activation failed'))

    await expectedFailure
    await retiring
    expect(supervisor.status('failed-replacement')).toEqual({
      featureId: 'failed-replacement',
      state: 'inactive',
    })
    await supervisor.dispose()
  })

  it('ignores a late capability invalidation after its feature is already gone', async () => {
    const token = createCapabilityToken<{ ready: true }>('runtime.late-signal/v1', 'application')
    let invalidate!: () => void
    const invalidated = new Promise<void>(resolve => {
      invalidate = resolve
    })
    const registry = new FeatureRegistry()
    const feature = factory({ id: 'late-signal-consumer', required: false, requires: [token] })
    const registration = registry.register(feature.factory)
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: new ScopeManager(),
      capabilities: {
        resolve<TValue>(): CapabilityLease<TValue> {
          return { value: { ready: true } as TValue, invalidated, release: vi.fn() }
        },
      },
    })
    await supervisor.start()
    await registration.release()

    invalidate()
    await Promise.resolve()

    expect(feature.dispose).toHaveBeenCalledTimes(1)
    expect(supervisor.status('late-signal-consumer')).toBeUndefined()
    await supervisor.dispose()
  })
})
