import { describe, expect, it } from 'vitest'
import { FormWorkspace } from 'pi-tui-orbs'
import type { FeatureSurfaceRuntimeSnapshot } from '../src/app/feature-surface-runtime.ts'
import {
  createCapabilitiesFeatureState,
  createSkillsFeatureState,
  createToolsFeatureState,
  createMcpFeatureState,
  transitionCapabilitiesFeature,
  transitionMcpFeature,
  transitionSkillsFeature,
  transitionToolsFeature,
  type CapabilitiesFeatureState,
} from '../src/features/capabilities/index.ts'
import type { SessionSkillsSnapshot } from '../src/skill/port.ts'
import type { SessionToolsSnapshot } from '../src/tool/port.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'
import {
  capabilitiesFormModel,
  capabilitiesStateSource,
  renderCapabilitiesFrame,
} from '../src/ui/capabilities-frame.ts'

const skillsSnapshot = (names: readonly string[]): SessionSkillsSnapshot => ({
  available: true, loading: false, complete: true, stale: false, generation: 1,
  skills: names.map(name => ({
    name, description: `${name} description`, modelInvocable: true, source: 'project-agents', provider: 'filesystem',
  })),
})

const toolsSnapshot = (names: readonly string[]): SessionToolsSnapshot => ({
  available: true, stale: false, generation: 1,
  tools: names.map(name => ({
    name, description: `${name} description`, group: 'core' as const, parameterNames: ['command'], requiredParameterNames: ['command'],
  })),
})

function stateWith(partial: Partial<CapabilitiesFeatureState> = {}): CapabilitiesFeatureState {
  return {
    ...createCapabilitiesFeatureState(),
    skills: transitionSkillsFeature(createSkillsFeatureState(), {
      type: 'snapshot.changed', snapshot: skillsSnapshot(['review', 'test']),
    }).state,
    tools: transitionToolsFeature(createToolsFeatureState(), {
      type: 'snapshot.changed', snapshot: toolsSnapshot(['pwsh', 'read']),
    }).state,
    mcp: transitionMcpFeature(createMcpFeatureState(), {
      type: 'snapshot.changed', snapshot: toolsSnapshot([]),
    }).state,
    ...partial,
  }
}

const viewport = { columns: 120, rows: 30 }
const model = (state: CapabilitiesFeatureState, options: Parameters<typeof capabilitiesFormModel>[2] = {}) => (
  capabilitiesFormModel(state, viewport, options)
)
const text = (state: CapabilitiesFeatureState, options: Parameters<typeof capabilitiesFormModel>[2] = {}) => (
  new FormWorkspace(model(state, options)).render(120).join('\n')
)

describe('capabilities FormWorkspace model', () => {
  it('projects categories with counts, a bounded list body, hidden action bar and one footer hint', () => {
    const current = model(stateWith())
    expect(current.categories).toEqual([
      { id: 'skills', label: 'Skills 2' },
      { id: 'tools', label: 'Tools 2' },
      { id: 'mcp', label: 'MCP 0' },
    ])
    expect(current.activeCategoryId).toBe('skills')
    expect(current.focus).toBe('content')
    expect(current.actions).toEqual([])
    expect(current.groups).toEqual([])
    expect(current.body).toMatchObject({ kind: 'list', selectedIndex: 0 })
    expect(current.body?.items.map(item => [item.label, item.value, item.group])).toEqual([
      ['review', 'filesystem', 'project-agents'],
      ['test', 'filesystem', 'project-agents'],
    ])
    expect(current.help).toBe('[/] tabs · ↑↓ select · Enter details · / search · r refresh · q back')
    expect(current.strings).toBeUndefined()

    const rendered = text(stateWith())
    expect(rendered).toContain('Capabilities')
    expect(rendered).toContain('› review')
    expect(rendered).toContain('review description')
    expect(rendered).toContain('q back')
    for (const line of rendered.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(120)
  })

  it('groups MCP rows by server and carries the specific empty message', () => {
    const mcp = transitionMcpFeature(createMcpFeatureState(), {
      type: 'snapshot.changed',
      snapshot: {
        available: true, stale: false, generation: 1,
        tools: [
          { name: 'mcp__github__create_issue', description: 'Create an issue', group: 'mcp' as const, parameterNames: [], requiredParameterNames: [] },
          { name: 'mcp__github__merge', description: 'Merge a pull request', group: 'mcp' as const, parameterNames: [], requiredParameterNames: [] },
          { name: 'mcp__files__read', description: 'Read a file', group: 'mcp' as const, parameterNames: [], requiredParameterNames: [] },
        ],
      },
    }).state
    const current = model(stateWith({ tab: 'mcp', mcp }))
    expect(current.categories).toContainEqual({ id: 'mcp', label: 'MCP 3' })
    expect(current.body?.items.map(item => [item.label, item.group])).toEqual([
      ['create_issue', 'github'],
      ['merge', 'github'],
      ['read', 'files'],
    ])
    const rendered = text(stateWith({ tab: 'mcp', mcp }))
    expect(rendered).toContain('github')
    expect(rendered).toContain('› create_issue')
    expect(rendered).not.toContain('tools available in this session')

    const empty = model(stateWith({ tab: 'mcp' }))
    expect(empty.body?.emptyMessage).toBe('No MCP servers configured — manage providers in /settings')
    expect(text(stateWith({ tab: 'mcp' }))).toContain('No MCP servers configured — manage providers in /settings')
    const emptyTools = model(stateWith({ tab: 'tools', tools: createToolsFeatureState() }))
    expect(emptyTools.body?.emptyMessage).toBe('No tools available in this session')
  })

  it('focuses search while typing and carries the active tab query', () => {
    const tools = transitionToolsFeature(stateWith().tools, {
      type: 'query.edit', action: { type: 'insert', text: 'pw' },
    }).state
    const current = model(stateWith({ tab: 'tools', tools }), { searching: true })
    expect(current.focus).toBe('search')
    expect(current.search).toEqual({ text: 'pw', cursor: 2 })
    expect(current.searchHidden).toBe(false)
    expect(current.body?.items.map(item => item.label)).toEqual(['pwsh'])
    const workspace = new FormWorkspace(current)
    workspace.render(120)
    expect(workspace.getCursor()).toBeDefined()
  })

  it('opens a read-only form modal for the selected entry and moves through its fields', () => {
    const base = stateWith({ tab: 'tools' })
    const open = transitionCapabilitiesFeature(base, { type: 'details.open' }).state
    const current = model(open)
    expect(current.modal).toMatchObject({ kind: 'form', title: 'pwsh', selectedFieldId: 'name' })
    const rendered = text(open)
    expect(rendered).toContain('Parameters')
    expect(rendered).toContain('command')
    expect(rendered).not.toContain('✎')
    const moved = transitionCapabilitiesFeature(open, { type: 'details.move', direction: 'down', amount: 4 }).state
    expect(model(moved).modal).toMatchObject({ selectedFieldId: 'required' })
    const closed = transitionCapabilitiesFeature(open, { type: 'details.close' }).state
    expect(model(closed).modal).toBeUndefined()
  })

  it('switches chrome strings with uiLanguage', () => {
    const zh = text(stateWith(), { uiLanguage: 'zh' })
    expect(zh).toContain('q / Esc 返回')
    expect(model(stateWith(), { uiLanguage: 'zh' }).strings).toBeDefined()
    expect(text(stateWith(), { uiLanguage: 'en' })).toContain('q / Esc back')
  })
})

describe('capabilities frame seam', () => {
  const snapshotWith = (node: unknown): FeatureSurfaceRuntimeSnapshot => ({
    host: {
      navigation: { mode: 'normal', route: { kind: 'workspace', featureId: 'capabilities', pane: 'content' } },
      slots: { contributions: [{
        slotId: 'workspace.content', featureId: 'capabilities', authority: 'core', contributionId: 'capabilities.navigator',
        value: { id: 'capabilities.navigator', role: 'content', node },
      }] },
    },
    layout: { placements: [] },
    surfaces: [],
  }) as unknown as FeatureSurfaceRuntimeSnapshot

  it('reads the Feature state source from the content-region node', () => {
    const state = stateWith()
    const source = { snapshot: () => state, onChanged: () => () => {} }
    expect(capabilitiesStateSource(snapshotWith({ kind: 'capabilities.navigator', state: source }))).toBe(source)
    expect(capabilitiesStateSource(snapshotWith({ kind: 'other', state: source }))).toBeUndefined()
    expect(capabilitiesStateSource(snapshotWith(undefined))).toBeUndefined()
  })

  it('renders the dual path: retained model plus neutral fallback lines', () => {
    const state = stateWith()
    const source = { snapshot: () => state, onChanged: () => () => {} }
    const snapshot = snapshotWith({ kind: 'capabilities.navigator', state: source })
    const deferred = renderCapabilitiesFrame(snapshot, viewport, { deferLayout: true })!
    expect(deferred.lines).toEqual([])
    expect(deferred.formWorkspace?.body?.kind).toBe('list')
    const rendered = renderCapabilitiesFrame(snapshot, viewport, { uiLanguage: 'en' })!
    expect(rendered.title).toBe('Capabilities')
    expect(rendered.lines.join('\n')).toContain('› review')
    expect(rendered.formWorkspace).toBeDefined()
  })
})
