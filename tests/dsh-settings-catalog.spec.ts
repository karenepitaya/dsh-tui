import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { DshSettingsCatalog } from '../src/dsh/settings-catalog.ts'

function harness(options: { readonly available?: boolean } = {}) {
  const documentListeners = new Set<(...args: unknown[]) => void>()
  const describe = vi.fn(() => [{
    ns: 'ui-theme',
    schema: { type: 'object' },
    value: { accent: 'cyan', apiKey: undefined },
    base: { accent: 'blue' },
    user: { accent: 'cyan' },
    revision: 7,
    applies: 'live',
    secrets: [{ path: ['apiKey'], set: true }],
  }])
  const mutate = vi.fn(async () => undefined)
  const settings = {
    writable: true,
    documentPath: 'D:\\profile\\settings.yml',
    describe,
    mutate,
  }
  const injectionDispose = vi.fn(async () => undefined)
  let injectCallback: ((serviceCtx: Context) => void | (() => void)) | undefined
  let injectedRelease: (() => void) | undefined
  const loggerError = vi.fn()
  const on = (name: string, listener: (...args: unknown[]) => void) => {
    if (name === 'settings/document-updated') documentListeners.add(listener)
    return () => { documentListeners.delete(listener) }
  }
  const ctx = {
    get: (name: string) => name === 'settings' && options.available !== false
      ? settings
      : undefined,
    inject: (_deps: unknown, callback: (serviceCtx: Context) => void | (() => void)) => {
      injectCallback = callback
      if (options.available !== false) {
        injectedRelease = callback({ settings } as unknown as Context) ?? undefined
      }
      return { dispose: injectionDispose }
    },
    on,
    logger: { error: loggerError },
  } as unknown as Context
  return {
    ctx,
    settings,
    describe,
    mutate,
    documentListeners,
    injectionDispose,
    loggerError,
    releaseService: () => { injectedRelease?.() },
    injectService: (next: unknown) => {
      const serviceCtx = { settings: next, on } as unknown as Context
      const release = injectCallback?.(serviceCtx)
      if (typeof release === 'function') injectedRelease = release
      return release
    },
  }
}

describe('DSH settings catalog adapter', () => {
  it('projects only redacted descriptors and preserves official revision writes', async () => {
    const fixture = harness()
    const adapter = new DshSettingsCatalog(fixture.ctx)

    const snapshot = adapter.settingsSnapshot()

    expect(fixture.describe).toHaveBeenCalledExactlyOnceWith({ redactSecrets: true })
    expect(snapshot).toMatchObject({
      available: true,
      writable: true,
      documentBacked: true,
      generation: 1,
      namespaces: [{
        namespace: 'ui-theme',
        value: { accent: 'cyan' },
        base: { accent: 'blue' },
        user: { accent: 'cyan' },
        revision: 7,
        applies: 'live',
        secrets: [{ path: ['apiKey'], set: true }],
      }],
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.namespaces[0]?.secrets[0]?.path)).toBe(true)

    await adapter.mutateSettings({
      namespace: 'ui-theme',
      path: ['accent'],
      operation: 'set',
      value: 'violet',
      expectedRevision: 7,
    })
    expect(fixture.mutate).toHaveBeenCalledExactlyOnceWith(
      'ui-theme',
      [{ op: 'set', path: ['accent'], value: 'violet' }],
      7,
    )
    await adapter.mutateSettings({
      namespace: 'ui-theme',
      path: ['accent'],
      operation: 'unset',
      expectedRevision: 8,
    })
    expect(fixture.mutate).toHaveBeenLastCalledWith(
      'ui-theme',
      [{ op: 'unset', path: ['accent'] }],
      8,
    )

    const changed = vi.fn()
    const stop = adapter.onSettingsChanged(changed)
    adapter.onSettingsChanged(() => { throw new Error('observer failed') })
    for (const listener of fixture.documentListeners) listener('ui-theme', 8)
    expect(changed).toHaveBeenCalledOnce()
    expect(adapter.settingsSnapshot().generation).toBe(2)
    stop()
    stop()
    await adapter.disposeSettings()
    expect(fixture.injectionDispose).toHaveBeenCalledOnce()
    expect(adapter.settingsSnapshot()).toMatchObject({ available: false, namespaces: [] })
    const stopDisposedObserver = adapter.onSettingsChanged(vi.fn())
    expect(stopDisposedObserver).toEqual(expect.any(Function))
    stopDisposedObserver()
    await expect(adapter.mutateSettings({
      namespace: 'ui-theme',
      path: ['accent'],
      operation: 'unset',
      expectedRevision: 8,
    })).rejects.toThrow('Settings service is unavailable')
    await adapter.disposeSettings()
  })

  it('contains missing services and describe failures without inventing settings', async () => {
    const missing = harness({ available: false })
    const unavailable = new DshSettingsCatalog(missing.ctx)
    expect(unavailable.settingsSnapshot()).toEqual({
      available: false,
      writable: false,
      documentBacked: false,
      generation: 0,
      namespaces: [],
    })
    await expect(unavailable.mutateSettings({
      namespace: 'ui-theme',
      path: ['accent'],
      operation: 'unset',
      expectedRevision: 0,
    })).rejects.toThrow('Settings service is unavailable')
    await unavailable.disposeSettings()

    const broken = harness()
    broken.describe.mockImplementation(() => { throw new Error('descriptor failed') })
    const adapter = new DshSettingsCatalog(broken.ctx)
    expect(adapter.settingsSnapshot()).toMatchObject({
      available: false,
      error: 'descriptor failed',
      namespaces: [],
    })
    await adapter.disposeSettings()
  })

  it('keeps a last-good redacted snapshot and contains provider lifecycle races', async () => {
    const fixture = harness()
    const adapter = new DshSettingsCatalog(fixture.ctx)
    expect(adapter.settingsSnapshot().available).toBe(true)
    const staleListener = [...fixture.documentListeners][0]!

    fixture.describe.mockImplementation(() => { throw 'temporary read failure' })
    expect(adapter.settingsSnapshot()).toMatchObject({
      available: true,
      stale: true,
      error: 'temporary read failure',
      namespaces: [expect.objectContaining({ namespace: 'ui-theme' })],
    })

    const changed = vi.fn()
    adapter.onSettingsChanged(changed)
    fixture.releaseService()
    fixture.releaseService()
    staleListener('ui-theme', 9)
    expect(changed).toHaveBeenCalledOnce()
    expect(adapter.settingsSnapshot()).toMatchObject({ available: false, generation: 2 })

    const replacement = {
      ...fixture.settings,
      writable: false,
      documentPath: undefined,
      describe: vi.fn(() => [{
        ns: 'agent-loop',
        schema: null,
        value: null,
        revision: 0,
        applies: 'restart' as const,
      }]),
    }
    const replacementRelease = fixture.injectService(replacement)
    expect(adapter.settingsSnapshot()).toMatchObject({
      available: true,
      writable: false,
      documentBacked: false,
      namespaces: [{
        namespace: 'agent-loop',
        schema: null,
        value: null,
        revision: 0,
        applies: 'restart',
        secrets: [],
      }],
    })
    replacementRelease?.()
    expect(changed).toHaveBeenCalledTimes(3)
    await adapter.disposeSettings()
  })

  it('normalizes opaque failures and logs injection disposal failures', async () => {
    const blank = harness()
    blank.describe.mockImplementation(() => { throw new Error('   ') })
    const blankAdapter = new DshSettingsCatalog(blank.ctx)
    expect(blankAdapter.settingsSnapshot().error).toBe('Settings descriptor failed')
    blank.injectionDispose.mockRejectedValueOnce(new Error('settings injection dispose failed'))
    await blankAdapter.disposeSettings()
    expect(blank.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'settings injection dispose failed' }),
    )

    const hostile = harness()
    hostile.describe.mockImplementation(() => {
      throw { toString: () => { throw new Error('hostile stringify') } }
    })
    const hostileAdapter = new DshSettingsCatalog(hostile.ctx)
    expect(hostileAdapter.settingsSnapshot().error).toBe('Settings descriptor failed')
    await hostileAdapter.disposeSettings()
  })
})
