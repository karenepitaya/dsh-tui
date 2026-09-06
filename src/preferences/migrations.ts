export type PreferenceMigration = (
  document: Readonly<Record<string, unknown>>,
) => unknown

interface RegisteredMigration {
  readonly toVersion: number
  readonly migrate: PreferenceMigration
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function documentVersion(document: unknown): number {
  if (!isRecord(document)) throw new Error('Preference document must be an object')
  if (!validVersion(document.version)) {
    throw new Error('Preference document has no valid version')
  }
  return document.version
}

/** Per-application migration table. Nothing is stored at module scope. */
export class PreferenceMigrationRegistry {
  private readonly migrations = new Map<number, RegisteredMigration>()

  register(
    fromVersion: number,
    toVersion: number,
    migrate: PreferenceMigration,
  ): void {
    if (!validVersion(fromVersion) || !validVersion(toVersion)) {
      throw new Error('Preference migration versions must be non-negative integers')
    }
    if (toVersion !== fromVersion + 1) {
      throw new Error(
        `Preference migrations must advance exactly one version: ${fromVersion} -> ${toVersion}`,
      )
    }
    if (this.migrations.has(fromVersion)) {
      throw new Error(`Duplicate preference migration from version ${fromVersion}`)
    }
    this.migrations.set(fromVersion, Object.freeze({ toVersion, migrate }))
  }

  migrate(document: unknown, targetVersion: number): unknown {
    if (!validVersion(targetVersion)) {
      throw new Error('Target preference version must be a non-negative integer')
    }
    let current = document
    let version = documentVersion(current)
    if (version > targetVersion) {
      throw new Error(
        `Unsupported preference version ${version}; current version is ${targetVersion}`,
      )
    }
    while (version < targetVersion) {
      const step = this.migrations.get(version)
      if (step === undefined) {
        throw new Error(`No preference migration registered for version ${version}`)
      }
      current = step.migrate(current as Readonly<Record<string, unknown>>)
      const migratedVersion = documentVersion(current)
      if (migratedVersion !== step.toVersion) {
        throw new Error(
          `Preference migration ${version} -> ${step.toVersion} returned version ${migratedVersion}`,
        )
      }
      version = migratedVersion
    }
    return current
  }
}
