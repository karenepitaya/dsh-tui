import { FormWorkspace, fitsFormConfirmation, type FormWorkspaceConfirmation, type FormWorkspaceField, type FormWorkspaceForm, type FormWorkspaceModel } from 'pi-tui-orbs'
import type { SettingsProviderDialog, SettingsProvidersView } from '../settings/providers-controller.ts'
import type { SettingsPageView } from '../settings/page-contracts.ts'
import { stripTerminalSequences } from '../terminal/text-layout.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'
import type { PromptEditorState } from './prompt-editor.ts'
import { settingsFormModel } from './settings-page-frame.ts'

const categories = [
  { id: 'general', label: '通用' }, { id: 'models', label: '模型与服务' },
  { id: 'plugins', label: '插件' }, { id: 'presets', label: 'Agent 预设' },
] as const
const clean = (value: string): string => stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const editorInput = (input: PromptEditorState) => ({ text: clean(input.text),
  cursor: clean([...segmenter.segment(input.text)].slice(0, input.cursor).map(part => part.segment).join('')).length })

function providerConfirmation(dialog: SettingsProviderDialog | undefined): FormWorkspaceConfirmation | undefined {
  if (!dialog?.kind.startsWith('confirm-')) return undefined
  return { kind: 'confirmation', title: clean(dialog.title), lines: dialog.description ? [clean(dialog.description)] : [],
    actions: dialog.rows.map(row => ({ id: row.id, label: clean(row.label) })), selectedIndex: dialog.selection,
    hint: '↑↓ 选择   Enter 确认   Esc / q 取消' }
}

/** Input and rendering use the same budget so hidden consequences cannot be confirmed. */
export function settingsProviderConfirmationFits(view: SettingsProvidersView, viewport: TerminalViewport): boolean {
  const modal = providerConfirmation(view.dialog)
  return modal === undefined || fitsFormConfirmation(viewport.columns, viewport.rows, modal)
}

function managementForm(view: SettingsProvidersView, navigation: string): FormWorkspaceForm {
  const dialog = view.dialog!
  const groups: { id: string; title: string; fields: FormWorkspaceField[] }[] = []
  for (const row of dialog.rows) {
    const title = clean(row.group ?? '连接配置')
    let group = groups.find(item => item.title === title)
    if (!group) { group = { id: title, title, fields: [] }; groups.push(group) }
    const credentials = row.id === 'credentials'
    const configured = view.selectedProvider?.credential.configured === true
    const kind = view.selectedProvider?.credential.kind
    group.fields.push({ id: row.id, label: credentials ? kind === 'api-key' ? 'API 密钥' : kind === 'oauth' ? '账号授权' : '服务认证' : clean(row.label),
      control: { kind: ['name', 'displayName', 'baseURL', 'modelId'].includes(row.id) && row.value !== undefined ? 'text' : row.id === 'model' || row.id === 'api' ? 'select' : 'action',
        value: clean(credentials ? configured ? '更换' : '配置' : row.value ?? row.label) },
      readonly: row.disabled === true, pending: view.busy,
      ...(row.description ? { description: clean(row.description) } : {}),
      ...(credentials && configured ? { badge: '已配置', tone: 'success' as const } : {}),
      ...(row.id === 'test' ? { intent: 'primary' as const }
        : row.id === 'disconnect' || row.id === 'remove' ? { intent: 'danger' as const } : {}),
    })
  }
  const result = view.testFeedback
  const tones = { running: 'accent', success: 'success', error: 'error', warning: 'warning', cancelled: 'warning' } as const
  const message = view.error && view.error !== result?.detail ? view.error : result ? undefined : view.notice
  const selected = dialog.rows[dialog.selection]
  return { kind: 'form', title: clean(dialog.title) + (dialog.kind === 'manage' ? ' · 管理' : ''), groups, ...(selected ? { selectedFieldId: selected.id } : {}), pending: view.busy,
    hint: view.busy ? 'Esc 取消测试' : dialog.kind === 'custom' ? navigation + '   Enter 编辑 / 添加   Esc / q 返回'
      : navigation + '   Enter 编辑 / 执行   Tab 操作   Ctrl+S 保存   t 测试   Esc / q 返回模型与服务',
    ...(result ? { feedback: { afterFieldId: 'test', tone: tones[result.state], title: clean(result.title),
      ...(result.detail ? { detail: clean(result.detail) } : {}) } } : {}),
    ...(message ? { message: clean(message), messageTone: view.error ? 'error' as const : 'muted' as const } : {}),
  }
}

/** Projects only display data; Orbs owns the sidebar, bounded list and centered dialogs. */
export function settingsProvidersWorkspaceModel(view: SettingsProvidersView, page: SettingsPageView, viewport: TerminalViewport): FormWorkspaceModel {
  const navigation = page.navigationKeys === 'arrows' ? '↑↓ 选择' : page.navigationKeys === 'vim' ? 'j/k 选择' : '↑↓/jk 选择'
  const dialog = view.dialog
  const message = page.pending ? '正在保存…' : dialog?.kind === 'manage' || dialog?.kind === 'custom' ? page.error ?? page.notice
    : view.error ?? view.notice ?? page.error ?? page.notice
    ?? (view.loading ? '正在加载服务目录…' : page.dirtyCount > 0 ? '其他分类有未保存更改。' : undefined)
  const error = view.error ?? page.error
  const modal: FormWorkspaceModel['modal'] = dialog?.editor ? {
    kind: 'editor', title: clean(dialog.title), ...(dialog.description ? { description: clean(dialog.description) } : {}),
    ...editorInput(dialog.editor), ...(view.error ? { error: clean(view.error) } : {}), hint: 'Enter 确认   Esc 取消',
  } : dialog?.kind === 'manage' || dialog?.kind === 'custom' ? managementForm(view, navigation) : providerConfirmation(dialog) ?? (dialog ? {
    kind: 'dialog', title: clean(dialog.title), ...(dialog.description ? { description: clean(dialog.description) } : {}),
    rows: dialog.rows.map(row => ({ id: row.id, label: clean(row.label),
      ...(row.value ? { value: clean(row.value) } : {}), ...(row.description ? { description: clean(row.description) } : {}),
      ...(row.group ? { group: clean(row.group) } : {}), ...(row.badge ? { badge: clean(row.badge) } : {}),
      ...(row.tone ? { tone: row.tone } : {}),
      ...(row.disabled ? { disabled: true } : {}) })), selectedIndex: dialog.selection,
    hint: dialog.kind === 'working' ? 'Esc 取消'
      : dialog.kind === 'directory' ? '输入搜索   ↑↓ 选择   Enter 打开   Esc 返回'
        : navigation + '   Enter 确认   Esc / q 返回',
    ...(message ? { message: clean(message), messageTone: error ? 'error' as const : 'muted' as const } : {}),
    ...(dialog.kind === 'directory' ? { search: { ...editorInput(view.query), placeholder: '搜索提供商…' }, searchFocused: dialog.searchFocused ?? true } : {}),
  } : undefined)
  const fields = [{ id: 'default-model', label: '新会话默认模型',
    control: { kind: 'select' as const, value: clean(view.defaultModel) }, readonly: !view.defaultWritable },
  { id: 'default-effort', label: '默认推理强度', control: { kind: 'select' as const, value: clean(view.defaultEffort ?? '模型默认') }, readonly: !view.defaultWritable },
  ...view.providers.map(provider => ({ id: 'provider:' + provider.id, label: clean(provider.name),
    badge: `${provider.id === view.defaultProviderId ? '当前默认' : provider.credential.configured ? '已配置' : '待配置'} · ${provider.models?.length ?? 0} 个模型`,
    tone: provider.id === view.defaultProviderId ? 'accent' as const : 'success' as const,
    control: { kind: 'action' as const, value: provider.credential.configured ? '管理' : '配置' } }))]
  const parent = settingsFormModel(page, viewport)
  return {
    height: Math.max(1, Math.floor(viewport.rows)), header: 'DSH 设置',
    categories, activeCategoryId: 'models', focus: page.focus === 'tabs' ? 'navigation' : page.focus === 'actions' ? 'actions' : 'content',
    headerAction: { label: '＋ 添加提供商' }, searchHidden: true,
    pending: page.pending, actions: dialog?.kind === 'custom' || dialog?.kind === 'manage' && page.dirtyCount === 0 ? [] : parent.actions, actionIndex: page.actionIndex, dirtyCount: page.dirtyCount, writable: page.writable,
    groups: [{ id: 'providers', title: '默认模型与已配置服务', fields }],
    selectedFieldId: fields[Math.max(0, Math.min(fields.length - 1, view.selection))]!.id,
    ...(message ? { message: clean(message), messageTone: error ? 'error' as const : 'muted' as const } : {}),
    ...(!view.loading && view.providers.length === 0 && message === undefined ? { message: '添加模型服务后即可选择模型。' } : {}),
    help: navigation + '   Enter 管理   n 添加   Tab 切换   q 返回' + (page.dirtyCount > 0 ? '   Ctrl+S 保存' : ''),
    ...(modal ? { modal } : {}),
  }
}

export function renderSettingsProvidersFrame(view: SettingsProvidersView, page: SettingsPageView, viewport: TerminalViewport, options: { readonly deferLayout?: boolean } = {}): UiFrame {
  const bounded = { columns: Math.max(1, Math.floor(viewport.columns)), rows: Math.max(1, Math.floor(viewport.rows)) }
  const model = settingsProvidersWorkspaceModel(view, page, bounded)
  if (options.deferLayout) return { title: '设置', viewport: bounded, lines: [], formWorkspace: model }
  const workspace = new FormWorkspace(model)
  const lines = workspace.render(bounded.columns)
  const cursor = workspace.getCursor()
  return { title: '设置', viewport: bounded, lines, formWorkspace: model, ...(cursor ? { cursor } : {}) }
}
