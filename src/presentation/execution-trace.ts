import type { ToolRow } from '../transcript/state.ts'
import { toolRowStatus } from './tool-outcome.ts'

export interface ExecutionTraceProjection {
  readonly turn: number
  readonly stepCount: number
  readonly status: 'done' | 'failed' | 'interrupted' | 'cancelled'
  readonly activitySummary: string
  readonly revision: string
  /** Key shared with a Verbose detail node for semantic scroll restoration. */
  readonly anchorKey: string
}

/** Tool completion and request settlement are separate durable facts. */
export function executionTraceProjection(
  turn: number,
  tools: readonly ToolRow[],
): ExecutionTraceProjection | undefined {
  if (tools.length === 0) return undefined
  const outcomes = tools.map(toolRowStatus)
  const failures = outcomes.filter(status => status === 'failed').length
  const cancellations = outcomes.filter(status => status === 'cancelled').length
  const unfinished = outcomes.filter(status => status === 'running').length
  const turnEnd = tools.at(-1)!.turnEnd
  const succeeded = turnEnd?.outcome === 'succeeded' && unfinished === 0
  const status = turnEnd?.outcome === 'cancelled' || (!succeeded && cancellations > 0)
    ? 'cancelled'
    : unfinished > 0 || turnEnd?.outcome === 'unknown'
      ? 'interrupted'
      : turnEnd?.outcome === 'failed' || (!succeeded && failures > 0)
        ? 'failed'
        : 'done'
  const steps = `${tools.length} execution step${tools.length === 1 ? '' : 's'}`
  const parts: string[] = []
  if (unfinished > 0) parts.push(`■ ${unfinished} of ${steps} unfinished`)
  else if (failures > 0 && !succeeded) parts.push(`× ${failures} of ${steps} failed`)
  else if (cancellations > 0 && !succeeded) parts.push(`■ ${cancellations} of ${steps} cancelled`)
  else parts.push(`${status === 'done' ? '✓' : status === 'failed' ? '×' : '■'} Completed ${steps}`)
  if (failures > 0 && (unfinished > 0 || succeeded)) parts.push(`${failures} failed`)
  if (cancellations > 0 && (unfinished > 0 || failures > 0 || succeeded)) parts.push(`${cancellations} cancelled`)
  if (turnEnd !== undefined) {
    switch (turnEnd.outcome) {
      case 'succeeded':
        parts.push(unfinished > 0
          ? 'request completed with unfinished execution'
          : failures + cancellations > 0 ? 'request completed' : 'request succeeded')
        break
      case 'failed': parts.push('request failed'); break
      case 'cancelled': parts.push('request cancelled'); break
      case 'unknown': parts.push('request outcome unavailable'); break
    }
  }
  parts.push('Ctrl+O for details')
  return {
    turn,
    stepCount: tools.length,
    status,
    activitySummary: parts.join(' · '),
    anchorKey: tools.at(-1)!.key,
    revision: tools.map((row, index) => [
      row.callSeq ?? 0,
      row.resultSeq ?? 0,
      outcomes[index],
      row.turnEnd?.seq ?? '',
      row.turnEnd?.outcome ?? '',
    ].join(':')).join('|'),
  }
}
