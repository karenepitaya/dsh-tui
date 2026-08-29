import { describe, expect, it } from 'vitest'
import type { SessionToolsSnapshot } from '../src/tool/port.ts'
import {
  applyToolBrowserAction,
  createToolBrowserState,
  openToolBrowser,
  reconcileToolBrowser,
  selectToolBrowser,
} from '../src/tool/browser.ts'

function snapshot(
  overrides: Partial<SessionToolsSnapshot> = {},
): SessionToolsSnapshot {
  return {
    available: true,
    stale: false,
    generation: 1,
    tools: [
      {
        name: 'read_file',
        description: 'Read a file from disk',
        group: 'core',
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
        name: 'run_code',
        description: 'Dispatch several tools from code',
        group: 'transport',
        parameterNames: ['code'],
        requiredParameterNames: ['code'],
      },
    ],
    ...overrides,
  }
}

describe('tool capability browser state', () => {
  it('opens a stable searchable directory grouped by capability kind', () => {
    const closed = createToolBrowserState()
    expect(selectToolBrowser(closed, snapshot())).toBeUndefined()
    expect(applyToolBrowserAction(closed, snapshot(), { type: 'move-down' }).state).toBe(closed)

    let state = openToolBrowser(closed, snapshot())
    expect(openToolBrowser(state, snapshot())).toBe(state)
    let view = selectToolBrowser(state, snapshot())!
    expect(view.selected?.name).toBe('read_file')
    expect(view.groups).toEqual([
      { id: 'core', label: 'Core', count: 1 },
      { id: 'mcp', label: 'MCP', count: 1 },
      { id: 'transport', label: 'Code transport', count: 1 },
    ])

    state = applyToolBrowserAction(state, snapshot(), { type: 'move-down' }).state
    expect(selectToolBrowser(state, snapshot())?.selected?.name).toBe('mcp__github__create_issue')
    state = applyToolBrowserAction(state, snapshot(), { type: 'move-up' }).state
    state = applyToolBrowserAction(state, snapshot(), { type: 'move-up' }).state
    expect(selectToolBrowser(state, snapshot())?.selected?.name).toBe('read_file')

    state = applyToolBrowserAction(state, snapshot(), {
      type: 'edit',
      action: { type: 'insert', text: 'github owner' },
    }).state
    view = selectToolBrowser(state, snapshot())!
    expect(view.rows.map(row => row.name)).toEqual(['mcp__github__create_issue'])
    expect(view.selected?.group).toBe('mcp')
  })

  it('preserves selection by capability name and falls back after catalog changes', () => {
    let state = openToolBrowser(createToolBrowserState(), snapshot())
    state = applyToolBrowserAction(state, snapshot(), { type: 'move-down' }).state
    const reordered = snapshot({ tools: [...snapshot().tools].reverse() })
    state = reconcileToolBrowser(state, reordered)
    expect(selectToolBrowser(state, reordered)?.selected?.name).toBe('mcp__github__create_issue')

    const removed = snapshot({ tools: [snapshot().tools[2]!] })
    state = reconcileToolBrowser(state, removed)
    expect(selectToolBrowser(state, removed)?.selected?.name).toBe('run_code')
  })

  it('represents no matches, unavailable projections, and explicit close', () => {
    let state = openToolBrowser(createToolBrowserState(), snapshot())
    state = applyToolBrowserAction(state, snapshot(), {
      type: 'edit',
      action: { type: 'insert', text: 'not-present' },
    }).state
    const empty = selectToolBrowser(state, snapshot())!
    expect(empty.rows).toEqual([])
    expect(empty.selectedIndex).toBe(-1)
    expect(empty.selected).toBeUndefined()
    expect(applyToolBrowserAction(state, snapshot(), { type: 'move-down' }).state).toBe(state)

    const unavailable = snapshot({ available: false, tools: [] })
    expect(selectToolBrowser(reconcileToolBrowser(state, unavailable), unavailable)).toMatchObject({
      available: false,
      rows: [],
    })

    const transition = applyToolBrowserAction(state, snapshot(), { type: 'escape' })
    expect(transition.outcome).toEqual({ kind: 'cancelled' })
    expect(transition.state.open).toBe(false)
    expect(selectToolBrowser(transition.state, snapshot())).toBeUndefined()
  })
})
