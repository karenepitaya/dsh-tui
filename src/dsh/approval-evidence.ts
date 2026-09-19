import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { ApprovalEvidence } from '../interaction/port.ts'
import { currentPermission, isSandboxMode } from './permission-facts.ts'
import { snapshotSessionEvents } from './session-events.ts'

interface CallEvidence {
  readonly source: 'tool/call' | 'tool/ptc-dispatch-start'
  readonly name: string
  readonly arguments: string
}

function callEvidence(events: readonly SessionEvent[], callId: string): CallEvidence | undefined {
  const calls: CallEvidence[] = []
  for (const event of events) {
    if (event.type === 'tool/call' && String(event.data.callId) === callId) {
      calls.push({ source: event.type, name: event.data.name, arguments: event.data.arguments })
    } else if (event.type === 'tool/ptc-dispatch-start' && String(event.data.subCallId) === callId) {
      calls.push({ source: event.type, name: event.data.name, arguments: JSON.stringify(event.data.arguments) })
    } else if (
      (event.type === 'tool/result' && event.data.message.source.kind === 'tool'
        && String(event.data.message.source.callId) === callId)
      || (event.type === 'tool/ptc-dispatch' && String(event.data.subCallId) === callId)
    ) {
      return undefined
    }
  }
  return calls.length === 1 ? calls[0] : undefined
}

/** Facts come only from the exact Session call and its scoped policy services. */
export function collectApprovalEvidence(
  ctx: Context,
  agent: Agent,
  callId: string,
  toolName: string,
): ApprovalEvidence {
  const missing: string[] = []
  const call = callEvidence(snapshotSessionEvents(agent.session), callId)
  const matching = call?.name === toolName ? call : undefined
  if (matching === undefined) missing.push('matching unfinished tool call is missing or ambiguous')
  let args: unknown
  if (matching !== undefined) {
    try { args = JSON.parse(matching.arguments) } catch { missing.push('tool arguments are not valid JSON') }
  }
  const fields = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : undefined
  const headerCwd = agent.session.header.cwd
  const workdir = fields?.['workdir']
  let cwd = headerCwd
  if ((toolName === 'pwsh' || toolName === 'bash') && workdir !== undefined) {
    cwd = typeof workdir === 'string'
      ? isAbsolute(workdir) ? workdir : headerCwd === undefined ? undefined : resolve(headerCwd, workdir)
      : undefined
  }
  if (cwd === undefined) missing.push('working directory is unavailable')
  let current: ApprovalEvidence['currentPermission']
  try { current = currentPermission(ctx, agent) } catch { /* The request remains rejectable. */ }
  if (current === undefined) missing.push('current permission policy is unavailable')
  let requested: ApprovalEvidence['requestedPermission']
  if (matching !== undefined && args !== undefined) {
    const requestedMode = fields?.['sandbox_permissions']
    if (requestedMode === undefined) requested = Object.freeze({ kind: 'tool-call' })
    else if (isSandboxMode(requestedMode)) {
      requested = Object.freeze({ kind: 'sandbox-escalation', sandboxMode: requestedMode })
    } else missing.push('requested sandbox permission is invalid')
  }
  return Object.freeze({
    ...(matching === undefined ? {} : { source: matching.source, arguments: matching.arguments }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(current === undefined ? {} : { currentPermission: current }),
    ...(requested === undefined ? {} : { requestedPermission: requested }),
    missing: Object.freeze(missing),
  })
}
