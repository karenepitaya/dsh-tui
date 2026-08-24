/** Origin label inherited from the official preset root. */
export type AgentPresetTrust = 'system' | 'user'

/** Minimal selection passed from the picker into runtime preparation. */
export interface AgentPresetSelectionPlan {
  readonly id: string
  readonly trust: AgentPresetTrust
  /** Official composition path retained for internal provenance validation only. */
  readonly sourcePath: string
}

/** One immutable preset projected for selection and provenance checks. */
export interface AgentPresetCatalogEntry extends AgentPresetSelectionPlan {
  readonly name?: string
  readonly description?: string
  readonly broken?: string
  readonly isDefault: boolean
}

/** One point-in-time view of the official preset roster and effective default. */
export interface AgentPresetCatalogSnapshot {
  readonly defaultId: string
  readonly presets: readonly AgentPresetCatalogEntry[]
}

export interface ListAgentPresetsOptions {
  readonly signal?: AbortSignal
}

/** Read-only preset discovery seam. It does not resolve, mount, or recompose. */
export interface AgentPresetCatalogPort {
  listPresets(options?: ListAgentPresetsOptions): Promise<AgentPresetCatalogSnapshot>
}
