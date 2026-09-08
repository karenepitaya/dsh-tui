import type { SessionId } from '../runtime/events.ts'
import type { PermissionPolicy } from '../permission/port.ts'

export interface UiQuestionOption {
  readonly label: string
  readonly description?: string
}

export interface UiQuestionIntent {
  readonly kind: 'plan-review'
  readonly approve: string
}

export interface UiQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly UiQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: UiQuestionIntent
}

export interface UiQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

export interface UiQuestionAnswer {
  readonly answers: readonly UiQuestionAnswerItem[]
}

export interface PendingQuestionInteraction {
  readonly id: string
  readonly kind: 'question'
  readonly sessionId: SessionId
  readonly questions: readonly UiQuestion[]
}

export interface PendingApprovalInteraction {
  readonly id: string
  readonly kind: 'approval'
  readonly sessionId: SessionId
  readonly approvalId: string
  readonly toolName: string
  readonly callId: string
  readonly reason?: string
  readonly evidence?: ApprovalEvidence
  /** The live adapter can remember this tool/cwd/permission scope until disconnect or revocation. */
  readonly allowSession?: boolean
}

export interface ApprovalEvidence {
  readonly source?: 'tool/call' | 'tool/code-dispatch-start'
  /** Exact logged arguments, without truncation or display escaping. */
  readonly arguments?: string
  readonly cwd?: string
  readonly currentPermission?: PermissionPolicy
  readonly requestedPermission?:
    | { readonly kind: 'tool-call' }
    | { readonly kind: 'sandbox-escalation'; readonly sandboxMode: PermissionPolicy['sandboxMode'] }
  readonly missing: readonly string[]
}

/** Shared raw-field limit: execution evidence beyond this limit cannot be reviewed in the dock. */
export const APPROVAL_FIELD_DISPLAY_LIMIT = 65_536

export function approvalEvidenceError(item: PendingApprovalInteraction): string | undefined {
  if (item.evidence === undefined) return 'Approval evidence is unavailable; reject this request.'
  const evidence = item.evidence
  const missing = [...evidence.missing]
  if (evidence.source === undefined || evidence.arguments === undefined) missing.push('tool arguments are unavailable')
  if (evidence.cwd === undefined) missing.push('working directory is unavailable')
  if (evidence.currentPermission === undefined) missing.push('current permission policy is unavailable')
  if (evidence.requestedPermission === undefined) missing.push('requested permission scope is unavailable')
  const executionFields = [
    ['tool/call identity', `${item.toolName} / ${item.callId}`],
    ['approval/session identity', `${item.approvalId} / ${item.sessionId}`],
    ['tool arguments', evidence.arguments],
    ['working directory', evidence.cwd],
  ] as const
  for (const [label, value] of executionFields) {
    if (value !== undefined && value.length > APPROVAL_FIELD_DISPLAY_LIMIT) {
      missing.push(`${label} cannot be fully inspected: exceeds the ${APPROVAL_FIELD_DISPLAY_LIMIT.toLocaleString('en-US')}-character display limit`)
    }
  }
  return missing.length === 0
    ? undefined
    : `Approval unavailable: ${[...new Set(missing)].join('; ')}.`
}

export type PendingInteraction =
  | PendingQuestionInteraction
  | PendingApprovalInteraction

export interface InteractionSnapshot {
  readonly type: 'interaction/snapshot'
  readonly sessionId: SessionId
  readonly pending: readonly PendingInteraction[]
  readonly rememberedApprovalCount?: number
}

export type InteractionResponse =
  | {
      readonly id: string
      readonly kind: 'question'
      readonly outcome:
        | { readonly kind: 'answered'; readonly answer: UiQuestionAnswer }
        | { readonly kind: 'cancelled' }
    }
  | {
      readonly id: string
      readonly kind: 'approval'
      readonly outcome: 'allowed-once' | 'allowed-session' | 'rejected'
    }

export type InteractionReceipt =
  | { readonly accepted: true }
  | {
      readonly accepted: false
      readonly reason: 'not-pending' | 'invalid-response'
      readonly message?: string
    }

export interface InteractionEventOptions {
  readonly signal?: AbortSignal
}

/** Product-owned transient interaction seam; it contains no Harness types. */
export interface DshInteractionPort {
  readonly sessionId: SessionId

  interactions(options?: InteractionEventOptions): AsyncIterable<InteractionSnapshot>

  respond(response: InteractionResponse): InteractionReceipt

  /** Revoke only this live session's remembered approvals. Never changes sandbox policy. */
  clearSessionApprovals?(): number

  /** Synchronously settle all owned waits and detach the renderer/provider. */
  disposeInteractions(): void
}
