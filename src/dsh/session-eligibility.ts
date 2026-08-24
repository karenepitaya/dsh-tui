import type { SessionHeader } from '@deepseek-ai/dsh-session'

/** Official delegation depth is authoritative even when coarse origin metadata is absent. */
export function isDelegatedSession(
  header: Pick<SessionHeader, 'origin' | 'delegationDepth'>,
): boolean {
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}
