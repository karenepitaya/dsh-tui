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
import { createMcpFeatureModel, type McpFeatureModel } from './model.ts'
import {
  createMcpContentNode,
  createMcpInspectorNode,
  type McpUiNode,
} from './nodes.ts'
import { detachMcpToolsSnapshot } from './projectors.ts'

export const MCP_FEATURE_ID = 'mcp'
export const MCP_ROUTE_ID = 'mcp'
export const MCP_RESOURCE_ID = 'mcp.catalog'
export const MCP_CONTENT_SURFACE_ID = 'mcp.content'
export const MCP_INSPECTOR_SURFACE_ID = 'mcp.inspector'
export const MCP_KEYMAP_ID = 'mcp.normal'
export const MCP_MOVE_UP_COMMAND_ID = 'mcp.selection.previous'
export const MCP_MOVE_DOWN_COMMAND_ID = 'mcp.selection.next'
export const MCP_REFRESH_COMMAND_ID = 'mcp.refresh'

const MCP_REQUIREMENTS = Object.freeze([SESSION_TOOLS_CAPABILITY] as const)
const MCP_COMMAND_IDS = Object.freeze([
  'navigation.move',
  'edit.insert',
  'edit.delete-backward',
  'edit.delete-forward',
  'edit.move',
  'edit.move-boundary',
  MCP_MOVE_UP_COMMAND_ID,
  MCP_MOVE_DOWN_COMMAND_ID,
  MCP_REFRESH_COMMAND_ID,
] as const)

const MCP_KEYMAP: FeatureKeymap = Object.freeze({
  context: Object.freeze({
    routeKind: 'workspace' as const,
    featureId: MCP_FEATURE_ID,
    mode: 'normal' as const,
  }),
  bindings: Object.freeze([
    Object.freeze({ key: 'k', commandId: MCP_MOVE_UP_COMMAND_ID }),
    Object.freeze({ key: 'j', commandId: MCP_MOVE_DOWN_COMMAND_ID }),
    Object.freeze({ key: 'r', commandId: MCP_REFRESH_COMMAND_ID }),
  ]),
})

export type McpFeatureContributions = FeatureContributions<
  NavigationRoute,
  FeatureCommandHandler,
  FeatureKeymap,
  ResourceDefinition<SessionToolsSnapshot>,
  LayoutRegion<McpUiNode>
>

export interface McpFeatureInstance extends FeatureInstance<McpFeatureContributions> {
  readonly model: McpFeatureModel
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
  model: McpFeatureModel,
  direction: 'up' | 'down',
): FeatureCommandHandler {
  return Object.freeze({
    handle: () => { model.dispatch({ type: 'selection.move', direction }) },
  })
}

function genericMoveHandler(model: McpFeatureModel): FeatureCommandHandler {
  return Object.freeze({
    handle: (command: RoutedUiCommand) => {
      if (command.command.type !== 'navigation.move') return
      if (command.command.direction === 'up' || command.command.direction === 'down') {
        model.dispatch({ type: 'selection.move', direction: command.command.direction })
      }
    },
  })
}

function editHandler(model: McpFeatureModel): FeatureCommandHandler {
  return Object.freeze({
    handle: (command: RoutedUiCommand) => {
      const action = editAction(command.command)
      if (action !== undefined) model.dispatch({ type: 'query.edit', action })
    },
  })
}

function resource(
  port: SessionToolsPort,
  model: McpFeatureModel,
): ResourceDefinition<SessionToolsSnapshot> {
  return Object.freeze({
    key: MCP_RESOURCE_ID,
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
        const snapshot = detachMcpToolsSnapshot(port.toolsSnapshot())
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
  node: McpUiNode,
  constraints: NonNullable<LayoutRegion['constraints']>,
) {
  const region: LayoutRegion<McpUiNode> = Object.freeze({
    id,
    role,
    node,
    constraints: Object.freeze({ ...constraints }),
  })
  return Object.freeze({ id, slot, value: region })
}

export const mcpFeature: FeatureFactory<
  typeof MCP_REQUIREMENTS,
  McpFeatureContributions
> = Object.freeze({
  manifest: Object.freeze({
    id: MCP_FEATURE_ID,
    apiVersion: FEATURE_API_VERSION,
    scope: 'session',
    activation: 'on-route',
    required: false,
    requires: MCP_REQUIREMENTS,
  }),
  declarations: Object.freeze({
    routes: Object.freeze([MCP_ROUTE_ID]),
    commands: MCP_COMMAND_IDS,
    keymaps: Object.freeze([MCP_KEYMAP_ID]),
    resources: Object.freeze([MCP_RESOURCE_ID]),
    surfaces: Object.freeze([
      Object.freeze({ slot: 'workspace.content', cardinality: 'multiple' as const }),
      Object.freeze({ slot: 'workspace.inspector', cardinality: 'multiple' as const }),
    ]),
  }),
  create: ({ dependencies }: FeatureCreateContext<
    ResolveRequirements<typeof MCP_REQUIREMENTS>
  >) => {
    const port = dependencies[0].value
    const model = createMcpFeatureModel()
    const state = Object.freeze({
      snapshot: () => model.snapshot(),
      onChanged: (listener: Parameters<McpFeatureModel['onChanged']>[0]) => (
        model.onChanged(listener)
      ),
    })
    const edit = editHandler(model)
    const content = createMcpContentNode(state)
    const inspector = createMcpInspectorNode(state)
    const contributions: McpFeatureContributions = Object.freeze({
      routes: Object.freeze([Object.freeze({
        id: MCP_ROUTE_ID,
        value: Object.freeze({
          kind: 'workspace' as const,
          featureId: MCP_FEATURE_ID,
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
        Object.freeze({ id: MCP_MOVE_UP_COMMAND_ID, value: moveHandler(model, 'up') }),
        Object.freeze({ id: MCP_MOVE_DOWN_COMMAND_ID, value: moveHandler(model, 'down') }),
        Object.freeze({
          id: MCP_REFRESH_COMMAND_ID,
          value: Object.freeze({
            handle: () => { model.dispatch({ type: 'refresh.requested' }) },
          }),
        }),
      ]),
      keymaps: Object.freeze([Object.freeze({ id: MCP_KEYMAP_ID, value: MCP_KEYMAP })]),
      resources: Object.freeze([Object.freeze({ id: MCP_RESOURCE_ID, value: resource(port, model) })]),
      surfaces: Object.freeze([
        surface(MCP_CONTENT_SURFACE_ID, 'workspace.content', 'content', content, {
          minColumns: 48,
          preferredColumns: 86,
          priority: 15,
        }),
        surface(MCP_INSPECTOR_SURFACE_ID, 'workspace.inspector', 'inspector', inspector, {
          minColumns: 30,
          preferredColumns: 44,
          priority: 10,
        }),
      ]),
    })
    return Object.freeze({
      contributions,
      model,
      dispose: () => { model.dispose() },
    } satisfies McpFeatureInstance)
  },
})
