import { sliceByColumn, stripTerminalSequences } from '../terminal/text-layout.ts'
import type { TerminalViewport, UiCursor, UiFrame } from './frame.ts'
import { secondaryModalFill, secondaryModalRow, type SecondaryModalRow } from './modal.ts'

export function inlineText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '�')
    .replaceAll('\n', '↵')
}

export function focusedWindowStart(count: number, selectedIndex: number, slots: number): number {
  if (count <= slots || selectedIndex < 0) return 0
  return Math.min(count - slots, Math.max(0, selectedIndex - Math.floor(slots / 2)))
}

export function secondaryModalFrame(
  viewport: TerminalViewport,
  rows: readonly SecondaryModalRow[],
  cursor?: UiCursor,
  splitLeftColumns?: number,
): UiFrame {
  return {
    title: 'DSH-TUI',
    viewport,
    lines: rows.map(row => row.text),
    lineStyles: rows.map(row => row.style),
    ...(splitLeftColumns === undefined || viewport.columns <= 4 ? {} : {
      styleSpans: rows.map(row => {
        const left = Math.max(1, Math.min(viewport.columns - 4, Math.floor(splitLeftColumns)))
        if (!row.text.startsWith('│') || !row.text.endsWith('│')
          || sliceByColumn(row.text, left + 1, 1) !== '│') return []
        return [
          { column: 1, width: left, style: row.style },
          { column: left + 2, width: viewport.columns - left - 3, style: row.style },
        ]
      }),
    }),
    ...(cursor === undefined ? {} : { cursor }),
  }
}

export function fillModalRows(
  rows: readonly SecondaryModalRow[],
  viewport: TerminalViewport,
  footer: SecondaryModalRow,
): SecondaryModalRow[] {
  const available = Math.max(0, viewport.rows - 1)
  const visible = rows.slice(0, available)
  const padding = Array.from({ length: available - visible.length }, () => (
    secondaryModalRow(
      secondaryModalFill('', viewport.columns),
      'primary',
    )
  ))
  return [...visible, ...padding, footer]
}
