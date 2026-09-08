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
import type { SessionModePort, SessionModeSnapshot } from '../../mode/port.ts'
import type { RoutedUiCommand } from '../../navigation/commands.ts'
import type { NavigationRoute } from '../../navigation/state.ts'
import type {
  ResourceDefinition,
  ResourceLoadContext,
  ResourceWatchContext,
} from '../../resource/resource-coordinator.ts'
import { SESSION_MODES_CAPABILITY } from '../../runtime/session-capabilities.ts'
import {
  selectedModesChoice,
  type ModesFeatureEffect,
  type ModesFeatureState,
} from './machine.ts'
import {
  createModesFeatureModel,
  type ModesFeatureModel,
} from './model.ts'
import { createModesContentNode, type ModesContentNode } from './nodes.ts'
import { detachModesSnapshot } from './projectors.ts'

export const MODES_FEATURE_ID = 'modes'
export const MODES_ROUTE_ID = 'modes'
export const MODES_RESOURCE_ID = 'modes.catalog'
export const MODES_CONTENT_SURFACE_ID = 'modes.content'
export const MODES_KEYMAP_ID = 'modes.normal'
export const MODES_MOVE_UP_COMMAND_ID = 'modes.selection.previous'
export const MODES_MOVE_DOWN_COMMAND_ID = 'modes.selection.next'
export const MODES_SELECT_COMMAND_ID = 'modes.selection.activate'
export const MODES_REFRESH_COMMAND_ID = 'modes.refresh'

const MODES_REQUIREMENTS = Object.freeze([SESSION_MODES_CAPABILITY] as const)
const MODES_COMMAND_IDS = Object.freeze([
  'navigation.move',
  'navigation.activate',
  MODES_MOVE_UP_COMMAND_ID,
  MODES_MOVE_DOWN_COMMAND_ID,
  MODES_SELECT_COMMAND_ID,
  MODES_REFRESH_COMMAND_ID,
] as const)

const MODES_KEYMAP: FeatureKeymap = Object.freeze({
  context: Object.freeze({
    routeKind: 'workspace' as const,
    featureId: MODES_FEATURE_ID,
    mode: 'normal' as const,
  }),
  bindings: Object.freeze([
    Object.freeze({ key: 'k', commandId: MODES_MOVE_UP_COMMAND_ID }),
    Object.freeze({ key: 'j', commandId: MODES_MOVE_DOWN_COMMAND_ID }),
    Object.freeze({ key: 'enter', commandId: MODES_SELECT_COMMAND_ID }),
    Object.freeze({ key: 'r', commandId: MODES_REFRESH_COMMAND_ID }),
  ]),
})

export type ModesFeatureContributions = FeatureContributions<
  NavigationRoute,
  FeatureCommandHandler,
  FeatureKeymap,
  ResourceDefinition<SessionModeSnapshot>,
  LayoutRegion<ModesContentNode>
>

export interface ModesFeatureInstance extends FeatureInstance<ModesFeatureContributions> {
  readonly model: ModesFeatureModel
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stateSource(model: ModesFeatureModel) {
  return Object.freeze({
    snapshot: () => model.snapshot(),
    onChanged: (listener: (state: ModesFeatureState) => void) => model.onChanged(listener),
  })
}

function requestOf(context: ResourceLoadContext<SessionModeSnapshot>) {
  return Object.freeze({ scopeEpoch: context.scope.epoch, requestId: context.requestId })
}

function watch(
  port: SessionModePort,
  model: ModesFeatureModel,
  context: ResourceWatchContext,
): () => void {
  const stopEffects = model.onEffect((effect: ModesFeatureEffect) => {
    if (effect.type === 'resource.refresh' && !context.signal.aborted) context.invalidate()
  })
  const stopModes = port.onModesChanged(() => {
    if (context.signal.aborted) return
    try {
      model.dispatch({ type: 'snapshot.changed', snapshot: port.modeSnapshot() })
    } catch (error: unknown) {
      model.dispatch({ type: 'snapshot.failed', message: messageOf(error) })
    }
  })
  return () => {
    stopModes()
    stopEffects()
  }
}

function resource(
  port: SessionModePort,
  model: ModesFeatureModel,
): ResourceDefinition<SessionModeSnapshot> {
  return Object.freeze({
    key: MODES_RESOURCE_ID,
    lifetime: 'surface',
    activation: 'on-open',
    cachePolicy: 'last-good',
    load: async (context: ResourceLoadContext<SessionModeSnapshot>) => {
      const request = requestOf(context)
      model.dispatch({ type: 'load.started', request })
      try {
        await port.refreshModes(context.signal)
        context.signal.throwIfAborted()
        const snapshot = detachModesSnapshot(port.modeSnapshot())
        model.dispatch({ type: 'load.succeeded', request, snapshot })
        return snapshot
      } catch (error: unknown) {
        if (!context.signal.aborted) {
          model.dispatch({ type: 'load.failed', request, message: messageOf(error) })
        }
        throw error
      }
    },
    watch: (context: ResourceWatchContext) => watch(port, model, context),
  })
}

function moveHandler(
  model: ModesFeatureModel,
  direction: 'up' | 'down',
): FeatureCommandHandler {
  return Object.freeze({
    handle: () => { model.dispatch({ type: 'selection.move', direction }) },
  })
}

function genericMoveHandler(model: ModesFeatureModel): FeatureCommandHandler {
  return Object.freeze({
    handle: (command: RoutedUiCommand) => {
      if (command.command.type !== 'navigation.move') return
      if (command.command.direction === 'up' || command.command.direction === 'down') {
        model.dispatch({ type: 'selection.move', direction: command.command.direction })
      }
    },
  })
}

function selectionBlock(state: ModesFeatureState): string | undefined {
  const choice = selectedModesChoice(state)
  if (choice === undefined) return 'No Agent mode is selected'
  if (state.snapshot?.available !== true) return 'DSH Agent mode selection is unavailable'
  if (state.snapshot.locked) return 'This Session has already started; use /new to choose a mode for a new session'
  if (state.selecting || state.snapshot.selecting) return 'An Agent mode selection is already running'
  if (choice.broken !== undefined) return choice.broken
  if (choice.isCurrent) return 'This Agent mode is already active'
  return undefined
}

function selectionHandler(
  port: SessionModePort,
  model: ModesFeatureModel,
  scopeSignal: AbortSignal,
  nextRequestId: () => number,
  replaceAbort: (abort: AbortController) => void,
): FeatureCommandHandler {
  return Object.freeze({
    handle: async () => {
      const state = model.snapshot()
      const blocked = selectionBlock(state)
      if (blocked !== undefined) {
        model.dispatch({ type: 'selection.blocked', message: blocked })
        return
      }
      const modeId = selectedModesChoice(state)!.id
      const requestId = nextRequestId()
      const abort = new AbortController()
      replaceAbort(abort)
      const signal = AbortSignal.any([scopeSignal, abort.signal])
      model.dispatch({ type: 'selection.started', requestId, modeId })
      try {
        await port.selectMode(modeId, { signal })
        signal.throwIfAborted()
        model.dispatch({
          type: 'selection.succeeded',
          requestId,
          snapshot: port.modeSnapshot(),
        })
      } catch (error: unknown) {
        if (signal.aborted) return
        let snapshot: SessionModeSnapshot | undefined
        try {
          snapshot = port.modeSnapshot()
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

export const modesFeature: FeatureFactory<
  typeof MODES_REQUIREMENTS,
  ModesFeatureContributions
> = Object.freeze({
  manifest: Object.freeze({
    id: MODES_FEATURE_ID,
    apiVersion: FEATURE_API_VERSION,
    scope: 'session',
    activation: 'on-route',
    required: false,
    requires: MODES_REQUIREMENTS,
  }),
  declarations: Object.freeze({
    routes: Object.freeze([MODES_ROUTE_ID]),
    commands: MODES_COMMAND_IDS,
    keymaps: Object.freeze([MODES_KEYMAP_ID]),
    resources: Object.freeze([MODES_RESOURCE_ID]),
    surfaces: Object.freeze([
      Object.freeze({ slot: 'workspace.content', cardinality: 'multiple' as const }),
    ]),
  }),
  create: ({ scope, dependencies }: FeatureCreateContext<
    ResolveRequirements<typeof MODES_REQUIREMENTS>
  >) => {
    const port = dependencies[0].value
    const model = createModesFeatureModel()
    let selectionRequestId = 0
    let selectionAbort: AbortController | undefined
    let disposed = false
    const select = selectionHandler(
      port,
      model,
      scope.signal,
      () => ++selectionRequestId,
      (abort) => {
        selectionAbort?.abort('Agent mode selection superseded')
        selectionAbort = abort
      },
    )
    const node = createModesContentNode(stateSource(model))
    const region: LayoutRegion<ModesContentNode> = Object.freeze({
      id: MODES_CONTENT_SURFACE_ID,
      role: 'content',
      node,
      constraints: Object.freeze({ minColumns: 48, preferredColumns: 84, priority: 15 }),
    })
    const contributions: ModesFeatureContributions = Object.freeze({
      routes: Object.freeze([Object.freeze({
        id: MODES_ROUTE_ID,
        value: Object.freeze({
          kind: 'workspace' as const,
          featureId: MODES_FEATURE_ID,
          pane: 'content' as const,
        }),
      })]),
      commands: Object.freeze([
        Object.freeze({ id: 'navigation.move', value: genericMoveHandler(model) }),
        Object.freeze({ id: 'navigation.activate', value: select }),
        Object.freeze({ id: MODES_MOVE_UP_COMMAND_ID, value: moveHandler(model, 'up') }),
        Object.freeze({ id: MODES_MOVE_DOWN_COMMAND_ID, value: moveHandler(model, 'down') }),
        Object.freeze({ id: MODES_SELECT_COMMAND_ID, value: select }),
        Object.freeze({
          id: MODES_REFRESH_COMMAND_ID,
          value: Object.freeze({
            handle: () => { model.dispatch({ type: 'refresh.requested' }) },
          }),
        }),
      ]),
      keymaps: Object.freeze([Object.freeze({ id: MODES_KEYMAP_ID, value: MODES_KEYMAP })]),
      resources: Object.freeze([Object.freeze({
        id: MODES_RESOURCE_ID,
        value: resource(port, model),
      })]),
      surfaces: Object.freeze([Object.freeze({
        id: MODES_CONTENT_SURFACE_ID,
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
        selectionAbort?.abort('Modes Feature disposed')
        selectionAbort = undefined
        model.dispose()
      },
    } satisfies ModesFeatureInstance)
  },
})
