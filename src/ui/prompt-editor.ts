export interface PromptEditorState {
  readonly text: string
  /** Cursor position in grapheme clusters, not UTF-16 code units. */
  readonly cursor: number
}

export type PromptEditorAction =
  | { readonly type: 'insert'; readonly text: string }
  | { readonly type: 'newline' }
  | { readonly type: 'backspace' }
  | { readonly type: 'delete' }
  | { readonly type: 'move-left' }
  | { readonly type: 'move-right' }
  | { readonly type: 'move-home' }
  | { readonly type: 'move-end' }
  | { readonly type: 'clear' }

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), part => part.segment)
}

export function createPromptEditorState(text = ''): PromptEditorState {
  const normalized = normalizeNewlines(text)
  return { text: normalized, cursor: graphemes(normalized).length }
}

export function reducePromptEditor(
  state: PromptEditorState,
  action: PromptEditorAction,
): PromptEditorState {
  const parts = graphemes(state.text)
  switch (action.type) {
    case 'insert': {
      const text = normalizeNewlines(action.text)
      if (text === '') return state
      const inserted = graphemes(text)
      return {
        text: [...parts.slice(0, state.cursor), ...inserted, ...parts.slice(state.cursor)].join(''),
        cursor: state.cursor + inserted.length,
      }
    }
    case 'newline':
      return reducePromptEditor(state, { type: 'insert', text: '\n' })
    case 'backspace':
      if (state.cursor === 0) return state
      return {
        text: [...parts.slice(0, state.cursor - 1), ...parts.slice(state.cursor)].join(''),
        cursor: state.cursor - 1,
      }
    case 'delete':
      if (state.cursor >= parts.length) return state
      return {
        text: [...parts.slice(0, state.cursor), ...parts.slice(state.cursor + 1)].join(''),
        cursor: state.cursor,
      }
    case 'move-left':
      return state.cursor === 0 ? state : { ...state, cursor: state.cursor - 1 }
    case 'move-right':
      return state.cursor >= parts.length ? state : { ...state, cursor: state.cursor + 1 }
    case 'move-home':
      return state.cursor === 0 ? state : { ...state, cursor: 0 }
    case 'move-end':
      return state.cursor === parts.length ? state : { ...state, cursor: parts.length }
    case 'clear':
      return state.text === '' ? state : { text: '', cursor: 0 }
  }
}
