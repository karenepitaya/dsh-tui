import type { DshDurableEventMap } from '../runtime/events.ts'
import type { ToolRow } from '../transcript/state.ts'

export type ToolResultStatus = 'done' | 'failed' | 'cancelled'

/** Only structured outcome facts determine status; result text is never parsed. */
export function toolResultStatus(
  result: Pick<DshDurableEventMap['tool/result'], 'isError' | 'error'>,
): ToolResultStatus {
  if (result.error?.code === 'ABORTED' || result.error?.code === 'ABORTED_BEFORE_DISPATCH') {
    return 'cancelled'
  }
  return result.isError === true || result.error !== undefined ? 'failed' : 'done'
}

export function toolRowStatus(row: ToolRow): ToolResultStatus | 'running' {
  const status = toolResultStatus(row)
  if (status !== 'done' || row.resultSeq !== undefined) return status
  return row.turnEnd?.outcome === 'cancelled' ? 'cancelled' : 'running'
}
