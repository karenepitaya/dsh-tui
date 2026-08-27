import { describe, expect, it } from 'vitest'
import {
  applyInteractionReceipt,
  createInteractionEditorState,
  prepareInteractionCancel,
  prepareInteractionSubmit,
  reconcileInteractionEditor,
  reduceInteractionEditor,
  moveApprovalSelection,
  movePlanReviewSelection,
  selectDshTuiInputMode,
} from '../src/interaction/editor.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import type {
  InteractionSnapshot,
  PendingApprovalInteraction,
  PendingQuestionInteraction,
} from '../src/interaction/port.ts'

function question(
  id = 'question-1',
  questions: PendingQuestionInteraction['questions'] = [{
    id: 'choice',
    question: 'Choose',
    options: [{ label: 'Yes' }, { label: 'No' }],
  }],
): PendingQuestionInteraction {
  return { id, kind: 'question', sessionId: 'session-a', questions }
}

function approval(id = 'approval-1'): PendingApprovalInteraction {
  return {
    id,
    kind: 'approval',
    sessionId: 'session-a',
    approvalId: id,
    callId: `call-${id}`,
    toolName: 'pwsh',
  }
}

function snapshot(
  ...pending: InteractionSnapshot['pending']
): InteractionSnapshot {
  return { type: 'interaction/snapshot', sessionId: 'session-a', pending }
}

function typeActive(state: ReturnType<typeof createInteractionEditorState>, text: string) {
  return reduceInteractionEditor(state, { type: 'insert', text })
}

describe('interaction editor reconciliation', () => {
  it('keeps the active item stable and never overwrites the normal prompt', () => {
    const q1 = question()
    const a1 = approval()
    let state = reconcileInteractionEditor(createInteractionEditorState(), snapshot(q1, a1))
    expect(state.active).toMatchObject({ kind: 'question', interactionId: q1.id })
    state = typeActive(state, 'draft answer')

    const reordered = reconcileInteractionEditor(state, snapshot(a1, q1))
    expect(reordered.active).toMatchObject({
      kind: 'question',
      interactionId: q1.id,
      editor: { text: 'draft answer' },
    })
    const prunedSettlement = reconcileInteractionEditor(
      { ...reordered, settledIds: ['gone'] },
      snapshot(q1),
    )
    expect(prunedSettlement.active).toBe(reordered.active)
    expect(prunedSettlement.settledIds).toEqual([])
    expect(reduceInteractionEditor(prunedSettlement, { type: 'insert', text: '' }))
      .toBe(prunedSettlement)
    const normalPrompt = createPromptEditorState('preserved prompt')
    expect(selectDshTuiInputMode(normalPrompt, reordered)).toMatchObject({
      kind: 'question',
      editor: { text: 'draft answer' },
    })

    state = reconcileInteractionEditor(reordered, snapshot(a1))
    expect(state.active).toMatchObject({ kind: 'approval', interactionId: a1.id })
    state = reconcileInteractionEditor(state, snapshot())
    expect(state.active).toBeUndefined()
    expect(selectDshTuiInputMode(normalPrompt, state)).toEqual({
      kind: 'prompt',
      editor: normalPrompt,
    })
  })

  it('resets an active editor if the same id changes interaction kind', () => {
    let state = reconcileInteractionEditor(createInteractionEditorState(), snapshot(question('same')))
    state = typeActive(state, 'old answer')
    state = reconcileInteractionEditor(state, snapshot(approval('same')))
    expect(state.active).toMatchObject({
      kind: 'approval',
      interactionId: 'same',
      editor: { text: '' },
    })

    const staleSubmit = prepareInteractionSubmit(state, snapshot())
    expect(staleSubmit.response).toBeUndefined()
    expect(staleSubmit.state).toEqual({ settledIds: ['same'] })
    expect(prepareInteractionSubmit(
      { ...state, settledIds: ['same'] },
      snapshot(),
    ).state).toEqual({ settledIds: ['same'] })
  })
})

describe('question editing', () => {
  it('collects ordered single-choice and custom answers before one response', () => {
    const request = question('multi-step', [
      {
        id: 'choice',
        question: 'Choose',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
      { id: 'detail', question: 'Why?' },
    ])
    const current = snapshot(request)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = typeActive(state, '2')
    let command = prepareInteractionSubmit(state, current)
    expect(command.response).toBeUndefined()
    state = command.state
    expect(state.active).toMatchObject({
      kind: 'question',
      questionIndex: 1,
      answers: [{ id: 'choice', selected: ['No'] }],
      editor: { text: '' },
    })

    state = typeActive(state, '   ')
    command = prepareInteractionSubmit(state, current)
    expect(command.response).toBeUndefined()
    expect(command.state.active?.error).toContain('nonblank')

    state = reduceInteractionEditor(command.state, { type: 'clear' })
    state = typeActive(state, 'because')
    command = prepareInteractionSubmit(state, current)
    expect(command.response).toEqual({
      id: request.id,
      kind: 'question',
      outcome: {
        kind: 'answered',
        answer: {
          answers: [
            { id: 'choice', selected: ['No'] },
            { id: 'detail', selected: [], custom: 'because' },
          ],
        },
      },
    })
    state = command.state
    expect(prepareInteractionSubmit(state, current).response).toBeUndefined()

    state = applyInteractionReceipt(state, {
      accepted: false,
      reason: 'invalid-response',
      message: 'upstream rejected it',
    })
    expect(state.active?.error).toBe('upstream rejected it')
    command = prepareInteractionSubmit(state, current)
    expect(command.response).toEqual(expect.objectContaining({ id: request.id }))
  })

  it('parses multi-select labels once and rejects invalid choices', () => {
    const request = question('multi-select', [{
      id: 'colors',
      question: 'Colors',
      multiSelect: true,
      options: [
        { label: 'Red' },
        { label: 'Green' },
        { label: 'Blue' },
      ],
    }])
    const current = snapshot(request)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = typeActive(state, '1, Blue, 1')
    let command = prepareInteractionSubmit(state, current)
    expect(command.response).toMatchObject({
      outcome: {
        answer: { answers: [{ id: 'colors', selected: ['Red', 'Blue'] }] },
      },
    })

    state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = typeActive(state, 'red')
    command = prepareInteractionSubmit(state, current)
    expect(command.response).toBeUndefined()
    expect(command.state.active?.error).toContain('option')

    state = reduceInteractionEditor(command.state, { type: 'clear' })
    command = prepareInteractionSubmit(state, current)
    expect(command.state.active?.error).toContain('at least one')

    const single = snapshot(question('single-invalid'))
    state = reconcileInteractionEditor(createInteractionEditorState(), single)
    state = typeActive(state, '9')
    command = prepareInteractionSubmit(state, single)
    expect(command.state.active?.error).toContain('Choose one option')
  })

  it('fails closed for an empty question request', () => {
    const current = snapshot(question('empty', []))
    const state = reconcileInteractionEditor(createInteractionEditorState(), current)
    const command = prepareInteractionSubmit(state, current)
    expect(command.response).toBeUndefined()
    expect(command.state.active?.error).toContain('no questions')
  })
})

describe('approval and settlement', () => {
  it('defaults to reject and supports an explicit two-action approval selector', () => {
    const request = approval('selector')
    const current = snapshot(request)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    expect(selectDshTuiInputMode(createPromptEditorState(), state)).toMatchObject({
      kind: 'approval',
      selectedIndex: 0,
      actionCount: 2,
    })
    expect(prepareInteractionSubmit(state, current).response).toMatchObject({
      outcome: 'rejected',
    })
    expect(moveApprovalSelection(state, 'previous')).toBe(state)
    expect(moveApprovalSelection(createInteractionEditorState(), 'next'))
      .toEqual(createInteractionEditorState())

    state = moveApprovalSelection(state, 'next')
    expect(selectDshTuiInputMode(createPromptEditorState(), state)).toMatchObject({
      kind: 'approval',
      selectedIndex: 1,
    })
    expect(prepareInteractionSubmit(state, current).response).toMatchObject({
      outcome: 'allowed-once',
    })
    const awaiting = prepareInteractionSubmit(state, current).state
    expect(moveApprovalSelection(awaiting, 'previous')).toBe(awaiting)
    expect(moveApprovalSelection(state, 'next')).toBe(state)
    expect(moveApprovalSelection(state, 'previous')).toMatchObject({
      active: { selectedIndex: 0 },
    })
  })

  it('accepts explicit allow/reject tokens and treats cancel as rejection', () => {
    const request = approval()
    const current = snapshot(request)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = typeActive(state, 'maybe')
    let command = prepareInteractionSubmit(state, current)
    expect(command.response).toBeUndefined()
    expect(command.state.active?.error).toContain('y/yes/1')

    state = reduceInteractionEditor(command.state, { type: 'clear' })
    state = typeActive(state, ' YES ')
    command = prepareInteractionSubmit(state, current)
    expect(command.response).toEqual({
      id: request.id,
      kind: 'approval',
      outcome: 'allowed-once',
    })
    expect(prepareInteractionCancel(command.state).response).toBeUndefined()

    state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = typeActive(state, '2')
    expect(prepareInteractionSubmit(state, current).response).toMatchObject({ outcome: 'rejected' })

    state = reconcileInteractionEditor(createInteractionEditorState(), current)
    expect(prepareInteractionCancel(state).response).toEqual({
      id: request.id,
      kind: 'approval',
      outcome: 'rejected',
    })

    const qState = reconcileInteractionEditor(
      createInteractionEditorState(),
      snapshot(question()),
    )
    expect(prepareInteractionCancel(qState).response).toMatchObject({
      kind: 'question',
      outcome: { kind: 'cancelled' },
    })
  })

  it('deduplicates accepted/stale snapshots and keeps invalid responses editable', () => {
    const first = approval('first')
    const second = approval('second')
    const current = snapshot(first, second)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = typeActive(state, 'y')
    state = prepareInteractionSubmit(state, current).state
    state = applyInteractionReceipt(state, { accepted: true })
    expect(state.active).toBeUndefined()
    expect(state.settledIds).toEqual(['first'])

    state = reconcileInteractionEditor(state, current)
    expect(state.active).toMatchObject({ interactionId: 'second' })
    state = typeActive(state, 'n')
    state = prepareInteractionSubmit(state, current).state
    state = applyInteractionReceipt(state, { accepted: false, reason: 'not-pending' })
    expect(state.settledIds).toEqual(['first', 'second'])
    expect(reconcileInteractionEditor(state, current).active).toBeUndefined()

    state = reconcileInteractionEditor(state, snapshot())
    expect(state.settledIds).toEqual([])
    expect(applyInteractionReceipt(state, {
      accepted: false,
      reason: 'invalid-response',
    })).toBe(state)
    expect(prepareInteractionCancel(state).state).toBe(state)
    expect(reduceInteractionEditor(state, { type: 'insert', text: 'ignored' })).toBe(state)
  })

  it('uses a safe receipt fallback and exposes modal errors in the input mode', () => {
    const current = snapshot(approval('fallback'))
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = typeActive(state, 'bad')
    state = prepareInteractionSubmit(state, current).state
    const mode = selectDshTuiInputMode(createPromptEditorState('normal'), state)
    expect(mode).toMatchObject({
      kind: 'approval',
      interactionId: 'fallback',
      error: expect.stringContaining('y/yes/1'),
    })

    state = reduceInteractionEditor(state, { type: 'clear' })
    state = typeActive(state, 'y')
    state = prepareInteractionSubmit(state, current).state
    expect(reduceInteractionEditor(state, { type: 'insert', text: 'ignored' })).toBe(state)
    state = applyInteractionReceipt(state, {
      accepted: false,
      reason: 'invalid-response',
    })
    expect(state.active?.error).toBe('The interaction response was rejected.')
  })
})

describe('first-party plan review editing', () => {
  function planReview(
    options = [{ label: 'Approve' }, { label: 'Keep planning' }],
  ): PendingQuestionInteraction {
    return question('review-1', [{
      id: 'plan-review',
      question: 'Approve this plan?',
      detail: '# Build it\n\n- inspect\n- implement',
      options,
      intent: { kind: 'plan-review', approve: 'Approve' },
    }])
  }

  it('defaults to approve, navigates all decisions, and keeps the composer read-only', () => {
    const request = planReview()
    const current = snapshot(request)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    expect(state.active).toMatchObject({
      kind: 'plan-review',
      selectedIndex: 2,
      editor: { text: 'Approve' },
    })
    expect(selectDshTuiInputMode(createPromptEditorState('normal'), state)).toMatchObject({
      kind: 'plan-review',
      selectedIndex: 2,
      actionCount: 3,
    })
    expect(reduceInteractionEditor(state, { type: 'insert', text: 'ignored' })).toBe(state)

    state = movePlanReviewSelection(state, 'previous')
    expect(state.active).toMatchObject({ selectedIndex: 1, editor: { text: 'Keep planning' } })
    state = movePlanReviewSelection(state, 'previous')
    expect(state.active).toMatchObject({ selectedIndex: 0, editor: { text: 'Discuss' } })
    expect(movePlanReviewSelection(state, 'previous')).toBe(state)
    state = movePlanReviewSelection(state, 'next')
    state = movePlanReviewSelection(state, 'next')
    expect(state.active).toMatchObject({ selectedIndex: 2, editor: { text: 'Approve' } })
    expect(movePlanReviewSelection(state, 'next')).toBe(state)

    if (state.active?.kind !== 'plan-review') throw new Error('expected plan-review editor')
    const staleSelection = {
      ...state,
      active: { ...state.active, selectedIndex: 99 },
    }
    expect(prepareInteractionSubmit(staleSelection, current)).toEqual({
      state: staleSelection,
    })

    const submitted = prepareInteractionSubmit(state, current)
    expect(submitted.response).toEqual({
      id: 'review-1',
      kind: 'question',
      outcome: {
        kind: 'answered',
        answer: { answers: [{ id: 'plan-review', selected: ['Approve'] }] },
      },
    })
    expect(movePlanReviewSelection(submitted.state, 'previous')).toBe(submitted.state)
    expect(reduceInteractionEditor(submitted.state, { type: 'clear' })).toBe(submitted.state)
    expect(prepareInteractionSubmit(submitted.state, current).response).toBeUndefined()
  })

  it('sends the decline label or dismisses so the user can discuss', () => {
    const request = planReview()
    const current = snapshot(request)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = movePlanReviewSelection(state, 'previous')
    expect(prepareInteractionSubmit(state, current).response).toMatchObject({
      outcome: {
        kind: 'answered',
        answer: { answers: [{ selected: ['Keep planning'] }] },
      },
    })

    state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = movePlanReviewSelection(movePlanReviewSelection(state, 'previous'), 'previous')
    expect(prepareInteractionSubmit(state, current).response).toMatchObject({
      kind: 'question',
      outcome: { kind: 'cancelled' },
    })
    expect(prepareInteractionCancel(state).response).toMatchObject({
      outcome: { kind: 'cancelled' },
    })
  })

  it('falls back when a replayed request loses review eligibility and exposes receipt errors', () => {
    const request = planReview([{ label: 'Approve' }])
    const current = snapshot(request)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    expect(selectDshTuiInputMode(createPromptEditorState(), state)).toMatchObject({
      kind: 'plan-review',
      actionCount: 2,
    })
    state = applyInteractionReceipt(prepareInteractionSubmit(state, current).state, {
      accepted: false,
      reason: 'invalid-response',
      message: 'review changed',
    })
    expect(selectDshTuiInputMode(createPromptEditorState(), state)).toMatchObject({
      kind: 'plan-review',
      error: 'review changed',
    })

    const generic = question('review-1', [{
      id: 'plan-review',
      question: 'Approve this plan?',
      options: [{ label: 'Approve' }],
    }])
    state = reconcileInteractionEditor(state, snapshot(generic))
    expect(state.active).toMatchObject({ kind: 'question', interactionId: 'review-1' })
    expect(movePlanReviewSelection(state, 'next')).toBe(state)
  })
})
