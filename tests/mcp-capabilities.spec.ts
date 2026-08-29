import { describe, expect, it } from 'vitest'
import type { SessionToolsSnapshot } from '../src/tool/port.ts'
import {
  applyMcpCapabilityBrowserAction,
  createMcpCapabilityBrowserState,
  openMcpCapabilityBrowser,
  reconcileMcpCapabilityBrowser,
  selectMcpCapabilityBrowser,
} from '../src/mcp/capabilities.ts'

function snapshot(
  overrides: Partial<SessionToolsSnapshot> = {},
): SessionToolsSnapshot {
  return {
    available: true,
    stale: false,
    generation: 7,
    tools: [
      {
        name: 'read_file',
        description: 'Read one local file',
        group: 'core',
        parameterNames: ['path'],
        requiredParameterNames: ['path'],
      },
      {
        name: 'mcp__filesystem__read_text',
        description: 'Read text through the filesystem server',
        group: 'mcp',
        parameterNames: ['path'],
        requiredParameterNames: ['path'],
      },
      {
        name: 'mcp__github__create_issue',
        description: 'Create a GitHub issue',
        group: 'mcp',
        parameterNames: ['owner', 'title'],
        requiredParameterNames: ['owner'],
      },
      {
        name: 'mcp__github__search_code',
        description: 'Search GitHub code',
        group: 'mcp',
        parameterNames: ['query'],
        requiredParameterNames: ['query'],
      },
      {
        name: 'run_code',
        description: 'Programmatic tool transport',
        group: 'transport',
        parameterNames: ['code'],
        requiredParameterNames: ['code'],
      },
    ],
    ...overrides,
  }
}

describe('MCP exact-Agent capability browser', () => {
  it('projects only mounted MCP tools and keeps their official namespace identity', () => {
    const closed = createMcpCapabilityBrowserState()
    expect(selectMcpCapabilityBrowser(closed, snapshot())).toBeUndefined()
    expect(applyMcpCapabilityBrowserAction(
      closed,
      snapshot(),
      { type: 'move-down' },
    ).state).toBe(closed)

    let state = openMcpCapabilityBrowser(closed, snapshot())
    expect(openMcpCapabilityBrowser(state, snapshot())).toBe(state)
    let view = selectMcpCapabilityBrowser(state, snapshot())!
    expect(view.rows.map(row => ({ server: row.serverName, tool: row.toolName }))).toEqual([
      { server: 'filesystem', tool: 'read_text' },
      { server: 'github', tool: 'create_issue' },
      { server: 'github', tool: 'search_code' },
    ])
    expect(view.namespaceCount).toBe(2)
    expect(view.totalCount).toBe(3)
    expect(view.selected?.name).toBe('mcp__filesystem__read_text')

    state = applyMcpCapabilityBrowserAction(state, snapshot(), { type: 'move-down' }).state
    expect(selectMcpCapabilityBrowser(state, snapshot())?.selected?.toolName).toBe('create_issue')
    state = applyMcpCapabilityBrowserAction(state, snapshot(), {
      type: 'edit',
      action: { type: 'insert', text: 'github owner' },
    }).state
    view = selectMcpCapabilityBrowser(state, snapshot())!
    expect(view.rows.map(row => row.toolName)).toEqual(['create_issue'])
    expect(view.selected?.serverName).toBe('github')
  })

  it('preserves selection across ToolRuntime generations and falls back when removed', () => {
    let state = openMcpCapabilityBrowser(createMcpCapabilityBrowserState(), snapshot())
    state = applyMcpCapabilityBrowserAction(state, snapshot(), { type: 'move-down' }).state

    const reordered = snapshot({ tools: [...snapshot().tools].reverse(), generation: 8 })
    state = reconcileMcpCapabilityBrowser(state, reordered)
    expect(selectMcpCapabilityBrowser(state, reordered)?.selected?.toolName).toBe('create_issue')

    const removed = snapshot({
      generation: 9,
      tools: [snapshot().tools[3]!, snapshot().tools[0]!],
    })
    state = reconcileMcpCapabilityBrowser(state, removed)
    expect(selectMcpCapabilityBrowser(state, removed)?.selected?.toolName).toBe('search_code')
  })

  it('keeps truthful empty, stale, malformed, and closed projections', () => {
    let state = openMcpCapabilityBrowser(createMcpCapabilityBrowserState(), snapshot())
    state = applyMcpCapabilityBrowserAction(state, snapshot(), {
      type: 'edit',
      action: { type: 'insert', text: 'missing' },
    }).state
    expect(selectMcpCapabilityBrowser(state, snapshot())).toMatchObject({
      rows: [],
      selectedIndex: -1,
      totalCount: 3,
      namespaceCount: 2,
    })

    const stale = snapshot({ stale: true, error: 'registry failed' })
    expect(selectMcpCapabilityBrowser(
      openMcpCapabilityBrowser(createMcpCapabilityBrowserState(), stale),
      stale,
    )).toMatchObject({ stale: true, error: 'registry failed' })

    const malformed = snapshot({
      tools: [{
        name: 'mcp__broken',
        description: 'Reserved-prefix capability without a qualified server',
        group: 'mcp',
        parameterNames: [],
        requiredParameterNames: [],
      }],
    })
    const malformedView = selectMcpCapabilityBrowser(
      openMcpCapabilityBrowser(createMcpCapabilityBrowserState(), malformed),
      malformed,
    )!
    expect(malformedView.selected).toMatchObject({
      serverName: 'unqualified',
      toolName: 'mcp__broken',
    })

    const underscore = snapshot({
      tools: [{
        name: 'mcp___private__ping',
        description: 'Ping a private MCP namespace',
        group: 'mcp',
        parameterNames: [],
        requiredParameterNames: [],
      }],
    })
    expect(selectMcpCapabilityBrowser(
      openMcpCapabilityBrowser(createMcpCapabilityBrowserState(), underscore),
      underscore,
    )?.selected).toMatchObject({ serverName: '_private', toolName: 'ping' })

    const transition = applyMcpCapabilityBrowserAction(
      state,
      snapshot(),
      { type: 'escape' },
    )
    expect(transition.outcome).toEqual({ kind: 'cancelled' })
    expect(selectMcpCapabilityBrowser(transition.state, snapshot())).toBeUndefined()
  })
})
