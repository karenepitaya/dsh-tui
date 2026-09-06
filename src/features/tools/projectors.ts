import type { SessionToolEntry, SessionToolsSnapshot } from '../../tool/port.ts'
import {
  selectToolBrowser,
  type ToolBrowserView,
} from '../../tool/browser.ts'
import type { ToolsFeatureState } from './machine.ts'

function detachTool(tool: SessionToolEntry): SessionToolEntry {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    group: tool.group,
    parameterNames: Object.freeze([...tool.parameterNames]),
    requiredParameterNames: Object.freeze([...tool.requiredParameterNames]),
  })
}

/** Detach the exact-Agent registry view before retaining it in Feature state. */
export function detachToolsSnapshot(snapshot: SessionToolsSnapshot): SessionToolsSnapshot {
  return Object.freeze({
    available: snapshot.available,
    stale: snapshot.stale,
    generation: snapshot.generation,
    tools: Object.freeze(snapshot.tools.map(detachTool)),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  })
}

export function projectToolsBrowser(
  state: ToolsFeatureState,
): ToolBrowserView | undefined {
  return state.snapshot === undefined
    ? undefined
    : selectToolBrowser(state.browser, state.snapshot)
}

