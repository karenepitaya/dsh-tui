import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { convertSessionEvent } from '../src/dsh/session-event-adapter.ts'
import { reduceAgentRequestEvent } from '../src/presentation/agent-request.ts'
import { toolResultStatus, toolRowStatus } from '../src/presentation/tool-outcome.ts'
import type { DshDurableEventMap } from '../src/runtime/events.ts'
import { reduceUiEvent, replayUiEvents } from '../src/transcript/reducer.ts'
import { createUiState, type ToolRow } from '../src/transcript/state.ts'

describe('structured tool outcomes', () => {
  it.each([
    ['read failure', 'read', { name: 'FsError', code: 'FS_NOT_FOUND' }],
    ['rejected write approval', 'write', undefined],
  ] as const)('retains one %s after the model finishes without another tool call', (_scenario, name, error) => {
    const raw: SessionEvent[] = []
    const append = (type: string, data: unknown, surface = false): void => {
      raw.push({ type, data, seq: raw.length, time: 1_000 + raw.length,
        ...(surface ? { surfaceOp: 'append' } : {}) } as SessionEvent)
    }
    append('turn/start', { turn: 1 })
    append('tool/call', { turn: 1, step: 1, callId: 'only-call', name, arguments: '{}' })
    if (name === 'write') {
      append('approval/asked', { id: 'approval-1', toolName: name, callId: 'only-call', reason: 'Write requires approval' })
      append('approval/decided', { id: 'approval-1', outcome: 'rejected' })
    }
    append('tool/result', {
      turn: 1, step: 1, ...(error === undefined ? {} : { error }),
      message: { id: 'failed-result', role: 'user', source: { kind: 'tool', callId: 'only-call' }, content: [{
        type: 'tool-result', toolCallId: 'only-call', isError: true,
        content: [{ type: 'text', text: name === 'write' ? 'Approval rejected' : 'File not found' }],
      }] },
    }, true)
    append('assistant/message', {
      turn: 1, step: 2, message: { id: 'answer', role: 'assistant', source: { kind: 'model' },
        content: [{ type: 'text', text: 'The operation failed; I made no further attempts.' }] },
    }, true)
    append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const events = raw.map(event => convertSessionEvent('session-a', event))
    const live = events.reduce(reduceUiEvent, createUiState())
    const replayEvents = (JSON.parse(JSON.stringify(raw)) as SessionEvent[])
      .map(event => convertSessionEvent('session-a', event))
    expect(live.sessions['session-a']).toEqual(replayUiEvents('session-a', replayEvents).sessions['session-a'])
    const rows = live.sessions['session-a']!.rows.filter(row => row.kind === 'tool')
    expect(rows).toHaveLength(1)
    expect(toolRowStatus(rows[0]!)).toBe('failed')
    expect(rows[0]).toMatchObject({ isError: true, turnEnd: { outcome: 'succeeded' } })
    const foldRequest = (source: typeof events) => source.reduce<ReturnType<typeof reduceAgentRequestEvent>>(
      (state, event) => reduceAgentRequestEvent(state, event), undefined)
    expect(foldRequest(events)).toEqual(foldRequest(replayEvents))
    expect(foldRequest(events)).toMatchObject({
      phase: 'succeeded', toolFailures: 1, description: 'Request complete · 1 tool failure',
    })
  })

  it('distinguishes running, success, failure, and cancellation without reading result text', () => {
    const row: ToolRow = {
      kind: 'tool', key: 'tool:1:1:test', turn: 1, step: 1, callId: 'test',
    }
    expect(toolRowStatus(row)).toBe('running')
    expect(toolRowStatus({ ...row, turnEnd: { seq: 9, outcome: 'cancelled' } })).toBe('cancelled')
    expect(toolRowStatus({ ...row, turnEnd: { seq: 9, outcome: 'failed' } })).toBe('running')
    expect(toolRowStatus({ ...row, resultSeq: 1, turnEnd: { seq: 9, outcome: 'cancelled' } })).toBe('done')
    expect(toolRowStatus({ ...row, resultSeq: 1 })).toBe('done')
    expect(toolRowStatus({ ...row, isError: true })).toBe('failed')
    const cases: readonly [Pick<DshDurableEventMap['tool/result'], 'isError' | 'error'>, string][] = [
      [{}, 'done'],
      [{ isError: false }, 'done'],
      [{ isError: true }, 'failed'],
      [{ error: { name: 'ToolError', code: 'FAILED' } }, 'failed'],
      [{ isError: false, error: { name: 'ToolError', code: 'FAILED' } }, 'failed'],
      [{ error: { name: 'AbortError', code: 'ABORTED' } }, 'cancelled'],
      [{ error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } }, 'cancelled'],
      [{ error: { name: 'AbortError', code: 'OTHER' } }, 'failed'],
    ]
    for (const [facts, status] of cases) expect(toolResultStatus(facts)).toBe(status)
  })

  it('preserves two failed executions followed by success across raw live and replay events', () => {
    const raw: SessionEvent[] = []
    const append = (type: string, data: unknown, surface = false): void => {
      raw.push({
        type, data, seq: raw.length, time: 1000 + raw.length,
        ...(surface ? { surfaceOp: 'append' } : {}),
      } as SessionEvent)
    }
    append('turn/start', { turn: 1 })
    for (let step = 1; step <= 3; step += 1) {
      append('tool/call', {
        turn: 1, step, callId: `call-${step}`, name: 'read', arguments: '{}',
      })
      append('tool/result', {
        turn: 1, step,
        message: {
          id: `result-${step}`, role: 'user', source: { kind: 'tool', callId: `call-${step}` },
          content: [{
            type: 'tool-result', toolCallId: `call-${step}`, isError: step === 1,
            content: [{ type: 'text', text: step === 3 ? 'Error is a documented word' : 'unavailable' }],
          }],
        },
        ...(step === 2 ? { error: { name: 'ToolError', code: 'FAILED' } } : {}),
      }, true)
    }
    append('assistant/message', {
      turn: 1, step: 4,
      message: {
        id: 'answer', role: 'assistant', source: { kind: 'model' },
        content: [{ type: 'text', text: 'Recovered and completed the request.' }],
      },
    }, true)
    append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const events = raw.map(event => convertSessionEvent('session-a', event))
    const live = events.reduce(reduceUiEvent, createUiState())
    const replayEvents = (JSON.parse(JSON.stringify(raw)) as SessionEvent[])
      .map(event => convertSessionEvent('session-a', event))
    const replay = replayUiEvents('session-a', replayEvents)
    expect(live.sessions['session-a']).toEqual(replay.sessions['session-a'])
    const rows = live.sessions['session-a']!.rows.filter(row => row.kind === 'tool')
    expect(rows.map(toolRowStatus)).toEqual(['failed', 'failed', 'done'])
    expect(rows.map(row => row.isError)).toEqual([true, false, false])
    const foldRequest = (source: typeof events) => source.reduce<
      ReturnType<typeof reduceAgentRequestEvent>
    >((state, event) => reduceAgentRequestEvent(state, event), undefined)
    expect(foldRequest(events)).toEqual(foldRequest(replayEvents))
    expect(foldRequest(events)).toMatchObject({
      phase: 'succeeded', description: 'Request complete · 2 tool failures',
    })
  })
})
