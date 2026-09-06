import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createCapabilityToken } from '../src/kernel/capability.ts'
import {
  FEATURE_API_VERSION,
  type FeatureContributionDeclarations,
  type FeatureFactory,
  type FeatureManifest,
} from '../src/kernel/feature.ts'
import {
  FeatureRegistrationError,
  FeatureRegistry,
} from '../src/kernel/feature-registry.ts'

function feature(
  id: string,
  manifest: Partial<Omit<FeatureManifest, 'id'>> = {},
  declarations?: FeatureContributionDeclarations,
): FeatureFactory {
  const factory: FeatureFactory = {
    manifest: {
      id,
      apiVersion: FEATURE_API_VERSION,
      scope: 'application',
      activation: 'eager',
      required: true,
      requires: [],
      ...manifest,
    },
    create: vi.fn(() => ({ contributions: {}, dispose: vi.fn() })),
  }
  if (declarations !== undefined) {
    return { ...factory, declarations }
  }
  return factory
}

function unsafeManifest(value: unknown): FeatureManifest {
  return value as FeatureManifest
}

function expectCode(factory: FeatureFactory, code: FeatureRegistrationError['code']): void {
  expect(() => new FeatureRegistry().register(factory)).toThrowError(
    expect.objectContaining<Partial<FeatureRegistrationError>>({ code }),
  )
}

describe('FeatureRegistry', () => {
  it('preserves declared capability value types in the factory context', () => {
    interface SessionIdentity {
      readonly sessionId: string
    }
    interface ApplicationRoot {
      readonly cwd: string
    }
    const application = createCapabilityToken<ApplicationRoot>(
      'dsh.typed-application/v1',
      'application',
    )
    const session = createCapabilityToken<SessionIdentity>('dsh.typed-session/v1', 'session')
    const typedFactory: FeatureFactory<readonly [typeof application, typeof session]> = {
      manifest: {
        id: 'typed-session',
        apiVersion: FEATURE_API_VERSION,
        scope: 'session',
        activation: 'eager',
        required: true,
        requires: [application, session],
      },
      create: (context) => {
        expectTypeOf(context.dependencies[0].token).toEqualTypeOf<typeof application>()
        expectTypeOf(context.dependencies[0].value).toEqualTypeOf<ApplicationRoot>()
        expectTypeOf(context.dependencies[1].token).toEqualTypeOf<typeof session>()
        expectTypeOf(context.dependencies[1].value).toEqualTypeOf<SessionIdentity>()
        return { contributions: {}, dispose() {} }
      },
    }

    expect(typedFactory.manifest.requires).toEqual([application, session])
  })

  it('rejects malformed factories deterministically', () => {
    expectCode(null as unknown as FeatureFactory, 'invalid-factory')
    expectCode({
      manifest: feature('missing-create').manifest,
    } as unknown as FeatureFactory, 'invalid-factory')
  })

  it('stores factories without constructing instances and supports API-version instances', () => {
    const registry = new FeatureRegistry()
    const factory = feature('conversation')
    registry.register(factory)

    expect(registry.get('conversation')).toBe(factory)
    expect(registry.provenanceOf('conversation')).toEqual({
      authority: 'extension',
      required: true,
    })
    expect(registry.provenanceOf(factory)).toEqual({
      authority: 'extension',
      required: true,
    })
    expect(registry.list()).toEqual([factory])
    expect(registry.size).toBe(1)
    expect(factory.create).not.toHaveBeenCalled()

    const versionTwo = new FeatureRegistry(2)
    versionTwo.register(feature('future', { apiVersion: 2 }))
    expect(versionTwo.supportedApiVersion).toBe(2)
  })

  it('binds immutable manifest and declaration snapshots to factory identity', async () => {
    const routes = ['original.route']
    const commands = ['original.command']
    const surfaces = [{ slot: 'original.slot', cardinality: 'single' as const }]
    const original = feature('mutable', {}, { routes, commands, surfaces })
    const registry = new FeatureRegistry()
    const lease = registry.register(original, { authority: 'core' })

    const snapshot = registry.snapshotOf(original)
    expect(snapshot).toEqual({
      manifest: original.manifest,
      declarations: {
        routes: ['original.route'],
        commands: ['original.command'],
        keymaps: [],
        resources: [],
        surfaces: [{ slot: 'original.slot', cardinality: 'single' }],
      },
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot?.manifest)).toBe(true)
    expect(Object.isFrozen(snapshot?.manifest.requires)).toBe(true)
    expect(Object.isFrozen(snapshot?.declarations)).toBe(true)
    expect(Object.isFrozen(snapshot?.declarations.routes)).toBe(true)
    expect(Object.isFrozen(snapshot?.declarations.surfaces[0])).toBe(true)

    routes[0] = 'mutated.route'
    commands.push('mutated.command')
    surfaces[0]!.slot = 'mutated.slot'
    const mutableManifest = original.manifest as unknown as {
      id: string
      activation: FeatureManifest['activation']
    }
    mutableManifest.id = 'mutated.feature'
    mutableManifest.activation = 'on-route'

    expect(registry.snapshotOf('mutable')).toBe(snapshot)
    expect(registry.get('mutable')).toBe(original)
    expect(snapshot?.manifest.activation).toBe('eager')
    expect(snapshot?.declarations).toMatchObject({
      routes: ['original.route'],
      commands: ['original.command'],
      surfaces: [{ slot: 'original.slot', cardinality: 'single' }],
    })
    expect(() => registry.register(feature('route-conflict', {}, {
      routes: ['original.route'],
    }))).toThrowError(expect.objectContaining({ code: 'duplicate-route' }))
    expect(() => registry.register(feature('slot-conflict', {}, {
      surfaces: [{ slot: 'original.slot', cardinality: 'multiple' }],
    }))).toThrowError(expect.objectContaining({ code: 'duplicate-single-slot' }))

    await lease.release()
    expect(registry.snapshotOf('mutable')).toBeUndefined()
    expect(registry.snapshotOf(original)).toBe(snapshot)
    const replacement = feature('mutable')
    registry.register(replacement)
    expect(registry.snapshotOf(replacement)).not.toBe(snapshot)
  })

  it('validates the approved manifest contract and explicit requirements', () => {
    const session = createCapabilityToken<{ readonly id: string }>('dsh.session/v1', 'session')
    const application = createCapabilityToken<{ readonly root: string }>(
      'dsh.application/v1',
      'application',
    )
    const malformed: readonly [FeatureFactory, FeatureRegistrationError['code']][] = [
      [{ manifest: unsafeManifest(null), create: () => ({ contributions: {}, dispose() {} }) }, 'invalid-manifest'],
      [feature(1 as unknown as string), 'invalid-id'],
      [feature(' invalid '), 'invalid-id'],
      [feature('future', { apiVersion: 2 }), 'unsupported-api-version'],
      [feature('scope', { scope: 'request' } as unknown as Partial<FeatureManifest>), 'invalid-scope'],
      [feature('activation', { activation: 'manual' } as unknown as Partial<FeatureManifest>), 'invalid-activation'],
      [feature('required', { required: 'yes' } as unknown as Partial<FeatureManifest>), 'invalid-required'],
      [feature('implicit', { requires: null } as unknown as Partial<FeatureManifest>), 'implicit-requires'],
      [feature('bad-requirement', { requires: [null] } as unknown as Partial<FeatureManifest>), 'invalid-requirement'],
      [feature('bad-requirement-id', {
        requires: [{ id: 'dsh.session', scope: 'session' }] as unknown as FeatureManifest['requires'],
      }), 'invalid-requirement'],
      [feature('bad-requirement-scope', {
        requires: [{ id: 'dsh.session/v1', scope: 'request' }] as unknown as FeatureManifest['requires'],
      }), 'invalid-requirement'],
      [feature('scope-mismatch', { requires: [session] }), 'capability-scope-mismatch'],
      [feature('duplicate-requirement', { requires: [application, application] }), 'duplicate-requirement'],
    ]

    for (const [factory, code] of malformed) expectCode(factory, code)

    const sessionFeature = feature('session-feature', {
      scope: 'session',
      requires: [application, session],
    })
    const registry = new FeatureRegistry()
    registry.register(sessionFeature)
    expect(registry.get('session-feature')?.manifest.requires).toEqual([application, session])
  })

  it('records composition-owned authority without reading it from a Feature', async () => {
    const registry = new FeatureRegistry()
    const builtin = feature('builtin')
    const lease = registry.register(builtin, { authority: 'core' })
    expect(registry.provenanceOf(builtin)).toEqual({ authority: 'core', required: true })
    expect(() => registry.register(
      feature('invalid-authority'),
      { authority: 'root' as 'core' },
    )).toThrowError(expect.objectContaining({ code: 'invalid-provenance' }))

    await lease.release()
    expect(registry.provenanceOf('builtin')).toBeUndefined()
    expect(registry.provenanceOf(builtin)).toEqual({ authority: 'core', required: true })
  })

  it('validates declarations and activation trigger metadata', () => {
    const malformed: readonly [FeatureFactory, FeatureRegistrationError['code']][] = [
      [feature('null-declarations', {}, null as unknown as FeatureContributionDeclarations), 'invalid-declarations'],
      [feature('routes-not-array', {}, { routes: 'chat' } as unknown as FeatureContributionDeclarations), 'invalid-declarations'],
      [feature('commands-not-array', {}, { commands: 'open' } as unknown as FeatureContributionDeclarations), 'invalid-declarations'],
      [feature('keymaps-not-array', {}, { keymaps: 'ctrl+k' } as unknown as FeatureContributionDeclarations), 'invalid-declarations'],
      [feature('resources-not-array', {}, { resources: 'catalog' } as unknown as FeatureContributionDeclarations), 'invalid-declarations'],
      [feature('bad-route', {}, { routes: [' route '] }), 'invalid-declarations'],
      [feature('duplicate-route', {}, { routes: ['chat', 'chat'] }), 'duplicate-route'],
      [feature('duplicate-command', {}, { commands: ['open', 'open'] }), 'duplicate-declaration'],
      [feature('surfaces-not-array', {}, { surfaces: 'main' } as unknown as FeatureContributionDeclarations), 'invalid-declarations'],
      [feature('bad-surface', {}, { surfaces: [null] } as unknown as FeatureContributionDeclarations), 'invalid-declarations'],
      [feature('bad-slot', {}, { surfaces: [{ slot: '', cardinality: 'single' }] }), 'invalid-declarations'],
      [feature('bad-cardinality', {}, {
        surfaces: [{ slot: 'main', cardinality: 'exclusive' }],
      } as unknown as FeatureContributionDeclarations), 'invalid-declarations'],
      [feature('duplicate-surface', {}, {
        surfaces: [
          { slot: 'main', cardinality: 'multiple' },
          { slot: 'main', cardinality: 'multiple' },
        ],
      }), 'duplicate-surface-declaration'],
      [feature('lazy-command', { activation: 'on-command' }), 'invalid-activation-declaration'],
      [feature('lazy-route', { activation: 'on-route' }), 'invalid-activation-declaration'],
    ]
    for (const [factory, code] of malformed) expectCode(factory, code)

    const registry = new FeatureRegistry()
    registry.register(feature('declared', {}, {
      routes: ['chat'],
      commands: ['open'],
      keymaps: ['ctrl+k'],
      resources: ['catalog'],
      surfaces: [{ slot: 'status', cardinality: 'multiple' }],
    }))
    expect(registry.size).toBe(1)
  })

  it('rejects duplicate ids, routes, and single slots while allowing multiple slots', () => {
    const registry = new FeatureRegistry()
    const original = feature('chat', {}, {
      routes: ['chat'],
      surfaces: [{ slot: 'status', cardinality: 'multiple' }],
    })
    registry.register(original)
    registry.register(feature('status-extra', {}, {
      routes: ['settings'],
      surfaces: [{ slot: 'status', cardinality: 'multiple' }],
    }))
    registry.register(feature('composer', {}, {
      surfaces: [{ slot: 'composer', cardinality: 'single' }],
    }))

    expect(() => registry.register(feature('chat'))).toThrowError(
      expect.objectContaining({ code: 'duplicate-id' }),
    )
    expect(() => registry.register(feature('other-chat', {}, { routes: ['chat'] }))).toThrowError(
      expect.objectContaining({ code: 'duplicate-route' }),
    )
    expect(() => registry.register(feature('exclusive-status', {}, {
      surfaces: [{ slot: 'status', cardinality: 'single' }],
    }))).toThrowError(expect.objectContaining({ code: 'duplicate-single-slot' }))
    expect(() => registry.register(feature('other-composer', {}, {
      surfaces: [{ slot: 'composer', cardinality: 'multiple' }],
    }))).toThrowError(expect.objectContaining({ code: 'duplicate-single-slot' }))
    expect(registry.list()).toEqual([original, expect.anything(), expect.anything()])
  })

  it('enforces the product slot catalog before registering a factory', () => {
    const registry = new FeatureRegistry(FEATURE_API_VERSION, [
      { id: 'shell.root', cardinality: 'single', protection: 'protected' },
      { id: 'workspace.primary', cardinality: 'single', protection: 'public' },
      { id: 'workspace.tools', cardinality: 'list', protection: 'public' },
    ])

    expect(() => registry.register(feature('unknown', {}, {
      surfaces: [{ slot: 'workspace.missing', cardinality: 'multiple' }],
    }))).toThrowError(expect.objectContaining({ code: 'unknown-slot' }))
    expect(() => registry.register(feature('lying-list', {}, {
      surfaces: [{ slot: 'workspace.primary', cardinality: 'multiple' }],
    }))).toThrowError(expect.objectContaining({ code: 'slot-cardinality-mismatch' }))
    expect(() => registry.register(feature('lying-single', {}, {
      surfaces: [{ slot: 'workspace.tools', cardinality: 'single' }],
    }))).toThrowError(expect.objectContaining({ code: 'slot-cardinality-mismatch' }))
    expect(() => registry.register(feature('extension-root', {}, {
      surfaces: [{ slot: 'shell.root', cardinality: 'single' }],
    }))).toThrowError(expect.objectContaining({ code: 'protected-slot' }))

    registry.register(feature('core-root', {}, {
      surfaces: [{ slot: 'shell.root', cardinality: 'single' }],
    }), { authority: 'core' })
    registry.register(feature('tools-left', {}, {
      surfaces: [{ slot: 'workspace.tools', cardinality: 'multiple' }],
    }))
    registry.register(feature('tools-right', {}, {
      surfaces: [{ slot: 'workspace.tools', cardinality: 'multiple' }],
    }))
    registry.register(feature('primary', {}, {
      surfaces: [{ slot: 'workspace.primary', cardinality: 'single' }],
    }))
    expect(() => registry.register(feature('primary-conflict', {}, {
      surfaces: [{ slot: 'workspace.primary', cardinality: 'single' }],
    }))).toThrowError(expect.objectContaining({ code: 'duplicate-single-slot' }))
  })

  it('validates the product slot catalog itself', () => {
    expect(() => new FeatureRegistry(FEATURE_API_VERSION, null as unknown as []))
      .toThrowError(expect.objectContaining({ code: 'invalid-slot-catalog' }))
    expect(() => new FeatureRegistry(FEATURE_API_VERSION, [{
      id: ' bad ',
      cardinality: 'single',
      protection: 'public',
    }])).toThrowError(expect.objectContaining({ code: 'invalid-slot-catalog' }))
    expect(() => new FeatureRegistry(FEATURE_API_VERSION, [
      { id: 'same', cardinality: 'single', protection: 'public' },
      { id: 'same', cardinality: 'list', protection: 'public' },
    ])).toThrowError(expect.objectContaining({ code: 'duplicate-slot-definition' }))
  })

  it('returns an idempotent async lease and notifies current listeners only', async () => {
    const registry = new FeatureRegistry()
    const factory = feature('conversation')
    const calls: string[] = []
    const removeListener = registry.onUnregistered(async removed => {
      await Promise.resolve()
      calls.push(removed.manifest.id)
    })
    const lease = registry.register(factory)

    expect(lease.active).toBe(true)
    await lease.release()
    expect(lease.active).toBe(false)
    expect(registry.get('conversation')).toBeUndefined()
    expect(calls).toEqual(['conversation'])
    await lease.release()

    removeListener()
    const replacement = feature('conversation')
    const replacementLease = registry.register(replacement)
    await replacementLease.release()
    expect(calls).toEqual(['conversation'])
  })

  it('keeps registry instances isolated', async () => {
    const factory = feature('conversation')
    const left = new FeatureRegistry()
    const right = new FeatureRegistry()
    const leftLease = left.register(factory)
    right.register(factory)

    await leftLease.release()

    expect(left.get('conversation')).toBeUndefined()
    expect(right.get('conversation')).toBe(factory)
  })
})
