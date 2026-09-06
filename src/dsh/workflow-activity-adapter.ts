import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import type { WorkflowActivityEvent } from '../activity/workflow-activity.ts'

/** Translate official durable events into the product-owned Workflow contract. */
export function adaptDshWorkflowActivityEvent(
  event: SessionEvent,
): WorkflowActivityEvent | undefined {
  switch (event.type) {
    case 'turn/start':
      return { type: event.type, seq: event.seq, data: { turn: event.data.turn } }
    case 'step/start':
    case 'step/end':
      return {
        type: event.type,
        seq: event.seq,
        data: { turn: event.data.turn, step: event.data.step },
      }
    case 'turn/end':
      return { type: event.type, seq: event.seq, data: { turn: event.data.turn } }
    case 'tool-workflow/run-start':
      return {
        type: 'workflow/run-start',
        seq: event.seq,
        data: { runId: String(event.data.runId), name: event.data.name },
      }
    case 'tool-workflow/agent-start':
      return {
        type: 'workflow/member-start',
        seq: event.seq,
        data: {
          runId: String(event.data.runId),
          seq: event.data.seq,
          label: event.data.label,
          ...(event.data.phase === undefined ? {} : { phase: event.data.phase }),
          childId: String(event.data.childId),
        },
      }
    case 'tool-workflow/agent-end':
      return {
        type: 'workflow/member-end',
        seq: event.seq,
        data: {
          runId: String(event.data.runId),
          seq: event.data.seq,
          outcome: event.data.outcome,
        },
      }
    case 'tool-workflow/run-end':
      return {
        type: 'workflow/run-end',
        seq: event.seq,
        data: {
          runId: String(event.data.runId),
          stopReason: event.data.stopReason,
        },
      }
    default:
      return undefined
  }
}
