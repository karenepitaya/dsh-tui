import { describe, expect, it, vi } from 'vitest'
import { activityWorkspaceDetails, connectionWorkspaceDetails, modelWorkspaceDetails, modeWorkspaceDetails, workspaceDirectoryDetailFrame, workspaceDirectoryDetailViewport } from '../src/ui/workspace-directory-details.ts'
import { renderLegacyWorkspaceFrame } from '../src/ui/legacy-workspace.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'
import type { ActivityCenterView } from '../src/activity/center.ts'
import type { ModelPickerView } from '../src/model/picker.ts'
import type { ModePickerView } from '../src/mode/picker.ts'
import type { ProviderConnectView } from '../src/provider/connect-controller.ts'

const long = `${'Full description 界🙂 '.repeat(120)}END_OF_DETAILS`
const mode: ModePickerView = { rows: [{ id: 'default', trust: 'system', name: 'Default', description: long, isCurrent: true, isDefault: true }], selectedIndex: 0, offset: 0, totalCount: 1, available: true, loading: false, selecting: false, locked: false }
const model: ModelPickerView = { stage: 'models', selectedModel: { provider: 'local', model: 'model' }, selectedModelIndex: 0, selectedEffortIndex: 0, groups: [{ id: 'local', name: 'Local', models: [{ provider: 'local', providerName: 'Local', id: 'model', name: 'Model', description: long, efforts: [], isCurrent: true, isDefault: false, catalogued: true, routable: true }] }], efforts: [], routable: true, writable: true, loading: false, selecting: false, failures: [] }
const connection: ProviderConnectView = { stage: 'providers', providers: [{ id: 'local', name: 'Local', active: true, configured: true, connected: true, credential: { kind: 'api-key', configured: true, writable: true, source: long }, methods: [{ id: 'key', label: 'API key' }], canDisconnect: true }], selectedProviderIndex: 0, selectedMethodIndex: -1, editor: createPromptEditorState(), selectedOptionIndex: -1, notices: [], loading: false, busy: false }
const activity: ActivityCenterView = { tab: 'jobs', tabs: [], rows: [{ key: 'job', title: 'Build', meta: 'Build job', status: 'running', statusTone: 'running', depth: 0, selected: true, stoppable: true, detail: [long] }], selectedIndex: 0, confirmStop: false, loading: false, subagentsAvailable: true }

describe('remaining legacy directory details', () => {
  it('reaches complete descriptions across breakpoints while keeping Escape and all terminal cells bounded', () => {
    for (const lines of [modeWorkspaceDetails(mode), modelWorkspaceDetails(model), connectionWorkspaceDetails(connection), activityWorkspaceDetails(activity)]) {
      for (const columns of [80, 99, 100, 139, 140, 180]) {
        const viewport = { columns, rows: 10 }
        const details = workspaceDirectoryDetailViewport(lines, viewport)
        const project = vi.fn(v => ({ title: 'DSH-TUI', viewport: v, lines: ['old list projection'] }))
        const first = renderLegacyWorkspaceFrame(viewport, { title: 'Catalog', focus: 'details', detailLines: lines }, project)
        expect(project).not.toHaveBeenCalled()
        expect(first.lines.join('\n')).not.toContain('END_OF_DETAILS')
        const last = renderLegacyWorkspaceFrame(viewport, { title: 'Catalog', focus: 'details', detailLines: lines, detailOffset: details.maxOffset }, project)
        expect(last.lines.join('\n')).toContain('END_OF_DETAILS')
        expect(last.lines[0]).toContain('Focus: details')
        expect(last.lines.at(-1)).toContain('Esc back')
        expect(last.lines.every(line => visibleWidth(line) === columns)).toBe(true)
        expect(workspaceDirectoryDetailViewport(lines, viewport, 100_000).offset).toBe(details.maxOffset)
      }
    }
  })
  it('keeps actual list projection until details receive focus', () => {
    const viewport = { columns: 120, rows: 10 }
    const project = vi.fn(v => ({ title: 'DSH-TUI', viewport: v, lines: ['List', '› actual selected item'] }))
    const frame = renderLegacyWorkspaceFrame(viewport, { title: 'Modes', focus: 'list', detailLines: modeWorkspaceDetails(mode) }, project)
    expect(project).toHaveBeenCalledExactlyOnceWith(viewport)
    expect(frame.lines[1]).toContain('actual selected item')
  })
  it('shows truthful absent, optional and broken metadata', () => {
    expect(modeWorkspaceDetails({ ...mode, rows: [], error: 'catalog failed', locked: true })).toContain('No Agent mode selected')
    expect(modeWorkspaceDetails({ ...mode, rows: [{ id: 'user-mode', trust: 'system', isCurrent: false, isDefault: false, broken: 'source unavailable' }] })).toContain('Mode  user-mode')
    expect(connectionWorkspaceDetails({ ...connection, providers: [], error: 'failed', notice: 'pending' })).toEqual(['Error: failed', 'Notice: pending', 'No Provider selected'])
    expect(connectionWorkspaceDetails({ ...connection, providers: [{ ...connection.providers[0]!, connected: false, credential: { kind: 'missing', configured: false, writable: false }, methods: [] }] })).toContain('Credential  missing · not configured')
    expect(activityWorkspaceDetails({ ...activity, rows: [], error: 'failed', notice: 'pending' })).toEqual(['Error: failed', 'Notice: pending', 'No activity selected'])
  })
  it('preserves complete reasoning descriptions and distinguishes retained and missing routes', () => {
    const effort = { id: 'high', name: 'High', description: long, isDefault: false }
    const row = model.groups[0]!.models[0]!
    const described = { ...model, stage: 'reasoning' as const, efforts: [{ ...effort, kind: 'effort' as const }], groups: [{ ...model.groups[0]!, models: [{ ...row, catalogued: false, routable: false, efforts: [effort] }] }], error: 'route error', failures: [{ provider: 'remote', message: 'offline' }] }
    expect(modelWorkspaceDetails(described)).toContain('State  unroutable · retained route')
    expect(modelWorkspaceDetails(described).join('\n')).toContain(`Selected effort  High: ${long}`)
    const { selectedModel: _omitted, ...missing } = model
    expect(modelWorkspaceDetails(missing)).toContain('No model selected')
    expect(modelWorkspaceDetails({ ...model, stage: 'reasoning', groups: [] })).toEqual(['No model selected', 'No reasoning option selected'])
    expect(modelWorkspaceDetails({ ...model, stage: 'reasoning', efforts: [{ kind: 'provider-default', name: 'Provider default', isDefault: true }] })).toContain('Provider decides reasoning effort')
    const { description: _description, ...noDescription } = row
    const noDetails = { ...model, stage: 'reasoning' as const, groups: [{ ...model.groups[0]!, models: [{ ...noDescription, efforts: [{ id: 'low', name: 'Low', isDefault: true }] }] }], efforts: [{ kind: 'effort' as const, id: 'low', name: 'Low', isDefault: true }] }
    expect(modelWorkspaceDetails(noDetails)).toContain('Selected effort  Low: low')
    expect(modelWorkspaceDetails(noDetails)).toContain('Reasoning Low  low')
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
