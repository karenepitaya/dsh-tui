import { describe, expect, it, vi } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { renderDshFrame, renderContextFrame, type DshTuiView } from '../src/ui/frame.ts'
import { createUiState } from '../src/transcript/state.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import { secondaryModalRow, secondaryModalSplit } from '../src/ui/modal.ts'
import { renderLegacyWorkspaceFrame } from '../src/ui/legacy-workspace.ts'
import { legacyWorkspaceDescriptor } from '../src/ui/legacy-workspace-routing.ts'
import { secondaryModalFrame } from '../src/ui/workspace-rows.ts'
import type { LlmAttemptChain } from '../src/llm/attempts.ts'
import type { RequestRouteEpoch } from '../src/llm/routes.ts'

const query = createPromptEditorState()
const base: DshTuiView = { ui: createUiState(), prompt: query, interaction: undefined }
const tool = { name: 'read_file', description: '读取文件的完整说明', group: 'core' as const, parameterNames: ['path'], requiredParameterNames: ['path'] }
const mcp = { ...tool, name: 'mcp__docs__read', group: 'mcp' as const, serverName: 'docs', toolName: 'read' }
const directoryCases: readonly [string, Partial<DshTuiView>][] = [
  ['Context', { contextPanel: true, context: { available: false } }],
  ['Request recovery', { attemptPanel: { rows: [], selectedIndex: -1, selectedAttemptIndex: -1, omittedChainCount: 0 } }],
  ['Model route', { routePanel: { rows: [], selectedIndex: -1, omittedEpochCount: 0 } }],
  ['Sessions', { sessionPicker: { view: { rows: [], selectedIndex: -1, offset: 0, totalCount: 0, durability: 'available' }, loaded: true, loading: false } }],
  ['Session inspection', { sessionInspection: { kind: 'loading', sessionId: 'session-a' } }],
  ['Models', { modelPicker: { stage: 'models', groups: [], selectedModelIndex: -1, efforts: [], selectedEffortIndex: -1, routable: false, writable: true, loading: false, selecting: false, failures: [] } }],
  ['Mode', { modePicker: { rows: [{ id: 'default', name: 'Default', trust: 'system', isCurrent: true, isDefault: true }], selectedIndex: 0, offset: 0, totalCount: 1, available: true, loading: false, selecting: false, locked: false } }],
  ['Skills', { skillPicker: { query, rows: [], selectedIndex: -1, totalCount: 0, available: true, loading: false, complete: true, stale: false } }],
  ['Tools', { toolBrowser: { query, rows: [tool], selected: tool, selectedIndex: 0, groups: [{ id: 'core', label: 'Core', count: 1 }], totalCount: 1, available: true, stale: false, generation: 1 } }],
  ['MCP', { mcpBrowser: { query, rows: [mcp], selected: mcp, selectedIndex: 0, totalCount: 1, namespaceCount: 1, available: true, stale: false, generation: 1 } }],
  ['Runtime library', { runtimeLibrary: { tab: 'settings', focus: 'catalog', query, searchFocused: false, detailScrollOffset: 0, pending: false,
    settings: { available: true, writable: true, documentBacked: true, generation: 1, stale: false, rows: [], totalCount: 0 },
    plugins: { available: true, rows: [], totalCount: 0, activeCount: 0, failedCount: 0 },
  } }],
  ['Activity', { activityCenter: { tab: 'jobs', tabs: [{ id: 'jobs', label: 'Jobs', count: 0, live: 0, selected: true }], rows: [], selectedIndex: -1, confirmStop: false, loading: false, subagentsAvailable: true } }],
  ['Jobs', { jobsActivity: { rows: [], selectedIndex: -1, confirmKill: false } }],
  ['Connections', { providerConnect: { stage: 'providers', providers: [], selectedProviderIndex: -1, selectedMethodIndex: -1, editor: query, selectedOptionIndex: -1, notices: [], loading: false, busy: false } }],
  ['Permission Presets', { permissionPicker: { rows: [], selectedIndex: -1, offset: 0, totalCount: 0, available: true, writable: true, stale: false, generation: 1, selecting: false } }],
]

describe('Legacy directory Workspace boundary', () => {
  it('keeps directory actions and detail navigation visible at 80 columns', () => {
    const navigation = { focus: 'details' as const, detailOffset: 0 }
    const cases: readonly [Partial<DshTuiView>, string][] = [
      [{ ...directoryCases[6]![1], modeNavigation: navigation }, 'Enter apply'],
      [{ modePicker: { ...directoryCases[6]![1].modePicker!, locked: true }, modeNavigation: navigation }, 'Mode locked'],
      [{ ...directoryCases[5]![1], modelNavigation: navigation }, 'Enter reasoning/select'],
      [{ modelPicker: { ...directoryCases[5]![1].modelPicker!, stage: 'reasoning' }, modelNavigation: navigation }, 'Enter switch'],
      [{ modelPicker: { ...directoryCases[5]![1].modelPicker!, writable: false }, modelNavigation: navigation }, 'Read-only'],
      [{ ...directoryCases[11]![1], activityNavigation: navigation }, 'K/Delete stop'],
      [{ providerConnect: { ...directoryCases[13]![1].providerConnect!, navigation } }, 'Enter connect'],
    ]
    for (const [view, action] of cases) {
      const footer = renderDshFrame({ ...base, ...view }, { columns: 80, rows: 20 }).lines.at(-1)!
      expect(footer).toContain('Esc back')
      expect(footer).toContain(action)
      expect(footer).toContain('Tab h/l focus')
      expect(footer).toContain('j/k PgUp/Down scroll')
    }
  })
  it('retains real detail focus and reasoning stage titles through the outer directory shell', () => {
    const navigation = { focus: 'details' as const, detailOffset: 0 }
    const views: DshTuiView[] = [
      { ...base, skillPicker: { ...directoryCases[7]![1].skillPicker!, navigation } },
      { ...base, toolBrowser: { ...directoryCases[8]![1].toolBrowser!, navigation } },
      { ...base, mcpBrowser: { ...directoryCases[9]![1].mcpBrowser!, navigation } },
      { ...base, permissionPicker: { ...directoryCases.at(-1)![1].permissionPicker!, navigation } },
      { ...base, ...directoryCases[1]![1], attemptNavigation: navigation },
      { ...base, ...directoryCases[2]![1], routeNavigation: navigation },
      { ...base, ...directoryCases[6]![1], modeNavigation: navigation },
      { ...base, ...directoryCases[5]![1], modelNavigation: navigation },
      { ...base, ...directoryCases[11]![1], activityNavigation: navigation },
      { ...base, providerConnect: { ...directoryCases.find(([title]) => title === 'Connections')![1].providerConnect!, navigation } },
    ]
    for (const view of views) {
      const frame = renderDshFrame(view, { columns: 120, rows: 20 })
      expect(frame.lines[0]).toContain('Focus: details')
      expect(frame.cursor).toBeUndefined()
      expect(frame.overlay).toBeUndefined()
    }
    const model = renderDshFrame({ ...base, modelPicker: { ...directoryCases[5]![1].modelPicker!, stage: 'reasoning' } }, { columns: 120, rows: 20 })
    expect(model.lines[0]).toContain('Models · Reasoning effort')
  })
  it.each(directoryCases)('renders real %s directory at the full terminal size with pinned Escape', (title, properties) => {
    for (const viewport of [{ columns: 80, rows: 20 }, { columns: 120, rows: 30 }, { columns: 160, rows: 45 }]) {
      const frame = renderDshFrame({ ...base, ...properties }, viewport)
      expect(frame.overlay).toBeUndefined()
      expect(frame.viewport).toEqual(viewport)
      expect(frame.lines).toHaveLength(viewport.rows)
      expect(frame.lines[0]).toContain(title)
      expect(frame.lines.at(-1)).toContain('Esc back')
      expect(frame.lines.every(line => visibleWidth(line) === viewport.columns)).toBe(true)
      expect(frame.styleSpans?.every(spans => spans[0]?.style.backgroundRole === 'panelBackground')).toBe(true)
    }
  })

  it('keeps every real directory bounded during tiny-terminal resize', () => {
    for (const [, properties] of directoryCases) {
      for (const viewport of [{ columns: 80, rows: 1 }, { columns: 80, rows: 2 }, { columns: 1, rows: 4 }, { columns: 2, rows: 4 }]) {
        const frame = renderDshFrame({ ...base, ...properties }, viewport)
        expect(frame.lines).toHaveLength(viewport.rows)
        expect(frame.lines.every(line => visibleWidth(line) === viewport.columns)).toBe(true)
        expect(frame.lines.join('')).not.toContain('\u001b')
        if (viewport.rows === 2) expect(frame.lines[1]).toContain('Esc back')
        if (viewport.rows <= 2) expect(frame.cursor).toBeUndefined()
        else if (frame.cursor !== undefined) {
          expect(frame.cursor.row).toBeGreaterThan(0)
          expect(frame.cursor.row).toBeLessThan(viewport.rows - 1)
          expect(frame.cursor.column).toBeLessThan(viewport.columns)
        }
      }
    }
  })

  it('keeps authentication challenges and confirmations outside the directory contract', () => {
    const providers = directoryCases.find(([title]) => title === 'Connections')![1].providerConnect!
    for (const stage of ['methods', 'working', 'prompt', 'confirm-disconnect'] as const) {
      expect(legacyWorkspaceDescriptor({ ...base, providerConnect: { ...providers, stage } })).toBeUndefined()
    }
    expect(legacyWorkspaceDescriptor({ ...base, sessionInspection: { kind: 'confirm-resume', sessionId: 's', header: { sessionId: 's', createdAt: 0, isSubagent: false }, observation: { kind: 'missing' } } })).toBeUndefined()
    expect(legacyWorkspaceDescriptor({ ...base, sessionFork: { kind: 'confirm', source: { sessionId: 's', createdAt: 0, isSubagent: false, attached: false, durablePresence: 'observed', relation: 'cold' } } })).toBeUndefined()
    expect(legacyWorkspaceDescriptor({ ...base, permissionPicker: { rows: [], selectedIndex: -1, offset: 0, totalCount: 0, available: true, writable: true, stale: false, generation: 1, selecting: false,
      confirmation: { fromValue: 'read', toValue: 'work', generation: 1, selectedIndex: 0,
        currentPermission: { sandboxMode: 'read-only', approvalPolicy: 'ask' }, targetPermission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' } } } })).toBeUndefined()
    expect(legacyWorkspaceDescriptor({ ...base, activityCenter: { ...directoryCases[11]![1].activityCenter!, confirmStop: true } })).toBeUndefined()
    expect(legacyWorkspaceDescriptor({ ...base, jobsActivity: { rows: [], selectedIndex: -1, confirmKill: true } })).toBeUndefined()
    expect(legacyWorkspaceDescriptor(base)).toBeUndefined()
  })

  it('uses actual Mode and Tools rows to distinguish active selection from search focus', () => {
    const mode = renderDshFrame({ ...base, ...directoryCases[6]![1] }, { columns: 120, rows: 30 })
    const tools = renderDshFrame({ ...base, toolBrowser: { ...directoryCases[8]![1].toolBrowser!, navigation: { focus: 'search', detailOffset: 0 } } }, { columns: 120, rows: 30 })
    expect(mode.lines[0]).toContain('Focus: list')
    expect(mode.styleSpans?.flat().some(span => span.style.backgroundRole === 'selectionBackground')).toBe(true)
    expect(tools.lines[0]).toContain('Focus: search')
    expect(tools.styleSpans?.flat().some(span => span.style.backgroundRole === 'inactiveSelectionBackground')).toBe(true)
    expect(tools.styleSpans?.flat().filter(span => span.style.backgroundRole === 'inactiveSelectionBackground').every(span => span.width < 120)).toBe(true)
    expect(tools.styleSpans?.flat().some(span => span.style.backgroundRole === 'selectionBackground')).toBe(false)
    expect(tools.styleSpans?.flat().some(span => span.style.backgroundRole === 'inputBackground')).toBe(true)
    expect(tools.styleSpans?.flat().every(span => span.style.dim !== true)).toBe(true)
  })

  it('keeps the real Runtime namespace selected but inactive while editing its detail', () => {
    const runtime = directoryCases[10]![1].runtimeLibrary!
    const namespace = { namespace: 'agent', applies: 'live' as const, revision: 1, overrideCount: 1, secretCount: 0, selected: true }
    for (const focus of ['detail', 'editor'] as const) {
      const view = { ...runtime, focus,
        settings: { ...runtime.settings, rows: [namespace], totalCount: 1, selected: { ...namespace, selectedFieldIndex: 0, fields: [{ path: ['enabled'], pathLabel: 'enabled', source: 'user' as const, value: true, selected: true }] } },
        ...(focus === 'editor' ? { editor: { namespace: 'agent', path: ['enabled'], secret: false, input: createPromptEditorState('true') } } : {}),
      }
      const frame = renderDshFrame({ ...base, runtimeLibrary: view }, { columns: 120, rows: 30 })
      expect(frame.lines[0]).toContain(`Focus: ${focus === 'detail' ? 'details' : 'editor'}`)
      const namespaceRow = frame.lines.findIndex(line => line.includes('▰ agent'))
      expect(namespaceRow).toBeGreaterThan(0)
      expect(frame.styleSpans?.[namespaceRow]?.some(span => span.style.backgroundRole === 'inactiveSelectionBackground')).toBe(true)
      expect(frame.styleSpans?.[namespaceRow]?.filter(span => span.style.backgroundRole === 'inactiveSelectionBackground').every(span => span.width < 120)).toBe(true)
      expect(frame.styleSpans?.[namespaceRow]?.some(span => span.style.backgroundRole === 'selectionBackground')).toBe(false)
    }
  })

  it('reuses the actual Context renderer without an overlay-sized intermediate viewport', () => {
    const viewport = { columns: 160, rows: 45 }
    const project = vi.fn(value => renderContextFrame({ available: false }, 'session-a', value))
    const frame = renderLegacyWorkspaceFrame(viewport, { title: 'Context', focus: 'details' }, project)
    expect(project).toHaveBeenCalledExactlyOnceWith(viewport)
    expect(frame.lines.join('\n')).toContain('Token meter offline')
    expect(frame.lines.at(-1)).toContain('Esc back')
  })

  it.each([[99_000, 'CRITICAL', 'error'], [90_000, 'PRESSURE', 'warning'], [10_000, 'HEALTHY', 'success']] as const)('keeps real Context pressure %s semantic instead of treating inverse emphasis as selection', (tokens, health, tone) => {
    const viewport = { columns: 120, rows: 20 }
    const frame = renderLegacyWorkspaceFrame(viewport, { title: 'Context', focus: 'details' }, value => renderContextFrame({
      available: true, pressure: { projectedTokens: tokens, contextWindow: 100_000 },
    }, 'session-a', value))
    const status = frame.lines.findIndex(line => line.includes(health))
    expect(frame.lineStyles?.[status]).toMatchObject({ tone, backgroundRole: 'panelBackground' })
    expect(frame.styleSpans?.flat().some(span => span.style.backgroundRole === 'selectionBackground')).toBe(false)
  })

  it.each(['›', '▰'])('limits %s list selection to its region and keeps non-focused detail text neutral', marker => {
    const viewport = { columns: 100, rows: 5 }
    const selected = secondaryModalRow(secondaryModalSplit(`${marker} 选择🙂`, '正文 detail', 100, 35), 'accent', { selected: true, bold: true })
    const render = () => secondaryModalFrame(viewport, [secondaryModalRow('old header', 'accent'), selected,
      secondaryModalRow('', 'primary'), secondaryModalRow('', 'primary'), secondaryModalRow('Esc close', 'muted')], undefined, 35)
    const focused = renderLegacyWorkspaceFrame(viewport, { title: 'Tools', focus: 'list' }, render)
    const unfocused = renderLegacyWorkspaceFrame(viewport, { title: 'Tools', focus: 'details' }, render)
    expect(focused.styleSpans?.[1]?.some(span => span.style.backgroundRole === 'selectionBackground' && span.width < 100)).toBe(true)
    expect(unfocused.styleSpans?.[1]?.some(span => span.style.backgroundRole === 'inactiveSelectionBackground')).toBe(true)
    expect(focused.styleSpans?.[1]?.at(-1)?.style).toMatchObject({ tone: 'primary', backgroundRole: 'panelBackground' })
    expect(focused.lines[1]).toContain('正文 detail')
    expect(focused.lines[1]).not.toContain('│')
  })

  it('treats literal box glyphs as detail content instead of a new region boundary', () => {
    const viewport = { columns: 80, rows: 4 }
    const frame = renderLegacyWorkspaceFrame(viewport, { title: 'Tools', focus: 'list' }, () => secondaryModalFrame(viewport, [
      secondaryModalRow('Tools', 'accent'),
      secondaryModalRow(secondaryModalSplit('› item │ literal', 'detail │ literal', 80, 24), 'accent', { selected: true }),
      secondaryModalRow('', 'primary'), secondaryModalRow('Esc close', 'muted'),
    ], undefined, 24))
    expect(frame.lines[1]).toContain('› item │ literal')
    expect(frame.lines[1]).toContain('detail │ literal')
    expect(frame.styleSpans?.[1]?.filter(span => span.style.backgroundRole === 'selectionBackground').map(span => span.width)).toEqual([24])
    expect(frame.styleSpans?.[1]?.at(-1)?.style).toMatchObject({ tone: 'primary', backgroundRole: 'panelBackground' })
  })

  it('does not highlight a single-column list when details own the focus', () => {
    const viewport = { columns: 80, rows: 3 }
    const frame = renderLegacyWorkspaceFrame(viewport, { title: 'Tools', focus: 'details' }, () => secondaryModalFrame(viewport, [
      secondaryModalRow('Tools', 'accent'), secondaryModalRow('› item', 'accent', { selected: true }), secondaryModalRow('Esc close', 'muted'),
    ]))
    expect(frame.lineStyles?.[1]?.backgroundRole).toBe('inactiveSelectionBackground')
  })

  it('keeps one-cell resize frames within terminal cells without emitting ANSI', () => {
    for (const columns of [1, 2]) {
      const viewport = { columns, rows: 3 }
      const frame = renderLegacyWorkspaceFrame(viewport, { title: '中文🙂', focus: 'details' }, () => ({ title: 'test', viewport, lines: ['', '│', ''] }))
      expect(frame.lines.every(line => visibleWidth(line) === columns)).toBe(true)
      expect(frame.lines.join('')).not.toContain('\u001b')
    }
  })

  it('fills an empty projection while the first terminal width sample is unavailable', () => {
    const frame = renderLegacyWorkspaceFrame({ columns: Number.NaN, rows: 3 }, { title: 'Loading', focus: 'list' }, viewport => ({ title: 'DSH-TUI', viewport, lines: [] }))
    expect(frame.viewport).toEqual({ columns: 1, rows: 3 })
    expect(frame.lines).toHaveLength(3)
    expect(frame.lines.every(line => visibleWidth(line) === 1)).toBe(true)
    expect(frame.lines[1]).toBe(' ')
  })

  it('preserves completed retry truth when displaying request recovery history', () => {
    const attempt = { retry: 1, scheduledSeq: 2, scheduledAt: 1_000, delayMs: 1_500, startedSeq: 3,
      failure: { message: 'Provider rejected request', code: 'RATE_LIMIT', status: 429, requestId: 'request-a' } }
    const chain: LlmAttemptChain = { retryId: 'retry-a', turn: 1, step: 1, phase: 'recovered', provider: 'provider-a',
      mode: 'normal', policyKey: 'normal', maxRetries: 2, attempts: [attempt] }
    const frame = renderDshFrame({ ...base, attemptPanel: { rows: [chain], selectedIndex: 0, selected: chain,
      selectedAttemptIndex: 0, selectedAttempt: attempt, omittedChainCount: 0 } }, { columns: 120, rows: 24 })
    expect(frame.lines.join('\n')).toContain('Retry wait  1.5s · completed')
    expect(frame.lines.join('\n')).toContain('State  RECOVERED')
    expect(frame.lines.join('\n')).not.toContain('· scheduled')
  })

  it('keeps the route history omission count visible on the actual Workspace rail', () => {
    const epochs: RequestRouteEpoch[] = Array.from({ length: 8 }, (_, index) => ({ headerSeq: index + 1,
      headerTime: index, reason: index === 0 ? 'initial' as const : 'change' as const, config: { provider: 'provider-a', model: `model-${index}` } })).reverse()
    const frame = renderDshFrame({ ...base, routePanel: { rows: epochs, selectedIndex: 0, selected: epochs[0]!, omittedEpochCount: 2 } }, { columns: 120, rows: 24 })
    expect(frame.lines.join('\n')).toContain('…4 ─')
    expect(frame.lines.join('\n')).toContain('10 epochs')
    expect(frame.lines.join('\n')).toContain('CURRENT')
    expect(frame.lines.at(-1)).toContain('Esc back')
  })
})
