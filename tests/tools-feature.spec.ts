import { describe, expect, it, vi } from 'vitest'
import type { FeatureCommandHandler } from '../src/app/feature-contribution-contract.ts'
import type {
  FeatureHostSnapshot,
  ProjectedFeatureResource,
} from '../src/app/feature-host.ts'
import {
  FeatureSurfaceRuntime,
  type FeatureSurfaceHostPort,
} from '../src/app/feature-surface-runtime.ts'
import {
  TOOLS_FEATURE_ID,
  TOOLS_REFRESH_COMMAND_ID,
  TOOLS_RESOURCE_ID,
  TOOLS_ROUTE_ID,
  createToolsContentNode,
  createToolsFeatureModel,
  createToolsFeatureState,
  createToolsInspectorNode,
  projectToolsBrowser,
  toolsFeature,
  transitionToolsFeature,
  type ToolsFeatureInstance,
  type ToolsFeatureState,
  type ToolsUiNode,
} from '../src/features/tools/index.ts'
import { FeatureRegistry } from '../src/kernel/feature-registry.ts'
import { FeatureSupervisor } from '../src/kernel/feature-supervisor.ts'
import {
  contributeToSlot,
  createSlotRegistry,
  type SlotContribution,
} from '../src/layout/slots.ts'
import type { LayoutRegion } from '../src/layout/strategy.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import {
  createNavigationState,
  transitionNavigation,
  type NavigationRoute,
} from '../src/navigation/state.ts'
import type { ResourceDefinition } from '../src/resource/resource-coordinator.ts'
import { SESSION_TOOLS_CAPABILITY } from '../src/runtime/session-capabilities.ts'
import type { SessionToolsPort, SessionToolsSnapshot } from '../src/tool/port.ts'

function snapshot(overrides: Partial<SessionToolsSnapshot> = {}): SessionToolsSnapshot {
  return {
    available: true,
    stale: false,
    generation: 7,
    tools: [
      {
        name: 'read_file',
        description: '读取 Windows 文件',
        group: 'core',
        parameterNames: ['path', 'encoding'],
        requiredParameterNames: ['path'],
      },
      {
        name: 'mcp__github__create_issue',
        description: 'Create a GitHub issue',
        group: 'mcp',
        parameterNames: ['owner', 'title'],
        requiredParameterNames: ['owner'],
      },
      {
        name: 'run_code',
        description: 'Programmatic tool transport',
        group: 'transport',
        parameterNames: ['code'],
        requiredParameterNames: [],
      },
    ],
    ...overrides,
  }
}

function request(scopeEpoch: number, requestId: number) {
  return { scopeEpoch, requestId }
}

class MutableToolsPort implements SessionToolsPort {
  private readonly listeners = new Set<() => void>()
  readonly stopWatch = vi.fn()
  readonly disposeTools = vi.fn()
  readonly reads = vi.fn(() => this.read())
  snapshotError: unknown | undefined
  afterRead: (() => void) | undefined

  constructor(private value: SessionToolsSnapshot = snapshot()) {}

  toolsSnapshot(): SessionToolsSnapshot {
    return this.reads()
  }

  private read(): SessionToolsSnapshot {
    if (this.snapshotError !== undefined) throw this.snapshotError
    const value = this.value
    this.afterRead?.()
    return value
  }

  set(value: SessionToolsSnapshot): void {
    this.value = value
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  onToolsChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
      this.stopWatch()
    }
  }
}

describe('Tools Feature state and projectors', () => {
  it('loads a detached searchable view and keeps selection stable across generations', () => {
    let state = createToolsFeatureState()
    state = transitionToolsFeature(state, {
      type: 'load.started',
      request: request(3, 1),
    }).state
    state = transitionToolsFeature(state, {
      type: 'load.succeeded',
      request: request(3, 1),
      snapshot: snapshot(),
    }).state
    expect(projectToolsBrowser(state)).toMatchObject({
      totalCount: 3,
      selected: { name: 'read_file' },
      groups: [
        { id: 'core', count: 1 },
        { id: 'mcp', count: 1 },
        { id: 'transport', count: 1 },
      ],
    })
    const source = snapshot()
    expect(state.snapshot?.tools).not.toBe(source.tools)
    expect(state.snapshot?.tools[0]?.parameterNames).not.toBe(source.tools[0]?.parameterNames)

    state = transitionToolsFeature(state, {
      type: 'selection.move',
      direction: 'down',
    }).state
    expect(projectToolsBrowser(state)?.selected?.name).toBe('mcp__github__create_issue')
    state = transitionToolsFeature(state, {
      type: 'snapshot.changed',
      snapshot: snapshot({ generation: 8, tools: [...snapshot().tools].reverse() }),
    }).state
    expect(projectToolsBrowser(state)?.selected?.name).toBe('mcp__github__create_issue')

    state = transitionToolsFeature(state, {
      type: 'query.edit',
      action: { type: 'insert', text: 'github owner' },
    }).state
    expect(projectToolsBrowser(state)?.rows.map(row => row.name))
      .toEqual(['mcp__github__create_issue'])
    expect(transitionToolsFeature(state, {
      type: 'query.edit',
      action: { type: 'move-end' },
    }).state).toBe(state)
    expect(transitionToolsFeature(state, {
      type: 'refresh.requested',
    }).effects).toEqual([{ type: 'resource.refresh', resourceId: TOOLS_RESOURCE_ID }])
  })

  it('retains last-good state and ignores stale or inapplicable transitions', () => {
    const idle = createToolsFeatureState()
    expect(projectToolsBrowser(idle)).toBeUndefined()
    expect(transitionToolsFeature(idle, {
      type: 'selection.move',
      direction: 'down',
    }).state).toBe(idle)
    expect(transitionToolsFeature(idle, {
      type: 'query.edit',
      action: { type: 'insert', text: 'x' },
    }).state).toBe(idle)
    expect(transitionToolsFeature(idle, {
      type: 'load.succeeded',
      request: request(9, 9),
      snapshot: snapshot(),
    }).state).toBe(idle)

    let state = transitionToolsFeature(idle, {
      type: 'load.started',
      request: request(4, 1),
    }).state
    expect(transitionToolsFeature(state, {
      type: 'load.succeeded',
      request: request(3, 1),
      snapshot: snapshot({ tools: [] }),
    }).state).toBe(state)
    expect(transitionToolsFeature(state, {
      type: 'load.failed',
      request: request(3, 1),
      message: 'late',
    }).state).toBe(state)
    state = transitionToolsFeature(state, {
      type: 'load.succeeded',
      request: request(4, 1),
      snapshot: snapshot(),
    }).state
    expect(transitionToolsFeature(state, {
      type: 'selection.move',
      direction: 'up',
    }).state).toBe(state)
    state = transitionToolsFeature(state, {
      type: 'load.started',
      request: request(4, 2),
    }).state
    expect(state.phase).toBe('refreshing')
    state = transitionToolsFeature(state, {
      type: 'load.failed',
      request: request(4, 2),
      message: 'registry failed',
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'registry failed' })
    expect(projectToolsBrowser(state)?.totalCount).toBe(3)

    state = transitionToolsFeature(state, {
      type: 'snapshot.changed',
      snapshot: snapshot({ stale: true, error: 'last-good registry' }),
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'last-good registry' })
    state = transitionToolsFeature(state, {
      type: 'snapshot.failed',
      message: 'snapshot threw',
    }).state
    expect(state.error).toBe('snapshot threw')
  })

  it('isolates model listeners and disposal', () => {
    const model = createToolsFeatureModel()
    const changed = vi.fn()
    const stop = model.onChanged(changed)
    model.onChanged(() => { throw new Error('renderer failed') })
    const effect = vi.fn()
    const stopEffect = model.onEffect(effect)
    model.onEffect(() => { throw new Error('effect adapter failed') })
    model.dispatch({ type: 'snapshot.failed', message: 'offline' })
    expect(changed).toHaveBeenCalledOnce()
    expect(model.dispatch({ type: 'refresh.requested' })).toEqual([
      { type: 'resource.refresh', resourceId: TOOLS_RESOURCE_ID },
    ])
    expect(effect).toHaveBeenCalledOnce()
    model.dispatch({ type: 'selection.move', direction: 'up' })
    stop()
    stop()
    stopEffect()
    stopEffect()
    model.dispose()
    model.dispose()
    expect(() => model.onChanged(vi.fn())).toThrow('disposed')
    expect(() => model.onEffect(vi.fn())).toThrow('disposed')
    expect(() => model.dispatch({ type: 'snapshot.failed', message: 'late' })).toThrow('disposed')
  })

  it('projects compact loading, last-good failure, unavailable, stale, and empty details', () => {
    const project = (state: ToolsFeatureState) => {
      const source = {
        snapshot: () => state,
        onChanged: () => () => {},
      }
      const context = {
        bounds: { x: 0, y: 0, width: 100, height: 20 },
        focus: true,
        mode: 'normal' as const,
        resources: [],
      }
      return [
        createToolsContentNode(source).project(context),
        createToolsInspectorNode(source).project(context),
      ].flatMap(value => value.rows.map(row => row.text)).join('\n')
    }
    const idle = createToolsFeatureState()
    expect(project(idle)).toContain('No tools available')
    expect(project(idle)).toContain('Select a tool')

    const loading = transitionToolsFeature(idle, {
      type: 'load.started', request: request(5, 1),
    }).state
    expect(project(loading)).toContain('Loading tools')

    const failed = transitionToolsFeature(loading, {
      type: 'load.succeeded',
      request: request(5, 1),
      snapshot: snapshot({
        available: false,
        stale: true,
        error: 'registry stale',
        tools: [],
      }),
    }).state
    const failedText = project(failed)
    expect(failedText).toContain('Unavailable')
    expect(failedText).toContain('last-known')
    expect(failedText).toContain('Registry error · registry stale')
    expect(failedText).toContain('Could not load tools · r to retry')

    const refreshing = transitionToolsFeature(failed, {
      type: 'load.started', request: request(5, 2),
    }).state
    expect(project(refreshing)).toContain('Loading tools')

    const emptyContract = transitionToolsFeature(refreshing, {
      type: 'load.succeeded',
      request: request(5, 2),
      snapshot: snapshot({
        tools: [{
          name: 'empty_tool',
          description: 'No inputs',
          group: 'core',
          parameterNames: [],
          requiredParameterNames: [],
        }],
      }),
    }).state
    const detailText = project(emptyContract)
    expect(detailText).toContain('PARAMETERS  none')
    expect(detailText).toContain('REQUIRED  none')
  })
})

class MutableHost implements FeatureSurfaceHostPort {
  private readonly listeners = new Set<(snapshot: FeatureHostSnapshot) => void>()
  constructor(private value: FeatureHostSnapshot) {}
  snapshot(): FeatureHostSnapshot { return this.value }
  onChanged(listener: (snapshot: FeatureHostSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(value: FeatureHostSnapshot): void {
    this.value = value
    for (const listener of this.listeners) listener(value)
  }
}

const CHAT_REGION: LayoutRegion = {
  id: 'legacy.chat.root',
  role: 'timeline',
  node: { kind: 'legacy-chat' },
}

function toolsRoute(): NavigationRoute {
  return { kind: 'workspace', featureId: TOOLS_FEATURE_ID, pane: 'content' }
}

function hostSnapshot(
  route: NavigationRoute,
  instance: ToolsFeatureInstance,
): FeatureHostSnapshot {
  const additions: SlotContribution<LayoutRegion>[] = (
    instance.contributions.surfaces ?? []
  ).map(surface => ({
    slotId: surface.slot,
    featureId: TOOLS_FEATURE_ID,
    authority: 'extension',
    contributionId: surface.id,
    value: surface.value as LayoutRegion,
  }))
  let slots = createSlotRegistry<LayoutRegion>()
  slots = contributeToSlot(slots, {
    slotId: 'shell.root',
    featureId: 'legacy.chat',
    authority: 'core',
    contributionId: CHAT_REGION.id,
    value: CHAT_REGION,
  })
  for (const addition of additions) slots = contributeToSlot(slots, addition)
  const navigation = route.kind === 'chat'
    ? createNavigationState()
    : transitionNavigation(createNavigationState(), { type: 'navigate', route }).state
  const resources: readonly ProjectedFeatureResource[] = (
    instance.contributions.resources ?? []
  ).map(resource => ({
    id: resource.id,
    featureId: TOOLS_FEATURE_ID,
    definition: resource.value as ResourceDefinition<unknown>,
  }))
  return Object.freeze({
    navigation,
    routes: Object.freeze([
      { id: 'chat', featureId: 'legacy.chat', route: { kind: 'chat' } as const },
      ...(instance.contributions.routes ?? []).map(item => ({
        id: item.id,
        featureId: TOOLS_FEATURE_ID,
        route: item.value as NavigationRoute,
      })),
    ]),
    commands: Object.freeze([]),
    resources,
    slots,
    regions: Object.freeze(slots.contributions.map(item => item.value)),
    issues: Object.freeze([]),
  })
}

describe('Tools Feature factory and scoped resource', () => {
  it('declares lazy session ownership without reading the registry during create', async () => {
    const manager = new ScopeManager()
    const port = new MutableToolsPort()
    const instance = await toolsFeature.create({
      scope: manager.createSession('contract'),
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as ToolsFeatureInstance

    expect(toolsFeature.manifest).toMatchObject({
      id: TOOLS_FEATURE_ID,
      scope: 'session',
      activation: 'on-route',
      required: false,
      requires: [SESSION_TOOLS_CAPABILITY],
    })
    expect(toolsFeature.declarations?.routes).toEqual([TOOLS_ROUTE_ID])
    expect(toolsFeature.declarations?.resources).toEqual([TOOLS_RESOURCE_ID])
    expect(port.reads).not.toHaveBeenCalled()
    expect(port.disposeTools).not.toHaveBeenCalled()
    expect(instance.contributions.surfaces?.map(item => item.slot)).toEqual([
      'workspace.content',
      'workspace.inspector',
    ])
    expect(instance.contributions.keymaps?.[0]?.value.bindings).toEqual(expect.arrayContaining([
      { key: 'r', commandId: TOOLS_REFRESH_COMMAND_ID },
    ]))

    await instance.dispose()
    await manager.dispose()
  })

  it('loads on open, refreshes from the watch, and releases the watch on close', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('runtime')
    const port = new MutableToolsPort()
    const instance = await toolsFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as ToolsFeatureInstance
    const host = new MutableHost(hostSnapshot({ kind: 'chat' }, instance))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(session, { columns: 160, rows: 40 })
    await lease.ready
    expect(port.reads).not.toHaveBeenCalled()

    host.set(hostSnapshot(toolsRoute(), instance))
    await lease.settled()
    await vi.waitFor(() => expect(port.reads).toHaveBeenCalledOnce())
    expect(instance.model.snapshot().phase).toBe('ready')

    const refresh = instance.contributions.commands
      ?.find(item => item.id === TOOLS_REFRESH_COMMAND_ID)?.value
    await refresh?.handle({
      target: { kind: 'feature', featureId: TOOLS_FEATURE_ID },
      command: { type: 'feature.command', commandId: TOOLS_REFRESH_COMMAND_ID },
    }, { navigation: createNavigationState(), openRoute: vi.fn() })
    await vi.waitFor(() => expect(port.reads).toHaveBeenCalledTimes(2))

    port.set(snapshot({ generation: 8, tools: [snapshot().tools[2]!] }))
    port.emit()
    await vi.waitFor(() => expect(port.reads).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(projectToolsBrowser(instance.model.snapshot())?.totalCount).toBe(1))

    host.set(hostSnapshot({ kind: 'chat' }, instance))
    await lease.settled()
    expect(port.stopWatch).toHaveBeenCalledOnce()
    port.emit()
    await Promise.resolve()
    expect(port.reads).toHaveBeenCalledTimes(3)
    instance.model.dispatch({ type: 'refresh.requested' })
    await Promise.resolve()
    expect(port.reads).toHaveBeenCalledTimes(3)

    await runtime.dispose()
    await instance.dispose()
    await manager.dispose()
  })

  it('keeps ResourceCoordinator last-good data after a registry read failure', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('failure')
    const port = new MutableToolsPort()
    const instance = await toolsFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as ToolsFeatureInstance
    const host = new MutableHost(hostSnapshot(toolsRoute(), instance))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(session, { columns: 160, rows: 40 })
    await lease.ready
    await vi.waitFor(() => expect(instance.model.snapshot().phase).toBe('ready'))

    port.snapshotError = new Error('ToolRuntime unavailable')
    port.emit()
    await vi.waitFor(() => expect(instance.model.snapshot()).toMatchObject({
      phase: 'failed',
      error: 'ToolRuntime unavailable',
    }))
    const resource = lease.snapshot().surfaces
      .find(item => item.featureId === TOOLS_FEATURE_ID)?.resources[0]?.state
    expect(resource).toMatchObject({
      phase: 'failed',
      lastGood: {
        generation: 7,
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'read_file' }),
        ]),
      },
    })

    await runtime.dispose()
    await instance.dispose()
    await manager.dispose()
  })

  it('supports list navigation, Unicode search editing, and safe detail projection', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('commands')
    const port = new MutableToolsPort()
    const instance = await toolsFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as ToolsFeatureInstance
    const resource = instance.contributions.resources![0]!.value
    const surface = session.child('surface', 'manual')
    await resource.load({ scope: surface, signal: surface.signal, requestId: 1, previous: undefined })
    const handlers = new Map<string, FeatureCommandHandler>(
      instance.contributions.commands!.map(item => [item.id, item.value]),
    )
    const target = { kind: 'feature', featureId: TOOLS_FEATURE_ID } as const
    const context = { navigation: createNavigationState(), openRoute: vi.fn() }

    await handlers.get('tools.selection.next')!.handle({
      target,
      command: { type: 'feature.command', commandId: 'tools.selection.next' },
    }, context)
    expect(projectToolsBrowser(instance.model.snapshot())?.selected?.group).toBe('mcp')
    await handlers.get('navigation.move')!.handle({
      target,
      command: { type: 'navigation.move', direction: 'up' },
    }, context)
    expect(projectToolsBrowser(instance.model.snapshot())?.selected?.name).toBe('read_file')

    const edit = handlers.get('edit.insert')!
    await edit.handle({ target, command: { type: 'edit.insert', text: '读取 path' } }, context)
    expect(projectToolsBrowser(instance.model.snapshot())?.rows.map(row => row.name))
      .toEqual(['read_file'])
    await handlers.get('edit.move')!.handle({
      target,
      command: { type: 'edit.move', direction: 'left' },
    }, context)
    await handlers.get('edit.delete-backward')!.handle({
      target,
      command: { type: 'edit.delete-backward' },
    }, context)
    await handlers.get('edit.move-boundary')!.handle({
      target,
      command: { type: 'edit.move-boundary', boundary: 'start' },
    }, context)
    await handlers.get('edit.delete-forward')!.handle({
      target,
      command: { type: 'edit.delete-forward' },
    }, context)
    await handlers.get('edit.move')!.handle({
      target,
      command: { type: 'edit.move', direction: 'right' },
    }, context)
    await handlers.get('edit.move')!.handle({
      target,
      command: { type: 'edit.move', direction: 'up' },
    }, context)
    await handlers.get('edit.move-boundary')!.handle({
      target,
      command: { type: 'edit.move-boundary', boundary: 'end' },
    }, context)
    await handlers.get('edit.insert')!.handle({
      target,
      command: { type: 'action.submit' },
    }, context)
    await handlers.get('navigation.move')!.handle({
      target,
      command: { type: 'action.submit' },
    }, context)
    await handlers.get('navigation.move')!.handle({
      target,
      command: { type: 'navigation.move', direction: 'left' },
    }, context)
    instance.model.dispatch({ type: 'query.edit', action: { type: 'clear' } })

    const regions = instance.contributions.surfaces!
      .map(item => item.value as LayoutRegion<ToolsUiNode>)
    const projections = regions.map(region => region.node.project({
      bounds: { x: 0, y: 0, width: 100, height: 20 },
      focus: true,
      mode: 'insert',
      resources: [],
    }))
    const text = projections.flatMap(value => value.rows.map(row => row.text)).join('\n')
    expect(text).toContain('SEARCH')
    expect(text).toContain('读取 Windows 文件')
    expect(text).toContain('PARAMETERS  path, encoding')
    expect(text).toContain('REQUIRED  path')

    const invalidated = vi.fn()
    const stop = regions[0]!.node.onChanged(invalidated)
    instance.model.dispatch({ type: 'query.edit', action: { type: 'insert', text: 'r' } })
    expect(invalidated).toHaveBeenCalled()
    stop()
    await instance.dispose()
    await manager.dispose()
  })

  it('does not commit a snapshot when its surface signal aborts during the read', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('abort')
    const port = new MutableToolsPort()
    const instance = await toolsFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as ToolsFeatureInstance
    const resource = instance.contributions.resources![0]!.value
    const surface = session.child('surface', 'abort-read')
    port.afterRead = () => { void surface.dispose('closed while reading') }
    await expect(Promise.resolve().then(() => resource.load({
      scope: surface,
      signal: surface.signal,
      requestId: 1,
      previous: undefined,
    }))).rejects.toBe('closed while reading')
    expect(instance.model.snapshot().phase).toBe('loading')
    expect(instance.model.snapshot().snapshot).toBeUndefined()

    await instance.dispose()
    await manager.dispose()
  })

  it('contains a missing optional tools capability before factory creation', async () => {
    const registry = new FeatureRegistry()
    registry.register(toolsFeature)
    const manager = new ScopeManager()
    const session = manager.createSession('missing-capability')
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      featureScope: 'session',
      sessionScope: session,
      capabilities: {
        resolve: () => { throw new Error('tools capability missing') },
      },
    })
    await supervisor.start()
    await expect(supervisor.activateRoute(TOOLS_ROUTE_ID)).resolves.toEqual([
      expect.objectContaining({
        featureId: TOOLS_FEATURE_ID,
        state: 'unavailable',
        error: expect.objectContaining({ message: 'tools capability missing' }),
      }),
    ])
    expect(supervisor.listActiveContributions()).toEqual([])
    await supervisor.dispose()
    await manager.dispose()
  })

  it('suppresses watch invalidation after its surface scope aborts', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('aborted-watch')
    const port = new MutableToolsPort()
    const instance = await toolsFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as ToolsFeatureInstance
    const surface = session.child('surface', 'watch')
    const invalidated = vi.fn()
    const stop = instance.contributions.resources![0]!.value.watch!({
      scope: surface,
      signal: surface.signal,
      invalidate: invalidated,
    })
    await surface.dispose('closed')
    port.emit()
    instance.model.dispatch({ type: 'refresh.requested' })
    expect(invalidated).not.toHaveBeenCalled()
    await stop?.()
    await instance.dispose()
    await manager.dispose()
  })

  it('normalizes non-Error registry failures', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('string-error')
    const port = new MutableToolsPort()
    port.snapshotError = 'registry offline'
    const instance = await toolsFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as ToolsFeatureInstance
    const surface = session.child('surface', 'load')
    const resource = instance.contributions.resources![0]!.value
    await expect(Promise.resolve().then(() => resource.load({
      scope: surface,
      signal: surface.signal,
      requestId: 1,
      previous: undefined,
    }))).rejects.toBe('registry offline')
    expect(instance.model.snapshot()).toMatchObject({ phase: 'failed', error: 'registry offline' })
    await instance.dispose()
    await manager.dispose()
  })
})
