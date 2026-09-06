import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  CordisDshTuiFeatureService,
  provideDshTuiFeatures,
  registerDshTuiCoreFeature,
  type DshTuiFeatureOwner,
} from '../src/dsh/feature-service.ts'
import {
  createCapabilityToken,
  type CapabilityLease,
  type CapabilityToken,
} from '../src/kernel/capability.ts'
import type { CapabilityFactoryContext } from '../src/kernel/capability-registry.ts'
import {
  FEATURE_API_VERSION,
  type FeatureFactory,
} from '../src/kernel/feature.ts'
import type { FeatureCapabilityResolver } from '../src/kernel/feature-supervisor.ts'
import type { DshTuiFeatureService } from '../src/kernel/feature-service.ts'
import { requireApplicationScopeHost } from '../src/lifecycle/application-scope-host.ts'
import type { ResourceScope } from '../src/lifecycle/scope-manager.ts'
import type {
  ResourceActivation,
  ResourceDefinition,
} from '../src/resource/resource-coordinator.ts'

const WORKSPACE_SLOT = Object.freeze({
  id: 'workspace.content',
  cardinality: 'list' as const,
  protection: 'public' as const,
})
const WORKSPACE_PRIMARY_SLOT = Object.freeze({
  id: 'workspace.primary',
  cardinality: 'single' as const,
  protection: 'public' as const,
})

function testResource<TValue>(
  key: string,
  value: TValue,
  options: {
    readonly lifetime?: ResourceDefinition<TValue>['lifetime']
    readonly activation?: ResourceActivation
  } = {},
): ResourceDefinition<TValue> {
  return Object.freeze({
    key,
    lifetime: options.lifetime ?? 'app',
    activation: options.activation ?? 'manual',
    cachePolicy: 'none',
    load: () => value,
  })
}

async function installFeatureHost(
  root: Context,
  onActiveFeatureUnloaded?: (event: {
    readonly featureId: string
    readonly fallbackRoute: 'chat'
    readonly restoreFocus: true
  }) => void,
): Promise<{
  readonly owner: DshTuiFeatureOwner
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}> {
  let owner!: DshTuiFeatureOwner
  const plugin = root.plugin({
    name: 'test-feature-host',
    apply(ctx) {
      owner = provideDshTuiFeatures(ctx, {
        slots: [WORKSPACE_SLOT, WORKSPACE_PRIMARY_SLOT],
        ...(onActiveFeatureUnloaded === undefined ? {} : { onActiveFeatureUnloaded }),
      })
      ctx.effect(() => () => owner.dispose())
    },
  })
  await plugin
  await owner.ready
  return { owner, plugin }
}

function routeFeature(
  id: string,
  dispose = vi.fn(),
): FeatureFactory {
  return {
    manifest: {
      id,
      apiVersion: FEATURE_API_VERSION,
      scope: 'application',
      activation: 'on-route',
      required: false,
      requires: [],
    },
    declarations: {
      routes: [`${id}.route`],
      commands: [`${id}.command`],
      resources: [`${id}.resource`],
      surfaces: [{ slot: WORKSPACE_SLOT.id, cardinality: 'multiple' }],
    },
    create: () => ({
      contributions: {
        routes: [{
          id: `${id}.route`,
          value: { kind: 'workspace', featureId: id, pane: 'content' },
        }],
        commands: [{ id: `${id}.command`, value: { handle() {} } }],
        resources: [{
          id: `${id}.resource`,
          value: testResource(`${id}.resource`, undefined, {
            lifetime: 'surface',
            activation: 'on-visible',
          }),
        }],
        surfaces: [{
          id: `${id}.surface`,
          slot: WORKSPACE_SLOT.id,
          value: { id: `${id}.surface`, role: 'content', node: {} },
        }],
      },
      dispose,
    }),
  }
}

function commandFeature(id: string, dispose = vi.fn()): FeatureFactory {
  return {
    manifest: {
      id,
      apiVersion: FEATURE_API_VERSION,
      scope: 'application',
      activation: 'on-command',
      required: false,
      requires: [],
    },
    declarations: { commands: [`${id}.open`] },
    create: () => ({
      contributions: {
        commands: [{ id: `${id}.open`, value: { handle() {} } }],
      },
      dispose,
    }),
  }
}

function sessionFeature(options: {
  readonly id: string
  readonly activation?: 'eager' | 'on-command' | 'on-route'
  readonly command?: string
  readonly route?: string
  readonly resource?: string
  readonly required?: boolean
  readonly requires?: readonly CapabilityToken<unknown>[]
  readonly create?: FeatureFactory['create']
}): FeatureFactory {
  const command = options.command
  const route = options.route
  const resource = options.resource
  return {
    manifest: {
      id: options.id,
      apiVersion: FEATURE_API_VERSION,
      scope: 'session',
      activation: options.activation ?? 'eager',
      required: options.required ?? false,
      requires: options.requires ?? [],
    },
    declarations: {
      ...(command === undefined ? {} : { commands: [command] }),
      ...(route === undefined ? {} : { routes: [route] }),
      ...(resource === undefined ? {} : { resources: [resource] }),
    },
    create: options.create ?? (() => ({ contributions: {}, dispose() {} })),
  }
}

function capabilityResolver(
  values: ReadonlyMap<string, unknown> = new Map(),
  log?: string[],
): FeatureCapabilityResolver {
  return {
    resolve<TValue>(token: CapabilityToken<TValue>, scope: ResourceScope): CapabilityLease<TValue> {
      log?.push(`acquire:${token.id}:${scope.label}`)
      if (!values.has(token.id)) throw new Error(`Missing capability ${token.id}`)
      return {
        value: values.get(token.id) as TValue,
        release: () => { log?.push(`release:${token.id}:${scope.label}`) },
      }
    },
  }
}

describe('DshTuiFeatureService', () => {
  it('keeps core registration authority on the private composition installer', async () => {
    const root = new Context()
    const service = new CordisDshTuiFeatureService(root)
    expect(() => registerDshTuiCoreFeature(
      root,
      {} as DshTuiFeatureService,
      routeFeature('missing.core-installer'),
    )).toThrow('dshTuiFeatures does not support package-owned Feature installation')

    const registration = registerDshTuiCoreFeature(
      root,
      service,
      routeFeature('owned.core-installer'),
    )
    await service.activateRoute('owned.core-installer.route')
    expect(service.listActiveContributions()).toEqual([
      expect.objectContaining({
        featureId: 'owned.core-installer',
        provenance: { authority: 'core', required: false },
      }),
    ])

    await registration.release()
    await service.dispose()
    await root.fiber.dispose()
  })

  it('lets the root composer release an external core registration explicitly', async () => {
    const root = new Context()
    const service = new CordisDshTuiFeatureService(root)
    let registration!: ReturnType<typeof registerDshTuiCoreFeature>
    const owner = root.plugin({
      name: 'externally-owned-core-feature',
      apply(ctx) {
        registration = registerDshTuiCoreFeature(
          ctx,
          service,
          routeFeature('external.core'),
          'external',
        )
      },
    })
    await owner
    await service.activateRoute('external.core.route')

    await owner.dispose()
    expect(registration.active).toBe(true)
    expect(service.contributionsFor('external.core')).toBeDefined()

    await registration.release()
    expect(registration.active).toBe(false)
    expect(service.contributionsFor('external.core')).toBeUndefined()
    await service.dispose()
    await root.fiber.dispose()
  })

  it('provides an inert kernel and starts explicit core Features only on demand', async () => {
    const root = new Context()
    const create = vi.fn(() => ({ contributions: {}, dispose() {} }))
    const coreFeature: FeatureFactory = {
      manifest: {
        id: 'test.core',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create,
    }
    let owner!: DshTuiFeatureOwner
    const plugin = root.plugin({
      name: 'test-inert-feature-host',
      apply(ctx) {
        owner = provideDshTuiFeatures(
          ctx,
          { slots: [WORKSPACE_SLOT, WORKSPACE_PRIMARY_SLOT] },
          [coreFeature],
        )
        ctx.effect(() => () => owner.dispose())
      },
    })
    await plugin
    const service = root.get('dshTuiFeatures')

    expect(service === undefined).toBe(false)
    expect(owner.service.name).toBe('dshTuiFeatures')
    expect(owner.slotDefinitions).toBe(owner.service.slotDefinitions)
    expect(owner.slotDefinitions).toContainEqual(WORKSPACE_SLOT)
    expect(create).not.toHaveBeenCalled()
    expect(service?.status('test.core')).toEqual({
      featureId: 'test.core',
      state: 'inactive',
    })
    expect(service?.status('legacy.chat')).toBeUndefined()

    const ready = owner.ready
    expect(service?.start()).toBe(ready)
    expect(service?.ready).toBe(ready)
    await ready
    expect(create).toHaveBeenCalledOnce()
    expect(service?.status('test.core')).toEqual({
      featureId: 'test.core',
      state: 'active',
    })
    expect(service?.listActiveContributions()).toEqual([
      expect.objectContaining({
        featureId: 'test.core',
        provenance: { authority: 'core', required: true },
      }),
    ])

    await owner.dispose()
    await owner.dispose()
    expect(() => service?.start()).toThrow('DshTuiFeatureService is disposed')
    await plugin.dispose()
    expect(root.get('dshTuiFeatures')).toBeUndefined()
    await root.fiber.dispose()
  })

  it('keeps session Features inactive until a RuntimeSession is explicitly bound', async () => {
    const root = new Context()
    const { owner, plugin } = await installFeatureHost(root)
    const applicationCreate = vi.fn(() => ({
      contributions: {
        resources: [{
          id: 'application.ready',
          value: testResource('application.ready', true),
        }],
      },
      dispose() {},
    }))
    const sessionCreate = vi.fn(() => ({
      contributions: {
        resources: [{
          id: 'session.ready',
          value: testResource('session.ready', true, { lifetime: 'session' }),
        }],
      },
      dispose() {},
    }))
    const application = owner.service.registerFeature({
      manifest: {
        id: 'scoped.application',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      declarations: { resources: ['application.ready'] },
      create: applicationCreate,
    })
    const session = owner.service.registerFeature(sessionFeature({
      id: 'scoped.session',
      required: true,
      resource: 'session.ready',
      create: sessionCreate,
    }))

    await expect(application.activation).resolves.toMatchObject({ state: 'active' })
    await expect(session.activation).resolves.toBeUndefined()
    expect(applicationCreate).toHaveBeenCalledOnce()
    expect(sessionCreate).not.toHaveBeenCalled()
    expect(owner.service.status('scoped.session')).toEqual({
      featureId: 'scoped.session',
      state: 'inactive',
    })
    await expect(owner.service.activateFeature('scoped.session')).resolves.toEqual({
      featureId: 'scoped.session',
      state: 'inactive',
    })
    expect(owner.service.listActiveContributions().map(item => item.featureId)).toEqual([
      'scoped.application',
    ])

    const scope = requireApplicationScopeHost(owner.service)
      .createRuntimeSessionScope('session-a')
    const binding = await owner.service.bindSession({
      scope,
      capabilities: capabilityResolver(),
    })

    expect(binding.active).toBe(true)
    expect(sessionCreate).toHaveBeenCalledOnce()
    expect(owner.service.status('scoped.session')).toEqual({
      featureId: 'scoped.session',
      state: 'active',
    })
    expect(owner.service.listActiveContributions().map(item => item.featureId)).toEqual([
      'scoped.application',
      'scoped.session',
    ])

    await binding.release()
    expect(binding.active).toBe(false)
    expect(owner.service.status('scoped.session')).toEqual({
      featureId: 'scoped.session',
      state: 'inactive',
    })
    await scope.dispose()
    await session.release()
    await application.release()
    await plugin.dispose()
    await root.fiber.dispose()
  })

  it('routes lazy activation to the current session supervisor and merges active snapshots once', async () => {
    const root = new Context()
    const { owner, plugin } = await installFeatureHost(root)
    const routeCreate = vi.fn(() => ({
      contributions: {
        routes: [{
          id: 'session.workspace',
          value: { kind: 'workspace', featureId: 'session.route', pane: 'content' },
        }],
      },
      dispose() {},
    }))
    const commandCreate = vi.fn(() => ({
      contributions: {
        commands: [{ id: 'session.open', value: { handle() {} } }],
      },
      dispose() {},
    }))
    const route = owner.service.registerFeature(sessionFeature({
      id: 'session.route',
      activation: 'on-route',
      route: 'session.workspace',
      create: routeCreate,
    }))
    const command = owner.service.registerFeature(sessionFeature({
      id: 'session.command',
      activation: 'on-command',
      command: 'session.open',
      create: commandCreate,
    }))

    await expect(owner.service.activateRoute('session.workspace')).resolves.toEqual([])
    await expect(owner.service.activateCommand('session.open')).resolves.toEqual([])
    expect(routeCreate).not.toHaveBeenCalled()
    expect(commandCreate).not.toHaveBeenCalled()

    const scope = requireApplicationScopeHost(owner.service)
      .createRuntimeSessionScope('session-routing')
    const binding = await owner.service.bindSession({
      scope,
      capabilities: capabilityResolver(),
    })
    await expect(owner.service.activateRoute('session.workspace')).resolves.toMatchObject([
      { featureId: 'session.route', state: 'active' },
    ])
    await expect(owner.service.activateCommand('session.open')).resolves.toMatchObject([
      { featureId: 'session.command', state: 'active' },
    ])
    await expect(owner.service.activateFeature('session.route')).resolves.toMatchObject({
      featureId: 'session.route',
      state: 'active',
    })
    expect(owner.service.listActiveContributions().map(item => item.featureId)).toEqual([
      'session.route',
      'session.command',
    ])
    expect(owner.service.contributionsFor('session.route')).toMatchObject({
      routes: [{ id: 'session.workspace' }],
    })

    await binding.release()
    await scope.dispose()
    await command.release()
    await route.release()
    await plugin.dispose()
    await root.fiber.dispose()
  })

  it('switches session supervisors by disposing Features in reverse activation order', async () => {
    const root = new Context()
    const unloaded: string[] = []
    const { owner, plugin } = await installFeatureHost(
      root,
      event => { unloaded.push(event.featureId) },
    )
    const log: string[] = []
    const create = (id: string): FeatureFactory['create'] => ({ scope }) => {
      log.push(`create:${id}:${scope.label}`)
      return {
        contributions: {},
        dispose: () => { log.push(`dispose:${id}:${scope.label}`) },
      }
    }
    const firstFeature = owner.service.registerFeature(sessionFeature({
      id: 'session.first',
      create: create('first'),
    }))
    const secondFeature = owner.service.registerFeature(sessionFeature({
      id: 'session.second',
      create: create('second'),
    }))
    const scopeHost = requireApplicationScopeHost(owner.service)
    const firstScope = scopeHost.createRuntimeSessionScope('first-session')
    const firstBinding = await owner.service.bindSession({
      scope: firstScope,
      capabilities: capabilityResolver(),
    })
    const secondScope = scopeHost.createRuntimeSessionScope('second-session')
    const secondBinding = await owner.service.bindSession({
      scope: secondScope,
      capabilities: capabilityResolver(),
    })

    expect(firstBinding.active).toBe(false)
    expect(secondBinding.active).toBe(true)
    expect(log).toEqual([
      'create:first:first-session',
      'create:second:first-session',
      'dispose:second:first-session',
      'dispose:first:first-session',
      'create:first:second-session',
      'create:second:second-session',
    ])
    expect(unloaded).toEqual(['session.second', 'session.first'])

    await secondScope.dispose()
    await vi.waitFor(() => expect(secondBinding.active).toBe(false))
    expect(log.slice(-2)).toEqual([
      'dispose:second:second-session',
      'dispose:first:second-session',
    ])
    expect(unloaded).toEqual([
      'session.second',
      'session.first',
      'session.second',
      'session.first',
    ])
    await firstScope.dispose()
    await secondFeature.release()
    await firstFeature.release()
    await plugin.dispose()
    await root.fiber.dispose()
  })

  it('releases a session Feature before its acquired capability lease', async () => {
    const root = new Context()
    const { owner, plugin } = await installFeatureHost(root)
    const log: string[] = []
    const token = createCapabilityToken<{ readonly id: string }>(
      'session.catalog/v1',
      'session',
    )
    const registration = owner.service.registerFeature(sessionFeature({
      id: 'session.capability-consumer',
      requires: [token],
      create: ({ scope, dependencies }) => {
        log.push(`create:feature:${scope.label}:${String(dependencies[0]?.value)}`)
        return {
          contributions: {},
          dispose: () => { log.push(`dispose:feature:${scope.label}`) },
        }
      },
    }))
    const scope = requireApplicationScopeHost(owner.service)
      .createRuntimeSessionScope('capability-session')
    const binding = await owner.service.bindSession({
      scope,
      capabilities: capabilityResolver(new Map([[token.id, 'catalog-value']]), log),
    })

    await binding.release()
    expect(log).toEqual([
      `acquire:${token.id}:capability-session`,
      'create:feature:capability-session:catalog-value',
      'dispose:feature:capability-session',
      `release:${token.id}:capability-session`,
    ])

    await scope.dispose()
    await registration.release()
    await plugin.dispose()
    await root.fiber.dispose()
  })

  it('resolves application requirements internally for a session Feature', async () => {
    const root = new Context()
    const { owner, plugin } = await installFeatureHost(root)
    const applicationToken = createCapabilityToken<string>(
      'application.catalog/v1',
      'application',
    )
    const sessionToken = createCapabilityToken<string>(
      'session.selection/v1',
      'session',
    )
    const releaseApplicationProvider = vi.fn()
    const applicationCapability = owner.service.registerCapability({
      token: applicationToken,
      create: ({ scope }) => {
        expect(scope.kind).toBe('app')
        return {
          value: 'application-value',
          release: releaseApplicationProvider,
        }
      },
    })
    const create = vi.fn((context) => ({
      contributions: {},
      dispose() {},
      context,
    }))
    const registration = owner.service.registerFeature(sessionFeature({
      id: 'session.mixed-capabilities',
      requires: [applicationToken, sessionToken],
      create,
    }))
    const sessionResolve = vi.fn((
      token: CapabilityToken<unknown>,
      scope: ResourceScope,
    ) => {
      expect(token).toEqual(sessionToken)
      expect(scope.kind).toBe('session')
    })
    const sessionCapabilities: FeatureCapabilityResolver = {
      resolve<TValue>(token: CapabilityToken<TValue>, scope: ResourceScope) {
        sessionResolve(token, scope)
        return { value: 'session-value' as unknown as TValue, release() {} }
      },
    }
    const scope = requireApplicationScopeHost(owner.service)
      .createRuntimeSessionScope('mixed-capabilities')
    const binding = await owner.service.bindSession({
      scope,
      capabilities: sessionCapabilities,
    })

    expect(owner.service.status('session.mixed-capabilities')).toEqual({
      featureId: 'session.mixed-capabilities',
      state: 'active',
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      dependencies: [
        { token: applicationToken, value: 'application-value' },
        { token: sessionToken, value: 'session-value' },
      ],
    }))
    expect(sessionResolve).toHaveBeenCalledOnce()

    await binding.release()
    expect(releaseApplicationProvider).not.toHaveBeenCalled()
    await applicationCapability.release()
    expect(releaseApplicationProvider).toHaveBeenCalledOnce()
    await scope.dispose()
    await registration.release()
    await plugin.dispose()
    await root.fiber.dispose()
  })

  it('starts a pre-bound session and activates later eager session registrations', async () => {
    const root = new Context()
    const service = new CordisDshTuiFeatureService(root)
    const scope = requireApplicationScopeHost(service)
      .createRuntimeSessionScope('pre-bound-session')
    const binding = await service.bindSession({
      scope,
      capabilities: capabilityResolver(),
    })
    const initialCreate = vi.fn(() => ({ contributions: {}, dispose() {} }))
    const initial = service.registerFeature(sessionFeature({
      id: 'session.pre-bound',
      create: initialCreate,
    }))

    await expect(initial.activation).resolves.toBeUndefined()
    await expect(service.start()).resolves.toMatchObject([
      { featureId: 'session.pre-bound', state: 'active' },
    ])
    expect(initialCreate).toHaveBeenCalledOnce()

    const dynamicCreate = vi.fn(() => ({ contributions: {}, dispose() {} }))
    const dynamic = service.registerFeature(sessionFeature({
      id: 'session.dynamic-eager',
      create: dynamicCreate,
    }))
    await expect(dynamic.activation).resolves.toMatchObject({
      featureId: 'session.dynamic-eager',
      state: 'active',
    })
    expect(dynamicCreate).toHaveBeenCalledOnce()

    await dynamic.release()
    await initial.release()
    await binding.release()
    await scope.dispose()
    await service.dispose()
    await root.fiber.dispose()
  })

  it('does not let an unbound required session Feature fail application startup', async () => {
    const root = new Context()
    const service = new CordisDshTuiFeatureService(root)
    const create = vi.fn(() => { throw new Error('session activation failed') })
    const registration = service.registerFeature(sessionFeature({
      id: 'session.required-failure',
      required: true,
      create,
    }))

    await expect(service.start()).resolves.toEqual([])
    await expect(registration.activation).resolves.toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    expect(service.status('session.required-failure')).toEqual({
      featureId: 'session.required-failure',
      state: 'inactive',
    })

    const scope = requireApplicationScopeHost(service)
      .createRuntimeSessionScope('failing-session')
    await expect(service.bindSession({
      scope,
      capabilities: capabilityResolver(),
    })).rejects.toMatchObject({
      name: 'FeatureActivationError',
      featureId: 'session.required-failure',
      required: true,
    })
    expect(create).toHaveBeenCalledOnce()
    expect(service.status('session.required-failure')).toEqual({
      featureId: 'session.required-failure',
      state: 'inactive',
    })

    await scope.dispose()
    await registration.release()
    await service.dispose()
    await root.fiber.dispose()
  })

  it('reports a dynamically activated required session failure through lifecycle observers', async () => {
    const root = new Context()
    const { owner, plugin } = await installFeatureHost(root)
    const failed = vi.fn()
    owner.service.onRequiredFeatureFailure(failed)
    const scope = requireApplicationScopeHost(owner.service)
      .createRuntimeSessionScope('dynamic-required-session')
    const binding = await owner.service.bindSession({
      scope,
      capabilities: capabilityResolver(),
    })
    const registration = owner.service.registerFeature(sessionFeature({
      id: 'session.dynamic-required-failure',
      required: true,
      create: () => { throw new Error('dynamic session failure') },
    }))

    await expect(registration.activation).rejects.toMatchObject({
      name: 'FeatureActivationError',
      featureId: 'session.dynamic-required-failure',
    })
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      featureId: 'session.dynamic-required-failure',
      reason: 'activation',
    }))

    await registration.release()
    await binding.release()
    await scope.dispose()
    await plugin.dispose()
    await root.fiber.dispose()
  })

  it('releases a transient supervisor when session-scope ownership cannot be installed', async () => {
    const root = new Context()
    const service = new CordisDshTuiFeatureService(root)
    await service.start()
    const scope = requireApplicationScopeHost(service)
      .createRuntimeSessionScope('ownership-failure')
    const expected = new Error('scope ownership failed')
    const defer = vi.spyOn(scope, 'defer').mockImplementationOnce(() => { throw expected })

    await expect(service.bindSession({
      scope,
      capabilities: capabilityResolver(),
    })).rejects.toBe(expected)
    expect(service.listActiveContributions()).toEqual([])

    defer.mockRestore()
    await scope.dispose()
    await service.dispose()
    await root.fiber.dispose()
  })

  it('combines session activation failure with rollback failure without retaining a binding', async () => {
    const root = new Context()
    const service = new CordisDshTuiFeatureService(root)
    await service.start()
    const first = service.registerFeature(sessionFeature({
      id: 'session.rollback-failure',
      create: () => ({
        contributions: {},
        dispose: () => { throw new Error('session rollback failed') },
      }),
    }))
    const second = service.registerFeature(sessionFeature({
      id: 'session.activation-failure',
      required: true,
      create: () => { throw new Error('session create failed') },
    }))
    const scope = requireApplicationScopeHost(service)
      .createRuntimeSessionScope('rollback-failure')

    await expect(service.bindSession({
      scope,
      capabilities: capabilityResolver(),
    })).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Session Feature binding activation cleanup failed',
    })
    expect(service.status('session.rollback-failure')).toEqual({
      featureId: 'session.rollback-failure',
      state: 'inactive',
    })
    expect(service.status('session.activation-failure')).toEqual({
      featureId: 'session.activation-failure',
      state: 'inactive',
    })

    await scope.dispose().catch(() => {})
    await second.release()
    await first.release()
    await service.dispose()
    await root.fiber.dispose()
  })

  it('contains a bound session disposal failure during service shutdown', async () => {
    const root = new Context()
    const service = new CordisDshTuiFeatureService(root)
    await service.start()
    const registration = service.registerFeature(sessionFeature({
      id: 'session.shutdown-failure',
      create: () => ({
        contributions: {},
        dispose: () => { throw new Error('session shutdown failed') },
      }),
    }))
    const scope = requireApplicationScopeHost(service)
      .createRuntimeSessionScope('shutdown-failure')
    const binding = await service.bindSession({
      scope,
      capabilities: capabilityResolver(),
    })

    await expect(service.dispose()).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'DshTuiFeatureService disposal failed',
    })
    expect(binding.active).toBe(false)

    await registration.release()
    await scope.dispose().catch(() => {})
    await root.fiber.dispose().catch(() => {})
  })

  it('owns lifecycle subscriptions by the calling Cordis fiber', async () => {
    const root = new Context()
    const { owner, plugin: host } = await installFeatureHost(root)
    const unloaded = vi.fn()
    const failed = vi.fn()
    const observer = root.plugin({
      name: 'test-feature-lifecycle-observer',
      inject: ['dshTuiFeatures'],
      apply(ctx) {
        ctx.dshTuiFeatures.onActiveFeatureUnloaded(unloaded)
        ctx.dshTuiFeatures.onRequiredFeatureFailure(failed)
      },
    })
    await observer

    const route = owner.service.registerFeature(routeFeature('observed.route'))
    await owner.service.activateRoute('observed.route.route')
    await route.release()
    expect(unloaded).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      featureId: 'observed.route',
    }))

    const firstFailure = owner.service.registerFeature({
      manifest: {
        id: 'observed.required-failure',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create: () => { throw new Error('observed failure') },
    })
    await expect(firstFailure.activation).rejects.toThrow('observed.required-failure')
    expect(failed).toHaveBeenCalledOnce()
    await firstFailure.release()

    await observer.dispose()
    const secondFailure = owner.service.registerFeature({
      manifest: {
        id: 'unobserved.required-failure',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create: () => { throw new Error('unobserved failure') },
    })
    await expect(secondFailure.activation).rejects.toThrow('unobserved.required-failure')
    expect(failed).toHaveBeenCalledOnce()

    await secondFailure.release()
    await host.dispose()
    await root.fiber.dispose()
  })

  it('aggregates multiple unload observer failures without retaining contributions', async () => {
    const root = new Context()
    const { owner, plugin } = await installFeatureHost(root)
    owner.service.onActiveFeatureUnloaded(() => { throw new Error('first observer failed') })
    owner.service.onActiveFeatureUnloaded(() => { throw new Error('second observer failed') })
    const registration = owner.service.registerFeature(routeFeature('observer.failures'))
    await owner.service.activateRoute('observer.failures.route')

    await expect(registration.release()).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Feature "observer.failures" unload failed',
    })
    expect(owner.service.listActiveContributions()).toEqual([])

    await plugin.dispose()
    await root.fiber.dispose()
  })

  it('activates route and command factories and removes them with the caller fiber', async () => {
    const root = new Context()
    const unloaded = vi.fn()
    const { owner, plugin: host } = await installFeatureHost(root, unloaded)
    const routeDispose = vi.fn()
    const commandDispose = vi.fn()
    let routeRegistration!: ReturnType<CordisDshTuiFeatureService['registerFeature']>
    let commandRegistration!: ReturnType<CordisDshTuiFeatureService['registerFeature']>
    const extension = root.plugin({
      name: 'test-extension',
      inject: ['dshTuiFeatures'],
      apply(ctx) {
        routeRegistration = ctx.dshTuiFeatures.registerFeature(
          routeFeature('fake.workspace', routeDispose),
        )
        commandRegistration = ctx.dshTuiFeatures.registerFeature(
          commandFeature('fake.command', commandDispose),
        )
      },
    })
    await extension
    const service = owner.service

    await expect(routeRegistration.activation).resolves.toBeUndefined()
    await expect(commandRegistration.activation).resolves.toBeUndefined()
    await expect(service.activateRoute('missing')).resolves.toEqual([])
    await expect(service.activateFeature('missing')).rejects.toThrow(
      'Feature "missing" is not registered',
    )
    await expect(service.activateRoute('fake.workspace.route')).resolves.toMatchObject([
      { featureId: 'fake.workspace', state: 'active' },
    ])
    await expect(service.activateCommand('fake.command.open')).resolves.toMatchObject([
      { featureId: 'fake.command', state: 'active' },
    ])
    await expect(service.activateFeature('fake.workspace')).resolves.toMatchObject({
      state: 'active',
    })
    expect(service.contributionsFor('fake.workspace')).toMatchObject({
      resources: [{ id: 'fake.workspace.resource' }],
      surfaces: [{ id: 'fake.workspace.surface' }],
    })

    await extension.dispose()
    expect(routeRegistration.active).toBe(false)
    expect(commandRegistration.active).toBe(false)
    expect(routeDispose).toHaveBeenCalledOnce()
    expect(commandDispose).toHaveBeenCalledOnce()
    expect(service.status('fake.workspace')).toBeUndefined()
    expect(service.status('fake.command')).toBeUndefined()
    expect(unloaded.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({
        featureId: 'fake.command',
        fallbackRoute: 'chat',
        restoreFocus: true,
      }),
      expect.objectContaining({
        featureId: 'fake.workspace',
        fallbackRoute: 'chat',
        restoreFocus: true,
      }),
    ])

    await host.dispose()
    await root.fiber.dispose()
  })

  it('resolves declared capabilities and retires their lease with the provider fiber', async () => {
    const root = new Context()
    const { owner, plugin: host } = await installFeatureHost(root)
    const token = createCapabilityToken<{ readonly label: string }>(
      'test.catalog/v1',
      'application',
    )
    const releaseProvider = vi.fn()
    const createCapability = vi.fn((_context: CapabilityFactoryContext) => ({
      value: { label: 'catalog' },
      release: releaseProvider,
    }))
    const createFeature = vi.fn((context) => ({
      contributions: {
        resources: [{
          id: 'catalog',
          value: testResource('catalog', context.dependencies[0]?.value),
        }],
      },
      dispose: vi.fn(),
    }))
    const dependent: FeatureFactory<readonly [typeof token]> = {
      manifest: {
        id: 'fake.capability-consumer',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [token],
      },
      declarations: { resources: ['catalog'] },
      create: createFeature,
    }
    let capabilityRegistration!: ReturnType<CordisDshTuiFeatureService['registerCapability']>
    let featureRegistration!: ReturnType<CordisDshTuiFeatureService['registerFeature']>
    const extension = root.plugin({
      name: 'test-capability-extension',
      inject: ['dshTuiFeatures'],
      apply(ctx) {
        capabilityRegistration = ctx.dshTuiFeatures.registerCapability({
          token,
          create: createCapability,
        })
        featureRegistration = ctx.dshTuiFeatures.registerFeature(dependent)
      },
    })
    await extension

    await expect(featureRegistration.activation).resolves.toMatchObject({
      featureId: 'fake.capability-consumer',
      state: 'active',
    })
    expect(createCapability).toHaveBeenCalledOnce()
    expect(createFeature).toHaveBeenCalledWith(expect.objectContaining({
      dependencies: [{ token, value: { label: 'catalog' } }],
    }))
    expect(owner.service.contributionsFor('fake.capability-consumer')).toMatchObject({
      resources: [{ id: 'catalog', value: { key: 'catalog' } }],
    })

    await featureRegistration.release()
    await capabilityRegistration.release()
    await extension.dispose()
    expect(releaseProvider).toHaveBeenCalledOnce()
    expect(featureRegistration.active).toBe(false)
    expect(capabilityRegistration.active).toBe(false)

    await host.dispose()
    await root.fiber.dispose()
  })

  it('quarantines optional single-slot overflow before publication', async () => {
    const root = new Context()
    const { owner, plugin } = await installFeatureHost(root)
    const dispose = vi.fn()
    const registration = owner.service.registerFeature({
      manifest: {
        id: 'optional.single-overflow',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      declarations: {
        surfaces: [{ slot: WORKSPACE_PRIMARY_SLOT.id, cardinality: 'single' }],
      },
      create: () => ({
        contributions: {
          surfaces: [
            {
              id: 'optional.primary',
              slot: WORKSPACE_PRIMARY_SLOT.id,
              value: { id: 'optional.primary', role: 'content', node: {} },
            },
            {
              id: 'optional.secondary',
              slot: WORKSPACE_PRIMARY_SLOT.id,
              value: { id: 'optional.secondary', role: 'content', node: {} },
            },
          ],
        },
        dispose,
      }),
    })

    await expect(registration.activation).resolves.toMatchObject({
      featureId: 'optional.single-overflow',
      state: 'unavailable',
    })
    expect(owner.service.status('optional.single-overflow')).toMatchObject({
      state: 'unavailable',
    })
    expect(owner.service.listActiveContributions().map(entry => entry.featureId))
      .not.toContain('optional.single-overflow')
    expect(dispose).toHaveBeenCalledOnce()

    await registration.release()
    await plugin.dispose()
    await root.fiber.dispose()
  })

  it('routes required product-contract failures through the fatal observer', async () => {
    const root = new Context()
    const fatal = vi.fn()
    let owner!: DshTuiFeatureOwner
    const plugin = root.plugin({
      name: 'required-contract-fixture',
      apply(ctx) {
        owner = provideDshTuiFeatures(ctx, { onRequiredFeatureFailure: fatal })
        ctx.effect(() => () => owner.dispose())
      },
    })
    await plugin
    await owner.ready
    const dispose = vi.fn()
    const registration = owner.service.registerFeature({
      manifest: {
        id: 'required.bad-command-contract',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      declarations: { commands: ['required.open'] },
      create: () => ({
        contributions: {
          commands: [{ id: 'required.open', value: { notAHandler: true } }],
        },
        dispose,
      }),
    })

    await expect(registration.activation).rejects.toMatchObject({
      name: 'FeatureActivationError',
      featureId: 'required.bad-command-contract',
      required: true,
    })
    expect(fatal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      featureId: 'required.bad-command-contract',
      reason: 'activation',
    }))
    expect(dispose).toHaveBeenCalledOnce()

    await registration.release()
    await plugin.dispose()
    await root.fiber.dispose()
  })

  it('uses the immutable registration snapshot for dynamic eager activation', async () => {
    const root = new Context()
    const service = new CordisDshTuiFeatureService(root)
    await service.start()
    let idReads = 0
    const factory: FeatureFactory = {
      manifest: {
        get id() {
          idReads += 1
          return idReads === 1 ? 'stable.eager' : 'mutated.eager'
        },
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      create: () => ({ contributions: {}, dispose() {} }),
    }

    const registration = service.registerFeature(factory)

    await expect(registration.activation).resolves.toEqual({
      featureId: 'stable.eager',
      state: 'active',
    })
    expect(registration.featureId).toBe('stable.eager')
    expect(service.status('stable.eager')?.state).toBe('active')
    expect(service.status('mutated.eager')).toBeUndefined()

    await registration.release()
    await service.dispose()
    await root.fiber.dispose()
  })

  it('does not activate an eager registration after its owning fiber releases it', async () => {
    const root = new Context()
    const service = new CordisDshTuiFeatureService(root)
    await service.start()
    const create = vi.fn(() => ({ contributions: {}, dispose() {} }))
    const registration = service.registerFeature({
      manifest: {
        id: 'released.eager',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [],
      },
      create,
    })

    const activation = registration.activation
    await registration.release()
    await expect(activation).resolves.toBeUndefined()
    expect(create).not.toHaveBeenCalled()

    await service.dispose()
    await root.fiber.dispose()
  })

  it('isolates registries, scopes, and feature state between Cordis applications', async () => {
    const firstRoot = new Context()
    const secondRoot = new Context()
    const first = await installFeatureHost(firstRoot)
    const second = await installFeatureHost(secondRoot)
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const firstRegistration = first.owner.service.registerFeature(
      routeFeature('same.id', firstDispose),
    )
    const secondRegistration = second.owner.service.registerFeature(
      routeFeature('same.id', secondDispose),
    )
    const firstSessionCreate = vi.fn(() => ({ contributions: {}, dispose() {} }))
    const secondSessionCreate = vi.fn(() => ({ contributions: {}, dispose() {} }))
    const firstSessionRegistration = first.owner.service.registerFeature(sessionFeature({
      id: 'same.session-id',
      create: firstSessionCreate,
    }))
    const secondSessionRegistration = second.owner.service.registerFeature(sessionFeature({
      id: 'same.session-id',
      create: secondSessionCreate,
    }))

    await first.owner.service.activateRoute('same.id.route')
    expect(first.owner.service.status('same.id')?.state).toBe('active')
    expect(second.owner.service.status('same.id')?.state).toBe('inactive')
    await firstRegistration.release()
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).not.toHaveBeenCalled()

    const firstSessionScope = requireApplicationScopeHost(first.owner.service)
      .createRuntimeSessionScope('first-context-session')
    const firstBinding = await first.owner.service.bindSession({
      scope: firstSessionScope,
      capabilities: capabilityResolver(),
    })
    expect(first.owner.service.status('same.session-id')?.state).toBe('active')
    expect(second.owner.service.status('same.session-id')?.state).toBe('inactive')
    expect(firstSessionCreate).toHaveBeenCalledOnce()
    expect(secondSessionCreate).not.toHaveBeenCalled()

    const secondSessionScope = requireApplicationScopeHost(second.owner.service)
      .createRuntimeSessionScope('second-context-session')
    const secondBinding = await second.owner.service.bindSession({
      scope: secondSessionScope,
      capabilities: capabilityResolver(),
    })
    expect(second.owner.service.status('same.session-id')?.state).toBe('active')
    expect(secondSessionCreate).toHaveBeenCalledOnce()

    await second.owner.service.activateRoute('same.id.route')
    expect(second.owner.service.status('same.id')?.state).toBe('active')
    await firstBinding.release()
    await secondBinding.release()
    await firstSessionScope.dispose()
    await secondSessionScope.dispose()
    await firstSessionRegistration.release()
    await secondSessionRegistration.release()
    await secondRegistration.release()
    await Promise.all([first.plugin.dispose(), second.plugin.dispose()])
    await Promise.all([firstRoot.fiber.dispose(), secondRoot.fiber.dispose()])
  })

  it('contains required activation and both feature/scope disposal failures', async () => {
    const requiredRoot = new Context()
    const requiredFailure = vi.fn(() => Promise.reject(new Error('observer failed')))
    const required = new CordisDshTuiFeatureService(requiredRoot, {
      onRequiredFeatureFailure: requiredFailure,
    })
    await required.start()
    const broken = required.registerFeature({
      manifest: {
        id: 'broken.required',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create: () => { throw new Error('activation failed') },
    })
    await expect(broken.activation).rejects.toThrow('broken.required')
    expect(requiredFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'required-feature-failure',
      featureId: 'broken.required',
      reason: 'activation',
    }))
    await broken.release()
    await required.dispose()
    expect(() => required.registerFeature(routeFeature('too-late'))).toThrow(
      'DshTuiFeatureService is disposed',
    )
    expect(() => required.registerCapability({
      token: createCapabilityToken('too-late/v1', 'application'),
      create: () => ({ value: undefined, release: () => {} }),
    })).toThrow('DshTuiFeatureService is disposed')
    await requiredRoot.fiber.dispose()

    const initialRoot = new Context()
    const initialFailure = vi.fn()
    const initial = new CordisDshTuiFeatureService(initialRoot, {
      onRequiredFeatureFailure: initialFailure,
    }, [{
      manifest: {
        id: 'initial.required',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create: () => { throw new Error('initial activation failed') },
    }])
    await expect(initial.start()).rejects.toThrow('initial.required')
    expect(initialFailure).not.toHaveBeenCalled()
    await initial.dispose()
    await initialRoot.fiber.dispose()

    const disposalRoot = new Context()
    const disposal = new CordisDshTuiFeatureService(disposalRoot)
    disposal.registerFeature({
      manifest: {
        id: 'broken.disposal',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create: ({ scope }) => {
        scope.defer(() => { throw new Error('scope cleanup failed') })
        return {
          contributions: {},
          dispose: () => { throw new Error('feature cleanup failed') },
        }
      },
    })
    await disposal.start()
    const disposeTask = disposal.dispose()
    expect(disposal.dispose()).toBe(disposeTask)
    await expect(disposeTask).rejects.toEqual(expect.objectContaining({
      name: 'AggregateError',
      message: 'DshTuiFeatureService disposal failed',
    }))
    await disposalRoot.fiber.dispose().catch(() => {})
  })

  it('aborts an in-flight feature factory before waiting for supervisor disposal', async () => {
    const root = new Context()
    const createEntered = deferred<void>()
    const instanceDispose = vi.fn()
    const feature: FeatureFactory = {
      manifest: {
        id: 'waiting.required',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: true,
        requires: [],
      },
      create: async ({ scope }) => {
        createEntered.resolve()
        await new Promise<void>((resolve) => {
          scope.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return { contributions: {}, dispose: instanceDispose }
      },
    }
    const service = new CordisDshTuiFeatureService(root, {}, [feature])
    const ready = service.start()
    await createEntered.promise

    await expect(service.dispose()).resolves.toBeUndefined()
    await expect(ready).rejects.toThrow('waiting.required')
    expect(instanceDispose).toHaveBeenCalledOnce()
    await root.fiber.dispose()
  })
})

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}
