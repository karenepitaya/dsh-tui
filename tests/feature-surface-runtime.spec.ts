import { describe, expect, it, vi } from 'vitest'
import type {
  FeatureHostSnapshot,
  ProjectedFeatureResource,
} from '../src/app/feature-host.ts'
import {
  FeatureSurfaceRuntime,
  type FeatureSurfaceHostPort,
} from '../src/app/feature-surface-runtime.ts'
import {
  contributeToSlot,
  createSlotRegistry,
  type SlotContribution,
} from '../src/layout/slots.ts'
import type { LayoutRegion, LayoutViewport } from '../src/layout/strategy.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import {
  createNavigationState,
  transitionNavigation,
  type NavigationRoute,
} from '../src/navigation/state.ts'
import type { ResourceDefinition } from '../src/resource/resource-coordinator.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

class MutableHost implements FeatureSurfaceHostPort {
  private readonly listeners = new Set<(snapshot: FeatureHostSnapshot) => void>()

  constructor(private current: FeatureHostSnapshot) {}

  snapshot(): FeatureHostSnapshot {
    return this.current
  }

  onChanged(listener: (snapshot: FeatureHostSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(snapshot: FeatureHostSnapshot): void {
    this.current = snapshot
    for (const listener of this.listeners) listener(snapshot)
  }
}

const CHAT_ROOT: LayoutRegion = Object.freeze({
  id: 'chat.root',
  role: 'timeline',
  node: Object.freeze({ kind: 'chat' }),
})
const WORKSPACE_CONTENT: LayoutRegion = Object.freeze({
  id: 'sessions.content',
  role: 'content',
  node: Object.freeze({ kind: 'sessions' }),
})

function hostSnapshot(
  route: NavigationRoute,
  resources: readonly ProjectedFeatureResource[] = [],
  additions: readonly SlotContribution<LayoutRegion>[] = [],
): FeatureHostSnapshot {
  const contributions: readonly SlotContribution<LayoutRegion>[] = [
    {
      slotId: 'shell.root',
      featureId: 'legacy.chat',
      authority: 'core',
      contributionId: CHAT_ROOT.id,
      value: CHAT_ROOT,
    },
    {
      slotId: 'workspace.content',
      featureId: 'sessions',
      authority: 'extension',
      contributionId: WORKSPACE_CONTENT.id,
      value: WORKSPACE_CONTENT,
    },
    ...additions,
  ]
  let slots = createSlotRegistry<LayoutRegion>()
  for (const contribution of contributions) slots = contributeToSlot(slots, contribution)
  const navigation = route.kind === 'chat'
    ? createNavigationState()
    : transitionNavigation(createNavigationState(), { type: 'navigate', route }).state
  return Object.freeze({
    navigation,
    routes: Object.freeze([
      Object.freeze({ id: 'chat', featureId: 'legacy.chat', route: { kind: 'chat' } as const }),
      Object.freeze({
        id: 'sessions.route',
        featureId: 'sessions',
        route: { kind: 'workspace', featureId: 'sessions', pane: 'content' } as const,
      }),
    ]),
    commands: Object.freeze([]),
    resources: Object.freeze([...resources]),
    slots,
    regions: Object.freeze(slots.contributions.map(item => item.value)),
    issues: Object.freeze([]),
  })
}

function withOverlay(
  snapshot: FeatureHostSnapshot,
  featureId: string,
  overlayId: string,
): FeatureHostSnapshot {
  const navigation = transitionNavigation(snapshot.navigation, {
    type: 'push-overlay',
    overlay: { id: overlayId, kind: 'custom', featureId },
  }).state
  return Object.freeze({ ...snapshot, navigation })
}

function projectedResource(
  featureId: string,
  id: string,
  definition: ResourceDefinition<unknown>,
): ProjectedFeatureResource {
  return Object.freeze({ featureId, id, definition })
}

describe('FeatureSurfaceRuntime', () => {
  it('snapshots live inspector availability without loading resources or projecting its node', async () => {
    const manager = new ScopeManager()
    let available = false
    const project = vi.fn()
    const inspector: LayoutRegion = { id: 'sessions.inspector', role: 'inspector', node: { hasContent: () => available, project } }
    const navigator: LayoutRegion = { id: 'sessions.navigator', role: 'navigator', node: {} }
    const additions: SlotContribution<LayoutRegion>[] = [inspector, navigator].map(region => ({
      slotId: `workspace.${region.role}`, featureId: 'sessions', authority: 'extension', contributionId: region.id, value: region,
    }))
    const host = new MutableHost(hostSnapshot({ kind: 'workspace', featureId: 'sessions', pane: 'content' }, [], additions))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(manager.createSession('details'), { columns: 140, rows: 20 })
    await lease.ready
    expect(lease.snapshot().layout.placements.map(placement => placement.area)).toEqual(['navigator', 'content'])
    available = true
    expect(lease.snapshot().layout.placements.map(placement => placement.area)).toEqual(['navigator', 'content', 'inspector'])
    expect(lease.snapshot().layout.placements.at(-1)?.region).toMatchObject({ hasContent: true })
    expect(lease.snapshot().surfaces[0]?.visible).toBe(true)
    expect(project).not.toHaveBeenCalled()
    await runtime.dispose()
    await manager.dispose()
  })
  it('leaves unopened resources cold, opens once, survives resize/theme, and closes exactly once', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const pending = deferred<string>()
    const stopOpen = vi.fn()
    const stopVisible = vi.fn()
    const openSignals: AbortSignal[] = []
    const visibleLoad = vi.fn(() => 'visible')
    const manualLoad = vi.fn(() => 'manual')
    const onOpen: ResourceDefinition<unknown> = {
      key: 'sessions.open',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load: ({ signal }) => {
        openSignals.push(signal)
        return pending.promise
      },
      watch: () => stopOpen,
    }
    const onVisible: ResourceDefinition<unknown> = {
      key: 'sessions.visible',
      lifetime: 'surface',
      activation: 'on-visible',
      cachePolicy: 'none',
      load: visibleLoad,
      watch: () => stopVisible,
    }
    const resources = [
      projectedResource('sessions', 'sessions.open', onOpen),
      projectedResource('sessions', 'sessions.visible', onVisible),
      projectedResource('sessions', 'sessions.manual', {
        key: 'sessions.manual',
        lifetime: 'surface',
        activation: 'manual',
        cachePolicy: 'none',
        load: manualLoad,
      }),
    ]
    const host = new MutableHost(hostSnapshot({ kind: 'chat' }, resources))
    let layoutPreference: 'auto' | 'single' = 'auto'
    const runtime = new FeatureSurfaceRuntime(host, undefined, () => layoutPreference)
    const lease = runtime.bindSession(session, { columns: 120, rows: 40 })
    await lease.ready

    expect(openSignals).toHaveLength(0)
    expect(visibleLoad).not.toHaveBeenCalled()
    expect(manualLoad).not.toHaveBeenCalled()

    host.set(hostSnapshot({
      kind: 'workspace', featureId: 'sessions', pane: 'content',
    }, resources))
    await lease.settled()
    await Promise.resolve()
    expect(openSignals).toHaveLength(1)
    expect(visibleLoad).toHaveBeenCalledOnce()
    expect(manualLoad).not.toHaveBeenCalled()
    expect(lease.snapshot().surfaces).toEqual([
      expect.objectContaining({ featureId: 'sessions', open: true, visible: true }),
    ])

    const resizes: Promise<void>[] = []
    for (let index = 0; index < 100; index += 1) {
      const viewport: LayoutViewport = {
        columns: index % 2 === 0 ? 110 : 130,
        rows: 30 + (index % 5),
      }
      resizes.push(lease.resize(viewport))
    }
    await Promise.all(resizes)
    await lease.resize({ columns: 160, rows: 40 })
    expect(lease.snapshot().layout.mode).toBe('split')
    layoutPreference = 'single'
    await lease.themeChanged()
    expect(lease.snapshot().layout.mode).toBe('single')
    expect(openSignals).toHaveLength(1)
    expect(visibleLoad).toHaveBeenCalledOnce()

    host.set(hostSnapshot({ kind: 'chat' }, resources))
    await lease.settled()
    expect(openSignals[0]?.aborted).toBe(true)
    expect(stopOpen).toHaveBeenCalledOnce()
    expect(stopVisible).toHaveBeenCalledOnce()
    expect(lease.snapshot().surfaces.some(surface => surface.featureId === 'sessions')).toBe(false)

    const changeCount = vi.fn()
    const stopListening = lease.onChanged(changeCount)
    pending.resolve('too late')
    await Promise.resolve()
    await Promise.resolve()
    expect(lease.snapshot().surfaces.some(surface => surface.featureId === 'sessions')).toBe(false)
    expect(changeCount).not.toHaveBeenCalled()
    stopListening()

    await lease.release()
    await lease.release()
    await runtime.dispose()
    await manager.dispose()
  })

  it('ties on-visible resources to actual layout visibility and keeps Chat hidden across Workspace breakpoints', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const stop = vi.fn()
    const load = vi.fn(() => 'chat projection')
    const definition: ResourceDefinition<unknown> = {
      key: 'chat.visible',
      lifetime: 'surface',
      activation: 'on-visible',
      cachePolicy: 'last-good',
      load,
      watch: () => stop,
    }
    const resources = [projectedResource('legacy.chat', 'chat.visible', definition)]
    const host = new MutableHost(hostSnapshot({ kind: 'chat' }, resources))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(session, { columns: 160, rows: 40 })
    await lease.ready
    await Promise.resolve()
    expect(load).toHaveBeenCalledOnce()
    expect(lease.snapshot().surfaces).toContainEqual(
      expect.objectContaining({ featureId: 'legacy.chat', open: true, visible: true }),
    )

    host.set(hostSnapshot({ kind: 'workspace', featureId: 'sessions', pane: 'content' }, resources))
    await lease.settled()
    await lease.resize({ columns: 120, rows: 40 })
    expect(stop).toHaveBeenCalledOnce()
    expect(lease.snapshot().surfaces.some(surface => surface.featureId === 'legacy.chat')).toBe(false)

    await lease.resize({ columns: 160, rows: 40 })
    expect(load).toHaveBeenCalledOnce()
    host.set(hostSnapshot({ kind: 'chat' }, resources))
    await lease.settled()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    await runtime.dispose()
    expect(stop).toHaveBeenCalledTimes(2)
    await manager.dispose()
  })

  it('contains listener failure and enforces one live session binding', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const withoutChatOwner = Object.freeze({
      ...hostSnapshot({ kind: 'chat' }),
      routes: Object.freeze([]),
    })
    const host = new MutableHost(withoutChatOwner)
    const runtime = new FeatureSurfaceRuntime(host)
    expect(() => runtime.bindSession(manager.app, { columns: 80, rows: 20 }))
      .toThrow('requires a session scope')
    const lease = runtime.bindSession(session, { columns: 80, rows: 20 })
    expect(() => runtime.bindSession(session, { columns: 80, rows: 20 }))
      .toThrow('already has an active session')
    const throwing = lease.onChanged(() => { throw new Error('renderer failed') })
    await lease.ready
    await expect(lease.resize({ columns: 81, rows: 21 })).resolves.toBeUndefined()
    throwing()
    const pendingResize = lease.resize({ columns: 82, rows: 22 })
    const pendingRelease = lease.release()
    await Promise.all([pendingResize, pendingRelease])
    expect(lease.active).toBe(false)
    expect(() => lease.onChanged(() => {})).toThrow('surface session is released')
    await expect(lease.resize({ columns: 83, rows: 23 })).rejects.toThrow(
      'surface session is released',
    )
    await runtime.dispose()
    await runtime.dispose()
    expect(() => runtime.bindSession(session, { columns: 80, rows: 20 }))
      .toThrow('surface runtime is disposed')
    await manager.dispose()
  })

  it('replaces a changed definition inside a still-open surface', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const firstStop = vi.fn()
    const secondStop = vi.fn()
    const firstLoad = vi.fn(() => 'first')
    const secondLoad = vi.fn(() => 'second')
    const first: ResourceDefinition<unknown> = {
      key: 'sessions.catalog',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load: firstLoad,
      watch: () => firstStop,
    }
    const second: ResourceDefinition<unknown> = {
      ...first,
      load: secondLoad,
      watch: () => secondStop,
    }
    const route = { kind: 'workspace', featureId: 'sessions', pane: 'content' } as const
    const host = new MutableHost(hostSnapshot(route, [
      projectedResource('sessions', 'sessions.catalog', first),
    ]))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(session, { columns: 120, rows: 40 })
    await lease.ready
    await Promise.resolve()

    host.set(hostSnapshot(route, [
      projectedResource('sessions', 'sessions.catalog', second),
    ]))
    await lease.settled()
    await Promise.resolve()

    expect(firstLoad).toHaveBeenCalledOnce()
    expect(firstStop).toHaveBeenCalledOnce()
    expect(secondLoad).toHaveBeenCalledOnce()
    host.set(hostSnapshot(route, []))
    await lease.settled()
    expect(secondStop).toHaveBeenCalledOnce()
    await runtime.dispose()
    expect(secondStop).toHaveBeenCalledOnce()
    await manager.dispose()
  })

  it('projects only the opened overlay owner and never invokes region nodes', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const nodeRead = vi.fn()
    const openOverlay: LayoutRegion = {
      id: 'question.overlay',
      role: 'overlay',
      get node() {
        nodeRead()
        return { kind: 'question' }
      },
    }
    const closedOverlay: LayoutRegion = {
      id: 'other.overlay',
      role: 'overlay',
      node: { kind: 'other' },
    }
    const closedInteraction: LayoutRegion = {
      id: 'other.interaction',
      role: 'overlay',
      node: { kind: 'interaction' },
    }
    const additions: readonly SlotContribution<LayoutRegion>[] = [
      {
        slotId: 'shell.overlay',
        featureId: 'question',
        authority: 'extension',
        contributionId: openOverlay.id,
        value: openOverlay,
      },
      {
        slotId: 'shell.overlay',
        featureId: 'other',
        authority: 'extension',
        contributionId: closedOverlay.id,
        value: closedOverlay,
      },
      {
        slotId: 'shell.interaction',
        featureId: 'other',
        authority: 'core',
        contributionId: closedInteraction.id,
        value: closedInteraction,
      },
    ]
    const initial = withOverlay(
      hostSnapshot({ kind: 'chat' }, [], additions),
      'question',
      'question.overlay',
    )
    const host = new MutableHost(initial)
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(session, { columns: 120, rows: 40 })
    await lease.ready

    expect(lease.snapshot().layout.placements.map(item => item.region.id))
      .toContain('question.overlay')
    expect(lease.snapshot().layout.placements.map(item => item.region.id))
      .not.toContain('other.overlay')
    expect(lease.snapshot().surfaces).toContainEqual(
      expect.objectContaining({ featureId: 'question', open: true, visible: true }),
    )
    expect(nodeRead).not.toHaveBeenCalled()

    await runtime.dispose()
    await manager.dispose()
  })

  it('reports a malformed host projection through settled without poisoning teardown', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const host = new MutableHost(hostSnapshot({ kind: 'chat' }))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(session, { columns: 120, rows: 40 })
    await lease.ready
    const duplicate: LayoutRegion = {
      id: CHAT_ROOT.id,
      role: 'status',
      node: { kind: 'duplicate' },
    }

    host.set(hostSnapshot({ kind: 'chat' }, [], [{
      slotId: 'shell.status',
      featureId: 'duplicate',
      authority: 'extension',
      contributionId: 'duplicate.status',
      value: duplicate,
    }]))

    await expect(lease.settled()).rejects.toThrow('Duplicate layout region id')
    await expect(lease.release()).resolves.toBeUndefined()
    await runtime.dispose()
    await manager.dispose()
  })
})
