import { createCapabilityToken } from '../../kernel/capability.ts'
import type { SessionActivationPort } from '../../session/activation-port.ts'
import type { SessionCatalogPort } from '../../session/catalog-port.ts'
import type { SessionForkPort } from '../../session/fork-port.ts'
import type { SessionInspectionPort } from '../../session/inspection-port.ts'

/** DSH-free application seam required by the Sessions workspace Feature. */
export interface SessionsWorkspacePort {
  readonly catalog: SessionCatalogPort
  readonly inspection: SessionInspectionPort
  readonly activation: SessionActivationPort
  readonly fork: SessionForkPort
}

export const SESSIONS_WORKSPACE_CAPABILITY = createCapabilityToken<SessionsWorkspacePort>(
  'dsh-tui.sessions.workspace/v1',
  'application',
)
