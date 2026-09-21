import { describe, expect, it, vi } from 'vitest'
import type {
  SessionDelegationPort,
  SessionDelegationSnapshot,
  SessionSubagent,
  SessionWorkflowRun,
} from '../src/activity/delegation-port.ts'
import type {
  SessionJob,
  SessionJobsPort,
  SessionJobsSnapshot,
} from '../src/activity/port.ts'
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
  ACTIVITY_DISMISS_COMMAND_ID,
  ACTIVITY_FEATURE_ID,
  ACTIVITY_KEYMAP_ID,
  ACTIVITY_NAVIGATOR_SURFACE_ID,
  ACTIVITY_REFRESH_COMMAND_ID,
  ACTIVITY_RESOURCE_ID,
  ACTIVITY_ROUTE_ID,
  ACTIVITY_STOP_COMMAND_ID,
  ACTIVITY_TAB_NEXT_COMMAND_ID,
  ACTIVITY_TAB_PREVIOUS_COMMAND_ID,
  activityFeature,
  createActivityFeatureModel,
  createActivityFeatureState,
  createActivityNavigatorNode,
  projectActivityCenter,
  projectActivityDetails,
  transitionActivityFeature,
  type ActivityFeatureInstance,
  type ActivityFeatureState,
  type ActivityFeedSnapshot,
} from '../src/features/activity/index.ts'
import {
  contributeToSlot,
  createSlotRegistry,
  type SlotContribution,
} from '../src/layout/slots.ts'
import type { LayoutRegion } from '../src/layout/strategy.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import type { RoutedUiCommand, UiCommand } from '../src/navigation/commands.ts'
import {
  createNavigationState,
  transitionNavigation,
  type NavigationRoute,
} from '../src/navigation/state.ts'
import type { FeatureSurfaceProjectContext } from '../src/presentation/feature-surface.ts'
import type { ResourceDefinition } from '../src/resource/resource-coordinator.ts'
import {
  SESSION_DELEGATION_CAPABILITY,
  SESSION_JOBS_CAPABILITY,
} from '../src/runtime/session-capabilities.ts'
import type { ActivityUiNode } from '../src/features/activity/index.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  return {
    promise: new Promise<T>((done, fail) => { resolve = done; reject = fail }),
    resolve: value => { resolve(value) },
    reject: error => { reject(error) },
  }
}

function job(id: string, overrides: Partial<SessionJob> = {}): SessionJob {
  return {
    id,
    kind: 'bash',
    label: `Run ${id}`,
    status: 'running',
    startedAt: 42,
    reported: false,
    ...overrides,
  }
}

function subagent(id: string, overrides: Partial<SessionSubagent> = {}): SessionSubagent {
  return {
    id,
    parentId: 'root',
    depth: 1,
    mode: 'one-shot',
    status: 'running',
    hasChildren: false,
    interruptible: true,
    ...overrides,
  }
}

function workflow(id: string, overrides: Partial<SessionWorkflowRun> = {}): SessionWorkflowRun {
  return {
    id,
    name: `Workflow ${id}`,
    status: 'running',
    startSeq: 7,
    phases: [],
    ...overrides,
  }
}

function jobsSnapshot(
  jobs: readonly SessionJob[],
  overrides: Partial<SessionJobsSnapshot> = {},
): SessionJobsSnapshot {
  return { available: true, generation: 3, jobs, ...overrides }
}

function delegationSnapshot(
  overrides: Partial<SessionDelegationSnapshot> = {},
): SessionDelegationSnapshot {
  return {
    available: true,
    generation: 5,
    loading: false,
    subagentsAvailable: true,
    subagents: [],
    workflows: [],
    ...overrides,
  }
}

class FakeJobsPort implements SessionJobsPort {
  private readonly listeners = new Set<() => void>()
  readonly runJobAction = vi.fn((): ReturnType<SessionJobsPort['runJobAction']> => ({
    accepted: true,
    outcome: 'requested',
  }))
  readonly reads = vi.fn(() => this.value)

  constructor(private value: SessionJobsSnapshot = jobsSnapshot([])) {}

  jobsSnapshot(): SessionJobsSnapshot {
    return this.reads()
  }

  set(value: SessionJobsSnapshot): void {
    this.value = value
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  listenerCount(): number {
    return this.listeners.size
  }

  onJobsChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  disposeJobs(): void {}
}

class FakeDelegationPort implements SessionDelegationPort {
  private readonly listeners = new Set<() => void>()
  readonly refreshDelegation = vi.fn(async (_signal?: AbortSignal) => {})
  readonly runDelegationAction = vi.fn((): ReturnType<SessionDelegationPort['runDelegationAction']> => ({
    accepted: true,
    outcome: 'requested',
  }))
  readonly reads = vi.fn(() => this.value)

  constructor(private value: SessionDelegationSnapshot = delegationSnapshot()) {}

  delegationSnapshot(): SessionDelegationSnapshot {
    return this.reads()
  }

  set(value: SessionDelegationSnapshot): void {
    this.value = value
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  listenerCount(): number {
    return this.listeners.size
  }

  onDelegationChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  disposeDelegation(): void {}
}

async function createInstance(
  manager: ScopeManager,
  jobs: FakeJobsPort,
  delegation: FakeDelegationPort,
): Promise<ActivityFeatureInstance> {
  return await activityFeature.create({
    scope: manager.createSession('activity-test'),
    dependencies: [
      { token: SESSION_JOBS_CAPABILITY, value: jobs },
      { token: SESSION_DELEGATION_CAPABILITY, value: delegation },
    ],
  }) as ActivityFeatureInstance
}

function seed(
  instance: ActivityFeatureInstance,
  jobs: SessionJobsSnapshot,
  delegation: SessionDelegationSnapshot,
): void {
  instance.model.dispatch({ type: 'jobs.changed', snapshot: jobs })
  instance.model.dispatch({ type: 'delegation.changed', snapshot: delegation })
  instance.model.dispatch({ type: 'surface.opened' })
}

function handlersOf(instance: ActivityFeatureInstance): Map<string, FeatureCommandHandler> {
  return new Map((instance.contributions.commands ?? []).map(command => [
    command.id,
    command.value as FeatureCommandHandler,
  ]))
}

function routed(command: UiCommand): RoutedUiCommand {
  return Object.freeze({
    target: Object.freeze({ kind: 'feature' as const, featureId: ACTIVITY_FEATURE_ID }),
    command: Object.freeze(command),
  })
}

function featureCommand(commandId: string): RoutedUiCommand {
  return routed({ type: 'feature.command', commandId })
}

function workspaceNavigation() {
  return transitionNavigation(createNavigationState(), {
    type: 'navigate',
    route: { kind: 'workspace', featureId: ACTIVITY_FEATURE_ID, pane: 'navigator' },
  }).state
}

function surfaceContext(
  width = 80,
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

function seededState(
  jobs: readonly SessionJob[],
  delegation: Partial<SessionDelegationSnapshot> = {},
): ActivityFeatureState {
  let state = createActivityFeatureState()
  state = transitionActivityFeature(state, {
    type: 'jobs.changed',
    snapshot: jobsSnapshot(jobs),
  }).state
  state = transitionActivityFeature(state, {
    type: 'delegation.changed',
    snapshot: delegationSnapshot(delegation),
  }).state
  return transitionActivityFeature(state, { type: 'surface.opened' }).state
}

describe('Activity Feature machine', () => {
  it('cycles tabs and moves selection through the embedded center machine', () => {
    let state = seededState([job('a'), job('b')], {
      subagents: [subagent('child')],
      workflows: [workflow('run-1')],
    })
    const view = projectActivityCenter(state)!
    expect(view.tab).toBe('jobs')
    expect(view.tabs).toEqual([
      { id: 'jobs', label: 'Jobs', count: 2, live: 2, selected: true },
      { id: 'subagents', label: 'Subagents', count: 1, live: 1, selected: false },
      { id: 'workflows', label: 'Workflows', count: 1, live: 1, selected: false },
    ])
    // Jobs render newest-first; the reconciled selection lands on 'b'.
    expect(view.rows.map(row => row.title)).toEqual(['Run b', 'Run a'])
    expect(view.rows[0]?.selected).toBe(true)

    state = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'move-down' },
    }).state
    expect(projectActivityCenter(state)?.rows[1]?.selected).toBe(true)

    state = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'tab-next' },
    }).state
    expect(projectActivityCenter(state)?.tab).toBe('subagents')
    expect(projectActivityCenter(state)?.rows[0]?.selected).toBe(true)

    state = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'tab-next' },
    }).state
    expect(projectActivityCenter(state)?.tab).toBe('workflows')

    state = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'tab-previous' },
    }).state
    expect(projectActivityCenter(state)?.tab).toBe('subagents')
  })

  it('gates stop requests by tab authority and stoppable state', () => {
    let state = seededState([job('done', { status: 'completed' })], {
      workflows: [workflow('run-1')],
    })
    const notStoppable = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'request-stop' },
    })
    expect(notStoppable.effects).toEqual([])
    expect(projectActivityCenter(notStoppable.state)?.error)
      .toBe('Job completed cannot be stopped.')

    state = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'tab-next' },
    }).state
    state = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'tab-next' },
    }).state
    const workflowStop = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'request-stop' },
    })
    expect(workflowStop.effects).toEqual([])
    expect(projectActivityCenter(workflowStop.state)?.error).toBe(
      'Workflow runs are observed from the parent Session and expose no independent cancel authority.',
    )

    const stopped = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'request-stop' },
    }).state
    expect(stopped.center.confirmStop).toBe(false)
    const confirmed = transitionActivityFeature(stopped, {
      type: 'center.action',
      action: { type: 'request-stop' },
    })
    expect(confirmed.state.center.confirmStop).toBe(false)
  })

  it('confirms a stop into a job action outcome and settles resolved or rejected', () => {
    let state = seededState([job('job-1')])
    state = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'request-stop' },
    }).state
    expect(state.center.confirmStop).toBe(true)
    expect(projectActivityCenter(state)?.rows[0]?.title).toBe('Run job-1')

    // Movement is frozen while the confirmation is pending.
    const blocked = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'move-down' },
    })
    expect(blocked.state).toBe(state)

    const confirmed = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'enter' },
    })
    expect(confirmed.effects).toEqual([{
      type: 'job.action',
      action: {
        kind: 'kill',
        ref: { id: 'job-1', startedAt: 42, generation: 3 },
      },
      successMessage: 'Stop requested for job-1',
    }])

    const resolved = transitionActivityFeature(confirmed.state, {
      type: 'stop.resolved',
      message: 'Stop requested for job-1',
    })
    expect(resolved.state.center.confirmStop).toBe(false)
    expect(resolved.state.center.notice).toBe('Stop requested for job-1')
    expect(resolved.state.center.error).toBeUndefined()

    const rejected = transitionActivityFeature(confirmed.state, {
      type: 'stop.rejected',
      message: 'job-ref-mismatch: stale generation',
    })
    expect(rejected.state.center.confirmStop).toBe(false)
    expect(rejected.state.center.error).toBe('job-ref-mismatch: stale generation')
    expect(rejected.state.center.notice).toBeUndefined()
  })

  it('confirms a subagent interrupt into a delegation action outcome', () => {
    let state = seededState([], { subagents: [subagent('sub-1')] })
    state = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'tab-next' },
    }).state
    state = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'request-stop' },
    }).state
    const confirmed = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'enter' },
    })
    expect(confirmed.effects).toEqual([{
      type: 'delegation.action',
      action: {
        kind: 'interrupt-subagent',
        ref: { id: 'sub-1', parentId: 'root', generation: 5 },
      },
      successMessage: 'Interrupt requested for sub-1',
    }])
  })

  it('reconciles the selection across snapshot changes and clears pending confirmations', () => {
    let state = seededState([job('a'), job('b')])
    state = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'request-stop' },
    }).state
    expect(state.center.confirmStop).toBe(true)

    const reconciled = transitionActivityFeature(state, {
      type: 'jobs.changed',
      snapshot: jobsSnapshot([job('a')]),
    })
    const view = projectActivityCenter(reconciled.state)!
    expect(view.rows.map(row => row.title)).toEqual(['Run a'])
    expect(reconciled.state.center.confirmStop).toBe(false)
    expect(reconciled.state.center.error).toBeUndefined()

    const withError = transitionActivityFeature(reconciled.state, {
      type: 'delegation.changed',
      snapshot: delegationSnapshot({ error: 'catalog degraded' }),
    })
    expect(projectActivityCenter(withError.state)?.error).toBe('catalog degraded')
  })

  it('tracks the delegation refresh lifecycle and duplicate requests', () => {
    let state = seededState([job('a')])
    const requested = transitionActivityFeature(state, {
      type: 'center.action',
      action: { type: 'refresh' },
    })
    expect(requested.effects).toEqual([{ type: 'delegation.refresh' }])

    state = transitionActivityFeature(requested.state, { type: 'refresh.started' }).state
    expect(state.refresh).toBe('refreshing')
    expect(transitionActivityFeature(state, { type: 'refresh.started' }).state).toBe(state)

    const duplicated = transitionActivityFeature(state, { type: 'refresh.duplicated' })
    expect(duplicated.state.center.notice)
      .toBe('Subagent catalog refresh is already running.')

    const failed = transitionActivityFeature(state, {
      type: 'refresh.failed',
      message: 'offline',
    })
    expect(failed.state.refresh).toBe('failed')
    expect(failed.state.center.error).toBe('Subagent refresh failed: offline')

    const succeeded = transitionActivityFeature(state, { type: 'refresh.succeeded' })
    expect(succeeded.state.refresh).toBe('idle')
    expect(transitionActivityFeature(succeeded.state, { type: 'refresh.succeeded' }).state)
      .toBe(succeeded.state)
  })

  it('prewarms the subagent catalog only when it opens empty', () => {
    const empty = seededState([], { subagentsAvailable: true, subagents: [] })
    expect(empty.center.open).toBe(true)
    // seededState drops effects; exercise surface.opened directly for the prewarm.
    let state = createActivityFeatureState()
    state = transitionActivityFeature(state, {
      type: 'delegation.changed',
      snapshot: delegationSnapshot({ subagentsAvailable: true, subagents: [] }),
    }).state
    const prewarm = transitionActivityFeature(state, { type: 'surface.opened' })
    expect(prewarm.effects).toEqual([{ type: 'delegation.refresh' }])

    state = transitionActivityFeature(state, {
      type: 'delegation.changed',
      snapshot: delegationSnapshot({ subagents: [subagent('kept')] }),
    }).state
    state = { ...state, center: { ...state.center, open: false } }
    const reopened = transitionActivityFeature(state, { type: 'surface.opened' })
    expect(reopened.effects).toEqual([])
    expect(transitionActivityFeature(reopened.state, { type: 'surface.opened' }).state)
      .toBe(reopened.state)
  })

  it('closes the surface, resets the center, and cancels an in-flight refresh', () => {
    let state = seededState([job('a')])
    state = transitionActivityFeature(state, { type: 'refresh.started' }).state
    const closed = transitionActivityFeature(state, { type: 'surface.closed' })
    expect(closed.effects).toEqual([{ type: 'delegation.refresh-cancel' }])
    expect(closed.state.center.open).toBe(false)
    expect(closed.state.refresh).toBe('idle')
    expect(transitionActivityFeature(closed.state, { type: 'surface.closed' }).effects)
      .toEqual([])
  })
})

describe('Activity Feature surfaces', () => {
  it('renders the exact tab strip, status markers, empty states, and confirm rows', () => {
    const model = createActivityFeatureModel()
    model.dispatch({ type: 'jobs.changed', snapshot: jobsSnapshot([job('a')]) })
    model.dispatch({ type: 'delegation.changed', snapshot: delegationSnapshot() })
    model.dispatch({ type: 'surface.opened' })
    const navigator = createActivityNavigatorNode(model)

    const projected = navigator.project(surfaceContext(80, 10))
    expect(projected.title).toBe('Activity')
    expect(projected.rows[0]?.text).toBe('▰ JOBS 1 · 1 LIVE  │  SUBAGENTS 0  │  WORKFLOWS 0')
    const selected = projected.rows.find(row => row.selected)
    expect(selected?.text).toContain('● Run a')
    expect(selected?.tone).toBe('accent')
    expect(projected.actionHint).toBe('[/] tabs · j/k move · Enter details · K stop · R refresh')

    model.dispatch({ type: 'center.action', action: { type: 'request-stop' } })
    const confirming = navigator.project(surfaceContext(80, 10))
    expect(confirming.rows.map(row => row.text).join('\n')).toContain('Stop Run a?')
    expect(confirming.rows.map(row => row.text).join('\n')).toContain('Enter confirm')
    expect(confirming.actionHint).toBe('Enter confirm')
    model.dispatch({ type: 'center.action', action: { type: 'escape' } })

    model.dispatch({ type: 'center.action', action: { type: 'tab-next' } })
    const subagents = navigator.project(surfaceContext(80, 6))
    expect(subagents.rows[0]?.text).toBe('JOBS 1 · 1 LIVE  │  ▰ SUBAGENTS 0  │  WORKFLOWS 0')
    expect(subagents.rows.map(row => row.text).join('\n'))
      .toContain('No durable Subagent descendants.')

    model.dispatch({
      type: 'delegation.changed',
      snapshot: delegationSnapshot({ subagentsAvailable: false, loading: true }),
    })
    const degraded = navigator.project(surfaceContext(80, 10)).rows.map(row => row.text).join('\n')
    expect(degraded).toContain('Refreshing Subagent catalog…')
    expect(degraded).toContain('Subagent service is not mounted in this Agent composition.')

    model.dispatch({ type: 'stop.rejected', message: 'denied' })
    model.dispatch({ type: 'stop.resolved', message: 'noted' })
    model.dispatch({ type: 'feed.failed', message: 'read failed' })
    const banded = navigator.project(surfaceContext(80, 12)).rows.map(row => row.text).join('\n')
    expect(banded).toContain('Feed error: read failed')
    expect(banded).toContain('Notice: noted')
    model.dispose()
  })

  it('renders lineage spines and tab-aware markers in the navigator', () => {
    const model = createActivityFeatureModel()
    model.dispatch({ type: 'jobs.changed', snapshot: jobsSnapshot([]) })
    model.dispatch({
      type: 'delegation.changed',
      snapshot: delegationSnapshot({
        subagents: [
          subagent('root-child'),
          subagent('grandchild', { parentId: 'root-child', depth: 2, status: 'idle', interruptible: false }),
          subagent('broken', { status: 'diagnostic', diagnosticReason: 'corrupt', interruptible: false }),
        ],
      }),
    })
    model.dispatch({ type: 'surface.opened' })
    model.dispatch({ type: 'center.action', action: { type: 'tab-next' } })
    const rows = createActivityNavigatorNode(model).project(surfaceContext(90, 10)).rows
    const text = rows.map(row => row.text).join('\n')
    expect(text).toContain('● root-child')
    expect(text).toContain('└─○ grandchild')
    expect(text).toContain('? broken')
    model.dispose()
  })

  it('projects detail modal content with authority and control facts', () => {
    const model = createActivityFeatureModel()
    model.dispatch({
      type: 'jobs.changed',
      snapshot: jobsSnapshot([job('a', { detail: 'exit 1', ownerSession: 'owner-1' })]),
    })
    model.dispatch({ type: 'delegation.changed', snapshot: delegationSnapshot() })
    model.dispatch({ type: 'surface.opened' })

    const details = projectActivityDetails(model.snapshot())
    expect(details?.title).toBe('Run a')
    expect(details?.fields.map(entry => [entry.label, entry.value])).toEqual([
      ['State', 'running'],
      ['Identity', 'a · bash'],
      ['Authority', 'JobRegistry'],
      ['Control', 'Stop available'],
      ['Trace', 'exit 1\nOwner owner-1'],
    ])

    model.dispatch({ type: 'center.action', action: { type: 'tab-next' } })
    model.dispatch({ type: 'center.action', action: { type: 'tab-next' } })
    model.dispatch({
      type: 'delegation.changed',
      snapshot: delegationSnapshot({ workflows: [workflow('run-9')] }),
    })
    const workflowDetails = projectActivityDetails(model.snapshot())
    expect(workflowDetails?.fields.map(entry => [entry.label, entry.value])).toEqual([
      ['State', 'running'],
      ['Identity', 'run-9 · 0 agents'],
      ['Authority', 'Session events'],
      ['Control', 'Read-only from parent Session'],
      ['Trace', 'No workflow members were published.'],
    ])

    model.dispatch({ type: 'surface.closed' })
    expect(projectActivityDetails(model.snapshot())).toBeUndefined()
    model.dispose()
  })

  it('opens, moves and closes the in-page details modal through wrapper events', () => {
    const model = createActivityFeatureModel()
    model.dispatch({ type: 'jobs.changed', snapshot: jobsSnapshot([job('a')]) })
    model.dispatch({ type: 'delegation.changed', snapshot: delegationSnapshot() })
    expect(transitionActivityFeature(model.snapshot(), { type: 'details.open' }).state.details)
      .toBeUndefined()
    model.dispatch({ type: 'surface.opened' })
    model.dispatch({ type: 'details.open' })
    expect(model.snapshot().details).toEqual({ fieldIndex: 0 })
    model.dispatch({ type: 'details.move', direction: 'down' })
    expect(model.snapshot().details).toEqual({ fieldIndex: 1 })
    model.dispatch({ type: 'details.move', direction: 'down', amount: 99 })
    expect(model.snapshot().details?.fieldIndex).toBe(3)
    model.dispatch({ type: 'details.move', direction: 'up', amount: 99 })
    expect(model.snapshot().details).toEqual({ fieldIndex: 0 })
    model.dispatch({ type: 'center.action', action: { type: 'request-stop' } })
    expect(model.snapshot().center.confirmStop).toBe(true)
    model.dispatch({ type: 'details.close' })
    model.dispatch({ type: 'center.action', action: { type: 'escape' } })
    model.dispatch({ type: 'details.open' })
    expect(model.snapshot().details).toEqual({ fieldIndex: 0 })
    model.dispatch({ type: 'center.action', action: { type: 'tab-next' } })
    expect(model.snapshot().details).toBeUndefined()
    expect(model.snapshot().center.tab).toBe('subagents')
    model.dispose()
  })

  it('isolates state and effect listeners and disposes idempotently', () => {
    const model = createActivityFeatureModel()
    model.dispatch({ type: 'surface.opened' })
    const stateListener = vi.fn()
    const effectListener = vi.fn()
    model.onChanged(() => { throw new Error('state listener failed') })
    const stopState = model.onChanged(stateListener)
    model.onEffect(() => { throw new Error('effect listener failed') })
    const stopEffect = model.onEffect(effectListener)
    model.dispatch({ type: 'center.action', action: { type: 'refresh' } })
    expect(stateListener).not.toHaveBeenCalled()
    expect(effectListener).toHaveBeenCalledWith({ type: 'delegation.refresh' })
    model.dispatch({ type: 'jobs.changed', snapshot: jobsSnapshot([job('a')]) })
    expect(stateListener).toHaveBeenCalled()
    stopState()
    stopState()
    stopEffect()
    stopEffect()
    model.dispose()
    model.dispose()
    expect(() => model.onChanged(vi.fn())).toThrow('disposed')
    expect(() => model.onEffect(vi.fn())).toThrow('disposed')
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
  instance: ActivityFeatureInstance,
): FeatureHostSnapshot {
  const surfaces = instance.contributions.surfaces ?? []
  const additions: SlotContribution<LayoutRegion>[] = surfaces.map(surface => ({
    slotId: surface.slot,
    featureId: ACTIVITY_FEATURE_ID,
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
    featureId: ACTIVITY_FEATURE_ID,
    definition: resource.value as ResourceDefinition<unknown>,
  }))
  return Object.freeze({
    navigation,
    routes: Object.freeze([
      { id: 'chat', featureId: 'legacy.chat', route: { kind: 'chat' } as const },
      ...(instance.contributions.routes ?? []).map(routeContribution => ({
        id: routeContribution.id,
        featureId: ACTIVITY_FEATURE_ID,
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

describe('Activity Feature factory and surface resources', () => {
  it('declares an on-route session workspace without touching the ports during create', async () => {
    const manager = new ScopeManager()
    const jobs = new FakeJobsPort(jobsSnapshot([job('a')]))
    const delegation = new FakeDelegationPort()
    const instance = await createInstance(manager, jobs, delegation)

    expect(activityFeature.manifest).toMatchObject({
      id: ACTIVITY_FEATURE_ID,
      scope: 'session',
      activation: 'on-route',
      required: false,
      requires: [SESSION_JOBS_CAPABILITY, SESSION_DELEGATION_CAPABILITY],
    })
    expect(activityFeature.declarations?.routes).toEqual([ACTIVITY_ROUTE_ID])
    expect(activityFeature.declarations?.keymaps).toEqual([ACTIVITY_KEYMAP_ID])
    expect(activityFeature.declarations?.resources).toEqual([ACTIVITY_RESOURCE_ID])
    expect(activityFeature.declarations?.surfaces).toEqual([
      { slot: 'workspace.navigator', cardinality: 'multiple' },
    ])
    expect(jobs.reads).not.toHaveBeenCalled()
    expect(delegation.reads).not.toHaveBeenCalled()
    expect(delegation.refreshDelegation).not.toHaveBeenCalled()

    const nodes = (instance.contributions.surfaces ?? [])
      .map(surface => (surface.value as LayoutRegion<ActivityUiNode>).node)
    expect(nodes.map(node => node.kind)).toEqual(['activity.navigator'])
    expect((instance.contributions.surfaces ?? []).map(surface => surface.id)).toEqual([
      ACTIVITY_NAVIGATOR_SURFACE_ID,
    ])
    expect(instance.contributions.routes?.[0]?.value).toEqual({
      kind: 'workspace',
      featureId: ACTIVITY_FEATURE_ID,
      pane: 'navigator',
    })
    expect(instance.contributions.keymaps?.[0]?.value.bindings).toEqual(expect.arrayContaining([
      { key: '[', commandId: ACTIVITY_TAB_PREVIOUS_COMMAND_ID },
      { key: ']', commandId: ACTIVITY_TAB_NEXT_COMMAND_ID },
      { key: 'K', commandId: ACTIVITY_STOP_COMMAND_ID },
      { key: 'delete', commandId: ACTIVITY_STOP_COMMAND_ID },
      { key: 'r', commandId: ACTIVITY_REFRESH_COMMAND_ID },
      { key: 'R', commandId: ACTIVITY_REFRESH_COMMAND_ID },
      { key: 'q', commandId: ACTIVITY_DISMISS_COMMAND_ID },
      { key: 'escape', commandId: ACTIVITY_DISMISS_COMMAND_ID },
    ]))
    expect(instance.contributions.keymaps?.[0]?.value.bindings.map(binding => binding.key))
      .not.toContain('h')
    expect(instance.contributions.keymaps?.[0]?.value.bindings.map(binding => binding.key))
      .not.toContain('l')
    await instance.dispose()
    await manager.dispose()
  })

  it('loads snapshots on open, bridges push changes, and closes on teardown', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('activity-resources')
    const jobs = new FakeJobsPort(jobsSnapshot([job('live')]))
    const delegation = new FakeDelegationPort(delegationSnapshot({
      subagents: [subagent('kept')],
    }))
    const instance = await createInstance(manager, jobs, delegation)
    const definition = (instance.contributions.resources ?? [])
      .find(resource => resource.id === ACTIVITY_RESOURCE_ID)
      ?.value as ResourceDefinition<ActivityFeedSnapshot>

    expect(instance.model.snapshot().center.open).toBe(false)
    const surface = sessionScope.child('surface', 'activity-open')
    const feed = await definition.load({
      scope: surface,
      signal: surface.signal,
      requestId: 1,
      previous: undefined,
    })
    expect(feed?.jobs.jobs[0]?.id).toBe('live')
    expect(instance.model.snapshot().center.open).toBe(true)
    expect(delegation.refreshDelegation).not.toHaveBeenCalled()

    const abort = new AbortController()
    const invalidated = vi.fn()
    const stop = definition.watch?.({
      scope: surface,
      signal: abort.signal,
      invalidate: invalidated,
    })
    expect(jobs.listenerCount()).toBe(1)
    expect(delegation.listenerCount()).toBe(1)

    jobs.set(jobsSnapshot([job('live'), job('newer')]))
    jobs.emit()
    expect(projectActivityCenter(instance.model.snapshot())?.rows[0]?.title).toBe('Run newer')
    delegation.set(delegationSnapshot({ subagents: [subagent('kept'), subagent('fresh')] }))
    delegation.emit()
    expect(instance.model.snapshot().delegation.subagents).toHaveLength(2)
    expect(invalidated).not.toHaveBeenCalled()

    stop?.()
    expect(jobs.listenerCount()).toBe(0)
    expect(delegation.listenerCount()).toBe(0)
    expect(instance.model.snapshot().center.open).toBe(false)

    await instance.dispose()
    await manager.dispose()
  })

  it('prewarms an empty subagent catalog and reports load failures', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('activity-prewarm')
    const jobs = new FakeJobsPort()
    const delegation = new FakeDelegationPort(delegationSnapshot({
      subagentsAvailable: true,
      subagents: [],
    }))
    const instance = await createInstance(manager, jobs, delegation)
    const definition = (instance.contributions.resources ?? [])
      .find(resource => resource.id === ACTIVITY_RESOURCE_ID)
      ?.value as ResourceDefinition<unknown>

    const surface = sessionScope.child('surface', 'activity-prewarm-open')
    await definition.load({
      scope: surface,
      signal: surface.signal,
      requestId: 1,
      previous: undefined,
    })
    await vi.waitFor(() => expect(delegation.refreshDelegation).toHaveBeenCalledOnce())
    expect(instance.model.snapshot().refresh).toBe('idle')

    const failingJobs = new FakeJobsPort()
    failingJobs.reads.mockImplementation(() => { throw new Error('registry gone') })
    const failingInstance = await createInstance(manager, failingJobs, delegation)
    const failingDefinition = (failingInstance.contributions.resources ?? [])
      .find(resource => resource.id === ACTIVITY_RESOURCE_ID)
      ?.value as ResourceDefinition<unknown>
    const failedSurface = sessionScope.child('surface', 'activity-feed-error')
    expect(() => failingDefinition.load({
      scope: failedSurface,
      signal: failedSurface.signal,
      requestId: 2,
      previous: undefined,
    })).toThrow('registry gone')
    expect(failingInstance.model.snapshot().feedError).toBe('registry gone')

    await instance.dispose()
    await failingInstance.dispose()
    await manager.dispose()
  })

  it('settles a confirmed job stop through the effect runner with the legacy wording', async () => {
    const manager = new ScopeManager()
    const jobs = new FakeJobsPort(jobsSnapshot([job('job-1')]))
    const delegation = new FakeDelegationPort()
    const instance = await createInstance(manager, jobs, delegation)
    seed(instance, jobsSnapshot([job('job-1')]), delegationSnapshot())

    instance.model.dispatch({ type: 'center.action', action: { type: 'request-stop' } })
    instance.model.dispatch({ type: 'center.action', action: { type: 'enter' } })
    expect(jobs.runJobAction).toHaveBeenCalledWith({
      kind: 'kill',
      ref: { id: 'job-1', startedAt: 42, generation: 3 },
    })
    expect(instance.model.snapshot().center.notice).toBe('Stop requested for job-1')

    jobs.runJobAction.mockReturnValue({ accepted: true, outcome: 'already-finished' })
    instance.model.dispatch({ type: 'center.action', action: { type: 'request-stop' } })
    instance.model.dispatch({ type: 'center.action', action: { type: 'enter' } })
    expect(instance.model.snapshot().center.notice).toBe('Job job-1 already finished')

    jobs.runJobAction.mockReturnValue({
      accepted: false,
      code: 'job-ref-mismatch',
      message: 'stale generation',
    })
    instance.model.dispatch({ type: 'center.action', action: { type: 'request-stop' } })
    instance.model.dispatch({ type: 'center.action', action: { type: 'enter' } })
    expect(instance.model.snapshot().center.error)
      .toBe('job-ref-mismatch: stale generation')

    jobs.runJobAction.mockImplementation(() => { throw new Error('registry offline') })
    instance.model.dispatch({ type: 'center.action', action: { type: 'request-stop' } })
    instance.model.dispatch({ type: 'center.action', action: { type: 'enter' } })
    expect(instance.model.snapshot().center.error).toBe('job-action-failed: registry offline')

    await instance.dispose()
    await manager.dispose()
  })

  it('settles a subagent interrupt with the already-idle wording', async () => {
    const manager = new ScopeManager()
    const jobs = new FakeJobsPort()
    const delegation = new FakeDelegationPort(delegationSnapshot({
      subagents: [subagent('sub-1')],
    }))
    const instance = await createInstance(manager, jobs, delegation)
    seed(instance, jobsSnapshot([]), delegationSnapshot({ subagents: [subagent('sub-1')] }))
    instance.model.dispatch({ type: 'center.action', action: { type: 'tab-next' } })
    instance.model.dispatch({ type: 'center.action', action: { type: 'request-stop' } })
    instance.model.dispatch({ type: 'center.action', action: { type: 'enter' } })
    expect(delegation.runDelegationAction).toHaveBeenCalledWith({
      kind: 'interrupt-subagent',
      ref: { id: 'sub-1', parentId: 'root', generation: 5 },
    })
    expect(instance.model.snapshot().center.notice).toBe('Interrupt requested for sub-1')

    delegation.runDelegationAction.mockReturnValue({ accepted: true, outcome: 'already-idle' })
    instance.model.dispatch({ type: 'center.action', action: { type: 'request-stop' } })
    instance.model.dispatch({ type: 'center.action', action: { type: 'enter' } })
    expect(instance.model.snapshot().center.notice).toBe('Subagent sub-1 is already idle')

    delegation.runDelegationAction.mockImplementation(() => { throw new Error('gone') })
    instance.model.dispatch({ type: 'center.action', action: { type: 'request-stop' } })
    instance.model.dispatch({ type: 'center.action', action: { type: 'enter' } })
    expect(instance.model.snapshot().center.error).toBe('subagent-action-failed: gone')

    await instance.dispose()
    await manager.dispose()
  })

  it('single-flights delegation refreshes and aborts the pending one on dispose', async () => {
    const manager = new ScopeManager()
    const pending = deferred<void>()
    let refreshSignal: AbortSignal | undefined
    const jobs = new FakeJobsPort(jobsSnapshot([job('a')]))
    const delegation = new FakeDelegationPort(delegationSnapshot({
      subagents: [subagent('kept')],
    }))
    delegation.refreshDelegation.mockImplementation(async (signal) => {
      refreshSignal = signal
      await pending.promise
    })
    const instance = await createInstance(manager, jobs, delegation)
    seed(instance, jobsSnapshot([job('a')]), delegationSnapshot({ subagents: [subagent('kept')] }))

    instance.model.dispatch({ type: 'center.action', action: { type: 'refresh' } })
    await vi.waitFor(() => expect(delegation.refreshDelegation).toHaveBeenCalledOnce())
    expect(instance.model.snapshot().refresh).toBe('refreshing')

    instance.model.dispatch({ type: 'center.action', action: { type: 'refresh' } })
    expect(delegation.refreshDelegation).toHaveBeenCalledOnce()
    expect(instance.model.snapshot().center.notice)
      .toBe('Subagent catalog refresh is already running.')

    const disposed = instance.dispose()
    expect(refreshSignal?.aborted).toBe(true)
    pending.resolve()
    await disposed
    expect(instance.model.snapshot().refresh).toBe('refreshing')
    await manager.dispose()
  })

  it('recovers a failed refresh and reconciles the fresh delegation snapshot', async () => {
    const manager = new ScopeManager()
    const jobs = new FakeJobsPort(jobsSnapshot([job('a')]))
    const delegation = new FakeDelegationPort(delegationSnapshot({
      subagents: [subagent('kept')],
    }))
    const instance = await createInstance(manager, jobs, delegation)
    seed(instance, jobsSnapshot([job('a')]), delegationSnapshot({ subagents: [subagent('kept')] }))

    delegation.refreshDelegation.mockRejectedValueOnce(new Error('offline'))
    instance.model.dispatch({ type: 'center.action', action: { type: 'refresh' } })
    await vi.waitFor(() => expect(instance.model.snapshot().refresh).toBe('failed'))
    expect(instance.model.snapshot().center.error).toBe('Subagent refresh failed: offline')

    delegation.set(delegationSnapshot({ subagents: [subagent('kept'), subagent('fresh')] }))
    instance.model.dispatch({ type: 'center.action', action: { type: 'refresh' } })
    await vi.waitFor(() => expect(instance.model.snapshot().refresh).toBe('idle'))
    expect(instance.model.snapshot().delegation.subagents).toHaveLength(2)

    await instance.dispose()
    await manager.dispose()
  })

  it('routes generic and semantic commands and leaves for chat once the center closes', async () => {
    const manager = new ScopeManager()
    const jobs = new FakeJobsPort(jobsSnapshot([job('a'), job('b')]))
    const delegation = new FakeDelegationPort(delegationSnapshot({
      subagents: [subagent('kept')],
    }))
    const instance = await createInstance(manager, jobs, delegation)
    seed(instance, jobsSnapshot([job('a'), job('b')]), delegationSnapshot({
      subagents: [subagent('kept')],
    }))
    const handlers = handlersOf(instance)
    const openRoute = vi.fn(async () => {})
    const context = { navigation: workspaceNavigation(), openRoute }

    await handlers.get('navigation.move')?.handle(routed({
      type: 'navigation.move', direction: 'down',
    }), context)
    expect(projectActivityCenter(instance.model.snapshot())?.rows[1]?.selected).toBe(true)
    await handlers.get('navigation.move')?.handle(routed({
      type: 'navigation.move', direction: 'left',
    }), context)
    expect(projectActivityCenter(instance.model.snapshot())?.tab).toBe('workflows')
    await handlers.get(ACTIVITY_TAB_NEXT_COMMAND_ID)?.handle(
      featureCommand(ACTIVITY_TAB_NEXT_COMMAND_ID), context,
    )
    expect(projectActivityCenter(instance.model.snapshot())?.tab).toBe('jobs')
    await handlers.get(ACTIVITY_TAB_PREVIOUS_COMMAND_ID)?.handle(
      featureCommand(ACTIVITY_TAB_PREVIOUS_COMMAND_ID), context,
    )
    expect(projectActivityCenter(instance.model.snapshot())?.tab).toBe('workflows')
    await handlers.get('navigation.move')?.handle(routed({
      type: 'navigation.move', direction: 'right',
    }), context)
    expect(projectActivityCenter(instance.model.snapshot())?.tab).toBe('jobs')

    // Unknown and unmapped commands are ignored.
    await handlers.get('navigation.move')?.handle(routed({
      type: 'edit.insert', text: 'x',
    }), context)
    expect(openRoute).not.toHaveBeenCalled()

    await handlers.get(ACTIVITY_STOP_COMMAND_ID)?.handle(
      featureCommand(ACTIVITY_STOP_COMMAND_ID), context,
    )
    expect(instance.model.snapshot().center.confirmStop).toBe(true)
    await handlers.get('action.submit')?.handle(routed({ type: 'action.submit' }), context)
    expect(jobs.runJobAction).toHaveBeenCalledOnce()
    expect(instance.model.snapshot().center.notice).toBe('Stop requested for a')
    expect(openRoute).not.toHaveBeenCalled()

    await handlers.get(ACTIVITY_REFRESH_COMMAND_ID)?.handle(
      featureCommand(ACTIVITY_REFRESH_COMMAND_ID), context,
    )
    await vi.waitFor(() => expect(delegation.refreshDelegation).toHaveBeenCalledOnce())

    // Escape clears a pending confirmation first; the next escape closes and leaves.
    await handlers.get(ACTIVITY_STOP_COMMAND_ID)?.handle(
      featureCommand(ACTIVITY_STOP_COMMAND_ID), context,
    )
    expect(instance.model.snapshot().center.confirmStop).toBe(true)
    await handlers.get('navigation.back')?.handle(
      featureCommand('navigation.back'), context,
    )
    expect(instance.model.snapshot().center.confirmStop).toBe(false)
    expect(openRoute).not.toHaveBeenCalled()
    await handlers.get('navigation.back')?.handle(
      featureCommand('navigation.back'), context,
    )
    expect(openRoute).toHaveBeenCalledWith('chat')

    await instance.dispose()
    await instance.dispose()
    await manager.dispose()
  })

  it('loads only when its route opens and closes the center when the route leaves', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('activity-route')
    const jobs = new FakeJobsPort(jobsSnapshot([job('live')]))
    const delegation = new FakeDelegationPort(delegationSnapshot({
      subagents: [subagent('kept')],
    }))
    const instance = await createInstance(manager, jobs, delegation)
    const host = new MutableHost(hostSnapshot({ kind: 'chat' }, instance))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(sessionScope, { columns: 120, rows: 30 })
    await lease.ready
    expect(jobs.reads).not.toHaveBeenCalled()
    expect(instance.model.snapshot().center.open).toBe(false)

    host.set(hostSnapshot({
      kind: 'workspace',
      featureId: ACTIVITY_FEATURE_ID,
      pane: 'navigator',
    }, instance))
    await lease.settled()
    await vi.waitFor(() => expect(instance.model.snapshot().center.open).toBe(true))
    expect(jobs.listenerCount()).toBe(1)
    expect(delegation.listenerCount()).toBe(1)

    jobs.set(jobsSnapshot([job('live'), job('newer')]))
    jobs.emit()
    expect(projectActivityCenter(instance.model.snapshot())?.rows[0]?.title).toBe('Run newer')

    host.set(hostSnapshot({ kind: 'chat' }, instance))
    await lease.settled()
    await vi.waitFor(() => expect(instance.model.snapshot().center.open).toBe(false))
    expect(jobs.listenerCount()).toBe(0)
    expect(delegation.listenerCount()).toBe(0)

    await runtime.dispose()
    await instance.dispose()
    await manager.dispose()
  })

  it('releases the snapshot watcher after its Feature model was already disposed', async () => {
    const manager = new ScopeManager()
    const sessionScope = manager.createSession('activity-first-disposal')
    const jobs = new FakeJobsPort(jobsSnapshot([job('live')]))
    const delegation = new FakeDelegationPort()
    const instance = await createInstance(manager, jobs, delegation)
    const host = new MutableHost(hostSnapshot({
      kind: 'workspace',
      featureId: ACTIVITY_FEATURE_ID,
      pane: 'navigator',
    }, instance))
    const runtime = new FeatureSurfaceRuntime(host)
    const lease = runtime.bindSession(sessionScope, { columns: 120, rows: 30 })
    await lease.ready
    await vi.waitFor(() => expect(lease.snapshot().surfaces.length).toBeGreaterThan(0))

    await instance.dispose()
    await expect(runtime.dispose()).resolves.toBeUndefined()
    await manager.dispose()
  })
})
