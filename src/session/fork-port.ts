import type { ActivatedSessionLease } from './activation-port.ts'

export interface SessionForkRequest {
  readonly sourceSessionId: string
  /** Optional source event anchor; the complete containing turn is inherited. */
  readonly atSeq?: number
  readonly signal: AbortSignal
}

/** Product-owned fork seam. Implementations return an owned child lease. */
export interface SessionForkPort {
  forkSession(request: SessionForkRequest): Promise<ActivatedSessionLease>
}
