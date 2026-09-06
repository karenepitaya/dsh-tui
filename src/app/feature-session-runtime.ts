import type {
  FeatureSurfaceRuntimePort,
  FeatureSurfaceRuntimeSnapshot,
  FeatureSurfaceSessionLease,
} from './feature-surface-runtime.ts'
import type { CapabilityLease, CapabilityToken } from '../kernel/capability.ts'
import type { DshTuiFeatureService } from '../kernel/feature-service.ts'
import type { FeatureSessionBindingLease } from '../kernel/feature-session.ts'
import type { FeatureCapabilityResolver } from '../kernel/feature-supervisor.ts'
import { runtimeSessionScopeOf } from '../lifecycle/application-scope-host.ts'
import type { ResourceScope } from '../lifecycle/scope-manager.ts'
import type { LayoutViewport } from '../layout/strategy.ts'
import {
  runtimeSessionCapabilitiesOf,
  type RuntimeSessionCapabilityResolver,
} from '../runtime/runtime-session.ts'

export type FeatureSessionActivationResult = 'active' | 'unavailable'
export type FeatureSessionSnapshot = FeatureSurfaceRuntimeSnapshot | undefined
export type FeatureSessionChangedListener = (
  snapshot: FeatureSessionSnapshot,
) => void

/** Surface ownership required by the app-scoped Session coordinator. */
export interface FeatureSessionSurfaceRuntime extends FeatureSurfaceRuntimePort {
  dispose(): Promise<void>
}

/** Narrow seam consumed by Product/controller composition. */
export interface FeatureSessionRuntimePort {
  activate(
    source: unknown,
    viewport: LayoutViewport,
  ): Promise<FeatureSessionActivationResult>
  resize(viewport: LayoutViewport): Promise<void>
  themeChanged(): Promise<void>
  snapshot(): FeatureSessionSnapshot
  onChanged(listener: FeatureSessionChangedListener): () => void
  deactivate(): Promise<void>
  dispose(): Promise<void>
}

interface SessionTarget {
  readonly source: unknown
  readonly scope: ResourceScope
  readonly capabilities: RuntimeSessionCapabilityResolver
}

interface ActiveSessionBinding {
  target: SessionTarget
  readonly feature: FeatureSessionBindingLease
  readonly surface: FeatureSurfaceSessionLease
  viewport: LayoutViewport
  snapshot: FeatureSurfaceRuntimeSnapshot
  epoch: number
  stopSurface: (() => void) | undefined
  releaseTask: Promise<void> | undefined
}

/**
 * App-scoped transaction boundary for Session Features and their surfaces.
 *
 * A Session becomes observable only after both bindings are ready. Switching
 * releases Surface before Feature, and a failed switch rebuilds the previous
 * binding from its cached DSH-free carriers.
 */
export class FeatureSessionRuntime implements FeatureSessionRuntimePort {
  private readonly listeners = new Set<FeatureSessionChangedListener>()
  private current: ActiveSessionBinding | undefined
  private currentSnapshot: FeatureSessionSnapshot
  private operation: Promise<void> = Promise.resolve()
  private requestedEpoch = 0
  private disposeTask: Promise<void> | undefined
  private disposed = false

  constructor(
    private readonly features: DshTuiFeatureService,
    private readonly surfaces: FeatureSessionSurfaceRuntime,
  ) {}

  activate(
    source: unknown,
    viewport: LayoutViewport,
  ): Promise<FeatureSessionActivationResult> {
    this.assertUsable()
    const epoch = ++this.requestedEpoch
    const target = sessionTargetOf(source)
    const requestedViewport = freezeViewport(viewport)
    return this.enqueue(async () => {
      if (!this.isCurrent(epoch)) return 'unavailable'
      if (target === undefined) {
        await this.makeUnavailable(epoch)
        return 'unavailable'
      }
      return this.activateTarget(target, requestedViewport, epoch)
    })
  }

  resize(viewport: LayoutViewport): Promise<void> {
    this.assertUsable()
    const requestedViewport = freezeViewport(viewport)
    return this.enqueue(async () => {
      const binding = this.current
      if (binding === undefined || sameViewport(binding.viewport, requestedViewport)) return
      await binding.surface.resize(requestedViewport)
      if (this.current !== binding || binding.epoch !== this.requestedEpoch) return
      binding.viewport = requestedViewport
      binding.snapshot = binding.surface.snapshot()
      this.publish(binding.snapshot)
    })
  }

  themeChanged(): Promise<void> {
    this.assertUsable()
    return this.enqueue(async () => {
      const binding = this.current
      if (binding === undefined) return
      await binding.surface.themeChanged()
      if (this.current !== binding || binding.epoch !== this.requestedEpoch) return
      binding.snapshot = binding.surface.snapshot()
      this.publish(binding.snapshot)
    })
  }

  snapshot(): FeatureSessionSnapshot {
    return this.currentSnapshot
  }

  onChanged(listener: FeatureSessionChangedListener): () => void {
    this.assertUsable()
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  deactivate(): Promise<void> {
    if (this.disposed) return this.disposeTask!
    const epoch = ++this.requestedEpoch
    return this.enqueue(async () => {
      if (!this.isCurrent(epoch)) return
      const binding = this.takeCurrent()
      try {
        if (binding !== undefined) await this.releaseBinding(binding)
      } finally {
        if (this.isCurrent(epoch)) this.publish(undefined)
      }
    })
  }

  dispose(): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.disposed = true
    ++this.requestedEpoch
    this.disposeTask = this.enqueue(() => this.disposeNow())
    return this.disposeTask
  }

  private async activateTarget(
    target: SessionTarget,
    viewport: LayoutViewport,
    epoch: number,
  ): Promise<FeatureSessionActivationResult> {
    const current = this.current
    if (current !== undefined && sameTarget(current.target, target)) {
      current.epoch = epoch
      current.target = target
      if (sameViewport(current.viewport, viewport)) return 'active'
      try {
        await current.surface.resize(viewport)
      } catch (error: unknown) {
        if (!this.isCurrent(epoch)) return 'unavailable'
        throw error
      }
      if (!this.isCurrent(epoch) || this.current !== current) return 'unavailable'
      current.viewport = viewport
      current.snapshot = current.surface.snapshot()
      this.publish(current.snapshot)
      return 'active'
    }

    const previous = this.takeCurrent()
    try {
      if (previous !== undefined) await this.releaseBinding(previous)
      if (!this.isCurrent(epoch)) return 'unavailable'
      const next = await this.bindTarget(target, viewport, epoch)
      if (!this.isCurrent(epoch)) {
        await this.releaseQuietly(next)
        return 'unavailable'
      }
      this.commit(next, epoch)
      return 'active'
    } catch (error: unknown) {
      if (!this.isCurrent(epoch)) return 'unavailable'
      if (previous === undefined) {
        this.publish(undefined)
        throw error
      }

      let restored: ActiveSessionBinding
      try {
        restored = await this.bindTarget(
          previous.target,
          previous.viewport,
          epoch,
        )
      } catch (rollbackError: unknown) {
        if (!this.isCurrent(epoch)) return 'unavailable'
        this.publish(undefined)
        throw new AggregateError(
          [error, rollbackError],
          'Feature Session activation and rollback failed',
        )
      }
      if (!this.isCurrent(epoch)) {
        await this.releaseQuietly(restored)
        return 'unavailable'
      }
      this.commit(restored, epoch)
      throw error
    }
  }

  private async bindTarget(
    target: SessionTarget,
    viewport: LayoutViewport,
    epoch: number,
  ): Promise<ActiveSessionBinding> {
    let feature: FeatureSessionBindingLease | undefined
    let surface: FeatureSurfaceSessionLease | undefined
    try {
      feature = await this.features.bindSession({
        scope: target.scope,
        capabilities: createSessionFeatureCapabilityResolver(
          target.scope,
          target.capabilities,
        ),
      })
      if (!this.isCurrent(epoch)) {
        throw new Error('Feature Session binding was superseded')
      }
      surface = this.surfaces.bindSession(target.scope, viewport)
      await surface.ready
      const binding: ActiveSessionBinding = {
        target,
        feature,
        surface,
        viewport,
        snapshot: surface.snapshot(),
        epoch,
        stopSurface: undefined,
        releaseTask: undefined,
      }
      binding.stopSurface = surface.onChanged((snapshot) => {
        if (this.current !== binding || binding.epoch !== this.requestedEpoch) return
        binding.snapshot = snapshot
        this.publish(snapshot)
      })
      binding.snapshot = surface.snapshot()
      return binding
    } catch (error: unknown) {
      const cleanupErrors: unknown[] = []
      if (surface !== undefined) {
        try {
          await surface.release()
        } catch (cleanupError: unknown) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (feature !== undefined) {
        try {
          await feature.release()
        } catch (cleanupError: unknown) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (cleanupErrors.length !== 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'Feature Session binding cleanup failed',
        )
      }
      throw error
    }
  }

  private commit(binding: ActiveSessionBinding, epoch: number): void {
    binding.epoch = epoch
    this.current = binding
    this.publish(binding.snapshot)
  }

  private takeCurrent(): ActiveSessionBinding | undefined {
    const binding = this.current
    this.current = undefined
    return binding
  }

  private releaseBinding(binding: ActiveSessionBinding): Promise<void> {
    binding.releaseTask ??= (async () => {
      const errors: unknown[] = []
      const stopSurface = binding.stopSurface!
      binding.stopSurface = undefined
      try {
        stopSurface()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await binding.surface.release()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await binding.feature.release()
      } catch (error: unknown) {
        errors.push(error)
      }
      if (errors.length !== 0) {
        throw new AggregateError(errors, 'Feature Session release failed')
      }
    })()
    return binding.releaseTask
  }

  private async releaseQuietly(binding: ActiveSessionBinding): Promise<void> {
    try {
      await this.releaseBinding(binding)
    } catch {
      // A superseded transaction must not overwrite or reject the newer epoch.
    }
  }

  private async makeUnavailable(epoch: number): Promise<void> {
    const binding = this.takeCurrent()
    if (binding !== undefined) await this.releaseQuietly(binding)
    if (this.isCurrent(epoch)) this.publish(undefined)
  }

  private async disposeNow(): Promise<void> {
    const errors: unknown[] = []
    const binding = this.takeCurrent()
    if (binding !== undefined) {
      try {
        await this.releaseBinding(binding)
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    this.publish(undefined)
    try {
      await this.surfaces.dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
    this.listeners.clear()
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'Feature Session runtime disposal failed')
    }
  }

  private publish(snapshot: FeatureSessionSnapshot): void {
    if (Object.is(this.currentSnapshot, snapshot)) return
    this.currentSnapshot = snapshot
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot)
      } catch {
        // A renderer/listener failure must not poison Session ownership.
      }
    }
  }

  private enqueue<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    const task = this.operation.then(operation, operation)
    this.operation = task.then(() => {}, () => {})
    return task
  }

  private isCurrent(epoch: number): boolean {
    return !this.disposed && epoch === this.requestedEpoch
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Feature Session runtime is disposed')
  }
}

/** Adapt one runtime Session capability carrier to the Feature kernel seam. */
export function createSessionFeatureCapabilityResolver(
  sessionScope: ResourceScope,
  capabilities: RuntimeSessionCapabilityResolver,
): FeatureCapabilityResolver {
  const resolve = <TValue>(
    token: CapabilityToken<TValue>,
    requestedScope: ResourceScope,
  ): Promise<CapabilityLease<TValue>> => {
    if (token.scope !== 'session' || requestedScope !== sessionScope) {
      throw new Error(
        `Session capability resolver rejected "${token.id}" outside its session scope`,
      )
    }
    return capabilities.acquire(token)
  }
  return Object.freeze({ resolve })
}

function sessionTargetOf(source: unknown): SessionTarget | undefined {
  const scope = runtimeSessionScopeOf(source)
  const capabilities = runtimeSessionCapabilitiesOf(source)
  if (scope === undefined || capabilities === undefined) return undefined
  return Object.freeze({ source, scope, capabilities })
}

function sameTarget(left: SessionTarget, right: SessionTarget): boolean {
  return left.scope === right.scope && left.capabilities === right.capabilities
}

function freezeViewport(viewport: LayoutViewport): LayoutViewport {
  return Object.freeze({ columns: viewport.columns, rows: viewport.rows })
}

function sameViewport(left: LayoutViewport, right: LayoutViewport): boolean {
  return left.columns === right.columns && left.rows === right.rows
}
