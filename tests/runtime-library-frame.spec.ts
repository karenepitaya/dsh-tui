import { describe, expect, it } from 'vitest'
import type { PluginInventorySnapshot } from '../src/plugin-inventory/port.ts'
import type { SettingsCatalogSnapshot } from '../src/settings/port.ts'
import {
  applyRuntimeLibraryAction,
  createRuntimeLibraryState,
  openRuntimeLibrary,
  selectRuntimeLibrary,
  type RuntimeLibraryState,
} from '../src/runtime-library/surface.ts'
import { createUiState } from '../src/transcript/state.ts'
import { renderDshFrame } from '../src/ui/frame.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'

const settings: SettingsCatalogSnapshot = {
  available: true,
  writable: true,
  documentBacked: true,
  generation: 8,
  namespaces: [{
    namespace: 'agent-loop',
    schema: {},
    value: { maxSteps: 30, retry: { enabled: true } },
    base: { maxSteps: 20 },
    user: { maxSteps: 30 },
    revision: 5,
    applies: 'live',
    secrets: [{ path: ['apiKey'], set: true }],
  }],
}

const plugins: PluginInventorySnapshot = {
  available: true,
  entries: [
    { entryId: 'settings', moduleName: '@deepseek-ai/dsh-settings-file', enabled: true, fiberPhase: 'active' },
    { entryId: 'web', moduleName: '@deepseek-ai/dsh-web', enabled: false, fiberPhase: 'failed' },
  ],
}

function frame(
  state: RuntimeLibraryState = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins),
  viewport = { columns: 160, rows: 42 },
) {
  return renderDshFrame({
    ui: createUiState(),
    interaction: undefined,
    prompt: createPromptEditorState('conversation must remain beneath the overlay'),
    runtimeLibrary: selectRuntimeLibrary(state)!,
  }, viewport)
}

describe('Runtime Library fixed secondary surface', () => {
  it('shows effective settings and edit scope before storage metadata', () => {
    const rendered = frame()
    const output = rendered.lines.join('\n')

    expect(rendered.overlay).toBeUndefined()
    expect(output).toContain('Settings')
    expect(output).toContain('SETTINGS')
    expect(output).toContain('PLUGINS')
    expect(output).toContain('Effective values')
    expect(output).toContain('Maximum steps  30')
    expect(output).toContain('apiKey  configured')
    expect(output).toContain('Applies immediately')
    expect(output).toContain('Saved for your user')
    expect(output).not.toContain('Layer stack')
    expect(output).not.toContain('Revision')
    expect(output).toContain('› Agent loop')
    expect(output).not.toContain('Dashboard')
    expect(output).not.toContain('conversation must remain')
    expect(rendered.lineStyles?.every(style => style?.backgroundRole !== undefined)).toBe(true)
    expect(rendered.lineStyles?.some(style => style?.backgroundRole === 'selectionBackground')).toBe(true)
  })

  it('shows the selected plugin state and supported action without internal lifecycle rows', () => {
    const base = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    const rendered = frame(applyRuntimeLibraryAction(base, { type: 'switch-tab' }).state)
    const output = rendered.lines.join('\n')

    expect(rendered.overlay).toBeUndefined()
    expect(output).toContain('Selected plugin')
    expect(output).toContain('ACTIVE')
    expect(output).toContain('Enter refresh')
    expect(output).toContain('› Settings file')
    expect(output).not.toContain('Layer stack')
  })

  it('renders settings authority, failure, empty, filter, editor, and pending states', () => {
    const staleSettings: SettingsCatalogSnapshot = {
      available: true,
      writable: false,
      documentBacked: false,
      generation: 9,
      stale: true,
      error: 'descriptor stale',
      namespaces: [{
        namespace: 'edge',
        schema: {},
        value: { opaque: 1n, optional: undefined, normal: true },
        user: { opaque: 1n, normal: true },
        revision: 3,
        applies: 'restart',
        secrets: [
          { path: ['firstSecret'], set: false },
          { path: ['secondSecret'], set: true },
        ],
      }],
    }
    let state = openRuntimeLibrary(createRuntimeLibraryState(), staleSettings, plugins)
    let output = frame(state).lines.join('\n')
    expect(output).toContain('descriptor stale')
    expect(output).toContain('Showing last known settings')
    expect(output).toContain('This application only · Read-only')
    expect(output).toContain('unprintable')
    expect(output).toContain('firstSecret  not set')
    expect(output).toContain('secondSecret  configured')
    expect(output).toContain('Applies after restart')

    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    output = frame(state).lines.join('\n')
    expect(output).toContain('Read-only')
    expect(output).not.toContain('Ctrl+S inherit')
    expect(frame(applyRuntimeLibraryAction(state, { type: 'enter' }).state).lines.join('\n'))
      .toContain('Settings provider is read only')

    state = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    const secretEditor = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    expect(frame(secretEditor).lines.join('\n')).toContain('Secret JSON')
    state = applyRuntimeLibraryAction(secretEditor, { type: 'escape' }).state
    state = applyRuntimeLibraryAction(state, { type: 'move-down' }).state
    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    output = frame(state).lines.join('\n')
    expect(output).toContain('Value JSON')
    expect(output).toContain('Type JSON')
    state = applyRuntimeLibraryAction(state, { type: 'escape' }).state
    state = applyRuntimeLibraryAction(state, { type: 'inherit' }).state
    output = frame(state).lines.join('\n')
    expect(output).toContain('Writing through official SettingsProvider')
    expect(output).toContain('Settings write in progress')

    const noisy = { ...state, notice: 'saved edge', error: 'write failed' }
    output = frame(noisy).lines.join('\n')
    expect(output).toContain('Saved  saved edge')
    expect(output).toContain('Error  write failed')

    const unavailable: SettingsCatalogSnapshot = {
      available: false,
      writable: false,
      documentBacked: false,
      generation: 0,
      namespaces: [],
    }
    output = frame(openRuntimeLibrary(createRuntimeLibraryState(), unavailable, {
      available: false,
      entries: [],
    })).lines.join('\n')
    expect(output).toContain('Settings service is unavailable')

    let filtered = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    filtered = applyRuntimeLibraryAction(filtered, { type: 'search' }).state
    filtered = applyRuntimeLibraryAction(filtered, {
      type: 'edit', action: { type: 'insert', text: 'no-such-namespace' },
    }).state
    expect(frame(filtered).lines.join('\n')).toContain('No matching settings')
  })

  it.each([
    { phase: 'pending' as const, symbol: '◐ PENDING' },
    { phase: 'loading' as const, symbol: '◐ LOADING' },
    { phase: 'failed' as const, symbol: '× FAILED' },
    { phase: 'unloading' as const, symbol: '◐ UNLOADING' },
    { phase: null, symbol: '○ DETACHED' },
  ])('renders the $phase plugin phase without inventing control authority', ({ phase }) => {
    const phasePlugins: PluginInventorySnapshot = {
      available: true,
      entries: [{
        entryId: `fixture-${String(phase)}`,
        moduleName: '@fixture/plugin',
        enabled: phase !== 'failed',
        fiberPhase: phase,
      }],
    }
    let state = openRuntimeLibrary(createRuntimeLibraryState(), settings, phasePlugins)
    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    const output = frame(state).lines.join('\n')
    expect(output).toContain(phase === null ? 'DETACHED' : phase.toUpperCase())
    if (phase === 'failed') expect(output).toContain('Disabled in configuration')
    expect(output).toContain('Change plugins in the application configuration')
    expect(output).not.toContain('Fiber')
  })

  it('renders unavailable and filtered Loader catalogs plus every compact height', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), {
      ...settings,
      available: false,
    }, {
      available: true,
      entries: [],
      error: 'loader snapshot failed',
    })
    let output = frame(state).lines.join('\n')
    expect(output).toContain('loader snapshot failed')
    expect(output).toContain('Could not load plugins · Enter to retry')

    state = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    state = applyRuntimeLibraryAction(state, { type: 'search' }).state
    state = applyRuntimeLibraryAction(state, {
      type: 'edit', action: { type: 'insert', text: 'no-such-plugin' },
    }).state
    output = frame(state).lines.join('\n')
    expect(output).toContain('No matching plugins')

    const base = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    for (const rows of [1, 2, 3, 4]) {
      const compact = frame(base, { columns: 80, rows })
      expect(compact.lines).toHaveLength(rows)
      expect(compact.lineStyles?.every(style => style?.backgroundRole !== undefined)).toBe(true)
    }
  })

  it('renders true empty authorities and keeps long catalogs visually subordinate to detail', () => {
    const availableEmpty: SettingsCatalogSnapshot = {
      available: true,
      writable: true,
      documentBacked: true,
      generation: 1,
      namespaces: [],
    }
    let output = frame(openRuntimeLibrary(
      createRuntimeLibraryState(),
      availableEmpty,
      { available: false, entries: [] },
    )).lines.join('\n')
    expect(output).toContain('No registered settings')

    const defaultsOnly: SettingsCatalogSnapshot = {
      ...settings,
      namespaces: [{
        namespace: 'defaults-only',
        schema: {},
        value: { enabled: true },
        revision: 0,
        applies: 'live',
        secrets: [],
      }],
    }
    output = frame(openRuntimeLibrary(
      createRuntimeLibraryState(),
      defaultsOnly,
      plugins,
    )).lines.join('\n')
    expect(output).toContain('enabled  true')
    expect(output).not.toContain('USER')
    expect(output).not.toContain('◈ SECRET')

    let unavailablePlugins = openRuntimeLibrary(
      createRuntimeLibraryState(),
      settings,
      { available: false, entries: [] },
    )
    unavailablePlugins = applyRuntimeLibraryAction(
      unavailablePlugins,
      { type: 'switch-tab' },
    ).state
    expect(frame(unavailablePlugins).lines.join('\n')).toContain(
      'Plugin list is unavailable',
    )

    const namespaces = Array.from({ length: 30 }, (_, index) => ({
      namespace: `namespace-${String(index).padStart(2, '0')}`,
      schema: {},
      value: { enabled: true },
      revision: index,
      applies: 'live' as const,
      secrets: [],
    }))
    const longCatalog: RuntimeLibraryState = {
      ...openRuntimeLibrary(createRuntimeLibraryState(), {
        ...settings,
        namespaces,
      }, plugins),
      focus: 'detail',
      settingsSelection: 'namespace-20',
      fieldSelection: '["enabled"]',
    }
    const rendered = frame(longCatalog)
    expect(rendered.lines.join('\n')).toContain('› namespace-20')
    expect(rendered.lines.join('\n')).toContain('  namespace-19')
    expect(rendered.overlay).toBeUndefined()
  })

  it('shows one active region below 100 columns and exposes a cursor only while inserting', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    expect(frame(state, { columns: 80, rows: 14 }).cursor).toBeUndefined()
    expect(frame(state, { columns: 80, rows: 14 }).lines.join('\n')).not.toContain('Layer stack')
    state = applyRuntimeLibraryAction(state, { type: 'search' }).state
    expect(frame(state, { columns: 80, rows: 14 }).cursor).toBeDefined()
    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    state = applyRuntimeLibraryAction(state, { type: 'focus-next' }).state
    const detail = frame(state, { columns: 80, rows: 14 })
    expect(detail.cursor).toBeUndefined()
    expect(detail.lines.join('\n')).toContain('Maximum steps')
    expect(detail.lines.join('\n')).not.toContain('› Agent loop')
    expect(frame(state, { columns: 100, rows: 14 }).lines.join('\n')).toContain('› Agent loop')
  })

  it('keeps plugin details and inherited base fields reachable at narrow widths', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), {
      ...settings, namespaces: [{ ...settings.namespaces[0]!, value: { inherited: 1, user: 2 }, base: { inherited: 1 }, user: { user: 2 } }],
    }, plugins)
    expect(frame(state).lines.join('\n')).toContain('inherited  1')
    state = applyRuntimeLibraryAction(state, { type: 'focus-next' }).state
    expect(frame(state).lines.join('\n')).toContain('inherited  1 · base')
    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    expect(frame(state, { columns: 80, rows: 14 }).lines.join('\n')).toContain('Plugins')
    state = applyRuntimeLibraryAction(state, { type: 'focus-next' }).state
    const detail = frame(state, { columns: 80, rows: 30 })
    expect(detail.lines.join('\n')).toContain('Plugin details')
    expect(detail.lines.join('\n')).toContain('j/k scroll')
    expect(detail.lines.join('\n')).toContain('Read-only plugin inventory')
  })

  it('keeps unavailable and filtered states visible in the narrow catalog region', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), {
      ...settings, available: false, writable: false, documentBacked: false, namespaces: [],
    }, { available: false, entries: [] })
    expect(frame(state, { columns: 80, rows: 12 }).lines.join('\n')).toContain('Settings service is unavailable')
    state = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    state = applyRuntimeLibraryAction(state, { type: 'search' }).state
    state = applyRuntimeLibraryAction(state, { type: 'edit', action: { type: 'insert', text: 'missing' } }).state
    expect(frame(state, { columns: 80, rows: 12 }).lines.join('\n')).toContain('No matching settings')
  })

  it('follows the selected field and wraps its complete value into reachable detail rows', () => {
    const value = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [
      `field${String(index).padStart(2, '0')}`,
      index === 44 ? `${'长路径值'.repeat(100)}REACHABLE_FIELD_END` : index,
    ]))
    let state = openRuntimeLibrary(createRuntimeLibraryState(), {
      ...settings, namespaces: [{ ...settings.namespaces[0]!, value, base: undefined, user: undefined, secrets: [] }],
    }, plugins)
    state = applyRuntimeLibraryAction(state, { type: 'focus-next' }).state
    for (let index = 0; index < 44; index += 1) state = applyRuntimeLibraryAction(state, { type: 'move-down' }).state
    expect(frame(state, { columns: 80, rows: 12 }).lines.join('\n')).toContain('field44')
    state = applyRuntimeLibraryAction(state, { type: 'scroll', delta: 10_000 }).state
    for (const columns of [80, 100, 140, 200]) {
      const rendered = frame(state, { columns, rows: 12 })
      expect(rendered.lines.join('\n')).toContain('REACHABLE_FIELD_END')
      expect(rendered.lines.every(line => visibleWidth(line) <= columns)).toBe(true)
    }
  })
})
