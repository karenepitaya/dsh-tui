import { sliceByColumn, truncateToWidth, visibleWidth } from '../terminal/text-layout.ts'
import type { PromptEditorState } from './prompt-editor.ts'
import { inlineText } from './workspace-rows.ts'

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function promptProjection(
  prompt: PromptEditorState,
  columns: number,
  requestedPrefix = '> ',
): { readonly line: string; readonly column: number } {
  const graphemes = Array.from(graphemeSegmenter.segment(prompt.text), part => part.segment)
  const before = inlineText(graphemes.slice(0, prompt.cursor).join(''))
  const full = inlineText(prompt.text)
  const prefix = columns > 1 ? requestedPrefix : ''
  const prefixWidth = visibleWidth(prefix)
  const available = Math.max(1, columns - prefixWidth)
  const beforeWidth = visibleWidth(before)
  const start = Math.max(0, beforeWidth - available + 1)
  const visible = sliceByColumn(full, start, available, true)
  return {
    line: truncateToWidth(prefix + visible, columns, ''),
    column: Math.min(columns - 1, prefixWidth + beforeWidth - start),
  }
}
