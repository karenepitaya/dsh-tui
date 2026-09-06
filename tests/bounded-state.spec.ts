import { describe, expect, it } from 'vitest'
import {
  createUiState,
  reduceUiEvent,
  replayUiEvents,
  selectSession,
  type DurableDshEnvelope,
  type SessionUiState,
  type UiState,
} from '../src/internal.ts'
import { UI_PROJECTION_LIMITS } from '../src/transcript/state.ts'
import { durable, message } from './fixtures.ts'

function active(state: UiState): SessionUiState {
  const value = state.sessions['session-a']
  if (value === undefined) throw new Error('missing session-a')
  return value
}

function observed(seq: number, sourceType = `event-${seq}`): DurableDshEnvelope {
  return durable(seq, {
    type: 'session/observed',
    data: { sourceType, ignorable: true },
  })
}

function apply(events: readonly DurableDshEnvelope[]): UiState {
  let state = selectSession(createUiState(), 'session-a')
  for (const event of events) state = reduceUiEvent(state, event)
  return state
}

describe('bounded transcript projection', () => {
  it('keeps a bounded journal tail while reducing every durable sequence', () => {
    const total = UI_PROJECTION_LIMITS.journalEvents + 37
    const events = Array.from({ length: total }, (_, seq) => observed(seq))
    const state = apply(events)
    const session = active(state)

    expect(session.journal).toHaveLength(UI_PROJECTION_LIMITS.journalEvents)
    expect(session.journalStartSeq).toBe(total - UI_PROJECTION_LIMITS.journalEvents)
    expect(session.journal[0]?.seq).toBe(session.journalStartSeq)
    expect(session.journal.at(-1)?.seq).toBe(total - 1)

    // Events older than the retained comparison tail are explicitly seq-idempotent.
    expect(active(reduceUiEvent(state, observed(0)))).toBe(session)
    expect(active(reduceUiEvent(state, observed(0, 'old-conflict-outside-tail')))).toBe(session)

    const recentConflict = reduceUiEvent(state, observed(total - 1, 'recent-conflict'))
    expect(active(recentConflict).compatibilityError?.code).toBe('CONFLICTING_DUPLICATE')
  })

  it('bounds rows, replacement diagnostics, and in-flight draft chunks', () => {
    const rowTotal = UI_PROJECTION_LIMITS.transcriptRows + 9
    const rowEvents = Array.from({ length: rowTotal }, (_, seq) => durable(seq, {
      type: 'user/message',
      data: {
        message: message(`user-${seq}`, 'user', `row ${seq}`),
        surfaceOp: 'append',
      },
    }))
    const rows = active(apply(rowEvents))
    expect(rows.rows).toHaveLength(UI_PROJECTION_LIMITS.transcriptRows)
    expect(rows.omittedRowCount).toBe(9)
    expect(rows.rows[0]).toMatchObject({ kind: 'user', seq: 9 })

    const replacementTotal = UI_PROJECTION_LIMITS.replacements + 7
    const replacementEvents = Array.from({ length: replacementTotal }, (_, seq) => durable(seq, {
      type: 'user/message',
      data: {
        message: message(`replacement-${seq}`, 'user', `replacement ${seq}`),
        surfaceOp: { op: 'replace', start: seq, end: seq },
      },
    }))
    const replacements = active(apply(replacementEvents))
    expect(replacements.replacements).toHaveLength(UI_PROJECTION_LIMITS.replacements)
    expect(replacements.omittedReplacementCount).toBe(7)
    expect(replacements.replacements[0]?.seq).toBe(7)

    const chunkTotal = 1_000
    const chunkEvents = Array.from({ length: chunkTotal }, (_, seq) => durable(seq, {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: String(seq) },
      },
    }))
    const chunks = active(apply(chunkEvents)).rows[0]
    expect(chunks).toMatchObject({
      kind: 'assistant-draft',
      firstSeq: 0,
      lastSeq: chunkTotal - 1,
      chunkCount: chunkTotal,
    })
    if (chunks?.kind !== 'assistant-draft') throw new Error('expected draft row')
    expect(chunks.text).toBe(Array.from({ length: chunkTotal }, (_, seq) => String(seq)).join(''))
    expect(chunks.reasoning).toBe('')

    const reasoningEvents = Array.from({ length: chunkTotal }, (_, seq) => durable(seq, {
      type: 'assistant/chunk',
      data: {
        turn: 2,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: `reasoning-${seq};` },
      },
    }))
    const reasoning = active(apply(reasoningEvents)).rows[0]
    if (reasoning?.kind !== 'assistant-draft') throw new Error('expected reasoning draft row')
    expect(reasoning.reasoningTruncated).toBe(true)
    expect(reasoning.reasoning.length).toBe(UI_PROJECTION_LIMITS.draftReasoningCodeUnits)
    expect(reasoning.reasoning).toContain('reasoning-999;')
  })

  it('fails loudly at the gap cap and recovers by replaying authoritative events', () => {
    let overflowed = selectSession(createUiState(), 'session-a')
    for (let seq = 1; seq <= UI_PROJECTION_LIMITS.pendingEvents; seq += 1) {
      overflowed = reduceUiEvent(overflowed, observed(seq))
    }
    expect(Object.keys(active(overflowed).pendingBySeq)).toHaveLength(
      UI_PROJECTION_LIMITS.pendingEvents,
    )

    overflowed = reduceUiEvent(
      overflowed,
      observed(UI_PROJECTION_LIMITS.pendingEvents + 1),
    )
    expect(active(overflowed).compatibilityError).toMatchObject({
      code: 'PROJECTION_RESYNC_REQUIRED',
    })
    expect(Object.keys(active(overflowed).pendingBySeq)).toHaveLength(
      UI_PROJECTION_LIMITS.pendingEvents,
    )

    const authoritative = Array.from(
      { length: UI_PROJECTION_LIMITS.pendingEvents + 2 },
      (_, seq) => observed(seq),
    )
    const recovered = active(replayUiEvents('session-a', authoritative))
    expect(recovered.compatibilityError).toBeUndefined()
    expect(recovered.pendingBySeq).toEqual({})
    expect((recovered.journalStartSeq ?? 0) + recovered.journal.length)
      .toBe(authoritative.length)
    expect(recovered.journal.at(-1)?.seq).toBe(authoritative.length - 1)
  })
})
