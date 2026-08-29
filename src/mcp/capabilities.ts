import type { SessionToolEntry, SessionToolsSnapshot } from '../tool/port.ts'
import {
  applyToolBrowserAction,
  createToolBrowserState,
  openToolBrowser,
  reconcileToolBrowser,
  selectToolBrowser,
  type ToolBrowserAction,
  type ToolBrowserState,
  type ToolBrowserTransition,
} from '../tool/browser.ts'

export type McpCapabilityBrowserState = ToolBrowserState

export interface McpCapabilityRow extends SessionToolEntry {
  readonly serverName: string
  readonly toolName: string
}

export interface McpCapabilityBrowserView {
  readonly query: ToolBrowserState['query']
  readonly rows: readonly McpCapabilityRow[]
  readonly selectedIndex: number
  readonly selected?: McpCapabilityRow
  readonly totalCount: number
  readonly namespaceCount: number
  readonly available: boolean
  readonly stale: boolean
  readonly generation: number
  readonly error?: string
}

function mcpSnapshot(snapshot: SessionToolsSnapshot): SessionToolsSnapshot {
  return Object.freeze({
    ...snapshot,
    tools: Object.freeze(snapshot.tools.filter(tool => tool.group === 'mcp')),
  })
}

function projectMcpTool(tool: SessionToolEntry): McpCapabilityRow {
  const qualified = /^mcp__([A-Za-z0-9_-]{1,32})__([^\s]+)$/u.exec(tool.name)
  return Object.freeze({
    ...tool,
    serverName: qualified?.[1] ?? 'unqualified',
    toolName: qualified?.[2] ?? tool.name,
  })
}

export function createMcpCapabilityBrowserState(): McpCapabilityBrowserState {
  return createToolBrowserState()
}

export function openMcpCapabilityBrowser(
  state: McpCapabilityBrowserState,
  snapshot: SessionToolsSnapshot,
): McpCapabilityBrowserState {
  return openToolBrowser(state, mcpSnapshot(snapshot))
}

export function reconcileMcpCapabilityBrowser(
  state: McpCapabilityBrowserState,
  snapshot: SessionToolsSnapshot,
): McpCapabilityBrowserState {
  return reconcileToolBrowser(state, mcpSnapshot(snapshot))
}

export function selectMcpCapabilityBrowser(
  state: McpCapabilityBrowserState,
  snapshot: SessionToolsSnapshot,
): McpCapabilityBrowserView | undefined {
  const mcp = mcpSnapshot(snapshot)
  const view = selectToolBrowser(state, mcp)
  if (view === undefined) return undefined
  const rows = Object.freeze(view.rows.map(projectMcpTool))
  const selected = rows[view.selectedIndex]
  const namespaceCount = new Set(mcp.tools.map(tool => projectMcpTool(tool).serverName)).size
  return Object.freeze({
    query: view.query,
    rows,
    selectedIndex: view.selectedIndex,
    ...(selected === undefined ? {} : { selected }),
    totalCount: view.totalCount,
    namespaceCount,
    available: view.available,
    stale: view.stale,
    generation: view.generation,
    ...(view.error === undefined ? {} : { error: view.error }),
  })
}

export function applyMcpCapabilityBrowserAction(
  state: McpCapabilityBrowserState,
  snapshot: SessionToolsSnapshot,
  action: ToolBrowserAction,
): ToolBrowserTransition {
  return applyToolBrowserAction(state, mcpSnapshot(snapshot), action)
}
