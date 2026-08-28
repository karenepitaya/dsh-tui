import {
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { InteractionSnapshot, PendingInteraction } from '../interaction/port.ts'
import type { DshTuiInputMode } from '../interaction/editor.ts'
import { planReviewChoices, planReviewOf } from '../interaction/plan-review.ts'
import { COMMAND_MENU_LIMIT, type CommandMenuView } from '../command/menu.ts'
import type { SessionPickerRow, SessionPickerView } from '../session/picker.ts'
import type { SessionModelSnapshot } from '../model/port.ts'
import type {
  ModelPickerEffortRow,
  ModelPickerModelRow,
  ModelPickerView,
} from '../model/picker.ts'
import type { ModePickerRow, ModePickerView } from '../mode/picker.ts'
import type { SkillPickerView } from '../skill/picker.ts'
import type { ProviderConnectView } from '../provider/connect-controller.ts'
import type { SessionContextSnapshot, SessionTokenUsage } from '../context/port.ts'
import type {
  SessionWorkbenchGoalPhase,
  SessionWorkbenchPlan,
  SessionWorkbenchSnapshot,
  SessionWorkbenchTodo,
} from '../workbench/port.ts'
import type { GoalActionSurfaceView } from '../workbench/goal-actions.ts'
import type {
  SessionJob,
  SessionJobStatus,
  SessionJobsSnapshot,
} from '../activity/port.ts'
import type { JobsActivityView } from '../activity/jobs-activity.ts'
import type {
  ActivityCenterRow,
  ActivityCenterView,
} from '../activity/center.ts'
import type {
  StartupPresetPickerRow,
  StartupPresetPickerView,
} from '../preset/picker.ts'
import type { SessionDurablePresence } from '../session/catalog-port.ts'
import type { SessionInspectionHeader } from '../session/inspection-port.ts'
import type {
  SessionCompactionState,
  TranscriptRow,
  UiState,
} from '../transcript/state.ts'
import { ToolCardRendererRegistry } from '../presentation/tool-card-renderers.ts'
import type { ToolPresentationView } from '../presentation/types.ts'
import {
  projectUiAssistantChunks,
  projectUiMessageContent,
} from '../presentation/message-content.ts'
import type { PromptEditorState } from './prompt-editor.ts'
import type { DshTuiSemanticRole } from './theme.ts'
import {
  secondarySurfaceGeometry,
  type SecondaryOverlayLayout,
  type SecondarySurfaceKind,
} from './secondary-surface.ts'
import { cordisBrandLines } from './brand.ts'
import { styleToolCardLines } from './tool-card-styling.ts'
import {
  layoutConversationComposer,
  layoutConversationDashboard,
  type ConversationDashboard,
  type ConversationDashboardLine,
  type ConversationCardNode,
  type ConversationDock,
  type ConversationNode,
  type ConversationStatusLine,
  type ConversationStatusSegment,
  type ConversationSurface,
} from './conversation.ts'

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
  /** Trusted product-owned line styling; frame text itself remains control-sequence free. */
  readonly lineStyles?: readonly (UiFrameLineStyle | undefined)[]
  readonly cursor?: UiCursor
  /** Fixed-size floating secondary surface; the retained conversation stays underneath. */
  readonly overlay?: SecondaryOverlayLayout
  /** Structured main surface consumed by the retained pi-tui layout. */
  readonly conversation?: ConversationSurface
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
  readonly model?: SessionModelSnapshot
  readonly modelPicker?: ModelPickerView
  readonly modePicker?: ModePickerView
  readonly skillPicker?: SkillPickerView
  readonly modeNotice?: string
  readonly providerConnect?: ProviderConnectView
  readonly context?: SessionContextSnapshot
  readonly workbench?: SessionWorkbenchSnapshot
  readonly goalActions?: GoalActionSurfaceView
  readonly jobs?: SessionJobsSnapshot
  readonly jobsActivity?: JobsActivityView
  readonly activityCenter?: ActivityCenterView
  readonly contextPanel?: boolean
  readonly bindingEpoch?: number
  readonly reasoningExpanded?: boolean
  readonly toolDetailsExpanded?: boolean
  readonly followRequest?: number
  /** Internal effect-owned rich renderer set; absent means generic fallback. */
  readonly toolCards?: ToolCardRendererRegistry
}

type DshTuiFrameInputMode = DshTuiInputMode | {
  readonly kind: 'goal-action'
  readonly editor: PromptEditorState
  readonly stage: GoalActionSurfaceView['stage']
  readonly error?: string
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

function messageText(content: Parameters<typeof projectUiMessageContent>[0]): string {
  const projection = projectUiMessageContent(content)
  const supplements = [
    ...projection.images.map(image => (
      `[image ${image.attachment.mediaType} ${image.attachment.width}x${image.attachment.height}]`
    )),
    ...projection.unsupported.map(block => `[unsupported:${block.sourceType}]`),
  ]
  return [projection.text, ...supplements].filter(Boolean).join('\n')
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

export interface UiFrameLineStyle {
  readonly tone: DshTuiSemanticRole
  readonly bold?: boolean
  readonly dim?: boolean
  /** Reverse foreground/background for an unambiguous selected row. */
  readonly inverse?: boolean
  /** Extend the style through the complete allocated row. */
  readonly fill?: boolean
}

function boundedCard(
  label: string,
  content: readonly string[],
  columns: number,
): FrameBlock {
  const normalizedLabel = inlineText(label)
  const innerColumns = Math.max(1, columns - 4)
  const plainContent = content.flatMap(line => wrap(line, columns))
  /* v8 ignore next -- every card producer supplies at least one semantic line. */
  const normalizedPlain = plainContent.length === 0 ? [''] : plainContent
  const wrappedContent = normalizedPlain.flatMap(line => wrap(line, innerColumns))
  let normalizedContent = wrappedContent
  /* v8 ignore next -- normalizedPlain is non-empty and pi-tui wraps every input to at least one line. */
  if (normalizedContent.length === 0) normalizedContent = ['']
  const salient = normalizedContent.find(line => (
    line.includes('Approval:') || line.includes('Question:')
  )) ?? normalizedContent.at(-1)!
  const compact = fitLine(`${normalizedLabel} · ${salient}`, columns)
  const topPrefix = `╭─ ${normalizedLabel} `

  if (columns < visibleWidth(topPrefix) + 1) {
    const lines = wrap(`${normalizedLabel} · ${normalizedContent.join(' ')}`, columns)
    return {
      label: normalizedLabel,
      plain: normalizedPlain,
      content: normalizedContent,
      lines,
      compact,
    }
  }

  const top = topPrefix
    + '─'.repeat(Math.max(0, columns - visibleWidth(topPrefix) - 1))
    + '╮'
  const bottom = '╰' + '─'.repeat(columns - 2) + '╯'
  const body = normalizedContent.map(line => {
    const visible = truncateToWidth(line, innerColumns, '')
    const padding = ' '.repeat(Math.max(0, innerColumns - visibleWidth(visible)))
    return `│ ${visible}${padding} │`
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
      const text = projectUiAssistantChunks(row.chunks.map(item => item.chunk)).text
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
      const diagnostics = row.protocolDiagnostics === undefined
        ? ''
        : row.protocolDiagnostics.doneWithoutRun === true
          ? ' · orphan done'
          : row.protocolDiagnostics.duplicateRun === true
            ? ' · duplicate run'
            : row.protocolDiagnostics.duplicateDone === true
              ? ' · duplicate done'
              : ''
      return [
        ...wrap(`Status: ${row.status}${diagnostics}`, columns),
        ...(row.text === undefined ? [] : wrap(row.text, columns)),
      ]
    }
  }
}

function toolActivityPresentation(
  row: Extract<TranscriptRow, { readonly kind: 'tool' }>,
  columns: number,
  toolCards?: ToolCardRendererRegistry,
): {
  readonly label: string
  readonly lines: readonly string[]
  readonly styledLines?: ReturnType<typeof styleToolCardLines>
} {
  const status = row.error !== undefined ? 'failed' : row.resultSeq !== undefined ? 'done' : 'running'
  const rendered = transcriptLines(row, columns, toolCards)
  const suffix = ` · ${status}`
  const rawTitle = rendered[0]!
  const withoutStatus = rawTitle.endsWith(suffix)
    ? rawTitle.slice(0, -suffix.length)
    : rawTitle
  const title = withoutStatus.startsWith('Tool ') ? withoutStatus.slice(5) : withoutStatus
  const activePresentation: ToolPresentationView | undefined = row.resultSeq === undefined
    ? row.callPresentation
    : row.resultPresentation ?? (row.callPresentation === undefined
      ? undefined
      : {
          phase: 'result',
          card: 'generic',
          title: row.callPresentation.title,
        })
  const lines = rendered.slice(1)
  const styledLines = styleToolCardLines(activePresentation, lines)
  return {
    label: `TOOL  ${title}`,
    lines,
    ...(styledLines === undefined ? {} : { styledLines }),
  }
}

function transcriptBlock(
  row: TranscriptRow,
  columns: number,
  toolCards?: ToolCardRendererRegistry,
): FrameBlock {
  if (row.kind === 'tool') {
    const presentation = toolActivityPresentation(row, Math.max(1, columns - 4), toolCards)
    const badge = row.error !== undefined
      ? '× FAILED'
      : row.resultSeq !== undefined ? '✓ DONE' : '● RUNNING'
    return boundedCard(`${presentation.label}  ${badge}`, presentation.lines, columns)
  }
  const label = row.kind === 'user'
    ? 'YOU'
    : row.kind === 'assistant' || row.kind === 'assistant-draft'
      ? 'DSH'
      : `CMD  ${row.name === undefined ? row.commandId : '/' + row.name}`
  const content = [...transcriptLines(row, columns, toolCards)]
  return boundedCard(label, content, columns)
}

function thinkingSummary(
  reasoning: string,
  streaming: boolean,
  reasoningTokens?: number,
): string | undefined {
  if (reasoning === '') return undefined
  const measure = streaming
    ? 'streaming'
    : reasoningTokens !== undefined
      ? `${reasoningTokens} tokens`
      : `${reasoning.split('\n').length} lines`
  return 'THINKING · ' + measure
}

function transcriptConversationNode(
  row: TranscriptRow,
  columns: number,
  toolCards?: ToolCardRendererRegistry,
): ConversationNode | undefined {
  switch (row.kind) {
    case 'user': {
      const text = messageText(row.message.content)
      return {
        kind: 'user',
        key: row.key,
        revision: String(row.seq),
        text: text === '' ? '[Empty user message]' : text,
      }
    }
    case 'assistant': {
      const projection = projectUiMessageContent(row.message.content)
      const supplements = messageText(row.message.content)
      if (supplements === '' && projection.reasoning === '' && !row.interrupted) {
        return undefined
      }
      return {
        kind: 'assistant',
        key: `assistant:${row.turn}:${row.step}`,
        revision: `${row.seq}:${projection.text.length}:${projection.reasoning.length}:${row.interrupted}`,
        text: supplements,
        reasoning: projection.reasoning,
        ...(thinkingSummary(
          projection.reasoning,
          false,
          row.usage?.reasoningTokens,
        ) === undefined
          ? {}
          : {
              reasoningSummary: thinkingSummary(
                projection.reasoning,
                false,
                row.usage?.reasoningTokens,
              )!,
            }),
        ...(row.interrupted ? { interrupted: true } : {}),
      }
    }
    case 'assistant-draft': {
      const projection = projectUiAssistantChunks(row.chunks.map(item => item.chunk))
      if (projection.text === '' && projection.reasoning === '') return undefined
      return {
        kind: 'assistant-draft',
        key: `assistant:${row.turn}:${row.step}`,
        revision: `${row.chunks[row.chunks.length - 1]!.seq}:${projection.text.length}:${projection.reasoning.length}`,
        text: projection.text,
        reasoning: projection.reasoning,
        ...(thinkingSummary(
          projection.reasoning,
          true,
        ) === undefined
          ? {}
          : {
              reasoningSummary: thinkingSummary(
                projection.reasoning,
                true,
              )!,
            }),
        ...(row.omittedChunkCount === undefined
          ? {}
          : { omittedChunkCount: row.omittedChunkCount }),
      }
    }
    case 'tool': {
      const status = row.error !== undefined
        ? 'failed' as const
        : row.resultSeq !== undefined ? 'done' as const : 'running' as const
      const presentation = toolActivityPresentation(
        row,
        Math.max(1, columns - 4),
        toolCards,
      )
      return {
        kind: 'tool',
        key: row.key,
        revision: `${row.callSeq ?? 0}:${row.resultSeq ?? 0}:${status}`,
        label: presentation.label,
        status,
        lines: presentation.lines,
        ...(presentation.styledLines === undefined
          ? {}
          : { styledLines: presentation.styledLines }),
      }
    }
    case 'command': {
      const identity = row.name === undefined ? row.commandId : '/' + row.name
      return {
        kind: 'command',
        key: row.key,
        revision: `${row.runSeq ?? 0}:${row.doneSeq ?? 0}:${row.status}`,
        label: `CMD  ${identity}`,
        status: row.status === 'error' ? 'failed' : row.status === 'success' ? 'done' : 'running',
        lines: transcriptLines(row, Math.max(1, columns - 4), toolCards),
      }
    }
  }
}

interface ProjectedTranscriptNode {
  readonly row: TranscriptRow
  readonly node: ConversationNode
}

function compactToolRun(
  entries: readonly ProjectedTranscriptNode[],
): ConversationCardNode {
  const tools = entries.map(entry => ({
    row: entry.row as Extract<TranscriptRow, { readonly kind: 'tool' }>,
    node: entry.node as ConversationCardNode,
  }))
  const failed = tools.some(entry => entry.node.status === 'failed')
  const running = tools.some(entry => entry.node.status === 'running')
  const visible = tools.slice(0, 7).map(entry => {
    const marker = entry.node.status === 'failed'
      ? '×'
      : entry.node.status === 'running' ? '●' : '✓'
    const detail = entry.node.lines.find(line => (
      line.startsWith('File:') || line.startsWith('At:') || line.startsWith('Cwd:')
    ))
    return `${marker} ${entry.node.label.replace(/^TOOL\s+/u, '')}`
      + (detail === undefined ? '' : ` · ${detail}`)
  })
  if (tools.length > visible.length) visible.push(`… ${tools.length - visible.length} more calls`)
  visible.push('Ctrl+O expands the individual tool cards')
  return {
    kind: 'tool',
    key: `tool-run:${tools[0]!.row.turn}:${tools[0]!.row.step}:${tools.at(-1)!.row.step}`,
    revision: tools.map(entry => entry.node.revision).join('|'),
    label: `TOOL RUN · ${tools.length} CALLS · TURN ${tools[0]!.row.turn}`,
    status: failed ? 'failed' : running ? 'running' : 'done',
    lines: visible,
  }
}

function compactTranscriptTools(
  projected: readonly ProjectedTranscriptNode[],
  expanded: boolean,
): readonly ConversationNode[] {
  if (expanded) return projected.map(entry => entry.node)
  const nodes: ConversationNode[] = []
  for (let index = 0; index < projected.length;) {
    const current = projected[index]!
    if (current.row.kind !== 'tool' || current.node.kind !== 'tool') {
      nodes.push(current.node)
      index += 1
      continue
    }
    let end = index + 1
    while (end < projected.length) {
      const next = projected[end]!
      if (
        next.row.kind !== 'tool'
        || next.node.kind !== 'tool'
        || next.row.turn !== current.row.turn
      ) break
      end += 1
    }
    const group = projected.slice(index, end)
    if (group.length >= 2) nodes.push(compactToolRun(group))
    else nodes.push(current.node)
    index = end
  }
  return nodes
}

function commandMenuLines(menu: CommandMenuView, columns: number): string[] {
  if (menu.candidates.length === 0) {
    return [fitLine(`  No matches for /${inlineText(menu.query)}`, columns)]
  }
  const windowStart = menu.windowStart ?? 0
  const visible = menu.candidates.slice(
    windowStart,
    windowStart + COMMAND_MENU_LIMIT,
  )
  const labels = visible.map(candidate => `/${inlineText(candidate.command.name)}`)
  const commandWidth = Math.min(
    Math.max(0, ...labels.map(label => visibleWidth(label))),
    Math.max(8, Math.floor(columns * 0.36)),
  )
  return visible.map((candidate, visibleIndex) => {
    const index = windowStart + visibleIndex
    const marker = index === menu.selectedIndex ? '› ' : '  '
    const label = truncateToWidth(labels[visibleIndex]!, commandWidth, '')
    const gap = ' '.repeat(Math.max(2, commandWidth - visibleWidth(label) + 2))
    return fitLine(`${marker}${label}${gap}${inlineText(candidate.command.description)}`, columns)
  })
}

function renderCommandPaletteFrame(
  menu: CommandMenuView,
  prompt: PromptEditorState,
  viewport: TerminalViewport,
  notice?: string,
  pending = false,
): UiFrame {
  const { columns, rows } = viewport
  const editor = promptProjection(prompt, Math.max(1, columns - 2), '')
  const searchLine = fitLine(`> ${editor.line}`, columns)
  const cursor = {
    row: rows - 1,
    column: Math.min(columns - 1, editor.column + 2),
  }
  if (rows === 1) {
    return {
      title: 'DSH-TUI',
      viewport,
      lines: [searchLine],
      lineStyles: [{ tone: 'composer', bold: true }],
      cursor: { ...cursor, row: 0 },
    }
  }
  if (rows === 2) {
    return {
      title: 'DSH-TUI',
      viewport,
      lines: ['─'.repeat(columns), searchLine],
      lineStyles: [
        { tone: 'muted', dim: true },
        { tone: 'composer', bold: true },
      ],
      cursor,
    }
  }
  const bodySlots = Math.max(0, rows - 2)
  const candidates = commandMenuLines(menu, columns)
  const status = pending
    ? 'Running command…'
    : notice === undefined ? undefined : inlineText(notice)
  const candidateSlots = Math.max(0, bodySlots - (status === undefined ? 0 : 1))
  const visible = candidates.slice(0, candidateSlots)
  const padding = Array.from({
    length: bodySlots - visible.length - (status === undefined ? 0 : 1),
  }, () => '')
  const statusLines = status === undefined ? [] : [fitLine(`  ${status}`, columns)]
  return {
    title: 'DSH-TUI',
    viewport,
    lines: [
      ...visible,
      ...padding,
      ...statusLines,
      '─'.repeat(columns),
      searchLine,
    ],
    lineStyles: [
      ...visible.map((line): UiFrameLineStyle => {
        if (line.startsWith('› ')) {
          return { tone: 'accent', bold: true, inverse: true, fill: true }
        }
        return { tone: line.includes('No matches for') ? 'muted' : 'primary' }
      }),
      ...padding.map(() => ({ tone: 'primary' as const })),
      ...statusLines.map(() => ({
        tone: pending ? 'warning' as const : 'muted' as const,
        dim: !pending,
      })),
      { tone: 'muted', dim: true },
      { tone: 'composer', bold: true },
    ],
    cursor,
  }
}

function planReviewLines(
  item: Extract<PendingInteraction, { readonly kind: 'question' }>,
  columns: number,
  input: DshTuiFrameInputMode,
): string[] | undefined {
  const review = planReviewOf(item.questions)
  if (review === undefined) return undefined
  const selectedIndex = input.kind === 'plan-review' && input.interactionId === item.id
    ? input.selectedIndex
    : planReviewChoices(review).length - 1
  const planLines = safeText(review.plan)
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
  const visiblePlan = planLines.slice(0, 3)
  const omitted = planLines.length - visiblePlan.length
  const actions = planReviewChoices(review).map((choice, index) => (
    `${index === selectedIndex ? '› ' : '  '}[${inlineText(choice.label)}]`
  )).join('  ')
  return [
    ...wrap(`Decision: ${review.question}`, columns),
    ...visiblePlan.flatMap(line => wrap('  ' + line, columns)),
    ...(omitted === 0 ? [] : wrap(`  … ${omitted} more plan line${omitted === 1 ? '' : 's'} in the tool card`, columns)),
    ...wrap(actions, columns),
  ]
}

function interactionLines(
  item: PendingInteraction,
  columns: number,
  input: DshTuiFrameInputMode,
  focused: boolean,
): string[] {
  if (item.kind === 'approval') {
    if (!focused) {
      return wrap(`Permission queued · ${item.toolName} · call ${item.callId}`, columns)
    }
    const approvalToken = input.kind === 'approval' && input.interactionId === item.id
      ? input.editor.text.trim().toLowerCase()
      : ''
    const selectedIndex = approvalToken === 'y' || approvalToken === 'yes' || approvalToken === '1'
      ? 1
      : input.kind === 'approval' && input.interactionId === item.id
        ? input.selectedIndex ?? 0
      : 0
    const actions = [
      `${selectedIndex === 0 ? '› ' : '  '}[Reject]`,
      `${selectedIndex === 1 ? '› ' : '  '}[Allow once]`,
    ].join('   ')
    if (columns < 40) {
      return [
        ...wrap('Permission · [DSH/approval]', columns),
        ...wrap(`Tool ${item.toolName} · call ${item.callId}`, columns),
        ...wrap(actions, columns),
      ]
    }
    return [
      ...wrap('Official permission request · [DSH/approval]', columns),
      ...wrap(`Tool   ${item.toolName}`, columns),
      ...wrap(`Call   ${item.callId}`, columns),
      ...wrap(`Audit  ${item.approvalId}`, columns),
      ...(item.reason === undefined ? [] : wrap(`Reason ${item.reason}`, columns)),
      ...wrap('Scope  this tool call only; no persistent grant', columns),
      ...wrap(actions, columns),
    ]
  }

  const review = planReviewLines(item, columns, input)
  if (review !== undefined) return review

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
  input: DshTuiFrameInputMode,
  focused: boolean,
): FrameBlock {
  const planReview = item.kind === 'question' && planReviewOf(item.questions) !== undefined
  const label = planReview
    ? focused ? 'PLAN REVIEW' : 'QUEUED PLAN REVIEW'
    : item.kind === 'approval'
      ? focused ? 'PERMISSION REQUIRED' : 'QUEUED PERMISSION'
      : focused ? 'FOCUS' : 'QUEUE'
  return boundedCard(
    label,
    interactionLines(item, columns, input, focused),
    columns,
  )
}

function goalActionLines(view: GoalActionSurfaceView, columns: number): string[] {
  const goal = view.goal
  const identity = `Goal ${goal.phase} · revision ${goal.revision}`
  const error = view.error === undefined ? [] : wrap('Error: ' + view.error, columns)
  if (view.stage === 'edit') {
    return [
      ...wrap(identity, columns),
      ...wrap('Current: ' + goal.objective, columns),
      ...wrap('Type the replacement objective below.', columns),
      ...error,
    ]
  }
  if (view.stage === 'confirm-clear') {
    return [
      ...wrap(identity, columns),
      ...wrap('Clear: ' + goal.objective, columns),
      ...wrap('This writes the official tombstone; prior Session history remains.', columns),
      ...error,
    ]
  }
  return [
    ...wrap(identity + ' · [DSH/official]', columns),
    ...wrap('Objective: ' + goal.objective, columns),
    ...view.actions.flatMap((action, index) => wrap(
      `${index === view.selectedIndex ? '› ' : '  '}${action.label} — ${action.description}`,
      columns,
    )),
    ...error,
  ]
}

function jobStatusMarker(status: SessionJobStatus): string {
  switch (status) {
    case 'running': return '●'
    case 'stopping': return '◌'
    case 'completed': return '✓'
    case 'killed': return '■'
    case 'failed': return '×'
  }
}

function jobCardStatus(
  status: SessionJobStatus,
): NonNullable<ConversationCardNode['status']> {
  switch (status) {
    case 'running': return 'running'
    case 'stopping': return 'stopping'
    case 'completed': return 'done'
    case 'killed': return 'killed'
    case 'failed': return 'failed'
  }
}

function jobCardLines(job: SessionJob, columns: number): string[] {
  return [
    ...wrap(job.label, columns),
    ...wrap([
      job.kind,
      job.status,
      job.detail,
    ].filter((part): part is string => part !== undefined).join(' · '), columns),
  ]
}

function jobsActivityLines(view: JobsActivityView, columns: number): string[] {
  const live = view.rows.filter(row => (
    row.status === 'running' || row.status === 'stopping'
  )).length
  const lines = [
    ...wrap(`[DSH/official] · ${view.rows.length} jobs · ${live} live`, columns),
  ]
  if (view.rows.length === 0) {
    lines.push(...wrap('No background jobs for this Session.', columns))
  } else {
    const visibleCount = Math.min(3, view.rows.length)
    const maxStart = Math.max(0, view.rows.length - visibleCount)
    const start = Math.min(
      maxStart,
      Math.max(0, view.selectedIndex - Math.floor(visibleCount / 2)),
    )
    const visible = view.rows.slice(start, start + visibleCount)
    for (const row of visible) {
      lines.push(...wrap(
        `${row.selected ? '›' : ' '} ${jobStatusMarker(row.status)} ${row.id} · ${row.status} · ${row.label}`,
        columns,
      ))
    }
    const omitted = view.rows.length - visible.length
    if (omitted > 0) lines.push(...wrap(`… ${omitted} other jobs`, columns))
    const selected = view.rows[view.selectedIndex]
    if (selected?.detail !== undefined) {
      lines.push(...wrap(`Detail: ${selected.detail}`, columns))
    }
    if (view.confirmKill && selected !== undefined) {
      lines.push(...wrap(`Stop ${selected.id}? Enter confirm · Esc back`, columns))
    }
  }
  if (view.error !== undefined) lines.push(...wrap('Error: ' + view.error, columns))
  if (view.notice !== undefined) lines.push(...wrap('Notice: ' + view.notice, columns))
  return lines
}

function activityStatusMarker(status: string): string {
  switch (status) {
    case 'running': return '●'
    case 'stopping': return '◌'
    case 'completed': return '✓'
    case 'idle': return '○'
    case 'ready': return '◇'
    case 'inactive': return '·'
    case 'cancelled': return '■'
    case 'killed': return '■'
    case 'interrupted': return '!'
    case 'failed': return '×'
    case 'diagnostic': return '?'
    default: return '·'
  }
}

function activityRowLine(row: ActivityCenterRow): string {
  const indent = '  '.repeat(Math.min(4, row.depth))
  return `${row.selected ? '›' : ' '} ${indent}${activityStatusMarker(row.status)} ${inlineText(row.title)}  ${row.status}`
}

function activityRowTone(row: ActivityCenterRow): UiFrameLineStyle {
  if (row.selected) return { tone: 'accent', bold: true, inverse: true, fill: true }
  switch (row.statusTone) {
    case 'running':
    case 'completed': return { tone: 'success' }
    case 'failed':
    case 'diagnostic': return { tone: 'error' }
    case 'stopping':
    case 'cancelled':
    case 'killed':
    case 'interrupted': return { tone: 'warning' }
    case 'idle':
    case 'ready': return { tone: 'primary' }
    case 'inactive': return { tone: 'muted', dim: true }
  }
}

function renderActivityCenterFrame(
  view: ActivityCenterView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const header = deckRule('ACTIVITY', columns, 'top', 'esc')
  if (rows === 1) {
    return {
      title: 'DSH-TUI', viewport, lines: [header],
      lineStyles: [{ tone: 'accent', bold: true }],
    }
  }
  const tabs = view.tabs.map(tab => {
    const label = `${tab.label} ${tab.count}${tab.live === 0 ? '' : `/${tab.live}`}`
    return tab.selected ? `[ ${label} ]` : `  ${label}  `
  }).join(' ')
  const tabLine = deckContentLine(' ' + tabs, columns)
  if (rows === 2) {
    return {
      title: 'DSH-TUI', viewport, lines: [header, tabLine],
      lineStyles: [{ tone: 'accent', bold: true }, { tone: 'telemetry', bold: true }],
    }
  }
  const selected = view.rows[view.selectedIndex]
  const section = deckRule(
    view.tab.toUpperCase(),
    columns,
    'middle',
    view.rows.length === 0 ? 'empty' : `${view.selectedIndex + 1}/${view.rows.length}`,
  )
  const footerText = view.confirmStop && selected !== undefined
    ? `Stop ${inlineText(selected.title)}?  Enter confirm  Esc back`
    : '←→/Tab section  ↑↓ move  K/Delete stop  R refresh  Esc close'
  const footer = deckRule(footerText, columns, 'bottom')
  if (rows === 3) {
    return {
      title: 'DSH-TUI', viewport, lines: [header, tabLine, footer],
      lineStyles: [
        { tone: 'accent', bold: true },
        { tone: 'telemetry', bold: true },
        { tone: 'muted' },
      ],
    }
  }

  const status = [
    view.loading ? 'Refreshing Subagent catalog…' : undefined,
    view.tab === 'subagents' && !view.subagentsAvailable
      ? 'Subagent service is not mounted in this Agent composition.'
      : undefined,
    view.error === undefined ? undefined : `Error: ${inlineText(view.error)}`,
    view.notice === undefined ? undefined : `Notice: ${inlineText(view.notice)}`,
  ].filter((line): line is string => line !== undefined)
  const detail = selected === undefined || rows < 12
    ? []
    : [
        deckRule('DETAIL', columns, 'middle'),
        ...[selected.meta, ...selected.detail].slice(0, 3).map(line => (
          deckContentLine(' ' + inlineText(line), columns)
        )),
      ]
  const bodySlots = rows - 4
  const statusSlots = Math.min(status.length, Math.max(0, bodySlots - detail.length - 1))
  const rowSlots = Math.max(0, bodySlots - statusSlots - detail.length)
  const start = view.selectedIndex < 0
    ? 0
    : Math.min(
        Math.max(0, view.rows.length - rowSlots),
        Math.max(0, view.selectedIndex - Math.floor(rowSlots / 2)),
      )
  const visibleRows = view.rows.slice(start, start + rowSlots)
  const empty = visibleRows.length === 0 && rowSlots > 0
    ? [view.tab === 'jobs'
        ? 'No background Jobs in this Session.'
        : view.tab === 'subagents'
          ? 'No durable Subagent descendants.'
          : 'No top-level Workflow runs in this Session.']
    : []
  const rowLines = visibleRows.map(row => deckContentLine(' ' + activityRowLine(row), columns))
  const emptyLines = empty.map(line => deckContentLine(' ' + line, columns))
  const visibleStatus = status.slice(-statusSlots).map(line => deckContentLine(' ' + line, columns))
  const used = visibleStatus.length + rowLines.length + emptyLines.length + detail.length
  const padding = Array.from({ length: Math.max(0, bodySlots - used) }, () => deckContentLine('', columns))
  return {
    title: 'DSH-TUI',
    viewport,
    lines: [
      header,
      tabLine,
      section,
      ...visibleStatus,
      ...rowLines,
      ...emptyLines,
      ...padding,
      ...detail,
      footer,
    ],
    lineStyles: [
      { tone: 'accent' as const, bold: true },
      { tone: 'telemetry', bold: true },
      { tone: 'activity', bold: true },
      ...visibleStatus.map((line): UiFrameLineStyle => ({
        tone: line.includes('Error:') ? 'error' : line.includes('Notice:') ? 'success' : 'warning',
      })),
      ...visibleRows.map(activityRowTone),
      ...emptyLines.map(() => ({ tone: 'muted' as const })),
      ...padding.map(() => ({ tone: 'primary' as const })),
      ...detail.map((_, index): UiFrameLineStyle => index === 0
        ? { tone: 'activity', bold: true }
        : { tone: 'muted' }),
      {
        tone: view.confirmStop ? 'warning' as const : 'muted' as const,
        bold: view.confirmStop,
      },
    ],
  }
}

function renderLegacyJobsActivityFrame(
  view: JobsActivityView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const header = deckRule('ACTIVITY · JOBS', columns, 'top', 'esc')
  const footer = deckRule('↑↓ move  K stop  Enter confirm  Esc close', columns, 'bottom')
  const available = Math.max(0, rows - 2)
  const body = jobsActivityLines(view, Math.max(1, columns - 2)).slice(0, available)
  const padding = Array.from({ length: available - body.length }, () => '')
  return {
    title: 'DSH-TUI', viewport,
    lines: [
      header,
      ...body.map(line => deckContentLine(' ' + line, columns)),
      ...padding.map(() => deckContentLine('', columns)),
      ...(rows > 1 ? [footer] : []),
    ].slice(0, rows),
    lineStyles: [
      { tone: 'accent' as const, bold: true },
      ...body.map(line => ({
        tone: line.startsWith('Error:') ? 'error' as const : 'activity' as const,
      })),
      ...padding.map(() => ({ tone: 'primary' as const })),
      ...(rows > 1 ? [{ tone: 'muted' as const }] : []),
    ].slice(0, rows),
  }
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
      fitLine(`╭─ ${block.label}`, columns),
      ...block.plain,
    ])
    labelled.push(fitLine('╰' + '─'.repeat(Math.max(0, columns - 1)), columns))
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

function centeredLine(text: string, columns: number): string {
  const clean = fitLine(text, columns)
  const padding = Math.max(0, Math.floor((columns - visibleWidth(clean)) / 2))
  return ' '.repeat(padding) + clean
}

function workbenchHomeLines(
  viewport: TerminalViewport,
  workbench?: SessionWorkbenchSnapshot,
): readonly string[] {
  const activeWork = workbench?.goal != null
    || workbench?.plan?.active === true
    || workbench?.plan?.pending === true
    || (workbench?.todos?.length ?? 0) > 0
  if (activeWork) {
    const guidance = viewport.columns < 24
      ? ['Ready']
      : viewport.columns < 48
        ? ['Timeline ready · send a prompt']
        : ['Timeline ready', 'Send a prompt to advance the active Goal']
    return guidance.map(line => centeredLine(line, viewport.columns))
  }
  const brand = cordisBrandLines({
    columns: viewport.columns,
    rows: Math.min(viewport.rows, 10),
  })
  const guidance = viewport.columns < 24
    ? []
    : viewport.columns < 48
      ? ['/goal · /plan · /help']
      : ['Harness workbench ready', '/goal <objective> · /plan · /help']
  return [
    ...brand,
    ...(brand.length === 0 || guidance.length === 0 ? [] : ['']),
    ...guidance.map(line => centeredLine(line, viewport.columns)),
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

function deckContentLine(content: string, columns: number): string {
  if (columns <= 2) return fitLine(content, columns)
  const inner = columns - 2
  const fitted = fitLine(content, inner)
  return `│${fitted}${' '.repeat(Math.max(0, inner - visibleWidth(fitted)))}│`
}

function deckRule(
  label: string,
  columns: number,
  edge: 'top' | 'middle' | 'bottom',
  endLabel?: string,
): string {
  if (columns <= 2) return fitLine(label, columns)
  const left = edge === 'top' ? '╭' : edge === 'bottom' ? '╰' : '├'
  const right = edge === 'top' ? '╮' : edge === 'bottom' ? '╯' : '┤'
  const cleanLabel = inlineText(label)
  const cleanEnd = endLabel === undefined ? '' : inlineText(endLabel)
  const prefix = `─ ${cleanLabel} `
  const suffix = cleanEnd === '' ? '' : ` ${cleanEnd} ─`
  const ruleWidth = Math.max(0, columns - 2 - visibleWidth(prefix) - visibleWidth(suffix))
  return fitLine(`${left}${prefix}${'─'.repeat(ruleWidth)}${suffix}${right}`, columns)
}

function floatingSecondaryFrame(
  terminalViewport: TerminalViewport,
  kind: SecondarySurfaceKind,
  render: (viewport: TerminalViewport) => UiFrame,
): UiFrame {
  const geometry = secondarySurfaceGeometry(terminalViewport, kind)
  const frame = render(geometry.viewport)
  return {
    ...frame,
    viewport: terminalViewport,
    overlay: geometry.overlay,
  }
}

function inlineText(text: string): string {
  return safeText(text).replaceAll('\n', '↵')
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function turnEndNotice(
  value: { readonly turn: number; readonly reason: unknown } | undefined,
): ConversationNode | undefined {
  if (value === undefined) return undefined
  const reason = recordOf(value.reason)
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
  let line: string
  switch (kind) {
    case 'completed': return undefined
    case 'error': {
      const failure = recordOf(reason?.error)
      const code = typeof failure?.code === 'string' ? failure.code : 'UNKNOWN'
      const message = typeof failure?.message === 'string'
        ? failure.message
        : 'the provider request failed without a diagnostic'
      line = `REQUEST FAILED · ${code}: ${message}`
      break
    }
    case 'blocked':
      line = 'REQUEST BLOCKED · no response was produced'
      break
    case 'max-tokens':
      line = 'RESPONSE STOPPED · model token limit reached'
      break
    case 'interrupted':
      line = 'REQUEST INTERRUPTED'
      break
    case 'aborted': {
      const cause = recordOf(reason?.reason)
      const causeKind = typeof cause?.kind === 'string' ? cause.kind : 'unknown cause'
      line = `REQUEST CANCELLED · ${causeKind}`
      break
    }
    default:
      line = `REQUEST ENDED · ${kind}`
  }
  return {
    kind: 'notice',
    key: `turn-end:${value.turn}`,
    revision: inlineText(line),
    lines: [line],
  }
}

function sameModelIdentity(
  left: { readonly provider: string; readonly model: string } | undefined,
  right: { readonly provider: string; readonly model: string } | undefined,
): boolean {
  return left?.provider === right?.provider && left?.model === right?.model
}

function modelIdentity(provider: string, model: string): string {
  return `${inlineText(provider)}/${inlineText(model)}`
}

export interface ContextOccupancy {
  readonly percent: number
  readonly usedTokens: number
  readonly contextWindow: number
}

/** Read the official projected numerator only when its capacity is also known. */
export function contextOccupancy(
  context: SessionContextSnapshot | undefined,
): ContextOccupancy | undefined {
  const pressure = context?.pressure
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return undefined
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
}

/** Compact, deterministic token formatting for status and panel rows. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  const [divisor, suffix] = tokens >= 1_000_000_000
    ? [1_000_000_000, 'B'] as const
    : tokens >= 1_000_000
      ? [1_000_000, 'M'] as const
      : [1_000, 'K'] as const
  const scaled = tokens / divisor
  const digits = scaled < 10 ? 1 : 0
  return `${Number(scaled.toFixed(digits))}${suffix}`
}

/** All disjoint provider-reported prompt billing buckets. */
export function billedInputTokens(usage: SessionTokenUsage): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Integer cache percentage with positive ties rounded up. */
function roundedCachePercent(cacheReadTokens: number, denominator: number): number {
  const quotient = Math.floor(denominator / 200)
  const remainder = denominator % 200
  let lower = 0
  let upper = 100
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * quotient + Math.ceil(factor * remainder / 200)
    if (cacheReadTokens >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

/** Cache-read share of billed input without displaying a partial hit as 100%. */
export function cacheHitPercent(usage: SessionTokenUsage): string | undefined {
  const denominator = billedInputTokens(usage)
  if (denominator === 0) return undefined
  const missed = usage.uncachedInputTokens + usage.cacheWriteTokens
  if (missed === 0) return '100'
  const integer = roundedCachePercent(usage.cacheReadTokens, denominator)
  if (integer < 100) return String(integer)

  let decimalPlaces = 1
  let scaledDoubleGap = missed * 200
  const denominatorTens = Math.floor(denominator / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    decimalPlaces += 1
  }
  const denominatorOnes = denominator % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(decimalPlaces - 1)}${10 - roundedLoss}`
}

function contextGauge(percent: number): string {
  const filled = Math.max(0, Math.min(8, Math.round(percent * 8 / 100)))
  return `[${'━'.repeat(filled)}${'·'.repeat(8 - filled)}]`
}

function statusLineSegments(
  groups: readonly (ConversationStatusSegment | undefined)[],
): readonly ConversationStatusSegment[] {
  return groups.filter((group): group is ConversationStatusSegment => group !== undefined)
}

function statusLineText(segments: readonly ConversationStatusSegment[]): string {
  return '◆ ' + segments.map(segment => segment.text).join(' │ ')
}

function firstStatusLineFit(
  candidates: readonly (readonly ConversationStatusSegment[])[],
  columns: number,
): { readonly text: string; readonly segments: readonly ConversationStatusSegment[] } | undefined {
  const exact = candidates.find(candidate => visibleWidth(statusLineText(candidate)) <= columns)
  if (exact !== undefined) return { text: statusLineText(exact), segments: exact }
  const fallback = candidates.at(-1)
  return fallback === undefined
    ? undefined
    : { text: fitLine(statusLineText(fallback), columns), segments: fallback }
}

function missionTone(
  phase: SessionWorkbenchGoalPhase | undefined,
): ConversationDashboardLine['tone'] {
  switch (phase) {
    case 'active': return 'accent'
    case 'paused': return 'muted'
    case 'blocked': return 'warning'
    case 'complete': return 'success'
    case undefined: return 'muted'
  }
}

function planTarget(plan: SessionWorkbenchPlan | undefined): boolean | undefined {
  if (plan === undefined) return undefined
  return plan.pending ? !plan.active : plan.active
}

function planLabel(plan: SessionWorkbenchPlan | undefined): string {
  const target = planTarget(plan)
  if (plan === undefined) return 'unavailable'
  if (plan.pending) return target === true ? 'entering' : 'leaving'
  return target === true ? 'on' : 'off'
}

function todoMarker(todo: SessionWorkbenchTodo): string {
  switch (todo.status) {
    case 'completed': return '✓'
    case 'in_progress': return '●'
    case 'pending': return '○'
  }
}

function todoTone(todo: SessionWorkbenchTodo): ConversationDashboardLine['tone'] {
  switch (todo.status) {
    case 'completed': return 'success'
    case 'in_progress': return 'accent'
    case 'pending': return 'muted'
  }
}

function missionLine(
  text: string,
  tone: ConversationDashboardLine['tone'],
  columns: number,
): ConversationDashboardLine {
  return { text: fitLine(text, columns), tone }
}

/** Build the responsive first-party Goal → Plan → Todo dashboard. */
export function buildWorkbenchDashboard(
  workbench: SessionWorkbenchSnapshot | undefined,
  columnsValue: number,
  rowsValue: number,
): ConversationDashboard | undefined {
  if (workbench?.available !== true) return undefined
  const columns = dimension(columnsValue)
  const rows = dimension(rowsValue)
  const contentColumns = columns < 12 ? columns : Math.max(1, columns - 4)
  const goal = workbench.goal ?? undefined
  const plan = workbench.plan
  const todos = workbench.todos ?? []
  const done = todos.filter(todo => todo.status === 'completed').length
  const current = todos.find(todo => todo.status === 'in_progress')
    ?? todos.find(todo => todo.status === 'pending')
  const phase = goal?.phase
  const tone = missionTone(phase)

  if (goal === undefined && planTarget(plan) !== true && todos.length === 0) {
    return {
      label: 'WORKBENCH DASHBOARD',
      lines: [missionLine(
        'GOAL none · PLAN off · /goal <objective> to begin',
        'muted',
        contentColumns,
      )],
    }
  }

  const phaseLabel = phase ?? 'none'
  const progress = todos.length === 0 ? '' : ` · ${done}/${todos.length} done`
  const actionHint = goal === undefined || goal.phase === 'complete'
    ? ''
    : ' · Ctrl+G actions'
  if (columns < 40 || rows < 10) {
    const todo = todos.length === 0 ? '' : ` · todo ${done}/${todos.length}`
    return {
      label: 'DASHBOARD',
      lines: [missionLine(
        `goal ${phaseLabel} · plan ${planLabel(plan)}${todo}`,
        tone,
        contentColumns,
      )],
    }
  }

  if (columns < 72 || rows < 16) {
    const detail = current !== undefined
      ? `${todoMarker(current)} ${inlineText(current.content)}`
      : goal === undefined ? 'No active work' : `◆ ${inlineText(goal.objective)}`
    return {
      label: 'WORKBENCH DASHBOARD',
      lines: [
        missionLine(
          `GOAL ${phaseLabel} · PLAN ${planLabel(plan)}${progress}${actionHint}`,
          tone,
          contentColumns,
        ),
        missionLine(detail, current === undefined ? tone : todoTone(current), contentColumns),
      ],
    }
  }

  const rounds = goal === undefined
    ? ''
    : ` · round ${goal.roundsStarted}/${goal.maxGoalRounds}`
  const planSummary = plan === undefined ? '' : ` · PLAN ${planLabel(plan).toUpperCase()}`
  const todoSummary = todos.length === 0 ? '' : ` · TODO ${done}/${todos.length}`
  const lines: ConversationDashboardLine[] = [
    missionLine(
      `GOAL ${phaseLabel.toUpperCase()}${rounds}${planSummary}${todoSummary}${actionHint}`,
      tone,
      contentColumns,
    ),
  ]
  if (goal !== undefined) {
    lines.push(missionLine(`◆ ${inlineText(goal.objective)}`, tone, contentColumns))
    if (goal.phase === 'blocked' && goal.blockedReason !== undefined) {
      lines.push(missionLine(
        `! blocked · ${inlineText(goal.blockedReason.message)}`,
        'warning',
        contentColumns,
      ))
    }
  }
  const visibleTodos = todos.slice(0, 3)
  for (const [index, todo] of visibleTodos.entries()) {
    const last = index === visibleTodos.length - 1 && visibleTodos.length === todos.length
    lines.push(missionLine(
      `${last ? '╰─' : '├─'} ${todoMarker(todo)} ${inlineText(todo.content)}`,
      todoTone(todo),
      contentColumns,
    ))
  }
  const omitted = todos.length - visibleTodos.length
  if (omitted > 0) {
    lines.push(missionLine(
      `╰─ … ${omitted} more task${omitted === 1 ? '' : 's'}`,
      'muted',
      contentColumns,
    ))
  }
  return { label: 'WORKBENCH DASHBOARD', lines }
}

/** Build the quiet, single-line instrument rail below the conversation. */
export function buildStatusLine(
  model: SessionModelSnapshot | undefined,
  context: SessionContextSnapshot | undefined,
  compaction: SessionCompactionState | undefined,
  columnsValue: number,
): ConversationStatusLine | undefined {
  const columns = dimension(columnsValue)
  const occupancy = contextOccupancy(context)
  const usage = context?.usage
  const current = model?.current
  const effort = current?.reasoningEffort ?? 'default'
  const modelHealth = model === undefined
    ? []
    : [
        model.routable ? undefined : 'unroutable',
        model.writable ? undefined : 'managed by other Host',
      ].filter((value): value is string => value !== undefined)
  const compactModelHealth = model === undefined
    ? []
    : [
        model.routable ? undefined : 'unroutable',
        model.writable ? undefined : 'read-only',
      ].filter((value): value is string => value !== undefined)
  const modelTone: ConversationStatusSegment['tone'] = modelHealth.length === 0
    ? 'assistant'
    : 'warning'
  const fullModel: ConversationStatusSegment | undefined = current === undefined
    ? modelHealth.length === 0
      ? undefined
      : { text: `MODEL ${modelHealth.join(' · ')}`, tone: modelTone }
    : {
        text: 'MODEL ' + [
          `${modelIdentity(current.provider, current.model)}/${inlineText(effort)}`,
          ...modelHealth,
        ].join(' · '),
        tone: modelTone,
      }
  const compactModel: ConversationStatusSegment | undefined = current === undefined
    ? compactModelHealth.length === 0
      ? undefined
      : { text: `MODEL ${compactModelHealth.join(' · ')}`, tone: modelTone }
    : {
        text: 'MODEL ' + [
          `${inlineText(current.model)}/${inlineText(effort)}`,
          ...compactModelHealth,
        ].join(' · '),
        tone: modelTone,
      }
  const contextTone: ConversationStatusSegment['tone'] = occupancy !== undefined
    && occupancy.percent >= 95
    ? 'error'
    : occupancy !== undefined && occupancy.percent >= 80
      ? 'warning'
      : 'telemetry'
  const fullContext: ConversationStatusSegment | undefined = occupancy === undefined
    ? undefined
    : {
        text: `CTX ${contextGauge(occupancy.percent)} ~${formatTokenCount(occupancy.usedTokens)}/${formatTokenCount(occupancy.contextWindow)} ${occupancy.percent}%`,
        tone: contextTone,
      }
  const compactContext: ConversationStatusSegment | undefined = occupancy === undefined
    ? undefined
    : {
        text: `CTX ~${formatTokenCount(occupancy.usedTokens)}/${formatTokenCount(occupancy.contextWindow)} ${occupancy.percent}%`,
        tone: contextTone,
      }
  const hitPercent = usage === undefined ? undefined : cacheHitPercent(usage)
  const cache: ConversationStatusSegment | undefined = hitPercent === undefined
    ? undefined
    : { text: `CACHE ${hitPercent}%`, tone: 'success' }
  const tokens: ConversationStatusSegment | undefined = usage === undefined
    || (billedInputTokens(usage) === 0 && usage.outputTokens === 0)
    ? undefined
    : {
        text: `TOK ↑${formatTokenCount(billedInputTokens(usage))} ↓${formatTokenCount(usage.outputTokens)}`,
        tone: 'muted',
      }
  const running = compaction?.phase === 'running'
  const fullCompaction: ConversationStatusSegment | undefined = !running
    ? undefined
    : compaction.shadowedItemCount === undefined || compaction.shadowedTokenCount === undefined
      ? { text: 'COMPACT …', tone: 'warning' }
      : {
          text: `COMPACT ${compaction.shadowedItemCount}/~${formatTokenCount(compaction.shadowedTokenCount)} …`,
          tone: 'warning',
        }
  const compactCompaction: ConversationStatusSegment | undefined = running
    ? { text: 'COMPACT …', tone: 'warning' }
    : undefined

  const candidates = running
    ? [
        statusLineSegments([fullCompaction, fullModel, fullContext, cache, tokens]),
        statusLineSegments([fullCompaction, compactModel, fullContext, cache, tokens]),
        statusLineSegments([fullCompaction, compactModel, compactContext, cache]),
        statusLineSegments([compactCompaction, compactContext, compactModel]),
        statusLineSegments([compactCompaction, compactContext]),
        statusLineSegments([compactCompaction]),
      ]
    : [
        statusLineSegments([fullModel, fullContext, cache, tokens]),
        statusLineSegments([compactModel, fullContext, cache, tokens]),
        statusLineSegments([compactModel, compactContext, cache, tokens]),
        statusLineSegments([compactModel, compactContext, cache]),
        statusLineSegments([compactContext, compactModel]),
        statusLineSegments([compactContext]),
        statusLineSegments([compactModel]),
        statusLineSegments([cache, tokens]),
      ]
  const selected = firstStatusLineFit(candidates.filter(candidate => candidate.length > 0), columns)
  if (selected === undefined || selected.text === '') return undefined
  const tone: ConversationStatusLine['tone'] = occupancy !== undefined && occupancy.percent >= 95
    ? 'error'
    : occupancy !== undefined && occupancy.percent >= 80
      ? 'warning'
      : running ? 'accent' : 'muted'
  return { text: selected.text, tone, segments: selected.segments }
}

/** Render the complete official token-meter projection for one live Session. */
export function renderContextFrame(
  context: SessionContextSnapshot,
  sessionId: string,
  viewport: TerminalViewport,
  compaction?: SessionCompactionState,
): UiFrame {
  const columns = dimension(viewport.columns)
  const rows = dimension(viewport.rows)
  const normalizedViewport = { columns, rows }
  const header = deckRule('CONTEXT · DSH/token-meter', columns, 'top', 'esc')
  if (rows === 1) {
    return {
      title: 'DSH-TUI',
      viewport: normalizedViewport,
      lines: [header],
      lineStyles: [{ tone: 'accent', bold: true }],
    }
  }

  const sessionLine = deckContentLine(`  Session  ${inlineText(sessionId)}`, columns)
  if (rows === 2) {
    return {
      title: 'DSH-TUI',
      viewport: normalizedViewport,
      lines: [header, sessionLine],
      lineStyles: [{ tone: 'accent', bold: true }, { tone: 'telemetry', bold: true }],
    }
  }

  const occupancy = contextOccupancy(context)
  const pressure = context.pressure
  const breakdown = context.breakdown
  const usage = context.usage
  const section = deckRule(context.available ? 'REQUEST PRESSURE' : 'UNAVAILABLE', columns, 'middle')
  const footer = deckRule('/compact uses Harness compaction', columns, 'bottom')
  if (rows === 3) {
    return {
      title: 'DSH-TUI',
      viewport: normalizedViewport,
      lines: [header, sessionLine, footer],
      lineStyles: [
        { tone: 'accent', bold: true },
        { tone: 'telemetry', bold: true },
        { tone: 'muted' },
      ],
    }
  }
  const bodySlots = rows - 4
  const occupancyLine = occupancy === undefined
    ? 'Occupancy · waiting for provider usage and route capacity'
    : `Occupancy · ${contextGauge(occupancy.percent)} · ~${formatTokenCount(occupancy.usedTokens)} / ${formatTokenCount(occupancy.contextWindow)} · ${occupancy.percent}%`
      + ` · ${pressure?.projectedTokens !== undefined ? 'projected next request' : 'provider sample'}`
  const latestPromptLine = pressure?.pressureTokens === undefined
    ? undefined
    : `Latest provider prompt · ${formatTokenCount(pressure.pressureTokens)} tokens`
  const compositionLine = breakdown === undefined
    ? undefined
    : `Composition estimate · system ${formatTokenCount(breakdown.systemTokens)} · tools ${formatTokenCount(breakdown.toolsTokens)} · messages ${formatTokenCount(breakdown.messageTokens)}`
  const durableUsageLine = usage === undefined
    ? undefined
    : `Durable provider usage · input ${formatTokenCount(usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)} · output ${formatTokenCount(usage.outputTokens)}`
  const inputDetailLine = usage === undefined
    ? undefined
    : `Input detail · uncached ${formatTokenCount(usage.uncachedInputTokens)} · cache read ${formatTokenCount(usage.cacheReadTokens)} · cache write ${formatTokenCount(usage.cacheWriteTokens)}`
  const cacheLine = usage === undefined || cacheHitPercent(usage) === undefined
    ? undefined
    : `Cache hit · ${cacheHitPercent(usage)}% of billed input`
  const compactionLine = compaction === undefined
    ? 'Compaction · no maintenance recorded'
    : `${compaction.phase === 'running' ? 'Compaction' : 'Last compaction'} · ${compaction.phase}`
      + (compaction.shadowedItemCount === undefined || compaction.shadowedTokenCount === undefined
        ? ''
        : ` · ${compaction.shadowedItemCount} items · ~${formatTokenCount(compaction.shadowedTokenCount)} tokens`)
  const sourceLine = `Projection source · official token-meter · as-of seq ${context.asOfSeq ?? 'unknown'}`
  const compactBody = [
    occupancyLine,
    latestPromptLine,
    compositionLine,
    durableUsageLine,
    compactionLine,
    sourceLine,
  ].filter((line): line is string => line !== undefined)
  const richBody = [
    occupancyLine,
    latestPromptLine,
    deckRule('PROMPT COMPOSITION', columns, 'middle'),
    compositionLine,
    deckRule('PROVIDER ACCOUNTING', columns, 'middle'),
    durableUsageLine,
    inputDetailLine,
    cacheLine,
    deckRule('COMPACTION', columns, 'middle'),
    compactionLine,
    deckRule('SOURCE OF TRUTH', columns, 'middle'),
    sourceLine,
  ].filter((line): line is string => line !== undefined)
  const rawBody = context.available
    ? rows >= 14 ? richBody : compactBody
    : [
        'Official token-meter projections are unavailable in this composition.',
        'No local estimate is substituted.',
      ]
  const body = rawBody.filter((line): line is string => line !== undefined).slice(0, bodySlots)
  const visibleBody = body.map(line => line.startsWith('├─')
    ? line
    : deckContentLine(' ' + line, columns))
  const padding = Array.from({ length: bodySlots - visibleBody.length }, () => (
    deckContentLine('', columns)
  ))
  const bodyStyles = body.map((line): UiFrameLineStyle => {
    if (line.startsWith('├─')) {
      return { tone: 'interaction', bold: true }
    }
    if (line.includes('Occupancy')) {
      return { tone: occupancy !== undefined && occupancy.percent >= 80 ? 'warning' : 'success' }
    }
    if (line.includes('Compaction') || line.includes('Last compaction')) {
      return { tone: compaction?.phase === 'running' ? 'warning' : 'success' }
    }
    if (line.includes('Projection source')) return { tone: 'muted', dim: true }
    if (line.includes('Durable provider') || line.includes('Input detail')) {
      return { tone: 'telemetry' }
    }
    return { tone: 'primary' }
  })
  return {
    title: 'DSH-TUI',
    viewport: normalizedViewport,
    lines: [header, sessionLine, section, ...visibleBody, ...padding, footer],
    lineStyles: [
      { tone: 'accent', bold: true },
      { tone: 'telemetry', bold: true },
      { tone: context.available ? 'interaction' : 'warning', bold: true },
      ...bodyStyles,
      ...padding.map(() => ({ tone: 'primary' as const })),
      { tone: 'muted' },
    ],
  }
}

function providerCredentialLabel(provider: ProviderConnectView['providers'][number]): string {
  const credential = provider.credential
  if (!credential.configured) return credential.kind
  const source = credential.source === undefined ? '' : `:${inlineText(credential.source)}`
  return `${credential.kind}${source}`
}

function providerConnectRow(
  provider: ProviderConnectView['providers'][number],
  selected: boolean,
): string {
  const state = provider.connected
    ? '● connected'
    : provider.active
      ? '● active'
      : provider.credential.configured
        ? '○ authorized'
        : '○ dormant'
  return `${selected ? '› ' : '  '}${inlineText(provider.name)}  ${state}`
}

function providerConnectStageLabel(stage: ProviderConnectView['stage']): string {
  switch (stage) {
    case 'providers': return 'PROVIDER DIRECTORY'
    case 'methods': return 'CONNECTION METHOD'
    case 'working': return 'CONNECTING'
    case 'prompt': return 'PROVIDER AUTHORIZATION'
    case 'confirm-disconnect': return 'DISCONNECT PROVIDER'
  }
}

function providerConnectDetail(
  provider: ProviderConnectView['providers'][number] | undefined,
  columns: number,
): string[] {
  if (provider === undefined) return []
  const state = provider.connected
    ? 'connected'
    : provider.active
      ? 'active'
      : provider.credential.configured ? 'authorized' : 'dormant'
  return [
    deckRule('SELECTED PROVIDER', columns, 'middle'),
    `Name  ${inlineText(provider.name)}`,
    `Route  ${inlineText(provider.id)}`,
    `State  ${state} · credential ${providerCredentialLabel(provider)} · ${provider.methods.length} method${provider.methods.length === 1 ? '' : 's'}`,
  ]
}

function providerConnectNotices(view: ProviderConnectView): string[] {
  const lines: string[] = []
  if (view.loading) lines.push('Refreshing official Provider directory…')
  if (view.error !== undefined) lines.push('Error: ' + inlineText(view.error))
  if (view.notice !== undefined) lines.push('Notice: ' + inlineText(view.notice))
  for (const notice of view.notices) {
    lines.push(inlineText(notice.message))
    if (notice.url !== undefined) lines.push('Open: ' + inlineText(notice.url))
    if (notice.code !== undefined) lines.push('Code: ' + inlineText(notice.code))
  }
  return lines
}

function providerConnectBody(view: ProviderConnectView): string[] {
  const provider = view.providers[view.selectedProviderIndex]
  switch (view.stage) {
    case 'providers':
      return view.providers.length === 0
        ? ['No configurable Providers are registered by DSH']
        : view.providers.map((entry, index) => providerConnectRow(
            entry,
            index === view.selectedProviderIndex,
          ))
    case 'methods':
      return provider === undefined
        ? ['No Provider is selected']
        : [
            `Connect ${inlineText(provider.name)} (${inlineText(provider.id)})`,
            ...provider.methods.map((method, index) => (
              `${index === view.selectedMethodIndex ? '› ' : '  '}${inlineText(method.label)} · id:${inlineText(method.id)}`
            )),
          ]
    case 'confirm-disconnect':
      return provider === undefined
        ? ['No Provider is selected']
        : [
            `Disconnect ${inlineText(provider.name)} (${inlineText(provider.id)}) locally?`,
            'This removes writable local credentials and a connection-only profile; it does not revoke remote OAuth grants.',
          ]
    case 'working':
      return [provider === undefined
        ? 'Provider operation in progress…'
        : `Connecting ${inlineText(provider.name)}…`]
    case 'prompt': {
      const prompt = view.prompt
      if (prompt === undefined) return ['Waiting for the official Provider flow…']
      if (prompt.kind !== 'select') return [inlineText(prompt.message)]
      return [
        inlineText(prompt.message),
        ...prompt.options.map((option, index) => [
          `${index === view.selectedOptionIndex ? '› ' : '  '}${inlineText(option.label)}`,
          option.description === undefined ? undefined : inlineText(option.description),
        ].filter((part): part is string => part !== undefined).join(' — ')),
      ]
    }
  }
}

function providerConnectFooter(view: ProviderConnectView): string {
  switch (view.stage) {
    case 'providers': return 'Up/Down select · Enter connect/reconnect · D disconnect · R refresh · Esc close'
    case 'methods': return 'Up/Down select · Enter start official flow · Esc back'
    case 'confirm-disconnect': return 'Enter disconnect locally · Esc back'
    case 'working': return 'Official Provider flow running · Esc cancel'
    case 'prompt': return view.prompt?.kind === 'select'
      ? 'Up/Down select · Enter answer · Esc cancel'
      : 'Enter answer · Esc cancel'
  }
}

function providerConnectFocusIndex(view: ProviderConnectView, noticeCount: number): number | undefined {
  switch (view.stage) {
    case 'methods':
      return view.selectedMethodIndex < 0
        ? undefined
        : noticeCount + 1 + view.selectedMethodIndex
    case 'prompt':
      return view.prompt?.kind !== 'select' || view.selectedOptionIndex < 0
        ? undefined
        : noticeCount + 1 + view.selectedOptionIndex
    /* v8 ignore next -- working-stage input is intentionally unfocused by the caller. */
    case 'working':
    case 'confirm-disconnect':
    /* v8 ignore next -- the Provider directory is focused by its dedicated list branch. */
    case 'providers':
      return undefined
  }
}

function focusedProviderLines(
  lines: readonly string[],
  slots: number,
  focus: number | undefined,
): readonly string[] {
  if (slots === 0) return []
  if (lines.length <= slots) return lines
  if (focus === undefined) return lines.slice(-slots)
  const start = Math.min(
    lines.length - slots,
    Math.max(0, focus - Math.floor(slots / 2)),
  )
  return lines.slice(start, start + slots)
}

/** Render the app-global `/connect` surface; secret prompts are masked here. */
export function renderProviderConnectFrame(
  view: ProviderConnectView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const provider = view.providers[view.selectedProviderIndex]
  const header = deckRule('PROVIDERS · DSH/official', columns, 'top', 'esc')
  const footer = deckRule(providerConnectFooter(view).replaceAll(' · ', '  '), columns, 'bottom')
  if (rows === 1) {
    return {
      title: 'DSH-TUI', viewport, lines: [header],
      lineStyles: [{ tone: 'accent', bold: true }],
    }
  }
  if (rows === 2) {
    return {
      title: 'DSH-TUI', viewport, lines: [header, footer],
      lineStyles: [{ tone: 'accent', bold: true }, { tone: 'muted' }],
    }
  }
  const connected = view.providers.filter(item => item.connected).length
  const configured = view.providers.filter(item => item.credential.configured).length
  const summary = deckContentLine(
    `  ${connected} connected  ·  ${configured} configured  ·  ${view.providers.length} available`,
    columns,
  )
  const showSummary = rows >= 8
  const section = deckRule(providerConnectStageLabel(view.stage), columns, 'middle')
  const prompt = view.stage === 'prompt' ? view.prompt : undefined
  const textPrompt = prompt !== undefined && prompt.kind !== 'select' ? prompt : undefined
  const inputSlots = textPrompt === undefined ? 0 : 1
  const contentSlots = Math.max(0, rows - 3 - (showSummary ? 1 : 0) - inputSlots)
  const notices = providerConnectNotices(view)
  const bodySource = providerConnectBody(view)
  const proposedDetail = view.stage === 'providers' && rows >= 12
    ? providerConnectDetail(provider, columns)
    : []
  const detail = contentSlots >= proposedDetail.length + Math.min(1, bodySource.length)
    ? proposedDetail
    : []
  let visible: readonly string[]
  if (view.stage === 'providers') {
    const minimumListSlots = Math.min(1, bodySource.length)
    const noticeSlots = Math.min(
      notices.length,
      Math.max(0, contentSlots - detail.length - minimumListSlots),
    )
    const listSlots = Math.max(0, contentSlots - detail.length - noticeSlots)
    const focused = focusedProviderLines(bodySource, listSlots, view.selectedProviderIndex)
    visible = [
      ...notices.slice(Math.max(0, notices.length - noticeSlots)),
      ...focused,
      ...detail,
    ]
  } else {
    const source = view.stage === 'working'
      ? [...bodySource, ...notices]
      : [...notices, ...bodySource]
    visible = focusedProviderLines(
      source,
      contentSlots,
      view.stage === 'working'
        ? undefined
        : providerConnectFocusIndex(view, notices.length),
    )
  }
  const padding = Array.from({ length: contentSlots - visible.length }, () => '')
  let promptLine: string | undefined
  let cursor: UiCursor | undefined
  if (textPrompt !== undefined) {
    const secret = textPrompt.kind === 'secret'
    const editor = secret
      ? {
          text: '•'.repeat(Array.from(graphemeSegmenter.segment(view.editor.text)).length),
          cursor: view.editor.cursor,
        }
      : view.editor
    const projection = promptProjection(
      editor,
      Math.max(1, columns - 2),
      secret ? ' secret › ' : ' answer › ',
    )
    promptLine = deckContentLine(projection.line, columns)
    cursor = { row: rows - 2, column: Math.min(columns - 1, projection.column + 1) }
  }
  return {
    title: 'DSH-TUI',
    viewport,
    lines: [
      header,
      ...(showSummary ? [summary] : []),
      section,
      ...visible.map(line => line.startsWith('├─')
        ? line
        : deckContentLine(' ' + line, columns)),
      ...padding.map(() => deckContentLine('', columns)),
      ...(promptLine === undefined ? [] : [promptLine]),
      footer,
    ],
    lineStyles: [
      { tone: 'accent', bold: true },
      ...(showSummary ? [{ tone: 'telemetry' as const, bold: true }] : []),
      { tone: 'interaction', bold: true },
      ...visible.map((line): UiFrameLineStyle => {
        if (line.startsWith('├─ SELECTED PROVIDER')) return { tone: 'interaction', bold: true }
        if (line.startsWith('› ')) {
          return { tone: 'accent', bold: true, inverse: true, fill: true }
        }
        if (line.startsWith('Error:')) return { tone: 'error', bold: true }
        if (line.startsWith('Notice:') || line.includes('…')) return { tone: 'warning' }
        if (line.startsWith('Open:') || line.startsWith('Code:')) return { tone: 'success' }
        if (line.startsWith('Route ') || line.startsWith('State ')) return { tone: 'muted' }
        return { tone: 'primary' }
      }),
      ...padding.map(() => ({ tone: 'primary' as const })),
      ...(promptLine === undefined ? [] : [{ tone: 'composer' as const, bold: true }]),
      { tone: 'muted' },
    ],
    ...(cursor === undefined ? {} : { cursor }),
  }
}

function modePickerRowLine(row: ModePickerRow, selected: boolean): string {
  const badges = [
    row.isCurrent ? 'current' : undefined,
    row.isDefault ? 'default' : undefined,
    row.broken === undefined ? undefined : 'unavailable',
  ].filter((badge): badge is string => badge !== undefined)
  return `${selected ? '› ' : '  '}${inlineText(row.name ?? row.id)}`
    + (badges.length === 0 ? '' : `  ${badges.join(' · ')}`)
}

function renderModePickerFrame(
  view: ModePickerView,
  viewport: TerminalViewport,
  notice?: string,
): UiFrame {
  const { columns, rows } = viewport
  const current = view.current ?? 'none'
  const selected = view.rows[view.selectedIndex]
  const header = deckRule('AGENT MODE', columns, 'top', 'esc')
  if (rows === 1) {
    return {
      title: 'DSH-TUI', viewport, lines: [header],
      lineStyles: [{ tone: 'accent', bold: true }],
    }
  }
  const currentLine = deckContentLine(`  Current  ${inlineText(current)}`, columns)
  if (rows === 2) {
    return {
      title: 'DSH-TUI', viewport,
      lines: [header, currentLine],
      lineStyles: [{ tone: 'accent', bold: true }, { tone: 'telemetry', bold: true }],
    }
  }
  const section = deckRule(view.locked ? 'LOCKED' : 'AVAILABLE', columns, 'middle')
  const footer = deckRule(
    view.locked ? 'Start a new session to switch' : '↑↓ move  Enter apply  R refresh',
    columns,
    'bottom',
  )
  if (rows === 3) {
    return {
      title: 'DSH-TUI', viewport,
      lines: [header, currentLine, footer],
      lineStyles: [
        { tone: 'accent', bold: true },
        { tone: 'telemetry', bold: true },
        { tone: 'muted' },
      ],
    }
  }
  const bodySlots = rows - 4
  const status: string[] = []
  const activity = [
    view.loading ? 'Refreshing mode catalog…' : undefined,
    view.selecting ? 'Applying mode composition…' : undefined,
  ].filter((line): line is string => line !== undefined)
  if (activity.length > 0) status.push(activity.join('  ·  '))
  if (view.locked) {
    status.push('Mode locked after the first turn · start a new session to switch')
  }
  if (!view.available) status.push('Agent modes are unavailable in this composition')
  if (view.error !== undefined) status.push('Error: ' + inlineText(view.error))
  if (notice !== undefined) status.push('Notice: ' + inlineText(notice))
  if (view.rows.length === 0) status.push('No Agent modes found')
  const rowLines = view.rows.map((row, index) => (
    modePickerRowLine(row, index === view.selectedIndex)
  ))
  const proposedDetail = selected?.description === undefined || rows < 10
    ? []
    : [`About  ${inlineText(selected.description)}`]
  const minimumRowSlots = Math.min(3, rowLines.length)
  const detail = proposedDetail
  const statusSlots = Math.min(
    status.length,
    Math.max(0, bodySlots - detail.length - minimumRowSlots),
  )
  const visibleRows = focusedProviderLines(
    rowLines,
    Math.max(0, bodySlots - statusSlots - detail.length),
    view.selectedIndex,
  )
  const visibleStatus = statusSlots === 0 ? [] : status.slice(-statusSlots)
  const body = [...visibleStatus, ...visibleRows, ...detail]
  const padding = Array.from({ length: bodySlots - body.length }, () => '')
  return {
    title: 'DSH-TUI',
    viewport,
    lines: [
      header,
      currentLine,
      section,
      ...body.map(line => deckContentLine(' ' + line, columns)),
      ...padding.map(() => deckContentLine('', columns)),
      footer,
    ],
    lineStyles: [
      { tone: 'accent', bold: true },
      { tone: 'telemetry', bold: true },
      { tone: view.locked ? 'warning' : 'interaction', bold: true },
      ...body.map((line): UiFrameLineStyle => {
        if (line.startsWith('› ')) {
          return { tone: 'accent', bold: true, inverse: true, fill: true }
        }
        if (line.startsWith('Error:')) return { tone: 'error' }
        if (line.includes('already started') || line.includes('unavailable')) {
          return { tone: 'warning' }
        }
        if (line.startsWith('About')) return { tone: 'muted', dim: true }
        return { tone: 'primary' }
      }),
      ...padding.map(() => ({ tone: 'primary' as const })),
      { tone: 'muted' },
    ],
  }
}

function skillResourceLabel(
  resource: SkillPickerView['rows'][number]['resourceBase'],
): string | undefined {
  if (resource === undefined) return undefined
  switch (resource.kind) {
    case 'directory': return resource.path
    case 'url': return resource.url
    case 'opaque': return resource.description
  }
}

function skillPickerDetailLines(
  view: SkillPickerView,
  columns: number,
): string[] {
  const selected = view.rows[view.selectedIndex]
  const status = [
    view.error === undefined ? undefined : `Error  ${inlineText(view.error)}`,
    view.loading ? 'Refreshing catalog…' : undefined,
    !view.complete
      ? view.stale
        ? 'Catalog changed · showing the last complete view'
        : 'Catalog discovery is incomplete'
      : undefined,
  ].filter((line): line is string => line !== undefined)
  if (!view.available) return [...status, 'Skills are unavailable in this Agent composition']
  if (selected === undefined) {
    return [...status, view.query.text.trim() === '' ? 'No user-invocable skills' : 'No matching skills']
  }
  const width = Math.max(1, columns - 6)
  const resource = skillResourceLabel(selected.resourceBase)
  return [
    ...status,
    ...wrap(`About  ${inlineText(selected.description)}`, width).slice(0, 2),
    ...(selected.whenToUse === undefined
      ? []
      : wrap(`When   ${inlineText(selected.whenToUse)}`, width).slice(0, 2)),
    `Call   USER ✓   MODEL ${selected.modelInvocable ? '✓' : '—'}`,
    `From   ${inlineText(selected.source)} · ${inlineText(selected.provider)}`,
    ...(resource === undefined ? [] : [`Base   ${inlineText(resource)}`]),
  ]
}

function renderSkillPickerFrame(
  view: SkillPickerView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const header = deckRule(`SKILLS · ${view.totalCount}`, columns, 'top', view.loading ? 'sync' : 'esc')
  if (rows === 1) {
    return {
      title: 'DSH-TUI', viewport, lines: [header],
      lineStyles: [{ tone: 'accent', bold: true }],
    }
  }
  const editor = promptProjection(view.query, Math.max(1, columns - 5), '')
  const search = deckContentLine(` > ${editor.line}`, columns)
  const cursor = { row: 1, column: Math.min(columns - 1, editor.column + 3) }
  if (rows === 2) {
    return {
      title: 'DSH-TUI', viewport, lines: [header, search],
      lineStyles: [{ tone: 'accent', bold: true }, { tone: 'composer', bold: true }],
      cursor,
    }
  }
  const section = deckRule(
    view.query.text.trim() === '' ? 'AVAILABLE' : `MATCHES · ${view.rows.length}`,
    columns,
    'middle',
  )
  if (rows <= 4) {
    const compact = rows === 3
      ? [header, search, section]
      : [header, search, section, deckRule('', columns, 'bottom')]
    return {
      title: 'DSH-TUI', viewport, lines: compact,
      lineStyles: [
        { tone: 'accent', bold: true },
        { tone: 'composer', bold: true },
        { tone: 'interaction', bold: true },
        ...(rows === 4 ? [{ tone: 'border' as const }] : []),
      ],
      cursor,
    }
  }
  const detail = skillPickerDetailLines(view, columns)
  const bodySlots = rows - 5
  const minimumList = Math.min(3, view.rows.length)
  const detailSlots = Math.min(
    detail.length,
    Math.max(0, bodySlots - minimumList),
  )
  const listSlots = Math.min(10, Math.max(0, bodySlots - detailSlots))
  const start = view.rows.length <= listSlots || view.selectedIndex < 0
    ? 0
    : Math.min(
        view.rows.length - listSlots,
        Math.max(0, view.selectedIndex - Math.floor(listSlots / 2)),
      )
  const visibleRows = view.rows.slice(start, start + listSlots)
  const rowLines = visibleRows.map((skill, index) => {
    const selected = start + index === view.selectedIndex
    return `${selected ? '› ' : '  '}/${inlineText(skill.name)}  ${inlineText(skill.description)}`
  })
  const visibleDetail = detail.slice(0, detailSlots)
  const padding = Array.from({
    length: Math.max(0, bodySlots - rowLines.length - visibleDetail.length),
  }, () => '')
  const detailRule = deckRule(
    view.rows[view.selectedIndex] === undefined ? 'STATUS' : 'SELECTED',
    columns,
    'middle',
  )
  const bottom = deckRule('', columns, 'bottom')
  return {
    title: 'DSH-TUI',
    viewport,
    lines: [
      header,
      search,
      section,
      ...rowLines.map(line => deckContentLine(' ' + line, columns)),
      detailRule,
      ...visibleDetail.map(line => deckContentLine('  ' + line, columns)),
      ...padding.map(() => deckContentLine('', columns)),
      bottom,
    ],
    lineStyles: [
      { tone: 'accent', bold: true },
      { tone: 'composer', bold: true },
      { tone: 'interaction', bold: true },
      ...rowLines.map((_, index): UiFrameLineStyle => (
        start + index === view.selectedIndex
          ? { tone: 'accent', bold: true, inverse: true, fill: true }
          : { tone: 'primary' }
      )),
      { tone: 'telemetry', bold: true },
      ...visibleDetail.map((line): UiFrameLineStyle => {
        if (line.startsWith('Error')) return { tone: 'error' }
        if (line.startsWith('Refreshing') || line.startsWith('Catalog')) return { tone: 'warning' }
        if (line.startsWith('Call')) return { tone: 'success', bold: true }
        if (line.startsWith('From') || line.startsWith('Base')) return { tone: 'muted', dim: true }
        return { tone: 'primary' }
      }),
      ...padding.map(() => ({ tone: 'primary' as const })),
      { tone: 'border' },
    ],
    cursor,
  }
}

interface ModelPickerDisplayLine {
  readonly text: string
  readonly selected: boolean
}

function modelPickerRowLine(row: ModelPickerModelRow, selected: boolean): string {
  const badges = [
    row.isCurrent ? 'current' : undefined,
    row.isDefault ? 'default' : undefined,
    row.catalogued ? undefined : 'unlisted',
    row.routable ? undefined : 'unroutable',
    row.retainedReasoningEffort === undefined
      ? undefined
      : `effort:${inlineText(row.retainedReasoningEffort)}`,
  ].filter((item): item is string => item !== undefined)
  return `${selected ? '› ' : '  '}${inlineText(row.name)}`
    + (badges.length === 0 ? '' : `  ${badges.join(' · ')}`)
}

function effortPickerRowLine(row: ModelPickerEffortRow, selected: boolean): string {
  const identity = row.kind === 'provider-default'
    ? row.name
    : `${inlineText(row.name)} · id:${inlineText(row.id)}`
  return [
    (selected ? '› ' : '  ') + identity,
    row.isDefault ? 'default' : undefined,
    row.kind === 'effort' && row.description !== undefined
      ? inlineText(row.description)
      : undefined,
  ].filter((item): item is string => item !== undefined).join(' · ')
}

function modelPickerDisplayLines(
  view: ModelPickerView,
  includeGroups = true,
): ModelPickerDisplayLine[] {
  if (view.stage === 'reasoning') {
    return view.efforts.map((effort, index) => ({
      text: effortPickerRowLine(effort, index === view.selectedEffortIndex),
      selected: index === view.selectedEffortIndex,
    }))
  }
  const lines: ModelPickerDisplayLine[] = []
  for (const group of view.groups) {
    if (includeGroups) {
      lines.push({
        text: `GROUP · ${inlineText(group.name)} · ${group.models.length} model${group.models.length === 1 ? '' : 's'}`,
        selected: false,
      })
    }
    for (const row of group.models) {
      const selected = sameModelIdentity(
        { provider: row.provider, model: row.id },
        view.selectedModel,
      )
      lines.push({ text: modelPickerRowLine(row, selected), selected })
    }
  }
  return lines
}

function modelPickerStatusLines(view: ModelPickerView): string[] {
  const lines: string[] = []
  const activity = [
    view.loading ? 'Refreshing model catalog…' : undefined,
    view.selecting ? 'Switching model…' : undefined,
  ].filter((line): line is string => line !== undefined)
  if (activity.length > 0) lines.push(activity.join('  ·  '))
  const ownership = [
    !view.writable ? 'Read-only: model is managed by another Host' : undefined,
    view.current !== undefined && !view.routable ? 'Current Provider is unroutable' : undefined,
  ].filter((line): line is string => line !== undefined)
  if (ownership.length > 0) lines.push(ownership.join('  ·  '))
  if (view.error !== undefined) lines.push('Error: ' + inlineText(view.error))
  for (const failure of view.failures) {
    lines.push(
      `Provider ${inlineText(failure.provider)} failed: ${inlineText(failure.message)}`,
    )
  }
  if (view.stage === 'models' && view.groups.every(group => group.models.length === 0)) {
    lines.push('No model catalog entries available')
  }
  if (view.stage === 'reasoning' && view.efforts.length === 0) {
    lines.push('No reasoning options available')
  }
  return lines
}

function modelPickerDetailLines(view: ModelPickerView): string[] {
  if (view.selectedModel === undefined) return []
  const row = view.groups
    .flatMap(group => group.models)
    .find(model => sameModelIdentity(
      { provider: model.provider, model: model.id },
      view.selectedModel,
    ))
  if (row === undefined) return []
  const flags = [
    row.isCurrent ? 'current' : undefined,
    row.isDefault ? 'default' : undefined,
    row.routable ? 'routable' : 'unroutable',
    row.catalogued ? undefined : 'retained route',
  ].filter((value): value is string => value !== undefined)
  const effort = row.retainedReasoningEffort === undefined
    ? row.efforts.length === 0
      ? 'provider default'
      : `${row.efforts.length} option${row.efforts.length === 1 ? '' : 's'}`
    : row.retainedReasoningEffort
  return [
    'DETAIL',
    `Route  ${modelIdentity(row.provider, row.id)}`,
    `State  ${flags.join(' · ')}`,
    `Reasoning  ${inlineText(effort)}`,
  ]
}

function visibleModelPickerLines(
  lines: readonly ModelPickerDisplayLine[],
  slots: number,
): string[] {
  if (lines.length === 0) return []
  const count = Math.min(slots, lines.length)
  const selectedIndex = lines.findIndex(line => line.selected)
  const maxStart = lines.length - count
  const start = selectedIndex < 0
    ? 0
    : Math.min(maxStart, Math.max(0, selectedIndex - count + 1))
  return lines.slice(start, start + count).map(line => line.text)
}

function modelPickerFooter(view: ModelPickerView): string {
  const shared = 'Up/Down select · R refresh'
  if (!view.writable) {
    return `Read-only · ${shared} · Esc ${view.stage === 'reasoning' ? 'back' : 'close'}`
  }
  return view.stage === 'reasoning'
    ? `Reasoning · ${shared} · Enter switch · Ctrl+S switch+default · Esc back`
    : `Models · ${shared} · Enter/Ctrl+S reasoning/select · Esc close`
}

function renderModelPickerFrame(
  view: ModelPickerView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const mode = view.writable ? view.stage : 'read-only'
  const header = deckRule('MODELS · DSH runtime', columns, 'top', 'esc')
  if (rows === 1) {
    return {
      title: 'DSH-TUI', viewport, lines: [header],
      lineStyles: [{ tone: 'accent', bold: true }],
    }
  }
  const statuses = modelPickerStatusLines(view)
  const modelCount = view.groups.reduce((total, group) => total + group.models.length, 0)
  const current = view.current === undefined
    ? 'none'
    : modelIdentity(view.current.provider, view.current.model)
  const summary = deckContentLine(
    `  Current  ${current}  ·  ${view.groups.length} providers  ·  ${modelCount} models`,
    columns,
  )
  if (rows === 2) {
    const status = statuses[0]
    return {
      title: 'DSH-TUI',
      viewport,
      lines: [header, status === undefined ? summary : deckContentLine(' ' + status, columns)],
      lineStyles: [
        { tone: 'accent', bold: true },
        { tone: status === undefined ? 'telemetry' : 'warning', bold: true },
      ],
    }
  }
  const scopedProvider = view.stage === 'models' && view.groups.length === 1
    ? ` · ${inlineText(view.groups[0]!.name)}`
    : ''
  const section = deckRule(
    (mode === 'reasoning'
      ? 'REASONING EFFORT'
      : mode === 'read-only' ? 'READ-ONLY CATALOG' : 'MODEL CATALOG') + scopedProvider,
    columns,
    'middle',
  )
  const footer = deckRule(modelPickerFooter(view).replaceAll(' · ', '  '), columns, 'bottom')
  if (rows === 3) {
    return {
      title: 'DSH-TUI',
      viewport,
      lines: [header, summary, footer],
      lineStyles: [
        { tone: 'accent', bold: true },
        { tone: 'telemetry', bold: true },
        { tone: 'muted' },
      ],
    }
  }
  const showSummary = rows >= 7
  const bodySlots = rows - 3 - (showSummary ? 1 : 0)
  const display = modelPickerDisplayLines(view, view.groups.length > 1)
  const proposedDetail = rows >= 14 ? modelPickerDetailLines(view) : []
  const detail = proposedDetail
  const statusSlots = Math.min(
    statuses.length,
    Math.max(0, bodySlots - detail.length - Math.min(1, display.length)),
  )
  const visibleStatuses = statusSlots === 0 ? [] : statuses.slice(-statusSlots)
  const visibleRows = visibleModelPickerLines(
    display,
    Math.max(0, bodySlots - statusSlots - detail.length),
  )
  const body = [...visibleStatuses, ...visibleRows, ...detail].slice(0, bodySlots)
  const padding = Array.from({ length: bodySlots - body.length }, () => '')
  return {
    title: 'DSH-TUI',
    viewport,
    lines: [
      header,
      ...(showSummary ? [summary] : []),
      section,
      ...body.map(line => {
        if (line === 'DETAIL') return deckRule('SELECTED MODEL', columns, 'middle')
        if (line.startsWith('GROUP · ')) {
          return deckRule(line.slice('GROUP · '.length), columns, 'middle')
        }
        return deckContentLine(' ' + line, columns)
      }),
      ...padding.map(() => deckContentLine('', columns)),
      footer,
    ],
    lineStyles: [
      { tone: 'accent', bold: true },
      ...(showSummary ? [{ tone: 'telemetry' as const, bold: true }] : []),
      { tone: mode === 'read-only' ? 'warning' : 'interaction', bold: true },
      ...body.map((line): UiFrameLineStyle => {
        if (line === 'DETAIL' || line.startsWith('GROUP · ')) {
          return { tone: 'interaction', bold: true }
        }
        if (line.startsWith('› ')) {
          return { tone: 'accent', bold: true, inverse: true, fill: true }
        }
        if (line.startsWith('Error:') || line.includes('failed:')) return { tone: 'error' }
        if (line.startsWith('Read-only:')) return { tone: 'warning' }
        if (line.startsWith('Route ') || line.startsWith('State ') || line.startsWith('Reasoning ')) {
          return { tone: 'muted' }
        }
        return { tone: 'primary' }
      }),
      ...padding.map(() => ({ tone: 'primary' as const })),
      { tone: 'muted' },
    ],
  }
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
  return [
    marker + inlineText(row.sessionId),
    row.relation,
    liveStatus,
  ].join(' · ')
}

function sessionPickerDetailLines(
  row: SessionPickerRow | undefined,
  rich: boolean,
): string[] {
  if (row === undefined) return []
  const liveStatus = row.liveStatus ?? (row.attached ? 'attached' : 'none')
  const ownership = row.isSubagent
    ? 'subagent:' + inlineText(row.parentSessionId ?? 'unknown-parent')
    : 'root'
  const workspace = [
    row.cwd === undefined ? undefined : 'cwd:' + inlineText(row.cwd),
    row.creationAgentPreset === undefined
      ? undefined
      : 'preset:' + inlineText(row.creationAgentPreset),
  ].filter((item): item is string => item !== undefined).join(' · ')
  if (!rich) {
    return [[
      ownership,
      workspace === '' ? undefined : workspace,
      'created:' + row.createdAt,
    ].filter((item): item is string => item !== undefined).join(' · ')]
  }
  return [
    'DETAIL',
    `State  ${row.relation} · live ${liveStatus} · durable ${row.durablePresence}`,
    `Ownership  ${ownership}`,
    workspace === '' ? 'Workspace  unavailable' : `Workspace  ${workspace}`,
    `Created  ${row.createdAt}`,
  ]
}

function sessionPickerStatusLines(panel: SessionPickerPanel): string[] {
  const lines: string[] = []
  if (panel.loading) lines.push('Loading sessions…')
  if (panel.error !== undefined) lines.push('Error: ' + inlineText(panel.error))
  const availability = [
    panel.view.durability === 'unavailable'
      ? 'Live sessions only · durable storage unavailable'
      : undefined,
    !panel.loaded && !panel.loading ? 'Session catalog not loaded' : undefined,
  ].filter((line): line is string => line !== undefined)
  if (availability.length > 0) lines.push(availability.join('  ·  '))
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
  const header = deckRule('SESSIONS · DSH/local', columns, 'top', 'esc')
  const footer = deckRule(
    sessionPickerFooter(panel.view, liveActivation, inspection).replace(/^Sessions \S+ · /u, '').replaceAll(' · ', '  '),
    columns,
    'bottom',
  )
  if (rows === 1) {
    return {
      title: 'DSH-TUI', viewport, lines: [header],
      lineStyles: [{ tone: 'accent', bold: true }],
    }
  }

  const selectedIndex = panel.view.rows.length === 0
    ? -1
    : normalizedPickerSelection(panel.view)
  const selectedRow = selectedIndex < 0 ? undefined : panel.view.rows[selectedIndex]
  const selected = selectedRow === undefined
    ? undefined
    : sessionPickerRowLine(selectedRow, true)
  const statuses = sessionPickerStatusLines(panel)
  if (rows === 2) {
    const second = selected ?? statuses[0]!
    return {
      title: 'DSH-TUI',
      viewport,
      lines: [header, deckContentLine(' ' + second, columns)],
      lineStyles: [
        { tone: 'accent', bold: true },
        { tone: selected === undefined ? 'muted' : 'accent', bold: selected !== undefined, inverse: selected !== undefined, fill: selected !== undefined },
      ],
    }
  }
  if (rows === 3) {
    const middle = selected ?? statuses[0]!
    return {
      title: 'DSH-TUI', viewport,
      lines: [header, deckContentLine(' ' + middle, columns), footer],
      lineStyles: [
        { tone: 'accent', bold: true },
        { tone: selected === undefined ? 'muted' : 'accent', bold: selected !== undefined, inverse: selected !== undefined, fill: selected !== undefined },
        { tone: 'muted' },
      ],
    }
  }

  const showSummary = rows >= 9
  const summary = deckContentLine(
    `  ${mode}  ·  ${panel.view.totalCount} sessions  ·  ${panel.view.durability === 'available' ? 'durable catalog' : 'live only'}`,
    columns,
  )
  const section = deckRule('SESSION DIRECTORY', columns, 'middle')
  const bodySlots = rows - 3 - (showSummary ? 1 : 0)
  const hasRows = panel.view.rows.length > 0
  const proposedDetail = sessionPickerDetailLines(selectedRow, rows >= 12)
  const minimumRowSlots = hasRows ? 1 : 0
  const detail = bodySlots >= proposedDetail.length + minimumRowSlots
    ? proposedDetail
    : []
  const statusLimit = hasRows
    ? Math.max(0, bodySlots - detail.length - minimumRowSlots)
    : bodySlots
  const statusCount = Math.min(statuses.length, statusLimit)
  const visibleStatuses = statusCount === 0 ? [] : statuses.slice(-statusCount)
  const visibleRows = sessionPickerRows(
    panel.view,
    bodySlots - visibleStatuses.length - detail.length,
  )
  const body = [...visibleStatuses, ...visibleRows, ...detail]
  const padding = Array.from({ length: bodySlots - body.length }, () => '')
  return {
    title: 'DSH-TUI',
    viewport,
    lines: [
      header,
      ...(showSummary ? [summary] : []),
      section,
      ...body.map(line => line === 'DETAIL'
        ? deckRule('SELECTED SESSION', columns, 'middle')
        : deckContentLine(' ' + line, columns)),
      ...padding.map(() => deckContentLine('', columns)),
      footer,
    ],
    lineStyles: [
      { tone: 'accent', bold: true },
      ...(showSummary ? [{ tone: 'telemetry' as const, bold: true }] : []),
      { tone: 'interaction', bold: true },
      ...body.map((line): UiFrameLineStyle => {
        if (line === 'DETAIL') return { tone: 'interaction', bold: true }
        if (line.startsWith('› ')) {
          return { tone: 'accent', bold: true, inverse: true, fill: true }
        }
        if (line.startsWith('Error:')) return { tone: 'error', bold: true }
        if (line.startsWith('Notice:') || line.includes('unavailable')) return { tone: 'warning' }
        if (line.startsWith('State ') || line.startsWith('Ownership ')
          || line.startsWith('Workspace ') || line.startsWith('Created ')) {
          return { tone: 'muted' }
        }
        return { tone: 'primary' }
      }),
      ...padding.map(() => ({ tone: 'primary' as const })),
      { tone: 'muted' },
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
    panel.error === undefined ? undefined : 'Error: ' + inlineText(panel.error),
    panel.notice === undefined ? undefined : 'Notice: ' + inlineText(panel.notice),
    panel.refreshing ? 'Refreshing inspection…' : undefined,
    inspectionObservation(panel.observation),
    'Logical read-only snapshot · Storage unchanged',
    session?.omittedRowCount === undefined
      ? undefined
      : `… ${session.omittedRowCount} earlier projected rows omitted`,
    inspectionMetadata(panel.header),
    'Snapshot may include in-memory interruption closers; durable storage was not repaired.',
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
  if (rows <= 3) return 0
  const showSummary = rows >= 5
  return inspectionReadyLayout(
    panel,
    Math.max(1, dimension(viewport.columns) - 4),
    rows - 3 - (showSummary ? 1 : 0),
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
  const header = deckRule('SESSION INSPECTION · DSH/durable', columns, 'top', 'esc')
  const compactHeader = deckRule(`SESSION INSPECTION · ${status}`, columns, 'top', 'esc')
  if (rows === 1) {
    return {
      title: 'DSH-TUI',
      viewport,
      lines: [compactHeader],
      lineStyles: [{ tone: 'accent', bold: true }],
    }
  }

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
  const footerLine = deckRule(footer.replaceAll(' · ', '  '), columns, 'bottom')
  if (rows === 2) {
    return {
      title: 'DSH-TUI',
      viewport,
      lines: [compactHeader, footerLine],
      lineStyles: [{ tone: 'accent', bold: true }, { tone: 'muted' }],
    }
  }

  const sectionLabel = panel.kind === 'loading'
    ? 'INSPECTING'
    : panel.kind === 'error'
      ? 'INSPECTION FAILED'
      : panel.kind === 'confirm-resume'
        ? 'COLD RESUME'
        : 'TRANSCRIPT'
  const section = deckRule(sectionLabel, columns, 'middle')
  if (rows === 3) {
    return {
      title: 'DSH-TUI',
      viewport,
      lines: [header, section, footerLine],
      lineStyles: [
        { tone: 'accent', bold: true },
        { tone: panel.kind === 'error' ? 'error' : 'interaction', bold: true },
        { tone: 'muted' },
      ],
    }
  }

  const showSummary = rows >= 5
  const summary = deckContentLine(
    `  Session  ${inlineText(panel.sessionId)}  ·  ${status}`,
    columns,
  )
  const bodySlots = rows - 3 - (showSummary ? 1 : 0)
  const innerColumns = Math.max(1, columns - 4)
  const body = panel.kind === 'loading'
    ? [
        `Inspecting ${inlineText(panel.sessionId)}… · logical read-only · Storage unchanged`,
      ].slice(0, bodySlots)
    : panel.kind === 'error'
      ? [
          'Inspect failed: ' + inlineText(panel.message) + ' · Storage unchanged',
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
      : inspectionReadyBody(panel, innerColumns, bodySlots)
  const padding = Array.from({ length: bodySlots - body.length }, () => '')
  return {
    title: 'DSH-TUI',
    viewport,
    lines: [
      header,
      ...(showSummary ? [summary] : []),
      section,
      ...body.map(line => deckContentLine(' ' + line, columns)),
      ...padding.map(() => deckContentLine('', columns)),
      footerLine,
    ],
    lineStyles: [
      { tone: 'accent', bold: true },
      ...(showSummary ? [{ tone: 'telemetry' as const, bold: true }] : []),
      { tone: panel.kind === 'error' ? 'error' : 'interaction', bold: true },
      ...body.map((line): UiFrameLineStyle => {
        if (line.startsWith('Error:') || line.startsWith('Inspect failed:')) {
          return { tone: 'error', bold: true }
        }
        if (line.startsWith('Notice:') || line.includes('repair or append')) {
          return { tone: 'warning', bold: true }
        }
        if (line.startsWith('You:')) return { tone: 'accent', bold: true }
        if (line.startsWith('Assistant:')) return { tone: 'primary' }
        if (line.startsWith('Tool ') || line.startsWith('Result:')) return { tone: 'tool' }
        return { tone: 'muted' }
      }),
      ...padding.map(() => ({ tone: 'primary' as const })),
      { tone: 'muted' },
    ],
  }
}

function inputPrefix(input: DshTuiFrameInputMode): string {
  switch (input.kind) {
    case 'prompt': return '> '
    case 'approval': return 'decision> '
    case 'question': return 'answer> '
    case 'plan-review': return 'review> '
    case 'goal-action': return 'goal> '
  }
}

function inputComposerLabel(input: DshTuiFrameInputMode): string {
  switch (input.kind) {
    case 'prompt': return 'PROMPT'
    case 'approval': return 'PERMISSION DECISION'
    case 'question': return 'ANSWER'
    case 'plan-review': return 'PLAN REVIEW RESPONSE'
    case 'goal-action': return input.stage === 'menu' ? 'GOAL ACTION' : 'GOAL EDITOR'
  }
}

function inputNotice(
  input: DshTuiFrameInputMode,
  commandNotice: string | undefined,
  commandPending: boolean,
): string {
  if (input.kind === 'goal-action') {
    return input.error === undefined ? '' : 'Error: ' + input.error
  }
  if (input.kind === 'prompt') {
    if (commandNotice !== undefined) return 'Notice: ' + commandNotice
    return commandPending ? 'Command running' : ''
  }
  return input.error === undefined ? '' : 'Error: ' + input.error
}

export function renderDshFrame(view: DshTuiView, viewport: TerminalViewport): UiFrame {
  const columns = dimension(viewport.columns)
  const rows = dimension(viewport.rows)
  const normalizedViewport = { columns, rows }
  if (view.providerConnect !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'directory', surface => (
      renderProviderConnectFrame(view.providerConnect!, surface)
    ))
  }
  if (view.sessionInspection !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'directory', surface => (
      renderSessionInspectionFrame(view.sessionInspection!, surface)
    ))
  }
  if (view.sessionPicker !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'directory', surface => (
      renderSessionPickerFrame(view.sessionPicker!, surface)
    ))
  }
  if (view.modePicker !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'compact', surface => (
      renderModePickerFrame(view.modePicker!, surface, view.modeNotice)
    ))
  }
  if (view.skillPicker !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'directory', surface => (
      renderSkillPickerFrame(view.skillPicker!, surface)
    ))
  }
  if (view.modelPicker !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'directory', surface => (
      renderModelPickerFrame(view.modelPicker!, surface)
    ))
  }
  if (view.activityCenter !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'directory', surface => (
      renderActivityCenterFrame(view.activityCenter!, surface)
    ))
  }
  if (view.jobsActivity !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'compact', surface => (
      renderLegacyJobsActivityFrame(view.jobsActivity!, surface)
    ))
  }
  if (view.contextPanel === true) {
    const activeSessionId = view.ui.activeSessionId
    return floatingSecondaryFrame(normalizedViewport, 'compact', surface => (
      renderContextFrame(
        view.context ?? { available: false },
        activeSessionId ?? 'no-session',
        surface,
        activeSessionId === undefined ? undefined : view.ui.sessions[activeSessionId]?.compaction,
      )
    ))
  }
  if (view.commandMenu !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'palette', surface => (
      renderCommandPaletteFrame(
        view.commandMenu!,
        view.prompt,
        surface,
        view.commandNotice,
        view.commandPending === true,
      )
    ))
  }
  const sessionId = view.ui.activeSessionId
  const session = sessionId === undefined ? undefined : view.ui.sessions[sessionId]
  const identity = sessionId ?? 'no-session'
  const status = view.ui.phase === 'booting'
    ? 'booting'
    : session?.agentStatus ?? view.ui.phase
  const jobsGeneration = view.jobs?.generation ?? 0
  const jobs = view.jobs?.jobs ?? []
  const liveJobCount = jobs.filter(job => (
    job.status === 'running' || job.status === 'stopping'
  )).length
  const header = fitLine(
    'DSH-TUI · ' + identity + ' · ' + status
      + (liveJobCount === 0 ? '' : ` · JOBS ${liveJobCount}`),
    columns,
  )
  const statusline = buildStatusLine(view.model, view.context, session?.compaction, columns)
  const baseInput: DshTuiInputMode = view.input ?? { kind: 'prompt', editor: view.prompt }
  const input: DshTuiFrameInputMode = view.goalActions === undefined
    ? baseInput
    : {
        kind: 'goal-action',
        editor: view.goalActions.editor,
        stage: view.goalActions.stage,
        ...(view.goalActions.error === undefined ? {} : { error: view.goalActions.error }),
      }
  const prompt = promptProjection(input.editor, columns, inputPrefix(input))
  const timeline: FrameBlock[] = []
  const conversationNodes: ConversationNode[] = []
  if (session?.omittedRowCount !== undefined) {
    conversationNodes.push({
      kind: 'notice',
      key: 'projection-omission',
      revision: String(session.omittedRowCount),
      lines: [`… ${session.omittedRowCount} earlier projected rows omitted`],
    })
  }
  if (session !== undefined) {
    const projectedTranscript: ProjectedTranscriptNode[] = []
    for (const row of session.rows) {
      const node = transcriptConversationNode(row, columns, view.toolCards)
      if (node === undefined) continue
      timeline.push(transcriptBlock(row, columns, view.toolCards))
      projectedTranscript.push({ row, node })
    }
    conversationNodes.push(...compactTranscriptTools(
      projectedTranscript,
      view.toolDetailsExpanded === true,
    ))
    const ending = turnEndNotice(session.lastTurnEnd)
    if (ending !== undefined) conversationNodes.push(ending)
  }
  const recentJobs = jobs.slice(-3)
  const omittedJobs = jobs.length - recentJobs.length
  if (omittedJobs > 0) {
    const omittedLine = `… ${omittedJobs} earlier background jobs`
    timeline.push(boundedCard('ACTIVITY', [omittedLine], columns))
    conversationNodes.push({
      kind: 'notice',
      key: 'activity-omission',
      revision: `${jobsGeneration}:${omittedJobs}`,
      lines: [omittedLine],
    })
  }
  for (const job of recentJobs) {
    const lines = jobCardLines(job, columns)
    timeline.push(boundedCard(`ACTIVITY · ${job.id}`, lines, columns))
    conversationNodes.push({
      kind: 'activity',
      key: `activity:${job.id}:${job.startedAt}`,
      revision: [
        jobsGeneration,
        job.status,
        job.detail ?? '',
        job.finishedAt ?? '',
      ].join(':'),
      label: `ACTIVITY · ${job.id}`,
      status: jobCardStatus(job.status),
      lines,
    })
  }
  const pending = view.interaction?.pending ?? []
  const activeInteractionId = input.kind === 'approval'
    || input.kind === 'question'
    || input.kind === 'plan-review'
    ? input.interactionId
    : undefined
  const focusedIndex = activeInteractionId === undefined
    ? pending.length - 1
    : pending.findIndex(item => item.id === activeInteractionId)
  let focus: FrameBlock | undefined
  let dock: ConversationDock | undefined
  for (const [index, item] of pending.entries()) {
    const block = interactionBlock(item, columns, input, index === focusedIndex)
    if (index === focusedIndex) {
      focus = block
      dock = {
        label: item.kind === 'approval'
          ? 'PERMISSION REQUIRED · DSH'
          : planReviewOf(item.questions) === undefined ? 'QUESTION' : 'PLAN REVIEW',
        role: 'interaction',
        lines: block.plain,
        ...(item.kind === 'approval' ? { status: 'warning' as const } : {}),
      }
    } else {
      timeline.push(block)
      conversationNodes.push({
        kind: 'interaction',
        key: `interaction:${item.id}`,
        revision: `${item.kind}:${block.plain.join('\n')}`,
        label: item.kind === 'question' && planReviewOf(item.questions) !== undefined
          ? 'QUEUED PLAN REVIEW'
          : 'QUEUED ' + item.kind.toUpperCase(),
        status: 'warning',
        lines: block.plain,
      })
    }
  }
  if (view.goalActions !== undefined && focus === undefined) {
    focus = boundedCard('GOAL ACTIONS', goalActionLines(view.goalActions, columns), columns)
    dock = {
      label: 'GOAL ACTIONS',
      role: 'interaction',
      lines: focus.plain,
    }
  }
  const statuslineVisible = rows >= 5 && statusline !== undefined
  const dashboard = rows >= 7 && (dock === undefined || rows >= 14)
    ? buildWorkbenchDashboard(view.workbench, columns, rows)
    : undefined
  const dashboardLines = dashboard === undefined
    ? []
    : [...layoutConversationDashboard(dashboard, columns)]
  const notice = fitLine(inputNotice(
    input,
    view.commandNotice,
    view.commandPending === true,
  ), columns)
  const noticeVisible = notice !== ''
  const composerLabel = inputComposerLabel(input)
  const availableComposerRows = Math.max(
    1,
    rows
      - 1
      - dashboardLines.length
      - (statuslineVisible ? 1 : 0)
      - (noticeVisible ? 1 : 0)
      - (rows >= 4 ? 1 : 0),
  )
  const composerBoxed = rows >= 10 && columns >= 20 && availableComposerRows >= 3
  const composerMaxRows = Math.min(6, availableComposerRows)
  const composerLayout = layoutConversationComposer(
    input.editor.text,
    input.editor.cursor,
    inputPrefix(input),
    composerLabel,
    composerBoxed,
    columns,
    composerMaxRows,
  )
  const bodySlots = Math.max(
    0,
    rows
      - 1
      - dashboardLines.length
      - (statuslineVisible ? 1 : 0)
      - (noticeVisible ? 1 : 0)
      - composerLayout.lines.length,
  )
  const emptySession = session !== undefined
    && session.rows.length === 0
    && timeline.length === 0
    && focus === undefined
  const visibleBody = emptySession
    ? centeredBodyLines(workbenchHomeLines(normalizedViewport, view.workbench), bodySlots)
    : bodyLayoutLines(timeline, focus, bodySlots, columns)
  if (emptySession) {
    conversationNodes.push({
      kind: 'empty',
      key: 'cordis-workbench-home',
      revision: [
        columns,
        rows,
        view.workbench?.goal?.revision ?? 'none',
        view.workbench?.plan?.active ?? 'none',
        view.workbench?.plan?.pending ?? 'none',
        view.workbench?.todos?.length ?? 0,
      ].join(':'),
      lines: centeredBodyLines(workbenchHomeLines(normalizedViewport, view.workbench), bodySlots),
    })
  }
  const conversation: ConversationSurface = {
    sessionId: identity,
    bindingEpoch: view.bindingEpoch ?? 0,
    header,
    nodes: conversationNodes,
    ...(dock === undefined ? {} : { dock }),
    ...(dashboard === undefined ? {} : { dashboard }),
    ...(statusline === undefined ? {} : { statusline }),
    composer: input.editor.text,
    composerColumn: input.editor.cursor,
    composerPrefix: inputPrefix(input),
    composerLabel,
    composerBoxed,
    footer: notice,
    reasoningExpanded: view.reasoningExpanded === true,
    followRequest: view.followRequest ?? 0,
  }

  if (rows === 1) {
    return {
      title: 'DSH-TUI',
      viewport: normalizedViewport,
      lines: [header],
      conversation,
    }
  }
  if (rows === 2) {
    return {
      title: 'DSH-TUI',
      viewport: normalizedViewport,
      lines: [header, fitLine(prompt.line, columns)],
      cursor: { row: 1, column: prompt.column },
      conversation,
    }
  }
  const lines = [
    header,
    ...dashboardLines,
    ...visibleBody,
    ...(noticeVisible ? [notice] : []),
    ...composerLayout.lines,
    ...(statuslineVisible ? [statusline.text] : []),
  ].map(line => fitLine(line, columns))
  const composerStart = 1
    + dashboardLines.length
    + visibleBody.length
    + (noticeVisible ? 1 : 0)
  return {
    title: 'DSH-TUI',
    viewport: normalizedViewport,
    lines,
    cursor: {
      row: composerStart + composerLayout.cursor.row,
      column: composerLayout.cursor.column,
    },
    conversation,
  }
}
