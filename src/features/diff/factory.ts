import type {
  FeatureCommandContext,
  FeatureCommandHandler,
} from '../../app/feature-contribution-contract.ts'
import {
  FEATURE_API_VERSION,
  type FeatureCreateContext,
  type FeatureFactory,
  type ResolveRequirements,
} from '../../kernel/feature.ts'
import type { LayoutRegion } from '../../layout/strategy.ts'
import type { RoutedUiCommand } from '../../navigation/commands.ts'
import type { ResourceDefinition } from '../../resource/resource-coordinator.ts'
import {
  createDiffFeatureState,
  transitionDiffFeature,
  type DiffFeatureEvent,
  type DiffFeatureState,
} from './machine.ts'
import {
  createDiffContentNode,
  createDiffInspectorNode,
  type DiffStateSource,
  type DiffUiNode,
} from './nodes.ts'
import {
  projectDiffDocument,
  type DiffProjection,
  type DiffProjectionLimits,
  type DiffProjector,
} from './projectors.ts'
import {
  DIFF_WORKSPACE_CAPABILITY,
  type DiffContentReference,
  type DiffWorkspacePort,
} from './port.ts'

export const DIFF_FEATURE_ID = 'diff'
export const DIFF_ROUTE_ID = 'diff'
export const DIFF_CONTENT_RESOURCE_ID = 'diff.document'
export const DIFF_CONTENT_SURFACE_ID = 'diff.content'
export const DIFF_INSPECTOR_SURFACE_ID = 'diff.inspector'
export const DIFF_KEYMAP_ID = 'diff.normal'
export const DIFF_HUNK_PREVIOUS_COMMAND = 'diff.hunk.previous'
export const DIFF_HUNK_NEXT_COMMAND = 'diff.hunk.next'

export interface DiffFeatureKeyBinding {
  readonly key: '[' | ']'
  readonly commandId:
    | typeof DIFF_HUNK_PREVIOUS_COMMAND
    | typeof DIFF_HUNK_NEXT_COMMAND
}

export interface DiffFeatureKeymap {
  readonly context: {
    readonly routeKind: 'diff'
    readonly featureId: typeof DIFF_FEATURE_ID
    readonly mode: 'normal'
  }
  readonly bindings: readonly DiffFeatureKeyBinding[]
}

export interface DiffFeatureFactoryOptions {
  /** Injectable only for deterministic projection tests and product policy. */
  readonly project?: DiffProjector
  readonly limits?: Partial<DiffProjectionLimits>
}

type DiffRequirements = readonly [typeof DIFF_WORKSPACE_CAPABILITY]
type DiffCreateContext = FeatureCreateContext<ResolveRequirements<DiffRequirements>>

class DiffFeatureModel implements DiffStateSource {
  private current: DiffFeatureState = createDiffFeatureState()
  private readonly listeners = new Set<(state: DiffFeatureState) => void>()
  private active = true

  snapshot(): DiffFeatureState {
    return this.current
  }

  onChanged(listener: (state: DiffFeatureState) => void): () => void {
    if (!this.active) throw new Error('Diff Feature model is disposed')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispatch(event: DiffFeatureEvent): void {
    if (!this.active) return
    const transition = transitionDiffFeature(this.current, event)
    if (transition.state === this.current) return
    this.current = transition.state
    for (const listener of [...this.listeners]) {
      try {
        listener(this.current)
      } catch {
        // A renderer listener cannot poison the Feature state machine.
      }
    }
  }

  dispose(): void {
    if (!this.active) return
    this.active = false
    this.listeners.clear()
  }
}

export function createDiffFeatureFactory(
  options: DiffFeatureFactoryOptions = {},
): FeatureFactory<DiffRequirements> {
  const project = options.project ?? projectDiffDocument
  const limits = options.limits === undefined ? undefined : Object.freeze({ ...options.limits })
  const factory: FeatureFactory<DiffRequirements> = {
    manifest: Object.freeze({
      id: DIFF_FEATURE_ID,
      apiVersion: FEATURE_API_VERSION,
      scope: 'session',
      activation: 'on-route',
      required: false,
      requires: Object.freeze([DIFF_WORKSPACE_CAPABILITY] as const),
    }),
    declarations: Object.freeze({
      routes: Object.freeze([DIFF_ROUTE_ID]),
      commands: Object.freeze([
        'navigation.move',
        'navigation.page',
        'navigation.activate',
        DIFF_HUNK_PREVIOUS_COMMAND,
        DIFF_HUNK_NEXT_COMMAND,
      ]),
      keymaps: Object.freeze([DIFF_KEYMAP_ID]),
      resources: Object.freeze([DIFF_CONTENT_RESOURCE_ID]),
      surfaces: Object.freeze([
        Object.freeze({ slot: 'workspace.content', cardinality: 'multiple' as const }),
        Object.freeze({ slot: 'workspace.inspector', cardinality: 'multiple' as const }),
      ]),
    }),
    create: (context: DiffCreateContext) => {
      const port = context.dependencies[0].value
      const model = new DiffFeatureModel()
      let cached: DiffProjection | undefined
      const resource = createDiffResource(port, model, project, limits, () => cached, (value) => {
        cached = value
      })
      const state: DiffStateSource = Object.freeze({
        snapshot: () => model.snapshot(),
        onChanged: (listener: (state: DiffFeatureState) => void) => model.onChanged(listener),
      })
      const contentNode = createDiffContentNode(DIFF_CONTENT_RESOURCE_ID, state)
      const inspectorNode = createDiffInspectorNode(DIFF_CONTENT_RESOURCE_ID, state)
      const commands = createCommandHandlers(model)
      return {
        contributions: Object.freeze({
          routes: Object.freeze([Object.freeze({
            id: DIFF_ROUTE_ID,
            value: Object.freeze({
              kind: 'diff' as const,
              featureId: DIFF_FEATURE_ID,
              pane: 'content' as const,
            }),
          })]),
          commands: Object.freeze(Object.entries(commands).map(([id, value]) => Object.freeze({
            id,
            value,
          }))),
          keymaps: Object.freeze([Object.freeze({
            id: DIFF_KEYMAP_ID,
            value: DIFF_KEYMAP,
          })]),
          resources: Object.freeze([Object.freeze({
            id: DIFF_CONTENT_RESOURCE_ID,
            value: resource,
          })]),
          surfaces: Object.freeze([
            surface(DIFF_CONTENT_SURFACE_ID, 'workspace.content', 'content', contentNode, {
              minColumns: 60,
              preferredColumns: 100,
              priority: 20,
            }),
            surface(DIFF_INSPECTOR_SURFACE_ID, 'workspace.inspector', 'inspector', inspectorNode, {
              minColumns: 28,
              preferredColumns: 36,
              priority: 10,
            }),
          ]),
        }),
        dispose: () => {
          cached = undefined
          model.dispose()
        },
      }
    },
  }
  return Object.freeze(factory)
}

export const diffFeature = createDiffFeatureFactory()

const DIFF_KEYMAP: DiffFeatureKeymap = Object.freeze({
  context: Object.freeze({
    routeKind: 'diff',
    featureId: DIFF_FEATURE_ID,
    mode: 'normal',
  }),
  bindings: Object.freeze([
    Object.freeze({ key: '[', commandId: DIFF_HUNK_PREVIOUS_COMMAND }),
    Object.freeze({ key: ']', commandId: DIFF_HUNK_NEXT_COMMAND }),
  ]),
})

function createDiffResource(
  port: DiffWorkspacePort,
  model: DiffFeatureModel,
  project: DiffProjector,
  limits: Partial<DiffProjectionLimits> | undefined,
  readCache: () => DiffProjection | undefined,
  writeCache: (projection: DiffProjection) => void,
): ResourceDefinition<DiffProjection | null> {
  const definition: ResourceDefinition<DiffProjection | null> = {
    key: DIFF_CONTENT_RESOURCE_ID,
    lifetime: 'surface',
    activation: 'on-visible',
    cachePolicy: 'last-good',
    load: async ({ signal, previous }) => {
      model.dispatch({ type: 'load-started' })
      try {
        signal.throwIfAborted()
        const reference = await port.describeCurrent({ signal })
        signal.throwIfAborted()
        if (reference === null || reference === undefined) {
          model.dispatch({ type: 'load-empty' })
          return null
        }
        validateReference(reference)
        const cachedProjection = readCache()
        const reusable = previous?.digest === reference.digest
          ? previous
          : cachedProjection?.digest === reference.digest
            ? cachedProjection
            : undefined
        if (reusable !== undefined) {
          model.dispatch({ type: 'load-succeeded', projection: reusable })
          return reusable
        }
        const document = await port.compute({ reference, signal })
        signal.throwIfAborted()
        if (document.digest !== reference.digest) {
          throw new Error(
            `Diff document digest ${document.digest} does not match ${reference.digest}`,
          )
        }
        const projection = project(document, limits)
        if (projection.digest !== reference.digest) {
          throw new Error('Diff projector changed the content digest')
        }
        writeCache(projection)
        model.dispatch({ type: 'load-succeeded', projection })
        return projection
      } catch (error: unknown) {
        if (!signal.aborted) model.dispatch({ type: 'load-failed', error })
        throw error
      }
    },
    ...(port.watch === undefined ? {} : {
      watch: ({ signal, invalidate }) => port.watch!({ signal, invalidate }),
    }),
  }
  return Object.freeze(definition)
}

function validateReference(reference: DiffContentReference): void {
  if (reference.digest.length === 0 || reference.digest.trim() !== reference.digest) {
    throw new Error('Diff content digest must be a trimmed string')
  }
}

function createCommandHandlers(
  model: DiffFeatureModel,
): Readonly<Record<string, FeatureCommandHandler>> {
  return Object.freeze({
    'navigation.move': handler((command) => {
      if (command.command.type !== 'navigation.move') return undefined
      return { type: 'move', direction: command.command.direction }
    }, model),
    'navigation.page': handler((command) => {
      if (command.command.type !== 'navigation.page') return undefined
      return { type: 'page', direction: command.command.direction }
    }, model),
    'navigation.activate': handler((command) => (
      command.command.type === 'navigation.activate'
        ? { type: 'toggle-collapse' }
        : undefined
    ), model),
    [DIFF_HUNK_PREVIOUS_COMMAND]: handler(() => ({
      type: 'move-hunk', direction: 'previous',
    }), model),
    [DIFF_HUNK_NEXT_COMMAND]: handler(() => ({
      type: 'move-hunk', direction: 'next',
    }), model),
  })
}

function handler(
  event: (command: RoutedUiCommand) => DiffFeatureEvent | undefined,
  model: DiffFeatureModel,
): FeatureCommandHandler {
  return Object.freeze({
    handle(command: RoutedUiCommand, _context: FeatureCommandContext): void {
      const value = event(command)
      if (value !== undefined) model.dispatch(value)
    },
  })
}

function surface(
  id: string,
  slot: 'workspace.content' | 'workspace.inspector',
  role: 'content' | 'inspector',
  node: DiffUiNode,
  constraints: NonNullable<LayoutRegion['constraints']>,
) {
  const region: LayoutRegion<DiffUiNode> = Object.freeze({
    id,
    role,
    node,
    constraints: Object.freeze({ ...constraints }),
  })
  return Object.freeze({ id, slot, value: region })
}
