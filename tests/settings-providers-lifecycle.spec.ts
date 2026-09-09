import { describe, expect, it, vi } from 'vitest'
import { ProviderAuthorizationDeclinedError, type ProviderAuthorizationInteraction, type ProviderConnectionEntry,
  type ProviderConnectionPort, type ProviderConnectionSnapshot } from '../src/provider/port.ts'
import type { SettingsCatalogPort, SettingsCatalogSnapshot } from '../src/settings/port.ts'
import { SettingsProvidersController } from '../src/settings/providers-controller.ts'

function entry(id = 'fixture'): ProviderConnectionEntry {
  return { id, name: id, active: true, configured: true, connected: true,
    credential: { kind: 'api-key', configured: true, writable: true },
    methods: [{ id: 'api-key', label: 'API key' }], canDisconnect: true,
    models: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }] }
}

const providers = (id = 'fixture'): ProviderConnectionSnapshot => ({ writable: true, providers: [entry(id)] })

function setup(overrides: Partial<ProviderConnectionPort> = {}) {
  let changed = () => {}
  let settingsChanged = () => {}
  let snapshot: SettingsCatalogSnapshot = { available: true, writable: true, documentBacked: true, generation: 1,
    namespaces: [{ namespace: 'agent-default-model', schema: {}, value: { provider: 'fixture', model: 'first' },
      revision: 3, applies: 'live', secrets: [] }] }
  const settings: SettingsCatalogPort = {
    settingsSnapshot: () => snapshot,
    mutateSettings: vi.fn(async () => {}),
    onSettingsChanged: listener => { settingsChanged = listener; return () => {} },
  }
  const port: ProviderConnectionPort = {
    list: vi.fn(async () => providers()), connect: vi.fn(async () => ({ status: 'connected' as const })),
    disconnect: vi.fn(async () => {}), test: vi.fn(async () => ({ elapsedMs: 1, outcome: 'completed' as const })),
    onChanged: listener => { changed = listener; return () => {} }, ...overrides,
  }
  const invalidate = vi.fn()
  const controller = new SettingsProvidersController(port, settings, invalidate)
  return { controller, port, settings, invalidate, changed: () => changed(), settingsChanged: () => settingsChanged(),
    snapshot: () => snapshot, setSnapshot: (value: SettingsCatalogSnapshot) => { snapshot = value } }
}

async function ticks() { for (let count = 0; count < 12; count++) await Promise.resolve() }
const press = (controller: SettingsProvidersController, text: string) => controller.handleInput({ type: 'insert', text })
async function ready(controller: SettingsProvidersController) { controller.open(); await controller.waitForIdle() }
async function manage(controller: SettingsProvidersController) {
  await ready(controller)
  controller.handleInput({ type: 'move-down' })
  controller.handleInput({ type: 'move-down' })
  controller.handleInput({ type: 'submit' })
}

function choose(controller: SettingsProvidersController, id: string) {
  const dialog = controller.view()!.dialog!
  const target = dialog.rows.findIndex(row => row.id === id)
  expect(target).toBeGreaterThanOrEqual(0)
  for (let index = dialog.selection; index < target; index++) controller.handleInput({ type: 'move-down' })
  for (let index = dialog.selection; index > target; index--) controller.handleInput({ type: 'move-up' })
  controller.handleInput({ type: 'submit' })
}

async function custom(fixture: ReturnType<typeof setup>) {
  const snapshot = fixture.snapshot()
  fixture.setSnapshot({ ...snapshot, namespaces: [...snapshot.namespaces, {
    namespace: 'llm-pi-ai', schema: { dict: { providers: { inner: { dict: { api: {
      list: [{ type: 'const', value: 'openai-completions' }],
    } } } } } }, value: { providers: {} }, revision: 1, applies: 'live', secrets: [],
  }] })
  await ready(fixture.controller)
  fixture.controller.openAdd()
  choose(fixture.controller, '__custom__')
  for (const [id, value] of [['displayName', 'New Service'], ['baseURL', 'https://service.example/v1'], ['modelId', 'chat']]) {
    choose(fixture.controller, id!)
    press(fixture.controller, value!)
    fixture.controller.handleInput({ type: 'submit' })
  }
  choose(fixture.controller, 'create')
}

describe('Settings provider operation lifecycles', () => {
  it.each(['resolve', 'reject'] as const)('keeps the new test result when a cancelled request later %ss', async outcome => {
    const old = Promise.withResolvers<{ elapsedMs: number }>()
    const current = Promise.withResolvers<{ elapsedMs: number }>()
    const test = vi.fn<NonNullable<ProviderConnectionPort['test']>>()
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const { controller } = setup({ test })
    await manage(controller)
    press(controller, 't'); await ticks()
    controller.handleInput({ type: 'escape' })
    expect(controller.view()?.testFeedback).toEqual({ state: 'cancelled', title: '测试已取消' })
    expect(controller.view()?.dialog?.rows[controller.view()!.dialog!.selection]?.id).toBe('test')
    press(controller, 't'); await ticks()
    current.resolve({ elapsedMs: 2300 }); await ticks()
    const result = { state: 'success', title: '连接成功', detail: '响应耗时 2.3 秒。' }
    expect(controller.view()?.testFeedback).toEqual(result)
    if (outcome === 'resolve') old.resolve({ elapsedMs: 1 })
    else old.reject(new Error('late private failure'))
    await controller.waitForIdle()
    expect(controller.view()?.testFeedback).toEqual(result)
    expect(test).toHaveBeenCalledTimes(2)
  })

  it.each(['resolve', 'reject'] as const)('keeps a newer directory when an aborted refresh later %ss', async outcome => {
    const old = Promise.withResolvers<ProviderConnectionSnapshot>()
    const current = Promise.withResolvers<ProviderConnectionSnapshot>()
    const signals: AbortSignal[] = []
    const list = vi.fn<ProviderConnectionPort['list']>()
      .mockImplementationOnce(options => { signals.push(options!.signal!); return old.promise })
      .mockImplementationOnce(options => { signals.push(options!.signal!); return current.promise })
    const fixture = setup({ list })
    fixture.controller.open()
    await ticks()
    expect(fixture.controller.pendingCount).toBe(1)
    fixture.changed()
    await ticks()
    expect(signals[0]?.aborted).toBe(true)
    expect(fixture.controller.pendingCount).toBe(2)
    current.resolve(providers('new'))
    await ticks()
    expect(fixture.controller.view()?.providers[0]?.id).toBe('new')
    if (outcome === 'resolve') old.resolve(providers('old'))
    else old.reject(new Error('old private transport failure'))
    await fixture.controller.waitForIdle()
    expect(fixture.controller.view()?.providers[0]?.id).toBe('new')
    expect(fixture.controller.view()?.error).toBeUndefined()
    expect(fixture.controller.pendingCount).toBe(0)
    fixture.controller.close()
  })

  it('clears a directory-load error after a successful explicit retry', async () => {
    const list = vi.fn<ProviderConnectionPort['list']>()
      .mockRejectedValueOnce(new Error('private failure')).mockResolvedValue(providers())
    const { controller } = setup({ list })
    await ready(controller)
    expect(controller.view()?.error).toContain('目录加载失败')
    press(controller, 'r')
    await controller.waitForIdle()
    expect(controller.view()?.providers).toHaveLength(1)
    expect(controller.view()?.error).toBeUndefined()
    controller.close()
  })

  it('settles a refresh after close without reopening the view or accepting stale topology events', async () => {
    const pending = Promise.withResolvers<ProviderConnectionSnapshot>()
    let signal: AbortSignal | undefined
    const list = vi.fn<ProviderConnectionPort['list']>(options => { signal = options?.signal; return pending.promise })
    const fixture = setup({ list })
    fixture.controller.open()
    await ticks()
    fixture.controller.close()
    expect(signal?.aborted).toBe(true)
    fixture.changed()
    pending.resolve(providers('late'))
    await fixture.controller.waitForIdle()
    expect(list).toHaveBeenCalledOnce()
    expect(fixture.controller.view()).toBeUndefined()
    expect(fixture.controller.pendingCount).toBe(0)
  })

  it('does not dispatch a save cancelled before its queued operation begins', async () => {
    const { controller, settings } = setup()
    await ready(controller)
    controller.handleInput({ type: 'submit' })
    controller.handleInput({ type: 'move-down' })
    controller.handleInput({ type: 'submit' })
    expect(controller.view()?.busy).toBe(true)
    controller.handleInput({ type: 'escape' })
    await controller.waitForIdle()
    expect(settings.mutateSettings).not.toHaveBeenCalled()
    expect(controller.view()?.busy).toBe(false)
    expect(controller.view()?.notice).toContain('设置可能已保存')
    controller.close()
  })

  it('keeps cancellation feedback when a non-abortable Settings write finishes later', async () => {
    const write = Promise.withResolvers<void>()
    const fixture = setup()
    vi.mocked(fixture.settings.mutateSettings).mockImplementation(() => write.promise)
    await ready(fixture.controller)
    fixture.controller.handleInput({ type: 'submit' })
    fixture.controller.handleInput({ type: 'move-down' })
    fixture.controller.handleInput({ type: 'submit' })
    await ticks()
    expect(fixture.settings.mutateSettings).toHaveBeenCalledOnce()
    fixture.controller.handleInput({ type: 'escape' })
    expect(fixture.controller.view()?.notice).toContain('设置可能已保存')
    const prior = fixture.snapshot()
    fixture.setSnapshot({ ...prior, generation: 2, namespaces: prior.namespaces.map(namespace => ({ ...namespace,
      revision: 4, value: { provider: 'fixture', model: 'second' } })) })
    fixture.settingsChanged()
    expect(fixture.invalidate).toHaveBeenCalled()
    write.resolve()
    await fixture.controller.waitForIdle()
    expect(fixture.controller.view()?.defaultModel).toBe('fixture / second')
    expect(fixture.controller.view()?.notice).toContain('设置可能已保存')
    expect(fixture.controller.isModalOpen).toBe(false)
    fixture.controller.close()
  })

  it('refuses authorization prompts and progress from a closed operation after reopening', async () => {
    const finish = Promise.withResolvers<{ status: 'cancelled' }>()
    let interaction: ProviderAuthorizationInteraction | undefined
    const fixture = setup({ connect: vi.fn((_provider, _method, value) => { interaction = value; return finish.promise }) })
    await manage(fixture.controller)
    press(fixture.controller, 'c')
    await ticks()
    fixture.controller.close()
    await ticks()
    fixture.controller.open()
    await ticks()
    interaction!.notify({ message: 'old progress must remain invisible' })
    await expect(interaction!.prompt({ kind: 'secret', message: 'late private prompt' })).rejects.toBeInstanceOf(ProviderAuthorizationDeclinedError)
    finish.resolve({ status: 'cancelled' })
    await fixture.controller.waitForIdle()
    expect(JSON.stringify(fixture.controller.view())).not.toContain('old progress')
    expect(JSON.stringify(fixture.controller.view())).not.toContain('late private prompt')
    expect(fixture.controller.isModalOpen).toBe(false)
    fixture.controller.close()
  })

  it('settles a provider-withdrawn secret prompt without retaining typed secret text', async () => {
    const promptAbort = new AbortController()
    let operationSignal: AbortSignal | undefined
    const fixture = setup({ connect: vi.fn(async (_provider, _method, interaction, options) => {
      operationSignal = options?.signal
      try { await interaction.prompt({ kind: 'secret', message: 'Enter key', signal: promptAbort.signal }) }
      catch (error) { expect(error).toBeInstanceOf(ProviderAuthorizationDeclinedError) }
      return { status: 'cancelled' as const }
    }) })
    await manage(fixture.controller)
    press(fixture.controller, 'c')
    await ticks()
    press(fixture.controller, 'unsubmitted-private-key')
    expect(JSON.stringify(fixture.controller.view())).not.toContain('unsubmitted-private-key')
    promptAbort.abort()
    await fixture.controller.waitForIdle()
    expect(operationSignal?.aborted).toBe(false)
    expect(fixture.controller.view()?.dialog?.kind).toBe('manage')
    expect(fixture.controller.view()?.dialog?.editor).toBeUndefined()
    expect(JSON.stringify(fixture.controller.view())).not.toContain('unsubmitted-private-key')
    fixture.controller.close()
  })

  it('does not start credentials after a cancelled custom registration commits late', async () => {
    const write = Promise.withResolvers<void>()
    const fixture = setup()
    vi.mocked(fixture.settings.mutateSettings).mockReturnValue(write.promise)
    await custom(fixture)
    await ticks()
    expect(fixture.settings.mutateSettings).toHaveBeenCalledOnce()
    fixture.controller.handleInput({ type: 'escape' })
    write.resolve()
    await fixture.controller.waitForIdle()
    expect(fixture.port.connect).not.toHaveBeenCalled()
    expect(fixture.port.list).toHaveBeenCalledOnce()
    expect(fixture.controller.view()?.notice).toContain('设置可能已保存')
    expect(fixture.controller.isModalOpen).toBe(false)
    fixture.controller.close()
  })

  it('reports a persisted custom provider absent from the directory without starting credentials', async () => {
    const fixture = setup()
    await custom(fixture)
    await fixture.controller.waitForIdle()
    expect(fixture.settings.mutateSettings).toHaveBeenCalledOnce()
    expect(fixture.port.connect).not.toHaveBeenCalled()
    expect(fixture.controller.view()?.error).toContain('服务目录尚未更新')
    expect(fixture.controller.view()?.dialog?.title).toBe('提供商暂不可用')
    fixture.controller.close()
  })

  it('closes during the post-test refresh without restoring the operation dialog', async () => {
    const refresh = Promise.withResolvers<ProviderConnectionSnapshot>()
    let signal: AbortSignal | undefined
    const list = vi.fn<ProviderConnectionPort['list']>().mockResolvedValueOnce(providers())
      .mockImplementationOnce(options => { signal = options?.signal; return refresh.promise })
    const fixture = setup({ list })
    await manage(fixture.controller)
    press(fixture.controller, 't')
    await ticks()
    expect(list).toHaveBeenCalledTimes(2)
    fixture.controller.close()
    expect(signal?.aborted).toBe(true)
    refresh.resolve(providers())
    await fixture.controller.waitForIdle()
    expect(fixture.controller.view()).toBeUndefined()
    expect(fixture.controller.pendingCount).toBe(0)
  })

  it('keeps cancellation feedback when the aborted test rejects later', async () => {
    const test = Promise.withResolvers<{ elapsedMs: number }>()
    const fixture = setup({ test: vi.fn(() => test.promise) })
    await manage(fixture.controller)
    press(fixture.controller, 't')
    await ticks()
    fixture.controller.handleInput({ type: 'escape' })
    test.reject(new Error('late private transport error'))
    await fixture.controller.waitForIdle()
    expect(fixture.controller.view()?.notice).toBe('已取消操作。')
    expect(fixture.controller.view()?.error).toBeUndefined()
    expect(fixture.controller.view()?.dialog?.kind).toBe('manage')
    fixture.controller.close()
  })

  it('cancels an authorization select prompt through Escape', async () => {
    let signal: AbortSignal | undefined
    const fixture = setup({ connect: vi.fn(async (_provider, _method, interaction, options) => {
      signal = options?.signal
      await interaction.prompt({ kind: 'select', message: 'Choose account', options: [{ id: 'one', label: 'One' }] })
      return { status: 'connected' as const }
    }) })
    await manage(fixture.controller)
    press(fixture.controller, 'c')
    await ticks()
    expect(fixture.controller.view()?.dialog?.kind).toBe('authorization')
    fixture.controller.handleInput({ type: 'escape' })
    await fixture.controller.waitForIdle()
    expect(signal?.aborted).toBe(true)
    expect(fixture.controller.view()?.error).toBeUndefined()
    expect(fixture.controller.view()?.notice).toBe('已取消操作。')
    fixture.controller.close()
  })

  it('declines a prompt whose own signal was already aborted', async () => {
    const promptAbort = new AbortController()
    promptAbort.abort()
    const fixture = setup({ connect: vi.fn(async (_provider, _method, interaction) => {
      await expect(interaction.prompt({ kind: 'secret', message: 'Withdrawn key', signal: promptAbort.signal }))
        .rejects.toBeInstanceOf(ProviderAuthorizationDeclinedError)
      return { status: 'cancelled' as const }
    }) })
    await manage(fixture.controller)
    press(fixture.controller, 'c')
    await fixture.controller.waitForIdle()
    expect(fixture.controller.view()?.dialog?.kind).toBe('manage')
    expect(JSON.stringify(fixture.controller.view())).not.toContain('Withdrawn key')
    fixture.controller.close()
  })
})
