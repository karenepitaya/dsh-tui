import { describe, expect, it } from 'vitest'
import {
  createPromptEditorState,
  reducePromptEditor,
} from '../src/ui/prompt-editor.ts'

describe('prompt editor reducer', () => {
  it('edits by grapheme without splitting emoji or combining marks', () => {
    let state = createPromptEditorState('A👨‍👩‍👧‍👦e\u0301中')
    expect(state).toEqual({ text: 'A👨‍👩‍👧‍👦e\u0301中', cursor: 4 })

    state = reducePromptEditor(state, { type: 'move-left' })
    state = reducePromptEditor(state, { type: 'backspace' })
    expect(state).toEqual({ text: 'A👨‍👩‍👧‍👦中', cursor: 2 })

    state = reducePromptEditor(state, { type: 'insert', text: '\r\nX' })
    expect(state).toEqual({ text: 'A👨‍👩‍👧‍👦\nX中', cursor: 4 })

    state = reducePromptEditor(state, { type: 'delete' })
    expect(state).toEqual({ text: 'A👨‍👩‍👧‍👦\nX', cursor: 4 })
  })

  it('supports newline, home, end, movement, and clear', () => {
    let state = createPromptEditorState()
    expect(state).toEqual({ text: '', cursor: 0 })

    state = reducePromptEditor(state, { type: 'insert', text: 'ab' })
    state = reducePromptEditor(state, { type: 'move-home' })
    state = reducePromptEditor(state, { type: 'move-right' })
    state = reducePromptEditor(state, { type: 'newline' })
    expect(state).toEqual({ text: 'a\nb', cursor: 2 })

    state = reducePromptEditor(state, { type: 'move-end' })
    expect(state.cursor).toBe(3)
    state = reducePromptEditor(state, { type: 'clear' })
    expect(state).toEqual({ text: '', cursor: 0 })
  })

  it('returns the same state for empty edits and boundary operations', () => {
    const empty = createPromptEditorState()
    expect(reducePromptEditor(empty, { type: 'insert', text: '' })).toBe(empty)
    expect(reducePromptEditor(empty, { type: 'move-left' })).toBe(empty)
    expect(reducePromptEditor(empty, { type: 'backspace' })).toBe(empty)
    expect(reducePromptEditor(empty, { type: 'delete' })).toBe(empty)

    const end = createPromptEditorState('x')
    expect(reducePromptEditor(end, { type: 'move-right' })).toBe(end)
    expect(reducePromptEditor(end, { type: 'move-end' })).toBe(end)
    expect(reducePromptEditor(empty, { type: 'move-home' })).toBe(empty)
    expect(reducePromptEditor(empty, { type: 'clear' })).toBe(empty)
  })
})
