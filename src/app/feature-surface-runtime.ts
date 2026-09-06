import type {
  FeatureHostSnapshot,
  ProjectedFeatureResource,
} from './feature-host.ts'
import type { SlotContribution } from '../layout/slots.ts'
import {
  resolveLayout,
  type LayoutPlan,
  type LayoutRegion,
  type LayoutViewport,
} from '../layout/strategy.ts'
import type { ResourceScope } from '../lifecycle/scope-manager.ts'
import type { DshTuiLayoutMode } from '../preferences/contracts.ts'
import {
  ResourceCoordinator,
  type ResourceDefinition,
  type ResourceSnapshot,
} from '../resource/resource-coordinator.ts'

export interface FeatureSurfaceHostPort {
  snapshot(): FeatureHostSnapshot
  onChanged(listener: (snapshot: FeatureHostSnapshot) => void): () => void
}

export interface FeatureSurfaceResourceSnapshot {
  readonly id: string
  readonly definition: ResourceDefinition<unknown>
  readonly state: ResourceSnapshot<unknown>
}

export interface ActiveFeatureSurfaceSnapshot {
  readonly featureId: string
  readonly open: boolean
  readonly visible: boolean
  readonly scopeEpoch: number
  readonly resources: readonly FeatureSurfaceResourceSnapshot[]
}

export interface FeatureSurfaceRuntimeSnapshot {
  readonly host: FeatureHostSnapshot
  readonly layout: LayoutPlan
  readonly surfaces: readonly ActiveFeatureSurfaceSnapshot[]
}

export interface FeatureSurfaceSessionLease {
  readonly active: boolean
  readonly ready: Promise<void>
  snapshot(): FeatureSurfaceRuntimeSnapshot
  onChanged(listener: (snapshot: FeatureSurfaceRuntimeSnapshot) => void): () => void
  resize(viewport: LayoutViewport): Promise<void>
  themeChanged(): Promise<void>
  settled(): Promise<void>
  release(): Promise<void>
}

/** Narrow product/controller seam; concrete ownership stays in Product scope. */
export interface FeatureSurfaceRuntimePort {
  bindSession(
    sessionScope: ResourceScope,
    viewport: LayoutViewport,
  ): FeatureSurfaceSessionLease
}

interface ActiveResource {
  readonly contribution: ProjectedFeatureResource
  state: ResourceSnapshot<unknown>
  stop: () => void
}

interface ActiveSurface {
  readonly featureId: string
  readonly scope: ResourceScope
  readonly resources: Map<string, ActiveResource>
  open: boolean
  visible: boolean
}

interface SurfaceBinding {
  readonly sessionScope: ResourceScope
  readonly surfaces: Map<string, ActiveSurface>
  readonly listeners: Set<(snapshot: FeatureSurfaceRuntimeSnapshot) => void>
  active: boolean
  viewport: LayoutViewport
  host: FeatureHostSnapshot
  layout: LayoutPlan
  current: FeatureSurfaceRuntimeSnapshot
  stopHost: (() => void) | undefined
  ready: Promise<void> | undefined
  releaseTask: Promise<void> | undefined
}

/**
 * App-scoped bridge from activated Feature contributions to visible surfaces.
 * It owns no DSH/Cordis values and never reads or invokes a LayoutRegion node.
 */
export class FeatureSurfaceRuntime implements FeatureSurfaceRuntimePort {
  private readonly coordinator: ResourceCoordinator
  private binding: SurfaceBinding | undefined
  private operation: Promise<void> = Promise.resolve()
  private lastTask: Promise<void> = Promise.resolve()
  private disposeTask: Promise<void> | undefined
  private disposed = false

  constructor(
    private readonly host: FeatureSurfaceHostPort,
    coordinator: ResourceCoordinator = new ResourceCoordinator(),
    private readonly layoutPreference: () => DshTuiLayoutMode = () => 'auto',
  ) {
    this.coordinator = coordinator
  }

  bindSession(
    sessionScope: ResourceScope,
    viewport: LayoutViewport,
  ): FeatureSurfaceSessionLease {
    if (this.disposed) throw new Error('Feature surface runtime is disposed')
    if (this.binding !== undefined) {
      throw new Error('Feature surface runtime already has an active session')
    }
    if (sessionScope.kind !== 'session' || sessionScope.disposed) {
      throw new Error('Feature surface runtime requires a session scope')
    }

    const host = this.host.snapshot()
    const layout = resolveLayout(viewport, host.navigation.route, [], this.layoutPreference())
    const binding: SurfaceBinding = {
      sessionScope,
      surfaces: new Map(),
      listeners: new Set(),
      active: true,
      viewport,
      host,
      layout,
      current: Object.freeze({ host, layout, surfaces: Object.freeze([]) }),
      stopHost: undefined,
      ready: undefined,
      releaseTask: undefined,
    }
    this.binding = binding
    binding.stopHost = this.host.onChanged((snapshot) => {
      const task = this.enqueue(() => this.reconcile(binding, snapshot))
      void task.catch(() => {})
    })
    binding.ready = this.enqueue(() => this.reconcile(binding, host))

    const runtime = this
    return Object.freeze({
      get active() {
        return binding.active
      },
      get ready() {
        return binding.ready!
      },
      snapshot: () => {
        runtime.refreshLayout(binding)
        binding.current = freezeRuntimeSnapshot(binding)
        return binding.current
      },
      onChanged: (listener: (snapshot: FeatureSurfaceRuntimeSnapshot) => void) => {
        runtime.assertActive(binding)
        binding.listeners.add(listener)
        return () => { binding.listeners.delete(listener) }
      },
      resize: async (nextViewport: LayoutViewport) => {
        runtime.assertActive(binding)
        await runtime.enqueue(async () => {
          binding.viewport = nextViewport
          await runtime.reconcile(binding, binding.host)
        })
      },
      themeChanged: async () => {
        runtime.assertActive(binding)
        await runtime.enqueue(() => runtime.reconcile(binding, binding.host))
      },
      settled: () => runtime.lastTask,
      release: () => runtime.releaseBinding(binding),
    })
  }

  dispose(): Promise<void> {
    this.disposeTask ??= this.disposeNow()
    return this.disposeTask
  }

  private async disposeNow(): Promise<void> {
    this.disposed = true
    const binding = this.binding
    if (binding !== undefined) await this.releaseBinding(binding)
  }

  private releaseBinding(binding: SurfaceBinding): Promise<void> {
    if (binding.releaseTask !== undefined) return binding.releaseTask
    binding.active = false
    binding.stopHost!()
    binding.listeners.clear()
    binding.releaseTask = this.enqueue(async () => {
      for (const surface of [...binding.surfaces.values()].reverse()) {
        await this.disposeSurface(surface, 'feature surface session released')
      }
      binding.surfaces.clear()
      this.binding = undefined
    })
    return binding.releaseTask
  }

  private async reconcile(
    binding: SurfaceBinding,
    host: FeatureHostSnapshot,
  ): Promise<void> {
    if (!binding.active) return
    const contributions = selectRegionContributions(host)
    const regions = contributions.map(contribution => detachedRegion(contribution.value))
    const layout = resolveLayout(binding.viewport, host.navigation.route, regions, this.layoutPreference())
    binding.host = host
    binding.layout = layout

    const open = openFeatureIds(host)
    const visible = visibleFeatureIds(layout, contributions)
    const desired = new Set([...open, ...visible])

    for (const surface of [...binding.surfaces.values()].reverse()) {
      if (desired.has(surface.featureId)) continue
      binding.surfaces.delete(surface.featureId)
      await this.disposeSurface(surface, 'feature surface hidden')
    }

    for (const featureId of [...desired].sort()) {
      let surface = binding.surfaces.get(featureId)
      if (surface === undefined) {
        surface = {
          featureId,
          scope: binding.sessionScope.child('surface', featureId),
          resources: new Map(),
          open: open.has(featureId),
          visible: visible.has(featureId),
        }
        binding.surfaces.set(featureId, surface)
      } else {
        surface.open = open.has(featureId)
        surface.visible = visible.has(featureId)
      }
      await this.reconcileResources(binding, surface, host.resources)
    }
    this.publish(binding)
  }

  private async reconcileResources(
    binding: SurfaceBinding,
    surface: ActiveSurface,
    resources: readonly ProjectedFeatureResource[],
  ): Promise<void> {
    const desired = new Map(resources
      .filter(resource => resource.featureId === surface.featureId)
      .filter(resource => resource.definition.activation === 'on-open'
        ? surface.open
        : resource.definition.activation === 'on-visible' && surface.visible)
      .map(resource => [resource.id, resource] as const))

    for (const [id, active] of [...surface.resources]) {
      const next = desired.get(id)
      if (next?.definition === active.contribution.definition) continue
      active.stop()
      surface.resources.delete(id)
      await this.coordinator.release(surface.scope, active.contribution.definition)
    }

    for (const [id, contribution] of desired) {
      if (surface.resources.has(id)) continue
      let active!: ActiveResource
      const stop = this.coordinator.subscribe(
        surface.scope,
        contribution.definition,
        (state) => {
          active.state = state
          this.publish(binding)
        },
      )
      active = {
        contribution,
        state: this.coordinator.get(surface.scope, contribution.definition),
        stop,
      }
      surface.resources.set(id, active)
      void this.coordinator.activate(surface.scope, contribution.definition)
    }
  }

  private async disposeSurface(surface: ActiveSurface, reason: string): Promise<void> {
    for (const active of surface.resources.values()) active.stop()
    surface.resources.clear()
    await surface.scope.dispose(reason)
  }

  private refreshLayout(binding: SurfaceBinding): void {
    binding.layout = resolveLayout(binding.viewport, binding.host.navigation.route,
      selectRegionContributions(binding.host).map(contribution => detachedRegion(contribution.value)),
      this.layoutPreference())
  }

  private publish(binding: SurfaceBinding): void {
    this.refreshLayout(binding)
    binding.current = freezeRuntimeSnapshot(binding)
    for (const listener of [...binding.listeners]) {
      try {
        listener(binding.current)
      } catch {
        // A renderer failure must not poison scope or resource ownership.
      }
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.operation.then(operation, operation)
    this.lastTask = task
    this.operation = task.then(() => {}, () => {})
    return task
  }

  private assertActive(binding: SurfaceBinding): void {
    if (!binding.active) throw new Error('Feature surface session is released')
  }
}

function routeFeatureId(snapshot: FeatureHostSnapshot): string | undefined {
  const route = snapshot.navigation.route
  return route.kind === 'chat'
    ? snapshot.routes.find(candidate => candidate.route.kind === 'chat')?.featureId
    : route.featureId
}

function openFeatureIds(snapshot: FeatureHostSnapshot): ReadonlySet<string> {
  const result = new Set<string>()
  const routeOwner = routeFeatureId(snapshot)
  if (routeOwner !== undefined) result.add(routeOwner)
  for (const overlay of snapshot.navigation.overlays) result.add(overlay.featureId)
  return result
}

function selectRegionContributions(
  snapshot: FeatureHostSnapshot,
): readonly SlotContribution<LayoutRegion>[] {
  const routeOwner = routeFeatureId(snapshot)
  const overlays = new Set(snapshot.navigation.overlays.map(overlay => overlay.featureId))
  return snapshot.slots.contributions.filter((contribution) => {
    if (contribution.slotId === 'shell.overlay'
      || contribution.slotId === 'shell.interaction') {
      return overlays.has(contribution.featureId)
    }
    if (contribution.slotId.startsWith('workspace.')) {
      return snapshot.navigation.route.kind !== 'chat'
        && contribution.featureId === routeOwner
    }
    return true
  })
}

function visibleFeatureIds(
  plan: LayoutPlan,
  contributions: readonly SlotContribution<LayoutRegion>[],
): ReadonlySet<string> {
  const visible = new Set(plan.placements.map(placement => placement.region.id))
  return new Set(contributions
    .filter(contribution => visible.has(contribution.value.id))
    .map(contribution => contribution.featureId))
}

function detachedRegion(region: LayoutRegion): LayoutRegion {
  if (region.role !== 'inspector') return region
  const node = region.node as { hasContent?: () => boolean } | null | undefined
  if (typeof node?.hasContent !== 'function') return region
  return Object.freeze({ ...region, hasContent: node.hasContent() })
}

function freezeRuntimeSnapshot(binding: SurfaceBinding): FeatureSurfaceRuntimeSnapshot {
  const surfaces = [...binding.surfaces.values()]
    .sort((left, right) => left.featureId.localeCompare(right.featureId))
    .map(surface => Object.freeze({
      featureId: surface.featureId,
      open: surface.open,
      visible: surface.visible,
      scopeEpoch: surface.scope.epoch,
      resources: Object.freeze([...surface.resources.values()].map(resource => Object.freeze({
        id: resource.contribution.id,
        definition: resource.contribution.definition,
        state: resource.state,
      }))),
    }))
  return Object.freeze({
    host: binding.host,
    layout: binding.layout,
    surfaces: Object.freeze(surfaces),
  })
}
