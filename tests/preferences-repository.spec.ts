import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DSH_TUI_PREFERENCES,
  DSH_TUI_SETTINGS_NAMESPACE,
  type DshTuiPreferencesV1,
} from '../src/preferences/contracts.ts'
import { PreferenceMigrationRegistry } from '../src/preferences/migrations.ts'
import {
  DshTuiPreferenceRepository,
  type PreferenceSettingsNamespacePort,
  type PreferenceSettingsNamespaceSnapshot,
} from '../src/preferences/repository.ts'

function settingsPort(
  initial: PreferenceSettingsNamespaceSnapshot = { revision: 0 },
): PreferenceSettingsNamespacePort & {
  readonly read: ReturnType<typeof vi.fn<() => Promise<PreferenceSettingsNamespaceSnapshot>>>
  readonly compareAndSwap: ReturnType<typeof vi.fn>
} {
  let snapshot = initial
  return {
    read: vi.fn(async () => snapshot),
    compareAndSwap: vi.fn(async request => {
      if (request.expectedRevision !== snapshot.revision) {
        throw new Error(`CAS conflict: expected ${request.expectedRevision}, actual ${snapshot.revision}`)
      }
      snapshot = { revision: snapshot.revision + 1, value: request.value }
      return { revision: snapshot.revision }
    }),
  }
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

describe('DSH-TUI preference repository', () => {
  it('depends on the product theme contract rather than the retained UI layer', () => {
    const directory = fileURLToPath(new URL('../src/preferences/', import.meta.url))
    const preferenceSources = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
      .map(entry => readFileSync(`${directory}/${entry.name}`, 'utf8'))

    expect(preferenceSources.join('\n')).not.toMatch(/from\s+['"][^'"]*ui\//u)
    expect(preferenceSources.join('\n')).toContain("from '../theme/contracts.ts'")
  })

  it('defines the product namespace and immutable v1 defaults', () => {
    expect(DSH_TUI_SETTINGS_NAMESPACE).toBe('dsh-tui')
    expect(DEFAULT_DSH_TUI_PREFERENCES).toEqual({
      version: 1,
      theme: { preset: 'auto' },
      density: 'compact',
      navigationKeys: 'both',
      reducedMotion: false,
      layoutMode: 'auto',
      defaultTranscriptMode: 'compact',
      uiLanguage: 'en',
    })
    expect(Object.isFrozen(DEFAULT_DSH_TUI_PREFERENCES)).toBe(true)
    expect(Object.isFrozen(DEFAULT_DSH_TUI_PREFERENCES.theme)).toBe(true)
  })

  it('merges defaults, Cordis row config, and user settings in that order', async () => {
    const port = settingsPort({
      revision: 7,
      value: {
        version: 1,
        density: 'compact',
        navigationKeys: 'arrows',
        theme: {
          colors: { accent: 'magentaBright', user: 'greenBright' },
          palette: { accent: '#abcdef', warning: 'yellow' },
        },
      },
    })
    const repository = new DshTuiPreferenceRepository({
      port,
      rowConfig: {
        version: 1,
        density: 'comfortable',
        navigationKeys: 'vim',
        reducedMotion: true,
        layoutMode: 'split',
        defaultTranscriptMode: 'verbose',
        uiLanguage: 'zh',
        theme: {
          preset: 'cordis',
          colors: { accent: 'cyanBright', border: 'gray' },
          palette: { accent: '#123456', border: 'gray' },
        },
      },
    })

    const snapshot = await repository.read()
    expect(port.read).toHaveBeenCalledOnce()
    expect(snapshot).toEqual({
      revision: 7,
      preferences: {
        version: 1,
        density: 'compact',
        navigationKeys: 'arrows',
        reducedMotion: true,
        layoutMode: 'split',
        defaultTranscriptMode: 'verbose',
        uiLanguage: 'zh',
        theme: {
          preset: 'cordis',
          colors: {
            accent: 'magentaBright',
            border: 'gray',
            user: 'greenBright',
          },
          palette: {
            accent: '#abcdef',
            border: 'gray',
            warning: 'yellow',
          },
        },
      },
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.preferences)).toBe(true)
    expect(Object.isFrozen(snapshot.preferences.theme)).toBe(true)
    expect(Object.isFrozen(snapshot.preferences.theme.colors)).toBe(true)
    expect(Object.isFrozen(snapshot.preferences.theme.palette)).toBe(true)
  })

  it('drops unknown persisted fields instead of retaining session or transcript data', async () => {
    const port = settingsPort({
      revision: 3,
      value: {
        version: 1,
        density: 'comfortable',
        transcript: [{ role: 'user', text: 'secret' }],
        rawToolOutput: 'private output',
        attachmentPath: 'D:\\secret.png',
        sessionViewMode: 'verbose',
        promptDraft: 'do not persist',
        theme: {
          preset: 'mono',
          apiKey: 'secret',
          colors: { accent: 'white', token: 'secret' },
          palette: { accent: '#abcdef', secret: '#000000' },
        },
      },
    })
    const repository = new DshTuiPreferenceRepository({
      port,
      rowConfig: {
        unknownRowValue: true,
        theme: { unknownThemeValue: true },
      },
    })

    const snapshot = await repository.read()
    expect(snapshot.preferences).toEqual({
      ...DEFAULT_DSH_TUI_PREFERENCES,
      density: 'comfortable',
      theme: {
        preset: 'mono',
        colors: { accent: 'white' },
        palette: { accent: '#abcdef' },
      },
    })
    expect(JSON.stringify(snapshot.preferences)).not.toMatch(
      /transcript|rawToolOutput|attachmentPath|sessionViewMode|promptDraft|apiKey|token/,
    )
  })

  it('performs a strict CAS write using only the v1 preference schema', async () => {
    const port = settingsPort({ revision: 4 })
    const repository = new DshTuiPreferenceRepository({ port })
    const next = preferences({
      density: 'comfortable',
      navigationKeys: 'vim',
      reducedMotion: true,
      layoutMode: 'single',
      defaultTranscriptMode: 'verbose',
      theme: { preset: 'mono', colors: { primary: 'white', muted: 'gray' } },
    })

    const written = await repository.write(4, next)
    expect(port.compareAndSwap).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 4,
      value: next,
    })
    expect(written).toEqual({ revision: 5, preferences: next })
    await expect(repository.write(4, next)).rejects.toThrow(
      'CAS conflict: expected 4, actual 5',
    )
  })

  it('rejects unknown or incomplete writes before calling the port', async () => {
    const port = settingsPort({ revision: 1 })
    const repository = new DshTuiPreferenceRepository({ port })
    const hostileKeys = [
      'transcript',
      'rawToolOutput',
      'attachmentPath',
      'sessionViewMode',
      'promptDraft',
    ] as const
    for (const key of hostileKeys) {
      await expect(repository.write(1, {
        ...preferences(),
        [key]: 'forbidden',
      } as DshTuiPreferencesV1)).rejects.toThrow(`Unknown preference key: ${key}`)
    }
    await expect(repository.write(1, {
      ...preferences(),
      theme: { preset: 'auto', secret: 'forbidden' },
    } as DshTuiPreferencesV1)).rejects.toThrow('Unknown theme preference key: secret')
    await expect(repository.write(1, {
      ...preferences(),
      theme: { colors: { accent: 'cyan', secret: 'forbidden' } },
    } as DshTuiPreferencesV1)).rejects.toThrow('Unknown theme color role: secret')
    await expect(repository.write(1, {
      ...preferences(),
      theme: { palette: { accent: '#abcdef', secret: '#000000' } },
    } as DshTuiPreferencesV1)).rejects.toThrow(
      'Unknown semantic theme color role: secret',
    )
    await expect(repository.write(1, {
      ...preferences(),
      theme: { palette: { accent: '#fff' } },
    } as DshTuiPreferencesV1)).rejects.toThrow(
      'Invalid semantic theme color for accent: #fff',
    )
    await expect(repository.write(1, {
      version: 1,
      theme: { preset: 'auto' },
    } as DshTuiPreferencesV1)).rejects.toThrow('Missing preference key: density')
    expect(port.compareAndSwap).not.toHaveBeenCalled()
  })

  it('validates known values, versions, revisions, and port results', async () => {
    const invalidDocuments: readonly unknown[] = [
      'not-an-object',
      {},
      { version: 2 },
      { version: 1, density: 'spacious' },
      { version: 1, navigationKeys: 'emacs' },
      { version: 1, uiLanguage: 'fr' },
      { version: 1, reducedMotion: 'no' },
      { version: 1, layoutMode: 'columns' },
      { version: 1, defaultTranscriptMode: 'all' },
      { version: 1, theme: 'cordis' },
      { version: 1, theme: { preset: 'rainbow' } },
      { version: 1, theme: { colors: 'cyan' } },
      { version: 1, theme: { colors: { accent: 'ultraviolet' } } },
      { version: 1, theme: { palette: 'cyan' } },
      { version: 1, theme: { palette: { accent: 42 } } },
      { version: 1, theme: { palette: { accent: '#fff' } } },
    ]
    for (const value of invalidDocuments) {
      const repository = new DshTuiPreferenceRepository({
        port: settingsPort({ revision: 1, value }),
      })
      await expect(repository.read()).rejects.toThrow()
    }

    await expect(new DshTuiPreferenceRepository({
      port: settingsPort({ revision: -1 }),
    }).read()).rejects.toThrow('Settings revision must be a non-negative integer')

    const badResultPort = settingsPort({ revision: 0 })
    badResultPort.compareAndSwap.mockResolvedValueOnce({ revision: -1 })
    await expect(new DshTuiPreferenceRepository({ port: badResultPort }).write(
      0,
      preferences(),
    )).rejects.toThrow('Settings revision must be a non-negative integer')
    await expect(new DshTuiPreferenceRepository({
      port: settingsPort(),
    }).write(-1, preferences())).rejects.toThrow(
      'Expected revision must be a non-negative integer',
    )
  })

  it('uses registered migrations without sharing state between repositories', async () => {
    const migrations = new PreferenceMigrationRegistry()
    migrations.register(0, 1, document => ({
      ...document,
      version: 1,
      density: 'comfortable',
    }))
    const firstPort = settingsPort({ revision: 1, value: { version: 0 } })
    const secondPort = settingsPort({
      revision: 9,
      value: { version: 1, density: 'compact', reducedMotion: true },
    })
    const first = new DshTuiPreferenceRepository({ port: firstPort, migrations })
    const second = new DshTuiPreferenceRepository({
      port: secondPort,
      rowConfig: { layoutMode: 'split' },
    })

    expect((await first.read()).preferences).toMatchObject({
      density: 'comfortable',
      reducedMotion: false,
      layoutMode: 'auto',
    })
    expect((await second.read()).preferences).toMatchObject({
      density: 'compact',
      reducedMotion: true,
      layoutMode: 'split',
    })
    await first.write(1, preferences({ density: 'comfortable' }))
    expect((await second.read()).revision).toBe(9)
  })

  it('accepts absent user settings and rejects unsupported row configuration', async () => {
    const repository = new DshTuiPreferenceRepository({ port: settingsPort() })
    expect(await repository.read()).toEqual({
      revision: 0,
      preferences: DEFAULT_DSH_TUI_PREFERENCES,
    })

    await expect(new DshTuiPreferenceRepository({
      port: settingsPort(),
      rowConfig: { version: 2 },
    }).read()).rejects.toThrow('Unsupported preference version 2; current version is 1')
    await expect(new DshTuiPreferenceRepository({
      port: settingsPort(),
      rowConfig: 'invalid',
    }).read()).rejects.toThrow('Preference overrides must be an object')
  })
})
