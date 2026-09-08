import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- the standalone E2E script intentionally has no public declaration file
import { assertSettingsManageForm, assertSettingsTestFeedback, assertSettingsDialogChrome, assertSettingsModelGroup, settingsProviderBadgeStyle, assertSuccessfulMockResult, commandSearchLineVisible, composerPromptLines, isProviderTestRequest, moveSelectionTo, settingsPickerSelected, settingsProviderDialogSelected, settingsViewportReady, startPty, startStandardToolchainMock, waitForScreen, workspaceViewportReady } from '../scripts/official-dsh-e2e.mjs'
import { renderSettingsPageFrame } from '../src/ui/settings-page-frame.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import type { SettingsPageView } from '../src/settings/page-contracts.ts'

const execFileAsync = promisify(execFile)
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

function settingsView(): SettingsPageView {
  return { section: 'general', focus: 'form', selection: 0, actionIndex: 0,
    query: createPromptEditorState('主题'), dirtyIds: [], dirtyCount: 0, confirmIndex: 0,
    pending: false, writable: true, available: true, documentBacked: true, fields: [{
      id: 'theme', namespace: 'dsh-tui', path: ['theme', 'preset'], section: 'general', group: '外观',
      label: '主题', description: '终端配色；自动根据终端颜色能力选择，单色保留文字层级。', control: 'select',
      value: 'auto', overridden: false, applies: 'live',
      options: [{ label: '自动', value: 'auto' }, { label: 'Cordis', value: 'cordis' }, { label: '单色', value: 'mono' }],
    }] }
}

function terminalFixture(env: Record<string, string> = {}, options: { trueColor?: boolean } = {}) {
  const output = new EventEmitter()
  const writes: string[] = []
  const pty = {
    write: (data: string) => { writes.push(data); output.emit('input', data) },
    onData: (listener: (data: string) => void) => {
      output.on('data', listener)
      return { dispose: () => { output.off('data', listener) } }
    },
    onExit: () => ({ dispose: () => {} }),
  }
  let spawnedEnv: Record<string, string> = {}
  const state = startPty({ spawn: (_file: string, _args: string[], spawnOptions: { env: Record<string, string> }) => {
    spawnedEnv = spawnOptions.env
    return pty
  } }, Terminal, '/fixture/preload.mjs', '/fixture/cli.mjs', '/fixture', env, undefined, options)
  const deliver = async (data: string) => {
    const drained = new Promise<void>(resolve => { state.events.once('parser-drain', resolve) })
    output.emit('data', data)
    await drained
    // Drain the waiting predicate's Promise continuation, without advancing time.
    await Promise.resolve()
  }
  const frame = (selection: string) => deliver(`\x1b[?2026h\x1b[H\x1b[2J${selection}\x1b[?2026l`)
  const nextInput = () => new Promise<string>(resolve => { output.once('input', resolve) })
  return { state, writes, spawnedEnv, deliver, frame, nextInput, dispose: () => state.terminal.dispose() }
}

describe('official E2E screen synchronization', () => {
  it('enables color only for the explicit lane by deleting NO_COLOR, including an empty value', () => {
    for (const noColor of ['', '1']) {
      const env = { NO_COLOR: noColor, FORCE_COLOR: '0', COLORTERM: 'ansi', DSH_HOME: '/isolated' }
      const colored = terminalFixture(env, { trueColor: true })
      const inherited = terminalFixture(env)
      try {
        expect(colored.spawnedEnv).not.toHaveProperty('NO_COLOR')
        expect(colored.spawnedEnv).toMatchObject({ FORCE_COLOR: '3', COLORTERM: 'truecolor', DSH_HOME: '/isolated' })
        expect(inherited.spawnedEnv).toEqual(env)
        expect(env).toEqual({ NO_COLOR: noColor, FORCE_COLOR: '0', COLORTERM: 'ansi', DSH_HOME: '/isolated' })
      } finally { colored.dispose(); inherited.dispose() }
    }
  })

  it('requires complete successful SSE output rather than an incidental client close', () => {
    expect(() => assertSuccessfulMockResult({ attempt: 2, outcome: 'completed', chunksSent: 4 }, '答🙂')).not.toThrow()
    for (const outcome of ['client_closed', 'reset', 'stalled', 'server_error']) {
      expect(() => assertSuccessfulMockResult({ attempt: 2, outcome, chunksSent: 4 }, '答🙂')).toThrow()
    }
    for (const chunksSent of [0, 1, 2, 3, 5]) {
      expect(() => assertSuccessfulMockResult({ attempt: 2, outcome: 'completed', chunksSent }, '答🙂')).toThrow()
    }
  })

  it('does not accept a matching partial VT frame before its split end marker', async () => {
    const fixture = terminalFixture()
    try {
      await fixture.frame('old frame')
      let settled = false
      const waiting = waitForScreen(fixture.state, (_lines: string[], text: string) => text.includes('target'), 'split frame', 1_000)
        .then(() => { settled = true })
      await fixture.deliver('\x1b[?2026h\x1b[Htarget\x1b[K')
      expect(settled).toBe(false)
      await fixture.deliver('\x1b[?2026')
      expect(settled).toBe(false)
      await fixture.deliver('l')
      await waiting
      expect(settled).toBe(true)
    } finally { fixture.dispose() }
  })

  it('does not count a resized description of the same selected mode as another Down', async () => {
    const fixture = terminalFixture()
    try {
      await fixture.frame('› 标准模式 [standard] · short')
      const firstDown = fixture.nextInput()
      const moving = moveSelectionTo(fixture.state, '极简模式', 'minimal mode', 1_000)
      await firstDown
      await fixture.frame('› 标准模式 [standard] · a longer description after resize')
      expect(fixture.writes).toEqual(['\x1b[B'])
      const secondDown = fixture.nextInput()
      await fixture.frame('› 标准模式 [standard]\r\n› PTC 模式 [code]')
      expect(fixture.writes).toEqual(['\x1b[B'])
      await fixture.frame('› PTC 模式 [code] · code tools')
      await secondDown
      expect(fixture.writes).toEqual(['\x1b[B', '\x1b[B'])
      await fixture.frame('› 极简模式 [minimal] · minimal tools')
      await moving
      expect(fixture.writes).toEqual(['\x1b[B', '\x1b[B'])
    } finally { fixture.dispose() }
  })

  it('requires body geometry to reach the new viewport after the outer frame has resized', async () => {
    const fixture = terminalFixture()
    try {
      fixture.state.terminal.resize(100, 6)
      const frame = (body: string) => fixture.frame(`MODES${' '.repeat(95)}\r\n${body}\x1b[6;1HEsc back${' '.repeat(92)}`)
      const baseline = fixture.state.completedFrames
      await frame(`模式${' '.repeat(76)}`)
      expect(workspaceViewportReady(fixture.state, 'MODES', 100, 6, baseline)).toBe(false)
      await frame(`模式${' '.repeat(96)}`)
      expect(workspaceViewportReady(fixture.state, 'MODES', 100, 6, baseline)).toBe(true)
      expect(workspaceViewportReady(fixture.state, 'MODES', 100, 6, fixture.state.completedFrames)).toBe(false)
      await fixture.deliver('\x1b[?2026h\x1b[3;1Hordinary detail\x1b[K\x1b[?2026l')
      expect(workspaceViewportReady(fixture.state, 'MODES', 100, 6, baseline)).toBe(true)
      await fixture.deliver(`\x1b[?2026h\x1b[3;1H\x1b[1mbold detail${' '.repeat(69)}\x1b[0m\x1b[K\x1b[?2026l`)
      expect(workspaceViewportReady(fixture.state, 'MODES', 100, 6, baseline)).toBe(false)
    } finally { fixture.dispose() }
  })

  it('moves upward by model identity while ignoring changing markers and split selections', async () => {
    const fixture = terminalFixture()
    try {
      await fixture.frame('› OpenAI model · OpenAI')
      const input = fixture.nextInput()
      const moving = moveSelectionTo(fixture.state, 'DeepSeek-V4-Pro', 'Pro model', 1_000, 'up')
      expect(await input).toBe('\x1b[A')
      await fixture.frame('› OpenAI model · OpenAI · current/default')
      expect(fixture.writes).toEqual(['\x1b[A'])
      await fixture.frame('› OpenAI model · OpenAI\r\n› DeepSeek-V4-Pro · DeepSeek')
      expect(fixture.writes).toEqual(['\x1b[A'])
      await fixture.frame('› DeepSeek-V4-Pro · DeepSeek')
      await moving
      expect(fixture.writes).toEqual(['\x1b[A'])
    } finally { fixture.dispose() }
  })

  it('ignores a background command suggestion when a modal has one selected connection method', async () => {
    const fixture = terminalFixture()
    try {
      await fixture.frame('     › Enter API key · id:api-key\r\n\r\n› /connect')
      await moveSelectionTo(fixture.state, 'id:api-key', 'API-key method', 100)
      expect(fixture.writes).toEqual([])
    } finally { fixture.dispose() }
  })

  it('accepts Sessions inactive-title EL while rejecting stale single-pane and split geometry', async () => {
    const fixture = terminalFixture()
    try {
      fixture.state.terminal.resize(100, 6)
      const frame = (columns: number, contentX?: number, bodyColumns = columns) => fixture.frame(
        `SESSIONS${' '.repeat(columns - 8)}\r\n1/1 matching\x1b[K`
        + (contentX === undefined ? '' : `\x1b[2;${contentX + 1}H› Untitled session\x1b[K\x1b[3;${contentX + 1}HC:\\fixture\x1b[K`)
        + (contentX === undefined ? '' : `\x1b[5;1H\x1b[2m${' '.repeat(contentX)}Created  Sep 7${' '.repeat(bodyColumns - contentX - 14)}\x1b[0m\x1b[K`)
        + `\x1b[6;1HEsc back${' '.repeat(columns - 8)}`,
      )
      const baseline = fixture.state.completedFrames
      await frame(100)
      expect(workspaceViewportReady(fixture.state, 'SESSIONS', 100, 6, baseline)).toBe(false)
      await frame(100, 28)
      expect(workspaceViewportReady(fixture.state, 'SESSIONS', 100, 6, baseline)).toBe(true)
      fixture.state.terminal.resize(140, 6)
      await frame(140, 28)
      expect(workspaceViewportReady(fixture.state, 'SESSIONS', 140, 6, baseline)).toBe(false)
      await frame(140, 33)
      expect(workspaceViewportReady(fixture.state, 'SESSIONS', 140, 6, baseline)).toBe(true)
      fixture.state.terminal.resize(200, 6)
      await frame(200, 33, 140)
      expect(workspaceViewportReady(fixture.state, 'SESSIONS', 200, 6, baseline)).toBe(false)
      await frame(200, 33)
      expect(workspaceViewportReady(fixture.state, 'SESSIONS', 200, 6, baseline)).toBe(true)
    } finally { fixture.dispose() }
  })

  it('requires the real Settings category layout, panel edge and control to reach every new viewport', async () => {
    const fixture = terminalFixture()
    try {
      await fixture.deliver('\x1b[?1049h')
      const deliver = (lines: readonly string[]) => fixture.frame(lines.map((line, row) => `\x1b[${row + 1};1H${line}`).join(''))
      for (const [columns, rows] of [[80, 24], [100, 30], [140, 30], [200, 30], [80, 6]] as const) {
        fixture.state.terminal.resize(columns, rows)
        const baseline = fixture.state.completedFrames
        const next = renderSettingsPageFrame(settingsView(), { columns, rows }).lines
        const previous = renderSettingsPageFrame(settingsView(), { columns: columns === 80 ? 60 : 80, rows: 24 }).lines
        const mixed = next.map((line, row) => row < (rows < 10 ? 1 : 2) || row === rows - 1 ? line : previous[row] ?? '')
        await deliver(mixed)
        expect(settingsViewportReady(fixture.state, columns, rows, baseline), `mixed body ${columns}x${rows}`).toBe(false)
        await deliver(next)
        expect(settingsViewportReady(fixture.state, columns, rows, baseline), `settled body ${columns}x${rows}\n${next.join("\n")}`).toBe(true)
        expect(settingsViewportReady(fixture.state, columns, rows, fixture.state.completedFrames)).toBe(false)
      }
    } finally { fixture.dispose() }
  })

  it.each([160, 200])('requires Settings body to use all %i columns and rejects a narrower previous body', async columns => {
    const fixture = terminalFixture()
    try {
      const rows = 30
      await fixture.deliver('\x1b[?1049h')
      fixture.state.terminal.resize(columns, rows)
      const baseline = fixture.state.completedFrames
      const deliver = (lines: readonly string[]) => fixture.frame(lines.map((line, row) => `\x1b[${row + 1};1H${line}`).join(''))
      const next = renderSettingsPageFrame(settingsView(), { columns, rows }).lines
      const previous = renderSettingsPageFrame(settingsView(), { columns: columns - 20, rows }).lines
      await deliver(next.map((line, row) => row < 2 || row === rows - 1 ? line : previous[row] ?? ''))
      expect(settingsViewportReady(fixture.state, columns, rows, baseline), 'new header with a narrower previous form').toBe(false)
      await deliver(next)
      const fieldRow = next.findIndex(line => line.includes('主题') && line.includes('▾'))
      expect(fixture.state.terminal.buffer.active.getLine(fieldRow)?.getCell(columns - 2)?.getChars(), 'form reaches the available right edge').toBe('│')
      expect(settingsViewportReady(fixture.state, columns, rows, baseline)).toBe(true)
    } finally { fixture.dispose() }
  })

  it('distinguishes the Settings choice picker from its form and rejects split selected rows', () => {
    const view = settingsView()
    const field = view.fields[0]!
    const frame = (selection: number) => renderSettingsPageFrame({ ...view, picker: { field, selection } }, { columns: 100, rows: 30 }).lines
    expect(settingsPickerSelected(renderSettingsPageFrame(view, { columns: 100, rows: 30 }).lines, '主题', '自动')).toBe(false)
    expect(settingsPickerSelected(frame(0), '主题', '自动')).toBe(true)
    expect(settingsPickerSelected(frame(0), '主题', 'Cordis')).toBe(false)
    expect(settingsPickerSelected(frame(1), '主题', 'Cordis')).toBe(true)
    expect(settingsPickerSelected(frame(2), '主题', '单色')).toBe(true)
    expect(settingsPickerSelected([...frame(2), '→ Cordis'], '主题', '单色')).toBe(false)
    expect(settingsPickerSelected(frame(2), '默认权限', '单色')).toBe(false)
  })
})

describe('official E2E Composer inspection', () => {
  it('reads exact input from the bottom prompt box instead of matching history', () => {
    const lines = [
      '╭──────────────────────╮',
      '│ > /old               │',
      '╰──────────────────────╯',
      '╭──────────────────────╮',
      '│ > /toolchain-check   │',
      '╰──────────────────────╯',
      'MODEL fixture',
    ]
    expect(composerPromptLines(lines)).toEqual(['> /toolchain-check'])
    expect(commandSearchLineVisible(lines, '/toolchain-check')).toBe(true)
    expect(commandSearchLineVisible(lines, '/toolchain')).toBe(false)
    expect(commandSearchLineVisible(lines, '/old')).toBe(false)
  })

  it('recognizes a blank boxed prompt and rejects incomplete or non-bottom boxes', () => {
    expect(commandSearchLineVisible(['╭──────╮', '│ >    │', '╰──────╯', 'MODEL fixture'], '')).toBe(true)
    expect(composerPromptLines(['│ > /old │', '╰────────╯', 'MODEL fixture'])).toEqual([])
    expect(composerPromptLines(['╭──────╮', '│ >    │', '╰──────╯', '', 'MODEL fixture'])).toEqual([])
  })
})

describe('official E2E provider dialog inspection', () => {
  it('requires three provider management form sections with distinguishable fields and buttons', () => {
    const lines = ['│ openai │', '│ 连接配置 ───── │', '│ 显示名称  │ openai ✎ │', '│ 服务地址  │ http://127.0.0.1/v1 ✎ │',
      '│ 连接测试 ───── │', '│ 测试模型  DSH-TUI OpenAI E2E ▾ │', '│ [ 测试连接 ] │',
      '│ 更多操作 ───── │', '│ [ 高级设置 ] [ 断开凭据 ] │']
    expect(() => assertSettingsManageForm(lines)).not.toThrow()
    expect(() => assertSettingsManageForm(lines.filter(line => !line.includes('连接配置')))).toThrow()
    expect(() => assertSettingsManageForm(lines.map(line => line.replaceAll('✎', '')))).toThrow()
    expect(() => assertSettingsManageForm(lines.map(line => line.replace('[ 测试连接 ]', '› 测试连接')))).toThrow()
    expect(() => assertSettingsManageForm([...lines, '│ [ 测试连接 ] │'])).toThrow()
  })

  it('requires nearby test feedback, green success, red failure and explicit cancellation inside the manage form', async () => {
    const fixture = terminalFixture()
    const feedback = (title: string, color: string, spacing = '') => fixture.frame(
      `│ openai │\r\n│ 连接测试 │\r\n│ [ 测试连接 ] │\r\n${spacing}│ ${color}${title}\x1b[0m │`)
    try {
      await feedback('连接成功', '\x1b[38;2;100;190;80m')
      expect(() => assertSettingsTestFeedback(fixture.state.terminal, { state: 'success', title: '连接成功' })).not.toThrow()
      await feedback('连接成功', '\x1b[38;2;230;80;90m')
      expect(() => assertSettingsTestFeedback(fixture.state.terminal, { state: 'success', title: '连接成功' })).toThrow()
      await feedback('连接测试失败', '\x1b[38;2;230;80;90m')
      expect(() => assertSettingsTestFeedback(fixture.state.terminal, { state: 'error', title: '连接测试失败' })).not.toThrow()
      await feedback('连接测试失败', '\x1b[38;2;100;190;80m')
      expect(() => assertSettingsTestFeedback(fixture.state.terminal, { state: 'error', title: '连接测试失败' })).toThrow()
      await feedback('测试已取消', '')
      expect(() => assertSettingsTestFeedback(fixture.state.terminal, { state: 'cancelled', title: '测试已取消' })).not.toThrow()
      await feedback('已取消操作。', '')
      expect(() => assertSettingsTestFeedback(fixture.state.terminal, { state: 'cancelled', title: '测试已取消' })).toThrow()
      await feedback('连接成功', '\x1b[38;2;100;190;80m', '\r\n\r\n\r\n')
      expect(() => assertSettingsTestFeedback(fixture.state.terminal, { state: 'success', title: '连接成功' })).toThrow()
      await fixture.frame('正在测试连接…')
      expect(() => assertSettingsTestFeedback(fixture.state.terminal, { state: 'running', title: '正在测试连接…' })).toThrow()
    } finally { fixture.dispose() }
  })

  it('requires one model name under its provider group and distinguishes equal names across providers', () => {
    const lines = ['  ┌────────────────────────┐', '  │ 新会话默认模型         │', '  │ DeepSeek               │',
      '  │   Shared Chat          │', '  │ OpenAI                 │', '  │ › Shared Chat          │', '  └────────────────────────┘',
      '↑↓ 选择  Enter 确定  Esc / q 返回']
    expect(() => assertSettingsModelGroup(lines, 'OpenAI', 'Shared Chat')).not.toThrow()
    expect(settingsProviderDialogSelected(lines, '新会话默认模型', 'Shared Chat', 'OpenAI')).toBe(true)
    expect(settingsProviderDialogSelected(lines, '新会话默认模型', 'Shared Chat', 'DeepSeek')).toBe(false)
    expect(() => assertSettingsModelGroup(lines.map(line => line.replace('› Shared Chat ', '› Shared Chat  Shared Chat ')), 'OpenAI', 'Shared Chat')).toThrow()
    expect(() => assertSettingsModelGroup(lines.filter(line => !line.includes('│ OpenAI ')), 'OpenAI', 'Shared Chat')).toThrow()
    expect(() => assertSettingsModelGroup(lines.map(line => line.replace('› Shared Chat ', '› OpenAI / Shared Chat ')), 'OpenAI', 'Shared Chat')).toThrow()
  })

  it('requires bounded dialogs and shortcut hints at the screen bottom outside the panel', () => {
    const lines = Array.from({ length: 30 }, () => '')
    lines.splice(3, 5, '  ┌────────────┐', '  │ 添加提供商 │', '  │ › OpenAI   │', '  │   Other    │', '  └────────────┘')
    lines[29] = '输入搜索   ↑↓ 选择   Enter 打开   Esc 返回'
    expect(() => assertSettingsDialogChrome(lines, '添加提供商')).not.toThrow()
    expect(() => assertSettingsDialogChrome(lines.map((line, row) => row === 29 ? '' : row === 6 ? '  │ Enter 打开 Esc 返回 │' : line), '添加提供商')).toThrow()
    expect(() => assertSettingsDialogChrome(lines.map((line, row) => row === 29 ? '' : row === 20 ? lines[29]! : line), '添加提供商')).toThrow()
    expect(() => assertSettingsDialogChrome(lines.map((line, row) => row === 28 ? '↑↓ 选择   Enter 打开   Esc / q' : row === 29 ? '返回' : line), '添加提供商')).toThrow()
    const tooTall = ['┌────────────┐', '│ 添加提供商 │', ...Array.from({ length: 23 }, () => '│ Other      │'), '└────────────┘', '', '', '', lines[29]!]
    expect(() => assertSettingsDialogChrome(tooTall, '添加提供商')).toThrow()
    const subtitle = lines.map((line, row) => row === 6 ? '  │ 搜索并选择 DSH 提供的服务。 │' : line)
    expect(() => assertSettingsDialogChrome(subtitle, '添加提供商')).toThrow()
  })

  it('reads a configured badge independently from cursor styling and rejects flattened monochrome status', async () => {
    const fixture = terminalFixture()
    try {
      await fixture.frame('│ DeepSeek\r\n│ OpenAI  \x1b[38;2;20;180;80m已配置\x1b[0m │')
      const idle = settingsProviderBadgeStyle(fixture.state.terminal, 'OpenAI', '已配置')
      await fixture.frame('│ DeepSeek\r\n│ \x1b[4;38;2;80;120;240m› OpenAI\x1b[0m  \x1b[38;2;20;180;80m已配置\x1b[0m │')
      const selected = settingsProviderBadgeStyle(fixture.state.terminal, 'OpenAI', '已配置')
      expect(selected).toEqual(idle)
      await fixture.frame('│ DeepSeek\r\n│ \x1b[4;38;2;80;120;240m› OpenAI  已配置\x1b[0m │')
      expect(() => settingsProviderBadgeStyle(fixture.state.terminal, 'OpenAI', '已配置')).toThrow()
      await fixture.frame('│ DeepSeek\r\n│ OpenAI  已配置 │')
      expect(() => settingsProviderBadgeStyle(fixture.state.terminal, 'OpenAI', '已配置')).toThrow()
    } finally { fixture.dispose() }
  })

  it('recognizes only the isolated fixed test prompt and never session history or tools', () => {
    const body = { messages: [{ role: 'user', content: 'Reply with OK.' }] }
    expect(isProviderTestRequest(body)).toBe(true)
    expect(isProviderTestRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }], tools: [] })).toBe(true)
    for (const changed of [
      { messages: [{ role: 'user', content: 'Reply with OK. and continue the task' }] },
      { messages: [{ role: 'system', content: 'session instructions' }, ...body.messages] },
      { messages: [...body.messages, { role: 'assistant', content: 'old answer' }] },
      { messages: [{ role: 'assistant', content: 'Reply with OK.' }] },
      { ...body, tools: [{ type: 'function', function: { name: 'read' } }] },
    ]) expect(isProviderTestRequest(changed)).toBe(false)
  })

  it('requires the selected provider row inside the dialog instead of stale background matches', () => {
    const lines = ['DSH 设置', 'openai 已添加', '  ┌────────────────────────┐', '  │ 添加提供商             │', '  │ › openai   已配置      │', '  │ Esc / q 取消           │', '  └────────────────────────┘']
    expect(settingsProviderDialogSelected(lines, '添加提供商', 'openai')).toBe(true)
    expect(settingsProviderDialogSelected(lines.map(line => line.replace('› openai', '  openai')), '添加提供商', 'openai')).toBe(false)
    expect(settingsProviderDialogSelected(lines, '选择测试模型', 'openai')).toBe(false)
    expect(settingsProviderDialogSelected(lines.map(line => line.replace('› openai ', '› openai-codex ')), '添加提供商', 'openai')).toBe(false)
    expect(settingsProviderDialogSelected([...lines, '› anthropic'], '添加提供商', 'openai')).toBe(false)
  })

  it('serves the explicit provider test once without advancing the normal toolchain or title lanes', async () => {
    const mock = await startStandardToolchainMock(2_000)
    try {
      const response = await fetch(`${mock.baseURL}/chat/completions`, { method: 'POST',
        headers: { Authorization: 'Bearer dsh-tui-e2e-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'dsh-tui-openai-e2e', stream: true, max_tokens: 128,
          messages: [{ role: 'user', content: 'Reply with OK.' }], tools: [] }),
      })
      const stream = await response.text()
      expect(response.status).toBe(200)
      expect(stream).toContain('"content":"OK"')
      expect(stream).toContain('"finish_reason":"stop"')
      expect(stream).toContain('[DONE]')
      expect(mock.providerTestRequests).toHaveLength(1)
      expect(mock.modelRequestCount).toBe(1)
      expect(mock.chatRequests).toHaveLength(0)
      expect(mock.retryRequests).toHaveLength(0)
      expect(mock.titleRequests).toHaveLength(0)
      expect(mock.callIds).toHaveLength(0)
      expect(mock.failures).toEqual([])
    } finally { await mock.close() }
  })

  it('controls success, non-retryable failure and cancellation as three explicit isolated provider tests', async () => {
    const mock = await startStandardToolchainMock(2_000)
    const send = (signal?: AbortSignal) => fetch(`${mock.baseURL}/chat/completions`, { method: 'POST', signal: signal ?? null,
      headers: { Authorization: 'Bearer dsh-tui-e2e-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'dsh-tui-openai-e2e', stream: true, max_tokens: 128,
        messages: [{ role: 'user', content: 'Reply with OK.' }], tools: [] }),
    })
    try {
      const success = mock.prepareProviderTest('success')
      let delivered = false
      const first = send().then(response => { delivered = true; return response })
      await success.request
      expect(delivered).toBe(false)
      success.release()
      expect(await (await first).text()).toContain('"content":"OK"')

      const failure = mock.prepareProviderTest('failure')
      const second = send()
      await failure.request
      failure.release()
      const failed = await second
      expect(failed.status).toBe(401)
      expect(await failed.json()).toEqual({ error: { message: 'isolated provider test rejected' } })

      const cancellation = mock.prepareProviderTest('success')
      const abort = new AbortController()
      const third = send(abort.signal)
      await cancellation.request
      abort.abort()
      await expect(third).rejects.toThrow()
      await cancellation.closed
      expect(mock.providerTestRequests).toHaveLength(3)
      expect(mock.providerTestResults.map((result: { outcome: string }) => result.outcome)).toEqual(['success', 'failure', 'cancelled'])
      expect(mock.modelRequestCount).toBe(3)
      expect(mock.chatRequests).toHaveLength(0)
      expect(mock.retryRequests).toHaveLength(0)
      expect(mock.titleRequests).toHaveLength(0)
      expect(mock.callIds).toHaveLength(0)
      expect(mock.failures).toEqual([])
    } finally { await mock.close() }
  })
})

describeOnWindows('official DeepSeek Harness profile release gate', () => {
  it('runs DSH-TUI through the repo-local mock provider and a real ConPTY', async () => {
    const projectRoot = fileURLToPath(new URL('..', import.meta.url))
    const scriptPath = fileURLToPath(
      new URL('../scripts/official-dsh-e2e.ps1', import.meta.url),
    )

    const { stdout } = await execFileAsync(
      process.env.PWSH_EXE ?? 'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        scriptPath,
        '-TimeoutMilliseconds',
        '90000',
        '-NodeExecutable',
        process.execPath,
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 540_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    )

    expect(stdout).toContain('OFFICIAL_DSH_E2E_OK')
    expect(stdout).toContain('profile=tui')
    expect(stdout).toContain('initial=80x24 resized=100x30')
    expect(stdout).toContain('workspace_resize=80x24+100x30+140x30+200x30+80x6')
    expect(stdout).toContain('workspace_pages=17 workspace_model_requests=0')
    expect(stdout).toContain('workspace_screens=')
    expect(stdout).toContain('approval_inspection=80x6-controls+80x3-fail-closed+argument-tail+default-reject+draft-preserved')
    expect(stdout).toContain('approval_details=explicit+scope-preview-3-to-2')
    expect(stdout).toContain('ctrl_o=draft+cursor+visible-response+model-requests-0')
    expect(stdout).toContain('mock=request+result')
    expect(stdout).toContain('session=contiguous')
    expect(stdout).toMatch(/providers=dynamic-\d+/)
    expect(stdout).toContain('connect=deepseek-official+openai')
    expect(stdout).toContain('provider_credentials=isolated')
    expect(stdout).toContain('provider_models=live')
    expect(stdout).toContain('provider_model_requests=0')
    expect(stdout).toContain('command=goal')
    expect(stdout).toContain('command_events=paired')
    expect(stdout).toContain('command_model_requests=0')
    expect(stdout).toContain('catalog=live-switch-current-noop')
    expect(stdout).toContain('catalog_events=none')
    expect(stdout).toContain('catalog_model_requests=0')
    expect(stdout).toContain('catalog_title=official-snapshot+search+requests-0')
    expect(stdout).toContain('context=official-token-meter')
    expect(stdout).toContain('statusline=model+effort+context+cache+tokens')
    expect(stdout).toContain('compact=official-execution+durable-transaction+live-status')
    expect(stdout).toContain('context_model_requests=0')
    expect(stdout).toContain('compaction_model_requests=1')
    expect(stdout).toContain('permission=official-projection+command-switch+restored-read-only')
    expect(stdout).toContain('permission_model_requests=0')
    expect(stdout).toContain('model_picker=session-to-deepseek-v4-pro+off')
    expect(stdout).toContain('model_picker_requests=0')
    expect(stdout).toContain('booted_profile=verified')
    expect(stdout).toContain('global_tools=empty')
    expect(stdout).toContain('fresh_preset=standard')
    expect(stdout).toContain('startup_mode=standard-direct')
    expect(stdout).toContain('mode_switch=standard-to-minimal-same-session')
    expect(stdout).toContain('mode_catalog=standard-compact-to-minimal-no-compact')
    expect(stdout).toContain('skills=user-picker+literal-token+official-pre-step-injection+model-tool')
    expect(stdout).toContain('fresh_presets=standard')
    expect(stdout).toContain('mode_selected_events=minimal-once')
    expect(stdout).toContain('alt_screen=once-per-process')
    expect(stdout).toMatch(/minimal_session_events=\d+/)
    expect(stdout).toContain('minimal_command=goal')
    expect(stdout).toContain('minimal_command_events=paired')
    expect(stdout).toContain('minimal_command_model_requests=0')
    expect(stdout).toContain('host_rows=exact')
    expect(stdout).toContain('catalogs=cold-after-fresh-exact')
    expect(stdout).toContain('audit_generation=owned')
    expect(stdout).toContain('guidance=standard-exact-scoped-section')
    expect(stdout).toContain('complete_prompt=resumed-minimal-persona-only')
    expect(stdout).toContain('time_context=profile+fresh-resume-snapshots')
    expect(stdout).toContain('image_admission=official-memory-png+malformed-rejected')
    expect(stdout).toContain('tool_directory=exact-agent-25+read-only+model-requests-0')
    expect(stdout).toContain('runtime_library=settings-redacted-browse+loader-read-only+model-requests-0')
    expect(stdout).toContain('settings_form=four-categories+typed-validation+save-cancel+requests-0')
    expect(stdout).toContain('settings_document=mono-saved+cancel-preserved+auto-restored')
    expect(stdout).toContain('settings_interaction=q-clean-dirty+picker-confirm-cancel+q-in-search-editor')
    expect(stdout).toContain('settings_permission=full-access-warning+cancel-no-write')
    expect(stdout).toContain('settings_providers=home+directory+configure+select-model+explicit-test+q-return')
    expect(stdout).toContain('provider_browse_requests=0 provider_test_requests=3 provider_test_session_writes=0')
    expect(stdout).toContain('settings_provider_polish=grouped-models+unique-name+badge-independent+bottom-shortcuts+bounded-directory-tail')
    expect(stdout).toContain('settings_provider_manage=form-three-sections+field-controls+running+success-green+failure-red+cancelled')
    expect(stdout).toContain('preferences=feature-document+jk-navigation+model-requests-0')
    expect(stdout).toContain('standard_toolchain=catalog-25+calls-16+approval-allow-reject+question-answer-cancel+goal-action-pause-resume-pause+plan-review-approve+job-run-kill')
    expect(stdout).toContain('workbench=goal-active-paused-active-paused+plan-on-review-off+todo-live+activity-live-killed')
    expect(stdout).toContain('toolchain_model_requests=17')
    expect(stdout).toContain('toolchain_retry_requests=1')
    expect(stdout).toContain('request_recovery=official-retry+statusline+attempt-workspace')
    expect(stdout).toContain('request_route=official-header-context+route-workspace')
    expect(stdout).toContain('toolchain_title_requests=1')
    expect(stdout).toContain('toolchain_search_requests=1')
    expect(stdout).toMatch(/toolchain_session_events=\d+/)
    expect(stdout).toContain('fresh_cli_model=deepseek-v4-flash-vision-exp+off')
    expect(stdout).toContain('cold_resume=explicit-over-history+default')
    expect(stdout).toContain('current_default=drifted')
    expect(stdout).toContain('resume_model=deepseek-v4-flash')
    expect(stdout).toContain('resume_preset=minimal')
    expect(stdout).toContain('current_model=deepseek-v4-pro')
    expect(stdout).toContain('current_preset=standard')
    expect(stdout).toContain('resume_transcript=replayed')
    expect(stdout).toContain('jsonl_prefix=preserved')
    expect(stdout).toContain('resume_suffix=contiguous')
    expect(stdout).toContain('resume_header=reason-resume')
    expect(stdout).toContain('resume_model_requests=1')
    expect(stdout).toMatch(/resumed_session_events=\d+/)
    expect(stdout).toMatch(/resume_suffix_events=\d+/)
    expect(stdout).toContain('exit=0 recovery=exact')
    expect(stdout).toMatch(/pid=\d+ process=gone temp=confirmed/)
    expect(stdout).toContain('toolchain_exit=0 toolchain_recovery=exact')
    expect(stdout).toMatch(/toolchain_pid=\d+ toolchain_process=gone/)
    expect(stdout).toContain('minimal_exit=0 minimal_recovery=exact')
    expect(stdout).toMatch(/minimal_pid=\d+ minimal_process=gone/)
    expect(stdout).toContain('resume_exit=0 resume_recovery=exact')
    expect(stdout).toMatch(/resume_pid=\d+ resume_process=gone/)
    expect(stdout).toContain('missing_resume=fail-closed')
    expect(stdout).toContain('missing_exit=1 missing_terminal=never-allocated')
    expect(stdout).toContain('missing_model_requests=0')
    expect(stdout).toContain('missing_session_writes=0')
    expect(stdout).toMatch(/missing_pid=\d+ missing_process=gone/)
  }, 550_000)
})
