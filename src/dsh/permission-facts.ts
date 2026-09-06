import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { serviceForAgent } from '@deepseek-ai/dsh-agent-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { PermissionPolicy } from '../permission/port.ts'

interface PermissionServices {
  readonly sandboxPolicy: {
    resolve(request: { readonly session: Session }): { readonly mode: string }
  }
  readonly approval: ApprovalService
  readonly permissionPresets: {
    resolve(value: string): { readonly sandbox: string; readonly approval: string }
  }
}

interface ServiceLookup {
  get(name: string): unknown
}

/** Scoped instances take priority; the official CLI keeps policy services on its host. */
function service<K extends keyof PermissionServices>(
  ctx: Context,
  agent: Agent,
  name: K,
): PermissionServices[K] | undefined {
  const scoped = serviceForAgent as (ctx: Context, agent: Agent, name: string) => unknown
  const value = scoped(ctx, agent, name)
    ?? (agent.ctx as unknown as ServiceLookup).get(name)
    ?? (ctx as unknown as ServiceLookup).get(name)
  return value as PermissionServices[K] | undefined
}

export function isSandboxMode(value: unknown): value is PermissionPolicy['sandboxMode'] {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

function policy(sandbox: unknown, approval: unknown): PermissionPolicy | undefined {
  return isSandboxMode(sandbox) && (approval === 'ask' || approval === 'never')
    ? Object.freeze({ sandboxMode: sandbox, approvalPolicy: approval })
    : undefined
}

export function currentPermission(ctx: Context, agent: Agent): PermissionPolicy | undefined {
  const sandbox = service(ctx, agent, 'sandboxPolicy')?.resolve({ session: agent.session }).mode
  const approval = service(ctx, agent, 'approval')
  return policy(sandbox, approval === undefined
    ? undefined
    : approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask')
}

export function presetPermission(
  ctx: Context,
  agent: Agent,
  value: string,
): PermissionPolicy | undefined {
  const spec = service(ctx, agent, 'permissionPresets')?.resolve(value)
  return spec === undefined ? undefined : policy(spec.sandbox, spec.approval)
}
