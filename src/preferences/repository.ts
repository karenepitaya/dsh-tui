import {
  DSH_TUI_PREFERENCES_VERSION,
  type DshTuiPreferencesV1,
} from './contracts.ts'
import {
  mergePreferenceLayers,
  parsePreferenceOverrides,
  serializePreferencesV1,
} from './codec.ts'
import { PreferenceMigrationRegistry } from './migrations.ts'

export interface PreferenceSettingsNamespaceSnapshot {
  readonly revision: number
  readonly value?: unknown
}

export interface PreferenceSettingsNamespaceWrite {
  readonly expectedRevision: number
  readonly value: DshTuiPreferencesV1
}

export interface PreferenceSettingsNamespacePort {
  read(): Promise<PreferenceSettingsNamespaceSnapshot>
  compareAndSwap(
    request: PreferenceSettingsNamespaceWrite,
  ): Promise<{ readonly revision: number }>
}

export interface DshTuiPreferenceSnapshot {
  readonly revision: number
  readonly preferences: DshTuiPreferencesV1
}

export interface DshTuiPreferenceRepositoryOptions {
  readonly port: PreferenceSettingsNamespacePort
  readonly rowConfig?: unknown
  readonly migrations?: PreferenceMigrationRegistry
}

function revision(value: number, label: 'Settings' | 'Expected'): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} revision must be a non-negative integer`)
  }
  return value
}

function freezeSnapshot(
  value: number,
  preferences: DshTuiPreferencesV1,
): DshTuiPreferenceSnapshot {
  return Object.freeze({ revision: value, preferences })
}

/** Pure product repository over a namespace-bound Settings port. */
export class DshTuiPreferenceRepository {
  private readonly port: PreferenceSettingsNamespacePort
  private readonly rowConfig: unknown
  private readonly migrations: PreferenceMigrationRegistry

  constructor(options: DshTuiPreferenceRepositoryOptions) {
    this.port = options.port
    this.rowConfig = options.rowConfig ?? {}
    this.migrations = options.migrations ?? new PreferenceMigrationRegistry()
  }

  async read(): Promise<DshTuiPreferenceSnapshot> {
    const settings = await this.port.read()
    const settingsRevision = revision(settings.revision, 'Settings')
    const row = parsePreferenceOverrides(this.rowConfig, 'drop')
    const user = settings.value === undefined
      ? Object.freeze({})
      : parsePreferenceOverrides(
          this.migrations.migrate(settings.value, DSH_TUI_PREFERENCES_VERSION),
          'drop',
        )
    return freezeSnapshot(settingsRevision, mergePreferenceLayers(row, user))
  }

  async write(
    expectedRevision: number,
    preferences: DshTuiPreferencesV1,
  ): Promise<DshTuiPreferenceSnapshot> {
    const expected = revision(expectedRevision, 'Expected')
    const clean = serializePreferencesV1(preferences)
    const result = await this.port.compareAndSwap({
      expectedRevision: expected,
      value: clean,
    })
    return freezeSnapshot(revision(result.revision, 'Settings'), clean)
  }
}
