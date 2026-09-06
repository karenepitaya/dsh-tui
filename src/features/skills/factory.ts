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
import { SESSION_SKILLS_CAPABILITY } from '../../runtime/session-capabilities.ts'
import type { SessionSkillsPort, SessionSkillsSnapshot } from '../../skill/port.ts'
import {
  SKILLS_DETAIL_ROUTE_ID,
  SKILLS_RESOURCE_ID,
  type SkillsFeatureEffect,
  type SkillsFeatureEvent,
  type SkillsRequestStamp,
} from './machine.ts'
import {
  createSkillsFeatureModel,
  type SkillsFeatureModel,
  type SkillsFeatureStateSource,
} from './model.ts'
import {
  createSkillsContentNode,
  createSkillsNavigatorNode,
  type SkillsUiNode,
} from './nodes.ts'
import { detachSkillsSnapshot } from './projectors.ts'

export const SKILLS_FEATURE_ID = 'skills'
export const SKILLS_ROUTE_ID = 'skills'
export const SKILLS_NAVIGATOR_SURFACE_ID = 'skills.navigator'
export const SKILLS_CONTENT_SURFACE_ID = 'skills.content'
export const SKILLS_KEYMAP_ID = 'skills.normal'
export const SKILLS_MOVE_UP_COMMAND_ID = 'skills.selection.previous'
export const SKILLS_MOVE_DOWN_COMMAND_ID = 'skills.selection.next'
export const SKILLS_ACTIVATE_COMMAND_ID = 'skills.selection.activate'
export const SKILLS_REFRESH_COMMAND_ID = 'skills.refresh'

const SKILLS_REQUIREMENTS = Object.freeze([SESSION_SKILLS_CAPABILITY] as const)
const SKILLS_COMMAND_IDS = Object.freeze([
  'navigation.move',
  'navigation.page',
  'navigation.activate',
  'edit.insert',
  'edit.delete-backward',
  'action.submit',
  SKILLS_MOVE_UP_COMMAND_ID,
  SKILLS_MOVE_DOWN_COMMAND_ID,
  SKILLS_ACTIVATE_COMMAND_ID,
  SKILLS_REFRESH_COMMAND_ID,
] as const)

const SKILLS_KEYMAP: FeatureKeymap = Object.freeze({
  context: Object.freeze({
    routeKind: 'workspace' as const,
    featureId: SKILLS_FEATURE_ID,
    mode: 'normal' as const,
  }),
  bindings: Object.freeze([
    Object.freeze({ key: 'k', commandId: SKILLS_MOVE_UP_COMMAND_ID }),
    Object.freeze({ key: 'j', commandId: SKILLS_MOVE_DOWN_COMMAND_ID }),
    Object.freeze({ key: 'enter', commandId: SKILLS_ACTIVATE_COMMAND_ID }),
    Object.freeze({ key: 'r', commandId: SKILLS_REFRESH_COMMAND_ID }),
  ]),
})

export type SkillsFeatureContributions = FeatureContributions<
  NavigationRoute,
  FeatureCommandHandler,
  FeatureKeymap,
  ResourceDefinition<SessionSkillsSnapshot>,
  LayoutRegion<SkillsUiNode>
>

export interface SkillsFeatureInstance
  extends FeatureInstance<SkillsFeatureContributions> {
  readonly model: SkillsFeatureModel
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requestOf(context: ResourceLoadContext<SessionSkillsSnapshot>): SkillsRequestStamp {
  return Object.freeze({
    scopeEpoch: context.scope.epoch,
    requestId: context.requestId,
  })
}

function stateSource(model: SkillsFeatureModel): SkillsFeatureStateSource {
  return Object.freeze({
    snapshot: () => model.snapshot(),
    onChanged: (listener: Parameters<SkillsFeatureStateSource['onChanged']>[0]) => (
      model.onChanged(listener)
    ),
  })
}

function dropLastCodePoint(value: string): string {
  const points = [...value]
  points.pop()
  return points.join('')
}

function eventForCommand(
  model: SkillsFeatureModel,
  command: RoutedUiCommand,
): SkillsFeatureEvent | undefined {
  switch (command.command.type) {
    case 'navigation.move':
      return command.command.direction === 'up' || command.command.direction === 'down'
        ? { type: 'selection.move', direction: command.command.direction }
        : undefined
    case 'navigation.page':
      return {
        type: 'selection.move',
        direction: command.command.direction,
        amount: 8,
      }
    case 'navigation.activate':
    case 'action.submit':
      return { type: 'selection.activated' }
    case 'edit.insert':
      return { type: 'query.changed', query: model.snapshot().query + command.command.text }
    case 'edit.delete-backward':
      return { type: 'query.changed', query: dropLastCodePoint(model.snapshot().query) }
    case 'feature.command':
      switch (command.command.commandId) {
        case SKILLS_MOVE_UP_COMMAND_ID:
          return { type: 'selection.move', direction: 'up' }
        case SKILLS_MOVE_DOWN_COMMAND_ID:
          return { type: 'selection.move', direction: 'down' }
        case SKILLS_ACTIVATE_COMMAND_ID:
          return { type: 'selection.activated' }
        case SKILLS_REFRESH_COMMAND_ID:
          return { type: 'refresh.requested' }
        default:
          return undefined
      }
    default:
      return undefined
  }
}

async function runEffects(
  effects: readonly SkillsFeatureEffect[],
  context: FeatureCommandContext,
): Promise<void> {
  for (const effect of effects) {
    if (effect.type === 'route.open') await context.openRoute(effect.routeId)
  }
}

function commandHandler(model: SkillsFeatureModel): FeatureCommandHandler {
  return Object.freeze({
    handle: async (command: RoutedUiCommand, context: FeatureCommandContext) => {
      const event = eventForCommand(model, command)
      if (event === undefined) return
      await runEffects(model.dispatch(event), context)
    },
  })
}

function resource(
  port: SessionSkillsPort,
  model: SkillsFeatureModel,
): ResourceDefinition<SessionSkillsSnapshot> {
  return Object.freeze({
    key: SKILLS_RESOURCE_ID,
    lifetime: 'surface',
    activation: 'on-open',
    cachePolicy: 'last-good',
    load: async (context: ResourceLoadContext<SessionSkillsSnapshot>) => {
      const request = requestOf(context)
      model.dispatch({ type: 'load.started', request })
      try {
        await port.refreshSkills(context.signal)
        context.signal.throwIfAborted()
        const snapshot = detachSkillsSnapshot(port.skillsSnapshot())
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
      const stopSkills = port.onSkillsChanged(() => {
        if (!context.signal.aborted) snapshotChanged(port, model)
      })
      return () => {
        stopSkills()
        stopEffects()
      }
    },
  })
}

function route(id: string, pane: 'navigator' | 'content') {
  return Object.freeze({
    id,
    value: Object.freeze({
      kind: 'workspace' as const,
      featureId: SKILLS_FEATURE_ID,
      pane,
    }),
  })
}

function regions(
  state: SkillsFeatureStateSource,
): readonly LayoutRegion<SkillsUiNode>[] {
  return Object.freeze([
    Object.freeze({
      id: SKILLS_NAVIGATOR_SURFACE_ID,
      role: 'navigator' as const,
      node: createSkillsNavigatorNode(state),
      constraints: Object.freeze({ minColumns: 28, preferredColumns: 40, priority: 8 }),
    }),
    Object.freeze({
      id: SKILLS_CONTENT_SURFACE_ID,
      role: 'content' as const,
      node: createSkillsContentNode(state),
      constraints: Object.freeze({ minColumns: 52, preferredColumns: 88, priority: 12 }),
    }),
  ])
}

function snapshotChanged(
  port: SessionSkillsPort,
  model: SkillsFeatureModel,
): void {
  try {
    const snapshot = detachSkillsSnapshot(port.skillsSnapshot())
    model.dispatch({ type: 'snapshot.changed', snapshot })
    if (snapshot.available && !snapshot.complete && !snapshot.loading) {
      model.dispatch({ type: 'refresh.requested' })
    }
  } catch (error: unknown) {
    model.dispatch({ type: 'snapshot.failed', message: messageOf(error) })
  }
}

export const skillsFeature: FeatureFactory<
  typeof SKILLS_REQUIREMENTS,
  SkillsFeatureContributions
> = Object.freeze({
  manifest: Object.freeze({
    id: SKILLS_FEATURE_ID,
    apiVersion: FEATURE_API_VERSION,
    scope: 'session',
    activation: 'on-route',
    required: false,
    requires: SKILLS_REQUIREMENTS,
  }),
  declarations: Object.freeze({
    routes: Object.freeze([SKILLS_ROUTE_ID, SKILLS_DETAIL_ROUTE_ID]),
    commands: SKILLS_COMMAND_IDS,
    keymaps: Object.freeze([SKILLS_KEYMAP_ID]),
    resources: Object.freeze([SKILLS_RESOURCE_ID]),
    surfaces: Object.freeze([
      Object.freeze({ slot: 'workspace.navigator', cardinality: 'multiple' as const }),
      Object.freeze({ slot: 'workspace.content', cardinality: 'multiple' as const }),
    ]),
  }),
  create: ({ dependencies }: FeatureCreateContext<
    ResolveRequirements<typeof SKILLS_REQUIREMENTS>
  >) => {
    const port = dependencies[0].value
    const model = createSkillsFeatureModel()
    let disposed = false
    const source = stateSource(model)
    const [navigator, content] = regions(source)
    const handler = commandHandler(model)
    const catalog = resource(port, model)
    const contributions: SkillsFeatureContributions = Object.freeze({
      routes: Object.freeze([
        route(SKILLS_ROUTE_ID, 'navigator'),
        route(SKILLS_DETAIL_ROUTE_ID, 'content'),
      ]),
      commands: Object.freeze(SKILLS_COMMAND_IDS.map(id => Object.freeze({
        id,
        value: handler,
      }))),
      keymaps: Object.freeze([Object.freeze({ id: SKILLS_KEYMAP_ID, value: SKILLS_KEYMAP })]),
      resources: Object.freeze([Object.freeze({ id: SKILLS_RESOURCE_ID, value: catalog })]),
      surfaces: Object.freeze([
        Object.freeze({
          id: navigator!.id,
          slot: 'workspace.navigator',
          value: navigator!,
        }),
        Object.freeze({
          id: content!.id,
          slot: 'workspace.content',
          value: content!,
        }),
      ]),
    })
    return Object.freeze({
      contributions,
      model,
      dispose: () => {
        if (disposed) return
        disposed = true
        model.dispose()
      },
    } satisfies SkillsFeatureInstance)
  },
})
