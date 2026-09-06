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
import {
  SETTINGS_RESOURCE_ID,
  type SettingsFeatureEffect,
  type SettingsFeatureEvent,
  type SettingsRequestStamp,
} from './machine.ts'
import {
  createSettingsFeatureModel,
  type SettingsFeatureModel,
  type SettingsStateListener,
} from './model.ts'
import {
  createSettingsContentNode,
  type SettingsContentNode,
} from './nodes.ts'
import {
  detachSettingsFeatureSnapshot,
  type SettingsFeatureSnapshot,
} from './projectors.ts'
import {
  DSH_TUI_PREFERENCES_CAPABILITY,
  type DshTuiPreferencesApplicationPort,
} from '../../preferences/port.ts'

export const SETTINGS_FEATURE_ID = 'settings'
export const SETTINGS_ROUTE_ID = 'preferences'
export const SETTINGS_CONTENT_SURFACE_ID = 'settings.content'
export const SETTINGS_KEYMAP_ID = 'settings.normal'
export const SETTINGS_MOVE_UP_COMMAND_ID = 'settings.selection.previous'
export const SETTINGS_MOVE_DOWN_COMMAND_ID = 'settings.selection.next'
export const SETTINGS_CYCLE_PREVIOUS_COMMAND_ID = 'settings.value.previous'
export const SETTINGS_CYCLE_NEXT_COMMAND_ID = 'settings.value.next'
export const SETTINGS_ACTIVATE_COMMAND_ID = 'settings.value.activate'
export const SETTINGS_REFRESH_COMMAND_ID = 'settings.refresh'

const SETTINGS_REQUIREMENTS = Object.freeze([
  DSH_TUI_PREFERENCES_CAPABILITY,
] as const)

const SETTINGS_COMMAND_IDS = Object.freeze([
  'navigation.move',
  'navigation.activate',
  SETTINGS_MOVE_UP_COMMAND_ID,
  SETTINGS_MOVE_DOWN_COMMAND_ID,
  SETTINGS_CYCLE_PREVIOUS_COMMAND_ID,
  SETTINGS_CYCLE_NEXT_COMMAND_ID,
  SETTINGS_ACTIVATE_COMMAND_ID,
  SETTINGS_REFRESH_COMMAND_ID,
] as const)

const SETTINGS_KEYMAP: FeatureKeymap = Object.freeze({
  context: Object.freeze({
    routeKind: 'workspace' as const,
    featureId: SETTINGS_FEATURE_ID,
    mode: 'normal' as const,
  }),
  bindings: Object.freeze([
    Object.freeze({ key: 'k', commandId: SETTINGS_MOVE_UP_COMMAND_ID }),
    Object.freeze({ key: 'j', commandId: SETTINGS_MOVE_DOWN_COMMAND_ID }),
    Object.freeze({ key: 'enter', commandId: SETTINGS_ACTIVATE_COMMAND_ID }),
    Object.freeze({ key: 'r', commandId: SETTINGS_REFRESH_COMMAND_ID }),
  ]),
})

export type SettingsFeatureContributions = FeatureContributions<
  NavigationRoute,
  FeatureCommandHandler,
  FeatureKeymap,
  ResourceDefinition<SettingsFeatureSnapshot>,
  LayoutRegion<SettingsContentNode>
>

export interface SettingsFeatureInstance
  extends FeatureInstance<SettingsFeatureContributions> {
  readonly model: SettingsFeatureModel
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requestOf(
  context: ResourceLoadContext<SettingsFeatureSnapshot>,
): SettingsRequestStamp {
  return Object.freeze({
    scopeEpoch: context.scope.epoch,
    requestId: context.requestId,
  })
}

async function readSnapshot(
  port: DshTuiPreferencesApplicationPort,
): Promise<SettingsFeatureSnapshot> {
  const snapshot = await port.read()
  return detachSettingsFeatureSnapshot({
    status: port.status(),
    revision: snapshot.revision,
    preferences: snapshot.preferences,
  })
}

function resource(
  port: DshTuiPreferencesApplicationPort,
  model: SettingsFeatureModel,
): ResourceDefinition<SettingsFeatureSnapshot> {
  return Object.freeze({
    key: SETTINGS_RESOURCE_ID,
    lifetime: 'surface',
    activation: 'on-open',
    cachePolicy: 'last-good',
    load: async (context: ResourceLoadContext<SettingsFeatureSnapshot>) => {
      const request = requestOf(context)
      model.dispatch({ type: 'load.started', request })
      try {
        const snapshot = await readSnapshot(port)
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
      model.dispatch({ type: 'editing.reset' })
      const stopEffects = model.onEffect((effect) => {
        if (effect.type === 'resource.refresh' && !context.signal.aborted) {
          context.invalidate()
        }
      })
      const stopPreferences = port.onChanged(() => {
        if (!context.signal.aborted) context.invalidate()
      })
      return () => {
        stopPreferences()
        stopEffects()
      }
    },
  })
}

function eventForCommand(
  command: RoutedUiCommand,
  model: SettingsFeatureModel,
  nextWriteRequestId: () => number,
): SettingsFeatureEvent | undefined {
  switch (command.command.type) {
    case 'navigation.move':
      if (command.command.direction === 'up' || command.command.direction === 'down') {
        return { type: 'selection.move', direction: command.command.direction }
      }
      if (!model.snapshot().editing) return undefined
      return {
        type: 'preference.cycle',
        direction: command.command.direction === 'left' ? 'previous' : 'next',
        requestId: nextWriteRequestId(),
      }
    case 'navigation.activate':
      return { type: 'editing.toggle' }
    case 'feature.command':
      switch (command.command.commandId) {
        case SETTINGS_MOVE_UP_COMMAND_ID:
          return { type: 'selection.move', direction: 'up' }
        case SETTINGS_MOVE_DOWN_COMMAND_ID:
          return { type: 'selection.move', direction: 'down' }
        case SETTINGS_CYCLE_PREVIOUS_COMMAND_ID:
          return {
            type: 'preference.cycle',
            direction: 'previous',
            requestId: nextWriteRequestId(),
          }
        case SETTINGS_CYCLE_NEXT_COMMAND_ID:
          return {
            type: 'preference.cycle',
            direction: 'next',
            requestId: nextWriteRequestId(),
          }
        case SETTINGS_ACTIVATE_COMMAND_ID:
          return { type: 'editing.toggle' }
        case SETTINGS_REFRESH_COMMAND_ID:
          return { type: 'refresh.requested' }
        default:
          return undefined
      }
    default:
      return undefined
  }
}

async function runEffects(
  effects: readonly SettingsFeatureEffect[],
  port: DshTuiPreferencesApplicationPort,
  model: SettingsFeatureModel,
  inactive: () => boolean,
): Promise<void> {
  for (const effect of effects) {
    if (effect.type !== 'preferences.write') continue
    try {
      const written = await port.write(effect.expectedRevision, effect.preferences)
      if (inactive()) continue
      model.dispatch({
        type: 'save.succeeded',
        requestId: effect.requestId,
        snapshot: {
          status: port.status(),
          revision: written.revision,
          preferences: written.preferences,
        },
      })
    } catch (error: unknown) {
      if (inactive()) continue
      model.dispatch({
        type: 'save.failed',
        requestId: effect.requestId,
        message: messageOf(error),
      })
      model.dispatch({ type: 'refresh.requested' })
    }
  }
}

function commandHandler(
  port: DshTuiPreferencesApplicationPort,
  model: SettingsFeatureModel,
  nextWriteRequestId: () => number,
  inactive: () => boolean,
): FeatureCommandHandler {
  return Object.freeze({
    handle: async (command: RoutedUiCommand) => {
      const event = eventForCommand(command, model, nextWriteRequestId)
      if (event === undefined) return
      await runEffects(model.dispatch(event), port, model, inactive)
    },
  })
}

export const settingsFeature: FeatureFactory<
  typeof SETTINGS_REQUIREMENTS,
  SettingsFeatureContributions
> = Object.freeze({
  manifest: Object.freeze({
    id: SETTINGS_FEATURE_ID,
    apiVersion: FEATURE_API_VERSION,
    scope: 'application',
    activation: 'on-route',
    required: false,
    requires: SETTINGS_REQUIREMENTS,
  }),
  declarations: Object.freeze({
    routes: Object.freeze([SETTINGS_ROUTE_ID]),
    commands: SETTINGS_COMMAND_IDS,
    keymaps: Object.freeze([SETTINGS_KEYMAP_ID]),
    resources: Object.freeze([SETTINGS_RESOURCE_ID]),
    surfaces: Object.freeze([
      Object.freeze({ slot: 'workspace.content', cardinality: 'multiple' as const }),
    ]),
  }),
  create: ({ scope, dependencies }: FeatureCreateContext<
    ResolveRequirements<typeof SETTINGS_REQUIREMENTS>
  >) => {
    const port = dependencies[0].value
    const model = createSettingsFeatureModel()
    let writeRequestId = 0
    let disposed = false
    const handler = commandHandler(
      port,
      model,
      () => ++writeRequestId,
      () => disposed || scope.signal.aborted,
    )
    const node = createSettingsContentNode(Object.freeze({
      snapshot: () => model.snapshot(),
      onChanged: (listener: SettingsStateListener) => model.onChanged(listener),
    }))
    const region: LayoutRegion<SettingsContentNode> = Object.freeze({
      id: SETTINGS_CONTENT_SURFACE_ID,
      role: 'content',
      node,
      constraints: Object.freeze({ minColumns: 48, preferredColumns: 82, priority: 12 }),
    })
    const contributions: SettingsFeatureContributions = Object.freeze({
      routes: Object.freeze([Object.freeze({
        id: SETTINGS_ROUTE_ID,
        value: Object.freeze({
          kind: 'workspace' as const,
          featureId: SETTINGS_FEATURE_ID,
          pane: 'content' as const,
        }),
      })]),
      commands: Object.freeze(SETTINGS_COMMAND_IDS.map(id => Object.freeze({
        id,
        value: handler,
      }))),
      keymaps: Object.freeze([Object.freeze({ id: SETTINGS_KEYMAP_ID, value: SETTINGS_KEYMAP })]),
      resources: Object.freeze([Object.freeze({
        id: SETTINGS_RESOURCE_ID,
        value: resource(port, model),
      })]),
      surfaces: Object.freeze([Object.freeze({
        id: SETTINGS_CONTENT_SURFACE_ID,
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
        writeRequestId += 1
        model.dispose()
      },
    } satisfies SettingsFeatureInstance)
  },
})
