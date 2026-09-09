import type { SettingsCatalogSnapshot, SettingsMutationRequest } from './port.ts'
import type { SettingsDraft, SettingsField, SettingsPageFocus, SettingsPageState, SettingsPageTransition, SettingsPageView, SettingsSaveResult, SettingsSection } from './page-contracts.ts'
import type { TerminalInputAction } from '../terminal/input.ts'
import { createPromptEditorState, reducePromptEditor, type PromptEditorState } from '../ui/prompt-editor.ts'
import { buildSettingsFields } from './page-catalog.ts'

const sections: readonly SettingsSection[] = ['general', 'models', 'plugins', 'presets']
const focuses: readonly SettingsPageFocus[] = ['tabs', 'form', 'actions']

function clean(state: SettingsPageState): SettingsPageState {
  const { error: _error, notice: _notice, ...rest } = state
  return rest
}

function redacted(state: SettingsPageState, text: string): string {
  for (const draft of Object.values(state.drafts)) {
    if (draft.field.control === 'secret' && typeof draft.value === 'string' && draft.value !== '') {
      text = text.split(draft.value).join('[redacted]')
    }
  }
  return text
}

function projectedField(field: SettingsField, draft?: SettingsDraft): SettingsField {
  const projected = draft === undefined ? field : {
    ...draft.field,
    value: draft.operation === 'unset' ? draft.field.inheritedValue : draft.value,
    overridden: draft.operation === 'set',
  }
  return projected.control === 'secret'
    ? { ...projected, value: undefined, inheritedValue: undefined,
      secretSet: draft === undefined ? field.secretSet === true : draft.operation === 'set' ? true : undefined }
    : projected
}

function revisionFor(state: SettingsPageState, snapshot: SettingsCatalogSnapshot, field: SettingsField): number {
  return Object.values(state.drafts).find(draft => draft.field.namespace === field.namespace)?.expectedRevision
    ?? snapshot.namespaces.find(namespace => namespace.namespace === field.namespace)!.revision
}

function stage(state: SettingsPageState, field: SettingsField, expectedRevision: number, value: unknown): SettingsPageState {
  const original = state.drafts[field.id]?.field ?? field
  const drafts = { ...state.drafts }
  if (field.control !== 'secret' && Object.is(value, original.value)) delete drafts[field.id]
  else drafts[field.id] = { field: original, expectedRevision, operation: 'set', value }
  return { ...clean(state), drafts }
}

function editInput(input: PromptEditorState, action: TerminalInputAction): PromptEditorState {
  switch (action.type) {
    case 'insert': case 'backspace': case 'delete': case 'move-left': case 'move-right': case 'move-home': case 'move-end':
      return reducePromptEditor(input, action)
    default: return input
  }
}

function acceptEditor(state: SettingsPageState): SettingsPageState {
  const { editor, ...rest } = state
  const { field, input, expectedRevision } = editor!
  if (field.control === 'secret' && input.text === '') return clean(rest)
  let value: unknown = input.text
  let error: string | undefined
  if (field.control === 'number') {
    const number = Number(input.text.trim())
    if (input.text.trim() === '' || !Number.isFinite(number)) error = '请输入有限数字。'
    else if (field.integer === true && !Number.isInteger(number)) error = '请输入整数。'
    else if (field.minimum !== undefined && number < field.minimum) error = `最小值为 ${field.minimum}。`
    else if (field.maximum !== undefined && number > field.maximum) error = `最大值为 ${field.maximum}。`
    value = number
  } else if (/[\r\n]/u.test(input.text)) error = '请输入单行文本。'
  if (error !== undefined) return { ...state, error }
  return stage(rest, field, expectedRevision, value)
}

function leave(state: SettingsPageState): SettingsPageTransition {
  return Object.keys(state.drafts).length === 0
    ? { state: createSettingsPageState(), outcome: { kind: 'close' } }
    : { state: { ...clean(state), confirmation: 'discard', confirmIndex: 0 } }
}

function save(state: SettingsPageState, snapshot: SettingsCatalogSnapshot, permissionConfirmed = false): SettingsPageTransition {
  if (!snapshot.available || !snapshot.writable || snapshot.stale === true) {
    return { state: { ...state, error: snapshot.stale === true ? '设置已过期，请刷新后再保存。' : '当前设置不可写。' } }
  }
  const drafts = Object.values(state.drafts)
  if (drafts.length === 0) return { state: { ...clean(state), notice: '没有需要保存的更改。' } }
  if (!permissionConfirmed && drafts.some(draft => draft.field.namespace === 'permission'
    && draft.field.path.join('.') === 'defaultPreset'
    && (draft.operation === 'unset' ? draft.field.inheritedValue : draft.value) === 'danger-full-access')) {
    return { state: { ...clean(state), confirmation: 'permission', confirmIndex: 0 } }
  }
  const groups = new Map<string, SettingsDraft[]>()
  for (const draft of drafts) {
    const group = groups.get(draft.field.namespace) ?? []
    group.push(draft)
    groups.set(draft.field.namespace, group)
  }
  const requests: SettingsMutationRequest[] = Array.from(groups, ([namespace, group]) => ({
    namespace, path: [], expectedRevision: group[0]!.expectedRevision, operation: 'batch',
    changes: group.map(draft => draft.operation === 'unset'
      ? { operation: 'unset', path: draft.field.path }
      : { operation: 'set', path: draft.field.path, value: draft.value }),
  }))
  return { state: { ...clean(state), pending: true, notice: '正在保存设置…' }, outcome: { kind: 'save', requests } }
}

function resetCategory(state: SettingsPageState, snapshot: SettingsCatalogSnapshot): SettingsPageState {
  if (!snapshot.available || !snapshot.writable || snapshot.stale === true) return { ...state, error: '当前设置不可写。' }
  const drafts = Object.fromEntries(Object.entries(state.drafts).filter(([, draft]) => draft.field.section !== state.section))
  for (const field of buildSettingsFields(snapshot)) {
    if (field.section === state.section && field.control !== 'readonly'
      && (field.overridden || (field.control === 'secret' && field.secretSet === true))) {
      drafts[field.id] = { field, expectedRevision: revisionFor(state, snapshot, field), operation: 'unset' }
    }
  }
  return { ...clean(state), drafts, notice: '已暂存恢复继承默认值；按 Ctrl+S 保存。' }
}

function direction(action: TerminalInputAction): number {
  if (action.type === 'move-left' || action.type === 'move-up') return -1
  if (action.type === 'move-right' || action.type === 'move-down') return 1
  return 0
}

function switchSection(state: SettingsPageState, delta: number): SettingsPageState {
  const section = sections[(sections.indexOf(state.section) + delta + sections.length) % sections.length]!
  return { ...clean(state), section, selection: 0, query: createPromptEditorState() }
}

export function createSettingsPageState(): SettingsPageState {
  return { section: 'general', focus: 'form', selection: 0, actionIndex: 0, query: createPromptEditorState(), drafts: {}, confirmIndex: 0, pending: false }
}
export function selectSettingsPage(state: SettingsPageState, snapshot: SettingsCatalogSnapshot): SettingsPageView {
  const { drafts, editor, picker, error, ...rest } = state
  const query = state.query.text.trim().toLocaleLowerCase()
  const fields = buildSettingsFields(snapshot)
    .filter(field => field.section === state.section && `${field.label} ${field.description} ${field.group}`.toLocaleLowerCase().includes(query))
    .map(field => projectedField(field, drafts[field.id]))
  const dirtyIds = Object.keys(drafts)
  return {
    ...rest, fields, selection: Math.min(state.selection, Math.max(0, fields.length - 1)), dirtyIds, dirtyCount: dirtyIds.length,
    available: snapshot.available, writable: snapshot.writable && snapshot.stale !== true, documentBacked: snapshot.documentBacked,
    ...(editor === undefined ? {} : { editor: { field: projectedField(editor.field), input: editor.input } }),
    ...(picker === undefined ? {} : { picker: { field: projectedField(picker.field, drafts[picker.fieldId]), selection: picker.selection } }),
    ...(error === undefined && snapshot.error === undefined ? {} : { error: redacted(state, error ?? snapshot.error!) }),
  }
}
export function applySettingsPageInput(state: SettingsPageState, snapshot: SettingsCatalogSnapshot, action: TerminalInputAction): SettingsPageTransition {
  if (state.pending) return { state }
  const quit = action.type === 'insert' && action.paste !== true && action.text === 'q'
  if (state.confirmation !== undefined) {
    const { confirmation, ...rest } = state
    if (action.type === 'escape' || quit || (action.type === 'submit' && state.confirmIndex === 0)) return { state: rest }
    if (action.type === 'submit') {
      if (confirmation === 'permission') return save(rest, snapshot, true)
      return confirmation === 'discard'
        ? { state: { ...clean(rest), drafts: {}, focus: 'form', actionIndex: 0, notice: '已放弃更改。' } }
        : { state: resetCategory(rest, snapshot) }
    }
    if (direction(action) !== 0) return { state: { ...state, confirmIndex: direction(action) > 0 ? 1 : 0 } }
    return { state }
  }
  if (state.picker !== undefined) {
    const { picker, ...rest } = state
    if (action.type === 'escape' || quit) return { state: clean(rest) }
    if (action.type === 'move-up' || action.type === 'move-down') {
      const count = picker.field.options!.length
      return { state: { ...clean(state), picker: { ...picker, selection: (picker.selection + direction(action) + count) % count } } }
    }
    if (action.type === 'submit') {
      if (!snapshot.available || !snapshot.writable || snapshot.stale === true) return { state: { ...state, error: '当前设置不可写。' } }
      return { state: stage(rest, picker.field, picker.expectedRevision, picker.field.options![picker.selection]!.value) }
    }
    return { state }
  }
  if (state.editor !== undefined) {
    if (action.type === 'escape') {
      const { editor: _editor, ...rest } = clean(state)
      return { state: rest }
    }
    if (action.type === 'submit' || action.type === 'save-default') {
      const accepted = acceptEditor(state)
      return action.type === 'save-default' && accepted.editor === undefined ? save(accepted, snapshot) : { state: accepted }
    }
    return { state: { ...clean(state), editor: { ...state.editor, input: editInput(state.editor.input, action) } } }
  }
  if (action.type === 'save-default') return save(state, snapshot)
  if (action.type === 'escape') {
    if (state.query.text !== '') return { state: { ...clean(state), query: createPromptEditorState(), focus: 'form', selection: 0 } }
    return leave(state)
  }
  if (action.type === 'complete') return { state: { ...state, focus: focuses[(focuses.indexOf(state.focus) + (action.reverse === true ? 2 : 1)) % 3]! } }
  if (state.focus === 'search') {
    return { state: action.type === 'submit' ? { ...state, focus: 'form', selection: 0 }
      : { ...clean(state), query: editInput(state.query, action), selection: 0 } }
  }
  if (quit) return leave(state)
  if (action.type === 'insert' && (action.text === '[' || action.text === ']')) return { state: switchSection(state, action.text === ']' ? 1 : -1) }
  if (state.focus === 'tabs') {
    if (direction(action) !== 0) return { state: switchSection(state, direction(action)) }
    return { state: action.type === 'submit' ? { ...state, focus: 'form' } : state }
  }
  if (state.focus === 'actions') {
    const dirty = Object.keys(state.drafts).length > 0
    if (direction(action) !== 0) return { state: { ...state, actionIndex: Math.min(dirty ? 1 : 0, Math.max(0, state.actionIndex + direction(action))) } }
    if (action.type !== 'submit') return { state }
    if (dirty && state.actionIndex === 0) return save(state, snapshot)
    if (dirty) return { state: { ...clean(state), confirmation: 'discard', confirmIndex: 0 } }
    return { state: { ...clean(state), confirmation: 'reset', confirmIndex: 0 } }
  }
  const view = selectSettingsPage(state, snapshot)
  if (action.type === 'move-up' || action.type === 'move-down' || action.type === 'page-up' || action.type === 'page-down') {
    const delta = action.type === 'page-up' ? -5 : action.type === 'page-down' ? 5 : direction(action)
    return { state: { ...state, selection: Math.max(0, Math.min(view.fields.length - 1, view.selection + delta)) } }
  }
  const field = view.fields[view.selection]
  if (field === undefined || field.control === 'readonly') return { state }
  const activate = action.type === 'submit' || (action.type === 'insert' && action.text === ' ')
  const horizontal = action.type === 'move-left' || action.type === 'move-right'
  if (!activate && !horizontal) return { state }
  if (!snapshot.available || !view.writable) return { state: { ...state, error: '当前设置不可写。' } }
  const revision = revisionFor(state, snapshot, field)
  if (field.control === 'boolean') return { state: stage(state, field, revision, horizontal ? direction(action) > 0 : field.value !== true) }
  if (field.control === 'select') {
    const options = field.options!
    const current = options.findIndex(option => Object.is(option.value, field.value))
    if (action.type === 'submit') return { state: { ...clean(state), picker: {
      fieldId: field.id, field: state.drafts[field.id]?.field ?? field, expectedRevision: revision, selection: Math.max(0, current),
    } } }
    const next = Math.max(0, Math.min(options.length - 1, current + (horizontal ? direction(action) : 1)))
    return { state: stage(state, field, revision, options[next]!.value) }
  }
  if (!activate || action.type !== 'submit') return { state }
  const value = state.drafts[field.id]?.value ?? field.value
  return { state: { ...clean(state), editor: {
    fieldId: field.id, field: state.drafts[field.id]?.field ?? field, expectedRevision: revision,
    input: createPromptEditorState(value === undefined ? '' : String(value)),
  } } }
}
export function settleSettingsPageSave(state: SettingsPageState, _snapshot: SettingsCatalogSnapshot, results: readonly SettingsSaveResult[]): SettingsPageState {
  if (!state.pending) return state
  const succeeded = new Set(results.filter(result => result.error === undefined).map(result => result.namespace))
  const drafts = Object.fromEntries(Object.entries(state.drafts).filter(([, draft]) => !succeeded.has(draft.field.namespace)))
  const errors = results.filter(result => result.error !== undefined).map(result => `${result.namespace}: ${result.error}`)
  const needsRestart = Object.values(state.drafts).some(draft => succeeded.has(draft.field.namespace) && draft.field.applies === 'restart')
  return {
    ...clean(state), pending: false, drafts, actionIndex: 0,
    notice: Object.keys(drafts).length > 0 ? '部分设置未保存，草稿已保留。' : needsRestart ? '设置已保存，部分更改需重启后生效。' : '设置已保存。',
    ...(errors.length > 0 ? { error: redacted(state, errors.join('\n')) }
      : Object.keys(drafts).length > 0 ? { error: '设置未保存，请重试或取消；草稿已保留。' } : {}),
  }
}

/** Overlay scalar drafts for the provider editor without committing the document. */
export function projectSettingsDrafts(state: SettingsPageState | undefined, snapshot: SettingsCatalogSnapshot): SettingsCatalogSnapshot {
  if (!state || Object.keys(state.drafts).length === 0) return snapshot
  const namespaces = snapshot.namespaces.map(namespace => {
    const drafts = Object.values(state.drafts).filter(draft => draft.field.namespace === namespace.namespace && draft.field.control !== 'secret')
    if (!drafts.length) return namespace
    const value = structuredClone(namespace.value) as Record<string, unknown>
    for (const draft of drafts) {
      let target = value
      const path = draft.field.path
      for (const key of path.slice(0, -1)) {
        if (!target[key] || typeof target[key] !== 'object') target[key] = {}
        target = target[key] as Record<string, unknown>
      }
      const key = path.at(-1)!
      if (draft.operation === 'unset' && draft.field.inheritedValue === undefined) delete target[key]
      else target[key] = draft.operation === 'unset' ? draft.field.inheritedValue : draft.value
    }
    return { ...namespace, value }
  })
  return { ...snapshot, namespaces }
}

/** Provider basic/default edits join the same transaction as every other setting. */
export function stageSettingsMutation(state: SettingsPageState, snapshot: SettingsCatalogSnapshot, request: SettingsMutationRequest): SettingsPageState | undefined {
  const changes = request.operation === 'batch' ? request.changes : [request]
  const fields = buildSettingsFields(snapshot)
  const matched = changes.map(change => fields.find(field => field.namespace === request.namespace && JSON.stringify(field.path) === JSON.stringify(change.path)))
  if (matched.some(field => !field || field.control === 'readonly' || field.control === 'secret')) return undefined
  let next = state
  for (const [index, change] of changes.entries()) {
    const field = matched[index]!
    const expectedRevision = Object.values(next.drafts).find(draft => draft.field.namespace === request.namespace)?.expectedRevision ?? request.expectedRevision
    if (change.operation === 'set') next = stage(next, field, expectedRevision, change.value)
    else {
      const original = next.drafts[field.id]?.field ?? field
      next = { ...clean(next), drafts: { ...next.drafts, [field.id]: { field: original, expectedRevision, operation: 'unset' } } }
    }
  }
  return { ...next, notice: '更改尚未保存。' }
}
