import { wrapTextWithAnsi } from '../terminal/text-layout.ts'
import { inlineText } from './workspace-rows.ts'

/** Wrap before slicing so every safe detail remains reachable at any width. */
export function legacyDetailViewport<T extends { readonly text: string }>(
  rows: readonly T[],
  width: number,
  height: number,
  requestedOffset: number,
): { readonly rows: readonly T[]; readonly offset: number; readonly maxOffset: number } {
  const wrapped = rows.flatMap(row => wrapTextWithAnsi(inlineText(row.text), Math.max(1, width))
    .map(text => ({ ...row, text })))
  const capacity = Math.max(0, Math.floor(height))
  const maxOffset = Math.max(0, wrapped.length - capacity)
  const offset = Math.max(0, Math.min(maxOffset, Math.floor(requestedOffset)))
  return { rows: wrapped.slice(offset, offset + capacity), offset, maxOffset }
}
