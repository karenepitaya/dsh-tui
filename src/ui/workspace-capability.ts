import { choiceText } from '../presentation/control-projection.ts'
import type { LegacyDirectoryState } from '../navigation/legacy-directory.ts'
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from '../terminal/text-layout.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'
import type { DshTuiSemanticRole } from './theme.ts'
import type { PromptEditorState } from './prompt-editor.ts'
import { promptProjection } from './prompt-projection.ts'
import { secondaryModalFill, secondaryModalHeader, secondaryModalPair, secondaryModalRow, secondaryModalSection, secondaryModalSplit, type SecondaryModalRow } from './modal.ts'
import { focusedWindowStart, inlineText, secondaryModalFrame } from './workspace-rows.ts'

function wrap(text: string, columns: number): string[] {
  return wrapTextWithAnsi(inlineText(text), Math.max(1, columns)).map(stripTerminalSequences)
}

interface CapabilityLensListRow {
  readonly label: string
  readonly badge: string
}

export interface CapabilityLensDetailLine {
  readonly text: string
  readonly tone: DshTuiSemanticRole
  readonly bold?: boolean
  readonly dim?: boolean
}

export interface LegacyDirectoryFrame extends UiFrame {
  readonly detailMaxOffset?: number
}

export interface CapabilityLensOptions extends LegacyDirectoryState {
  readonly title: string
  readonly sectionLabel: string
  readonly query: PromptEditorState
  readonly rows: readonly CapabilityLensListRow[]
  readonly selectedIndex: number
  readonly summary: string
  readonly detail: readonly CapabilityLensDetailLine[]
  readonly footerLeft: string
}

export function capabilityLensLeftColumns(columns: number): number {
  return columns < 100 ? Math.max(1, columns - 2) : Math.max(18, Math.min(38, Math.floor((columns - 3) * 0.32)))
}

export function renderCapabilityLensFrame(options: CapabilityLensOptions, viewport: TerminalViewport): LegacyDirectoryFrame {
  const { columns, rows } = viewport
  const focus = options.navigation?.focus ?? 'list'
  const split = columns >= 100
  const header = secondaryModalRow(secondaryModalHeader(options.title, columns), 'accent', { bold: true })
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  const searchPrefix = '  Search › '
  const editor = promptProjection(options.query, Math.max(1, columns - visibleWidth(searchPrefix)), '')
  const search = secondaryModalRow(secondaryModalFill(`${searchPrefix}${editor.line}`, columns), 'composer', { bold: true })
  const cursor = focus === 'search' ? { row: 1, column: Math.min(columns - 1, visibleWidth(searchPrefix) + editor.column) } : undefined
  if (rows === 2) return secondaryModalFrame(viewport, [header, search])
  const footer = secondaryModalRow(secondaryModalPair(
    `  ${focus === 'search' ? 'Enter results' : options.footerLeft.trim()} · / i search · Tab details · h/l focus · j/k move`,
    'Esc back', columns), 'muted')
  if (rows === 3) return secondaryModalFrame(viewport, [header, search, footer], cursor)
  const bodySlots = rows - 4
  const leftColumns = capabilityLensLeftColumns(columns)
  const detailWidth = split ? columns - leftColumns - 3 : Math.max(1, columns - 4)
  const details = options.detail.flatMap(line => wrap(line.text, detailWidth).map(text => ({ ...line, text })))
  const detailOffset = Math.max(0, Math.min(options.navigation?.detailOffset ?? 0, details.length - bodySlots))
  const range = details.length > bodySlots ? ` · Detail ${detailOffset + 1}–${Math.min(details.length, detailOffset + bodySlots)}/${details.length}` : ''
  const section = secondaryModalRow(secondaryModalSection(options.sectionLabel, columns, `${options.summary}${range}`), 'interaction', { bold: true })
  const notices = !split && focus !== 'details' && options.rows.length > 0
    ? details.filter(line => line.tone === 'error' || line.tone === 'warning').slice(0, Math.min(2, Math.max(0, bodySlots - 1))) : []
  const start = focusedWindowStart(options.rows.length, options.selectedIndex, bodySlots - notices.length)
  const body: SecondaryModalRow[] = []
  for (let index = 0; index < bodySlots; index += 1) {
    const notice = notices[index]
    if (notice !== undefined) {
      body.push(secondaryModalRow(secondaryModalFill(`  ${notice.text}`, columns), notice.tone, { bold: notice.bold === true }))
      continue
    }
    const itemIndex = start + index - notices.length
    const item = options.rows[itemIndex]
    const selected = item !== undefined && itemIndex === options.selectedIndex
    const detail = details[detailOffset + index]
    const left = item === undefined ? '' : secondaryModalPair(choiceText(inlineText(item.label), selected), item.badge, leftColumns)
    if (split) {
      body.push(secondaryModalRow(secondaryModalSplit(left, detail?.text ?? '', columns, leftColumns),
        detail?.tone === 'error' ? 'error' : selected ? 'accent' : detail?.tone ?? 'primary',
        { bold: selected || detail?.bold === true, selected }))
    } else if (focus === 'details' || options.rows.length === 0) {
      body.push(secondaryModalRow(secondaryModalFill(`  ${detail?.text ?? ''}`, columns), detail?.tone ?? 'primary', { bold: detail?.bold === true }))
    } else {
      body.push(secondaryModalRow(secondaryModalFill(left, columns), selected ? 'accent' : 'primary', { bold: selected, selected }))
    }
  }
  return { ...secondaryModalFrame(viewport, [header, search, section, ...body, footer], cursor, split ? leftColumns : undefined),
    detailMaxOffset: Math.max(0, details.length - bodySlots) }
}
