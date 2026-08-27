export type SessionSubagentMode = 'one-shot' | 'continuable' | 'diagnostic'

export type SessionSubagentStatus =
  | 'running'
  | 'idle'
  | 'ready'
  | 'inactive'
  | 'diagnostic'

export interface SessionSubagentRef {
  readonly id: string
  readonly parentId: string
  readonly generation: number
}

/** Product-owned, detached view of one durable Harness subagent descendant. */
export interface SessionSubagent {
  readonly id: string
  readonly parentId: string
  readonly depth: number
  readonly mode: SessionSubagentMode
  readonly label?: string
  readonly status: SessionSubagentStatus
  readonly hasChildren: boolean
  readonly interruptible: boolean
  readonly diagnosticReason?: 'corrupt' | 'unsupported' | 'unavailable'
}

export type SessionWorkflowStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface SessionWorkflowMember {
  readonly seq: number
  readonly label: string
  readonly childId: string
  readonly status: SessionWorkflowStatus
}

export interface SessionWorkflowPhase {
  readonly key: string
  /** `null` preserves an absent phase field; an empty string is a distinct phase. */
  readonly phase: string | null
  readonly members: readonly SessionWorkflowMember[]
}

/** Durable top-level workflow projected from one exact parent Session log. */
export interface SessionWorkflowRun {
  readonly id: string
  readonly name: string
  readonly status: SessionWorkflowStatus
  readonly startSeq: number
  readonly phases: readonly SessionWorkflowPhase[]
}

export interface SessionDelegationSnapshot {
  readonly available: boolean
  readonly generation: number
  readonly loading: boolean
  readonly subagentsAvailable: boolean
  readonly subagents: readonly SessionSubagent[]
  readonly workflows: readonly SessionWorkflowRun[]
  readonly error?: string
}

export type SessionDelegationAction = {
  readonly kind: 'interrupt-subagent'
  readonly ref: SessionSubagentRef
}

export type SessionDelegationActionReceipt =
  | {
      readonly accepted: true
      readonly outcome: 'requested' | 'already-idle'
    }
  | {
      readonly accepted: false
      readonly code: string
      readonly message: string
    }

/** Optional live Subagent + durable Workflow capability for one exact Agent lease. */
export interface SessionDelegationPort {
  delegationSnapshot(): SessionDelegationSnapshot
  refreshDelegation(signal?: AbortSignal): Promise<void>
  onDelegationChanged(listener: () => void): () => void
  runDelegationAction(action: SessionDelegationAction): SessionDelegationActionReceipt
  disposeDelegation(): void
}

const UNAVAILABLE_DELEGATION_SNAPSHOT: SessionDelegationSnapshot = Object.freeze({
  available: false,
  generation: 0,
  loading: false,
  subagentsAvailable: false,
  subagents: Object.freeze([]),
  workflows: Object.freeze([]),
})

/** Compatibility seam for Agent compositions without the delegation adapter. */
export function createUnavailableSessionDelegationPort(): SessionDelegationPort {
  return {
    delegationSnapshot: () => UNAVAILABLE_DELEGATION_SNAPSHOT,
    refreshDelegation: async () => {},
    onDelegationChanged: () => () => {},
    runDelegationAction: () => ({
      accepted: false,
      code: 'delegation-capability-unavailable',
      message: 'Subagent and Workflow activity is unavailable in this Agent composition.',
    }),
    disposeDelegation: () => {},
  }
}
