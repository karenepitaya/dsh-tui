import {
  selectMcpCapabilityBrowser,
  type McpCapabilityBrowserView,
} from '../../mcp/capabilities.ts'
import type { SessionToolEntry, SessionToolsSnapshot } from '../../tool/port.ts'
import type { McpFeatureState } from './machine.ts'

function detachTool(tool: SessionToolEntry): SessionToolEntry {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    group: tool.group,
    parameterNames: Object.freeze([...tool.parameterNames]),
    requiredParameterNames: Object.freeze([...tool.requiredParameterNames]),
  })
}

export function detachMcpToolsSnapshot(snapshot: SessionToolsSnapshot): SessionToolsSnapshot {
  return Object.freeze({
    available: snapshot.available,
    stale: snapshot.stale,
    generation: snapshot.generation,
    tools: Object.freeze(snapshot.tools.map(detachTool)),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  })
}

export function projectMcpBrowser(
  state: McpFeatureState,
): McpCapabilityBrowserView | undefined {
  return state.snapshot === undefined
    ? undefined
    : selectMcpCapabilityBrowser(state.browser, state.snapshot)
}

