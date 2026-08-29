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
  it('uses a dedicated solid settings layer composition instead of a generic dashboard', () => {
    const rendered = frame()
    const output = rendered.lines.join('\n')

    expect(rendered.overlay).toMatchObject({ kind: 'library', anchor: 'center' })
    expect(output).toContain('▌ Runtime library')
    expect(output).toContain('SETTINGS')
    expect(output).toContain('PLUGINS')
    expect(output).toContain('Layer stack')
    expect(output).toContain('DEFAULT')
    expect(output).toContain('BASE')
    expect(output).toContain('USER')
    expect(output).toContain('SECRET')
    expect(output).toContain('EFFECTIVE')
    expect(output).toContain('WRITE · USER FILE · G8')
    expect(output).toContain('▰ agent-loop')
    expect(output).not.toContain('Dashboard')
    expect(output).not.toContain('conversation must remain')
    expect(rendered.lineStyles?.every(style => style?.background === 'black')).toBe(true)
    expect(rendered.lineStyles?.some(style => style?.inverse === true)).toBe(true)
  })

  it('switches to a Loader lifecycle rail without resizing the floating surface', () => {
    const base = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    const rendered = frame(applyRuntimeLibraryAction(base, { type: 'switch-tab' }).state)
    const output = rendered.lines.join('\n')

    expect(rendered.overlay).toMatchObject({ kind: 'library', width: 122, maxHeight: 32 })
    expect(output).toContain('Lifecycle rail')
    expect(output).toContain('CONFIGURED')
    expect(output).toContain('ENABLED')
    expect(output).toContain('ACTIVE')
    expect(output).toContain('Authority  Loader snapshot · read only')
    expect(output).toContain('▰ settings')
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
    expect(output).toContain('Showing last good redacted descriptor')
    expect(output).toContain('READ · MEMORY · G9')
    expect(output).toContain('unprintable')
    expect(output).toContain('2 overrides')
    expect(output).toContain('2 redacted slots')
    expect(output).toContain('◐ RESTART')

    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    output = frame(state).lines.join('\n')
    expect(output).toContain('Ctrl+S inherit')
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
    filtered = applyRuntimeLibraryAction(filtered, {
      type: 'edit', action: { type: 'insert', text: 'no-such-namespace' },
    }).state
    expect(frame(filtered).lines.join('\n')).toContain('No matching namespaces')
  })

  it.each([
    { phase: 'pending' as const, symbol: '◐ PENDING' },
    { phase: 'loading' as const, symbol: '◐ LOADING' },
    { phase: 'failed' as const, symbol: '× FAILED' },
    { phase: 'unloading' as const, symbol: '◐ UNLOADING' },
    { phase: null, symbol: '○ DETACHED' },
  ])('renders the $phase Loader phase without inventing control authority', ({ phase, symbol }) => {
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
    expect(output).toContain(symbol)
    expect(output).toContain(phase === 'failed' ? 'DISABLED' : 'ENABLED')
    expect(output).toContain('Not projected  provenance · history · health')
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
    expect(output).toContain('No Loader plugin entries')

    state = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    state = applyRuntimeLibraryAction(state, {
      type: 'edit', action: { type: 'insert', text: 'no-such-plugin' },
    }).state
    output = frame(state).lines.join('\n')
    expect(output).toContain('No matching Loader entries')

    const base = openRuntimeLibrary(createRuntimeLibraryState(), settings, plugins)
    for (const rows of [1, 2, 3, 4]) {
      const compact = frame(base, { columns: 80, rows })
      expect(compact.lines).toHaveLength(rows)
      expect(compact.lineStyles?.every(style => style?.background === 'black')).toBe(true)
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
    expect(output).toContain('No registered settings namespaces')

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
    expect(output).toContain('USER        0 overrides')
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
      'Loader inventory is unavailable',
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
    expect(rendered.lines.join('\n')).toContain('▰ namespace-20')
    expect(rendered.lines.join('\n')).toContain('  namespace-19')
    expect(rendered.overlay).toMatchObject({ kind: 'library', width: 122, maxHeight: 32 })
  })
})
