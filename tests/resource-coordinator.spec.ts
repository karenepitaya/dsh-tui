import { describe, expect, it, vi } from 'vitest'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import {
  ResourceCoordinator,
  type ResourceDefinition,
} from '../src/resource/resource-coordinator.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('ResourceCoordinator', () => {
  it('publishes scoped snapshot changes without letting a listener break loading', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const coordinator = new ResourceCoordinator()
    const definition: ResourceDefinition<number> = {
      key: 'subscribed',
      lifetime: 'surface',
      activation: 'on-visible',
      cachePolicy: 'last-good',
      load: () => 1,
    }
    const snapshots: string[] = []
    const stopThrowing = coordinator.subscribe(surface, definition, () => {
      throw new Error('render failed')
    })
    const stop = coordinator.subscribe(surface, definition, snapshot => {
      snapshots.push(snapshot.phase)
    })

    await coordinator.activate(surface, definition)
    stopThrowing()
    stopThrowing()
    stop()
    await coordinator.refresh(surface, definition)

    expect(snapshots).toEqual(['loading', 'ready'])
    await manager.dispose()
  })

  it('deduplicates one key in one scope and repeated reads do not reload it', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const coordinator = new ResourceCoordinator()
    const pending = deferred<string>()
    const load = vi.fn(() => pending.promise)
    const definition: ResourceDefinition<string> = {
      key: 'models',
      lifetime: 'session',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load,
    }

    expect(coordinator.get(session, definition)).toMatchObject({
      phase: 'idle',
      requestId: 0,
      scopeEpoch: session.epoch,
    })
    expect(coordinator.get(session, definition).phase).toBe('idle')
    const first = coordinator.activate(session, definition)
    const duplicate = coordinator.activate(session, definition)
    await Promise.resolve()

    expect(duplicate).toBe(first)
    expect(load).toHaveBeenCalledOnce()
    expect(coordinator.get(session, definition)).toMatchObject({
      phase: 'loading',
      requestId: 1,
    })

    pending.resolve('model-a')
    await first
    expect(coordinator.get(session, definition)).toMatchObject({
      phase: 'ready',
      value: 'model-a',
      lastGood: 'model-a',
      requestId: 1,
    })

    await coordinator.activate(session, definition)
    coordinator.get(session, definition)
    coordinator.get(session, definition)
    expect(load).toHaveBeenCalledOnce()
  })

  it('uses latest-wins request ids and ignores an abort-ignoring late completion', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const coordinator = new ResourceCoordinator()
    const loads: Deferred<string>[] = []
    const signals: AbortSignal[] = []
    const definition: ResourceDefinition<string> = {
      key: 'diff',
      lifetime: 'surface',
      activation: 'on-visible',
      cachePolicy: 'last-good',
      load: ({ signal }) => {
        signals.push(signal)
        const next = deferred<string>()
        loads.push(next)
        return next.promise
      },
    }

    const initial = coordinator.activate(surface, definition)
    await Promise.resolve()
    loads[0]!.resolve('base')
    await initial

    const stale = coordinator.refresh(surface, definition)
    await Promise.resolve()
    expect(coordinator.get(surface, definition)).toMatchObject({
      phase: 'refreshing',
      value: 'base',
      lastGood: 'base',
      requestId: 2,
    })
    const latest = coordinator.refresh(surface, definition)
    await Promise.resolve()
    expect(signals[1]!.aborted).toBe(true)
    expect(signals[2]!.aborted).toBe(false)

    loads[2]!.resolve('latest')
    await latest
    loads[1]!.resolve('stale')
    await stale

    expect(coordinator.get(surface, definition)).toMatchObject({
      phase: 'ready',
      value: 'latest',
      lastGood: 'latest',
      requestId: 3,
    })
  })

  it('retains last-good data while refreshing and after a refresh failure', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const coordinator = new ResourceCoordinator()
    const loads: Deferred<number>[] = []
    const definition: ResourceDefinition<number> = {
      key: 'catalog',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load: ({ previous }) => {
        expect(previous).toBe(loads.length === 0 ? undefined : 1)
        const next = deferred<number>()
        loads.push(next)
        return next.promise
      },
    }

    const initial = coordinator.activate(surface, definition)
    await Promise.resolve()
    loads[0]!.resolve(1)
    await initial
    const refresh = coordinator.refresh(surface, definition)
    await Promise.resolve()
    expect(coordinator.get(surface, definition)).toMatchObject({
      phase: 'refreshing',
      value: 1,
      lastGood: 1,
    })

    const failure = new Error('offline')
    loads[1]!.reject(failure)
    await refresh
    expect(coordinator.get(surface, definition)).toMatchObject({
      phase: 'failed',
      value: 1,
      lastGood: 1,
      error: failure,
    })
  })

  it('ignores a superseded request that rejects after the latest value commits', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const coordinator = new ResourceCoordinator()
    const loads: Deferred<number>[] = []
    const definition: ResourceDefinition<number> = {
      key: 'late-error',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load: () => {
        const next = deferred<number>()
        loads.push(next)
        return next.promise
      },
    }

    const stale = coordinator.activate(surface, definition)
    await Promise.resolve()
    const latest = coordinator.refresh(surface, definition)
    await Promise.resolve()
    loads[1]!.resolve(2)
    await latest
    loads[0]!.reject(new Error('late failure'))
    await stale

    expect(coordinator.get(surface, definition)).toMatchObject({
      phase: 'ready',
      value: 2,
      requestId: 2,
    })
  })

  it('drops the previous value during a no-cache refresh', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const coordinator = new ResourceCoordinator()
    const loads: Deferred<number>[] = []
    const definition: ResourceDefinition<number> = {
      key: 'preview',
      lifetime: 'surface',
      activation: 'manual',
      cachePolicy: 'none',
      load: () => {
        const next = deferred<number>()
        loads.push(next)
        return next.promise
      },
    }

    const initial = coordinator.activate(surface, definition)
    await Promise.resolve()
    loads[0]!.resolve(1)
    await initial
    const refresh = coordinator.refresh(surface, definition)
    await Promise.resolve()
    expect(coordinator.get(surface, definition)).toEqual({
      phase: 'loading',
      requestId: 2,
      scopeEpoch: surface.epoch,
    })
    const failure = new Error('failed')
    loads[1]!.reject(failure)
    await refresh
    expect(coordinator.get(surface, definition)).toEqual({
      phase: 'failed',
      requestId: 2,
      scopeEpoch: surface.epoch,
      error: failure,
    })
  })

  it('isolates equal keys in two scopes and surface disposal does not affect session data', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const surface = session.child('surface', 'chat')
    const sibling = session.child('surface', 'diff')
    const coordinator = new ResourceCoordinator()
    const sessionLoad = vi.fn(() => 'session-value')
    const surfaceLoad = vi.fn(() => 'surface-value')
    const siblingLoad = vi.fn(() => 'sibling-value')
    const sessionDefinition: ResourceDefinition<string> = {
      key: 'shared',
      lifetime: 'session',
      activation: 'eager',
      cachePolicy: 'last-good',
      load: sessionLoad,
    }
    const surfaceDefinition: ResourceDefinition<string> = {
      key: 'shared',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load: surfaceLoad,
    }
    const siblingDefinition: ResourceDefinition<string> = {
      ...surfaceDefinition,
      load: siblingLoad,
    }

    await Promise.all([
      coordinator.activate(session, sessionDefinition),
      coordinator.activate(surface, surfaceDefinition),
      coordinator.activate(sibling, siblingDefinition),
    ])
    await surface.dispose()

    expect(coordinator.get(session, sessionDefinition)).toMatchObject({
      phase: 'ready', value: 'session-value',
    })
    expect(coordinator.get(sibling, siblingDefinition)).toMatchObject({
      phase: 'ready', value: 'sibling-value',
    })
    expect(() => coordinator.get(surface, surfaceDefinition)).toThrow(
      'surface scope is disposed',
    )
    expect(sessionLoad).toHaveBeenCalledOnce()
    expect(surfaceLoad).toHaveBeenCalledOnce()
    expect(siblingLoad).toHaveBeenCalledOnce()
  })

  it('starts one watcher, refreshes on invalidation, and releases it with the scope', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const coordinator = new ResourceCoordinator()
    let invalidate!: () => void
    const stop = vi.fn()
    let value = 0
    const load = vi.fn(() => ++value)
    const watch = vi.fn(({ invalidate: requestRefresh }) => {
      invalidate = requestRefresh
      return stop
    })
    const definition: ResourceDefinition<number> = {
      key: 'watched',
      lifetime: 'surface',
      activation: 'on-visible',
      cachePolicy: 'last-good',
      load,
      watch,
    }

    await coordinator.activate(surface, definition)
    await coordinator.activate(surface, definition)
    invalidate()
    await Promise.resolve()
    await Promise.resolve()

    expect(watch).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledTimes(2)
    expect(coordinator.get(surface, definition)).toMatchObject({ value: 2 })

    await surface.dispose()
    invalidate()
    await Promise.resolve()
    expect(stop).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('contains watcher setup failure and does not start the loader', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const coordinator = new ResourceCoordinator()
    const failure = new Error('watch failed')
    const load = vi.fn(() => 1)
    const watch = vi.fn(() => { throw failure })
    const definition: ResourceDefinition<number> = {
      key: 'broken-watch',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load,
      watch,
    }

    await coordinator.activate(surface, definition)
    await coordinator.refresh(surface, definition)

    expect(load).not.toHaveBeenCalled()
    expect(watch).toHaveBeenCalledTimes(2)
    expect(coordinator.get(surface, definition)).toMatchObject({
      phase: 'failed',
      error: failure,
    })
  })

  it('aborts an active loader and releases an asynchronous watcher exactly once', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const coordinator = new ResourceCoordinator()
    const pending = deferred<string>()
    let loadSignal!: AbortSignal
    const stop = vi.fn(async () => { await Promise.resolve() })
    const definition: ResourceDefinition<string> = {
      key: 'slow',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load: ({ signal }) => {
        loadSignal = signal
        return pending.promise
      },
      watch: () => stop,
    }

    const task = coordinator.activate(surface, definition)
    const disposal = surface.dispose('surface closed')
    await Promise.resolve()
    expect(loadSignal.aborted).toBe(true)
    pending.resolve('too late')
    await task
    await disposal
    await surface.dispose()

    expect(stop).toHaveBeenCalledOnce()
  })

  it('does not wait for an abort-ignoring loader before releasing its scope', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const coordinator = new ResourceCoordinator()
    const pending = deferred<string>()
    const stop = vi.fn()
    let loadSignal!: AbortSignal
    const definition: ResourceDefinition<string> = {
      key: 'never-settles-on-abort',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load: ({ signal }) => {
        loadSignal = signal
        return pending.promise
      },
      watch: () => stop,
    }

    const task = coordinator.activate(surface, definition)
    await Promise.resolve()
    const disposal = surface.dispose('surface closed')
    const outcome = await Promise.race([
      disposal.then(() => 'disposed' as const),
      new Promise<'timed-out'>((resolve) => {
        setTimeout(() => { resolve('timed-out') }, 100)
      }),
    ])

    expect(outcome).toBe('disposed')
    expect(loadSignal.aborted).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    expect(() => coordinator.get(surface, definition)).toThrow('surface scope is disposed')

    pending.resolve('late')
    await expect(task).resolves.toMatchObject({ phase: 'loading', requestId: 1 })
  })

  it('can release one resource early without disposing its containing scope', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const coordinator = new ResourceCoordinator()
    const stop = vi.fn()
    const load = vi.fn(() => 1)
    const definition: ResourceDefinition<number> = {
      key: 'feature-owned',
      lifetime: 'surface',
      activation: 'on-visible',
      cachePolicy: 'last-good',
      load,
      watch: () => stop,
    }

    await coordinator.activate(surface, definition)
    expect(() => coordinator.release(surface, {
      ...definition,
      load: () => 2,
    })).toThrow('resource feature-owned is already defined in surface scope')
    await coordinator.release(surface, definition)
    await coordinator.release(surface, definition)

    expect(stop).toHaveBeenCalledOnce()
    expect(surface.disposed).toBe(false)
    expect(coordinator.get(surface, definition).phase).toBe('idle')
    await coordinator.activate(surface, definition)
    expect(load).toHaveBeenCalledTimes(2)
    await manager.dispose()
  })

  it('rejects lifetime mismatches and conflicting definitions for one scoped key', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const coordinator = new ResourceCoordinator()
    const definition: ResourceDefinition<number> = {
      key: 'models',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load: () => 1,
    }
    expect(() => coordinator.get(session, definition)).toThrow(
      'resource models requires surface scope, received session scope',
    )

    const first: ResourceDefinition<number> = { ...definition, lifetime: 'session' }
    const conflicting: ResourceDefinition<number> = { ...first, load: () => 2 }
    coordinator.get(session, first)
    expect(() => coordinator.get(session, conflicting)).toThrow(
      'resource models is already defined in session scope',
    )
    await manager.dispose()
  })
})
