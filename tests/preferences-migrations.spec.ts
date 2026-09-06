import { describe, expect, it, vi } from 'vitest'
import { PreferenceMigrationRegistry } from '../src/preferences/migrations.ts'

describe('preference migration registry', () => {
  it('uses v1 as an identity and does not invoke a migration', () => {
    const registry = new PreferenceMigrationRegistry()
    const document = { version: 1, density: 'compact' }
    expect(registry.migrate(document, 1)).toBe(document)
  })

  it('supports explicitly registered future migration steps per instance', () => {
    const registry = new PreferenceMigrationRegistry()
    const migrate = vi.fn((document: Readonly<Record<string, unknown>>) => ({
      ...document,
      version: 1,
      density: 'comfortable',
    }))
    registry.register(0, 1, migrate)

    expect(registry.migrate({ version: 0 }, 1)).toEqual({
      version: 1,
      density: 'comfortable',
    })
    expect(migrate).toHaveBeenCalledExactlyOnceWith({ version: 0 })

    const isolated = new PreferenceMigrationRegistry()
    expect(() => isolated.migrate({ version: 0 }, 1))
      .toThrow('No preference migration registered for version 0')
  })

  it('rejects duplicates, invalid steps, future versions, and malformed output', () => {
    const registry = new PreferenceMigrationRegistry()
    registry.register(0, 1, () => ({ version: 1 }))
    expect(() => registry.register(0, 1, () => ({ version: 1 })))
      .toThrow('Duplicate preference migration from version 0')
    expect(() => registry.register(1, 3, () => ({ version: 3 })))
      .toThrow('Preference migrations must advance exactly one version: 1 -> 3')
    expect(() => registry.register(-1, 0, () => ({ version: 0 })))
      .toThrow('Preference migration versions must be non-negative integers')
    expect(() => registry.register(1.5, 2.5, () => ({ version: 2.5 })))
      .toThrow('Preference migration versions must be non-negative integers')
    expect(() => registry.migrate({ version: 2 }, 1))
      .toThrow('Unsupported preference version 2; current version is 1')

    const broken = new PreferenceMigrationRegistry()
    broken.register(0, 1, () => ({ version: 0 }))
    expect(() => broken.migrate({ version: 0 }, 1))
      .toThrow('Preference migration 0 -> 1 returned version 0')
    expect(() => broken.migrate({}, 1))
      .toThrow('Preference document has no valid version')
    expect(() => broken.migrate({ version: -1 }, 1))
      .toThrow('Preference document has no valid version')
    expect(() => broken.migrate({ version: 1.2 }, 1))
      .toThrow('Preference document has no valid version')
    expect(() => broken.migrate(null, 1))
      .toThrow('Preference document must be an object')
    expect(() => broken.migrate({ version: 1 }, -1))
      .toThrow('Target preference version must be a non-negative integer')
  })
})
