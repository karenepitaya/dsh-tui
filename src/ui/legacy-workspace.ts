import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from '../terminal/text-layout.ts'
import { safeFeatureSurfaceText } from '../presentation/feature-surface.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'
import type { UiFrameLineStyle, UiFrameStyleSpan } from './frame-style.ts'
import { workspaceDirectoryDetailFrame } from './workspace-directory-details.ts'

export interface LegacyWorkspaceDescriptor {
  readonly title: string
  readonly focus: 'list' | 'details' | 'editor'
  readonly detailLines?: readonly string[]
  readonly detailOffset?: number
  readonly detailActionHints?: string
}

const PANEL: UiFrameLineStyle = Object.freeze({ tone: 'primary', backgroundRole: 'panelBackground', fill: true })

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function fit(text: string, columns: number): string {
  const value = stripTerminalSequences(truncateToWidth(safeFeatureSurfaceText(text), columns, ''))
  return value + ' '.repeat(Math.max(0, columns - visibleWidth(value)))
}

function bodyStyle(style: UiFrameLineStyle | undefined, selected: boolean, focused: boolean): UiFrameLineStyle {
  const tone = style?.tone
  return Object.freeze({
    ...PANEL,
    tone: selected ? 'primary' : tone === 'error' || tone === 'warning' || tone === 'success' ? tone : 'primary',
    ...(selected ? {
      backgroundRole: focused ? 'selectionBackground' as const : 'inactiveSelectionBackground' as const,
      ...(focused ? { bold: true as const } : {}),
    } : style?.bold === true ? { bold: true as const } : {}),
  })
}

function footerActions(text: string): string {
  return safeFeatureSurfaceText(text)
    .replace(/[╭╮╰╯├┤─]/gu, ' ')
    .replace(/\besc(?:ape)?\b(?:\s+(?:close|back|cancel))?/giu, '')
    .replace(/\s+/gu, ' ')
    .replace(/^[ ·|]+|[ ·|]+$/gu, '')
}

/**
 * Keep legacy domain projection and cursor geometry, but give directories the
 * same complete, solid Workspace canvas. No loaders or business state live here.
 */
export function renderLegacyWorkspaceFrame(
  viewport: TerminalViewport,
  descriptor: LegacyWorkspaceDescriptor,
  render: (viewport: TerminalViewport) => UiFrame,
): UiFrame {
  const normalized = Object.freeze({ columns: dimension(viewport.columns), rows: dimension(viewport.rows) })
  const frame = descriptor.focus === 'details' && descriptor.detailLines !== undefined
    ? workspaceDirectoryDetailFrame(normalized, descriptor.detailLines, descriptor.detailOffset ?? 0, descriptor.detailActionHints)
    : render(normalized)
  const { columns, rows } = normalized
  const queryFocused = frame.cursor !== undefined && descriptor.focus === 'list'
  const lines: string[] = []
  const lineStyles: UiFrameLineStyle[] = []
  const styleSpans: UiFrameStyleSpan[][] = []
  for (let row = 0; row < rows; row += 1) {
    const text = fit(frame.lines[row] ?? '', columns)
    const style = frame.lineStyles?.[row]
    const split = frame.styleSpans?.[row]
    const spans: UiFrameStyleSpan[] = [{ column: 0, width: columns, style: PANEL }]
    if (split?.length === 2) {
      const { column: left, width: leftWidth } = split[0]!
      const { column: right, width: rightWidth } = split[1]!
      const first = sliceByColumn(text, left, leftWidth, true)
      const second = sliceByColumn(text, right, rightWidth, true)
      const listSelected = /^[›▰]/u.test(first.trimStart())
      const detailSelected = descriptor.focus === 'details' && second.trimStart().startsWith('›')
      const listStyle = bodyStyle(style, listSelected, descriptor.focus === 'list' && !queryFocused)
      const detailStyle = bodyStyle(split[1]!.style, detailSelected, descriptor.focus === 'details')
      lines.push(fit(` ${first} ${second} `, columns))
      spans.push({ column: left, width: leftWidth, style: listStyle }, { column: right, width: rightWidth, style: detailStyle })
      lineStyles.push(listSelected ? listStyle : detailStyle)
    } else {
      const selected = (style?.inverse === true && descriptor.focus === 'list')
        || /^[│ ]*[›▰]/u.test(text)
      let projected = bodyStyle(style, selected, descriptor.focus === 'list' && !queryFocused)
      if (frame.cursor?.row === row) projected = { ...PANEL, backgroundRole: 'inputBackground' }
      // Remove a legacy single-pane box without changing terminal-cell offsets.
      lines.push(fit(text.startsWith('│') && text.endsWith('│')
        ? ` ${sliceByColumn(text, 1, Math.max(0, columns - 2), true)} `
        : text, columns))
      spans.push({ column: 0, width: columns, style: projected })
      lineStyles.push(projected)
    }
    styleSpans.push(spans)
  }
  const chrome = (row: number, text: string, tone: UiFrameLineStyle['tone']) => {
    lines[row] = fit(text, columns)
    const style = Object.freeze({ ...PANEL, tone, bold: true })
    lineStyles[row] = style
    styleSpans[row] = [{ column: 0, width: columns, style: PANEL }, { column: 0, width: columns, style }]
  }
  const contextLabel = queryFocused ? ' · Searching' : descriptor.focus === 'editor' ? ' · Editing'
    : descriptor.focus === 'details' && descriptor.detailLines !== undefined ? ' · Details' : ''
  chrome(0, ' ' + descriptor.title + contextLabel, 'accent')
  if (rows >= 2) {
    const originalFooter = frame.lines.at(-1) ?? ''
    const actions = rows >= 3 || /Notice:|Error:/u.test(originalFooter) ? footerActions(originalFooter) : ''
    chrome(rows - 1, ` Esc back${actions.length === 0 ? '' : ` · ${actions}`}`, 'muted')
  }
  const cursor = frame.cursor !== undefined && frame.cursor.row > 0 && frame.cursor.row < rows - 1
    ? { row: frame.cursor.row, column: Math.max(0, Math.min(columns - 1, frame.cursor.column)) }
    : undefined
  return Object.freeze({
    title: safeFeatureSurfaceText(frame.title), viewport: normalized,
    lines: Object.freeze(lines), lineStyles: Object.freeze(lineStyles),
    styleSpans: Object.freeze(styleSpans.map(spans => Object.freeze(spans))),
    ...(cursor === undefined ? {} : { cursor: Object.freeze(cursor) }),
  })
}
