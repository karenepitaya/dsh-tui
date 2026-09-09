import { SettingsWorkspace, fitsSettingsConfirmation, type SettingsWorkspaceConfirmation, type SettingsWorkspaceField, type SettingsWorkspaceGroup, type SettingsWorkspaceModel } from 'pi-tui-orbs'
import type { SettingsField, SettingsPageView } from '../settings/page-contracts.ts'
import { stripTerminalSequences } from '../terminal/text-layout.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'
import type { PromptEditorState } from './prompt-editor.ts'

const categories = [
  { id: 'general', label: '通用' }, { id: 'models', label: '模型与服务' },
  { id: 'plugins', label: '插件' }, { id: 'presets', label: 'Agent 预设' },
] as const
const titles = { general: '外观与交互', models: '模型与服务', plugins: '插件设置', presets: 'Agent 预设' }
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function confirmation(kind: NonNullable<SettingsPageView['confirmation']>, selectedIndex: number): SettingsWorkspaceConfirmation {
  const permission = kind === 'permission'
  const reset = kind === 'reset'
  return {
    kind: 'confirmation', selectedIndex,
    title: permission ? '允许新会话使用完全访问权限？' : reset ? '恢复默认设置？' : '放弃未保存的更改？',
    lines: [permission ? '新会话可访问工作目录外的文件并运行命令。'
      : reset ? '当前分类将恢复默认值，保存后生效。' : '本次未保存的更改将丢失。'],
    actions: [{ id: 'cancel', label: '取消' }, { id: 'confirm', label: permission ? '确认保存' : reset ? '恢复默认' : '放弃更改' }],
    hint: '←→ 选择   Enter 确认   Esc / q 取消',
  }
}

/** Shares the framework's actual confirmation layout budget with the input guard. */
export function settingsPermissionConfirmationFits(viewport: TerminalViewport): boolean {
  return fitsSettingsConfirmation(viewport.columns, viewport.rows, confirmation('permission', 0))
}

function summary(value: unknown): string {
  if (value === undefined || value === null) return '未设置'
  if (typeof value === 'string') return value === '' ? '空文本' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return String(value.length) + ' 项'
  return '已配置'
}

/** DSH-specific formatting and redaction stop here; Orbs owns all layout and controls. */
export function settingsWorkspaceModel(view: SettingsPageView, viewport: TerminalViewport): SettingsWorkspaceModel {
  const source = [...view.fields, ...(view.editor ? [view.editor.field] : []), ...(view.picker ? [view.picker.field] : [])]
  const secrets = source.filter(field => field.control === 'secret').flatMap(field => [field.value, field.inheritedValue])
    .filter((value): value is string => typeof value === 'string' && value !== '')
  if (view.editor?.field.control === 'secret') secrets.push(view.editor.input.text)
  const safe = (text: string): string => {
    for (const secret of secrets) if (secret !== '') text = text.replaceAll(secret, '••••')
    return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
  }
  const input = (state: PromptEditorState, masked = false) => {
    const parts = Array.from(segmenter.segment(state.text), part => part.segment)
    return masked ? { text: '•'.repeat(parts.length), cursor: Math.min(parts.length, state.cursor) }
      : { text: safe(state.text), cursor: safe(parts.slice(0, state.cursor).join('')).length }
  }
  const control = (field: SettingsField): SettingsWorkspaceField['control'] => {
    if (field.control === 'secret') return { kind: 'text', value: field.secretSet === true ? '•••••• 已设置' : field.secretSet === false ? '未设置' : '状态未知' }
    if (field.control === 'boolean') return { kind: 'toggle', value: field.value === true ? '开启' : '关闭', checked: field.value === true }
    if (field.control === 'select') {
      const choices = (field.options ?? []).map((option, index) => ({ value: String(index), label: safe(option.label) }))
      const selected = (field.options ?? []).findIndex(option => Object.is(option.value, field.value))
      return { kind: choices.length === 2 ? 'segmented' : 'select', choices,
        value: selected < 0 ? safe(summary(field.value)) : String(selected) }
    }
    return { kind: 'text', value: safe(summary(field.value)) + (field.control === 'readonly' ? '（只读）' : '') }
  }
  const grouped = new Map<string, SettingsWorkspaceField[]>()
  for (const field of view.fields) {
    const fields = grouped.get(field.group) ?? []
    fields.push({ id: field.id, label: safe(field.label),
      description: safe(field.description) + (field.applies === 'restart' ? '（重启后生效）' : ''),
      control: control(field), readonly: field.control === 'readonly' || !view.available || !view.writable,
      changed: view.dirtyIds.includes(field.id), pending: view.pending })
    grouped.set(field.group, fields)
  }
  const groups: SettingsWorkspaceGroup[] = Array.from(grouped, ([id, fields]) => ({ id, title: safe(id), fields }))
  const status = view.pending ? '正在保存…' : view.error ?? view.notice
    ?? (!view.available ? '设置服务暂不可用' : !view.writable ? '只读设置' : view.dirtyCount > 0 ? String(view.dirtyCount) + ' 项更改未保存' : '')
  const persistence = !view.documentBacked && view.available ? ' · 仅当前运行' : ''
  const navigation = view.navigationKeys === 'arrows' ? '↑↓ 移动' : view.navigationKeys === 'vim' ? 'j/k 移动' : '↑↓/jk 移动'
  const modal: SettingsWorkspaceModel['modal'] = view.confirmation ? confirmation(view.confirmation, view.confirmIndex)
    : view.editor ? { kind: 'editor', title: '编辑：' + safe(view.editor.field.label),
      description: safe(view.editor.field.description) + (view.editor.field.control === 'secret' ? ' 留空保持不变。' : ''),
      ...input(view.editor.input, view.editor.field.control === 'secret'),
      ...(view.error ? { error: safe(view.error) } : {}), hint: 'Enter 确认输入   Esc 取消' }
      : view.picker ? { kind: 'picker', title: safe(view.picker.field.label), description: safe(view.picker.field.description),
        options: (view.picker.field.options ?? []).map((option, index) => ({ value: String(index), label: safe(option.label) })),
        selectedIndex: view.picker.selection, hint: navigation.replace('移动', '选择') + '   Enter 确认   Esc / q 取消' } : undefined
  const selectedField = view.fields[Math.max(0, Math.min(view.fields.length - 1, view.selection))]
  return {
    height: Math.max(1, Math.floor(viewport.rows)), header: 'DSH 设置', title: titles[view.section], scope: '用户设置', categories,
    activeCategoryId: view.section, focus: view.focus === 'tabs' ? 'navigation' : view.focus === 'form' ? 'content' : view.focus,
    groups, searchHidden: true, actionIndex: view.actionIndex, dirtyCount: view.dirtyCount, pending: view.pending,
    actions: view.dirtyCount > 0 ? [{ id: 'save', label: '保存', disabled: view.pending }, { id: 'cancel', label: '取消', disabled: view.pending }]
      : [{ id: 'reset', label: '重置设置', disabled: !view.writable || view.pending }],
    writable: view.available && view.writable, message: safe(status + persistence),
    messageTone: view.error ? 'error' : view.dirtyCount > 0 ? 'warning' : 'muted',
    emptyMessage: !view.available ? '设置服务暂不可用' : view.query.text.trim() === '' ? '此分类暂无可用设置' : '没有匹配的设置，请修改搜索内容。',
    help: navigation + '   Enter 修改   Tab 切换   Ctrl+S 保存   q 返回',
    ...(selectedField ? { selectedFieldId: selectedField.id } : {}), ...(modal ? { modal } : {}),
  }
}

export function renderSettingsPageFrame(view: SettingsPageView, viewport: TerminalViewport, options: { readonly deferLayout?: boolean } = {}): UiFrame {
  const bounded = { columns: Math.max(1, Math.floor(viewport.columns)), rows: Math.max(1, Math.floor(viewport.rows)) }
  const model = settingsWorkspaceModel(view, bounded)
  if (options.deferLayout) return { title: '设置', viewport: bounded, lines: [], settingsWorkspace: model }
  const component = new SettingsWorkspace(model)
  const lines = component.render(bounded.columns)
  const cursor = component.getCursor()
  return { title: '设置', viewport: bounded, lines, settingsWorkspace: model, ...(cursor ? { cursor } : {}) }
}
