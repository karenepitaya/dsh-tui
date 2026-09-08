import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { FeatureSurfaceRuntimeSnapshot } from '../app/feature-surface-runtime.ts'
import type { LegacyDirectoryNavigation } from '../navigation/legacy-directory.ts'
import type { InteractionSnapshot, PendingInteraction } from '../interaction/port.ts'
import { renderFeatureSurfaceFrame } from './feature-surface-frame.ts'
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
  type SessionLlmAttemptState,
} from '../llm/attempts.ts'
import type { RoutePanelView } from '../llm/routes.ts'
import type { RuntimeLibraryView } from '../runtime-library/surface.ts'
import type { PermissionPickerView } from '../permission/picker.ts'
import type { ProviderConnectView } from '../provider/connect-controller.ts'
import type { SessionContextSnapshot } from '../context/port.ts'
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
import type { AgentRequestStatusView } from '../presentation/agent-request.ts'
import type { TranscriptViewMode } from '../presentation/transcript-view.ts'
import type { DshTuiPreferencesV1 } from '../preferences/contracts.ts'
import {
  projectUiMessageContent,
} from '../presentation/message-content.ts'
import type { PromptEditorState } from './prompt-editor.ts'
import { toolRowStatus } from '../presentation/tool-outcome.ts'
import { executionTraceProjection, type ExecutionTraceProjection } from '../presentation/execution-trace.ts'
import { buildApprovalDock } from './approval-dock.ts'
import { approvalLayoutBudget } from '../presentation/approval-layout.ts'
import { renderPermissionWorkspace } from './permission-workspace.ts'
import { renderRuntimeLibraryFrame } from './workspace-runtime.ts'
import { renderSettingsPageFrame } from './settings-page-frame.ts'
import { renderSessionDirectoryFrame } from './workspace-sessions.ts'
import { renderSkillPickerFrame, renderToolBrowserFrame, renderMcpCapabilityFrame } from './workspace-capability.ts'
import { promptProjection } from './prompt-projection.ts'
import { renderLegacyWorkspaceFrame } from './legacy-workspace.ts'
import { legacyWorkspaceDescriptor } from './legacy-workspace-routing.ts'
import type { PromptImageView } from '../attachment/port.ts'
import type { DshTuiSemanticRole } from './theme.ts'
import type { UiFrameLineStyle, UiFrameStyleSpan } from './frame-style.ts'
import type { SettingsWorkspaceModel } from 'pi-tui-orbs'
export type { UiFrameLineStyle, UiFrameStyleSpan } from './frame-style.ts'
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
import { styleToolCardLines } from './tool-card-styling.ts'
import { renderContextFrame } from './workspace-context.ts'
import { renderAttemptFrame, formatRetryDelay } from './workspace-request-recovery.ts'
import { renderRouteFrame } from './workspace-model-route.ts'
import { billedInputTokens, cacheHitPercent, contextOccupancy, formatTokenCount } from './context-metrics.ts'
import { fillModalRows, focusedWindowStart, inlineText, secondaryModalFrame } from './workspace-rows.ts'
export { renderContextFrame } from './workspace-context.ts'
export { billedInputTokens, cacheHitPercent, contextOccupancy, formatTokenCount, type ContextOccupancy } from './context-metrics.ts'
import {
  layoutConversationComposer,
  layoutConversationDashboard,
  type ConversationDashboard,
  type ConversationDashboardLine,
  type ConversationCardNode,
  type ConversationDock,
  type ConversationNode,
  type ConversationMarkdownNode,
  type ConversationStyledLine,
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
  /** Bounded region styles override the legacy whole-row style. */
  readonly styleSpans?: readonly (readonly UiFrameStyleSpan[])[]
  readonly cursor?: UiCursor
  /** Fixed-size floating secondary surface; the retained conversation stays underneath. */
  readonly overlay?: SecondaryOverlayLayout
  /** Structured main surface consumed by the retained pi-tui layout. */
  readonly conversation?: ConversationSurface
  /** Settings uses the retained Orbs component; lines are its neutral fallback projection. */
  readonly settingsWorkspace?: SettingsWorkspaceModel
  /** Lazily materializes legacy lines only when a retained driver needs a dimmed backdrop. */
  readonly flatFallback?: () => UiFrame
}

export interface RenderDshFrameOptions {
  /** Avoid duplicate flat transcript work until a retained driver actually needs it. */
  readonly deferFlatFallback?: boolean
}

export interface DshTuiView {
  readonly ui: UiState
  /** Generic non-Chat Feature surface projection for the active Session. */
  readonly featureSurface?: FeatureSurfaceRuntimeSnapshot
  readonly interaction: InteractionSnapshot | undefined
  readonly prompt: PromptEditorState
  readonly attachments?: readonly PromptImageView[]
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
  readonly attemptNavigation?: LegacyDirectoryNavigation
  readonly routeNavigation?: LegacyDirectoryNavigation
  readonly modeNavigation?: LegacyDirectoryNavigation
  readonly modelNavigation?: LegacyDirectoryNavigation
  readonly activityNavigation?: LegacyDirectoryNavigation
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
  readonly contextPanelOffset?: number
  readonly bindingEpoch?: number
  readonly reasoningExpanded?: boolean
  readonly transcriptViewMode?: TranscriptViewMode
  readonly preferences?: DshTuiPreferencesV1
  readonly agentRequest?: AgentRequestStatusView
  readonly followRequest?: number
  /** Internal effect-owned rich renderer set; absent means generic fallback. */
  readonly toolCards?: ToolCardRendererRegistry
  /** Controller-owned projection cache; direct render callers are intentionally uncached. */
  readonly projectionCache?: DshTuiFrameProjectionCache
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

function projectedMessageText(
  projection: ReturnType<typeof projectUiMessageContent>,
): string {
  const supplements = [
    ...projection.images.map(image => (
      `[image ${image.attachment.mediaType} ${image.attachment.width}x${image.attachment.height}]`
    )),
    ...projection.unsupported.map(block => `[unsupported:${block.sourceType}]`),
  ]
  return [projection.text, ...supplements].filter(Boolean).join('\n')
}

function messageText(content: Parameters<typeof projectUiMessageContent>[0]): string {
  return projectedMessageText(projectUiMessageContent(content, { includeReasoning: false }))
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

function activeToolPresentation(
  row: Extract<TranscriptRow, { readonly kind: 'tool' }>,
): ToolPresentationView | undefined {
  if (row.resultSeq === undefined) return row.callPresentation
  return row.resultPresentation ?? (row.callPresentation === undefined
    ? undefined
    : {
        phase: 'result',
        card: 'generic',
        title: row.callPresentation.title,
      })
}

function transcriptLines(
  row: TranscriptRow,
  columns: number,
  toolCards?: ToolCardRendererRegistry,
): string[] {
  switch (row.kind) {
    case 'user':
      return wrap('You: ' + messageText(row.message.content), columns)
    case 'assistant':
      return wrap('Assistant: ' + messageText(row.message.content), columns)
    case 'assistant-draft': {
      return wrap('Assistant: ' + row.text, columns)
    }
    case 'tool': {
      const status = toolRowStatus(row)
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
      const registry = toolCards ?? new ToolCardRendererRegistry()
      return [...registry.renderSafe({
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
  const status = toolRowStatus(row)
  const rendered = transcriptLines(row, columns, toolCards)
  const suffix = ` · ${status}`
  const rawTitle = rendered[0]!
  const withoutStatus = rawTitle.endsWith(suffix)
    ? rawTitle.slice(0, -suffix.length)
    : rawTitle
  const title = withoutStatus.startsWith('Tool ') ? withoutStatus.slice(5) : withoutStatus
  const activePresentation = activeToolPresentation(row)
  const lines = rendered.slice(1)
  const styledLines = styleToolCardLines(activePresentation, lines)
  return {
    label: `TOOL  ${title}`,
    lines,
    ...(styledLines === undefined ? {} : { styledLines }),
  }
}

function thinkingSummary(
  streaming: boolean,
  reasoningTokens: number | undefined,
  hasReasoning: boolean,
): string | undefined {
  if (streaming) return hasReasoning ? 'THOUGHT · LIVE' : undefined
  if (reasoningTokens !== undefined && reasoningTokens > 0) {
    return 'THOUGHT · ' + reasoningTokens + ' TOKENS'
      + (hasReasoning ? '' : ' · TEXT UNAVAILABLE')
  }
  return hasReasoning ? 'THOUGHT · AVAILABLE' : undefined
}

type AssistantTranscriptRow = Extract<
  TranscriptRow,
  { readonly kind: 'assistant' | 'assistant-draft' }
>
type ToolTranscriptRow = Extract<TranscriptRow, { readonly kind: 'tool' }>

function transcriptRowSequence(row: TranscriptRow): number {
  switch (row.kind) {
    case 'user': return row.seq
    case 'assistant': return row.seq
    case 'assistant-draft': return row.lastSeq
    case 'tool': return row.resultSeq ?? row.callSeq ?? Number.MAX_SAFE_INTEGER
    case 'command': return row.doneSeq ?? row.runSeq ?? Number.MAX_SAFE_INTEGER
  }
}

function chronologicalTranscriptRows(
  rows: readonly TranscriptRow[],
): readonly TranscriptRow[] {
  return rows
    .map((row, index) => ({ row, index, seq: transcriptRowSequence(row) }))
    .sort((left, right) => left.seq - right.seq || left.index - right.index)
    .map(entry => entry.row)
}

interface AssistantDisplay {
  readonly row: AssistantTranscriptRow
  readonly text: string
  readonly hasReasoning: boolean
  readonly hasToolCalls: boolean
  readonly reasoningSummary?: string
}

function assistantDisplay(row: AssistantTranscriptRow): AssistantDisplay {
  if (row.kind === 'assistant-draft') {
    const hasReasoning = row.reasoning !== ''
    const summary = thinkingSummary(true, undefined, hasReasoning)
    return {
      row,
      text: row.text,
      hasReasoning,
      hasToolCalls: false,
      ...(summary === undefined ? {} : { reasoningSummary: summary }),
    }
  }
  const projection = projectUiMessageContent(row.message.content, {
    includeReasoning: false,
  })
  const hasReasoning = projection.hasReasoning
  const summary = thinkingSummary(
    false,
    row.usage?.reasoningTokens,
    hasReasoning,
  )
  return {
    row,
    text: projectedMessageText(projection),
    hasReasoning,
    hasToolCalls: projection.toolCalls.length > 0,
    ...(summary === undefined ? {} : { reasoningSummary: summary }),
  }
}

type TranscriptConversationNode = ConversationMarkdownNode
  | (ConversationCardNode & { readonly kind: 'tool' | 'command' })

function assistantConversationNode(
  display: AssistantDisplay,
  options: {
    readonly activitySummary?: string
    readonly reasoningSummary?: string
    readonly anchorKey?: string
  } = {},
): TranscriptConversationNode | undefined {
  const interrupted = display.row.kind === 'assistant' && display.row.interrupted
  if (
    display.text === ''
    && options.activitySummary === undefined
    && options.reasoningSummary === undefined
    && !interrupted
  ) return undefined
  const sourceRevision = display.row.kind === 'assistant'
    ? display.row.seq
    : display.text === '' ? display.row.firstSeq : display.row.lastSeq
  const nodeKind = display.text === '' ? 'assistant-draft' : display.row.kind
  return {
    kind: nodeKind,
    key: 'assistant:' + display.row.key,
    revision: [
      sourceRevision,
      display.text.length,
      display.hasReasoning,
      options.activitySummary ?? '',
      options.reasoningSummary ?? '',
      options.anchorKey ?? '',
      interrupted,
    ].join(':'),
    text: display.text,
    ...(options.anchorKey === undefined ? {} : { anchorKey: options.anchorKey }),
    ...(options.activitySummary === undefined
      ? {}
      : { activitySummary: options.activitySummary }),
    ...(options.reasoningSummary === undefined
      ? {}
      : { reasoningSummary: options.reasoningSummary }),
    ...(interrupted ? { interrupted: true } : {}),
  }
}

function transcriptConversationNode(
  row: TranscriptRow,
  columns: number,
  toolCards: ToolCardRendererRegistry | undefined,
): TranscriptConversationNode | undefined {
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
    case 'assistant':
    case 'assistant-draft': {
      const display = assistantDisplay(row)
      return assistantConversationNode(display, {
        ...(display.reasoningSummary !== undefined
          ? { reasoningSummary: display.reasoningSummary }
          : {}),
      })
    }
    case 'tool': {
      const status = toolRowStatus(row)
      const presentation = toolActivityPresentation(
        row,
        Math.max(1, columns - 4),
        toolCards,
      )
      return {
        kind: 'tool',
        key: row.key,
        revision: [
          row.callSeq ?? 0,
          row.resultSeq ?? 0,
          status,
          row.presentationRevision ?? 0,
        ].join(':'),
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
        revision: (row.runSeq ?? 0) + ':' + (row.doneSeq ?? 0) + ':' + row.status,
        label: 'CMD  ' + identity,
        status: row.status === 'error' ? 'failed' : row.status === 'success' ? 'done' : 'running',
        lines: transcriptLines(row, Math.max(1, columns - 4), toolCards),
      }
    }
  }
}

export type { ExecutionTraceProjection } from '../presentation/execution-trace.ts'

interface IndexedAssistantDisplay {
  readonly index: number
  readonly sequence: number
  readonly display: AssistantDisplay
}

interface CompactTurnProjection {
  readonly turn: number
  readonly trace?: ExecutionTraceProjection
  readonly finalAnswer?: AssistantDisplay
  readonly liveAnswer?: AssistantDisplay
  readonly latestReasoning?: IndexedAssistantDisplay
}

function compactTurnProjections(
  rows: readonly TranscriptRow[],
  openTurn: number | undefined,
): ReadonlyMap<number, CompactTurnProjection> {
  const entries = new Map<
    number,
    {
      tools: ToolTranscriptRow[]
      assistants: IndexedAssistantDisplay[]
      lastToolSequence: number
    }
  >()
  for (const [index, row] of rows.entries()) {
    if (row.kind !== 'assistant' && row.kind !== 'assistant-draft' && row.kind !== 'tool') {
      continue
    }
    const current = entries.get(row.turn) ?? {
      tools: [],
      assistants: [],
      lastToolSequence: -1,
    }
    if (row.kind === 'tool') {
      current.tools.push(row)
      current.lastToolSequence = Math.max(
        current.lastToolSequence,
        transcriptRowSequence(row),
      )
    } else {
      current.assistants.push({
        index,
        sequence: transcriptRowSequence(row),
        display: assistantDisplay(row),
      })
    }
    entries.set(row.turn, current)
  }

  const projections = new Map<number, CompactTurnProjection>()
  for (const [turn, entry] of entries) {
    const finalAnswer = entry.assistants
      .filter(candidate => (
        candidate.display.row.kind === 'assistant'
        && candidate.display.text !== ''
        && !candidate.display.hasToolCalls
        && (
          entry.tools.length === 0
          || candidate.sequence > entry.lastToolSequence
        )
      ))
      .at(-1)?.display
    const liveAnswer = finalAnswer === undefined && openTurn === turn
      ? entry.assistants
          .filter(candidate => (
            candidate.display.row.kind === 'assistant-draft'
            && candidate.display.text !== ''
            && candidate.sequence > entry.lastToolSequence
          ))
          .at(-1)?.display
      : undefined
    const latestReasoning = entry.assistants
      .filter(candidate => candidate.display.reasoningSummary !== undefined)
      .at(-1)
    const hasAnswer = finalAnswer !== undefined || liveAnswer !== undefined
    const trace = hasAnswer || openTurn !== turn
      ? executionTraceProjection(turn, entry.tools)
      : undefined
    projections.set(turn, {
      turn,
      ...(trace === undefined ? {} : { trace }),
      ...(finalAnswer === undefined ? {} : { finalAnswer }),
      ...(liveAnswer === undefined ? {} : { liveAnswer }),
      ...(latestReasoning === undefined ? {} : { latestReasoning }),
    })
  }
  return projections
}

function latestReasoningKey(
  projections: ReadonlyMap<number, CompactTurnProjection>,
): string | undefined {
  let latest: IndexedAssistantDisplay | undefined
  for (const projection of projections.values()) {
    if (
      projection.latestReasoning !== undefined
      && (latest === undefined || projection.latestReasoning.index > latest.index)
    ) latest = projection.latestReasoning
  }
  return latest?.display.row.key
}

function compactTurnNode(
  projection: CompactTurnProjection,
  expandedReasoningKey: string | undefined,
): TranscriptConversationNode | undefined {
  const latestReasoning = projection.latestReasoning
  const reasoningSummary = latestReasoning !== undefined
    && latestReasoning.display.row.key === expandedReasoningKey
    ? latestReasoning.display.reasoningSummary
    : undefined
  const answer = projection.finalAnswer ?? projection.liveAnswer
  if (answer !== undefined) {
    return assistantConversationNode(answer, {
      ...(projection.trace === undefined
        ? {}
        : {
            activitySummary: projection.trace.activitySummary,
            anchorKey: projection.trace.anchorKey,
          }),
      ...(reasoningSummary === undefined ? {} : { reasoningSummary }),
    })
  }
  if (projection.trace === undefined && reasoningSummary === undefined) return undefined
  return {
    kind: 'assistant-draft',
    key: projection.trace?.anchorKey
      ?? 'assistant:' + latestReasoning!.display.row.key,
    revision: [
      projection.trace?.revision ?? '',
      reasoningSummary ?? '',
    ].join(':'),
    text: '',
    ...(projection.trace === undefined
      ? {}
      : { activitySummary: projection.trace.activitySummary }),
    ...(reasoningSummary === undefined ? {} : { reasoningSummary }),
  }
}

function compactTranscriptNodes(
  rows: readonly TranscriptRow[],
  projections: ReadonlyMap<number, CompactTurnProjection>,
  reasoningExpanded: boolean,
  columns: number,
  toolCards: ToolCardRendererRegistry | undefined,
): readonly TranscriptConversationNode[] {
  const nodes: TranscriptConversationNode[] = []
  const handledTurns = new Set<number>()
  const expandedReasoningKey = reasoningExpanded
    ? latestReasoningKey(projections)
    : undefined
  for (const row of rows) {
    if (row.kind === 'assistant' || row.kind === 'assistant-draft' || row.kind === 'tool') {
      if (handledTurns.has(row.turn)) continue
      handledTurns.add(row.turn)
      const projection = projections.get(row.turn)!
      const node = compactTurnNode(projection, expandedReasoningKey)
      if (node !== undefined) nodes.push(node)
      continue
    }
    const node = transcriptConversationNode(row, columns, toolCards)
    nodes.push(node!)
  }
  return nodes
}

function verboseTranscriptNodes(
  rows: readonly TranscriptRow[],
  columns: number,
  toolCards: ToolCardRendererRegistry | undefined,
): readonly TranscriptConversationNode[] {
  const nodes: TranscriptConversationNode[] = []
  for (const row of rows) {
    const node = transcriptConversationNode(row, columns, toolCards)
    if (node !== undefined) nodes.push(node)
  }
  return nodes
}

function flatTranscriptBlock(
  node: TranscriptConversationNode,
  columns: number,
): FrameBlock {
  if ('text' in node) {
    const prefixWidth = columns >= 3 ? 2 : 0
    const contentColumns = Math.max(1, columns - prefixWidth)
    const lines: string[] = []
    if (node.kind === 'user') {
      const body = wrap(node.text, contentColumns)
      lines.push(...body.map((line, index) => (
        (prefixWidth === 0 ? '' : index === 0 ? '› ' : '  ')
        + fitLine(line, contentColumns)
      )))
    } else {
      if (node.activitySummary !== undefined) {
        lines.push((prefixWidth === 0 ? '' : '  ') + truncateToWidth(
          safeText(node.activitySummary), contentColumns, '…',
        ))
      }
      if (node.reasoningSummary !== undefined) {
        lines.push(...wrap(node.reasoningSummary, contentColumns).map(line => (
          (prefixWidth === 0 ? '' : '  ') + fitLine(line, contentColumns)
        )))
      }
      if (node.text !== '') {
        const body = wrap(node.text, contentColumns)
        lines.push(...body.map((line, index) => (
          (prefixWidth === 0 ? '' : index === 0 ? '● ' : '  ')
          + fitLine(line, contentColumns)
        )))
      }
      if (node.interrupted === true) {
        lines.push((prefixWidth === 0 ? '' : '  ') + fitLine(
          '[interrupted]',
          contentColumns,
        ))
      }
    }
    return {
      label: node.kind === 'user' ? 'user' : 'assistant',
      plain: lines,
      content: lines,
      lines,
      compact: fitLine(lines.join(' '), columns),
    }
  }
  const badge = node.status === 'failed'
    ? '× FAILED'
    : node.status === 'cancelled' ? '■ CANCELLED'
      : node.status === 'running' ? '● RUNNING' : '✓ DONE'
  return boundedCard(node.label + '  ' + badge, node.lines, columns)
}

function flatTranscriptTimeline(
  nodes: readonly TranscriptConversationNode[],
  columns: number,
  density: DshTuiPreferencesV1['density'],
): readonly FrameBlock[] {
  const blocks: FrameBlock[] = []
  for (const [index, node] of nodes.entries()) {
    const previous = nodes[index - 1]
    if (previous !== undefined && node.kind === 'user') {
      blocks.push({ label: '', plain: [''], content: [''], lines: [''], compact: '' })
      if (density === 'comfortable') blocks.push({ label: '', plain: [''], content: [''], lines: [''], compact: '' })
    }
    blocks.push(flatTranscriptBlock(node, columns))
  }
  return blocks
}

interface TranscriptProjection {
  readonly timeline: readonly FrameBlock[]
  readonly nodes: readonly ConversationNode[]
  readonly answerTurns: ReadonlySet<number>
}

const TRANSCRIPT_PROJECTION_CACHE_LIMIT = 8

/** One Controller-owned cache. No render state is shared between app instances. */
export class DshTuiFrameProjectionCache {
  readonly #projections = new WeakMap<
    readonly TranscriptRow[],
    Map<string, TranscriptProjection>
  >()
  readonly #toolCardRegistryIds = new WeakMap<ToolCardRendererRegistry, number>()
  #nextToolCardRegistryId = 0

  get(
    rows: readonly TranscriptRow[],
    key: string,
  ): TranscriptProjection | undefined {
    return this.#projections.get(rows)?.get(key)
  }

  set(
    rows: readonly TranscriptRow[],
    key: string,
    projection: TranscriptProjection,
  ): void {
    let entries = this.#projections.get(rows)
    entries ??= new Map()
    entries.set(key, projection)
    while (entries.size > TRANSCRIPT_PROJECTION_CACHE_LIMIT) {
      const oldest = entries.keys().next().value as string | undefined
      /* v8 ignore next -- positive Map size guarantees one oldest key. */
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    this.#projections.set(rows, entries)
  }

  toolCardRegistryId(registry: ToolCardRendererRegistry): number {
    const existing = this.#toolCardRegistryIds.get(registry)
    if (existing !== undefined) return existing
    const id = ++this.#nextToolCardRegistryId
    this.#toolCardRegistryIds.set(registry, id)
    return id
  }
}

function projectTranscript(
  rows: readonly TranscriptRow[],
  openTurn: number | undefined,
  columns: number,
  toolCards: ToolCardRendererRegistry | undefined,
  mode: TranscriptViewMode,
  reasoningExpanded: boolean,
  includeFlatTimeline: boolean,
  cache: DshTuiFrameProjectionCache | undefined,
  density: DshTuiPreferencesV1['density'],
): TranscriptProjection {
  const registry = toolCards ?? new ToolCardRendererRegistry()
  const cacheKey = mode === 'compact'
    ? [
        columns,
        includeFlatTimeline ? 1 : 0,
        mode,
        density,
        reasoningExpanded ? 1 : 0,
        openTurn ?? 'closed',
      ].join(':')
    : [
        columns,
        includeFlatTimeline ? 1 : 0,
        mode,
        density,
        cache?.toolCardRegistryId(registry) ?? 'uncached',
        registry.generation,
        openTurn ?? 'closed',
      ].join(':')
  const cached = cache?.get(rows, cacheKey)
  if (cached !== undefined) return cached

  const orderedRows = chronologicalTranscriptRows(rows)
  const turnProjections = compactTurnProjections(orderedRows, openTurn)
  const nodes = mode === 'verbose'
    ? verboseTranscriptNodes(orderedRows, columns, registry)
    : compactTranscriptNodes(
        orderedRows,
        turnProjections,
        reasoningExpanded,
        columns,
        registry,
      )
  const answerTurns = new Set<number>()
  for (const projection of turnProjections.values()) {
    if (projection.finalAnswer !== undefined || projection.liveAnswer !== undefined) {
      answerTurns.add(projection.turn)
    }
  }
  const projection: TranscriptProjection = {
    timeline: includeFlatTimeline
      ? flatTranscriptTimeline(nodes, columns, density)
      : [],
    nodes,
    answerTurns,
  }
  cache?.set(rows, cacheKey, projection)
  return projection
}

function agentRequestTurn(
  openTurn: number | undefined,
  request: AgentRequestStatusView | undefined,
): number | undefined {
  if (openTurn !== undefined) return openTurn
  return request?.turn
}

function visibleAgentRequest(
  request: AgentRequestStatusView | undefined,
  currentTurnHasAnswer: boolean,
): AgentRequestStatusView | undefined {
  if (request === undefined || currentTurnHasAnswer) return undefined
  return request.phase === 'succeeded' ? undefined : request
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

function commandMenuStyles(lines: readonly string[]): readonly ConversationStyledLine[] {
  return lines.map(line => {
    const selected = line.startsWith('› ')
    return {
      segments: [{
        text: line,
        tone: selected
          ? 'accent' as const
          : line.includes('No matches for') ? 'muted' as const : 'primary' as const,
        ...(selected ? { bold: true } : {}),
      }],
    }
  })
}

function commandMenuBlock(lines: readonly string[]): FrameBlock {
  return {
    label: 'COMMANDS',
    plain: lines,
    content: lines,
    lines,
    compact: lines.find(line => line.startsWith('› ')) ?? lines.at(-1) ?? '',
  }
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


function interactionPosition(
  snapshot: InteractionSnapshot,
  item: PendingInteraction,
): string {
  const index = snapshot.pending.findIndex(candidate => candidate.id === item.id)
  return `${Math.max(1, index + 1)}/${Math.max(1, snapshot.pending.length)}`
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
          '  [/] section · j/k move · Tab/h/l focus',
          'K/Delete stop · R refresh · Esc close',
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
  ], undefined, leftColumns)
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

function visibleTimelineLines(
  blocks: readonly FrameBlock[],
  slots: number,
  columns: number,
): string[] {
  if (slots <= 0 || blocks.length === 0) return []

  if (columns < 40) {
    return blocks.flatMap(block => block.lines).slice(-slots)
  }

  const selected: FrameBlock[] = []
  let clippedHead: readonly string[] | undefined
  let remaining = slots
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!
    if (block.lines.length > remaining) {
      if (remaining > 0) clippedHead = block.lines.slice(-remaining)
      break
    }
    selected.unshift(block)
    remaining -= block.lines.length
  }
  return [
    ...(clippedHead ?? []),
    ...selected.flatMap(block => block.lines),
  ]
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
  // The first-run home treatment is intentionally dormant while the core
  // conversation surface is being rebuilt. Empty Chat should stay empty;
  // real Goal/Plan/Todo state above still receives its workbench guidance.
  return []
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
    return undefined
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
    case 'providers': return 'Enter connect/reconnect  Tab/l details  j/k move  D disconnect  R refresh'
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
        : 'Enter apply  Tab/l details  j/k move  R refresh',
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
  const shared = 'j/k move  Tab/l details  R refresh'
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
  const transcript = inspectionTranscriptLines(panel, columns)
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
    transcript.length === 0 ? `No transcript rows · ${inspectionObservation(panel.observation)}` : 'TRANSCRIPT',
  ].filter((line): line is string => line !== undefined)
    .flatMap(line => wrap(line, columns))
  const fixedLimit = Math.max(0, slots - (transcript.length === 0 && fixed.length <= slots ? 0 : 1))
  const visibleFixed = fixed.slice(0, fixedLimit)
  const transcriptSlots = slots - visibleFixed.length
  const scrollable = [...fixed.slice(fixedLimit), ...transcript]
  const maxOffset = Math.max(0, scrollable.length - transcriptSlots)
  return { visibleFixed, transcript: scrollable, transcriptSlots, maxOffset }
}

export function sessionInspectionMaxScrollOffset(
  panel: Extract<SessionInspectionPanel, { kind: 'ready' }>,
  viewport: TerminalViewport,
): number {
  const rows = dimension(viewport.rows)
  if (rows <= 3) return 0
  return inspectionReadyLayout(
    panel,
    Math.max(1, dimension(viewport.columns) - 4),
    Math.max(1, rows - 4),
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
        ? '  j/k ↑↓ PgUp/PgDn · Refreshing'
        : panel.notice !== undefined
          ? `  Notice: ${inlineText(panel.notice)} · R refresh`
          : panel.error === undefined
            ? panel.canResumeCold === true
              ? '  A resume · j/k ↑↓ PgUp/PgDn · R refresh'
              : '  j/k ↑↓ PgUp/PgDn · R refresh'
            : `  j/k ↑↓ PgUp/PgDn · R retry · Refresh failed: ${inlineText(panel.error)}`
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
    case 'prompt': return ''
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

export function renderDshFrame(
  view: DshTuiView,
  viewport: TerminalViewport,
  options: RenderDshFrameOptions = {},
): UiFrame {
  const columns = dimension(viewport.columns)
  const rows = dimension(viewport.rows)
  const normalizedViewport = { columns, rows }
  const baseInput: DshTuiInputMode = view.input ?? { kind: 'prompt', editor: view.prompt }
  const pendingInteraction = focusedInteraction(view.interaction, baseInput)
  if (pendingInteraction?.kind === 'question' && view.interaction !== undefined) {
    return floatingSecondaryFrame(normalizedViewport, 'compact', surface => (
      renderQuestionInteractionFrame(pendingInteraction, view.interaction!, baseInput, surface)
    ))
  }
  const approval = pendingInteraction?.kind === 'approval' ? pendingInteraction : undefined
  const approvalBudget = approvalLayoutBudget(normalizedViewport)
  const approvalDock = approval === undefined ? undefined
    : buildApprovalDock(approval, view.interaction!, baseInput, columns, approvalBudget.dockRows)
  const approvalSpans = approvalDock?.styledLines.map(line => {
    let column = 0
    return line.segments.map(segment => {
      const width = visibleWidth(segment.text)
      const span: UiFrameStyleSpan = { column, width, style: {
        tone: segment.tone, backgroundRole: 'panelBackground',
        ...(segment.bold === undefined ? {} : { bold: segment.bold }),
      } }
      column += width
      return span
    })
  })
  if (approvalDock !== undefined && approvalBudget.compactOnly) {
    const lines = Array.from({ length: rows }, (_, index) => approvalDock.lines[index] ?? '')
    return {
      title: 'DSH-TUI', viewport: normalizedViewport, lines,
      lineStyles: lines.map(() => ({ tone: 'primary', backgroundRole: 'panelBackground', fill: true })),
      styleSpans: approvalSpans!,
    }
  }
  const renderSecondary = (kind: Parameters<typeof floatingSecondaryFrame>[1], render: (surface: TerminalViewport) => UiFrame): UiFrame => {
    const descriptor = legacyWorkspaceDescriptor(view)
    return descriptor === undefined
      ? floatingSecondaryFrame(normalizedViewport, kind, render)
      : renderLegacyWorkspaceFrame(normalizedViewport, descriptor, render)
  }
  if (approval === undefined && view.providerConnect !== undefined) {
    return renderSecondary('picker', surface => (
      renderProviderConnectFrame(view.providerConnect!, surface)
    ))
  }
  if (approval === undefined && view.sessionFork !== undefined) {
    return renderSecondary('compact', surface => (
      renderSessionForkFrame(view.sessionFork!, surface)
    ))
  }
  if (approval === undefined && view.sessionInspection !== undefined) {
    const kind = view.sessionInspection.kind === 'confirm-resume' ? 'compact' : 'directory'
    return renderSecondary(kind, surface => (
      renderSessionInspectionFrame(view.sessionInspection!, surface)
    ))
  }
  if (approval === undefined && view.sessionPicker !== undefined) {
    return renderSecondary('picker', surface => (
      renderSessionDirectoryFrame(view.sessionPicker!, surface)
    ))
  }
  if (approval === undefined && view.permissionPicker !== undefined) {
    return renderSecondary('compact', surface => (
      renderPermissionWorkspace(
        view.permissionPicker!,
        surface,
        view.commandNotice,
      )
    ))
  }
  if (approval === undefined && view.modePicker !== undefined) {
    return renderSecondary('compact', surface => (
      renderModePickerFrame(view.modePicker!, surface, view.modeNotice)
    ))
  }
  if (approval === undefined && view.skillPicker !== undefined) {
    return renderSecondary('directory', surface => (
      renderSkillPickerFrame(view.skillPicker!, surface)
    ))
  }
  if (approval === undefined && view.toolBrowser !== undefined) {
    return renderSecondary('directory', surface => (
      renderToolBrowserFrame(view.toolBrowser!, surface)
    ))
  }
  if (approval === undefined && view.mcpBrowser !== undefined) {
    return renderSecondary('directory', surface => (
      renderMcpCapabilityFrame(view.mcpBrowser!, surface)
    ))
  }
  if (approval === undefined && view.runtimeLibrary !== undefined) {
    if (view.runtimeLibrary.page !== undefined) return renderSettingsPageFrame({
      ...view.runtimeLibrary.page, navigationKeys: view.preferences?.navigationKeys ?? 'both',
    }, normalizedViewport)
    return renderSecondary('library', surface => (
      renderRuntimeLibraryFrame(view.runtimeLibrary!, surface)
    ))
  }
  if (approval === undefined && view.modelPicker !== undefined) {
    return renderSecondary('catalog', surface => (
      renderModelPickerFrame(view.modelPicker!, surface)
    ))
  }
  if (approval === undefined && view.activityCenter !== undefined) {
    return renderSecondary('directory', surface => (
      renderActivityCenterFrame(view.activityCenter!, surface)
    ))
  }
  if (approval === undefined && view.jobsActivity !== undefined) {
    return renderSecondary('compact', surface => (
      renderLegacyJobsActivityFrame(view.jobsActivity!, surface)
    ))
  }
  if (approval === undefined && view.contextPanel === true) {
    const activeSessionId = view.ui.activeSessionId
    return renderSecondary('compact', surface => (
      renderContextFrame(
        view.context ?? { available: false },
        activeSessionId ?? 'no-session',
        surface,
        activeSessionId === undefined ? undefined : view.ui.sessions[activeSessionId]?.compaction,
        view.contextPanelOffset,
      )
    ))
  }
  if (approval === undefined && view.attemptPanel !== undefined) {
    return renderSecondary('attempts', surface => (
      renderAttemptFrame(view.attemptPanel!, surface, view.attemptNavigation)
    ))
  }
  if (approval === undefined && view.routePanel !== undefined) {
    return renderSecondary('routes', surface => (
      renderRouteFrame(view.routePanel!, surface, view.routeNavigation)
    ))
  }
  if (approval === undefined && view.featureSurface !== undefined
    && view.featureSurface.host.navigation.route.kind !== 'chat') {
    return renderFeatureSurfaceFrame(
      view.featureSurface,
      normalizedViewport,
      `DSH-TUI · ${view.ui.activeSessionId ?? 'no-session'}`,
    )
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
  const input: DshTuiFrameInputMode = approval !== undefined
    ? { kind: 'prompt', editor: view.prompt }
    : view.goalActions === undefined ? baseInput
    : {
        kind: 'goal-action',
        editor: view.goalActions.editor,
        stage: view.goalActions.stage,
        ...(view.goalActions.error === undefined ? {} : { error: view.goalActions.error }),
      }
  const deferFlatFallback = options.deferFlatFallback === true
  const timeline: FrameBlock[] = []
  const conversationNodes: ConversationNode[] = []
  let currentTurnHasAnswer = false
  if (session?.omittedRowCount !== undefined) {
    conversationNodes.push({
      kind: 'notice',
      key: 'projection-omission',
      revision: String(session.omittedRowCount),
      lines: [`… ${session.omittedRowCount} earlier projected rows omitted`],
    })
  }
  if (session !== undefined) {
    const transcript = projectTranscript(
      session.rows,
      session.openTurn,
      columns,
      view.toolCards,
      view.transcriptViewMode ?? 'compact',
      view.reasoningExpanded === true,
      !deferFlatFallback,
      view.projectionCache,
      view.preferences?.density ?? 'compact',
    )
    timeline.push(...transcript.timeline)
    conversationNodes.push(...transcript.nodes)
    const requestTurn = agentRequestTurn(session.openTurn, view.agentRequest)
    currentTurnHasAnswer = requestTurn !== undefined && transcript.answerTurns.has(requestTurn)
    const ending = turnEndNotice(session.lastTurnEnd)
    if (ending !== undefined) conversationNodes.push(ending)
  }
  const recentJobs = jobs.slice(-3)
  const omittedJobs = jobs.length - recentJobs.length
  if (omittedJobs > 0) {
    const omittedLine = `… ${omittedJobs} earlier background jobs`
    if (!deferFlatFallback) timeline.push(boundedCard('ACTIVITY', [omittedLine], columns))
    conversationNodes.push({
      kind: 'notice',
      key: 'activity-omission',
      revision: `${jobsGeneration}:${omittedJobs}`,
      lines: [omittedLine],
    })
  }
  for (const job of recentJobs) {
    const lines = jobCardLines(job, columns)
    if (!deferFlatFallback) timeline.push(boundedCard(`ACTIVITY · ${job.id}`, lines, columns))
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
  const agentRequest = visibleAgentRequest(view.agentRequest, currentTurnHasAnswer)
  if (!deferFlatFallback && agentRequest !== undefined) {
    timeline.push(flatTranscriptBlock({
      kind: 'assistant-draft',
      key: `request:${agentRequest.turn ?? 'unknown'}`,
      revision: `${agentRequest.phase}:${agentRequest.description}`,
      text: '',
      activitySummary: `✦ ${agentRequest.phase.toUpperCase()} · ${agentRequest.description}`,
    }, columns))
  }
  let focus: FrameBlock | undefined
  let dock: ConversationDock | undefined
  if (approval !== undefined) {
    dock = approvalDock
  } else if (view.commandMenu !== undefined) {
    const lines = commandMenuLines(view.commandMenu, columns)
    focus = commandMenuBlock(lines)
    dock = {
      label: 'COMMANDS',
      role: 'command',
      lines,
      styledLines: commandMenuStyles(lines),
    }
  } else if (view.goalActions !== undefined) {
    focus = boundedCard('GOAL ACTIONS', goalActionLines(view.goalActions, columns), columns)
    dock = {
      label: 'GOAL ACTIONS',
      role: 'interaction',
      lines: focus.plain,
    }
  }
  const statuslineVisible = rows >= 5 && statusline !== undefined
  const separatorVisible = rows >= 6
  const approvalLines = dock?.inline === true ? dock.lines : []
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
      - (separatorVisible ? 1 : 0)
      - approvalLines.length
      - (noticeVisible ? 1 : 0)
      - (rows >= 4 ? 1 : 0),
  )
  const composerBoxed = rows >= 6
    && columns >= 12
    && availableComposerRows >= 3
  const composerMaxRows = Math.min(6, availableComposerRows)
  const composerLayout = deferFlatFallback
    ? undefined
    : layoutConversationComposer(
        input.editor.text,
        input.editor.cursor,
        inputPrefix(input),
        composerLabel,
        composerBoxed,
        columns,
        composerMaxRows,
        view.attachments,
      )
  const bodySlots = Math.max(
    0,
    rows
      - 1
      - dashboardLines.length
      - (statuslineVisible ? 1 : 0)
      - (separatorVisible ? 1 : 0)
      - approvalLines.length
      - (noticeVisible ? 1 : 0)
      - (composerLayout?.lines.length ?? 1),
  )
  const emptySession = session !== undefined
    && session.rows.length === 0
    && jobs.length === 0
    && focus === undefined
  const visibleBody = deferFlatFallback
    ? []
    : emptySession
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
      lines: deferFlatFallback
        ? workbenchHomeLines(normalizedViewport, view.workbench)
        : centeredBodyLines(workbenchHomeLines(normalizedViewport, view.workbench), bodySlots),
    })
  }
  const conversation: ConversationSurface = {
    density: view.preferences?.density ?? 'compact',
    reducedMotion: view.preferences?.reducedMotion === true,
    sessionId: identity,
    bindingEpoch: view.bindingEpoch ?? 0,
    header,
    nodes: conversationNodes,
    ...(dock === undefined ? {} : { dock }),
    ...(dashboard === undefined ? {} : { dashboard }),
    ...(statusline === undefined ? {} : { statusline }),
    ...(view.attachments === undefined ? {} : { attachments: view.attachments }),
    composer: input.editor.text,
    composerColumn: input.editor.cursor,
    composerPrefix: inputPrefix(input),
    composerLabel,
    composerBoxed,
    composerMaxRows,
    composerDisabled: approval !== undefined,
    footer: notice,
    reasoningExpanded: view.reasoningExpanded === true,
    ...(agentRequest === undefined ? {} : { agentRequest }),
    followRequest: view.followRequest ?? 0,
  }
  const flatFallback = deferFlatFallback
    ? () => renderDshFrame(view, normalizedViewport)
    : undefined

  if (deferFlatFallback) {
    return {
      title: 'DSH-TUI',
      viewport: normalizedViewport,
      lines: [header],
      conversation,
      flatFallback: flatFallback!,
    }
  }

  const prompt = promptProjection(input.editor, columns, inputPrefix(input))

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
    ...(separatorVisible ? [''] : []),
    ...approvalLines,
    ...composerLayout!.lines,
    ...(statuslineVisible ? [statusline.text] : []),
  ].map(line => fitLine(line, columns))
  const composerStart = 1
    + dashboardLines.length
    + visibleBody.length
    + (noticeVisible ? 1 : 0)
    + (separatorVisible ? 1 : 0)
    + approvalLines.length
  return {
    title: 'DSH-TUI',
    viewport: normalizedViewport,
    lines,
    lineStyles: lines.map((_, index) => index >= composerStart && index < composerStart + composerLayout!.lines.length
      ? { tone: 'primary' as const, backgroundRole: 'inputBackground' as const, fill: true }
      : index >= composerStart - approvalLines.length && index < composerStart
        ? { tone: 'primary' as const, backgroundRole: 'panelBackground' as const, fill: true }
        : undefined),
    ...(approvalSpans === undefined ? {} : { styleSpans: lines.map((_, index) =>
      approvalSpans[index - (composerStart - approvalLines.length)] ?? []) }),
    ...(approval === undefined ? { cursor: {
      row: composerStart + composerLayout!.cursor.row,
      column: composerLayout!.cursor.column,
    } } : {}),
    conversation,
  }
}
