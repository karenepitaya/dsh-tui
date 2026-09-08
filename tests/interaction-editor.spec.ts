import { describe, expect, it } from 'vitest'
import {
  applyInteractionReceipt,
  createInteractionEditorState,
  moveQuestionFocus,
  moveQuestionPage,
  prepareInteractionCancel,
  prepareQuestionContinue,
  prepareQuestionSkip,
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
    evidence: {
      source: 'tool/call',
      arguments: '{"command":"Write-Output ok"}',
      cwd: 'D:\\workspace',
      currentPermission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
      requestedPermission: { kind: 'tool-call' },
      missing: [],
    },
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
  it('offers scoped session approval without changing the reject shortcut or default', () => {
    const item = { ...approval(), allowSession: true }
    const pending = snapshot(item)
    const initial = reconcileInteractionEditor(createInteractionEditorState(), pending)
    expect(prepareInteractionSubmit(initial, pending).response).toMatchObject({ outcome: 'rejected' })
    expect(prepareInteractionSubmit(typeActive(initial, '2'), pending).response).toMatchObject({ outcome: 'rejected' })
    expect(typeActive(initial, '3').active).toMatchObject({ selectedIndex: 2 })
    const changedChoice = typeActive(typeActive(initial, '3'), '2')
    expect(changedChoice.active).toMatchObject({ selectedIndex: 1, editor: { text: '' } })
    expect(prepareInteractionSubmit(changedChoice, pending).response).toMatchObject({ outcome: 'rejected' })
    expect(prepareInteractionSubmit(typeActive(changedChoice, '1'), pending).response).toMatchObject({ outcome: 'allowed-once' })
    expect(prepareInteractionSubmit(typeActive(initial, '3'), pending).response).toMatchObject({ outcome: 'allowed-session' })
    expect(typeActive(initial, ' 3 ').active).toMatchObject({ selectedIndex: 2 })
    expect(prepareInteractionSubmit(typeActive(initial, ' 3 '), pending).response).toMatchObject({ outcome: 'allowed-session' })
    expect(prepareInteractionSubmit(moveApprovalSelection(initial, 'next'), pending).response).toMatchObject({ outcome: 'allowed-session' })
    const unsupported = snapshot(approval())
    expect(prepareInteractionSubmit(typeActive(reconcileInteractionEditor(createInteractionEditorState(), unsupported), '3'), unsupported).response).toBeUndefined()
  })
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
  it('settles a skipped final question and keeps page movement bounded', () => {
    const current = snapshot(question('last-skip'))
    const state = reconcileInteractionEditor(createInteractionEditorState(), current)
    expect(moveQuestionPage(state, 'previous')).toBe(state)
    expect(prepareQuestionSkip(state, current).response).toEqual({
      id: 'last-skip', kind: 'question',
      outcome: { kind: 'answered', answer: { answers: [{ id: 'choice', selected: [] }] } },
    })
  })

  it('keeps per-question drafts and submits official selected/custom semantics', () => {
    const request = question('draft-flow', [
      {
        id: 'single',
        question: 'Choose one',
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
      },
      {
        id: 'multi',
        question: 'Choose many',
        multiSelect: true,
        options: [{ label: 'Red' }, { label: 'Blue' }],
      },
      { id: 'custom', question: 'Why?' },
    ])
    const current = snapshot(request)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)

    state = prepareInteractionSubmit(state, current).state
    expect(state.active).toMatchObject({
      kind: 'question',
      questionIndex: 1,
    })
    if (state.active?.kind !== 'question') throw new Error('expected question editor')
    expect(state.active.drafts[0]).toMatchObject({
      selected: ['Alpha'], editor: { text: '' }, skipped: false,
    })

    state = moveQuestionPage(state, 'previous')
    state = typeActive(state, 'A different answer')
    expect(state.active).toMatchObject({
      kind: 'question',
      questionIndex: 0,
      optionIndex: 2,
    })
    if (state.active?.kind !== 'question') throw new Error('expected question editor')
    expect(state.active.drafts[0]).toMatchObject({
      selected: [], editor: { text: 'A different answer' }, skipped: false,
    })
    state = prepareQuestionContinue(state, current).state

    state = prepareInteractionSubmit(state, current).state
    state = typeActive(state, 'warm shade')
    expect(state.active).toMatchObject({
      kind: 'question',
      questionIndex: 1,
      optionIndex: 2,
    })
    if (state.active?.kind !== 'question') throw new Error('expected question editor')
    expect(state.active.drafts[0]).toMatchObject({
      selected: [], editor: { text: 'A different answer' },
    })
    expect(state.active.drafts[1]).toMatchObject({
      selected: ['Red'], editor: { text: 'warm shade' }, skipped: false,
    })
    state = prepareQuestionContinue(state, current).state

    state = typeActive(state, 'Because it fits')
    state = moveQuestionPage(state, 'previous')
    expect(state.active).toMatchObject({
      kind: 'question',
      questionIndex: 1,
      drafts: [
        { editor: { text: 'A different answer' } },
        { selected: ['Red'], editor: { text: 'warm shade' } },
        { editor: { text: 'Because it fits' } },
      ],
    })
    state = moveQuestionPage(state, 'next')
    const command = prepareQuestionContinue(state, current)
    expect(command.response).toEqual({
      id: 'draft-flow',
      kind: 'question',
      outcome: {
        kind: 'answered',
        answer: {
          answers: [
            { id: 'single', selected: [], custom: 'A different answer' },
            { id: 'multi', selected: ['Red'], custom: 'warm shade' },
            { id: 'custom', selected: [], custom: 'Because it fits' },
          ],
        },
      },
    })
  })

  it('supports option focus, incomplete review, and explicit skips', () => {
    const request = question('review-drafts', [
      {
        id: 'choice',
        question: 'Choose',
        options: [{ label: 'One' }, { label: 'Two' }],
      },
      { id: 'detail', question: 'Detail' },
    ])
    const current = snapshot(request)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = moveQuestionFocus(state, 'next')
    expect(state.active).toMatchObject({ kind: 'question', optionIndex: 1 })
    state = moveQuestionFocus(state, 'next')
    expect(state.active).toMatchObject({ kind: 'question', optionIndex: 2 })
    expect(moveQuestionFocus(state, 'next')).toBe(state)
    state = moveQuestionPage(state, 'next')
    state = typeActive(state, 'second draft')

    let command = prepareQuestionContinue(state, current)
    expect(command.response).toBeUndefined()
    expect(command.state.active).toMatchObject({
      kind: 'question',
      questionIndex: 0,
      error: expect.stringContaining('complete every question'),
      drafts: [
        { skipped: false },
        { editor: { text: 'second draft' } },
      ],
    })

    command = prepareQuestionSkip(command.state, current)
    expect(command.response).toBeUndefined()
    expect(command.state.active).toMatchObject({ kind: 'question', questionIndex: 1 })
    command = prepareQuestionContinue(command.state, current)
    expect(command.response).toEqual({
      id: 'review-drafts',
      kind: 'question',
      outcome: {
        kind: 'answered',
        answer: {
          answers: [
            { id: 'choice', selected: [] },
            { id: 'detail', selected: [], custom: 'second draft' },
          ],
        },
      },
    })
    expect(selectDshTuiInputMode(createPromptEditorState(), command.state)).toMatchObject({
      kind: 'question',
      questionIndex: 1,
      answerCount: 2,
      optionIndex: 0,
      steps: ['skipped', 'answered'],
    })
  })

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
    state = moveQuestionFocus(state, 'next')
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
    expect(command.state.active?.error).toContain('Answer this question')

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

  it('toggles multi-select options and accepts custom answers beside options', () => {
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
    state = prepareInteractionSubmit(state, current).state
    state = moveQuestionFocus(moveQuestionFocus(state, 'next'), 'next')
    state = prepareInteractionSubmit(state, current).state
    let command = prepareQuestionContinue(state, current)
    expect(command.response).toMatchObject({
      outcome: {
        answer: { answers: [{ id: 'colors', selected: ['Red', 'Blue'] }] },
      },
    })

    state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = prepareInteractionSubmit(state, current).state
    state = prepareInteractionSubmit(state, current).state
    command = prepareQuestionContinue(state, current)
    expect(command.response).toBeUndefined()
    expect(command.state.active?.error).toContain('Answer this question')

    state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = typeActive(state, 'red')
    command = prepareQuestionContinue(state, current)
    expect(command.response).toMatchObject({
      outcome: {
        answer: { answers: [{ id: 'colors', selected: [], custom: 'red' }] },
      },
    })

    const single = snapshot(question('single-invalid'))
    state = reconcileInteractionEditor(createInteractionEditorState(), single)
    state = typeActive(state, '9')
    command = prepareQuestionContinue(state, single)
    expect(command.response).toMatchObject({
      outcome: {
        answer: { answers: [{ id: 'choice', selected: [], custom: '9' }] },
      },
    })
  })

  it('fails closed for an empty question request', () => {
    const current = snapshot(question('empty', []))
    const state = reconcileInteractionEditor(createInteractionEditorState(), current)
    const command = prepareInteractionSubmit(state, current)
    expect(command.response).toBeUndefined()
    expect(command.state.active?.error).toContain('no questions')
    expect(prepareQuestionContinue(state, current).state.active?.error).toContain('no questions')
    expect(prepareQuestionSkip(state, current).state.active?.error).toContain('no questions')
    expect(reduceInteractionEditor(state, { type: 'insert', text: 'ignored' })).toBe(state)
    expect(moveQuestionFocus(state, 'next')).toBe(state)
    expect(moveQuestionPage(state, 'next')).toBe(state)
    expect(selectDshTuiInputMode(createPromptEditorState(), state)).toMatchObject({
      kind: 'question',
      selected: [],
      skipped: false,
      multiSelect: false,
    })
  })

  it('contains no-op, stale, and awaiting question transitions without losing drafts', () => {
    const none = createInteractionEditorState()
    const noPending = snapshot()
    expect(prepareQuestionContinue(none, noPending).state).toBe(none)
    expect(prepareQuestionSkip(none, noPending).state).toBe(none)
    expect(moveQuestionFocus(none, 'previous')).toBe(none)
    expect(moveQuestionPage(none, 'previous')).toBe(none)

    const request = question('edge-question', [
      {
        id: 'choice',
        question: 'Choose',
        options: [{ label: 'One' }, { label: 'Two' }],
      },
      {
        id: 'next',
        question: 'Next',
        options: [{ label: 'Done' }],
      },
    ])
    const current = snapshot(request)
    let state = reconcileInteractionEditor(none, current)
    expect(reduceInteractionEditor(state, { type: 'backspace' })).toBe(state)

    if (state.active?.kind !== 'question') throw new Error('expected question editor')
    const focusError = { ...state, active: { ...state.active, error: 'clear me' } }
    expect(moveQuestionFocus(focusError, 'previous').active?.error).toBeUndefined()
    const pageError = { ...state, active: { ...state.active, error: 'clear me' } }
    expect(moveQuestionPage(pageError, 'previous').active?.error).toBeUndefined()

    state = moveQuestionFocus(moveQuestionFocus(state, 'next'), 'next')
    expect(reduceInteractionEditor(state, { type: 'backspace' })).toBe(state)
    const staleContinue = prepareQuestionContinue(state, noPending)
    expect(staleContinue.state).toEqual({ settledIds: ['edge-question'] })
    const staleSkip = prepareQuestionSkip(state, noPending)
    expect(staleSkip.state).toEqual({ settledIds: ['edge-question'] })

    state = reconcileInteractionEditor(none, current)
    state = prepareInteractionSubmit(state, current).state
    state = prepareInteractionSubmit(state, current).state
    expect(state.active).toMatchObject({ kind: 'question', awaitingReceipt: true })
    expect(prepareQuestionContinue(state, current).state).toBe(state)
    expect(prepareQuestionSkip(state, current).state).toBe(state)
    expect(moveQuestionFocus(state, 'next')).toBe(state)
    expect(moveQuestionPage(state, 'next')).toBe(state)

    const approvalState = reconcileInteractionEditor(none, snapshot(approval('editor-noop')))
    expect(reduceInteractionEditor(approvalState, { type: 'insert', text: '' })).toBe(approvalState)
  })
})

describe('approval and settlement', () => {
  it('rejects grants when execution evidence exceeds the inspectable field limit', () => {
    const base = approval('oversized-evidence')
    const oversized = 'x'.repeat(65_537)
    for (const request of [
      { ...base, evidence: { ...base.evidence!, arguments: oversized } },
      { ...base, evidence: { ...base.evidence!, cwd: oversized } },
      { ...base, toolName: oversized },
      { ...base, callId: oversized },
      { ...base, approvalId: oversized },
      { ...base, sessionId: oversized },
    ]) {
      const current = { ...snapshot(request), sessionId: request.sessionId }
      const state = reconcileInteractionEditor(createInteractionEditorState(), current)
      for (const allow of [moveApprovalSelection(state, 'previous'), typeActive(state, 'yes'), typeActive(state, '1')]) {
        const result = prepareInteractionSubmit(allow, current)
        expect(result.response).toBeUndefined()
        expect(result.state.active?.error).toContain('cannot be fully inspected')
      }
      expect(prepareInteractionSubmit(state, current).response).toMatchObject({ outcome: 'rejected' })
      expect(prepareInteractionCancel(state).response).toMatchObject({ outcome: 'rejected' })
    }
    const inspectable = snapshot({ ...base, reason: oversized, evidence: { ...base.evidence!, arguments: 'x'.repeat(65_536) } })
    const state = reconcileInteractionEditor(createInteractionEditorState(), inspectable)
    expect(prepareInteractionSubmit(moveApprovalSelection(state, 'previous'), inspectable).response)
      .toMatchObject({ outcome: 'allowed-once' })
  })

  it('blocks keyboard allow tokens and selection when evidence is missing', () => {
    const { evidence, ...missing } = approval('missing-evidence')
    const current = snapshot(missing)
    const state = reconcileInteractionEditor(createInteractionEditorState(), current)
    for (const token of ['y', 'yes', '1']) {
      const result = prepareInteractionSubmit(typeActive(state, token), current)
      expect(result.response).toBeUndefined()
      expect(result.state.active?.error).toContain('evidence is unavailable')
    }
    expect(prepareInteractionSubmit(moveApprovalSelection(state, 'previous'), current).response).toBeUndefined()
    expect(prepareInteractionSubmit(state, current).response).toMatchObject({ outcome: 'rejected' })
    const incomplete = snapshot({ ...missing, evidence: { missing: [] } })
    expect(prepareInteractionSubmit(typeActive(state, '1'), incomplete).response).toBeUndefined()
    const indicatedMissing = snapshot({ ...missing, evidence: { ...evidence!, missing: ['call identity mismatched'] } })
    expect(prepareInteractionSubmit(typeActive(state, 'yes'), indicatedMissing).state.active?.error)
      .toContain('call identity mismatched')
  })

  it('defaults to reject and supports an explicit two-action approval selector', () => {
    const request = approval('selector')
    const current = snapshot(request)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    expect(selectDshTuiInputMode(createPromptEditorState(), state)).toMatchObject({
      kind: 'approval',
      selectedIndex: 1,
      actionCount: 2,
    })
    expect(prepareInteractionSubmit(state, current).response).toMatchObject({
      outcome: 'rejected',
    })
    expect(moveApprovalSelection(state, 'next')).toBe(state)
    expect(moveApprovalSelection(createInteractionEditorState(), 'next'))
      .toEqual(createInteractionEditorState())

    state = moveApprovalSelection(state, 'previous')
    expect(selectDshTuiInputMode(createPromptEditorState(), state)).toMatchObject({
      kind: 'approval',
      selectedIndex: 0,
    })
    expect(prepareInteractionSubmit(state, current).response).toMatchObject({
      outcome: 'allowed-once',
    })
    const awaiting = prepareInteractionSubmit(state, current).state
    expect(moveApprovalSelection(awaiting, 'previous')).toBe(awaiting)
    expect(moveApprovalSelection(state, 'previous')).toBe(state)
    expect(moveApprovalSelection(state, 'next')).toMatchObject({
      active: { selectedIndex: 1 },
    })
  })

  it('accepts explicit allow/reject tokens and treats cancel as rejection', () => {
    const request = approval()
    const current = snapshot(request)
    let state = reconcileInteractionEditor(createInteractionEditorState(), current)
    state = typeActive(state, 'maybe')
    let command = prepareInteractionSubmit(state, current)
    expect(command.response).toBeUndefined()
    expect(command.state.active?.error).toContain('1 to allow once')

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
      error: expect.stringContaining('1 to allow once'),
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
