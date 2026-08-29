import type { SessionEvent } from '@deepseek-ai/dsh-session'

export type DshSessionForkUnavailableCode =
  | 'invalid-anchor'
  | 'no-completed-turn'
  | 'turn-open'

/** Stable adapter error for official Host-compatible fork admission failures. */
export class DshSessionForkUnavailableError extends Error {
  constructor(
    readonly code: DshSessionForkUnavailableCode,
    readonly sourceSessionId: string,
    message: string,
  ) {
    super(message)
    this.name = 'DshSessionForkUnavailableError'
  }
}

export interface DshSessionForkPlan {
  /** The completed turn/end selected by the official anchor rule. */
  readonly boundarySeq: number
  /** Balanced prefix, extended through standalone events before the next turn. */
  readonly seed: readonly SessionEvent[]
}

/**
 * Reproduce the rc.2 Host fork cut without creating any Session or Agent.
 * An in-log anchor belongs to the turn containing it; omitted and past-end
 * anchors select the last completed turn. Between-turn appends remain in the
 * child until the next turn/start.
 */
export function planDshSessionFork(
  sourceSessionId: string,
  events: readonly SessionEvent[],
  atSeq?: number,
): DshSessionForkPlan {
  if (
    atSeq !== undefined
    && (!Number.isSafeInteger(atSeq) || atSeq < 0)
  ) {
    throw new DshSessionForkUnavailableError(
      'invalid-anchor',
      sourceSessionId,
      `fork anchor for session "${sourceSessionId}" must be a non-negative safe integer`,
    )
  }

  const lastSeq = events.at(-1)?.seq ?? -1
  const anchoredBoundary = atSeq === undefined
    ? undefined
    : events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
  const boundary = anchoredBoundary
    ?? (atSeq === undefined || atSeq > lastSeq
      ? events.findLast(event => event.type === 'turn/end')
      : undefined)
  if (boundary === undefined) {
    const openTurn = atSeq !== undefined && atSeq <= lastSeq
    throw new DshSessionForkUnavailableError(
      openTurn ? 'turn-open' : 'no-completed-turn',
      sourceSessionId,
      openTurn
        ? `session "${sourceSessionId}" has not completed the turn containing event ${String(atSeq)}`
        : `session "${sourceSessionId}" has no completed turn to fork from`,
    )
  }

  let cut = boundary.seq + 1
  while (cut < events.length && events[cut]?.type !== 'turn/start') cut += 1
  return Object.freeze({
    boundarySeq: boundary.seq,
    seed: Object.freeze(events.slice(0, cut)),
  })
}
