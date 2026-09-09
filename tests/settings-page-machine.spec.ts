import { describe, expect, it, vi } from 'vitest'
import type { SettingsField, SettingsPageState } from '../src/settings/page-contracts.ts'
import type { SettingsCatalogSnapshot } from '../src/settings/port.ts'
import type { TerminalInputAction } from '../src/terminal/input.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'

const catalog = vi.hoisted(() => ({ fields: [] as SettingsField[] }))
vi.mock('../src/settings/page-catalog.ts', () => ({ buildSettingsFields: () => catalog.fields }))
import { applySettingsPageInput, createSettingsPageState, selectSettingsPage, settleSettingsPageSave } from '../src/settings/page-machine.ts'

function fixture() {
  catalog.fields = [
    field('theme', 'select', 'auto', { options: [{ label: 'Auto', value: 'auto' }, { label: 'Mono', value: 'mono' }] }),
    field('enabled', 'boolean', false),
    field('limit', 'number', 3, { minimum: 1, maximum: 10, integer: true }),
    field('name', 'text', 'old', { overridden: true, inheritedValue: 'base' }),
    field('key', 'secret', undefined, { namespace: 'provider', section: 'models', secretSet: true, overridden: true }),
    field('plugin', 'boolean', true, { namespace: 'plugins', section: 'plugins', applies: 'restart', overridden: true, inheritedValue: false }),
    field('preset', 'readonly', 'standard', { section: 'presets' }),
  ]
  const snapshot: SettingsCatalogSnapshot = {
    available: true, writable: true, documentBacked: true, generation: 1,
    namespaces: ['ui', 'provider', 'plugins'].map(namespace => ({ namespace, schema: {}, value: {}, revision: 7, applies: 'live', secrets: [] })),
  }
  return snapshot
}

function field(id: string, control: SettingsField['control'], value: unknown, extra: Partial<SettingsField> = {}): SettingsField {
  return { id, namespace: 'ui', path: [id], section: 'general', group: 'Interface', label: id, description: `Configure ${id}`, control, value, inheritedValue: value, overridden: false, applies: 'live', ...extra }
}
function key(state: SettingsPageState, snapshot: SettingsCatalogSnapshot, action: TerminalInputAction): SettingsPageState {
  return applySettingsPageInput(state, snapshot, action).state
}
function type(state: SettingsPageState, snapshot: SettingsCatalogSnapshot, text: string): SettingsPageState {
  return key(state, snapshot, { type: 'insert', text })
}
function replaceEditor(state: SettingsPageState, text: string): SettingsPageState {
  return { ...state, editor: { ...state.editor!, input: createPromptEditorState(text) } }
}

describe('Settings page machine', () => {
  it('quits on q outside text entry, confirms draft discard and ignores q while saving', () => {
    const snapshot = fixture()
    for (const focus of ['tabs', 'form', 'actions'] as const) {
      const state = { ...createSettingsPageState(), focus, query: createPromptEditorState('theme') }
      expect(applySettingsPageInput(state, snapshot, { type: 'insert', text: 'q' }).outcome).toEqual({ kind: 'close' })
    }
    let state = key(createSettingsPageState(), snapshot, { type: 'move-right' })
    const departure = applySettingsPageInput(state, snapshot, { type: 'insert', text: 'q' })
    expect(departure.outcome).toBeUndefined()
    expect(departure.state).toMatchObject({ confirmation: 'discard', confirmIndex: 0, drafts: state.drafts })
    state = key(departure.state, snapshot, { type: 'move-right' })
    const cancelled = applySettingsPageInput(state, snapshot, { type: 'insert', text: 'q' })
    expect(cancelled.outcome).toBeUndefined()
    expect(cancelled.state.confirmation).toBeUndefined()
    expect(cancelled.state.drafts).toEqual(state.drafts)
    state = key(cancelled.state, snapshot, { type: 'save-default' })
    expect(applySettingsPageInput(state, snapshot, { type: 'insert', text: 'q' })).toEqual({ state })
  })

  it('treats q as text in search and editors and does not execute pasted quit text', () => {
    const snapshot = fixture()
    let state: SettingsPageState = { ...createSettingsPageState(), focus: 'search' }
    state = type(state, snapshot, 'q')
    expect(state).toMatchObject({ focus: 'search', query: { text: 'q' } })
    state = key(state, snapshot, { type: 'escape' })
    state = key({ ...state, selection: 3 }, snapshot, { type: 'submit' })
    state = type(state, snapshot, 'q')
    expect(state.editor?.input.text).toBe('oldq')
    state = key(state, snapshot, { type: 'escape' })
    expect(applySettingsPageInput(state, snapshot, { type: 'insert', text: 'q', paste: true })).toEqual({ state })
    for (const confirmation of ['discard', 'reset', 'permission'] as const) {
      const cancelled = type({ ...state, confirmation, confirmIndex: 1 }, snapshot, 'q')
      expect(cancelled.confirmation).toBeUndefined()
      expect(cancelled.drafts).toEqual({})
    }
  })

  it('opens a select list without a draft, wraps choices and stages only the confirmed option', () => {
    const snapshot = fixture()
    let state = key(createSettingsPageState(), snapshot, { type: 'submit' })
    expect(state.picker).toMatchObject({ fieldId: 'theme', expectedRevision: 7, selection: 0 })
    expect(state.editor).toBeUndefined()
    expect(state.drafts).toEqual({})
    expect(selectSettingsPage(state, snapshot).picker).toMatchObject({ field: { id: 'theme', value: 'auto' }, selection: 0 })
    state = key(state, snapshot, { type: 'move-up' })
    expect(state.picker?.selection).toBe(1)
    state = key(state, snapshot, { type: 'move-down' })
    expect(state.picker?.selection).toBe(0)
    state = key(state, snapshot, { type: 'move-down' })
    expect(state.picker?.selection).toBe(1)
    expect(state.drafts).toEqual({})
    for (const action of [{ type: 'move-right' }, { type: 'complete' }, { type: 'save-default' }, { type: 'insert', text: ']' }] as const) {
      expect(applySettingsPageInput(state, snapshot, action)).toEqual({ state })
    }
    state = key(state, snapshot, { type: 'submit' })
    expect(state.picker).toBeUndefined()
    expect(state.drafts.theme).toMatchObject({ value: 'mono', expectedRevision: 7 })
    state = key(state, snapshot, { type: 'submit' })
    expect(state.picker?.selection).toBe(1)
    expect(selectSettingsPage(state, snapshot).picker?.field.value).toBe('mono')
    state = key(state, snapshot, { type: 'move-up' })
    state = key(state, snapshot, { type: 'submit' })
    expect(state.picker).toBeUndefined()
    expect(state.drafts).toEqual({})
  })

  it('cancels a select list without losing existing drafts and keeps its opening revision across refresh', () => {
    const snapshot = fixture()
    const staged = key(createSettingsPageState(), snapshot, { type: 'move-right' })
    for (const action of [{ type: 'escape' }, { type: 'insert', text: 'q' }] as const) {
      let state = key(staged, snapshot, { type: 'submit' })
      expect(state.picker?.selection).toBe(1)
      state = key(state, snapshot, { type: 'move-up' })
      const cancelled = applySettingsPageInput(state, snapshot, action)
      expect(cancelled.outcome).toBeUndefined()
      expect(cancelled.state.picker).toBeUndefined()
      expect(cancelled.state.drafts).toEqual(staged.drafts)
    }
    let state = key(createSettingsPageState(), snapshot, { type: 'submit' })
    const newer = { ...snapshot, generation: 2, namespaces: snapshot.namespaces.map(ns => ({ ...ns, revision: 8 })) }
    catalog.fields[0] = { ...catalog.fields[0]!, value: 'mono' }
    state = key(state, newer, { type: 'move-down' })
    state = key(state, newer, { type: 'submit' })
    expect(state.drafts.theme).toMatchObject({ value: 'mono', expectedRevision: 7, field: { value: 'auto' } })
  })

  it('rejects select confirmation if write access disappears and still allows cancellation', () => {
    const snapshot = fixture()
    let state = key(createSettingsPageState(), snapshot, { type: 'submit' })
    state = key(state, snapshot, { type: 'move-down' })
    for (const unavailable of [{ ...snapshot, available: false }, { ...snapshot, writable: false }, { ...snapshot, stale: true }]) {
      const attempted = key(state, unavailable, { type: 'submit' })
      expect(attempted.drafts).toEqual({})
      expect(attempted.picker).toEqual(state.picker)
      expect(attempted.error).toBe('当前设置不可写。')
      expect(type(attempted, unavailable, 'q').picker).toBeUndefined()
    }
  })

  it('navigates the category sidebar vertically, enters the form and keeps bracket shortcuts', () => {
    const snapshot = fixture()
    let state = { ...createSettingsPageState(), selection: 2, query: createPromptEditorState('limit') }
    state = key(state, snapshot, { type: 'complete', reverse: true })
    expect(state.focus).toBe('tabs')
    state = key(state, snapshot, { type: 'move-down' })
    expect(state).toMatchObject({ section: 'models', focus: 'tabs', selection: 0, query: { text: '' } })
    state = key(state, snapshot, { type: 'move-up' })
    expect(state.section).toBe('general')
    state = key(state, snapshot, { type: 'move-up' })
    expect(state.section).toBe('presets')
    state = key(state, snapshot, { type: 'submit' })
    expect(state.focus).toBe('form')
    state = type(state, snapshot, ']')
    expect(state.section).toBe('general')
    state = type(state, snapshot, '[')
    expect(state.section).toBe('presets')
    expect(state.drafts).toEqual({})
  })

  it('stages typed controls and submits exactly one revision-checked batch per namespace', () => {
    const snapshot = fixture()
    let state = createSettingsPageState()
    state = key(state, snapshot, { type: 'move-right' })
    state = key(state, snapshot, { type: 'move-down' })
    state = type(state, snapshot, ' ')
    expect(selectSettingsPage(state, snapshot).fields.slice(0, 2).map(item => item.value)).toEqual(['mono', true])
    expect(state.pending).toBe(false)
    const saved = applySettingsPageInput(state, snapshot, { type: 'save-default' })
    expect(saved.outcome).toEqual({ kind: 'save', requests: [{ namespace: 'ui', path: [], expectedRevision: 7, operation: 'batch', changes: [
      { operation: 'set', path: ['theme'], value: 'mono' }, { operation: 'set', path: ['enabled'], value: true },
    ] }] })
    expect(saved.state.pending).toBe(true)
    expect(key(saved.state, snapshot, { type: 'escape' })).toBe(saved.state)
    expect(applySettingsPageInput(saved.state, snapshot, { type: 'save-default' }).outcome).toBeUndefined()
  })

  it('keeps the edit-start revision and draft when a newer snapshot arrives or saving conflicts', () => {
    const snapshot = fixture()
    let state = key({ ...createSettingsPageState(), selection: 3 }, snapshot, { type: 'submit' })
    state = replaceEditor(state, 'mine')
    const newer = { ...snapshot, generation: 2, namespaces: snapshot.namespaces.map(ns => ({ ...ns, revision: 8 })) }
    catalog.fields[3] = { ...catalog.fields[3]!, value: 'theirs' }
    state = key(state, newer, { type: 'submit' })
    const saved = applySettingsPageInput(state, newer, { type: 'save-default' })
    expect(saved.outcome).toMatchObject({ requests: [{ expectedRevision: 7 }] })
    const failed = settleSettingsPageSave(saved.state, newer, [{ namespace: 'ui', error: 'Revision conflict' }])
    expect(selectSettingsPage(failed, newer).fields[3]?.value).toBe('mine')
    expect(failed.error).toContain('Revision conflict')
    expect(failed.pending).toBe(false)
    expect(failed.drafts.name?.expectedRevision).toBe(7)
  })

  it('validates numbers without losing the editor and saves a valid edit with Ctrl+S', () => {
    const snapshot = fixture()
    let state = key({ ...createSettingsPageState(), selection: 2 }, snapshot, { type: 'submit' })
    for (const invalid of ['', 'NaN', 'Infinity', '1.5', '0', '11']) {
      state = key(replaceEditor(state, invalid), snapshot, { type: 'submit' })
      expect(state.error).toBeTruthy()
      expect(state.editor?.input.text).toBe(invalid)
      expect(state.drafts).toEqual({})
    }
    const saved = applySettingsPageInput(replaceEditor(state, ' 8 '), snapshot, { type: 'save-default' })
    expect(saved.outcome).toMatchObject({ kind: 'save', requests: [{ changes: [{ operation: 'set', path: ['limit'], value: 8 }] }] })
    expect(saved.state.editor).toBeUndefined()
  })

  it('keeps secret values out of field projections and error messages while retaining failed secret drafts', () => {
    const snapshot = fixture()
    let state = key({ ...createSettingsPageState(), section: 'models' }, snapshot, { type: 'submit' })
    expect(state.editor?.input.text).toBe('')
    state = type(state, snapshot, 'private-token')
    expect(selectSettingsPage(state, snapshot).editor?.input.text).toBe('private-token')
    state = key(state, snapshot, { type: 'submit' })
    const visible = selectSettingsPage(state, snapshot)
    expect(visible.fields[0]).toMatchObject({ control: 'secret', value: undefined, inheritedValue: undefined, secretSet: true })
    expect(JSON.stringify(visible)).not.toContain('private-token')
    const saved = applySettingsPageInput(state, snapshot, { type: 'save-default' })
    expect(saved.outcome).toMatchObject({ requests: [{ namespace: 'provider', changes: [{ value: 'private-token' }] }] })
    state = settleSettingsPageSave(saved.state, snapshot, [{ namespace: 'provider', error: 'Rejected private-token' }])
    expect(state.drafts.key?.value).toBe('private-token')
    expect(JSON.stringify(selectSettingsPage(state, snapshot))).not.toContain('private-token')
    expect(state.error).toContain('[redacted]')
  })

  it('restores only the current category to inherited defaults after confirmation and an explicit save', () => {
    const snapshot = fixture()
    let state = key(createSettingsPageState(), snapshot, { type: 'move-right' })
    state = type(state, snapshot, ']')
    state = key(state, snapshot, { type: 'submit' })
    state = key(replaceEditor(state, 'secret'), snapshot, { type: 'submit' })
    state = type(state, snapshot, '[')
    state = { ...state, confirmation: 'reset', confirmIndex: 0 }
    expect(state.confirmation).toBe('reset')
    expect(state.confirmIndex).toBe(0)
    const cancelled = key(state, snapshot, { type: 'submit' })
    expect(cancelled.drafts.theme?.value).toBe('mono')
    state = key(state, snapshot, { type: 'move-right' })
    state = key(state, snapshot, { type: 'submit' })
    expect(state.drafts.theme).toBeUndefined()
    expect(state.drafts.name).toMatchObject({ operation: 'unset', expectedRevision: 7 })
    expect(state.drafts.key?.value).toBe('secret')
    expect(selectSettingsPage(state, snapshot).fields[3]?.value).toBe('base')
    const saved = applySettingsPageInput(state, snapshot, { type: 'save-default' })
    expect(saved.outcome).toMatchObject({ requests: [
      { namespace: 'provider', changes: [{ operation: 'set', path: ['key'], value: 'secret' }] },
      { namespace: 'ui', changes: [{ operation: 'unset', path: ['name'] }] },
    ] })
  })

  it('settles successful namespaces independently and never overwrites failed drafts with a new snapshot', () => {
    const snapshot = fixture()
    let state = key(createSettingsPageState(), snapshot, { type: 'move-right' })
    state = key({ ...state, section: 'plugins', selection: 0 }, snapshot, { type: 'submit' })
    state = key(state, snapshot, { type: 'save-default' })
    state = settleSettingsPageSave(state, snapshot, [{ namespace: 'ui' }, { namespace: 'plugins', error: 'Disk full' }])
    expect(Object.keys(state.drafts)).toEqual(['plugin'])
    expect(state.error).toContain('Disk full')
    expect(state.notice).toContain('保存')
    const second = key(state, snapshot, { type: 'save-default' })
    state = settleSettingsPageSave(second, snapshot, [{ namespace: 'plugins' }])
    expect(state.drafts).toEqual({})
    expect(state.notice).toContain('重启')
    expect(state.error).toBeUndefined()
    expect(settleSettingsPageSave(state, snapshot, [{ namespace: 'plugins', error: 'late result' }])).toBe(state)
  })

  it('cancels an edit, clears search, and confirms unsaved departure without silently saving', () => {
    const snapshot = fixture()
    let state = key(createSettingsPageState(), snapshot, { type: 'move-right' })
    state = key({ ...state, selection: 3 }, snapshot, { type: 'submit' })
    state = key(replaceEditor(state, 'cancel me'), snapshot, { type: 'escape' })
    expect(state.editor).toBeUndefined()
    expect(state.drafts.name).toBeUndefined()
    state = { ...state, focus: 'search' }
    state = type(state, snapshot, 'enabled')
    expect(selectSettingsPage(state, snapshot).fields.map(item => item.id)).toEqual(['enabled'])
    state = key(state, snapshot, { type: 'escape' })
    expect(state.query.text).toBe('')
    state = key(state, snapshot, { type: 'escape' })
    expect(state.confirmation).toBe('discard')
    state = key(state, snapshot, { type: 'escape' })
    expect(state.drafts.theme?.value).toBe('mono')
    state = key({ ...state, focus: 'actions', actionIndex: 1 }, snapshot, { type: 'submit' })
    state = key(state, snapshot, { type: 'move-right' })
    const departure = applySettingsPageInput(state, snapshot, { type: 'submit' })
    expect(departure.outcome).toBeUndefined()
    expect(departure.state.drafts).toEqual({})
  })

  it('cycles all focus areas in both directions and keeps search text as text', () => {
    const snapshot = fixture()
    let state = createSettingsPageState()
    for (const focus of ['actions', 'tabs', 'form']) {
      state = key(state, snapshot, { type: 'complete' })
      expect(state.focus).toBe(focus)
    }
    state = key(state, snapshot, { type: 'complete', reverse: true })
    expect(state.focus).toBe('tabs')
    state = key(state, snapshot, { type: 'move-left' })
    expect(state.section).toBe('presets')
    state = key(state, snapshot, { type: 'move-right' })
    expect(state.section).toBe('general')
    expect(key(state, snapshot, { type: 'ignored' })).toBe(state)
    state = key(state, snapshot, { type: 'submit' })
    state = { ...state, focus: 'search' }
    state = type(state, snapshot, '[name]')
    expect(state.query.text).toBe('[name]')
    expect(selectSettingsPage(state, snapshot).fields).toEqual([])
    state = key(state, snapshot, { type: 'move-home' })
    state = key(state, snapshot, { type: 'delete' })
    state = key(state, snapshot, { type: 'move-end' })
    state = key(state, snapshot, { type: 'backspace' })
    expect(state.query.text).toBe('name')
    state = key(state, snapshot, { type: 'submit' })
    expect(state.focus).toBe('form')
    expect(selectSettingsPage(state, snapshot).fields.map(item => item.id)).toEqual(['name'])
    expect(key(state, snapshot, { type: 'interrupt' })).toBe(state)
  })

  it('bounds navigation and uses typed select or boolean controls without opening a JSON editor', () => {
    const snapshot = fixture()
    let state = createSettingsPageState()
    expect(key(state, snapshot, { type: 'move-up' }).selection).toBe(0)
    state = key(state, snapshot, { type: 'page-down' })
    expect(state.selection).toBe(3)
    expect(key(state, snapshot, { type: 'move-right' })).toBe(state)
    expect(type(state, snapshot, ' ')).toBe(state)
    state = key(state, snapshot, { type: 'page-up' })
    state = key(state, snapshot, { type: 'submit' })
    expect(state.drafts).toEqual({})
    expect(state.picker?.selection).toBe(0)
    state = key(state, snapshot, { type: 'move-down' })
    state = key(state, snapshot, { type: 'submit' })
    expect(state.drafts.theme?.value).toBe('mono')
    state = key(state, snapshot, { type: 'move-left' })
    expect(state.drafts).toEqual({})
    state = type(state, snapshot, ' ')
    expect(state.drafts.theme?.value).toBe('mono')
    expect(state.picker).toBeUndefined()
    state = key(state, snapshot, { type: 'move-left' })
    expect(state.drafts).toEqual({})
    state = key({ ...state, selection: 1 }, snapshot, { type: 'move-right' })
    expect(state.drafts.enabled?.value).toBe(true)
    state = key(state, snapshot, { type: 'move-left' })
    expect(state.drafts).toEqual({})
    expect(state.editor).toBeUndefined()
    expect(key({ ...state, section: 'presets' }, snapshot, { type: 'submit' }).drafts).toEqual({})
    catalog.fields = []
    expect(key(state, snapshot, { type: 'submit' })).toBe(state)
  })

  it('keeps read-only, unavailable and stale catalogs non-writable while still allowing exit', () => {
    const snapshot = fixture()
    const state = createSettingsPageState()
    expect(applySettingsPageInput(state, snapshot, { type: 'escape' }).outcome).toEqual({ kind: 'close' })
    expect(key(state, snapshot, { type: 'save-default' }).notice).toBe('没有需要保存的更改。')
    expect(key({ ...state, focus: 'actions' }, snapshot, { type: 'submit' }).confirmation).toBe('reset')
    for (const unavailable of [{ ...snapshot, available: false }, { ...snapshot, writable: false }, { ...snapshot, stale: true }]) {
      expect(key(state, unavailable, { type: 'move-right' }).drafts).toEqual({})
      expect(key(state, unavailable, { type: 'move-right' }).error).toBeTruthy()
      expect(applySettingsPageInput(state, unavailable, { type: 'save-default' }).outcome).toBeUndefined()
    }
    expect(selectSettingsPage(state, { ...snapshot, error: 'Offline' }).error).toBe('Offline')
    expect(selectSettingsPage(state, { ...snapshot, stale: true }).writable).toBe(false)
  })

  it('edits graphemes in plain strings, cancels invalid multiline input and accepts unrestricted decimals', () => {
    const snapshot = fixture()
    let state = key({ ...createSettingsPageState(), selection: 3 }, snapshot, { type: 'submit' })
    state = key(state, snapshot, { type: 'move-home' })
    state = type(state, snapshot, '🙂')
    state = key(state, snapshot, { type: 'move-right' })
    state = key(state, snapshot, { type: 'move-left' })
    state = key(state, snapshot, { type: 'delete' })
    expect(state.editor?.input.text).toBe('🙂ld')
    state = key(state, snapshot, { type: 'newline' })
    expect(state.editor?.input.text).toBe('🙂ld')
    state = type(state, snapshot, '\n')
    expect(applySettingsPageInput(state, snapshot, { type: 'save-default' }).outcome).toBeUndefined()
    expect(key(state, snapshot, { type: 'submit' }).error).toBe('请输入单行文本。')
    state = key(replaceEditor(state, '{"literal":"text"}'), snapshot, { type: 'submit' })
    expect(state.drafts.name?.value).toBe('{"literal":"text"}')
    catalog.fields[2] = field('limit', 'number', 3)
    state = key({ ...state, selection: 2 }, snapshot, { type: 'submit' })
    state = key(replaceEditor(state, '1.5'), snapshot, { type: 'submit' })
    expect(state.drafts.limit?.value).toBe(1.5)
  })

  it('keeps a namespace revision stable when a second field is edited after refresh', () => {
    const snapshot = fixture()
    let state = key(createSettingsPageState(), snapshot, { type: 'move-right' })
    const newer = { ...snapshot, namespaces: snapshot.namespaces.map(ns => ({ ...ns, revision: 9 })) }
    state = key({ ...state, selection: 1 }, newer, { type: 'submit' })
    expect(Object.values(state.drafts).map(draft => draft.expectedRevision)).toEqual([7, 7])
    state = key(state, newer, { type: 'save-default' })
    const missing = settleSettingsPageSave(state, newer, [])
    expect(missing.drafts).toEqual(state.drafts)
    expect(missing.error).toContain('未保存')
    state = settleSettingsPageSave(state, newer, [{ namespace: 'ui' }])
    expect(state.notice).toBe('设置已保存。')
    expect(state.drafts).toEqual({})
  })

  it('reopens a staged secret, unsets only its override, and makes confirmation safe by default', () => {
    const snapshot = fixture()
    let state = key({ ...createSettingsPageState(), section: 'models' }, snapshot, { type: 'submit' })
    state = key(replaceEditor(state, 'replacement'), snapshot, { type: 'submit' })
    state = key(state, snapshot, { type: 'submit' })
    expect(state.editor?.input.text).toBe('replacement')
    state = key(state, snapshot, { type: 'escape' })
    state = { ...state, focus: 'actions' }
    state = key(state, snapshot, { type: 'move-down' })
    state = key(state, snapshot, { type: 'move-right' })
    expect(state.actionIndex).toBe(1)
    expect(key(state, snapshot, { type: 'ignored' })).toBe(state)
    state = key(state, snapshot, { type: 'move-left' })
    expect(state.actionIndex).toBe(0)
    state = key(state, snapshot, { type: 'move-right' })
    state = key(state, snapshot, { type: 'submit' })
    expect(key(state, snapshot, { type: 'ignored' })).toBe(state)
    state = key(state, snapshot, { type: 'move-right' })
    state = key(state, snapshot, { type: 'move-left' })
    expect(state.confirmIndex).toBe(0)
    state = { ...state, confirmation: 'reset', confirmIndex: 1 }
    state = key(state, snapshot, { type: 'submit' })
    expect(selectSettingsPage(state, snapshot).fields[0]).toMatchObject({ secretSet: undefined, value: undefined, inheritedValue: undefined })
    expect(state.drafts.key?.operation).toBe('unset')
    catalog.fields[4] = { ...catalog.fields[4]!, secretSet: false }
    expect(selectSettingsPage({ ...state, drafts: {} }, snapshot).fields[0]?.secretSet).toBe(false)
  })

  it('preserves drafts if write access disappears before reset confirmation', () => {
    const snapshot = fixture()
    let state = key(createSettingsPageState(), snapshot, { type: 'move-right' })
    state = { ...state, confirmation: 'reset', confirmIndex: 0 }
    state = key(state, snapshot, { type: 'move-right' })
    for (const unavailable of [{ ...snapshot, available: false }, { ...snapshot, writable: false }, { ...snapshot, stale: true }]) {
      const attempted = key(state, unavailable, { type: 'submit' })
      expect(attempted.drafts).toEqual(state.drafts)
      expect(attempted.error).toBe('当前设置不可写。')
    }
  })

  it('turns the real nested schema catalog selection into an exact official mutation path', async () => {
    const { buildSettingsFields } = await vi.importActual<typeof import('../src/settings/page-catalog.ts')>('../src/settings/page-catalog.ts')
    const snapshot: SettingsCatalogSnapshot = {
      available: true, writable: true, documentBacked: true, generation: 3,
      namespaces: [{ namespace: 'dsh-tui', revision: 11, applies: 'live', secrets: [],
        schema: { type: 'object', dict: { theme: { type: 'object', dict: { preset: {
          type: 'union', list: [{ type: 'const', value: 'auto' }, { type: 'const', value: 'mono' }],
        } } } } }, value: { theme: { preset: 'auto' } }, base: { theme: { preset: 'auto' } }, user: {},
      }],
    }
    catalog.fields = [...buildSettingsFields(snapshot)]
    let state = key(createSettingsPageState(), snapshot, { type: 'move-right' })
    expect(selectSettingsPage(state, snapshot).fields[0]).toMatchObject({ label: '主题', value: 'mono' })
    const result = applySettingsPageInput(state, snapshot, { type: 'save-default' })
    expect(result.outcome).toEqual({ kind: 'save', requests: [{ operation: 'batch', namespace: 'dsh-tui', path: [], expectedRevision: 11,
      changes: [{ operation: 'set', path: ['theme', 'preset'], value: 'mono' }],
    }] })
    state = settleSettingsPageSave(result.state, snapshot, [{ namespace: 'dsh-tui' }])
    expect(state.drafts).toEqual({})
  })

  it('leaves a secret unchanged when its blank editor is confirmed, including an existing draft', () => {
    const snapshot = fixture()
    let state = key({ ...createSettingsPageState(), section: 'models' }, snapshot, { type: 'submit' })
    expect(state.editor?.input.text).toBe('')
    const unchanged = applySettingsPageInput(state, snapshot, { type: 'save-default' })
    expect(unchanged.outcome).toBeUndefined()
    expect(unchanged.state.drafts).toEqual({})
    expect(selectSettingsPage(unchanged.state, snapshot).fields[0]?.secretSet).toBe(true)
    state = key(replaceEditor(state, 'replacement'), snapshot, { type: 'submit' })
    state = key(state, snapshot, { type: 'submit' })
    state = key(replaceEditor(state, ''), snapshot, { type: 'submit' })
    expect(state.drafts.key?.value).toBe('replacement')
    expect(state.editor).toBeUndefined()
  })

  it('requires explicit confirmation before saving a full-access default and keeps all drafts on cancellation', () => {
    const initial = fixture()
    catalog.fields.push(field('defaultPermission', 'select', 'read-only', {
      namespace: 'permission', path: ['defaultPreset'], options: [
        { label: 'Read only', value: 'read-only' }, { label: 'Full access', value: 'danger-full-access' },
      ],
    }))
    const snapshot = { ...initial, namespaces: [...initial.namespaces, { namespace: 'permission', revision: 2, schema: {}, value: {}, secrets: [], applies: 'live' as const }] }
    let state = key(createSettingsPageState(), snapshot, { type: 'move-right' })
    state = key({ ...state, selection: 4 }, snapshot, { type: 'move-right' })
    const requested = applySettingsPageInput(state, snapshot, { type: 'save-default' })
    expect(requested.outcome).toBeUndefined()
    expect(requested.state.confirmation).toBe('permission')
    expect(requested.state.confirmIndex).toBe(0)
    expect(key(requested.state, snapshot, { type: 'submit' }).drafts).toEqual(state.drafts)
    expect(key(requested.state, snapshot, { type: 'escape' }).drafts).toEqual(state.drafts)
    state = key(requested.state, snapshot, { type: 'move-right' })
    const confirmed = applySettingsPageInput(state, snapshot, { type: 'submit' })
    expect(confirmed.outcome).toMatchObject({ kind: 'save', requests: [
      { namespace: 'ui', changes: [{ value: 'mono' }] },
      { namespace: 'permission', expectedRevision: 2, changes: [{ path: ['defaultPreset'], value: 'danger-full-access' }] },
    ] })
    expect(confirmed.state.pending).toBe(true)
  })

  it('confirms full access inherited by reset and rechecks stale state before writing', () => {
    const initial = fixture()
    catalog.fields.push(field('defaultPermission', 'select', 'read-only', {
      namespace: 'permission', path: ['defaultPreset'], overridden: true, inheritedValue: 'danger-full-access',
      options: [{ label: 'Read only', value: 'read-only' }, { label: 'Full access', value: 'danger-full-access' }],
    }))
    const snapshot = { ...initial, namespaces: [...initial.namespaces, { namespace: 'permission', revision: 2, schema: {}, value: {}, secrets: [], applies: 'live' as const }] }
    let state = key({ ...createSettingsPageState(), focus: 'actions', actionIndex: 2 }, snapshot, { type: 'submit' })
    state = key(state, snapshot, { type: 'move-right' })
    state = key(state, snapshot, { type: 'submit' })
    state = key(state, snapshot, { type: 'save-default' })
    expect(state.confirmation).toBe('permission')
    state = key(state, snapshot, { type: 'move-right' })
    const rejected = applySettingsPageInput(state, { ...snapshot, stale: true }, { type: 'submit' })
    expect(rejected.outcome).toBeUndefined()
    expect(rejected.state.drafts).toEqual(state.drafts)
    expect(rejected.state.error).toContain('已过期')
    const confirmed = applySettingsPageInput(state, snapshot, { type: 'submit' })
    expect(confirmed.outcome).toMatchObject({ requests: [
      { namespace: 'ui', changes: [{ operation: 'unset', path: ['name'] }] },
      { namespace: 'permission', changes: [{ operation: 'unset', path: ['defaultPreset'] }] },
    ] })
  })

  it('unsets an advertised secret without reading its redacted user value or claiming an inherited secret is gone', async () => {
    const { buildSettingsFields } = await vi.importActual<typeof import('../src/settings/page-catalog.ts')>('../src/settings/page-catalog.ts')
    const snapshot: SettingsCatalogSnapshot = {
      available: true, writable: true, documentBacked: true, generation: 1,
      namespaces: [{ namespace: 'llm-example', schema: { type: 'object', dict: { apiKey: { type: 'string', meta: { role: 'secret' } } } },
        value: {}, base: {}, user: {}, revision: 9, applies: 'live', secrets: [{ path: ['apiKey'], set: true }],
      }],
    }
    catalog.fields = [...buildSettingsFields(snapshot)]
    expect(catalog.fields[0]).toMatchObject({ overridden: false, secretSet: true, value: undefined })
    let state = key({ ...createSettingsPageState(), section: 'models', focus: 'actions', actionIndex: 2 }, snapshot, { type: 'submit' })
    state = key(state, snapshot, { type: 'move-right' })
    state = key(state, snapshot, { type: 'submit' })
    expect(Object.values(state.drafts)).toMatchObject([{ operation: 'unset', expectedRevision: 9, field: { path: ['apiKey'] } }])
    expect(selectSettingsPage(state, snapshot).fields[0]?.secretSet).toBeUndefined()
    const saved = applySettingsPageInput(state, snapshot, { type: 'save-default' })
    expect(saved.outcome).toEqual({ kind: 'save', requests: [{ namespace: 'llm-example', path: [], expectedRevision: 9, operation: 'batch',
      changes: [{ operation: 'unset', path: ['apiKey'] }],
    }] })
    state = settleSettingsPageSave(saved.state, snapshot, [{ namespace: 'llm-example' }])
    expect(selectSettingsPage(state, snapshot).fields[0]?.secretSet).toBe(true)
    catalog.fields = [{ ...catalog.fields[0]!, secretSet: false }]
    state = { ...state, confirmation: 'reset', confirmIndex: 0 }
    state = key(state, snapshot, { type: 'move-right' })
    state = key(state, snapshot, { type: 'submit' })
    expect(state.drafts).toEqual({})
  })
})
