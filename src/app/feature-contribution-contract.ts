import type {
  FeatureContribution,
  FeatureContributions,
  FeatureSurfaceContribution,
} from '../kernel/feature.ts'
import type { RegisteredFeatureSnapshot } from '../kernel/feature-registry.ts'
import type { FeatureRegistrationProvenance } from '../kernel/feature-registry.ts'
import type { LayoutRegion } from '../layout/strategy.ts'
import type { NavigationRoute } from '../navigation/state.ts'
import type {
  ResourceActivation,
  ResourceCachePolicy,
  ResourceDefinition,
} from '../resource/resource-coordinator.ts'
import type { ResourceScopeKind } from '../lifecycle/scope-manager.ts'

export type FeatureHostContractErrorCode =
  | 'invalid-route'
  | 'route-owner-mismatch'
  | 'invalid-command'
  | 'invalid-keymap'
  | 'invalid-resource'
  | 'invalid-surface'
  | 'single-slot-overflow'
  | 'missing-route'
  | 'ambiguous-route'

export class FeatureHostContractError extends Error {
  constructor(
    readonly code: FeatureHostContractErrorCode,
    readonly featureId: string,
    readonly contributionId: string,
    message: string,
  ) {
    super(message)
    this.name = 'FeatureHostContractError'
  }
}

export interface FeatureCommandContext {
  readonly navigation: import('../navigation/state.ts').NavigationState
  openRoute(routeId: string): Promise<void>
}

/** Runtime value stored in a Feature's command contribution. */
export interface FeatureCommandHandler {
  handle(
    command: import('../navigation/commands.ts').RoutedUiCommand,
    context: FeatureCommandContext,
  ): import('../kernel/capability.ts').MaybePromise<void>
}

export interface FeatureKeymapBinding {
  readonly key: string
  readonly commandId: string
  readonly ctrl?: true
  readonly alt?: true
  readonly shift?: true
}

export interface FeatureKeymap {
  readonly context: {
    readonly routeKind: NavigationRoute['kind']
    readonly featureId: string
    readonly mode: import('../navigation/state.ts').NavigationMode
  }
  readonly bindings: readonly FeatureKeymapBinding[]
}

const LAYOUT_ROLES: readonly LayoutRegion['role'][] = Object.freeze([
  'timeline',
  'navigator',
  'content',
  'inspector',
  'composer',
  'status',
  'overlay',
])

const RESOURCE_SCOPE_KINDS: readonly ResourceScopeKind[] = Object.freeze([
  'app',
  'session',
  'surface',
  'overlay',
  'request',
  'motion',
])
const RESOURCE_ACTIVATIONS: readonly ResourceActivation[] = Object.freeze([
  'eager',
  'on-open',
  'on-visible',
  'manual',
])
const RESOURCE_CACHE_POLICIES: readonly ResourceCachePolicy[] = Object.freeze([
  'none',
  'last-good',
])

/** Product semantic contract executed before a Feature becomes active. */
export function normalizeDshTuiFeatureContributions(
  factory: RegisteredFeatureSnapshot,
  contributions: FeatureContributions,
  provenance: FeatureRegistrationProvenance,
): FeatureContributions {
  const normalized: FeatureContributions = {
    ...(contributions.routes === undefined ? {} : {
      routes: normalizePlain(contributions.routes, contribution => ({
        id: contribution.id,
        value: requireNavigationRoute(
          factory.manifest.id,
          contribution.id,
          contribution.value,
          provenance.authority,
        ),
      })),
    }),
    ...(contributions.commands === undefined ? {} : {
      commands: normalizePlain(contributions.commands, contribution => ({
        id: contribution.id,
        value: requireCommandHandler(
          factory.manifest.id,
          contribution.id,
          contribution.value,
        ),
      })),
    }),
    ...(contributions.keymaps === undefined ? {} : {
      keymaps: normalizePlain(contributions.keymaps, contribution => ({
        id: contribution.id,
        value: requireFeatureKeymap(
          factory.manifest.id,
          contribution.id,
          contribution.value,
          factory.declarations.commands,
        ),
      })),
    }),
    ...(contributions.resources === undefined ? {} : {
      resources: normalizePlain(contributions.resources, contribution => ({
        id: contribution.id,
        value: requireResourceDefinition(
          factory.manifest.id,
          contribution.id,
          contribution.value,
        ),
      })),
    }),
    ...(contributions.surfaces === undefined ? {} : {
      surfaces: normalizeSurfaces(factory, contributions.surfaces),
    }),
  }
  return Object.freeze(normalized)
}

function normalizeSurfaces(
  factory: RegisteredFeatureSnapshot,
  contributions: readonly FeatureSurfaceContribution[],
): readonly FeatureSurfaceContribution<LayoutRegion>[] {
  const counts = new Map<string, number>()
  for (const contribution of contributions) {
    const count = (counts.get(contribution.slot) ?? 0) + 1
    counts.set(contribution.slot, count)
    const declaration = factory.declarations.surfaces.find(
      candidate => candidate.slot === contribution.slot,
    )
    if (declaration?.cardinality === 'single' && count > 1) {
      throw new FeatureHostContractError(
        'single-slot-overflow',
        factory.manifest.id,
        contribution.id,
        `Feature "${factory.manifest.id}" contributed more than one surface to single slot "${contribution.slot}"`,
      )
    }
  }
  return Object.freeze(contributions.map(contribution => Object.freeze({
    id: contribution.id,
    slot: contribution.slot,
    value: requireLayoutRegion(
      factory.manifest.id,
      contribution.id,
      contribution.value,
    ),
  } satisfies FeatureSurfaceContribution<LayoutRegion>)))
}

function normalizePlain<TValue>(
  contributions: readonly FeatureContribution[],
  normalize: (contribution: FeatureContribution) => FeatureContribution<TValue>,
): readonly FeatureContribution<TValue>[] {
  return Object.freeze(contributions.map(contribution => Object.freeze(normalize(contribution))))
}

export function requireNavigationRoute(
  featureId: string,
  contributionId: string,
  value: unknown,
  authority: FeatureRegistrationProvenance['authority'],
): NavigationRoute {
  if (value === null || typeof value !== 'object') {
    throw invalidContribution('invalid-route', featureId, contributionId, 'route')
  }
  const route = value as Partial<NavigationRoute>
  if (route.kind === 'chat') {
    if (authority !== 'core') {
      throw new FeatureHostContractError(
        'route-owner-mismatch',
        featureId,
        contributionId,
        `Extension feature "${featureId}" cannot own the Chat route`,
      )
    }
    return Object.freeze({ kind: 'chat' })
  }
  if (route.kind === 'diff'
    && trimmed(route.featureId)
    && (route.pane === 'content' || route.pane === 'inspector')) {
    assertRouteOwner(featureId, contributionId, route.featureId)
    return Object.freeze({ kind: 'diff', featureId: route.featureId, pane: route.pane })
  }
  if (route.kind === 'workspace'
    && trimmed(route.featureId)
    && (route.pane === 'navigator' || route.pane === 'content' || route.pane === 'inspector')) {
    assertRouteOwner(featureId, contributionId, route.featureId)
    return Object.freeze({ kind: 'workspace', featureId: route.featureId, pane: route.pane })
  }
  throw invalidContribution('invalid-route', featureId, contributionId, 'route')
}

function assertRouteOwner(
  featureId: string,
  contributionId: string,
  routeFeatureId: string,
): void {
  if (routeFeatureId === featureId) return
  throw new FeatureHostContractError(
    'route-owner-mismatch',
    featureId,
    contributionId,
    `Route "${contributionId}" claims feature "${routeFeatureId}" instead of "${featureId}"`,
  )
}

export function requireCommandHandler(
  featureId: string,
  contributionId: string,
  value: unknown,
): FeatureCommandHandler {
  if (value === null || typeof value !== 'object'
    || typeof (value as Partial<FeatureCommandHandler>).handle !== 'function') {
    throw invalidContribution('invalid-command', featureId, contributionId, 'command')
  }
  return value as FeatureCommandHandler
}

export function requireFeatureKeymap(
  featureId: string,
  contributionId: string,
  value: unknown,
  declaredCommands: readonly string[] = [],
): FeatureKeymap {
  if (value === null || typeof value !== 'object') {
    throw invalidContribution('invalid-keymap', featureId, contributionId, 'keymap')
  }
  const keymap = value as Partial<FeatureKeymap>
  const context = keymap.context
  if (context === null || typeof context !== 'object'
    || (context.routeKind !== 'chat'
      && context.routeKind !== 'workspace'
      && context.routeKind !== 'diff')
    || context.featureId !== featureId
    || (context.mode !== 'normal' && context.mode !== 'insert')
    || !Array.isArray(keymap.bindings)
    || keymap.bindings.length === 0) {
    throw invalidContribution('invalid-keymap', featureId, contributionId, 'keymap')
  }

  const seen = new Set<string>()
  const bindings = keymap.bindings.map((candidate) => {
    if (candidate === null || typeof candidate !== 'object') {
      throw invalidContribution('invalid-keymap', featureId, contributionId, 'keymap')
    }
    const binding = candidate as Partial<FeatureKeymapBinding>
    if (!trimmed(binding.key)
      || !trimmed(binding.commandId)
      || !declaredCommands.includes(binding.commandId)
      || (binding.ctrl !== undefined && binding.ctrl !== true)
      || (binding.alt !== undefined && binding.alt !== true)
      || (binding.shift !== undefined && binding.shift !== true)) {
      throw invalidContribution('invalid-keymap', featureId, contributionId, 'keymap')
    }
    const identity = [
      binding.ctrl === true ? 'C' : '',
      binding.alt === true ? 'A' : '',
      binding.shift === true ? 'S' : '',
      binding.key,
    ].join(':')
    if (seen.has(identity)) {
      throw invalidContribution('invalid-keymap', featureId, contributionId, 'keymap')
    }
    seen.add(identity)
    return Object.freeze({
      key: binding.key,
      commandId: binding.commandId,
      ...(binding.ctrl === true ? { ctrl: true as const } : {}),
      ...(binding.alt === true ? { alt: true as const } : {}),
      ...(binding.shift === true ? { shift: true as const } : {}),
    })
  })
  return Object.freeze({
    context: Object.freeze({
      routeKind: context.routeKind,
      featureId: context.featureId,
      mode: context.mode,
    }),
    bindings: Object.freeze(bindings),
  })
}

/** Validate resource metadata without executing its loader, watcher, or value renderer. */
export function requireResourceDefinition(
  featureId: string,
  contributionId: string,
  value: unknown,
): ResourceDefinition<unknown> {
  if (value === null || typeof value !== 'object') {
    throw invalidContribution('invalid-resource', featureId, contributionId, 'resource')
  }
  const resource = value as Partial<ResourceDefinition<unknown>>
  const activation = resource.activation
  const lifetime = resource.lifetime
  if (resource.key !== contributionId
    || !RESOURCE_SCOPE_KINDS.includes(lifetime as ResourceScopeKind)
    || !RESOURCE_ACTIVATIONS.includes(activation as ResourceActivation)
    || !RESOURCE_CACHE_POLICIES.includes(resource.cachePolicy as ResourceCachePolicy)
    || typeof resource.load !== 'function'
    || (resource.watch !== undefined && typeof resource.watch !== 'function')
    || ((activation === 'on-open' || activation === 'on-visible') && lifetime !== 'surface')) {
    throw invalidContribution('invalid-resource', featureId, contributionId, 'resource')
  }
  return value as ResourceDefinition<unknown>
}

export function requireLayoutRegion(
  featureId: string,
  contributionId: string,
  value: unknown,
): LayoutRegion {
  if (value === null || typeof value !== 'object') {
    throw invalidContribution('invalid-surface', featureId, contributionId, 'surface')
  }
  const region = value as Partial<LayoutRegion>
  if (!trimmed(region.id) || region.id !== contributionId
    || typeof region.role !== 'string'
    || !LAYOUT_ROLES.includes(region.role as LayoutRegion['role'])
    || !Object.prototype.hasOwnProperty.call(region, 'node')) {
    throw invalidContribution('invalid-surface', featureId, contributionId, 'surface')
  }
  return Object.freeze({
    id: region.id,
    role: region.role as LayoutRegion['role'],
    node: region.node,
    ...(region.constraints === undefined
      ? {}
      : { constraints: Object.freeze({ ...region.constraints }) }),
  })
}

function invalidContribution(
  code: FeatureHostContractErrorCode,
  featureId: string,
  contributionId: string,
  kind: string,
): FeatureHostContractError {
  return new FeatureHostContractError(
    code,
    featureId,
    contributionId,
    `Feature "${featureId}" contributed an invalid ${kind} "${contributionId}"`,
  )
}

function trimmed(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}
