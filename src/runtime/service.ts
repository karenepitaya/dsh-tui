import type { DshTuiModelSelection } from '../model/port.ts'
import type { PluginInventoryPort } from '../plugin-inventory/port.ts'
import type {
  AgentPresetCatalogPort,
  AgentPresetSelectionPlan,
} from '../preset/catalog-port.ts'
import type { ProviderConnectionPort } from '../provider/port.ts'
import type { SessionActivationPort } from '../session/activation-port.ts'
import type { SessionCatalogPort } from '../session/catalog-port.ts'
import type { SessionForkPort } from '../session/fork-port.ts'
import type { SessionInspectionPort } from '../session/inspection-port.ts'
import type { SettingsCatalogPort } from '../settings/port.ts'
import type { DshTuiSessionPort } from './tui-session-port.ts'
import type { RuntimeSessionLease } from './runtime-session.ts'

export type {
  RuntimeSessionCapabilityResolver,
  RuntimeSessionCorePort,
  RuntimeSessionLease,
} from './runtime-session.ts'

/** Product-owned request DTO; adapter-specific setup stays behind the boundary. */
export interface OpenDshTuiSessionOptions {
  readonly mode?: 'create'
  readonly sessionId?: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly agentPresetPlan?: AgentPresetSelectionPlan
  readonly selection?: DshTuiModelSelection
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}

/** Product-facing runtime contract implemented by the active Host adapter. */
export interface DshTuiRuntimeService {
  readonly catalog: SessionCatalogPort
  readonly activation: SessionActivationPort
  readonly inspection: SessionInspectionPort
  readonly fork: SessionForkPort
  readonly presets: AgentPresetCatalogPort
  readonly providers: ProviderConnectionPort
  readonly settings: SettingsCatalogPort
  readonly pluginInventory: PluginInventoryPort
  openSession(options: OpenDshTuiSessionOptions): Promise<RuntimeSessionLease>
  openLegacy(options: OpenDshTuiSessionOptions): Promise<DshTuiSessionPort>
  /** @deprecated Compatibility alias. New integrations use openSession(). */
  open(options: OpenDshTuiSessionOptions): Promise<DshTuiSessionPort>
}

/** App-scope ownership for a product runtime contract. */
export interface DshTuiRuntimeOwner {
  readonly service: DshTuiRuntimeService
  dispose(): Promise<void>
}
