import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import {
  DSH_TUI_PREFERENCES_SCHEMA,
  provideDshTuiPreferencesSettings,
} from '../src/dsh/preferences-settings.ts'
import {
  DEFAULT_DSH_TUI_PREFERENCES,
  DSH_TUI_SETTINGS_NAMESPACE,
  type DshTuiPreferencesV1,
} from '../src/preferences/contracts.ts'
import { PreferenceMigrationRegistry } from '../src/preferences/migrations.ts'
import { DSH_TUI_PREFERENCES_CAPABILITY } from '../src/preferences/port.ts'
import { DshSettingsCatalog } from '../src/dsh/settings-catalog.ts'
import { PreferenceApplication } from '../src/preferences/application.ts'

interface SettingsHarnessOptions {
  readonly available?: boolean
  readonly writable?: boolean
  readonly documentPath?: string
  readonly revision?: number
  readonly user?: unknown
}

function preferences(
  overrides: Partial<DshTuiPreferencesV1> = {},
): DshTuiPreferencesV1 {
  return {
    ...DEFAULT_DSH_TUI_PREFERENCES,
    ...overrides,
    theme: {
      ...DEFAULT_DSH_TUI_PREFERENCES.theme,
      ...overrides.theme,
    },
  }
}

function settingsHarness(options: SettingsHarnessOptions = {}) {
  let revision = options.revision ?? 0
  let user = options.user
  let registerOptions: Readonly<Record<string, unknown>> | undefined
  const listeners = new Set<(...args: unknown[]) => void>()
  const register = vi.fn((_namespace, _schema, nextOptions) => {
    registerOptions = nextOptions as Readonly<Record<string, unknown>>
    return {}
  })
  const describe = vi.fn(() => [{
    ns: DSH_TUI_SETTINGS_NAMESPACE,
    schema: {},
    value: {},
    ...(registerOptions?.base === undefined ? {} : { base: registerOptions.base }),
    ...(user === undefined ? {} : { user }),
    revision,
    applies: 'live' as const,
  }])
  const replace = vi.fn(async (_namespace, section, expectedRevision) => {
    if (options.writable === false) throw new Error('Settings provider is read-only')
    if (expectedRevision !== revision) {
      throw new Error(`CAS conflict: expected ${String(expectedRevision)}, actual ${revision}`)
    }
    user = section
    revision += 1
    for (const listener of [...listeners]) {
      listener(DSH_TUI_SETTINGS_NAMESPACE, revision)
    }
  })
  const provider = {
    writable: options.writable !== false,
    documentPath: options.documentPath ?? 'D:\\profile\\settings.yml',
    register,
    describe,
    replace,
  } as unknown as SettingsProvider
  const injectionDispose = vi.fn(async () => undefined)
  let injectCallback: ((serviceCtx: Context) => void | (() => void)) | undefined
  let release: (() => void) | undefined
  let stopHook: (() => void) | undefined
  const on = (name: string, listener: (...args: unknown[]) => void) => {
    if (name === 'settings/document-updated') listeners.add(listener)
    return () => {
      listeners.delete(listener)
      const hook = stopHook
      stopHook = undefined
      hook?.()
    }
  }
  const ctx = {
    inject: (_deps: unknown, callback: (serviceCtx: Context) => void | (() => void)) => {
      injectCallback = callback
      if (options.available !== false) {
        release = callback({ settings: provider, on } as unknown as Context) ?? undefined
      }
      return { dispose: injectionDispose }
    },
  } as unknown as Context
  return {
    ctx,
    provider,
    register,
    describe,
    replace,
    listeners,
    injectionDispose,
    emit: (namespace: string) => {
      for (const listener of [...listeners]) listener(namespace, revision)
    },
    release: () => { release?.() },
    setStopHook: (hook: () => void) => { stopHook = hook },
    attach: (next: SettingsProvider = provider) => {
      release = injectCallback?.({ settings: next, on } as unknown as Context) ?? undefined
      return release
    },
  }
}

describe('official DSH preference settings adapter', () => {
  it('live-applies real Settings leaf mutations and restores base without persisting effective defaults', async () => {
    const persisted: { namespace: string; section: Record<string, unknown> }[] = []
    class MemorySettings extends SettingsProvider {
      readonly writable = true
      protected async load(): Promise<Record<string, unknown>> { return {} }
      protected async persist(namespace: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
        persisted.push({ namespace: String(namespace), section: structuredClone(section) })
      }
    }
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const owner = provideDshTuiPreferencesSettings(ctx, {
      rowConfig: { theme: { preset: 'cordis' }, density: 'comfortable' },
    })
    const catalog = new DshSettingsCatalog(ctx)
    const reportError = vi.fn()
    const application = new PreferenceApplication(owner.service, undefined, reportError)
    try {
      await vi.waitFor(() => expect(owner.service.status().available).toBe(true))
      await application.start()
      expect(application.snapshot()).toMatchObject({ theme: { preset: 'cordis' }, density: 'comfortable' })
      const descriptor = () => catalog.settingsSnapshot().namespaces.find(item => item.namespace === 'dsh-tui')!
      await catalog.mutateSettings({ namespace: 'dsh-tui', path: ['theme', 'preset'], operation: 'set',
        value: 'mono', expectedRevision: descriptor().revision })
      await expect(owner.service.read()).resolves.toMatchObject({ preferences: { version: 1, theme: { preset: 'mono' }, density: 'comfortable' } })
      await vi.waitFor(() => expect(application.snapshot().theme.preset).toBe('mono'))
      expect(descriptor().user).toEqual({ theme: { preset: 'mono' } })
      expect(persisted.at(-1)).toEqual({ namespace: 'dsh-tui', section: { theme: { preset: 'mono' } } })

      await catalog.mutateSettings({ namespace: 'dsh-tui', path: [], operation: 'batch',
        changes: [{ operation: 'set', path: ['density'], value: 'compact' }, { operation: 'set', path: ['reducedMotion'], value: true }],
        expectedRevision: descriptor().revision })
      await vi.waitFor(() => expect(application.snapshot()).toMatchObject({ density: 'compact', reducedMotion: true }))
      expect(descriptor().user).toEqual({ theme: { preset: 'mono' }, density: 'compact', reducedMotion: true })

      await catalog.mutateSettings({ namespace: 'dsh-tui', path: [], operation: 'batch',
        changes: [{ operation: 'unset', path: ['theme'] }, { operation: 'unset', path: ['density'] }, { operation: 'unset', path: ['reducedMotion'] }],
        expectedRevision: descriptor().revision })
      await vi.waitFor(() => expect(application.snapshot()).toMatchObject({ theme: { preset: 'cordis' }, density: 'comfortable', reducedMotion: false }))
      expect(descriptor().user).toEqual({})
      expect(persisted.at(-1)?.section).toEqual({})
      expect(reportError).not.toHaveBeenCalled()
    } finally {
      application.dispose()
      await catalog.disposeSettings()
      await owner.dispose()
      await ctx.fiber.dispose()
    }
  })

  it.each([null, [], 'bad document', 7])('keeps invalid non-object user data rejected: %j', async user => {
    const fixture = settingsHarness({ user })
    const owner = provideDshTuiPreferencesSettings(fixture.ctx)
    await expect(owner.service.read()).rejects.toThrow('Preference document must be an object')
    expect(fixture.replace).not.toHaveBeenCalled()
    await owner.dispose()
  })

  it.each([undefined, null, '1'])('does not replace an explicit invalid version: %j', async version => {
    const fixture = settingsHarness({ user: { version, density: 'comfortable' } })
    const owner = provideDshTuiPreferencesSettings(fixture.ctx)
    await expect(owner.service.read()).rejects.toThrow('Preference document has no valid version')
    await owner.dispose()
  })

  it('preserves explicit old and future versions for the existing migration contract', async () => {
    const fixture = settingsHarness({ user: { version: 0, density: 'comfortable' } })
    const migrations = new PreferenceMigrationRegistry()
    const migrate = vi.fn(document => ({ ...document, version: 1 }))
    migrations.register(0, 1, migrate)
    const owner = provideDshTuiPreferencesSettings(fixture.ctx, { migrations })
    await expect(owner.service.read()).resolves.toMatchObject({ preferences: { version: 1, density: 'comfortable' } })
    expect(migrate).toHaveBeenCalledExactlyOnceWith({ version: 0, density: 'comfortable' })
    expect(fixture.replace).not.toHaveBeenCalled()
    await owner.dispose()
    const future = provideDshTuiPreferencesSettings(settingsHarness({ user: { version: 2 } }).ctx)
    await expect(future.service.read()).rejects.toThrow('Unsupported preference version 2')
    await future.dispose()
  })

  it('owns a strict v1 namespace schema with semantic RGB palette input', () => {
    expect(DSH_TUI_SETTINGS_NAMESPACE).toBe('dsh-tui')
    expect(DSH_TUI_PREFERENCES_CAPABILITY).toMatchObject({
      id: 'dsh-tui.preferences/v1',
      scope: 'application',
    })
    expect(DSH_TUI_PREFERENCES_SCHEMA({} as DshTuiPreferencesV1)).toMatchObject(
      DEFAULT_DSH_TUI_PREFERENCES,
    )
    expect(DSH_TUI_PREFERENCES_SCHEMA({
      theme: {
        colors: { accent: 'red' },
        palette: { accent: '#12AbEf', border: 'cyanBright' },
      },
    } as unknown as DshTuiPreferencesV1)).toMatchObject({
      version: 1,
      theme: {
        colors: { accent: 'red' },
        palette: { accent: '#12AbEf', border: 'cyanBright' },
      },
    })
    expect(() => DSH_TUI_PREFERENCES_SCHEMA({
      theme: { palette: { accent: '#fff' } },
    } as unknown as DshTuiPreferencesV1)).toThrow()
  })

  it('registers lazy official Settings state without descriptor IO', async () => {
    const fixture = settingsHarness({
      revision: 7,
      user: {
        version: 1,
        density: 'compact',
        theme: { palette: { accent: '#abcdef' } },
      },
    })
    const migrations = new PreferenceMigrationRegistry()
    const owner = provideDshTuiPreferencesSettings(fixture.ctx, {
      migrations,
      rowConfig: {
        density: 'comfortable',
        layoutMode: 'split',
        theme: { palette: { accent: '#123456', border: 'gray' } },
        promptDraft: 'must be dropped',
      },
    })

    expect(fixture.register).toHaveBeenCalledOnce()
    expect(String(fixture.register.mock.calls[0]?.[0])).toBe('dsh-tui')
    expect(fixture.register.mock.calls[0]?.[1]).toBe(DSH_TUI_PREFERENCES_SCHEMA)
    expect(fixture.register.mock.calls[0]?.[2]).toEqual({
      applies: 'live',
      base: {
        density: 'comfortable',
        layoutMode: 'split',
        theme: { palette: { accent: '#123456', border: 'gray' } },
      },
    })
    expect(fixture.describe).not.toHaveBeenCalled()
    expect(owner.service.status()).toEqual({
      available: true,
      writable: true,
      documentBacked: true,
    })

    await expect(owner.service.read()).resolves.toEqual({
      revision: 7,
      preferences: {
        ...DEFAULT_DSH_TUI_PREFERENCES,
        density: 'compact',
        layoutMode: 'split',
        theme: {
          preset: 'auto',
          palette: { accent: '#abcdef', border: 'gray' },
        },
      },
    })
    expect(fixture.describe).toHaveBeenCalledExactlyOnceWith({ redactSecrets: true })
    await owner.dispose()
  })

  it('performs official whole-namespace CAS writes and observes only its namespace', async () => {
    const fixture = settingsHarness({ revision: 3 })
    const owner = provideDshTuiPreferencesSettings(fixture.ctx)
    const changed = vi.fn()
    const stop = owner.service.onChanged(changed)
    owner.service.onChanged(() => { throw new Error('observer failed') })

    fixture.emit('another-feature')
    expect(changed).not.toHaveBeenCalled()
    fixture.emit('dsh-tui')
    expect(changed).toHaveBeenCalledOnce()
    await expect(owner.service.read()).resolves.toEqual({
      revision: 3,
      preferences: DEFAULT_DSH_TUI_PREFERENCES,
    })

    const next = preferences({
      density: 'comfortable',
      navigationKeys: 'vim',
      reducedMotion: true,
      layoutMode: 'single',
      defaultTranscriptMode: 'verbose',
      uiLanguage: 'zh',
      theme: { preset: 'cordis', palette: { accent: '#224466' } },
    })
    await expect(owner.service.write(3, next)).resolves.toEqual({
      revision: 4,
      preferences: next,
    })
    expect(fixture.replace).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      next,
      3,
    )
    expect(String(fixture.replace.mock.calls[0]?.[0])).toBe('dsh-tui')
    expect(changed).toHaveBeenCalledTimes(2)
    await expect(owner.service.write(3, next)).rejects.toThrow(
      'CAS conflict: expected 3, actual 4',
    )

    stop()
    stop()
    fixture.emit('dsh-tui')
    expect(changed).toHaveBeenCalledTimes(2)
    await owner.dispose()
  })

  it('contains unavailable, read-only, detach, and owner disposal states', async () => {
    const missing = settingsHarness({ available: false })
    const missingOwner = provideDshTuiPreferencesSettings(missing.ctx, {
      rowConfig: { density: 'comfortable' },
    })
    expect(missing.register).not.toHaveBeenCalled()
    expect(missingOwner.service.status()).toEqual({
      available: false,
      writable: false,
      documentBacked: false,
    })
    await expect(missingOwner.service.read()).resolves.toEqual({
      revision: 0,
      preferences: { ...DEFAULT_DSH_TUI_PREFERENCES, density: 'comfortable' },
    })
    await expect(missingOwner.service.write(
      0,
      preferences(),
    )).rejects.toThrow('Settings service is unavailable')
    await missingOwner.dispose()

    const readOnly = settingsHarness({ writable: false, documentPath: '' })
    const readOnlyOwner = provideDshTuiPreferencesSettings(readOnly.ctx)
    expect(readOnlyOwner.service.status()).toEqual({
      available: true,
      writable: false,
      documentBacked: true,
    })
    await expect(readOnlyOwner.service.write(
      0,
      preferences(),
    )).rejects.toThrow('Settings provider is read-only')

    const duplicateRelease = readOnly.attach()
    expect(readOnly.register).toHaveBeenCalledOnce()
    expect(duplicateRelease).toEqual(expect.any(Function))

    const changed = vi.fn()
    readOnlyOwner.service.onChanged(changed)
    const staleListeners = [...readOnly.listeners]
    readOnly.release()
    readOnly.release()
    expect(changed).toHaveBeenCalledOnce()
    for (const listener of staleListeners) listener('dsh-tui', 1)
    expect(changed).toHaveBeenCalledOnce()
    expect(readOnlyOwner.service.status().available).toBe(false)

    await readOnlyOwner.dispose()
    await readOnlyOwner.dispose()
    expect(readOnly.injectionDispose).toHaveBeenCalledOnce()
    expect(readOnlyOwner.service.status()).toEqual({
      available: false,
      writable: false,
      documentBacked: false,
    })
    const disposedObserver = vi.fn()
    const stopDisposed = readOnlyOwner.service.onChanged(disposedObserver)
    stopDisposed()
    const disposedRelease = readOnly.attach()
    disposedRelease?.()
    readOnly.emit('dsh-tui')
    expect(disposedObserver).not.toHaveBeenCalled()
    await expect(readOnlyOwner.service.write(
      0,
      preferences(),
    )).rejects.toThrow('Settings service is unavailable')
  })

  it('fails clearly if the provider loses its namespace descriptor', async () => {
    const fixture = settingsHarness()
    const owner = provideDshTuiPreferencesSettings(fixture.ctx)
    fixture.describe.mockReturnValueOnce([])
    await expect(owner.service.read()).rejects.toThrow(
      'DSH-TUI preference namespace is not registered',
    )
    await owner.dispose()
  })

  it('contains a provider replacement that arrives during old-listener teardown', async () => {
    const fixture = settingsHarness()
    const owner = provideDshTuiPreferencesSettings(fixture.ctx)
    const replacement = {
      ...fixture.provider,
      writable: false,
      documentPath: undefined,
    } as unknown as SettingsProvider
    fixture.setStopHook(() => { fixture.attach(replacement) })

    fixture.release()

    expect(fixture.register).toHaveBeenCalledTimes(2)
    expect(owner.service.status()).toEqual({
      available: true,
      writable: false,
      documentBacked: false,
    })
    await owner.dispose()
  })
})
