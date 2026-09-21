import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Full durable event history of a Session, including any fork-inherited
 * prefix. Harness 0.1.5 replaced the `Session.events` getter with
 * `snapshotEvents()`; keep the read behind one seam.
 */
export function snapshotSessionEvents(session: Session): readonly SessionEvent[] {
  return session.snapshotEvents()
}
