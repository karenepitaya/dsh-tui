export type SettingsApplies = 'live' | 'restart'

export interface SettingsSecretSlot {
  readonly path: readonly string[]
  readonly set: boolean
}

export interface SettingsNamespaceSnapshot {
  readonly namespace: string
  readonly schema: unknown
  readonly value: unknown
  readonly revision: number
  readonly base?: unknown
  readonly user?: unknown
  readonly applies: SettingsApplies
  readonly secrets: readonly SettingsSecretSlot[]
}

export interface SettingsCatalogSnapshot {
  readonly available: boolean
  readonly writable: boolean
  readonly documentBacked: boolean
  readonly generation: number
  readonly namespaces: readonly SettingsNamespaceSnapshot[]
  /** Optional product choices from the currently available preset catalog. */
  readonly presetChoices?: readonly { readonly id: string; readonly name: string }[]
  readonly stale?: boolean
  readonly error?: string
}

export type SettingsMutationRequest = {
  readonly namespace: string
  readonly path: readonly string[]
  readonly expectedRevision: number
} & (
  | { readonly operation: 'set'; readonly value: unknown }
  | { readonly operation: 'unset' }
  | { readonly operation: 'batch'; readonly changes: readonly (
    | { readonly operation: 'set'; readonly path: readonly string[]; readonly value: unknown }
    | { readonly operation: 'unset'; readonly path: readonly string[] }
  )[] }
)

/** App-global settings capability; values crossing this seam are always redacted. */
export interface SettingsCatalogPort {
  settingsSnapshot(): SettingsCatalogSnapshot
  onSettingsChanged(listener: () => void): () => void
  mutateSettings(request: SettingsMutationRequest): Promise<void>
}
