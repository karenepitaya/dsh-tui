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

export const CAPABILITIES_SKILLS_RESOURCE_ID = 'skills.catalog'
export const CAPABILITIES_TOOLS_RESOURCE_ID = 'tools.catalog'
export const CAPABILITIES_MCP_RESOURCE_ID = 'mcp.catalog'
export const CAPABILITIES_DETAIL_ROUTE_ID = 'capabilities.detail'

export type CapabilityTab = 'skills' | 'tools' | 'mcp'
export const CAPABILITY_TABS: readonly CapabilityTab[] = Object.freeze(['skills', 'tools', 'mcp'])

export interface CapabilitiesFeatureState {
  readonly tab: CapabilityTab
  readonly skills: SkillsFeatureState
  readonly tools: ToolsFeatureState
  readonly mcp: McpFeatureState
}

export type CapabilitiesFeatureEvent =
  | { readonly type: 'tab.next' }
  | { readonly type: 'tab.previous' }
  | { readonly type: 'tab.set'; readonly tab: CapabilityTab }
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
  | { readonly type: 'route.open'; readonly routeId: typeof CAPABILITIES_DETAIL_ROUTE_ID }

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
      return tab === state.tab ? transition(state) : transition(Object.freeze({ ...state, tab }))
    }
    case 'tab.set':
      return event.tab === state.tab
        ? transition(state)
        : transition(Object.freeze({ ...state, tab: event.tab }))
    case 'skills': {
      const next = transitionSkillsFeature(state.skills, event.event)
      const effects: CapabilitiesFeatureEffect[] = next.effects.map((effect) => {
        if (effect.type === 'route.open') {
          return Object.freeze({ type: 'route.open' as const, routeId: CAPABILITIES_DETAIL_ROUTE_ID })
        }
        return Object.freeze({ type: 'resource.refresh' as const, resourceId: CAPABILITIES_SKILLS_RESOURCE_ID })
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
