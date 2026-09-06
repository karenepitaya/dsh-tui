import { describe, expect, it, vi } from 'vitest'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import {
  createCapabilityToken,
  type CapabilityFactory,
  type CapabilityLease,
  type CapabilityScope,
  type CapabilityToken,
} from '../src/kernel/capability.ts'
import {
  CapabilityRegistry,
  CapabilityRegistryError,
  type CapabilityFactoryContext,
} from '../src/kernel/capability-registry.ts'

function capabilityFactory<TValue>(
  token: CapabilityToken<TValue>,
  create: (context: CapabilityFactoryContext) => CapabilityLease<TValue> | Promise<CapabilityLease<TValue>>,
): CapabilityFactory<TValue, CapabilityFactoryContext> {
  return { token, create }
}

describe('CapabilityRegistry', () => {
  it('rejects malformed factories deterministically', () => {
    const registry = new CapabilityRegistry()
    expect(() => registry.register(
      null as unknown as CapabilityFactory<unknown, CapabilityFactoryContext>,
    )).toThrowError(
      expect.objectContaining<Partial<CapabilityRegistryError>>({ code: 'invalid-factory' }),
    )
    expect(() => registry.register({
      token: createCapabilityToken('runtime.missing-create/v1', 'application'),
    } as unknown as CapabilityFactory<unknown, CapabilityFactoryContext>)).toThrowError(
      expect.objectContaining<Partial<CapabilityRegistryError>>({ code: 'invalid-factory' }),
    )
  })

  it('validates registrations, rejects duplicates, and keeps registries isolated', async () => {
    const token = createCapabilityToken<{ name: string }>('runtime.model/v1', 'application')
    const create = vi.fn(() => ({ value: { name: 'mimo' }, release: vi.fn() }))
    const factory = capabilityFactory(token, create)
    const left = new CapabilityRegistry()
    const right = new CapabilityRegistry()
    const leftRegistration = left.register(factory)
    right.register(factory)

    expect(left.size).toBe(1)
    expect(left.get(token.id)).toBe(factory)
    expect(() => left.register(factory)).toThrowError(
      expect.objectContaining<Partial<CapabilityRegistryError>>({ code: 'duplicate-token' }),
    )
    expect(() => left.register(capabilityFactory({
      id: 'runtime.model' as `${string}/v${number}`,
      scope: 'application',
    }, create))).toThrowError(expect.objectContaining({ code: 'invalid-token' }))
    expect(() => left.register(capabilityFactory({
      id: 'runtime.other/v1',
      scope: 'request' as CapabilityScope,
    }, create))).toThrowError(expect.objectContaining({ code: 'invalid-token' }))

    expect(leftRegistration.active).toBe(true)
    await leftRegistration.release()
    await leftRegistration.release()
    expect(leftRegistration.active).toBe(false)
    expect(left.get(token.id)).toBeUndefined()
    expect(right.get(token.id)).toBe(factory)
  })

  it('rejects malformed acquisition tokens before consulting registered factories', async () => {
    const registry = new CapabilityRegistry()
    const manager = new ScopeManager()

    await expect(registry.acquire(
      null as unknown as CapabilityToken<unknown>,
      manager.app,
    )).rejects.toMatchObject({ code: 'invalid-token' })
    await expect(registry.acquire({
      id: 'runtime.invalid' as `${string}/v${number}`,
      scope: 'application',
    }, manager.app)).rejects.toMatchObject({ code: 'invalid-token' })

    await manager.dispose()
  })

  it('deduplicates concurrent and repeated acquisition within one scope', async () => {
    const token = createCapabilityToken<{ name: string }>('runtime.model/v1', 'application')
    const providerRelease = vi.fn()
    const create = vi.fn(() => ({ value: { name: 'mimo' }, release: providerRelease }))
    const registry = new CapabilityRegistry()
    registry.register(capabilityFactory(token, create))
    const manager = new ScopeManager()

    const [first, second] = await Promise.all([
      registry.acquire(token, manager.app),
      registry.resolve(token, manager.app),
    ])
    expect(create).toHaveBeenCalledTimes(1)
    expect(first.value).toBe(second.value)
    await first.release()
    await first.release()
    await second.release()

    const reacquired = await registry.acquire(token, manager.app)
    expect(create).toHaveBeenCalledTimes(1)
    expect(reacquired.value).toEqual({ name: 'mimo' })
    await manager.dispose('test complete')

    expect(providerRelease).toHaveBeenCalledTimes(1)
    expect(() => reacquired.value).toThrowError(
      expect.objectContaining<Partial<CapabilityRegistryError>>({ code: 'capability-unavailable' }),
    )
  })

  it('creates one session value per session and rejects scope mismatches', async () => {
    const sessionToken = createCapabilityToken<{ epoch: number }>('runtime.session/v1', 'session')
    const appToken = createCapabilityToken<{ epoch: number }>('runtime.app/v1', 'application')
    let epoch = 0
    const registry = new CapabilityRegistry()
    registry.register(capabilityFactory(sessionToken, () => ({
      value: { epoch: ++epoch },
      release: vi.fn(),
    })))
    registry.register(capabilityFactory(appToken, () => ({
      value: { epoch: ++epoch },
      release: vi.fn(),
    })))
    const manager = new ScopeManager()
    const firstSession = manager.createSession('first')
    const secondSession = manager.createSession('second')

    const first = await registry.acquire(sessionToken, firstSession)
    const firstAgain = await registry.acquire(sessionToken, firstSession)
    const second = await registry.acquire(sessionToken, secondSession)
    expect(first.value).toBe(firstAgain.value)
    expect(second.value).not.toBe(first.value)
    await expect(registry.acquire(sessionToken, manager.app)).rejects.toMatchObject({
      code: 'scope-mismatch',
    })
    await expect(registry.acquire(appToken, firstSession)).rejects.toMatchObject({
      code: 'scope-mismatch',
    })
    await firstSession.dispose()
    await expect(registry.acquire(sessionToken, firstSession)).rejects.toMatchObject({
      code: 'scope-mismatch',
    })
    await manager.dispose()
  })

  it('rejects an aborted session scope before its deferred disposal reaches the capability', async () => {
    const token = createCapabilityToken<{ ready: true }>('runtime.aborted/v1', 'session')
    const create = vi.fn(() => ({ value: { ready: true }, release: vi.fn() }))
    const registry = new CapabilityRegistry()
    registry.register(capabilityFactory(token, create))
    const manager = new ScopeManager()
    const session = manager.createSession('aborting')
    let unblock!: () => void
    manager.app.defer(() => new Promise<void>(resolve => {
      unblock = resolve
    }))

    const disposing = manager.dispose()
    expect(session.signal.aborted).toBe(true)
    expect(session.disposed).toBe(false)
    await expect(registry.acquire(token, session)).rejects.toMatchObject({
      code: 'scope-mismatch',
    })
    expect(create).not.toHaveBeenCalled()

    unblock()
    await disposing
  })

  it('invalidates all owned instances when a factory is unregistered', async () => {
    const token = createCapabilityToken<{ session: string }>('runtime.session/v1', 'session')
    const releases: string[] = []
    const registry = new CapabilityRegistry()
    const registration = registry.register(capabilityFactory(token, ({ scope }) => ({
      value: { session: scope.label },
      release: () => {
        releases.push(scope.label)
      },
    })))
    const manager = new ScopeManager()
    const firstScope = manager.createSession('first')
    const secondScope = manager.createSession('second')
    const first = await registry.acquire(token, firstScope)
    const second = await registry.acquire(token, secondScope)

    await registration.release()

    expect(releases).toEqual(['first', 'second'])
    expect(() => first.value).toThrowError(expect.objectContaining({ code: 'capability-unavailable' }))
    expect(() => second.value).toThrowError(expect.objectContaining({ code: 'capability-unavailable' }))
    await expect(registry.acquire(token, firstScope)).rejects.toMatchObject({
      code: 'unregistered-token',
    })
    await first.release()
    await second.release()
    await manager.dispose()
  })

  it('signals provider invalidation without treating consumer release as invalidation', async () => {
    const token = createCapabilityToken<{ ready: true }>('runtime.signal/v1', 'application')
    const registry = new CapabilityRegistry()
    const registration = registry.register(capabilityFactory(token, () => ({
      value: { ready: true },
      release: vi.fn(),
    })))
    const manager = new ScopeManager()
    const first = await registry.acquire(token, manager.app)
    let invalidations = 0
    void Promise.resolve(first.invalidated).then(() => {
      invalidations += 1
    })

    await first.release()
    await Promise.resolve()
    expect(invalidations).toBe(0)

    const second = await registry.acquire(token, manager.app)
    void Promise.resolve(second.invalidated).then(() => {
      invalidations += 1
    })
    await registration.release()
    await Promise.resolve()

    expect(invalidations).toBe(2)
    expect(() => second.value).toThrowError(
      expect.objectContaining<Partial<CapabilityRegistryError>>({ code: 'capability-unavailable' }),
    )
    await manager.dispose()
  })

  it('invalidates an in-flight creation when its factory is unregistered', async () => {
    const token = createCapabilityToken<{ ready: true }>('runtime.slow/v1', 'application')
    let finish!: (lease: CapabilityLease<{ ready: true }>) => void
    const task = new Promise<CapabilityLease<{ ready: true }>>(resolve => {
      finish = resolve
    })
    const providerRelease = vi.fn()
    const registry = new CapabilityRegistry()
    const registration = registry.register(capabilityFactory(token, () => task))
    const manager = new ScopeManager()

    const acquiring = registry.acquire(token, manager.app)
    const unregistering = registration.release()
    finish({ value: { ready: true }, release: providerRelease })

    await expect(acquiring).rejects.toMatchObject({ code: 'capability-unavailable' })
    await unregistering
    expect(providerRelease).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })

  it('contains an in-flight creation failure while its factory is unregistered', async () => {
    const token = createCapabilityToken<{ ready: true }>(
      'runtime.slow-failure/v1',
      'application',
    )
    let fail!: (error: Error) => void
    const task = new Promise<CapabilityLease<{ ready: true }>>((_resolve, reject) => {
      fail = reject
    })
    const registry = new CapabilityRegistry()
    const registration = registry.register(capabilityFactory(token, () => task))
    const manager = new ScopeManager()

    const acquiring = registry.acquire(token, manager.app)
    const unregistering = registration.release()
    fail(new Error('late create failure'))

    await expect(acquiring).rejects.toMatchObject({ code: 'capability-unavailable' })
    await expect(unregistering).resolves.toBeUndefined()
    await manager.dispose()
  })

  it('contains factory creation failure and a scope disposed during creation', async () => {
    const failingToken = createCapabilityToken<{ ready: true }>('runtime.failure/v1', 'application')
    const failingRegistry = new CapabilityRegistry()
    const create = vi.fn(() => {
      throw new Error('create failed')
    })
    failingRegistry.register(capabilityFactory(failingToken, create))
    const manager = new ScopeManager()

    await expect(failingRegistry.acquire(failingToken, manager.app)).rejects.toMatchObject({
      code: 'capability-unavailable',
      cause: expect.objectContaining({ message: 'create failed' }),
    })
    await expect(failingRegistry.acquire(failingToken, manager.app)).rejects.toMatchObject({
      code: 'capability-unavailable',
    })
    expect(create).toHaveBeenCalledTimes(2)

    const slowToken = createCapabilityToken<{ ready: true }>('runtime.disposed/v1', 'session')
    let finish!: (lease: CapabilityLease<{ ready: true }>) => void
    const slowTask = new Promise<CapabilityLease<{ ready: true }>>(resolve => {
      finish = resolve
    })
    const providerRelease = vi.fn()
    const slowRegistry = new CapabilityRegistry()
    slowRegistry.register(capabilityFactory(slowToken, () => slowTask))
    const session = manager.createSession('closing')
    const acquiring = slowRegistry.acquire(slowToken, session)
    await session.dispose()
    finish({ value: { ready: true }, release: providerRelease })

    await expect(acquiring).rejects.toMatchObject({ code: 'capability-unavailable' })
    expect(providerRelease).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })

  it('keeps unrelated scope entries while failures and unregisters remove only their token', async () => {
    const stable = createCapabilityToken<{ stable: true }>('runtime.stable/v1', 'application')
    const failing = createCapabilityToken<{ ready: true }>('runtime.failed-neighbor/v1', 'application')
    const unused = createCapabilityToken<{ ready: true }>('runtime.unused/v1', 'application')
    const retired = createCapabilityToken<{ ready: true }>('runtime.retired/v1', 'application')
    const stableRelease = vi.fn()
    const retiredRelease = vi.fn()
    const registry = new CapabilityRegistry()
    registry.register(capabilityFactory(stable, () => ({
      value: { stable: true },
      release: stableRelease,
    })))
    registry.register(capabilityFactory(failing, () => {
      throw new Error('neighbor failed')
    }))
    const unusedRegistration = registry.register(capabilityFactory(unused, () => ({
      value: { ready: true },
      release: vi.fn(),
    })))
    const retiredRegistration = registry.register(capabilityFactory(retired, () => ({
      value: { ready: true },
      release: retiredRelease,
    })))
    const manager = new ScopeManager()

    const stableLease = await registry.acquire(stable, manager.app)
    await expect(registry.acquire(failing, manager.app)).rejects.toMatchObject({
      code: 'capability-unavailable',
    })
    await unusedRegistration.release()
    await registry.acquire(retired, manager.app)
    await retiredRegistration.release()

    expect(stableLease.value).toEqual({ stable: true })
    expect(retiredRelease).toHaveBeenCalledTimes(1)
    await manager.dispose()
    expect(stableRelease).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a factory returns a malformed provider lease', async () => {
    const missingValue = createCapabilityToken<undefined>(
      'runtime.missing-value/v1',
      'application',
    )
    const missingRelease = createCapabilityToken<{ ready: true }>(
      'runtime.missing-release/v1',
      'application',
    )
    const partialRelease = vi.fn()
    const failingPartialRelease = vi.fn(() => {
      throw new Error('partial cleanup failed')
    })
    const failingCleanup = createCapabilityToken<undefined>(
      'runtime.failing-invalid-cleanup/v1',
      'application',
    )
    const registry = new CapabilityRegistry()
    registry.register(capabilityFactory(missingValue, () => ({
      release: partialRelease,
    } as unknown as CapabilityLease<undefined>)))
    registry.register(capabilityFactory(missingRelease, () => ({
      value: { ready: true },
    } as unknown as CapabilityLease<{ ready: true }>)))
    registry.register(capabilityFactory(failingCleanup, () => ({
      release: failingPartialRelease,
    } as unknown as CapabilityLease<undefined>)))
    const manager = new ScopeManager()

    await expect(registry.acquire(missingValue, manager.app)).rejects.toMatchObject({
      code: 'capability-unavailable',
      cause: expect.objectContaining({ message: 'Capability factory returned an invalid lease' }),
    })
    await expect(registry.acquire(missingRelease, manager.app)).rejects.toMatchObject({
      code: 'capability-unavailable',
      cause: expect.objectContaining({ message: 'Capability factory returned an invalid lease' }),
    })
    expect(partialRelease).toHaveBeenCalledTimes(1)
    await expect(registry.acquire(failingCleanup, manager.app)).rejects.toMatchObject({
      code: 'capability-unavailable',
      cause: expect.objectContaining({ message: 'Invalid capability lease cleanup failed' }),
    })
    expect(failingPartialRelease).toHaveBeenCalledTimes(1)

    await manager.dispose()
  })
})
