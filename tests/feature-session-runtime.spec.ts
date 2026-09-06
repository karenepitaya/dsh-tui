import { describe, expect, it, vi } from 'vitest'
import {
  FeatureSessionRuntime,
  createSessionFeatureCapabilityResolver,
} from '../src/app/feature-session-runtime.ts'
import type {
  FeatureSurfaceRuntimePort,
  FeatureSurfaceRuntimeSnapshot,
  FeatureSurfaceSessionLease,
} from '../src/app/feature-surface-runtime.ts'
import {
  createCapabilityToken,
  type CapabilityLease,
  type CapabilityToken,
} from '../src/kernel/capability.ts'
import type { DshTuiFeatureService } from '../src/kernel/feature-service.ts'
import type {
  FeatureSessionBindingLease,
  FeatureSessionBindingOptions,
} from '../src/kernel/feature-session.ts'
import {
  runtimeSessionScope,
  type RuntimeSessionScopeCarrier,
} from '../src/lifecycle/application-scope-host.ts'
import {
  ScopeManager,
  type ResourceScope,
} from '../src/lifecycle/scope-manager.ts'
import type { LayoutViewport } from '../src/layout/strategy.ts'
import {
  runtimeSessionCapabilities,
  type RuntimeSessionCapabilityCarrier,
  type RuntimeSessionCapabilityResolver,
} from '../src/runtime/runtime-session.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

interface BindGate {
  readonly entered: Deferred<void>
  readonly resume: Deferred<void>
}

class FeatureServiceProbe {
  readonly bindSession = vi.fn((options: FeatureSessionBindingOptions) => (
    this.bind(options)
  ))
  readonly failures = new Map<string, unknown>()
  readonly gates = new Map<string, BindGate>()
  readonly releaseFailures = new Map<string, unknown>()
  readonly releaseGates = new Map<string, BindGate>()

  constructor(private readonly events: string[]) {}

  asService(): DshTuiFeatureService {
    return { bindSession: this.bindSession } as unknown as DshTuiFeatureService
  }

  hold(label: string): BindGate {
    const gate = { entered: deferred<void>(), resume: deferred<void>() }
    this.gates.set(label, gate)
    return gate
  }

  holdRelease(label: string): BindGate {
    const gate = { entered: deferred<void>(), resume: deferred<void>() }
    this.releaseGates.set(label, gate)
    return gate
  }

  private async bind(
    options: FeatureSessionBindingOptions,
  ): Promise<FeatureSessionBindingLease> {
    const label = options.scope.label
    this.events.push(`feature:bind:${label}`)
    const gate = this.gates.get(label)
    if (gate !== undefined) {
      gate.entered.resolve()
      await gate.resume.promise
      this.gates.delete(label)
    }
    if (this.failures.has(label)) {
      const failure = this.failures.get(label)
      this.failures.delete(label)
      throw failure
    }
    let active = true
    return {
      get active() {
        return active
      },
      release: async () => {
        if (!active) return
        active = false
        this.events.push(`feature:release:${label}`)
        const releaseGate = this.releaseGates.get(label)
        if (releaseGate !== undefined) {
          releaseGate.entered.resolve()
          await releaseGate.resume.promise
          this.releaseGates.delete(label)
        }
        if (this.releaseFailures.has(label)) {
          const failure = this.releaseFailures.get(label)
          this.releaseFailures.delete(label)
          throw failure
        }
      },
    }
  }
}

interface SurfaceRuntimeOwner extends FeatureSurfaceRuntimePort {
  dispose(): Promise<void>
}

class SurfaceRuntimeProbe implements SurfaceRuntimeOwner {
  readonly failures = new Map<string, unknown>()
  readonly readyGates = new Map<string, BindGate>()
  readonly resizeFailures = new Map<string, unknown>()
  readonly resizeGates = new Map<string, BindGate>()
  readonly themeFailures = new Map<string, unknown>()
  readonly themeGates = new Map<string, BindGate>()
  readonly stopFailures = new Map<string, unknown>()
  readonly releaseFailures = new Map<string, unknown>()
  readonly onSubscribe = new Map<string, () => void>()
  readonly bindCalls: string[] = []
  disposeCalls = 0
  disposeFailure: unknown
  private active: FeatureSurfaceSessionLease | undefined
  private disposed = false
  private readonly lateListeners = new Map<
    string,
    (snapshot: FeatureSurfaceRuntimeSnapshot) => void
  >()

  constructor(private readonly events: string[]) {}

  holdReady(label: string): BindGate {
    return this.hold(this.readyGates, label)
  }

  holdResize(label: string): BindGate {
    return this.hold(this.resizeGates, label)
  }

  holdTheme(label: string): BindGate {
    return this.hold(this.themeGates, label)
  }

  emitLate(label: string, viewport: LayoutViewport): void {
    this.lateListeners.get(label)?.(surfaceSnapshot(label, viewport, 999))
  }

  bindSession(
    sessionScope: ResourceScope,
    viewport: LayoutViewport,
  ): FeatureSurfaceSessionLease {
    if (this.active?.active === true) throw new Error('surface already bound')
    const label = sessionScope.label
    this.bindCalls.push(label)
    this.events.push(`surface:bind:${label}`)
    let active = true
    let revision = 0
    let current = surfaceSnapshot(label, viewport, revision)
    const listeners = new Set<(snapshot: FeatureSurfaceRuntimeSnapshot) => void>()
    const ready = (async () => {
      await this.waitFor(this.readyGates, label)
      if (this.failures.has(label)) {
        const failure = this.failures.get(label)
        this.failures.delete(label)
        throw failure
      }
    })()
    let releaseTask: Promise<void> | undefined
    const lease: FeatureSurfaceSessionLease = {
      get active() {
        return active
      },
      ready,
      snapshot: () => current,
      onChanged: (listener) => {
        if (!active) throw new Error('surface released')
        listeners.add(listener)
        this.lateListeners.set(label, listener)
        const onSubscribe = this.onSubscribe.get(label)
        if (onSubscribe !== undefined) {
          this.onSubscribe.delete(label)
          onSubscribe()
        }
        return () => {
          if (this.stopFailures.has(label)) {
            const failure = this.stopFailures.get(label)
            this.stopFailures.delete(label)
            throw failure
          }
          listeners.delete(listener)
        }
      },
      resize: async (nextViewport) => {
        if (!active) throw new Error('surface released')
        this.events.push(`surface:resize:${label}`)
        await this.waitFor(this.resizeGates, label)
        if (this.resizeFailures.has(label)) {
          const failure = this.resizeFailures.get(label)
          this.resizeFailures.delete(label)
          throw failure
        }
        current = surfaceSnapshot(label, nextViewport, ++revision)
        for (const listener of [...listeners]) listener(current)
      },
      themeChanged: async () => {
        if (!active) throw new Error('surface released')
        this.events.push(`surface:theme:${label}`)
        await this.waitFor(this.themeGates, label)
        if (this.themeFailures.has(label)) {
          const failure = this.themeFailures.get(label)
          this.themeFailures.delete(label)
          throw failure
        }
        current = surfaceSnapshot(label, current.layout.viewport, ++revision)
        for (const listener of [...listeners]) listener(current)
      },
      settled: () => Promise.resolve(),
      release: () => {
        releaseTask ??= (async () => {
          if (!active) return
          active = false
          listeners.clear()
          this.events.push(`surface:release:${label}`)
          if (this.active === lease) this.active = undefined
          if (this.releaseFailures.has(label)) {
            const failure = this.releaseFailures.get(label)
            this.releaseFailures.delete(label)
            throw failure
          }
        })()
        return releaseTask
      },
    }
    this.active = lease
    return lease
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.disposed = true
    this.disposeCalls += 1
    this.events.push('surface:dispose')
    return this.disposeFailure === undefined
      ? Promise.resolve()
      : Promise.reject(this.disposeFailure)
  }

  private hold(gates: Map<string, BindGate>, label: string): BindGate {
    const gate = { entered: deferred<void>(), resume: deferred<void>() }
    gates.set(label, gate)
    return gate
  }

  private async waitFor(gates: Map<string, BindGate>, label: string): Promise<void> {
    const gate = gates.get(label)
    if (gate === undefined) return
    gate.entered.resolve()
    await gate.resume.promise
    gates.delete(label)
  }
}

function surfaceSnapshot(
  label: string,
  viewport: LayoutViewport,
  revision: number,
): FeatureSurfaceRuntimeSnapshot {
  return Object.freeze({
    host: Object.freeze({ sessionLabel: label, revision }) as never,
    layout: Object.freeze({ viewport: Object.freeze({ ...viewport }) }) as never,
    surfaces: Object.freeze([]),
  })
}

function snapshotLabel(
  snapshot: FeatureSurfaceRuntimeSnapshot | undefined,
): string | undefined {
  return (snapshot?.host as unknown as { sessionLabel?: string }).sessionLabel
}

function sessionSource(
  scope: ResourceScope,
  capabilities: RuntimeSessionCapabilityResolver = {
    acquire: async <TValue>(_token: CapabilityToken<TValue>) => ({
      value: undefined as TValue,
      release: () => {},
    } satisfies CapabilityLease<TValue>),
  },
): RuntimeSessionScopeCarrier & RuntimeSessionCapabilityCarrier {
  return Object.freeze({
    [runtimeSessionScope]: scope,
    [runtimeSessionCapabilities]: capabilities,
  })
}

describe('FeatureSessionRuntime', () => {
  it('binds Feature before Surface and switches in reverse ownership order', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('switch')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const beta = sessionSource(scopes.createSession('beta'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)

    await expect(runtime.activate(alpha, { columns: 120, rows: 40 }))
      .resolves.toBe('active')
    await expect(runtime.activate(alpha, { columns: 120, rows: 40 }))
      .resolves.toBe('active')
    await runtime.activate(beta, { columns: 140, rows: 44 })

    expect(events).toEqual([
      'feature:bind:alpha',
      'surface:bind:alpha',
      'surface:release:alpha',
      'feature:release:alpha',
      'feature:bind:beta',
      'surface:bind:beta',
    ])
    expect(snapshotLabel(runtime.snapshot())).toBe('beta')

    await runtime.dispose()
    await scopes.dispose()
  })

  it('restores the cached source and coherent snapshot when a switch fails', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('rollback')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const beta = sessionSource(scopes.createSession('beta'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)
    const observed: (string | undefined)[] = []
    runtime.onChanged(() => { throw new Error('broken renderer') })
    runtime.onChanged(snapshot => { observed.push(snapshotLabel(snapshot)) })

    await runtime.activate(alpha, { columns: 120, rows: 40 })
    events.length = 0
    const failure = new Error('beta surface failed')
    surfaces.failures.set('beta', failure)

    await expect(runtime.activate(beta, { columns: 160, rows: 50 }))
      .rejects.toBe(failure)

    expect(events).toEqual([
      'surface:release:alpha',
      'feature:release:alpha',
      'feature:bind:beta',
      'surface:bind:beta',
      'surface:release:beta',
      'feature:release:beta',
      'feature:bind:alpha',
      'surface:bind:alpha',
    ])
    expect(snapshotLabel(runtime.snapshot())).toBe('alpha')
    expect(runtime.snapshot()?.layout.viewport).toEqual({ columns: 120, rows: 40 })
    expect(observed).toEqual(['alpha', 'alpha'])

    await runtime.dispose()
    await scopes.dispose()
  })

  it('resizes and refreshes theme without reloading either binding', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('resize')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)

    await runtime.activate(alpha, { columns: 100, rows: 30 })
    await runtime.activate(alpha, { columns: 110, rows: 32 })
    events.length = 0
    await runtime.resize({ columns: 180, rows: 55 })
    await runtime.themeChanged()

    expect(events).toEqual(['surface:resize:alpha', 'surface:theme:alpha'])
    expect(features.bindSession).toHaveBeenCalledOnce()
    expect(surfaces.bindCalls).toEqual(['alpha'])
    expect(runtime.snapshot()?.layout.viewport).toEqual({ columns: 180, rows: 55 })

    await runtime.dispose()
    await scopes.dispose()
  })

  it('keeps stale resize and theme completions behind the newest activation', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('stale-controls')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const beta = sessionSource(scopes.createSession('beta'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)
    await runtime.activate(alpha, { columns: 100, rows: 30 })

    const resizeGate = surfaces.holdResize('alpha')
    const resize = runtime.resize({ columns: 120, rows: 35 })
    await resizeGate.entered.promise
    const switchToBeta = runtime.activate(beta, { columns: 140, rows: 40 })
    resizeGate.resume.resolve()
    await Promise.all([resize, switchToBeta])

    const themeGate = surfaces.holdTheme('beta')
    const theme = runtime.themeChanged()
    await themeGate.entered.promise
    const switchToAlpha = runtime.activate(alpha, { columns: 160, rows: 45 })
    themeGate.resume.resolve()
    await Promise.all([theme, switchToAlpha])

    surfaces.emitLate('beta', { columns: 999, rows: 999 })
    expect(snapshotLabel(runtime.snapshot())).toBe('alpha')
    expect(runtime.snapshot()?.layout.viewport).toEqual({ columns: 160, rows: 45 })

    await runtime.dispose()
    await scopes.dispose()
  })

  it('propagates a current resize failure and contains a superseded resize', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('stale-current')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const beta = sessionSource(scopes.createSession('beta'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)
    await runtime.activate(alpha, { columns: 100, rows: 30 })
    const currentFailure = new Error('current resize failed')
    surfaces.resizeFailures.set('alpha', currentFailure)
    await expect(runtime.activate(alpha, { columns: 110, rows: 32 }))
      .rejects.toBe(currentFailure)

    const gate = surfaces.holdResize('alpha')
    const resize = runtime.activate(alpha, { columns: 120, rows: 35 })
    await gate.entered.promise
    const switched = runtime.activate(beta, { columns: 140, rows: 40 })
    gate.resume.resolve()

    await expect(resize).resolves.toBe('unavailable')
    await expect(switched).resolves.toBe('active')
    expect(snapshotLabel(runtime.snapshot())).toBe('beta')

    await runtime.activate(alpha, { columns: 100, rows: 30 })
    const staleFailure = new Error('stale resize failed')
    const staleGate = surfaces.holdResize('alpha')
    surfaces.resizeFailures.set('alpha', staleFailure)
    const staleResize = runtime.activate(alpha, { columns: 120, rows: 35 })
    await staleGate.entered.promise
    const finalSwitch = runtime.activate(beta, { columns: 140, rows: 40 })
    staleGate.resume.resolve()
    await expect(staleResize).resolves.toBe('unavailable')
    await expect(finalSwitch).resolves.toBe('active')

    await runtime.dispose()
    await scopes.dispose()
  })

  it('keeps deactivation and carrier-free cleanup behind a newer request', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('stale-cleanup')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const beta = sessionSource(scopes.createSession('beta'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)
    await runtime.activate(alpha, { columns: 100, rows: 30 })

    let gate = features.holdRelease('alpha')
    const deactivation = runtime.deactivate()
    await gate.entered.promise
    const restore = runtime.activate(alpha, { columns: 110, rows: 32 })
    gate.resume.resolve()
    await Promise.all([deactivation, restore])
    expect(snapshotLabel(runtime.snapshot())).toBe('alpha')

    gate = features.holdRelease('alpha')
    const unavailable = runtime.activate({ legacy: true }, { columns: 80, rows: 24 })
    await gate.entered.promise
    const switched = runtime.activate(beta, { columns: 140, rows: 40 })
    gate.resume.resolve()
    await expect(unavailable).resolves.toBe('unavailable')
    await expect(switched).resolves.toBe('active')
    await expect(runtime.activate({ legacy: true }, { columns: 80, rows: 24 }))
      .resolves.toBe('unavailable')
    await expect(runtime.activate({ legacy: true }, { columns: 80, rows: 24 }))
      .resolves.toBe('unavailable')

    await runtime.dispose()
    await scopes.dispose()
  })

  it('returns unavailable for a carrier-free legacy source without rejecting it', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('legacy')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)

    await runtime.activate(alpha, { columns: 100, rows: 30 })
    events.length = 0
    await expect(runtime.activate({ legacy: true }, { columns: 80, rows: 24 }))
      .resolves.toBe('unavailable')

    expect(events).toEqual(['surface:release:alpha', 'feature:release:alpha'])
    expect(runtime.snapshot()).toBeUndefined()

    await runtime.dispose()
    await scopes.dispose()
  })

  it('cleans a superseded late binding without publishing over the newer epoch', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('epoch')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const beta = sessionSource(scopes.createSession('beta'))
    const features = new FeatureServiceProbe(events)
    const gate = features.hold('alpha')
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)
    const observed: (string | undefined)[] = []
    runtime.onChanged(snapshot => { observed.push(snapshotLabel(snapshot)) })

    const first = runtime.activate(alpha, { columns: 100, rows: 30 })
    await gate.entered.promise
    const second = runtime.activate(beta, { columns: 140, rows: 40 })
    gate.resume.resolve()

    await expect(first).resolves.toBe('unavailable')
    await expect(second).resolves.toBe('active')
    expect(events).toEqual([
      'feature:bind:alpha',
      'feature:release:alpha',
      'feature:bind:beta',
      'surface:bind:beta',
    ])
    expect(observed).toEqual(['beta'])
    expect(snapshotLabel(runtime.snapshot())).toBe('beta')

    await runtime.dispose()
    await scopes.dispose()
  })

  it('skips an activation superseded before it starts', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('queued-epoch')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const beta = sessionSource(scopes.createSession('beta'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)

    const first = runtime.activate(alpha, { columns: 100, rows: 30 })
    const second = runtime.activate(beta, { columns: 140, rows: 40 })

    await expect(first).resolves.toBe('unavailable')
    await expect(second).resolves.toBe('active')
    expect(events).toEqual(['feature:bind:beta', 'surface:bind:beta'])

    await runtime.dispose()
    await scopes.dispose()
  })

  it('drops a switch superseded after releasing the previous Session', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('release-epoch')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const beta = sessionSource(scopes.createSession('beta'))
    const gamma = sessionSource(scopes.createSession('gamma'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)
    await runtime.activate(alpha, { columns: 100, rows: 30 })
    const gate = features.holdRelease('alpha')

    const first = runtime.activate(beta, { columns: 120, rows: 35 })
    await gate.entered.promise
    const second = runtime.activate(gamma, { columns: 140, rows: 40 })
    gate.resume.resolve()

    await expect(first).resolves.toBe('unavailable')
    await expect(second).resolves.toBe('active')
    expect(events).not.toContain('feature:bind:beta')
    expect(snapshotLabel(runtime.snapshot())).toBe('gamma')

    await runtime.dispose()
    await scopes.dispose()
  })

  it('cleans a fully prepared Surface lease superseded while becoming ready', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('surface-epoch')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const beta = sessionSource(scopes.createSession('beta'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)
    const gate = surfaces.holdReady('alpha')

    const first = runtime.activate(alpha, { columns: 100, rows: 30 })
    await gate.entered.promise
    const second = runtime.activate(beta, { columns: 140, rows: 40 })
    gate.resume.resolve()

    await expect(first).resolves.toBe('unavailable')
    await expect(second).resolves.toBe('active')
    expect(events).toEqual([
      'feature:bind:alpha',
      'surface:bind:alpha',
      'surface:release:alpha',
      'feature:release:alpha',
      'feature:bind:beta',
      'surface:bind:beta',
    ])

    await runtime.dispose()
    await scopes.dispose()
  })

  it('reports initial binding and rollback failures without a stale snapshot', async () => {
    const initialEvents: string[] = []
    const initialScopes = new ScopeManager('initial-failure')
    const initialFeatures = new FeatureServiceProbe(initialEvents)
    const initialSurfaces = new SurfaceRuntimeProbe(initialEvents)
    const initial = new FeatureSessionRuntime(
      initialFeatures.asService(),
      initialSurfaces,
    )
    const initialFailure = new Error('initial feature failed')
    initialFeatures.failures.set('alpha', initialFailure)
    await expect(initial.activate(
      sessionSource(initialScopes.createSession('alpha')),
      { columns: 100, rows: 30 },
    )).rejects.toBe(initialFailure)
    expect(initial.snapshot()).toBeUndefined()
    await initial.dispose()
    await initialScopes.dispose()

    const events: string[] = []
    const scopes = new ScopeManager('rollback-failure')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const beta = sessionSource(scopes.createSession('beta'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)
    await runtime.activate(alpha, { columns: 100, rows: 30 })
    const switchFailure = new Error('beta surface failed')
    const rollbackFailure = new Error('alpha restore failed')
    surfaces.failures.set('beta', switchFailure)
    features.failures.set('alpha', rollbackFailure)

    const failure = await runtime.activate(beta, { columns: 140, rows: 40 })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({
      message: 'Feature Session activation and rollback failed',
      errors: [switchFailure, rollbackFailure],
    })
    expect(runtime.snapshot()).toBeUndefined()

    await runtime.dispose()
    await scopes.dispose()
  })

  it('does not let late rollback failure or success overwrite a newer epoch', async () => {
    const failedEvents: string[] = []
    const failedScopes = new ScopeManager('stale-rollback-failure')
    const failedAlpha = sessionSource(failedScopes.createSession('alpha'))
    const failedBeta = sessionSource(failedScopes.createSession('beta'))
    const failedGamma = sessionSource(failedScopes.createSession('gamma'))
    const failedFeatures = new FeatureServiceProbe(failedEvents)
    const failedSurfaces = new SurfaceRuntimeProbe(failedEvents)
    const failedRuntime = new FeatureSessionRuntime(
      failedFeatures.asService(),
      failedSurfaces,
    )
    await failedRuntime.activate(failedAlpha, { columns: 100, rows: 30 })
    failedSurfaces.failures.set('beta', new Error('beta failed'))
    const restoreGate = failedFeatures.hold('alpha')
    const failedSwitch = failedRuntime.activate(failedBeta, { columns: 120, rows: 35 })
    await restoreGate.entered.promise
    const newerAfterFailure = failedRuntime.activate(
      failedGamma,
      { columns: 140, rows: 40 },
    )
    restoreGate.resume.resolve()
    await expect(failedSwitch).resolves.toBe('unavailable')
    await expect(newerAfterFailure).resolves.toBe('active')
    expect(snapshotLabel(failedRuntime.snapshot())).toBe('gamma')
    await failedRuntime.dispose()
    await failedScopes.dispose()

    const events: string[] = []
    const scopes = new ScopeManager('stale-rollback-success')
    const alpha = sessionSource(scopes.createSession('alpha'))
    const beta = sessionSource(scopes.createSession('beta'))
    const gamma = sessionSource(scopes.createSession('gamma'))
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)
    await runtime.activate(alpha, { columns: 100, rows: 30 })
    surfaces.failures.set('beta', new Error('beta failed'))
    let newer!: Promise<'active' | 'unavailable'>
    surfaces.onSubscribe.set('alpha', () => {
      newer = runtime.activate(gamma, { columns: 160, rows: 45 })
    })

    await expect(runtime.activate(beta, { columns: 120, rows: 35 }))
      .resolves.toBe('unavailable')
    await expect(newer).resolves.toBe('active')
    expect(snapshotLabel(runtime.snapshot())).toBe('gamma')

    await runtime.dispose()
    await scopes.dispose()
  })

  it('aggregates binding cleanup, release, and owned runtime disposal failures', async () => {
    const bindingEvents: string[] = []
    const bindingScopes = new ScopeManager('binding-cleanup')
    const bindingFeatures = new FeatureServiceProbe(bindingEvents)
    const bindingSurfaces = new SurfaceRuntimeProbe(bindingEvents)
    const bindingRuntime = new FeatureSessionRuntime(
      bindingFeatures.asService(),
      bindingSurfaces,
    )
    const primary = new Error('surface ready failed')
    const surfaceCleanup = new Error('surface cleanup failed')
    const featureCleanup = new Error('feature cleanup failed')
    bindingSurfaces.failures.set('alpha', primary)
    bindingSurfaces.releaseFailures.set('alpha', surfaceCleanup)
    bindingFeatures.releaseFailures.set('alpha', featureCleanup)
    const bindingFailure = await bindingRuntime.activate(
      sessionSource(bindingScopes.createSession('alpha')),
      { columns: 100, rows: 30 },
    ).catch((error: unknown) => error)
    expect(bindingFailure).toMatchObject({
      message: 'Feature Session binding cleanup failed',
      errors: [primary, surfaceCleanup, featureCleanup],
    })
    await bindingRuntime.dispose()
    await bindingScopes.dispose()

    const releaseEvents: string[] = []
    const releaseScopes = new ScopeManager('release-failure')
    const releaseFeatures = new FeatureServiceProbe(releaseEvents)
    const releaseSurfaces = new SurfaceRuntimeProbe(releaseEvents)
    const releaseRuntime = new FeatureSessionRuntime(
      releaseFeatures.asService(),
      releaseSurfaces,
    )
    await releaseRuntime.activate(
      sessionSource(releaseScopes.createSession('alpha')),
      { columns: 100, rows: 30 },
    )
    const stopFailure = new Error('listener stop failed')
    const surfaceRelease = new Error('surface release failed')
    const featureRelease = new Error('feature release failed')
    releaseSurfaces.stopFailures.set('alpha', stopFailure)
    releaseSurfaces.releaseFailures.set('alpha', surfaceRelease)
    releaseFeatures.releaseFailures.set('alpha', featureRelease)
    const releaseFailure = await releaseRuntime.deactivate()
      .catch((error: unknown) => error)
    expect(releaseFailure).toMatchObject({
      message: 'Feature Session release failed',
      errors: [stopFailure, surfaceRelease, featureRelease],
    })
    expect(releaseRuntime.snapshot()).toBeUndefined()
    await releaseRuntime.dispose()
    await releaseScopes.dispose()

    const disposeEvents: string[] = []
    const disposeScopes = new ScopeManager('dispose-failure')
    const disposeFeatures = new FeatureServiceProbe(disposeEvents)
    const disposeSurfaces = new SurfaceRuntimeProbe(disposeEvents)
    const disposeRuntime = new FeatureSessionRuntime(
      disposeFeatures.asService(),
      disposeSurfaces,
    )
    await disposeRuntime.activate(
      sessionSource(disposeScopes.createSession('alpha')),
      { columns: 100, rows: 30 },
    )
    const disposeRelease = new Error('dispose release failed')
    const surfaceDispose = new Error('surface owner dispose failed')
    disposeFeatures.releaseFailures.set('alpha', disposeRelease)
    disposeSurfaces.disposeFailure = surfaceDispose
    const disposeFailure = await disposeRuntime.dispose()
      .catch((error: unknown) => error)
    expect(disposeFailure).toMatchObject({
      message: 'Feature Session runtime disposal failed',
      errors: [expect.objectContaining({ errors: [disposeRelease] }), surfaceDispose],
    })
    await disposeScopes.dispose()
  })

  it('keeps inactive controls and lifecycle calls idempotent', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('inactive')
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)
    const stop = runtime.onChanged(() => {})
    stop()
    stop()

    await runtime.resize({ columns: 80, rows: 24 })
    await runtime.themeChanged()
    await runtime.deactivate()
    const pendingDeactivate = runtime.deactivate()
    const activation = runtime.activate(
      sessionSource(scopes.createSession('alpha')),
      { columns: 100, rows: 30 },
    )
    await Promise.all([pendingDeactivate, activation])
    await runtime.deactivate()
    await runtime.deactivate()

    const disposal = runtime.dispose()
    await disposal
    expect(runtime.dispose()).toBe(disposal)
    await expect(runtime.deactivate()).resolves.toBeUndefined()
    expect(() => runtime.activate({}, { columns: 80, rows: 24 })).toThrow(
      'Feature Session runtime is disposed',
    )
    expect(() => runtime.resize({ columns: 80, rows: 24 })).toThrow(
      'Feature Session runtime is disposed',
    )
    expect(() => runtime.themeChanged()).toThrow('Feature Session runtime is disposed')
    expect(() => runtime.onChanged(() => {})).toThrow('Feature Session runtime is disposed')

    await scopes.dispose()
  })

  it('keeps two app-scoped instances and their listeners isolated', async () => {
    const leftEvents: string[] = []
    const rightEvents: string[] = []
    const leftScopes = new ScopeManager('left')
    const rightScopes = new ScopeManager('right')
    const left = new FeatureSessionRuntime(
      new FeatureServiceProbe(leftEvents).asService(),
      new SurfaceRuntimeProbe(leftEvents),
    )
    const right = new FeatureSessionRuntime(
      new FeatureServiceProbe(rightEvents).asService(),
      new SurfaceRuntimeProbe(rightEvents),
    )
    const leftObserved: string[] = []
    const rightObserved: string[] = []
    left.onChanged(snapshot => { leftObserved.push(snapshotLabel(snapshot) ?? 'none') })
    right.onChanged(snapshot => { rightObserved.push(snapshotLabel(snapshot) ?? 'none') })

    await Promise.all([
      left.activate(sessionSource(leftScopes.createSession('left-session')), {
        columns: 100,
        rows: 30,
      }),
      right.activate(sessionSource(rightScopes.createSession('right-session')), {
        columns: 160,
        rows: 50,
      }),
    ])

    expect(snapshotLabel(left.snapshot())).toBe('left-session')
    expect(snapshotLabel(right.snapshot())).toBe('right-session')
    expect(leftObserved).toEqual(['left-session'])
    expect(rightObserved).toEqual(['right-session'])

    await Promise.all([left.dispose(), right.dispose()])
    await Promise.all([leftScopes.dispose(), rightScopes.dispose()])
  })

  it('disposes bindings and the owned Surface runtime exactly once', async () => {
    const events: string[] = []
    const scopes = new ScopeManager('dispose')
    const features = new FeatureServiceProbe(events)
    const surfaces = new SurfaceRuntimeProbe(events)
    const runtime = new FeatureSessionRuntime(features.asService(), surfaces)
    await runtime.activate(sessionSource(scopes.createSession('alpha')), {
      columns: 100,
      rows: 30,
    })
    events.length = 0

    const first = runtime.dispose()
    expect(runtime.dispose()).toBe(first)
    await first
    await expect(runtime.deactivate()).resolves.toBeUndefined()

    expect(events).toEqual([
      'surface:release:alpha',
      'feature:release:alpha',
      'surface:dispose',
    ])
    expect(surfaces.disposeCalls).toBe(1)
    expect(runtime.snapshot()).toBeUndefined()

    await scopes.dispose()
  })
})

describe('createSessionFeatureCapabilityResolver', () => {
  it('allows only the exact owning Session scope', async () => {
    const scopes = new ScopeManager('resolver')
    const session = scopes.createSession('session')
    const other = scopes.createSession('other')
    const sessionToken = createCapabilityToken<string>('test.session/v1', 'session')
    const appToken = createCapabilityToken<string>('test.application/v1', 'application')
    const release = vi.fn()
    const acquire = vi.fn<(token: CapabilityToken<unknown>) => void>()
    const capabilities: RuntimeSessionCapabilityResolver = {
      acquire: async <TValue>(token: CapabilityToken<TValue>) => {
        acquire(token)
        return { value: 'resolved' as TValue, release }
      },
    }
    const resolver = createSessionFeatureCapabilityResolver(session, capabilities)

    await expect(resolver.resolve(sessionToken, session)).resolves.toEqual({
      value: 'resolved',
      release,
    })
    expect(() => resolver.resolve(sessionToken, other)).toThrow(
      'Session capability resolver rejected "test.session/v1" outside its session scope',
    )
    expect(() => resolver.resolve(appToken, session)).toThrow(
      'Session capability resolver rejected "test.application/v1" outside its session scope',
    )
    expect(acquire).toHaveBeenCalledExactlyOnceWith(sessionToken)

    await scopes.dispose()
  })
})
