import { describe, expect, it, vi } from 'vitest'
import { workspaceDirectoryDetailFrame, workspaceDirectoryDetailViewport } from '../src/ui/workspace-directory-details.ts'
import { renderLegacyWorkspaceFrame } from '../src/ui/legacy-workspace.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'

const long = `${'Full description 界🙂 '.repeat(120)}END_OF_DETAILS`
const details: readonly string[] = ['Error: catalog failed', 'Notice: refresh pending', `Detail  ${long}`]

describe('remaining legacy directory details', () => {
  it('reaches complete descriptions across breakpoints while keeping Escape and all terminal cells bounded', () => {
    for (const columns of [80, 99, 100, 139, 140, 180]) {
      const viewport = { columns, rows: 10 }
      const viewportInfo = workspaceDirectoryDetailViewport(details, viewport)
      const project = vi.fn(v => ({ title: 'DSH-TUI', viewport: v, lines: ['old list projection'] }))
      const first = renderLegacyWorkspaceFrame(viewport, { title: 'Catalog', focus: 'details', detailLines: details }, project)
      expect(project).not.toHaveBeenCalled()
      expect(first.lines.join('\n')).not.toContain('END_OF_DETAILS')
      const last = renderLegacyWorkspaceFrame(viewport, { title: 'Catalog', focus: 'details', detailLines: details, detailOffset: viewportInfo.maxOffset }, project)
      expect(last.lines.join('\n')).toContain('END_OF_DETAILS')
      expect(last.lines[0]).toContain('Catalog · Details')
      expect(last.lines.at(-1)).toContain('Esc back')
      expect(last.lines.every(line => visibleWidth(line) === columns)).toBe(true)
      expect(workspaceDirectoryDetailViewport(details, viewport, 100_000).offset).toBe(viewportInfo.maxOffset)
    }
  })
  it('keeps actual list projection until details receive focus', () => {
    const viewport = { columns: 120, rows: 10 }
    const project = vi.fn(v => ({ title: 'DSH-TUI', viewport: v, lines: ['List', '› actual selected item'] }))
    const frame = renderLegacyWorkspaceFrame(viewport, { title: 'Modes', focus: 'list', detailLines: details }, project)
    expect(project).toHaveBeenCalledExactlyOnceWith(viewport)
    expect(frame.lines[1]).toContain('actual selected item')
  })
  it('bounds hostile and empty detail pages at tiny sizes and retains errors', () => {
    for (const rows of [1, 2, 3, 8]) for (const columns of [1, 2, 40, 120]) {
      const frame = workspaceDirectoryDetailFrame({ columns, rows }, ['Error: source\u001b[2J unavailable', 'Broken: detail\u0007', 'plain'], 0)
      expect(frame.lines).toHaveLength(rows)
      expect(frame.lines.join('\n')).not.toContain('\u001b')
      expect(frame.lines.every(line => visibleWidth(line) <= columns)).toBe(true)
    }
    const frame = workspaceDirectoryDetailFrame({ columns: 80, rows: 8 }, ['Error: unavailable', 'Broken: failed', 'plain'], 0)
    expect(frame.lineStyles?.[1]?.tone).toBe('error')
    expect(frame.lineStyles?.[2]?.tone).toBe('error')
    expect(frame.lineStyles?.[3]?.tone).toBe('primary')
  })
})
