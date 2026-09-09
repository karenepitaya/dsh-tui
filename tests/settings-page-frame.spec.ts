import { describe, expect, it } from 'vitest'
import { SettingsWorkspace } from 'pi-tui-orbs'
import type { SettingsField, SettingsPageView } from '../src/settings/page-contracts.ts'
import { stripTerminalSequences, visibleWidth } from '../src/terminal/text-layout.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import { renderSettingsPageFrame, settingsPermissionConfirmationFits, settingsWorkspaceModel } from '../src/ui/settings-page-frame.ts'
import { createSettingsWorkspaceTheme } from '../src/ui/settings-workspace-theme.ts'
import { createDshTuiTheme } from '../src/ui/theme.ts'

function field(change: Partial<SettingsField> = {}): SettingsField {
  return { id: 'theme', namespace: 'ui', path: ['theme'], section: 'general', group: '外观',
    label: '主题', description: '选择界面的配色。', control: 'select', value: 'auto',
    overridden: false, applies: 'live', options: [{ label: '自动', value: 'auto' }, { label: '单色', value: 'mono' }], ...change }
}

function view(change: Partial<SettingsPageView> = {}): SettingsPageView {
  return { section: 'general', focus: 'form', fields: [field()], selection: 0, actionIndex: 0,
    query: createPromptEditorState(), dirtyIds: [], dirtyCount: 0, confirmIndex: 0,
    pending: false, writable: true, available: true, documentBacked: true, ...change }
}

function text(current = view(), columns = 120, rows = 40) {
  return renderSettingsPageFrame(current, { columns, rows }).lines.join('\n')
}

function model(current = view()) {
  return settingsWorkspaceModel(current, { columns: 120, rows: 40 })
}

describe('Settings terminal form', () => {
  it('renders Chinese categories, grouped controls, readable help and actual actions', () => {
    const current = view({ dirtyIds: ['motion'], dirtyCount: 1, fields: [field(), field({
      id: 'motion', group: '交互', label: '减少动画', control: 'boolean', value: true, description: '关闭界面中的动画效果。',
    })] })
    const rendered = text(current)
    for (const expected of ['设置', '通用', '模型', '插件', 'Agent', '外观', '交互',
      '主题', '自动', '单色', '开启', '减少动画', '关闭界面中的动画效果。', '保存', '取消', '未保存', 'Ctrl+S', 'Esc', 'q']) expect(rendered).toContain(expected)
    const frame = renderSettingsPageFrame(current, { columns: 120, rows: 40 })
    expect(frame.settingsWorkspace).toMatchObject({ focus: 'content', selectedFieldId: 'theme', dirtyCount: 1,
      groups: [{ title: '外观', fields: [{ control: { kind: 'segmented', value: '0' } }] },
        { title: '交互', fields: [{ changed: true, control: { kind: 'toggle', checked: true, value: '开启' } }] }] })
    expect(frame.lineStyles).toBeUndefined()
    expect(frame.lines.join('')).not.toContain('\x1b')
  })

  it.each([[80, 24], [100, 30], [120, 40], [160, 50], [40, 12]])('follows selected settings at %ix%i', (columns, rows) => {
    const fields = Array.from({ length: 40 }, (_, index) => field({ id: `item-${index}`, label: `设置项 ${index}`, group: `分组 ${Math.floor(index / 5)}` }))
    const frame = renderSettingsPageFrame(view({ fields, selection: 39 }), { columns, rows })
    expect(frame.lines.join('\n')).toContain('设置项 39')
    expect(frame.lines.join('\n')).toContain('重置设置')
    expect(frame.lines.join('\n')).not.toContain('取消')
    expect(frame.lines.join('\n')).toMatch(/恢复默认|重置/)
    expect(frame.settingsWorkspace?.selectedFieldId).toBe('item-39')
    expect(frame.lines.length).toBeLessThanOrEqual(rows)
    for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
  })

  it('masks stored and edited secrets, including errors, without JSON fallbacks', () => {
    const secret = field({ control: 'secret', value: 'stored-sensitive', inheritedValue: 'inherited-sensitive', secretSet: true })
    const current = view({ fields: [secret], editor: { field: secret, input: createPromptEditorState('typed-sensitive') },
      error: 'Cannot store typed-sensitive; old stored-sensitive / inherited-sensitive' })
    const frame = renderSettingsPageFrame(current, { columns: 80, rows: 24 })
    const rendered = frame.lines.join('\n')
    for (const hidden of ['stored-sensitive', 'inherited-sensitive', 'typed-sensitive']) {
      expect(rendered).not.toContain(hidden)
      expect(JSON.stringify(frame.settingsWorkspace)).not.toContain(hidden)
    }
    expect(rendered).toContain('编辑')
    expect(rendered).toContain('取消')
    expect(rendered).toContain('留空保持不变')
    expect(frame.cursor).toBeDefined()
    expect(text(view({ fields: [field({ control: 'readonly', value: { confidential: 'never-dump-object' } })] })))
      .not.toContain('never-dump-object')
  })

  it('makes discard/reset confirmation and cancellation explicit', () => {
    for (const confirmation of ['discard', 'reset'] as const) {
      const frame = renderSettingsPageFrame(view({ confirmation }), { columns: 80, rows: 24 })
      expect(frame.lines.join('\n')).toContain(confirmation === 'discard' ? '放弃' : '恢复默认')
      expect(frame.lines.join('\n')).toContain('取消')
      expect(frame.settingsWorkspace?.modal).toMatchObject({ kind: 'confirmation', selectedIndex: 0,
        actions: [{ id: 'cancel', label: '取消' }, { id: 'confirm' }] })
    }
  })

  it.each([
    ['boolean', false, '关闭'],
    ['number', 42, '42'],
    ['text', '', '空文本'],
    ['readonly', undefined, '未设置（只读）'],
    ['readonly', null, '未设置（只读）'],
    ['readonly', true, 'true（只读）'],
    ['readonly', ['one', 'two'], '2 项（只读）'],
    ['readonly', { private: 'do not print' }, '已配置（只读）'],
  ] as const)('projects %s values as readable controls', (kind, value, expected) => {
    expect(text(view({ fields: [field({ control: kind, value, applies: 'restart' })] }))).toContain(expected)
    expect(text(view({ fields: [field({ control: kind, value, applies: 'restart' })] }))).toContain('重启后生效')
  })

  it('uses a compact choice control for long option lists and unknown current values', () => {
    const options = ['one', 'two', 'three', 'four'].map(value => ({ value, label: `选项 ${value}` }))
    expect(text(view({ fields: [field({ value: 'four', options })] }))).toContain('选项 four')
    expect(model(view({ fields: [field({ value: 'four', options })] })).groups[0]?.fields[0]?.control).toMatchObject({ kind: 'select', value: '3' })
    expect(text(view({ fields: [field({ value: 'missing', options })] }))).toContain('missing')
    expect(text(view({ fields: [field({ value: undefined, options: [] })] }))).toContain('未设置')
    const { options: _options, ...withoutOptions } = field()
    expect(text(view({ fields: [withoutOptions] }))).toContain('auto')
    const long = renderSettingsPageFrame(view({ fields: [field({ options: [{ label: '这是超出控件宽度的很长的选择项', value: 'auto' }] })] }), { columns: 40, rows: 12 })
    expect(long.lines.join('')).toContain('这是超出')
    expect(long.lines.every(line => visibleWidth(line) <= 40)).toBe(true)
  })

  it('never exposes secret values for configured, unset or unknown state', () => {
    for (const secretSet of [true, false, undefined]) {
      const rendered = text(view({ fields: [field({ control: 'secret', ...(secretSet === undefined ? {} : { secretSet }), value: 4, inheritedValue: '' })] }))
      expect(rendered).toContain(secretSet === true ? '•••••• 已设置' : secretSet === false ? '未设置' : '状态未知')
    }
    const secret = field({ control: 'secret', value: undefined })
    const frame = renderSettingsPageFrame(view({ editor: { field: secret, input: createPromptEditorState('') } }), { columns: 40, rows: 12 })
    expect(frame.cursor).toBeDefined()
  })

  it('keeps all categories and each action focus visible in a narrow form', () => {
    for (const section of ['general', 'models', 'plugins', 'presets'] as const) {
      const frame = renderSettingsPageFrame(view({ section, focus: 'tabs' }), { columns: 40, rows: 12 })
      for (const label of ['通用', '模型', '插件', 'Agent 预设']) expect(frame.lines.join('\n')).toContain(label)
      expect(frame.settingsWorkspace).toMatchObject({ focus: 'navigation', activeCategoryId: section })
    }
    for (const actionIndex of [0, 1]) {
      const frame = renderSettingsPageFrame(view({ focus: 'actions', actionIndex, dirtyCount: 1 }), { columns: 40, rows: 12 })
      expect(frame.settingsWorkspace).toMatchObject({ focus: 'actions', actionIndex })
      for (const action of ['保存', '取消']) expect(frame.lines.join('')).toContain(action)
    }
  })

  it('shows service, search, read-only, persistence and save status honestly', () => {
    expect(text(view({ available: false, fields: [] }))).toContain('设置服务暂不可用')
    expect(model(view({ available: false })).groups[0]?.fields[0]?.readonly).toBe(true)
    expect(text(view({ fields: [] }))).toContain('此分类暂无可用设置')
    expect(text(view({ fields: [], query: createPromptEditorState('missing') }))).toContain('没有匹配的设置')
    expect(text(view({ writable: false }))).toContain('只读设置')
    expect(text(view({ documentBacked: false }))).toContain('仅当前运行')
    expect(text(view({ notice: '设置已保存' }))).toContain('设置已保存')
    expect(text(view({ error: '无法保存，请重试' }))).toContain('无法保存，请重试')
    const frame = renderSettingsPageFrame(view({ focus: 'actions', pending: true }), { columns: 80, rows: 24 })
    expect(frame.lines.join('\n')).toContain('正在保存')
    expect(frame.settingsWorkspace).toMatchObject({ pending: true, groups: [{ fields: [{ pending: true }] }] })
    expect(frame.cursor).toBeUndefined()
  })

  it('scrolls the search and edit caret by terminal columns for CJK and graphemes', () => {
    const input = createPromptEditorState('设置👩‍💻é'.repeat(25) + '终点')
    for (const _focus of ['form'] as const) {
      const current = view({ editor: { field: field({ control: 'text' }), input } })
      const frame = renderSettingsPageFrame(current, { columns: 40, rows: 12 })
      expect(frame.lines[frame.cursor!.row]).toContain('终点')
      expect(frame.cursor!.column).toBeGreaterThanOrEqual(0)
      expect(frame.cursor!.column).toBeLessThan(40)
      expect(frame.lines.every(line => visibleWidth(line) <= 40)).toBe(true)
      expect(renderSettingsPageFrame({ ...current, pending: true }, { columns: 40, rows: 12 }).cursor).toBeUndefined()
    }
  })

  it('gives confirmation priority over the editor and highlights either answer', () => {
    for (const confirmIndex of [0, 1]) {
      const frame = renderSettingsPageFrame(view({ confirmation: 'reset', confirmIndex,
        editor: { field: field(), input: createPromptEditorState('should not render') } }), { columns: 40, rows: 12 })
      expect(frame.lines.join('\n')).toContain('当前分类')
      expect(frame.lines.join('\n')).not.toContain('should not render')
      expect(frame.cursor).toBeUndefined()
      expect(frame.lines.some(line => line.includes('取消') && line.includes('恢复默认'))).toBe(true)
      expect(frame.settingsWorkspace?.modal).toMatchObject({ kind: 'confirmation', selectedIndex: confirmIndex })
    }
    const frame = renderSettingsPageFrame(view({ confirmation: 'discard', pending: true }), { columns: 40, rows: 12 })
    expect(frame.settingsWorkspace?.pending).toBe(true)
    expect(frame.cursor).toBeUndefined()
  })

  it('keeps a bounded active surface even at one cell and short terminal heights', () => {
    const secret = field({ control: 'secret' })
    const cases = [view(), view({ fields: [] }), view({ focus: 'search' }), view({ focus: 'tabs' }),
      view({ focus: 'actions', actionIndex: 2 }), view({ confirmation: 'discard' }),
      view({ editor: { field: secret, input: createPromptEditorState('private') } })]
    for (const current of cases) for (const size of [1, 2, 4, 7]) {
      const frame = renderSettingsPageFrame(current, { columns: size, rows: size })
      expect(frame.lines.length).toBeLessThanOrEqual(size)
      expect(frame.lines.every(line => visibleWidth(line) <= size)).toBe(true)
      if (frame.cursor) {
        expect(frame.cursor.row).toBeLessThan(size)
        expect(frame.cursor.column).toBeLessThan(size)
      }
      expect(JSON.stringify(frame.settingsWorkspace)).not.toContain('private')
    }
    expect(renderSettingsPageFrame(view(), { columns: 0, rows: 0 }).viewport).toEqual({ columns: 1, rows: 1 })
  })

  it('strips terminal control sequences and keeps focus when selection is outside the list', () => {
    const fields = [field({ label: '\x1b[31m中文\x1b[0m\n👩‍💻', description: '说明\t可读' }), field({ id: 'last', label: '最后一项' })]
    const first = text(view({ fields, selection: -1 }), 80, 24)
    expect(first).toContain('中文 👩‍💻')
    expect(first).toContain('说明 可读')
    expect(first).not.toContain('\x1b')
    const last = renderSettingsPageFrame(view({ fields, selection: 1000 }), { columns: 80, rows: 24 })
    expect(last.settingsWorkspace?.selectedFieldId).toBe('last')
    expect(last.lines.join('')).toContain('最后一项')
    expect(text()).not.toContain('Ctrl+O 高级')
  })

  it('delegates neutral layout and styled rendering to the same real SettingsWorkspace component', () => {
    const theme = createDshTuiTheme({}, { colorSupported: true, noColor: false, dumbTerminal: false, colorLevel: 'truecolor' })
    const frame = renderSettingsPageFrame(view(), { columns: 100, rows: 30 })
    expect(frame.lines).toHaveLength(30)
    const component = new SettingsWorkspace(frame.settingsWorkspace!, createSettingsWorkspaceTheme(theme))
    const painted = component.render(100)
    expect(painted.map(stripTerminalSequences)).toEqual(frame.lines)
    for (const line of painted) expect(visibleWidth(line)).toBe(100)
    expect(painted.join('')).toContain('\x1b[48;2;')
    expect(frame.styleSpans).toBeUndefined()
    expect(renderSettingsPageFrame(view(), { columns: 80, rows: 6 }).lines).toHaveLength(6)
  })

  it('spaces wide fields and retains the selected explanation and long recovery advice', () => {
    const explanation = '这里是一段较长的说明，用于解释这个选项何时生效以及如何影响当前工作。'.repeat(3) + '完整说明终点'
    const error = '保存时发生冲突。'.repeat(15) + '请重新打开设置后再试。'
    const frame = renderSettingsPageFrame(view({ fields: [field({ description: explanation }), field({ id: 'other', label: '另一个设置' })], error }), { columns: 100, rows: 30 })
    const rendered = frame.lines.join('\n')
    expect(rendered).toContain('完整说明终点')
    expect(rendered.replace(/\s/g, '')).toContain('请重新打开设置后再试。')
    const next = frame.lines.findIndex(line => line.includes('另一个设置'))
    expect(next).toBeGreaterThan(frame.lines.findIndex(line => line.includes('完整说明终点')))
    expect(frame.lines.length).toBe(30)
    expect(frame.lines.every(line => visibleWidth(line) <= 100)).toBe(true)
    expect(rendered).not.toContain('\x1b')
  })

  it('redacts raw secret errors before removing control sequences, including an editor outside the filtered list', () => {
    const secret = field({ control: 'secret', value: 'stored\u001b[31msecret', inheritedValue: 'inherited-value' })
    const rendered = text(view({ fields: [], editor: { field: secret, input: createPromptEditorState('typed\tsecret') },
      error: 'stored\u001b[31msecret / inherited-value / typed\tsecret' }))
    for (const value of ['stored', 'inherited-value', 'typed', '\x1b']) expect(rendered).not.toContain(value)
  })

  it('projects a picker as indexed labels without exposing raw option values or terminal sequences', () => {
    const sensitive = field({ control: 'secret', value: 'hidden-token', inheritedValue: 'inherited-token' })
    const choice = field({ label: '\x1b[31m模型\x1b[0m', description: '选择 hidden-token',
      options: [{ label: '服务 inherited-token', value: { credential: 'never-copy-option-value' } }, { label: '模型\n二', value: 'second' }] })
    const frame = renderSettingsPageFrame(view({ fields: [sensitive], picker: { field: choice, selection: 1 } }), { columns: 80, rows: 24 })
    expect(frame.settingsWorkspace?.modal).toEqual({ kind: 'picker', title: '模型', description: '选择 ••••',
      options: [{ value: '0', label: '服务 ••••' }, { value: '1', label: '模型 二' }], selectedIndex: 1,
      hint: '↑↓/jk 选择   Enter 确认   Esc / q 取消' })
    for (const hidden of ['hidden-token', 'inherited-token', 'never-copy-option-value', '\x1b']) {
      expect(JSON.stringify(frame.settingsWorkspace)).not.toContain(hidden)
      expect(frame.lines.join('')).not.toContain(hidden)
    }
    for (const label of ['模型 二', '服务 ••••', 'Enter', 'q']) expect(frame.lines.join('')).toContain(label)
    expect(frame.cursor).toBeUndefined()
    const { options: _options, ...emptyChoice } = choice
    expect(model(view({ picker: { field: emptyChoice, selection: 0 } })).modal).toMatchObject({ options: [] })
  })

  it('converts grapheme cursors for the component and masks each secret grapheme once', () => {
    const input = { ...createPromptEditorState('设置👩‍💻éq'), cursor: 3 }
    expect(model(view({ focus: 'search', query: input })).search).toBeUndefined()
    expect(model(view({ editor: { field: field({ control: 'text' }), input } })).modal)
      .toMatchObject({ kind: 'editor', text: input.text, cursor: '设置👩‍💻'.length })
    const secretInput = { ...createPromptEditorState('密👩‍💻é'), cursor: 2 }
    expect(model(view({ editor: { field: field({ control: 'secret' }), input: secretInput } })).modal)
      .toMatchObject({ kind: 'editor', text: '•••', cursor: 2 })
  })

  it('shows the full-access warning and default cancellation before saving at common widths', () => {
    for (const [columns, rows] of [[40, 12], [80, 24], [100, 30], [120, 40], [160, 50]]) {
      const frame = renderSettingsPageFrame(view({ confirmation: 'permission' }), { columns: columns!, rows: rows! })
      const rendered = frame.lines.join('').replace(/[│\s]/g, '')
      expect(rendered).toContain('允许新会话使用完全访问权限？')
      expect(rendered).toContain('新会话可访问工作目录外的文件并运行命令。')
      const confirmRow = frame.lines.findIndex(line => line.includes('确认保存'))
      expect(frame.lines[confirmRow]).toContain('取消')
      expect(frame.settingsWorkspace?.modal).toMatchObject({ selectedIndex: 0, actions: [{ id: 'cancel' }, { id: 'confirm' }] })
    }
  })

  it('shares an exact permission budget with input guards and keeps confirmation actions unique', () => {
    expect(settingsPermissionConfirmationFits({ columns: 80, rows: 6 })).toBe(false)
    expect(settingsPermissionConfirmationFits({ columns: 1, rows: 100 })).toBe(false)
    expect(settingsPermissionConfirmationFits({ columns: 40, rows: 12 })).toBe(true)
    expect(settingsPermissionConfirmationFits({ columns: 21, rows: 100 })).toBe(false)
    for (const columns of [40, 80, 120]) {
      const rows = Array.from({ length: 20 }, (_, index) => index + 1).find(rows => settingsPermissionConfirmationFits({ columns, rows }))!
      expect(settingsPermissionConfirmationFits({ columns, rows: rows - 1 })).toBe(false)
      const frame = renderSettingsPageFrame(view({ confirmation: 'permission', error: '恢复说明'.repeat(80) }), { columns, rows })
      const rendered = frame.lines.join('').replace(/[│\s]/g, '')
      expect(rendered).toContain('允许新会话使用完全访问权限？')
      expect(rendered).toContain('新会话可访问工作目录外的文件并运行命令。')
      expect(rendered).toContain('取消')
      expect(rendered).toContain('确认保存')
      expect(rendered.match(/确认保存/g)).toHaveLength(1)
      expect(rendered).not.toContain('保存更改')
      expect(rendered).not.toContain('恢复默认')
      expect(frame.settingsWorkspace?.modal).toMatchObject({ actions: [{ id: 'cancel' }, { id: 'confirm' }] })
    }
    const tiny = text(view({ confirmation: 'permission' }), 80, 6)
    expect(tiny).toContain('请放大终端')
    expect(tiny).toContain('取消')
    expect(tiny).not.toContain('确认保存')
  })

  it('matches navigation preferences while confirmation keeps arrow keys', () => {
    for (const navigationKeys of ['arrows', 'vim', 'both'] as const) {
      const rendered = text(view({ navigationKeys }), 80, 24)
      expect(rendered).toContain(navigationKeys === 'arrows' ? '↑↓ 移动'
        : navigationKeys === 'vim' ? 'j/k 移动' : '↑↓/jk 移动')
      expect(rendered).not.toContain('Ctrl+O 高级')
      expect(text(view({ navigationKeys, confirmation: 'permission' }), 40, 12)).toContain('←→ 选择')
      const picker = view({ navigationKeys, picker: { field: field(), selection: 0 } })
      expect(text(picker, 80, 24)).toContain(navigationKeys === 'arrows' ? '↑↓ 选择'
        : navigationKeys === 'vim' ? 'j/k 选择' : '↑↓/jk 选择')
      expect(text(picker, 80, 24)).toContain('Esc / q 取消')
    }
  })
})
it.each([80, 120])('uses category navigation without a duplicate content title at %s columns', columns => {
  for (const section of ['general', 'models', 'plugins', 'presets'] as const) {
    const rendered = text(view({ section }), columns)
    expect(rendered).not.toMatch(/外观与交互|插件设置/)
    expect(rendered.match(/模型与服务/g)).toHaveLength(1)
    expect(rendered.match(/Agent 预设/g)).toHaveLength(1)
    expect(rendered).toContain('外观')
    expect(rendered).toContain('选择界面的配色。')
    expect(rendered).toContain('重置设置')
  }
})
