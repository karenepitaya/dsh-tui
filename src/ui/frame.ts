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
import type { ToolBrowserView } from '../tool/browser.ts'
import type { McpCapabilityBrowserView } from '../mcp/capabilities.ts'
import {
  activeLlmAttemptChain,
  type AttemptPanelView,
  type LlmAttemptChain,
  type LlmAttemptPhase,
  type SessionLlmAttemptState,
} from '../llm/attempts.ts'
import type {
  RequestRouteEpoch,
  RoutePanelView,
} from '../llm/routes.ts'
import {
  pluginPhaseLabel,
  type RuntimeLibraryView,
  type RuntimeSettingFieldView,
} from '../runtime-library/surface.ts'
import type {
  PermissionPickerRow,
  PermissionPickerView,
} from '../permission/picker.ts'
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
import type { DshTuiAnsiColor, DshTuiSemanticRole } from './theme.ts'
import {
  secondaryModalChrome,
  secondaryModalFill,
  secondaryModalHeader,
  secondaryModalInspector,
  secondaryModalKeybar,
  secondaryModalPair,
  secondaryModalRow,
  secondaryModalSection,
  secondaryModalSplit,
  secondaryModalStyle,
  type SecondaryModalRow,
} from './modal.ts'
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
  readonly sessionFork?: SessionForkPanel
  readonly sessionInspection?: SessionInspectionPanel
  readonly sessionPicker?: SessionPickerPanel
  readonly model?: SessionModelSnapshot
  readonly modelPicker?: ModelPickerView
  readonly modePicker?: ModePickerView
  readonly skillPicker?: SkillPickerView
  readonly toolBrowser?: ToolBrowserView
  readonly mcpBrowser?: McpCapabilityBrowserView
  readonly runtimeLibrary?: RuntimeLibraryView
  readonly attemptPanel?: AttemptPanelView
  readonly routePanel?: RoutePanelView
  readonly permissionPicker?: PermissionPickerView
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
  readonly forkAvailable?: boolean
  readonly error?: string
  readonly notice?: string
}

export type SessionForkPanel = {
  readonly kind: 'confirm' | 'running'
  readonly source: SessionPickerRow
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
  /** Paint an explicit row background; secondary modals use this to mask the retained chat. */
  readonly background?: DshTuiAnsiColor
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

const COMMAND_PALETTE_COPY: Readonly<Record<string, string>> = Object.freeze({
  activity: 'Open activity',
  attempts: 'Inspect request recovery',
  compact: 'Compact context',
  connect: 'Manage providers',
  context: 'Inspect context',
  exit: 'Exit safely',
  feedback: 'Send feedback',
  goal: 'Manage goal',
  help: 'Show help',
  mcp: 'Browse MCP tools',
  mode: 'Switch Agent mode',
  model: 'Switch model',
  permission: 'Change permissions',
  plan: 'Toggle plan mode',
  route: 'Inspect model route',
  sessions: 'Browse sessions',
  settings: 'Open settings',
  skills: 'Browse skills',
  stop: 'Stop active turn',
  tools: 'Browse tools',
})

function commandPaletteDescription(
  candidate: CommandMenuView['candidates'][number],
  width: number,
): string {
  const source = COMMAND_PALETTE_COPY[candidate.command.name]
    ?? inlineText(candidate.command.description)
  return truncateToWidth(source, Math.max(0, Math.min(52, width)), '…')
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
    const descriptionWidth = columns - visibleWidth(marker + label + gap)
    const description = commandPaletteDescription(candidate, descriptionWidth)
    return fitLine(`${marker}${label}${gap}${description}`, columns)
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
  const searchLine = secondaryModalFill(`> ${editor.line}`, columns)
  const cursor = {
    row: rows - 1,
    column: Math.min(columns - 1, editor.column + 2),
  }
  if (rows === 1) {
    return secondaryModalFrame(viewport, [
      secondaryModalRow(searchLine, 'composer', { bold: true }),
    ], { ...cursor, row: 0 })
  }
  if (rows === 2) {
    return secondaryModalFrame(viewport, [
      secondaryModalRow(secondaryModalFill('', columns), 'primary'),
      secondaryModalRow(searchLine, 'composer', { bold: true }),
    ], cursor)
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
  const modalRows: SecondaryModalRow[] = [
    ...visible.map(line => secondaryModalRow(
      secondaryModalFill(line, columns),
      line.startsWith('› ')
        ? 'accent'
        : line.includes('No matches for') ? 'muted' : 'primary',
      { bold: line.startsWith('› '), selected: line.startsWith('› ') },
    )),
    ...padding.map(() => secondaryModalRow(secondaryModalFill('', columns), 'primary')),
    ...statusLines.map(line => secondaryModalRow(
      secondaryModalFill(line, columns),
      pending ? 'warning' : 'muted',
      { dim: !pending },
    )),
    secondaryModalRow(secondaryModalFill('', columns), 'primary'),
    secondaryModalRow(searchLine, 'composer', { bold: true }),
  ]
  return secondaryModalFrame(viewport, modalRows, cursor)
}

function renderPlanReviewInteractionFrame(
  item: Extract<PendingInteraction, { readonly kind: 'question' }>,
  snapshot: InteractionSnapshot,
  input: DshTuiFrameInputMode,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const review = planReviewOf(item.questions)!
  const choices = planReviewChoices(review)
  const selectedIndex = input.kind === 'plan-review' && input.interactionId === item.id
    ? input.selectedIndex
    : choices.length - 1
  const selected = choices[selectedIndex]
  const header = secondaryModalRow(
    secondaryModalHeader('Plan review', columns, interactionPosition(snapshot, item)),
    'accent',
    { bold: true },
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  const footer = secondaryModalRow(
    secondaryModalPair('  ←→ choose · Enter confirm', 'Esc discuss', columns),
    'muted',
  )
  if (rows === 2) return secondaryModalFrame(viewport, [header, footer])

  const decisionRow = (
    choice: (typeof choices)[number],
    index: number,
  ): SecondaryModalRow => {
    const selectedChoice = index === selectedIndex
    const description = choice.kind === 'discuss'
      ? 'Return to conversation'
      : choice.option.description
        ?? (choice.verdict === 'approve' ? 'Start execution' : 'Request changes')
    const tone: DshTuiSemanticRole = choice.kind === 'discuss'
      ? 'interaction'
      : choice.verdict === 'approve' ? 'success' : 'warning'
    return secondaryModalRow(
      secondaryModalPair(
        `  ${selectedChoice ? '›' : ' '}  ${inlineText(choice.label)}`,
        inlineText(description),
        columns,
      ),
      tone,
      { bold: selectedChoice || choice.kind !== 'discuss', selected: selectedChoice },
    )
  }

  if (rows <= 5) {
    const compact = selected === undefined
      ? secondaryModalRow(secondaryModalFill('  No decision available', columns), 'error')
      : decisionRow(selected, selectedIndex)
    return secondaryModalFrame(viewport, fillModalRows([
      header,
      secondaryModalRow(
        secondaryModalFill('  READY FOR DECISION', columns),
        'warning',
        { bold: true },
      ),
      compact,
    ], viewport, footer))
  }

  const planLines = safeText(review.plan)
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
  const visiblePlan = planLines.slice(0, 3)
  const omitted = planLines.length - visiblePlan.length
  const body: SecondaryModalRow[] = [
    header,
    secondaryModalRow(
      secondaryModalPair('  READY FOR DECISION', `${choices.length} choices`, columns),
      'warning',
      { bold: true },
    ),
    secondaryModalRow(secondaryModalFill('', columns), 'primary'),
    secondaryModalRow(secondaryModalSection('Plan', columns, 'read-only'), 'interaction', { bold: true }),
    ...visiblePlan.map(line => secondaryModalRow(
      secondaryModalFill(`│  ${line}`, columns),
      line.startsWith('#') ? 'telemetry' : 'primary',
      { bold: line.startsWith('#') },
    )),
    ...(omitted === 0
      ? []
      : [secondaryModalRow(
          secondaryModalFill(
            `│  … ${omitted} more plan line${omitted === 1 ? '' : 's'} in the tool card`,
            columns,
          ),
          'muted',
          { dim: true },
        )]),
    secondaryModalRow(secondaryModalFill('', columns), 'primary'),
    secondaryModalRow(secondaryModalSection('Decision', columns), 'interaction', { bold: true }),
    ...wrap(review.question, Math.max(1, columns - 4)).slice(0, 2).map(line => secondaryModalRow(
      secondaryModalFill(`  ${line}`, columns),
      'primary',
      { bold: true },
    )),
    ...choices.map(decisionRow),
    ...(input.kind === 'plan-review' && input.error !== undefined
      ? [secondaryModalRow(
          secondaryModalFill(`  Error: ${inlineText(input.error)}`, columns),
          'error',
          { bold: true },
        )]
      : []),
  ]
  return secondaryModalFrame(viewport, fillModalRows(body, viewport, footer))
}

function focusedInteraction(
  snapshot: InteractionSnapshot | undefined,
  input: DshTuiFrameInputMode,
): PendingInteraction | undefined {
  const pending = snapshot?.pending ?? []
  const activeId = input.kind === 'approval'
    || input.kind === 'question'
    || input.kind === 'plan-review'
    ? input.interactionId
    : undefined
  return activeId === undefined
    ? pending.at(-1)
    : pending.find(item => item.id === activeId) ?? pending.at(-1)
}

function approvalSelection(
  item: Extract<PendingInteraction, { readonly kind: 'approval' }>,
  input: DshTuiFrameInputMode,
): number {
  if (input.kind !== 'approval' || input.interactionId !== item.id) return 0
  const token = input.editor.text.trim().toLowerCase()
  if (token === 'y' || token === 'yes' || token === '1') return 1
  if (token === 'n' || token === 'no' || token === '0') return 0
  return input.selectedIndex ?? 0
}

function interactionPosition(
  snapshot: InteractionSnapshot,
  item: PendingInteraction,
): string {
  const index = snapshot.pending.findIndex(candidate => candidate.id === item.id)
  return `${Math.max(1, index + 1)}/${Math.max(1, snapshot.pending.length)}`
}

function fillModalRows(
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

function renderApprovalInteractionFrame(
  item: Extract<PendingInteraction, { readonly kind: 'approval' }>,
  snapshot: InteractionSnapshot,
  input: DshTuiFrameInputMode,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const position = interactionPosition(snapshot, item)
  const header = secondaryModalRow(
    secondaryModalHeader('Permission request', columns, position),
    'warning',
    { bold: true },
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  const selected = approvalSelection(item, input)
  const reason = item.reason === undefined ? 'No additional reason supplied.' : inlineText(item.reason)
  const reasonRows = wrap(reason, Math.max(1, columns - 4)).slice(0, rows >= 18 ? 3 : 1)
  const reject = secondaryModalRow(
    secondaryModalPair(
      `${selected === 0 ? '›' : ' '}  REJECT`,
      'Keep the current boundary',
      columns,
    ),
    'error',
    { bold: true, selected: selected === 0 },
  )
  const allow = secondaryModalRow(
    secondaryModalPair(
      `${selected === 1 ? '›' : ' '}  ALLOW ONCE`,
      'Permit only this tool call',
      columns,
    ),
    'success',
    { bold: true, selected: selected === 1 },
  )
  const body: SecondaryModalRow[] = [
    header,
    secondaryModalRow(
      secondaryModalFill('  One-time access · review before continuing', columns),
      'warning',
      { bold: true },
    ),
    secondaryModalRow(secondaryModalFill('', columns), 'primary'),
    secondaryModalRow(secondaryModalSection('Requested action', columns, 'This call only'), 'interaction', { bold: true }),
    secondaryModalRow(
      secondaryModalPair(`  Tool  ${inlineText(item.toolName)}`, `Call  ${inlineText(item.callId)}`, columns),
      'tool',
      { bold: true },
    ),
    secondaryModalRow(
      secondaryModalPair('  Scope  one tool call', `Audit  ${inlineText(item.approvalId)}`, columns),
      'muted',
      { dim: true },
    ),
    secondaryModalRow(secondaryModalSection('Reason', columns), 'interaction', { bold: true }),
    ...reasonRows.map(line => secondaryModalRow(secondaryModalFill(`  ${line}`, columns), 'primary')),
    secondaryModalRow(secondaryModalFill('', columns), 'primary'),
    secondaryModalRow(secondaryModalSection('Decision', columns), 'interaction', { bold: true }),
    reject,
    allow,
    ...(input.kind === 'approval' && input.error !== undefined
      ? [secondaryModalRow(secondaryModalFill(`  Error: ${inlineText(input.error)}`, columns), 'error', { bold: true })]
      : []),
  ]
  const footer = secondaryModalRow(
    secondaryModalPair('  ←→ choose · Enter confirm', 'Esc reject', columns),
    'muted',
  )
  if (rows <= 5) {
    const compactDecision = `${selected === 0 ? '›' : ' '} REJECT   ${selected === 1 ? '›' : ' '} ALLOW ONCE`
    return secondaryModalFrame(viewport, fillModalRows([
      header,
      ...(rows >= 4
        ? [secondaryModalRow(
            secondaryModalPair(`  ${inlineText(item.toolName)}`, inlineText(item.callId), columns),
            'tool',
            { bold: true },
          )]
        : []),
      secondaryModalRow(
        secondaryModalFill(`  ${compactDecision}`, columns),
        selected === 0 ? 'error' : 'success',
        { bold: true },
      ),
    ], viewport, footer))
  }
  if (rows <= 13) {
    const compactBody: SecondaryModalRow[] = [
      header,
      secondaryModalRow(
        secondaryModalFill('  One-time access · review before continuing', columns),
        'warning',
        { bold: true },
      ),
      secondaryModalRow(secondaryModalSection('Requested action', columns, 'This call only'), 'interaction', { bold: true }),
      secondaryModalRow(
        secondaryModalPair(`  Tool  ${inlineText(item.toolName)}`, `Call  ${inlineText(item.callId)}`, columns),
        'tool',
        { bold: true },
      ),
      secondaryModalRow(secondaryModalSection('Reason', columns), 'interaction', { bold: true }),
      secondaryModalRow(secondaryModalFill(`  ${reasonRows.join('')}`, columns), 'primary'),
      secondaryModalRow(secondaryModalSection('Decision', columns), 'interaction', { bold: true }),
      reject,
      allow,
    ]
    return secondaryModalFrame(viewport, fillModalRows(compactBody, viewport, footer))
  }
  return secondaryModalFrame(viewport, fillModalRows(body, viewport, footer))
}

function renderQuestionInteractionFrame(
  item: Extract<PendingInteraction, { readonly kind: 'question' }>,
  snapshot: InteractionSnapshot,
  input: DshTuiFrameInputMode,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const review = planReviewOf(item.questions)
  if (review !== undefined) return renderPlanReviewInteractionFrame(item, snapshot, input, viewport)

  const questionIndex = input.kind === 'question' && input.interactionId === item.id
    ? Math.min(input.questionIndex, Math.max(0, item.questions.length - 1))
    : 0
  const question = item.questions[questionIndex]
  const editor = input.kind === 'question' && input.interactionId === item.id
    ? input.editor
    : { text: '', cursor: 0 }
  const options = question?.options ?? []
  const optionIndex = input.kind === 'question' && input.interactionId === item.id
    ? Math.min(input.optionIndex ?? 0, options.length)
    : 0
  const selected = input.kind === 'question' && input.interactionId === item.id
    ? input.selected ?? []
    : []
  const skipped = input.kind === 'question'
    && input.interactionId === item.id
    && input.skipped === true
  const multiSelect = question?.multiSelect === true
    || (input.kind === 'question'
      && input.interactionId === item.id
      && input.multiSelect === true)
  const questionCount = Math.max(
    1,
    input.kind === 'question' && input.interactionId === item.id
      ? input.questionCount ?? item.questions.length
      : item.questions.length,
  )
  const steps = input.kind === 'question' && input.interactionId === item.id
    ? input.steps
    : undefined
  const progress = Array.from({ length: questionCount }, (_, index) => {
    if (index === questionIndex) return `◆ ${index + 1}`
    const status = steps?.[index] ?? (index < questionIndex ? 'answered' : 'pending')
    return `${status === 'answered' ? '●' : status === 'skipped' ? '–' : '○'} ${index + 1}`
  }).join('  ')
  const answered = steps?.filter(status => status === 'answered').length
    ?? Math.min(questionIndex, questionCount)
  const skippedCount = steps?.filter(status => status === 'skipped').length ?? 0
  const typeLabel = options.length === 0
    ? 'free response'
    : multiSelect ? 'multiple choice' : 'single choice'
  const header = secondaryModalRow(
    secondaryModalHeader('Answer', columns, interactionPosition(snapshot, item)),
    'accent',
    { bold: true },
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])

  const progressRow = secondaryModalRow(
    secondaryModalPair(
      `  Progress  ${progress}`,
      `${answered} answered${skippedCount === 0 ? '' : ` · ${skippedCount} skipped`}`,
      columns,
    ),
    'telemetry',
    { bold: true },
  )
  const customFocused = optionIndex === options.length
  const customPrefix = `  ${customFocused ? '›' : ' '}  ✎ `
  const customProjection = promptProjection(
    editor,
    Math.max(1, columns - visibleWidth(customPrefix)),
    '',
  )
  const customPlaceholder = options.length === 0 ? 'Type your answer' : 'Other answer'
  const customText = skipped
    ? 'Skipped'
    : editor.text === '' ? customPlaceholder : customProjection.line
  const customRow = secondaryModalRow(
    secondaryModalFill(customPrefix + customText, columns),
    skipped ? 'warning' : customFocused ? 'composer' : editor.text === '' ? 'muted' : 'composer',
    { bold: customFocused || editor.text !== '', selected: customFocused },
  )
  const optionRow = (index: number): SecondaryModalRow => {
    const option = options[index]!
    const focused = index === optionIndex
    const checked = selected.includes(option.label)
    const marker = multiSelect
      ? checked ? '☑' : '☐'
      : checked ? '◉' : '○'
    return secondaryModalRow(
      secondaryModalPair(
        `  ${focused ? '›' : ' '}  ${marker} ${inlineText(option.label)}`,
        checked ? 'selected' : '',
        columns,
      ),
      checked ? 'success' : focused ? 'accent' : 'primary',
      { bold: checked || focused, selected: focused },
    )
  }
  const focusedRow = question === undefined
    ? secondaryModalRow(secondaryModalFill('  No question payload.', columns), 'error')
    : customFocused ? customRow : optionRow(optionIndex)
  const footer = secondaryModalRow(
    secondaryModalPair(
      options.length === 0
        ? '  Enter next · Ctrl+S skip'
        : multiSelect
          ? '  ↑↓ option · Enter toggle · Tab next'
          : '  ↑↓ option · Enter choose · Tab next',
      'Esc cancel',
      columns,
    ),
    'muted',
  )
  if (rows === 2) return secondaryModalFrame(viewport, [header, footer])
  if (rows <= 5) {
    return secondaryModalFrame(viewport, fillModalRows([
      header,
      ...(rows >= 4 ? [progressRow] : []),
      focusedRow,
    ], viewport, footer))
  }

  const questionLines = question === undefined
    ? ['No question payload.']
    : wrap(question.question, Math.max(1, columns - 4)).slice(0, rows >= 10 ? 2 : 1)
  const detailRows = question?.detail === undefined || rows < 14
    ? []
    : wrap(question.detail, Math.max(1, columns - 6)).slice(0, 2).map(line => (
        secondaryModalRow(secondaryModalFill(`    ${line}`, columns), 'muted')
      ))
  const errorRows = input.kind === 'question' && input.error !== undefined
    ? [secondaryModalRow(
        secondaryModalFill(`  Error: ${inlineText(input.error)}`, columns),
        'error',
        { bold: true },
      )]
    : []
  const prefix: SecondaryModalRow[] = [
    header,
    progressRow,
    secondaryModalRow(
      secondaryModalSection(question?.header ?? 'Question', columns, typeLabel),
      'interaction',
      { bold: true },
    ),
    ...questionLines.map(line => secondaryModalRow(
      secondaryModalFill(`  ${line}`, columns),
      question === undefined ? 'error' : 'primary',
      { bold: true },
    )),
    ...detailRows,
    ...(rows >= 10
      ? [secondaryModalRow(
          secondaryModalSection(options.length === 0 ? 'Response' : 'Answers', columns),
          'interaction',
          { bold: true },
        )]
      : []),
  ]

  const available = Math.max(0, rows - 1)
  const optionSlots = Math.max(0, available - prefix.length - errorRows.length)
  const optionArea: SecondaryModalRow[] = []
  if (optionSlots > 0) {
    const optionCapacity = Math.max(0, optionSlots - 1)
    const needsOmission = options.length > optionCapacity
    const visibleCapacity = needsOmission ? Math.max(0, optionCapacity - 1) : optionCapacity
    const focus = optionIndex < options.length ? optionIndex : options.length - 1
    const start = visibleCapacity === 0
      ? 0
      : Math.min(
          Math.max(0, options.length - visibleCapacity),
          Math.max(0, focus - Math.floor(visibleCapacity / 2)),
        )
    const end = Math.min(options.length, start + visibleCapacity)
    for (let index = start; index < end; index += 1) optionArea.push(optionRow(index))
    if (needsOmission && optionCapacity > 0) {
      optionArea.push(secondaryModalRow(
        secondaryModalFill(`  … ${options.length - (end - start)} more options`, columns),
        'muted',
        { dim: true },
      ))
    }
    optionArea.push(customRow)

    const focusedDescription = optionIndex < options.length
      ? options[optionIndex]?.description
      : undefined
    if (focusedDescription !== undefined && optionArea.length < optionSlots) {
      const rowIndex = optionIndex - start
      const descriptionRow = secondaryModalRow(
        secondaryModalFill(`       ${inlineText(focusedDescription)}`, columns),
        'muted',
        { dim: true },
      )
      optionArea.splice(rowIndex + 1, 0, descriptionRow)
    }
  }

  const body = [...prefix, ...optionArea.slice(0, optionSlots), ...errorRows]
  const modalRows = fillModalRows(body, viewport, footer)
  const customRowIndex = modalRows.indexOf(customRow)
  return secondaryModalFrame(viewport, modalRows, !customFocused || skipped || customRowIndex < 0
    ? undefined
    : {
        row: customRowIndex,
        column: Math.min(columns - 1, visibleWidth(customPrefix) + customProjection.column),
      })
}

function renderInteractionFrame(
  item: PendingInteraction,
  snapshot: InteractionSnapshot,
  input: DshTuiFrameInputMode,
  viewport: TerminalViewport,
): UiFrame {
  return item.kind === 'approval'
    ? renderApprovalInteractionFrame(item, snapshot, input, viewport)
    : renderQuestionInteractionFrame(item, snapshot, input, viewport)
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

function activitySpineLine(row: ActivityCenterRow, columns: number): string {
  const depth = Math.min(4, row.depth)
  const lineage = depth === 0 ? '' : `${'│ '.repeat(depth - 1)}└─`
  return secondaryModalPair(
    `${row.selected ? '›' : ' '} ${lineage}${activityStatusMarker(row.status)} ${inlineText(row.title)}`,
    row.status.toUpperCase(),
    columns,
  )
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
  const header = secondaryModalRow(
    secondaryModalHeader('Activity', columns),
    'accent',
    { bold: true },
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])

  const tabs = view.tabs.map(tab => {
    const live = tab.live === 0 ? '' : ` · ${tab.live} LIVE`
    const label = `${tab.label.toUpperCase()} ${tab.count}${live}`
    return tab.selected ? `▰ ${label}` : label
  }).join('  │  ')
  const tabRow = secondaryModalRow(
    secondaryModalPair(`  ${tabs}`, '3 authorities', columns),
    'telemetry',
    { bold: true },
  )
  if (rows === 2) return secondaryModalFrame(viewport, [header, tabRow])

  const selected = view.rows[view.selectedIndex]
  const selectedTab = view.tabs.find(tab => tab.selected)!
  const section = secondaryModalRow(
    secondaryModalSection(
      'Operations',
      columns,
      `${view.rows.length} total · ${selectedTab.live} live`,
    ),
    'interaction',
    { bold: true },
  )
  const footer = view.confirmStop && selected !== undefined
    ? secondaryModalRow(
        secondaryModalPair(
          `  Stop ${inlineText(selected.title)}?`,
          'Enter confirm · Esc back',
          columns,
        ),
        'warning',
        { bold: true },
      )
    : secondaryModalRow(
        secondaryModalPair(
          '  ←→ section · ↑↓ move',
          'K stop · R refresh · Esc close',
          columns,
        ),
        'muted',
        { dim: true },
      )
  if (rows === 3) {
    return secondaryModalFrame(viewport, [header, tabRow, footer])
  }
  if (rows === 4) return secondaryModalFrame(viewport, [header, tabRow, section, footer])

  const status: SecondaryModalRow[] = [
    view.loading
      ? secondaryModalRow(secondaryModalFill('  Refreshing Subagent catalog…', columns), 'warning', { bold: true })
      : undefined,
    view.tab === 'subagents' && !view.subagentsAvailable
      ? secondaryModalRow(
          secondaryModalFill('  Subagent service is not mounted in this Agent composition.', columns),
          'warning',
        )
      : undefined,
    view.error === undefined
      ? undefined
      : secondaryModalRow(
          secondaryModalFill(`  Error: ${inlineText(view.error)}`, columns),
          'error',
          { bold: true },
        ),
    view.notice === undefined
      ? undefined
      : secondaryModalRow(
          secondaryModalFill(`  Notice: ${inlineText(view.notice)}`, columns),
          'success',
        ),
  ].filter((line): line is SecondaryModalRow => line !== undefined)
  const bodySlots = rows - 4
  const statusSlots = Math.min(status.length, Math.max(0, bodySlots - 1))
  const visibleStatus = status.slice(0, statusSlots)
  const operationSlots = bodySlots - visibleStatus.length
  const start = focusedWindowStart(view.rows.length, view.selectedIndex, operationSlots)
  const visibleRows = view.rows.slice(start, start + operationSlots)
  const leftColumns = Math.max(26, Math.min(50, Math.floor((columns - 3) * 0.42)))
  const authority = view.tab === 'jobs'
    ? 'JobRegistry'
    : view.tab === 'subagents' ? 'SubagentRuntime' : 'Session events'
  const control = selected === undefined
    ? 'No operation selected'
    : view.tab === 'workflows'
      ? 'Read-only from parent Session'
      : selected.stoppable
        ? view.tab === 'jobs' ? 'Stop available' : 'Interrupt available'
        : 'No live stop authority'
  const empty = view.tab === 'jobs'
    ? 'No background Jobs in this Session.'
    : view.tab === 'subagents'
      ? 'No durable Subagent descendants.'
      : 'No top-level Workflow runs in this Session.'
  const detail: readonly { readonly text: string; readonly tone: DshTuiSemanticRole; readonly bold?: boolean; readonly dim?: boolean }[] = selected === undefined
    ? []
    : [
        { text: `Selected operation  ${inlineText(selected.title)}`, tone: 'interaction', bold: true },
        { text: `State  ${inlineText(selected.status)}`, tone: activityRowTone(selected).tone, bold: true },
        { text: `Identity  ${inlineText(selected.meta)}`, tone: 'primary' },
        { text: `Authority  ${authority}`, tone: 'telemetry', bold: true },
        {
          text: `Control  ${control}`,
          tone: selected.stoppable ? 'success' : view.tab === 'workflows' ? 'warning' : 'muted',
          bold: selected.stoppable || view.tab === 'workflows',
        },
        ...selected.detail.map(line => ({
          text: `Trace  ${inlineText(line)}`,
          tone: 'muted' as const,
          dim: true,
        })),
      ]
  const operationRows = Array.from({ length: operationSlots }, (_, index): SecondaryModalRow => {
    const row = visibleRows[index]
    const detailLine = detail[index]
    const selectedRow = row !== undefined && row.selected
    if (row === undefined && index === 0 && view.rows.length === 0) {
      return secondaryModalRow(
        secondaryModalFill(`  ∅  ${empty}`, columns),
        'muted',
        { dim: true },
      )
    }
    const left = row === undefined
      ? ''
      : activitySpineLine(row, leftColumns)
    const tone = selectedRow
      ? 'accent'
      : row === undefined ? detailLine?.tone ?? 'primary' : activityRowTone(row).tone
    return secondaryModalRow(
      secondaryModalSplit(left, detailLine?.text ?? '', columns, leftColumns),
      tone,
      {
        bold: selectedRow || detailLine?.bold === true,
        dim: !selectedRow && (detailLine?.dim === true || row?.statusTone === 'inactive'),
        selected: selectedRow,
      },
    )
  })
  return secondaryModalFrame(viewport, [
    header,
    tabRow,
    section,
    ...visibleStatus,
    ...operationRows,
    footer,
  ])
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
  return brand
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

function secondaryModalFrame(
  viewport: TerminalViewport,
  rows: readonly SecondaryModalRow[],
  cursor?: UiCursor,
): UiFrame {
  return {
    title: 'DSH-TUI',
    viewport,
    lines: rows.map(row => row.text),
    lineStyles: rows.map(row => row.style),
    ...(cursor === undefined ? {} : { cursor }),
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

function contextCapacityBar(percent: number, width: number): string {
  const slots = Math.max(1, Math.floor(width))
  const filled = Math.max(0, Math.min(slots, Math.round(percent * slots / 100)))
  return '█'.repeat(filled) + '░'.repeat(slots - filled)
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
      label: 'QUICK START',
      lines: [missionLine(
        '/mode  Agent mode  ·  /goal  Start a goal  ·  /help  Commands',
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
  llmAttempts?: SessionLlmAttemptState,
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

  const activeAttempt = activeLlmAttemptChain(llmAttempts)
  const latestAttempt = activeAttempt?.attempts.at(-1)
  const attemptPosition = latestAttempt === undefined ? undefined : latestAttempt.retry + 1
  const attemptTotal = activeAttempt?.mode === 'normal'
    ? (activeAttempt.maxRetries ?? 0) + 1
    : '∞'
  const attemptTone: ConversationStatusSegment['tone'] = activeAttempt?.phase === 'backoff'
    ? 'warning'
    : 'telemetry'
  const attemptLabel = activeAttempt?.phase === 'backoff' ? 'RETRY' : 'ATTEMPT'
  const fullAttempt: ConversationStatusSegment | undefined = activeAttempt === undefined
    || latestAttempt === undefined
    || attemptPosition === undefined
    ? undefined
    : {
        text: `${attemptLabel} ${attemptPosition}/${attemptTotal}`
          + ` · ${inlineText(activeAttempt.provider)}`
          + (activeAttempt.phase === 'backoff'
            ? ` · WAIT ${formatRetryDelay(latestAttempt.delayMs)} · ${inlineText(latestAttempt.failure.code)}`
            : ' · LIVE'),
        tone: attemptTone,
      }
  const mediumAttempt: ConversationStatusSegment | undefined = activeAttempt === undefined
    || latestAttempt === undefined
    || attemptPosition === undefined
    ? undefined
    : {
        text: `${attemptLabel} ${attemptPosition}/${attemptTotal}`
          + (activeAttempt.phase === 'backoff'
            ? ` · WAIT ${formatRetryDelay(latestAttempt.delayMs)}`
            : ' · LIVE'),
        tone: attemptTone,
      }
  const compactAttempt: ConversationStatusSegment | undefined = attemptPosition === undefined
    ? undefined
    : { text: `${attemptLabel} ${attemptPosition}/${attemptTotal}`, tone: attemptTone }

  if (activeAttempt !== undefined && fullAttempt !== undefined) {
    const selectedAttempt = firstStatusLineFit([
      statusLineSegments([fullAttempt, compactCompaction, compactContext, cache]),
      statusLineSegments([fullAttempt, compactContext]),
      statusLineSegments([fullAttempt]),
      statusLineSegments([mediumAttempt, compactContext]),
      statusLineSegments([mediumAttempt]),
      statusLineSegments([compactAttempt]),
    ], columns)!
    return {
      text: selectedAttempt.text,
      tone: activeAttempt.phase === 'backoff' ? 'warning' : 'accent',
      segments: selectedAttempt.segments,
    }
  }

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

function formatRetryDelay(delayMs: number): string {
  if (delayMs < 1_000) return `${Number(delayMs.toFixed(0))}ms`
  const seconds = delayMs / 1_000
  return `${Number(seconds.toFixed(seconds < 10 ? 1 : 0))}s`
}

function attemptPhaseLabel(phase: LlmAttemptPhase): string {
  switch (phase) {
    case 'backoff': return 'BACKOFF'
    case 'requesting': return 'REQUESTING'
    case 'recovered': return 'RECOVERED'
    case 'failed': return 'FAILED'
    case 'cancelled': return 'CANCELLED'
    case 'rerouted': return 'REROUTED'
  }
}

function attemptPhaseTone(phase: LlmAttemptPhase): DshTuiSemanticRole {
  switch (phase) {
    case 'backoff': return 'warning'
    case 'requesting': return 'telemetry'
    case 'recovered': return 'success'
    case 'failed': return 'error'
    case 'cancelled': return 'muted'
    case 'rerouted': return 'interaction'
  }
}

function attemptPhaseSymbol(phase: LlmAttemptPhase): string {
  switch (phase) {
    case 'backoff': return '◆'
    case 'requesting': return '◉'
    case 'recovered': return '✓'
    case 'failed': return '×'
    case 'cancelled': return '○'
    case 'rerouted': return '↗'
  }
}

function attemptOrdinal(value: number): string {
  return String(value).padStart(2, '0')
}

function attemptPath(chain: LlmAttemptChain): string {
  const failures = chain.attempts.map(attempt => `×${attemptOrdinal(attempt.retry)}`)
  const next = (chain.attempts.at(-1)?.retry ?? 0) + 1
  return [...failures, `${attemptPhaseSymbol(chain.phase)}${attemptOrdinal(next)}`].join(' ─ ')
}

function attemptChainRow(chain: LlmAttemptChain, selected: boolean): string {
  const marker = attemptPhaseSymbol(chain.phase)
  return `${selected ? '›' : ' '} ${marker}  T${chain.turn}/S${chain.step}  ${inlineText(chain.provider)}`
}

function attemptDetailRows(chain: LlmAttemptChain | undefined): readonly {
  readonly text: string
  readonly tone: DshTuiSemanticRole
  readonly bold?: boolean
}[] {
  if (chain === undefined) return []
  const latest = chain.attempts.at(-1)
  const finiteBudget = chain.mode === 'normal'
    ? `${(chain.maxRetries ?? 0) + 1} total attempts`
    : 'unbounded retries'
  const wait = latest === undefined ? '—' : formatRetryDelay(latest.delayMs)
  const status = latest?.failure.status === undefined ? '' : ` · HTTP ${latest.failure.status}`
  return [
    { text: `Attempt path  ${attemptPath(chain)}`, tone: 'telemetry', bold: true },
    {
      text: `State  ${attemptPhaseLabel(chain.phase)}`
        + (chain.phase === 'backoff' ? ` · WAIT ${wait}` : ''),
      tone: attemptPhaseTone(chain.phase),
      bold: true,
    },
    { text: `Provider  ${inlineText(chain.provider)}`, tone: 'assistant', bold: true },
    {
      text: `Failure  ${latest === undefined ? '—' : inlineText(latest.failure.code)}${status}`,
      tone: latest === undefined ? 'muted' : 'error',
      bold: latest !== undefined,
    },
    { text: `Message  ${latest === undefined ? '—' : inlineText(latest.failure.message)}`, tone: 'primary' },
    { text: `Policy  ${inlineText(chain.mode)} · ${finiteBudget}`, tone: 'interaction' },
    { text: `Turn / step  ${chain.turn} / ${chain.step}`, tone: 'muted' },
    { text: `Retry id  ${inlineText(chain.retryId)}`, tone: 'muted' },
    ...(latest?.failure.providerRetryAfterMs === undefined ? [] : [{
      text: `Provider delay  ${formatRetryDelay(latest.failure.providerRetryAfterMs)}`,
      tone: 'warning' as const,
    }]),
    ...(latest?.failure.requestId === undefined ? [] : [{
      text: `Request id  ${inlineText(latest.failure.requestId)}`,
      tone: 'muted' as const,
    }]),
  ]
}

function renderAttemptFrame(view: AttemptPanelView, viewport: TerminalViewport): UiFrame {
  const { columns, rows } = viewport
  const active = view.rows.filter(chain => chain.phase === 'backoff' || chain.phase === 'requesting').length
  const failures = view.rows.reduce((sum, chain) => sum + chain.attempts.length, 0)
  const header = secondaryModalRow(
    secondaryModalHeader('Request attempts', columns),
    'accent',
    { bold: true },
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  const footer = secondaryModalRow(
    secondaryModalPair('  ↑↓ inspect recovery chain', 'Esc close', columns),
    'muted',
    { dim: true },
  )
  if (rows === 2) return secondaryModalFrame(viewport, [header, footer])
  const summary = secondaryModalRow(
    secondaryModalPair(
      `  ${view.rows.length + view.omittedChainCount} chains · ${failures} failed requests`,
      `${active} active`,
      columns,
    ),
    active > 0 ? 'warning' : 'telemetry',
    { bold: true },
  )
  if (rows === 3) return secondaryModalFrame(viewport, [header, summary, footer])
  const section = secondaryModalRow(
    secondaryModalSection('Recovery chains', columns, 'Attempt trace'),
    'interaction',
    { bold: true },
  )
  const bodySlots = rows - 4
  const start = focusedWindowStart(view.rows.length, view.selectedIndex, bodySlots)
  const visible = view.rows.slice(start, start + bodySlots)
  const details = attemptDetailRows(view.selected)
  const leftColumns = Math.max(24, Math.min(43, Math.floor((columns - 3) * 0.4)))
  const body = Array.from({ length: bodySlots }, (_, index): SecondaryModalRow => {
    const chain = visible[index]
    const absoluteIndex = start + index
    const selected = chain !== undefined && absoluteIndex === view.selectedIndex
    const detail = details[index]
    if (chain === undefined && detail === undefined && index === 0 && view.rows.length === 0) {
      return secondaryModalRow(
        secondaryModalSplit('  ∅  No retry history', 'No provider recovery has been scheduled.', columns, leftColumns),
        'muted',
        { dim: true },
      )
    }
    return secondaryModalRow(
      secondaryModalSplit(
        chain === undefined ? '' : attemptChainRow(chain, selected),
        detail?.text ?? '',
        columns,
        leftColumns,
      ),
      selected ? 'accent' : chain === undefined ? detail?.tone ?? 'primary' : attemptPhaseTone(chain.phase),
      { bold: selected || detail?.bold === true, selected },
    )
  })
  return secondaryModalFrame(viewport, [header, summary, section, ...body, footer])
}

function routeReasonLabel(reason: RequestRouteEpoch['reason']): string {
  switch (reason) {
    case 'initial': return 'INITIAL'
    case 'resume': return 'RESUME'
    case 'change': return 'CHANGE'
  }
}

function routeReasonTone(reason: RequestRouteEpoch['reason']): DshTuiSemanticRole {
  switch (reason) {
    case 'initial': return 'success'
    case 'resume': return 'telemetry'
    case 'change': return 'warning'
  }
}

function routeRail(view: RoutePanelView): string {
  const chronological = [...view.rows].reverse()
  const visible = chronological.slice(-6)
  const hidden = view.omittedEpochCount + chronological.length - visible.length
  const firstOrdinal = view.omittedEpochCount + chronological.length - visible.length + 1
  const parts = visible.map((epoch, index) => {
    const current = epoch.headerSeq === view.rows[0]?.headerSeq
    const symbol = current ? '◉' : epoch.reason === 'initial' ? '◆' : epoch.reason === 'resume' ? '↻' : '◇'
    return `${symbol}${String(firstOrdinal + index).padStart(2, '0')}`
  })
  return `${hidden === 0 ? '' : `…${hidden} ─ `}${parts.join(' ─ ') || '∅'}`
}

function routeEpochRow(
  epoch: RequestRouteEpoch,
  selected: boolean,
  current: boolean,
  ordinal: number,
): string {
  const symbol = current ? '◉' : epoch.reason === 'initial' ? '◆' : epoch.reason === 'resume' ? '↻' : '◇'
  return `${selected ? '›' : ' '} ${symbol}${String(ordinal).padStart(2, '0')}  ${routeReasonLabel(epoch.reason).padEnd(7)}  ${inlineText(epoch.config.provider)}/${inlineText(epoch.config.model)}`
}

function routeFieldSource(
  value: unknown,
  adapterDefault: true | undefined,
): string {
  if (adapterDefault === true) return 'adapter default'
  return value === undefined ? 'unset' : 'caller'
}

function routeDetailRows(
  selected: RequestRouteEpoch | undefined,
  currentHeaderSeq: number | undefined,
): readonly {
  readonly text: string
  readonly tone: DshTuiSemanticRole
  readonly bold?: boolean
}[] {
  if (selected === undefined) return []
  const config = selected.config
  const effortSource = routeFieldSource(
    config.reasoningEffort,
    selected.adapterDefaults?.reasoningEffort,
  )
  const maxSource = routeFieldSource(config.maxTokens, selected.adapterDefaults?.maxTokens)
  return [
    {
      text: `State  ${selected.headerSeq === currentHeaderSeq ? 'CURRENT' : 'HISTORY'}`,
      tone: selected.headerSeq === currentHeaderSeq ? 'success' : 'muted',
      bold: true,
    },
    { text: `Provider  ${inlineText(config.provider)}`, tone: 'telemetry', bold: true },
    { text: `Model  ${inlineText(config.model)}`, tone: 'primary' },
    {
      text: `Effort  ${config.reasoningEffort === undefined ? '—' : inlineText(config.reasoningEffort)} · ${effortSource}`,
      tone: 'interaction',
    },
    {
      text: `Max output  ${config.maxTokens === undefined ? '—' : formatTokenCount(config.maxTokens)} · ${maxSource}`,
      tone: 'interaction',
    },
    {
      text: `Temperature  ${config.temperature === undefined ? '—' : config.temperature}`,
      tone: 'primary',
    },
    {
      text: `Stop sequences  ${config.stop === undefined ? '—' : config.stop.length}`,
      tone: 'primary',
    },
    {
      text: `Context window  ${selected.context?.contextWindow === undefined ? 'not advertised' : formatTokenCount(selected.context.contextWindow)}`,
      tone: selected.context?.contextWindow === undefined ? 'muted' : 'success',
    },
    {
      text: `Header  ${routeReasonLabel(selected.reason)} · seq ${selected.headerSeq}`,
      tone: routeReasonTone(selected.reason),
    },
    {
      text: 'Authority  Official request/header + request/context',
      tone: 'muted',
    },
  ]
}

function renderRouteFrame(view: RoutePanelView, viewport: TerminalViewport): UiFrame {
  const { columns, rows } = viewport
  const header = secondaryModalRow(
    secondaryModalHeader('Model route', columns),
    'accent',
    { bold: true },
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  const footer = secondaryModalRow(
    secondaryModalPair('  ↑↓ inspect route epoch', 'Esc close', columns),
    'muted',
    { dim: true },
  )
  if (rows === 2) return secondaryModalFrame(viewport, [header, footer])
  const current = view.rows[0]
  const summary = secondaryModalRow(
    secondaryModalPair(
      `  ${routeRail(view)}`,
      `${view.rows.length + view.omittedEpochCount} epochs${current === undefined ? '' : ` · ${inlineText(current.config.provider)}/${inlineText(current.config.model)}`}`,
      columns,
    ),
    current === undefined ? 'muted' : 'telemetry',
    { bold: true },
  )
  if (rows === 3) return secondaryModalFrame(viewport, [header, summary, footer])
  const section = secondaryModalRow(
    secondaryModalSection('Route epochs', columns, 'Effective request'),
    'interaction',
    { bold: true },
  )
  const bodySlots = rows - 4
  const start = focusedWindowStart(view.rows.length, view.selectedIndex, bodySlots)
  const visible = view.rows.slice(start, start + bodySlots)
  const details = routeDetailRows(view.selected, current?.headerSeq)
  const leftColumns = Math.max(28, Math.min(50, Math.floor((columns - 3) * 0.44)))
  const body = Array.from({ length: bodySlots }, (_, index): SecondaryModalRow => {
    const epoch = visible[index]
    const absoluteIndex = start + index
    const selected = epoch !== undefined && absoluteIndex === view.selectedIndex
    const detail = details[index]
    if (epoch === undefined && detail === undefined && index === 0 && view.rows.length === 0) {
      return secondaryModalRow(
        secondaryModalSplit('  ∅  No route epochs recorded', 'Send a prompt to materialize the official route.', columns, leftColumns),
        'muted',
        { dim: true },
      )
    }
    const ordinal = view.omittedEpochCount + view.rows.length - absoluteIndex
    return secondaryModalRow(
      secondaryModalSplit(
        epoch === undefined ? '' : routeEpochRow(
          epoch,
          selected,
          epoch.headerSeq === current?.headerSeq,
          ordinal,
        ),
        detail?.text ?? '',
        columns,
        leftColumns,
      ),
      selected ? 'accent' : epoch === undefined ? detail?.tone ?? 'primary' : routeReasonTone(epoch.reason),
      { bold: selected || detail?.bold === true, selected },
    )
  })
  return secondaryModalFrame(viewport, [header, summary, section, ...body, footer])
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
  const occupancy = contextOccupancy(context)
  const pressure = context.pressure
  const breakdown = context.breakdown
  const usage = context.usage
  const header = secondaryModalChrome('Context', 'Pressure', columns)
  if (rows === 1) return secondaryModalFrame(normalizedViewport, [header])

  const footer = secondaryModalRow(
    secondaryModalKeybar('/compact  maintain context', columns),
    'muted',
  )
  if (!context.available) {
    return secondaryModalFrame(normalizedViewport, fillModalRows([
      header,
      secondaryModalRow(secondaryModalFill(`  Session  ${inlineText(sessionId)}`, columns), 'telemetry', { bold: true }),
      secondaryModalRow(secondaryModalFill('  Token meter offline', columns), 'warning', { bold: true }),
      secondaryModalRow(secondaryModalFill('  Official projections are not composed.', columns), 'primary'),
      secondaryModalRow(secondaryModalFill('  Local estimates remain disabled.', columns), 'muted'),
    ], normalizedViewport, footer))
  }

  const percent = occupancy?.percent
  const pressureTone: DshTuiSemanticRole = percent === undefined
    ? 'muted'
    : percent >= 95 ? 'error' : percent >= 80 ? 'warning' : 'success'
  const health = percent === undefined
    ? 'WAITING'
    : percent >= 95 ? 'CRITICAL' : percent >= 80 ? 'PRESSURE' : 'HEALTHY'
  const capacity = occupancy === undefined
    ? 'Waiting for route capacity and provider usage'
    : `~${formatTokenCount(occupancy.usedTokens)} / ${formatTokenCount(occupancy.contextWindow)}`
  const barWidth = Math.max(4, columns - 4)
  const bar = occupancy === undefined
    ? '·'.repeat(barWidth)
    : contextCapacityBar(occupancy.percent, barWidth)
  const promptSource = pressure?.projectedTokens !== undefined
    ? 'Next request'
    : pressure?.pressureTokens !== undefined ? 'Latest request' : 'No sample'
  const requestRows = [
    `System      ${breakdown === undefined ? '—' : formatTokenCount(breakdown.systemTokens)}`,
    `Tools       ${breakdown === undefined ? '—' : formatTokenCount(breakdown.toolsTokens)}`,
    `Messages    ${breakdown === undefined ? '—' : formatTokenCount(breakdown.messageTokens)}`,
    `Provider    ${pressure?.pressureTokens === undefined ? '—' : formatTokenCount(pressure.pressureTokens)}`,
  ]
  const hit = usage === undefined ? undefined : cacheHitPercent(usage)
  const providerRows = [
    `Input       ${usage === undefined ? '—' : formatTokenCount(billedInputTokens(usage))}`,
    `Output      ${usage === undefined ? '—' : formatTokenCount(usage.outputTokens)}`,
    `Cache read  ${usage === undefined ? '—' : formatTokenCount(usage.cacheReadTokens)}`,
    `Hit rate    ${hit === undefined ? '—' : `${hit}%`}`,
  ]
  const compactionText = compaction === undefined
    ? 'No maintenance recorded'
    : `${compaction.phase === 'running' ? 'Running' : 'Last: ' + compaction.phase}`
      + (compaction.shadowedItemCount === undefined || compaction.shadowedTokenCount === undefined
        ? ''
        : ` · ${compaction.shadowedItemCount} items · ~${formatTokenCount(compaction.shadowedTokenCount)}`)
  const sourceText = `Official projection · seq ${context.asOfSeq ?? 'unknown'}`
  const sessionRow = secondaryModalRow(
    secondaryModalFill(`  Session  ${inlineText(sessionId)}  ·  ${promptSource}`, columns),
    'telemetry',
    { bold: true },
  )
  const capacityRow = secondaryModalRow(
    secondaryModalPair(
      occupancy === undefined ? '  Waiting for capacity' : `  ${health} · ${occupancy.percent}%`,
      capacity,
      columns,
    ),
    pressureTone,
    { bold: true, selected: occupancy !== undefined },
  )
  const barRow = secondaryModalRow(
    secondaryModalFill(`  ${bar}`, columns),
    pressureTone,
    { bold: true },
  )
  const maintenanceHeader = secondaryModalRow(
    secondaryModalSection('Compaction', columns, 'Source of truth'),
    'interaction',
    { bold: true },
  )
  const maintenanceRow = secondaryModalRow(
    secondaryModalPair(`  Compact ${compactionText}`, sourceText, columns),
    compaction?.phase === 'running' ? 'warning' : 'muted',
  )
  const fullBody: SecondaryModalRow[] = [
    header,
    sessionRow,
    capacityRow,
    barRow,
    secondaryModalRow(
      secondaryModalSection('Request envelope', columns, 'Provider usage'),
      'interaction',
      { bold: true },
    ),
    ...requestRows.map((left, index) => secondaryModalRow(
      secondaryModalPair(`  ${left}`, providerRows[index]!, columns),
      index === 3 ? 'telemetry' : 'primary',
    )),
    maintenanceHeader,
    maintenanceRow,
  ]
  const compactRequest = `Sys ${requestRows[0]!.split(/\s+/u).at(-1)} · Tool ${requestRows[1]!.split(/\s+/u).at(-1)} · Msg ${requestRows[2]!.split(/\s+/u).at(-1)}`
  const compactUsage = `In ${providerRows[0]!.split(/\s+/u).at(-1)} · Out ${providerRows[1]!.split(/\s+/u).at(-1)} · Cache ${providerRows[2]!.split(/\s+/u).at(-1)}`
  const compactBody: SecondaryModalRow[] = [
    header,
    sessionRow,
    capacityRow,
    ...(rows >= 7 ? [barRow] : []),
    ...(rows >= 7
      ? [secondaryModalRow(
          secondaryModalSection('Request envelope', columns, 'Provider usage'),
          'interaction',
          { bold: true },
        )]
      : []),
    secondaryModalRow(
      secondaryModalPair(`  ${compactRequest}`, compactUsage, columns),
      'primary',
    ),
    secondaryModalRow(
      secondaryModalPair(`  Compact ${compactionText}`, sourceText, columns),
      compaction?.phase === 'running' ? 'warning' : 'muted',
    ),
  ]
  const body = rows >= 12 ? fullBody : compactBody
  return secondaryModalFrame(normalizedViewport, fillModalRows(body, normalizedViewport, footer))
}

function providerCredentialLabel(provider: ProviderConnectView['providers'][number]): string {
  const credential = provider.credential
  if (!credential.configured) return credential.kind
  const source = credential.source === undefined ? '' : `:${inlineText(credential.source)}`
  return `${credential.kind}${source}`
}

function providerConnectState(
  provider: ProviderConnectView['providers'][number],
): { readonly symbol: string; readonly label: string; readonly tone: DshTuiSemanticRole } {
  if (provider.connected) return { symbol: '●', label: 'connected', tone: 'success' }
  if (provider.active) return { symbol: '◆', label: 'active', tone: 'success' }
  if (provider.credential.configured) {
    return { symbol: '◐', label: 'authorized', tone: 'telemetry' }
  }
  return { symbol: '○', label: 'dormant', tone: 'muted' }
}

function providerConnectRow(
  provider: ProviderConnectView['providers'][number],
  selected: boolean,
): string {
  return `${selected ? '› ' : '  '}${inlineText(provider.name)}`
}

function providerConnectStageLabel(
  stage: Exclude<ProviderConnectView['stage'], 'providers'>,
): string {
  switch (stage) {
    case 'methods': return 'CONNECTION METHOD'
    case 'working': return 'CONNECTING'
    case 'prompt': return 'PROVIDER AUTHORIZATION'
    case 'confirm-disconnect': return 'DISCONNECT PROVIDER'
  }
}

function providerConnectDetail(
  provider: ProviderConnectView['providers'][number] | undefined,
): string[] {
  if (provider === undefined) return []
  const state = providerConnectState(provider)
  return [
    inlineText(provider.name),
    `Route  ${inlineText(provider.id)}`,
    `State  ${state.symbol} ${state.label}`,
    `Credential  ${providerCredentialLabel(provider)}`,
    `Methods  ${provider.methods.length}`,
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
        ? ['No Providers available']
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
    case 'providers': return '↑↓ move  Enter connect/reconnect  D disconnect  R refresh'
    case 'methods': return '↑↓ move  Enter start official flow'
    case 'confirm-disconnect': return 'Enter disconnect locally'
    case 'working': return 'Official Provider flow running'
    case 'prompt': return view.prompt?.kind === 'select'
      ? '↑↓ move  Enter answer'
      : 'Enter answer'
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

function providerNoticeStyle(line: string): SecondaryModalRow['style'] {
  if (line.startsWith('Error:')) return secondaryModalStyle('error', { bold: true })
  if (line.startsWith('Open:') || line.startsWith('Code:')) {
    return secondaryModalStyle('success')
  }
  return secondaryModalStyle('warning')
}

function providerDirectoryRows(
  view: ProviderConnectView,
  columns: number,
  slots: number,
): SecondaryModalRow[] {
  const notices = providerConnectNotices(view)
  const selectedProvider = view.providers[view.selectedProviderIndex]
  const detail = providerConnectDetail(selectedProvider).slice(1)
  const detailSlots = slots >= 8 ? Math.min(4, detail.length) : 0
  const detailBlockSlots = detailSlots === 0 ? 0 : detailSlots + 1
  const noticeSlots = Math.min(
    notices.length,
    Math.max(0, slots - 2 - detailBlockSlots),
  )
  const directorySlots = Math.max(0, slots - 1 - noticeSlots - detailBlockSlots)
  const body = providerConnectBody(view)
  const directoryStart = focusedWindowStart(
    body.length,
    view.selectedProviderIndex,
    directorySlots,
  )
  const visibleProviders = body.slice(directoryStart, directoryStart + directorySlots)
  const rows: SecondaryModalRow[] = notices
    .slice(Math.max(0, notices.length - noticeSlots))
    .map(line => ({ text: secondaryModalFill(`  ${line}`, columns), style: providerNoticeStyle(line) }))
  rows.push(secondaryModalRow(
    secondaryModalSection(
      'Directory',
      columns,
      view.providers.length === 0
        ? 'empty'
        : `${Math.max(1, view.selectedProviderIndex + 1)}/${view.providers.length}`,
    ),
    'interaction',
    { bold: true },
  ))
  for (let index = 0; index < directorySlots; index += 1) {
    const left = visibleProviders[index] ?? ''
    const selected = left.startsWith('› ')
    const provider = view.providers[directoryStart + index]
    const state = provider === undefined ? undefined : providerConnectState(provider)
    const tone = selected
      ? 'accent'
      : provider === undefined ? 'primary' : state!.tone
    rows.push(secondaryModalRow(
      secondaryModalPair(
        `  ${left}`,
        state === undefined ? '' : `${state.symbol} ${state.label}`,
        columns,
      ),
      tone,
      { bold: selected, selected },
    ))
  }
  if (detailSlots > 0) {
    rows.push(secondaryModalRow(
      secondaryModalInspector('Selected provider', columns),
      'interaction',
      { bold: true },
    ))
    rows.push(...detail.slice(0, detailSlots).map(line => secondaryModalRow(
      secondaryModalFill(`  ${line}`, columns),
      line.startsWith('State ') ? 'success' : 'muted',
    )))
  }
  return rows
}

/** Render the app-global `/connect` surface; secret prompts are masked here. */
export function renderProviderConnectFrame(
  view: ProviderConnectView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const header = secondaryModalChrome('Providers', 'Connections', columns)
  const footer = secondaryModalKeybar(providerConnectFooter(view), columns)
  if (rows === 1) {
    return secondaryModalFrame(viewport, [
      header,
    ])
  }
  if (rows === 2) {
    return secondaryModalFrame(viewport, [
      header,
      secondaryModalRow(footer, 'muted'),
    ])
  }
  const connected = view.providers.filter(item => item.connected).length
  const configured = view.providers.filter(item => item.credential.configured).length
  const summary = secondaryModalFill(
    `  Connected ${connected}    Ready ${configured}    Available ${view.providers.length}`,
    columns,
  )
  const showSummary = rows >= 8
  const baseRows: SecondaryModalRow[] = [
    header,
    ...(showSummary ? [secondaryModalRow(summary, 'telemetry', { bold: true })] : []),
  ]
  if (view.stage === 'providers') {
    const contentSlots = Math.max(0, rows - baseRows.length - 1)
    const directory = providerDirectoryRows(view, columns, contentSlots)
    return secondaryModalFrame(viewport, [
      ...baseRows,
      ...directory,
      secondaryModalRow(footer, 'muted'),
    ])
  }
  const section = secondaryModalSection(providerConnectStageLabel(view.stage), columns)
  const prompt = view.stage === 'prompt' ? view.prompt : undefined
  const textPrompt = prompt !== undefined && prompt.kind !== 'select' ? prompt : undefined
  const inputSlots = textPrompt === undefined ? 0 : 1
  const contentSlots = Math.max(0, rows - baseRows.length - 2 - inputSlots)
  const notices = providerConnectNotices(view)
  const bodySource = providerConnectBody(view)
  const source = view.stage === 'working'
    ? [...bodySource, ...notices]
    : [...notices, ...bodySource]
  const visible = focusedProviderLines(
    source,
    contentSlots,
    view.stage === 'working'
      ? undefined
      : providerConnectFocusIndex(view, notices.length),
  )
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
    promptLine = secondaryModalFill(projection.line, columns)
    cursor = { row: rows - 2, column: Math.min(columns - 1, projection.column) }
  }
  const bodyRows = visible.map(line => secondaryModalRow(
    secondaryModalFill(' ' + line, columns),
    line.startsWith('› ')
      ? 'accent'
      : line.startsWith('Error:')
        ? 'error'
        : line.startsWith('Open:') || line.startsWith('Code:')
          ? 'success'
          : line.startsWith('Notice:') || line.includes('…')
            ? 'warning'
            : 'primary',
    { bold: line.startsWith('› ') || line.startsWith('Error:'), selected: line.startsWith('› ') },
  ))
  return secondaryModalFrame(viewport, [
    ...baseRows,
    secondaryModalRow(section, 'interaction', { bold: true }),
    ...bodyRows,
    ...padding.map(() => secondaryModalRow(secondaryModalFill('', columns), 'primary')),
    ...(promptLine === undefined
      ? []
      : [secondaryModalRow(promptLine, 'composer', { bold: true })]),
    secondaryModalRow(footer, 'muted'),
  ], cursor)
}

function modePickerRowLine(
  row: ModePickerRow,
  selected: boolean,
  columns: number,
): string {
  const badges = [
    row.isCurrent ? 'current' : undefined,
    row.isDefault ? 'default' : undefined,
    row.trust,
    row.broken === undefined ? undefined : 'unavailable',
  ].filter((badge): badge is string => badge !== undefined)
  const marker = row.isCurrent ? '◆' : row.broken === undefined ? '○' : '!'
  return secondaryModalPair(
    `  ${selected ? '›' : ' '}  ${marker} ${inlineText(row.name ?? row.id)}`,
    badges.join(' · '),
    columns,
  )
}

function renderModePickerFrame(
  view: ModePickerView,
  viewport: TerminalViewport,
  notice?: string,
): UiFrame {
  const { columns, rows } = viewport
  const current = view.current ?? 'none'
  const selected = view.rows[view.selectedIndex]
  const header = secondaryModalChrome('Mode', 'Agent composition', columns)
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  const currentLine = secondaryModalRow(
    secondaryModalPair(
      `  Current  ${inlineText(current)}`,
      columns >= 56
        ? view.locked ? 'Turn started · locked' : 'Blank session · switchable'
        : view.locked ? 'locked' : 'switchable',
      columns,
    ),
    view.locked ? 'warning' : 'telemetry',
    { bold: true },
  )
  if (rows === 2) return secondaryModalFrame(viewport, [header, currentLine])
  const footer = secondaryModalRow(
    secondaryModalKeybar(
      view.locked
        ? 'New session required'
        : '↑↓ move  Enter apply  R refresh',
      columns,
    ),
    'muted',
  )
  if (rows === 3) return secondaryModalFrame(viewport, [header, currentLine, footer])

  const section = secondaryModalRow(
    secondaryModalSection(
      'Available compositions',
      columns,
      `${view.totalCount} · ${view.locked ? 'locked' : 'switchable'}`,
    ),
    'interaction',
    { bold: true },
  )
  const bodySlots = rows - 4
  const status: Array<{
    readonly text: string
    readonly tone: DshTuiSemanticRole
    readonly bold?: boolean
  }> = []
  const activity = [
    view.loading ? 'Refreshing mode catalog…' : undefined,
    view.selecting ? 'Applying mode composition…' : undefined,
  ].filter((line): line is string => line !== undefined)
  if (activity.length > 0) status.push({
    text: activity.join(' · '),
    tone: 'telemetry',
    bold: true,
  })
  if (view.locked) {
    status.push({
      text: 'Mode locked after the first turn · start a new session to switch',
      tone: 'warning',
    })
  }
  if (!view.available) status.push({
    text: 'Agent modes are unavailable in this composition',
    tone: 'warning',
  })
  if (view.error !== undefined) status.push({
    text: 'Error: ' + inlineText(view.error),
    tone: 'error',
    bold: true,
  })
  if (notice !== undefined) status.push({
    text: 'Notice: ' + inlineText(notice),
    tone: 'telemetry',
  })
  if (view.rows.length === 0) status.push({
    text: 'No Agent modes found',
    tone: 'muted',
  })
  const proposedDetail = selected?.description === undefined || rows < 10
    ? []
    : [secondaryModalRow(
        secondaryModalPair(
          `  Inspector / ${inlineText(selected.name ?? selected.id)}`,
          `${inlineText(selected.description)} · id ${inlineText(selected.id)}`,
          columns,
        ),
        'interaction',
        { bold: true },
      )]
  const minimumRowSlots = Math.min(3, view.rows.length)
  const detail = proposedDetail
  const statusSlots = Math.min(
    status.length,
    Math.max(0, bodySlots - detail.length - minimumRowSlots),
  )
  const rowSlots = Math.max(0, bodySlots - statusSlots - detail.length)
  const rowStart = view.rows.length <= rowSlots || view.selectedIndex < 0
    ? 0
    : Math.min(
        view.rows.length - rowSlots,
        Math.max(0, view.selectedIndex - Math.floor(rowSlots / 2)),
      )
  const visibleRows = view.rows.slice(rowStart, rowStart + rowSlots).map((row, index) => {
    const absoluteIndex = rowStart + index
    const focused = absoluteIndex === view.selectedIndex
    return secondaryModalRow(
      modePickerRowLine(row, focused, columns),
      row.broken !== undefined ? 'warning' : row.isCurrent ? 'success' : focused ? 'accent' : 'primary',
      { bold: focused || row.isCurrent, selected: focused },
    )
  })
  const visibleStatus = statusSlots === 0 ? [] : status.slice(-statusSlots)
  const body: SecondaryModalRow[] = [
    ...visibleStatus.map(item => secondaryModalRow(
      secondaryModalFill(`  ${item.text}`, columns),
      item.tone,
      { bold: item.bold === true },
    )),
    ...visibleRows,
    ...detail,
  ]
  const padding = Array.from({ length: bodySlots - body.length }, () => '')
  return secondaryModalFrame(viewport, [
    header,
    currentLine,
    section,
    ...body,
    ...padding.map(() => secondaryModalRow(secondaryModalFill('', columns), 'primary')),
    footer,
  ])
}

function permissionPickerRowLine(
  row: PermissionPickerRow,
  selected: boolean,
  columns: number,
): string {
  const badge = row.isCurrent
    ? 'current'
    : !row.selectable
      ? 'current only'
      : selected
        ? 'candidate'
        : ''
  return secondaryModalPair(
    `${selected ? '›' : ' '}  ${inlineText(row.name)}`,
    badge,
    columns,
  )
}

function renderPermissionPickerFrame(
  view: PermissionPickerView,
  viewport: TerminalViewport,
  notice?: string,
): UiFrame {
  const { columns, rows } = viewport
  const selected = view.rows[view.selectedIndex]
  const current = view.currentValue ?? 'none'
  const candidate = selected?.value ?? 'none'
  const header = secondaryModalRow(
    secondaryModalHeader('Session permissions', columns),
    'accent',
    { bold: true },
  )
  if (rows === 1) {
    return secondaryModalFrame(viewport, [header])
  }
  const rail = secondaryModalRow(
    secondaryModalPair(
      `  Current  ${inlineText(current)}`,
      `Candidate  ${inlineText(candidate)}`,
      columns,
    ),
    'telemetry',
    { bold: true },
  )
  if (rows === 2) {
    return secondaryModalFrame(viewport, [header, rail])
  }
  const stateLabel = !view.available
    ? 'Unavailable'
    : view.stale
      ? 'Stale'
      : !view.writable
        ? 'Read only'
        : view.selecting
          ? 'Applying'
          : 'Ready'
  const section = secondaryModalRow(
    secondaryModalSection('Policies', columns, `${view.totalCount} · ${stateLabel}`),
    view.stale || !view.writable ? 'warning' : 'interaction',
    { bold: true },
  )
  const footer = secondaryModalRow(secondaryModalPair(
    view.writable && !view.stale
      ? '  ↑↓ move · Enter apply'
      : '  Inspection only',
    'Esc close',
    columns,
  ), 'muted')
  if (rows === 3) {
    return secondaryModalFrame(viewport, [header, rail, footer])
  }

  const bodySlots = rows - 4
  const status = [
    view.error === undefined ? undefined : `Error: ${inlineText(view.error)}`,
    view.selecting ? 'Applying the official /permission command…' : undefined,
    view.stale ? 'Projection changed · showing the last known policy' : undefined,
    notice === undefined ? undefined : `Notice: ${inlineText(notice)}`,
    !view.available ? 'Permission presets are unavailable in this composition' : undefined,
    view.available && !view.writable
      ? 'Official write command unavailable · inspection only'
      : undefined,
    view.rows.length === 0 ? 'No permission profiles found' : undefined,
  ].filter((line): line is string => line !== undefined)
  const selectedDescription = selected?.description === undefined
    ? []
    : wrap(inlineText(selected.description), Math.max(1, columns - 4))
        .slice(0, 2)
        .map(line => secondaryModalFill(`  ${line}`, columns))
  const detail = selected === undefined
    ? []
    : [
        secondaryModalSection(
          'Selection',
          columns,
          selected.selectable ? 'can apply' : 'inspection only',
        ),
        secondaryModalPair('  Profile', inlineText(selected.value), columns),
        ...selectedDescription,
      ]
  const minimumRowCount = view.rows.length === 0 ? 0 : 1
  const statusBudget = Math.min(
    status.length,
    2,
    Math.max(0, bodySlots - minimumRowCount),
  )
  const detailBudget = Math.min(
    detail.length,
    Math.max(0, bodySlots - statusBudget - minimumRowCount),
  )
  const rowBudget = Math.max(
    0,
    bodySlots - statusBudget - detailBudget,
  )
  const boundedRowCount = Math.min(view.rows.length, rowBudget)
  const rowStart = boundedRowCount === 0 || view.rows.length <= boundedRowCount
    ? 0
    : Math.min(
        view.rows.length - boundedRowCount,
        Math.max(0, view.selectedIndex - Math.floor(boundedRowCount / 2)),
      )
  const visibleEntries = view.rows
    .slice(rowStart, rowStart + boundedRowCount)
    .map((row, index) => ({
      row,
      selected: rowStart + index === view.selectedIndex,
      line: permissionPickerRowLine(
        row,
        rowStart + index === view.selectedIndex,
        columns,
      ),
    }))
  const visibleStatus = status.slice(0, statusBudget)
  const visibleDetail = detail.slice(0, detailBudget)
  const bodyRows: SecondaryModalRow[] = [
    ...visibleStatus.map(line => secondaryModalRow(
      secondaryModalFill(`  ${line}`, columns),
      line.startsWith('Error:') ? 'error' : line.startsWith('Notice:') ? 'warning' : 'muted',
    )),
    ...visibleEntries.map(({ line, row, selected: isSelected }) => secondaryModalRow(
      line,
      isSelected ? 'accent' : row.isCurrent ? 'success' : !row.selectable ? 'warning' : 'primary',
      { bold: isSelected || row.isCurrent, selected: isSelected },
    )),
    ...visibleDetail.map((line, index) => secondaryModalRow(
      line,
      index === 0 ? 'interaction' : 'muted',
      { bold: index === 0, dim: index > 0 },
    )),
  ]
  const padding = Array.from({ length: bodySlots - bodyRows.length }, () => (
    secondaryModalRow(secondaryModalFill('', columns), 'primary')
  ))
  return secondaryModalFrame(viewport, [header, rail, section, ...bodyRows, ...padding, footer])
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

interface CapabilityLensListRow {
  readonly label: string
  readonly badge: string
}

interface CapabilityLensDetailLine {
  readonly text: string
  readonly tone: DshTuiSemanticRole
  readonly bold?: boolean
  readonly dim?: boolean
}

interface CapabilityLensOptions {
  readonly title: string
  readonly sectionLabel: string
  readonly query: PromptEditorState
  readonly rows: readonly CapabilityLensListRow[]
  readonly selectedIndex: number
  readonly summary: string
  readonly detail: readonly CapabilityLensDetailLine[]
  readonly footerLeft: string
  readonly cursorOnTwoRows: boolean
}

function capabilityLensLeftColumns(columns: number): number {
  return Math.max(18, Math.min(38, Math.floor((columns - 3) * 0.32)))
}

function renderCapabilityLensFrame(
  options: CapabilityLensOptions,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const header = secondaryModalRow(
    secondaryModalHeader(options.title, columns),
    'accent',
    { bold: true },
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])

  const searchPrefix = '  Search › '
  const editor = promptProjection(
    options.query,
    Math.max(1, columns - visibleWidth(searchPrefix)),
    '',
  )
  const search = secondaryModalRow(
    secondaryModalFill(`${searchPrefix}${editor.line}`, columns),
    'composer',
    { bold: true },
  )
  const cursor = {
    row: 1,
    column: Math.min(columns - 1, visibleWidth(searchPrefix) + editor.column),
  }
  if (rows === 2) {
    return secondaryModalFrame(
      viewport,
      [header, search],
      options.cursorOnTwoRows ? cursor : undefined,
    )
  }

  const footer = secondaryModalRow(
    secondaryModalPair(options.footerLeft, 'Esc close', columns),
    'muted',
    { dim: true },
  )
  if (rows === 3) return secondaryModalFrame(viewport, [header, search, footer], cursor)

  const section = secondaryModalRow(
    secondaryModalSection(options.sectionLabel, columns, options.summary),
    'interaction',
    { bold: true },
  )
  if (rows === 4) return secondaryModalFrame(viewport, [header, search, section, footer], cursor)

  const bodySlots = rows - 4
  const leftColumns = capabilityLensLeftColumns(columns)
  const start = focusedWindowStart(options.rows.length, options.selectedIndex, bodySlots)
  const visible = options.rows.slice(start, start + bodySlots)
  const body: SecondaryModalRow[] = []
  for (let index = 0; index < bodySlots; index += 1) {
    const absolute = start + index
    const item = visible[index]
    const selected = item !== undefined && absolute === options.selectedIndex
    const detail = options.detail[index]
    const left = item === undefined
      ? ''
      : secondaryModalPair(
          `${selected ? '›' : ' '} ${item.label}`,
          item.badge,
          leftColumns,
        )
    body.push(secondaryModalRow(
      secondaryModalSplit(left, detail?.text ?? '', columns, leftColumns),
      detail?.tone === 'error' ? 'error' : selected ? 'accent' : detail?.tone ?? 'primary',
      {
        bold: selected || detail?.bold === true,
        dim: !selected && detail?.dim === true,
        selected,
      },
    ))
  }
  return secondaryModalFrame(viewport, [header, search, section, ...body, footer], cursor)
}

function skillPickerDetailLines(
  view: SkillPickerView,
  columns: number,
): CapabilityLensDetailLine[] {
  const selected = view.rows[view.selectedIndex]
  const status: CapabilityLensDetailLine[] = []
  if (view.error !== undefined) {
    status.push({ text: `Error  ${inlineText(view.error)}`, tone: 'error', bold: true })
  }
  if (view.loading) {
    status.push({ text: 'Refreshing catalog…', tone: 'warning', bold: true })
  }
  if (!view.complete) {
    status.push({
      text: view.stale
        ? 'Catalog changed · showing the last complete view'
        : 'Catalog discovery is incomplete',
      tone: 'warning',
    })
  }
  if (!view.available) {
    return [
      ...status,
      { text: 'Skills are unavailable in this Agent composition', tone: 'muted', dim: true },
    ]
  }
  if (selected === undefined) {
    return [
      ...status,
      {
        text: view.query.text.trim() === '' ? 'No user-invocable skills' : 'No matching skills',
        tone: 'muted',
        dim: true,
      },
    ]
  }
  const width = Math.max(1, columns)
  const resource = skillResourceLabel(selected.resourceBase)
  return [
    ...status,
    { text: `Selected  /${inlineText(selected.name)}`, tone: 'interaction', bold: true },
    ...wrap(`About  ${inlineText(selected.description)}`, width).slice(0, 2)
      .map(text => ({ text, tone: 'primary' as const })),
    ...(selected.whenToUse === undefined
      ? []
      : wrap(`When  ${inlineText(selected.whenToUse)}`, width).slice(0, 2)
          .map(text => ({ text, tone: 'primary' as const }))),
    {
      text: `Invoke  user ✓ · model ${selected.modelInvocable ? '✓' : '—'}`,
      tone: 'success',
      bold: true,
    },
    {
      text: `Source  ${inlineText(selected.source)} · ${inlineText(selected.provider)}`,
      tone: 'muted',
      dim: true,
    },
    ...(resource === undefined
      ? []
      : [{ text: `Base  ${inlineText(resource)}`, tone: 'muted' as const, dim: true }]),
  ]
}

function renderSkillPickerFrame(
  view: SkillPickerView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const leftColumns = capabilityLensLeftColumns(columns)
  const rightColumns = Math.max(1, columns - leftColumns - 3)
  return renderCapabilityLensFrame({
    title: 'Skills',
    sectionLabel: 'Capabilities',
    query: view.query,
    rows: view.rows.map(skill => ({
      label: `/${inlineText(skill.name)}`,
      badge: skill.modelInvocable ? 'user+model' : 'user',
    })),
    selectedIndex: view.selectedIndex,
    summary: `${view.rows.length}/${view.totalCount} · exact Agent${view.loading ? ' · sync' : ''}`,
    detail: skillPickerDetailLines(view, rightColumns),
    footerLeft: '  ↑↓ move · Enter insert',
    cursorOnTwoRows: true,
  }, { columns, rows })
}

function toolGroupLabel(group: ToolBrowserView['rows'][number]['group']): string {
  switch (group) {
    case 'core': return 'Core'
    case 'mcp': return 'MCP'
    case 'transport': return 'Code transport'
  }
}

function renderToolBrowserFrame(
  view: ToolBrowserView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const selected = view.selected
  const required = new Set(selected?.requiredParameterNames ?? [])
  const leftColumns = capabilityLensLeftColumns(columns)
  const detailWidth = Math.max(1, columns - leftColumns - 3)
  const parameters = selected?.parameterNames.map(name => (
    required.has(name) ? `${inlineText(name)}*` : inlineText(name)
  )).join(', ')
  const detail: CapabilityLensDetailLine[] = []
  if (view.error !== undefined) {
    detail.push({ text: `Error  ${inlineText(view.error)}`, tone: 'error', bold: true })
    if (view.stale) detail.push({ text: 'Showing last good catalog', tone: 'warning' })
  }
  if (selected === undefined) {
    detail.push({
      text: view.available ? 'No matching capabilities' : 'Capability registry unavailable',
      tone: 'muted',
      dim: true,
    })
  } else {
    detail.push(
      { text: `Selected  ${inlineText(selected.name)}`, tone: 'interaction', bold: true },
      ...wrap(`About  ${inlineText(selected.description)}`, detailWidth).slice(0, 3)
        .map(text => ({ text, tone: 'primary' as const })),
      { text: `Kind  ${toolGroupLabel(selected.group)}`, tone: 'telemetry', bold: true },
      {
        text: `Inputs  ${selected.requiredParameterNames.length} required · ${selected.parameterNames.length} total`,
        tone: 'primary',
      },
      ...wrap(`Params  ${parameters === '' ? 'none' : parameters}`, detailWidth).slice(0, 2)
        .map(text => ({ text, tone: 'muted' as const, dim: true })),
      {
        text: `Scope  exact Agent · generation ${view.generation}`,
        tone: 'muted',
        dim: true,
      },
    )
  }

  return renderCapabilityLensFrame({
    title: 'Tools',
    sectionLabel: 'Capabilities',
    query: view.query,
    rows: view.rows.map(tool => ({
      label: inlineText(tool.name),
      badge: toolGroupLabel(tool.group),
    })),
    selectedIndex: view.selectedIndex,
    summary: `${view.rows.length}/${view.totalCount} · exact Agent · gen ${view.generation}`,
    detail,
    footerLeft: '  ↑↓ move · read only',
    cursorOnTwoRows: false,
  }, { columns, rows })
}

function renderMcpCapabilityFrame(
  view: McpCapabilityBrowserView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const selected = view.selected
  const required = new Set(selected?.requiredParameterNames ?? [])
  const leftColumns = capabilityLensLeftColumns(columns)
  const detailWidth = Math.max(1, columns - leftColumns - 3)
  const parameters = selected?.parameterNames.map(name => (
    required.has(name) ? `${inlineText(name)}*` : inlineText(name)
  )).join(', ')
  const detail: CapabilityLensDetailLine[] = []
  if (view.error !== undefined) {
    detail.push({ text: `Error  ${inlineText(view.error)}`, tone: 'error', bold: true })
  }
  if (view.stale) {
    detail.push({ text: 'Showing last good ToolRuntime view', tone: 'warning' })
  }
  if (selected === undefined) {
    detail.push({
      text: !view.available
        ? 'ToolRuntime capabilities are unavailable'
        : view.query.text.trim() === ''
          ? 'No MCP capabilities mounted on this Agent'
          : 'No matching MCP capabilities',
      tone: 'muted',
      dim: true,
    })
  } else {
    detail.push(
      { text: `Namespace  ${inlineText(selected.serverName)}`, tone: 'interaction', bold: true },
      { text: `Tool  ${inlineText(selected.toolName)}`, tone: 'telemetry', bold: true },
      ...wrap(`About  ${inlineText(selected.description)}`, detailWidth).slice(0, 3)
        .map(text => ({ text, tone: 'primary' as const })),
      {
        text: `Inputs  ${selected.requiredParameterNames.length} required · ${selected.parameterNames.length} total`,
        tone: 'primary',
      },
      ...wrap(`Params  ${parameters === '' ? 'none' : parameters}`, detailWidth).slice(0, 2)
        .map(text => ({ text, tone: 'muted' as const, dim: true })),
      {
        text: `Mounted  exact Agent · generation ${view.generation}`,
        tone: 'success',
        bold: true,
      },
      { text: 'Health  Cordis-owned · not inferred', tone: 'muted', dim: true },
    )
  }
  return renderCapabilityLensFrame({
    title: 'MCP capabilities',
    sectionLabel: 'Mounted tools',
    query: view.query,
    rows: view.rows.map(tool => ({
      label: inlineText(tool.toolName),
      badge: inlineText(tool.serverName),
    })),
    selectedIndex: view.selectedIndex,
    summary: `${view.rows.length}/${view.totalCount} tools · ${view.namespaceCount} namespaces · exact Agent`,
    detail,
    footerLeft: '  ↑↓ move · type filter',
    cursorOnTwoRows: false,
  }, { columns, rows })
}

function runtimeValueLabel(field: RuntimeSettingFieldView): string {
  if (field.source === 'secret') return field.secretSet === true ? 'configured' : 'not set'
  try {
    const value = JSON.stringify(field.value)
    return inlineText(value === undefined ? 'undefined' : value)
  } catch {
    return 'unprintable'
  }
}

function runtimeFieldTone(field: RuntimeSettingFieldView): DshTuiSemanticRole {
  if (field.selected) return 'accent'
  switch (field.source) {
    case 'user': return 'success'
    case 'base': return 'telemetry'
    case 'secret': return 'warning'
    case 'default': return 'muted'
  }
}

function runtimeSettingsDetail(view: RuntimeLibraryView): CapabilityLensDetailLine[] {
  const lines: CapabilityLensDetailLine[] = []
  if (view.settings.error !== undefined) {
    lines.push({ text: `Error  ${inlineText(view.settings.error)}`, tone: 'error', bold: true })
  }
  if (view.settings.stale) {
    lines.push({ text: 'Showing last good redacted descriptor', tone: 'warning', bold: true })
  }
  const selected = view.settings.selected
  if (selected === undefined) {
    lines.push({
      text: view.settings.available
        ? view.query.text.trim() === '' ? 'No registered settings namespaces' : 'No matching namespaces'
        : 'Settings service is unavailable',
      tone: 'muted',
      dim: true,
    })
    return lines
  }
  const defaults = selected.fields.filter(field => field.source === 'default').length
  const bases = selected.fields.filter(field => field.source === 'base').length
  const users = selected.fields.filter(field => field.source === 'user').length
  const secrets = selected.fields.filter(field => field.source === 'secret').length
  lines.push(
    { text: `Layer stack  ${inlineText(selected.namespace)}`, tone: 'interaction', bold: true },
    { text: `○ DEFAULT     ${defaults} inherited`, tone: 'muted', dim: true },
    { text: `◇ BASE        ${bases} composed`, tone: 'telemetry', bold: bases > 0 },
    { text: `◆ USER        ${users} override${users === 1 ? '' : 's'}`, tone: users > 0 ? 'success' : 'muted', bold: users > 0 },
    ...(secrets === 0 ? [] : [{ text: `◈ SECRET      ${secrets} redacted slot${secrets === 1 ? '' : 's'}`, tone: 'warning' as const, bold: true }]),
    {
      text: `● EFFECTIVE   ${selected.applies.toUpperCase()} · R${selected.revision}`,
      tone: selected.applies === 'live' ? 'success' : 'warning',
      bold: true,
    },
    { text: 'Field map', tone: 'interaction', bold: true },
    ...selected.fields.map(field => ({
      text: `${field.selected ? '›' : ' '} ${field.source.toUpperCase().padEnd(7)} ${inlineText(field.pathLabel)}  ${runtimeValueLabel(field)}`,
      tone: runtimeFieldTone(field),
      bold: field.selected,
      dim: field.source === 'default' && !field.selected,
    })),
  )
  return lines
}

function runtimePluginsDetail(view: RuntimeLibraryView): CapabilityLensDetailLine[] {
  const lines: CapabilityLensDetailLine[] = []
  if (view.plugins.error !== undefined) {
    lines.push({ text: `Error  ${inlineText(view.plugins.error)}`, tone: 'error', bold: true })
  }
  const selected = view.plugins.selected
  if (selected === undefined) {
    lines.push({
      text: view.plugins.available
        ? view.query.text.trim() === '' ? 'No Loader plugin entries' : 'No matching Loader entries'
        : 'Loader inventory is unavailable',
      tone: 'muted',
      dim: true,
    })
    return lines
  }
  const phase = pluginPhaseLabel(selected.fiberPhase)
  const phaseSymbol = selected.fiberPhase === 'active'
    ? '●'
    : selected.fiberPhase === 'failed' ? '×' : selected.fiberPhase === null ? '○' : '◐'
  const lifecycle = `CONFIGURED  ━━━  ${selected.enabled ? 'ENABLED' : 'DISABLED'}  ━━━  ${phaseSymbol} ${phase.toUpperCase()}`
  lines.push(
    { text: 'Lifecycle rail', tone: 'interaction', bold: true },
    {
      text: lifecycle,
      tone: selected.fiberPhase === 'failed'
        ? 'error'
        : selected.enabled && selected.fiberPhase === 'active' ? 'success' : 'warning',
      bold: true,
    },
    { text: `Module  ${inlineText(selected.moduleName)}`, tone: 'primary', bold: true },
    { text: `Entry   ${inlineText(selected.entryId)}`, tone: 'telemetry' },
    { text: `Config  ${selected.enabled ? 'enabled' : 'disabled'}`, tone: selected.enabled ? 'success' : 'warning' },
    { text: `Fiber   ${phaseSymbol} ${phase}`, tone: selected.fiberPhase === 'failed' ? 'error' : 'primary' },
    { text: '', tone: 'primary' },
    { text: 'Authority  Loader snapshot · read only', tone: 'muted', dim: true },
    { text: 'Not projected  provenance · history · health', tone: 'muted', dim: true },
  )
  return lines
}

function runtimeLibraryFooter(view: RuntimeLibraryView): string {
  if (view.pending) return 'Settings write in progress · Esc close'
  if (view.tab === 'plugins') return '↑↓ plugin · Enter refresh · Tab settings · Esc close'
  if (view.focus === 'editor') return 'Type JSON · Enter apply · Esc cancel'
  if (view.focus === 'detail') return '↑↓ field · Enter edit · Ctrl+S inherit · Esc namespaces'
  return '↑↓ namespace · Enter fields · Tab plugins · Esc close'
}

function runtimeLibraryListRow(
  view: RuntimeLibraryView,
  index: number,
  columns: number,
): { readonly text: string; readonly selected: boolean } | undefined {
  if (view.tab === 'settings') {
    const row = view.settings.rows[index]
    if (row === undefined) return undefined
    const badge = `${row.applies === 'live' ? '● LIVE' : '◐ RESTART'} · U${row.overrideCount} · S${row.secretCount}`
    return {
      text: secondaryModalPair(`${row.selected ? '▰' : ' '} ${inlineText(row.namespace)}`, badge, columns),
      selected: row.selected,
    }
  }
  const row = view.plugins.rows[index]
  if (row === undefined) return undefined
  const phase = pluginPhaseLabel(row.fiberPhase)
  const phaseSymbol = row.fiberPhase === 'active'
    ? '●'
    : row.fiberPhase === 'failed' ? '×' : row.fiberPhase === null ? '○' : '◐'
  const badge = row.enabled ? `${phaseSymbol} ${phase.toUpperCase()}` : '○ OFF'
  return {
    text: secondaryModalPair(`${row.selected ? '▰' : ' '} ${inlineText(row.entryId)}`, badge, columns),
    selected: row.selected,
  }
}

function renderRuntimeLibraryFrame(
  view: RuntimeLibraryView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const header = secondaryModalRow(
    secondaryModalHeader('Runtime library', columns),
    'accent',
    { bold: true },
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  const settingsOverrides = view.settings.rows.reduce((total, row) => total + row.overrideCount, 0)
  const settingsTab = `${view.tab === 'settings' ? '▰' : ' '} SETTINGS ${view.settings.totalCount} · U${settingsOverrides}`
  const pluginsTab = `${view.tab === 'plugins' ? '▰' : ' '} PLUGINS ${view.plugins.totalCount} · ${view.plugins.activeCount} ACTIVE`
  const tabs = secondaryModalRow(
    secondaryModalPair(`  ${settingsTab}    ${pluginsTab}`, 'APP GLOBAL', columns),
    'telemetry',
    { bold: true },
  )
  if (rows === 2) return secondaryModalFrame(viewport, [header, tabs])

  const editing = view.focus === 'editor' && view.editor !== undefined
  const inputState = editing ? view.editor!.input : view.query
  const inputPrefix = editing
    ? `  ${view.editor!.secret ? 'Secret JSON' : 'Value JSON'} › `
    : '  Search › '
  const inputProjection = promptProjection(
    inputState,
    Math.max(1, columns - visibleWidth(inputPrefix)),
    '',
  )
  const input = secondaryModalRow(
    secondaryModalFill(`${inputPrefix}${inputProjection.line}`, columns),
    editing ? 'warning' : view.focus === 'catalog' ? 'composer' : 'muted',
    { bold: editing || view.focus === 'catalog' },
  )
  const cursor: UiCursor | undefined = editing || view.focus === 'catalog'
    ? { row: 2, column: Math.min(columns - 1, visibleWidth(inputPrefix) + inputProjection.column) }
    : undefined
  if (rows === 3) return secondaryModalFrame(viewport, [header, tabs, input], cursor)

  const leftColumns = Math.max(24, Math.min(44, Math.floor((columns - 3) * 0.37)))
  const selectedCount = view.tab === 'settings' ? view.settings.rows.length : view.plugins.rows.length
  const totalCount = view.tab === 'settings' ? view.settings.totalCount : view.plugins.totalCount
  const authority = view.tab === 'settings'
    ? `${view.settings.writable ? 'WRITE' : 'READ'} · ${view.settings.documentBacked ? 'USER FILE' : 'MEMORY'} · G${view.settings.generation}`
    : `READ · ${view.plugins.failedCount} FAILED`
  const section = secondaryModalRow(
    secondaryModalSplit(
      secondaryModalPair(
        view.tab === 'settings' ? '  Namespaces' : '  Loader entries',
        `${selectedCount}/${totalCount}`,
        leftColumns,
      ),
      secondaryModalPair(
        view.tab === 'settings' ? '  Layer stack' : '  Lifecycle rail',
        authority,
        Math.max(1, columns - leftColumns - 3),
      ),
      columns,
      leftColumns,
    ),
    'interaction',
    { bold: true },
  )
  const footer = secondaryModalRow(
    secondaryModalFill(`  ${runtimeLibraryFooter(view)}`, columns),
    'muted',
    { dim: true },
  )
  if (rows === 4) return secondaryModalFrame(viewport, [header, tabs, input, footer], cursor)

  const bodySlots = rows - 5
  const selectedIndex = view.tab === 'settings'
    ? Math.max(0, view.settings.rows.findIndex(row => row.selected))
    : Math.max(0, view.plugins.rows.findIndex(row => row.selected))
  const listCount = view.tab === 'settings' ? view.settings.rows.length : view.plugins.rows.length
  const start = focusedWindowStart(listCount, selectedIndex, bodySlots)
  const detail = view.tab === 'settings'
    ? runtimeSettingsDetail(view)
    : runtimePluginsDetail(view)
  if (view.notice !== undefined) {
    detail.unshift({ text: `Saved  ${inlineText(view.notice)}`, tone: 'success', bold: true })
  }
  if (view.error !== undefined) {
    detail.unshift({ text: `Error  ${inlineText(view.error)}`, tone: 'error', bold: true })
  }
  if (view.pending) {
    detail.unshift({ text: 'Writing through official SettingsProvider…', tone: 'warning', bold: true })
  }
  const body: SecondaryModalRow[] = []
  for (let index = 0; index < bodySlots; index += 1) {
    const list = runtimeLibraryListRow(view, start + index, leftColumns)
    const item = detail[index]
    body.push(secondaryModalRow(
      secondaryModalSplit(list?.text ?? '', item?.text ?? '', columns, leftColumns),
      item?.tone === 'error'
        ? 'error'
        : list?.selected === true && view.focus === 'catalog'
          ? 'accent'
          : item?.tone ?? (list?.selected === true ? 'telemetry' : 'primary'),
      {
        bold: list?.selected === true || item?.bold === true,
        dim: list?.selected !== true && item?.dim === true,
        selected: list?.selected === true && view.focus === 'catalog',
      },
    ))
  }
  return secondaryModalFrame(viewport, [header, tabs, input, section, ...body, footer], cursor)
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

function modelPickerStatusPriority(line: string): number {
  if (line.startsWith('Error:')) return 0
  if (line.startsWith('Read-only:')) return 1
  if (line.includes(' failed:')) return 2
  if (line.includes('unroutable')) return 3
  if (line.includes('Refreshing') || line.includes('Switching')) return 4
  return 5
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
  let start = selectedIndex < 0
    ? 0
    : Math.min(maxStart, Math.max(0, selectedIndex - count + 1))
  if (selectedIndex >= 0) {
    let groupIndex = -1
    for (let index = selectedIndex; index >= 0; index -= 1) {
      if (lines[index]!.text.startsWith('GROUP · ')) {
        groupIndex = index
        break
      }
    }
    if (groupIndex >= 0 && selectedIndex - groupIndex < count) {
      start = Math.min(maxStart, groupIndex)
    }
  }
  return lines.slice(start, start + count).map(line => line.text)
}

function modelPickerFooter(view: ModelPickerView): {
  readonly actions: string
  readonly escape: string
} {
  const shared = '↑↓ move  R refresh'
  if (!view.writable) {
    return {
      actions: `Read-only  ${shared}`,
      escape: view.stage === 'reasoning' ? 'Esc back' : 'Esc close',
    }
  }
  return view.stage === 'reasoning'
    ? {
        actions: `Reasoning  ${shared}  Enter switch  Ctrl+S switch+default`,
        escape: 'Esc back',
      }
    : {
        actions: `Models  ${shared}  Enter/Ctrl+S reasoning/select`,
        escape: 'Esc close',
      }
}

function modelPickerSelectedRow(view: ModelPickerView): ModelPickerModelRow | undefined {
  if (view.selectedModel === undefined) return undefined
  return view.groups
    .flatMap(group => group.models)
    .find(row => sameModelIdentity(
      { provider: row.provider, model: row.id },
      view.selectedModel,
    ))
}

function focusedWindowStart(count: number, selectedIndex: number, slots: number): number {
  if (count <= slots || selectedIndex < 0) return 0
  return Math.min(count - slots, Math.max(0, selectedIndex - Math.floor(slots / 2)))
}

function modelPickerDirectoryFrame(
  view: ModelPickerView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const header = secondaryModalChrome(
    'Models',
    view.stage === 'reasoning' ? 'Reasoning effort' : 'Route selection',
    columns,
  )
  const current = view.current === undefined
    ? 'none'
    : modelIdentity(view.current.provider, view.current.model)
  const modelCount = view.groups.reduce((total, group) => total + group.models.length, 0)
  const summary = secondaryModalFill(
    `  Current  ${current}    ${view.groups.length} providers    ${modelCount} models`,
    columns,
  )
  const statuses = [...modelPickerStatusLines(view)]
    .sort((left, right) => modelPickerStatusPriority(left) - modelPickerStatusPriority(right))
  const footerCopy = modelPickerFooter(view)
  const footer = secondaryModalKeybar(footerCopy.actions, columns, footerCopy.escape)
  const statusSlots = Math.min(statuses.length, Math.max(0, Math.min(3, rows - 8)))
  const selected = modelPickerSelectedRow(view)
  const selectedEffort = view.efforts[view.selectedEffortIndex]
  const detailLines = view.stage === 'reasoning'
    ? [
        selected === undefined ? 'No model selected' : inlineText(selected.name),
        selected === undefined ? '' : `Route  ${modelIdentity(selected.provider, selected.id)}`,
        selectedEffort === undefined
          ? 'No reasoning option'
          : selectedEffort.kind === 'provider-default'
            ? 'Provider decides effort'
            : inlineText(selectedEffort.description ?? selectedEffort.name),
        selectedEffort?.isDefault === true ? 'Default option' : '',
      ].filter(line => line !== '')
    : modelPickerDetailLines(view).filter(line => line !== 'DETAIL')
  const detailSlots = rows >= 14 ? Math.min(4, detailLines.length) : 0
  const detailBlockSlots = detailSlots === 0 ? 0 : detailSlots + 1
  const listSlots = Math.max(1, rows - 4 - statusSlots - detailBlockSlots)
  const display = modelPickerDisplayLines(view, true)
  const fallback = view.stage === 'reasoning'
    ? '  No reasoning options available'
    : '  No models available'
  const visible = display.length === 0
    ? [fallback]
    : visibleModelPickerLines(display, listSlots)
  const modalRows: SecondaryModalRow[] = [
    header,
    secondaryModalRow(summary, 'telemetry', { bold: true }),
    ...statuses.slice(0, statusSlots).map(line => secondaryModalRow(
      secondaryModalFill(`  ${line}`, columns),
      line.startsWith('Error:') || line.includes('failed:')
        ? 'error'
        : line.startsWith('Read-only:') ? 'warning' : 'telemetry',
      { bold: line.startsWith('Error:') },
    )),
    secondaryModalRow(
      secondaryModalSection(
        view.stage === 'reasoning' ? 'Reasoning options' : 'Catalog',
        columns,
        view.writable ? undefined : 'read-only',
      ),
      view.writable ? 'interaction' : 'warning',
      { bold: true },
    ),
  ]
  for (let index = 0; index < listSlots; index += 1) {
    const line = visible[index] ?? ''
    const group = line.startsWith('GROUP · ')
    const content = group ? line.slice('GROUP · '.length) : line
    const selectedLine = content.startsWith('› ')
    modalRows.push(secondaryModalRow(
      group
        ? secondaryModalSection(content, columns)
        : secondaryModalFill(`  ${content}`, columns),
      selectedLine ? 'accent' : group ? 'interaction' : 'primary',
      { bold: selectedLine || group, selected: selectedLine },
    ))
  }
  if (detailSlots > 0) {
    modalRows.push(secondaryModalRow(
      secondaryModalInspector(
        view.stage === 'reasoning' ? 'Selected effort' : 'Selected model',
        columns,
      ),
      'interaction',
      { bold: true },
    ))
    modalRows.push(...detailLines.slice(0, detailSlots).map((line, index) => secondaryModalRow(
      secondaryModalFill(`  ${line}`, columns),
      index === 0 ? 'accent' : line.startsWith('State ') && line.includes('unroutable')
        ? 'warning'
        : 'muted',
      { bold: index === 0 },
    )))
  }
  modalRows.push(secondaryModalRow(footer, 'muted'))
  return secondaryModalFrame(viewport, modalRows)
}

function renderModelPickerFrame(
  view: ModelPickerView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  if (columns >= 72 && rows >= 10) return modelPickerDirectoryFrame(view, viewport)
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
  const footerCopy = modelPickerFooter(view)
  const footer = deckRule(
    `${footerCopy.actions}  ${footerCopy.escape}`,
    columns,
    'bottom',
  )
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

function sessionPickerStatusLines(panel: SessionPickerPanel, columns: number): string[] {
  const lines: string[] = []
  const prefixed = (label: string, value: string): string[] => inlineText(value)
    .split(/;\s+/u)
    .flatMap(part => wrap(
      part,
      Math.max(1, columns - visibleWidth(label) - 4),
    ))
    .slice(0, 2)
    .map(line => label + line)
  if (panel.error !== undefined) lines.push(...prefixed('Error: ', panel.error))
  if (panel.loading) lines.push('Loading sessions…')
  if (panel.view.durability === 'unavailable') {
    lines.push('Live sessions only · durable storage unavailable')
  }
  if (!panel.loaded && !panel.loading) lines.push('Session catalog not loaded')
  if (panel.notice !== undefined) lines.push(...prefixed('Notice: ', panel.notice))
  if (panel.loaded && !panel.loading && panel.view.rows.length === 0) {
    lines.push('No sessions found')
  }
  return lines
}

function normalizedPickerSelection(view: SessionPickerView): number {
  return Math.min(view.rows.length - 1, Math.max(0, view.selectedIndex))
}

function sessionPickerOpenLabel(
  liveActivation: boolean,
  inspection: boolean,
): string {
  return liveActivation
    ? inspection ? 'Enter switch/inspect' : 'Enter switch/explain'
    : inspection ? 'Enter inspect/explain' : 'Enter open'
}

function sessionPickerBadge(row: SessionPickerRow): string {
  if (row.relation === 'current') return 'current'
  if (row.relation === 'cold') return 'cold'
  return row.liveStatus ?? 'live'
}

function sessionPickerRowLine(
  row: SessionPickerRow,
  selected: boolean,
  columns: number,
): string {
  return secondaryModalPair(
    `${selected ? '›' : ' '}  ${inlineText(row.sessionId)}`,
    sessionPickerBadge(row),
    columns,
  )
}

function sessionPickerAction(
  row: SessionPickerRow,
  liveActivation: boolean,
  inspection: boolean,
): string {
  if (row.relation === 'current') return 'Already open'
  if (row.relation === 'other-live' && liveActivation) return 'Switch to live session'
  if (inspection && row.durablePresence === 'observed') return 'Inspect durable history'
  return 'Explain availability'
}

function renderSessionPickerFrame(
  panel: SessionPickerPanel,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const liveActivation = panel.liveActivation === true
  const inspection = panel.inspection === true
  const forkAvailable = panel.forkAvailable === true
  const selectedIndex = panel.view.rows.length === 0
    ? -1
    : normalizedPickerSelection(panel.view)
  const selected = selectedIndex < 0 ? undefined : panel.view.rows[selectedIndex]
  const statuses = sessionPickerStatusLines(panel, columns)
  const range = panel.view.rows.length === 0
    ? '0/0'
    : `${panel.view.offset + 1}-${panel.view.offset + panel.view.rows.length}/${panel.view.totalCount}`
  const durability = panel.view.durability === 'available' ? 'Durable' : 'Live only'
  const header = secondaryModalRow(
    secondaryModalHeader('Sessions', columns),
    'accent',
    { bold: true },
  )
  const footer = secondaryModalRow(
    secondaryModalPair(
      `  ↑↓ move · ${sessionPickerOpenLabel(liveActivation, inspection)}${forkAvailable ? ' · F fork' : ''} · R refresh`,
      'Esc close',
      columns,
    ),
    'muted',
  )
  if (rows === 1) {
    return secondaryModalFrame(viewport, [header])
  }
  if (rows === 2) {
    const line = selected === undefined
      ? secondaryModalFill(`  ${statuses[0]!}`, columns)
      : sessionPickerRowLine(selected, true, columns)
    return secondaryModalFrame(viewport, [
      header,
      secondaryModalRow(line, selected === undefined ? 'muted' : 'accent', {
        bold: selected !== undefined,
        selected: selected !== undefined,
      }),
    ])
  }
  if (rows === 3) {
    const line = selected === undefined
      ? secondaryModalFill(`  ${statuses[0]!}`, columns)
      : sessionPickerRowLine(selected, true, columns)
    return secondaryModalFrame(viewport, [
      header,
      secondaryModalRow(line, selected === undefined ? 'muted' : 'accent', {
        bold: selected !== undefined,
        selected: selected !== undefined,
      }),
      footer,
    ])
  }
  const listSection = secondaryModalRow(
    secondaryModalSection(
      'Session list',
      columns,
      `${panel.view.totalCount} · ${durability} · ${range}`,
    ),
    panel.view.durability === 'available' ? 'interaction' : 'warning',
    { bold: true },
  )
  if (rows === 4) {
    const line = selected === undefined
      ? secondaryModalFill(`  ${statuses[0]!}`, columns)
      : sessionPickerRowLine(selected, true, columns)
    return secondaryModalFrame(viewport, [
      header,
      listSection,
      secondaryModalRow(line, selected === undefined ? 'muted' : 'accent', {
        bold: selected !== undefined,
        selected: selected !== undefined,
      }),
      footer,
    ])
  }
  const action = selected === undefined
    ? 'No selection'
    : sessionPickerAction(selected, liveActivation, inspection)
  const selectedSection = secondaryModalRow(
    secondaryModalSection('Selected session', columns, action),
    'interaction',
    { bold: true },
  )
  const selectedState = selected === undefined
    ? undefined
    : `${selected.relation} · ${selected.liveStatus ?? (selected.attached ? 'attached' : 'offline')}`
  const owner = selected === undefined
    ? undefined
    : selected.isSubagent
      ? `Child of ${inlineText(selected.parentSessionId ?? 'unknown')}`
      : 'Root session'
  const detailRows: SecondaryModalRow[] = selected === undefined
    ? []
    : [
        secondaryModalRow(secondaryModalPair('  State', selectedState!, columns), 'telemetry', { bold: true }),
        secondaryModalRow(secondaryModalPair('  Storage', selected.durablePresence, columns), 'muted'),
        secondaryModalRow(secondaryModalPair('  Owner', owner!, columns), 'muted'),
        secondaryModalRow(secondaryModalPair('  Preset', inlineText(selected.creationAgentPreset ?? 'Not recorded'), columns), 'muted'),
        secondaryModalRow(secondaryModalPair('  Workspace', inlineText(selected.cwd ?? 'Not recorded'), columns), 'muted'),
        secondaryModalRow(secondaryModalPair('  Created', String(selected.createdAt), columns), 'muted'),
      ]
  const bodySlots = Math.max(0, rows - 4)
  const minimumRowCount = panel.view.rows.length === 0 ? 0 : 1
  const statusBudget = Math.min(
    statuses.length,
    2,
    Math.max(0, bodySlots - minimumRowCount),
  )
  const availableAfterStatus = Math.max(0, bodySlots - statusBudget)
  const minimumDetailCount = selected === undefined || availableAfterStatus <= minimumRowCount
    ? 0
    : Math.min(2, detailRows.length, availableAfterStatus - minimumRowCount)
  const rowBudget = Math.max(
    minimumRowCount,
    availableAfterStatus - minimumDetailCount,
  )
  const visibleRowCount = Math.min(panel.view.rows.length, rowBudget)
  const start = visibleRowCount === 0
    ? 0
    : focusedWindowStart(panel.view.rows.length, selectedIndex, visibleRowCount)
  const visibleEntries = panel.view.rows
    .slice(start, start + visibleRowCount)
    .map((row, index) => ({
      row,
      selected: start + index === selectedIndex,
    }))
  const detailBudget = Math.min(
    detailRows.length,
    Math.max(0, bodySlots - statusBudget - visibleEntries.length),
  )
  const bodyRows: SecondaryModalRow[] = [
    ...statuses.slice(0, statusBudget).map(line => secondaryModalRow(
      secondaryModalFill(`  ${line}`, columns),
      line.startsWith('Error:')
        ? 'error'
        : line.startsWith('Notice:') || line.includes('unavailable')
          ? 'warning'
          : 'telemetry',
      { bold: line.startsWith('Error:') },
    )),
    ...visibleEntries.map(({ row, selected: isSelected }) => secondaryModalRow(
      sessionPickerRowLine(row, isSelected, columns),
      isSelected ? 'accent' : row.relation === 'current' ? 'success' : row.relation === 'cold' ? 'muted' : 'primary',
      { bold: isSelected || row.relation === 'current', selected: isSelected },
    )),
    ...detailRows.slice(0, detailBudget),
  ]
  const padding = Array.from({ length: bodySlots - bodyRows.length }, () => (
    secondaryModalRow(secondaryModalFill('', columns), 'primary')
  ))
  return secondaryModalFrame(viewport, [
    header,
    ...bodyRows.slice(0, statusBudget),
    listSection,
    ...bodyRows.slice(statusBudget, statusBudget + visibleEntries.length),
    selectedSection,
    ...bodyRows.slice(statusBudget + visibleEntries.length),
    ...padding,
    footer,
  ])
}

function renderSessionForkFrame(
  panel: SessionForkPanel,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const running = panel.kind === 'running'
  const source = panel.source
  const header = secondaryModalRow(
    secondaryModalHeader('Fork session', columns),
    'accent',
    { bold: true },
  )
  const footer = secondaryModalRow(
    secondaryModalPair(
      running ? '  Creating child' : '  Enter create',
      running ? 'Esc cancel' : 'Esc back',
      columns,
    ),
    running ? 'warning' : 'muted',
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  if (rows === 2) return secondaryModalFrame(viewport, [header, footer])

  const sourceState = `${source.relation} · ${source.liveStatus ?? (source.attached ? 'attached' : 'offline')}`
  const owner = source.isSubagent
    ? `Child of ${inlineText(source.parentSessionId ?? 'unknown')}`
    : 'Root session'
  const summary = secondaryModalRow(
    secondaryModalFill(
      running
        ? '  Creating child session · source remains unchanged'
        : '  New child session · source remains unchanged',
      columns,
    ),
    running ? 'warning' : 'telemetry',
    { bold: true },
  )
  const action = secondaryModalRow(
    secondaryModalPair(
      running ? '  CREATING CHILD' : '›  CREATE CHILD',
      running ? 'Wait or cancel' : 'Enter confirm',
      columns,
    ),
    running ? 'warning' : 'accent',
    { bold: true, selected: !running },
  )

  if (rows <= 7) {
    const available = rows - 2
    const compactFacts: SecondaryModalRow[] = [
      summary,
      secondaryModalRow(secondaryModalPair('  Source', inlineText(source.sessionId), columns), 'primary'),
      secondaryModalRow(
        secondaryModalFill('  Inherits working directory, model, Agent mode, and completed history', columns),
        'muted',
      ),
    ]
    const middle = available <= 1
      ? [action]
      : [...compactFacts.slice(0, available - 1), action]
    return secondaryModalFrame(viewport, [header, ...middle, footer])
  }

  const sourceSection = secondaryModalRow(
    secondaryModalSection('Source', columns, sourceState),
    'interaction',
    { bold: true },
  )
  const childSection = secondaryModalRow(
    secondaryModalSection('Child contract', columns, running ? 'Creating' : 'Ready'),
    running ? 'warning' : 'interaction',
    { bold: true },
  )
  const compactRows: SecondaryModalRow[] = [
    header,
    summary,
    sourceSection,
    secondaryModalRow(secondaryModalPair('  Session', inlineText(source.sessionId), columns), 'primary', { bold: true }),
    secondaryModalRow(secondaryModalPair('  State', sourceState, columns), 'telemetry'),
    secondaryModalRow(secondaryModalPair('  Owner', owner, columns), 'muted'),
    secondaryModalRow(secondaryModalPair('  Workspace', inlineText(source.cwd ?? 'Resolved from history'), columns), 'muted'),
    childSection,
    secondaryModalRow(secondaryModalPair('  History', 'Last completed turn', columns), 'primary'),
    secondaryModalRow(secondaryModalPair('  Source', 'No source activation or mutation', columns), 'success'),
    action,
  ]
  if (rows <= 12) {
    return secondaryModalFrame(viewport, fillModalRows(compactRows, viewport, footer))
  }

  const fullRows: SecondaryModalRow[] = [
    ...compactRows.slice(0, 7),
    secondaryModalRow(
      secondaryModalPair('  Preset', inlineText(source.creationAgentPreset ?? 'Resolved from history'), columns),
      'muted',
    ),
    childSection,
    secondaryModalRow(secondaryModalPair('  Type', 'Ordinary child session', columns), 'primary'),
    secondaryModalRow(secondaryModalPair('  History', 'Last completed turn', columns), 'primary'),
    secondaryModalRow(secondaryModalPair('  Runtime', 'Fresh Agent and Session identity', columns), 'primary'),
    secondaryModalRow(secondaryModalPair('  Inherits', 'Working directory, model, and Agent mode', columns), 'muted'),
    secondaryModalRow(secondaryModalPair('  Source', 'No source activation or mutation', columns), 'success'),
    action,
  ]
  return secondaryModalFrame(viewport, fillModalRows(fullRows, viewport, footer))
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
    'TRANSCRIPT',
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
  if (rows <= 4) return 0
  return inspectionReadyLayout(
    panel,
    Math.max(1, dimension(viewport.columns) - 4),
    rows - 4,
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

function renderColdResumeConfirmationFrame(
  panel: Extract<SessionInspectionPanel, { kind: 'confirm-resume' }>,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const fits = coldResumeConfirmationFits(viewport)
  const header = secondaryModalRow(
    secondaryModalHeader('Resume cold session', columns),
    'warning',
    { bold: true },
  )
  const footer = secondaryModalRow(
    secondaryModalPair(
      fits
        ? '  Enter resume'
        : `  Resize to at least ${COLD_RESUME_CONFIRMATION_MIN_COLUMNS}x${COLD_RESUME_CONFIRMATION_MIN_ROWS}`,
      'Esc back',
      columns,
    ),
    fits ? 'muted' : 'warning',
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  if (rows === 2) return secondaryModalFrame(viewport, [header, footer])
  if (!fits) {
    return secondaryModalFrame(viewport, fillModalRows([
      header,
      secondaryModalRow(
        secondaryModalFill(
          `  Resize to at least ${COLD_RESUME_CONFIRMATION_MIN_COLUMNS}x${COLD_RESUME_CONFIRMATION_MIN_ROWS} before resuming.`,
          columns,
        ),
        'warning',
        { bold: true },
      ),
      secondaryModalRow(
        secondaryModalPair('  Session', inlineText(panel.sessionId), columns),
        'primary',
      ),
    ], viewport, footer))
  }

  const warning = secondaryModalRow(
    secondaryModalFill('  Resume may repair or append durable storage.', columns),
    'warning',
    { bold: true },
  )
  const targetSection = secondaryModalRow(
    secondaryModalSection('Exact target', columns, panel.observation.kind === 'missing' ? 'Missing' : panel.observation.relation),
    'interaction',
    { bold: true },
  )
  const effectsSection = secondaryModalRow(
    secondaryModalSection('Runtime effects', columns, 'No work started'),
    'interaction',
    { bold: true },
  )
  const action = secondaryModalRow(
    secondaryModalPair('›  RESUME SESSION', 'Enter confirm', columns),
    'accent',
    { bold: true, selected: true },
  )
  const compact = [
    header,
    warning,
    targetSection,
    secondaryModalRow(secondaryModalPair('  Session', inlineText(panel.sessionId), columns), 'primary', { bold: true }),
    effectsSection,
    action,
  ]
  if (rows <= 9) {
    return secondaryModalFrame(viewport, fillModalRows(compact, viewport, footer))
  }
  const metadataRows = wrap(inspectionMetadata(panel.header), Math.max(1, columns - 4))
    .slice(0, 2)
    .map(line => secondaryModalRow(secondaryModalFill(`  ${line}`, columns), 'muted'))
  const full = [
    header,
    warning,
    targetSection,
    secondaryModalRow(secondaryModalPair('  Session', inlineText(panel.sessionId), columns), 'primary', { bold: true }),
    secondaryModalRow(secondaryModalFill(`  ${inspectionObservation(panel.observation)}`, columns), 'telemetry'),
    ...metadataRows,
    effectsSection,
    secondaryModalRow(
      secondaryModalFill('  It may create and publish an Agent before this TUI switches views.', columns),
      'primary',
    ),
    secondaryModalRow(secondaryModalFill('  No resume has started yet.', columns), 'success'),
    action,
  ]
  return secondaryModalFrame(viewport, fillModalRows(full, viewport, footer))
}

function renderSessionInspectionFrame(
  panel: SessionInspectionPanel,
  viewport: TerminalViewport,
): UiFrame {
  if (panel.kind === 'confirm-resume') {
    return renderColdResumeConfirmationFrame(panel, viewport)
  }
  const { columns, rows } = viewport
  const status = panel.kind === 'ready'
    ? panel.refreshing
      ? 'immutable snapshot · refreshing'
      : panel.error === undefined
        ? panel.notice === undefined
          ? 'immutable snapshot'
          : 'immutable snapshot · action blocked'
        : 'immutable snapshot · refresh failed'
    : panel.kind
  const header = secondaryModalRow(
    secondaryModalHeader('Session inspection', columns),
    'accent',
    { bold: true },
  )
  const footerLeft = panel.kind === 'loading'
    ? '  Inspecting'
    : panel.kind === 'error'
      ? '  R retry'
      : panel.refreshing
        ? '  Up/Down scroll · Refreshing'
        : panel.notice !== undefined
          ? `  Notice: ${inlineText(panel.notice)} · R refresh`
          : panel.error === undefined
            ? panel.canResumeCold === true
              ? '  A resume · Up/Down scroll · R refresh'
              : '  Up/Down scroll · R refresh'
            : `  Up/Down scroll · R retry · Refresh failed: ${inlineText(panel.error)}`
  const footerRight = panel.kind === 'loading' ? 'Esc cancel' : 'Esc back'
  const footer = secondaryModalRow(
    secondaryModalPair(footerLeft, footerRight, columns),
    'muted',
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  if (rows === 2) return secondaryModalFrame(viewport, [header, footer])

  const sectionLabel = panel.kind === 'loading'
    ? 'Inspection'
    : panel.kind === 'error'
      ? 'Inspection failed'
      : 'Snapshot safety'
  const section = secondaryModalRow(
    secondaryModalSection(sectionLabel, columns, status),
    panel.kind === 'error' ? 'error' : 'interaction',
    { bold: true },
  )
  if (rows === 3) return secondaryModalFrame(viewport, [header, section, footer])
  if (rows === 4) {
    const line = panel.kind === 'loading'
      ? `Inspecting ${inlineText(panel.sessionId)}… · logical read-only · Storage unchanged`
      : panel.kind === 'error'
        ? 'Inspect failed: ' + inlineText(panel.message) + ' · Storage unchanged'
        : inspectionReadyBody(panel, Math.max(1, columns - 4), 1)[0]!
    return secondaryModalFrame(viewport, [
      header,
      section,
      secondaryModalRow(
        secondaryModalFill(`  ${line}`, columns),
        panel.kind === 'error'
          ? 'error'
          : line.includes('Storage unchanged') ? 'success' : 'muted',
        { bold: panel.kind === 'error' },
      ),
      footer,
    ])
  }

  const session = secondaryModalRow(
    secondaryModalPair(`  Session  ${inlineText(panel.sessionId)}`, status, columns),
    panel.kind === 'error' ? 'error' : 'telemetry',
    { bold: true },
  )
  const bodySlots = rows - 4
  const innerColumns = Math.max(1, columns - 4)
  const body = panel.kind === 'loading'
    ? [`Inspecting ${inlineText(panel.sessionId)}… · logical read-only · Storage unchanged`]
    : panel.kind === 'error'
      ? ['Inspect failed: ' + inlineText(panel.message) + ' · Storage unchanged']
      : inspectionReadyBody(panel, innerColumns, bodySlots)
  const visibleBody = body.slice(0, bodySlots)
  const bodyRows = visibleBody.map((line): SecondaryModalRow => {
    if (line === 'TRANSCRIPT') {
      return secondaryModalRow(secondaryModalSection('Transcript', columns), 'interaction', { bold: true })
    }
    const tone: DshTuiSemanticRole = line.startsWith('Error:') || line.startsWith('Inspect failed:')
      ? 'error'
      : line.startsWith('Notice:')
        ? 'warning'
        : line.startsWith('You:')
          ? 'accent'
          : line.startsWith('Assistant:')
            ? 'primary'
            : line.startsWith('Tool ') || line.startsWith('Result:')
              ? 'tool'
              : line.includes('Storage unchanged')
                ? 'success'
                : 'muted'
    return secondaryModalRow(
      secondaryModalFill(`  ${line}`, columns),
      tone,
      { bold: tone === 'error' || line.startsWith('You:') },
    )
  })
  const padding = Array.from({ length: bodySlots - bodyRows.length }, () => (
    secondaryModalRow(secondaryModalFill('', columns), 'primary')
  ))
  return secondaryModalFrame(viewport, [
    header,
    session,
    section,
    ...bodyRows,
    ...padding,
    footer,
  ])
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
  const baseInput: DshTuiInputMode = view.input ?? { kind: 'prompt', editor: view.prompt }
  const pendingInteraction = focusedInteraction(view.interaction, baseInput)
  if (pendingInteraction !== undefined && view.interaction !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'compact', surface => (
      renderInteractionFrame(pendingInteraction, view.interaction!, baseInput, surface)
    ))
  }
  if (view.providerConnect !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'picker', surface => (
      renderProviderConnectFrame(view.providerConnect!, surface)
    ))
  }
  if (view.sessionFork !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'compact', surface => (
      renderSessionForkFrame(view.sessionFork!, surface)
    ))
  }
  if (view.sessionInspection !== undefined) {
    const kind = view.sessionInspection.kind === 'confirm-resume' ? 'compact' : 'directory'
    return floatingSecondaryFrame(normalizedViewport, kind, surface => (
      renderSessionInspectionFrame(view.sessionInspection!, surface)
    ))
  }
  if (view.sessionPicker !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'picker', surface => (
      renderSessionPickerFrame(view.sessionPicker!, surface)
    ))
  }
  if (view.permissionPicker !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'compact', surface => (
      renderPermissionPickerFrame(
        view.permissionPicker!,
        surface,
        view.commandNotice,
      )
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
  if (view.toolBrowser !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'directory', surface => (
      renderToolBrowserFrame(view.toolBrowser!, surface)
    ))
  }
  if (view.mcpBrowser !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'directory', surface => (
      renderMcpCapabilityFrame(view.mcpBrowser!, surface)
    ))
  }
  if (view.runtimeLibrary !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'library', surface => (
      renderRuntimeLibraryFrame(view.runtimeLibrary!, surface)
    ))
  }
  if (view.modelPicker !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'catalog', surface => (
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
  if (view.attemptPanel !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'attempts', surface => (
      renderAttemptFrame(view.attemptPanel!, surface)
    ))
  }
  if (view.routePanel !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'routes', surface => (
      renderRouteFrame(view.routePanel!, surface)
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
  const statusline = buildStatusLine(
    view.model,
    view.context,
    session?.compaction,
    columns,
    session?.llmAttempts,
  )
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
  let focus: FrameBlock | undefined
  let dock: ConversationDock | undefined
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
