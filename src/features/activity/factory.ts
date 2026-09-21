import type {
  FeatureCommandContext,
  FeatureCommandHandler,
  FeatureKeymap,
} from '../../app/feature-contribution-contract.ts'
import {
  FEATURE_API_VERSION,
  type FeatureContributions,
  type FeatureCreateContext,
  type FeatureFactory,
  type FeatureInstance,
  type ResolveRequirements,
} from '../../kernel/feature.ts'
import type { LayoutRegion } from '../../layout/strategy.ts'
import type { RoutedUiCommand } from '../../navigation/commands.ts'
import type { NavigationRoute } from '../../navigation/state.ts'
import type {
  ResourceDefinition,
  ResourceLoadContext,
  ResourceWatchContext,
} from '../../resource/resource-coordinator.ts'
import {
  SESSION_DELEGATION_CAPABILITY,
  SESSION_JOBS_CAPABILITY,
} from '../../runtime/session-capabilities.ts'
import type { SessionDelegationPort } from '../../activity/delegation-port.ts'
import type { SessionJobsPort } from '../../activity/port.ts'
import type { ActivityCenterAction } from '../../activity/center.ts'
import {
  ACTIVITY_RESOURCE_ID,
  type ActivityFeatureEffect,
  type ActivityFeatureEvent,
} from './machine.ts'
import {
  createActivityFeatureModel,
  type ActivityFeatureModel,
  type ActivityFeatureStateSource,
  type ActivityStateListener,
} from './model.ts'
import {
  createActivityInspectorNode,
  createActivityNavigatorNode,
  type ActivityUiNode,
} from './nodes.ts'
import {
  detachDelegationSnapshot,
  detachJobsSnapshot,
} from './projectors.ts'

export const ACTIVITY_FEATURE_ID = 'activity'
export const ACTIVITY_ROUTE_ID = 'activity'
export const ACTIVITY_KEYMAP_ID = 'activity.normal'
export const ACTIVITY_NAVIGATOR_SURFACE_ID = 'activity.navigator'
export const ACTIVITY_INSPECTOR_SURFACE_ID = 'activity.inspector'
export const ACTIVITY_TAB_NEXT_COMMAND_ID = 'activity.tab.next'
export const ACTIVITY_TAB_PREVIOUS_COMMAND_ID = 'activity.tab.previous'
export const ACTIVITY_STOP_COMMAND_ID = 'activity.stop'
export const ACTIVITY_REFRESH_COMMAND_ID = 'activity.refresh'

const ACTIVITY_REQUIREMENTS = Object.freeze([
  SESSION_JOBS_CAPABILITY,
  SESSION_DELEGATION_CAPABILITY,
] as const)

const ACTIVITY_COMMAND_IDS = Object.freeze([
  'navigation.move',
  'navigation.activate',
  'navigation.back',
  'action.submit',
  ACTIVITY_TAB_NEXT_COMMAND_ID,
  ACTIVITY_TAB_PREVIOUS_COMMAND_ID,
  ACTIVITY_STOP_COMMAND_ID,
  ACTIVITY_REFRESH_COMMAND_ID,
] as const)

const ACTIVITY_KEYMAP: FeatureKeymap = Object.freeze({
  context: Object.freeze({
    routeKind: 'workspace' as const,
    featureId: ACTIVITY_FEATURE_ID,
    mode: 'normal' as const,
  }),
  bindings: Object.freeze([
    Object.freeze({ key: 'h', commandId: ACTIVITY_TAB_PREVIOUS_COMMAND_ID }),
    Object.freeze({ key: 'l', commandId: ACTIVITY_TAB_NEXT_COMMAND_ID }),
    Object.freeze({ key: '[', commandId: ACTIVITY_TAB_PREVIOUS_COMMAND_ID }),
    Object.freeze({ key: ']', commandId: ACTIVITY_TAB_NEXT_COMMAND_ID }),
    Object.freeze({ key: 'K', commandId: ACTIVITY_STOP_COMMAND_ID }),
    Object.freeze({ key: 'delete', commandId: ACTIVITY_STOP_COMMAND_ID }),
    Object.freeze({ key: 'r', commandId: ACTIVITY_REFRESH_COMMAND_ID }),
    Object.freeze({ key: 'R', commandId: ACTIVITY_REFRESH_COMMAND_ID }),
  ]),
})

export interface ActivityFeedSnapshot {
  readonly jobs: ReturnType<typeof detachJobsSnapshot>
  readonly delegation: ReturnType<typeof detachDelegationSnapshot>
}

export type ActivityFeatureContributions = FeatureContributions<
  NavigationRoute,
  FeatureCommandHandler,
  FeatureKeymap,
  ResourceDefinition<ActivityFeedSnapshot>,
  LayoutRegion<ActivityUiNode>
>

export interface ActivityFeatureInstance extends FeatureInstance<ActivityFeatureContributions> {
  readonly model: ActivityFeatureModel
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function centerAction(action: ActivityCenterAction): ActivityFeatureEvent {
  return { type: 'center.action', action }
}

function eventForCommand(
  commandId: string,
  command: RoutedUiCommand,
): ActivityFeatureEvent | undefined {
  switch (commandId) {
    case ACTIVITY_TAB_NEXT_COMMAND_ID: return centerAction({ type: 'tab-next' })
    case ACTIVITY_TAB_PREVIOUS_COMMAND_ID: return centerAction({ type: 'tab-previous' })
    case ACTIVITY_STOP_COMMAND_ID: return centerAction({ type: 'request-stop' })
    case ACTIVITY_REFRESH_COMMAND_ID: return centerAction({ type: 'refresh' })
    case 'navigation.back': return centerAction({ type: 'escape' })
    default: break
  }
  switch (command.command.type) {
    case 'navigation.move':
      switch (command.command.direction) {
        case 'up': return centerAction({ type: 'move-up' })
        case 'down': return centerAction({ type: 'move-down' })
        case 'left': return centerAction({ type: 'tab-previous' })
        case 'right': return centerAction({ type: 'tab-next' })
      }
      return undefined
    case 'navigation.activate':
    case 'action.submit':
      return centerAction({ type: 'enter' })
    default:
      return undefined
  }
}

interface ActivityEffectRunner {
  dispose(): Promise<void>
}

function createEffectRunner(
  model: ActivityFeatureModel,
  jobsPort: SessionJobsPort,
  delegationPort: SessionDelegationPort,
  scopeSignal: AbortSignal,
): ActivityEffectRunner {
  let disposed = false
  let refreshAbort: AbortController | undefined
  let refreshTask: Promise<void> | undefined
  const tasks = new Set<Promise<void>>()

  const dispatch = (event: ActivityFeatureEvent): void => {
    if (disposed) return
    try {
      model.dispatch(event)
    } catch {
      // The Feature model may already be disposed by an earlier teardown winner.
    }
  }

  const runJobAction = (effect: Extract<ActivityFeatureEffect, { type: 'job.action' }>): void => {
    let receipt: ReturnType<SessionJobsPort['runJobAction']>
    try {
      receipt = jobsPort.runJobAction(effect.action)
    } catch (error: unknown) {
      receipt = { accepted: false, code: 'job-action-failed', message: messageOf(error) }
    }
    if (receipt.accepted) {
      dispatch({
        type: 'stop.resolved',
        message: receipt.outcome === 'already-finished'
          ? `Job ${effect.action.ref.id} already finished`
          : effect.successMessage,
      })
    } else {
      dispatch({ type: 'stop.rejected', message: `${receipt.code}: ${receipt.message}` })
    }
  }

  const runDelegationAction = (
    effect: Extract<ActivityFeatureEffect, { type: 'delegation.action' }>,
  ): void => {
    let receipt: ReturnType<SessionDelegationPort['runDelegationAction']>
    try {
      receipt = delegationPort.runDelegationAction(effect.action)
    } catch (error: unknown) {
      receipt = { accepted: false, code: 'subagent-action-failed', message: messageOf(error) }
    }
    if (receipt.accepted) {
      dispatch({
        type: 'stop.resolved',
        message: receipt.outcome === 'already-idle'
          ? `Subagent ${effect.action.ref.id} is already idle`
          : effect.successMessage,
      })
    } else {
      dispatch({ type: 'stop.rejected', message: `${receipt.code}: ${receipt.message}` })
    }
  }

  const cancelRefresh = (): void => {
    refreshAbort?.abort(new Error('Activity delegation refresh cancelled'))
    refreshAbort = undefined
  }

  const startRefresh = (): void => {
    if (refreshTask !== undefined) {
      dispatch({ type: 'refresh.duplicated' })
      return
    }
    const abort = new AbortController()
    const signal = AbortSignal.any([scopeSignal, abort.signal])
    refreshAbort = abort
    dispatch({ type: 'refresh.started' })
    const task = Promise.resolve().then(async () => {
      try {
        await delegationPort.refreshDelegation(signal)
        if (disposed || signal.aborted) return
        dispatch({
          type: 'delegation.changed',
          snapshot: delegationPort.delegationSnapshot(),
        })
        dispatch({ type: 'refresh.succeeded' })
      } catch (error: unknown) {
        if (disposed || signal.aborted) return
        dispatch({ type: 'refresh.failed', message: messageOf(error) })
      } finally {
        if (refreshTask === task) {
          refreshTask = undefined
          refreshAbort = undefined
        }
        tasks.delete(task)
      }
    })
    refreshTask = task
    tasks.add(task)
  }

  const stopEffects = model.onEffect((effect) => {
    switch (effect.type) {
      case 'job.action':
        runJobAction(effect)
        break
      case 'delegation.action':
        runDelegationAction(effect)
        break
      case 'delegation.refresh':
        startRefresh()
        break
      case 'delegation.refresh-cancel':
        cancelRefresh()
        break
    }
  })

  return Object.freeze({
    dispose: async () => {
      if (disposed) return
      disposed = true
      stopEffects()
      cancelRefresh()
      await Promise.allSettled([...tasks])
    },
  })
}

function snapshotsResource(
  jobsPort: SessionJobsPort,
  delegationPort: SessionDelegationPort,
  model: ActivityFeatureModel,
  isFeatureActive: () => boolean,
): ResourceDefinition<ActivityFeedSnapshot> {
  return Object.freeze({
    key: ACTIVITY_RESOURCE_ID,
    lifetime: 'surface',
    activation: 'on-open',
    cachePolicy: 'last-good',
    load: (context: ResourceLoadContext<ActivityFeedSnapshot>) => {
      try {
        context.signal.throwIfAborted()
        const jobs = detachJobsSnapshot(jobsPort.jobsSnapshot())
        const delegation = detachDelegationSnapshot(delegationPort.delegationSnapshot())
        context.signal.throwIfAborted()
        model.dispatch({ type: 'jobs.changed', snapshot: jobs })
        model.dispatch({ type: 'delegation.changed', snapshot: delegation })
        model.dispatch({ type: 'surface.opened' })
        return Object.freeze({ jobs, delegation })
      } catch (error: unknown) {
        if (!context.signal.aborted) {
          model.dispatch({ type: 'feed.failed', message: messageOf(error) })
        }
        throw error
      }
    },
    watch: (context: ResourceWatchContext) => {
      const stopJobs = jobsPort.onJobsChanged(() => {
        if (context.signal.aborted || !isFeatureActive()) return
        model.dispatch({
          type: 'jobs.changed',
          snapshot: jobsPort.jobsSnapshot(),
        })
      })
      const stopDelegation = delegationPort.onDelegationChanged(() => {
        if (context.signal.aborted || !isFeatureActive()) return
        model.dispatch({
          type: 'delegation.changed',
          snapshot: delegationPort.delegationSnapshot(),
        })
      })
      return () => {
        stopJobs()
        stopDelegation()
        if (isFeatureActive()) model.dispatch({ type: 'surface.closed' })
      }
    },
  })
}

function commandHandler(
  commandId: string,
  model: ActivityFeatureModel,
): FeatureCommandHandler {
  return Object.freeze({
    handle: async (command: RoutedUiCommand, context: FeatureCommandContext) => {
      const event = eventForCommand(commandId, command)
      if (event === undefined) return
      model.dispatch(event)
      if (!model.snapshot().center.open) await context.openRoute('chat')
    },
  })
}

function stateSourceOf(model: ActivityFeatureModel): ActivityFeatureStateSource {
  return Object.freeze({
    snapshot: () => model.snapshot(),
    onChanged: (listener: ActivityStateListener) => model.onChanged(listener),
  })
}

export const activityFeature: FeatureFactory<
  typeof ACTIVITY_REQUIREMENTS,
  ActivityFeatureContributions
> = Object.freeze({
  manifest: Object.freeze({
    id: ACTIVITY_FEATURE_ID,
    apiVersion: FEATURE_API_VERSION,
    scope: 'session',
    activation: 'on-route',
    required: false,
    requires: ACTIVITY_REQUIREMENTS,
  }),
  declarations: Object.freeze({
    routes: Object.freeze([ACTIVITY_ROUTE_ID]),
    commands: ACTIVITY_COMMAND_IDS,
    keymaps: Object.freeze([ACTIVITY_KEYMAP_ID]),
    resources: Object.freeze([ACTIVITY_RESOURCE_ID]),
    surfaces: Object.freeze([
      Object.freeze({ slot: 'workspace.navigator', cardinality: 'multiple' as const }),
      Object.freeze({ slot: 'workspace.inspector', cardinality: 'multiple' as const }),
    ]),
  }),
  create: ({ scope, dependencies }: FeatureCreateContext<
    ResolveRequirements<typeof ACTIVITY_REQUIREMENTS>
  >) => {
    const jobsPort = dependencies[0].value
    const delegationPort = dependencies[1].value
    const model = createActivityFeatureModel()
    let disposed = false
    const effectRunner = createEffectRunner(
      model,
      jobsPort,
      delegationPort,
      scope.signal,
    )
    const state = stateSourceOf(model)
    const navigator = Object.freeze({
      id: ACTIVITY_NAVIGATOR_SURFACE_ID,
      role: 'navigator' as const,
      node: createActivityNavigatorNode(state),
      constraints: Object.freeze({ minColumns: 26, preferredColumns: 50, priority: 3 }),
    })
    const inspector = Object.freeze({
      id: ACTIVITY_INSPECTOR_SURFACE_ID,
      role: 'inspector' as const,
      node: createActivityInspectorNode(state),
      constraints: Object.freeze({ minColumns: 32, preferredColumns: 64, priority: 2 }),
    })
    const contributions: ActivityFeatureContributions = Object.freeze({
      routes: Object.freeze([Object.freeze({
        id: ACTIVITY_ROUTE_ID,
        value: Object.freeze({
          kind: 'workspace' as const,
          featureId: ACTIVITY_FEATURE_ID,
          pane: 'navigator' as const,
        }),
      })]),
      commands: Object.freeze(ACTIVITY_COMMAND_IDS.map(id => Object.freeze({
        id,
        value: commandHandler(id, model),
      }))),
      keymaps: Object.freeze([
        Object.freeze({ id: ACTIVITY_KEYMAP_ID, value: ACTIVITY_KEYMAP }),
      ]),
      resources: Object.freeze([Object.freeze({
        id: ACTIVITY_RESOURCE_ID,
        value: snapshotsResource(
          jobsPort,
          delegationPort,
          model,
          () => !disposed,
        ),
      })]),
      surfaces: Object.freeze([
        Object.freeze({ id: navigator.id, slot: 'workspace.navigator', value: navigator }),
        Object.freeze({ id: inspector.id, slot: 'workspace.inspector', value: inspector }),
      ]),
    })
    return Object.freeze({
      contributions,
      model,
      dispose: async () => {
        if (disposed) return
        disposed = true
        await effectRunner.dispose()
        model.dispose()
      },
    } satisfies ActivityFeatureInstance)
  },
})
