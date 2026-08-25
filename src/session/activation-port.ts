import type { DshTuiSessionLease } from './binding.ts'
import type { DshTuiModelSelection } from '../model/port.ts'

export interface SessionActivationRequest {
  readonly intent: 'attach-live' | 'resume-cold'
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly selection?: DshTuiModelSelection
}

export interface ActivatedSessionLease {
  readonly port: DshTuiSessionLease
  /**
   * Release only capabilities acquired by this activation. A borrowed live
   * Agent implementation must detach TUI listeners/mailboxes without stopping
   * or unregistering that Agent; an owned provisional may tear down its handle.
   */
  release(): Promise<void>
}

/**
 * Resolve one exact live-session lease. Implementations own the distinction
 * between borrowed live Agents and TUI-owned cold resumes; release() must only
 * release capabilities that the returned lease actually owns. Implementations
 * should settle promptly after request.signal aborts; the Controller's second
 * interrupt is a forced terminal-recovery path, not normal cancellation.
 */
export interface SessionActivationPort {
  activateSession(request: SessionActivationRequest): Promise<ActivatedSessionLease>
}
