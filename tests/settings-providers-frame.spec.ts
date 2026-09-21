import { describe, expect, it } from 'vitest'
import { FormWorkspace } from 'pi-tui-orbs'
import type { SettingsPageView } from '../src/settings/page-contracts.ts'
import type { SettingsProvidersView } from '../src/settings/providers-controller.ts'
import { visibleWidth, stripTerminalSequences } from '../src/terminal/text-layout.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import { renderSettingsProvidersFrame, settingsProviderConfirmationFits, settingsProvidersWorkspaceModel } from '../src/ui/settings-providers-frame.ts'
import { createFormWorkspaceTheme } from '../src/ui/form-workspace-theme.ts'
import { createDshTuiTheme } from '../src/ui/theme.ts'

const page: SettingsPageView = { section: 'models', focus: 'form', fields: [], selection: 0, actionIndex: 0,
  query: createPromptEditorState(), dirtyIds: [], dirtyCount: 0, confirmIndex: 0, pending: false,
  writable: true, available: true, documentBacked: true }
const current = (change: Partial<SettingsProvidersView> = {}): SettingsProvidersView => ({
  providers: [{ id: 'service', name: '示例服务', configured: true, active: true, connected: true,
    credential: { kind: 'api-key', configured: true, writable: true, source: 'PRIVATE_ENV_NAME' }, canDisconnect: true,
    methods: [{ id: 'key', label: '密钥' }], models: [{ id: 'chat', name: '对话模型' }] }], directory: [],
  selection: 0, query: createPromptEditorState(), defaultModel: '示例服务 / 对话模型', defaultWritable: true,
  loading: false, busy: false, writable: true, ...change,
})

describe('Settings providers frame', () => {
  it('uses a grouped management form with editable fields, a primary test button and separate destructive actions', () => {
    const view = current({ selectedProvider: current().providers[0]!, dialog: { kind: 'manage', title: '示例服务', selection: 4,
      description: '不应重复显示的凭据说明', rows: [
        { id: 'credentials', label: 'API 密钥', group: '连接配置' },
        { id: 'name', label: '显示名称', value: '示例\x1b[2J服务', group: '连接配置' },
        { id: 'baseURL', label: '服务地址', value: 'https://example.test/v1', group: '连接配置', disabled: true },
        { id: 'model', label: '测试模型', value: 'Chat', group: '连接测试' },
        { id: 'test', label: '测试连接', group: '连接测试' },
        { id: 'advanced', label: '高级设置', group: '更多操作' },
        { id: 'disconnect', label: '断开连接', group: '更多操作' },
        { id: 'remove', label: '重置服务配置', group: '更多操作' },
      ] } })
    const modal = settingsProvidersWorkspaceModel(view, page, { columns: 100, rows: 28 }).modal
    expect(modal?.kind).toBe('form')
    if (modal?.kind !== 'form') throw new Error('Management must use the framework form')
    expect(modal.groups.map(group => group.title)).toEqual(['连接配置', '连接测试', '更多操作'])
    expect(modal.groups[0]!.fields).toMatchObject([
      { control: { kind: 'action', value: '更换' }, badge: '已配置', tone: 'success' },
      { label: '显示名称', control: { kind: 'text', value: '示例服务' } },
      { control: { kind: 'text', value: 'https://example.test/v1' }, readonly: true },
    ])
    expect(modal.groups[1]!.fields).toMatchObject([
      { control: { kind: 'select', value: 'Chat' } }, { control: { kind: 'action', value: '测试连接' }, intent: 'primary' },
    ])
    expect(modal.groups[2]!.fields.slice(1).map(field => field.intent)).toEqual(['danger', 'danger'])
    expect(modal.selectedFieldId).toBe('test')
    expect(JSON.stringify(modal)).not.toContain('不应重复显示')
    expect(modal.hint).toContain('t 测试')
  })

  it.each([
    ['running', 'accent'], ['success', 'success'], ['error', 'error'], ['warning', 'warning'], ['cancelled', 'warning'],
  ] as const)('anchors %s test feedback to the button without repeating a generic notice', (state, tone) => {
    const view = current({ busy: state === 'running', notice: '旧提示不可重复', testFeedback: { state, title: '醒目结果', detail: '测试\x1b[2J细节' },
      dialog: { kind: 'manage', title: '服务', rows: [{ id: 'test', label: '测试连接', group: '连接测试' }], selection: 0 } })
    const modal = settingsProvidersWorkspaceModel(view, page, { columns: 80, rows: 24 }).modal
    expect(modal).toMatchObject({ kind: 'form', selectedFieldId: 'test', pending: state === 'running',
      feedback: { afterFieldId: 'test', title: '醒目结果', detail: '测试细节', tone } })
    expect(JSON.stringify(modal)).not.toContain('旧提示不可重复')
    expect(modal?.hint).toContain(state === 'running' ? 'Esc 取消测试' : 't 测试')
  })

  it('shows truthful authentication controls and handles unavailable providers and safe local errors', () => {
    for (const kind of ['oauth', 'ambient'] as const) {
      const provider = { ...current().providers[0]!, credential: { kind, configured: false, writable: true } }
      const modal = settingsProvidersWorkspaceModel(current({ selectedProvider: provider, error: '读取失败', dialog: {
        kind: 'manage', title: '服务', selection: 0, rows: [{ id: 'credentials', label: '配置凭据', description: '认证方式由服务提供' }],
      } }), page, { columns: 80, rows: 24 }).modal
      expect(modal).toMatchObject({ kind: 'form', message: '读取失败', messageTone: 'error', groups: [{ title: '连接配置', fields: [{
        label: kind === 'oauth' ? '账号授权' : '服务认证', control: { kind: 'action', value: '配置' }, description: '认证方式由服务提供',
      }] }] })
    }
    const empty = settingsProvidersWorkspaceModel(current({ testFeedback: { state: 'cancelled', title: '测试已取消' }, dialog: {
      kind: 'manage', title: '提供商暂不可用', selection: 0, rows: [],
    } }), page, { columns: 40, rows: 12 }).modal
    expect(empty).toMatchObject({ kind: 'form', groups: [], feedback: { title: '测试已取消' } })
    expect(empty && 'selectedFieldId' in empty ? empty.selectedFieldId : undefined).toBeUndefined()
    for (const error of ['只读配置不可修改', '测试失败']) {
      const result = settingsProvidersWorkspaceModel(current({ error, testFeedback: { state: 'error', title: '连接测试失败', detail: '测试失败' },
        dialog: { kind: 'manage', title: '服务', rows: [], selection: 0 },
      }), page, { columns: 80, rows: 24 }).modal
      expect(result && 'message' in result ? result.message : undefined).toBe(error === '测试失败' ? undefined : error)
    }
  })

  it('wraps destructive consequences and shares the fail-closed confirmation budget', () => {
    expect(settingsProviderConfirmationFits(current(), { columns: 1, rows: 1 })).toBe(true)
    for (const kind of ['confirm-disconnect', 'confirm-discard'] as const) {
      const view = current({ dialog: { kind, title: '重置服务配置？',
        description: '保留已保存的密钥；恢复原始配置，无原始配置的服务将移除。', selection: 1,
        rows: [{ id: 'cancel', label: '取消' }, { id: 'confirm', label: '确认' }] } })
      const model = settingsProvidersWorkspaceModel(view, page, { columns: 40, rows: 12 })
      expect(model.modal).toMatchObject({ kind: 'confirmation', selectedIndex: 1, actions: [{ id: 'cancel' }, { id: 'confirm' }] })
      expect(settingsProviderConfirmationFits(view, { columns: 40, rows: 12 })).toBe(true)
      expect(settingsProviderConfirmationFits(view, { columns: 80, rows: 6 })).toBe(false)
      const text = renderSettingsProvidersFrame(view, page, { columns: 40, rows: 12 }).lines.join('').replace(/[│\s]/gu, '')
      expect(text).toContain('保留已保存的密钥；恢复原始配置，无原始配置的服务将移除。')
      expect(renderSettingsProvidersFrame(view, page, { columns: 80, rows: 6 }).lines.join('')).toContain('Enlarge the terminal')
    }
    const noDescription = settingsProvidersWorkspaceModel(current({ dialog: { kind: 'confirm-discard', title: '确认', rows: [], selection: 0 } }), page, { columns: 80, rows: 24 })
    expect(noDescription.modal).toMatchObject({ kind: 'confirmation', lines: [] })
  })
  it('separates provider badges from keyboard focus and removes repeated subtitles and shortcut labels', () => {
    const configured = current().providers[0]!
    const model = settingsProvidersWorkspaceModel(current({ defaultProviderId: 'default-service', providers: [
      configured, { ...configured, id: 'default-service' },
      { ...configured, id: 'pending', credential: { kind: 'missing', configured: false, writable: true } },
    ] }), page, { columns: 120, rows: 36 })
    expect(model.headerAction?.label).toBe('＋ 添加提供商')
    const fields = model.groups[0]!.fields
    expect(fields[0]!.description).toBeUndefined()
    expect(fields.slice(2)).toMatchObject([
      { badge: '已配置 · 1 个模型', tone: 'success' }, { badge: '当前默认 · 1 个模型', tone: 'accent' }, { id: 'provider:pending' },
    ])
    expect(fields[4]!.badge).toBe('待配置 · 1 个模型')
    expect(fields[1]!.control.value).not.toContain('已配置')
    const grouped = settingsProvidersWorkspaceModel(current({ dialog: { kind: 'default-model', title: '新会话默认模型', selection: 0,
      rows: [{ id: 'service/chat', label: '对话模型', group: '示例服务', badge: '当前默认', tone: 'accent' },
        { id: 'other/chat', label: '对话模型', group: '其他服务', badge: '已配置', tone: 'success' }] } }), page, { columns: 80, rows: 24 })
    expect(grouped.modal).toMatchObject({ rows: [
      { group: '示例服务', label: '对话模型', badge: '当前默认', tone: 'accent' },
      { group: '其他服务', label: '对话模型', badge: '已配置', tone: 'success' },
    ] })
  })
  it.each([[40, 12], [80, 24], [160, 40]])('renders compact configured rows without schema or save chrome at %sx%s', (columns, rows) => {
    const view = current()
    const frame = renderSettingsProvidersFrame(view, page, { columns, rows })
    const text = frame.lines.join('\n')
    for (const label of ['新会话默认模型', '示例服务', '添加提供商']) expect(text).toContain(label)
    for (const absent of ['保存更改', '恢复默认', '所有更改已保存', 'supports', 'PRIVATE_ENV_NAME']) expect(JSON.stringify(frame)).not.toContain(absent)
    expect(frame.formWorkspace?.groups).toHaveLength(1)
    expect(frame.lines).toHaveLength(rows)
    expect(frame.lines.every(line => visibleWidth(line) <= columns)).toBe(true)
  })

  it('keeps empty, loading, error, notice, settings focus and missing model counts explicit', () => {
    for (const focus of ['tabs', 'form', 'actions', 'search'] as const) {
      const model = settingsProvidersWorkspaceModel(current({ providers: [], selection: -1 }), { ...page, focus }, { columns: 80, rows: 24 })
      expect(model.focus).toBe(focus === 'tabs' ? 'navigation' : focus === 'actions' ? 'actions' : 'content')
      expect(model.message).toContain('添加模型服务')
    }
    expect(settingsProvidersWorkspaceModel(current({ loading: true }), page, { columns: 80, rows: 24 }).message).toContain('正在加载')
    expect(settingsProvidersWorkspaceModel(current({ error: '失败\x1b[31m\n', notice: 'should-not-show' }), page, { columns: 80, rows: 24 }))
      .toMatchObject({ message: '失败 ', messageTone: 'error' })
    expect(settingsProvidersWorkspaceModel(current({ notice: '更新完成' }), page, { columns: 80, rows: 24 }).message).toBe('更新完成')
    const provider = current().providers[0]!
    const { models: _models, ...withoutModels } = provider
    const rendered = renderSettingsProvidersFrame(current({ selection: 99, providers: [{ ...withoutModels,
      credential: { kind: 'missing', configured: false, writable: true } }] }), page, { columns: 80, rows: 24 })
    expect(rendered.formWorkspace?.selectedFieldId).toBe('provider:service')
    expect(rendered.lines.join('')).toContain('配置')
    expect(rendered.lines.join('')).toContain('0 个模型')
  })

  it('renders directory search in the centered dialog with CJK and emoji caret', () => {
    const query = { ...createPromptEditorState('服务👩‍💻q'), cursor: 3 }
    const view = current({ query, dialog: { kind: 'directory', title: '添加提供商', selection: 0, rows: [
      { id: 'fixture', label: '服务', value: '添加', description: '服务说明', disabled: true }, { id: 'custom', label: '自定义兼容服务' },
    ] } })
    const model = settingsProvidersWorkspaceModel(view, page, { columns: 80, rows: 24 })
    expect(model.modal).toMatchObject({ kind: 'dialog', search: { text: query.text, cursor: '服务👩‍💻'.length, placeholder: '搜索提供商…' }, searchFocused: true })
    const frame = renderSettingsProvidersFrame(view, page, { columns: 80, rows: 24 })
    expect(frame.cursor).toBeDefined()
    for (const label of ['添加提供商', '服务说明', '输入搜索', '自定义兼容服务']) expect(frame.lines.join('')).toContain(label)
  })

  it.each([[40, 12], [80, 24], [160, 40]])('keeps the selected management action, result and return hint visible at %sx%s', (columns, rows) => {
    const view = current({ notice: '测试通过（32 ms）。', dialog: { kind: 'manage', title: '特别长的提供商名称'.repeat(5),
      description: '凭据已配置；可用性以显式测试结果为准。', selection: 19,
      rows: Array.from({ length: 20 }, (_, index) => ({ id: String(index), label: index === 19 ? '测试连接' : '提供商配置项 ' + index })) } })
    const frame = renderSettingsProvidersFrame(view, page, { columns, rows })
    const text = frame.lines.join('\n')
    expect(text).toContain('测试连接')
    expect(text).toContain('测试通过')
    expect(text).toContain('Esc')
    expect(text).toContain('q 返回')
    expect(frame.lines.every(line => visibleWidth(line) <= columns)).toBe(true)
  })

  it('projects editors, working cancellation, choice hints and errors without serialized provider details', () => {
    const authorization = settingsProvidersWorkspaceModel(current({ notice: '认证服务已就绪', dialog: {
      kind: 'authorization', title: '配置凭据', description: '选择账号授权方式', selection: 0,
      rows: [{ id: 'account', label: '账号授权' }],
    } }), page, { columns: 80, rows: 24 })
    expect(authorization.modal).toMatchObject({ kind: 'dialog', description: '选择账号授权方式', message: '认证服务已就绪', messageTone: 'muted' })
    for (const navigationKeys of ['arrows', 'vim', 'both'] as const) {
      const view = current({ dialog: { kind: 'models', title: '选择模型', rows: [], selection: 0 } })
      const model = settingsProvidersWorkspaceModel(view, { ...page, navigationKeys }, { columns: 80, rows: 24 })
      expect(model.modal?.hint).toContain(navigationKeys === 'arrows' ? '↑↓ 选择' : navigationKeys === 'vim' ? 'j/k 选择' : '↑↓/jk 选择')
    }
    const working = settingsProvidersWorkspaceModel(current({ busy: true, dialog: { kind: 'working', title: '正在测试连接…', rows: [], selection: 0 } }), page, { columns: 80, rows: 24 })
    expect(working.modal?.hint).toBe('Esc 取消')
    for (const error of [undefined, '输入有误']) for (const description of [undefined, '凭据输入']) {
      const frame = renderSettingsProvidersFrame(current({ ...(error ? { error } : {}), dialog: { kind: 'authorization', title: '配置凭据', rows: [], selection: 0,
        ...(description ? { description } : {}), editor: createPromptEditorState('••••') } }), page, { columns: 80, rows: 24 })
      expect(frame.cursor).toBeDefined()
      expect(frame.lines.join('')).toContain('••••')
      expect(JSON.stringify(frame)).not.toContain('PRIVATE_ENV_NAME')
    }
    const noSearchFocus = settingsProvidersWorkspaceModel(current({ dialog: { kind: 'directory', title: '服务', rows: [], selection: 0, searchFocused: false } }), page, { columns: 80, rows: 24 })
    expect(noSearchFocus.modal).toMatchObject({ searchFocused: false })
  })

  it('uses the shared theme and bounds every line including tiny terminals', () => {
    const theme = createDshTuiTheme({ preset: 'mono' }, { colorSupported: false, noColor: true, dumbTerminal: false, colorLevel: 'mono' })
    for (const [columns, rows] of [[0, 0], [1, 1], [40, 12], [80, 24], [160, 40]]) {
      const frame = renderSettingsProvidersFrame(current(), page, { columns: columns!, rows: rows! })
      const component = new FormWorkspace(frame.formWorkspace!, createFormWorkspaceTheme(theme))
      const styled = component.render(Math.max(1, columns!))
      expect(styled.map(stripTerminalSequences)).toEqual(frame.lines)
      expect(styled.join('')).not.toMatch(/\x1b\[(?:38|48);/)
      expect(frame.lines.every(line => visibleWidth(line) <= Math.max(1, columns!))).toBe(true)
    }
  })

  it('keeps other Settings category drafts and failures visible, including a dialog error', () => {
    for (const changed of [{ notice: '先保存其他分类' }, { error: '设置冲突' }, { dirtyCount: 2 }]) {
      const model = settingsProvidersWorkspaceModel(current(), { ...page, ...changed }, { columns: 80, rows: 24 })
      expect(model.message).toBe(changed.notice ?? changed.error ?? '其他分类有未保存更改。')
    }
    const model = settingsProvidersWorkspaceModel(current({ error: '目录失败', dialog: { kind: 'directory', title: '服务', rows: [], selection: 0 } }), page, { columns: 80, rows: 24 })
    expect(model.modal).toMatchObject({ messageTone: 'error', message: '目录失败' })
  })
})


it('shows only creation actions in the custom provider form', () => {
  const provider = current({ dialog: { kind: 'custom', title: '自定义兼容服务', selection: 0, rows: [
    { id: 'displayName', label: '显示名称', value: 'My service' },
    { id: 'baseURL', label: '服务地址', value: 'https://example.test/v1' },
    { id: 'create', label: '添加并配置凭据' },
  ] } })
  const saving = settingsProvidersWorkspaceModel(current({ notice: '更改尚未保存。' }), { ...page, pending: true }, { columns: 120, rows: 30 })
  expect(saving.pending).toBe(true)
  expect(saving.message).toBe('正在保存…')
  for (const columns of [40, 120]) {
    const frame = renderSettingsProvidersFrame(provider, page, { columns, rows: 30 })
    expect(frame.lines.join('\n')).toContain('添加并配置凭据')
    expect(frame.lines.join('\n')).not.toMatch(/重置设置|Ctrl\+S|\[ 添加/)
    expect(frame.formWorkspace?.modal?.kind).toBe('form')
  }
})
it.each([80, 160])('opens provider management as an independent page at %s columns', columns => {
  const view = current({ dialog: { kind: 'manage', title: '示例服务', selection: 0, rows: [{ id: 'test', label: '测试连接' }] } })
  const frame = renderSettingsProvidersFrame(view, page, { columns, rows: 24 })
  const text = stripTerminalSequences(frame.lines.join('\n'))
  expect(text).toContain('示例服务 · 管理')
  expect(text).toContain('返回模型与服务')
  expect(text).not.toMatch(/重置设置|Agent 预设|DSH 设置/)
  expect(frame.formWorkspace?.actions).toEqual([])
  const dirty = renderSettingsProvidersFrame(view, { ...page, dirtyCount: 1 }, { columns, rows: 24 })
  expect(stripTerminalSequences(dirty.lines.join('\n'))).toMatch(/保存.*取消/)
})
