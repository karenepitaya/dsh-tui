import { describe, expect, it } from 'vitest'
import { approvalLayoutBudget } from '../src/presentation/approval-layout.ts'

describe('shared approval inspection budget', () => {
  it('keeps compact approval decisions independent of hidden draft chrome', () => {
    for (const rows of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(approvalLayoutBudget({ columns: 80, rows })).toEqual({
        compactOnly: true, dockRows: rows, canInspect: rows >= 4,
      })
    }
  })

  it('reserves header, separator, six composer rows and status without shrinking decisions', () => {
    expect(approvalLayoutBudget({ columns: 40, rows: 13 })).toEqual({
      compactOnly: false, dockRows: 4, canInspect: true,
    })
    expect(approvalLayoutBudget({ columns: 80, rows: 30 })).toEqual({
      compactOnly: false, dockRows: 12, canInspect: true,
    })
    expect(approvalLayoutBudget({ columns: 39, rows: 30 }).canInspect).toBe(false)
    expect(approvalLayoutBudget({ columns: 80, rows: 0 })).toEqual({
      compactOnly: true, dockRows: 1, canInspect: false,
    })
  })
})
