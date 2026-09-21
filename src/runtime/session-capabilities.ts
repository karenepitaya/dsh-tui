import type { SessionJobsPort } from '../activity/port.ts'
import type { SessionDelegationPort } from '../activity/delegation-port.ts'
import type { DshCommandPort } from '../command/port.ts'
import type { SessionContextPort } from '../context/port.ts'
import { createCapabilityToken } from '../kernel/capability.ts'
import type { SessionModePort } from '../mode/port.ts'
import type { SessionModelPort } from '../model/port.ts'
import type { SessionPermissionPort } from '../permission/port.ts'
import type { SessionSkillsPort } from '../skill/port.ts'
import type { SessionToolsPort } from '../tool/port.ts'
import type { SessionWorkbenchPort } from '../workbench/port.ts'

export interface SessionAgentStatusSnapshot {
  readonly status: 'idle' | 'running'
}

/** Read-only exact-Agent lifecycle projection for mutation safety gates. */
export interface SessionAgentStatusPort {
  snapshot(): SessionAgentStatusSnapshot
  onChanged(listener: () => void): () => void
}

/** Product-owned tokens for secondary session capabilities. */
export const SESSION_COMMANDS_CAPABILITY = createCapabilityToken<DshCommandPort>(
  'dsh.session.commands/v1',
  'session',
)
export const SESSION_AGENT_STATUS_CAPABILITY = createCapabilityToken<SessionAgentStatusPort>(
  'dsh.session.agent-status/v1',
  'session',
)
export const SESSION_MODELS_CAPABILITY = createCapabilityToken<SessionModelPort>(
  'dsh.session.models/v1',
  'session',
)
export const SESSION_CONTEXT_CAPABILITY = createCapabilityToken<SessionContextPort>(
  'dsh.session.context/v1',
  'session',
)
export const SESSION_WORKBENCH_CAPABILITY = createCapabilityToken<SessionWorkbenchPort>(
  'dsh.session.workbench/v1',
  'session',
)
export const SESSION_JOBS_CAPABILITY = createCapabilityToken<SessionJobsPort>(
  'dsh.session.jobs/v1',
  'session',
)
export const SESSION_MODES_CAPABILITY = createCapabilityToken<SessionModePort>(
  'dsh.session.modes/v1',
  'session',
)
export const SESSION_SKILLS_CAPABILITY = createCapabilityToken<SessionSkillsPort>(
  'dsh.session.skills/v1',
  'session',
)
export const SESSION_DELEGATION_CAPABILITY = createCapabilityToken<SessionDelegationPort>(
  'dsh.session.delegation/v1',
  'session',
)
export const SESSION_TOOLS_CAPABILITY = createCapabilityToken<SessionToolsPort>(
  'dsh.session.tools/v1',
  'session',
)
export const SESSION_PERMISSIONS_CAPABILITY = createCapabilityToken<SessionPermissionPort>(
  'dsh.session.permissions/v1',
  'session',
)
