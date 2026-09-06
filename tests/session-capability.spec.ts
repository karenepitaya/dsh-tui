import { describe, expect, it, vi } from 'vitest'
import {
  createCapabilityToken,
  type CapabilityLease,
  type CapabilityToken,
} from '../src/kernel/capability.ts'
import { CapabilityRegistryError } from '../src/kernel/capability-registry.ts'
import { ResourceScope, ScopeManager } from '../src/lifecycle/scope-manager.ts'
import type { CoreSessionPort } from '../src/runtime/core-session-port.ts'
import {
  SessionCapabilityFactoryRegistry,
  composeSessionCapabilityLease,
  type SessionCapabilityFactory,
  type SessionCapabilityFactoryContext,
} from '../src/runtime/session-capability.ts'

interface CoreHarness {
  readonly port: CoreSessionPort
  readonly dispose: ReturnType<typeof vi.fn>
}

function core(
  sessionId: string,
  onDispose: () => void | Promise<void> = () => {},
): CoreHarness {
  const dispose = vi.fn(async () => { await onDispose() })
  return {
    port: { sessionId, dispose } as unknown as CoreSessionPort,
    dispose,
  }
}

function factory<TValue>(
  token: CapabilityToken<TValue>,
  create: (
    context: SessionCapabilityFactoryContext,
  ) => CapabilityLease<TValue> | Promise<CapabilityLease<TValue>>,
): SessionCapabilityFactory<TValue> {
  return { token, create }
}

describe('Session capability lease composer', () => {
  it('binds the exact core, delegates same-session singleton caching, and owns teardown', async () => {
    const manager = new ScopeManager()
    const scope = manager.createSession('session-a')
    const bound = core('session-a')
    const token = createCapabilityToken<{ readonly id: string }>(
      'session.model/v1',
      'session',
    )
    const order: string[] = []
    const providerRelease = vi.fn(() => { order.push('provider') })
    const create = vi.fn((context: SessionCapabilityFactoryContext) => ({
      value: { id: `${context.core.sessionId}:${context.scope.epoch}` },
      release: providerRelease,
    }))
    const lease = composeSessionCapabilityLease({
      core: bound.port,
      scope,
      factories: [factory(token, create)],
    })

    const [first, second] = await Promise.all([
      lease.acquire(token),
      lease.acquire(token),
    ])

    expect(Object.isFrozen(lease)).toBe(true)
    expect(lease.core).toBe(bound.port)
    expect(lease.scope).toBe(scope)
    expect(create).toHaveBeenCalledExactlyOnceWith({ core: bound.port, scope })
    expect(first.value).toBe(second.value)
    await first.release()
    await first.release()
    await second.release()
    expect(providerRelease).not.toHaveBeenCalled()

    const release = lease.release('session complete')
    expect(lease.release()).toBe(release)
    await release
    expect(scope.disposed).toBe(true)
    expect(scope.signal.reason).toBe('session complete')
    expect(providerRelease).toHaveBeenCalledOnce()
    expect(bound.dispose).toHaveBeenCalledOnce()
    expect(() => first.value).toThrowError(
      expect.objectContaining<Partial<CapabilityRegistryError>>({
        code: 'capability-unavailable',
      }),
    )
    await expect(lease.acquire(token)).rejects.toMatchObject({ code: 'scope-mismatch' })
    await manager.dispose()
  })

  it('isolates equal durable ids across different exact core and scope objects', async () => {
    const manager = new ScopeManager()
    const firstScope = manager.createSession('first-epoch')
    const secondScope = manager.createSession('second-epoch')
    const firstCore = core('same-session')
    const secondCore = core('same-session')
    const token = createCapabilityToken<{ readonly core: CoreSessionPort }>(
      'session.context/v1',
      'session',
    )
    const shared = factory(token, ({ core: exactCore }) => ({
      value: { core: exactCore },
      release: () => {},
    }))
    const first = composeSessionCapabilityLease({
      core: firstCore.port,
      scope: firstScope,
      factories: [shared],
    })
    const second = composeSessionCapabilityLease({
      core: secondCore.port,
      scope: secondScope,
      factories: [shared],
    })

    const firstCapability = await first.acquire(token)
    const secondCapability = await second.acquire(token)

    expect(firstCapability.value.core).toBe(firstCore.port)
    expect(secondCapability.value.core).toBe(secondCore.port)
    expect(firstCapability.value).not.toBe(secondCapability.value)
    await Promise.all([first.release(), second.release()])
    await manager.dispose()
  })

  it('rejects invalid scope and factory tokens before taking core ownership', async () => {
    const manager = new ScopeManager()
    const validToken = createCapabilityToken('session.valid/v1', 'session')
    const valid = factory(validToken, () => ({ value: undefined, release: () => {} }))
    const appBound = core('app')
    expect(() => composeSessionCapabilityLease({
      core: appBound.port,
      scope: manager.app,
      factories: [valid],
    })).toThrowError(expect.objectContaining<Partial<CapabilityRegistryError>>({
      code: 'scope-mismatch',
    }))
    expect(appBound.dispose).not.toHaveBeenCalled()

    const scope = manager.createSession('session-a')
    const bound = core('session-a')
    const appToken = createCapabilityToken('application.invalid/v1', 'application')
    expect(() => composeSessionCapabilityLease({
      core: bound.port,
      scope,
      factories: [factory(appToken, () => ({ value: undefined, release: () => {} }))],
    })).toThrowError(expect.objectContaining<Partial<CapabilityRegistryError>>({
      code: 'scope-mismatch',
    }))
    expect(() => composeSessionCapabilityLease({
      core: bound.port,
      scope,
      factories: [valid, valid],
    })).toThrowError(expect.objectContaining<Partial<CapabilityRegistryError>>({
      code: 'duplicate-token',
    }))
    expect(() => composeSessionCapabilityLease({
      core: bound.port,
      scope,
      factories: [{ token: { id: 'invalid', scope: 'session' }, create: vi.fn() } as never],
    })).toThrowError(expect.objectContaining<Partial<CapabilityRegistryError>>({
      code: 'invalid-token',
    }))
    expect(() => composeSessionCapabilityLease({
      core: bound.port,
      scope,
      factories: [null as never],
    })).toThrowError(expect.objectContaining<Partial<CapabilityRegistryError>>({
      code: 'invalid-factory',
    }))
    expect(bound.dispose).not.toHaveBeenCalled()

    const lease = composeSessionCapabilityLease({
      core: bound.port,
      scope,
      factories: [valid],
    })
    await expect(lease.acquire(appToken)).rejects.toMatchObject({ code: 'scope-mismatch' })
    await expect(lease.acquire(
      createCapabilityToken('session.missing/v1', 'session'),
    )).rejects.toMatchObject({ code: 'unregistered-token' })
    await expect(lease.acquire({
      id: 'invalid' as `${string}/v${number}`,
      scope: 'session',
    })).rejects.toMatchObject({ code: 'invalid-token' })
    await lease.release()

    const disposedScope = manager.createSession('disposed')
    await disposedScope.dispose()
    const disposedCore = core('disposed')
    expect(() => composeSessionCapabilityLease({
      core: disposedCore.port,
      scope: disposedScope,
      factories: [],
    })).toThrowError(expect.objectContaining<Partial<CapabilityRegistryError>>({
      code: 'scope-mismatch',
    }))
    expect(disposedCore.dispose).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('releases providers before core in reverse acquisition order with exact AggregateError order', async () => {
    const manager = new ScopeManager()
    const scope = manager.createSession('session-a')
    const order: string[] = []
    const firstFailure = new Error('first release failed')
    const thirdFailure = new Error('third release failed')
    const coreFailure = new Error('core release failed')
    const bound = core('session-a', () => {
      order.push('core')
      throw coreFailure
    })
    const firstToken = createCapabilityToken('session.first/v1', 'session')
    const secondToken = createCapabilityToken('session.second/v1', 'session')
    const thirdToken = createCapabilityToken('session.third/v1', 'session')
    const unusedToken = createCapabilityToken('session.unused/v1', 'session')
    const make = (
      token: CapabilityToken<unknown>,
      release: () => void,
    ): SessionCapabilityFactory<unknown> => factory(token, () => ({
      value: token.id,
      release,
    }))
    const lease = composeSessionCapabilityLease({
      core: bound.port,
      scope,
      factories: [
        make(firstToken, () => {
          order.push('first')
          throw firstFailure
        }),
        make(secondToken, () => { order.push('second') }),
        make(thirdToken, () => {
          order.push('third')
          throw thirdFailure
        }),
        make(unusedToken, () => { order.push('unused') }),
      ],
    })
    await lease.acquire(firstToken)
    await lease.acquire(thirdToken)
    await lease.acquire(secondToken)

    const failure = await lease.release().catch((error: unknown) => error)

    expect(order).toEqual(['second', 'third', 'first', 'core'])
    expect(failure).toEqual(expect.objectContaining({
      name: 'AggregateError',
      message: 'session scope disposal failed',
    }))
    expect((failure as AggregateError).errors).toEqual([
      thirdFailure,
      firstFailure,
      coreFailure,
    ])
    await manager.dispose().catch(() => {})
  })

  it('contains an in-flight factory during release and cleans its late provider before core', async () => {
    const manager = new ScopeManager()
    const scope = manager.createSession('session-a')
    const order: string[] = []
    const bound = core('session-a', () => { order.push('core') })
    const token = createCapabilityToken<{ readonly ready: true }>(
      'session.slow/v1',
      'session',
    )
    let finish!: (lease: CapabilityLease<{ readonly ready: true }>) => void
    const pending = new Promise<CapabilityLease<{ readonly ready: true }>>(resolve => {
      finish = resolve
    })
    const lease = composeSessionCapabilityLease({
      core: bound.port,
      scope,
      factories: [factory(token, () => pending)],
    })

    const acquiring = lease.acquire(token)
    const releasing = lease.release()
    finish({
      value: { ready: true },
      release: () => { order.push('provider') },
    })

    await expect(acquiring).rejects.toMatchObject({ code: 'capability-unavailable' })
    await releasing
    expect(order).toEqual(['provider', 'core'])
    expect(lease.release()).toBe(releasing)
    await manager.dispose()
  })

  it('aggregates a late provider failure through binding-owned teardown', async () => {
    const manager = new ScopeManager()
    const scope = manager.createSession('late-release-failure')
    const deferToScope = scope.defer.bind(scope)
    let deferCalls = 0
    scope.defer = ((disposer) => {
      deferCalls += 1
      if (deferCalls !== 4) return deferToScope(disposer)
      let releaseTask: Promise<void> | undefined
      return () => {
        releaseTask ??= Promise.resolve().then(disposer)
        return releaseTask
      }
    }) as ResourceScope['defer']
    const bound = core('late-release-failure')
    const token = createCapabilityToken('session.late-release-failure/v1', 'session')
    const releaseFailure = new Error('late provider release failed')
    const providerRelease = vi.fn(() => { throw releaseFailure })
    const lease = composeSessionCapabilityLease({
      core: bound.port,
      scope,
      factories: [factory(token, () => ({
        value: undefined,
        release: providerRelease,
      }))],
    })

    await lease.acquire(token)
    const releasing = lease.release()

    const failure = await releasing.catch((error: unknown) => error)
    expect(providerRelease).toHaveBeenCalledOnce()
    expect(failure).toMatchObject({
      name: 'AggregateError',
      message: 'session scope disposal failed',
    })
    expect((failure as AggregateError).errors).toContainEqual(expect.objectContaining({
      name: 'AggregateError',
      message: 'Session capability binding disposal failed',
      errors: [releaseFailure],
    }))
    await manager.dispose().catch(() => {})
  })
})

describe('SessionCapabilityFactoryRegistry', () => {
  it('makes a later provider visible to an already-bound session and retires it deterministically', async () => {
    const manager = new ScopeManager()
    const registry = new SessionCapabilityFactoryRegistry(manager.app)
    const scope = manager.createSession('session-a')
    const bound = core('session-a')
    const token = createCapabilityToken<{ readonly generation: number }>(
      'session.dynamic/v1',
      'session',
    )
    const binding = registry.bind(bound.port, scope)

    await expect(binding.acquire(token)).rejects.toMatchObject({ code: 'unregistered-token' })

    const providerRelease = vi.fn()
    const create = vi.fn((context: SessionCapabilityFactoryContext) => ({
      value: { generation: context.scope.epoch },
      release: providerRelease,
    }))
    const registration = registry.register(factory(token, create), {
      ownerId: 'feature.models',
      generation: 7,
    })
    const [first, second] = await Promise.all([
      binding.acquire(token),
      binding.acquire(token),
    ])

    expect(registry.size).toBe(1)
    expect(registration.tokenId).toBe(token.id)
    expect(registration.provenance).toEqual({
      ownerId: 'feature.models',
      generation: 7,
    })
    expect(Object.isFrozen(registration.provenance)).toBe(true)
    expect(create).toHaveBeenCalledExactlyOnceWith({ core: bound.port, scope })
    expect(first.value).toBe(second.value)

    let invalidations = 0
    void Promise.resolve(first.invalidated).then(() => { invalidations += 1 })
    const retiring = registration.release()
    expect(registration.active).toBe(false)
    await retiring
    await Promise.resolve()

    expect(registry.size).toBe(0)
    expect(invalidations).toBe(1)
    expect(providerRelease).toHaveBeenCalledOnce()
    expect(() => first.value).toThrowError(expect.objectContaining({
      code: 'capability-unavailable',
    }))
    await expect(binding.acquire(token)).rejects.toMatchObject({
      code: 'capability-unavailable',
    })
    await first.release()
    await second.release()
    await binding.release()
    await manager.dispose()
  })

  it('keeps a new generation installed while the old generation releases slowly', async () => {
    const manager = new ScopeManager()
    const registry = new SessionCapabilityFactoryRegistry(manager.app)
    const scope = manager.createSession('session-a')
    const binding = registry.bind(core('session-a').port, scope)
    const token = createCapabilityToken<{ readonly generation: number }>(
      'session.generation/v1',
      'session',
    )
    let finishOldRelease!: () => void
    const oldReleaseGate = new Promise<void>(resolve => { finishOldRelease = resolve })
    const oldRelease = vi.fn(() => oldReleaseGate)
    const oldRegistration = registry.register(factory(token, () => ({
      value: { generation: 1 },
      release: oldRelease,
    })), { ownerId: 'feature.tools', generation: 1 })
    const oldLease = await binding.acquire(token)

    const retiringOld = oldRegistration.release()
    const newRelease = vi.fn()
    const newRegistration = registry.register(factory(token, () => ({
      value: { generation: 2 },
      release: newRelease,
    })), { ownerId: 'feature.tools', generation: 2 })
    const newLease = await binding.acquire(token)

    expect(oldRelease).toHaveBeenCalledOnce()
    expect(newLease.value).toEqual({ generation: 2 })
    expect(() => oldLease.value).toThrowError(expect.objectContaining({
      code: 'capability-unavailable',
    }))

    finishOldRelease()
    await retiringOld
    expect(newRegistration.active).toBe(true)
    expect((await binding.acquire(token)).value).toBe(newLease.value)
    expect(newRelease).not.toHaveBeenCalled()

    await newRegistration.release()
    expect(newRelease).toHaveBeenCalledOnce()
    await binding.release()
    await manager.dispose()
  })

  it('keeps an old generation retirement app-owned after its registration is gone', async () => {
    const manager = new ScopeManager()
    const registry = new SessionCapabilityFactoryRegistry(manager.app)
    const scope = manager.createSession('session-a')
    const binding = registry.bind(core('session-a').port, scope)
    const token = createCapabilityToken('session.pending-retirement/v1', 'session')
    let finishRelease!: () => void
    const releaseGate = new Promise<void>(resolve => { finishRelease = resolve })
    const registration = registry.register(factory(token, () => ({
      value: undefined,
      release: () => releaseGate,
    })), { ownerId: 'feature.pending', generation: 1 })
    await binding.acquire(token)

    const retiring = registration.release()
    const disposing = registry.dispose()
    let disposed = false
    void disposing.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    finishRelease()
    await Promise.all([retiring, disposing])
    expect(disposed).toBe(true)
    await binding.release()
    await manager.dispose()
  })

  it('reports a failing pending retirement when registry disposal joins it', async () => {
    const manager = new ScopeManager()
    const registry = new SessionCapabilityFactoryRegistry(manager.app)
    const scope = manager.createSession('pending-retirement-failure')
    const binding = registry.bind(core('pending-retirement-failure').port, scope)
    const token = createCapabilityToken('session.pending-retirement-failure/v1', 'session')
    const releaseFailure = new Error('pending retirement failed')
    const releaseGate = Promise.withResolvers<void>()
    const registration = registry.register(factory(token, () => ({
      value: undefined,
      release: async () => {
        await releaseGate.promise
        throw releaseFailure
      },
    })), { ownerId: 'feature.pending-failure', generation: 1 })
    await binding.acquire(token)

    const retiring = registration.release()
    const disposing = registry.dispose()
    releaseGate.resolve()

    await expect(retiring).rejects.toMatchObject({
      name: 'AggregateError',
      message: `Session capability "${token.id}" retirement failed`,
    })
    await expect(disposing).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Session capability registry disposal failed',
    })
    await binding.release()
    await manager.dispose().catch(() => {})
  })

  it('never publishes a provider whose create finishes after its binding starts releasing', async () => {
    const manager = new ScopeManager()
    const registry = new SessionCapabilityFactoryRegistry(manager.app)
    const scope = manager.createSession('session-a')
    const order: string[] = []
    const bound = core('session-a', () => { order.push('core') })
    const binding = registry.bind(bound.port, scope)
    const token = createCapabilityToken<{ readonly ready: true }>(
      'session.late/v1',
      'session',
    )
    let finish!: (lease: CapabilityLease<{ readonly ready: true }>) => void
    const pending = new Promise<CapabilityLease<{ readonly ready: true }>>(resolve => {
      finish = resolve
    })
    registry.register(factory(token, () => pending), {
      ownerId: 'feature.skills',
      generation: 1,
    })

    const acquiring = binding.acquire(token)
    const releasing = binding.release('session switched')
    expect(scope.signal.aborted).toBe(true)
    finish({
      value: { ready: true },
      release: () => { order.push('provider') },
    })

    await expect(acquiring).rejects.toMatchObject({ code: 'capability-unavailable' })
    await releasing
    expect(order).toEqual(['provider', 'core'])
    await expect(binding.acquire(token)).rejects.toMatchObject({ code: 'scope-mismatch' })
    await manager.dispose()
  })

  it('releases acquired providers in reverse order before the core', async () => {
    const manager = new ScopeManager()
    const registry = new SessionCapabilityFactoryRegistry(manager.app)
    const scope = manager.createSession('session-a')
    const order: string[] = []
    const binding = registry.bind(core('session-a', () => { order.push('core') }).port, scope)
    const first = createCapabilityToken('session.dynamic-first/v1', 'session')
    const second = createCapabilityToken('session.dynamic-second/v1', 'session')
    const third = createCapabilityToken('session.dynamic-third/v1', 'session')
    for (const [index, token] of [first, second, third].entries()) {
      registry.register(factory(token, () => ({
        value: token.id,
        release: () => { order.push(token.id) },
      })), { ownerId: 'feature.catalogs', generation: index + 1 })
    }

    await binding.acquire(first)
    await binding.acquire(third)
    await binding.acquire(second)
    await binding.release()

    expect(order).toEqual([
      second.id,
      third.id,
      first.id,
      'core',
    ])
    await manager.dispose()
  })

  it('finishes each reverse provider retirement before starting the previous one', async () => {
    const manager = new ScopeManager()
    const registry = new SessionCapabilityFactoryRegistry(manager.app)
    const scope = manager.createSession('session-a')
    const binding = registry.bind(core('session-a').port, scope)
    const first = createCapabilityToken('session.serial-first/v1', 'session')
    const second = createCapabilityToken('session.serial-second/v1', 'session')
    const secondStarted = Promise.withResolvers<void>()
    const secondRelease = Promise.withResolvers<void>()
    const order: string[] = []
    registry.register(factory(first, () => ({
      value: undefined,
      release: () => { order.push('first') },
    })), { ownerId: 'feature.serial', generation: 1 })
    registry.register(factory(second, () => ({
      value: undefined,
      release: async () => {
        order.push('second:start')
        secondStarted.resolve()
        await secondRelease.promise
        order.push('second:end')
      },
    })), { ownerId: 'feature.serial', generation: 2 })
    await binding.acquire(first)
    await binding.acquire(second)

    const disposing = registry.dispose()
    await secondStarted.promise
    expect(order).toEqual(['second:start'])

    secondRelease.resolve()
    await disposing
    expect(order).toEqual(['second:start', 'second:end', 'first'])
    await binding.release()
    await manager.dispose()
  })

  it('isolates bindings, snapshots mutable factories, and validates app ownership', async () => {
    const manager = new ScopeManager()
    const foreignManager = new ScopeManager('foreign')
    const registry = new SessionCapabilityFactoryRegistry(manager.app)
    const firstScope = manager.createSession('first')
    const secondScope = manager.createSession('second')
    const firstCore = core('first')
    const secondCore = core('second')
    const firstBinding = registry.bind(firstCore.port, firstScope)
    const secondBinding = registry.bind(secondCore.port, secondScope)
    const token = createCapabilityToken<{ readonly sessionId: string }>(
      'session.snapshot/v1',
      'session',
    )
    const mutable = factory(token, ({ core: exactCore }) => ({
      value: { sessionId: exactCore.sessionId },
      release: () => {},
    }))
    const registration = registry.register(mutable, {
      ownerId: 'feature.snapshot',
      generation: 1,
    })
    ;(mutable as { create: SessionCapabilityFactory<{ readonly sessionId: string }>['create'] }).create = () => ({
      value: { sessionId: 'mutated' },
      release: () => {},
    })
    ;(mutable as { token: CapabilityToken<{ readonly sessionId: string }> }).token =
      createCapabilityToken('session.mutated/v1', 'session')

    expect((await firstBinding.acquire(token)).value).toEqual({ sessionId: 'first' })
    expect((await secondBinding.acquire(token)).value).toEqual({ sessionId: 'second' })
    await expect(firstBinding.acquire(
      createCapabilityToken('session.mutated/v1', 'session'),
    )).rejects.toMatchObject({ code: 'unregistered-token' })

    const foreignScope = foreignManager.createSession('foreign')
    expect(() => registry.bind(core('foreign').port, foreignScope)).toThrowError(
      expect.objectContaining({ code: 'scope-mismatch' }),
    )

    await registration.release()
    await Promise.all([firstBinding.release(), secondBinding.release()])
    await Promise.all([manager.dispose(), foreignManager.dispose()])
  })

  it('rejects invalid factories and provenance without taking ownership', async () => {
    const manager = new ScopeManager()
    const registry = new SessionCapabilityFactoryRegistry(manager.app)
    const token = createCapabilityToken('session.valid-registration/v1', 'session')
    const valid = factory(token, () => ({ value: undefined, release: () => {} }))

    expect(() => new SessionCapabilityFactoryRegistry(manager.createSession('not-app')))
      .toThrowError(expect.objectContaining({ code: 'scope-mismatch' }))
    expect(() => registry.register(
      factory(createCapabilityToken('application.invalid-registration/v1', 'application'), () => ({
        value: undefined,
        release: () => {},
      })),
      { ownerId: 'feature.invalid', generation: 1 },
    )).toThrowError(expect.objectContaining({ code: 'scope-mismatch' }))

    const malformedProvenance = [
      null,
      1,
      { ownerId: 1, generation: 1 },
      { ownerId: '', generation: 1 },
      { ownerId: ' padded ', generation: 1 },
      { ownerId: 'feature.invalid', generation: 1.5 },
      { ownerId: 'feature.invalid', generation: 0 },
    ]
    for (const provenance of malformedProvenance) {
      expect(() => registry.register(valid, provenance as never)).toThrowError(
        expect.objectContaining({ code: 'invalid-provenance' }),
      )
    }

    const registered = registry.register(valid, {
      ownerId: 'feature.valid',
      generation: 1,
    })
    expect(() => registry.register(valid, {
      ownerId: 'feature.duplicate',
      generation: 2,
    })).toThrowError(expect.objectContaining({ code: 'duplicate-token' }))
    const firstRelease = registered.release()
    expect(registered.release()).toBe(firstRelease)
    await firstRelease
    await registry.dispose()
    await manager.dispose()
  })

  it('waits for binding retirement errors, aggregates them, and remains idempotent', async () => {
    const manager = new ScopeManager()
    const registry = new SessionCapabilityFactoryRegistry(manager.app)
    const scope = manager.createSession('session-a')
    const binding = registry.bind(core('session-a').port, scope)
    const firstFailure = new Error('first provider failed to release')
    const secondFailure = new Error('second provider failed to release')
    const first = createCapabilityToken('session.dispose-first/v1', 'session')
    const second = createCapabilityToken('session.dispose-second/v1', 'session')
    registry.register(factory(first, () => ({
      value: undefined,
      release: () => { throw firstFailure },
    })), { ownerId: 'feature.failure', generation: 1 })
    registry.register(factory(second, () => ({
      value: undefined,
      release: () => { throw secondFailure },
    })), { ownerId: 'feature.failure', generation: 2 })
    await binding.acquire(first)
    await binding.acquire(second)

    const disposing = registry.dispose()
    expect(registry.dispose()).toBe(disposing)
    const failure = await disposing.catch((error: unknown) => error)
    expect(failure).toEqual(expect.objectContaining({
      name: 'AggregateError',
      message: 'Session capability registry disposal failed',
    }))
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        name: 'AggregateError',
        message: `Session capability "${second.id}" retirement failed`,
      }),
      expect.objectContaining({
        name: 'AggregateError',
        message: `Session capability "${first.id}" retirement failed`,
      }),
    ])
    expect(() => registry.register(factory(
      createCapabilityToken('session.after-dispose/v1', 'session'),
      () => ({ value: undefined, release: () => {} }),
    ), { ownerId: 'feature.closed', generation: 1 })).toThrowError(
      expect.objectContaining({ code: 'capability-unavailable' }),
    )
    expect(() => registry.bind(core('closed').port, manager.createSession('closed')))
      .toThrowError(expect.objectContaining({ code: 'capability-unavailable' }))

    await binding.release()
    await manager.dispose().catch(() => {})
  })

  it('ignores later registrations while an externally disposed binding is draining', async () => {
    const manager = new ScopeManager()
    const registry = new SessionCapabilityFactoryRegistry(manager.app)
    const scope = manager.createSession('session-a')
    const binding = registry.bind(core('session-a').port, scope)
    const slowToken = createCapabilityToken('session.drain/v1', 'session')
    let finishRelease!: () => void
    const releaseGate = new Promise<void>(resolve => { finishRelease = resolve })
    registry.register(factory(slowToken, () => ({
      value: undefined,
      release: () => releaseGate,
    })), { ownerId: 'feature.drain', generation: 1 })
    await binding.acquire(slowToken)

    const disposingScope = scope.dispose()
    const laterToken = createCapabilityToken('session.drain-later/v1', 'session')
    const laterRegistration = registry.register(factory(laterToken, () => ({
      value: undefined,
      release: () => {},
    })), { ownerId: 'feature.drain', generation: 2 })
    finishRelease()
    await disposingScope

    await expect(binding.acquire(laterToken)).rejects.toMatchObject({ code: 'scope-mismatch' })
    await laterRegistration.release()
    await manager.dispose()
  })

  it('rejects an orphan session and an aborted application scope', async () => {
    const manager = new ScopeManager()
    const orphan = new ResourceScope(manager, 'session', 1000, 'orphan', undefined)
    expect(() => composeSessionCapabilityLease({
      core: core('orphan').port,
      scope: orphan,
      factories: [],
    })).toThrowError(expect.objectContaining({ code: 'scope-mismatch' }))
    await orphan.dispose()

    const aborted = new ScopeManager('aborted')
    aborted.abort('test abort')
    expect(() => new SessionCapabilityFactoryRegistry(aborted.app)).toThrowError(
      expect.objectContaining({ code: 'scope-mismatch' }),
    )
    await aborted.dispose()

    const appOwned = new ScopeManager('app-owned')
    const appOwnedRegistry = new SessionCapabilityFactoryRegistry(appOwned.app)
    await appOwned.dispose()
    await expect(appOwnedRegistry.dispose()).resolves.toBeUndefined()
    await manager.dispose()
  })
})
