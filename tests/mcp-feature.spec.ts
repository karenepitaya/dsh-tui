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
  MCP_CONTENT_SURFACE_ID,
  MCP_FEATURE_ID,
  MCP_REFRESH_COMMAND_ID,
  MCP_RESOURCE_ID,
  MCP_ROUTE_ID,
  createMcpContentNode,
  createMcpFeatureModel,
  createMcpFeatureState,
  createMcpInspectorNode,
  mcpFeature,
  projectMcpBrowser,
  transitionMcpFeature,
  type McpFeatureInstance,
  type McpFeatureState,
  type McpUiNode,
} from '../src/features/mcp/index.ts'
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
    generation: 11,
    tools: [
      {
        name: 'read_file',
        description: 'Core file reader',
        group: 'core',
        parameterNames: ['path'],
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
        name: 'mcp__filesystem__read_file',
        description: '读取 Windows 文件',
        group: 'mcp',
        parameterNames: ['path', 'encoding'],
        requiredParameterNames: ['path'],
      },
      {
        name: 'legacy_mcp_tool',
        description: 'Legacy capability without a qualified name',
        group: 'mcp',
        parameterNames: [],
        requiredParameterNames: [],
      },
      {
        name: 'run_code',
        description: 'Programmatic transport',
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

  toolsSnapshot(): SessionToolsSnapshot { return this.reads() }

  private read(): SessionToolsSnapshot {
    if (this.snapshotError !== undefined) throw this.snapshotError
    const value = this.value
    this.afterRead?.()
    return value
  }

  set(value: SessionToolsSnapshot): void { this.value = value }

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

describe('MCP Feature state and projectors', () => {
  it('filters exact MCP rows, detaches data, and preserves namespace identity', () => {
    const source = snapshot()
    let state = transitionMcpFeature(createMcpFeatureState(), {
      type: 'load.started', request: request(2, 1),
    }).state
    state = transitionMcpFeature(state, {
      type: 'load.succeeded', request: request(2, 1), snapshot: source,
    }).state
    expect(projectMcpBrowser(state)).toMatchObject({
      totalCount: 3,
      namespaceCount: 3,
      selected: {
        name: 'mcp__github__create_issue',
        serverName: 'github',
        toolName: 'create_issue',
      },
    })
    expect(projectMcpBrowser(state)?.rows.map(row => row.name)).toEqual([
      'mcp__github__create_issue',
      'mcp__filesystem__read_file',
      'legacy_mcp_tool',
    ])
    expect(state.snapshot?.tools).not.toBe(source.tools)
    expect(state.snapshot?.tools[0]?.parameterNames).not.toBe(source.tools[0]?.parameterNames)

    state = transitionMcpFeature(state, {
      type: 'selection.move', direction: 'down',
    }).state
    expect(projectMcpBrowser(state)?.selected?.serverName).toBe('filesystem')
    state = transitionMcpFeature(state, {
      type: 'snapshot.changed',
      snapshot: snapshot({ generation: 12, tools: [...snapshot().tools].reverse() }),
    }).state
    expect(projectMcpBrowser(state)?.selected?.name).toBe('mcp__filesystem__read_file')
    state = transitionMcpFeature(state, {
      type: 'query.edit', action: { type: 'insert', text: '文件 path' },
    }).state
    expect(projectMcpBrowser(state)?.rows.map(row => row.name))
      .toEqual(['mcp__filesystem__read_file'])
    expect(transitionMcpFeature(state, {
      type: 'query.edit', action: { type: 'move-end' },
    }).state).toBe(state)
    expect(transitionMcpFeature(state, { type: 'refresh.requested' }).effects)
      .toEqual([{ type: 'resource.refresh', resourceId: MCP_RESOURCE_ID }])
  })

  it('retains last-good state and rejects stale or inapplicable transitions', () => {
    const idle = createMcpFeatureState()
    expect(projectMcpBrowser(idle)).toBeUndefined()
    expect(transitionMcpFeature(idle, {
      type: 'selection.move', direction: 'down',
    }).state).toBe(idle)
    expect(transitionMcpFeature(idle, {
      type: 'query.edit', action: { type: 'insert', text: 'x' },
    }).state).toBe(idle)
    expect(transitionMcpFeature(idle, {
      type: 'load.succeeded', request: request(9, 9), snapshot: snapshot(),
    }).state).toBe(idle)

    let state = transitionMcpFeature(idle, {
      type: 'load.started', request: request(3, 1),
    }).state
    expect(transitionMcpFeature(state, {
      type: 'load.succeeded', request: request(4, 1), snapshot: snapshot({ tools: [] }),
    }).state).toBe(state)
    expect(transitionMcpFeature(state, {
      type: 'load.failed', request: request(4, 1), message: 'late',
    }).state).toBe(state)
    state = transitionMcpFeature(state, {
      type: 'load.succeeded', request: request(3, 1), snapshot: snapshot(),
    }).state
    expect(transitionMcpFeature(state, {
      type: 'selection.move', direction: 'up',
    }).state).toBe(state)
    state = transitionMcpFeature(state, {
      type: 'load.started', request: request(3, 2),
    }).state
    expect(state.phase).toBe('refreshing')
    state = transitionMcpFeature(state, {
      type: 'load.failed', request: request(3, 2), message: 'registry failed',
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'registry failed' })
    expect(projectMcpBrowser(state)?.totalCount).toBe(3)
    state = transitionMcpFeature(state, {
      type: 'snapshot.changed', snapshot: snapshot({ stale: true, error: 'last-good' }),
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'last-good' })
    state = transitionMcpFeature(state, { type: 'snapshot.failed', message: 'snapshot threw' }).state
    expect(state.error).toBe('snapshot threw')
  })

  it('isolates state/effect listeners and disposal', () => {
    const model = createMcpFeatureModel()
    const changed = vi.fn()
    const stop = model.onChanged(changed)
    model.onChanged(() => { throw new Error('renderer failed') })
    const effected = vi.fn()
    const stopEffect = model.onEffect(effected)
    model.onEffect(() => { throw new Error('effect adapter failed') })
    model.dispatch({ type: 'snapshot.failed', message: 'offline' })
    expect(changed).toHaveBeenCalledOnce()
    expect(model.dispatch({ type: 'refresh.requested' })).toEqual([
      { type: 'resource.refresh', resourceId: MCP_RESOURCE_ID },
    ])
    expect(effected).toHaveBeenCalledOnce()
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

  it('projects loading, unavailable, stale, failed, empty, and unqualified details', () => {
    const project = (state: McpFeatureState) => {
      const source = { snapshot: () => state, onChanged: () => () => {} }
      const context = {
        bounds: { x: 0, y: 0, width: 100, height: 20 },
        focus: true,
        mode: 'normal' as const,
        resources: [],
      }
      return [
        createMcpContentNode(source).project(context),
        createMcpInspectorNode(source).project(context),
      ].flatMap(value => value.rows.map(row => row.text)).join('\n')
    }
    const idle = createMcpFeatureState()
    expect(project(idle)).toContain('No matching MCP tools')
    expect(project(idle)).toContain('Select an MCP tool')
    const loading = transitionMcpFeature(idle, {
      type: 'load.started', request: request(7, 1),
    }).state
    expect(project(loading)).toContain('Loading MCP capabilities')
    const failed = transitionMcpFeature(loading, {
      type: 'load.succeeded',
      request: request(7, 1),
      snapshot: snapshot({ available: false, stale: true, error: 'stale', tools: [] }),
    }).state
    const failedText = project(failed)
    expect(failedText).toContain('Unavailable')
    expect(failedText).toContain('last-known MCP')
    expect(failedText).toContain('Registry error · stale')
    const refreshing = transitionMcpFeature(failed, {
      type: 'load.started', request: request(7, 2),
    }).state
    expect(project(refreshing)).toContain('Loading MCP capabilities')
    const unqualified = transitionMcpFeature(refreshing, {
      type: 'load.succeeded',
      request: request(7, 2),
      snapshot: snapshot({ tools: [snapshot().tools[3]!] }),
    }).state
    const detail = project(unqualified)
    expect(detail).toContain('unqualified / legacy_mcp_tool')
    expect(detail).toContain('PARAMETERS  none')
    expect(detail).toContain('REQUIRED  none')
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

function mcpRoute(): NavigationRoute {
  return { kind: 'workspace', featureId: MCP_FEATURE_ID, pane: 'content' }
}

function hostSnapshot(
  route: NavigationRoute,
  instance: McpFeatureInstance,
): FeatureHostSnapshot {
  const additions: SlotContribution<LayoutRegion>[] = (
    instance.contributions.surfaces ?? []
  ).map(surface => ({
    slotId: surface.slot,
    featureId: MCP_FEATURE_ID,
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
    featureId: MCP_FEATURE_ID,
    definition: resource.value as ResourceDefinition<unknown>,
  }))
  return Object.freeze({
    navigation,
    routes: Object.freeze([
      { id: 'chat', featureId: 'legacy.chat', route: { kind: 'chat' } as const },
      ...(instance.contributions.routes ?? []).map(item => ({
        id: item.id,
        featureId: MCP_FEATURE_ID,
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

describe('MCP Feature factory and scoped resource', () => {
  it('declares lazy session ownership without reading ToolRuntime during create', async () => {
    const manager = new ScopeManager()
    const port = new MutableToolsPort()
    const instance = await mcpFeature.create({
      scope: manager.createSession('contract'),
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as McpFeatureInstance
    expect(mcpFeature.manifest).toMatchObject({
      id: MCP_FEATURE_ID,
      scope: 'session',
      activation: 'on-route',
      required: false,
      requires: [SESSION_TOOLS_CAPABILITY],
    })
    expect(mcpFeature.declarations?.routes).toEqual([MCP_ROUTE_ID])
    expect(mcpFeature.declarations?.resources).toEqual([MCP_RESOURCE_ID])
    expect(port.reads).not.toHaveBeenCalled()
    expect(port.disposeTools).not.toHaveBeenCalled()
    expect(instance.contributions.surfaces?.map(item => [item.id, item.slot])).toEqual([
      [MCP_CONTENT_SURFACE_ID, 'workspace.content'],
      ['mcp.inspector', 'workspace.inspector'],
    ])
    expect(instance.contributions.keymaps?.[0]?.value.bindings).toEqual(expect.arrayContaining([
      { key: 'r', commandId: MCP_REFRESH_COMMAND_ID },
    ]))
    await instance.dispose()
    await manager.dispose()
  })

  it('loads on open, refreshes on r/change, and releases both watchers on close', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('runtime')
    const port = new MutableToolsPort()
    const instance = await mcpFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as McpFeatureInstance
    const host = new MutableHost(hostSnapshot({ kind: 'chat' }, instance))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(session, { columns: 160, rows: 40 })
    await lease.ready
    expect(port.reads).not.toHaveBeenCalled()
    host.set(hostSnapshot(mcpRoute(), instance))
    await lease.settled()
    await vi.waitFor(() => expect(port.reads).toHaveBeenCalledOnce())

    const refresh = instance.contributions.commands
      ?.find(item => item.id === MCP_REFRESH_COMMAND_ID)?.value
    await refresh?.handle({
      target: { kind: 'feature', featureId: MCP_FEATURE_ID },
      command: { type: 'feature.command', commandId: MCP_REFRESH_COMMAND_ID },
    }, { navigation: createNavigationState(), openRoute: vi.fn() })
    await vi.waitFor(() => expect(port.reads).toHaveBeenCalledTimes(2))

    port.set(snapshot({ generation: 12, tools: [snapshot().tools[2]!] }))
    port.emit()
    await vi.waitFor(() => expect(port.reads).toHaveBeenCalledTimes(3))
    expect(projectMcpBrowser(instance.model.snapshot())?.selected?.serverName).toBe('filesystem')
    host.set(hostSnapshot({ kind: 'chat' }, instance))
    await lease.settled()
    expect(port.stopWatch).toHaveBeenCalledOnce()
    port.emit()
    instance.model.dispatch({ type: 'refresh.requested' })
    await Promise.resolve()
    expect(port.reads).toHaveBeenCalledTimes(3)
    await runtime.dispose()
    await instance.dispose()
    await manager.dispose()
  })

  it('keeps ResourceCoordinator last-good MCP data after a read failure', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('failure')
    const port = new MutableToolsPort()
    const instance = await mcpFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as McpFeatureInstance
    const runtime = new FeatureSurfaceRuntime(new MutableHost(hostSnapshot(mcpRoute(), instance)))
    const lease = runtime.bindSession(session, { columns: 160, rows: 40 })
    await lease.ready
    await vi.waitFor(() => expect(instance.model.snapshot().phase).toBe('ready'))
    port.snapshotError = new Error('MCP registry unavailable')
    port.emit()
    await vi.waitFor(() => expect(instance.model.snapshot()).toMatchObject({
      phase: 'failed', error: 'MCP registry unavailable',
    }))
    const resource = lease.snapshot().surfaces
      .find(item => item.featureId === MCP_FEATURE_ID)?.resources[0]?.state
    expect(resource).toMatchObject({
      phase: 'failed',
      lastGood: {
        generation: 11,
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'mcp__github__create_issue' }),
        ]),
      },
    })
    await runtime.dispose()
    await instance.dispose()
    await manager.dispose()
  })

  it('supports j/k and insert-mode search while projecting safe MCP details', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('commands')
    const port = new MutableToolsPort()
    const instance = await mcpFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as McpFeatureInstance
    const surface = session.child('surface', 'manual')
    await instance.contributions.resources![0]!.value.load({
      scope: surface, signal: surface.signal, requestId: 1, previous: undefined,
    })
    const handlers = new Map<string, FeatureCommandHandler>(
      instance.contributions.commands!.map(item => [item.id, item.value]),
    )
    const target = { kind: 'feature', featureId: MCP_FEATURE_ID } as const
    const context = { navigation: createNavigationState(), openRoute: vi.fn() }
    await handlers.get('mcp.selection.next')!.handle({
      target, command: { type: 'feature.command', commandId: 'mcp.selection.next' },
    }, context)
    expect(projectMcpBrowser(instance.model.snapshot())?.selected?.serverName).toBe('filesystem')
    await handlers.get('navigation.move')!.handle({
      target, command: { type: 'navigation.move', direction: 'up' },
    }, context)
    expect(projectMcpBrowser(instance.model.snapshot())?.selected?.serverName).toBe('github')
    await handlers.get('edit.insert')!.handle({
      target, command: { type: 'edit.insert', text: '文件 path' },
    }, context)
    expect(projectMcpBrowser(instance.model.snapshot())?.selected?.serverName).toBe('filesystem')
    await handlers.get('edit.move')!.handle({
      target, command: { type: 'edit.move', direction: 'left' },
    }, context)
    await handlers.get('edit.delete-backward')!.handle({
      target, command: { type: 'edit.delete-backward' },
    }, context)
    await handlers.get('edit.move-boundary')!.handle({
      target, command: { type: 'edit.move-boundary', boundary: 'start' },
    }, context)
    await handlers.get('edit.delete-forward')!.handle({
      target, command: { type: 'edit.delete-forward' },
    }, context)
    await handlers.get('edit.move')!.handle({
      target, command: { type: 'edit.move', direction: 'right' },
    }, context)
    await handlers.get('edit.move')!.handle({
      target, command: { type: 'edit.move', direction: 'up' },
    }, context)
    await handlers.get('edit.move-boundary')!.handle({
      target, command: { type: 'edit.move-boundary', boundary: 'end' },
    }, context)
    await handlers.get('edit.insert')!.handle({ target, command: { type: 'action.submit' } }, context)
    await handlers.get('navigation.move')!.handle({
      target, command: { type: 'action.submit' },
    }, context)
    await handlers.get('navigation.move')!.handle({
      target, command: { type: 'navigation.move', direction: 'left' },
    }, context)
    instance.model.dispatch({ type: 'query.edit', action: { type: 'clear' } })
    instance.model.dispatch({ type: 'query.edit', action: { type: 'insert', text: 'filesystem' } })

    const regions = instance.contributions.surfaces!
      .map(item => item.value as LayoutRegion<McpUiNode>)
    const projections = regions.map(region => region.node.project({
      bounds: { x: 0, y: 0, width: 100, height: 20 },
      focus: true,
      mode: 'insert',
      resources: [],
    }))
    const text = projections.flatMap(value => value.rows.map(row => row.text)).join('\n')
    expect(text).toContain('filesystem / read_file')
    expect(text).toContain('QUALIFIED  mcp__filesystem__read_file')
    expect(text).toContain('PARAMETERS  path, encoding')
    expect(text).toContain('REQUIRED  path')
    expect(text).not.toContain('Core file reader')
    instance.model.dispatch({ type: 'query.edit', action: { type: 'clear' } })
    const allRows = regions[0]!.node.project({
      bounds: { x: 0, y: 0, width: 100, height: 20 },
      focus: true,
      mode: 'normal',
      resources: [],
    }).rows.map(row => row.text)
    expect(allRows).toContain('  unqualified / legacy_mcp_tool')

    const invalidated = vi.fn()
    const stop = regions[0]!.node.onChanged(invalidated)
    instance.model.dispatch({ type: 'query.edit', action: { type: 'insert', text: 'x' } })
    expect(invalidated).toHaveBeenCalled()
    stop()
    await instance.dispose()
    await manager.dispose()
  })

  it('does not commit data when its surface aborts during the synchronous read', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('abort')
    const port = new MutableToolsPort()
    const instance = await mcpFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as McpFeatureInstance
    const surface = session.child('surface', 'abort-read')
    port.afterRead = () => { void surface.dispose('closed while reading') }
    await expect(Promise.resolve().then(() => instance.contributions.resources![0]!.value.load({
      scope: surface, signal: surface.signal, requestId: 1, previous: undefined,
    }))).rejects.toBe('closed while reading')
    expect(instance.model.snapshot()).toMatchObject({ phase: 'loading' })
    expect(instance.model.snapshot().snapshot).toBeUndefined()
    await instance.dispose()
    await manager.dispose()
  })

  it('contains a missing optional ToolRuntime capability before creation', async () => {
    const registry = new FeatureRegistry()
    registry.register(mcpFeature)
    const manager = new ScopeManager()
    const session = manager.createSession('missing-capability')
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      featureScope: 'session',
      sessionScope: session,
      capabilities: { resolve: () => { throw new Error('tools capability missing') } },
    })
    await supervisor.start()
    await expect(supervisor.activateRoute(MCP_ROUTE_ID)).resolves.toEqual([
      expect.objectContaining({
        featureId: MCP_FEATURE_ID,
        state: 'unavailable',
        error: expect.objectContaining({ message: 'tools capability missing' }),
      }),
    ])
    expect(supervisor.listActiveContributions()).toEqual([])
    await supervisor.dispose()
    await manager.dispose()
  })

  it('suppresses change and refresh effects after Surface abort', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('aborted-watch')
    const port = new MutableToolsPort()
    const instance = await mcpFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as McpFeatureInstance
    const surface = session.child('surface', 'watch')
    const invalidated = vi.fn()
    const stop = instance.contributions.resources![0]!.value.watch!({
      scope: surface, signal: surface.signal, invalidate: invalidated,
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
    port.snapshotError = 'MCP registry offline'
    const instance = await mcpFeature.create({
      scope: session,
      dependencies: [{ token: SESSION_TOOLS_CAPABILITY, value: port }],
    }) as McpFeatureInstance
    const surface = session.child('surface', 'load')
    await expect(Promise.resolve().then(() => instance.contributions.resources![0]!.value.load({
      scope: surface, signal: surface.signal, requestId: 1, previous: undefined,
    }))).rejects.toBe('MCP registry offline')
    expect(instance.model.snapshot()).toMatchObject({
      phase: 'failed', error: 'MCP registry offline',
    })
    await instance.dispose()
    await manager.dispose()
  })
})
