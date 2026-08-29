export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

export interface PluginInventoryEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

export interface PluginInventorySnapshot {
  readonly available: boolean
  readonly entries: readonly PluginInventoryEntry[]
  readonly error?: string
}

/** Point-in-time Loader projection. It deliberately exposes no mutation API. */
export interface PluginInventoryPort {
  pluginInventorySnapshot(): PluginInventorySnapshot
}
