import { FormWorkspace, type FormWorkspaceModel, type SelectionListItem } from 'pi-tui-orbs'
import type { FeatureSurfaceRuntimeSnapshot } from '../app/feature-surface-runtime.ts'
import {
  projectCapabilitiesDetails,
  projectMcpBrowser,
  projectSkillsCatalog,
  projectToolsBrowser,
  type CapabilitiesFeatureState,
  type CapabilitiesFeatureStateSource,
  type CapabilitiesNavigatorNode,
} from '../features/capabilities/index.ts'
import { formWorkspaceStrings } from './form-workspace-strings.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'

export interface CapabilitiesFrameOptions {
  readonly uiLanguage?: string
  /** Navigation insert mode: the search box owns focus and the cursor. */
  readonly searching?: boolean
  readonly deferLayout?: boolean
}

interface TabProjection {
  readonly items: readonly SelectionListItem[]
  readonly selectedIndex: number
  readonly query: { readonly text: string; readonly cursor: number }
  readonly emptyMessage: string
  readonly message?: string
  readonly messageTone?: 'error' | 'warning'
}

/** The Feature-owned state source rides its content-region node, the same seam the host's detail scroller uses. */
export function capabilitiesStateSource(
  snapshot: FeatureSurfaceRuntimeSnapshot,
): CapabilitiesFeatureStateSource | undefined {
  const contribution = snapshot.host.slots.contributions.find(candidate => (
    candidate.featureId === 'capabilities' && candidate.value.role === 'content'
  ))
  const node = contribution?.value.node as CapabilitiesNavigatorNode | null | undefined
  return node?.kind === 'capabilities.navigator' ? node.state : undefined
}

function skillsProjection(state: CapabilitiesFeatureState['skills']): TabProjection {
  const projection = projectSkillsCatalog(state.snapshot, state.query)
  const phase = state.phase
  return {
    items: projection.rows.map(entry => ({
      id: entry.name,
      label: entry.name,
      value: entry.provider,
      description: entry.description,
      group: entry.source,
    })),
    selectedIndex: Math.max(0, state.selectedIndex),
    query: { text: state.query, cursor: state.query.length },
    emptyMessage: phase === 'loading' || phase === 'refreshing'
      ? 'Discovering user-invocable skills…'
      : state.snapshot?.available === false
        ? 'Skills are unavailable in this Agent composition'
        : state.query.length === 0
          ? 'No user-invocable skills were discovered'
          : 'No skills match the current filter',
    ...(state.error !== undefined
      ? { message: `Last refresh failed · ${state.error}`, messageTone: 'error' as const }
      : state.snapshot?.stale === true
        ? { message: 'Showing last known catalog while discovery refreshes', messageTone: 'warning' as const }
        : {}),
  }
}

function toolsProjection(state: CapabilitiesFeatureState['tools']): TabProjection {
  const view = projectToolsBrowser(state)
  return {
    items: (view?.rows ?? []).map(tool => ({
      id: tool.name,
      label: tool.name,
      value: tool.group,
      description: tool.description,
    })),
    selectedIndex: Math.max(0, view?.selectedIndex ?? 0),
    query: view?.query ?? { text: '', cursor: 0 },
    emptyMessage: state.phase === 'loading' || state.phase === 'refreshing'
      ? 'Loading tools…'
      : state.error !== undefined
        ? 'Could not load tools — r to retry'
        : view?.available === false
          ? 'This session has no tool service — check /settings, then r to refresh'
          : view !== undefined && view.query.text.trim() !== ''
            ? 'No matching tools — edit or clear the search'
            : 'No tools available in this session',
    ...(state.error !== undefined
      ? { message: `Registry error · ${state.error}`, messageTone: 'error' as const }
      : view?.stale === true
        ? { message: 'Showing last-known tool registry', messageTone: 'warning' as const }
        : {}),
  }
}

function mcpProjection(state: CapabilitiesFeatureState['mcp']): TabProjection {
  const view = projectMcpBrowser(state)
  return {
    items: (view?.rows ?? []).map(tool => ({
      id: tool.name,
      label: tool.toolName,
      description: tool.description,
      group: tool.serverName,
    })),
    selectedIndex: Math.max(0, view?.selectedIndex ?? 0),
    query: view?.query ?? { text: '', cursor: 0 },
    emptyMessage: state.phase === 'loading' || state.phase === 'refreshing'
      ? 'Loading MCP capabilities…'
      : state.error !== undefined
        ? 'Could not load MCP tools — r to retry'
        : view?.available === false
          ? 'This session has no tool service — check /settings, then r to refresh'
          : view !== undefined && view.query.text.trim() !== ''
            ? 'No matching MCP tools — edit or clear the search'
            : 'No MCP servers configured — manage providers in /settings',
    ...(state.error !== undefined
      ? { message: `Registry error · ${state.error}`, messageTone: 'error' as const }
      : view?.stale === true
        ? { message: 'Showing last-known MCP capabilities', messageTone: 'warning' as const }
        : {}),
  }
}

function tabProjection(state: CapabilitiesFeatureState): TabProjection {
  switch (state.tab) {
    case 'skills': return skillsProjection(state.skills)
    case 'tools': return toolsProjection(state.tools)
    case 'mcp': return mcpProjection(state.mcp)
  }
}

/** DSH-owned copy stops here; Orbs owns the list, search box and detail modal layout. */
export function capabilitiesFormModel(
  state: CapabilitiesFeatureState,
  viewport: TerminalViewport,
  options: CapabilitiesFrameOptions = {},
): FormWorkspaceModel {
  const projection = tabProjection(state)
  const strings = formWorkspaceStrings(options.uiLanguage)
  const details = state.details === undefined ? undefined : projectCapabilitiesDetails(state)
  const detailField = details === undefined || state.details === undefined
    ? undefined
    : details.fields[Math.max(0, Math.min(details.fields.length - 1, state.details.fieldIndex))]
  const modal: FormWorkspaceModel['modal'] = details === undefined ? undefined : {
    kind: 'form',
    title: details.title,
    groups: [{
      id: 'details',
      title: details.title,
      fields: details.fields.map(entry => ({
        id: entry.id,
        label: entry.label,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        control: { kind: 'text' as const, value: entry.value },
        readonly: true,
      })),
    }],
    ...(detailField === undefined ? {} : { selectedFieldId: detailField.id }),
    hint: '↑↓ move · Enter / Esc / q close',
  }
  return {
    height: Math.max(1, Math.floor(viewport.rows)),
    header: 'Capabilities',
    categories: [
      { id: 'skills', label: `Skills ${state.skills.snapshot?.skills.length ?? 0}` },
      { id: 'tools', label: `Tools ${state.tools.snapshot?.tools.length ?? 0}` },
      { id: 'mcp', label: `MCP ${projectMcpBrowser(state.mcp)?.totalCount ?? 0}` },
    ],
    activeCategoryId: state.tab,
    focus: options.searching === true ? 'search' : 'content',
    search: { text: projection.query.text, cursor: projection.query.cursor },
    searchHidden: false,
    actions: [],
    groups: [],
    dirtyCount: 0,
    body: {
      kind: 'list',
      items: projection.items,
      selectedIndex: projection.selectedIndex,
      emptyMessage: projection.emptyMessage,
    },
    ...(projection.message === undefined ? {} : {
      message: projection.message,
      messageTone: projection.messageTone ?? 'error',
    }),
    help: '[/] tabs · ↑↓ select · Enter details · / search · r refresh · q back',
    ...(strings === undefined ? {} : { strings }),
    ...(modal === undefined ? {} : { modal }),
  }
}

/** Mirrors the settings dual path: retained drivers consume the model, snapshots use plain lines. */
export function renderCapabilitiesFrame(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  viewport: TerminalViewport,
  options: CapabilitiesFrameOptions = {},
): UiFrame | undefined {
  const source = capabilitiesStateSource(snapshot)
  if (source === undefined) return undefined
  const bounded = {
    columns: Math.max(1, Math.floor(viewport.columns)),
    rows: Math.max(1, Math.floor(viewport.rows)),
  }
  const model = capabilitiesFormModel(source.snapshot(), bounded, {
    ...options,
    searching: options.searching ?? snapshot.host.navigation.mode === 'insert',
  })
  if (options.deferLayout === true) {
    return { title: 'Capabilities', viewport: bounded, lines: [], formWorkspace: model }
  }
  const component = new FormWorkspace(model)
  const lines = component.render(bounded.columns)
  const cursor = component.getCursor()
  return {
    title: 'Capabilities',
    viewport: bounded,
    lines,
    formWorkspace: model,
    ...(cursor === undefined ? {} : { cursor }),
  }
}
