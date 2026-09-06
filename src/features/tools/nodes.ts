import {
  createFeatureSurfaceProjection,
  createFeatureDetailSurface,
  featureListViewport,
  type FeatureSurfaceInvalidationListener,
  type FeatureSurfaceProjectContext,
  type FeatureSurfaceRowInput,
  type FeatureSurfaceUiNode,
} from '../../presentation/feature-surface.ts'
import { projectToolsBrowser } from './projectors.ts'
import type { ToolsFeatureStateSource } from './model.ts'

interface ToolsNodeBase extends FeatureSurfaceUiNode {
  readonly featureId: 'tools'
  readonly resourceId: 'tools.catalog'
  readonly state: ToolsFeatureStateSource
}

export interface ToolsContentNode extends ToolsNodeBase {
  readonly kind: 'tools.content'
}

export interface ToolsInspectorNode extends ToolsNodeBase {
  readonly kind: 'tools.inspector'
}

export type ToolsUiNode = ToolsContentNode | ToolsInspectorNode

function contentRows(state: ReturnType<ToolsFeatureStateSource['snapshot']>, context: FeatureSurfaceProjectContext): readonly FeatureSurfaceRowInput[] {
  const view = projectToolsBrowser(state)
  const result: FeatureSurfaceRowInput[] = [{
    text: `TOOLS  ${view?.rows.length ?? 0}/${view?.totalCount ?? 0} · ${state.phase}`,
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
    result.push({ text: 'Showing last-known tool registry', tone: 'warning' })
  }
  if (state.error !== undefined) {
    result.push({ text: `Registry error · ${state.error}`, tone: 'danger' })
  }
  if (view === undefined || view.rows.length === 0) {
    result.push({
      text: state.phase === 'loading' || state.phase === 'refreshing'
        ? 'Loading tools…'
        : 'No matching tools',
      tone: 'muted',
      dim: true,
    })
    return result
  }
  result.push(...view.rows.map((tool, index) => ({
    text: `${index === view.selectedIndex ? '›' : ' '} ${tool.name} · ${tool.group}`,
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

function inspectorRows(state: ReturnType<ToolsFeatureStateSource['snapshot']>): readonly FeatureSurfaceRowInput[] {
  const selected = projectToolsBrowser(state)?.selected
  if (selected === undefined) {
    return [{ text: 'TOOL DETAILS', tone: 'accent', bold: true }, {
      text: 'Select a tool to inspect its contract',
      tone: 'muted',
      dim: true,
    }]
  }
  return [{
    text: selected.name,
    tone: 'accent',
    bold: true,
  }, {
    text: selected.description,
  }, {
    text: `GROUP  ${selected.group}`,
    tone: 'info',
  }, {
    text: `PARAMETERS  ${selected.parameterNames.join(', ') || 'none'}`,
  }, {
    text: `REQUIRED  ${selected.requiredParameterNames.join(', ') || 'none'}`,
    tone: selected.requiredParameterNames.length === 0 ? 'muted' : 'warning',
  }]
}

function node<TKind extends ToolsUiNode['kind']>(
  kind: TKind,
  state: ToolsFeatureStateSource,
  rows: (value: ReturnType<ToolsFeatureStateSource['snapshot']>, context: FeatureSurfaceProjectContext) => readonly FeatureSurfaceRowInput[],
): Extract<ToolsUiNode, { readonly kind: TKind }> {
  return Object.freeze({
    kind,
    featureId: 'tools',
    resourceId: 'tools.catalog',
    state,
    project: (context: FeatureSurfaceProjectContext) => createFeatureSurfaceProjection(
      context,
      rows(state.snapshot(), context),
    ),
    onChanged: (listener: FeatureSurfaceInvalidationListener) => (
      state.onChanged(() => { listener() })
    ),
  }) as Extract<ToolsUiNode, { readonly kind: TKind }>
}

export function createToolsContentNode(state: ToolsFeatureStateSource): ToolsContentNode {
  return node('tools.content', state, contentRows)
}

export function createToolsInspectorNode(state: ToolsFeatureStateSource): ToolsInspectorNode {
  return Object.freeze({
    kind: 'tools.inspector',
    featureId: 'tools',
    resourceId: 'tools.catalog',
    state,
    ...createFeatureDetailSurface({
      rows: () => inspectorRows(state.snapshot()),
      key: () => projectToolsBrowser(state.snapshot())?.selected?.name,
      hasContent: () => projectToolsBrowser(state.snapshot())?.selected !== undefined,
      onChanged: listener => state.onChanged(() => { listener() }),
    }),
  })
}
