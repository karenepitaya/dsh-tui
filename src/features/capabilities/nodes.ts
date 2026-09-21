import { choiceText } from '../../presentation/control-projection.ts'
import {
  createFeatureSurfaceProjection,
  featureListViewport,
  type FeatureSurfaceInvalidationListener,
  type FeatureSurfaceProjectContext,
  type FeatureSurfaceRowInput,
  type FeatureSurfaceTone,
  type FeatureSurfaceUiNode,
} from '../../presentation/feature-surface.ts'
import type { SkillsFeaturePhase, SkillsFeatureState } from './skills-machine.ts'
import type { ToolsFeaturePhase, ToolsFeatureState } from './tools-machine.ts'
import type { McpFeaturePhase, McpFeatureState } from './mcp-machine.ts'
import type { CapabilitiesFeatureState, CapabilityTab } from './machine.ts'
import type { CapabilitiesFeatureStateSource } from './model.ts'
import {
  projectMcpBrowser,
  projectSkillsCatalog,
  projectToolsBrowser,
} from './projectors.ts'

export interface CapabilitiesNavigatorNode extends FeatureSurfaceUiNode {
  readonly kind: 'capabilities.navigator'
  readonly featureId: 'capabilities'
  readonly resourceId: 'capabilities.catalog'
  readonly state: CapabilitiesFeatureStateSource
}

export type CapabilitiesUiNode = CapabilitiesNavigatorNode

type AnyPhase = SkillsFeaturePhase | ToolsFeaturePhase | McpFeaturePhase

function phaseTone(phase: AnyPhase): FeatureSurfaceTone {
  switch (phase) {
    case 'failed': return 'danger'
    case 'loading':
    case 'refreshing': return 'warning'
    case 'ready': return 'success'
    case 'idle': return 'muted'
  }
}

function tabStrip(state: CapabilitiesFeatureState): string {
  const counts: Record<CapabilityTab, number> = {
    skills: state.skills.snapshot?.skills.length ?? 0,
    tools: state.tools.snapshot?.tools.length ?? 0,
    mcp: projectMcpBrowser(state.mcp)?.totalCount ?? 0,
  }
  return CAPABILITY_TAB_LABELS.map(({ tab, label }) => {
    const text = `${label} ${counts[tab]}`
    return state.tab === tab ? `▰ ${text}` : text
  }).join('  │  ')
}

const CAPABILITY_TAB_LABELS: readonly { readonly tab: CapabilityTab; readonly label: string }[] = Object.freeze([
  Object.freeze({ tab: 'skills', label: 'SKILLS' }),
  Object.freeze({ tab: 'tools', label: 'TOOLS' }),
  Object.freeze({ tab: 'mcp', label: 'MCP' }),
])

function skillsPhaseOf(state: SkillsFeatureState, context: FeatureSurfaceProjectContext): SkillsFeaturePhase {
  if (state.phase !== 'idle') return state.phase
  return context.resources.find(candidate => candidate.id === 'skills.catalog')?.phase ?? 'idle'
}

function skillsNavigatorRows(
  state: SkillsFeatureState,
  context: FeatureSurfaceProjectContext,
): readonly FeatureSurfaceRowInput[] {
  const phase = skillsPhaseOf(state, context)
  const projection = projectSkillsCatalog(state.snapshot, state.query)
  const rows: FeatureSurfaceRowInput[] = [
    {
      text: `${projection.rows.length}/${projection.totalCount} available skills`,
      tone: phase === 'failed' ? 'danger' : 'accent',
      bold: true,
    },
    {
      text: state.query.length === 0
        ? 'FILTER  i to search · r to refresh'
        : `FILTER  ${state.query}`,
      tone: state.query.length === 0 ? 'muted' : 'info',
    },
  ]
  if (state.snapshot?.stale === true) {
    rows.push({ text: 'Showing last known catalog while discovery refreshes', tone: 'warning' })
  }
  if (state.error !== undefined) {
    rows.push({ text: `Last refresh failed · ${state.error}`, tone: 'danger' })
  }
  if (projection.rows.length === 0) {
    rows.push({
      text: phase === 'loading' || phase === 'refreshing'
        ? 'Discovering user-invocable skills…'
        : state.snapshot?.available === false
          ? 'Skills are unavailable in this Agent composition'
          : state.query.length === 0
            ? 'No user-invocable skills were discovered'
            : 'No skills match the current filter',
      tone: phaseTone(phase),
      dim: true,
    })
    return rows
  }

  const capacity = Math.max(0, Math.floor(context.bounds.height) - rows.length)
  const visible = featureListViewport(projection.rows, state.selectedIndex, capacity)
  rows.push(...visible.map((entry) => {
    const selected = entry.name === state.selectedName
    return {
      text: choiceText(`${entry.name} · ${entry.description}`, selected),
      tone: selected ? 'accent' as const : 'default' as const,
      bold: selected,
      dim: false,
      selected,
    }
  }))
  return rows
}

function toolsNavigatorRows(
  state: ToolsFeatureState,
  context: FeatureSurfaceProjectContext,
): readonly FeatureSurfaceRowInput[] {
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
              : 'No tools available in this session',
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

function mcpNavigatorRows(
  state: McpFeatureState,
  context: FeatureSurfaceProjectContext,
): readonly FeatureSurfaceRowInput[] {
  const view = projectMcpBrowser(state)
  const result: FeatureSurfaceRowInput[] = [{
    text: `SEARCH  ${view?.query.text || 'i to search · r to refresh'}`,
    tone: 'info',
  }]
  if (view?.available === false) {
    result.push({ text: 'Unavailable · This session has no tool service', tone: 'warning' })
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
        : state.error !== undefined
          ? 'Could not load MCP tools · r to retry'
          : view?.available === false
            ? 'Check the session configuration, then r to refresh'
            : view !== undefined && view.query.text.trim() !== ''
              ? 'No matching MCP tools · Edit or clear the search'
              : 'No MCP servers configured — manage providers in /settings',
      tone: 'muted',
      dim: true,
    })
    return result
  }
  result.push(...view.rows.map((tool, index) => ({
    text: choiceText(`${tool.serverName} / ${tool.toolName} · ${tool.description}`, index === view.selectedIndex),
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

function navigatorRows(
  state: CapabilitiesFeatureState,
  context: FeatureSurfaceProjectContext,
): readonly FeatureSurfaceRowInput[] {
  const strip: FeatureSurfaceRowInput = { text: tabStrip(state), tone: 'accent', bold: true }
  const tabContext: FeatureSurfaceProjectContext = {
    ...context,
    bounds: { ...context.bounds, height: Math.max(0, context.bounds.height - 1) },
  }
  switch (state.tab) {
    case 'skills': return [strip, ...skillsNavigatorRows(state.skills, tabContext)]
    case 'tools': return [strip, ...toolsNavigatorRows(state.tools, tabContext)]
    case 'mcp': return [strip, ...mcpNavigatorRows(state.mcp, tabContext)]
  }
}

function navigatorHint(mode: FeatureSurfaceProjectContext['mode']): string {
  return mode === 'insert'
    ? 'Type to search · Enter results'
    : '[/] tabs · j/k choose · Enter details · / search · r refresh'
}

function onChanged(
  state: CapabilitiesFeatureStateSource,
  listener: FeatureSurfaceInvalidationListener,
): () => void {
  return state.onChanged(() => { listener() })
}

export function createCapabilitiesNavigatorNode(
  state: CapabilitiesFeatureStateSource,
): CapabilitiesNavigatorNode {
  return Object.freeze({
    kind: 'capabilities.navigator',
    featureId: 'capabilities',
    resourceId: 'capabilities.catalog',
    state,
    project: (context: FeatureSurfaceProjectContext) => Object.freeze({
      ...createFeatureSurfaceProjection(context, navigatorRows(state.snapshot(), context)),
      actionHint: navigatorHint(context.mode),
    }),
    onChanged: (listener: FeatureSurfaceInvalidationListener) => onChanged(state, listener),
  })
}
