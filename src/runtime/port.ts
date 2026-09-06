import type { AgentStatus, SessionId } from './events.ts'
import type { DshRuntimeEventItem } from './delivery.ts'
import type { PromptImageInput } from '../attachment/port.ts'

export type Delivery = 'followup' | 'steer'

export type CancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

export interface RuntimeEventOptions {
  /** Replay durable session events strictly after this sequence number. */
  readonly afterSeq?: number
  readonly signal?: AbortSignal
  /**
   * Called exactly once after the initial durable replay and runtime lifecycle
   * reconciliation. A live stream calls it immediately before its first wait;
   * an already-disposed stream calls it before terminal completion.
   *
   * The implementation has already installed its live listener at this point.
   * This signal is pull-driven, so the consumer must continue draining replay.
   * A callback failure rejects only this event consumer.
   */
  readonly onCaughtUp?: (boundary: RuntimeReplayBoundary) => void
}

export interface RuntimeReplayBoundary {
  /** Durable session tail observed at the replay boundary, or -1 for an empty log. */
  readonly lastSeq: number
  readonly status: AgentStatus
}

export interface SubmitInput {
  readonly text: string
  readonly images?: readonly PromptImageInput[]
}

export interface SubmitResult {
  readonly inputId: string
}

export interface SubmitOptions {
  readonly signal?: AbortSignal
}

/** Recoverable prompt refusal. The controller keeps the composer draft intact. */
export class DshSubmitRejectedError extends Error {
  override readonly name = 'DshSubmitRejectedError'

  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * Product-owned DSH seam. Implementations subscribe before taking their replay
 * snapshot, then deduplicate snapshot/live overlap by durable seq.
 */
export interface DshRuntimePort {
  readonly sessionId: SessionId
  /** True only when this exact binding owns the Agent lifecycle it may cancel. */
  readonly ownsAgentLifecycle: boolean

  events(options?: RuntimeEventOptions): AsyncIterable<DshRuntimeEventItem>

  submit(input: SubmitInput, delivery: Delivery, options?: SubmitOptions): Promise<SubmitResult>

  cancel(cause: CancelCause, options?: { readonly keepInbox?: boolean }): void

  whenIdle(): Promise<void>

  flush(): Promise<void>

  dispose(): Promise<void>
}
