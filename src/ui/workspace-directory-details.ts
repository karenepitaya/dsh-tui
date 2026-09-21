import type { TerminalViewport, UiFrame } from './frame.ts'
import { legacyDetailViewport } from './legacy-detail-rows.ts'
import { secondaryModalFill, secondaryModalRow } from './modal.ts'
import { secondaryModalFrame } from './workspace-rows.ts'

export function workspaceDirectoryDetailViewport(lines: readonly string[], viewport: TerminalViewport, offset = 0) {
  return legacyDetailViewport(lines.map(text => ({ text })), Math.max(1, viewport.columns - 4), Math.max(0, viewport.rows - 2), offset)
}

export function workspaceDirectoryDetailFrame(viewport: TerminalViewport, lines: readonly string[], offset: number, actionHints?: string): UiFrame {
  const details = workspaceDirectoryDetailViewport(lines, viewport, offset)
  const rows = [secondaryModalRow(secondaryModalFill('Details', viewport.columns), 'accent')]
  if (viewport.rows === 1) return secondaryModalFrame(viewport, rows)
  for (let index = 0; index < viewport.rows - 2; index += 1) {
    const text = details.rows[index]?.text ?? ''
    rows.push(secondaryModalRow(secondaryModalFill(`  ${text}`, viewport.columns), text.startsWith('Error:') || text.startsWith('Broken') ? 'error' : 'primary'))
  }
  rows.push(secondaryModalRow(secondaryModalFill(`Esc back${actionHints === undefined ? '' : ` · ${actionHints}`} · Tab h/l focus · j/k PgUp/Down scroll · ${details.offset + 1}/${details.maxOffset + 1}`, viewport.columns), 'muted'))
  return secondaryModalFrame(viewport, rows)
}
