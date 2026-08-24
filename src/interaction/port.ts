import type { SessionId } from '../runtime/events.ts'

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
}

export type PendingInteraction =
  | PendingQuestionInteraction
  | PendingApprovalInteraction

export interface InteractionSnapshot {
  readonly type: 'interaction/snapshot'
  readonly sessionId: SessionId
  readonly pending: readonly PendingInteraction[]
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
      readonly outcome: 'allowed-once' | 'rejected'
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

  /** Synchronously settle all owned waits and detach the renderer/provider. */
  disposeInteractions(): void
}
