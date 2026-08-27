import type { UiQuestion, UiQuestionOption } from './port.ts'

/** Strictly narrowed official plan-review presentation. */
export interface UiPlanReview {
  readonly id: string
  readonly question: string
  readonly plan: string
  readonly approve: UiQuestionOption
  readonly decline?: UiQuestionOption
}
export type UiPlanReviewChoice =
  | { readonly kind: 'discuss'; readonly label: 'Discuss' }
  | {
      readonly kind: 'answer'
      readonly verdict: 'decline' | 'approve'
      readonly option: UiQuestionOption
      readonly label: string
    }

/**
 * Accept only the binary form a dedicated decision surface can represent.
 * Every rejected form remains reachable through the generic question editor.
 */
export function planReviewOf(
  questions: readonly UiQuestion[],
): UiPlanReview | undefined {
  if (questions.length !== 1) return undefined
  const question = questions[0]!
  if (question.intent?.kind !== 'plan-review') return undefined
  if (question.detail === undefined || question.detail.trim() === '') return undefined
  if (question.multiSelect === true) return undefined
  const options = question.options
  if (options === undefined || options.length === 0 || options.length > 2) return undefined
  const approving = options.filter(option => option.label === question.intent!.approve)
  if (approving.length !== 1) return undefined
  const approve = approving[0]!
  const decline = options.find(option => option !== approve)
  return {
    id: question.id,
    question: question.question,
    plan: question.detail,
    approve,
    ...(decline === undefined ? {} : { decline }),
  }
}

/** Ordered keyboard decisions: discuss, optional decline, then primary approve. */
export function planReviewChoices(review: UiPlanReview): readonly UiPlanReviewChoice[] {
  return [
    { kind: 'discuss', label: 'Discuss' },
    ...(review.decline === undefined
      ? []
      : [{
          kind: 'answer' as const,
          verdict: 'decline' as const,
          option: review.decline,
          label: review.decline.label,
        }]),
    {
      kind: 'answer',
      verdict: 'approve',
      option: review.approve,
      label: review.approve.label,
    },
  ]
}
