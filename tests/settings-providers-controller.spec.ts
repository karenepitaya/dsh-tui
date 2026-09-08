import { describe, expect, it, vi } from 'vitest'
import type { ProviderAuthorizationInteraction, ProviderConnectionEntry, ProviderConnectionPort } from '../src/provider/port.ts'
import type { SettingsCatalogPort, SettingsCatalogSnapshot } from '../src/settings/port.ts'
import { SettingsProvidersController } from '../src/settings/providers-controller.ts'

function provider(change: Partial<ProviderConnectionEntry> = {}): ProviderConnectionEntry {
  return { id: 'local-service', name: '本地服务', active: true, configured: true, connected: true,
    credential: { kind: 'api-key', configured: true, writable: true },
    methods: [{ id: 'api-key', label: 'API key' }], canDisconnect: true,
    models: [{ id: 'chat-v1', name: 'Chat V1' }, { id: 'chat-v2', name: 'Chat V2' }],
    configuration: { namespace: 'llm-pi-ai', path: ['providers', 'local-service'], revision: 3,
      writable: true, baseURL: 'https://service.example/v1', displayName: '本地服务' }, ...change }
}

function settings(): SettingsCatalogPort {
  const snapshot: SettingsCatalogSnapshot = { available: true, writable: true, documentBacked: true, generation: 1,
    namespaces: [{ namespace: 'agent-default-model', schema: {}, value: { provider: 'local-service', model: 'chat-v1', reasoningEffort: 'high' },
      revision: 7, applies: 'live', secrets: [] }] }
  return { settingsSnapshot: () => snapshot, onSettingsChanged: () => () => undefined, mutateSettings: vi.fn(async () => undefined) }
}

function setup(change: Partial<ProviderConnectionPort> = {}, catalog = settings()) {
  const port: ProviderConnectionPort = { list: vi.fn(async () => ({ writable: true, providers: [provider(), provider({ id: 'other', name: '目录服务', configured: false, active: false,
    connected: false, credential: { kind: 'missing', configured: false, writable: true } })] })),
    connect: vi.fn(async () => ({ status: 'connected' as const })), disconnect: vi.fn(async () => undefined),
    onChanged: () => () => undefined, test: vi.fn(async () => ({ elapsedMs: 21 })), ...change }
  const controller = new SettingsProvidersController(port, catalog, vi.fn())
  return { controller, port, catalog }
}

async function ready(controller: SettingsProvidersController) {
  controller.open()
  await controller.waitForIdle()
}

function press(controller: SettingsProvidersController, text: string) {
  controller.handleInput({ type: 'insert', text })
}

function choose(controller: SettingsProvidersController, id: string) {
  const dialog = controller.view()?.dialog
  const target = dialog?.rows.findIndex(row => row.id === id) ?? -1
  expect(target, `dialog has action ${id}`).toBeGreaterThanOrEqual(0)
  for (let index = dialog!.selection; index > target; index--) controller.handleInput({ type: 'move-up' })
  for (let index = dialog!.selection; index < target; index++) controller.handleInput({ type: 'move-down' })
  controller.handleInput({ type: 'submit' })
}

function replace(controller: SettingsProvidersController, value: string) {
  controller.handleInput({ type: 'move-home' })
  for (let index = 0; index < 250; index++) controller.handleInput({ type: 'delete' })
  controller.handleInput({ type: 'insert', text: value, paste: true })
}

function richSettings(change: Partial<SettingsCatalogSnapshot> = {}): SettingsCatalogPort {
  const schema = { dict: { providers: { inner: { dict: { api: { list: [
    { type: 'const', value: 'openai-completions' }, { type: 'const', value: 'other-protocol' },
  ] } } } } } }
  const snapshot: SettingsCatalogSnapshot = { ...settings().settingsSnapshot(), namespaces: [...settings().settingsSnapshot().namespaces,
    { namespace: 'llm-pi-ai', schema, value: { providers: { 'local-service': {
      displayName: '本地服务', baseURL: 'https://user:stored-secret@service.example/v1?api_key=hidden#private', models: [{ id: 'chat-v1' }],
    } } }, user: { providers: { 'local-service': {} } }, revision: 3, applies: 'live', secrets: [] }], ...change }
  return { settingsSnapshot: () => snapshot, onSettingsChanged: () => () => undefined, mutateSettings: vi.fn(async () => undefined) }
}

async function manage(controller: SettingsProvidersController) {
  await ready(controller)
  controller.handleInput({ type: 'move-down' })
  controller.handleInput({ type: 'submit' })
}

async function ticks() { for (let index = 0; index < 5; index++) await Promise.resolve() }

describe('Settings provider management', () => {
  it('groups connection configuration, testing and further actions without repetitive descriptions', async () => {
    const { controller } = setup({ list: vi.fn(async () => ({ writable: true, providers: [provider({
      configuration: { ...provider().configuration!, api: 'openai-completions' },
    })] })) }, richSettings())
    await manage(controller)
    const dialog = controller.view()!.dialog!
    expect(dialog.description).toBeUndefined()
    expect(dialog.rows.map(row => [row.id, row.group])).toEqual([
      ['credentials', '连接配置'], ['name', '连接配置'], ['baseURL', '连接配置'],
      ['model', '连接测试'], ['test', '连接测试'],
      ['modelId', '更多操作'], ['advanced', '更多操作'], ['disconnect', '更多操作'], ['remove', '更多操作'],
    ])
    expect(dialog.rows.every(row => row.description === undefined)).toBe(true)
    expect(dialog.rows.find(row => row.id === 'disconnect')?.label).toBe('断开连接')
    expect(dialog.rows.find(row => row.id === 'remove')?.label).toBe('重置服务配置')
    choose(controller, 'remove')
    expect(controller.view()?.dialog?.description).toContain('保留已保存的密钥')
    expect(controller.view()?.dialog?.description).toContain('原始配置')
  })

  it('keeps the management panel and focused test action while a single explicit request is running', async () => {
    const pending = Promise.withResolvers<{ elapsedMs: number }>()
    const { controller, port } = setup({ test: vi.fn(() => pending.promise) })
    await manage(controller)
    press(controller, 't')
    const running = controller.view()!
    expect(running.testFeedback).toEqual({ state: 'running', title: '正在测试连接…' })
    expect(running.dialog?.kind).toBe('manage')
    expect(running.dialog?.rows[running.dialog.selection]?.id).toBe('test')
    expect(running.dialog?.rows.every(row => row.disabled)).toBe(true)
    press(controller, 't'); press(controller, 'c'); controller.handleInput({ type: 'submit' })
    controller.handleInput({ type: 'move-up' })
    await ticks()
    expect(port.test).toHaveBeenCalledOnce()
    expect(port.connect).not.toHaveBeenCalled()
    pending.resolve({ elapsedMs: 1200 })
    await controller.waitForIdle()
    const result = controller.view()!
    expect(result.testFeedback).toEqual({ state: 'success', title: '连接成功', detail: '响应耗时 1.2 秒。' })
    expect(result.busy).toBe(false)
    expect(result.dialog?.rows[result.dialog.selection]?.id).toBe('test')
    expect(result.dialog?.rows.find(row => row.id === 'test')?.disabled).toBe(false)
    choose(controller, 'model'); choose(controller, 'chat-v1')
    expect(controller.view()?.testFeedback?.state).toBe('success')
    choose(controller, 'model'); choose(controller, 'chat-v2')
    expect(controller.view()?.testFeedback).toBeUndefined()
    expect(controller.view()?.notice).toBeUndefined()
  })

  it.each(['name', 'baseURL', 'credentials', 'provider'] as const)('clears previous test feedback when changing %s', async action => {
    const { controller } = setup({}, richSettings())
    await manage(controller)
    press(controller, 't'); await controller.waitForIdle()
    expect(controller.view()?.testFeedback?.state).toBe('success')
    if (action === 'provider') { controller.openAdd(); choose(controller, 'other') }
    else if (action === 'credentials') { choose(controller, action); await controller.waitForIdle() }
    else { choose(controller, action); replace(controller, action === 'name' ? 'New Name' : 'https://changed.example/v1'); controller.handleInput({ type: 'submit' }); await controller.waitForIdle() }
    expect(controller.view()?.testFeedback).toBeUndefined()
  })

  it('keeps unconfigured directory choices in the add dialog and never connects merely by opening', async () => {
    const { controller, port } = setup()
    await ready(controller)
    expect(controller.view()?.providers.map(row => row.id)).toEqual(['local-service'])
    press(controller, 'n')
    expect(controller.isModalOpen).toBe(true)
    expect(controller.view()?.dialog?.kind).toBe('directory')
    press(controller, '目录')
    expect(controller.view()?.directory.map(row => row.id)).toEqual(['other'])
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.dialog?.kind).toBe('manage')
    expect(controller.view()?.selectedProvider?.id).toBe('other')
    expect(port.connect).not.toHaveBeenCalled()
    expect(port.test).not.toHaveBeenCalled()
    controller.handleInput({ type: 'escape' })
    expect(controller.isModalOpen).toBe(false)
  })

  it('writes only the new-session default through Settings with the captured revision', async () => {
    const { controller, catalog, port } = setup()
    await ready(controller)
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.dialog?.kind).toBe('default-model')
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'submit' })
    await controller.waitForIdle()
    expect(catalog.mutateSettings).toHaveBeenCalledWith({ namespace: 'agent-default-model', path: [],
      expectedRevision: 7, operation: 'batch', changes: [
        { operation: 'set', path: ['provider'], value: 'local-service' },
        { operation: 'set', path: ['model'], value: 'chat-v2' },
        { operation: 'unset', path: ['reasoningEffort'] },
      ] })
    expect(port.connect).not.toHaveBeenCalled()
    expect(port.test).not.toHaveBeenCalled()
  })

  it('tests only after an explicit action and shows failures without raw transport details', async () => {
    const test = vi.fn(async () => { throw new Error('request failed with Authorization: secret-credential') })
    const { controller } = setup({ test })
    await ready(controller)
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'submit' })
    expect(test).not.toHaveBeenCalled()
    press(controller, 't')
    await controller.waitForIdle()
    expect(test).toHaveBeenCalledWith('local-service', 'chat-v1', { signal: expect.any(AbortSignal) })
    expect(controller.view()?.error).toContain('测试失败')
    expect(controller.view()?.testFeedback).toEqual({ state: 'error', title: '连接测试失败', detail: '测试失败，请检查凭据、地址与模型后重试。' })
    expect(controller.view()?.dialog?.kind).toBe('manage')
    expect(JSON.stringify(controller.view())).not.toContain('secret-credential')
    expect(controller.view()?.notice ?? '').not.toContain('测试通过')
  })

  it('masks authorization input, treats q as text, and clears secret input when cancelled', async () => {
    let interaction!: ProviderAuthorizationInteraction
    const { controller } = setup({ connect: vi.fn(async (_id, _method, value) => {
      interaction = value
      try { await interaction.prompt({ kind: 'secret', message: '输入密钥' }) } catch { return { status: 'cancelled' as const } }
      return { status: 'connected' as const }
    }) })
    await ready(controller)
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'submit' })
    press(controller, 'c')
    await Promise.resolve()
    await Promise.resolve()
    press(controller, 'q-secret')
    expect(controller.view()?.dialog?.kind).toBe('authorization')
    expect(JSON.stringify(controller.view())).not.toContain('q-secret')
    expect(controller.view()?.dialog?.editor?.text).toBe('••••••••')
    controller.handleInput({ type: 'escape' })
    await controller.waitForIdle()
    expect(controller.view()?.dialog?.kind).toBe('manage')
    expect(JSON.stringify(controller.view())).not.toContain('q-secret')
  })

  it('ignores a test result after cancellation, including close and reopen', async () => {
    let finish!: (result: { elapsedMs: number }) => void
    let signal: AbortSignal | undefined
    const { controller } = setup({ test: vi.fn((_provider, _model, options) => {
      signal = options?.signal
      return new Promise<{ elapsedMs: number }>(resolve => { finish = resolve })
    }) })
    await ready(controller)
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'submit' })
    press(controller, 't')
    await Promise.resolve()
    controller.handleInput({ type: 'escape' })
    expect(signal?.aborted).toBe(true)
    controller.close()
    controller.open()
    finish({ elapsedMs: 10 })
    await controller.waitForIdle()
    expect(controller.view()?.notice ?? '').not.toContain('测试通过')
    expect(controller.isModalOpen).toBe(false)
  })

  it('leaves q in directory search and blocks writes when settings or credentials are read-only', async () => {
    const { controller, port, catalog } = setup({ list: vi.fn(async () => ({ writable: false,
      providers: [provider({ credential: { kind: 'reference', configured: true, writable: false }, canDisconnect: false })] })) },
    { ...settings(), settingsSnapshot: () => ({ ...settings().settingsSnapshot(), writable: false }) })
    await ready(controller)
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toContain('只读')
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'submit' })
    press(controller, 'c')
    expect(port.connect).not.toHaveBeenCalled()
    controller.handleInput({ type: 'escape' })
    press(controller, 'n')
    press(controller, 'q')
    expect(controller.view()?.query.text).toBe('q')
    expect(controller.isModalOpen).toBe(true)
    expect(catalog.mutateSettings).not.toHaveBeenCalled()
  })

  it('closes idempotently and settles other teardown work after a subscription throws', async () => {
    const stopSettings = vi.fn()
    const { controller } = setup({ onChanged: () => () => { throw new Error('broken subscription') } },
      { ...settings(), onSettingsChanged: () => stopSettings })
    await ready(controller)
    expect(() => controller.close()).not.toThrow()
    expect(controller.isOpen).toBe(false)
    expect(stopSettings).toHaveBeenCalledOnce()
    controller.close()
    controller.quiesce()
    expect(stopSettings).toHaveBeenCalledOnce()
  })

  it('keeps unavailable catalogs retryable and supports opening without a settings service', async () => {
    let changed!: () => void
    let count = 0
    const { port } = setup({ list: vi.fn(async () => { if (++count === 1) throw new Error('private endpoint'); return { writable: true, providers: [] } }),
      onChanged: listener => { changed = listener; return () => undefined } })
    const controller = new SettingsProvidersController(port, undefined, vi.fn())
    expect(controller.view()).toBeUndefined()
    controller.openAdd()
    expect(controller.handleInput({ type: 'submit' })).toBeUndefined()
    await ready(controller)
    controller.open()
    expect(controller.view()?.error).toContain('目录加载失败')
    expect(JSON.stringify(controller.view())).not.toContain('private endpoint')
    press(controller, 'R')
    await controller.waitForIdle()
    changed()
    await controller.waitForIdle()
    expect(port.list).toHaveBeenCalledTimes(3)
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toContain('默认模型服务不可用')
    expect(controller.handleInput({ type: 'toggle-transcript-details' })).toEqual({ kind: 'advanced' })
    expect(controller.handleInput({ type: 'escape' })).toEqual({ kind: 'close' })
    press(controller, 'N')
    choose(controller, '__custom__')
    expect(controller.view()?.error).toContain('只读')
    controller.handleInput({ type: 'complete' })
    expect(controller.view()?.dialog?.searchFocused).toBe(false)
    press(controller, 'q')
    expect(controller.isModalOpen).toBe(false)
    controller.close()
    expect(controller.view()).toBeUndefined()
  })

  it('supports model selection and both completed and limited test outcomes without accidental retrigger', async () => {
    let finish!: (value: { elapsedMs: number; outcome: 'completed' | 'limited' }) => void
    const test = vi.fn(() => new Promise<{ elapsedMs: number; outcome: 'completed' | 'limited' }>(resolve => { finish = resolve }))
    const { controller } = setup({ test })
    await manage(controller)
    choose(controller, 'model')
    expect(controller.view()?.dialog?.title).toBe('选择测试模型')
    controller.handleInput({ type: 'insert', text: 'j' }, 'arrows')
    expect(controller.view()?.dialog?.selection).toBe(0)
    controller.handleInput({ type: 'insert', text: 'j' }, 'vim')
    expect(controller.view()?.dialog?.selection).toBe(1)
    controller.handleInput({ type: 'insert', text: 'k' }, 'vim')
    controller.handleInput({ type: 'complete' })
    controller.handleInput({ type: 'submit' })
    choose(controller, 'test')
    await ticks()
    press(controller, 't')
    controller.openAdd()
    expect(test).toHaveBeenCalledOnce()
    expect(test).toHaveBeenLastCalledWith('local-service', 'chat-v2', expect.anything())
    finish({ elapsedMs: 24.5, outcome: 'limited' })
    await controller.waitForIdle()
    expect(controller.view()?.notice).toContain('测试输出达到限制')
    expect(controller.view()?.testFeedback).toEqual({ state: 'warning', title: '服务已响应，输出受限', detail: '响应耗时 0.02 秒。' })
    press(controller, 't')
    await ticks()
    finish({ elapsedMs: 25, outcome: 'completed' })
    await controller.waitForIdle()
    expect(controller.view()?.notice).toContain('测试通过（25 ms）')
    expect(controller.handleInput({ type: 'toggle-transcript-details' })).toEqual({ kind: 'advanced', namespace: 'llm-pi-ai' })
  })

  it('edits only the chosen basic field, masks old endpoint secrets and preserves revision conflicts', async () => {
    const catalog = richSettings()
    const { controller } = setup({}, catalog)
    await manage(controller)
    choose(controller, 'baseURL')
    expect(controller.view()?.dialog?.editor?.text).toBe('https://service.example/v1')
    expect(JSON.stringify(controller.view())).not.toMatch(/stored-secret|api_key=hidden|#private/)
    controller.handleInput({ type: 'submit' })
    expect(catalog.mutateSettings).not.toHaveBeenCalled()
    choose(controller, 'name')
    replace(controller, '')
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toContain('非空')
    replace(controller, 'one\ntwo')
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toContain('单行')
    replace(controller, 'q新名称')
    controller.handleInput({ type: 'submit' })
    await controller.waitForIdle()
    expect(catalog.mutateSettings).toHaveBeenCalledWith({ namespace: 'llm-pi-ai', path: ['providers', 'local-service', 'displayName'],
      expectedRevision: 3, operation: 'set', value: 'q新名称' })
    choose(controller, 'baseURL')
    replace(controller, 'ftp://bad.example')
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toContain('http(s)')
    replace(controller, 'not-an-endpoint')
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.dialog?.kind).toBe('editor')
    replace(controller, 'https://changed.example/v1')
    vi.mocked(catalog.mutateSettings).mockRejectedValueOnce(new Error('conflict contains secret'))
    controller.handleInput({ type: 'submit' })
    await controller.waitForIdle()
    expect(controller.view()?.dialog?.kind).toBe('editor')
    expect(controller.view()?.dialog?.editor?.text).toBe('https://changed.example/v1')
    expect(controller.view()?.error).toContain('配置可能已变更')
    expect(JSON.stringify(controller.view())).not.toContain('contains secret')
    controller.handleInput({ type: 'escape' })
    expect(controller.view()?.dialog?.kind).toBe('confirm-discard')
    choose(controller, 'cancel')
    expect(controller.view()?.dialog?.kind).toBe('editor')
    controller.handleInput({ type: 'escape' })
    choose(controller, 'confirm')
    expect(controller.view()?.dialog?.kind).toBe('manage')
  })

  it('uses the official multi-step authorization interaction and redacts later echoes of submitted secrets', async () => {
    const received: string[] = []
    const { controller } = setup({ list: vi.fn(async () => ({ writable: true, providers: [provider({ methods: [
      { id: 'browser', label: '浏览器登录' }, { id: 'key', label: '密钥' },
    ] })] })), connect: vi.fn(async (_provider, _method, interaction) => {
      interaction.notify({ message: '在浏览器登录', url: 'https://auth.example', code: 'ABCD' })
      received.push(await interaction.prompt({ kind: 'select', message: '选择账户', options: [{ id: 'one', label: '账户一', description: '个人账户' }, { id: 'two', label: '账户二' }] }))
      received.push(await interaction.prompt({ kind: 'text', message: '浏览器代码' }))
      received.push(await interaction.prompt({ kind: 'secret', message: '密钥' }))
      interaction.notify({ message: 'received ' + received[2] })
      return { status: 'connected' as const }
    }) })
    await manage(controller)
    choose(controller, 'credentials')
    expect(controller.view()?.dialog?.kind).toBe('methods')
    choose(controller, 'browser')
    await ticks()
    expect(controller.view()?.dialog?.rows[0]?.description).toBe('个人账户')
    choose(controller, 'two')
    await ticks()
    press(controller, 'q-browser-code')
    expect(controller.view()?.dialog?.editor?.text).toBe('q-browser-code')
    controller.handleInput({ type: 'submit' })
    await ticks()
    press(controller, 'private-secret')
    controller.handleInput({ type: 'submit' })
    await controller.waitForIdle()
    expect(received).toEqual(['two', 'q-browser-code', 'private-secret'])
    expect(controller.view()?.notice).toContain('凭据已配置')
    expect(JSON.stringify(controller.view())).not.toContain('private-secret')
  })

  it('separates disconnecting credentials from removing an overridable provider record', async () => {
    const { controller, port, catalog } = setup({}, richSettings())
    await manage(controller)
    choose(controller, 'disconnect')
    expect(controller.view()?.dialog?.description).toContain('保留服务地址')
    controller.handleInput({ type: 'submit' })
    expect(port.disconnect).not.toHaveBeenCalled()
    choose(controller, 'disconnect')
    choose(controller, 'confirm')
    await controller.waitForIdle()
    expect(port.disconnect).toHaveBeenCalledWith('local-service', { signal: expect.any(AbortSignal) })
    choose(controller, 'remove')
    expect(controller.view()?.dialog?.description).toContain('原始配置')
    choose(controller, 'confirm')
    await controller.waitForIdle()
    expect(catalog.mutateSettings).toHaveBeenCalledWith({ namespace: 'llm-pi-ai', path: ['providers', 'local-service'], expectedRevision: 3, operation: 'unset' })
    expect(controller.isModalOpen).toBe(false)
  })

  it('adds a custom model ID through the configuration boundary and rejects duplicates', async () => {
    const { controller, catalog } = setup({ list: vi.fn(async () => ({ writable: true,
      providers: [provider({ configuration: { ...provider().configuration!, api: 'openai-completions' } })] })) }, richSettings())
    await manage(controller)
    choose(controller, 'modelId')
    press(controller, 'chat-v1')
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toContain('已存在')
    replace(controller, 'new-model')
    controller.handleInput({ type: 'submit' })
    await controller.waitForIdle()
    expect(catalog.mutateSettings).toHaveBeenCalledWith({ namespace: 'llm-pi-ai', path: ['providers', 'local-service', 'models'], expectedRevision: 3,
      operation: 'set', value: [{ id: 'chat-v1' }, { id: 'new-model' }] })
  })

  it('creates a custom service from mounted types then continues official credential configuration', async () => {
    const catalog = richSettings()
    let created = false
    let authorize = false
    const mutate = vi.mocked(catalog.mutateSettings).mockImplementation(async () => { created = true })
    const { controller, port } = setup({ list: vi.fn(async () => ({ writable: true, providers: created ? [provider({ id: 'custom-my-service', name: 'My Service' })] : [] })),
      connect: vi.fn(async (_id, _method, interaction) => { authorize = true; await interaction.prompt({ kind: 'secret', message: '密钥' }); return { status: 'connected' as const } }) }, catalog)
    await ready(controller)
    controller.openAdd()
    choose(controller, '__custom__')
    expect(controller.view()?.dialog?.kind).toBe('custom')
    choose(controller, 'create')
    expect(controller.view()?.error).toContain('显示名称')
    choose(controller, 'displayName'); press(controller, 'My Service'); controller.handleInput({ type: 'submit' })
    choose(controller, 'api'); choose(controller, 'other-protocol')
    choose(controller, 'baseURL'); press(controller, 'https://custom.example/v1'); controller.handleInput({ type: 'submit' })
    choose(controller, 'modelId'); press(controller, 'custom-chat'); controller.handleInput({ type: 'submit' })
    choose(controller, 'create')
    for (let index = 0; index < 20 && !authorize; index++) await ticks()
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ path: ['providers', 'custom-my-service'], value: {
      displayName: 'My Service', api: 'other-protocol', baseURL: 'https://custom.example/v1', models: [{ id: 'custom-chat' }],
    } }))
    expect(port.connect).toHaveBeenCalledWith('custom-my-service', 'api-key', expect.anything(), expect.anything())
    press(controller, 'the-key')
    controller.handleInput({ type: 'submit' })
    await controller.waitForIdle()
    expect(JSON.stringify(controller.view())).not.toContain('the-key')
  })

  it('preserves a custom draft on registration failure, and cancellation before submission writes nothing', async () => {
    const catalog = richSettings()
    vi.mocked(catalog.mutateSettings).mockRejectedValue(new Error('revision mismatch'))
    const { controller } = setup({ list: vi.fn(async () => ({ writable: true, providers: [] })) }, catalog)
    await ready(controller)
    controller.openAdd(); choose(controller, '__custom__')
    choose(controller, 'api'); controller.handleInput({ type: 'escape' })
    choose(controller, 'displayName'); press(controller, 'Draft'); controller.handleInput({ type: 'submit' })
    controller.handleInput({ type: 'escape' })
    expect(controller.view()?.dialog?.kind).toBe('confirm-discard')
    controller.handleInput({ type: 'escape' })
    expect(controller.view()?.dialog?.kind).toBe('custom')
    choose(controller, 'baseURL'); press(controller, 'https://draft.example'); controller.handleInput({ type: 'submit' })
    choose(controller, 'modelId'); press(controller, 'chat'); controller.handleInput({ type: 'submit' })
    choose(controller, 'create')
    await controller.waitForIdle()
    expect(controller.view()?.error).toContain('添加失败')
    expect(controller.view()?.dialog?.kind).toBe('custom')
    expect(controller.view()?.dialog?.rows.find(row => row.id === 'displayName')?.value).toBe('Draft')
    controller.handleInput({ type: 'escape' }); choose(controller, 'confirm')
    expect(controller.isModalOpen).toBe(false)
    controller.openAdd(); choose(controller, '__custom__'); controller.handleInput({ type: 'escape' })
    expect(controller.isModalOpen).toBe(false)
    expect(catalog.mutateSettings).toHaveBeenCalledOnce()
  })

  it('shows providers with no optional metadata honestly and keeps unavailable actions inert', async () => {
    const { models: _models, configuration: _configuration, ...basic } = provider()
    const { controller, port } = setup({ list: vi.fn(async () => ({ writable: true, providers: [{ ...basic,
      credential: { kind: 'missing' as const, configured: false, writable: true }, methods: [] }] })) })
    await ready(controller)
    controller.handleInput({ type: 'move-up' })
    controller.handleInput({ type: 'ignored' })
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toContain('请先添加一个可用模型')
    controller.handleInput({ type: 'move-down' }); controller.handleInput({ type: 'submit' })
    const rows = controller.view()!.dialog!.rows
    expect(rows.find(row => row.id === 'model')).toMatchObject({ value: '暂无模型', disabled: true })
    expect(rows.find(row => row.id === 'baseURL')?.value).toBe('使用服务默认地址')
    press(controller, 't')
    expect(controller.view()?.error).toContain('无法测试')
    press(controller, 'c')
    expect(port.connect).not.toHaveBeenCalled()
    expect(controller.handleInput({ type: 'insert', text: '?' })).toBeUndefined()
    expect(controller.handleInput({ type: 'insert', text: 'a' })).toEqual({ kind: 'advanced' })
    controller.handleInput({ type: 'escape' })
    controller.openAdd()
    expect(controller.view()?.dialog?.rows[0]?.value).toBe('继续配置')
    controller.handleInput({ type: 'move-up' })
    controller.handleInput({ type: 'complete' })
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.dialog?.kind).toBe('manage')
  })

  it('keeps model management coherent when the provider or selected model disappears from a refresh', async () => {
    let changed!: () => void
    let providers = [provider()]
    const { controller, port } = setup({ list: vi.fn(async () => ({ writable: true, providers })),
      onChanged: listener => { changed = listener; return () => undefined } })
    await manage(controller)
    providers = [provider({ models: [{ id: 'replacement', name: 'Replacement' }] })]
    changed(); await controller.waitForIdle()
    expect(controller.view()?.dialog?.rows.find(row => row.id === 'model')?.value).toBe('Replacement')
    press(controller, 't'); await controller.waitForIdle()
    expect(port.test).toHaveBeenLastCalledWith('local-service', 'replacement', expect.anything())
    providers = []
    changed(); await controller.waitForIdle()
    expect(controller.view()?.dialog).toMatchObject({ title: '提供商暂不可用', rows: [] })
    press(controller, 'a')
    expect(controller.view()?.error).toContain('不可用')
  })

  it('responds to settings updates, malformed defaults and revoked write access without mutation', async () => {
    const original = richSettings().settingsSnapshot()
    let current = { ...original, namespaces: original.namespaces.map(namespace => namespace.namespace === 'agent-default-model'
      ? { ...namespace, value: { provider: 5, model: 'chat-v1' } } : namespace) }
    let changed!: () => void
    const catalog = { ...richSettings(), settingsSnapshot: () => current,
      onSettingsChanged: (listener: () => void) => { changed = listener; return () => undefined } }
    const { controller } = setup({}, catalog)
    await ready(controller)
    expect(controller.view()?.defaultModel).toBe('chat-v1')
    controller.handleInput({ type: 'submit' })
    current = { ...current, writable: false }; changed()
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toContain('只读')
    expect(catalog.mutateSettings).not.toHaveBeenCalled()
    controller.handleInput({ type: 'escape' })
    current = { ...current, writable: true, namespaces: current.namespaces.map(namespace => namespace.namespace === 'agent-default-model'
      ? { ...namespace, value: [] } : namespace) }; changed()
    expect(controller.view()?.defaultModel).toBe('使用默认模型')
    controller.openAdd(); choose(controller, '__custom__')
    current = { ...current, writable: false }; changed()
    choose(controller, 'create')
    expect(controller.view()?.error).toContain('只读')
  })

  it('supports empty custom protocol catalogs and cancels untouched fields without writing', async () => {
    const catalog = richSettings({ namespaces: richSettings().settingsSnapshot().namespaces.map(namespace => ({ ...namespace, schema: {} })) })
    const { controller } = setup({}, catalog)
    await ready(controller)
    controller.openAdd(); choose(controller, '__custom__')
    choose(controller, 'api')
    expect(controller.view()?.dialog?.rows).toEqual([])
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.dialog?.kind).toBe('custom')
    choose(controller, 'displayName')
    controller.handleInput({ type: 'newline' })
    controller.handleInput({ type: 'escape' })
    expect(controller.view()?.dialog?.kind).toBe('custom')
    choose(controller, 'displayName'); press(controller, 'Changed'); controller.handleInput({ type: 'escape' })
    expect(controller.view()?.dialog?.kind).toBe('confirm-discard')
    choose(controller, 'confirm')
    expect(controller.view()?.dialog?.kind).toBe('custom')
    expect(catalog.mutateSettings).not.toHaveBeenCalled()
    controller.handleInput({ type: 'escape' })
    controller.handleInput({ type: 'move-down' }); controller.handleInput({ type: 'submit' })
    choose(controller, 'name'); controller.handleInput({ type: 'escape' })
    expect(controller.view()?.dialog?.kind).toBe('manage')
    choose(controller, 'model'); controller.handleInput({ type: 'escape' })
    expect(controller.view()?.dialog?.kind).toBe('manage')
  })

  it('edits an optional name without replacing the runtime model directory with one custom model', async () => {
    const rich = richSettings().settingsSnapshot()
    const catalog = richSettings({ namespaces: rich.namespaces.map(namespace => namespace.namespace === 'llm-pi-ai'
      ? { ...namespace, value: { providers: { 'local-service': { models: 'invalid' } } } } : namespace) })
    const { controller } = setup({ list: vi.fn(async () => ({ writable: true, providers: [provider({
      configuration: { ...provider().configuration!, api: 'openai-completions' },
    })] })) }, catalog)
    await manage(controller)
    choose(controller, 'name')
    expect(controller.view()?.dialog?.editor?.text).toBe('')
    press(controller, 'Name'); controller.handleInput({ type: 'submit' }); await controller.waitForIdle()
    expect(controller.view()?.dialog?.rows.some(row => row.id === 'modelId')).toBe(false)
    expect(catalog.mutateSettings).toHaveBeenCalledOnce()
  })

  it('keeps empty model and authentication pickers safe when the directory changes underneath them', async () => {
    let providers = [provider({ methods: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] })]
    let changed!: () => void
    const { controller, port } = setup({ list: vi.fn(async () => ({ writable: true, providers })),
      onChanged: listener => { changed = listener; return () => undefined } })
    await manage(controller)
    choose(controller, 'model')
    providers = []
    changed(); await controller.waitForIdle()
    expect(controller.view()?.dialog?.rows).toEqual([])
    controller.handleInput({ type: 'submit' })
    providers = [provider({ methods: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] })]
    changed(); await controller.waitForIdle()
    choose(controller, 'credentials')
    providers = []
    changed(); await controller.waitForIdle()
    expect(controller.view()?.dialog?.rows).toEqual([])
    controller.handleInput({ type: 'submit' })
    expect(port.connect).not.toHaveBeenCalled()
    controller.handleInput({ type: 'escape' })
    expect(controller.view()?.dialog?.kind).toBe('manage')
  })

  it('does not submit stale provider edits or remove actions when their configuration disappears', async () => {
    let providers = [provider()]
    let changed!: () => void
    const { controller, catalog } = setup({ list: vi.fn(async () => ({ writable: true, providers })),
      onChanged: listener => { changed = listener; return () => undefined } }, richSettings())
    await manage(controller)
    choose(controller, 'name')
    replace(controller, 'New name')
    providers = []; changed(); await controller.waitForIdle()
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toContain('服务配置已变更')
    controller.handleInput({ type: 'escape' }); choose(controller, 'confirm')
    providers = [provider()]; changed(); await controller.waitForIdle()
    choose(controller, 'remove')
    providers = []; changed(); await controller.waitForIdle()
    choose(controller, 'confirm')
    expect(catalog.mutateSettings).not.toHaveBeenCalled()
  })

  it.each([[], undefined])('refuses to replace a model directory removed while adding an ID (%s)', async models => {
    let snapshot = richSettings().settingsSnapshot()
    const catalog = { ...richSettings(), settingsSnapshot: () => snapshot }
    const { controller } = setup({ list: vi.fn(async () => ({ writable: true, providers: [provider({
      configuration: { ...provider().configuration!, api: 'openai-completions' },
    })] })) }, catalog)
    await manage(controller)
    choose(controller, 'modelId')
    snapshot = { ...snapshot, namespaces: snapshot.namespaces.map(namespace => namespace.namespace === 'llm-pi-ai'
      ? { ...namespace, value: { providers: { 'local-service': { models } } } } : namespace) }
    press(controller, 'new-model')
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.error).toContain('模型配置已变更')
    expect(catalog.mutateSettings).not.toHaveBeenCalled()
  })

  it('renders custom field names and protocol labels and retains them when a schema choice disappears', async () => {
    let snapshot = richSettings().settingsSnapshot()
    const { controller } = setup({}, { ...richSettings(), settingsSnapshot: () => snapshot })
    await ready(controller)
    controller.openAdd(); choose(controller, '__custom__')
    expect(controller.view()?.dialog?.rows.find(row => row.id === 'api')?.value).toBe('OpenAI 兼容服务')
    choose(controller, 'displayName')
    expect(controller.view()?.dialog?.title).toBe('编辑：显示名称')
    controller.handleInput({ type: 'escape' })
    snapshot = { ...snapshot, namespaces: snapshot.namespaces.map(namespace => ({ ...namespace, schema: {} })) }
    expect(controller.view()?.dialog?.rows.find(row => row.id === 'api')?.value).toBe('openai-completions')
  })

  it('keeps an empty official choice prompt open until it is cancelled', async () => {
    const { controller, port } = setup({ connect: vi.fn(async (_id, _method, interaction) => {
      try { await interaction.prompt({ kind: 'select', message: '账户暂不可用', options: [] }) }
      catch { return { status: 'cancelled' as const } }
      return { status: 'connected' as const }
    }) })
    await manage(controller)
    choose(controller, 'credentials'); await ticks()
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.dialog).toMatchObject({ kind: 'authorization', rows: [] })
    controller.handleInput({ type: 'escape' }); await controller.waitForIdle()
    expect(port.connect).toHaveBeenCalledOnce()
    expect(controller.view()?.notice).toContain('取消')
  })

  it('retains a registered custom service when credentials become read-only before authorization', async () => {
    const catalog = richSettings()
    let created = false
    vi.mocked(catalog.mutateSettings).mockImplementation(async () => { created = true })
    const { controller, port } = setup({ list: vi.fn(async () => ({ writable: true, providers: created ? [provider({
      id: 'custom-read-only', name: 'Read Only', credential: { kind: 'missing', configured: false, writable: false }, methods: [],
    })] : [] })) }, catalog)
    await ready(controller)
    controller.openAdd(); choose(controller, '__custom__')
    choose(controller, 'displayName'); press(controller, 'Read Only'); controller.handleInput({ type: 'submit' })
    choose(controller, 'baseURL'); press(controller, 'https://readonly.example'); controller.handleInput({ type: 'submit' })
    choose(controller, 'modelId'); press(controller, 'chat'); controller.handleInput({ type: 'submit' })
    choose(controller, 'create'); await controller.waitForIdle()
    expect(controller.view()?.error).toContain('当前凭据只读')
    expect(controller.view()?.selectedProvider?.id).toBe('custom-read-only')
    expect(port.connect).not.toHaveBeenCalled()
    expect(catalog.mutateSettings).toHaveBeenCalledOnce()
  })

  it('groups model choices by provider without duplicating labels and preserves identity across equal names', async () => {
    const { controller, catalog } = setup({ list: vi.fn(async () => ({ writable: true, providers: [
      provider({ name: 'Same Vendor', models: [{ id: 'chat-v1', name: 'Shared Chat' }, { id: 'fallback-id', name: '   ' }] }),
      provider({ id: 'another', name: 'Same Vendor', models: [{ id: 'chat-v1', name: 'Shared Chat' }] }),
      provider({ id: 'unique', name: 'Unique Vendor', models: [{ id: 'only-model', name: 'only-model' }] }),
    ] })) })
    await ready(controller)
    expect(controller.view()?.defaultProviderId).toBe('local-service')
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.dialog?.description).toBeUndefined()
    expect(controller.view()?.dialog?.rows).toEqual([
      { id: 'local-service/chat-v1', label: 'Shared Chat', group: 'Same Vendor (local-service)', badge: '当前默认', tone: 'accent' },
      { id: 'local-service/fallback-id', label: 'fallback-id', group: 'Same Vendor (local-service)' },
      { id: 'another/chat-v1', label: 'Shared Chat', group: 'Same Vendor (another)' },
      { id: 'unique/only-model', label: 'only-model', group: 'Unique Vendor' },
    ])
    choose(controller, 'another/chat-v1')
    await controller.waitForIdle()
    expect(catalog.mutateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ changes: [
      { operation: 'set', path: ['provider'], value: 'another' },
      { operation: 'set', path: ['model'], value: 'chat-v1' },
      { operation: 'unset', path: ['reasoningEffort'] },
    ] }))
  })

  it.each([true, false])('gives provider states independent badges without reordering choices (default credential=%s)', async configured => {
    const { controller } = setup({ list: vi.fn(async () => ({ writable: true, providers: [
      provider({ id: 'connected', name: 'Configured' }),
      provider({ credential: { kind: configured ? 'api-key' : 'missing', configured, writable: true } }),
      provider({ id: 'pending', name: 'Pending', credential: { kind: 'missing', configured: false, writable: true } }),
      provider({ id: 'new', name: 'New', configured: false, credential: { kind: 'missing', configured: false, writable: true } }),
    ] })) })
    await ready(controller)
    controller.openAdd()
    expect(controller.view()?.dialog?.description).toBeUndefined()
    expect(controller.view()?.dialog?.rows.slice(0, 4)).toEqual([
      { id: 'connected', label: 'Configured', badge: '已配置', tone: 'success' },
      { id: 'local-service', label: '本地服务', badge: '当前默认', tone: 'accent', ...(configured ? {} : { value: '继续配置' }) },
      { id: 'pending', label: 'Pending', value: '继续配置' },
      { id: 'new', label: 'New', value: '添加' },
    ])
    choose(controller, 'pending')
    expect(controller.view()?.selectedProvider?.id).toBe('pending')
  })

  it('shows each test model name once without a redundant subtitle and falls back to its ID when its display name is empty', async () => {
    const { controller } = setup({ list: vi.fn(async () => ({ writable: true, providers: [provider({ models: [
      { id: 'named-id', name: 'Readable Name' }, { id: 'fallback', name: '' },
    ] })] })) })
    await manage(controller)
    choose(controller, 'model')
    expect(controller.view()?.dialog?.description).toBeUndefined()
    expect(controller.view()?.dialog?.rows).toEqual([
      { id: 'named-id', label: 'Readable Name' }, { id: 'fallback', label: 'fallback' },
    ])
  })

  it.each(['', undefined, 42])('omits a missing default provider identity (%s)', async providerId => {
    const snapshot = settings().settingsSnapshot()
    const { controller } = setup({}, { ...settings(), settingsSnapshot: () => ({ ...snapshot,
      namespaces: snapshot.namespaces.map(namespace => ({ ...namespace, value: { provider: providerId, model: 'chat-v1' } })),
    }) })
    await ready(controller)
    expect(controller.view()?.defaultProviderId).toBeUndefined()
    controller.openAdd()
    expect(controller.view()?.dialog?.rows[0]).toMatchObject({ badge: '已配置', tone: 'success' })
  })
})
