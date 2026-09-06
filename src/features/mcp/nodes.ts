import {
  createFeatureSurfaceProjection,
  createFeatureDetailSurface,
  featureListViewport,
  type FeatureSurfaceInvalidationListener,
  type FeatureSurfaceProjectContext,
  type FeatureSurfaceRowInput,
  type FeatureSurfaceUiNode,
} from '../../presentation/feature-surface.ts'
import type { McpFeatureStateSource } from './model.ts'
import { projectMcpBrowser } from './projectors.ts'

interface McpNodeBase extends FeatureSurfaceUiNode {
  readonly featureId: 'mcp'
  readonly resourceId: 'mcp.catalog'
  readonly state: McpFeatureStateSource
}

export interface McpContentNode extends McpNodeBase {
  readonly kind: 'mcp.content'
}

export interface McpInspectorNode extends McpNodeBase {
  readonly kind: 'mcp.inspector'
}

export type McpUiNode = McpContentNode | McpInspectorNode

function contentRows(state: ReturnType<McpFeatureStateSource['snapshot']>, context: FeatureSurfaceProjectContext): readonly FeatureSurfaceRowInput[] {
  const view = projectMcpBrowser(state)
  const result: FeatureSurfaceRowInput[] = [{
    text: `MCP  ${view?.rows.length ?? 0} tools · ${view?.namespaceCount ?? 0} servers · ${state.phase}`,
    tone: state.phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }, {
    text: `SEARCH  ${view?.query.text || 'i to search · r to refresh'}`,
    tone: 'info',
  }]
  if (view?.available === false) {
    result.push({ text: 'Unavailable · ToolRuntime is not mounted', tone: 'warning' })
  }
  if (view?.stale === true) {
    result.push({ text: 'Showing last-known MCP capabilities', tone: 'warning' })
  }
  if (state.error !== undefined) {
    result.push({ text: `Registry error · ${state.error}`, tone: 'danger' })
  }
  if (view === undefined || view.rows.length === 0) {
    result.push({
      text: state.phase === 'loading' || state.phase === 'refreshing'
        ? 'Loading MCP capabilities…'
        : 'No matching MCP tools',
      tone: 'muted',
      dim: true,
    })
    return result
  }
  result.push(...view.rows.map((tool, index) => ({
    text: `${index === view.selectedIndex ? '›' : ' '} ${tool.serverName} / ${tool.toolName}`,
    tone: index === view.selectedIndex ? 'accent' as const : 'default' as const,
    bold: index === view.selectedIndex,
    dim: false,
    selected: index === view.selectedIndex,
  })))
  return [...result.slice(0, result.length - view.rows.length), ...featureListViewport(
    result.slice(result.length - view.rows.length), view.selectedIndex,
    context.bounds.height - (result.length - view.rows.length),
  )]
}

function inspectorRows(state: ReturnType<McpFeatureStateSource['snapshot']>): readonly FeatureSurfaceRowInput[] {
  const selected = projectMcpBrowser(state)?.selected
  if (selected === undefined) {
    return [{ text: 'MCP TOOL DETAILS', tone: 'accent', bold: true }, {
      text: 'Select an MCP tool to inspect its contract',
      tone: 'muted',
      dim: true,
    }]
  }
  return [{
    text: `${selected.serverName} / ${selected.toolName}`,
    tone: 'accent',
    bold: true,
  }, {
    text: selected.description,
  }, {
    text: `QUALIFIED  ${selected.name}`,
    tone: 'info',
  }, {
    text: `PARAMETERS  ${selected.parameterNames.join(', ') || 'none'}`,
  }, {
    text: `REQUIRED  ${selected.requiredParameterNames.join(', ') || 'none'}`,
    tone: selected.requiredParameterNames.length === 0 ? 'muted' : 'warning',
  }]
}

function node<TKind extends McpUiNode['kind']>(
  kind: TKind,
  state: McpFeatureStateSource,
  rows: (value: ReturnType<McpFeatureStateSource['snapshot']>, context: FeatureSurfaceProjectContext) => readonly FeatureSurfaceRowInput[],
): Extract<McpUiNode, { readonly kind: TKind }> {
  return Object.freeze({
    kind,
    featureId: 'mcp',
    resourceId: 'mcp.catalog',
    state,
    project: (context: FeatureSurfaceProjectContext) => createFeatureSurfaceProjection(
      context,
      rows(state.snapshot(), context),
    ),
    onChanged: (listener: FeatureSurfaceInvalidationListener) => (
      state.onChanged(() => { listener() })
    ),
  }) as Extract<McpUiNode, { readonly kind: TKind }>
}

export function createMcpContentNode(state: McpFeatureStateSource): McpContentNode {
  return node('mcp.content', state, contentRows)
}

export function createMcpInspectorNode(state: McpFeatureStateSource): McpInspectorNode {
  return Object.freeze({
    kind: 'mcp.inspector',
    featureId: 'mcp',
    resourceId: 'mcp.catalog',
    state,
    ...createFeatureDetailSurface({
      rows: () => inspectorRows(state.snapshot()),
      key: () => projectMcpBrowser(state.snapshot())?.selected?.name,
      hasContent: () => projectMcpBrowser(state.snapshot())?.selected !== undefined,
      onChanged: listener => state.onChanged(() => { listener() }),
    }),
  })
}
