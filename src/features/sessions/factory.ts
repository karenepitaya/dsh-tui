import type {
  FeatureCommandContext,
  FeatureCommandHandler,
  FeatureKeymap,
} from '../../app/feature-contribution-contract.ts'
import {
  FEATURE_API_VERSION,
  type FeatureCreateContext,
  type FeatureContributions,
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
import type { SessionCatalogSnapshot } from '../../session/catalog-port.ts'
import {
  SESSION_NAVIGATION_CAPABILITY,
  type SessionNavigationCancellation,
  type SessionNavigationPort,
  type SessionNavigationRequest,
} from '../../session/navigation-port.ts'
import {
  SESSIONS_CATALOG_RESOURCE_ID,
  SESSIONS_INSPECTION_RESOURCE_ID,
  type SessionsFeatureEffect,
  type SessionsFeatureEvent,
  type SessionsRequestStamp,
} from './machine.ts'
import {
  createSessionsFeatureModel,
  type SessionsFeatureModel,
  type SessionsFeatureStateSource,
  type SessionsStateListener,
} from './model.ts'
import {
  createSessionsNavigatorNode,
  type SessionsUiNode,
} from './nodes.ts'
import {
  detachSessionsCatalogSnapshot,
  projectSessionsInspection,
  type SessionsInspectionProjection,
} from './projectors.ts'
import {
  SESSIONS_WORKSPACE_CAPABILITY,
  type SessionsWorkspacePort,
} from './port.ts'

export const SESSIONS_FEATURE_ID = 'sessions'
export const SESSIONS_ROUTE_ID = 'sessions'
export const SESSIONS_KEYMAP_ID = 'sessions.normal'
export const SESSIONS_MOVE_UP_COMMAND_ID = 'sessions.selection.previous'
export const SESSIONS_MOVE_DOWN_COMMAND_ID = 'sessions.selection.next'
export const SESSIONS_ACTIVATE_COMMAND_ID = 'sessions.selection.activate'
export const SESSIONS_REFRESH_COMMAND_ID = 'sessions.refresh'
export const SESSIONS_RESUME_COMMAND_ID = 'sessions.resume'
export const SESSIONS_FORK_COMMAND_ID = 'sessions.fork'
export const SESSIONS_BACK_COMMAND_ID = 'sessions.back'

export const SESSIONS_NAVIGATOR_REGION_ID = 'sessions.navigator'

const SESSIONS_REQUIREMENTS = Object.freeze([
  SESSIONS_WORKSPACE_CAPABILITY,
  SESSION_NAVIGATION_CAPABILITY,
] as const)

const SESSIONS_COMMAND_IDS = Object.freeze([
  'navigation.move',
  'navigation.page',
  'navigation.activate',
  'edit.insert',
  'edit.delete-backward',
  'action.submit',
  'navigation.back',
  SESSIONS_MOVE_UP_COMMAND_ID,
  SESSIONS_MOVE_DOWN_COMMAND_ID,
  SESSIONS_ACTIVATE_COMMAND_ID,
  SESSIONS_REFRESH_COMMAND_ID,
  SESSIONS_RESUME_COMMAND_ID,
  SESSIONS_FORK_COMMAND_ID,
  SESSIONS_BACK_COMMAND_ID,
] as const)

const SESSIONS_KEYMAP: FeatureKeymap = Object.freeze({
  context: Object.freeze({
    routeKind: 'workspace' as const,
    featureId: SESSIONS_FEATURE_ID,
    mode: 'normal' as const,
  }),
  bindings: Object.freeze([
    Object.freeze({ key: 'k', commandId: SESSIONS_MOVE_UP_COMMAND_ID }),
    Object.freeze({ key: 'j', commandId: SESSIONS_MOVE_DOWN_COMMAND_ID }),
    Object.freeze({ key: 'enter', commandId: SESSIONS_ACTIVATE_COMMAND_ID }),
    Object.freeze({ key: 'r', commandId: SESSIONS_REFRESH_COMMAND_ID }),
    Object.freeze({ key: 'a', commandId: SESSIONS_RESUME_COMMAND_ID }),
    Object.freeze({ key: 'f', commandId: SESSIONS_FORK_COMMAND_ID }),
    Object.freeze({ key: 'q', commandId: SESSIONS_BACK_COMMAND_ID }),
    Object.freeze({ key: 'escape', commandId: SESSIONS_BACK_COMMAND_ID }),
  ]),
})

export type SessionsFeatureContributions = FeatureContributions<
  NavigationRoute,
  FeatureCommandHandler,
  FeatureKeymap,
  unknown,
  LayoutRegion<SessionsUiNode>
>

export interface SessionsFeatureInstance
  extends FeatureInstance<SessionsFeatureContributions> {
  readonly model: SessionsFeatureModel
}

function stampOf(context: ResourceLoadContext<unknown>): SessionsRequestStamp {
  return Object.freeze({
    scopeEpoch: context.scope.epoch,
    requestId: context.requestId,
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function watchRefresh(
  model: SessionsFeatureModel,
  resourceId: typeof SESSIONS_CATALOG_RESOURCE_ID | typeof SESSIONS_INSPECTION_RESOURCE_ID,
  context: ResourceWatchContext,
): () => void {
  return model.onEffect((effect) => {
    if (effect.type === 'resource.refresh'
      && effect.resourceId === resourceId
      && !context.signal.aborted) {
      context.invalidate()
    }
  })
}

function catalogResource(
  workspace: SessionsWorkspacePort,
  navigation: SessionNavigationPort,
  model: SessionsFeatureModel,
): ResourceDefinition<SessionCatalogSnapshot> {
  return Object.freeze({
    key: SESSIONS_CATALOG_RESOURCE_ID,
    lifetime: 'surface',
    activation: 'on-open',
    cachePolicy: 'last-good',
    load: async (context: ResourceLoadContext<SessionCatalogSnapshot>) => {
      model.dispatch({ type: 'navigation.changed', snapshot: navigation.snapshot() })
      const request = stampOf(context)
      model.dispatch({ type: 'catalog.load-started', request })
      try {
        const snapshot = await workspace.catalog.listSessions({ signal: context.signal })
        context.signal.throwIfAborted()
        const detached = detachSessionsCatalogSnapshot(snapshot)
        model.dispatch({ type: 'catalog.loaded', request, snapshot: detached })
        return detached
      } catch (error: unknown) {
        if (!context.signal.aborted) {
          model.dispatch({
            type: 'catalog.failed',
            request,
            message: messageOf(error),
          })
        }
        throw error
      }
    },
    watch: (context: ResourceWatchContext) => (
      watchRefresh(model, SESSIONS_CATALOG_RESOURCE_ID, context)
    ),
  })
}

function inspectionResource(
  workspace: SessionsWorkspacePort,
  navigation: SessionNavigationPort,
  model: SessionsFeatureModel,
  isFeatureActive: () => boolean,
): ResourceDefinition<SessionsInspectionProjection | undefined> {
  return Object.freeze({
    key: SESSIONS_INSPECTION_RESOURCE_ID,
    lifetime: 'surface',
    activation: 'on-open',
    cachePolicy: 'last-good',
    load: async (
      context: ResourceLoadContext<SessionsInspectionProjection | undefined>,
    ) => {
      model.dispatch({ type: 'navigation.changed', snapshot: navigation.snapshot() })
      const inspection = model.snapshot().inspection
      const sessionId = inspection.phase === 'loading'
        && inspection.request === undefined
        ? inspection.sessionId
        : undefined
      if (sessionId === undefined) return undefined
      const request = stampOf(context)
      model.dispatch({ type: 'inspection.load-started', sessionId, request })
      try {
        const snapshot = await workspace.inspection.inspectSession({
          sessionId,
          signal: context.signal,
        })
        context.signal.throwIfAborted()
        const projection = await projectSessionsInspection(snapshot, context.signal)
        context.signal.throwIfAborted()
        model.dispatch({
          type: 'inspection.loaded',
          sessionId,
          request,
          projection,
        })
        return projection
      } catch (error: unknown) {
        if (!context.signal.aborted) {
          model.dispatch({
            type: 'inspection.failed',
            sessionId,
            request,
            message: messageOf(error),
          })
        }
        throw error
      }
    },
    watch: (context: ResourceWatchContext) => {
      const stopRefresh = watchRefresh(model, SESSIONS_INSPECTION_RESOURCE_ID, context)
      return () => {
        stopRefresh()
        if (isFeatureActive()) model.dispatch({ type: 'inspection.closed' })
      }
    },
  })
}

function dropLastCodePoint(value: string): string {
  const points = [...value]
  points.pop()
  return points.join('')
}

function eventForCommand(
  model: SessionsFeatureModel,
  commandId: string,
  command: RoutedUiCommand,
  nextRequestId: () => number,
): SessionsFeatureEvent | undefined {
  const detailsOpen = model.snapshot().details !== undefined
  if (commandId === SESSIONS_MOVE_UP_COMMAND_ID) {
    return detailsOpen
      ? { type: 'details.move', direction: 'up' }
      : { type: 'selection.move', direction: 'up' }
  }
  if (commandId === SESSIONS_MOVE_DOWN_COMMAND_ID) {
    return detailsOpen
      ? { type: 'details.move', direction: 'down' }
      : { type: 'selection.move', direction: 'down' }
  }
  if (commandId === SESSIONS_REFRESH_COMMAND_ID) {
    return detailsOpen
      ? { type: 'inspection.refresh-requested' }
      : { type: 'catalog.refresh-requested' }
  }
  if (commandId === SESSIONS_RESUME_COMMAND_ID) return { type: 'resume.requested' }
  if (commandId === SESSIONS_FORK_COMMAND_ID) return { type: 'fork.requested' }
  if (commandId === SESSIONS_BACK_COMMAND_ID || commandId === 'navigation.back') {
    return { type: 'back.requested' }
  }
  if (commandId === SESSIONS_ACTIVATE_COMMAND_ID) {
    const operation = model.snapshot().operation
    if (operation.phase === 'confirm-resume' || operation.phase === 'confirm-fork') {
      return { type: 'confirmation.accepted', requestId: nextRequestId() }
    }
    if (detailsOpen) return { type: 'details.closed' }
    return { type: 'selection.activated', requestId: nextRequestId() }
  }
  switch (command.command.type) {
    case 'navigation.move':
      if (detailsOpen) {
        return command.command.direction === 'up' || command.command.direction === 'down'
          ? { type: 'details.move', direction: command.command.direction }
          : undefined
      }
      return command.command.direction === 'up' || command.command.direction === 'down'
        ? { type: 'selection.move', direction: command.command.direction }
        : undefined
    case 'navigation.page':
      return detailsOpen
        ? {
            type: 'details.move',
            direction: command.command.direction,
            amount: 8,
          }
        : {
            type: 'selection.move',
            direction: command.command.direction,
            amount: 8,
          }
    case 'navigation.activate':
    case 'action.submit': {
      const operation = model.snapshot().operation
      if (operation.phase === 'confirm-resume' || operation.phase === 'confirm-fork') {
        return { type: 'confirmation.accepted', requestId: nextRequestId() }
      }
      if (detailsOpen) return { type: 'details.closed' }
      return { type: 'selection.activated', requestId: nextRequestId() }
    }
    case 'edit.insert':
      return {
        type: 'query.changed',
        query: model.snapshot().query + command.command.text,
      }
    case 'edit.delete-backward':
      return {
        type: 'query.changed',
        query: dropLastCodePoint(model.snapshot().query),
      }
    default:
      return undefined
  }
}

type SessionsNavigateEffect = Extract<SessionsFeatureEffect, { type: 'session.navigate' }>

interface SessionsNavigationAttempt {
  readonly requestId: number
  readonly abort: AbortController
  readonly stopAbortListener: () => void
  task: Promise<void>
}

interface SessionsEffectRunner {
  run(effects: readonly SessionsFeatureEffect[], context: FeatureCommandContext): Promise<void>
  dispose(): Promise<void>
}

function navigationRequest(
  effect: SessionsNavigateEffect,
  signal: AbortSignal,
  cancellation: SessionNavigationCancellation,
): SessionNavigationRequest {
  return effect.request.kind === 'fork'
    ? Object.freeze({ kind: 'fork', sessionId: effect.request.sessionId, signal, cancellation })
    : Object.freeze({
        kind: 'activate',
        sessionId: effect.request.sessionId,
        intent: effect.request.intent,
        signal,
        cancellation,
      })
}

function createEffectRunner(
  model: SessionsFeatureModel,
  navigation: SessionNavigationPort,
  scopeSignal: AbortSignal,
): SessionsEffectRunner {
  let active: SessionsNavigationAttempt | undefined
  let disposed = false
  const tasks = new Set<Promise<void>>()

  const schedule = (
    effect: SessionsNavigateEffect,
    context: FeatureCommandContext,
  ): void => {
    const abort = new AbortController()
    const signal = AbortSignal.any([scopeSignal, abort.signal])
    const onAbort = (): void => {
      model.dispatch({ type: 'navigation.cancelled', requestId: effect.requestId })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const attempt: SessionsNavigationAttempt = {
      requestId: effect.requestId,
      abort,
      stopAbortListener: () => { signal.removeEventListener('abort', onAbort) },
      task: Promise.resolve(),
    }
    active = attempt
    attempt.task = Promise.resolve().then(async () => {
      try {
        await navigation.navigate(navigationRequest(effect, signal, Object.freeze({
          cancel: (reason: unknown): void => { abort.abort(reason) },
        })))
        signal.throwIfAborted()
        model.dispatch({ type: 'navigation.changed', snapshot: navigation.snapshot() })
        await context.openRoute('chat')
        signal.throwIfAborted()
        model.dispatch({ type: 'navigation.succeeded', requestId: attempt.requestId })
      } catch (error: unknown) {
        if (disposed || active !== attempt) return
        try {
          model.dispatch({ type: 'navigation.changed', snapshot: navigation.snapshot() })
        } catch {
          // Preserve the operation result if the product host has already detached.
        }
        model.dispatch(signal.aborted
          ? { type: 'navigation.cancelled', requestId: attempt.requestId }
          : {
              type: 'navigation.failed',
              requestId: attempt.requestId,
              message: messageOf(error),
            })
      } finally {
        attempt.stopAbortListener()
        if (active === attempt) active = undefined
        tasks.delete(attempt.task)
      }
    })
    tasks.add(attempt.task)
  }

  return Object.freeze({
    run: async (
      effects: readonly SessionsFeatureEffect[],
      context: FeatureCommandContext,
    ) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'resource.refresh':
            // The Surface-scoped Resource.watch adapter owns invalidation.
            break
          case 'route.open':
            await context.openRoute(effect.routeId)
            break
          case 'session.navigate':
            schedule(effect, context)
            break
          case 'session.cancel':
            /* v8 ignore else -- the reducer emits cancellation only for its active request. */
            if (active?.requestId === effect.requestId) {
              active.abort.abort(new Error('Session navigation cancelled by user'))
            }
            break
        }
      }
    },
    dispose: async () => {
      disposed = true
      active?.stopAbortListener()
      active?.abort.abort(new Error('Sessions Feature disposed'))
      active = undefined
      await Promise.allSettled([...tasks])
    },
  })
}

function commandHandler(
  commandId: string,
  model: SessionsFeatureModel,
  navigation: SessionNavigationPort,
  nextRequestId: () => number,
  effects: SessionsEffectRunner,
): FeatureCommandHandler {
  return Object.freeze({
    handle: async (command: RoutedUiCommand, context: FeatureCommandContext) => {
      model.dispatch({ type: 'navigation.changed', snapshot: navigation.snapshot() })
      const event = eventForCommand(model, commandId, command, nextRequestId)
      if (event === undefined) return
      await effects.run(model.dispatch(event), context)
    },
  })
}

function stateSourceOf(model: SessionsFeatureModel): SessionsFeatureStateSource {
  return Object.freeze({
    snapshot: () => model.snapshot(),
    onChanged: (listener: SessionsStateListener) => model.onChanged(listener),
  })
}

function regions(state: SessionsFeatureStateSource): readonly LayoutRegion<SessionsUiNode>[] {
  return Object.freeze([
    Object.freeze({
      id: SESSIONS_NAVIGATOR_REGION_ID,
      role: 'navigator' as const,
      node: createSessionsNavigatorNode(state),
      constraints: Object.freeze({ minColumns: 24, preferredColumns: 32, priority: 3 }),
    }),
  ])
}

function route(id: string, pane: 'navigator') {
  return Object.freeze({
    id,
    value: Object.freeze({
      kind: 'workspace' as const,
      featureId: SESSIONS_FEATURE_ID,
      pane,
    }),
  })
}

export const sessionsFeature: FeatureFactory<
  typeof SESSIONS_REQUIREMENTS,
  SessionsFeatureContributions
> = Object.freeze({
  manifest: Object.freeze({
    id: SESSIONS_FEATURE_ID,
    apiVersion: FEATURE_API_VERSION,
    scope: 'application',
    activation: 'on-route',
    required: false,
    requires: SESSIONS_REQUIREMENTS,
  }),
  declarations: Object.freeze({
    routes: Object.freeze([
      SESSIONS_ROUTE_ID,
    ]),
    commands: SESSIONS_COMMAND_IDS,
    keymaps: Object.freeze([SESSIONS_KEYMAP_ID]),
    resources: Object.freeze([
      SESSIONS_CATALOG_RESOURCE_ID,
      SESSIONS_INSPECTION_RESOURCE_ID,
    ]),
    surfaces: Object.freeze([
      Object.freeze({ slot: 'workspace.navigator', cardinality: 'multiple' as const }),
    ]),
  }),
  create: ({ scope, dependencies }: FeatureCreateContext<
    ResolveRequirements<typeof SESSIONS_REQUIREMENTS>
  >) => {
    const workspace = dependencies[0].value
    const navigation = dependencies[1].value
    const model = createSessionsFeatureModel()
    let requestId = 0
    let disposed = false
    const effectRunner = createEffectRunner(model, navigation, scope.signal)
    const state = stateSourceOf(model)
    const [navigator] = regions(state)
    const contributions: SessionsFeatureContributions = Object.freeze({
      routes: Object.freeze([
        route(SESSIONS_ROUTE_ID, 'navigator'),
      ]),
      commands: Object.freeze(SESSIONS_COMMAND_IDS.map(id => Object.freeze({
        id,
        value: commandHandler(id, model, navigation, () => ++requestId, effectRunner),
      }))),
      keymaps: Object.freeze([
        Object.freeze({ id: SESSIONS_KEYMAP_ID, value: SESSIONS_KEYMAP }),
      ]),
      resources: Object.freeze([
        Object.freeze({
          id: SESSIONS_CATALOG_RESOURCE_ID,
          value: catalogResource(workspace, navigation, model),
        }),
        Object.freeze({
          id: SESSIONS_INSPECTION_RESOURCE_ID,
          value: inspectionResource(workspace, navigation, model, () => !disposed),
        }),
      ]),
      surfaces: Object.freeze([
        Object.freeze({
          id: navigator!.id,
          slot: 'workspace.navigator',
          value: navigator!,
        }),
      ]),
    })
    return Object.freeze({
      contributions,
      model,
      dispose: async () => {
        if (disposed) return
        disposed = true
        requestId += 1
        await effectRunner.dispose()
        model.dispose()
      },
    } satisfies SessionsFeatureInstance)
  },
})
