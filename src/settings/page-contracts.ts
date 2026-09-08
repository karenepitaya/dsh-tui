import type { SettingsCatalogSnapshot, SettingsMutationRequest } from './port.ts'
import type { PromptEditorState } from '../ui/prompt-editor.ts'

export type SettingsSection = 'general' | 'models' | 'plugins' | 'presets'
export type SettingsFieldControl = 'select' | 'boolean' | 'number' | 'text' | 'secret' | 'readonly'
export interface SettingsField {
  readonly id: string
  readonly namespace: string
  readonly path: readonly string[]
  readonly section: SettingsSection
  readonly group: string
  readonly label: string
  readonly description: string
  readonly control: SettingsFieldControl
  readonly value: unknown
  readonly inheritedValue?: unknown
  readonly overridden: boolean
  readonly secretSet?: boolean | undefined
  readonly options?: readonly { readonly label: string; readonly value: unknown }[]
  readonly minimum?: number
  readonly maximum?: number
  readonly integer?: boolean
  readonly applies: 'live' | 'restart'
}
export interface SettingsDraft {
  readonly field: SettingsField
  readonly expectedRevision: number
  readonly operation: 'set' | 'unset'
  readonly value?: unknown
}
export type SettingsPageFocus = 'tabs' | 'form' | 'actions' | 'search'
export interface SettingsPageState {
  readonly section: SettingsSection
  readonly focus: SettingsPageFocus
  readonly selection: number
  readonly actionIndex: number
  readonly query: PromptEditorState
  readonly drafts: Readonly<Record<string, SettingsDraft>>
  readonly editor?: {
    readonly fieldId: string
    readonly field: SettingsField
    readonly expectedRevision: number
    readonly input: PromptEditorState
  }
  readonly picker?: {
    readonly fieldId: string
    readonly field: SettingsField
    readonly expectedRevision: number
    readonly selection: number
  }
  readonly confirmation?: 'discard' | 'reset' | 'permission'
  readonly confirmIndex: number
  readonly pending: boolean
  readonly notice?: string
  readonly error?: string
}
export interface SettingsPageView {
  readonly navigationKeys?: 'arrows' | 'vim' | 'both'
  readonly section: SettingsSection
  readonly focus: SettingsPageFocus
  readonly fields: readonly SettingsField[]
  readonly selection: number
  readonly actionIndex: number
  readonly query: PromptEditorState
  readonly dirtyIds: readonly string[]
  readonly dirtyCount: number
  readonly editor?: { readonly field: SettingsField; readonly input: PromptEditorState }
  readonly picker?: { readonly field: SettingsField; readonly selection: number }
  readonly confirmation?: 'discard' | 'reset' | 'permission'
  readonly confirmIndex: number
  readonly pending: boolean
  readonly writable: boolean
  readonly available: boolean
  readonly documentBacked: boolean
  readonly notice?: string
  readonly error?: string
}
export type SettingsPageOutcome =
  | { readonly kind: 'close' }
  | { readonly kind: 'save'; readonly requests: readonly SettingsMutationRequest[] }
export interface SettingsPageTransition {
  readonly state: SettingsPageState
  readonly outcome?: SettingsPageOutcome
}
export interface SettingsSaveResult {
  readonly namespace: string
  readonly error?: string
}
export type SettingsPageCatalog = SettingsCatalogSnapshot
