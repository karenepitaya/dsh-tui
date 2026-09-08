import type { CommandMenuCandidate } from '../command/menu.ts'
import type { DshCommandDescriptor } from '../command/port.ts'

/** Declared route metadata needed to expose one route through the command menu. */
export interface FeatureRouteCommandSource {
  readonly id: string
  readonly featureId: string
}

/** Narrow navigation seam; concrete Feature Host ownership stays outside the bridge. */
export interface FeatureRouteCommandHost {
  openRoute(routeId: string): Promise<void>
}

export type FeatureRouteCommandDispatch =
  | { readonly kind: 'not-feature-route' }
  | {
      readonly kind: 'invalid-input'
      readonly routeId: string
      readonly command: DshCommandDescriptor
    }
  | {
      readonly kind: 'opened'
      readonly routeId: string
      readonly completion: Promise<void>
    }

export interface FeatureRouteCommandBridge {
  readonly candidates: readonly CommandMenuCandidate[]
  tryOpen(
    line: string,
    host: FeatureRouteCommandHost,
  ): FeatureRouteCommandDispatch
}

interface FeatureRouteCommandEntry {
  readonly routeId: string
  readonly candidate: CommandMenuCandidate
}

const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u
const COMMAND_LINE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u
const NOT_FEATURE_ROUTE: FeatureRouteCommandDispatch = Object.freeze({
  kind: 'not-feature-route',
})

function compareCommandSources(
  left: FeatureRouteCommandSource,
  right: FeatureRouteCommandSource,
): number {
  // Ambiguous ids are removed before sorting, so the comparator only receives
  // distinct safe ASCII tokens.
  return left.id < right.id ? -1 : 1
}

function commandEntry(source: FeatureRouteCommandSource): FeatureRouteCommandEntry {
  const command: DshCommandDescriptor = Object.freeze({
    name: source.id,
    description: `Open ${source.featureId}`,
  })
  return Object.freeze({
    routeId: source.id,
    candidate: Object.freeze({ origin: 'local', command }),
  })
}

/**
 * Project declared Feature routes into the existing slash-command surface.
 * Unsafe, ambiguous, and already claimed names remain owned by their source.
 */
export function createFeatureRouteCommandBridge(
  routes: readonly FeatureRouteCommandSource[],
  occupiedCommands: readonly DshCommandDescriptor[],
): FeatureRouteCommandBridge {
  const occupiedNames = new Set(occupiedCommands.map(command => command.name))
  const routeCounts = new Map<string, number>()
  for (const route of routes) {
    if (!COMMAND_NAME.test(route.id)) continue
    routeCounts.set(route.id, (routeCounts.get(route.id) ?? 0) + 1)
  }
  const entries = Object.freeze(routes
    .filter(route => COMMAND_NAME.test(route.id))
    .filter(route => routeCounts.get(route.id) === 1 && !occupiedNames.has(route.id))
    .sort(compareCommandSources)
    .map(commandEntry))
  const candidates = Object.freeze(entries.map(entry => entry.candidate))

  return Object.freeze({
    candidates,
    tryOpen: (
      line: string,
      host: FeatureRouteCommandHost,
    ): FeatureRouteCommandDispatch => {
      const match = COMMAND_LINE.exec(line)
      if (match === null) return NOT_FEATURE_ROUTE
      const name = match[1] as string
      const entry = entries.find(candidate => candidate.candidate.command.name === name)
      if (entry === undefined) return NOT_FEATURE_ROUTE
      if (line.length !== name.length + 1) {
        return Object.freeze({
          kind: 'invalid-input',
          routeId: entry.routeId,
          command: entry.candidate.command,
        })
      }
      return Object.freeze({
        kind: 'opened',
        routeId: entry.routeId,
        completion: host.openRoute(entry.routeId),
      })
    },
  })
}
