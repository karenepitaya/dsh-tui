import { describe, expect, it } from 'vitest'
import {
  applyMcpCapabilityBrowserAction,
  createMcpCapabilityBrowserState,
  openMcpCapabilityBrowser,
  selectMcpCapabilityBrowser,
} from '../src/mcp/capabilities.ts'
import type { SessionToolsSnapshot } from '../src/tool/port.ts'
import { createUiState } from '../src/transcript/state.ts'
import { renderDshFrame } from '../src/ui/frame.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'

const TOOLS: SessionToolsSnapshot = {
  available: true,
  stale: false,
  generation: 12,
  tools: [
    {
      name: 'mcp__github__create_issue',
      description: 'Create an issue in a GitHub repository',
      group: 'mcp',
      parameterNames: ['owner', 'repo', 'title'],
      requiredParameterNames: ['owner', 'repo'],
    },
    {
      name: 'mcp__filesystem__read_text',
      description: 'Read text from an exposed filesystem root',
      group: 'mcp',
      parameterNames: ['path'],
      requiredParameterNames: ['path'],
    },
  ],
}

function browser(snapshot: SessionToolsSnapshot = TOOLS) {
  return selectMcpCapabilityBrowser(
    openMcpCapabilityBrowser(createMcpCapabilityBrowserState(), snapshot),
    snapshot,
  )!
}

describe('MCP capability secondary surface', () => {
  it('renders a fixed solid exact-Agent browser without inventing connection health', () => {
    const frame = renderDshFrame({
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState('retained draft'),
      mcpBrowser: browser(),
    }, { columns: 160, rows: 40 })
    const output = frame.lines.join('\n')

    expect(frame.overlay).toBeUndefined()
    expect(frame.lines).toHaveLength(40)
    expect(output).toContain('MCP')
    expect(output).toContain('Mounted tools')
    expect(output).toContain('2/2 tools')
    expect(output).not.toContain('servers')
    expect(output).toContain('filesystem')
    expect(output).toContain('read_text')
    expect(output).toContain('Ask in Chat')
    expect(output).not.toContain('generation')
    expect(output).not.toContain('Health')
    expect(output).not.toContain('connected')
    expect(output).not.toContain('reconnecting')
    expect(output).not.toContain('retained draft')
    expect(frame.styleSpans?.every(spans => spans[0]?.style.backgroundRole === 'panelBackground')).toBe(true)
    expect(frame.styleSpans?.flat().some(span => span.style.backgroundRole === 'selectionBackground')).toBe(true)
    expect(frame.cursor).toBeUndefined()
    expect(frame.lines.at(-1)).toContain('Esc back')
  })

  it('keeps error, empty, and tiny terminal states bounded', () => {
    const empty = browser({ ...TOOLS, tools: [], stale: true, error: 'registry failed' })
    const view = (rows: number, columns = 100) => renderDshFrame({
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      mcpBrowser: empty,
    }, { columns, rows })

    const full = view(12)
    expect(full.lines.join('\n')).toContain('registry failed')
    expect(full.lines.join('\n')).toContain('Could not load MCP tools · Reopen /mcp to retry')
    expect(full.lines.join('\n')).toContain('Showing last good ToolRuntime view')

    const unavailableSnapshot: SessionToolsSnapshot = {
      ...TOOLS,
      available: false,
      tools: [],
    }
    const unavailable = renderDshFrame({
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      mcpBrowser: browser(unavailableSnapshot),
    }, { columns: 100, rows: 12 })
    expect(unavailable.lines.join('\n')).toContain('MCP tools are unavailable in this session')

    const baseState = openMcpCapabilityBrowser(createMcpCapabilityBrowserState(), TOOLS)
    const filteredState = applyMcpCapabilityBrowserAction(baseState, TOOLS, {
      type: 'edit',
      action: { type: 'insert', text: 'missing' },
    }).state
    const noMatch = renderDshFrame({
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      mcpBrowser: selectMcpCapabilityBrowser(filteredState, TOOLS)!,
    }, { columns: 100, rows: 12 })
    expect(noMatch.lines.join('\n')).toContain('No matching MCP tools')

    const noInputSnapshot: SessionToolsSnapshot = {
      ...TOOLS,
      tools: [{
        name: 'mcp__health__ping',
        description: 'Ping the server namespace',
        group: 'mcp',
        parameterNames: [],
        requiredParameterNames: [],
      }],
    }
    const noInput = renderDshFrame({
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      mcpBrowser: { ...browser(noInputSnapshot), navigation: { focus: 'details', detailOffset: 0 } },
    }, { columns: 100, rows: 12 })
    expect(noInput.lines.join('\n')).toContain('Params  none')

    for (const rows of [1, 2, 3, 4]) {
      const tiny = view(rows, 44)
      expect(tiny.lines).toHaveLength(rows)
      expect(tiny.overlay).toBeUndefined()
      for (const line of tiny.lines) expect(line.length).toBeGreaterThan(0)
    }
  })
})
