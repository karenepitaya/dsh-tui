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
  MODES_FEATURE_ID,
  MODES_REFRESH_COMMAND_ID,
  MODES_RESOURCE_ID,
  MODES_ROUTE_ID,
  createModesContentNode,
  createModesFeatureModel,
  createModesFeatureState,
  modesFeature,
  projectModesChoices,
  transitionModesFeature,
  type ModesFeatureInstance,
  type ModesContentNode,
} from '../src/features/modes/index.ts'
import {
  contributeToSlot,
  createSlotRegistry,
  type SlotContribution,
} from '../src/layout/slots.ts'
import type { LayoutRegion } from '../src/layout/strategy.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import type { SessionModePort, SessionModeSnapshot } from '../src/mode/port.ts'
import { mapTerminalKey, routeUiCommand } from '../src/navigation/commands.ts'
import {
  createNavigationState,
  transitionNavigation,
  type NavigationRoute,
} from '../src/navigation/state.ts'
import type { ResourceDefinition } from '../src/resource/resource-coordinator.ts'
import { SESSION_MODES_CAPABILITY } from '../src/runtime/session-capabilities.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  return {
    promise: new Promise<T>((done, fail) => {
      resolve = done
      reject = fail
    }),
    resolve: value => { resolve(value) },
    reject: error => { reject(error) },
  }
}

function snapshot(overrides: Partial<SessionModeSnapshot> = {}): SessionModeSnapshot {
  return {
    available: true,
    current: 'standard',
    defaultId: 'standard',
    loading: false,
    selecting: false,
    locked: false,
    presets: [
      {
        id: 'standard',
        trust: 'system',
        sourcePath: 'D:\\预设\\standard\\agent.cordis.yml',
        name: '标准模式',
        description: '完整编码助手',
        isDefault: true,
      },
      {
        id: 'code',
        trust: 'user',
        sourcePath: 'D:\\预设\\code\\agent.cordis.yml',
        name: 'Code',
        isDefault: false,
      },
      {
        id: 'broken',
        trust: 'user',
        sourcePath: 'D:\\预设\\broken\\agent.cordis.yml',
        broken: 'invalid composition',
        isDefault: false,
      },
    ],
    ...overrides,
  }
}

function snapshotWithoutSelection(
  overrides: Partial<Omit<SessionModeSnapshot, 'current' | 'defaultId'>> = {},
): SessionModeSnapshot {
  const value = snapshot(overrides)
  return {
    available: value.available,
    loading: value.loading,
    selecting: value.selecting,
    locked: value.locked,
    presets: value.presets,
    ...(value.error === undefined ? {} : { error: value.error }),
  }
}

function request(scopeEpoch: number, requestId: number) {
  return { scopeEpoch, requestId }
}

class MutableModesPort implements SessionModePort {
  private readonly listeners = new Set<() => void>()
  readonly refreshModes = vi.fn<(signal?: AbortSignal) => Promise<void>>(async () => {})
  readonly selectMode = vi.fn<SessionModePort['selectMode']>(async (modeId) => {
    this.value = snapshot({ ...this.value, current: modeId })
    this.emit()
  })
  readonly disposeModes = vi.fn()
  readonly stopWatch = vi.fn()
  snapshotError: unknown | undefined

  constructor(private value: SessionModeSnapshot = snapshot()) {}

  modeSnapshot(): SessionModeSnapshot {
    if (this.snapshotError !== undefined) throw this.snapshotError
    return this.value
  }

  set(value: SessionModeSnapshot): void {
    this.value = value
    this.emit()
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  onModesChanged(listener: () => void): () => void {
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

describe('Modes Feature state machine and safe projector', () => {
  it('distinguishes choosing a mode from locked, unavailable and in-flight states in the action hint', () => {
    const model = createModesFeatureModel()
    const node = createModesContentNode(model)
    const hint = () => node.project({ bounds: { x: 0, y: 0, width: 80, height: 10 }, focus: true, mode: 'normal', resources: [] }).actionHint
    expect(hint()).toContain('R retry')
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot({ presets: [] }) })
    expect(hint()).toContain('R retry')
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot() })
    expect(hint()).not.toContain('Enter choose')
    model.dispatch({ type: 'selection.move', direction: 'down' })
    expect(hint()).toContain('Enter choose')
    model.dispatch({ type: 'selection.move', direction: 'down' })
    expect(hint()).toContain('choose another mode')
    expect(hint()).not.toContain('Enter choose')
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot({ locked: true }) })
    expect(hint()).toContain('/new in Chat')
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot({ selecting: true }) })
    expect(hint()).toBe('Changing mode…')
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot() })
    model.dispatch({ type: 'selection.started', requestId: 1, modeId: 'code' })
    expect(hint()).toBe('Changing mode…')
    model.dispose()
  })

  it('keeps the selected purpose and the locked-session next step visible in a small window', () => {
    const model = createModesFeatureModel()
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot({ locked: true }) })
    const rows = createModesContentNode(model).project({
      bounds: { x: 0, y: 0, width: 60, height: 6 }, focus: true, mode: 'normal', resources: [],
    }).rows
    expect(rows.map(row => row.text).join('\n')).toContain('完整编码助手')
    expect(rows.map(row => row.text).join('\n')).toContain('/new')
    model.dispose()
  })

  it('keeps stable selection, rejects stale requests, and retains last-good rows', () => {
    let state = createModesFeatureState()
    state = transitionModesFeature(state, {
      type: 'load.started',
      request: request(4, 1),
    }).state
    state = transitionModesFeature(state, {
      type: 'load.succeeded',
      request: request(4, 1),
      snapshot: snapshot(),
    }).state
    expect(state).toMatchObject({
      phase: 'ready',
      selectedModeId: 'standard',
      selectedIndex: 0,
    })
    expect(projectModesChoices(state.snapshot)[0]).toEqual({
      id: 'standard',
      trust: 'system',
      name: '标准模式',
      description: '完整编码助手',
      isCurrent: true,
      isDefault: true,
    })
    expect(projectModesChoices(state.snapshot)[0]).not.toHaveProperty('sourcePath')

    state = transitionModesFeature(state, {
      type: 'selection.move',
      direction: 'down',
    }).state
    expect(state.selectedModeId).toBe('code')
    state = transitionModesFeature(state, {
      type: 'snapshot.changed',
      snapshot: snapshot({ presets: [...snapshot().presets].reverse() }),
    }).state
    expect(state.selectedModeId).toBe('code')
    expect(state.selectedIndex).toBe(1)

    state = transitionModesFeature(state, {
      type: 'load.started',
      request: request(4, 2),
    }).state
    expect(state.phase).toBe('refreshing')
    const stale = transitionModesFeature(state, {
      type: 'load.succeeded',
      request: request(3, 99),
      snapshot: snapshot({ presets: [] }),
    })
    expect(stale.state).toBe(state)
    state = transitionModesFeature(state, {
      type: 'load.failed',
      request: request(4, 2),
      message: 'catalog offline',
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'catalog offline' })
    expect(projectModesChoices(state.snapshot)).toHaveLength(3)
    expect(transitionModesFeature(state, { type: 'refresh.requested' }).effects)
      .toEqual([{ type: 'resource.refresh', resourceId: MODES_RESOURCE_ID }])
  })

  it('reconciles fallbacks and isolates stale selection completions', () => {
    let state = createModesFeatureState()
    state = transitionModesFeature(state, {
      type: 'snapshot.changed',
      snapshot: snapshot({
        current: 'missing',
        defaultId: 'code',
      }),
    }).state
    expect(state.selectedModeId).toBe('code')
    state = transitionModesFeature(state, {
      type: 'selection.started',
      requestId: 7,
      modeId: 'standard',
    }).state
    expect(transitionModesFeature(state, {
      type: 'selection.failed',
      requestId: 6,
      message: 'stale',
    }).state).toBe(state)
    state = transitionModesFeature(state, {
      type: 'selection.succeeded',
      requestId: 7,
      snapshot: snapshot({ current: 'standard' }),
    }).state
    expect(state).toMatchObject({
      phase: 'ready',
      selectedModeId: 'code',
      selecting: false,
    })

    const noHealthy = snapshot({
      current: 'missing',
      defaultId: 'missing',
      presets: [snapshot().presets[2]!],
    })
    state = transitionModesFeature(createModesFeatureState(), {
      type: 'snapshot.changed',
      snapshot: noHealthy,
    }).state
    expect(state.selectedModeId).toBe('broken')
    state = transitionModesFeature(state, {
      type: 'selection.blocked',
      message: 'invalid composition',
    }).state
    expect(state.error).toBe('invalid composition')
  })

  it('covers empty, error, pending, boundary, and failed-selection transitions', () => {
    let state = createModesFeatureState()
    expect(transitionModesFeature(state, {
      type: 'selection.move',
      direction: 'up',
    }).state).toBe(state)
    state = transitionModesFeature(state, {
      type: 'load.started',
      request: request(9, 1),
    }).state
    state = transitionModesFeature(state, {
      type: 'snapshot.changed',
      snapshot: snapshotWithoutSelection({ error: 'partial' }),
    }).state
    expect(state).toMatchObject({ phase: 'loading', selectedModeId: 'standard' })
    expect(state.error).toBeUndefined()
    expect(transitionModesFeature(state, {
      type: 'load.failed',
      request: request(8, 1),
      message: 'stale',
    }).state).toBe(state)
    state = transitionModesFeature(state, {
      type: 'load.succeeded',
      request: request(9, 1),
      snapshot: snapshot({ error: 'catalog warning' }),
    }).state
    expect(state.phase).toBe('failed')
    expect(transitionModesFeature(state, {
      type: 'selection.move',
      direction: 'up',
    }).state).toBe(state)

    state = transitionModesFeature(state, {
      type: 'snapshot.failed',
      message: 'snapshot unavailable',
    }).state
    expect(state.error).toBe('snapshot unavailable')
    state = transitionModesFeature(state, {
      type: 'selection.started',
      requestId: 11,
      modeId: 'standard',
    }).state
    expect(transitionModesFeature(state, {
      type: 'selection.succeeded',
      requestId: 10,
      snapshot: snapshot(),
    }).state).toBe(state)
    state = transitionModesFeature(state, {
      type: 'selection.failed',
      requestId: 11,
      message: 'selection failed',
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'selection failed' })

    state = transitionModesFeature(createModesFeatureState(), {
      type: 'snapshot.changed',
      snapshot: snapshot({ current: 'missing', defaultId: 'missing', presets: [] }),
    }).state
    expect(state).toMatchObject({ selectedIndex: -1 })

    state = transitionModesFeature(state, {
      type: 'selection.started',
      requestId: 15,
      modeId: 'missing',
    }).state
    state = transitionModesFeature(state, {
      type: 'selection.failed',
      requestId: 15,
      message: 'no snapshot',
    }).state
    expect(state.snapshot).toMatchObject({ presets: [] })

    let blank = transitionModesFeature(createModesFeatureState(), {
      type: 'selection.started',
      requestId: 16,
      modeId: 'missing',
    }).state
    blank = transitionModesFeature(blank, {
      type: 'selection.failed',
      requestId: 16,
      message: 'blank failure',
    }).state
    expect(blank.snapshot).toBeUndefined()

    let warning = transitionModesFeature(createModesFeatureState(), {
      type: 'selection.started',
      requestId: 17,
      modeId: 'code',
    }).state
    warning = transitionModesFeature(warning, {
      type: 'selection.succeeded',
      requestId: 17,
      snapshot: snapshot({ current: 'code', error: 'committed with warning' }),
    }).state
    expect(warning).toMatchObject({ phase: 'failed', error: 'committed with warning' })
  })

  it('keeps model listeners isolated and enforces disposal', () => {
    const model = createModesFeatureModel()
    const changed = vi.fn()
    const effect = vi.fn()
    const stopChanged = model.onChanged(changed)
    model.onChanged(() => { throw new Error('presentation failed') })
    const stopEffect = model.onEffect(effect)
    model.onEffect(() => { throw new Error('effect adapter failed') })
    model.dispatch({ type: 'selection.blocked', message: 'blocked' })
    expect(changed).toHaveBeenCalledOnce()
    model.dispatch({ type: 'refresh.requested' })
    expect(effect).toHaveBeenCalledWith({
      type: 'resource.refresh',
      resourceId: MODES_RESOURCE_ID,
    })
    stopChanged()
    stopChanged()
    stopEffect()
    stopEffect()
    model.dispose()
    model.dispose()
    expect(() => model.onChanged(vi.fn())).toThrow('disposed')
    expect(() => model.onEffect(vi.fn())).toThrow('disposed')
    expect(() => model.dispatch({ type: 'refresh.requested' })).toThrow('disposed')
  })

  it('projects loading, failed, locked, unavailable, and bounded list states', () => {
    const model = createModesFeatureModel()
    const node = createModesContentNode(model)
    const invalidated = vi.fn()
    const stop = node.onChanged(invalidated)
    const project = (height: number, resources: Parameters<typeof node.project>[0]['resources'] = []) => (
      node.project({
        bounds: { x: 0, y: 0, width: 120, height },
        focus: true,
        mode: 'normal',
        resources,
      })
    )
    expect(project(5, [{ id: MODES_RESOURCE_ID, phase: 'loading' }]).rows)
      .toMatchObject([
        { text: '0 presets · loading…', tone: 'accent' },
        { text: 'Loading Agent presets…', tone: 'warning' },
      ])
    model.dispatch({ type: 'snapshot.failed', message: 'offline' })
    expect(project(5).rows).toMatchObject([
      { tone: 'danger' },
      { text: 'Last operation failed · offline' },
      { text: 'No Agent modes available · R retry; check preset settings', tone: 'danger' },
    ])

    model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshot({
        available: false,
        locked: true,
        error: 'roster warning',
      }),
    })
    const detailed = project(20).rows
    expect(detailed.map(row => row.text)).toEqual(expect.arrayContaining([
      '3 presets',
      'CURRENT  standard',
      'Unavailable · DSH AgentPresets is not active',
      'Session started · mode locked · /new to choose another',
      'Last operation failed · roster warning',
      '完整编码助手',
      '› 标准模式 · current/default',
      '  Code',
      '  broken · broken',
    ]))
    expect(detailed.find(row => row.text.includes('broken · broken'))?.tone).toBe('danger')
    expect(project(5).rows).toHaveLength(5)

    model.dispatch({ type: 'selection.move', direction: 'down' })
    expect(project(9).rows.find(row => row.selected))
      .toMatchObject({ selected: true, tone: 'accent' })
    expect(project(1).rows).toHaveLength(1)

    model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshotWithoutSelection({
        presets: [snapshot().presets[1]!],
      }),
    })
    expect(project(8).rows[0]?.text).toBe('1 preset')
    model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshot({ current: 'standard' }),
    })
    expect(project(4).rows).toHaveLength(4)

    model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshotWithoutSelection({ presets: [] }),
    })
    expect(project(4).rows.at(-1)).toMatchObject({
      text: 'No Agent modes available · R retry; check preset settings',
      tone: 'success',
    })
    expect(invalidated).toHaveBeenCalled()
    stop()
    model.dispose()
  })
})

class MutableHost implements FeatureSurfaceHostPort {
  private readonly listeners = new Set<(snapshot: FeatureHostSnapshot) => void>()

  constructor(private value: FeatureHostSnapshot) {}

  snapshot(): FeatureHostSnapshot {
    return this.value
  }

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

function hostSnapshot(
  route: NavigationRoute,
  instance: ModesFeatureInstance,
): FeatureHostSnapshot {
  const surfaces = instance.contributions.surfaces ?? []
  const additions: SlotContribution<LayoutRegion>[] = surfaces.map(surface => ({
    slotId: surface.slot,
    featureId: MODES_FEATURE_ID,
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
    featureId: MODES_FEATURE_ID,
    definition: resource.value as ResourceDefinition<unknown>,
  }))
  return Object.freeze({
    navigation,
    routes: Object.freeze([
      { id: 'chat', featureId: 'legacy.chat', route: { kind: 'chat' } as const },
      ...(instance.contributions.routes ?? []).map(routeContribution => ({
        id: routeContribution.id,
        featureId: MODES_FEATURE_ID,
        route: routeContribution.value as NavigationRoute,
      })),
    ]),
    commands: Object.freeze([]),
    resources: Object.freeze(resources),
    slots,
    regions: Object.freeze(slots.contributions.map(item => item.value)),
    issues: Object.freeze([]),
  })
}

async function createInstance(manager: ScopeManager, port: SessionModePort) {
  return await modesFeature.create({
    scope: manager.createSession('active'),
    dependencies: [{ token: SESSION_MODES_CAPABILITY, value: port }],
  }) as ModesFeatureInstance
}

function modesRoute(): NavigationRoute {
  return {
    kind: 'workspace',
    featureId: MODES_FEATURE_ID,
    pane: 'content',
  }
}

describe('Modes Feature factory, resource, commands, and surface', () => {
  it('declares a lazy session-scoped workspace and projects no source paths', async () => {
    const manager = new ScopeManager()
    const port = new MutableModesPort()
    const instance = await createInstance(manager, port)

    expect(modesFeature.manifest).toMatchObject({
      id: MODES_FEATURE_ID,
      scope: 'session',
      activation: 'on-route',
      required: false,
      requires: [SESSION_MODES_CAPABILITY],
    })
    expect(modesFeature.declarations?.routes).toEqual([MODES_ROUTE_ID])
    expect(port.refreshModes).not.toHaveBeenCalled()
    expect(port.selectMode).not.toHaveBeenCalled()

    const node = (instance.contributions.surfaces?.[0]?.value as LayoutRegion<ModesContentNode>)
      .node
    const projected = node.project({
      bounds: { x: 0, y: 0, width: 100, height: 20 },
      focus: true,
      mode: 'normal',
      resources: [],
    })
    expect(projected.rows.map(row => row.text).join('\n')).not.toContain('sourcePath')
    expect(projected.rows.map(row => row.text).join('\n')).not.toContain('D:\\预设')

    const keymap = instance.contributions.keymaps?.[0]?.value
    expect(keymap?.bindings.map(binding => binding.key)).toEqual(['k', 'j', 'enter', 'r'])
    const navigation = transitionNavigation(createNavigationState(), {
      type: 'navigate',
      route: modesRoute(),
    }).state
    const escape = mapTerminalKey({ type: 'named', key: 'escape' }, { navigation })
    expect(escape).toEqual({ type: 'navigation.back' })
    expect(routeUiCommand(navigation, escape!)).toMatchObject({
      target: { kind: 'feature', featureId: MODES_FEATURE_ID },
      command: { type: 'navigation.back' },
    })

    await instance.dispose()
    await manager.dispose()
  })

  it('loads only while open, aborts and unsubscribes on close, and ignores late results', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('surface-session')
    const pending = deferred<void>()
    const signals: AbortSignal[] = []
    const port = new MutableModesPort()
    port.refreshModes.mockImplementation((signal) => {
      if (signal !== undefined) signals.push(signal)
      return pending.promise
    })
    const instance = await modesFeature.create({
      scope: sessionScope,
      dependencies: [{ token: SESSION_MODES_CAPABILITY, value: port }],
    }) as ModesFeatureInstance
    const host = new MutableHost(hostSnapshot({ kind: 'chat' }, instance))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(sessionScope, { columns: 120, rows: 30 })
    await lease.ready
    expect(port.refreshModes).not.toHaveBeenCalled()

    host.set(hostSnapshot(modesRoute(), instance))
    await lease.settled()
    await vi.waitFor(() => expect(port.refreshModes).toHaveBeenCalledOnce())
    expect(signals[0]?.aborted).toBe(false)

    host.set(hostSnapshot({ kind: 'chat' }, instance))
    await lease.settled()
    expect(signals[0]?.aborted).toBe(true)
    expect(port.stopWatch).toHaveBeenCalledOnce()
    pending.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(instance.model.snapshot().phase).toBe('loading')
    expect(projectModesChoices(instance.model.snapshot().snapshot)).toEqual([])

    await runtime.dispose()
    await instance.dispose()
    await manager.dispose()
  })

  it('navigates with j/k, selects on Enter, blocks unsafe choices, and refreshes last-good data', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('commands-session')
    const port = new MutableModesPort()
    const instance = await modesFeature.create({
      scope: sessionScope,
      dependencies: [{ token: SESSION_MODES_CAPABILITY, value: port }],
    }) as ModesFeatureInstance
    const host = new MutableHost(hostSnapshot(modesRoute(), instance))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(sessionScope, { columns: 160, rows: 40 })
    await lease.ready
    await vi.waitFor(() => expect(instance.model.snapshot().phase).toBe('ready'))

    const handlers = new Map((instance.contributions.commands ?? []).map(command => [
      command.id,
      command.value as FeatureCommandHandler,
    ]))
    const target = { kind: 'feature', featureId: MODES_FEATURE_ID } as const
    const context = { navigation: host.snapshot().navigation, openRoute: vi.fn() }
    await handlers.get('navigation.move')?.handle({
      target,
      command: { type: 'navigation.move', direction: 'down' },
    }, context)
    expect(instance.model.snapshot().selectedModeId).toBe('code')
    await handlers.get('navigation.activate')?.handle({
      target,
      command: { type: 'navigation.activate' },
    }, context)
    expect(port.selectMode).toHaveBeenCalledWith('code', { signal: expect.any(AbortSignal) })
    expect(instance.model.snapshot()).toMatchObject({
      phase: 'ready',
      selecting: false,
      snapshot: { current: 'code' },
    })

    await handlers.get('modes.selection.next')?.handle({
      target,
      command: { type: 'feature.command', commandId: 'modes.selection.next' },
    }, context)
    expect(instance.model.snapshot().selectedModeId).toBe('broken')
    await handlers.get('modes.selection.activate')?.handle({
      target,
      command: { type: 'feature.command', commandId: 'modes.selection.activate' },
    }, context)
    expect(port.selectMode).toHaveBeenCalledTimes(1)
    expect(instance.model.snapshot().error).toBe('invalid composition')

    const refreshFailure = deferred<void>()
    port.refreshModes.mockImplementationOnce(() => refreshFailure.promise)
    await handlers.get(MODES_REFRESH_COMMAND_ID)?.handle({
      target,
      command: { type: 'feature.command', commandId: MODES_REFRESH_COMMAND_ID },
    }, context)
    await vi.waitFor(() => expect(instance.model.snapshot().phase).toBe('refreshing'))
    refreshFailure.reject(new Error('preset service offline'))
    await vi.waitFor(() => expect(instance.model.snapshot()).toMatchObject({
      phase: 'failed',
      error: 'preset service offline',
    }))
    expect(projectModesChoices(instance.model.snapshot().snapshot)).toHaveLength(3)
    const resourceState = lease.snapshot().surfaces
      .find(surface => surface.featureId === MODES_FEATURE_ID)?.resources[0]?.state
    expect(resourceState).toMatchObject({
      phase: 'failed',
      lastGood: { current: 'standard' },
    })

    port.set(snapshot({ current: 'code', locked: true }))
    await handlers.get('modes.selection.previous')?.handle({
      target,
      command: { type: 'feature.command', commandId: 'modes.selection.previous' },
    }, context)
    await handlers.get('modes.selection.activate')?.handle({
      target,
      command: { type: 'feature.command', commandId: 'modes.selection.activate' },
    }, context)
    expect(instance.model.snapshot().error).toContain('already started')
    expect(port.selectMode).toHaveBeenCalledTimes(1)

    await runtime.dispose()
    await instance.dispose()
    await manager.dispose()
  })

  it('contains selection failure and aborts an in-flight selection when disposed', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('selection-session')
    const port = new MutableModesPort(snapshot({ current: 'standard' }))
    const instance = await modesFeature.create({
      scope: sessionScope,
      dependencies: [{ token: SESSION_MODES_CAPABILITY, value: port }],
    }) as ModesFeatureInstance
    const resource = instance.contributions.resources![0]!.value
    const surface = sessionScope.child('surface', 'modes-test')
    await resource.load({
      scope: surface,
      signal: surface.signal,
      requestId: 1,
      previous: undefined,
    })
    instance.model.dispatch({ type: 'selection.move', direction: 'down' })
    const handler = instance.contributions.commands!
      .find(command => command.id === 'navigation.activate')!.value
    port.selectMode.mockRejectedValueOnce(new Error('recompose failed'))
    await handler.handle({
      target: { kind: 'feature', featureId: MODES_FEATURE_ID },
      command: { type: 'navigation.activate' },
    }, { navigation: createNavigationState(), openRoute: vi.fn() })
    expect(instance.model.snapshot()).toMatchObject({
      phase: 'failed',
      selecting: false,
      error: 'recompose failed',
    })

    const pending = deferred<void>()
    let selectionSignal: AbortSignal | undefined
    port.selectMode.mockImplementationOnce((_modeId, options) => {
      selectionSignal = options?.signal
      return pending.promise
    })
    const task = handler.handle({
      target: { kind: 'feature', featureId: MODES_FEATURE_ID },
      command: { type: 'navigation.activate' },
    }, { navigation: createNavigationState(), openRoute: vi.fn() })
    await vi.waitFor(() => expect(selectionSignal).toBeDefined())
    await instance.dispose()
    expect(selectionSignal?.aborted).toBe(true)
    pending.resolve()
    await task

    await manager.dispose()
  })

  it('contains defensive command, watch, snapshot, and repeated-dispose edges', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('edge-session')
    const port = new MutableModesPort()
    const instance = await modesFeature.create({
      scope: sessionScope,
      dependencies: [{ token: SESSION_MODES_CAPABILITY, value: port }],
    }) as ModesFeatureInstance
    const commands = new Map(instance.contributions.commands!.map(command => [
      command.id,
      command.value,
    ]))
    const target = { kind: 'feature', featureId: MODES_FEATURE_ID } as const
    const context = { navigation: createNavigationState(), openRoute: vi.fn() }
    const activate = commands.get('navigation.activate')!

    await activate.handle({ target, command: { type: 'navigation.activate' } }, context)
    expect(instance.model.snapshot().error).toBe('No Agent mode is selected')

    instance.model.dispatch({ type: 'snapshot.changed', snapshot: snapshot({ available: false }) })
    await activate.handle({ target, command: { type: 'navigation.activate' } }, context)
    expect(instance.model.snapshot().error).toContain('unavailable')

    instance.model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshot({ current: 'standard', selecting: true }),
    })
    instance.model.dispatch({ type: 'selection.move', direction: 'down' })
    await activate.handle({ target, command: { type: 'navigation.activate' } }, context)
    expect(instance.model.snapshot().error).toContain('already running')

    instance.model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshot({ current: 'standard', selecting: false }),
    })
    instance.model.dispatch({ type: 'selection.started', requestId: 40, modeId: 'code' })
    await activate.handle({ target, command: { type: 'navigation.activate' } }, context)
    expect(instance.model.snapshot().error).toContain('already running')
    instance.model.dispatch({
      type: 'selection.failed',
      requestId: 40,
      message: 'cleared',
    })

    instance.model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshot({ current: 'code' }),
    })
    await activate.handle({ target, command: { type: 'navigation.activate' } }, context)
    expect(instance.model.snapshot().error).toContain('already active')

    const genericMove = commands.get('navigation.move')!
    const before = instance.model.snapshot()
    await genericMove.handle({
      target,
      command: { type: 'feature.command', commandId: 'ignored' },
    }, context)
    await genericMove.handle({
      target,
      command: { type: 'navigation.move', direction: 'left' },
    }, context)
    expect(instance.model.snapshot()).toBe(before)

    const definition = instance.contributions.resources![0]!.value
    const aborted = new AbortController()
    aborted.abort('closed')
    const invalidated = vi.fn()
    const stopAbortedWatch = definition.watch!({
      scope: sessionScope.child('surface', 'aborted-watch'),
      signal: aborted.signal,
      invalidate: invalidated,
    }) as () => void
    instance.model.dispatch({ type: 'refresh.requested' })
    port.emit()
    expect(invalidated).not.toHaveBeenCalled()
    stopAbortedWatch()

    const watchingScope = sessionScope.child('surface', 'throwing-watch')
    const stopThrowingWatch = definition.watch!({
      scope: watchingScope,
      signal: watchingScope.signal,
      invalidate: vi.fn(),
    }) as () => void
    port.snapshotError = 'snapshot exploded'
    port.emit()
    expect(instance.model.snapshot()).toMatchObject({
      phase: 'failed',
      error: 'snapshot exploded',
    })
    stopThrowingWatch()

    port.snapshotError = undefined
    instance.model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshot({ current: 'standard' }),
    })
    port.selectMode.mockRejectedValueOnce('selection exploded')
    port.snapshotError = 'snapshot unavailable'
    await activate.handle({ target, command: { type: 'navigation.activate' } }, context)
    expect(instance.model.snapshot()).toMatchObject({
      phase: 'failed',
      error: 'selection exploded',
    })

    const node = (instance.contributions.surfaces![0]!.value as LayoutRegion<ModesContentNode>)
      .node
    const stopNode = node.onChanged(vi.fn())
    stopNode()
    await instance.dispose()
    await instance.dispose()
    await manager.dispose()
  })
})
