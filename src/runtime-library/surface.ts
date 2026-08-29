import type {
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from '../plugin-inventory/port.ts'
import type {
  SettingsCatalogSnapshot,
  SettingsMutationRequest,
  SettingsNamespaceSnapshot,
} from '../settings/port.ts'
import {
  createPromptEditorState,
  reducePromptEditor,
  type PromptEditorAction,
  type PromptEditorState,
} from '../ui/prompt-editor.ts'

export type RuntimeLibraryTab = 'settings' | 'plugins'
export type RuntimeLibraryFocus = 'catalog' | 'detail' | 'editor'
export type RuntimeSettingSource = 'user' | 'base' | 'default' | 'secret'

export interface RuntimeSettingFieldView {
  readonly path: readonly string[]
  readonly pathLabel: string
  readonly value: unknown
  readonly source: RuntimeSettingSource
  readonly secretSet?: boolean
  readonly selected: boolean
}

export interface RuntimeSettingsRowView {
  readonly namespace: string
  readonly applies: 'live' | 'restart'
  readonly revision: number
  readonly overrideCount: number
  readonly secretCount: number
  readonly selected: boolean
}

export interface RuntimeSettingsSelectionView extends RuntimeSettingsRowView {
  readonly fields: readonly RuntimeSettingFieldView[]
  readonly selectedFieldIndex: number
}

export interface RuntimePluginRowView extends PluginInventoryEntry {
  readonly selected: boolean
}

export interface RuntimeLibraryEditorView {
  readonly namespace: string
  readonly path: readonly string[]
  readonly secret: boolean
  readonly input: PromptEditorState
}

export interface RuntimeLibraryView {
  readonly tab: RuntimeLibraryTab
  readonly focus: RuntimeLibraryFocus
  readonly query: PromptEditorState
  readonly pending: boolean
  readonly settings: {
    readonly available: boolean
    readonly writable: boolean
    readonly documentBacked: boolean
    readonly generation: number
    readonly stale: boolean
    readonly rows: readonly RuntimeSettingsRowView[]
    readonly totalCount: number
    readonly selected?: RuntimeSettingsSelectionView
    readonly error?: string
  }
  readonly plugins: {
    readonly available: boolean
    readonly rows: readonly RuntimePluginRowView[]
    readonly totalCount: number
    readonly activeCount: number
    readonly failedCount: number
    readonly selected?: RuntimePluginRowView
    readonly error?: string
  }
  readonly editor?: RuntimeLibraryEditorView
  readonly notice?: string
  readonly error?: string
}

interface RuntimeLibraryPendingIntent {
  readonly operation: 'set' | 'unset'
  readonly pathLabel: string
}

export interface RuntimeLibraryState {
  readonly open: boolean
  readonly tab: RuntimeLibraryTab
  readonly focus: RuntimeLibraryFocus
  readonly query: PromptEditorState
  readonly settings: SettingsCatalogSnapshot
  readonly plugins: PluginInventorySnapshot
  readonly settingsSelection: string | undefined
  readonly pluginSelection: string | undefined
  readonly fieldSelection: string | undefined
  readonly editor: RuntimeLibraryEditorView | undefined
  readonly pending: boolean
  readonly pendingIntent: RuntimeLibraryPendingIntent | undefined
  readonly notice: string | undefined
  readonly error: string | undefined
}

export type RuntimeLibraryAction =
  | { readonly type: 'move-up' | 'move-down' }
  | { readonly type: 'switch-tab' }
  | { readonly type: 'enter' }
  | { readonly type: 'escape' }
  | { readonly type: 'inherit' }
  | { readonly type: 'edit'; readonly action: PromptEditorAction }

export type RuntimeLibraryOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refresh-plugins' }
  | { readonly kind: 'mutate'; readonly request: SettingsMutationRequest }

export interface RuntimeLibraryTransition {
  readonly state: RuntimeLibraryState
  readonly outcome?: RuntimeLibraryOutcome
}

const EMPTY_SETTINGS: SettingsCatalogSnapshot = Object.freeze({
  available: false,
  writable: false,
  documentBacked: false,
  generation: 0,
  namespaces: Object.freeze([]),
})

const EMPTY_PLUGINS: PluginInventorySnapshot = Object.freeze({
  available: false,
  entries: Object.freeze([]),
})

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasAt(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return value !== undefined
  let current = value
  for (const part of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return false
    current = current[part]
  }
  return true
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const part of path) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path)
}

function pathLabel(path: readonly string[]): string {
  return path.length === 0 ? '$' : path.join('.')
}

function collectLeafPaths(value: unknown, prefix: readonly string[], out: Map<string, readonly string[]>): void {
  if (isRecord(value) && Object.keys(value).length > 0) {
    for (const key of Object.keys(value).sort()) {
      collectLeafPaths(value[key], [...prefix, key], out)
    }
    return
  }
  out.set(pathKey(prefix), Object.freeze([...prefix]))
}

function fieldsOf(namespace: SettingsNamespaceSnapshot): readonly Omit<RuntimeSettingFieldView, 'selected'>[] {
  const paths = new Map<string, readonly string[]>()
  collectLeafPaths(namespace.value, [], paths)
  if (namespace.base !== undefined) collectLeafPaths(namespace.base, [], paths)
  if (namespace.user !== undefined) collectLeafPaths(namespace.user, [], paths)
  const secretByPath = new Map(namespace.secrets.map(secret => [pathKey(secret.path), secret]))
  for (const secret of namespace.secrets) {
    paths.set(pathKey(secret.path), Object.freeze([...secret.path]))
  }
  return Object.freeze([...paths.values()]
    .sort((left, right) => pathLabel(left).localeCompare(pathLabel(right)))
    .map(path => {
      const secret = secretByPath.get(pathKey(path))
      if (secret !== undefined) {
        return Object.freeze({
          path,
          pathLabel: pathLabel(path),
          value: undefined,
          source: 'secret' as const,
          secretSet: secret.set,
        })
      }
      const source: RuntimeSettingSource = hasAt(namespace.user, path)
        ? 'user'
        : hasAt(namespace.base, path) ? 'base' : 'default'
      return Object.freeze({
        path,
        pathLabel: pathLabel(path),
        value: valueAt(namespace.value, path),
        source,
      })
    }))
}

function normalizedQuery(query: PromptEditorState): string {
  return query.text.trim().toLocaleLowerCase()
}

function matchingNamespaces(state: RuntimeLibraryState): readonly SettingsNamespaceSnapshot[] {
  const query = normalizedQuery(state.query)
  if (query === '') return state.settings.namespaces
  return state.settings.namespaces.filter(namespace => (
    namespace.namespace.toLocaleLowerCase().includes(query)
  ))
}

function matchingPlugins(state: RuntimeLibraryState): readonly PluginInventoryEntry[] {
  const query = normalizedQuery(state.query)
  if (query === '') return state.plugins.entries
  return state.plugins.entries.filter(entry => (
    entry.entryId.toLocaleLowerCase().includes(query)
    || entry.moduleName.toLocaleLowerCase().includes(query)
    || (entry.fiberPhase ?? 'detached').includes(query)
  ))
}

function selectedNamespace(state: RuntimeLibraryState): SettingsNamespaceSnapshot | undefined {
  const rows = matchingNamespaces(state)
  return rows.find(row => row.namespace === state.settingsSelection) ?? rows[0]
}

function selectedPlugin(state: RuntimeLibraryState): PluginInventoryEntry | undefined {
  const rows = matchingPlugins(state)
  return rows.find(row => row.entryId === state.pluginSelection) ?? rows[0]
}

function selectedField(state: RuntimeLibraryState): Omit<RuntimeSettingFieldView, 'selected'> | undefined {
  const namespace = selectedNamespace(state)
  if (namespace === undefined) return undefined
  const fields = fieldsOf(namespace)
  return fields.find(field => pathKey(field.path) === state.fieldSelection) ?? fields[0]
}

function normalizeSelections(state: RuntimeLibraryState): RuntimeLibraryState {
  const namespace = selectedNamespace(state)
  const plugin = selectedPlugin(state)
  const fields = namespace === undefined ? [] : fieldsOf(namespace)
  const field = fields.find(item => pathKey(item.path) === state.fieldSelection) ?? fields[0]
  return {
    ...state,
    ...(namespace === undefined
      ? { settingsSelection: undefined, fieldSelection: undefined }
      : {
          settingsSelection: namespace.namespace,
          // fieldsOf() always contributes at least the effective root value.
          fieldSelection: pathKey(field!.path),
        }),
    ...(plugin === undefined
      ? { pluginSelection: undefined }
      : { pluginSelection: plugin.entryId }),
  }
}

export function createRuntimeLibraryState(): RuntimeLibraryState {
  return {
    open: false,
    tab: 'settings',
    focus: 'catalog',
    query: createPromptEditorState(),
    settings: EMPTY_SETTINGS,
    plugins: EMPTY_PLUGINS,
    settingsSelection: undefined,
    pluginSelection: undefined,
    fieldSelection: undefined,
    editor: undefined,
    pending: false,
    pendingIntent: undefined,
    notice: undefined,
    error: undefined,
  }
}

export function openRuntimeLibrary(
  state: RuntimeLibraryState,
  settings: SettingsCatalogSnapshot,
  plugins: PluginInventorySnapshot,
): RuntimeLibraryState {
  return normalizeSelections({
    ...state,
    open: true,
    tab: !settings.available && plugins.available ? 'plugins' : state.tab,
    focus: 'catalog',
    query: createPromptEditorState(),
    settings,
    plugins,
    editor: undefined,
    pending: false,
    pendingIntent: undefined,
    notice: undefined,
    error: undefined,
  })
}

export function reconcileRuntimeLibrary(
  state: RuntimeLibraryState,
  settings: SettingsCatalogSnapshot,
  plugins: PluginInventorySnapshot,
): RuntimeLibraryState {
  return normalizeSelections({ ...state, settings, plugins })
}

function moveSelection(state: RuntimeLibraryState, delta: -1 | 1): RuntimeLibraryState {
  if (state.tab === 'plugins') {
    const rows = matchingPlugins(state)
    if (rows.length === 0) return state
    const current = rows.findIndex(row => row.entryId === selectedPlugin(state)?.entryId)
    const index = (Math.max(0, current) + delta + rows.length) % rows.length
    return { ...state, pluginSelection: rows[index]!.entryId, notice: undefined, error: undefined }
  }
  if (state.focus === 'catalog') {
    const rows = matchingNamespaces(state)
    if (rows.length === 0) return state
    const current = rows.findIndex(row => row.namespace === selectedNamespace(state)?.namespace)
    const index = (Math.max(0, current) + delta + rows.length) % rows.length
    const namespace = rows[index]!
    return normalizeSelections({
      ...state,
      settingsSelection: namespace.namespace,
      fieldSelection: undefined,
      notice: undefined,
      error: undefined,
    })
  }
  const namespace = selectedNamespace(state)
  const rows = namespace === undefined ? [] : fieldsOf(namespace)
  if (rows.length === 0) return state
  const currentField = selectedField(state)
  // A non-empty field list guarantees selectedField() can fall back to its first row.
  const currentKey = pathKey(currentField!.path)
  const current = rows.findIndex(row => pathKey(row.path) === currentKey)
  const index = (Math.max(0, current) + delta + rows.length) % rows.length
  return {
    ...state,
    fieldSelection: pathKey(rows[index]!.path),
    notice: undefined,
    error: undefined,
  }
}

function beginMutation(
  state: RuntimeLibraryState,
  request: SettingsMutationRequest,
): RuntimeLibraryTransition {
  return {
    state: {
      ...state,
      focus: 'detail',
      editor: undefined,
      pending: true,
      pendingIntent: {
        operation: request.operation,
        pathLabel: pathLabel(request.path),
      },
      notice: undefined,
      error: undefined,
    },
    outcome: { kind: 'mutate', request },
  }
}

function mutateSelected(state: RuntimeLibraryState, operation: 'set' | 'unset', value?: unknown): RuntimeLibraryTransition {
  const namespace = selectedNamespace(state)
  const field = selectedField(state)
  if (namespace === undefined || field === undefined) return { state }
  if (!state.settings.writable) {
    return { state: { ...state, error: 'Settings provider is read only' } }
  }
  const shared = {
    namespace: namespace.namespace,
    path: field.path,
    expectedRevision: namespace.revision,
  }
  return beginMutation(state, operation === 'set'
    ? { ...shared, operation, value }
    : { ...shared, operation })
}

export function applyRuntimeLibraryAction(
  state: RuntimeLibraryState,
  action: RuntimeLibraryAction,
): RuntimeLibraryTransition {
  if (!state.open) return { state }
  if (state.pending) {
    return action.type === 'escape'
      ? { state: { ...createRuntimeLibraryState(), settings: state.settings, plugins: state.plugins }, outcome: { kind: 'cancelled' } }
      : { state }
  }
  switch (action.type) {
    case 'move-up': return { state: moveSelection(state, -1) }
    case 'move-down': return { state: moveSelection(state, 1) }
    case 'switch-tab':
      return {
        state: normalizeSelections({
          ...state,
          tab: state.tab === 'settings' ? 'plugins' : 'settings',
          focus: 'catalog',
          query: createPromptEditorState(),
          editor: undefined,
          notice: undefined,
          error: undefined,
        }),
      }
    case 'edit': {
      if (state.focus === 'detail') return { state }
      if (state.focus === 'editor' && state.editor !== undefined) {
        return {
          state: {
            ...state,
            editor: { ...state.editor, input: reducePromptEditor(state.editor.input, action.action) },
            error: undefined,
          },
        }
      }
      return {
        state: normalizeSelections({
          ...state,
          query: reducePromptEditor(state.query, action.action),
          notice: undefined,
          error: undefined,
        }),
      }
    }
    case 'enter': {
      if (state.tab === 'plugins') {
        return { state, outcome: { kind: 'refresh-plugins' } }
      }
      if (state.focus === 'catalog') {
        return selectedNamespace(state) === undefined
          ? { state }
          : { state: { ...state, focus: 'detail', notice: undefined, error: undefined } }
      }
      if (state.focus === 'detail') {
        const namespace = selectedNamespace(state)
        const field = selectedField(state)
        if (namespace === undefined || field === undefined) return { state }
        if (!state.settings.writable) {
          return { state: { ...state, error: 'Settings provider is read only' } }
        }
        const serialized = field.source === 'secret'
          ? '""'
          : JSON.stringify(field.value) ?? 'null'
        return {
          state: {
            ...state,
            focus: 'editor',
            editor: {
              namespace: namespace.namespace,
              path: field.path,
              secret: field.source === 'secret',
              input: createPromptEditorState(serialized),
            },
            notice: undefined,
            error: undefined,
          },
        }
      }
      if (state.editor === undefined) return { state }
      try {
        return mutateSelected(state, 'set', JSON.parse(state.editor.input.text))
      } catch {
        return { state: { ...state, error: 'Value must be valid JSON' } }
      }
    }
    case 'inherit':
      return state.tab === 'settings' && state.focus === 'detail'
        ? mutateSelected(state, 'unset')
        : { state }
    case 'escape':
      if (state.focus === 'editor') {
        return {
          state: {
            ...state,
            focus: 'detail',
            editor: undefined,
            notice: undefined,
            error: undefined,
          },
        }
      }
      if (state.focus === 'detail') {
        return { state: { ...state, focus: 'catalog', notice: undefined, error: undefined } }
      }
      return {
        state: {
          ...createRuntimeLibraryState(),
          settings: state.settings,
          plugins: state.plugins,
        },
        outcome: { kind: 'cancelled' },
      }
  }
}

export function settleRuntimeLibraryMutation(
  state: RuntimeLibraryState,
  settings: SettingsCatalogSnapshot,
  plugins: PluginInventorySnapshot,
  error: string | undefined,
): RuntimeLibraryState {
  const intent = state.pendingIntent
  const notice = error !== undefined || intent === undefined
    ? undefined
    : intent.operation === 'unset'
      ? `Inherited ${intent.pathLabel} from the lower settings layer`
      : `Updated ${intent.pathLabel}`
  return normalizeSelections({
    ...state,
    settings,
    plugins,
    focus: 'detail',
    editor: undefined,
    pending: false,
    pendingIntent: undefined,
    ...(notice === undefined ? { notice: undefined } : { notice }),
    ...(error === undefined ? { error: undefined } : { error }),
  })
}

function overrideCount(namespace: SettingsNamespaceSnapshot): number {
  return fieldsOf(namespace).filter(field => field.source === 'user').length
}

function selectedFieldIndex(state: RuntimeLibraryState, fields: readonly Omit<RuntimeSettingFieldView, 'selected'>[]): number {
  const index = fields.findIndex(field => pathKey(field.path) === state.fieldSelection)
  return index < 0 ? 0 : index
}

export function selectRuntimeLibrary(state: RuntimeLibraryState): RuntimeLibraryView | undefined {
  if (!state.open) return undefined
  const namespaceRows = matchingNamespaces(state)
  const namespace = selectedNamespace(state)
  const pluginRows = matchingPlugins(state)
  const plugin = selectedPlugin(state)
  const fields = namespace === undefined ? [] : fieldsOf(namespace)
  const fieldIndex = selectedFieldIndex(state, fields)
  const settingsRows = namespaceRows.map(item => ({
    namespace: item.namespace,
    applies: item.applies,
    revision: item.revision,
    overrideCount: overrideCount(item),
    secretCount: item.secrets.length,
    selected: item.namespace === namespace?.namespace,
  }))
  const selectedSettingsRow = settingsRows.find(row => row.selected)
  const pluginViews = pluginRows.map(item => ({
    ...item,
    selected: item.entryId === plugin?.entryId,
  }))
  const selectedPluginView = pluginViews.find(item => item.selected)
  return {
    tab: state.tab,
    focus: state.focus,
    query: state.query,
    pending: state.pending,
    settings: {
      available: state.settings.available,
      writable: state.settings.writable,
      documentBacked: state.settings.documentBacked,
      generation: state.settings.generation,
      stale: state.settings.stale === true,
      rows: settingsRows,
      totalCount: state.settings.namespaces.length,
      ...(namespace === undefined || selectedSettingsRow === undefined
        ? {}
        : {
            selected: {
              ...selectedSettingsRow,
              fields: fields.map((field, index) => ({ ...field, selected: index === fieldIndex })),
              selectedFieldIndex: fieldIndex,
            },
          }),
      ...(state.settings.error === undefined ? {} : { error: state.settings.error }),
    },
    plugins: {
      available: state.plugins.available,
      rows: pluginViews,
      totalCount: state.plugins.entries.length,
      activeCount: state.plugins.entries.filter(item => item.fiberPhase === 'active').length,
      failedCount: state.plugins.entries.filter(item => item.fiberPhase === 'failed').length,
      ...(selectedPluginView === undefined ? {} : { selected: selectedPluginView }),
      ...(state.plugins.error === undefined ? {} : { error: state.plugins.error }),
    },
    ...(state.editor === undefined ? {} : { editor: state.editor }),
    ...(state.notice === undefined ? {} : { notice: state.notice }),
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}

export function pluginPhaseLabel(phase: PluginFiberPhase): string {
  return phase === null ? 'detached' : phase
}
