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
import type { RoutedUiCommand } from '../../navigation/commands.ts'
import type { NavigationRoute } from '../../navigation/state.ts'
import type {
  ResourceDefinition,
  ResourceLoadContext,
  ResourceWatchContext,
} from '../../resource/resource-coordinator.ts'
import { SESSION_TOOLS_CAPABILITY } from '../../runtime/session-capabilities.ts'
import type { SessionToolsPort, SessionToolsSnapshot } from '../../tool/port.ts'
import type { PromptEditorAction } from '../../ui/prompt-editor.ts'
import { createToolsFeatureModel, type ToolsFeatureModel } from './model.ts'
import {
  createToolsContentNode,
  createToolsInspectorNode,
  type ToolsUiNode,
} from './nodes.ts'
import { detachToolsSnapshot } from './projectors.ts'

export const TOOLS_FEATURE_ID = 'tools'
export const TOOLS_ROUTE_ID = 'tools'
export const TOOLS_RESOURCE_ID = 'tools.catalog'
export const TOOLS_CONTENT_SURFACE_ID = 'tools.content'
export const TOOLS_INSPECTOR_SURFACE_ID = 'tools.inspector'
export const TOOLS_KEYMAP_ID = 'tools.normal'
export const TOOLS_MOVE_UP_COMMAND_ID = 'tools.selection.previous'
export const TOOLS_MOVE_DOWN_COMMAND_ID = 'tools.selection.next'
export const TOOLS_REFRESH_COMMAND_ID = 'tools.refresh'

const TOOLS_REQUIREMENTS = Object.freeze([SESSION_TOOLS_CAPABILITY] as const)
const TOOLS_COMMAND_IDS = Object.freeze([
  'navigation.move',
  'edit.insert',
  'edit.delete-backward',
  'edit.delete-forward',
  'edit.move',
  'edit.move-boundary',
  TOOLS_MOVE_UP_COMMAND_ID,
  TOOLS_MOVE_DOWN_COMMAND_ID,
  TOOLS_REFRESH_COMMAND_ID,
] as const)

const TOOLS_KEYMAP: FeatureKeymap = Object.freeze({
  context: Object.freeze({
    routeKind: 'workspace' as const,
    featureId: TOOLS_FEATURE_ID,
    mode: 'normal' as const,
  }),
  bindings: Object.freeze([
    Object.freeze({ key: 'k', commandId: TOOLS_MOVE_UP_COMMAND_ID }),
    Object.freeze({ key: 'j', commandId: TOOLS_MOVE_DOWN_COMMAND_ID }),
    Object.freeze({ key: 'r', commandId: TOOLS_REFRESH_COMMAND_ID }),
  ]),
})

export type ToolsFeatureContributions = FeatureContributions<
  NavigationRoute,
  FeatureCommandHandler,
  FeatureKeymap,
  ResourceDefinition<SessionToolsSnapshot>,
  LayoutRegion<ToolsUiNode>
>

export interface ToolsFeatureInstance extends FeatureInstance<ToolsFeatureContributions> {
  readonly model: ToolsFeatureModel
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function editAction(command: RoutedUiCommand['command']): PromptEditorAction | undefined {
  switch (command.type) {
    case 'edit.insert': return { type: 'insert', text: command.text }
    case 'edit.delete-backward': return { type: 'backspace' }
    case 'edit.delete-forward': return { type: 'delete' }
    case 'edit.move':
      return command.direction === 'left'
        ? { type: 'move-left' }
        : command.direction === 'right' ? { type: 'move-right' } : undefined
    case 'edit.move-boundary':
      return { type: command.boundary === 'start' ? 'move-home' : 'move-end' }
    default: return undefined
  }
}

function moveHandler(
  model: ToolsFeatureModel,
  direction: 'up' | 'down',
): FeatureCommandHandler {
  return Object.freeze({
    handle: () => { model.dispatch({ type: 'selection.move', direction }) },
  })
}

function genericMoveHandler(model: ToolsFeatureModel): FeatureCommandHandler {
  return Object.freeze({
    handle: (command: RoutedUiCommand) => {
      if (command.command.type !== 'navigation.move') return
      if (command.command.direction === 'up' || command.command.direction === 'down') {
        model.dispatch({ type: 'selection.move', direction: command.command.direction })
      }
    },
  })
}

function editHandler(model: ToolsFeatureModel): FeatureCommandHandler {
  return Object.freeze({
    handle: (command: RoutedUiCommand) => {
      const action = editAction(command.command)
      if (action !== undefined) model.dispatch({ type: 'query.edit', action })
    },
  })
}

function resource(
  port: SessionToolsPort,
  model: ToolsFeatureModel,
): ResourceDefinition<SessionToolsSnapshot> {
  return Object.freeze({
    key: TOOLS_RESOURCE_ID,
    lifetime: 'surface',
    activation: 'on-open',
    cachePolicy: 'last-good',
    load: (context: ResourceLoadContext<SessionToolsSnapshot>) => {
      const request = Object.freeze({
        scopeEpoch: context.scope.epoch,
        requestId: context.requestId,
      })
      model.dispatch({ type: 'load.started', request })
      try {
        context.signal.throwIfAborted()
        const snapshot = detachToolsSnapshot(port.toolsSnapshot())
        context.signal.throwIfAborted()
        model.dispatch({ type: 'load.succeeded', request, snapshot })
        return snapshot
      } catch (error: unknown) {
        if (!context.signal.aborted) {
          model.dispatch({ type: 'load.failed', request, message: messageOf(error) })
        }
        throw error
      }
    },
    watch: (context: ResourceWatchContext) => {
      const stopEffects = model.onEffect((effect) => {
        if (effect.type === 'resource.refresh' && !context.signal.aborted) {
          context.invalidate()
        }
      })
      const stopTools = port.onToolsChanged(() => {
        if (!context.signal.aborted) context.invalidate()
      })
      return () => {
        stopTools()
        stopEffects()
      }
    },
  })
}

function surface(
  id: string,
  slot: 'workspace.content' | 'workspace.inspector',
  role: 'content' | 'inspector',
  node: ToolsUiNode,
  constraints: NonNullable<LayoutRegion['constraints']>,
) {
  const region: LayoutRegion<ToolsUiNode> = Object.freeze({
    id,
    role,
    node,
    constraints: Object.freeze({ ...constraints }),
  })
  return Object.freeze({ id, slot, value: region })
}

export const toolsFeature: FeatureFactory<
  typeof TOOLS_REQUIREMENTS,
  ToolsFeatureContributions
> = Object.freeze({
  manifest: Object.freeze({
    id: TOOLS_FEATURE_ID,
    apiVersion: FEATURE_API_VERSION,
    scope: 'session',
    activation: 'on-route',
    required: false,
    requires: TOOLS_REQUIREMENTS,
  }),
  declarations: Object.freeze({
    routes: Object.freeze([TOOLS_ROUTE_ID]),
    commands: TOOLS_COMMAND_IDS,
    keymaps: Object.freeze([TOOLS_KEYMAP_ID]),
    resources: Object.freeze([TOOLS_RESOURCE_ID]),
    surfaces: Object.freeze([
      Object.freeze({ slot: 'workspace.content', cardinality: 'multiple' as const }),
      Object.freeze({ slot: 'workspace.inspector', cardinality: 'multiple' as const }),
    ]),
  }),
  create: ({ dependencies }: FeatureCreateContext<
    ResolveRequirements<typeof TOOLS_REQUIREMENTS>
  >) => {
    const port = dependencies[0].value
    const model = createToolsFeatureModel()
    const state = Object.freeze({
      snapshot: () => model.snapshot(),
      onChanged: (listener: Parameters<ToolsFeatureModel['onChanged']>[0]) => (
        model.onChanged(listener)
      ),
    })
    const edit = editHandler(model)
    const content = createToolsContentNode(state)
    const inspector = createToolsInspectorNode(state)
    const contributions: ToolsFeatureContributions = Object.freeze({
      routes: Object.freeze([Object.freeze({
        id: TOOLS_ROUTE_ID,
        value: Object.freeze({
          kind: 'workspace' as const,
          featureId: TOOLS_FEATURE_ID,
          pane: 'content' as const,
        }),
      })]),
      commands: Object.freeze([
        Object.freeze({ id: 'navigation.move', value: genericMoveHandler(model) }),
        Object.freeze({ id: 'edit.insert', value: edit }),
        Object.freeze({ id: 'edit.delete-backward', value: edit }),
        Object.freeze({ id: 'edit.delete-forward', value: edit }),
        Object.freeze({ id: 'edit.move', value: edit }),
        Object.freeze({ id: 'edit.move-boundary', value: edit }),
        Object.freeze({ id: TOOLS_MOVE_UP_COMMAND_ID, value: moveHandler(model, 'up') }),
        Object.freeze({ id: TOOLS_MOVE_DOWN_COMMAND_ID, value: moveHandler(model, 'down') }),
        Object.freeze({
          id: TOOLS_REFRESH_COMMAND_ID,
          value: Object.freeze({
            handle: () => { model.dispatch({ type: 'refresh.requested' }) },
          }),
        }),
      ]),
      keymaps: Object.freeze([Object.freeze({ id: TOOLS_KEYMAP_ID, value: TOOLS_KEYMAP })]),
      resources: Object.freeze([Object.freeze({ id: TOOLS_RESOURCE_ID, value: resource(port, model) })]),
      surfaces: Object.freeze([
        surface(TOOLS_CONTENT_SURFACE_ID, 'workspace.content', 'content', content, {
          minColumns: 48,
          preferredColumns: 86,
          priority: 15,
        }),
        surface(TOOLS_INSPECTOR_SURFACE_ID, 'workspace.inspector', 'inspector', inspector, {
          minColumns: 30,
          preferredColumns: 42,
          priority: 10,
        }),
      ]),
    })
    return Object.freeze({
      contributions,
      model,
      dispose: () => { model.dispose() },
    } satisfies ToolsFeatureInstance)
  },
})
