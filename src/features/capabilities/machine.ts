import {
  createSkillsFeatureState,
  transitionSkillsFeature,
  type SkillsFeatureEvent,
  type SkillsFeatureState,
} from './skills-machine.ts'
import {
  createToolsFeatureState,
  transitionToolsFeature,
  type ToolsFeatureEvent,
  type ToolsFeatureState,
} from './tools-machine.ts'
import {
  createMcpFeatureState,
  transitionMcpFeature,
  type McpFeatureEvent,
  type McpFeatureState,
} from './mcp-machine.ts'
import { projectCapabilitiesDetails } from './details.ts'

export const CAPABILITIES_SKILLS_RESOURCE_ID = 'skills.catalog'
export const CAPABILITIES_TOOLS_RESOURCE_ID = 'tools.catalog'
export const CAPABILITIES_MCP_RESOURCE_ID = 'mcp.catalog'

export type CapabilityTab = 'skills' | 'tools' | 'mcp'
export const CAPABILITY_TABS: readonly CapabilityTab[] = Object.freeze(['skills', 'tools', 'mcp'])

/** In-page read-only inspector modal; the item is always the active tab selection. */
export interface CapabilitiesDetailsState {
  readonly fieldIndex: number
}

export interface CapabilitiesFeatureState {
  readonly tab: CapabilityTab
  readonly skills: SkillsFeatureState
  readonly tools: ToolsFeatureState
  readonly mcp: McpFeatureState
  readonly details?: CapabilitiesDetailsState
}

export type CapabilitiesFeatureEvent =
  | { readonly type: 'tab.next' }
  | { readonly type: 'tab.previous' }
  | { readonly type: 'tab.set'; readonly tab: CapabilityTab }
  | { readonly type: 'details.open' }
  | { readonly type: 'details.close' }
  | { readonly type: 'details.move'; readonly direction: 'up' | 'down'; readonly amount?: number }
  | { readonly type: 'page.back' }
  | { readonly type: 'skills'; readonly event: SkillsFeatureEvent }
  | { readonly type: 'tools'; readonly event: ToolsFeatureEvent }
  | { readonly type: 'mcp'; readonly event: McpFeatureEvent }

export type CapabilitiesFeatureEffect =
  | {
      readonly type: 'resource.refresh'
      readonly resourceId:
        | typeof CAPABILITIES_SKILLS_RESOURCE_ID
        | typeof CAPABILITIES_TOOLS_RESOURCE_ID
        | typeof CAPABILITIES_MCP_RESOURCE_ID
    }
  | { readonly type: 'route.open'; readonly routeId: 'chat' }

export interface CapabilitiesFeatureTransition {
  readonly state: CapabilitiesFeatureState
  readonly effects: readonly CapabilitiesFeatureEffect[]
}

const NO_EFFECTS: readonly CapabilitiesFeatureEffect[] = Object.freeze([])

function transition(
  state: CapabilitiesFeatureState,
  effects: readonly CapabilitiesFeatureEffect[] = NO_EFFECTS,
): CapabilitiesFeatureTransition {
  return Object.freeze({ state, effects: Object.freeze([...effects]) })
}

function tabAt(index: number): CapabilityTab {
  return CAPABILITY_TABS[((index % CAPABILITY_TABS.length) + CAPABILITY_TABS.length) % CAPABILITY_TABS.length]!
}

export function createCapabilitiesFeatureState(): CapabilitiesFeatureState {
  return Object.freeze({
    tab: 'skills',
    skills: createSkillsFeatureState(),
    tools: createToolsFeatureState(),
    mcp: createMcpFeatureState(),
  })
}

function withDetails(
  state: CapabilitiesFeatureState,
  details: CapabilitiesDetailsState | undefined,
): CapabilitiesFeatureState {
  return Object.freeze(details === undefined
    ? { tab: state.tab, skills: state.skills, tools: state.tools, mcp: state.mcp }
    : { ...state, details: Object.freeze({ ...details }) })
}

/** The embedded pure machines own their domain state; the wrapper owns only tab routing. */
export function transitionCapabilitiesFeature(
  state: CapabilitiesFeatureState,
  event: CapabilitiesFeatureEvent,
): CapabilitiesFeatureTransition {
  switch (event.type) {
    case 'tab.next':
    case 'tab.previous': {
      const delta = event.type === 'tab.next' ? 1 : -1
      const tab = tabAt(CAPABILITY_TABS.indexOf(state.tab) + delta)
      return tab === state.tab && state.details === undefined
        ? transition(state)
        : transition(withDetails(Object.freeze({ ...state, tab }), undefined))
    }
    case 'tab.set':
      return event.tab === state.tab && state.details === undefined
        ? transition(state)
        : transition(withDetails(Object.freeze({ ...state, tab: event.tab }), undefined))
    case 'details.open': {
      if (state.details !== undefined) return transition(state)
      if (projectCapabilitiesDetails(state) === undefined) return transition(state)
      return transition(withDetails(state, { fieldIndex: 0 }))
    }
    case 'details.close':
      return state.details === undefined
        ? transition(state)
        : transition(withDetails(state, undefined))
    case 'details.move': {
      const details = state.details
      if (details === undefined) return transition(state)
      const count = projectCapabilitiesDetails(state)?.fields.length ?? 0
      if (count === 0) return transition(state)
      const requested = event.amount ?? 1
      const amount = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1
      const fieldIndex = Math.max(0, Math.min(count - 1,
        details.fieldIndex + (event.direction === 'up' ? -amount : amount)))
      return fieldIndex === details.fieldIndex
        ? transition(state)
        : transition(withDetails(state, { fieldIndex }))
    }
    case 'page.back':
      return transition(state, [Object.freeze({ type: 'route.open' as const, routeId: 'chat' as const })])
    case 'skills': {
      const next = transitionSkillsFeature(state.skills, event.event)
      const effects: CapabilitiesFeatureEffect[] = next.effects.flatMap((effect) => {
        /* The in-page details modal replaced the standalone detail route. */
        if (effect.type === 'route.open') return []
        return [Object.freeze({ type: 'resource.refresh' as const, resourceId: CAPABILITIES_SKILLS_RESOURCE_ID })]
      })
      return transition(
        next.state === state.skills ? state : Object.freeze({ ...state, skills: next.state }),
        effects,
      )
    }
    case 'tools': {
      const next = transitionToolsFeature(state.tools, event.event)
      return transition(
        next.state === state.tools ? state : Object.freeze({ ...state, tools: next.state }),
        next.effects.map(() => Object.freeze({
          type: 'resource.refresh' as const,
          resourceId: CAPABILITIES_TOOLS_RESOURCE_ID,
        })),
      )
    }
    case 'mcp': {
      const next = transitionMcpFeature(state.mcp, event.event)
      return transition(
        next.state === state.mcp ? state : Object.freeze({ ...state, mcp: next.state }),
        next.effects.map(() => Object.freeze({
          type: 'resource.refresh' as const,
          resourceId: CAPABILITIES_MCP_RESOURCE_ID,
        })),
      )
    }
    /* v8 ignore next 2 -- CapabilitiesFeatureEvent is exhausted above. */
    default:
      return assertNever(event)
  }
}

/* v8 ignore next 3 -- exported discriminated union is exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Capabilities Feature event: ${String(value)}`)
}
