import type {
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
import type { SessionModelPort, SessionModelSnapshot } from '../../model/port.ts'
import type { RoutedUiCommand } from '../../navigation/commands.ts'
import type { NavigationRoute } from '../../navigation/state.ts'
import type {
  ResourceDefinition,
  ResourceLoadContext,
  ResourceWatchContext,
} from '../../resource/resource-coordinator.ts'
import {
  SESSION_AGENT_STATUS_CAPABILITY,
  SESSION_MODELS_CAPABILITY,
  type SessionAgentStatusPort,
} from '../../runtime/session-capabilities.ts'
import {
  selectedModelsChoice,
  type ModelsFeatureEffect,
  type ModelsFeatureState,
} from './machine.ts'
import { createModelsFeatureModel, type ModelsFeatureModel } from './model.ts'
import { createModelsContentNode, type ModelsContentNode } from './nodes.ts'
import {
  detachModelsSnapshot,
  modelsChoiceSelection,
} from './projectors.ts'

export const MODELS_FEATURE_ID = 'models'
export const MODELS_ROUTE_ID = 'models'
export const MODELS_RESOURCE_ID = 'models.catalog'
export const MODELS_CONTENT_SURFACE_ID = 'models.content'
export const MODELS_KEYMAP_ID = 'models.normal'
export const MODELS_MOVE_UP_COMMAND_ID = 'models.selection.previous'
export const MODELS_MOVE_DOWN_COMMAND_ID = 'models.selection.next'
export const MODELS_SELECT_COMMAND_ID = 'models.selection.activate'
export const MODELS_SAVE_DEFAULT_COMMAND_ID = 'models.selection.save-default'
export const MODELS_REFRESH_COMMAND_ID = 'models.refresh'
export const MODELS_EFFORT_PREVIOUS_COMMAND_ID = 'models.effort.previous'
export const MODELS_EFFORT_NEXT_COMMAND_ID = 'models.effort.next'

const MODELS_REQUIREMENTS = Object.freeze([
  SESSION_MODELS_CAPABILITY,
  SESSION_AGENT_STATUS_CAPABILITY,
] as const)
const MODELS_COMMAND_IDS = Object.freeze([
  'navigation.move',
  'navigation.activate',
  MODELS_MOVE_UP_COMMAND_ID,
  MODELS_MOVE_DOWN_COMMAND_ID,
  MODELS_SELECT_COMMAND_ID,
  MODELS_SAVE_DEFAULT_COMMAND_ID,
  MODELS_REFRESH_COMMAND_ID,
  MODELS_EFFORT_PREVIOUS_COMMAND_ID,
  MODELS_EFFORT_NEXT_COMMAND_ID,
] as const)

const MODELS_KEYMAP: FeatureKeymap = Object.freeze({
  context: Object.freeze({
    routeKind: 'workspace' as const,
    featureId: MODELS_FEATURE_ID,
    mode: 'normal' as const,
  }),
  bindings: Object.freeze([
    Object.freeze({ key: 'k', commandId: MODELS_MOVE_UP_COMMAND_ID }),
    Object.freeze({ key: 'j', commandId: MODELS_MOVE_DOWN_COMMAND_ID }),
    Object.freeze({ key: 'enter', commandId: MODELS_SELECT_COMMAND_ID }),
    Object.freeze({ key: 's', ctrl: true, commandId: MODELS_SAVE_DEFAULT_COMMAND_ID }),
    Object.freeze({ key: 'r', commandId: MODELS_REFRESH_COMMAND_ID }),
    Object.freeze({ key: 'left', commandId: MODELS_EFFORT_PREVIOUS_COMMAND_ID }),
    Object.freeze({ key: 'right', commandId: MODELS_EFFORT_NEXT_COMMAND_ID }),
    Object.freeze({ key: 'h', commandId: MODELS_EFFORT_PREVIOUS_COMMAND_ID }),
    Object.freeze({ key: 'l', commandId: MODELS_EFFORT_NEXT_COMMAND_ID }),
  ]),
})

export type ModelsFeatureContributions = FeatureContributions<
  NavigationRoute,
  FeatureCommandHandler,
  FeatureKeymap,
  ResourceDefinition<SessionModelSnapshot>,
  LayoutRegion<ModelsContentNode>
>

export interface ModelsFeatureInstance
  extends FeatureInstance<ModelsFeatureContributions> {
  readonly model: ModelsFeatureModel
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requestOf(context: ResourceLoadContext<SessionModelSnapshot>) {
  return Object.freeze({
    scopeEpoch: context.scope.epoch,
    requestId: context.requestId,
  })
}

function stateSource(model: ModelsFeatureModel) {
  return Object.freeze({
    snapshot: () => model.snapshot(),
    onChanged: (listener: (state: ModelsFeatureState) => void) => model.onChanged(listener),
  })
}

function selectionBlock(state: ModelsFeatureState): string | undefined {
  const choice = selectedModelsChoice(state)
  if (choice === undefined) return 'No model route is selected'
  if (state.agentStatus?.status !== 'idle') {
    return 'Model selection requires the Agent to be idle'
  }
  if (state.snapshot?.writable !== true) {
    return 'Model selection is read-only because this Agent is owned by another Host'
  }
  if (state.snapshot.selecting && !state.selecting) {
    return 'A model selection is already running'
  }
  if (!choice.routable) return 'The selected model route is not currently routable'
  return undefined
}

function moveHandler(
  model: ModelsFeatureModel,
  direction: 'up' | 'down',
): FeatureCommandHandler {
  return Object.freeze({
    handle: () => { model.dispatch({ type: 'selection.move', direction }) },
  })
}

function genericMoveHandler(model: ModelsFeatureModel): FeatureCommandHandler {
  return Object.freeze({
    handle: (command: RoutedUiCommand) => {
      if (command.command.type !== 'navigation.move') return
      if (command.command.direction === 'up' || command.command.direction === 'down') {
        model.dispatch({ type: 'selection.move', direction: command.command.direction })
      }
    },
  })
}

function selectionHandler(
  port: SessionModelPort,
  model: ModelsFeatureModel,
  scopeSignal: AbortSignal,
  nextRequestId: () => number,
  replaceAbort: (abort: AbortController) => void,
  saveDefault: boolean,
): FeatureCommandHandler {
  return Object.freeze({
    handle: async () => {
      const state = model.snapshot()
      const blocked = selectionBlock(state)
      if (blocked !== undefined) {
        model.dispatch({ type: 'selection.blocked', message: blocked })
        return
      }
      const selection = modelsChoiceSelection(selectedModelsChoice(state)!)
      const requestId = nextRequestId()
      const abort = new AbortController()
      replaceAbort(abort)
      const signal = AbortSignal.any([scopeSignal, abort.signal])
      model.dispatch({ type: 'selection.started', requestId, selection })
      try {
        await port.selectModel(selection, saveDefault ? { signal, saveDefault: true } : { signal })
        signal.throwIfAborted()
        model.dispatch({
          type: 'selection.succeeded',
          requestId,
          snapshot: detachModelsSnapshot(port.modelSnapshot()),
        })
      } catch (error: unknown) {
        if (signal.aborted) return
        let snapshot: SessionModelSnapshot | undefined
        try {
          snapshot = detachModelsSnapshot(port.modelSnapshot())
        } catch {
          snapshot = undefined
        }
        model.dispatch({
          type: 'selection.failed',
          requestId,
          message: messageOf(error),
          ...(snapshot === undefined ? {} : { snapshot }),
        })
      }
    },
  })
}

function watch(
  port: SessionModelPort,
  status: SessionAgentStatusPort,
  model: ModelsFeatureModel,
  context: ResourceWatchContext,
): () => void {
  const stops: Array<() => void> = []
  try {
    stops.push(model.onEffect((effect: ModelsFeatureEffect) => {
      if (effect.type === 'resource.refresh' && !context.signal.aborted) context.invalidate()
    }))
    stops.push(port.onModelsChanged(() => {
      if (context.signal.aborted) return
      try {
        model.dispatch({
          type: 'snapshot.changed',
          snapshot: detachModelsSnapshot(port.modelSnapshot()),
        })
      } catch (error: unknown) {
        model.dispatch({ type: 'snapshot.failed', message: messageOf(error) })
      }
    }))
    stops.push(status.onChanged(() => {
      if (context.signal.aborted) return
      try {
        model.dispatch({ type: 'status.changed', status: status.snapshot() })
      } catch (error: unknown) {
        model.dispatch({ type: 'snapshot.failed', message: messageOf(error) })
      }
    }))
  } catch (error: unknown) {
    for (const stop of [...stops].reverse()) stop()
    throw error
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    for (const stop of [...stops].reverse()) stop()
  }
}

function resource(
  port: SessionModelPort,
  status: SessionAgentStatusPort,
  model: ModelsFeatureModel,
  hasRefreshed: () => boolean,
  markRefreshed: () => void,
): ResourceDefinition<SessionModelSnapshot> {
  return Object.freeze({
    key: MODELS_RESOURCE_ID,
    lifetime: 'surface',
    activation: 'on-open',
    cachePolicy: 'last-good',
    load: async (context: ResourceLoadContext<SessionModelSnapshot>) => {
      const request = requestOf(context)
      model.dispatch({ type: 'load.started', request })
      try {
        if (!hasRefreshed() || context.previous !== undefined) {
          await port.refreshModels(context.signal)
          context.signal.throwIfAborted()
          markRefreshed()
        }
        const snapshot = detachModelsSnapshot(port.modelSnapshot())
        model.dispatch({ type: 'status.changed', status: status.snapshot() })
        model.dispatch({ type: 'load.succeeded', request, snapshot })
        return snapshot
      } catch (error: unknown) {
        if (!context.signal.aborted) {
          model.dispatch({ type: 'load.failed', request, message: messageOf(error) })
        }
        throw error
      }
    },
    watch: (context: ResourceWatchContext) => watch(port, status, model, context),
  })
}

export const modelsFeature: FeatureFactory<
  typeof MODELS_REQUIREMENTS,
  ModelsFeatureContributions
> = Object.freeze({
  manifest: Object.freeze({
    id: MODELS_FEATURE_ID,
    apiVersion: FEATURE_API_VERSION,
    scope: 'session',
    activation: 'on-route',
    required: false,
    requires: MODELS_REQUIREMENTS,
  }),
  declarations: Object.freeze({
    routes: Object.freeze([MODELS_ROUTE_ID]),
    commands: MODELS_COMMAND_IDS,
    keymaps: Object.freeze([MODELS_KEYMAP_ID]),
    resources: Object.freeze([MODELS_RESOURCE_ID]),
    surfaces: Object.freeze([
      Object.freeze({ slot: 'workspace.content', cardinality: 'multiple' as const }),
    ]),
  }),
  create: ({ scope, dependencies }: FeatureCreateContext<
    ResolveRequirements<typeof MODELS_REQUIREMENTS>
  >) => {
    const port = dependencies[0].value
    const status = dependencies[1].value
    const model = createModelsFeatureModel()
    let refreshed = false
    let selectionRequestId = 0
    let selectionAbort: AbortController | undefined
    let disposed = false
    const catalog = resource(
      port,
      status,
      model,
      () => refreshed,
      () => { refreshed = true },
    )
    const select = selectionHandler(
      port,
      model,
      scope.signal,
      () => ++selectionRequestId,
      (abort) => {
        selectionAbort?.abort('model selection superseded')
        selectionAbort = abort
      },
      false,
    )
    const saveDefault = selectionHandler(
      port,
      model,
      scope.signal,
      () => ++selectionRequestId,
      (abort) => {
        selectionAbort?.abort('model selection superseded')
        selectionAbort = abort
      },
      true,
    )
    const node = createModelsContentNode(stateSource(model))
    const region: LayoutRegion<ModelsContentNode> = Object.freeze({
      id: MODELS_CONTENT_SURFACE_ID,
      role: 'content',
      node,
      constraints: Object.freeze({ minColumns: 52, preferredColumns: 92, priority: 15 }),
    })
    const contributions: ModelsFeatureContributions = Object.freeze({
      routes: Object.freeze([Object.freeze({
        id: MODELS_ROUTE_ID,
        value: Object.freeze({
          kind: 'workspace' as const,
          featureId: MODELS_FEATURE_ID,
          pane: 'content' as const,
        }),
      })]),
      commands: Object.freeze([
        Object.freeze({ id: 'navigation.move', value: genericMoveHandler(model) }),
        Object.freeze({ id: 'navigation.activate', value: select }),
        Object.freeze({ id: MODELS_MOVE_UP_COMMAND_ID, value: moveHandler(model, 'up') }),
        Object.freeze({ id: MODELS_MOVE_DOWN_COMMAND_ID, value: moveHandler(model, 'down') }),
        Object.freeze({ id: MODELS_EFFORT_PREVIOUS_COMMAND_ID, value: Object.freeze({
          handle: () => { model.dispatch({ type: 'effort.move', direction: 'left' }) },
        }) }),
        Object.freeze({ id: MODELS_EFFORT_NEXT_COMMAND_ID, value: Object.freeze({
          handle: () => { model.dispatch({ type: 'effort.move', direction: 'right' }) },
        }) }),
        Object.freeze({ id: MODELS_SELECT_COMMAND_ID, value: select }),
        Object.freeze({ id: MODELS_SAVE_DEFAULT_COMMAND_ID, value: saveDefault }),
        Object.freeze({
          id: MODELS_REFRESH_COMMAND_ID,
          value: Object.freeze({
            handle: () => { model.dispatch({ type: 'refresh.requested' }) },
          }),
        }),
      ]),
      keymaps: Object.freeze([Object.freeze({ id: MODELS_KEYMAP_ID, value: MODELS_KEYMAP })]),
      resources: Object.freeze([Object.freeze({ id: MODELS_RESOURCE_ID, value: catalog })]),
      surfaces: Object.freeze([Object.freeze({
        id: MODELS_CONTENT_SURFACE_ID,
        slot: 'workspace.content',
        value: region,
      })]),
    })
    return Object.freeze({
      contributions,
      model,
      dispose: () => {
        if (disposed) return
        disposed = true
        selectionRequestId += 1
        selectionAbort?.abort('Models Feature disposed')
        selectionAbort = undefined
        model.dispose()
      },
    } satisfies ModelsFeatureInstance)
  },
})
