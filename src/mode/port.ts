import type { AgentPresetCatalogEntry } from '../preset/catalog-port.ts'

/** Detached view of one live Agent's DSH preset composition. */
export interface SessionModeSnapshot {
  readonly available: boolean
  readonly current?: string
  readonly defaultId?: string
  readonly loading: boolean
  readonly selecting: boolean
  /** A durable turn/start permanently fixes the composition for this Session. */
  readonly locked: boolean
  readonly presets: readonly AgentPresetCatalogEntry[]
  readonly error?: string
}

export interface SessionModeSelectOptions {
  readonly signal?: AbortSignal
}

/** Product-owned seam over DSH AgentPresets.recompose(). */
export interface SessionModePort {
  modeSnapshot(): SessionModeSnapshot
  refreshModes(signal?: AbortSignal): Promise<void>
  selectMode(modeId: string, options?: SessionModeSelectOptions): Promise<void>
  onModesChanged(listener: () => void): () => void
  disposeModes(): void
}

const UNAVAILABLE_MODE_SNAPSHOT: SessionModeSnapshot = Object.freeze({
  available: false,
  loading: false,
  selecting: false,
  locked: false,
  presets: Object.freeze([]),
})

/** Compatibility seam for non-DSH test and embedder leases. */
export function createUnavailableSessionModePort(): SessionModePort {
  return {
    modeSnapshot: () => UNAVAILABLE_MODE_SNAPSHOT,
    refreshModes: () => Promise.resolve(),
    selectMode: () => Promise.reject(
      new Error('DSH Agent mode selection is unavailable for this Session'),
    ),
    onModesChanged: () => () => {},
    disposeModes: () => {},
  }
}
