import { describe, expect, it, vi } from 'vitest'
import type { FeatureCommandHandler } from '../src/app/feature-host.ts'
import {
  FeatureSurfaceRuntime,
  type FeatureSurfaceHostPort,
} from '../src/app/feature-surface-runtime.ts'
import type {
  FeatureHostSnapshot,
  ProjectedFeatureResource,
} from '../src/app/feature-host.ts'
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
  type NavigationState,
} from '../src/navigation/state.ts'
import type { RoutedUiCommand, UiCommand } from '../src/navigation/commands.ts'
import { FeatureRegistry } from '../src/kernel/feature-registry.ts'
import { FeatureSupervisor } from '../src/kernel/feature-supervisor.ts'
import type { ResourceDefinition } from '../src/resource/resource-coordinator.ts'
import type { FeatureSurfaceProjectContext } from '../src/presentation/feature-surface.ts'
import type { UiMessage } from '../src/runtime/events.ts'
import type { SessionCatalogSnapshot } from '../src/session/catalog-port.ts'
import type { SessionInspectionSnapshot } from '../src/session/inspection-port.ts'
import {
  SESSION_NAVIGATION_CAPABILITY,
  type SessionNavigationPort,
} from '../src/session/navigation-port.ts'
import { durable, message } from './fixtures.ts'
import {
  SESSIONS_ACTIVATE_COMMAND_ID,
  SESSIONS_BACK_COMMAND_ID,
  SESSIONS_CATALOG_RESOURCE_ID,
  SESSIONS_CONTENT_ROUTE_ID,
  SESSIONS_FEATURE_ID,
  SESSIONS_FORK_COMMAND_ID,
  SESSIONS_INSPECTION_RESOURCE_ID,
  SESSIONS_INSPECTOR_ROUTE_ID,
  SESSIONS_MOVE_DOWN_COMMAND_ID,
  SESSIONS_MOVE_UP_COMMAND_ID,
  SESSIONS_REFRESH_COMMAND_ID,
  SESSIONS_RESUME_COMMAND_ID,
  SESSIONS_ROUTE_ID,
  createSessionsContentNode,
  createSessionsFeatureModel,
  createSessionsFeatureState,
  createSessionsInspectorNode,
  createSessionsNavigatorNode,
  projectSessionsInspection,
  projectSessionsCatalog,
  sessionsFeature,
  transitionSessionsFeature,
  type SessionsFeatureInstance,
  type SessionsFeatureState,
  type SessionsInspectionProjection,
  type SessionsFeatureStateSource,
  type SessionsUiNode,
} from '../src/features/sessions/index.ts'
import {
  SESSIONS_WORKSPACE_CAPABILITY,
  type SessionsWorkspacePort,
} from '../src/features/sessions/port.ts'
import {
  createSessionUiState,
  createUiState,
  type TranscriptRow,
} from '../src/transcript/state.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => { resolve = done }),
    resolve: value => { resolve(value) },
  }
}

function catalog(
  ids: readonly string[],
  overrides: Partial<SessionCatalogSnapshot['sessions'][number]> = {},
): SessionCatalogSnapshot {
  return {
    durability: 'available',
    sessions: ids.map((sessionId, index) => ({
      sessionId,
      createdAt: 100 - index,
      cwd: index === 0 ? 'D:\\研发\\代理项目' : `D:\\work\\${sessionId}`,
      isSubagent: false,
      attached: index === 0,
      durablePresence: 'observed',
      ...overrides,
    })),
  }
}

function inspection(sessionId: string): SessionInspectionSnapshot {
  return {
    header: {
      sessionId,
      createdAt: 42,
      cwd: 'D:\\研发\\代理项目',
      isSubagent: false,
    },
    events: [durable(0, {
      type: 'user/message',
      data: {
        message: message('user-1', 'user', '检查 Windows 路径'),
        surfaceOp: 'append',
      },
    }, sessionId)],
  }
}

function request(scopeEpoch: number, requestId: number) {
  return { scopeEpoch, requestId }
}

function navigationPort(sessionId = 'active'): SessionNavigationPort {
  return {
    snapshot: vi.fn(() => ({ sessionId, busy: false })),
    navigate: vi.fn(async () => {}),
  }
}

function seedCatalog(
  instance: SessionsFeatureInstance,
  snapshot: SessionCatalogSnapshot,
  requestId = 1,
): void {
  const stamp = request(1, requestId)
  instance.model.dispatch({ type: 'catalog.load-started', request: stamp })
  instance.model.dispatch({ type: 'catalog.loaded', request: stamp, snapshot })
}

function handlersOf(instance: SessionsFeatureInstance): Map<string, FeatureCommandHandler> {
  return new Map((instance.contributions.commands ?? []).map(command => [
    command.id,
    command.value as FeatureCommandHandler,
  ]))
}

function routed(command: UiCommand): RoutedUiCommand {
  return Object.freeze({
    target: Object.freeze({ kind: 'feature' as const, featureId: SESSIONS_FEATURE_ID }),
    command: Object.freeze(command),
  })
}

function featureCommand(commandId: string): RoutedUiCommand {
  return routed({ type: 'feature.command', commandId })
}

function workspaceNavigation(
  pane: 'navigator' | 'content' | 'inspector' = 'navigator',
): NavigationState {
  return transitionNavigation(createNavigationState(), {
    type: 'navigate',
    route: { kind: 'workspace', featureId: SESSIONS_FEATURE_ID, pane },
  }).state
}

function surfaceContext(
  width = 64,
  height = 20,
  overrides: Partial<FeatureSurfaceProjectContext> = {},
): FeatureSurfaceProjectContext {
  return Object.freeze({
    bounds: Object.freeze({ x: 0, y: 0, width, height }),
    focus: true,
    mode: 'normal',
    resources: Object.freeze([]),
    ...overrides,
  })
}

describe('Sessions Feature state machine and projectors', () => {
  it('uses recorded titles for recognition and search instead of leading with a SessionId', () => {
    const model = createSessionsFeatureModel()
    const entry = { ...catalog(['3fa85f64-5717-4562-b3fc-2c963f66afa6']).sessions[0]!, title: 'Fix Windows clipboard' }
    model.dispatch({ type: 'catalog.load-started', request: request(1, 1) })
    model.dispatch({ type: 'catalog.loaded', request: request(1, 1), snapshot: { durability: 'available', sessions: [entry] } })
    const rows = createSessionsNavigatorNode(model).project(surfaceContext()).rows
    expect(rows.find(row => row.selected)?.text).toContain('Fix Windows clipboard')
    expect(rows.find(row => row.selected)?.text).not.toContain(entry.sessionId)
    model.dispatch({ type: 'query.changed', query: 'clipboard' })
    expect(projectSessionsCatalog(model.snapshot()).filteredCount).toBe(1)
    model.dispose()
  })

  it('filters Unicode/path fields and keeps selection stable by SessionId across refresh', () => {
    let state = createSessionsFeatureState()
    state = transitionSessionsFeature(state, {
      type: 'catalog.load-started',
      request: request(1, 1),
    }).state
    state = transitionSessionsFeature(state, {
      type: 'catalog.loaded',
      request: request(1, 1),
      snapshot: catalog(['当前', '另一个', 'third']),
    }).state

    state = transitionSessionsFeature(state, {
      type: 'query.changed',
      query: '研发',
    }).state
    expect(projectSessionsCatalog(state)).toMatchObject({
      query: '研发',
      totalCount: 3,
      filteredCount: 1,
      selectedSessionId: '当前',
      rows: [{ sessionId: '当前', cwd: 'D:\\研发\\代理项目' }],
    })

    state = transitionSessionsFeature(state, { type: 'query.changed', query: '' }).state
    state = transitionSessionsFeature(state, {
      type: 'selection.move',
      direction: 'down',
    }).state
    expect(projectSessionsCatalog(state).selectedSessionId).toBe('另一个')

    state = transitionSessionsFeature(state, {
      type: 'catalog.load-started',
      request: request(1, 2),
    }).state
    expect(state.catalog.phase).toBe('refreshing')
    state = transitionSessionsFeature(state, {
      type: 'catalog.loaded',
      request: request(1, 2),
      snapshot: catalog(['third', '另一个', '当前']),
    }).state
    expect(projectSessionsCatalog(state).selectedSessionId).toBe('另一个')
    expect(projectSessionsCatalog(state).selectedIndex).toBe(1)

    const stale = transitionSessionsFeature(state, {
      type: 'catalog.failed',
      request: request(1, 1),
      message: 'late failure',
    })
    expect(stale.state).toBe(state)
    expect(stale.effects).toEqual([])
  })

  it('emits declarative refresh/route effects and retains last-good data on failure', () => {
    let state = createSessionsFeatureState()
    state = transitionSessionsFeature(state, {
      type: 'catalog.load-started',
      request: request(2, 1),
    }).state
    state = transitionSessionsFeature(state, {
      type: 'catalog.loaded',
      request: request(2, 1),
      snapshot: catalog(['a', 'b'], { attached: false }),
    }).state

    expect(transitionSessionsFeature(state, { type: 'catalog.refresh-requested' }).effects)
      .toEqual([{ type: 'resource.refresh', resourceId: SESSIONS_CATALOG_RESOURCE_ID }])
    const activation = transitionSessionsFeature(state, {
      type: 'selection.activated',
      requestId: 3,
    })
    expect(activation.effects).toEqual([
      { type: 'resource.refresh', resourceId: SESSIONS_INSPECTION_RESOURCE_ID },
      { type: 'route.open', routeId: SESSIONS_INSPECTOR_ROUTE_ID },
    ])
    expect(activation.state.inspection).toMatchObject({ phase: 'loading', sessionId: 'a' })

    state = transitionSessionsFeature(state, {
      type: 'catalog.load-started',
      request: request(2, 2),
    }).state
    state = transitionSessionsFeature(state, {
      type: 'catalog.failed',
      request: request(2, 2),
      message: 'offline',
    }).state
    expect(state.catalog).toMatchObject({ phase: 'failed', message: 'offline' })
    expect(projectSessionsCatalog(state).rows.map(row => row.sessionId)).toEqual(['a', 'b'])
  })

  it('keeps subagent inspection read-only instead of offering generic cold resume', async () => {
    let state = createSessionsFeatureState()
    state = transitionSessionsFeature(state, {
      type: 'navigation.changed', snapshot: { sessionId: 'current', busy: false },
    }).state
    const snapshot = catalog(['current', 'child'])
    state = transitionSessionsFeature(state, {
      type: 'catalog.load-started', request: request(3, 1),
    }).state
    state = transitionSessionsFeature(state, {
      type: 'catalog.loaded',
      request: request(3, 1),
      snapshot: {
        ...snapshot,
        sessions: [snapshot.sessions[0]!, {
          ...snapshot.sessions[1]!,
          isSubagent: true,
          attached: false,
          parentSessionId: 'current',
        }],
      },
    }).state
    state = transitionSessionsFeature(state, {
      type: 'selection.move', direction: 'down',
    }).state
    state = transitionSessionsFeature(state, {
      type: 'selection.activated', requestId: 4,
    }).state
    const stamp = request(3, 2)
    state = transitionSessionsFeature(state, {
      type: 'inspection.load-started', sessionId: 'child', request: stamp,
    }).state
    const childInspection = inspection('child')
    const projection = await projectSessionsInspection({
      ...childInspection,
      header: { ...childInspection.header, isSubagent: true, parentSessionId: 'current' },
    }, new AbortController().signal)
    state = transitionSessionsFeature(state, {
      type: 'inspection.loaded', sessionId: 'child', request: stamp, projection,
    }).state

    const resume = transitionSessionsFeature(state, { type: 'resume.requested' })
    expect(resume.effects).toEqual([])
    expect(resume.state.operation).toMatchObject({
      phase: 'failed',
      action: 'resume-cold',
      message: 'Inspect an observed cold root session before resuming it',
    })

    const minimal = await projectSessionsInspection({
      header: { sessionId: 'minimal', createdAt: 1, isSubagent: false },
      events: [],
    }, new AbortController().signal)
    expect(minimal.header).toEqual({ sessionId: 'minimal', createdAt: 1, isSubagent: false })
    const rich = await projectSessionsInspection({
      header: {
        sessionId: 'rich', createdAt: 2, cwd: 'D:\\rich', parentSessionId: 'current',
        seedLength: 4, isSubagent: true, delegationDepth: 2,
        creationAgentPreset: 'review',
      },
      events: [],
    }, new AbortController().signal)
    expect(rich.header).toMatchObject({
      seedLength: 4, delegationDepth: 2, creationAgentPreset: 'review',
    })
  })

  it('exhausts stale, empty, blocked, and terminal reducer paths', async () => {
    const empty = createSessionsFeatureState()
    expect(transitionSessionsFeature(empty, {
      type: 'catalog.loaded', request: request(9, 1), snapshot: catalog([]),
    }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, { type: 'query.changed', query: '' }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, {
      type: 'selection.move', direction: 'up', amount: 0,
    }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, { type: 'selection.activated' }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, { type: 'resume.requested' }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, { type: 'fork.requested' }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, {
      type: 'confirmation.accepted', requestId: 1,
    }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, { type: 'back.requested' }).effects)
      .toEqual([{ type: 'route.open', routeId: 'chat' }])
    expect(transitionSessionsFeature(empty, { type: 'inspection.refresh-requested' }).state)
      .toBe(empty)
    expect(transitionSessionsFeature(empty, {
      type: 'inspection.load-started', sessionId: 'none', request: request(9, 2),
    }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, {
      type: 'inspection.loaded', sessionId: 'none', request: request(9, 2),
      projection: await projectSessionsInspection(inspection('none'), new AbortController().signal),
    }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, {
      type: 'inspection.failed', sessionId: 'none', request: request(9, 2), message: 'late',
    }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, {
      type: 'navigation.succeeded', requestId: 9,
    }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, {
      type: 'navigation.failed', requestId: 9, message: 'late',
    }).state).toBe(empty)
    expect(transitionSessionsFeature(empty, {
      type: 'navigation.cancelled', requestId: 9,
    }).state).toBe(empty)

    let failedCatalog = transitionSessionsFeature(empty, {
      type: 'catalog.load-started', request: request(9, 3),
    }).state
    failedCatalog = transitionSessionsFeature(failedCatalog, {
      type: 'catalog.failed', request: request(9, 3), message: 'offline',
    }).state
    expect(failedCatalog.catalog).toEqual({ phase: 'failed', message: 'offline' })

    let currentState = createSessionsFeatureState()
    currentState = transitionSessionsFeature(currentState, {
      type: 'navigation.changed', snapshot: { sessionId: 'current', busy: false },
    }).state
    currentState = transitionSessionsFeature(currentState, {
      type: 'catalog.load-started', request: request(10, 1),
    }).state
    currentState = transitionSessionsFeature(currentState, {
      type: 'catalog.loaded', request: request(10, 1), snapshot: catalog(['current', 'cold']),
    }).state
    expect(transitionSessionsFeature(currentState, {
      type: 'selection.move', direction: 'up', amount: 20,
    }).state).toBe(currentState)
    expect(transitionSessionsFeature(currentState, {
      type: 'selection.activated', requestId: 2,
    }).effects).toEqual([{ type: 'route.open', routeId: 'chat' }])

    let unavailable = transitionSessionsFeature(empty, {
      type: 'catalog.load-started', request: request(11, 1),
    }).state
    unavailable = transitionSessionsFeature(unavailable, {
      type: 'catalog.loaded',
      request: request(11, 1),
      snapshot: catalog(['unavailable'], { attached: false, durablePresence: 'not-observed' }),
    }).state
    expect(transitionSessionsFeature(unavailable, {
      type: 'selection.activated', requestId: 3,
    }).state.operation).toMatchObject({ phase: 'failed', action: 'resume-cold' })

    let cold = transitionSessionsFeature(currentState, {
      type: 'selection.move', direction: 'down',
    }).state
    cold = transitionSessionsFeature(cold, {
      type: 'selection.activated', requestId: 4,
    }).state
    const inspectionRequest = request(12, 1)
    cold = transitionSessionsFeature(cold, {
      type: 'inspection.load-started', sessionId: 'cold', request: inspectionRequest,
    }).state
    const projection = await projectSessionsInspection(inspection('cold'), new AbortController().signal)
    expect(transitionSessionsFeature(cold, {
      type: 'inspection.loaded', sessionId: 'cold', request: request(12, 99), projection,
    }).state).toBe(cold)
    cold = transitionSessionsFeature(cold, {
      type: 'inspection.loaded', sessionId: 'cold', request: inspectionRequest, projection,
    }).state
    const refreshing = transitionSessionsFeature(cold, {
      type: 'inspection.load-started', sessionId: 'cold', request: request(12, 2),
    }).state
    expect(refreshing.inspection.phase).toBe('refreshing')
    const refreshFailed = transitionSessionsFeature(refreshing, {
      type: 'inspection.failed', sessionId: 'cold', request: request(12, 2), message: 'offline',
    }).state
    expect(refreshFailed.inspection).toMatchObject({ phase: 'failed', previous: projection })
    expect(transitionSessionsFeature(refreshFailed, {
      type: 'inspection.refresh-requested',
    }).effects).toEqual([
      { type: 'resource.refresh', resourceId: SESSIONS_INSPECTION_RESOURCE_ID },
    ])

    const inspectedWithoutCatalog: SessionsFeatureState = {
      ...empty,
      inspection: { phase: 'ready', projection },
    }
    expect(transitionSessionsFeature(inspectedWithoutCatalog, {
      type: 'resume.requested',
    }).state.operation).toMatchObject({ phase: 'failed', sessionId: 'cold' })

    const busy: SessionsFeatureState = {
      ...cold,
      navigation: { sessionId: 'current', busy: true },
    }
    expect(transitionSessionsFeature(busy, { type: 'resume.requested' }).state.operation)
      .toMatchObject({ phase: 'failed', action: 'resume-cold' })
    expect(transitionSessionsFeature(busy, { type: 'fork.requested' }).state.operation)
      .toMatchObject({ phase: 'failed', action: 'fork' })
    const confirmBusy: SessionsFeatureState = {
      ...busy,
      operation: { phase: 'confirm-fork', sessionId: 'cold' },
    }
    expect(transitionSessionsFeature(confirmBusy, {
      type: 'confirmation.accepted', requestId: 5,
    }).state.operation).toMatchObject({ phase: 'failed', action: 'fork' })

    const running: SessionsFeatureState = {
      ...cold,
      operation: { phase: 'running', action: 'fork', sessionId: 'cold', requestId: 6 },
    }
    expect(transitionSessionsFeature(running, {
      type: 'navigation.succeeded', requestId: 6,
    }).state.operation.phase).toBe('idle')
    expect(transitionSessionsFeature(running, {
      type: 'navigation.failed', requestId: 6, message: 'failed',
    }).state.operation).toMatchObject({ phase: 'failed', message: 'failed' })
    expect(transitionSessionsFeature(running, {
      type: 'navigation.cancelled', requestId: 6,
    }).state.operation.phase).toBe('idle')
    expect(transitionSessionsFeature(running, {
      type: 'navigation.cancelled', requestId: 7,
    }).state).toBe(running)
  })

  it('reconciles every prior inspection phase and the legacy missing request id', async () => {
    let state = createSessionsFeatureState()
    state = transitionSessionsFeature(state, {
      type: 'navigation.changed', snapshot: { sessionId: 'current', busy: false },
    }).state
    state = transitionSessionsFeature(state, {
      type: 'catalog.load-started', request: request(20, 1),
    }).state
    state = transitionSessionsFeature(state, {
      type: 'catalog.loaded',
      request: request(20, 1),
      snapshot: catalog(['current', 'cold', 'other']),
    }).state
    state = transitionSessionsFeature(state, {
      type: 'selection.move', direction: 'down',
    }).state

    const cold = await projectSessionsInspection(
      inspection('cold'),
      new AbortController().signal,
    )
    const other = await projectSessionsInspection(
      inspection('other'),
      new AbortController().signal,
    )
    const priorStates: readonly SessionsFeatureState['inspection'][] = [
      { phase: 'loading', sessionId: 'cold', previous: cold },
      { phase: 'loading', sessionId: 'other', previous: other },
      { phase: 'ready', projection: cold },
      { phase: 'ready', projection: other },
      { phase: 'refreshing', sessionId: 'cold', request: request(20, 2), projection: cold },
      { phase: 'refreshing', sessionId: 'other', request: request(20, 3), projection: other },
      { phase: 'failed', sessionId: 'cold', message: 'stale', previous: cold },
      { phase: 'failed', sessionId: 'other', message: 'stale', previous: other },
    ]
    for (const prior of priorStates) {
      const transition = transitionSessionsFeature({ ...state, inspection: prior }, {
        type: 'selection.activated', requestId: 21,
      })
      expect(transition.effects).toEqual([
        { type: 'resource.refresh', resourceId: SESSIONS_INSPECTION_RESOURCE_ID },
        { type: 'route.open', routeId: SESSIONS_INSPECTOR_ROUTE_ID },
      ])
    }

    const ready: SessionsFeatureState = { ...state, inspection: { phase: 'ready', projection: cold } }
    expect(transitionSessionsFeature(ready, {
      type: 'inspection.loaded',
      sessionId: 'cold',
      request: request(20, 99),
      projection: cold,
    }).state).toBe(ready)

    const pending = request(20, 4)
    const loading: SessionsFeatureState = {
      ...state,
      inspection: { phase: 'loading', sessionId: 'cold', request: pending },
    }
    expect(transitionSessionsFeature(loading, {
      type: 'inspection.failed',
      sessionId: 'cold',
      request: pending,
      message: 'first inspection failed',
    }).state.inspection).toEqual({
      phase: 'failed',
      sessionId: 'cold',
      message: 'first inspection failed',
    })

    const liveSnapshot = catalog(['current', 'live'])
    let live = createSessionsFeatureState()
    live = transitionSessionsFeature(live, {
      type: 'navigation.changed', snapshot: { sessionId: 'current', busy: false },
    }).state
    live = transitionSessionsFeature(live, {
      type: 'catalog.load-started', request: request(21, 1),
    }).state
    live = transitionSessionsFeature(live, {
      type: 'catalog.loaded',
      request: request(21, 1),
      snapshot: {
        ...liveSnapshot,
        sessions: [
          liveSnapshot.sessions[0]!,
          { ...liveSnapshot.sessions[1]!, attached: true, liveStatus: 'idle' },
        ],
      },
    }).state
    live = transitionSessionsFeature(live, {
      type: 'selection.move', direction: 'down',
    }).state
    expect(transitionSessionsFeature(live, { type: 'selection.activated' }).effects)
      .toEqual([{
        type: 'session.navigate',
        requestId: 0,
        request: { kind: 'activate', sessionId: 'live', intent: 'attach-live' },
      }])
  })
})

describe('Sessions Feature surface projections', () => {
  it('keeps the default preview readable and reveals audit fields only after explicit details focus', async () => {
    const model = createSessionsFeatureModel()
    const content = createSessionsContentNode(model)
    const navigator = createSessionsNavigatorNode(model)
    const inspector = createSessionsInspectorNode(model)
    model.dispatch({ type: 'catalog.load-started', request: request(1, 1) })
    model.dispatch({ type: 'catalog.loaded', request: request(1, 1), snapshot: catalog(['review-id'], {
      title: 'Review the current changes', cwd: 'D:/project', createdAt: 123,
      titleUpdatedAt: 456, parentSessionId: 'parent-id', creationAgentPreset: 'audit-preset', titleUnavailable: true,
    }) })
    const preview = content.project(surfaceContext(120, 24, { focus: false }))
    const output = preview.rows.map(row => row.text).join('\n')
    expect(output).toContain('Review the current changes')
    expect(output).toContain('D:/project')
    expect(output).toContain('Status')
    expect(output).toContain('Created')
    expect(output).toContain('Title unavailable · R refresh')
    for (const hidden of ['ID  ', 'Storage', 'Title updated', 'Parent', 'Preset', 'parent-id', 'audit-preset', '1970-01-01T']) {
      expect(output).not.toContain(hidden)
    }
    expect(navigator.project(surfaceContext()).actionHint).toContain('Tab details')
    const details = content.project(surfaceContext(120, 24)).rows.map(row => row.text).join('\n')
    for (const visible of ['ID  review-id', 'Storage', 'Title updated', 'Parent  parent-id', 'Preset  audit-preset']) {
      expect(details).toContain(visible)
    }
    model.dispatch({ type: 'selection.activated' })
    model.dispatch({ type: 'inspection.load-started', sessionId: 'review-id', request: request(1, 2) })
    expect(inspector.project(surfaceContext()).rows[0]?.text).toBe('› Review the current changes')
    const projection = await projectSessionsInspection(inspection('review-id'), new AbortController().signal)
    model.dispatch({ type: 'inspection.loaded', sessionId: 'review-id', request: request(1, 2), projection })
    const inspected = inspector.project(surfaceContext()).rows
    expect(inspected[0]?.text).toBe('› Review the current changes')
    expect(inspected.some(row => row.text === 'ID  review-id')).toBe(true)
    for (const [durability, durablePresence] of [
      ['unavailable', 'observed'],
      ['available', 'not-observed'],
    ] as const) {
      model.dispatch({ type: 'catalog.load-started', request: request(1, 3) })
      model.dispatch({ type: 'catalog.loaded', request: request(1, 3), snapshot: {
        ...catalog(['review-id'], { durablePresence }), durability,
      } })
      const unavailable = content.project(surfaceContext(120, 24, { focus: false })).rows
      expect(unavailable).toContainEqual(expect.objectContaining({
        text: 'Saved history unavailable · R refresh', tone: 'warning',
      }))
      expect(unavailable.map(row => row.text).join('\n')).not.toContain('Storage')
    }
    model.dispose()
  })

  it('keeps action hints aligned with a busy host and the exact inspected session', async () => {
    const model = createSessionsFeatureModel()
    const navigator = createSessionsNavigatorNode(model)
    const inspector = createSessionsInspectorNode(model)
    model.dispatch({ type: 'catalog.load-started', request: request(1, 1) })
    model.dispatch({ type: 'catalog.loaded', request: request(1, 1), snapshot: catalog(['current', 'cold']) })
    model.dispatch({ type: 'navigation.changed', snapshot: { sessionId: 'current', busy: true } })
    expect(navigator.project(surfaceContext()).actionHint).toContain('Wait for the current session operation')
    model.dispatch({ type: 'navigation.changed', snapshot: { sessionId: 'current', busy: false } })
    expect(navigator.project(surfaceContext()).actionHint).toContain('Enter return to chat')
    model.dispatch({ type: 'selection.move', direction: 'down' })
    expect(navigator.project(surfaceContext()).actionHint).toContain('Enter inspect')
    expect(inspector.project(surfaceContext()).actionHint).not.toContain('a resume')
    model.dispatch({ type: 'selection.activated' })
    const projection = await projectSessionsInspection(inspection('cold'), new AbortController().signal)
    model.dispatch({ type: 'inspection.load-started', sessionId: 'cold', request: request(1, 2) })
    model.dispatch({ type: 'inspection.loaded', sessionId: 'cold', request: request(1, 2), projection })
    expect(inspector.project(surfaceContext()).actionHint).toContain('a resume')
    model.dispatch({ type: 'selection.move', direction: 'up' })
    expect(inspector.project(surfaceContext()).actionHint).not.toContain('a resume')
    model.dispose()
  })

  it('shows an untitled session with its directory in a compact catalog and keeps full facts in details', () => {
    const model = createSessionsFeatureModel()
    const content = createSessionsContentNode(model)
    expect(content.hasContent?.()).toBe(false)
    expect(content.project(surfaceContext()).rows.map(row => row.text).join('\n')).toContain('Select a session to inspect')
    model.dispatch({ type: 'catalog.load-started', request: request(1, 1) })
    model.dispatch({ type: 'catalog.loaded', request: request(1, 1), snapshot: catalog(['uuid-placeholder'], {
      cwd: 'D:\\work\\clipboard-project', title: '  ', titleUpdatedAt: 123, titleUnavailable: true,
    }) })
    const compact = createSessionsNavigatorNode(model).project(surfaceContext(36, 4)).rows
    expect(compact.map(row => row.text).join('\n')).toContain('Untitled session')
    expect(compact.map(row => row.text).join('\n')).toContain('clipboard-project')
    expect(compact.map(row => row.text).join('\n')).not.toContain('uuid-placeholder')
    const tiny = createSessionsNavigatorNode(model).project(surfaceContext(36, 3)).rows
    expect(tiny).toHaveLength(3)
    expect(tiny[2]).toMatchObject({ selected: true })
    expect(content.hasContent?.()).toBe(true)
    const details = content.project(surfaceContext(80, 20)).rows.map(row => row.text).join('\n')
    expect(details).toContain('ID  uuid-placeholder')
    expect(details).toContain('Title updated  1970-01-01T00:00:00.123Z')
    expect(details).toContain('Title unavailable · R refresh')
    model.dispose()
  })

  it('isolates state/effect listeners and disposes idempotently', () => {
    const model = createSessionsFeatureModel()
    const stateListener = vi.fn()
    const effectListener = vi.fn()
    model.onChanged(() => { throw new Error('state listener failed') })
    const stopState = model.onChanged(stateListener)
    model.onEffect(() => { throw new Error('effect listener failed') })
    const stopEffect = model.onEffect(effectListener)
    model.dispatch({ type: 'query.changed', query: 'x' })
    model.dispatch({ type: 'catalog.refresh-requested' })
    expect(stateListener).toHaveBeenCalled()
    expect(effectListener).toHaveBeenCalledWith({
      type: 'resource.refresh', resourceId: SESSIONS_CATALOG_RESOURCE_ID,
    })
    stopState()
    stopState()
    stopEffect()
    stopEffect()
    model.dispose()
    model.dispose()
    expect(() => model.onChanged(vi.fn())).toThrow('disposed')
    expect(() => model.onEffect(vi.fn())).toThrow('disposed')
  })

  it('projects empty, dense, operation, inspection, and transcript variants safely', () => {
    let current = createSessionsFeatureState()
    const listeners = new Set<(state: SessionsFeatureState) => void>()
    const source: SessionsFeatureStateSource = {
      snapshot: () => current,
      onChanged: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const navigator = createSessionsNavigatorNode(source)
    const content = createSessionsContentNode(source)
    const inspector = createSessionsInspectorNode(source)
    const invalidated = vi.fn()
    const stops = [
      navigator.onChanged(invalidated),
      content.onChanged(invalidated),
      inspector.onChanged(invalidated),
    ]
    for (const listener of listeners) listener(current)
    expect(invalidated).toHaveBeenCalledTimes(3)
    for (const stop of stops) stop()

    expect(navigator.project(surfaceContext()).rows.at(-1)?.text).toContain('No sessions yet')
    current = {
      ...current,
      catalog: { phase: 'loading', request: request(1, 1) },
    }
    expect(navigator.project(surfaceContext(32, 3, {
      resources: [{ id: SESSIONS_CATALOG_RESOURCE_ID, phase: 'loading' }],
    })).rows.map(row => row.text).join('\n')).toContain('Loading session catalog')
    current = {
      ...current,
      query: 'missing',
      catalog: { phase: 'failed', message: 'offline' },
    }
    expect(navigator.project(surfaceContext(32, 3, {
      resources: [{ id: SESSIONS_CATALOG_RESOURCE_ID, phase: 'failed' }],
    })).rows.map(row => row.text).join('\n')).toContain('Catalog unavailable')
    current = { ...current, catalog: { phase: 'idle' } }
    expect(navigator.project(surfaceContext()).rows.at(-1)?.text).toContain('No sessions match')

    const snapshot: SessionCatalogSnapshot = {
      durability: 'available',
      sessions: [
        {
          sessionId: 'current', createdAt: 1, cwd: 'D:\\current', isSubagent: false,
          attached: true, durablePresence: 'observed', liveStatus: 'running',
        },
        {
          sessionId: 'live', createdAt: 1e20, isSubagent: false,
          attached: true, durablePresence: 'observed', liveStatus: 'idle',
        },
        {
          sessionId: 'child', createdAt: 3, parentSessionId: 'current',
          creationAgentPreset: 'review', isSubagent: true, attached: false,
          durablePresence: 'observed',
        },
        {
          sessionId: 'cold', title: 'Saved investigation', createdAt: 4, cwd: 'D:\\cold', isSubagent: false,
          attached: false, durablePresence: 'observed',
        },
        {
          sessionId: 'detached', createdAt: Number.NaN, isSubagent: false,
          attached: false, durablePresence: 'not-observed',
        },
        ...Array.from({ length: 4 }, (_, index) => ({
          sessionId: `extra-${index}`,
          createdAt: 10 + index,
          isSubagent: false,
          attached: false,
          durablePresence: 'observed' as const,
        })),
      ],
    }
    current = createSessionsFeatureState()
    current = transitionSessionsFeature(current, {
      type: 'navigation.changed', snapshot: { sessionId: 'current', busy: false },
    }).state
    current = transitionSessionsFeature(current, {
      type: 'catalog.load-started', request: request(1, 2),
    }).state
    current = transitionSessionsFeature(current, {
      type: 'catalog.loaded', request: request(1, 2), snapshot,
    }).state
    const ready = current

    expect(navigator.project(surfaceContext(18, 1)).rows).toHaveLength(1)
    expect(navigator.project(surfaceContext(64, 4)).rows.map(row => row.text).join('\n'))
      .toContain('current')
    expect(navigator.project(surfaceContext(64, 0)).rows).toHaveLength(0)
    expect(navigator.project(surfaceContext(64, 8, {
      mode: 'insert',
      resources: [{ id: SESSIONS_CATALOG_RESOURCE_ID, phase: 'ready' }],
    })).cursor).toBeDefined()
    expect(navigator.project(surfaceContext(64, 8, { focus: false })).cursor).toBeUndefined()
    current = { ...ready, selection: { index: 3, sessionId: 'cold' } }
    expect(navigator.project(surfaceContext(64, 8)).rows.some(row => (
      row.selected && row.text.includes('Saved investigation') && row.tone === 'accent'
    ))).toBe(true)

    for (const sessionId of ['current', 'live', 'child', 'cold', 'detached']) {
      current = {
        ...ready,
        selection: { index: 0, sessionId },
      }
      const text = content.project(surfaceContext()).rows.map(row => row.text).join('\n')
      expect(text).toContain(sessionId)
    }
    current = { ...ready, query: 'does-not-exist' }
    expect(content.project(surfaceContext()).rows.at(-1)?.text).toContain('No match')
    current = { ...ready, catalog: { phase: 'failed', message: 'refresh failed', snapshot } }
    expect(content.project(surfaceContext()).rows.map(row => row.text).join('\n'))
      .toContain('Refresh failed')
    current = {
      ...ready,
      catalog: { phase: 'ready', snapshot: { ...snapshot, durability: 'unavailable' } },
      selection: { index: 3, sessionId: 'cold' },
    }
    expect(content.project(surfaceContext()).rows.some(row => (
      row.text.startsWith('Storage') && row.tone === 'warning'
    ))).toBe(true)
    current = {
      ...ready,
      selection: { index: 0, sessionId: 'current' },
    }
    expect(content.project(surfaceContext(64, 12, { focus: false })).rows.map(row => row.text))
      .not.toContain(expect.stringContaining('return to chat'))

    const operations: readonly SessionsFeatureState['operation'][] = [
      { phase: 'confirm-resume', sessionId: 'cold' },
      { phase: 'confirm-fork', sessionId: 'current' },
      { phase: 'running', action: 'fork', sessionId: 'current', requestId: 1 },
      { phase: 'running', action: 'resume-cold', sessionId: 'cold', requestId: 2 },
      { phase: 'running', action: 'attach-live', sessionId: 'live', requestId: 3 },
      { phase: 'failed', action: 'fork', sessionId: 'current', message: 'denied' },
    ]
    for (const operation of operations) {
      current = { ...ready, operation }
      expect(content.project(surfaceContext()).rows.map(row => row.text).join('\n'))
        .toMatch(/confirm|continues|failed/u)
    }

    const emptyTranscript = createUiState()
    const noSessionProjection: SessionsInspectionProjection = {
      sessionId: 'cold',
      header: { sessionId: 'cold', createdAt: 4, isSubagent: false },
      transcript: { ...emptyTranscript, phase: 'ready', activeSessionId: 'cold' },
    }
    current = { ...ready, inspection: { phase: 'idle' }, operation: { phase: 'idle' } }
    expect(inspector.project(surfaceContext()).rows.at(-1)?.text).toContain('Press Enter')
    current = {
      ...createSessionsFeatureState(),
      inspection: { phase: 'loading', sessionId: 'cold', request: request(2, 1) },
    }
    expect(inspector.project(surfaceContext()).rows[0]?.text).toBe('› cold')
    current = {
      ...ready,
      inspection: { phase: 'loading', sessionId: 'cold', request: request(2, 1) },
    }
    expect(inspector.project(surfaceContext(64, 10, {
      resources: [{ id: SESSIONS_INSPECTION_RESOURCE_ID, phase: 'loading' }],
    })).rows.map(row => row.text).join('\n')).toContain('Replaying')
    current = {
      ...ready,
      inspection: { phase: 'failed', sessionId: 'cold', message: 'broken' },
    }
    expect(inspector.project(surfaceContext(64, 10, {
      resources: [{ id: SESSIONS_INSPECTION_RESOURCE_ID, phase: 'failed' }],
    })).rows.map(row => row.text).join('\n')).toContain('Inspection failed')
    current = { ...ready, inspection: { phase: 'ready', projection: noSessionProjection } }
    expect(inspector.project(surfaceContext()).rows.map(row => row.text).join('\n'))
      .toContain('No projected transcript state')

    const richMessage: UiMessage = {
      id: 'rich',
      role: 'user',
      sourceKind: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'reasoning', text: 'summary' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'image-1', mediaType: 'image/png', bytes: 1,
            width: 1, height: 1, name: 'screen.png',
          },
        },
        {
          type: 'image',
          attachment: {
            attachmentId: 'image-2', mediaType: 'image/png', bytes: 1,
            width: 1, height: 1,
          },
        },
        { type: 'tool-call', id: 'call', name: 'read', arguments: '{}' },
        { type: 'unsupported', sourceType: 'future' },
      ],
    }
    const transcriptRows: readonly TranscriptRow[] = [
      { kind: 'user', key: 'event:1', seq: 1, message: richMessage },
      {
        kind: 'assistant', key: 'event:2', seq: 2, turn: 1, step: 1,
        message: message('assistant', 'assistant', 'answer'), interrupted: false,
      },
      {
        kind: 'assistant-draft', key: 'draft:1:1', firstSeq: 3, lastSeq: 3,
        turn: 1, step: 1, text: 'draft', reasoning: '', chunkCount: 1,
      },
      { kind: 'tool', key: 'tool:1:1:call', turn: 1, step: 1, callId: 'call' },
      {
        kind: 'tool', key: 'tool:1:1:named', turn: 1, step: 1,
        callId: 'named', name: 'search',
      },
      { kind: 'command', key: 'command:one', commandId: 'one', status: 'success' },
      {
        kind: 'command', key: 'command:two', commandId: 'two', name: 'compact',
        status: 'running',
      },
    ]
    const projectionFor = (
      row: TranscriptRow | undefined,
      agentStatus: 'idle' | 'running' = 'idle',
    ): SessionsInspectionProjection => {
      const session = {
        ...createSessionUiState('cold'),
        agentStatus,
        rows: Object.freeze(row === undefined ? [] : [row]),
        journal: Object.freeze(row === undefined ? [] : [durable(0, {
          type: 'user/message',
          data: { message: message('journal', 'user', 'hello'), surfaceOp: 'append' },
        }, 'cold')]),
        omittedRowCount: row === undefined ? 0 : 1,
        omittedReplacementCount: row === undefined ? 0 : 2,
        compatibilityError: row === undefined
          ? undefined
          : { code: 'future-event', message: 'unsupported event' },
      }
      return {
        sessionId: 'cold',
        header: { sessionId: 'cold', createdAt: 4, cwd: 'D:\\cold', isSubagent: false },
        transcript: {
          ...createUiState(),
          phase: 'ready',
          activeSessionId: 'cold',
          sessions: { cold: session },
        },
      }
    }
    for (const [index, row] of transcriptRows.entries()) {
      const projection = projectionFor(row, index === 0 ? 'running' : 'idle')
      current = {
        ...ready,
        selection: { index: 3, sessionId: 'cold' },
        inspection: { phase: 'ready', projection },
        operation: { phase: 'idle' },
      }
      expect(inspector.project(surfaceContext()).rows.map(item => item.text).join('\n'))
        .toContain('cold')
    }
    const previous = projectionFor(undefined)
    current = {
      ...ready,
      inspection: {
        phase: 'refreshing', sessionId: 'cold', request: request(2, 2), projection: previous,
      },
      operation: { phase: 'running', action: 'resume-cold', sessionId: 'cold', requestId: 8 },
    }
    expect(inspector.project(surfaceContext(64, 20, {
      resources: [{ id: SESSIONS_INSPECTION_RESOURCE_ID, phase: 'refreshing' }],
    })).rows.map(row => row.text).join('\n')).toContain('Refreshing inspection')
    current = {
      ...ready,
      inspection: { phase: 'failed', sessionId: 'cold', message: 'stale', previous },
      operation: { phase: 'failed', action: 'resume-cold', sessionId: 'cold', message: 'denied' },
    }
    expect(inspector.project(surfaceContext()).rows.map(row => row.text).join('\n'))
      .toContain('Refresh failed')
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
  instance: SessionsFeatureInstance,
): FeatureHostSnapshot {
  const surfaces = instance.contributions.surfaces ?? []
  const additions: SlotContribution<LayoutRegion>[] = surfaces.map(surface => ({
    slotId: surface.slot,
    featureId: SESSIONS_FEATURE_ID,
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
    featureId: SESSIONS_FEATURE_ID,
    definition: resource.value as ResourceDefinition<unknown>,
  }))
  return Object.freeze({
    navigation,
    routes: Object.freeze([
      { id: 'chat', featureId: 'legacy.chat', route: { kind: 'chat' } as const },
      ...(instance.contributions.routes ?? []).map(routeContribution => ({
        id: routeContribution.id,
        featureId: SESSIONS_FEATURE_ID,
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

describe('Sessions Feature factory and surface resources', () => {
  it('declares an on-route workspace without touching catalog or inspection during create', async () => {
    const manager = new ScopeManager()
    const workspace: SessionsWorkspacePort = {
      catalog: { listSessions: vi.fn(async () => catalog([])) },
      inspection: { inspectSession: vi.fn(async ({ sessionId }) => inspection(sessionId)) },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigationPort() },
      ],
    }) as SessionsFeatureInstance

    expect(sessionsFeature.manifest).toMatchObject({
      id: SESSIONS_FEATURE_ID,
      scope: 'application',
      activation: 'on-route',
      required: false,
      requires: [SESSIONS_WORKSPACE_CAPABILITY, SESSION_NAVIGATION_CAPABILITY],
    })
    expect(sessionsFeature.declarations?.routes).toEqual([
      SESSIONS_ROUTE_ID,
      SESSIONS_CONTENT_ROUTE_ID,
      SESSIONS_INSPECTOR_ROUTE_ID,
    ])
    expect(workspace.catalog.listSessions).not.toHaveBeenCalled()
    expect(workspace.inspection.inspectSession).not.toHaveBeenCalled()

    const nodes = (instance.contributions.surfaces ?? [])
      .map(surface => (surface.value as LayoutRegion<SessionsUiNode>).node)
    expect(nodes.map(node => node.kind)).toEqual([
      'sessions.navigator',
      'sessions.content',
      'sessions.inspector',
    ])
    expect(nodes.every(node => node.featureId === SESSIONS_FEATURE_ID)).toBe(true)
    expect(nodes[0]).toMatchObject({ catalogResourceId: SESSIONS_CATALOG_RESOURCE_ID })
    expect(nodes[2]).toMatchObject({
      catalogResourceId: SESSIONS_CATALOG_RESOURCE_ID,
      inspectionResourceId: SESSIONS_INSPECTION_RESOURCE_ID,
    })
    expect(instance.contributions.keymaps?.[0]?.value.bindings).toEqual(expect.arrayContaining([
      { key: 'j', commandId: 'sessions.selection.next' },
      { key: 'k', commandId: 'sessions.selection.previous' },
      { key: 'enter', commandId: 'sessions.selection.activate' },
      { key: 'r', commandId: 'sessions.refresh' },
      { key: 'f', commandId: 'sessions.fork' },
    ]))
    await instance.dispose()
    await manager.dispose()
  })

  it('normalizes direct resource failures and suppresses aborted inspection errors', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('sessions-resource-errors')
    let inspectionAbort: AbortController | undefined
    const workspace: SessionsWorkspacePort = {
      catalog: {
        listSessions: vi.fn(async () => { throw 'catalog offline' }),
      },
      inspection: {
        inspectSession: vi.fn(async () => {
          if (inspectionAbort !== undefined) {
            inspectionAbort.abort('inspection surface closed')
            throw 'inspection aborted'
          }
          throw new Error('inspection offline')
        }),
      },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigationPort('active') },
      ],
    }) as SessionsFeatureInstance
    const definitions = new Map(
      instance.contributions.resources?.map(resource => [resource.id, resource.value]),
    )
    const catalogDefinition = definitions.get(
      SESSIONS_CATALOG_RESOURCE_ID,
    ) as ResourceDefinition<SessionCatalogSnapshot>
    const inspectionDefinition = definitions.get(
      SESSIONS_INSPECTION_RESOURCE_ID,
    ) as ResourceDefinition<SessionsInspectionProjection | undefined>

    const catalogSurface = sessionScope.child('surface', 'catalog-error')
    await expect(catalogDefinition.load({
      scope: catalogSurface,
      signal: catalogSurface.signal,
      requestId: 1,
      previous: undefined,
    })).rejects.toBe('catalog offline')
    expect(instance.model.snapshot().catalog).toEqual({
      phase: 'failed', message: 'catalog offline',
    })

    const emptyInspectionSurface = sessionScope.child('surface', 'inspection-empty')
    await expect(inspectionDefinition.load({
      scope: emptyInspectionSurface,
      signal: emptyInspectionSurface.signal,
      requestId: 1,
      previous: undefined,
    })).resolves.toBeUndefined()

    seedCatalog(instance, catalog(['cold'], { attached: false }), 2)
    instance.model.dispatch({ type: 'selection.activated', requestId: 2 })
    const inspectionSurface = sessionScope.child('surface', 'inspection-error')
    await expect(inspectionDefinition.load({
      scope: inspectionSurface,
      signal: inspectionSurface.signal,
      requestId: 2,
      previous: undefined,
    })).rejects.toThrow('inspection offline')
    expect(instance.model.snapshot().inspection).toMatchObject({
      phase: 'failed', sessionId: 'cold', message: 'inspection offline',
    })

    inspectionAbort = new AbortController()
    instance.model.dispatch({ type: 'inspection.refresh-requested' })
    const abortedInspectionSurface = sessionScope.child('surface', 'inspection-abort')
    await expect(inspectionDefinition.load({
      scope: abortedInspectionSurface,
      signal: inspectionAbort.signal,
      requestId: 3,
      previous: undefined,
    })).rejects.toBe('inspection aborted')
    expect(inspectionAbort.signal.aborted).toBe(true)

    await instance.dispose()
    await manager.dispose()
  })

  it('accepts generic navigation commands and exposes its factory state source', async () => {
    const manager = new ScopeManager()
    const workspace: SessionsWorkspacePort = {
      catalog: { listSessions: vi.fn(async () => catalog([])) },
      inspection: { inspectSession: vi.fn(async ({ sessionId }) => inspection(sessionId)) },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const navigation = navigationPort('current')
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigation },
      ],
    }) as SessionsFeatureInstance
    seedCatalog(instance, catalog(['current']))
    const handlers = handlersOf(instance)
    const openRoute = vi.fn(async () => {})
    const context = { navigation: workspaceNavigation(), openRoute }

    const node = (
      instance.contributions.surfaces?.[0]?.value as LayoutRegion<SessionsUiNode>
    ).node
    expect(node.state.snapshot()).toBe(instance.model.snapshot())
    const stateChanged = vi.fn()
    const stop = node.state.onChanged(stateChanged)
    instance.model.dispatch({ type: 'query.changed', query: 'current' })
    expect(stateChanged).toHaveBeenCalled()
    stop()
    instance.model.dispatch({ type: 'query.changed', query: '' })

    for (const direction of ['up', 'down', 'left'] as const) {
      await handlers.get('navigation.move')?.handle(routed({
        type: 'navigation.move', direction,
      }), context)
    }
    for (const direction of ['up', 'down'] as const) {
      await handlers.get('navigation.page')?.handle(routed({
        type: 'navigation.page', direction,
      }), context)
    }
    await handlers.get('edit.insert')?.handle(routed({
      type: 'edit.delete-forward',
    }), context)

    await handlers.get(SESSIONS_FORK_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_FORK_COMMAND_ID), context,
    )
    await handlers.get('action.submit')?.handle(routed({ type: 'action.submit' }), context)
    await vi.waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith({
      kind: 'fork', sessionId: 'current', signal: expect.any(AbortSignal),
      cancellation: { cancel: expect.any(Function) },
    }))
    await vi.waitFor(() => expect(openRoute).toHaveBeenCalledWith('chat'))
    await vi.waitFor(() => expect(instance.model.snapshot().operation.phase).toBe('idle'))

    await instance.dispose()
    await instance.dispose()
    await manager.dispose()
  })

  it('attaches an observed live session and opens Chat only after navigation commits', async () => {
    const manager = new ScopeManager()
    const pending = deferred<void>()
    const workspace: SessionsWorkspacePort = {
      catalog: { listSessions: vi.fn(async () => catalog([])) },
      inspection: { inspectSession: vi.fn(async ({ sessionId }) => inspection(sessionId)) },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const navigation: SessionNavigationPort = {
      snapshot: vi.fn(() => ({ sessionId: 'current', busy: false })),
      navigate: vi.fn(async () => { await pending.promise }),
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigation },
      ],
    }) as SessionsFeatureInstance
    const snapshot = catalog(['current', 'live'])
    seedCatalog(instance, {
      ...snapshot,
      sessions: [snapshot.sessions[0]!, {
        ...snapshot.sessions[1]!,
        attached: true,
        liveStatus: 'idle',
      }],
    })
    const handlers = handlersOf(instance)
    const openRoute = vi.fn(async () => {})
    const context = { navigation: workspaceNavigation(), openRoute }

    await handlers.get(SESSIONS_MOVE_DOWN_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_MOVE_DOWN_COMMAND_ID), context,
    )
    await handlers.get(SESSIONS_ACTIVATE_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_ACTIVATE_COMMAND_ID), context,
    )
    await vi.waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith({
      kind: 'activate',
      sessionId: 'live',
      intent: 'attach-live',
      signal: expect.any(AbortSignal),
      cancellation: { cancel: expect.any(Function) },
    }))
    expect(openRoute).not.toHaveBeenCalled()
    expect(instance.model.snapshot().operation).toMatchObject({
      phase: 'running', action: 'attach-live', sessionId: 'live',
    })

    pending.resolve()
    await vi.waitFor(() => expect(openRoute).toHaveBeenCalledWith('chat'))
    await vi.waitFor(() => expect(instance.model.snapshot().operation.phase).toBe('idle'))
    expect(workspace.activation.activateSession).not.toHaveBeenCalled()
    expect(workspace.fork.forkSession).not.toHaveBeenCalled()
    await instance.dispose()
    await manager.dispose()
  })

  it('inspects and confirms a cold-root resume before using the navigation transaction', async () => {
    const manager = new ScopeManager()
    const workspace: SessionsWorkspacePort = {
      catalog: { listSessions: vi.fn(async () => catalog([])) },
      inspection: { inspectSession: vi.fn(async ({ sessionId }) => inspection(sessionId)) },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const navigation: SessionNavigationPort = {
      snapshot: vi.fn(() => ({ sessionId: 'current', busy: false })),
      navigate: vi.fn(async () => {}),
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigation },
      ],
    }) as SessionsFeatureInstance
    seedCatalog(instance, catalog(['current', 'cold']))
    const handlers = handlersOf(instance)
    const openRoute = vi.fn(async () => {})
    const navigatorContext = { navigation: workspaceNavigation(), openRoute }

    await handlers.get(SESSIONS_MOVE_DOWN_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_MOVE_DOWN_COMMAND_ID), navigatorContext,
    )
    await handlers.get(SESSIONS_ACTIVATE_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_ACTIVATE_COMMAND_ID), navigatorContext,
    )
    expect(openRoute).toHaveBeenCalledWith(SESSIONS_INSPECTOR_ROUTE_ID)
    expect(navigation.navigate).not.toHaveBeenCalled()

    const stamp = request(2, 1)
    const projection = await projectSessionsInspection(
      inspection('cold'),
      new AbortController().signal,
    )
    instance.model.dispatch({ type: 'inspection.load-started', sessionId: 'cold', request: stamp })
    instance.model.dispatch({
      type: 'inspection.loaded', sessionId: 'cold', request: stamp, projection,
    })
    const inspectorContext = { navigation: workspaceNavigation('inspector'), openRoute }
    await handlers.get(SESSIONS_RESUME_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_RESUME_COMMAND_ID), inspectorContext,
    )
    expect(instance.model.snapshot().operation).toEqual({
      phase: 'confirm-resume', sessionId: 'cold',
    })
    await handlers.get(SESSIONS_ACTIVATE_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_ACTIVATE_COMMAND_ID), inspectorContext,
    )

    await vi.waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith({
      kind: 'activate',
      sessionId: 'cold',
      intent: 'resume-cold',
      signal: expect.any(AbortSignal),
      cancellation: { cancel: expect.any(Function) },
    }))
    await vi.waitFor(() => expect(openRoute).toHaveBeenCalledWith('chat'))
    expect(workspace.activation.activateSession).not.toHaveBeenCalled()
    await instance.dispose()
    await manager.dispose()
  })

  it('requires fork confirmation and suppresses a late result after Esc cancellation', async () => {
    const manager = new ScopeManager()
    const pending = deferred<void>()
    let navigationSignal: AbortSignal | undefined
    const workspace: SessionsWorkspacePort = {
      catalog: { listSessions: vi.fn(async () => catalog([])) },
      inspection: { inspectSession: vi.fn(async ({ sessionId }) => inspection(sessionId)) },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const navigation: SessionNavigationPort = {
      snapshot: vi.fn(() => ({ sessionId: 'current', busy: false })),
      navigate: vi.fn(async (request) => {
        navigationSignal = request.signal
        await pending.promise
      }),
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigation },
      ],
    }) as SessionsFeatureInstance
    seedCatalog(instance, catalog(['current']))
    const handlers = handlersOf(instance)
    const openRoute = vi.fn(async () => {})
    const context = { navigation: workspaceNavigation(), openRoute }

    await handlers.get(SESSIONS_FORK_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_FORK_COMMAND_ID), context,
    )
    expect(instance.model.snapshot().operation).toEqual({
      phase: 'confirm-fork', sessionId: 'current',
    })
    expect(navigation.navigate).not.toHaveBeenCalled()
    await handlers.get(SESSIONS_ACTIVATE_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_ACTIVATE_COMMAND_ID), context,
    )
    await vi.waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith({
      kind: 'fork', sessionId: 'current', signal: expect.any(AbortSignal),
      cancellation: { cancel: expect.any(Function) },
    }))
    await handlers.get(SESSIONS_BACK_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_BACK_COMMAND_ID), context,
    )
    expect(navigationSignal?.aborted).toBe(true)
    expect(instance.model.snapshot().operation.phase).toBe('idle')

    const snapshotCallsBeforeCancellation = vi.mocked(navigation.snapshot).mock.calls.length
    pending.resolve()
    await vi.waitFor(() => expect(vi.mocked(navigation.snapshot).mock.calls.length)
      .toBeGreaterThan(snapshotCallsBeforeCancellation))
    await instance.dispose()
    expect(openRoute).not.toHaveBeenCalledWith('chat')
    expect(workspace.fork.forkSession).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('settles its running operation immediately when the Shell cancels navigation', async () => {
    const manager = new ScopeManager()
    const pending = deferred<void>()
    let navigationRequest: Parameters<SessionNavigationPort['navigate']>[0] | undefined
    const workspace: SessionsWorkspacePort = {
      catalog: { listSessions: vi.fn(async () => catalog([])) },
      inspection: { inspectSession: vi.fn(async ({ sessionId }) => inspection(sessionId)) },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const navigation: SessionNavigationPort = {
      snapshot: vi.fn(() => ({ sessionId: 'current', busy: false })),
      navigate: vi.fn(async request => {
        navigationRequest = request
        await pending.promise
      }),
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigation },
      ],
    }) as SessionsFeatureInstance
    const snapshot = catalog(['current', 'live'])
    seedCatalog(instance, {
      ...snapshot,
      sessions: [snapshot.sessions[0]!, {
        ...snapshot.sessions[1]!,
        attached: true,
        liveStatus: 'idle',
      }],
    })
    const handlers = handlersOf(instance)
    const openRoute = vi.fn(async () => {})
    const context = { navigation: workspaceNavigation(), openRoute }

    await handlers.get(SESSIONS_MOVE_DOWN_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_MOVE_DOWN_COMMAND_ID), context,
    )
    await handlers.get(SESSIONS_ACTIVATE_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_ACTIVATE_COMMAND_ID), context,
    )
    await vi.waitFor(() => expect(navigation.navigate).toHaveBeenCalledOnce())
    expect(instance.model.snapshot().operation.phase).toBe('running')
    expect(navigationRequest?.cancellation).toBeDefined()

    navigationRequest?.cancellation?.cancel(new Error('cancelled from Shell'))
    expect(navigationRequest?.signal.aborted).toBe(true)
    expect(instance.model.snapshot().operation.phase).toBe('idle')
    expect(openRoute).not.toHaveBeenCalled()

    pending.resolve()
    await instance.dispose()
    expect(openRoute).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('disposes a pending navigation attempt without publishing its late result', async () => {
    const manager = new ScopeManager()
    const pending = deferred<void>()
    const workspace: SessionsWorkspacePort = {
      catalog: { listSessions: vi.fn(async () => catalog([])) },
      inspection: { inspectSession: vi.fn(async ({ sessionId }) => inspection(sessionId)) },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const navigation: SessionNavigationPort = {
      snapshot: vi.fn(() => ({ sessionId: 'current', busy: false })),
      navigate: vi.fn(async () => { await pending.promise }),
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigation },
      ],
    }) as SessionsFeatureInstance
    seedCatalog(instance, catalog(['current']))
    const handlers = handlersOf(instance)
    const openRoute = vi.fn(async () => {})
    const context = { navigation: workspaceNavigation(), openRoute }

    await handlers.get(SESSIONS_FORK_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_FORK_COMMAND_ID), context,
    )
    await handlers.get(SESSIONS_ACTIVATE_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_ACTIVATE_COMMAND_ID), context,
    )
    await vi.waitFor(() => expect(navigation.navigate).toHaveBeenCalledOnce())

    const disposed = instance.dispose()
    pending.resolve()
    await disposed
    expect(openRoute).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('blocks navigation while the host is busy and reports transaction failures', async () => {
    const manager = new ScopeManager()
    let busy = true
    const workspace: SessionsWorkspacePort = {
      catalog: { listSessions: vi.fn(async () => catalog([])) },
      inspection: { inspectSession: vi.fn(async ({ sessionId }) => inspection(sessionId)) },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const navigation: SessionNavigationPort = {
      snapshot: vi.fn(() => ({ sessionId: 'current', busy })),
      navigate: vi.fn(async () => { throw new Error('candidate hydration failed') }),
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigation },
      ],
    }) as SessionsFeatureInstance
    const snapshot = catalog(['current', 'live'])
    seedCatalog(instance, {
      ...snapshot,
      sessions: [snapshot.sessions[0]!, { ...snapshot.sessions[1]!, attached: true }],
    })
    const handlers = handlersOf(instance)
    const openRoute = vi.fn(async () => {})
    const context = { navigation: workspaceNavigation(), openRoute }
    await handlers.get(SESSIONS_MOVE_DOWN_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_MOVE_DOWN_COMMAND_ID), context,
    )
    await handlers.get(SESSIONS_ACTIVATE_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_ACTIVATE_COMMAND_ID), context,
    )
    expect(instance.model.snapshot().operation).toMatchObject({
      phase: 'failed', message: 'Another session operation is already running',
    })
    expect(navigation.navigate).not.toHaveBeenCalled()

    await handlers.get(SESSIONS_BACK_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_BACK_COMMAND_ID), context,
    )
    busy = false
    await handlers.get(SESSIONS_ACTIVATE_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_ACTIVATE_COMMAND_ID), context,
    )
    await vi.waitFor(() => expect(instance.model.snapshot().operation).toMatchObject({
      phase: 'failed',
      action: 'attach-live',
      message: 'candidate hydration failed',
    }))
    expect(openRoute).not.toHaveBeenCalledWith('chat')
    await instance.dispose()
    await manager.dispose()
  })

  it('loads only when its route opens, aborts on close, and ignores a late catalog result', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('active')
    const pending = deferred<SessionCatalogSnapshot>()
    const signals: AbortSignal[] = []
    const workspace: SessionsWorkspacePort = {
      catalog: {
        listSessions: vi.fn(({ signal } = {}) => {
          if (signal !== undefined) signals.push(signal)
          return pending.promise
        }),
      },
      inspection: { inspectSession: vi.fn(async ({ sessionId }) => inspection(sessionId)) },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigationPort() },
      ],
    }) as SessionsFeatureInstance
    const host = new MutableHost(hostSnapshot({ kind: 'chat' }, instance))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(sessionScope, { columns: 120, rows: 30 })
    await lease.ready
    expect(workspace.catalog.listSessions).not.toHaveBeenCalled()

    host.set(hostSnapshot({
      kind: 'workspace',
      featureId: SESSIONS_FEATURE_ID,
      pane: 'navigator',
    }, instance))
    await lease.settled()
    await vi.waitFor(() => expect(workspace.catalog.listSessions).toHaveBeenCalledOnce())
    expect(signals[0]?.aborted).toBe(false)

    host.set(hostSnapshot({ kind: 'chat' }, instance))
    await lease.settled()
    expect(signals[0]?.aborted).toBe(true)
    pending.resolve(catalog(['late']))
    await Promise.resolve()
    await Promise.resolve()
    expect(projectSessionsCatalog(instance.model.snapshot()).rows).toEqual([])

    await runtime.dispose()
    await instance.dispose()
    await manager.dispose()
  })

  it('loads inspection only after an explicit request and forgets the target when the surface closes', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('inspection-lifecycle')
    const inspectionAborted = deferred<void>()
    let inspectionSignal: AbortSignal | undefined
    const workspace: SessionsWorkspacePort = {
      catalog: {
        listSessions: vi.fn(async () => catalog(['cold'], { attached: false })),
      },
      inspection: {
        inspectSession: vi.fn(({ sessionId, signal }) => {
          inspectionSignal = signal
          if (vi.mocked(workspace.inspection.inspectSession).mock.calls.length > 1) {
            return Promise.resolve(inspection(sessionId))
          }
          return new Promise<SessionInspectionSnapshot>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              inspectionAborted.resolve()
              reject(signal.reason)
            }, { once: true })
          })
        }),
      },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigationPort('active') },
      ],
    }) as SessionsFeatureInstance
    const host = new MutableHost(hostSnapshot({
      kind: 'workspace',
      featureId: SESSIONS_FEATURE_ID,
      pane: 'navigator',
    }, instance))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(sessionScope, { columns: 80, rows: 24 })
    await lease.ready
    await vi.waitFor(() => expect(projectSessionsCatalog(instance.model.snapshot()).rows)
      .toHaveLength(1))
    expect(workspace.inspection.inspectSession).not.toHaveBeenCalled()

    instance.model.dispatch({ type: 'selection.activated', requestId: 1 })
    await vi.waitFor(() => expect(workspace.inspection.inspectSession).toHaveBeenCalledOnce())
    expect(inspectionSignal?.aborted).toBe(false)

    host.set(hostSnapshot({ kind: 'chat' }, instance))
    await lease.settled()
    await inspectionAborted.promise
    expect(inspectionSignal?.aborted).toBe(true)

    host.set(hostSnapshot({
      kind: 'workspace',
      featureId: SESSIONS_FEATURE_ID,
      pane: 'navigator',
    }, instance))
    await lease.settled()
    await Promise.resolve()
    const inspectionCalls = vi.mocked(workspace.inspection.inspectSession).mock.calls.length
    const inspectionState = instance.model.snapshot().inspection

    await runtime.dispose()
    await instance.dispose()
    await manager.dispose()

    expect(inspectionCalls).toBe(1)
    expect(inspectionState).toEqual({ phase: 'idle' })
  })

  it('releases the inspection watcher after its Feature model was already disposed', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('feature-first-disposal')
    const workspace: SessionsWorkspacePort = {
      catalog: { listSessions: vi.fn(async () => catalog([])) },
      inspection: { inspectSession: vi.fn(async ({ sessionId }) => inspection(sessionId)) },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigationPort() },
      ],
    }) as SessionsFeatureInstance
    const host = new MutableHost(hostSnapshot({
      kind: 'workspace',
      featureId: SESSIONS_FEATURE_ID,
      pane: 'navigator',
    }, instance))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(sessionScope, { columns: 120, rows: 30 })
    await lease.ready
    await vi.waitFor(() => expect(lease.snapshot().surfaces[0]?.resources)
      .toHaveLength(2))

    await instance.dispose()
    await expect(runtime.dispose()).resolves.toBeUndefined()
    await manager.dispose()
  })

  it('routes j/k and Enter through semantic commands and lazily projects inspection', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('active')
    const workspace: SessionsWorkspacePort = {
      catalog: { listSessions: vi.fn(async () => catalog(['一号', '二号'])) },
      inspection: { inspectSession: vi.fn(async ({ sessionId }) => inspection(sessionId)) },
      activation: { activateSession: vi.fn() },
      fork: { forkSession: vi.fn() },
    }
    const instance = await sessionsFeature.create({
      scope: manager.app,
      dependencies: [
        { token: SESSIONS_WORKSPACE_CAPABILITY, value: workspace },
        { token: SESSION_NAVIGATION_CAPABILITY, value: navigationPort('一号') },
      ],
    }) as SessionsFeatureInstance
    const route = {
      kind: 'workspace',
      featureId: SESSIONS_FEATURE_ID,
      pane: 'navigator',
    } as const
    const host = new MutableHost(hostSnapshot(route, instance))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(sessionScope, { columns: 160, rows: 40 })
    await lease.ready
    await vi.waitFor(() => expect(projectSessionsCatalog(instance.model.snapshot()).rows)
      .toHaveLength(2))

    const handlers = new Map((instance.contributions.commands ?? []).map(command => [
      command.id,
      command.value as FeatureCommandHandler,
    ]))
    const openRoute = vi.fn(async () => {})
    const context = { navigation: host.snapshot().navigation, openRoute }
    const target = { kind: 'feature', featureId: SESSIONS_FEATURE_ID } as const
    await handlers.get('edit.insert')?.handle({
      target,
      command: { type: 'edit.insert', text: '二' },
    }, context)
    expect(projectSessionsCatalog(instance.model.snapshot()).rows.map(row => row.sessionId))
      .toEqual(['二号'])
    await handlers.get('edit.delete-backward')?.handle({
      target,
      command: { type: 'edit.delete-backward' },
    }, context)
    await handlers.get(SESSIONS_MOVE_UP_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_MOVE_UP_COMMAND_ID), context,
    )
    await handlers.get(SESSIONS_MOVE_DOWN_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_MOVE_DOWN_COMMAND_ID), context,
    )
    expect(projectSessionsCatalog(instance.model.snapshot()).selectedSessionId).toBe('二号')

    await handlers.get(SESSIONS_REFRESH_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_REFRESH_COMMAND_ID), context,
    )
    await vi.waitFor(() => expect(workspace.catalog.listSessions).toHaveBeenCalledTimes(2))

    await handlers.get('navigation.activate')?.handle({
      target,
      command: { type: 'navigation.activate' },
    }, context)
    expect(openRoute).toHaveBeenCalledWith(SESSIONS_INSPECTOR_ROUTE_ID)
    await vi.waitFor(() => expect(workspace.inspection.inspectSession).toHaveBeenCalledWith({
      sessionId: '二号',
      signal: expect.any(AbortSignal),
    }))
    await vi.waitFor(() => expect(instance.model.snapshot().inspection.phase).toBe('ready'))
    expect(instance.model.snapshot().inspection).toMatchObject({
      phase: 'ready',
      projection: {
        sessionId: '二号',
        header: { cwd: 'D:\\研发\\代理项目' },
      },
    })

    await handlers.get(SESSIONS_REFRESH_COMMAND_ID)?.handle(
      featureCommand(SESSIONS_REFRESH_COMMAND_ID), {
        navigation: workspaceNavigation('inspector'),
        openRoute,
      },
    )
    await vi.waitFor(() => expect(workspace.inspection.inspectSession).toHaveBeenCalledTimes(2))

    await runtime.dispose()
    const catalogCalls = vi.mocked(workspace.catalog.listSessions).mock.calls.length
    const inspectionCalls = vi.mocked(workspace.inspection.inspectSession).mock.calls.length
    instance.model.dispatch({ type: 'catalog.refresh-requested' })
    instance.model.dispatch({ type: 'inspection.refresh-requested' })
    await Promise.resolve()
    expect(workspace.catalog.listSessions).toHaveBeenCalledTimes(catalogCalls)
    expect(workspace.inspection.inspectSession).toHaveBeenCalledTimes(inspectionCalls)
    await instance.dispose()
    await manager.dispose()
  })

  it('contains a missing optional capability before creating the workspace', async () => {
    const registry = new FeatureRegistry()
    registry.register(sessionsFeature)
    const manager = new ScopeManager()
    const supervisor = new FeatureSupervisor({
      registry,
      scopeManager: manager,
      featureScope: 'application',
      capabilities: {
        resolve: () => { throw new Error('Session navigation capability missing') },
      },
    })
    await supervisor.start()
    await expect(supervisor.activateRoute(SESSIONS_ROUTE_ID)).resolves.toEqual([
      expect.objectContaining({
        featureId: SESSIONS_FEATURE_ID,
        state: 'unavailable',
        error: expect.objectContaining({ message: 'Session navigation capability missing' }),
      }),
    ])
    expect(supervisor.listActiveContributions()).toEqual([])
    await supervisor.dispose()
    await manager.dispose()
  })
})
