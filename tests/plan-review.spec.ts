import { describe, expect, it } from 'vitest'
import {
  planReviewChoices,
  planReviewOf,
} from '../src/interaction/plan-review.ts'
import type { UiQuestion } from '../src/interaction/port.ts'

type QuestionOverrides = {
  [Key in keyof UiQuestion]?: UiQuestion[Key] | undefined
}

function review(overrides: QuestionOverrides = {}): UiQuestion {
  return {
    id: 'plan-review',
    header: 'Plan review',
    question: 'Approve this plan?',
    detail: '# Ship it\n\n- test it',
    options: [
      { label: 'Approve', description: 'Carry it out.' },
      { label: 'Keep planning', description: 'Revise it.' },
    ],
    intent: { kind: 'plan-review', approve: 'Approve' },
    ...overrides,
  } as UiQuestion
}

describe('plan-review presentation narrowing', () => {
  it('projects the exact binary decision and orders discuss, decline, approve', () => {
    const projected = planReviewOf([review()])!
    expect(projected).toEqual({
      id: 'plan-review',
      question: 'Approve this plan?',
      plan: '# Ship it\n\n- test it',
      approve: { label: 'Approve', description: 'Carry it out.' },
      decline: { label: 'Keep planning', description: 'Revise it.' },
    })
    expect(planReviewChoices(projected)).toEqual([
      { kind: 'discuss', label: 'Discuss' },
      {
        kind: 'answer',
        verdict: 'decline',
        option: projected.decline,
        label: 'Keep planning',
      },
      {
        kind: 'answer',
        verdict: 'approve',
        option: projected.approve,
        label: 'Approve',
      },
    ])
  })

  it('supports an approve-only review without inventing a decline', () => {
    const projected = planReviewOf([review({ options: [{ label: 'Approve' }] })])!
    expect(projected).not.toHaveProperty('decline')
    expect(planReviewChoices(projected).map(choice => choice.label)).toEqual([
      'Discuss',
      'Approve',
    ])
  })

  it.each([
    ['no questions', []],
    ['more than one question', [review(), review({ id: 'second' })]],
    ['no intent', [review({ intent: undefined })]],
    ['no detail', [review({ detail: undefined })]],
    ['blank detail', [review({ detail: '  ' })]],
    ['multi-select', [review({ multiSelect: true })]],
    ['no options', [review({ options: undefined })]],
    ['empty options', [review({ options: [] })]],
    ['three options', [review({ options: [
      { label: 'Approve' }, { label: 'Keep planning' }, { label: 'Restart' },
    ] })]],
    ['missing approve label', [review({
      intent: { kind: 'plan-review', approve: 'Ship it' },
    })]],
    ['duplicate approve label', [review({
      options: [{ label: 'Approve' }, { label: 'Approve' }],
    })]],
  ] satisfies readonly [string, readonly UiQuestion[]][])('keeps %s on the generic flow', (_label, questions) => {
    expect(planReviewOf(questions)).toBeUndefined()
  })
})
