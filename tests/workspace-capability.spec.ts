import { describe, expect, it } from 'vitest'
import { renderCapabilityLensFrame, renderMcpCapabilityFrame, renderSkillPickerFrame, renderToolBrowserFrame } from '../src/ui/workspace-capability.ts'
import { renderLegacyWorkspaceFrame } from '../src/ui/legacy-workspace.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'
import type { SkillPickerView } from '../src/skill/picker.ts'
import type { ToolBrowserView } from '../src/tool/browser.ts'
import type { McpCapabilityBrowserView } from '../src/mcp/capabilities.ts'

const query = createPromptEditorState()
const long = `${'Long description 界🙂 '.repeat(80)}END_OF_DESCRIPTION`
const skill: SkillPickerView = { query, rows: [{ name: 'review', description: long, modelInvocable: true, source: 'project', provider: 'local' }],
  selectedIndex: 0, totalCount: 1, available: true, loading: false, complete: true, stale: false }
const tool = { name: 'read_file', description: long, group: 'core' as const, parameterNames: ['path', 'encoding'], requiredParameterNames: ['path'] }
const tools: ToolBrowserView = { query, rows: [tool], selected: tool, selectedIndex: 0, groups: [], totalCount: 1, available: true, stale: false, generation: 1 }
const mcpTool = { ...tool, name: 'mcp__docs__read', group: 'mcp' as const, serverName: 'docs', toolName: 'read' }
const mcp: McpCapabilityBrowserView = { ...tools, rows: [mcpTool], selected: mcpTool, namespaceCount: 1 }

describe('capability directory layout and reachable details', () => {
  it('shows discovery failure and empty-state explanations immediately on narrow lists', () => {
    const viewport = { columns: 80, rows: 14 }
    const failed = renderSkillPickerFrame({ ...skill, error: 'catalog failed', complete: false, stale: true }, viewport)
    expect(failed.lines.join('\n')).toContain('catalog failed')
    expect(failed.lines.join('\n')).toContain('Catalog changed')
    expect(failed.lines.join('\n')).toContain('› /review')
    const empty = renderToolBrowserFrame({ query, rows: [], selectedIndex: -1, totalCount: 0, groups: [], available: false, stale: false, generation: 0 }, viewport)
    expect(empty.lines.join('\n')).toContain('Capability registry unavailable')
  })
  it('uses one active region below 100 columns and two real regions at both wide breakpoints', () => {
    for (const columns of [78, 99, 100, 139, 140, 180]) {
      const viewport = { columns, rows: 16 }
      const list = renderToolBrowserFrame(tools, viewport)
      const detail = renderToolBrowserFrame({ ...tools, navigation: { focus: 'details', detailOffset: 0 } }, viewport)
      expect(list.cursor).toBeUndefined()
      expect(list.lines.join('\n')).toContain('read_file')
      expect(detail.lines.join('\n')).toContain('About')
      if (columns < 100) {
        expect(list.lines.join('\n')).not.toContain('About')
        expect(detail.styleSpans).toBeUndefined()
      } else {
        expect(list.lines.join('\n')).toContain('About')
        expect(list.styleSpans?.filter(spans => spans.length > 0).every(spans => spans.length === 2)).toBe(true)
      }
      expect(list.lines.every(line => visibleWidth(line) <= columns)).toBe(true)
    }
  })

  it('reaches complete long skill, tool and MCP descriptions and metadata by scrolling', () => {
    const viewport = { columns: 80, rows: 10 }
    const projects = [
      (detailOffset: number) => renderSkillPickerFrame({ ...skill, navigation: { focus: 'details', detailOffset } }, viewport),
      (detailOffset: number) => renderToolBrowserFrame({ ...tools, navigation: { focus: 'details', detailOffset } }, viewport),
      (detailOffset: number) => renderMcpCapabilityFrame({ ...mcp, navigation: { focus: 'details', detailOffset } }, viewport),
    ]
    for (const project of projects) {
      const start = project(0)
      expect(start.lines.join('\n')).not.toContain('END_OF_DESCRIPTION')
      expect(start.detailMaxOffset).toBeGreaterThan(0)
      const seen = Array.from({ length: start.detailMaxOffset! + 1 }, (_, offset) => project(offset).lines.join('\n')).join('\n')
      expect(seen).toContain('END_OF_DESCRIPTION')
      expect(project(100_000).lines).toEqual(project(start.detailMaxOffset!).lines)
    }
    expect(projects[1]!(100_000).lines.join('\n')).toContain('path*, encoding')
    expect(projects[2]!(100_000).lines.join('\n')).toContain('Health  Cordis-owned')
  })

  it('shows an input cursor only in search and keeps selection visible after resize', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ ...tool, name: `tool-${index}` }))
    for (const columns of [1, 2, 80, 120]) {
      for (const rows of [1, 2, 3, 4, 5, 12]) {
        const viewport = { columns, rows }
        for (const focus of ['list', 'search', 'details'] as const) {
          const view = { ...tools, query: createPromptEditorState('界🙂'.repeat(40)), rows: many, selected: many[29]!, selectedIndex: 29, navigation: { focus, detailOffset: 0 } }
          const frame = renderLegacyWorkspaceFrame(viewport, { title: 'Tools', focus: focus === 'details' ? 'details' : 'list' }, v => renderToolBrowserFrame(view, v))
          expect(frame.lines).toHaveLength(rows)
          expect(frame.lines.every(line => visibleWidth(line) === columns)).toBe(true)
          if (focus !== 'search' || rows < 3) expect(frame.cursor).toBeUndefined()
          if (columns >= 80 && rows >= 5 && focus !== 'details') expect(frame.lines.join('\n')).toContain('tool-29')
        }
      }
    }
  })

  it('keeps empty, unavailable and stale discovery explanations reachable in detail focus', () => {
    const viewport = { columns: 120, rows: 22 }
    for (const available of [true, false]) {
      for (const stale of [true, false]) {
        const navigation = { focus: 'details' as const, detailOffset: 0 }
        const skills = renderSkillPickerFrame({ ...skill, rows: [], selectedIndex: -1, available, stale, complete: false, loading: true, error: 'discovery failed', navigation }, viewport)
        expect(skills.lines.join('\n')).toContain('discovery failed')
        expect(skills.lines.join('\n')).toContain(available ? 'No user-invocable skills' : 'Skills are unavailable')
        const toolFrame = renderToolBrowserFrame({ query, rows: [], selectedIndex: -1, groups: [], totalCount: 0, available, stale, generation: 0, error: 'tool failed', navigation }, viewport)
        expect(toolFrame.lines.join('\n')).toContain(available ? 'No matching capabilities' : 'Capability registry unavailable')
        const mcpFrame = renderMcpCapabilityFrame({ query, rows: [], selectedIndex: -1, totalCount: 0, namespaceCount: 0, available, stale, generation: 0, error: 'mcp failed', navigation }, viewport)
        expect(mcpFrame.lines.join('\n')).toContain(available ? 'No MCP capabilities mounted' : 'ToolRuntime capabilities are unavailable')
      }
    }
    const searched = createPromptEditorState('absent')
    expect(renderSkillPickerFrame({ ...skill, rows: [], query: searched }, viewport).lines.join('\n')).toContain('No matching skills')
    expect(renderMcpCapabilityFrame({ query: searched, rows: [], selectedIndex: -1, totalCount: 0, namespaceCount: 0, available: true, stale: false, generation: 0 }, viewport).lines.join('\n')).toContain('No matching MCP capabilities')
  })

  it('preserves all skill resource kinds, optional invocation guidance and tool group metadata', () => {
    const viewport = { columns: 120, rows: 24 }
    for (const resourceBase of [{ kind: 'directory' as const, path: 'D:\\skills' }, { kind: 'url' as const, url: 'https://example.test/skill' }, { kind: 'opaque' as const, description: 'virtual resource' }]) {
      const frame = renderSkillPickerFrame({ ...skill, rows: [{ ...skill.rows[0]!, description: 'short', whenToUse: 'review diffs', modelInvocable: false, resourceBase }] }, viewport)
      expect(frame.lines.join('\n')).toContain('Base')
      expect(frame.lines.join('\n')).toContain('When  review diffs')
      expect(frame.lines.join('\n')).toContain('model —')
    }
    for (const group of ['core', 'mcp', 'transport'] as const) {
      const selected = { ...tool, description: 'short', group, parameterNames: [], requiredParameterNames: [] }
      expect(renderToolBrowserFrame({ ...tools, rows: [selected], selected }, viewport).lines.join('\n')).toContain('Params  none')
    }
    expect(renderMcpCapabilityFrame({ ...mcp, selected: { ...mcpTool, description: 'short', parameterNames: [], requiredParameterNames: [] } }, viewport).lines.join('\n')).toContain('Params  none')
  })

  it('renders empty generic detail slots without fabricating content or selections', () => {
    const options = { title: 'Tools', sectionLabel: 'Capabilities', query, rows: [], selectedIndex: -1, summary: 'empty', detail: [], footerLeft: 'read only' }
    for (const columns of [80, 120]) {
      const frame = renderCapabilityLensFrame({ ...options, navigation: { focus: 'details', detailOffset: 99 } }, { columns, rows: 12 })
      expect(frame.detailMaxOffset).toBe(0)
      expect(frame.lineStyles?.every(style => style?.inverse !== true)).toBe(true)
    }
  })
})
