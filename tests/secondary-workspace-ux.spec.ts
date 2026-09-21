import { describe, expect, it } from 'vitest'
import {
  createCapabilitiesFeatureModel,
  createCapabilitiesFeatureState,
  createCapabilitiesNavigatorNode,
  createMcpFeatureState,
  createSkillsFeatureState,
  createToolsFeatureState,
  projectCapabilitiesDetails,
  transitionMcpFeature,
  transitionSkillsFeature,
  transitionToolsFeature,
  type CapabilitiesFeatureState,
  type CapabilityTab,
} from '../src/features/capabilities/index.ts'
import type { FeatureSurfaceUiNode } from '../src/presentation/feature-surface.ts'
import type { SessionToolsSnapshot } from '../src/tool/port.ts'
import type { SettingsCatalogSnapshot } from '../src/settings/port.ts'
import { applyRuntimeLibraryAction, createRuntimeLibraryState, openRuntimeLibrary, reconcileRuntimeLibrary, selectRuntimeLibrary, runtimeSettingsName, runtimeSettingName, runtimePluginName } from '../src/runtime-library/surface.ts'
import { renderRuntimeLibraryFrame } from '../src/ui/workspace-runtime.ts'

const tools: SessionToolsSnapshot = {
  available: true, stale: false, generation: 12,
  tools: [{ name: 'mcp__files__read', description: 'Read a file without modifying it', group: 'mcp', parameterNames: ['path'], requiredParameterNames: ['path'] }],
}
const settings: SettingsCatalogSnapshot = {
  available: true, writable: true, documentBacked: true, generation: 11,
  namespaces: [{ namespace: 'agent-loop', schema: {}, value: { maxSteps: 30 }, base: { maxSteps: 20 }, user: { maxSteps: 30 }, revision: 8, applies: 'live', secrets: [] }],
}
const plugins = { available: true, entries: [{ entryId: 'opaque-id', moduleName: '@deepseek-ai/dsh-settings-file', enabled: true, fiberPhase: 'active' as const }] }
const context = { bounds: { x: 0, y: 0, width: 110, height: 24 }, focus: false, mode: 'normal', resources: [] }
const source = <T>(state: T) => ({ snapshot: () => state, onChanged: () => () => {} })
const capability = (tab: CapabilityTab, state: CapabilitiesFeatureState[CapabilityTab]) => {
  const base = createCapabilitiesFeatureState()
  if (tab === 'skills') return source<CapabilitiesFeatureState>({ ...base, tab, skills: state as CapabilitiesFeatureState['skills'] })
  if (tab === 'tools') return source<CapabilitiesFeatureState>({ ...base, tab, tools: state as CapabilitiesFeatureState['tools'] })
  return source<CapabilitiesFeatureState>({ ...base, tab, mcp: state as CapabilitiesFeatureState['mcp'] })
}
const text = (node: FeatureSurfaceUiNode, focus = false) => node.project({ ...context, focus }).rows.map(row => row.text).join('\n')
const runtimeText = (state: ReturnType<typeof createRuntimeLibraryState>, columns = 140) => renderRuntimeLibraryFrame(selectRuntimeLibrary(state)!, { columns, rows: 24 }).lines.join('\n')

describe('secondary workspaces answer the user task before exposing implementation details', () => {
  it('distinguishes an empty MCP catalog, a search miss, and a failed discovery with next steps', () => {
    const empty = transitionMcpFeature(createMcpFeatureState(), { type: 'snapshot.changed', snapshot: { ...tools, tools: [] } }).state
    const emptyText = text(createCapabilitiesNavigatorNode(capability('mcp', empty)))
    expect(emptyText).toContain('No MCP servers configured — manage providers in /settings')
    expect(emptyText).not.toContain('No matching')
    const ready = transitionMcpFeature(createMcpFeatureState(), { type: 'snapshot.changed', snapshot: tools }).state
    const filtered = transitionMcpFeature(ready, { type: 'query.edit', action: { type: 'insert', text: 'missing' } }).state
    expect(text(createCapabilitiesNavigatorNode(capability('mcp', filtered)))).toContain('No matching MCP tools · Edit or clear the search')
    const failed = transitionMcpFeature(createMcpFeatureState(), { type: 'snapshot.failed', message: 'Connection refused' }).state
    const failedText = text(createCapabilitiesNavigatorNode(capability('mcp', failed)))
    expect(failedText).toContain('Connection refused')
    expect(failedText).toContain('r to retry')
    expect(failedText).not.toContain('No matching')
    expect(failedText).not.toContain('No MCP servers configured')
  })

  it('shows tool purpose in the list and opens the contract only as explicit details', () => {
    const mcp = transitionMcpFeature(createMcpFeatureState(), { type: 'snapshot.changed', snapshot: tools }).state
    const tool = transitionToolsFeature(createToolsFeatureState(), { type: 'snapshot.changed', snapshot: tools }).state
    expect(text(createCapabilitiesNavigatorNode(capability('mcp', mcp)))).toContain('Read a file without modifying it')
    expect(text(createCapabilitiesNavigatorNode(capability('tools', tool)))).toContain('Read a file without modifying it')
    for (const state of [
      { ...createCapabilitiesFeatureState(), tab: 'mcp', mcp },
      { ...createCapabilitiesFeatureState(), tab: 'tools', tools: tool },
    ] as const) {
      const details = projectCapabilitiesDetails(state)
      expect(details?.fields.find(entry => entry.id === 'parameters')?.value).toBe('path')
      expect(details?.fields.find(entry => entry.id === 'required')?.value).toBe('path')
    }
    expect(text(createCapabilitiesNavigatorNode(capability('mcp', mcp)))).not.toContain('Parameters')
  })

  it('keeps skill usage, source, provider and resource paths inside the details modal content', () => {
    const state = transitionSkillsFeature(createSkillsFeatureState(), { type: 'snapshot.changed', snapshot: {
      available: true, complete: true, loading: false, stale: false, generation: 2,
      skills: [{ name: 'review', description: 'Review the current diff', whenToUse: 'Before opening a pull request', source: 'workspace', provider: 'filesystem', modelInvocable: true, resourceBase: { kind: 'directory', path: '/private/catalog/review' } }],
    } }).state
    const details = projectCapabilitiesDetails(capability('skills', state).snapshot())
    expect(details?.title).toBe('review')
    const values = details?.fields.map(entry => entry.value).join('\n') ?? ''
    expect(values).toContain('Before opening a pull request')
    expect(values).toContain('Use /review in Chat')
    expect(values).toContain('workspace')
    expect(values).toContain('/private/catalog/review')
    expect(text(createCapabilitiesNavigatorNode(capability('skills', state)))).not.toContain('/private/catalog')
  })

  it('puts effective settings before storage details and keeps the real field editor reachable', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    const catalog = runtimeText(state)
    expect(catalog).toContain('Agent loop')
    expect(catalog).toContain('Maximum steps')
    expect(catalog).toContain('30')
    expect(catalog).toContain('Applies immediately')
    expect(catalog).not.toContain('Layer stack')
    expect(catalog).not.toContain('generation')
    expect(catalog).not.toContain('Revision')
    expect(runtimeText(state, 80)).toContain('Maximum steps')
    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    expect(runtimeText(state)).toContain('Namespace  agent-loop')
    expect(runtimeText(state)).toContain('Enter edit')
    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    expect(selectRuntimeLibrary(state)?.editor).toMatchObject({ namespace: 'agent-loop', path: ['maxSteps'], input: { text: '30' } })
  })

  it('searches meaningful setting names and returns to the filtered list without entering the editor', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    state = applyRuntimeLibraryAction(state, { type: 'search' }).state
    state = applyRuntimeLibraryAction(state, { type: 'edit', action: { type: 'insert', text: 'Maximum steps' } }).state
    expect(selectRuntimeLibrary(state)?.settings.rows.map(row => row.namespace)).toEqual(['agent-loop'])
    const submitted = applyRuntimeLibraryAction(state, { type: 'enter' })
    expect(submitted.outcome).toBeUndefined()
    expect(submitted.state).toMatchObject({ focus: 'catalog', searchFocused: false, editor: undefined })
  })

  it('identifies plugins by module and gives the supported next action without a lifecycle dump', () => {
    const state = applyRuntimeLibraryAction(openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins), { type: 'switch-tab' }).state
    const output = runtimeText(state)
    expect(output).toContain('Settings file')
    expect(output).toContain('Enter refresh')
    expect(output).not.toContain('Lifecycle rail')
    expect(output).not.toContain('Fiber')
    expect(output).not.toContain('opaque-id')
    const detail = applyRuntimeLibraryAction(state, { type: 'focus-next' }).state
    expect(runtimeText(detail)).toContain('opaque-id')
  })

  it('preserves extension-owned names, including names inherited by plain JavaScript objects', () => {
    expect(runtimePluginName('dsh-tui/features/capabilities')).toBe('Capabilities')
    expect(runtimePluginName('@deepseek-ai/dsh-time-context')).toBe('Current time')
    for (const name of ['custom-plugin', 'constructor', 'toString']) {
      expect(runtimeSettingsName(name)).toBe(name)
      expect(runtimePluginName(name)).toBe(name)
      expect(runtimeSettingName('agent-loop', name)).toBe(name)
      expect(runtimeSettingName(name, 'maxSteps')).toBe('maxSteps')
    }
  })

  it('searches public effective values safely and preserves selection across refreshes', () => {
    const snapshot: SettingsCatalogSnapshot = { ...settings, namespaces: [{
      ...settings.namespaces[0]!,
      value: { maxSteps: 30, opaque: 1n, optional: undefined, apiKey: 'secret-value-must-not-match' },
      secrets: [{ path: ['apiKey'], set: true }],
    }, { namespace: 'unknown-extension', value: { raw_option: 'visible-value' }, schema: {}, revision: 2, applies: 'restart', secrets: [] }] }
    for (const [query, names] of [
      ['Agent loop', ['agent-loop']], ['maxSteps', ['agent-loop']], ['30', ['agent-loop']],
      ['raw_option', ['unknown-extension']], ['visible-value', ['unknown-extension']], ['secret-value-must-not-match', []],
      ['nothing', []],
    ] as const) {
      let state = applyRuntimeLibraryAction(openRuntimeLibrary(createRuntimeLibraryState(), snapshot, plugins), { type: 'search' }).state
      state = applyRuntimeLibraryAction(state, { type: 'edit', action: { type: 'insert', text: query } }).state
      expect(selectRuntimeLibrary(state)?.settings.rows.map(row => row.namespace)).toEqual(names)
    }
    let state = openRuntimeLibrary(createRuntimeLibraryState(), snapshot, plugins)
    state = applyRuntimeLibraryAction(state, { type: 'move-down' }).state
    state = reconcileRuntimeLibrary(state, { ...snapshot, namespaces: [...snapshot.namespaces].reverse() }, plugins)
    expect(selectRuntimeLibrary(state)?.settings.selected?.namespace).toBe('unknown-extension')
    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    state = applyRuntimeLibraryAction(state, { type: 'search' }).state
    state = applyRuntimeLibraryAction(state, { type: 'edit', action: { type: 'insert', text: 'Settings file' } }).state
    expect(selectRuntimeLibrary(state)?.plugins.selected?.entryId).toBe('opaque-id')
    expect(runtimeText(state)).not.toContain('secret-value-must-not-match')
  })

  it('distinguishes missing settings and plugins from catalog read failures', () => {
    const empty = openRuntimeLibrary(createRuntimeLibraryState(), { ...settings, namespaces: [] }, { available: true, entries: [] })
    expect(runtimeText(empty)).toContain('No registered settings')
    expect(runtimeText(applyRuntimeLibraryAction(empty, { type: 'switch-tab' }).state)).toContain('No plugins configured')
    const failed = openRuntimeLibrary(createRuntimeLibraryState(), { ...settings, namespaces: [], error: 'Settings read failed' }, plugins)
    expect(runtimeText(failed)).toContain('Could not load settings')
    expect(runtimeText(failed)).not.toContain('No registered settings')
    const memory = openRuntimeLibrary(createRuntimeLibraryState(), { ...settings, documentBacked: false }, plugins)
    expect(runtimeText(applyRuntimeLibraryAction(memory, { type: 'enter' }).state)).toContain('In memory')
  })

  it('keeps unavailable tool services distinct from valid empty and filtered catalogs', () => {
    const mcp = transitionMcpFeature(createMcpFeatureState(), { type: 'snapshot.changed', snapshot: { ...tools, available: false, tools: [] } }).state
    expect(text(createCapabilitiesNavigatorNode(capability('mcp', mcp)))).toContain('Check the session configuration')
    let state = transitionToolsFeature(createToolsFeatureState(), { type: 'snapshot.changed', snapshot: { ...tools, available: false, tools: [] } }).state
    expect(text(createCapabilitiesNavigatorNode(capability('tools', state)))).toContain('Check the session configuration')
    state = transitionToolsFeature(state, { type: 'snapshot.changed', snapshot: { ...tools, tools: [] } }).state
    expect(text(createCapabilitiesNavigatorNode(capability('tools', state)))).toContain('No tools available')
    state = transitionToolsFeature(state, { type: 'snapshot.changed', snapshot: tools }).state
    state = transitionToolsFeature(state, { type: 'query.edit', action: { type: 'insert', text: 'missing' } }).state
    expect(text(createCapabilitiesNavigatorNode(capability('tools', state)))).toContain('No matching tools · Edit or clear the search')
  })

  it('keeps open detail content in sync with registry changes', () => {
    const mcpModel = createCapabilitiesFeatureModel()
    mcpModel.dispatch({ type: 'tab.set', tab: 'mcp' })
    const toolsModel = createCapabilitiesFeatureModel()
    toolsModel.dispatch({ type: 'tab.set', tab: 'tools' })
    for (const [model, tab] of [
      [mcpModel, 'mcp'],
      [toolsModel, 'tools'],
    ] as const) {
      const dispatch = (snapshot: typeof tools) => {
        if (tab === 'mcp') model.dispatch({ type: 'mcp', event: { type: 'snapshot.changed', snapshot } })
        else model.dispatch({ type: 'tools', event: { type: 'snapshot.changed', snapshot } })
      }
      expect(projectCapabilitiesDetails(model.snapshot())).toBeUndefined()
      dispatch(tools)
      const details = projectCapabilitiesDetails(model.snapshot())
      expect(details?.fields.find(entry => entry.id === 'description')?.value)
        .toBe('Read a file without modifying it')
      dispatch({ ...tools, tools: [] })
      expect(projectCapabilitiesDetails(model.snapshot())).toBeUndefined()
      model.dispose()
    }
  })

  it('publishes real footer actions for browsing, searching and details', () => {
    const mcp = transitionMcpFeature(createMcpFeatureState(), { type: 'snapshot.changed', snapshot: tools }).state
    const tool = transitionToolsFeature(createToolsFeatureState(), { type: 'snapshot.changed', snapshot: tools }).state
    for (const node of [createCapabilitiesNavigatorNode(capability('mcp', mcp)), createCapabilitiesNavigatorNode(capability('tools', tool))]) {
      expect(node.project(context).actionHint).toContain('Enter details')
      expect(node.project({ ...context, mode: 'insert' }).actionHint).toContain('Enter results')
      expect(node.project(context).actionHint).not.toContain('Enter activate')
    }
    const skillState = capability('skills', createSkillsFeatureState())
    const skills = createCapabilitiesNavigatorNode(skillState)
    expect(skills.project(context).actionHint).toContain('Enter details')
    expect(skills.project({ ...context, mode: 'insert' }).actionHint).toContain('Enter results')
  })

  it('does not advertise runtime mutations on read-only settings', () => {
    const state = openRuntimeLibrary(createRuntimeLibraryState(), { ...settings, writable: false }, plugins)
    const detail = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    expect(runtimeText(detail)).toContain('Read-only')
    expect(runtimeText(detail)).not.toContain('Enter edit')
    expect(runtimeText(detail)).not.toContain('Ctrl+S inherit')
  })
})
