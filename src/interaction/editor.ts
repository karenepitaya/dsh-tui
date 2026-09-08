import type {
  InteractionReceipt,
  InteractionResponse,
  InteractionSnapshot,
  PendingInteraction,
  UiQuestion,
  UiQuestionAnswerItem,
} from './port.ts'
import { approvalEvidenceError } from './port.ts'
import {
  createPromptEditorState,
  reducePromptEditor,
  type PromptEditorAction,
  type PromptEditorState,
} from '../ui/prompt-editor.ts'
import {
  planReviewChoices,
  planReviewOf,
  type UiPlanReview,
} from './plan-review.ts'

export interface ActiveApprovalEditor {
  readonly kind: 'approval'
  readonly interactionId: string
  readonly editor: PromptEditorState
  readonly error: string | undefined
  readonly awaitingReceipt: boolean
  readonly selectedIndex: number
  readonly scrollOffset?: number
  readonly detailsExpanded?: boolean
  readonly allowSession?: boolean
}

export interface ActiveQuestionEditor {
  readonly kind: 'question'
  readonly interactionId: string
  readonly editor: PromptEditorState
  readonly error: string | undefined
  readonly awaitingReceipt: boolean
  readonly questionIndex: number
  readonly optionIndex: number
  readonly drafts: readonly QuestionDraftEditor[]
  readonly answers: readonly UiQuestionAnswerItem[]
}

export interface QuestionDraftEditor {
  readonly id: string
  readonly optionLabels: readonly string[]
  readonly multiSelect: boolean
  readonly selected: readonly string[]
  readonly editor: PromptEditorState
  readonly skipped: boolean
  readonly optionIndex: number
}

export type QuestionStepStatus = 'pending' | 'answered' | 'skipped'

export interface ActivePlanReviewEditor {
  readonly kind: 'plan-review'
  readonly interactionId: string
  readonly editor: PromptEditorState
  readonly error: string | undefined
  readonly awaitingReceipt: boolean
  readonly review: UiPlanReview
  readonly selectedIndex: number
}

export type ActiveInteractionEditor =
  | ActiveApprovalEditor
  | ActiveQuestionEditor
  | ActivePlanReviewEditor

export interface InteractionEditorState {
  readonly active?: ActiveInteractionEditor
  /** Locally settled ids retained only while a stale snapshot still contains them. */
  readonly settledIds: readonly string[]
}

export type DshTuiInputMode =
  | { readonly kind: 'prompt'; readonly editor: PromptEditorState }
  | {
      readonly kind: 'approval'
      readonly editor: PromptEditorState
      readonly interactionId: string
      readonly selectedIndex?: number
      readonly scrollOffset?: number
      readonly actionCount?: 2 | 3
      readonly detailsExpanded?: boolean
      readonly error?: string
    }
  | {
      readonly kind: 'question'
      readonly editor: PromptEditorState
      readonly interactionId: string
      readonly questionIndex: number
      readonly answerCount: number
      readonly questionCount?: number
      readonly optionIndex?: number
      readonly selected?: readonly string[]
      readonly skipped?: boolean
      readonly multiSelect?: boolean
      readonly steps?: readonly QuestionStepStatus[]
      readonly error?: string
    }
  | {
      readonly kind: 'plan-review'
      readonly editor: PromptEditorState
      readonly interactionId: string
      readonly selectedIndex: number
      readonly actionCount: number
      readonly error?: string
    }

export interface InteractionEditorCommand {
  readonly state: InteractionEditorState
  readonly response?: InteractionResponse
}

function createQuestionDraft(question: UiQuestion): QuestionDraftEditor {
  return {
    id: question.id,
    optionLabels: Object.freeze((question.options ?? []).map(option => option.label)),
    multiSelect: question.multiSelect === true,
    selected: Object.freeze([]),
    editor: createPromptEditorState(),
    skipped: false,
    optionIndex: 0,
  }
}

function draftStatus(draft: QuestionDraftEditor): QuestionStepStatus {
  if (draft.skipped) return 'skipped'
  return draft.selected.length > 0 || draft.editor.text.trim() !== ''
    ? 'answered'
    : 'pending'
}

function draftAnswer(draft: QuestionDraftEditor): UiQuestionAnswerItem {
  if (draft.skipped) return { id: draft.id, selected: [] }
  const custom = draft.editor.text.trim()
  return {
    id: draft.id,
    selected: custom === '' || draft.multiSelect ? draft.selected : [],
    ...(custom === '' ? {} : { custom }),
  }
}

function completedAnswers(
  drafts: readonly QuestionDraftEditor[],
): readonly UiQuestionAnswerItem[] {
  return drafts.filter(draft => draftStatus(draft) !== 'pending').map(draftAnswer)
}

function replaceQuestionDraft(
  active: ActiveQuestionEditor,
  index: number,
  draft: QuestionDraftEditor,
  patch: Partial<ActiveQuestionEditor> = {},
): ActiveQuestionEditor {
  const drafts = active.drafts.map((item, itemIndex) => itemIndex === index ? draft : item)
  return {
    ...active,
    ...patch,
    drafts,
    answers: completedAnswers(drafts),
    editor: draft.editor,
    optionIndex: draft.optionIndex,
  }
}

function createActive(item: PendingInteraction): ActiveInteractionEditor {
  const common = {
    interactionId: item.id,
    editor: createPromptEditorState(),
    error: undefined,
    awaitingReceipt: false,
  }
  if (item.kind === 'approval') return { kind: 'approval', ...common, selectedIndex: 1, allowSession: item.allowSession === true }
  const review = planReviewOf(item.questions)
  if (review === undefined) {
    const drafts = Object.freeze(item.questions.map(createQuestionDraft))
    const first = drafts[0]
    return {
      kind: 'question',
      ...common,
      editor: first?.editor ?? createPromptEditorState(),
      questionIndex: 0,
      optionIndex: first?.optionIndex ?? 0,
      drafts,
      answers: [],
    }
  }
  const choices = planReviewChoices(review)
  const selectedIndex = choices.length - 1
  return {
    kind: 'plan-review',
    ...common,
    review,
    selectedIndex,
    editor: createPromptEditorState(choices[selectedIndex]!.label),
  }
}

function matchesActive(item: PendingInteraction, active: ActiveInteractionEditor): boolean {
  if (item.id !== active.interactionId) return false
  if (active.kind === 'plan-review') {
    return item.kind === 'question' && planReviewOf(item.questions) !== undefined
  }
  return item.kind === active.kind
}

function pendingFor(
  snapshot: InteractionSnapshot,
  active: ActiveInteractionEditor,
): PendingInteraction | undefined {
  return snapshot.pending.find(item => matchesActive(item, active))
}

function settleActive(
  state: InteractionEditorState,
  active: ActiveInteractionEditor,
): InteractionEditorState {
  return {
    settledIds: state.settledIds.includes(active.interactionId)
      ? state.settledIds
      : [...state.settledIds, active.interactionId],
  }
}

function withActiveError(
  state: InteractionEditorState,
  active: ActiveInteractionEditor,
  message: string,
): InteractionEditorState {
  return { ...state, active: { ...active, error: message } }
}

export function createInteractionEditorState(): InteractionEditorState {
  return { settledIds: [] }
}

export function reconcileInteractionEditor(
  state: InteractionEditorState,
  snapshot: InteractionSnapshot,
): InteractionEditorState {
  const pendingIds = new Set(snapshot.pending.map(item => item.id))
  const settledIds = state.settledIds.filter(id => pendingIds.has(id))
  const settledUnchanged = settledIds.length === state.settledIds.length
  const active = state.active
  const retained = active === undefined
    ? undefined
    : snapshot.pending.find(item => (
        matchesActive(item, active) && !settledIds.includes(item.id)
      ))

  if (retained !== undefined) {
    return settledUnchanged ? state : { ...state, settledIds }
  }

  const next = snapshot.pending.find(item => !settledIds.includes(item.id))
  return {
    ...(next === undefined ? {} : { active: createActive(next) }),
    settledIds,
  }
}

export function reduceInteractionEditor(
  state: InteractionEditorState,
  action: PromptEditorAction,
): InteractionEditorState {
  const active = state.active
  if (active === undefined || active.awaitingReceipt) return state
  if (active.kind === 'plan-review') return state
  if (active.kind === 'question') {
    const draft = active.drafts[active.questionIndex]
    if (draft === undefined) return state
    const customIndex = draft.optionLabels.length
    const opensCustom = action.type === 'insert'
      || action.type === 'newline'
      || action.type === 'clear'
    if (active.optionIndex !== customIndex && !opensCustom) return state
    const editor = reducePromptEditor(draft.editor, action)
    const optionIndex = opensCustom ? customIndex : draft.optionIndex
    if (
      editor === draft.editor
      && optionIndex === draft.optionIndex
      && !draft.skipped
      && active.error === undefined
    ) return state
    const nextDraft: QuestionDraftEditor = {
      ...draft,
      selected: draft.multiSelect ? draft.selected : Object.freeze([]),
      editor,
      skipped: false,
      optionIndex,
    }
    return {
      ...state,
      active: replaceQuestionDraft(active, active.questionIndex, nextDraft, {
        error: undefined,
        optionIndex,
      }),
    }
  }
  if (action.type === 'insert' && (action.text === '1' || action.text === '2'
    || (action.text === '3' && active.allowSession === true))) {
    return { ...state, active: { ...active, selectedIndex: Number(action.text) - 1,
      editor: createPromptEditorState(), error: undefined, scrollOffset: 0,
    } }
  }
  const editor = reducePromptEditor(active.editor, action)
  if (editor === active.editor && active.error === undefined) return state
  const token = editor.text.trim().toLowerCase()
  const selectedIndex = token === '3' && active.allowSession === true ? 2
    : ['y', 'yes', '1'].includes(token) ? 0 : ['n', 'no', '2'].includes(token) ? 1 : active.selectedIndex
  return { ...state, active: { ...active, editor, selectedIndex, error: undefined,
    ...(selectedIndex === active.selectedIndex ? {} : { scrollOffset: 0 }),
  } }
}

function answeredResponse(
  active: ActiveQuestionEditor,
  answers = active.answers,
): InteractionResponse {
  return {
    id: active.interactionId,
    kind: 'question',
    outcome: { kind: 'answered', answer: { answers } },
  }
}

function questionAt(
  active: ActiveQuestionEditor,
  index: number,
  error: string | undefined = undefined,
): ActiveQuestionEditor {
  const questionIndex = Math.min(active.drafts.length - 1, Math.max(0, index))
  const draft = active.drafts[questionIndex]!
  return {
    ...active,
    questionIndex,
    optionIndex: draft.optionIndex,
    editor: draft.editor,
    error,
  }
}

function submitQuestionDrafts(
  state: InteractionEditorState,
  active: ActiveQuestionEditor,
): InteractionEditorCommand {
  const missing = active.drafts.findIndex(draft => draftStatus(draft) === 'pending')
  if (missing >= 0) {
    return {
      state: {
        ...state,
        active: questionAt(
          active,
          missing,
          'Please complete every question or skip it before submitting.',
        ),
      },
    }
  }
  const answers = active.drafts.map(draftAnswer)
  const nextActive: ActiveQuestionEditor = {
    ...active,
    answers,
    error: undefined,
    awaitingReceipt: true,
  }
  return {
    state: { ...state, active: nextActive },
    response: answeredResponse(nextActive, answers),
  }
}

function continueQuestion(
  state: InteractionEditorState,
  active: ActiveQuestionEditor,
): InteractionEditorCommand {
  const draft = active.drafts[active.questionIndex]
  if (draft === undefined) {
    return {
      state: withActiveError(state, active, 'Question request contains no questions.'),
    }
  }
  if (draftStatus(draft) === 'pending') {
    return {
      state: withActiveError(
        state,
        active,
        'Answer this question or skip it before continuing.',
      ),
    }
  }
  if (active.questionIndex < active.drafts.length - 1) {
    return {
      state: {
        ...state,
        active: questionAt(active, active.questionIndex + 1),
      },
    }
  }
  return submitQuestionDrafts(state, active)
}

export function prepareQuestionContinue(
  state: InteractionEditorState,
  snapshot: InteractionSnapshot,
): InteractionEditorCommand {
  const active = state.active
  if (active?.kind !== 'question' || active.awaitingReceipt) return { state }
  const item = pendingFor(snapshot, active)
  if (item === undefined) return { state: settleActive(state, active) }
  return continueQuestion(state, active)
}

export function prepareQuestionSkip(
  state: InteractionEditorState,
  snapshot: InteractionSnapshot,
): InteractionEditorCommand {
  const active = state.active
  if (active?.kind !== 'question' || active.awaitingReceipt) return { state }
  const item = pendingFor(snapshot, active)
  if (item === undefined) return { state: settleActive(state, active) }
  const draft = active.drafts[active.questionIndex]
  if (draft === undefined) {
    return {
      state: withActiveError(state, active, 'Question request contains no questions.'),
    }
  }
  const skipped: QuestionDraftEditor = {
    ...draft,
    selected: Object.freeze([]),
    editor: createPromptEditorState(),
    skipped: true,
    optionIndex: draft.optionLabels.length,
  }
  const nextActive = replaceQuestionDraft(active, active.questionIndex, skipped, {
    error: undefined,
    optionIndex: skipped.optionIndex,
  })
  if (active.questionIndex < active.drafts.length - 1) {
    return {
      state: {
        ...state,
        active: questionAt(nextActive, active.questionIndex + 1),
      },
    }
  }
  return submitQuestionDrafts({ ...state, active: nextActive }, nextActive)
}

export function moveQuestionFocus(
  state: InteractionEditorState,
  direction: 'previous' | 'next',
): InteractionEditorState {
  const active = state.active
  if (active?.kind !== 'question' || active.awaitingReceipt) return state
  const draft = active.drafts[active.questionIndex]
  if (draft === undefined) return state
  const delta = direction === 'previous' ? -1 : 1
  const optionIndex = Math.min(
    draft.optionLabels.length,
    Math.max(0, draft.optionIndex + delta),
  )
  if (optionIndex === draft.optionIndex && active.error === undefined) return state
  const nextDraft = { ...draft, optionIndex }
  return {
    ...state,
    active: replaceQuestionDraft(active, active.questionIndex, nextDraft, {
      error: undefined,
      optionIndex,
    }),
  }
}

export function moveQuestionPage(
  state: InteractionEditorState,
  direction: 'previous' | 'next',
): InteractionEditorState {
  const active = state.active
  if (active?.kind !== 'question' || active.awaitingReceipt) return state
  if (active.drafts.length === 0) return state
  const delta = direction === 'previous' ? -1 : 1
  const questionIndex = Math.min(
    active.drafts.length - 1,
    Math.max(0, active.questionIndex + delta),
  )
  if (questionIndex === active.questionIndex && active.error === undefined) return state
  return { ...state, active: questionAt(active, questionIndex) }
}

export function prepareInteractionSubmit(
  state: InteractionEditorState,
  snapshot: InteractionSnapshot,
): InteractionEditorCommand {
  const active = state.active
  if (active === undefined || active.awaitingReceipt) return { state }
  const item = pendingFor(snapshot, active)
  if (item === undefined) return { state: settleActive(state, active) }

  if (active.kind === 'approval') {
    const token = active.editor.text.trim().toLowerCase()
    const remembered = item.kind === 'approval' && item.allowSession === true
      && (token === '' ? active.selectedIndex === 2 : token === '3')
    const allowed = token === ''
      ? active.selectedIndex === 0
      : token === 'y' || token === 'yes' || token === '1'
    const rejected = token === ''
      ? active.selectedIndex === 1
      : token === 'n' || token === 'no' || token === '2'
    if (!allowed && !rejected && !remembered) {
      return { state: withActiveError(state, active, 'Choose 1 to allow once, 2 to reject, or an offered session option.') }
    }
    if ((allowed || remembered) && item.kind === 'approval') {
      const error = approvalEvidenceError(item)
      if (error !== undefined) return { state: withActiveError(state, active, error) }
    }
    const nextState: InteractionEditorState = {
      ...state,
      active: { ...active, error: undefined, awaitingReceipt: true },
    }
    return {
      state: nextState,
      response: {
        id: active.interactionId,
        kind: 'approval',
        outcome: remembered ? 'allowed-session' : allowed ? 'allowed-once' : 'rejected',
      },
    }
  }

  if (active.kind === 'plan-review') {
    const choice = planReviewChoices(active.review)[active.selectedIndex]
    if (choice === undefined) return { state }
    const nextActive = { ...active, error: undefined, awaitingReceipt: true }
    return {
      state: { ...state, active: nextActive },
      response: choice.kind === 'discuss'
        ? {
            id: active.interactionId,
            kind: 'question',
            outcome: { kind: 'cancelled' },
          }
        : {
            id: active.interactionId,
            kind: 'question',
            outcome: {
              kind: 'answered',
              answer: {
                answers: [{ id: active.review.id, selected: [choice.option.label] }],
              },
            },
          },
    }
  }

  if (active.drafts.length === 0) {
    return { state: withActiveError(state, active, 'Question request contains no questions.') }
  }
  const draft = active.drafts[active.questionIndex]!
  const selected = draft.optionLabels[active.optionIndex]
  if (selected === undefined) return continueQuestion(state, active)
  const wasSelected = draft.selected.includes(selected)
  const nextDraft: QuestionDraftEditor = draft.multiSelect
    ? {
        ...draft,
        selected: wasSelected
          ? draft.selected.filter(label => label !== selected)
          : [...draft.selected, selected],
        skipped: false,
      }
    : {
        ...draft,
        selected: [selected],
        editor: createPromptEditorState(),
        skipped: false,
      }
  const nextActive = replaceQuestionDraft(active, active.questionIndex, nextDraft, {
    error: undefined,
  })
  const nextState = { ...state, active: nextActive }
  return draft.multiSelect ? { state: nextState } : continueQuestion(nextState, nextActive)
}

export function moveApprovalSelection(
  state: InteractionEditorState,
  direction: 'previous' | 'next',
): InteractionEditorState {
  const active = state.active
  if (active?.kind !== 'approval' || active.awaitingReceipt) return state
  const selectedIndex = Math.max(0, Math.min(active.allowSession === true ? 2 : 1,
    active.selectedIndex + (direction === 'previous' ? -1 : 1)))
  if (selectedIndex === active.selectedIndex && active.error === undefined) return state
  return {
    ...state,
    active: {
      ...active,
      selectedIndex,
      scrollOffset: 0,
      editor: createPromptEditorState(),
      error: undefined,
    },
  }
}

export function prepareInteractionCancel(
  state: InteractionEditorState,
): InteractionEditorCommand {
  const active = state.active
  if (active === undefined || active.awaitingReceipt) return { state }
  return {
    state: { ...state, active: { ...active, error: undefined, awaitingReceipt: true } },
    response: active.kind === 'approval'
      ? { id: active.interactionId, kind: 'approval', outcome: 'rejected' }
      : {
          id: active.interactionId,
          kind: 'question',
          outcome: { kind: 'cancelled' },
        },
  }
}

export function movePlanReviewSelection(
  state: InteractionEditorState,
  direction: 'previous' | 'next',
): InteractionEditorState {
  const active = state.active
  if (active?.kind !== 'plan-review' || active.awaitingReceipt) return state
  const choices = planReviewChoices(active.review)
  const delta = direction === 'previous' ? -1 : 1
  const selectedIndex = Math.min(
    choices.length - 1,
    Math.max(0, active.selectedIndex + delta),
  )
  if (selectedIndex === active.selectedIndex && active.error === undefined) return state
  return {
    ...state,
    active: {
      ...active,
      selectedIndex,
      editor: createPromptEditorState(choices[selectedIndex]!.label),
      error: undefined,
    },
  }
}

export function applyInteractionReceipt(
  state: InteractionEditorState,
  receipt: InteractionReceipt,
): InteractionEditorState {
  const active = state.active
  if (active === undefined) return state
  if (receipt.accepted || receipt.reason === 'not-pending') return settleActive(state, active)
  return {
    ...state,
    active: {
      ...active,
      awaitingReceipt: false,
      error: receipt.message ?? 'The interaction response was rejected.',
    },
  }
}

export function selectDshTuiInputMode(
  prompt: PromptEditorState,
  state: InteractionEditorState,
): DshTuiInputMode {
  const active = state.active
  if (active === undefined) return { kind: 'prompt', editor: prompt }
  const error = active.error === undefined ? {} : { error: active.error }
  return active.kind === 'approval'
    ? {
        kind: 'approval',
        editor: active.editor,
        interactionId: active.interactionId,
        selectedIndex: active.selectedIndex,
        ...(active.scrollOffset === undefined ? {} : { scrollOffset: active.scrollOffset }),
        actionCount: active.allowSession === true ? 3 : 2,
        ...(active.detailsExpanded === undefined ? {} : { detailsExpanded: active.detailsExpanded }),
        ...error,
      }
    : active.kind === 'question'
      ? (() => {
          const draft = active.drafts[active.questionIndex]
          return {
            kind: 'question' as const,
            editor: active.editor,
            interactionId: active.interactionId,
            questionIndex: active.questionIndex,
            answerCount: active.answers.length,
            questionCount: active.drafts.length,
            optionIndex: active.optionIndex,
            selected: draft?.selected ?? [],
            skipped: draft?.skipped ?? false,
            multiSelect: draft?.multiSelect ?? false,
            steps: active.drafts.map(draftStatus),
            ...error,
          }
        })()
      : {
          kind: 'plan-review',
          editor: active.editor,
          interactionId: active.interactionId,
          selectedIndex: active.selectedIndex,
          actionCount: planReviewChoices(active.review).length,
          ...error,
        }
}
