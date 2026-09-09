import { choiceText } from '../../presentation/control-projection.ts'
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
    text: `${view?.rows.length ?? 0}/${view?.totalCount ?? 0} available tools`,
    tone: state.phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }, {
    text: `SEARCH  ${view?.query.text || 'i to search · r to refresh'}`,
    tone: 'info',
  }]
  if (view?.available === false) {
    result.push({ text: 'Unavailable · This session has no tool service', tone: 'warning' })
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
        : state.error !== undefined
          ? 'Could not load tools · r to retry'
          : view?.available === false
            ? 'Check the session configuration, then r to refresh'
            : view !== undefined && view.query.text.trim() !== ''
              ? 'No matching tools · Edit or clear the search'
              : 'No tools available · Check /settings, then r to refresh',
      tone: 'muted',
      dim: true,
    })
    return result
  }
  result.push(...view.rows.map((tool, index) => ({
    text: choiceText(`${tool.name} · ${tool.description}`, index === view.selectedIndex),
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

function inspectorRows(state: ReturnType<ToolsFeatureStateSource['snapshot']>, context: FeatureSurfaceProjectContext): readonly FeatureSurfaceRowInput[] {
  const selected = projectToolsBrowser(state)?.selected
  if (selected === undefined) {
    return [{ text: 'TOOL DETAILS', tone: 'accent', bold: true }, {
      text: 'Select a tool to inspect its contract',
      tone: 'muted',
      dim: true,
    }]
  }
  const summary: FeatureSurfaceRowInput[] = [{
    text: selected.name,
    tone: 'accent',
    bold: true,
  }, {
    text: selected.description,
  }, {
    text: 'Ask in Chat to use this tool',
    tone: 'muted',
  }]
  if (!context.focus) return summary
  return [...summary, {
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
    project: (context: FeatureSurfaceProjectContext) => Object.freeze({
      ...createFeatureSurfaceProjection(context, rows(state.snapshot(), context)),
      actionHint: context.mode === 'insert' ? 'Type to search · Enter results' : 'j/k choose · / search · Tab details · r refresh',
    }),
    onChanged: (listener: FeatureSurfaceInvalidationListener) => (
      state.onChanged(() => { listener() })
    ),
  }) as Extract<ToolsUiNode, { readonly kind: TKind }>
}

export function createToolsContentNode(state: ToolsFeatureStateSource): ToolsContentNode {
  return node('tools.content', state, contentRows)
}

export function createToolsInspectorNode(state: ToolsFeatureStateSource): ToolsInspectorNode {
  const detail = createFeatureDetailSurface({
    rows: context => inspectorRows(state.snapshot(), context),
    key: () => projectToolsBrowser(state.snapshot())?.selected?.name,
    hasContent: () => projectToolsBrowser(state.snapshot())?.selected !== undefined,
    onChanged: listener => state.onChanged(() => { listener() }),
  })
  return Object.freeze({
    kind: 'tools.inspector',
    featureId: 'tools',
    resourceId: 'tools.catalog',
    state,
    ...detail,
    project: (context: FeatureSurfaceProjectContext) => Object.freeze({
      ...detail.project(context),
      actionHint: context.mode === 'insert' ? 'Type to search · Enter results' : 'j/k scroll · PgUp/PgDn page · Tab list · r refresh',
    }),
  })
}
