import type { DurableDshEnvelope } from '../runtime/events.ts'

export interface SessionInspectionHeader {
  readonly sessionId: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSessionId?: string
  readonly seedLength?: number
  readonly isSubagent: boolean
  readonly delegationDepth?: number
  /** Creation-time composition fact; this is not the current live preset. */
  readonly creationAgentPreset?: string
}

export interface SessionInspectionSnapshot {
  readonly header: SessionInspectionHeader
  readonly events: readonly DurableDshEnvelope[]
}

export interface SessionInspectionRequest {
  readonly sessionId: string
  readonly signal: AbortSignal
}

export interface SessionInspectionPort {
  /** Every returned header/event SessionId must equal the exact requested SessionId. */
  inspectSession(request: SessionInspectionRequest): Promise<SessionInspectionSnapshot>
}

/** Adapter-owned failures; official inspection and abort failures pass through unchanged. */
export type SessionInspectionErrorCode = 'unavailable' | 'identity-mismatch'

export class SessionInspectionError extends Error {
  constructor(
    readonly code: SessionInspectionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SessionInspectionError'
  }
}
