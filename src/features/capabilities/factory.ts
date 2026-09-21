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
  SESSION_SKILLS_CAPABILITY,
  SESSION_TOOLS_CAPABILITY,
} from '../../runtime/session-capabilities.ts'
import type { SessionSkillsPort, SessionSkillsSnapshot } from '../../skill/port.ts'
import type { SessionToolsPort, SessionToolsSnapshot } from '../../tool/port.ts'
import type { PromptEditorAction } from '../../ui/prompt-editor.ts'
import {
  CAPABILITIES_MCP_RESOURCE_ID,
  CAPABILITIES_SKILLS_RESOURCE_ID,
  CAPABILITIES_TOOLS_RESOURCE_ID,
  type CapabilitiesFeatureEffect,
  type CapabilitiesFeatureEvent,
} from './machine.ts'
import {
  createCapabilitiesFeatureModel,
  type CapabilitiesFeatureModel,
  type CapabilitiesFeatureStateSource,
} from './model.ts'
import {
  createCapabilitiesNavigatorNode,
  type CapabilitiesUiNode,
} from './nodes.ts'
import {
  detachMcpToolsSnapshot,
  detachSkillsSnapshot,
  detachToolsSnapshot,
} from './projectors.ts'

export const CAPABILITIES_FEATURE_ID = 'capabilities'
export const CAPABILITIES_ROUTE_ID = 'capabilities'
export const CAPABILITIES_NAVIGATOR_SURFACE_ID = 'capabilities.navigator'
export const CAPABILITIES_KEYMAP_ID = 'capabilities.normal'
export const CAPABILITIES_TAB_PREVIOUS_COMMAND_ID = 'capabilities.tab.previous'
export const CAPABILITIES_TAB_NEXT_COMMAND_ID = 'capabilities.tab.next'
export const CAPABILITIES_MOVE_UP_COMMAND_ID = 'capabilities.selection.previous'
export const CAPABILITIES_MOVE_DOWN_COMMAND_ID = 'capabilities.selection.next'
export const CAPABILITIES_REFRESH_COMMAND_ID = 'capabilities.refresh'
export const CAPABILITIES_DISMISS_COMMAND_ID = 'capabilities.dismiss'

const CAPABILITIES_REQUIREMENTS = Object.freeze([
  SESSION_SKILLS_CAPABILITY,
  SESSION_TOOLS_CAPABILITY,
] as const)

const CAPABILITIES_COMMAND_IDS = Object.freeze([
  'navigation.move',
  'navigation.page',
  'navigation.activate',
  'action.submit',
  'edit.insert',
  'edit.delete-backward',
  'edit.delete-forward',
  'edit.move',
  'edit.move-boundary',
  CAPABILITIES_TAB_PREVIOUS_COMMAND_ID,
  CAPABILITIES_TAB_NEXT_COMMAND_ID,
  CAPABILITIES_MOVE_UP_COMMAND_ID,
  CAPABILITIES_MOVE_DOWN_COMMAND_ID,
  CAPABILITIES_REFRESH_COMMAND_ID,
  CAPABILITIES_DISMISS_COMMAND_ID,
] as const)

const CAPABILITIES_KEYMAP: FeatureKeymap = Object.freeze({
  context: Object.freeze({
    routeKind: 'workspace' as const,
    featureId: CAPABILITIES_FEATURE_ID,
    mode: 'normal' as const,
  }),
  bindings: Object.freeze([
    Object.freeze({ key: '[', commandId: CAPABILITIES_TAB_PREVIOUS_COMMAND_ID }),
    Object.freeze({ key: ']', commandId: CAPABILITIES_TAB_NEXT_COMMAND_ID }),
    Object.freeze({ key: 'k', commandId: CAPABILITIES_MOVE_UP_COMMAND_ID }),
    Object.freeze({ key: 'j', commandId: CAPABILITIES_MOVE_DOWN_COMMAND_ID }),
    Object.freeze({ key: 'r', commandId: CAPABILITIES_REFRESH_COMMAND_ID }),
    Object.freeze({ key: 'q', commandId: CAPABILITIES_DISMISS_COMMAND_ID }),
    Object.freeze({ key: 'escape', commandId: CAPABILITIES_DISMISS_COMMAND_ID }),
  ]),
})

export type CapabilitiesFeatureContributions = FeatureContributions<
  NavigationRoute,
  FeatureCommandHandler,
  FeatureKeymap,
  unknown,
  LayoutRegion<CapabilitiesUiNode>
>

export interface CapabilitiesFeatureInstance
  extends FeatureInstance<CapabilitiesFeatureContributions> {
  readonly model: CapabilitiesFeatureModel
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function dropLastCodePoint(value: string): string {
  const points = [...value]
  points.pop()
  return points.join('')
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

function eventForCommand(
  model: CapabilitiesFeatureModel,
  command: RoutedUiCommand,
): CapabilitiesFeatureEvent | undefined {
  const state = model.snapshot()
  const tab = state.tab
  const detailsOpen = state.details !== undefined
  switch (command.command.type) {
    case 'navigation.move':
      if (detailsOpen) {
        switch (command.command.direction) {
          case 'up':
          case 'down':
            return { type: 'details.move', direction: command.command.direction }
          default:
            return undefined
        }
      }
      switch (command.command.direction) {
        case 'up':
        case 'down':
          return tab === 'skills'
            ? { type: 'skills', event: { type: 'selection.move', direction: command.command.direction } }
            : tab === 'tools'
              ? { type: 'tools', event: { type: 'selection.move', direction: command.command.direction } }
              : { type: 'mcp', event: { type: 'selection.move', direction: command.command.direction } }
        case 'left': return { type: 'tab.previous' }
        case 'right': return { type: 'tab.next' }
      }
      return undefined
    case 'navigation.page':
      if (detailsOpen) {
        return { type: 'details.move', direction: command.command.direction, amount: 5 }
      }
      return tab === 'skills'
        ? { type: 'skills', event: { type: 'selection.move', direction: command.command.direction, amount: 8 } }
        : undefined
    case 'navigation.activate':
    case 'action.submit':
      return { type: detailsOpen ? 'details.close' : 'details.open' }
    case 'edit.insert':
    case 'edit.delete-backward':
    case 'edit.delete-forward':
    case 'edit.move':
    case 'edit.move-boundary': {
      if (detailsOpen) return undefined
      const action = editAction(command.command)
      if (action === undefined) return undefined
      if (tab === 'skills') {
        if (command.command.type === 'edit.insert') {
          return { type: 'skills', event: { type: 'query.changed', query: model.snapshot().skills.query + command.command.text } }
        }
        if (command.command.type === 'edit.delete-backward') {
          return { type: 'skills', event: { type: 'query.changed', query: dropLastCodePoint(model.snapshot().skills.query) } }
        }
        return undefined
      }
      return tab === 'tools'
        ? { type: 'tools', event: { type: 'query.edit', action } }
        : { type: 'mcp', event: { type: 'query.edit', action } }
    }
    case 'feature.command':
      switch (command.command.commandId) {
        case CAPABILITIES_DISMISS_COMMAND_ID:
          return { type: detailsOpen ? 'details.close' : 'page.back' }
        case CAPABILITIES_TAB_PREVIOUS_COMMAND_ID: return { type: 'tab.previous' }
        case CAPABILITIES_TAB_NEXT_COMMAND_ID: return { type: 'tab.next' }
        case CAPABILITIES_MOVE_UP_COMMAND_ID:
          if (detailsOpen) return { type: 'details.move', direction: 'up' }
          return tab === 'skills'
            ? { type: 'skills', event: { type: 'selection.move', direction: 'up' } }
            : tab === 'tools'
              ? { type: 'tools', event: { type: 'selection.move', direction: 'up' } }
              : { type: 'mcp', event: { type: 'selection.move', direction: 'up' } }
        case CAPABILITIES_MOVE_DOWN_COMMAND_ID:
          if (detailsOpen) return { type: 'details.move', direction: 'down' }
          return tab === 'skills'
            ? { type: 'skills', event: { type: 'selection.move', direction: 'down' } }
            : tab === 'tools'
              ? { type: 'tools', event: { type: 'selection.move', direction: 'down' } }
              : { type: 'mcp', event: { type: 'selection.move', direction: 'down' } }
        case CAPABILITIES_REFRESH_COMMAND_ID:
          if (detailsOpen) return undefined
          return tab === 'skills'
            ? { type: 'skills', event: { type: 'refresh.requested' } }
            : tab === 'tools'
              ? { type: 'tools', event: { type: 'refresh.requested' } }
              : { type: 'mcp', event: { type: 'refresh.requested' } }
        default:
          return undefined
      }
    default:
      return undefined
  }
}

async function runEffects(
  effects: readonly CapabilitiesFeatureEffect[],
  context: FeatureCommandContext,
): Promise<void> {
  for (const effect of effects) {
    if (effect.type === 'route.open') await context.openRoute(effect.routeId)
  }
}

function commandHandler(model: CapabilitiesFeatureModel): FeatureCommandHandler {
  return Object.freeze({
    handle: async (command: RoutedUiCommand, context: FeatureCommandContext) => {
      const event = eventForCommand(model, command)
      if (event === undefined) return
      await runEffects(model.dispatch(event), context)
    },
  })
}

function requestOf(context: ResourceLoadContext<unknown>): { scopeEpoch: number; requestId: number } {
  return Object.freeze({
    scopeEpoch: context.scope.epoch,
    requestId: context.requestId,
  })
}

function refreshEffectInvalidates(
  model: CapabilitiesFeatureModel,
  context: ResourceWatchContext,
  resourceId: string,
): () => void {
  return model.onEffect((effect) => {
    if (effect.type === 'resource.refresh' && effect.resourceId === resourceId && !context.signal.aborted) {
      context.invalidate()
    }
  })
}

function skillsResource(
  port: SessionSkillsPort,
  model: CapabilitiesFeatureModel,
): ResourceDefinition<SessionSkillsSnapshot> {
  return Object.freeze({
    key: CAPABILITIES_SKILLS_RESOURCE_ID,
    lifetime: 'surface',
    activation: 'on-open',
    cachePolicy: 'last-good',
    load: async (context: ResourceLoadContext<SessionSkillsSnapshot>) => {
      const request = requestOf(context)
      model.dispatch({ type: 'skills', event: { type: 'load.started', request } })
      try {
        await port.refreshSkills(context.signal)
        context.signal.throwIfAborted()
        const snapshot = detachSkillsSnapshot(port.skillsSnapshot())
        model.dispatch({ type: 'skills', event: { type: 'load.succeeded', request, snapshot } })
        return snapshot
      } catch (error: unknown) {
        if (!context.signal.aborted) {
          model.dispatch({ type: 'skills', event: { type: 'load.failed', request, message: messageOf(error) } })
        }
        throw error
      }
    },
    watch: (context: ResourceWatchContext) => {
      const stopEffects = refreshEffectInvalidates(model, context, CAPABILITIES_SKILLS_RESOURCE_ID)
      const stopSkills = port.onSkillsChanged(() => {
        if (context.signal.aborted) return
        try {
          const snapshot = detachSkillsSnapshot(port.skillsSnapshot())
          model.dispatch({ type: 'skills', event: { type: 'snapshot.changed', snapshot } })
          if (snapshot.available && !snapshot.complete && !snapshot.loading) {
            model.dispatch({ type: 'skills', event: { type: 'refresh.requested' } })
          }
        } catch (error: unknown) {
          model.dispatch({ type: 'skills', event: { type: 'snapshot.failed', message: messageOf(error) } })
        }
      })
      return () => {
        stopSkills()
        stopEffects()
      }
    },
  })
}

function toolsResource(
  port: SessionToolsPort,
  model: CapabilitiesFeatureModel,
  resourceId: typeof CAPABILITIES_TOOLS_RESOURCE_ID | typeof CAPABILITIES_MCP_RESOURCE_ID,
  tab: 'tools' | 'mcp',
): ResourceDefinition<SessionToolsSnapshot> {
  return Object.freeze({
    key: resourceId,
    lifetime: 'surface',
    activation: 'on-open',
    cachePolicy: 'last-good',
    load: (context: ResourceLoadContext<SessionToolsSnapshot>) => {
      const request = requestOf(context)
      model.dispatch({ type: tab, event: { type: 'load.started', request } })
      try {
        context.signal.throwIfAborted()
        const snapshot = tab === 'tools'
          ? detachToolsSnapshot(port.toolsSnapshot())
          : detachMcpToolsSnapshot(port.toolsSnapshot())
        context.signal.throwIfAborted()
        model.dispatch({ type: tab, event: { type: 'load.succeeded', request, snapshot } })
        return snapshot
      } catch (error: unknown) {
        if (!context.signal.aborted) {
          model.dispatch({ type: tab, event: { type: 'load.failed', request, message: messageOf(error) } })
        }
        throw error
      }
    },
    watch: (context: ResourceWatchContext) => {
      const stopEffects = refreshEffectInvalidates(model, context, resourceId)
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

function stateSource(model: CapabilitiesFeatureModel): CapabilitiesFeatureStateSource {
  return Object.freeze({
    snapshot: () => model.snapshot(),
    onChanged: (listener: Parameters<CapabilitiesFeatureStateSource['onChanged']>[0]) => (
      model.onChanged(listener)
    ),
  })
}

function route(id: string, pane: 'content') {
  return Object.freeze({
    id,
    value: Object.freeze({
      kind: 'workspace' as const,
      featureId: CAPABILITIES_FEATURE_ID,
      pane,
    }),
  })
}

export const capabilitiesFeature: FeatureFactory<
  typeof CAPABILITIES_REQUIREMENTS,
  CapabilitiesFeatureContributions
> = Object.freeze({
  manifest: Object.freeze({
    id: CAPABILITIES_FEATURE_ID,
    apiVersion: FEATURE_API_VERSION,
    scope: 'session',
    activation: 'on-route',
    required: false,
    requires: CAPABILITIES_REQUIREMENTS,
  }),
  declarations: Object.freeze({
    routes: Object.freeze([CAPABILITIES_ROUTE_ID]),
    commands: CAPABILITIES_COMMAND_IDS,
    keymaps: Object.freeze([CAPABILITIES_KEYMAP_ID]),
    resources: Object.freeze([
      CAPABILITIES_SKILLS_RESOURCE_ID,
      CAPABILITIES_TOOLS_RESOURCE_ID,
      CAPABILITIES_MCP_RESOURCE_ID,
    ]),
    surfaces: Object.freeze([
      Object.freeze({ slot: 'workspace.content', cardinality: 'multiple' as const }),
    ]),
  }),
  create: ({ dependencies }: FeatureCreateContext<
    ResolveRequirements<typeof CAPABILITIES_REQUIREMENTS>
  >) => {
    const skillsPort = dependencies[0].value
    const toolsPort = dependencies[1].value
    const model = createCapabilitiesFeatureModel()
    const source = stateSource(model)
    const handler = commandHandler(model)
    const contributions: CapabilitiesFeatureContributions = Object.freeze({
      routes: Object.freeze([
        route(CAPABILITIES_ROUTE_ID, 'content'),
      ]),
      commands: Object.freeze(CAPABILITIES_COMMAND_IDS.map(id => Object.freeze({
        id,
        value: handler,
      }))),
      keymaps: Object.freeze([Object.freeze({ id: CAPABILITIES_KEYMAP_ID, value: CAPABILITIES_KEYMAP })]),
      resources: Object.freeze([
        Object.freeze({ id: CAPABILITIES_SKILLS_RESOURCE_ID, value: skillsResource(skillsPort, model) }),
        Object.freeze({ id: CAPABILITIES_TOOLS_RESOURCE_ID, value: toolsResource(toolsPort, model, CAPABILITIES_TOOLS_RESOURCE_ID, 'tools') }),
        Object.freeze({ id: CAPABILITIES_MCP_RESOURCE_ID, value: toolsResource(toolsPort, model, CAPABILITIES_MCP_RESOURCE_ID, 'mcp') }),
      ]),
      surfaces: Object.freeze([
        Object.freeze({
          id: CAPABILITIES_NAVIGATOR_SURFACE_ID,
          slot: 'workspace.content',
          value: Object.freeze({
            id: CAPABILITIES_NAVIGATOR_SURFACE_ID,
            role: 'content' as const,
            node: createCapabilitiesNavigatorNode(source),
            constraints: Object.freeze({ minColumns: 28, preferredColumns: 40, priority: 8 }),
          }),
        }),
      ]),
    })
    return Object.freeze({
      contributions,
      model,
      dispose: () => { model.dispose() },
    } satisfies CapabilitiesFeatureInstance)
  },
})
