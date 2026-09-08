import { describe, expect, it, vi } from 'vitest'
import type { FeatureCommandHandler } from '../src/app/feature-contribution-contract.ts'
import {
  MODELS_CONTENT_SURFACE_ID,
  MODELS_FEATURE_ID,
  MODELS_EFFORT_PREVIOUS_COMMAND_ID,
  MODELS_EFFORT_NEXT_COMMAND_ID,
  MODELS_KEYMAP_ID,
  MODELS_MOVE_DOWN_COMMAND_ID,
  MODELS_MOVE_UP_COMMAND_ID,
  MODELS_REFRESH_COMMAND_ID,
  MODELS_RESOURCE_ID,
  MODELS_ROUTE_ID,
  MODELS_SAVE_DEFAULT_COMMAND_ID,
  MODELS_SELECT_COMMAND_ID,
  createModelsContentNode,
  createModelsFeatureModel,
  createModelsFeatureState,
  detachModelsSnapshot,
  modelsChoiceKey,
  modelsChoiceSelection,
  modelsFeature,
  projectModelsChoices,
  selectedModelsChoice,
  transitionModelsFeature,
  type ModelsFeatureEffect,
  type ModelsFeatureInstance,
  type ModelsRequestStamp,
} from '../src/features/models/index.ts'
import { ScopeManager, type ResourceScope } from '../src/lifecycle/scope-manager.ts'
import type {
  DshTuiModelSelection,
  SessionModelPort,
  SessionModelSelectOptions,
  SessionModelSnapshot,
} from '../src/model/port.ts'
import type { RoutedUiCommand } from '../src/navigation/commands.ts'
import type { FeatureSurfaceProjectContext } from '../src/presentation/feature-surface.ts'
import {
  ResourceCoordinator,
  type ResourceLoadContext,
} from '../src/resource/resource-coordinator.ts'
import {
  SESSION_AGENT_STATUS_CAPABILITY,
  SESSION_MODELS_CAPABILITY,
  type SessionAgentStatusPort,
  type SessionAgentStatusSnapshot,
} from '../src/runtime/session-capabilities.ts'

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
    resolve,
    reject,
  }
}

function snapshot(
  overrides: Partial<SessionModelSnapshot> = {},
): SessionModelSnapshot {
  return {
    current: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'opaque-live',
    },
    defaultSelection: {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'thorough',
    },
    routable: true,
    writable: true,
    loading: false,
    selecting: false,
    groups: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          {
            provider: 'deepseek',
            providerName: 'DeepSeek',
            id: 'deepseek-chat',
            name: 'DeepSeek Chat',
            description: 'General chat',
            efforts: [],
          },
          {
            provider: 'deepseek',
            providerName: 'DeepSeek',
            id: 'deepseek-reasoner',
            name: 'DeepSeek Reasoner',
            efforts: [
              {
                id: 'quick',
                name: 'Quick',
                description: 'Short reasoning',
                isDefault: false,
              },
              { id: 'thorough', name: 'Thorough', isDefault: true },
            ],
          },
        ],
      },
      {
        id: 'xiaomi',
        name: 'Xiaomi',
        models: [{
          provider: 'xiaomi',
          providerName: 'Xiaomi Token Plan',
          id: 'mimo-v2.5-pro',
          name: 'MiMo V2.5 Pro',
          efforts: [{ id: 'thinking', name: 'Thinking', isDefault: false }],
        }],
      },
    ],
    failures: [],
    ...overrides,
  }
}

function request(scopeEpoch: number, requestId: number): ModelsRequestStamp {
  return { scopeEpoch, requestId }
}

class FakeModelsPort implements SessionModelPort {
  value: SessionModelSnapshot = snapshot()
  readonly listeners = new Set<() => void>()
  readonly refreshCalls: Array<AbortSignal | undefined> = []
  readonly selectCalls: Array<{
    readonly selection: DshTuiModelSelection
    readonly options: SessionModelSelectOptions | undefined
  }> = []
  refreshImplementation: (signal?: AbortSignal) => Promise<void> = async () => {}
  selectImplementation: (
    selection: DshTuiModelSelection,
    options?: SessionModelSelectOptions,
  ) => Promise<void> = async () => {}
  snapshotError: unknown
  stopCalls = 0

  modelSnapshot(): SessionModelSnapshot {
    if (this.snapshotError !== undefined) throw this.snapshotError
    return this.value
  }

  refreshModels(signal?: AbortSignal): Promise<void> {
    this.refreshCalls.push(signal)
    return this.refreshImplementation(signal)
  }

  selectModel(
    selection: DshTuiModelSelection,
    options?: SessionModelSelectOptions,
  ): Promise<void> {
    this.selectCalls.push({ selection, options })
    return this.selectImplementation(selection, options)
  }

  onModelsChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.stopCalls += 1
      this.listeners.delete(listener)
    }
  }

  disposeModels(): void {}

  emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

class FakeAgentStatusPort implements SessionAgentStatusPort {
  value: SessionAgentStatusSnapshot = { status: 'idle' }
  readonly listeners = new Set<() => void>()
  snapshotError: unknown
  watchError: unknown
  stopCalls = 0

  snapshot(): SessionAgentStatusSnapshot {
    if (this.snapshotError !== undefined) throw this.snapshotError
    return this.value
  }

  onChanged(listener: () => void): () => void {
    if (this.watchError !== undefined) throw this.watchError
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.stopCalls += 1
      this.listeners.delete(listener)
    }
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

async function createInstance(
  port = new FakeModelsPort(),
  status = new FakeAgentStatusPort(),
): Promise<{
  readonly manager: ScopeManager
  readonly session: ResourceScope
  readonly instance: ModelsFeatureInstance
  readonly port: FakeModelsPort
  readonly status: FakeAgentStatusPort
}> {
  const manager = new ScopeManager()
  const session = manager.createSession('models')
  const instance = await modelsFeature.create({
    scope: session,
    dependencies: [
      { token: SESSION_MODELS_CAPABILITY, value: port },
      { token: SESSION_AGENT_STATUS_CAPABILITY, value: status },
    ],
  }) as ModelsFeatureInstance
  return { manager, session, instance, port, status }
}

function loadContext(
  scope: ResourceScope,
  requestId: number,
  signal = new AbortController().signal,
  previous?: SessionModelSnapshot,
): ResourceLoadContext<SessionModelSnapshot> {
  return { scope, signal, requestId, previous }
}

function projectContext(
  overrides: Partial<FeatureSurfaceProjectContext> = {},
): FeatureSurfaceProjectContext {
  return {
    bounds: { x: 0, y: 0, width: 160, height: 20 },
    focus: true,
    mode: 'normal',
    resources: [],
    ...overrides,
  }
}

function routed(command: RoutedUiCommand['command']): RoutedUiCommand {
  return {
    target: { kind: 'feature', featureId: MODELS_FEATURE_ID },
    command,
  }
}

describe('Models Feature projectors and state machine', () => {
  it('keeps the current model selected when its provider default differs from the saved default effort', () => {
    const state = transitionModelsFeature(createModelsFeatureState(), {
      type: 'snapshot.changed', snapshot: snapshot({
        current: { provider: 'deepseek', model: 'deepseek-reasoner' },
        defaultSelection: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'quick' },
      }),
    }).state
    expect(selectedModelsChoice(state)).toMatchObject({ model: 'deepseek-reasoner', reasoningEffort: 'thorough' })
  })

  it('bounds the separate reasoning choice and preserves it across a catalog refresh', () => {
    const model = createModelsFeatureModel()
    const idle = model.snapshot()
    model.dispatch({ type: 'effort.move', direction: 'left' })
    expect(model.snapshot()).toBe(idle)
    const { current: _current, ...withoutCurrent } = snapshot()
    model.dispatch({ type: 'snapshot.changed', snapshot: withoutCurrent })
    expect(createModelsContentNode(model).project(projectContext()).rows.some(row => row.text.startsWith('CURRENT'))).toBe(false)
    expect(selectedModelsChoice(model.snapshot())?.reasoningEffort).toBe('thorough')
    model.dispatch({ type: 'effort.move', direction: 'right' })
    expect(selectedModelsChoice(model.snapshot())?.reasoningEffort).toBe('thorough')
    const index = model.snapshot().selectedIndex
    model.dispatch({ type: 'effort.move', direction: 'left' })
    expect(selectedModelsChoice(model.snapshot())?.reasoningEffort).toBe('quick')
    model.dispatch({ type: 'effort.move', direction: 'left' })
    expect(model.snapshot().selectedIndex).toBe(index)
    model.dispatch({ type: 'snapshot.changed', snapshot: withoutCurrent })
    expect(selectedModelsChoice(model.snapshot())?.reasoningEffort).toBe('quick')
    const tiny = createModelsContentNode(model).project(projectContext({ bounds: { x: 0, y: 0, width: 60, height: 3 } }))
    expect(tiny.rows).toHaveLength(3)
    expect(tiny.rows[1]?.text).toContain('Quick')
    expect(tiny.rows[2]).toMatchObject({ selected: true })
    model.dispose()
  })

  it('lists each model once and navigates models independently of reasoning effort', () => {
    const model = createModelsFeatureModel()
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot() })
    const rows = createModelsContentNode(model).project(projectContext()).rows
    expect(rows.filter(row => row.text.includes('DeepSeek Reasoner'))).toHaveLength(1)
    model.dispatch({ type: 'selection.move', direction: 'down' })
    expect(selectedModelsChoice(model.snapshot())?.model).toBe('deepseek-reasoner')
    model.dispatch({ type: 'selection.move', direction: 'down' })
    expect(selectedModelsChoice(model.snapshot())?.model).toBe('mimo-v2.5-pro')
    model.dispose()
  })

  it('detaches adapter data and projects catalogued provider/model/effort routes', () => {
    const detached = detachModelsSnapshot(snapshot())
    const choices = projectModelsChoices(detached)

    expect(choices.map(choice => ({
      provider: choice.provider,
      model: choice.model,
      effort: choice.reasoningEffort,
      effortName: choice.reasoningEffortName,
    }))).toEqual([
      { provider: 'deepseek', model: 'deepseek-chat', effort: 'opaque-live', effortName: 'opaque-live' },
      { provider: 'deepseek', model: 'deepseek-reasoner', effort: 'quick', effortName: 'Quick' },
      { provider: 'deepseek', model: 'deepseek-reasoner', effort: 'thorough', effortName: 'Thorough' },
      { provider: 'xiaomi', model: 'mimo-v2.5-pro', effort: undefined, effortName: 'Provider default' },
      { provider: 'xiaomi', model: 'mimo-v2.5-pro', effort: 'thinking', effortName: 'Thinking' },
    ])
    expect(choices[0]).toMatchObject({
      catalogued: true,
      routable: true,
      isCurrent: true,
      isDefault: false,
      description: 'General chat',
    })
    expect(choices[1]).toMatchObject({ description: 'Short reasoning', isReasoningDefault: false })
    expect(choices[2]).toMatchObject({ isDefault: true, isReasoningDefault: true })
    expect(modelsChoiceSelection(choices[1]!)).toEqual({
      provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'quick',
    })
    expect(modelsChoiceKey(modelsChoiceSelection(choices[3]!)))
      .toBe('["xiaomi","mimo-v2.5-pro",null]')
    expect(Object.isFrozen(detached.groups[0]?.models[0]?.efforts)).toBe(true)
    expect(Object.isFrozen(detached.failures)).toBe(true)
    expect(projectModelsChoices(undefined)).toEqual([])
  })

  it('retains unlisted current/default routes without granting missing provider authority', () => {
    const choices = projectModelsChoices(snapshot({
      current: {
        provider: 'removed',
        model: 'current-only',
        reasoningEffort: 'opaque-live',
      },
      defaultSelection: {
        provider: 'degraded',
        model: 'saved-only',
        reasoningEffort: 'balanced',
      },
      routable: false,
      groups: [],
      failures: [{ provider: 'degraded', message: 'catalog unavailable' }],
    }))

    expect(choices).toEqual([
      expect.objectContaining({
        provider: 'removed',
        providerName: 'removed',
        model: 'current-only',
        modelName: 'current-only',
        reasoningEffort: 'opaque-live',
        catalogued: false,
        routable: false,
        isCurrent: true,
        isDefault: false,
      }),
      expect.objectContaining({
        provider: 'degraded',
        model: 'saved-only',
        reasoningEffort: 'balanced',
        catalogued: false,
        routable: true,
        isCurrent: false,
        isDefault: true,
      }),
    ])

    const retainedEffort = projectModelsChoices({
      current: {
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        reasoningEffort: 'retired',
      },
      routable: true,
      writable: true,
      loading: false,
      selecting: false,
      groups: [{
        id: 'deepseek',
        name: 'DeepSeek',
        models: [{
          provider: 'deepseek',
          providerName: 'DeepSeek',
          id: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          description: 'Reasoning model',
          efforts: [{ id: 'quick', name: 'Quick', isDefault: true }],
        }],
      }],
      failures: [],
    })
    expect(retainedEffort[0]).toMatchObject({
      reasoningEffort: 'retired',
      reasoningEffortName: 'retired',
      description: 'Reasoning model',
      catalogued: false,
      routable: true,
    })
  })

  it('keeps a stable choice across reorder and clamps movement', () => {
    let state = createModelsFeatureState()
    expect(selectedModelsChoice(state)).toBeUndefined()
    expect(transitionModelsFeature(state, { type: 'selection.move', direction: 'down' }).state)
      .toBe(state)
    state = transitionModelsFeature(state, {
      type: 'load.started', request: request(1, 1),
    }).state
    expect(state.phase).toBe('loading')
    state = transitionModelsFeature(state, {
      type: 'load.succeeded', request: request(1, 1), snapshot: snapshot(),
    }).state
    expect(selectedModelsChoice(state)?.reasoningEffort).toBe('opaque-live')
    expect(transitionModelsFeature(state, { type: 'selection.move', direction: 'up' }).state)
      .toBe(state)
    state = transitionModelsFeature(state, { type: 'selection.move', direction: 'down' }).state
    const stableKey = state.selectedKey
    state = transitionModelsFeature(state, {
      type: 'snapshot.changed', snapshot: snapshot({ groups: [...snapshot().groups].reverse() }),
    }).state
    expect(state.selectedKey).toBe(stableKey)
    expect(selectedModelsChoice(state)?.reasoningEffort).toBe('thorough')
    for (let index = 0; index < 10; index += 1) {
      state = transitionModelsFeature(state, { type: 'selection.move', direction: 'down' }).state
    }
    expect(transitionModelsFeature(state, { type: 'selection.move', direction: 'down' }).state)
      .toBe(state)
  })

  it('uses latest load results and retains last-good data on failure', () => {
    let state = transitionModelsFeature(createModelsFeatureState(), {
      type: 'load.started', request: request(2, 1),
    }).state
    state = transitionModelsFeature(state, {
      type: 'load.succeeded', request: request(2, 1), snapshot: snapshot(),
    }).state
    const lastGood = state.snapshot
    state = transitionModelsFeature(state, {
      type: 'load.started', request: request(2, 2),
    }).state
    expect(state.phase).toBe('refreshing')
    state = transitionModelsFeature(state, {
      type: 'load.started', request: request(2, 3),
    }).state
    expect(transitionModelsFeature(state, {
      type: 'load.succeeded', request: request(2, 2), snapshot: snapshot({ groups: [] }),
    }).state).toBe(state)
    expect(transitionModelsFeature(state, {
      type: 'load.failed', request: request(2, 2), message: 'late',
    }).state).toBe(state)
    state = transitionModelsFeature(state, {
      type: 'load.failed', request: request(2, 3), message: 'offline',
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'offline', snapshot: lastGood })
  })

  it('emits refresh effects and records blocked selections without discarding last-good data', () => {
    const ready = transitionModelsFeature(createModelsFeatureState(), {
      type: 'snapshot.changed', snapshot: snapshot(),
    }).state
    const running = transitionModelsFeature(ready, {
      type: 'status.changed', status: { status: 'running' },
    }).state
    expect(running.agentStatus).toEqual({ status: 'running' })
    expect(Object.isFrozen(running.agentStatus)).toBe(true)
    const refresh = transitionModelsFeature(ready, { type: 'refresh.requested' })
    expect(refresh.state).toBe(ready)
    expect(refresh.effects).toEqual([{
      type: 'resource.refresh',
      resourceId: MODELS_RESOURCE_ID,
    }])
    const blocked = transitionModelsFeature(ready, {
      type: 'selection.blocked', message: 'Agent is running',
    })
    expect(blocked.effects).toEqual([])
    expect(blocked.state).toMatchObject({
      phase: 'ready',
      error: 'Agent is running',
      snapshot: ready.snapshot,
    })
  })

  it('keeps only the latest selection completion and optional failure snapshot', () => {
    let state = transitionModelsFeature(createModelsFeatureState(), {
      type: 'snapshot.changed', snapshot: snapshot(),
    }).state
    const first = modelsChoiceSelection(selectedModelsChoice(state)!)
    const second = { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'quick' }
    state = transitionModelsFeature(state, {
      type: 'selection.started', requestId: 1, selection: first,
    }).state
    state = transitionModelsFeature(state, {
      type: 'selection.started', requestId: 2, selection: second,
    }).state
    expect(transitionModelsFeature(state, {
      type: 'selection.succeeded', requestId: 1, snapshot: snapshot({ current: first }),
    }).state).toBe(state)
    expect(transitionModelsFeature(state, {
      type: 'selection.failed', requestId: 1, message: 'late',
    }).state).toBe(state)
    state = transitionModelsFeature(state, {
      type: 'selection.failed', requestId: 2, message: 'rejected', snapshot: snapshot({ current: first }),
    }).state
    expect(state).toMatchObject({ phase: 'failed', selecting: false, error: 'rejected' })
    state = transitionModelsFeature(state, {
      type: 'selection.started', requestId: 3, selection: second,
    }).state
    state = transitionModelsFeature(state, {
      type: 'selection.succeeded', requestId: 3, snapshot: snapshot({ current: second }),
    }).state
    expect(state).toMatchObject({ phase: 'ready', selecting: false, snapshot: { current: second } })
    state = transitionModelsFeature(state, {
      type: 'selection.started', requestId: 4, selection: first,
    }).state
    state = transitionModelsFeature(state, {
      type: 'selection.failed', requestId: 4, message: 'no replacement',
    }).state
    expect(state.snapshot?.current).toEqual(second)
  })

  it('reconciles current/default/fallback choices and snapshot errors', () => {
    let state = transitionModelsFeature(createModelsFeatureState(), {
      type: 'snapshot.changed',
      snapshot: snapshot({ current: { provider: 'deepseek', model: 'deepseek-reasoner' } }),
    }).state
    expect(selectedModelsChoice(state)?.reasoningEffort).toBe('thorough')
    state = transitionModelsFeature(createModelsFeatureState(), {
      type: 'snapshot.changed',
      snapshot: snapshot({ current: { provider: 'missing', model: 'missing' } }),
    }).state
    expect(selectedModelsChoice(state)).toMatchObject({
      provider: 'missing',
      model: 'missing',
      catalogued: false,
      routable: true,
      isCurrent: true,
    })
    state = transitionModelsFeature(createModelsFeatureState(), {
      type: 'snapshot.changed',
      snapshot: snapshot({
        current: { provider: 'missing', model: 'missing' },
        defaultSelection: { provider: 'missing', model: 'also-missing' },
      }),
    }).state
    expect(state.selectedIndex).toBe(0)
    state = transitionModelsFeature(state, {
      type: 'snapshot.changed', snapshot: snapshot({ groups: [], error: 'unavailable' }),
    }).state
    expect(state).toMatchObject({ phase: 'failed', selectedIndex: 0, error: 'unavailable' })
    state = transitionModelsFeature(state, {
      type: 'snapshot.failed', message: 'snapshot exploded',
    }).state
    expect(state.error).toBe('snapshot exploded')

    const retainedDefault = projectModelsChoices(snapshot({
      current: { provider: 'deepseek', model: 'deepseek-reasoner' },
      defaultSelection: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        reasoningEffort: 'opaque-default',
      },
    }))
    expect(retainedDefault.find(choice => choice.isDefault)?.reasoningEffort)
      .toBe('opaque-default')

    const catalog = snapshot()
    const {
      current: _current,
      defaultSelection: _defaultSelection,
      ...withoutSelections
    } = catalog
    state = transitionModelsFeature(createModelsFeatureState(), {
      type: 'snapshot.changed',
      snapshot: {
        ...withoutSelections,
        defaultSelection: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'quick' },
      },
    }).state
    expect(selectedModelsChoice(state)).toMatchObject({ isDefault: true, reasoningEffort: 'quick' })
    state = transitionModelsFeature(createModelsFeatureState(), {
      type: 'snapshot.changed', snapshot: withoutSelections,
    }).state
    expect(state.selectedIndex).toBe(0)

    state = transitionModelsFeature(createModelsFeatureState(), {
      type: 'load.started', request: request(11, 1),
    }).state
    state = transitionModelsFeature(state, {
      type: 'snapshot.changed', snapshot: snapshot(),
    }).state
    expect(state.phase).toBe('loading')
    expect(state.error).toBeUndefined()

    state = transitionModelsFeature(createModelsFeatureState(), {
      type: 'selection.started',
      requestId: 7,
      selection: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
    }).state
    state = transitionModelsFeature(state, {
      type: 'selection.failed', requestId: 7, message: 'empty last-good',
    }).state
    expect(state.snapshot).toBeUndefined()
  })
})

describe('Models Feature model and semantic surface', () => {
  it('advertises only actions available for the selected model and Agent state', () => {
    const model = createModelsFeatureModel()
    const node = createModelsContentNode(model)
    const hint = () => node.project(projectContext()).actionHint
    expect(hint()).toContain('R retry')
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot() })
    expect(hint()).toContain('Wait for Agent')
    model.dispatch({ type: 'status.changed', status: { status: 'idle' } })
    expect(hint()).toContain('Enter apply · Ctrl+S default')
    expect(hint()).not.toContain('←→')
    model.dispatch({ type: 'selection.move', direction: 'down' })
    expect(hint()).toContain('←→ reasoning')
    model.dispatch({ type: 'selection.move', direction: 'up' })
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot({ writable: false }) })
    expect(hint()).toContain('Read-only')
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot({ selecting: true }) })
    expect(hint()).toBe('Applying model…')
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot({ routable: false }) })
    expect(hint()).toContain('choose an available model')
    model.dispatch({ type: 'selection.started', requestId: 1, selection: snapshot().current! })
    expect(hint()).toBe('Applying model…')
    model.dispose()
  })

  it('isolates listener errors and disposes idempotently', () => {
    const model = createModelsFeatureModel()
    const observed: string[] = []
    const effects: ModelsFeatureEffect[] = []
    const stopThrowing = model.onChanged(() => { throw new Error('renderer failed') })
    const stop = model.onChanged(state => { observed.push(state.phase) })
    const stopThrowingEffect = model.onEffect(() => { throw new Error('adapter failed') })
    const stopEffect = model.onEffect(effect => { effects.push(effect) })
    expect(model.dispatch({ type: 'refresh.requested' })).toEqual([{
      type: 'resource.refresh', resourceId: MODELS_RESOURCE_ID,
    }])
    expect(effects).toEqual([{ type: 'resource.refresh', resourceId: MODELS_RESOURCE_ID }])
    model.dispatch({ type: 'selection.move', direction: 'down' })
    expect(observed).toEqual([])
    model.dispatch({ type: 'snapshot.failed', message: 'offline' })
    expect(observed).toEqual(['failed'])
    stopThrowing()
    stopThrowing()
    stop()
    stopThrowingEffect()
    stopThrowingEffect()
    stopEffect()
    model.dispatch({ type: 'snapshot.failed', message: 'again' })
    model.dispose()
    model.dispose()
    expect(() => model.onChanged(() => {})).toThrow('Models Feature model is disposed')
    expect(() => model.onEffect(() => {})).toThrow('Models Feature model is disposed')
    expect(() => model.dispatch({ type: 'snapshot.failed', message: 'late' }))
      .toThrow('Models Feature model is disposed')
  })

  it('renders provider/model/reasoning, failures, read-only and a bounded selection', () => {
    const model = createModelsFeatureModel()
    const node = createModelsContentNode(model)
    let invalidations = 0
    const stop = node.onChanged(() => { invalidations += 1 })
    model.dispatch({ type: 'snapshot.changed', snapshot: snapshot() })
    expect(invalidations).toBe(1)
    let projection = node.project(projectContext())
    const text = projection.rows.map(row => row.text).join('\n')
    expect(text).toContain('CURRENT  deepseek / deepseek-chat')
    expect(text).toContain('Reasoning  opaque-live')
    expect(text).toContain('DeepSeek Chat · DeepSeek')
    expect(projection.rows.some(row => row.selected)).toBe(true)
    model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshot({
        writable: false,
        failures: [{ provider: 'bad\u001b[2J', message: 'failed\u0000catalog' }],
      }),
    })
    model.dispatch({ type: 'snapshot.failed', message: 'refresh\u001b[31m failed' })
    projection = node.project(projectContext({ bounds: { x: 0, y: 0, width: 80, height: 30 } }))
    const failedText = projection.rows.map(row => row.text).join('\n')
    expect(failedText).toContain('Read-only')
    expect(failedText).toContain('Last operation failed')
    expect(failedText).toContain('bad · failed')
    expect(failedText).toContain('catalog')
    expect(failedText).not.toContain('\u001b')
    for (let index = 0; index < 4; index += 1) {
      model.dispatch({ type: 'selection.move', direction: 'down' })
    }
    projection = node.project(projectContext({ bounds: { x: 0, y: 0, width: 200, height: 10 } }))
    expect(projection.rows.length).toBeLessThanOrEqual(10)
    expect(projection.rows.at(-1)?.text).toContain('MiMo V2.5 Pro')
    stop()
    model.dispose()
  })

  it('projects idle/loading/refreshing/ready empty states', () => {
    const model = createModelsFeatureModel()
    const node = createModelsContentNode(model)
    expect(node.project(projectContext()).rows).toEqual([
      expect.objectContaining({ text: '0 models' }),
      expect.objectContaining({ text: 'No models available · R retry; check provider settings', tone: 'muted' }),
    ])
    expect(node.project(projectContext({
      resources: [{ id: MODELS_RESOURCE_ID, phase: 'loading' }],
    })).rows.map(row => row.text)).toEqual([
      '0 models · loading…',
      'Loading provider model catalogs…',
    ])
    model.dispatch({ type: 'load.started', request: request(9, 1) })
    model.dispatch({
      type: 'load.succeeded', request: request(9, 1),
      snapshot: {
        routable: false,
        writable: true,
        loading: false,
        selecting: false,
        groups: [],
        failures: [],
      },
    })
    expect(node.project(projectContext()).rows.at(-1)?.text).toBe('No models available · R retry; check provider settings')
    expect(node.project(projectContext()).rows.at(-1)?.tone).toBe('success')
    model.dispatch({ type: 'load.started', request: request(9, 2) })
    expect(node.project(projectContext()).rows[0]?.text).toContain('refreshing')
    model.dispatch({ type: 'load.failed', request: request(9, 2), message: 'offline' })
    expect(node.project(projectContext()).rows[0]).toMatchObject({ tone: 'danger' })
    model.dispose()
  })

  it('renders singular routes, unroutable current state, and provider-default reasoning', () => {
    const model = createModelsFeatureModel()
    const node = createModelsContentNode(model)
    model.dispatch({
      type: 'snapshot.changed',
      snapshot: {
        current: { provider: 'solo', model: 'one' },
        routable: false,
        writable: true,
        loading: false,
        selecting: false,
        groups: [{
          id: 'solo',
          name: 'Solo',
          models: [{
            provider: 'solo',
            providerName: 'Solo',
            id: 'one',
            name: 'One',
            efforts: [],
          }],
        }],
        failures: [],
      },
    })
    const projection = node.project(projectContext())
    expect(projection.rows[0]?.text).toBe('1 model')
    expect(projection.actionHint).not.toContain('Enter apply')
    expect(projection.rows[2]).toMatchObject({ tone: 'warning' })
    expect(projection.rows[3]?.text).toContain('provider default')
    expect(projection.rows.at(-1)?.text).toContain('unroutable')
    model.dispatch({
      type: 'snapshot.changed',
      snapshot: snapshot({
        current: { provider: 'gone', model: 'old' },
        defaultSelection: { provider: 'saved', model: 'fallback' },
        routable: false,
        groups: [],
      }),
    })
    const retained = node.project(projectContext()).rows.map(row => row.text).join('\n')
    expect(retained).toContain('old · gone · current/retained/unroutable')
    expect(retained).toContain('fallback · saved · default/retained/unroutable')
    model.dispose()
  })
})

describe('Models Feature factory, lazy Resource, commands, and keymap', () => {
  it('declares a lazy session workspace without listing during create', async () => {
    const { manager, instance, port, status } = await createInstance()
    expect(modelsFeature.manifest).toEqual({
      id: MODELS_FEATURE_ID,
      apiVersion: 1,
      scope: 'session',
      activation: 'on-route',
      required: false,
      requires: [SESSION_MODELS_CAPABILITY, SESSION_AGENT_STATUS_CAPABILITY],
    })
    expect(modelsFeature.declarations).toEqual({
      routes: [MODELS_ROUTE_ID],
      commands: [
        'navigation.move',
        'navigation.activate',
        MODELS_MOVE_UP_COMMAND_ID,
        MODELS_MOVE_DOWN_COMMAND_ID,
        MODELS_SELECT_COMMAND_ID,
        MODELS_SAVE_DEFAULT_COMMAND_ID,
        MODELS_REFRESH_COMMAND_ID,
        MODELS_EFFORT_PREVIOUS_COMMAND_ID,
        MODELS_EFFORT_NEXT_COMMAND_ID,
      ],
      keymaps: [MODELS_KEYMAP_ID],
      resources: [MODELS_RESOURCE_ID],
      surfaces: [{ slot: 'workspace.content', cardinality: 'multiple' }],
    })
    expect(port.refreshCalls).toEqual([])
    expect(instance.model.snapshot().phase).toBe('idle')
    expect(instance.contributions.routes).toEqual([{
      id: MODELS_ROUTE_ID,
      value: { kind: 'workspace', featureId: MODELS_FEATURE_ID, pane: 'content' },
    }])
    expect(instance.contributions.surfaces?.[0]).toMatchObject({
      id: MODELS_CONTENT_SURFACE_ID,
      slot: 'workspace.content',
      value: {
        id: MODELS_CONTENT_SURFACE_ID,
        role: 'content',
        node: {
          kind: 'models.content',
          featureId: MODELS_FEATURE_ID,
          resourceId: MODELS_RESOURCE_ID,
        },
      },
    })
    const node = instance.contributions.surfaces?.[0]?.value.node
    expect(node?.state.snapshot()).toBe(instance.model.snapshot())
    const stopNodeState = node?.state.onChanged(() => {})
    stopNodeState?.()
    const keymap = instance.contributions.keymaps?.[0]?.value
    expect(keymap).toEqual({
      context: { routeKind: 'workspace', featureId: MODELS_FEATURE_ID, mode: 'normal' },
      bindings: [
        { key: 'k', commandId: MODELS_MOVE_UP_COMMAND_ID },
        { key: 'j', commandId: MODELS_MOVE_DOWN_COMMAND_ID },
        { key: 'enter', commandId: MODELS_SELECT_COMMAND_ID },
        { key: 's', ctrl: true, commandId: MODELS_SAVE_DEFAULT_COMMAND_ID },
        { key: 'r', commandId: MODELS_REFRESH_COMMAND_ID },
        { key: 'left', commandId: MODELS_EFFORT_PREVIOUS_COMMAND_ID },
        { key: 'right', commandId: MODELS_EFFORT_NEXT_COMMAND_ID },
        { key: 'h', commandId: MODELS_EFFORT_PREVIOUS_COMMAND_ID },
        { key: 'l', commandId: MODELS_EFFORT_NEXT_COMMAND_ID },
      ],
    })
    expect(keymap?.bindings.some(binding => binding.key === 'escape')).toBe(false)
    expect(port.listeners.size).toBe(0)
    expect(status.listeners.size).toBe(0)
    await instance.dispose()
    await instance.dispose()
    expect(port.stopCalls).toBe(0)
    expect(status.stopCalls).toBe(0)
    await manager.dispose()
  })

  it('owns model watches by surface close/reopen and refreshes only on first open', async () => {
    const { manager, session, instance, port, status } = await createInstance()
    const coordinator = new ResourceCoordinator()
    const firstSurface = session.child('surface', 'models-content-1')
    const resource = instance.contributions.resources?.[0]?.value
    expect(resource).toMatchObject({
      key: MODELS_RESOURCE_ID,
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
    })
    expect(resource?.watch).toEqual(expect.any(Function))
    const first = await coordinator.activate(firstSurface, resource!)
    expect(port.refreshCalls).toHaveLength(1)
    expect(first.value).toEqual(snapshot())
    expect(port.listeners.size).toBe(1)
    expect(status.listeners.size).toBe(1)
    expect(instance.model.snapshot().agentStatus).toEqual({ status: 'idle' })

    port.value = snapshot({ current: { provider: 'xiaomi', model: 'mimo-v2.5-pro' } })
    port.emit()
    expect(instance.model.snapshot().snapshot?.current).toEqual(port.value.current)

    const staleListener = [...port.listeners][0]
    const staleStatusListener = [...status.listeners][0]
    await firstSurface.dispose('models page closed')
    expect(port.listeners.size).toBe(0)
    expect(port.stopCalls).toBe(1)
    expect(status.listeners.size).toBe(0)
    expect(status.stopCalls).toBe(1)
    staleListener?.()
    staleStatusListener?.()
    const visibleBeforeClosedChange = instance.model.snapshot().snapshot?.current
    port.value = snapshot({ current: { provider: 'deepseek', model: 'deepseek-reasoner' } })
    port.emit()
    expect(instance.model.snapshot().snapshot?.current).toEqual(visibleBeforeClosedChange)

    const secondSurface = session.child('surface', 'models-content-2')
    const reopened = await coordinator.activate(secondSurface, resource!)
    expect(port.refreshCalls).toHaveLength(1)
    expect(port.listeners.size).toBe(1)
    expect(status.listeners.size).toBe(1)
    expect(reopened.value?.current).toEqual(port.value.current)
    expect(instance.model.snapshot().snapshot?.current).toEqual(port.value.current)

    port.snapshotError = new Error('watch snapshot failed')
    port.emit()
    expect(instance.model.snapshot()).toMatchObject({
      phase: 'failed',
      error: 'watch snapshot failed',
    })
    port.snapshotError = undefined
    status.snapshotError = new Error('status snapshot failed')
    status.emit()
    expect(instance.model.snapshot().error).toBe('status snapshot failed')
    status.snapshotError = undefined
    port.emit()
    status.value = { status: 'running' }
    status.emit()
    expect(instance.model.snapshot().agentStatus).toEqual({ status: 'running' })
    await secondSurface.dispose('models page closed again')
    expect(port.stopCalls).toBe(2)
    expect(status.stopCalls).toBe(2)
    await instance.dispose()
    await manager.dispose()
  })

  it('cleans partial/duplicate watch disposal and ignores refreshes after watch abort', async () => {
    const status = new FakeAgentStatusPort()
    status.watchError = new Error('status watch failed')
    const { manager, session, instance, port } = await createInstance(new FakeModelsPort(), status)
    const resource = instance.contributions.resources?.[0]?.value!
    const firstSurface = session.child('surface', 'models-watch-failure')
    expect(() => resource.watch?.({
      scope: firstSurface,
      signal: firstSurface.signal,
      invalidate: vi.fn(),
    })).toThrow('status watch failed')
    expect(port.listeners.size).toBe(0)
    expect(port.stopCalls).toBe(1)

    status.watchError = undefined
    const secondSurface = session.child('surface', 'models-watch-abort')
    const invalidate = vi.fn()
    const stop = resource.watch?.({
      scope: secondSurface,
      signal: secondSurface.signal,
      invalidate,
    }) as () => void
    await secondSurface.dispose('closed')
    instance.model.dispatch({ type: 'refresh.requested' })
    port.emit()
    status.emit()
    expect(invalidate).not.toHaveBeenCalled()
    stop()
    stop()
    await firstSurface.dispose('cleanup')
    await instance.dispose()
    await manager.dispose()
  })

  it('retries aborted/failed initial refresh and retains last-good state', async () => {
    const { manager, session, instance, port } = await createInstance()
    const surface = session.child('surface', 'models-content')
    const resource = instance.contributions.resources?.[0]?.value
    const pending = deferred<void>()
    port.refreshImplementation = () => pending.promise
    const abort = new AbortController()
    const abandoned = resource?.load(loadContext(surface, 1, abort.signal))
    abort.abort('closed')
    pending.reject(new Error('aborted'))
    await expect(abandoned).rejects.toThrow('aborted')
    expect(instance.model.snapshot().phase).toBe('loading')

    port.refreshImplementation = async () => { throw 'offline' }
    await expect(resource?.load(loadContext(surface, 2))).rejects.toBe('offline')
    expect(instance.model.snapshot()).toMatchObject({ phase: 'failed', error: 'offline' })
    expect(port.refreshCalls).toHaveLength(2)

    port.refreshImplementation = async () => {}
    await expect(resource?.load(loadContext(surface, 3))).resolves.toEqual(snapshot())
    const lastGood = instance.model.snapshot().snapshot
    port.snapshotError = new Error('snapshot unavailable')
    await expect(resource?.load(loadContext(surface, 4))).rejects.toThrow('snapshot unavailable')
    expect(instance.model.snapshot()).toMatchObject({
      phase: 'failed', error: 'snapshot unavailable', snapshot: lastGood,
    })
    port.emit()
    expect(instance.model.snapshot().error).toBe('snapshot unavailable')
    await instance.dispose()
    await manager.dispose()
  })

  it('routes movement and makes the latest Enter selection win', async () => {
    const { manager, session, instance, port } = await createInstance()
    const surface = session.child('surface', 'models-content')
    const coordinator = new ResourceCoordinator()
    await coordinator.activate(surface, instance.contributions.resources?.[0]?.value!)
    const handlers = new Map(instance.contributions.commands?.map(command => [
      command.id,
      command.value as FeatureCommandHandler,
    ]))
    const context = {
      navigation: {
        value: 'workspace' as const,
        route: { kind: 'workspace' as const, featureId: MODELS_FEATURE_ID, pane: 'content' as const },
        mode: 'normal' as const,
        focus: { kind: 'feature' as const, featureId: MODELS_FEATURE_ID },
        overlays: [],
      },
      openRoute: vi.fn(async () => {}),
    }
    await handlers.get('navigation.move')?.handle(
      routed({ type: 'navigation.activate' }), context,
    )
    await handlers.get('navigation.move')?.handle(
      routed({ type: 'navigation.move', direction: 'left' }), context,
    )
    expect(instance.model.snapshot().selectedIndex).toBe(0)
    await handlers.get(MODELS_MOVE_DOWN_COMMAND_ID)?.handle(
      routed({ type: 'feature.command', commandId: MODELS_MOVE_DOWN_COMMAND_ID }), context,
    )
    expect(selectedModelsChoice(instance.model.snapshot())?.reasoningEffort).toBe('thorough')
    await handlers.get(MODELS_MOVE_UP_COMMAND_ID)?.handle(
      routed({ type: 'feature.command', commandId: MODELS_MOVE_UP_COMMAND_ID }), context,
    )
    await handlers.get('navigation.move')?.handle(
      routed({ type: 'navigation.move', direction: 'down' }), context,
    )

    await handlers.get(MODELS_EFFORT_PREVIOUS_COMMAND_ID)!.handle(
      routed({ type: 'feature.command', commandId: MODELS_EFFORT_PREVIOUS_COMMAND_ID }), context,
    )
    expect(selectedModelsChoice(instance.model.snapshot())?.reasoningEffort).toBe('quick')
    expect(port.selectCalls).toHaveLength(0)
    await handlers.get(MODELS_EFFORT_NEXT_COMMAND_ID)!.handle(
      routed({ type: 'feature.command', commandId: MODELS_EFFORT_NEXT_COMMAND_ID }), context,
    )
    await handlers.get(MODELS_EFFORT_PREVIOUS_COMMAND_ID)!.handle(
      routed({ type: 'feature.command', commandId: MODELS_EFFORT_PREVIOUS_COMMAND_ID }), context,
    )

    const selections: Deferred<void>[] = []
    port.selectImplementation = async () => {
      const pending = deferred<void>()
      selections.push(pending)
      return pending.promise
    }
    const first = handlers.get('navigation.activate')!.handle(
      routed({ type: 'navigation.activate' }), context,
    ) as Promise<void>
    expect(port.selectCalls[0]?.selection).toMatchObject({ reasoningEffort: 'quick' })
    await handlers.get(MODELS_MOVE_DOWN_COMMAND_ID)?.handle(
      routed({ type: 'feature.command', commandId: MODELS_MOVE_DOWN_COMMAND_ID }), context,
    )
    const secondChoice = selectedModelsChoice(instance.model.snapshot())
    const second = handlers.get(MODELS_SELECT_COMMAND_ID)!.handle(
      routed({ type: 'feature.command', commandId: MODELS_SELECT_COMMAND_ID }), context,
    ) as Promise<void>
    expect(port.selectCalls[0]?.options?.signal?.aborted).toBe(true)
    expect(port.selectCalls[1]?.selection).toEqual(modelsChoiceSelection(secondChoice!))
    port.value = snapshot({ current: port.selectCalls[1]!.selection })
    selections[1]!.resolve()
    await second
    const latestSnapshot = instance.model.snapshot().snapshot
    port.value = snapshot({ current: port.selectCalls[0]!.selection })
    selections[0]!.resolve()
    await first
    expect(instance.model.snapshot().snapshot).toBe(latestSnapshot)
    expect(instance.model.snapshot()).toMatchObject({
      phase: 'ready', selecting: false, snapshot: { current: port.selectCalls[1]!.selection },
    })
    await instance.dispose()
    await manager.dispose()
  })

  it('refreshes the open Resource on R and saves the selected route on Ctrl+S', async () => {
    const { manager, session, instance, port } = await createInstance()
    const surface = session.child('surface', 'models-content')
    const coordinator = new ResourceCoordinator()
    await coordinator.activate(surface, instance.contributions.resources?.[0]?.value!)
    const handlers = new Map(instance.contributions.commands?.map(command => [
      command.id,
      command.value as FeatureCommandHandler,
    ]))
    const context = {
      navigation: {
        value: 'workspace' as const,
        route: { kind: 'workspace' as const, featureId: MODELS_FEATURE_ID, pane: 'content' as const },
        mode: 'normal' as const,
        focus: { kind: 'feature' as const, featureId: MODELS_FEATURE_ID },
        overlays: [],
      },
      openRoute: vi.fn(async () => {}),
    }

    await handlers.get(MODELS_REFRESH_COMMAND_ID)?.handle(
      routed({ type: 'feature.command', commandId: MODELS_REFRESH_COMMAND_ID }),
      context,
    )
    await vi.waitFor(() => expect(port.refreshCalls).toHaveLength(2))
    expect(instance.model.snapshot().phase).toBe('ready')

    await handlers.get(MODELS_SAVE_DEFAULT_COMMAND_ID)?.handle(
      routed({ type: 'feature.command', commandId: MODELS_SAVE_DEFAULT_COMMAND_ID }),
      context,
    )
    expect(port.selectCalls).toHaveLength(1)
    expect(port.selectCalls[0]).toMatchObject({
      selection: modelsChoiceSelection(selectedModelsChoice(instance.model.snapshot())!),
      options: { saveDefault: true, signal: expect.any(AbortSignal) },
    })

    await surface.dispose('models closed')
    await handlers.get(MODELS_REFRESH_COMMAND_ID)?.handle(
      routed({ type: 'feature.command', commandId: MODELS_REFRESH_COMMAND_ID }),
      context,
    )
    await Promise.resolve()
    expect(port.refreshCalls).toHaveLength(2)
    await instance.dispose()
    await manager.dispose()
  })

  it('keeps read-only/empty Enter inert and reports selection failures', async () => {
    const { manager, session, instance, port, status } = await createInstance()
    const surface = session.child('surface', 'models-content')
    const coordinator = new ResourceCoordinator()
    await coordinator.activate(surface, instance.contributions.resources?.[0]?.value!)
    const handlers = new Map(instance.contributions.commands?.map(command => [
      command.id,
      command.value as FeatureCommandHandler,
    ]))
    const select = handlers.get(MODELS_SELECT_COMMAND_ID)!
    const context = {
      navigation: {
        value: 'workspace' as const,
        route: { kind: 'workspace' as const, featureId: MODELS_FEATURE_ID, pane: 'content' as const },
        mode: 'normal' as const,
        focus: { kind: 'feature' as const, featureId: MODELS_FEATURE_ID },
        overlays: [],
      },
      openRoute: async () => {},
    }
    port.value = snapshot({ writable: false })
    port.emit()
    await select.handle(routed({ type: 'feature.command', commandId: MODELS_SELECT_COMMAND_ID }), context)
    status.value = { status: 'running' }
    status.emit()
    port.value = snapshot({ writable: true })
    port.emit()
    await select.handle(routed({ type: 'feature.command', commandId: MODELS_SELECT_COMMAND_ID }), context)
    expect(instance.model.snapshot().error).toContain('idle')

    status.value = { status: 'idle' }
    status.emit()
    port.value = snapshot({ selecting: true })
    port.emit()
    await select.handle(routed({ type: 'feature.command', commandId: MODELS_SELECT_COMMAND_ID }), context)
    expect(instance.model.snapshot().error).toContain('already running')

    port.value = snapshot({ routable: false, selecting: false })
    port.emit()
    await select.handle(routed({ type: 'feature.command', commandId: MODELS_SELECT_COMMAND_ID }), context)
    expect(instance.model.snapshot().error).toContain('not currently routable')

    port.value = {
      groups: [],
      writable: true,
      routable: false,
      loading: false,
      selecting: false,
      failures: [],
    }
    port.emit()
    await select.handle(routed({ type: 'feature.command', commandId: MODELS_SELECT_COMMAND_ID }), context)
    expect(port.selectCalls).toEqual([])

    port.value = snapshot()
    port.emit()
    port.selectImplementation = async () => { throw 'selection rejected' }
    await select.handle(routed({ type: 'feature.command', commandId: MODELS_SELECT_COMMAND_ID }), context)
    expect(instance.model.snapshot()).toMatchObject({
      phase: 'failed', error: 'selection rejected', snapshot: { groups: expect.any(Array) },
    })
    port.selectImplementation = async () => {
      port.snapshotError = new Error('post-select snapshot failed')
    }
    await select.handle(routed({ type: 'feature.command', commandId: MODELS_SELECT_COMMAND_ID }), context)
    expect(instance.model.snapshot()).toMatchObject({
      phase: 'failed', error: 'post-select snapshot failed',
    })
    port.snapshotError = undefined

    const pending = deferred<void>()
    port.selectImplementation = () => pending.promise
    const active = select.handle(
      routed({ type: 'feature.command', commandId: MODELS_SELECT_COMMAND_ID }), context,
    ) as Promise<void>
    const signal = port.selectCalls.at(-1)?.options?.signal
    await instance.dispose()
    expect(signal?.aborted).toBe(true)
    pending.resolve()
    await active
    await manager.dispose()
    expect(port.stopCalls).toBe(1)
  })
})
