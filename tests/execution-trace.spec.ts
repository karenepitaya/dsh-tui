import { describe, expect, it } from 'vitest'
import { executionTraceProjection } from '../src/presentation/execution-trace.ts'
import { replayUiEvents } from '../src/transcript/reducer.ts'
import type { DurableDshEnvelope } from '../src/runtime/events.ts'
import type { ToolRow } from '../src/transcript/state.ts'
import { durable, message } from './fixtures.ts'

function tool(index: number, fields: Partial<ToolRow> = {}): ToolRow {
  return {
    kind: 'tool', key: `tool:1:1:${index}`, turn: 1, step: 1, callId: String(index),
    callSeq: index, resultSeq: index + 1, ...fields,
  }
}

describe('durable execution trace settlement', () => {
  it.each([
    ['read failure', 'read', { name: 'FsError', code: 'FS_NOT_FOUND' }],
    ['rejected write approval', 'write', undefined],
  ] as const)('does not infer recovery from a completed reply after one %s', (_scenario, name, error) => {
    const events = [
      durable(0, { type: 'turn/start', data: { turn: 1 } }),
      durable(1, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'only-call', name, arguments: '{}' } }),
      durable(2, { type: 'tool/result', data: {
        turn: 1, step: 1, callId: 'only-call', isError: true,
        ...(error === undefined ? {} : { error }),
        message: message('failed-result', 'user', 'Operation did not complete', 'tool'), surfaceOp: 'append',
      } }),
      durable(3, { type: 'assistant/message', data: {
        turn: 1, step: 2, message: message('answer', 'assistant', 'The operation failed; I made no further attempts.'), surfaceOp: 'append',
      } }),
      durable(4, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
    ]
    const rows = replayUiEvents('session-a', events).sessions['session-a']!.rows.filter(row => row.kind === 'tool')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ isError: true, turnEnd: { outcome: 'succeeded' } })
    expect(executionTraceProjection(1, rows)).toMatchObject({
      status: 'done', stepCount: 1,
      activitySummary: '✓ Completed 1 execution step · 1 failed · request completed · Ctrl+O for details',
    })
  })

  it('keeps tool failures visible after another tool succeeds and a real turn/end completes', () => {
    const events: DurableDshEnvelope[] = [durable(0, { type: 'turn/start', data: { turn: 1 } })]
    for (let index = 1; index <= 3; index += 1) {
      events.push(durable(events.length, { type: 'tool/call', data: {
        turn: 1, step: index, callId: String(index), name: 'read', arguments: '{}',
      } }))
      events.push(durable(events.length, { type: 'tool/result', data: {
        turn: 1, step: index, callId: String(index), surfaceOp: 'append',
        isError: index === 1,
        ...(index === 2 ? { error: { name: 'ToolError', code: 'FAILED' } } : {}),
        message: message(`result-${index}`, 'user', index === 3 ? 'Error is a documented word' : 'failed', 'tool'),
      } }))
    }
    events.push(durable(events.length, { type: 'assistant/message', data: {
      turn: 1, step: 4, message: message('claimed-success', 'assistant', 'All done!'), surfaceOp: 'append',
    } }))
    const project = () => executionTraceProjection(1, replayUiEvents('session-a', events)
      .sessions['session-a']!.rows.filter(row => row.kind === 'tool'))!
    const before = project()
    expect(before).toMatchObject({ status: 'failed', stepCount: 3 })
    expect(before.activitySummary).toBe('× 2 of 3 execution steps failed · Ctrl+O for details')
    events.push(durable(events.length, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
    const after = project()
    expect(after).toMatchObject({ status: 'done', stepCount: 3 })
    expect(after.activitySummary).toBe('✓ Completed 3 execution steps · 2 failed · request completed · Ctrl+O for details')
    expect(after.revision).not.toBe(before.revision)
  })

  it('distinguishes execution completion from request success when no settlement exists', () => {
    expect(executionTraceProjection(1, [])).toBeUndefined()
    expect(executionTraceProjection(1, [tool(1)])).toMatchObject({
      status: 'done', activitySummary: '✓ Completed 1 execution step · Ctrl+O for details',
    })
    expect(executionTraceProjection(1, [tool(1, { isError: true })])?.status).toBe('failed')
    expect(executionTraceProjection(1, [tool(1, { isError: true })])?.revision)
      .not.toBe(executionTraceProjection(1, [tool(1)])?.revision)
  })

  it('reports cancellation and unfinished executions separately from failure', () => {
    const cancelled = tool(1, { error: { name: 'AbortError', code: 'ABORTED' } })
    const failed = tool(2, { isError: true })
    const running: ToolRow = { kind: 'tool', key: 'tool:1:1:running', turn: 1, step: 1, callId: 'running' }
    expect(executionTraceProjection(1, [cancelled])).toMatchObject({
      status: 'cancelled', activitySummary: '■ 1 of 1 execution step cancelled · Ctrl+O for details',
    })
    expect(executionTraceProjection(1, [failed, cancelled])?.activitySummary)
      .toBe('× 1 of 2 execution steps failed · 1 cancelled · Ctrl+O for details')
    expect(executionTraceProjection(1, [running])).toMatchObject({
      status: 'interrupted', activitySummary: '■ 1 of 1 execution step unfinished · Ctrl+O for details',
    })
    expect(executionTraceProjection(1, [failed, cancelled, running])?.activitySummary)
      .toBe('■ 1 of 3 execution steps unfinished · 1 failed · 1 cancelled · Ctrl+O for details')
    expect(executionTraceProjection(1, [running, { ...cancelled, turnEnd: { seq: 9, outcome: 'cancelled' } }])?.activitySummary)
      .toContain('request cancelled')
    expect(executionTraceProjection(1, [{ ...cancelled, turnEnd: { seq: 9, outcome: 'succeeded' } }])?.activitySummary)
      .toContain('1 cancelled · request completed')
  })

  it.each(['succeeded', 'failed', 'cancelled', 'unknown'] as const)('keeps the explicit %s request outcome separate from successful executions', outcome => {
    const projection = executionTraceProjection(1, [tool(1, { turnEnd: { seq: 9, outcome } })])!
    expect(projection.status).toBe({ succeeded: 'done', failed: 'failed', cancelled: 'cancelled', unknown: 'interrupted' }[outcome])
    expect(projection.activitySummary).toContain({
      succeeded: 'request succeeded', failed: 'request failed', cancelled: 'request cancelled', unknown: 'request outcome unavailable',
    }[outcome])
  })

  it('does not conceal missing tool results even when a malformed trace has a completed turn', () => {
    const row: ToolRow = {
      kind: 'tool', key: 'tool:1:1:missing', turn: 1, step: 1, callId: 'missing',
      turnEnd: { seq: 9, outcome: 'succeeded' },
    }
    expect(executionTraceProjection(1, [row])).toMatchObject({
      status: 'interrupted', activitySummary: '■ 1 of 1 execution step unfinished · request completed with unfinished execution · Ctrl+O for details',
    })
  })
})
