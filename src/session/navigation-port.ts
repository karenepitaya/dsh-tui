import { createCapabilityToken } from '../kernel/capability.ts'

export interface SessionNavigationSnapshot {
  readonly sessionId?: string
  readonly busy: boolean
}

/** Caller-owned channel for Product Shell cancellation of an in-flight transaction. */
export interface SessionNavigationCancellation {
  cancel(reason: unknown): void
}

export type SessionNavigationRequest = {
  readonly kind: 'activate'
  readonly sessionId: string
  readonly intent: 'attach-live' | 'resume-cold'
  readonly signal: AbortSignal
  readonly cancellation?: SessionNavigationCancellation
} | {
  readonly kind: 'fork'
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly cancellation?: SessionNavigationCancellation
}

/** Product-owned Session transaction; Features never handle live Agent leases. */
export interface SessionNavigationPort {
  snapshot(): SessionNavigationSnapshot
  navigate(request: SessionNavigationRequest): Promise<void>
}

export const SESSION_NAVIGATION_CAPABILITY = createCapabilityToken<SessionNavigationPort>(
  'dsh-tui.session.navigation/v1', 'application',
)
