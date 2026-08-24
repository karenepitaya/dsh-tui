import {
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { InteractionSnapshot, PendingInteraction } from '../interaction/port.ts'
import type { DshTuiInputMode } from '../interaction/editor.ts'
import type { CommandMenuView } from '../command/menu.ts'
import type { SessionPickerRow, SessionPickerView } from '../session/picker.ts'
import type {
  StartupPresetPickerRow,
  StartupPresetPickerView,
} from '../preset/picker.ts'
import type { SessionDurablePresence } from '../session/catalog-port.ts'
import type { SessionInspectionHeader } from '../session/inspection-port.ts'
import type { TranscriptRow, UiState } from '../transcript/state.ts'
import { ToolCardRendererRegistry } from '../presentation/tool-card-renderers.ts'
import type { PromptEditorState } from './prompt-editor.ts'
import { cordisBrandLines } from './brand.ts'

export interface TerminalViewport {
  readonly columns: number
  readonly rows: number
}

export interface UiCursor {
  readonly row: number
  readonly column: number
}

export interface UiFrame {
  readonly title: string
  readonly viewport: TerminalViewport
  readonly lines: readonly string[]
  readonly cursor?: UiCursor
}

export interface DshTuiView {
  readonly ui: UiState
  readonly interaction: InteractionSnapshot | undefined
  readonly prompt: PromptEditorState
  readonly input?: DshTuiInputMode
  readonly commandMenu?: CommandMenuView
  readonly commandNotice?: string
  readonly commandPending?: boolean
  readonly sessionInspection?: SessionInspectionPanel
  readonly sessionPicker?: SessionPickerPanel
  /** Internal effect-owned rich renderer set; absent means generic fallback. */
  readonly toolCards?: ToolCardRendererRegistry
}

export type SessionInspectionCatalogObservation =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'observed'
      readonly relation: 'cold' | 'other-live'
      readonly durablePresence: SessionDurablePresence
      readonly liveStatus?: 'idle' | 'running'
    }

export type SessionInspectionPanel =
  | {
      readonly kind: 'loading'
      readonly sessionId: string
    }
  | {
      readonly kind: 'error'
      readonly sessionId: string
      readonly message: string
    }
  | {
      readonly kind: 'ready'
      readonly sessionId: string
      readonly header: SessionInspectionHeader
      readonly projection: UiState
      readonly scrollOffset: number
      readonly refreshing: boolean
      readonly observation: SessionInspectionCatalogObservation
      readonly canResumeCold?: boolean
      readonly error?: string
      readonly notice?: string
    }
  | {
      readonly kind: 'confirm-resume'
      readonly sessionId: string
      readonly header: SessionInspectionHeader
      readonly observation: SessionInspectionCatalogObservation
    }

export interface SessionPickerPanel {
  readonly view: SessionPickerView
  readonly loading: boolean
  readonly loaded: boolean
  readonly liveActivation?: boolean
  readonly inspection?: boolean
  readonly error?: string
  readonly notice?: string
}

export interface StartupPresetPanel {
  readonly view?: StartupPresetPickerView
  readonly loading: boolean
  readonly loaded: boolean
  readonly error?: string
  readonly notice?: string
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export const COLD_RESUME_CONFIRMATION_MIN_COLUMNS = 60
export const COLD_RESUME_CONFIRMATION_MIN_ROWS = 7

export function coldResumeConfirmationFits(viewport: TerminalViewport): boolean {
  return dimension(viewport.columns) >= COLD_RESUME_CONFIRMATION_MIN_COLUMNS
    && dimension(viewport.rows) >= COLD_RESUME_CONFIRMATION_MIN_ROWS
}

function dimension(value: number): number {
  return Math.max(1, Math.floor(value))
}

function blockText(block: unknown): string {
  const candidate = Object(block) as { readonly type?: unknown; readonly text?: unknown }
  if (typeof candidate.text === 'string') return candidate.text
  if (typeof candidate.type === 'string') return '[' + candidate.type + ']'
  return '[content]'
}

function messageText(content: readonly unknown[]): string {
  return content.map(blockText).join(' ')
}

function chunkText(chunk: unknown): string {
  const candidate = Object(chunk) as { readonly text?: unknown }
  return typeof candidate.text === 'string' ? candidate.text : ''
}

function safeText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '�')
}

function wrap(text: string, columns: number): string[] {
  return wrapTextWithAnsi(safeText(text), columns).map(stripTerminalSequences)
}

interface FrameBlock {
  readonly label: string
  readonly plain: readonly string[]
  readonly content: readonly string[]
  readonly lines: readonly string[]
  readonly compact: string
}

function boundedCard(
  label: string,
  content: readonly string[],
  columns: number,
): FrameBlock {
  const normalizedLabel = inlineText(label)
  const innerColumns = Math.max(1, columns - 4)
  const plainContent = content.flatMap(line => wrap(line, columns))
  const normalizedPlain = plainContent.length === 0 ? [''] : plainContent
  const wrappedContent = normalizedPlain.flatMap(line => wrap(line, innerColumns))
  let normalizedContent = wrappedContent
  /* v8 ignore next -- normalizedPlain is non-empty and pi-tui wraps every input to at least one line. */
  if (normalizedContent.length === 0) normalizedContent = ['']
  const salient = normalizedContent.find(line => (
    line.includes('Approval:') || line.includes('Question:')
  )) ?? normalizedContent.at(-1)!
  const compact = fitLine(`${normalizedLabel} | ${salient}`, columns)
  const topPrefix = `+-- ${normalizedLabel} `

  if (columns < visibleWidth(topPrefix) + 1) {
    const lines = wrap(`${normalizedLabel} | ${normalizedContent.join(' ')}`, columns)
    return {
      label: normalizedLabel,
      plain: normalizedPlain,
      content: normalizedContent,
      lines,
      compact,
    }
  }

  const top = topPrefix
    + '-'.repeat(Math.max(0, columns - visibleWidth(topPrefix) - 1))
    + '+'
  const bottom = '+' + '-'.repeat(columns - 2) + '+'
  const body = normalizedContent.map(line => {
    const visible = truncateToWidth(line, innerColumns, '')
    const padding = ' '.repeat(Math.max(0, innerColumns - visibleWidth(visible)))
    return `| ${visible}${padding} |`
  })
  return {
    label: normalizedLabel,
    plain: normalizedPlain,
    content: normalizedContent,
    lines: [top, ...body, bottom],
    compact,
  }
}

const genericToolCards = new ToolCardRendererRegistry()

function transcriptLines(
  row: TranscriptRow,
  columns: number,
  toolCards = genericToolCards,
): string[] {
  switch (row.kind) {
    case 'user':
      return wrap('You: ' + messageText(row.message.content), columns)
    case 'assistant':
      return wrap('Assistant: ' + messageText(row.message.content), columns)
    case 'assistant-draft': {
      const text = row.chunks.map(item => chunkText(item.chunk)).join('')
      return wrap('Assistant: ' + text, columns)
    }
    case 'tool': {
      const status = row.error !== undefined
        ? 'failed'
        : row.resultSeq !== undefined ? 'done' : 'running'
      const phase = row.resultSeq === undefined ? 'call' : 'result'
      const presentation = phase === 'call'
        ? row.callPresentation
        : row.resultPresentation ?? (row.callPresentation === undefined
          ? undefined
          : {
              phase: 'result' as const,
              card: 'generic' as const,
              title: row.callPresentation.title,
            })
      return [...toolCards.renderSafe({
        phase,
        toolName: row.name ?? row.callId,
        status,
        width: columns,
        ...(row.arguments === undefined ? {} : { arguments: row.arguments }),
        ...(row.result === undefined
          ? {}
          : { result: messageText(row.result.content) || '[empty]' }),
        ...(row.error === undefined
          ? {}
          : { error: `${row.error.code}: ${row.error.name}` }),
        ...(presentation === undefined ? {} : { presentation }),
      })]
    }
    case 'command': {
      const identity = row.name === undefined ? row.commandId : '/' + row.name
      const diagnostics = row.protocolDiagnostics === undefined
        ? ''
        : row.protocolDiagnostics.doneWithoutRun === true
          ? ' · orphan done'
          : row.protocolDiagnostics.duplicateRun === true
            ? ' · duplicate run'
            : row.protocolDiagnostics.duplicateDone === true
              ? ' · duplicate done'
              : ''
      const text = row.text === undefined ? '' : ' · ' + row.text
      return wrap(`Command ${identity} · ${row.status}${diagnostics}${text}`, columns)
    }
  }
}

function transcriptBlock(
  row: TranscriptRow,
  columns: number,
  toolCards?: ToolCardRendererRegistry,
): FrameBlock {
  const label = row.kind === 'user'
    ? 'YOU'
    : row.kind === 'assistant' || row.kind === 'assistant-draft'
      ? 'DSH'
      : row.kind === 'tool'
        ? 'TOOL'
        : 'CMD'
  const contentColumns = row.kind === 'tool' ? Math.max(1, columns - 4) : columns
  const content = [...transcriptLines(row, contentColumns, toolCards)]
  return boundedCard(label, content, columns)
}

function commandMenuLines(menu: CommandMenuView, columns: number): string[] {
  if (menu.candidates.length === 0) {
    return wrap(`No commands match /${menu.query}`, columns)
  }
  const lines: string[] = []
  for (const [index, candidate] of menu.candidates.entries()) {
    const command = candidate.command
    const marker = index === menu.selectedIndex ? '› ' : '  '
    const hint = command.input === undefined ? '' : ' ' + command.input.hint
    const origin = candidate.origin === 'official' ? '[DSH/official]' : '[DSH-TUI/local]'
    lines.push(...wrap(
      `${marker}/${command.name}${hint} — ${command.description} ${origin}`,
      columns,
    ))
  }
  if (menu.totalCount > menu.candidates.length) {
    lines.push(...wrap(`  … ${menu.totalCount - menu.candidates.length} more`, columns))
  }
  return lines
}

function interactionLines(
  item: PendingInteraction,
  columns: number,
  input: DshTuiInputMode,
): string[] {
  if (item.kind === 'approval') {
    const reason = item.reason === undefined ? '' : ' · ' + item.reason
    const lines = input.kind === 'approval' && input.interactionId === item.id
      ? wrap('Answering approval', columns)
      : []
    lines.push(...wrap('Approval: ' + item.toolName + reason, columns))
    return lines
  }

  const lines: string[] = []
  if (input.kind === 'question' && input.interactionId === item.id) {
    const total = Math.max(1, item.questions.length)
    const current = Math.min(input.questionIndex + 1, Math.max(1, total))
    lines.push(...wrap(`Answering question ${current}/${total}`, columns))
  }
  for (const question of item.questions) {
    lines.push(...wrap((question.header ?? 'Question') + ': ' + question.question, columns))
    if (question.detail !== undefined) lines.push(...wrap('  ' + question.detail, columns))
    for (const [index, option] of (question.options ?? []).entries()) {
      const description = option.description === undefined ? '' : ' — ' + option.description
      lines.push(...wrap(String(index + 1) + '. ' + option.label + description, columns))
    }
  }
  return lines
}

function interactionBlock(
  item: PendingInteraction,
  columns: number,
  input: DshTuiInputMode,
  focused: boolean,
): FrameBlock {
  return boundedCard(
    focused ? 'FOCUS' : 'QUEUE',
    interactionLines(item, columns, input),
    columns,
  )
}

function denseTimelineBlock(blocks: readonly FrameBlock[], columns: number): FrameBlock {
  const content = blocks.flatMap(block => block.content.map((line, index) => (
    `${index === 0 ? block.label : ' '.repeat(block.label.length)} | ${line}`
  )))
  return boundedCard('TIMELINE', content, columns)
}

function visibleTimelineLines(
  blocks: readonly FrameBlock[],
  slots: number,
  columns: number,
): string[] {
  if (slots <= 0 || blocks.length === 0) return []
  const full = blocks.flatMap(block => block.lines)
  if (full.length <= slots) return full

  if (columns < 40) {
    const labelled = blocks.flatMap(block => [
      fitLine(`+-- ${block.label}`, columns),
      ...block.plain,
    ])
    labelled.push(fitLine('+' + '-'.repeat(Math.max(0, columns - 1)), columns))
    return labelled.slice(-slots)
  }

  const dense = denseTimelineBlock(blocks, columns)
  if (dense.lines.length <= slots) return [...dense.lines]

  const selected: FrameBlock[] = []
  let remaining = slots
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!
    if (block.lines.length > remaining) continue
    selected.unshift(block)
    remaining -= block.lines.length
  }
  if (selected.length > 0) return selected.flatMap(block => block.lines)
  return [blocks.at(-1)!.compact]
}

function bodyLayoutLines(
  timeline: readonly FrameBlock[],
  focus: FrameBlock | undefined,
  slots: number,
  columns: number,
): string[] {
  if (slots <= 0) return []
  const fullTimeline = timeline.flatMap(block => block.lines)
  const fullFocus = focus === undefined ? [] : [...focus.lines]
  let content: string[]

  if (fullTimeline.length + fullFocus.length <= slots) {
    content = [...fullTimeline, ...fullFocus]
  } else if (focus === undefined) {
    content = visibleTimelineLines(timeline, slots, columns)
  } else {
    const visibleFocus = focus.lines.length <= slots
      ? [...focus.lines]
      : [focus.compact]
    const timelineSlots = Math.max(0, slots - visibleFocus.length)
    content = [
      ...visibleTimelineLines(timeline, timelineSlots, columns),
      ...visibleFocus,
    ]
  }

  return [
    ...Array.from({ length: Math.max(0, slots - content.length) }, () => ''),
    ...content,
  ]
}

function centeredBodyLines(content: readonly string[], slots: number): string[] {
  if (slots <= 0) return []
  const visible = content.slice(0, slots)
  const spare = slots - visible.length
  const before = Math.floor(spare / 2)
  return [
    ...Array.from({ length: before }, () => ''),
    ...visible,
    ...Array.from({ length: spare - before }, () => ''),
  ]
}

function promptProjection(
  prompt: PromptEditorState,
  columns: number,
  requestedPrefix = '> ',
): { readonly line: string; readonly column: number } {
  const graphemes = Array.from(graphemeSegmenter.segment(prompt.text), part => part.segment)
  const before = safeText(graphemes.slice(0, prompt.cursor).join('')).replaceAll('\n', '↵')
  const full = safeText(prompt.text).replaceAll('\n', '↵')
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

function fitLine(text: string, columns: number): string {
  return stripTerminalSequences(
    truncateToWidth(safeText(text).replace(/[\r\n]/gu, ''), columns, ''),
  )
}

function inlineText(text: string): string {
  return safeText(text).replaceAll('\n', '↵')
}

function startupPresetRowLine(
  row: StartupPresetPickerRow,
  selected: boolean,
): string {
  const marker = selected ? '› ' : '  '
  return [
    marker + inlineText(row.name ?? row.id),
    'id:' + inlineText(row.id),
    row.trust,
    row.isDefault ? 'default' : undefined,
    row.broken === undefined ? undefined : 'broken:' + inlineText(row.broken),
  ].filter((item): item is string => item !== undefined).join(' · ')
}

function normalizedStartupPresetSelection(view: StartupPresetPickerView): number {
  if (view.selectedIndex < 0 || view.selectedIndex >= view.rows.length) return -1
  return view.selectedIndex
}

function startupPresetRows(
  view: StartupPresetPickerView,
  slots: number,
): string[] {
  const selectedIndex = normalizedStartupPresetSelection(view)
  const count = Math.min(slots, view.rows.length)
  const maxStart = view.rows.length - count
  const start = selectedIndex < 0
    ? 0
    : Math.min(maxStart, Math.max(0, selectedIndex - count + 1))
  return view.rows.slice(start, start + count).map((row, index) => (
    startupPresetRowLine(row, selectedIndex >= 0 && start + index === selectedIndex)
  ))
}

function startupPresetStatusLines(panel: StartupPresetPanel): string[] {
  const lines: string[] = []
  if (panel.loading) lines.push('Loading agent presets…')
  if (panel.error !== undefined) lines.push('Error: ' + inlineText(panel.error))
  if (panel.notice !== undefined) lines.push('Notice: ' + inlineText(panel.notice))
  if (panel.view?.defaultMissing === true) {
    lines.push('Default preset missing: ' + inlineText(panel.view.defaultId))
  }
  if (!panel.loaded || panel.view === undefined) {
    lines.push('Agent preset roster not loaded')
  }
  if (panel.loaded && !panel.loading
    && panel.view !== undefined && panel.view.rows.length === 0) {
    lines.push('No agent presets found')
  }
  return lines
}

function startupPresetDetailLines(view: StartupPresetPickerView): string[] {
  const selectedIndex = normalizedStartupPresetSelection(view)
  if (selectedIndex < 0) return []
  const selected = view.rows[selectedIndex]!
  const lines: string[] = []
  if (selected.description !== undefined) {
    lines.push('Description: ' + inlineText(selected.description))
  }
  if (selected.trust === 'user') {
    lines.push('Warning: user composition has the same trust as shell access.')
  }
  if (selected.broken !== undefined) {
    lines.push('Enter blocked: ' + inlineText(selected.broken))
  }
  return lines
}

function startupPresetFooter(view: StartupPresetPickerView | undefined): string {
  const range = view === undefined
    ? 'not-loaded'
    : view.rows.length === 0
    ? `0/${view.totalCount}`
    : `${view.offset + 1}-${view.offset + view.rows.length}/${view.totalCount}`
  return `Presets ${range} · Up/Down select · R refresh · Enter select · Esc cancel`
}

export function renderStartupPresetFrame(
  panel: StartupPresetPanel,
  viewport: TerminalViewport,
): UiFrame {
  const columns = dimension(viewport.columns)
  const rows = dimension(viewport.rows)
  const normalizedViewport = { columns, rows }
  const header = fitLine('Startup AgentPreset · [DSH-TUI/local]', columns)
  if (rows === 1) {
    return {
      title: 'DSH-TUI',
      viewport: normalizedViewport,
      lines: [header],
    }
  }

  const statuses = startupPresetStatusLines(panel)
  const selectedIndex = panel.view === undefined
    ? -1
    : normalizedStartupPresetSelection(panel.view)
  const selected = panel.view === undefined || selectedIndex < 0
    ? undefined
    : startupPresetRowLine(panel.view.rows[selectedIndex]!, true)
  if (rows === 2) {
    return {
      title: 'DSH-TUI',
      viewport: normalizedViewport,
      lines: [
        header,
        fitLine(selected ?? statuses[0] ?? startupPresetFooter(panel.view), columns),
      ],
    }
  }

  const bodySlots = rows - 2
  let body: string[]
  if (panel.view === undefined || panel.view.rows.length === 0) {
    body = statuses.slice(0, bodySlots)
  } else {
    const visibleStatuses = statuses.slice(0, Math.max(0, bodySlots - 1))
    const remaining = bodySlots - visibleStatuses.length
    const details = startupPresetDetailLines(panel.view)
    const visibleDetails = details.slice(0, Math.max(0, remaining - 1))
    const visibleRows = startupPresetRows(
      panel.view,
      remaining - visibleDetails.length,
    )
    body = [...visibleStatuses, ...visibleRows, ...visibleDetails]
  }
  const padding = Array.from({ length: bodySlots - body.length }, () => '')
  return {
    title: 'DSH-TUI',
    viewport: normalizedViewport,
    lines: [
      header,
      ...padding,
      ...body.map(line => fitLine(line, columns)),
      fitLine(startupPresetFooter(panel.view), columns),
    ],
  }
}

function sessionPickerRowLine(
  row: SessionPickerRow,
  selected: boolean,
): string {
  const marker = selected ? '› ' : '  '
  const liveStatus = row.liveStatus ?? (row.attached ? 'attached' : 'none')
  const ownership = row.isSubagent
    ? 'subagent:' + inlineText(row.parentSessionId ?? 'unknown-parent')
    : 'root'
  const metadata = [
    row.cwd === undefined ? undefined : 'cwd:' + inlineText(row.cwd),
    row.creationAgentPreset === undefined
      ? undefined
      : 'preset:' + inlineText(row.creationAgentPreset),
    'created:' + row.createdAt,
  ].filter((item): item is string => item !== undefined)
  return [
    marker + inlineText(row.sessionId),
    row.relation,
    'live:' + liveStatus,
    'durable:' + row.durablePresence,
    ownership,
    ...metadata,
  ].join(' · ')
}

function sessionPickerStatusLines(panel: SessionPickerPanel): string[] {
  const lines: string[] = []
  if (panel.loading) lines.push('Loading sessions…')
  if (panel.error !== undefined) lines.push('Error: ' + inlineText(panel.error))
  if (panel.view.durability === 'unavailable') {
    lines.push('Live sessions only · durable storage unavailable')
  }
  if (!panel.loaded && !panel.loading) lines.push('Session catalog not loaded')
  if (panel.notice !== undefined) lines.push('Notice: ' + inlineText(panel.notice))
  if (panel.loaded && !panel.loading && panel.view.rows.length === 0) {
    lines.push('No sessions found')
  }
  return lines
}

function normalizedPickerSelection(view: SessionPickerView): number {
  return Math.min(view.rows.length - 1, Math.max(0, view.selectedIndex))
}

function sessionPickerRows(
  view: SessionPickerView,
  slots: number,
): string[] {
  if (slots <= 0 || view.rows.length === 0) return []
  const selectedIndex = normalizedPickerSelection(view)
  const count = Math.min(slots, view.rows.length)
  const maxStart = view.rows.length - count
  const start = Math.min(maxStart, Math.max(0, selectedIndex - count + 1))
  return view.rows.slice(start, start + count).map((row, index) => (
    sessionPickerRowLine(row, start + index === selectedIndex)
  ))
}

function sessionPickerFooter(
  view: SessionPickerView,
  liveActivation: boolean,
  inspection: boolean,
): string {
  const range = view.rows.length === 0
    ? '0/0'
    : `${view.offset + 1}-${view.offset + view.rows.length}/${view.totalCount}`
  const enter = liveActivation
    ? inspection ? 'Enter switch/inspect' : 'Enter switch/explain'
    : inspection ? 'Enter inspect/explain' : 'Enter explain/read-only'
  return `Sessions ${range} · Up/Down select · ${enter} · R refresh · Esc close`
}

function renderSessionPickerFrame(
  panel: SessionPickerPanel,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const liveActivation = panel.liveActivation === true
  const inspection = panel.inspection === true
  const mode = liveActivation
    ? inspection ? 'browse/live-switch/inspect' : 'browse/live-switch'
    : inspection ? 'browse/inspect' : 'read-only'
  const header = fitLine(`Sessions · [DSH-TUI/local] · ${mode}`, columns)
  if (rows === 1) {
    return { title: 'DSH-TUI', viewport, lines: [header] }
  }

  const selected = sessionPickerRows(panel.view, 1)[0]
  if (rows === 2) {
    const second = selected ?? sessionPickerStatusLines(panel)[0]!
    return {
      title: 'DSH-TUI',
      viewport,
      lines: [header, fitLine(second, columns)],
    }
  }

  const bodySlots = rows - 2
  const statuses = sessionPickerStatusLines(panel)
  const hasRows = panel.view.rows.length > 0
  const statusLimit = hasRows ? Math.max(0, bodySlots - 1) : bodySlots
  const visibleStatuses = statuses.slice(0, statusLimit)
  const visibleRows = sessionPickerRows(panel.view, bodySlots - visibleStatuses.length)
  const body = [...visibleStatuses, ...visibleRows]
  const padding = Array.from({ length: bodySlots - body.length }, () => '')
  return {
    title: 'DSH-TUI',
    viewport,
    lines: [
      header,
      ...padding,
      ...body.map(line => fitLine(line, columns)),
      fitLine(sessionPickerFooter(panel.view, liveActivation, inspection), columns),
    ],
  }
}

function inspectionMetadata(header: SessionInspectionHeader): string {
  const ownership = header.isSubagent
    ? 'subagent:' + inlineText(header.parentSessionId ?? 'unknown-parent')
    : 'root'
  return [
    ownership,
    'created:' + header.createdAt,
    header.cwd === undefined ? undefined : 'cwd:' + inlineText(header.cwd),
    header.creationAgentPreset === undefined
      ? undefined
      : 'preset:' + inlineText(header.creationAgentPreset),
    header.seedLength === undefined ? undefined : 'seed:' + header.seedLength,
    header.delegationDepth === undefined ? undefined : 'depth:' + header.delegationDepth,
  ].filter((item): item is string => item !== undefined).join(' · ')
}

function inspectionObservation(
  observation: SessionInspectionCatalogObservation,
): string {
  if (observation.kind === 'missing') return 'Latest catalog observation: missing'
  return [
    'Latest catalog observation: ' + observation.relation,
    'durable:' + observation.durablePresence,
    observation.liveStatus === undefined ? undefined : 'live:' + observation.liveStatus,
  ].filter((item): item is string => item !== undefined).join(' · ')
}

function inspectionTranscriptLines(
  panel: Extract<SessionInspectionPanel, { kind: 'ready' }>,
  columns: number,
): string[] {
  const session = panel.projection.sessions[panel.sessionId]
  if (session === undefined) return []
  return session.rows.flatMap(row => transcriptLines(row, columns))
}

interface SessionInspectionReadyLayout {
  readonly visibleFixed: readonly string[]
  readonly transcript: readonly string[]
  readonly transcriptSlots: number
  readonly maxOffset: number
}

function inspectionReadyLayout(
  panel: Extract<SessionInspectionPanel, { kind: 'ready' }>,
  columns: number,
  slots: number,
): SessionInspectionReadyLayout {
  const session = panel.projection.sessions[panel.sessionId]
  const fixed = [
    'Logical read-only snapshot · Storage unchanged',
    'Snapshot may include in-memory interruption closers; durable storage was not repaired.',
    session?.omittedRowCount === undefined
      ? undefined
      : `… ${session.omittedRowCount} earlier projected rows omitted`,
    inspectionObservation(panel.observation),
    inspectionMetadata(panel.header),
    panel.refreshing ? 'Refreshing inspection…' : undefined,
    panel.error === undefined ? undefined : 'Error: ' + inlineText(panel.error),
    panel.notice === undefined ? undefined : 'Notice: ' + inlineText(panel.notice),
  ].filter((line): line is string => line !== undefined)
  const transcript = inspectionTranscriptLines(panel, columns)
  const fixedLimit = Math.max(0, slots - (transcript.length === 0 ? 0 : 1))
  const visibleFixed = fixed.slice(0, fixedLimit)
  const transcriptSlots = slots - visibleFixed.length
  const maxOffset = Math.max(0, transcript.length - transcriptSlots)
  return { visibleFixed, transcript, transcriptSlots, maxOffset }
}

export function sessionInspectionMaxScrollOffset(
  panel: Extract<SessionInspectionPanel, { kind: 'ready' }>,
  viewport: TerminalViewport,
): number {
  const rows = dimension(viewport.rows)
  if (rows <= 2) return 0
  return inspectionReadyLayout(
    panel,
    dimension(viewport.columns),
    rows - 2,
  ).maxOffset
}

function inspectionReadyBody(
  panel: Extract<SessionInspectionPanel, { kind: 'ready' }>,
  columns: number,
  slots: number,
): string[] {
  const layout = inspectionReadyLayout(panel, columns, slots)
  if (layout.transcript.length === 0) return [...layout.visibleFixed]
  const offset = Math.min(
    layout.maxOffset,
    Math.max(0, Math.floor(panel.scrollOffset)),
  )
  const start = Math.max(
    0,
    layout.transcript.length - layout.transcriptSlots - offset,
  )
  return [
    ...layout.visibleFixed,
    ...layout.transcript.slice(start, start + layout.transcriptSlots),
  ]
}

function renderSessionInspectionFrame(
  panel: SessionInspectionPanel,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const confirmationFits = coldResumeConfirmationFits(viewport)
  const status = panel.kind === 'ready'
    ? panel.refreshing
      ? 'immutable snapshot · refreshing'
      : panel.error === undefined
        ? panel.notice === undefined
          ? 'immutable snapshot'
          : 'immutable snapshot · action blocked'
        : 'immutable snapshot · refresh failed'
    : panel.kind === 'confirm-resume'
      ? confirmationFits
        ? 'resume confirmation'
        : 'resume confirmation · resize required'
      : panel.kind
  const header = fitLine(
    `Session inspection · ${status} · ${inlineText(panel.sessionId)}`,
    columns,
  )
  if (rows === 1) return { title: 'DSH-TUI', viewport, lines: [header] }

  const footer = panel.kind === 'loading'
    ? 'Esc cancel'
    : panel.kind === 'error'
      ? 'r retry · Esc back'
      : panel.kind === 'confirm-resume'
        ? confirmationFits
          ? 'Enter resume · Esc back'
          : `Resize to at least ${COLD_RESUME_CONFIRMATION_MIN_COLUMNS}x${COLD_RESUME_CONFIRMATION_MIN_ROWS} · Esc back`
      : panel.refreshing
        ? 'Up/Down scroll · Esc back · Refreshing'
        : panel.notice !== undefined
          ? `Notice: ${inlineText(panel.notice)} · r refresh · Esc back`
        : panel.error === undefined
          ? panel.canResumeCold === true
            ? 'a resume · Up/Down scroll · r refresh · Esc back'
            : 'Up/Down scroll · r refresh · Esc back'
          : `Up/Down scroll · r retry · Esc back · Refresh failed: ${inlineText(panel.error)}`
  if (rows === 2) {
    return {
      title: 'DSH-TUI',
      viewport,
      lines: [header, fitLine(footer, columns)],
    }
  }

  const bodySlots = rows - 2
  const body = panel.kind === 'loading'
    ? [
        `Inspecting ${inlineText(panel.sessionId)}…`,
        'logical read-only view · Storage unchanged',
      ].slice(0, bodySlots)
    : panel.kind === 'error'
      ? [
          'Inspect failed: ' + inlineText(panel.message),
          'logical read-only view · Storage unchanged',
        ].slice(0, bodySlots)
      : panel.kind === 'confirm-resume'
        ? [
            'Cold resume confirmation',
            `Exact target: ${inlineText(panel.sessionId)}`,
            'Resume may repair or append durable storage.',
            'It may create and publish an Agent before this TUI switches views.',
            'No resume has started yet.',
            inspectionObservation(panel.observation),
            inspectionMetadata(panel.header),
          ].slice(0, bodySlots)
      : inspectionReadyBody(panel, columns, bodySlots)
  const padding = Array.from({ length: bodySlots - body.length }, () => '')
  return {
    title: 'DSH-TUI',
    viewport,
    lines: [
      header,
      ...body.map(line => fitLine(line, columns)),
      ...padding,
      fitLine(footer, columns),
    ],
  }
}

function inputPrefix(input: DshTuiInputMode): string {
  switch (input.kind) {
    case 'prompt': return '> '
    case 'approval': return 'allow? '
    case 'question': return 'answer> '
  }
}

function questionProgress(
  input: Extract<DshTuiInputMode, { kind: 'question' }>,
  interaction: InteractionSnapshot | undefined,
): string {
  const pending = interaction?.pending.find(item => (
    item.kind === 'question' && item.id === input.interactionId
  ))
  const total = pending?.kind === 'question'
    ? Math.max(1, pending.questions.length)
    : Math.max(input.questionIndex + 1, input.answerCount + 1)
  const current = Math.min(input.questionIndex + 1, Math.max(1, total))
  return `${current}/${total}`
}

function inputFooter(
  input: DshTuiInputMode,
  interaction: InteractionSnapshot | undefined,
  commandMenu: CommandMenuView | undefined,
  commandNotice: string | undefined,
  commandPending: boolean,
): string {
  if (input.kind === 'prompt') {
    const instruction = commandMenu !== undefined
      ? 'Up/Down select · Tab complete · Enter use · Esc close'
      : commandPending
        ? 'Command running · Ctrl+C cancel'
        : 'Ctrl+C cancel · Enter send · Shift+Enter newline'
    return commandNotice === undefined
      ? instruction
      : 'Notice: ' + commandNotice + ' · ' + instruction
  }
  const instruction = input.kind === 'approval'
    ? 'Approval: y/yes/1 allow · n/no/2 reject · Esc reject'
    : `Question ${questionProgress(input, interaction)}: Enter answer · Esc cancel`
  return input.error === undefined ? instruction : 'Error: ' + input.error + ' · ' + instruction
}

export function renderDshFrame(view: DshTuiView, viewport: TerminalViewport): UiFrame {
  const columns = dimension(viewport.columns)
  const rows = dimension(viewport.rows)
  const normalizedViewport = { columns, rows }
  if (view.sessionInspection !== undefined) {
    return renderSessionInspectionFrame(view.sessionInspection, normalizedViewport)
  }
  if (view.sessionPicker !== undefined) {
    return renderSessionPickerFrame(view.sessionPicker, normalizedViewport)
  }
  const sessionId = view.ui.activeSessionId
  const session = sessionId === undefined ? undefined : view.ui.sessions[sessionId]
  const identity = sessionId ?? 'no-session'
  const status = session?.agentStatus ?? view.ui.phase
  const header = fitLine('DSH-TUI · ' + identity + ' · ' + status, columns)
  const input: DshTuiInputMode = view.input ?? { kind: 'prompt', editor: view.prompt }

  if (rows === 1) {
    return { title: 'DSH-TUI', viewport: normalizedViewport, lines: [header] }
  }

  const prompt = promptProjection(input.editor, columns, inputPrefix(input))
  if (rows === 2) {
    return {
      title: 'DSH-TUI',
      viewport: normalizedViewport,
      lines: [header, fitLine(prompt.line, columns)],
      cursor: { row: 1, column: prompt.column },
    }
  }

  const timeline: FrameBlock[] = []
  if (session !== undefined) {
    for (const row of session.rows) {
      timeline.push(transcriptBlock(row, columns, view.toolCards))
    }
  }
  const pending = view.interaction?.pending ?? []
  const activeInteractionId = input.kind === 'prompt' ? undefined : input.interactionId
  const focusedIndex = activeInteractionId === undefined
    ? pending.length - 1
    : pending.findIndex(item => item.id === activeInteractionId)
  let focus: FrameBlock | undefined
  for (const [index, item] of pending.entries()) {
    if (index === focusedIndex) {
      focus = interactionBlock(item, columns, input, true)
    } else {
      timeline.push(interactionBlock(item, columns, input, false))
    }
  }
  if (view.commandMenu !== undefined) {
    if (focus !== undefined) timeline.push(focus)
    focus = boundedCard('CMD', commandMenuLines(view.commandMenu, columns), columns)
  }
  const bodySlots = rows - 3
  const emptySession = session !== undefined
    && session.rows.length === 0
    && timeline.length === 0
    && focus === undefined
  const visibleBody = emptySession
    ? centeredBodyLines(cordisBrandLines(normalizedViewport), bodySlots)
    : bodyLayoutLines(timeline, focus, bodySlots, columns)
  const footer = fitLine(inputFooter(
    input,
    view.interaction,
    view.commandMenu,
    view.commandNotice,
    view.commandPending === true,
  ), columns)
  const lines = [
    header,
    ...visibleBody,
    fitLine(prompt.line, columns),
    footer,
  ].map(line => fitLine(line, columns))
  return {
    title: 'DSH-TUI',
    viewport: normalizedViewport,
    lines,
    cursor: { row: rows - 2, column: prompt.column },
  }
}
