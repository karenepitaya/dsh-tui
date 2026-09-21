import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type SettingsProvider,
} from '@deepseek-ai/dsh-settings'
import type {
  DshTuiPreferencesApplicationPort,
  DshTuiPreferencesApplicationStatus,
} from '../preferences/port.ts'
import {
  DSH_TUI_ANSI_COLORS,
  DSH_TUI_SEMANTIC_ROLES,
  DSH_TUI_THEME_PRESETS,
  type DshTuiThemeConfig,
} from '../theme/contracts.ts'
import { SEMANTIC_COLOR_ROLES } from '../theme/semantic-colors.ts'
import {
  DEFAULT_DSH_TUI_PREFERENCES,
  DSH_TUI_SETTINGS_NAMESPACE,
  type DshTuiPreferencesV1,
} from '../preferences/contracts.ts'
import {
  DshTuiPreferenceRepository,
  type DshTuiPreferenceRepositoryOptions,
  type PreferenceSettingsNamespacePort,
  type PreferenceSettingsNamespaceSnapshot,
  type PreferenceSettingsNamespaceWrite,
} from '../preferences/repository.ts'
import { parsePreferenceOverrides } from '../preferences/codec.ts'
import type { PreferenceMigrationRegistry } from '../preferences/migrations.ts'

const PREFERENCES_NAMESPACE = DSH_TUI_SETTINGS_NAMESPACE

const themeSchema: z<DshTuiThemeConfig> = z.object({
  preset: z.union(DSH_TUI_THEME_PRESETS).default('auto'),
  palette: z.dict(
    z.union([
      ...DSH_TUI_ANSI_COLORS,
      z.string().pattern(/^#[\da-f]{6}$/iu),
    ]),
    z.union(SEMANTIC_COLOR_ROLES),
  ),
  colors: z.dict(
    z.union(DSH_TUI_ANSI_COLORS),
    z.union(DSH_TUI_SEMANTIC_ROLES),
  ),
}) as z<DshTuiThemeConfig>

/** Official Settings registration schema for the first durable DSH-TUI format. */
export const DSH_TUI_PREFERENCES_SCHEMA: z<DshTuiPreferencesV1> = z.object({
  version: z.const(1).default(1),
  theme: themeSchema.default(DEFAULT_DSH_TUI_PREFERENCES.theme),
  density: z.union(['compact', 'comfortable'] as const).default('compact'),
  navigationKeys: z.union(['arrows', 'vim', 'both'] as const).default('both'),
  reducedMotion: z.boolean().default(false),
  layoutMode: z.union(['auto', 'single', 'split'] as const).default('auto'),
  defaultTranscriptMode: z.union(['compact', 'verbose'] as const).default('compact'),
}) as z<DshTuiPreferencesV1>

export interface DshTuiPreferencesSettingsOptions {
  readonly rowConfig?: unknown
  readonly migrations?: PreferenceMigrationRegistry
}

export interface DshTuiPreferencesSettingsOwner {
  readonly service: DshTuiPreferencesApplicationPort
  dispose(): Promise<void>
}

interface ActiveSettings {
  readonly provider: SettingsProvider
  readonly release: () => void
}

function sameNamespace(value: unknown): boolean {
  return String(value) === DSH_TUI_SETTINGS_NAMESPACE
}

/** Namespace-bound official Settings bridge; it never exposes other namespaces. */
class DshPreferenceSettingsNamespacePort implements PreferenceSettingsNamespacePort {
  private active: ActiveSettings | undefined
  private readonly listeners = new Set<() => void>()
  private disposed = false

  attach(provider: SettingsProvider, eventContext: Context, rowConfig: unknown): () => void {
    if (this.disposed) return () => {}
    if (this.active?.provider === provider) return this.active.release
    this.active?.release()
    provider.register(PREFERENCES_NAMESPACE, DSH_TUI_PREFERENCES_SCHEMA, {
      base: rowConfig as Partial<DshTuiPreferencesV1>,
      applies: 'live',
    })
    let attached = true
    const stopDocument = eventContext.on(
      'settings/document-updated',
      (namespace) => {
        if (attached && !this.disposed && sameNamespace(namespace)) this.notify()
      },
    )
    const release = () => {
      if (!attached) return
      attached = false
      stopDocument()
      if (this.active?.provider !== provider) return
      this.active = undefined
      if (!this.disposed) this.notify()
    }
    this.active = Object.freeze({ provider, release })
    this.notify()
    return release
  }

  status(): DshTuiPreferencesApplicationStatus {
    const provider = this.active?.provider
    return Object.freeze({
      available: !this.disposed && provider !== undefined,
      writable: !this.disposed && provider?.writable === true,
      documentBacked: !this.disposed && provider?.documentPath !== undefined,
    })
  }

  async read(): Promise<PreferenceSettingsNamespaceSnapshot> {
    const provider = this.active?.provider
    if (this.disposed || provider === undefined) {
      return Object.freeze({ revision: 0 })
    }
    const descriptor = provider.describe({ redactSecrets: true })
      .find(candidate => sameNamespace(candidate.ns))
    if (descriptor === undefined) {
      throw new Error('DSH-TUI preference namespace is not registered')
    }
    // Settings stores partial overrides; the preference repository reads versioned documents.
    const user = descriptor.user
    const value = typeof user === 'object' && user !== null && !Array.isArray(user)
      && !Object.hasOwn(user, 'version')
      ? { ...user, version: DEFAULT_DSH_TUI_PREFERENCES.version }
      : user
    return Object.freeze({
      revision: descriptor.revision,
      ...(value === undefined ? {} : { value }),
    })
  }

  async compareAndSwap(
    request: PreferenceSettingsNamespaceWrite,
  ): Promise<{ readonly revision: number }> {
    const provider = this.active?.provider
    if (this.disposed || provider === undefined) {
      throw new Error('DSH-TUI preference Settings service is unavailable')
    }
    await provider.replace(
      PREFERENCES_NAMESPACE,
      request.value,
      request.expectedRevision,
    )
    const snapshot = await this.read()
    return Object.freeze({ revision: snapshot.revision })
  }

  onChanged(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    /* v8 ignore next -- the public owner memoizes this private teardown. */
    if (this.disposed) return
    this.disposed = true
    this.active?.release()
    this.active = undefined
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // Preference observers cannot veto an official Settings commit.
      }
    }
  }
}

/**
 * Register the official `dsh-tui` namespace and expose a repository-backed app API.
 * Registration is synchronous and performs no storage IO; `read()` is the first
 * lightweight descriptor projection and may be used before the first frame.
 */
export function provideDshTuiPreferencesSettings(
  ctx: Context,
  options: DshTuiPreferencesSettingsOptions = {},
): DshTuiPreferencesSettingsOwner {
  const namespace = new DshPreferenceSettingsNamespacePort()
  const rowConfig = parsePreferenceOverrides(options.rowConfig ?? {}, 'drop')
  const repositoryOptions: DshTuiPreferenceRepositoryOptions = {
    port: namespace,
    rowConfig,
    ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
  }
  const repository = new DshTuiPreferenceRepository(repositoryOptions)
  const serviceFiber = ctx.inject(['settings'], serviceCtx => (
    namespace.attach(serviceCtx.settings, serviceCtx, rowConfig)
  ))
  const service: DshTuiPreferencesApplicationPort = Object.freeze({
    status: () => namespace.status(),
    read: () => repository.read(),
    write: (expectedRevision: number, preferences: DshTuiPreferencesV1) => (
      repository.write(expectedRevision, preferences)
    ),
    onChanged: (listener: () => void) => namespace.onChanged(listener),
  })
  let disposeTask: Promise<void> | undefined
  return Object.freeze({
    service,
    dispose: () => {
      disposeTask ??= (async () => {
        namespace.dispose()
        await serviceFiber.dispose()
      })()
      return disposeTask
    },
  })
}
