import type { SessionModeSnapshot } from '../../mode/port.ts'
import type { AgentPresetCatalogEntry } from '../../preset/catalog-port.ts'

export interface ModesChoice {
  readonly id: string
  readonly trust: AgentPresetCatalogEntry['trust']
  readonly name: string
  readonly description?: string
  readonly broken?: string
  readonly isCurrent: boolean
  readonly isDefault: boolean
}

function detachPreset(entry: AgentPresetCatalogEntry): AgentPresetCatalogEntry {
  return Object.freeze({
    id: entry.id,
    trust: entry.trust,
    sourcePath: entry.sourcePath,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.broken === undefined ? {} : { broken: entry.broken }),
    isDefault: entry.isDefault,
  })
}

/** Detach adapter-owned arrays while keeping source provenance outside the UI projection. */
export function detachModesSnapshot(snapshot: SessionModeSnapshot): SessionModeSnapshot {
  return Object.freeze({
    available: snapshot.available,
    ...(snapshot.current === undefined ? {} : { current: snapshot.current }),
    ...(snapshot.defaultId === undefined ? {} : { defaultId: snapshot.defaultId }),
    loading: snapshot.loading,
    selecting: snapshot.selecting,
    locked: snapshot.locked,
    presets: Object.freeze(snapshot.presets.map(detachPreset)),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  })
}

/** Presentation-safe rows deliberately omit preset sourcePath. */
export function projectModesChoices(
  snapshot: SessionModeSnapshot | undefined,
): readonly ModesChoice[] {
  if (snapshot === undefined) return Object.freeze([])
  return Object.freeze(snapshot.presets.map(preset => Object.freeze({
    id: preset.id,
    trust: preset.trust,
    name: preset.name ?? preset.id,
    ...(preset.description === undefined ? {} : { description: preset.description }),
    ...(preset.broken === undefined ? {} : { broken: preset.broken }),
    isCurrent: preset.id === snapshot.current,
    isDefault: preset.id === snapshot.defaultId || preset.isDefault,
  })))
}

