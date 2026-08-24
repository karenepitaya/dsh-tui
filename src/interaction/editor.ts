import type {
  InteractionReceipt,
  InteractionResponse,
  InteractionSnapshot,
  PendingInteraction,
  PendingQuestionInteraction,
  UiQuestion,
  UiQuestionAnswerItem,
} from './port.ts'
import {
  createPromptEditorState,
  reducePromptEditor,
  type PromptEditorAction,
  type PromptEditorState,
} from '../ui/prompt-editor.ts'

export interface ActiveApprovalEditor {
  readonly kind: 'approval'
  readonly interactionId: string
  readonly editor: PromptEditorState
  readonly error: string | undefined
  readonly awaitingReceipt: boolean
}

export interface ActiveQuestionEditor {
  readonly kind: 'question'
  readonly interactionId: string
  readonly editor: PromptEditorState
  readonly error: string | undefined
  readonly awaitingReceipt: boolean
  readonly questionIndex: number
  readonly answers: readonly UiQuestionAnswerItem[]
}

export type ActiveInteractionEditor = ActiveApprovalEditor | ActiveQuestionEditor

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
      readonly error?: string
    }
  | {
      readonly kind: 'question'
      readonly editor: PromptEditorState
      readonly interactionId: string
      readonly questionIndex: number
      readonly answerCount: number
      readonly error?: string
    }

export interface InteractionEditorCommand {
  readonly state: InteractionEditorState
  readonly response?: InteractionResponse
}

type AnswerResult =
  | { readonly answer: UiQuestionAnswerItem; readonly error?: never }
  | { readonly answer?: never; readonly error: string }

function createActive(item: PendingInteraction): ActiveInteractionEditor {
  const common = {
    interactionId: item.id,
    editor: createPromptEditorState(),
    error: undefined,
    awaitingReceipt: false,
  }
  return item.kind === 'approval'
    ? { kind: 'approval', ...common }
    : { kind: 'question', ...common, questionIndex: 0, answers: [] }
}

function pendingFor(
  snapshot: InteractionSnapshot,
  active: ActiveInteractionEditor,
): PendingInteraction | undefined {
  return snapshot.pending.find(item => item.id === active.interactionId && item.kind === active.kind)
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

function optionLabel(
  options: NonNullable<UiQuestion['options']>,
  token: string,
): string | undefined {
  if (/^[0-9]+$/u.test(token)) {
    const index = Number(token) - 1
    return options[index]?.label
  }
  return options.find(option => option.label === token)?.label
}

function answerQuestion(question: UiQuestion, input: string): AnswerResult {
  const text = input.trim()
  const options = question.options ?? []
  if (options.length === 0) {
    return text === ''
      ? { error: 'Custom answers must be nonblank.' }
      : { answer: { id: question.id, selected: [], custom: text } }
  }

  if (question.multiSelect === true) {
    const tokens = text.split(/[,，]/u).map(token => token.trim()).filter(Boolean)
    if (tokens.length === 0) return { error: 'Choose at least one option.' }
    const selected: string[] = []
    for (const token of tokens) {
      const label = optionLabel(options, token)
      if (label === undefined) return { error: `Unknown option: ${token}` }
      if (!selected.includes(label)) selected.push(label)
    }
    return { answer: { id: question.id, selected } }
  }

  const label = optionLabel(options, text)
  return label === undefined
    ? { error: 'Choose one option by number or exact label.' }
    : { answer: { id: question.id, selected: [label] } }
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
        item.id === active.interactionId
        && item.kind === active.kind
        && !settledIds.includes(item.id)
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
  const editor = reducePromptEditor(active.editor, action)
  if (editor === active.editor && active.error === undefined) return state
  return { ...state, active: { ...active, editor, error: undefined } }
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
    const allowed = token === 'y' || token === 'yes' || token === '1'
    const rejected = token === 'n' || token === 'no' || token === '2'
    if (!allowed && !rejected) {
      return { state: withActiveError(state, active, 'Enter y/yes/1 to allow or n/no/2 to reject.') }
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
        outcome: allowed ? 'allowed-once' : 'rejected',
      },
    }
  }

  const questions = (item as PendingQuestionInteraction).questions
  if (questions.length === 0) {
    return { state: withActiveError(state, active, 'Question request contains no questions.') }
  }
  if (active.questionIndex >= questions.length) {
    const nextActive = { ...active, error: undefined, awaitingReceipt: true }
    return {
      state: { ...state, active: nextActive },
      response: answeredResponse(nextActive),
    }
  }

  const current = questions[active.questionIndex]!
  const result = answerQuestion(current, active.editor.text)
  if (result.answer === undefined) {
    return { state: withActiveError(state, active, result.error) }
  }
  const answers = [...active.answers, result.answer]
  const questionIndex = active.questionIndex + 1
  if (questionIndex < questions.length) {
    return {
      state: {
        ...state,
        active: {
          ...active,
          editor: createPromptEditorState(),
          error: undefined,
          questionIndex,
          answers,
        },
      },
    }
  }

  const nextActive: ActiveQuestionEditor = {
    ...active,
    error: undefined,
    awaitingReceipt: true,
    questionIndex,
    answers,
  }
  return {
    state: { ...state, active: nextActive },
    response: answeredResponse(nextActive, answers),
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
        ...error,
      }
    : {
        kind: 'question',
        editor: active.editor,
        interactionId: active.interactionId,
        questionIndex: active.questionIndex,
        answerCount: active.answers.length,
        ...error,
      }
}
