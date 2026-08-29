export type SessionToolGroup = 'core' | 'mcp' | 'transport'

/** Detached capability metadata from one exact live Agent's official registry view. */
export interface SessionToolEntry {
  readonly name: string
  readonly description: string
  readonly group: SessionToolGroup
  readonly parameterNames: readonly string[]
  readonly requiredParameterNames: readonly string[]
}

/** Last-good official ToolRuntime.schemas(agent) projection. */
export interface SessionToolsSnapshot {
  readonly available: boolean
  readonly stale: boolean
  readonly generation: number
  readonly tools: readonly SessionToolEntry[]
  readonly error?: string
}

/** Product-owned read-only seam over the official scoped ToolRuntime catalog. */
export interface SessionToolsPort {
  toolsSnapshot(): SessionToolsSnapshot
  onToolsChanged(listener: () => void): () => void
  disposeTools(): void
}

const UNAVAILABLE_TOOLS_SNAPSHOT: SessionToolsSnapshot = Object.freeze({
  available: false,
  stale: false,
  generation: 0,
  tools: Object.freeze([]),
})

/** Compatibility seam for non-DSH tests and embedders. */
export function createUnavailableSessionToolsPort(): SessionToolsPort {
  return {
    toolsSnapshot: () => UNAVAILABLE_TOOLS_SNAPSHOT,
    onToolsChanged: () => () => {},
    disposeTools: () => {},
  }
}
