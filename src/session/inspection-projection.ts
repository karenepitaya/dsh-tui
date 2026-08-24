import { createUiState, type UiState } from '../transcript/state.ts'
import { reduceUiEvent, selectSession } from '../transcript/reducer.ts'
import type { SessionInspectionSnapshot } from './inspection-port.ts'

/** Bound synchronous replay work before yielding back to terminal input. */
export const SESSION_INSPECTION_REPLAY_BATCH = 256

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve) })
}

/**
 * Rebuild one detached inspection through the same reducer as live delivery.
 * The result is published only after the complete snapshot has replayed.
 */
export async function projectSessionInspection(
  snapshot: SessionInspectionSnapshot,
  signal: AbortSignal,
): Promise<UiState> {
  signal.throwIfAborted()
  let state = selectSession(createUiState(), snapshot.header.sessionId)
  for (const [index, event] of snapshot.events.entries()) {
    signal.throwIfAborted()
    if (event.sessionId !== snapshot.header.sessionId) {
      throw new Error(
        `Inspection event ${index} session "${event.sessionId}" does not match snapshot session "${snapshot.header.sessionId}"`,
      )
    }
    state = reduceUiEvent(state, event)
    const compatibility = state.sessions[snapshot.header.sessionId]?.compatibilityError
    if (compatibility !== undefined) {
      throw new Error(`${compatibility.code}: ${compatibility.message}`)
    }
    const processed = index + 1
    if (
      processed % SESSION_INSPECTION_REPLAY_BATCH === 0
      && processed < snapshot.events.length
    ) {
      await yieldToEventLoop()
    }
  }
  signal.throwIfAborted()
  return state
}
