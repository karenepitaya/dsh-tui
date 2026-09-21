import { describe, expect, it, vi } from 'vitest'
import type { FeatureCommandHandler } from '../src/app/feature-contribution-contract.ts'
import {
  CAPABILITIES_DISMISS_COMMAND_ID,
  CAPABILITIES_FEATURE_ID,
  CAPABILITIES_KEYMAP_ID,
  CAPABILITIES_MOVE_DOWN_COMMAND_ID,
  CAPABILITIES_MOVE_UP_COMMAND_ID,
  CAPABILITIES_MCP_RESOURCE_ID,
  CAPABILITIES_NAVIGATOR_SURFACE_ID,
  CAPABILITIES_REFRESH_COMMAND_ID,
  CAPABILITIES_ROUTE_ID,
  CAPABILITIES_SKILLS_RESOURCE_ID,
  CAPABILITIES_TAB_NEXT_COMMAND_ID,
  CAPABILITIES_TAB_PREVIOUS_COMMAND_ID,
  CAPABILITIES_TOOLS_RESOURCE_ID,
  capabilitiesFeature,
  createCapabilitiesFeatureModel,
  createCapabilitiesFeatureState,
  createCapabilitiesNavigatorNode,
  createMcpFeatureState,
  createSkillsFeatureState,
  createToolsFeatureState,
  describeSkillResource,
  detachSkillsSnapshot,
  projectCapabilitiesDetails,
  projectMcpBrowser,
  projectSkillsCatalog,
  projectToolsBrowser,
  transitionCapabilitiesFeature,
  transitionMcpFeature,
  transitionSkillsFeature,
  transitionToolsFeature,
  type CapabilitiesFeatureInstance,
} from '../src/features/capabilities/index.ts'
import type { SessionSkillEntry, SessionSkillsSnapshot } from '../src/skill/port.ts'
import type { SessionToolEntry, SessionToolsSnapshot } from '../src/tool/port.ts'
import { SESSION_SKILLS_CAPABILITY, SESSION_TOOLS_CAPABILITY } from '../src/runtime/session-capabilities.ts'

function request(scopeEpoch: number, requestId: number) {
  return { scopeEpoch, requestId }
}

function skill(
  name: string,
  overrides: Partial<SessionSkillEntry> = {},
): SessionSkillEntry {
  return {
    name,
    description: `${name} description`,
    modelInvocable: true,
    source: 'workspace',
    provider: 'filesystem',
    ...overrides,
  }
}

function skillsSnapshot(
  skills: readonly SessionSkillEntry[],
  overrides: Partial<SessionSkillsSnapshot> = {},
): SessionSkillsSnapshot {
  return {
    available: true,
    loading: false,
    complete: true,
    stale: false,
    generation: 1,
    skills,
    ...overrides,
  }
}

const TOOL_ROWS: readonly SessionToolEntry[] = [
  {
    name: 'read_file',
    description: 'Read a file from disk',
    group: 'core',
    parameterNames: ['path'],
    requiredParameterNames: ['path'],
  },
  {
    name: 'mcp__github__create_issue',
    description: 'Create an issue',
    group: 'mcp',
    parameterNames: ['owner', 'title'],
    requiredParameterNames: ['owner'],
  },
  {
    name: 'run_code',
    description: 'Run code',
    group: 'transport',
    parameterNames: [],
    requiredParameterNames: [],
  },
]

const MCP_ROWS: readonly SessionToolEntry[] = [
  {
    name: 'mcp__github__create_issue',
    description: 'Create a GitHub issue',
    group: 'mcp',
    parameterNames: ['owner', 'title'],
    requiredParameterNames: ['owner'],
  },
  {
    name: 'mcp__filesystem__read_file',
    description: '读取 Windows 文件',
    group: 'mcp',
    parameterNames: ['path', 'encoding'],
    requiredParameterNames: ['path'],
  },
  {
    name: 'legacy_mcp_tool',
    description: 'Legacy capability without a qualified name',
    group: 'mcp',
    parameterNames: [],
    requiredParameterNames: [],
  },
  {
    name: 'run_code',
    description: 'Programmatic transport',
    group: 'transport',
    parameterNames: ['code'],
    requiredParameterNames: [],
  },
]

function toolsSnapshot(
  overrides: Partial<SessionToolsSnapshot> = {},
  tools: readonly SessionToolEntry[] = TOOL_ROWS,
): SessionToolsSnapshot {
  return {
    available: true,
    stale: false,
    generation: 3,
    tools,
    ...overrides,
  }
}

function mcpSnapshot(
  overrides: Partial<SessionToolsSnapshot> = {},
  tools: readonly SessionToolEntry[] = MCP_ROWS,
): SessionToolsSnapshot {
  return {
    available: true,
    stale: false,
    generation: 9,
    tools,
    ...overrides,
  }
}

describe('Capabilities Skills machine', () => {
  it('detaches snapshots, filters the catalog, and keeps request fencing', () => {
    const raw = skillsSnapshot([
      skill('alpha', { resourceBase: { kind: 'directory', path: 'D:\\alpha' } }),
      skill('beta'),
    ])
    const detached = detachSkillsSnapshot(raw)
    expect(detached).not.toBe(raw)
    expect(detached.skills).not.toBe(raw.skills)
    expect(Object.isFrozen(detached.skills[0]?.resourceBase)).toBe(true)
    expect(projectSkillsCatalog(detached, 'ALPHA workspace')).toMatchObject({
      rows: [{ name: 'alpha' }],
      totalCount: 2,
    })
    expect(projectSkillsCatalog(undefined, '')).toEqual({ rows: [], totalCount: 0 })
    expect(describeSkillResource(skill('alpha', {
      resourceBase: { kind: 'url', url: 'https://example.test/skill' },
    }))).toBe('https://example.test/skill')

    let state = createSkillsFeatureState()
    expect(transitionSkillsFeature(state, { type: 'selection.activated' }).state).toBe(state)
    expect(transitionSkillsFeature(state, {
      type: 'selection.move', direction: 'down', amount: 0,
    }).state).toBe(state)
    const first = { scopeEpoch: 1, requestId: 1 }
    const second = { scopeEpoch: 1, requestId: 2 }
    state = transitionSkillsFeature(state, { type: 'load.started', request: first }).state
    expect(state.phase).toBe('loading')
    state = transitionSkillsFeature(state, {
      type: 'snapshot.changed', snapshot: skillsSnapshot([skill('during-load')]),
    }).state
    expect(state).toMatchObject({ phase: 'loading', snapshot: { skills: [{ name: 'during-load' }] } })
    expect(transitionSkillsFeature(state, {
      type: 'load.succeeded', request: second, snapshot: raw,
    }).state).toBe(state)
    expect(transitionSkillsFeature(state, {
      type: 'load.failed', request: second, message: 'late',
    }).state).toBe(state)
    state = transitionSkillsFeature(state, {
      type: 'load.succeeded', request: first, snapshot: raw,
    }).state
    expect(state).toMatchObject({ phase: 'ready', selectedName: 'alpha' })
    const errorRequest = { scopeEpoch: 1, requestId: 3 }
    state = transitionSkillsFeature(state, { type: 'load.started', request: errorRequest }).state
    state = transitionSkillsFeature(state, {
      type: 'load.succeeded',
      request: errorRequest,
      snapshot: skillsSnapshot([skill('alpha'), skill('beta')], { error: 'reported failure' }),
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'reported failure' })
    state = transitionSkillsFeature(state, { type: 'load.started', request: second }).state
    expect(state.phase).toBe('refreshing')
    state = transitionSkillsFeature(state, {
      type: 'load.failed', request: second, message: 'failed',
    }).state
    expect(state).toMatchObject({ phase: 'failed', selectedName: 'alpha', error: 'failed' })
    expect(transitionSkillsFeature(state, { type: 'query.changed', query: '' }).state).toBe(state)
    state = transitionSkillsFeature(state, { type: 'selection.move', direction: 'down' }).state
    expect(state.selectedName).toBe('beta')
    expect(transitionSkillsFeature(state, { type: 'selection.move', direction: 'down' }).state).toBe(state)
    state = transitionSkillsFeature(state, {
      type: 'selection.move', direction: 'up', amount: Number.NaN,
    }).state
    expect(state.selectedName).toBe('alpha')
    expect(transitionSkillsFeature(state, { type: 'selection.activated' }).effects).toEqual([{
      type: 'route.open', routeId: 'skills.detail',
    }])
    expect(transitionSkillsFeature(state, { type: 'refresh.requested' }).effects).toEqual([{
      type: 'resource.refresh', resourceId: 'skills.catalog',
    }])
    state = transitionSkillsFeature(state, {
      type: 'snapshot.changed',
      snapshot: skillsSnapshot([skill('alpha')], { error: 'adapter failure' }),
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'adapter failure' })
  })
})

describe('Capabilities Tools machine', () => {
  it('loads a detached searchable view and keeps selection stable across generations', () => {
    let state = createToolsFeatureState()
    state = transitionToolsFeature(state, {
      type: 'load.started',
      request: request(3, 1),
    }).state
    state = transitionToolsFeature(state, {
      type: 'load.succeeded',
      request: request(3, 1),
      snapshot: toolsSnapshot(),
    }).state
    expect(projectToolsBrowser(state)).toMatchObject({
      totalCount: 3,
      selected: { name: 'read_file' },
      groups: [
        { id: 'core', count: 1 },
        { id: 'mcp', count: 1 },
        { id: 'transport', count: 1 },
      ],
    })
    const source = toolsSnapshot()
    expect(state.snapshot?.tools).not.toBe(source.tools)
    expect(state.snapshot?.tools[0]?.parameterNames).not.toBe(source.tools[0]?.parameterNames)

    state = transitionToolsFeature(state, {
      type: 'selection.move',
      direction: 'down',
    }).state
    expect(projectToolsBrowser(state)?.selected?.name).toBe('mcp__github__create_issue')
    state = transitionToolsFeature(state, {
      type: 'snapshot.changed',
      snapshot: toolsSnapshot({ generation: 8 }, [...TOOL_ROWS].reverse()),
    }).state
    expect(projectToolsBrowser(state)?.selected?.name).toBe('mcp__github__create_issue')

    state = transitionToolsFeature(state, {
      type: 'query.edit',
      action: { type: 'insert', text: 'github owner' },
    }).state
    expect(projectToolsBrowser(state)?.rows.map(row => row.name))
      .toEqual(['mcp__github__create_issue'])
    expect(transitionToolsFeature(state, {
      type: 'query.edit',
      action: { type: 'move-end' },
    }).state).toBe(state)
    expect(transitionToolsFeature(state, {
      type: 'refresh.requested',
    }).effects).toEqual([{ type: 'resource.refresh', resourceId: 'tools.catalog' }])
  })

  it('retains last-good state and ignores stale or inapplicable transitions', () => {
    const idle = createToolsFeatureState()
    expect(projectToolsBrowser(idle)).toBeUndefined()
    expect(transitionToolsFeature(idle, {
      type: 'selection.move',
      direction: 'down',
    }).state).toBe(idle)
    expect(transitionToolsFeature(idle, {
      type: 'query.edit',
      action: { type: 'insert', text: 'x' },
    }).state).toBe(idle)
    expect(transitionToolsFeature(idle, {
      type: 'load.succeeded',
      request: request(9, 9),
      snapshot: toolsSnapshot(),
    }).state).toBe(idle)

    let state = transitionToolsFeature(idle, {
      type: 'load.started',
      request: request(4, 1),
    }).state
    expect(transitionToolsFeature(state, {
      type: 'load.succeeded',
      request: request(3, 1),
      snapshot: toolsSnapshot({}, []),
    }).state).toBe(state)
    expect(transitionToolsFeature(state, {
      type: 'load.failed',
      request: request(3, 1),
      message: 'late',
    }).state).toBe(state)
    state = transitionToolsFeature(state, {
      type: 'load.succeeded',
      request: request(4, 1),
      snapshot: toolsSnapshot(),
    }).state
    expect(transitionToolsFeature(state, {
      type: 'selection.move',
      direction: 'up',
    }).state).toBe(state)
    state = transitionToolsFeature(state, {
      type: 'load.started',
      request: request(4, 2),
    }).state
    expect(state.phase).toBe('refreshing')
    state = transitionToolsFeature(state, {
      type: 'load.failed',
      request: request(4, 2),
      message: 'registry failed',
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'registry failed' })
    expect(projectToolsBrowser(state)?.totalCount).toBe(3)

    state = transitionToolsFeature(state, {
      type: 'snapshot.changed',
      snapshot: toolsSnapshot({ stale: true, error: 'last-good registry' }),
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'last-good registry' })
    state = transitionToolsFeature(state, {
      type: 'snapshot.failed',
      message: 'snapshot threw',
    }).state
    expect(state.error).toBe('snapshot threw')
  })
})

describe('Capabilities MCP machine', () => {
  it('filters exact MCP rows, detaches data, and preserves namespace identity', () => {
    const source = mcpSnapshot()
    let state = transitionMcpFeature(createMcpFeatureState(), {
      type: 'load.started', request: request(2, 1),
    }).state
    state = transitionMcpFeature(state, {
      type: 'load.succeeded', request: request(2, 1), snapshot: source,
    }).state
    expect(projectMcpBrowser(state)).toMatchObject({
      totalCount: 3,
      namespaceCount: 3,
      selected: {
        name: 'mcp__github__create_issue',
        serverName: 'github',
        toolName: 'create_issue',
      },
    })
    expect(projectMcpBrowser(state)?.rows.map(row => row.name)).toEqual([
      'mcp__github__create_issue',
      'mcp__filesystem__read_file',
      'legacy_mcp_tool',
    ])
    expect(state.snapshot?.tools).not.toBe(source.tools)
    expect(state.snapshot?.tools[0]?.parameterNames).not.toBe(source.tools[0]?.parameterNames)

    state = transitionMcpFeature(state, {
      type: 'selection.move', direction: 'down',
    }).state
    expect(projectMcpBrowser(state)?.selected?.serverName).toBe('filesystem')
    state = transitionMcpFeature(state, {
      type: 'snapshot.changed',
      snapshot: mcpSnapshot({ generation: 12 }, [...MCP_ROWS].reverse()),
    }).state
    expect(projectMcpBrowser(state)?.selected?.name).toBe('mcp__filesystem__read_file')
    state = transitionMcpFeature(state, {
      type: 'query.edit', action: { type: 'insert', text: '文件 path' },
    }).state
    expect(projectMcpBrowser(state)?.rows.map(row => row.name))
      .toEqual(['mcp__filesystem__read_file'])
    expect(transitionMcpFeature(state, {
      type: 'query.edit', action: { type: 'move-end' },
    }).state).toBe(state)
    expect(transitionMcpFeature(state, { type: 'refresh.requested' }).effects)
      .toEqual([{ type: 'resource.refresh', resourceId: 'mcp.catalog' }])
  })

  it('retains last-good state and rejects stale or inapplicable transitions', () => {
    const idle = createMcpFeatureState()
    expect(projectMcpBrowser(idle)).toBeUndefined()
    expect(transitionMcpFeature(idle, {
      type: 'selection.move', direction: 'down',
    }).state).toBe(idle)
    expect(transitionMcpFeature(idle, {
      type: 'query.edit', action: { type: 'insert', text: 'x' },
    }).state).toBe(idle)
    expect(transitionMcpFeature(idle, {
      type: 'load.succeeded', request: request(9, 9), snapshot: mcpSnapshot(),
    }).state).toBe(idle)

    let state = transitionMcpFeature(idle, {
      type: 'load.started', request: request(3, 1),
    }).state
    expect(transitionMcpFeature(state, {
      type: 'load.succeeded', request: request(4, 1), snapshot: mcpSnapshot({}, []),
    }).state).toBe(state)
    expect(transitionMcpFeature(state, {
      type: 'load.failed', request: request(4, 1), message: 'late',
    }).state).toBe(state)
    state = transitionMcpFeature(state, {
      type: 'load.succeeded', request: request(3, 1), snapshot: mcpSnapshot(),
    }).state
    expect(transitionMcpFeature(state, {
      type: 'selection.move', direction: 'up',
    }).state).toBe(state)
    state = transitionMcpFeature(state, {
      type: 'load.started', request: request(3, 2),
    }).state
    expect(state.phase).toBe('refreshing')
    state = transitionMcpFeature(state, {
      type: 'load.failed', request: request(3, 2), message: 'registry failed',
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'registry failed' })
    expect(projectMcpBrowser(state)?.totalCount).toBe(3)
    state = transitionMcpFeature(state, {
      type: 'snapshot.changed', snapshot: mcpSnapshot({ stale: true, error: 'last-good' }),
    }).state
    expect(state).toMatchObject({ phase: 'failed', error: 'last-good' })
    state = transitionMcpFeature(state, { type: 'snapshot.failed', message: 'snapshot threw' }).state
    expect(state.error).toBe('snapshot threw')
  })
})

describe('Capabilities wrapper machine', () => {
  it('cycles tabs and remembers the last tab while the model lives', () => {
    let state = createCapabilitiesFeatureState()
    expect(state.tab).toBe('skills')
    state = transitionCapabilitiesFeature(state, { type: 'tab.next' }).state
    expect(state.tab).toBe('tools')
    state = transitionCapabilitiesFeature(state, { type: 'tab.next' }).state
    expect(state.tab).toBe('mcp')
    state = transitionCapabilitiesFeature(state, { type: 'tab.next' }).state
    expect(state.tab).toBe('skills')
    state = transitionCapabilitiesFeature(state, { type: 'tab.previous' }).state
    expect(state.tab).toBe('mcp')
    state = transitionCapabilitiesFeature(state, { type: 'tab.set', tab: 'tools' }).state
    expect(state.tab).toBe('tools')
    expect(transitionCapabilitiesFeature(state, { type: 'tab.set', tab: 'tools' }).state).toBe(state)
    expect(transitionCapabilitiesFeature(state, { type: 'tab.previous' }).effects).toEqual([])
  })

  it('routes domain events to the owning sub-machine and translates effects', () => {
    let state = createCapabilitiesFeatureState()
    const loadedSkills = transitionSkillsFeature(state.skills, {
      type: 'load.started', request: request(1, 1),
    }).state
    state = transitionCapabilitiesFeature(state, {
      type: 'skills',
      event: { type: 'load.started', request: request(1, 1) },
    }).state
    expect(state.skills).toEqual(loadedSkills)
    expect(state.tools.phase).toBe('idle')

    const refreshed = transitionCapabilitiesFeature(state, {
      type: 'skills',
      event: { type: 'refresh.requested' },
    })
    expect(refreshed.effects).toEqual([{ type: 'resource.refresh', resourceId: 'skills.catalog' }])

    const withSkill = {
      ...state,
      skills: transitionSkillsFeature(
        transitionSkillsFeature(createSkillsFeatureState(), {
          type: 'load.started', request: request(1, 1),
        }).state,
        { type: 'load.succeeded', request: request(1, 1), snapshot: skillsSnapshot([skill('alpha')]) },
      ).state,
    }
    const opened = transitionCapabilitiesFeature(withSkill, { type: 'details.open' })
    expect(opened.effects).toEqual([])
    expect(opened.state.details).toEqual({ fieldIndex: 0 })
    expect(transitionCapabilitiesFeature(opened.state, { type: 'details.open' }).state).toBe(opened.state)
    const moved = transitionCapabilitiesFeature(opened.state, { type: 'details.move', direction: 'down' })
    expect(moved.state.details).toEqual({ fieldIndex: 1 })
    expect(transitionCapabilitiesFeature(moved.state, { type: 'details.move', direction: 'up' }).state.details)
      .toEqual({ fieldIndex: 0 })
    expect(transitionCapabilitiesFeature(opened.state, { type: 'details.move', direction: 'up' }).state)
      .toBe(opened.state)
    const tabbed = transitionCapabilitiesFeature(opened.state, { type: 'tab.next' })
    expect(tabbed.state.details).toBeUndefined()
    expect(tabbed.state.tab).toBe('tools')
    const closed = transitionCapabilitiesFeature(opened.state, { type: 'details.close' })
    expect(closed.state.details).toBeUndefined()
    expect(transitionCapabilitiesFeature(closed.state, { type: 'details.close' }).state).toBe(closed.state)
    expect(transitionCapabilitiesFeature(state, { type: 'details.open' }).state).toBe(state)
    expect(transitionCapabilitiesFeature(state, { type: 'details.move', direction: 'down' }).state).toBe(state)
    expect(transitionCapabilitiesFeature(state, { type: 'page.back' }).effects).toEqual([{
      type: 'route.open', routeId: 'chat',
    }])

    expect(transitionCapabilitiesFeature(state, {
      type: 'tools',
      event: { type: 'refresh.requested' },
    }).effects).toEqual([{ type: 'resource.refresh', resourceId: 'tools.catalog' }])
    expect(transitionCapabilitiesFeature(state, {
      type: 'mcp',
      event: { type: 'refresh.requested' },
    }).effects).toEqual([{ type: 'resource.refresh', resourceId: 'mcp.catalog' }])
  })

  it('isolates listeners and disposal in the wrapper model', () => {
    const model = createCapabilitiesFeatureModel()
    const changed = vi.fn()
    const stop = model.onChanged(changed)
    model.onChanged(() => { throw new Error('renderer failed') })
    const effect = vi.fn()
    const stopEffect = model.onEffect(effect)
    model.onEffect(() => { throw new Error('effect adapter failed') })
    model.dispatch({ type: 'tab.next' })
    expect(changed).toHaveBeenCalledOnce()
    model.dispatch({ type: 'skills', event: { type: 'refresh.requested' } })
    expect(effect).toHaveBeenCalledExactlyOnceWith({
      type: 'resource.refresh', resourceId: 'skills.catalog',
    })
    stop()
    stop()
    stopEffect()
    stopEffect()
    model.dispose()
    model.dispose()
    expect(() => model.onChanged(vi.fn())).toThrow('disposed')
    expect(() => model.onEffect(vi.fn())).toThrow('disposed')
    expect(() => model.dispatch({ type: 'tab.next' })).toThrow('disposed')
  })
})

interface StubSource {
  snapshot(): ReturnType<typeof createCapabilitiesFeatureState>
  onChanged(): () => void
}

function sourceOf(state: ReturnType<typeof createCapabilitiesFeatureState>): StubSource {
  return {
    snapshot: () => state,
    onChanged: () => () => {},
  }
}

const PROJECT_CONTEXT = {
  bounds: { x: 0, y: 0, width: 100, height: 20 },
  focus: true,
  mode: 'normal' as const,
  resources: [],
}

function projectTab(
  state: ReturnType<typeof createCapabilitiesFeatureState>,
): string {
  const source = sourceOf(state)
  return createCapabilitiesNavigatorNode(source).project(PROJECT_CONTEXT)
    .rows.map(row => row.text).join('\n')
}

describe('Capabilities nodes', () => {
  it('projects the tab strip and tab content per tab', () => {
    const skills = transitionSkillsFeature(createSkillsFeatureState(), {
      type: 'snapshot.changed',
      snapshot: skillsSnapshot([skill('alpha', { description: 'first' })]),
    }).state
    const tools = transitionToolsFeature(createToolsFeatureState(), {
      type: 'snapshot.changed',
      snapshot: toolsSnapshot(),
    }).state
    const mcp = transitionMcpFeature(createMcpFeatureState(), {
      type: 'snapshot.changed',
      snapshot: mcpSnapshot(),
    }).state
    const state = {
      ...createCapabilitiesFeatureState(),
      skills,
      tools,
      mcp,
    }

    const skillsText = projectTab(state)
    expect(skillsText).toContain('▰ SKILLS 1')
    expect(skillsText).toContain('1/1 available skills')
    expect(skillsText).toContain('FILTER  i to search · r to refresh')
    expect(skillsText).toContain('alpha · first')

    const toolsText = projectTab({ ...state, tab: 'tools' })
    expect(toolsText).toContain('▰ TOOLS 3')
    expect(toolsText).toContain('3/3 available tools')
    expect(toolsText).toContain('read_file · Read a file from disk')

    const mcpText = projectTab({ ...state, tab: 'mcp' })
    expect(mcpText).toContain('▰ MCP 3')
    expect(mcpText).toContain('github / create_issue')
    expect(mcpText).not.toContain('tools available in this session')
  })

  it('keeps honest empty, loading and failure states per tab', () => {
    const idle = createCapabilitiesFeatureState()
    const idleText = projectTab(idle)
    expect(idleText).toContain('No user-invocable skills were discovered')

    const toolsText = projectTab({ ...idle, tab: 'tools' })
    expect(toolsText).toContain('No tools available in this session')

    const mcpText = projectTab({ ...idle, tab: 'mcp' })
    expect(mcpText).toContain('No MCP servers configured — manage providers in /settings')

    const failed = {
      ...idle,
      skills: transitionSkillsFeature(transitionSkillsFeature(createSkillsFeatureState(), {
        type: 'load.started', request: request(1, 1),
      }).state, {
        type: 'load.failed', request: request(1, 1), message: 'discovery offline',
      }).state,
    }
    expect(projectTab(failed)).toContain('Last refresh failed · discovery offline')
  })

  it('projects read-only detail fields for the active tab selection', () => {
    const skills = transitionSkillsFeature(createSkillsFeatureState(), {
      type: 'snapshot.changed',
      snapshot: skillsSnapshot([skill('alpha', { description: 'first' })]),
    }).state
    const skillsView = projectCapabilitiesDetails({ ...createCapabilitiesFeatureState(), skills })
    expect(skillsView?.title).toBe('alpha')
    expect(skillsView?.fields.map(entry => [entry.label, entry.value])).toEqual([
      ['Name', 'alpha'],
      ['Description', 'first'],
      ['Source', 'workspace'],
      ['Provider', 'filesystem'],
      ['Usage', 'Use /alpha in Chat'],
      ['Agent', 'The agent can also choose this skill'],
    ])

    const tools = transitionToolsFeature(createToolsFeatureState(), {
      type: 'snapshot.changed',
      snapshot: toolsSnapshot(),
    }).state
    const toolsView = projectCapabilitiesDetails({ ...createCapabilitiesFeatureState(), tab: 'tools', tools })
    expect(toolsView?.title).toBe('read_file')
    expect(toolsView?.fields.map(entry => entry.label)).toEqual([
      'Name', 'Description', 'Group', 'Parameters', 'Required',
    ])
    expect(toolsView?.fields.find(entry => entry.id === 'parameters')?.value).toBe('path')
    expect(toolsView?.fields.find(entry => entry.id === 'required')?.value).toBe('path')

    const mcp = transitionMcpFeature(createMcpFeatureState(), {
      type: 'snapshot.changed',
      snapshot: mcpSnapshot(),
    }).state
    const mcpView = projectCapabilitiesDetails({ ...createCapabilitiesFeatureState(), tab: 'mcp', mcp })
    expect(mcpView?.title).toBe('github / create_issue')
    expect(mcpView?.fields.find(entry => entry.id === 'qualified')?.value).toBe('mcp__github__create_issue')

    expect(projectCapabilitiesDetails(createCapabilitiesFeatureState())).toBeUndefined()
  })
})

interface FakeCapabilitiesPorts {
  readonly skills: {
    skillsSnapshot(): SessionSkillsSnapshot
    refreshSkills: ReturnType<typeof vi.fn>
    onSkillsChanged: ReturnType<typeof vi.fn>
    disposeSkills: ReturnType<typeof vi.fn>
    setSnapshot(next: SessionSkillsSnapshot): void
    emit(): void
  }
  readonly tools: {
    toolsSnapshot(): SessionToolsSnapshot
    onToolsChanged: ReturnType<typeof vi.fn>
    emit(): void
  }
}

function fakePorts(): FakeCapabilitiesPorts {
  let skills = skillsSnapshot([skill('alpha')])
  const skillsListeners = new Set<() => void>()
  let tools = toolsSnapshot()
  const toolsListeners = new Set<() => void>()
  return {
    skills: {
      skillsSnapshot: () => skills,
      refreshSkills: vi.fn(async () => {}),
      onSkillsChanged: vi.fn((listener: () => void) => {
        skillsListeners.add(listener)
        let active = true
        return () => {
          if (!active) return
          active = false
          skillsListeners.delete(listener)
        }
      }),
      disposeSkills: vi.fn(),
      setSnapshot: (next) => { skills = next },
      emit: () => { for (const listener of [...skillsListeners]) listener() },
    },
    tools: {
      toolsSnapshot: () => tools,
      onToolsChanged: vi.fn((listener: () => void) => {
        toolsListeners.add(listener)
        let active = true
        return () => {
          if (!active) return
          active = false
          toolsListeners.delete(listener)
        }
      }),
      emit: () => { for (const listener of [...toolsListeners]) listener() },
    },
  }
}

function command(instance: CapabilitiesFeatureInstance, id: string): FeatureCommandHandler {
  const handler = instance.contributions.commands?.find(candidate => candidate.id === id)?.value
  if (handler === undefined) throw new Error(`missing command ${id}`)
  return handler
}

const commandContext = (openRoute = vi.fn(async () => {})) => ({
  navigation: {} as never,
  openRoute,
})

function routed(command: Parameters<FeatureCommandHandler['handle']>[0]['command']) {
  return Object.freeze({
    target: Object.freeze({ kind: 'feature' as const, featureId: CAPABILITIES_FEATURE_ID }),
    command,
  })
}

describe('Capabilities Feature factory', () => {
  it('declares a lazy session-scoped workspace with the three catalogs and one pane', async () => {
    expect(capabilitiesFeature.manifest).toMatchObject({
      id: CAPABILITIES_FEATURE_ID,
      scope: 'session',
      activation: 'on-route',
      required: false,
    })
    expect(capabilitiesFeature.declarations).toEqual(expect.objectContaining({
      routes: [CAPABILITIES_ROUTE_ID],
      keymaps: [CAPABILITIES_KEYMAP_ID],
      resources: [
        CAPABILITIES_SKILLS_RESOURCE_ID,
        CAPABILITIES_TOOLS_RESOURCE_ID,
        CAPABILITIES_MCP_RESOURCE_ID,
      ],
    }))

    const ports = fakePorts()
    const instance = await capabilitiesFeature.create({
      scope: { epoch: 1, signal: new AbortController().signal } as never,
      dependencies: [
        { token: SESSION_SKILLS_CAPABILITY, value: ports.skills as never },
        { token: SESSION_TOOLS_CAPABILITY, value: ports.tools as never },
      ],
    }) as CapabilitiesFeatureInstance
    expect(ports.skills.refreshSkills).not.toHaveBeenCalled()

    expect(instance.contributions.routes).toEqual([
      { id: CAPABILITIES_ROUTE_ID, value: { kind: 'workspace', featureId: CAPABILITIES_FEATURE_ID, pane: 'content' } },
    ])
    expect(instance.contributions.keymaps).toEqual([{
      id: CAPABILITIES_KEYMAP_ID,
      value: {
        context: { routeKind: 'workspace', featureId: CAPABILITIES_FEATURE_ID, mode: 'normal' },
        bindings: [
          { key: '[', commandId: CAPABILITIES_TAB_PREVIOUS_COMMAND_ID },
          { key: ']', commandId: CAPABILITIES_TAB_NEXT_COMMAND_ID },
          { key: 'k', commandId: CAPABILITIES_MOVE_UP_COMMAND_ID },
          { key: 'j', commandId: CAPABILITIES_MOVE_DOWN_COMMAND_ID },
          { key: 'r', commandId: CAPABILITIES_REFRESH_COMMAND_ID },
          { key: 'q', commandId: CAPABILITIES_DISMISS_COMMAND_ID },
          { key: 'escape', commandId: CAPABILITIES_DISMISS_COMMAND_ID },
        ],
      },
    }])
    expect(instance.contributions.surfaces).toEqual([
      expect.objectContaining({
        id: CAPABILITIES_NAVIGATOR_SURFACE_ID,
        slot: 'workspace.content',
        value: expect.objectContaining({
          role: 'content',
          node: expect.objectContaining({ kind: 'capabilities.navigator' }),
        }),
      }),
    ])
    await instance.dispose()
  })

  it('routes commands through the active tab and opens details in a page modal', async () => {
    const ports = fakePorts()
    const instance = await capabilitiesFeature.create({
      scope: { epoch: 1, signal: new AbortController().signal } as never,
      dependencies: [
        { token: SESSION_SKILLS_CAPABILITY, value: ports.skills as never },
        { token: SESSION_TOOLS_CAPABILITY, value: ports.tools as never },
      ],
    }) as CapabilitiesFeatureInstance
    const model = instance.model

    const openRoute = vi.fn(async () => {})
    const context = commandContext(openRoute)

    await command(instance, CAPABILITIES_TAB_NEXT_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: CAPABILITIES_TAB_NEXT_COMMAND_ID }),
      context,
    )
    expect(model.snapshot().tab).toBe('tools')
    await command(instance, CAPABILITIES_TAB_PREVIOUS_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: CAPABILITIES_TAB_PREVIOUS_COMMAND_ID }),
      context,
    )
    expect(model.snapshot().tab).toBe('skills')

    model.dispatch({
      type: 'skills',
      event: { type: 'snapshot.changed', snapshot: skillsSnapshot([skill('alpha'), skill('beta')]) },
    })
    await command(instance, 'navigation.move').handle(
      routed({ type: 'navigation.move', direction: 'down' }),
      context,
    )
    expect(model.snapshot().skills.selectedName).toBe('beta')
    await command(instance, 'action.submit').handle(routed({ type: 'action.submit' }), context)
    expect(model.snapshot().details).toEqual({ fieldIndex: 0 })
    expect(openRoute).not.toHaveBeenCalled()

    await command(instance, CAPABILITIES_MOVE_DOWN_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: CAPABILITIES_MOVE_DOWN_COMMAND_ID }),
      context,
    )
    expect(model.snapshot().details).toEqual({ fieldIndex: 1 })
    expect(model.snapshot().skills.selectedName).toBe('beta')
    await command(instance, CAPABILITIES_REFRESH_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: CAPABILITIES_REFRESH_COMMAND_ID }),
      context,
    )
    expect(model.snapshot().details).toEqual({ fieldIndex: 1 })

    await command(instance, CAPABILITIES_DISMISS_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: CAPABILITIES_DISMISS_COMMAND_ID }),
      context,
    )
    expect(model.snapshot().details).toBeUndefined()
    expect(openRoute).not.toHaveBeenCalled()
    await command(instance, CAPABILITIES_DISMISS_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: CAPABILITIES_DISMISS_COMMAND_ID }),
      context,
    )
    expect(openRoute).toHaveBeenCalledExactlyOnceWith('chat')

    await command(instance, 'edit.insert').handle(routed({ type: 'edit.insert', text: 'alp' }), context)
    expect(model.snapshot().skills.query).toBe('alp')
    await command(instance, 'edit.delete-backward').handle(routed({ type: 'edit.delete-backward' }), context)
    expect(model.snapshot().skills.query).toBe('al')

    await command(instance, CAPABILITIES_TAB_NEXT_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: CAPABILITIES_TAB_NEXT_COMMAND_ID }),
      context,
    )
    model.dispatch({
      type: 'tools',
      event: { type: 'load.started', request: request(1, 1) },
    })
    model.dispatch({
      type: 'tools',
      event: { type: 'load.succeeded', request: request(1, 1), snapshot: toolsSnapshot() },
    })
    await command(instance, 'navigation.move').handle(
      routed({ type: 'navigation.move', direction: 'down' }),
      context,
    )
    expect(projectToolsBrowser(model.snapshot().tools)?.selected?.name).toBe('mcp__github__create_issue')
    await command(instance, 'action.submit').handle(routed({ type: 'action.submit' }), context)
    expect(model.snapshot().details).toEqual({ fieldIndex: 0 })
    expect(openRoute).toHaveBeenCalledOnce()

    await instance.dispose()
  })

  it('refreshes only the active tab catalog through the matching resource', async () => {
    const ports = fakePorts()
    const instance = await capabilitiesFeature.create({
      scope: { epoch: 1, signal: new AbortController().signal } as never,
      dependencies: [
        { token: SESSION_SKILLS_CAPABILITY, value: ports.skills as never },
        { token: SESSION_TOOLS_CAPABILITY, value: ports.tools as never },
      ],
    }) as CapabilitiesFeatureInstance
    const model = instance.model
    const invalidated: string[] = []
    const stops = (instance.contributions.resources ?? []).map((contribution) => {
      const resource = contribution.value as {
        watch(context: { signal: AbortSignal; invalidate(): void }): () => void
      }
      return resource.watch({
        signal: new AbortController().signal,
        invalidate: () => { invalidated.push(contribution.id) },
      })
    })

    const context = commandContext()
    await command(instance, CAPABILITIES_REFRESH_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: CAPABILITIES_REFRESH_COMMAND_ID }),
      context,
    )
    expect(invalidated).toEqual(['skills.catalog'])
    expect(ports.skills.refreshSkills).not.toHaveBeenCalled()

    model.dispatch({ type: 'tab.set', tab: 'tools' })
    await command(instance, CAPABILITIES_REFRESH_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: CAPABILITIES_REFRESH_COMMAND_ID }),
      context,
    )
    expect(invalidated).toEqual(['skills.catalog', 'tools.catalog'])

    model.dispatch({ type: 'tab.set', tab: 'mcp' })
    await command(instance, CAPABILITIES_REFRESH_COMMAND_ID).handle(
      routed({ type: 'feature.command', commandId: CAPABILITIES_REFRESH_COMMAND_ID }),
      context,
    )
    expect(invalidated).toEqual(['skills.catalog', 'tools.catalog', 'mcp.catalog'])

    for (const stop of stops) stop()
    await instance.dispose()
  })
})
