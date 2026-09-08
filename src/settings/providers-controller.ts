import type { TerminalInputAction } from '../terminal/input.ts'
import { stripTerminalSequences } from '../terminal/text-layout.ts'
import { createPromptEditorState, reducePromptEditor, type PromptEditorState } from '../ui/prompt-editor.ts'
import { ProviderAuthorizationDeclinedError, type ProviderAuthorizationPrompt, type ProviderConnectionEntry,
  type ProviderConnectionPort, type ProviderConnectionSnapshot } from '../provider/port.ts'
import type { SettingsCatalogPort, SettingsMutationRequest, SettingsNamespaceSnapshot } from './port.ts'
import { createProviderCustomDraft, prepareProviderCustomCreation, providerCustomApiChoices, type ProviderCustomDraft } from './provider-custom.ts'

export interface SettingsProviderRow {
  readonly id: string
  readonly label: string
  readonly value?: string
  readonly description?: string
  readonly disabled?: boolean
  readonly group?: string
  readonly badge?: string
  readonly tone?: 'success' | 'accent'
}

type DialogKind = 'directory' | 'manage' | 'models' | 'default-model' | 'methods' | 'authorization' | 'working'
  | 'editor' | 'confirm-disconnect' | 'confirm-remove' | 'confirm-discard' | 'custom' | 'custom-api'

export interface SettingsProviderDialog {
  readonly kind: DialogKind
  readonly title: string
  readonly description?: string
  readonly rows: readonly SettingsProviderRow[]
  readonly selection: number
  readonly editor?: PromptEditorState
  readonly searchFocused?: boolean
}

export interface SettingsProviderTestFeedback {
  readonly state: 'running' | 'success' | 'error' | 'warning' | 'cancelled'
  readonly title: string
  readonly detail?: string
}

export interface SettingsProvidersView {
  readonly providers: readonly ProviderConnectionEntry[]
  readonly directory: readonly ProviderConnectionEntry[]
  readonly selectedProvider?: ProviderConnectionEntry
  readonly selection: number
  readonly query: PromptEditorState
  readonly defaultModel: string
  readonly defaultProviderId?: string
  readonly defaultWritable: boolean
  readonly loading: boolean
  readonly busy: boolean
  readonly writable: boolean
  readonly dialog?: SettingsProviderDialog
  readonly error?: string
  readonly notice?: string
  readonly testFeedback?: SettingsProviderTestFeedback
}

export type SettingsProvidersOutcome = { readonly kind: 'close' } | { readonly kind: 'advanced'; readonly namespace?: string }
type ManagementAction = 'credentials' | 'model' | 'test' | 'name' | 'baseURL' | 'modelId' | 'advanced' | 'disconnect' | 'remove'

interface PendingPrompt {
  readonly prompt: ProviderAuthorizationPrompt
  readonly resolve: (value: string) => void
  readonly reject: (error: unknown) => void
  readonly dispose: () => void
}

const empty: ProviderConnectionSnapshot = { providers: [], writable: false }
const clamp = (value: number, count: number): number => Math.max(0, Math.min(value, count - 1))
const clean = (value: string): string => stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function endpoint(value: string): string {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString() }
  catch { return value }
}
const customLabels: Record<keyof ProviderCustomDraft, string> = {
  displayName: '显示名称', api: '服务类型', baseURL: '服务地址', modelId: '模型 ID',
}

function input(state: PromptEditorState, action: TerminalInputAction): PromptEditorState {
  switch (action.type) {
    case 'insert': case 'backspace': case 'delete': case 'move-left': case 'move-right': case 'move-home': case 'move-end':
      return reducePromptEditor(state, action)
    default: return state
  }
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** Settings owns provider management; official authorization and model calls stay behind the port. */
export class SettingsProvidersController {
  private opened = false
  private generation = 0
  private snapshot = empty
  private selection = 0
  private providerId: string | undefined
  private modelId: string | undefined
  private stage: DialogKind | undefined
  private dialogSelection = 0
  private query = createPromptEditorState()
  private searchFocused = true
  private editor = createPromptEditorState()
  private editField: 'name' | 'baseURL' | 'modelId' | undefined
  private editRevision = 0
  private editOriginal = ''
  private customDraft: ProviderCustomDraft | undefined
  private customField: keyof ProviderCustomDraft | undefined
  private customInitial: ProviderCustomDraft | undefined
  private discardStage: DialogKind | undefined
  private discardTarget: DialogKind | undefined
  private defaultRevision = 0
  private defaultOptions: { provider: string; model: string; label: string; group: string }[] = []
  private error: string | undefined
  private notice: string | undefined
  private testFeedback: SettingsProviderTestFeedback | undefined
  private loading = false
  private busy = false
  private stopProvider: (() => void) | undefined
  private stopSettings: (() => void) | undefined
  private refreshAbort: AbortController | undefined
  private operationAbort: AbortController | undefined
  private pendingPrompt: PendingPrompt | undefined
  private tasks = new Set<Promise<void>>()
  private secrets = new Set<string>()
  private authorizationNotice: string | undefined
  private cancellationNotice = '已取消操作。'

  constructor(private readonly port: ProviderConnectionPort, private readonly settings: SettingsCatalogPort | undefined,
    private readonly invalidate: () => void) {}

  get isOpen(): boolean { return this.opened }
  get isModalOpen(): boolean { return this.stage !== undefined }
  get pendingCount(): number { return this.tasks.size }

  open(): void {
    if (this.opened) return
    this.opened = true
    this.generation += 1
    this.stage = undefined
    this.selection = 0
    this.error = undefined
    this.notice = undefined
    this.testFeedback = undefined
    this.stopProvider = this.port.onChanged(() => { void this.refresh() })
    this.stopSettings = this.settings?.onSettingsChanged(() => { this.invalidate() })
    void this.refresh()
  }

  close(): void {
    if (!this.opened) return
    this.opened = false
    this.generation += 1
    for (const stop of [this.stopProvider, this.stopSettings]) {
      try { stop?.() } catch { /* A broken subscription must not prevent aborting authorization. */ }
    }
    this.stopProvider = undefined
    this.stopSettings = undefined
    this.refreshAbort?.abort()
    this.cancelOperation()
    this.stage = undefined
    this.customDraft = undefined
    this.editor = createPromptEditorState()
    this.secrets.clear()
    this.invalidate()
  }

  quiesce(): void { this.close() }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks])
  }

  private safe(value: string): string {
    for (const secret of this.secrets) value = value.replaceAll(secret, '••••')
    if (this.pendingPrompt?.prompt.kind === 'secret' && this.editor.text !== '') value = value.replaceAll(this.editor.text, '••••')
    return clean(value)
  }

  private providers(): readonly ProviderConnectionEntry[] {
    return this.snapshot.providers.filter(provider => provider.configured || provider.credential.configured)
  }

  private directory(): readonly ProviderConnectionEntry[] {
    const query = this.query.text.toLocaleLowerCase().trim()
    return this.snapshot.providers.filter(provider => `${provider.name} ${provider.id}`.toLocaleLowerCase().includes(query))
  }

  private provider(): ProviderConnectionEntry | undefined {
    return this.snapshot.providers.find(provider => provider.id === this.providerId)
  }

  private defaultNamespace(): SettingsNamespaceSnapshot | undefined {
    return this.settings?.settingsSnapshot().namespaces.find(item => item.namespace === 'agent-default-model')
  }

  private settingsWritable(): boolean {
    const snapshot = this.settings?.settingsSnapshot()
    return snapshot?.available === true && snapshot.writable && snapshot.stale !== true
  }

  private canConfigure(provider: ProviderConnectionEntry): boolean {
    return this.snapshot.writable && provider.credential.writable && provider.methods.length > 0
  }

  private managementRows(): SettingsProviderRow[] {
    const provider = this.provider()
    if (provider === undefined) return []
    const configuration = provider.configuration
    const namespace = this.settings?.settingsSnapshot().namespaces.find(item => item.namespace === configuration?.namespace)
    const editable = configuration?.writable === true && this.settingsWritable() && namespace !== undefined
    const models = provider.models ?? []
    const selected = models.find(model => model.id === this.modelId) ?? models[0]
    const rows: SettingsProviderRow[] = [
      { id: 'credentials', label: provider.credential.configured ? '更换凭据' : '配置凭据', group: '连接配置',
        value: provider.credential.configured ? '•••••• 已配置' : '待配置', disabled: !this.canConfigure(provider) },
      { id: 'name', label: '显示名称', group: '连接配置', value: configuration?.displayName ?? provider.name, disabled: !editable },
      { id: 'baseURL', label: '服务地址', group: '连接配置', value: configuration?.baseURL ?? '使用服务默认地址', disabled: !editable },
      { id: 'model', label: '测试模型', group: '连接测试', value: selected?.name ?? '暂无模型', disabled: models.length === 0 },
      { id: 'test', label: '测试连接', group: '连接测试',
        disabled: this.port.test === undefined || !provider.active || !provider.credential.configured || selected === undefined },
    ]
    const configuredModels = configuration ? valueAt(namespace?.value, [...configuration.path, 'models']) : undefined
    if (editable && configuration?.api !== undefined && Array.isArray(configuredModels) && configuredModels.length > 0) {
      rows.push({ id: 'modelId', label: '添加模型 ID', group: '更多操作' })
    }
    rows.push({ id: 'advanced', label: '高级设置', group: '更多操作' })
    rows.push({ id: 'disconnect', label: '断开连接', group: '更多操作', disabled: !provider.canDisconnect || !this.snapshot.writable })
    if (configuration && valueAt(namespace?.user, configuration.path) !== undefined) {
      rows.push({ id: 'remove', label: '重置服务配置', group: '更多操作', disabled: !editable })
    }
    return this.busy ? rows.map(row => ({ ...row, disabled: true })) : rows
  }

  view(): SettingsProvidersView | undefined {
    if (!this.opened) return undefined
    const provider = this.provider()
    const value = this.defaultNamespace()?.value
    const defaultProvider = valueAt(value, ['provider'])
    const defaultModel = valueAt(value, ['model'])
    const stage = this.stage
    let title = ''
    let description: string | undefined
    let rows: SettingsProviderRow[] = []
    let editor: PromptEditorState | undefined
    if (stage === 'directory') {
      title = '添加提供商'
      rows = this.directory().map(item => ({ id: item.id, label: item.name,
        ...(!item.credential.configured ? { value: item.configured ? '继续配置' : '添加' } : {}),
        ...(item.id === defaultProvider ? { badge: '当前默认', tone: 'accent' as const }
          : item.credential.configured ? { badge: '已配置', tone: 'success' as const } : {}) }))
      rows.push({ id: '__custom__', label: '自定义兼容服务', description: '填写名称、地址和模型 ID。', disabled: !this.settingsWritable() })
    } else if (stage === 'manage') {
      title = provider?.name ?? '提供商暂不可用'
      rows = this.managementRows()
    } else if (stage === 'models') {
      title = '选择测试模型'
      rows = (provider?.models ?? []).map(model => ({ id: model.id, label: model.name.trim() === '' ? model.id : model.name }))
    } else if (stage === 'default-model') {
      title = '新会话默认模型'
      rows = this.defaultOptions.map(item => ({ id: `${item.provider}/${item.model}`, label: item.label, group: item.group,
        ...(item.provider === defaultProvider && item.model === defaultModel ? { badge: '当前默认', tone: 'accent' as const } : {}) }))
    } else if (stage === 'methods') {
      title = '配置凭据'
      description = '选择服务提供的认证方式。'
      rows = (provider?.methods ?? []).map(method => ({ id: method.id, label: method.label }))
    } else if (stage === 'authorization') {
      title = '配置凭据'
      const prompt = this.pendingPrompt!.prompt
      description = prompt.message
      if (prompt.kind === 'select') rows = prompt.options.map(option => ({ id: option.id, label: option.label,
        ...(option.description ? { description: option.description } : {}) }))
      else {
        editor = prompt.kind === 'secret' ? { text: '•'.repeat([...segmenter.segment(this.editor.text)].length), cursor: this.editor.cursor } : this.editor
      }
    } else if (stage === 'working') {
      title = this.notice!
      description = this.authorizationNotice
    } else if (stage === 'editor') {
      title = '编辑：' + (this.customField ? customLabels[this.customField] : this.editField === 'name' ? '显示名称' : this.editField === 'baseURL' ? '服务地址' : '模型 ID')
      description = this.editField === 'modelId' || this.customField === 'modelId' ? '填写服务商提供的模型名称。' : undefined
      editor = this.editField === 'baseURL' || this.customField === 'baseURL'
        ? { text: endpoint(this.editor.text), cursor: Math.min(this.editor.cursor, [...segmenter.segment(endpoint(this.editor.text))].length) } : this.editor
    } else if (stage === 'custom') {
      title = '自定义兼容服务'
      description = '添加后继续配置凭据。'
      const choices = providerCustomApiChoices(this.settings!.settingsSnapshot())
      rows = (Object.keys(customLabels) as (keyof ProviderCustomDraft)[]).map(key => ({ id: key, label: customLabels[key],
        value: (key === 'api' ? choices.find(choice => choice.id === this.customDraft!.api)?.label ?? this.customDraft!.api : this.customDraft![key]) || '未填写' }))
      rows.push({ id: 'create', label: '添加并配置凭据', disabled: !this.settingsWritable() })
    } else if (stage === 'custom-api') {
      title = '服务类型'
      rows = providerCustomApiChoices(this.settings!.settingsSnapshot()).map(item => ({ id: item.id, label: item.label }))
    } else if (stage === 'confirm-disconnect' || stage === 'confirm-remove' || stage === 'confirm-discard') {
      title = stage === 'confirm-disconnect' ? '断开此服务的连接？' : stage === 'confirm-remove' ? '重置服务配置？' : '放弃未保存的输入？'
      description = stage === 'confirm-disconnect' ? '移除已保存的凭据，保留服务地址与模型配置。'
        : stage === 'confirm-remove' ? '保留已保存的密钥；恢复原始配置，无原始配置的服务将移除。' : '未保存的内容将丢失。'
      rows = [{ id: 'cancel', label: '取消' }, { id: 'confirm', label: stage === 'confirm-discard' ? '放弃更改' : '确认' }]
    }
    return { providers: this.providers(), directory: this.directory(), ...(provider ? { selectedProvider: provider } : {}),
      selection: this.selection, query: this.query, defaultModel: typeof defaultModel === 'string' && defaultModel !== ''
        ? this.safe(`${typeof defaultProvider === 'string' ? defaultProvider + ' / ' : ''}${defaultModel}`) : '使用默认模型',
      ...(typeof defaultProvider === 'string' && defaultProvider !== '' ? { defaultProviderId: defaultProvider } : {}),
      defaultWritable: this.settingsWritable() && this.defaultNamespace() !== undefined,
      loading: this.loading, busy: this.busy, writable: this.snapshot.writable,
      ...(stage ? { dialog: { kind: stage, title: this.safe(title), ...(description ? { description: this.safe(description) } : {}),
        rows: rows.map(row => ({ ...row, label: this.safe(row.label), ...(row.value ? { value: this.safe(row.value) } : {}),
          ...(row.description ? { description: this.safe(row.description) } : {}),
          ...(row.group ? { group: this.safe(row.group) } : {}), ...(row.badge ? { badge: this.safe(row.badge) } : {}) })), selection: this.dialogSelection,
        ...(editor ? { editor: { text: this.safe(editor.text), cursor: editor.cursor } } : {}),
        ...(stage === 'directory' ? { searchFocused: this.searchFocused } : {}) } } : {}),
      ...(this.error ? { error: this.safe(this.error) } : {}), ...(this.notice ? { notice: this.safe(this.notice) } : {}),
      ...(this.testFeedback ? { testFeedback: { ...this.testFeedback, title: this.safe(this.testFeedback.title),
        ...(this.testFeedback.detail ? { detail: this.safe(this.testFeedback.detail) } : {}) } } : {}) }
  }

  openAdd(): void {
    if (!this.opened || this.busy) return
    this.clearTestFeedback()
    this.stage = 'directory'
    this.query = createPromptEditorState()
    this.searchFocused = true
    this.dialogSelection = 0
    this.error = undefined
    this.notice = undefined
    this.invalidate()
  }

  handleInput(action: TerminalInputAction, navigationKeys: 'arrows' | 'vim' | 'both' = 'both'): SettingsProvidersOutcome | undefined {
    if (!this.opened) return
    const editing = this.stage === 'editor' || (this.stage === 'authorization' && this.pendingPrompt?.prompt.kind !== 'select')
      || (this.stage === 'directory' && this.searchFocused)
    if (!editing && navigationKeys !== 'arrows' && action.type === 'insert' && action.paste !== true) {
      if (action.text === 'j') action = { type: 'move-down' }
      else if (action.text === 'k') action = { type: 'move-up' }
    }
    const key = action.type === 'insert' && action.paste !== true ? action.text : ''
    if (this.stage === 'authorization' && this.pendingPrompt?.prompt.kind !== 'select') {
      this.handleEditor(action, true)
    } else if (this.stage === 'editor') {
      this.handleEditor(action, false)
    } else if (this.busy && this.stage !== 'authorization') {
      if (action.type === 'escape' || action.type === 'interrupt') this.cancelOperation()
    } else if (action.type === 'escape' || action.type === 'interrupt'
      || (key === 'q' && !(this.stage === 'directory' && this.searchFocused))) {
      if (this.stage === undefined) return { kind: 'close' }
      if (this.stage === 'authorization') this.cancelOperation()
      else if (this.stage === 'confirm-discard') this.stage = this.discardStage
      else if (this.stage === 'custom' && JSON.stringify(this.customDraft) !== JSON.stringify(this.customInitial)) this.confirmDiscard(undefined)
      else if (['methods', 'models', 'confirm-disconnect', 'confirm-remove'].includes(this.stage)) this.stage = 'manage'
      else if (this.stage === 'custom-api') this.stage = 'custom'
      else this.stage = undefined
      this.error = undefined
    } else if (this.stage === 'directory' && (this.searchFocused || action.type === 'complete')) {
      if (action.type === 'complete') this.searchFocused = !this.searchFocused
      else if (action.type === 'move-down' || action.type === 'move-up') this.dialogSelection = clamp(this.dialogSelection + (action.type === 'move-down' ? 1 : -1), this.directory().length + 1)
      else if (action.type === 'submit') this.chooseDirectory()
      else { this.query = input(this.query, action); this.dialogSelection = 0 }
    } else if (this.stage === undefined) {
      if (key === 'n' || key === 'N') this.openAdd()
      else if (key === 'r' || key === 'R') void this.refresh()
      else if (action.type === 'toggle-transcript-details') return { kind: 'advanced' }
      else if (action.type === 'move-up' || action.type === 'move-down') this.selection = clamp(this.selection + (action.type === 'move-down' ? 1 : -1), this.providers().length + 1)
      else if (action.type === 'submit') {
        if (this.selection === 0) this.openDefault()
        else this.openManage(this.providers()[this.selection - 1]?.id)
      }
    } else {
      const rows = this.view()!.dialog!.rows
      if (action.type === 'move-up' || action.type === 'move-down' || action.type === 'complete') {
        this.dialogSelection = clamp(this.dialogSelection + (action.type === 'move-up' || (action.type === 'complete' && action.reverse) ? -1 : 1), rows.length)
      } else if (this.stage === 'manage') {
        const shortcuts: Record<string, string> = { c: 'credentials', t: 'test', m: 'model', e: 'baseURL', g: 'name', d: 'disconnect', a: 'advanced' }
        const id = action.type === 'submit' ? rows[this.dialogSelection]?.id
          : action.type === 'toggle-transcript-details' ? 'advanced' : shortcuts[key]
        if (id !== undefined) return this.activateManagement(id as ManagementAction)
      } else if (action.type === 'submit') this.activateDialog()
    }
    this.invalidate()
    return undefined
  }

  private openManage(id: string | undefined): void {
    this.clearTestFeedback()
    this.providerId = id
    this.modelId = this.provider()?.models?.[0]?.id
    this.stage = 'manage'
    this.dialogSelection = 0
    this.error = undefined
  }

  private chooseDirectory(): void {
    const provider = this.directory()[this.dialogSelection]
    if (provider) this.openManage(provider.id)
    else if (this.settingsWritable() && this.settings) {
      this.customDraft = createProviderCustomDraft(this.settings.settingsSnapshot())
      this.customInitial = { ...this.customDraft }
      this.stage = 'custom'
      this.dialogSelection = 0
    } else this.error = '当前设置只读，无法添加自定义服务。'
  }

  private openDefault(): void {
    const namespace = this.defaultNamespace()
    if (!namespace || !this.settingsWritable()) { this.error = '当前设置只读或默认模型服务不可用。'; return }
    const providers = this.providers()
    this.defaultOptions = providers.flatMap(provider => (provider.models ?? []).map(model => ({
      provider: provider.id, model: model.id, label: model.name.trim() === '' ? model.id : model.name,
      group: providers.filter(item => this.safe(item.name) === this.safe(provider.name)).length > 1
        ? `${provider.name} (${provider.id})` : provider.name,
    })))
    if (this.defaultOptions.length === 0) { this.error = '请先添加一个可用模型服务。'; return }
    this.defaultRevision = namespace.revision
    this.dialogSelection = Math.max(0, this.defaultOptions.findIndex(option => option.provider === valueAt(namespace.value, ['provider']) && option.model === valueAt(namespace.value, ['model'])))
    this.stage = 'default-model'
    this.error = undefined
  }

  private activateManagement(id: ManagementAction): SettingsProvidersOutcome | undefined {
    const provider = this.provider()
    if (!provider || this.managementRows().find(item => item.id === id)!.disabled) {
      this.error = id === 'test' ? '无法测试：请先配置凭据并选择可用模型。' : '此操作当前不可用或受只读配置管理。'
      this.invalidate()
      return
    }
    this.error = undefined
    if (id === 'advanced') return { kind: 'advanced', ...(provider.configuration?.namespace ? { namespace: provider.configuration.namespace } : {}) }
    if (id === 'credentials') this.openCredentials()
    else if (id === 'model') { this.stage = 'models'; this.dialogSelection = Math.max(0, provider.models!.findIndex(model => model.id === this.modelId)) }
    else if (id === 'test') this.beginTest()
    else if (id === 'disconnect' || id === 'remove') { this.stage = id === 'disconnect' ? 'confirm-disconnect' : 'confirm-remove'; this.dialogSelection = 0 }
    else this.openEditor(id)
    this.invalidate()
    return undefined
  }

  private activateDialog(): void {
    const provider = this.provider()
    if (this.stage === 'directory') this.chooseDirectory()
    else if (this.stage === 'models') {
      const modelId = provider?.models?.[this.dialogSelection]?.id
      if (this.modelId !== modelId) this.clearTestFeedback()
      this.modelId = modelId; this.stage = 'manage'; this.dialogSelection = this.managementRows().findIndex(row => row.id === 'model')
    }
    else if (this.stage === 'methods') { const method = provider?.methods[this.dialogSelection]; if (method) this.beginConnect(method.id) }
    else if (this.stage === 'authorization') {
      // Text and secret prompts are handled before dialog actions.
      const prompt = this.pendingPrompt!.prompt as Extract<ProviderAuthorizationPrompt, { kind: 'select' }>
      const answer = prompt.options[this.dialogSelection]?.id
      if (answer !== undefined) this.resolvePrompt(answer)
    } else if (this.stage === 'default-model') {
      const option = this.defaultOptions[this.dialogSelection]!
      this.beginMutation({ namespace: 'agent-default-model', path: [], expectedRevision: this.defaultRevision, operation: 'batch', changes: [
        { operation: 'set', path: ['provider'], value: option.provider }, { operation: 'set', path: ['model'], value: option.model },
        { operation: 'unset', path: ['reasoningEffort'] },
      ] }, '新会话默认模型已更新。', undefined)
    } else if (this.stage === 'confirm-discard') {
      if (this.dialogSelection === 0) this.stage = this.discardStage
      else { this.stage = this.discardTarget; this.editor = createPromptEditorState(); if (this.stage === undefined) this.customDraft = undefined }
    } else if (this.stage === 'confirm-disconnect' || this.stage === 'confirm-remove') {
      if (this.dialogSelection === 0) this.stage = 'manage'
      else if (provider && this.stage === 'confirm-disconnect') this.runOperation('正在断开连接…', '断开失败，请刷新后重试。', async signal => {
        await this.port.disconnect(provider.id, { signal }); return '连接已断开，服务配置保留。'
      }, 'manage')
      else if (provider?.configuration && this.stage === 'confirm-remove') this.beginMutation({ namespace: provider.configuration.namespace,
        path: provider.configuration.path, expectedRevision: provider.configuration.revision, operation: 'unset' }, '服务配置已重置，已保存的密钥保留。', undefined)
    } else if (this.stage === 'custom') {
      const id = this.view()!.dialog!.rows[this.dialogSelection]?.id
      if (id === 'create') this.createCustom()
      else if (id === 'api') { this.stage = 'custom-api'; this.dialogSelection = 0 }
      else {
        const field = id as 'displayName' | 'baseURL' | 'modelId'
        this.customField = field; this.editField = undefined; this.editOriginal = this.customDraft![field]
        this.editor = createPromptEditorState(this.editOriginal); this.stage = 'editor'
      }
    } else {
      const choice = providerCustomApiChoices(this.settings!.settingsSnapshot())[this.dialogSelection]
      if (choice) this.customDraft = { ...this.customDraft!, api: choice.id }
      this.stage = 'custom'; this.dialogSelection = 1
    }
  }

  private openEditor(field: 'name' | 'baseURL' | 'modelId'): void {
    const configuration = this.provider()!.configuration!
    const namespace = this.settings!.settingsSnapshot().namespaces.find(item => item.namespace === configuration.namespace)!
    const original = field === 'modelId' ? '' : valueAt(namespace.value, [...configuration.path, field === 'name' ? 'displayName' : field])
    this.editOriginal = typeof original === 'string' ? field === 'baseURL' ? endpoint(original) : original : ''
    this.editRevision = namespace.revision
    this.editField = field
    this.customField = undefined
    this.editor = createPromptEditorState(this.editOriginal)
    this.stage = 'editor'
  }

  private confirmDiscard(target: DialogKind | undefined): void {
    this.discardStage = this.stage; this.discardTarget = target
    this.stage = 'confirm-discard'; this.dialogSelection = 0
  }

  private handleEditor(action: TerminalInputAction, authorization: boolean): void {
    if (action.type === 'escape' || action.type === 'interrupt') {
      if (authorization) this.cancelOperation()
      else if (this.editor.text !== this.editOriginal) this.confirmDiscard(this.customField ? 'custom' : 'manage')
      else this.stage = this.customField ? 'custom' : 'manage'
      return
    }
    if (action.type !== 'submit') { this.editor = input(this.editor, action); this.error = undefined; return }
    const value = this.editor.text.trim()
    if (value === '' || /[\r\n]/.test(this.editor.text)) { this.error = '请输入非空的单行内容。'; return }
    if (authorization) { this.resolvePrompt(value); return }
    if (this.customField && this.customDraft) {
      this.customDraft = { ...this.customDraft, [this.customField]: value }; this.stage = 'custom'; this.editor = createPromptEditorState(); return
    }
    if (value === this.editOriginal) { this.stage = 'manage'; return }
    if (this.editField === 'baseURL') {
      try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error() }
      catch { this.error = '请输入 http(s) 服务地址，不含密钥、用户名、查询参数或片段。'; return }
    }
    const configuration = this.provider()?.configuration
    if (!configuration) { this.error = '服务配置已变更，请重新打开。'; return }
    let path = [...configuration.path, this.editField === 'name' ? 'displayName' : this.editField!]
    let changed: unknown = value
    if (this.editField === 'modelId') {
      const namespace = this.settings?.settingsSnapshot().namespaces.find(item => item.namespace === configuration.namespace)
      const models = valueAt(namespace?.value, [...configuration.path, 'models'])
      if (!Array.isArray(models) || models.length === 0) { this.error = '模型配置已变更，请重新打开。'; return }
      const existing = models
      if (existing.some(model => valueAt(model, ['id']) === value)) { this.error = '此模型 ID 已存在。'; return }
      path = [...configuration.path, 'models']; changed = [...existing, { id: value }]
    }
    this.beginMutation({ namespace: configuration.namespace, path, expectedRevision: this.editRevision, operation: 'set', value: changed }, '提供商设置已更新。', 'manage')
  }

  private openCredentials(): void {
    this.clearTestFeedback()
    const provider = this.provider()!
    if (!this.canConfigure(provider)) { this.error = '当前凭据只读或认证服务不可用。'; return }
    if (provider.methods.length === 1) this.beginConnect(provider.methods[0]!.id)
    else { this.stage = 'methods'; this.dialogSelection = 0 }
  }

  private beginConnect(method: string): void {
    const id = this.providerId!
    this.runOperation('正在配置凭据…', '凭据配置失败，请检查输入后重试。', async (signal) => {
      const outcome = await this.port.connect(id, method, {
        notify: notice => { if (this.operationAbort?.signal === signal && !signal.aborted) {
          this.authorizationNotice = this.safe([notice.message, notice.url, notice.code].filter(Boolean).join(' ')); this.invalidate()
        } }, prompt: prompt => this.receivePrompt(prompt, signal),
      }, { signal })
      return outcome.status === 'connected' ? '凭据已配置；可点击测试连接验证。' : '已取消凭据配置。'
    }, 'manage')
  }

  private receivePrompt(prompt: ProviderAuthorizationPrompt, operationSignal: AbortSignal): Promise<string> {
    if (operationSignal.aborted || !this.opened || this.operationAbort?.signal !== operationSignal || prompt.signal?.aborted) {
      return Promise.reject(new ProviderAuthorizationDeclinedError())
    }
    this.rejectPrompt()
    return new Promise((resolve, reject) => {
      const withdrawn = (): void => { this.rejectPrompt(); this.stage = 'working'; this.invalidate() }
      prompt.signal?.addEventListener('abort', withdrawn, { once: true })
      this.pendingPrompt = { prompt, resolve, reject, dispose: () => prompt.signal?.removeEventListener('abort', withdrawn) }
      this.stage = 'authorization'; this.dialogSelection = 0; this.editor = createPromptEditorState(); this.invalidate()
    })
  }

  private resolvePrompt(answer: string): void {
    const pending = this.pendingPrompt!
    if (pending.prompt.kind === 'secret') this.secrets.add(answer)
    this.pendingPrompt = undefined; pending.dispose(); this.editor = createPromptEditorState(); this.stage = 'working'; pending.resolve(answer)
  }

  private rejectPrompt(): void {
    const pending = this.pendingPrompt
    if (!pending) return
    this.pendingPrompt = undefined; this.editor = createPromptEditorState()
    pending.dispose(); pending.reject(new ProviderAuthorizationDeclinedError())
  }

  private beginTest(): void {
    const provider = this.provider()!
    const model = provider.models!.find(item => item.id === this.modelId) ?? provider.models![0]!
    const test = this.port.test!
    this.dialogSelection = this.managementRows().findIndex(row => row.id === 'test')
    this.runOperation('正在测试连接…', '测试失败，请检查凭据、地址与模型后重试。', async signal => {
      const result = await test.call(this.port, provider.id, model.id, { signal })
      const limited = result.outcome === 'limited'
      return { notice: limited ? `服务已响应，测试输出达到限制（${Math.round(result.elapsedMs)} ms）。`
        : `测试通过（${Math.round(result.elapsedMs)} ms）。`, feedback: {
        state: limited ? 'warning' as const : 'success' as const, title: limited ? '服务已响应，输出受限' : '连接成功',
        detail: `响应耗时 ${Math.max(0.01, Math.round(result.elapsedMs / 10) / 100)} 秒。`,
      } }
    }, 'manage', undefined, true)
  }

  private clearTestFeedback(): void {
    if (this.testFeedback) { this.testFeedback = undefined; this.notice = undefined; this.error = undefined }
  }

  private beginMutation(request: SettingsMutationRequest, success: string, returnStage: DialogKind | undefined): void {
    if (!this.settingsWritable() || !this.settings) { this.error = '当前设置只读或已过期，请刷新后重试。'; return }
    this.runOperation('正在保存设置…', '保存失败，配置可能已变更；请重新打开后重试。', async () => {
      await this.settings!.mutateSettings(request); return success
    }, returnStage)
  }

  private createCustom(): void {
    if (!this.customDraft || !this.settings || !this.settingsWritable()) { this.error = '当前设置只读，无法添加服务。'; return }
    const prepared = prepareProviderCustomCreation(this.settings.settingsSnapshot(), this.customDraft)
    if ('error' in prepared) { this.error = prepared.error; this.dialogSelection = (Object.keys(customLabels) as string[]).indexOf(prepared.field); return }
    const generation = this.generation
    this.runOperation('正在添加服务…', '添加失败，请检查输入或刷新设置后重试。', async signal => {
      await this.settings!.mutateSettings(prepared.request)
      if (signal.aborted || generation !== this.generation) return ''
      this.providerId = prepared.providerId
      await this.refresh()
      return '已添加，待配置凭据。'
    }, 'manage', () => {
      this.customDraft = undefined
      this.modelId = this.provider()?.models?.[0]?.id
      if (this.provider()) this.openCredentials()
      else this.error = '已添加，服务目录尚未更新；请刷新后继续配置凭据。'
    })
  }

  private runOperation(working: string, failure: string,
    execute: (signal: AbortSignal) => Promise<string | { notice: string; feedback: SettingsProviderTestFeedback }>,
    returnStage: DialogKind | undefined, after?: () => void, testOperation = false): void {
    const abort = new AbortController()
    const generation = this.generation
    const failureStage = this.stage
    this.clearTestFeedback()
    if (testOperation) this.testFeedback = { state: 'running', title: working }
    this.operationAbort = abort; this.busy = true; this.stage = testOperation ? 'manage' : 'working'; this.error = undefined; this.notice = working; this.authorizationNotice = undefined
    this.cancellationNotice = working === '正在保存设置…' || working === '正在添加服务…'
      ? '已停止等待，设置可能已保存；请刷新确认。' : '已取消操作。'
    const current = (): boolean => this.opened && generation === this.generation && this.operationAbort === abort && !abort.signal.aborted
    const task = Promise.resolve().then(() => current() ? execute(abort.signal) : '').then(async notice => {
      if (!current()) return
      this.notice = typeof notice === 'string' ? notice : notice.notice
      await this.refresh()
      if (current()) {
        this.stage = returnStage
        if (typeof notice !== 'string') this.testFeedback = notice.feedback
        if (!testOperation) this.dialogSelection = 0
      }
    }).catch(() => {
      if (current()) {
        this.error = failure; this.notice = undefined; this.stage = failureStage
        if (testOperation) this.testFeedback = { state: 'error', title: '连接测试失败', detail: failure }
      }
    }).finally(() => {
      if (this.operationAbort !== abort) return
      const success = current() && this.error === undefined
      this.operationAbort = undefined; this.busy = false; this.rejectPrompt()
      if (success) after?.()
      this.invalidate()
    })
    this.track(task); this.invalidate()
  }

  private cancelOperation(): void {
    if (!this.operationAbort) return
    const abort = this.operationAbort
    if (this.testFeedback?.state === 'running') this.testFeedback = { state: 'cancelled', title: '测试已取消' }
    this.operationAbort = undefined; abort.abort(); this.rejectPrompt(); this.busy = false
    this.stage = this.providerId ? 'manage' : undefined; this.notice = this.cancellationNotice; this.error = undefined
    this.invalidate()
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task)
    void task.finally(() => { this.tasks.delete(task) })
  }

  private refresh(): Promise<void> {
    if (!this.opened) return Promise.resolve()
    this.refreshAbort?.abort()
    const abort = new AbortController()
    const generation = this.generation
    this.refreshAbort = abort; this.loading = true
    const current = (): boolean => this.opened && this.generation === generation && this.refreshAbort === abort && !abort.signal.aborted
    const task = Promise.resolve().then(() => this.port.list({ signal: abort.signal })).then(snapshot => {
      if (!current()) return
      this.snapshot = snapshot; this.selection = clamp(this.selection, this.providers().length + 1)
      if (this.error === '服务目录加载失败，请按 r 重试。') this.error = undefined
    }).catch(() => {
      if (current()) this.error = '服务目录加载失败，请按 r 重试。'
    }).finally(() => {
      if (this.refreshAbort === abort) { this.loading = false; this.refreshAbort = undefined; this.invalidate() }
    })
    this.track(task); this.invalidate()
    return task
  }
}
