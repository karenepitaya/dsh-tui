import { describe, expect, it } from 'vitest'
import { applySessionPickerAction, createSessionPickerState, openSessionPicker, reconcileSessionPicker, selectSessionPicker } from '../src/session/picker.ts'
import type { SessionCatalogSnapshot } from '../src/session/catalog-port.ts'
import { renderSessionDirectoryFrame } from '../src/ui/workspace-sessions.ts'
import { renderLegacyWorkspaceFrame } from '../src/ui/legacy-workspace.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'

const catalog: SessionCatalogSnapshot = { durability: 'available', sessions: Array.from({ length: 12 }, (_, index) => ({
  sessionId: `session-${index}`, createdAt: index, cwd: index === 11 ? `D:\\项目\\${'很长的路径 '.repeat(160)}PATH_END` : 'D:\\work',
  isSubagent: index === 10, attached: index < 10, durablePresence: 'observed' as const,
  ...(index === 10 ? { parentSessionId: 'ROOT', creationAgentPreset: 'ＣＯＤＥ', liveStatus: 'running' as const } : {}),
})) }

describe('legacy Sessions search and complete detail contract', () => {
  it('filters exact catalog fields with Unicode normalization and keeps the selected identity through refresh', () => {
    let state = openSessionPicker(createSessionPickerState(), catalog, 'session-0')
    state = { ...state, navigation: { focus: 'search', detailOffset: 0 } }
    expect(applySessionPickerAction(state, catalog, 'session-0', { type: 'edit', action: { type: 'insert', text: '' } }).state).toBe(state)
    for (const query of [' root ', 'code', 'RUNNING', '项目', 'session-11']) {
      state = applySessionPickerAction(state, catalog, 'session-0', { type: 'edit', action: { type: 'clear' } }).state
      state = applySessionPickerAction(state, catalog, 'session-0', { type: 'edit', action: { type: 'insert', text: query } }).state
      const selected = selectSessionPicker(state, catalog, 'session-0')!
      expect(selected.filteredCount).toBe(1)
      expect(selected.totalCount).toBe(12)
      expect(selected.navigation?.focus).toBe('search')
      expect(applySessionPickerAction(state, catalog, 'session-0', { type: 'enter' }).outcome).toMatchObject({ sessionId: selected.selectedSessionId })
    }
    state = applySessionPickerAction(state, catalog, 'session-0', { type: 'edit', action: { type: 'clear' } }).state
    const reordered = { ...catalog, sessions: [...catalog.sessions].reverse() }
    state = reconcileSessionPicker(state, reordered, 'session-0')
    expect(state.selectedSessionId).toBe('session-11')
    expect(state.selectedIndex).toBe(0)
    state = applySessionPickerAction(state, reordered, 'session-0', { type: 'move-down' }).state
    expect(state.selectedSessionId).toBe('session-10')
    expect(state.query?.text).toBe('')
    const removed = { ...catalog, sessions: catalog.sessions.slice(0, 10) }
    state = reconcileSessionPicker(state, removed, 'session-0')
    expect(state.selectedSessionId).toBe('session-1')
    state = applySessionPickerAction(state, removed, 'session-0', { type: 'edit', action: { type: 'insert', text: 'absent' } }).state
    expect(selectSessionPicker(state, removed)?.rows).toEqual([])
    const closed = applySessionPickerAction(state, removed, undefined, { type: 'escape' }).state
    expect(openSessionPicker(closed, catalog, 'session-0')).toMatchObject({ selectedSessionId: 'session-0' })
    expect(openSessionPicker(closed, catalog).query).toBeUndefined()
  })

  it('keeps long paths reachable, searches focused, and real actions visible through the Workspace shell', () => {
    const state = openSessionPicker(createSessionPickerState(), catalog, 'session-11')
    const view = selectSessionPicker(state, catalog, 'session-11')!
    for (const columns of [80, 99, 100, 139, 140, 200]) {
      const viewport = { columns, rows: 12 }
      const panel = { view: { ...view, navigation: { focus: 'details' as const, detailOffset: 100_000 } }, loaded: true, loading: false, inspection: true, liveActivation: true, forkAvailable: true }
      const detail = renderSessionDirectoryFrame(panel, viewport)
      expect(detail.lines.join('\n')).toContain('PATH_END')
      expect(detail.detailMaxOffset).toBeGreaterThan(0)
      const frame = renderLegacyWorkspaceFrame(viewport, { title: 'Sessions', focus: 'details' }, v => renderSessionDirectoryFrame(panel, v))
      expect(frame.lines.at(-1)).toContain('Esc back')
      expect(frame.lines.every(line => visibleWidth(line) === columns)).toBe(true)
    }
    const panel = { view, loaded: true, loading: false, inspection: true, liveActivation: true, forkAvailable: true }
    const list = renderSessionDirectoryFrame(panel, { columns: 160, rows: 20 })
    expect(list.cursor).toBeUndefined()
    expect(list.lines.at(-1)).toContain('Enter switch/inspect')
    expect(list.lines.at(-1)).toContain('F fork')
    expect(list.lines.at(-1)).toContain('R refresh')
    const search = renderSessionDirectoryFrame({ ...panel, view: { ...view, navigation: { focus: 'search', detailOffset: 0 } } }, { columns: 80, rows: 12 })
    expect(search.cursor?.row).toBe(1)
    const tiny = renderSessionDirectoryFrame(panel, { columns: 80, rows: 3 })
    expect(tiny.lines[1]).toContain('session-11')
    expect(tiny.lines.at(-1)).toContain('Esc back')
    expect(tiny.cursor).toBeUndefined()
    const tinyNotice = renderSessionDirectoryFrame({ ...panel, notice: 'still selected' }, { columns: 80, rows: 3 })
    expect(tinyNotice.lines[1]).toContain('session-11')
    expect(tinyNotice.lines[1]).toContain('Notice: still selected')
    const tinyError = renderSessionDirectoryFrame({ ...panel, error: 'refresh failed', loading: true }, { columns: 80, rows: 4 })
    expect(tinyError.lines[1]).toContain('Error: refresh failed')
    expect(tinyError.lineStyles?.[1]?.tone).toBe('error')
    const tinySearch = renderSessionDirectoryFrame({ ...panel, view: { ...view, navigation: { focus: 'search', detailOffset: 0 } } }, { columns: 80, rows: 3 })
    expect(tinySearch.lines[1]).toContain('Search')
    expect(tinySearch.cursor?.row).toBe(1)
  })

  it('shows empty, failed, loading and optional Session facts without hiding their meanings', () => {
    const viewport = { columns: 180, rows: 25 }
    const empty = selectSessionPicker(openSessionPicker(createSessionPickerState(), { ...catalog, sessions: [] }), { ...catalog, sessions: [] })!
    const base = { view: empty, loaded: false, loading: false }
    expect(renderSessionDirectoryFrame(base, viewport).lines.join('\n')).toContain('Session catalog not loaded')
    for (const rows of [3, 4]) {
      expect(renderSessionDirectoryFrame({ ...base, loaded: true }, { columns: 80, rows }).lines.join('\n')).toContain('No sessions found')
      const error = renderSessionDirectoryFrame({ ...base, error: 'offline' }, { columns: 80, rows })
      expect(error.lines[1]).toContain('Error: offline')
      expect(error.lineStyles?.[1]?.tone).toBe('error')
      expect(renderSessionDirectoryFrame({ ...base, loading: true }, { columns: 80, rows }).lines[1]).toContain('Loading sessions')
    }
    expect(renderSessionDirectoryFrame({ ...base, loaded: true, loading: true, error: 'offline', notice: 'last good', view: { ...empty, durability: 'unavailable', query: { text: 'none', cursor: 4 } } }, viewport).lines.join('\n'))
      .toContain('No matching sessions')
    for (const index of [0, 10, 11]) for (const liveActivation of [false, true]) for (const inspection of [false, true]) {
      const view = selectSessionPicker(openSessionPicker(createSessionPickerState(), catalog, `session-${index}`), catalog, 'other')!
      const frame = renderSessionDirectoryFrame({ view, loaded: true, loading: false, liveActivation, inspection }, viewport)
      expect(frame.lines.join('\n')).toContain('Selected session')
    }
    const { parentSessionId: _parent, liveStatus: _status, cwd: _cwd, ...missing } = catalog.sessions[10]!
    const unknown = { ...catalog, sessions: [missing] }
    const view = selectSessionPicker(openSessionPicker(createSessionPickerState(), unknown), unknown)!
    expect(renderSessionDirectoryFrame({ ...base, view }, viewport).lines.join('\n')).toContain('Child of unknown')
  })
})
