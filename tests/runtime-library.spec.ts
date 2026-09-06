import { describe, expect, it } from 'vitest'
import type { PluginInventorySnapshot } from '../src/plugin-inventory/port.ts'
import type { SettingsCatalogSnapshot } from '../src/settings/port.ts'
import {
  applyRuntimeLibraryAction,
  createRuntimeLibraryState,
  openRuntimeLibrary,
  pluginPhaseLabel,
  reconcileRuntimeLibrary,
  selectRuntimeLibrary,
  settleRuntimeLibraryMutation,
  type RuntimeLibraryState,
} from '../src/runtime-library/surface.ts'

const SETTINGS: SettingsCatalogSnapshot = {
  available: true,
  writable: true,
  documentBacked: true,
  generation: 4,
  namespaces: [
    {
      namespace: 'agent-loop',
      schema: {},
      value: { maxSteps: 30, policy: 'balanced', retry: { enabled: true } },
      base: { maxSteps: 20 },
      user: { policy: 'balanced' },
      revision: 9,
      applies: 'live',
      secrets: [{ path: ['apiKey'], set: true }],
    },
    {
      namespace: 'web-server',
      schema: {},
      value: { port: 3000 },
      revision: 2,
      applies: 'restart',
      secrets: [],
    },
  ],
}

const PLUGINS: PluginInventorySnapshot = {
  available: true,
  entries: [
    { entryId: 'agent', moduleName: '@deepseek-ai/dsh-agent', enabled: true, fiberPhase: 'active' },
    { entryId: 'web', moduleName: '@deepseek-ai/dsh-web', enabled: false, fiberPhase: null },
  ],
}

const EMPTY_SETTINGS: SettingsCatalogSnapshot = {
  available: false,
  writable: false,
  documentBacked: false,
  generation: 0,
  namespaces: [],
}

const EMPTY_PLUGINS: PluginInventorySnapshot = {
  available: false,
  entries: [],
}

describe('Runtime Library surface state', () => {
  it('keeps Normal keys out of search and leaves the directory with one Escape', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), SETTINGS, PLUGINS)
    expect(selectRuntimeLibrary(state)?.searchFocused).toBe(false)
    expect(applyRuntimeLibraryAction(state, { type: 'edit', action: { type: 'insert', text: 'j' } }).state).toBe(state)
    state = applyRuntimeLibraryAction(state, { type: 'search' }).state
    state = applyRuntimeLibraryAction(state, { type: 'edit', action: { type: 'insert', text: 'web' } }).state
    expect(selectRuntimeLibrary(state)).toMatchObject({ searchFocused: true, query: { text: 'web' } })
    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    expect(selectRuntimeLibrary(state)).toMatchObject({ searchFocused: false, focus: 'catalog' })
    state = applyRuntimeLibraryAction(state, { type: 'focus-next' }).state
    expect(selectRuntimeLibrary(state)?.focus).toBe('detail')
    expect(applyRuntimeLibraryAction(state, { type: 'escape' }).outcome).toEqual({ kind: 'cancelled' })
    const search = applyRuntimeLibraryAction(openRuntimeLibrary(state, SETTINGS, PLUGINS), { type: 'search' }).state
    expect(applyRuntimeLibraryAction(search, { type: 'escape' }).outcome).toEqual({ kind: 'cancelled' })
  })

  it('scrolls plugin details independently and resets detail position with the selection', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), SETTINGS, PLUGINS)
    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    state = applyRuntimeLibraryAction(state, { type: 'focus-next' }).state
    state = applyRuntimeLibraryAction(state, { type: 'move-down' }).state
    expect(selectRuntimeLibrary(state)).toMatchObject({ focus: 'detail', detailScrollOffset: 1, plugins: { selected: { entryId: 'agent' } } })
    state = applyRuntimeLibraryAction(state, { type: 'scroll', delta: 8 }).state
    expect(selectRuntimeLibrary(state)?.detailScrollOffset).toBe(9)
    state = applyRuntimeLibraryAction(state, { type: 'focus-previous' }).state
    state = applyRuntimeLibraryAction(state, { type: 'move-down' }).state
    expect(selectRuntimeLibrary(state)).toMatchObject({ focus: 'catalog', detailScrollOffset: undefined, plugins: { selected: { entryId: 'web' } } })
  })

  it('builds a stable settings layer stack and plugin lifecycle catalog', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), SETTINGS, PLUGINS)
    let view = selectRuntimeLibrary(state)!

    expect(view.tab).toBe('settings')
    expect(view.settings.rows.map(row => row.namespace)).toEqual(['agent-loop', 'web-server'])
    expect(view.settings.selected?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['maxSteps'], source: 'base', value: 30 }),
      expect.objectContaining({ path: ['policy'], source: 'user', value: 'balanced' }),
      expect.objectContaining({ path: ['retry', 'enabled'], source: 'default', value: true }),
      expect.objectContaining({ path: ['apiKey'], source: 'secret', secretSet: true }),
    ]))

    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    view = selectRuntimeLibrary(state)!
    expect(view.tab).toBe('plugins')
    expect(view.plugins.rows).toEqual([
      expect.objectContaining({ entryId: 'agent', fiberPhase: 'active', selected: true }),
      expect.objectContaining({ entryId: 'web', enabled: false, fiberPhase: null }),
    ])
  })

  it('edits one JSON field with CAS metadata, supports inherit, and contains invalid JSON', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), SETTINGS, PLUGINS)
    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    let view = selectRuntimeLibrary(state)!
    expect(view.focus).toBe('detail')

    state = applyRuntimeLibraryAction(state, { type: 'move-down' }).state
    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    view = selectRuntimeLibrary(state)!
    expect(view.editor?.path).toEqual(['maxSteps'])
    for (const type of ['search', 'focus-next', 'focus-previous', 'move-up'] as const) {
      expect(applyRuntimeLibraryAction(state, { type }).state).toBe(state)
    }
    expect(applyRuntimeLibraryAction(state, { type: 'scroll', delta: 1 }).state).toBe(state)
    for (let index = 0; index < 2; index += 1) {
      state = applyRuntimeLibraryAction(state, {
        type: 'edit', action: { type: 'backspace' },
      }).state
    }
    state = applyRuntimeLibraryAction(state, {
      type: 'edit', action: { type: 'insert', text: '{' },
    }).state
    let invalid = applyRuntimeLibraryAction(state, { type: 'enter' })
    expect(invalid.outcome).toBeUndefined()
    expect(selectRuntimeLibrary(invalid.state)?.error).toContain('valid JSON')

    state = applyRuntimeLibraryAction(state, { type: 'escape' }).state
    const inherit = applyRuntimeLibraryAction(state, { type: 'inherit' })
    expect(inherit.outcome).toEqual({
      kind: 'mutate',
      request: {
        namespace: 'agent-loop',
        path: ['maxSteps'],
        operation: 'unset',
        expectedRevision: 9,
      },
    })
    expect(selectRuntimeLibrary(inherit.state)?.pending).toBe(true)

    const settled = settleRuntimeLibraryMutation(
      inherit.state,
      { ...SETTINGS, generation: 5 },
      PLUGINS,
      undefined,
    )
    expect(selectRuntimeLibrary(settled)).toMatchObject({
      pending: false,
      notice: 'Inherited maxSteps from the lower settings layer',
    })
  })

  it('contains closed, empty, pending, and read-only action states', () => {
    const closed = createRuntimeLibraryState()
    expect(selectRuntimeLibrary(closed)).toBeUndefined()
    expect(applyRuntimeLibraryAction(closed, { type: 'move-down' })).toEqual({ state: closed })

    let state = openRuntimeLibrary(closed, EMPTY_SETTINGS, PLUGINS)
    expect(selectRuntimeLibrary(state)?.tab).toBe('plugins')
    state = applyRuntimeLibraryAction(state, { type: 'move-down' }).state
    expect(selectRuntimeLibrary(state)?.plugins.selected?.entryId).toBe('web')
    state = applyRuntimeLibraryAction(state, { type: 'move-up' }).state
    expect(selectRuntimeLibrary(state)?.plugins.selected?.entryId).toBe('agent')
    expect(applyRuntimeLibraryAction(state, { type: 'enter' }).outcome).toEqual({
      kind: 'refresh-plugins',
    })

    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    expect(selectRuntimeLibrary(state)?.tab).toBe('settings')
    expect(applyRuntimeLibraryAction(state, { type: 'move-down' }).state).toBe(state)
    expect(applyRuntimeLibraryAction(state, { type: 'enter' }).state).toBe(state)
    expect(applyRuntimeLibraryAction(state, { type: 'inherit' }).state).toBe(state)

    const cancelled = applyRuntimeLibraryAction(state, { type: 'escape' })
    expect(cancelled.outcome).toEqual({ kind: 'cancelled' })
    expect(selectRuntimeLibrary(cancelled.state)).toBeUndefined()

    const readOnly = openRuntimeLibrary(createRuntimeLibraryState(), {
      ...SETTINGS,
      writable: false,
    }, EMPTY_PLUGINS)
    const detail = applyRuntimeLibraryAction(readOnly, { type: 'enter' }).state
    expect(selectRuntimeLibrary(
      applyRuntimeLibraryAction(detail, { type: 'enter' }).state,
    )?.error).toBe('Settings provider is read only')
    expect(selectRuntimeLibrary(
      applyRuntimeLibraryAction(detail, { type: 'inherit' }).state,
    )?.error).toBe('Settings provider is read only')

    const pending = { ...detail, pending: true }
    expect(applyRuntimeLibraryAction(pending, { type: 'move-down' }).state).toBe(pending)
    expect(applyRuntimeLibraryAction(pending, { type: 'escape' }).outcome).toEqual({
      kind: 'cancelled',
    })

    const emptyPlugins = applyRuntimeLibraryAction(
      openRuntimeLibrary(createRuntimeLibraryState(), SETTINGS, EMPTY_PLUGINS),
      { type: 'switch-tab' },
    ).state
    expect(applyRuntimeLibraryAction(emptyPlugins, { type: 'move-down' }).state)
      .toBe(emptyPlugins)
  })

  it('contains empty detail focus and recovers stale field selections', () => {
    const availableEmpty: SettingsCatalogSnapshot = {
      ...EMPTY_SETTINGS,
      available: true,
      writable: true,
    }
    const emptyDetail: RuntimeLibraryState = {
      ...openRuntimeLibrary(createRuntimeLibraryState(), availableEmpty, EMPTY_PLUGINS),
      focus: 'detail',
    }
    expect(applyRuntimeLibraryAction(emptyDetail, { type: 'move-down' }).state)
      .toBe(emptyDetail)
    expect(applyRuntimeLibraryAction(emptyDetail, { type: 'enter' }).state)
      .toBe(emptyDetail)
    expect(applyRuntimeLibraryAction(emptyDetail, { type: 'inherit' }).state)
      .toBe(emptyDetail)

    const staleSelection: RuntimeLibraryState = {
      ...openRuntimeLibrary(createRuntimeLibraryState(), SETTINGS, PLUGINS),
      focus: 'detail',
      fieldSelection: '["removed-field"]',
    }
    const recovered = applyRuntimeLibraryAction(staleSelection, { type: 'enter' }).state
    expect(selectRuntimeLibrary(recovered)?.editor?.path).toEqual(['apiKey'])
    expect(selectRuntimeLibrary(
      applyRuntimeLibraryAction(staleSelection, { type: 'move-down' }).state,
    )?.settings.selected?.fields.some(field => field.selected)).toBe(true)
    expect(selectRuntimeLibrary(
      applyRuntimeLibraryAction(staleSelection, { type: 'escape' }).state,
    )).toBeUndefined()

    const undefinedRoot: SettingsCatalogSnapshot = {
      ...SETTINGS,
      namespaces: [{
        namespace: 'undefined-root',
        schema: {},
        value: undefined,
        revision: 1,
        applies: 'live',
        secrets: [],
      }],
    }
    let root = openRuntimeLibrary(createRuntimeLibraryState(), undefinedRoot, EMPTY_PLUGINS)
    root = applyRuntimeLibraryAction(root, { type: 'enter' }).state
    root = applyRuntimeLibraryAction(root, { type: 'enter' }).state
    expect(selectRuntimeLibrary(root)?.editor?.input.text).toBe('null')
  })

  it('filters both authorities and reconciles removed selections', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), SETTINGS, PLUGINS)
    state = applyRuntimeLibraryAction(state, { type: 'search' }).state
    state = applyRuntimeLibraryAction(state, {
      type: 'edit', action: { type: 'insert', text: 'WEB' },
    }).state
    expect(selectRuntimeLibrary(state)?.settings.rows.map(row => row.namespace)).toEqual([
      'web-server',
    ])
    state = applyRuntimeLibraryAction(state, { type: 'move-down' }).state
    expect(selectRuntimeLibrary(state)?.settings.selected?.namespace).toBe('web-server')

    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    state = applyRuntimeLibraryAction(state, { type: 'search' }).state
    state = applyRuntimeLibraryAction(state, {
      type: 'edit', action: { type: 'insert', text: '@deepseek-ai/dsh-web' },
    }).state
    expect(selectRuntimeLibrary(state)?.plugins.rows.map(row => row.entryId)).toEqual(['web'])
    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    state = applyRuntimeLibraryAction(state, { type: 'search' }).state
    state = applyRuntimeLibraryAction(state, {
      type: 'edit', action: { type: 'insert', text: 'detached' },
    }).state
    expect(selectRuntimeLibrary(state)?.plugins.rows.map(row => row.entryId)).toEqual(['web'])
    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    state = applyRuntimeLibraryAction(state, { type: 'switch-tab' }).state
    state = applyRuntimeLibraryAction(state, { type: 'search' }).state
    state = applyRuntimeLibraryAction(state, {
      type: 'edit', action: { type: 'insert', text: 'agent' },
    }).state
    expect(selectRuntimeLibrary(state)?.plugins.rows.map(row => row.entryId)).toEqual(['agent'])

    const selectedSecond = applyRuntimeLibraryAction(
      openRuntimeLibrary(createRuntimeLibraryState(), SETTINGS, PLUGINS),
      { type: 'move-down' },
    ).state
    const reconciled = reconcileRuntimeLibrary(selectedSecond, {
      ...SETTINGS,
      namespaces: SETTINGS.namespaces.slice(0, 1),
    }, { ...PLUGINS, entries: PLUGINS.entries.slice(1) })
    expect(selectRuntimeLibrary(reconciled)).toMatchObject({
      settings: { selected: { namespace: 'agent-loop' } },
      plugins: { selected: { entryId: 'web' } },
    })
  })

  it('edits secret and defensive JSON fields, then settles success and failure', () => {
    let state = openRuntimeLibrary(createRuntimeLibraryState(), SETTINGS, PLUGINS)
    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    expect(selectRuntimeLibrary(state)?.settings.selected?.fields[0]).toMatchObject({
      source: 'secret',
      selected: true,
    })
    state = applyRuntimeLibraryAction(state, { type: 'enter' }).state
    expect(selectRuntimeLibrary(state)?.editor).toMatchObject({ secret: true })
    state = applyRuntimeLibraryAction(state, {
      type: 'edit', action: { type: 'backspace' },
    }).state
    state = applyRuntimeLibraryAction(state, {
      type: 'edit', action: { type: 'backspace' },
    }).state
    state = applyRuntimeLibraryAction(state, {
      type: 'edit', action: { type: 'insert', text: '"secret"' },
    }).state
    const saved = applyRuntimeLibraryAction(state, { type: 'enter' })
    expect(saved.outcome).toMatchObject({
      kind: 'mutate',
      request: { operation: 'set', value: 'secret' },
    })
    expect(selectRuntimeLibrary(settleRuntimeLibraryMutation(
      saved.state,
      SETTINGS,
      PLUGINS,
      undefined,
    ))?.notice).toBe('Updated apiKey')
    expect(selectRuntimeLibrary(settleRuntimeLibraryMutation(
      saved.state,
      SETTINGS,
      PLUGINS,
      'revision conflict',
    ))?.error).toBe('revision conflict')
    expect(selectRuntimeLibrary(settleRuntimeLibraryMutation(
      { ...saved.state, pendingIntent: undefined },
      SETTINGS,
      PLUGINS,
      undefined,
    ))?.notice).toBeUndefined()

    const missingEditor = { ...state, focus: 'editor' as const, editor: undefined }
    expect(applyRuntimeLibraryAction(missingEditor, { type: 'enter' }).state).toBe(missingEditor)
    expect(applyRuntimeLibraryAction(
      { ...state, focus: 'detail' as const },
      { type: 'edit', action: { type: 'insert', text: 'ignored' } },
    ).state).toMatchObject({ focus: 'detail' })
  })

  it('labels root and lower-layer-only fields without inventing a user override', () => {
    const edge: SettingsCatalogSnapshot = {
      ...SETTINGS,
      namespaces: [{
        namespace: 'edge',
        schema: {},
        value: {},
        base: { nested: { value: 1 } },
        revision: 1,
        applies: 'restart',
        secrets: [],
      }, {
        namespace: 'root',
        schema: {},
        value: null,
        revision: 2,
        applies: 'live',
        secrets: [],
      }],
    }
    let state = openRuntimeLibrary(createRuntimeLibraryState(), edge, EMPTY_PLUGINS)
    expect(selectRuntimeLibrary(state)?.settings.selected?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ pathLabel: '$', source: 'base', value: {} }),
      expect.objectContaining({ pathLabel: 'nested.value', source: 'base', value: undefined }),
    ]))
    state = applyRuntimeLibraryAction(state, { type: 'move-down' }).state
    expect(selectRuntimeLibrary(state)?.settings.selected?.fields).toEqual([
      expect.objectContaining({ pathLabel: '$', source: 'default', value: null }),
    ])
    expect(pluginPhaseLabel('loading')).toBe('loading')
    expect(pluginPhaseLabel(null)).toBe('detached')
  })
})
