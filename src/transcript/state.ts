import type {
  AgentStatus,
  DurableDshEnvelope,
  LiveSourceId,
  SessionId,
  UiAssistantDelta,
  UiMessage,
  UiTodoItem,
  UiTokenUsage,
  UiCommandSource,
} from '../runtime/events.ts'
import type { ToolPresentationView } from '../presentation/types.ts'

export type StepKey = `${number}:${number}`
export type ToolKey = `${number}:${number}:${string}`
export type CommandKey = `command:${string}`

/**
 * Hard item-count bounds for product-owned projection caches. The official
 * DSH Session.events log remains the unbounded durable owner and replay source.
 */
export const UI_PROJECTION_LIMITS = Object.freeze({
  journalEvents: 256,
  pendingEvents: 256,
  transcriptRows: 512,
  replacements: 128,
  draftChunks: 64,
})

export interface UserRow {
  readonly kind: 'user'
  readonly key: `event:${number}`
  readonly seq: number
  readonly message: UiMessage
}

export interface AssistantDraftRow {
  readonly kind: 'assistant-draft'
  readonly key: `draft:${StepKey}`
  readonly firstSeq: number
  readonly turn: number
  readonly step: number
  readonly chunks: readonly { readonly seq: number; readonly chunk: UiAssistantDelta }[]
  /** Older chunks coalesced out of this intermediate-only rendering cache. */
  readonly omittedChunkCount?: number
}

export interface AssistantRow {
  readonly kind: 'assistant'
  readonly key: `event:${number}`
  readonly seq: number
  readonly turn: number
  readonly step: number
  readonly message: UiMessage
  readonly usage?: UiTokenUsage
  readonly interrupted: boolean
}

export interface ToolRow {
  readonly kind: 'tool'
  readonly key: `tool:${ToolKey}`
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly callSeq?: number
  readonly name?: string
  readonly arguments?: string
  readonly resultSeq?: number
  readonly result?: UiMessage
  readonly error?: { readonly name: string; readonly code: string }
  readonly meta?: unknown
  /** Ephemeral presenter output; never copied into the durable journal. */
  readonly callPresentation?: Extract<ToolPresentationView, { phase: 'call' }>
  /** Ephemeral presenter output; never participates in durable seq equality. */
  readonly resultPresentation?: Extract<ToolPresentationView, { phase: 'result' }>
}

/** Finite protocol flags keep malformed command logs inspectable without unbounded diagnostics. */
export interface CommandProtocolDiagnostics {
  readonly doneWithoutRun?: true
  readonly duplicateRun?: true
  readonly duplicateDone?: true
}

/** Structured result correlated from the official compaction transaction. */
export interface CommandCompactionSummary {
  readonly compactionId: string
  readonly summarySeq: number
  readonly shadowedItemCount: number
  readonly shadowedTokenCount: number
  readonly provider: string
  readonly model: string
}

/** One durable slash-command lifecycle, paired by the official commandId. */
export interface CommandRow {
  readonly kind: 'command'
  readonly key: CommandKey
  readonly commandId: string
  readonly status: 'running' | 'success' | 'error'
  readonly runSeq?: number
  readonly name?: string
  /** Missing remains missing; the TUI never recreates command input from local editor state. */
  readonly args?: string
  readonly source?: UiCommandSource
  readonly doneSeq?: number
  readonly text?: string
  readonly sourceEventSeq?: number
  readonly compaction?: CommandCompactionSummary
  readonly protocolDiagnostics?: CommandProtocolDiagnostics
}

export type TranscriptRow = UserRow | AssistantDraftRow | AssistantRow | ToolRow | CommandRow

export interface ContextReplacement {
  readonly seq: number
  readonly eventType: 'user/message' | 'assistant/message' | 'tool/result'
  readonly start: number
  readonly end: number
}

export interface UiFailure {
  readonly code: string
  readonly message: string
}

/** Latest official compaction lifecycle for status and context presentation. */
export interface SessionCompactionState {
  readonly compactionId: string
  readonly sourceCommandId?: string
  readonly phase: 'running' | 'completed' | 'failed'
  readonly startSeq: number
  readonly summarySeq?: number
  readonly endSeq?: number
  readonly shadowedItemCount?: number
  readonly shadowedTokenCount?: number
  readonly provider?: string
  readonly model?: string
  readonly error?: string
}

export interface SessionUiState {
  readonly sessionId: SessionId
  /** Bounded applied-event tail; offset i has seq journalStartSeq + i. */
  readonly journal: readonly DurableDshEnvelope[]
  /** Defaults to zero for states constructed before bounded projection. */
  readonly journalStartSeq?: number
  /** Out-of-order arrivals waiting for all smaller seq values. */
  readonly pendingBySeq: Readonly<Record<number, DurableDshEnvelope>>
  readonly rows: readonly TranscriptRow[]
  /** Rows evicted from the front of the terminal projection window. */
  readonly omittedRowCount?: number
  readonly todos: readonly UiTodoItem[]
  readonly replacements: readonly ContextReplacement[]
  /** Replacement diagnostics evicted from the front of their bounded tail. */
  readonly omittedReplacementCount?: number
  readonly agentStatus: AgentStatus
  readonly liveSourceId?: LiveSourceId | undefined
  readonly openTurn?: number | undefined
  readonly openStep?: { readonly turn: number; readonly step: number } | undefined
  readonly lastTurnEnd?: { readonly turn: number; readonly reason: unknown } | undefined
  readonly compaction?: SessionCompactionState
  readonly compatibilityError?: UiFailure | undefined
}

export interface UiState {
  readonly phase: 'booting' | 'ready' | 'stopping' | 'stopped'
  readonly activeSessionId?: SessionId | undefined
  readonly sessions: Readonly<Record<string, SessionUiState>>
  /** Last applied ordinal for each live source. */
  readonly runtimeCursor: Readonly<Record<string, number>>
}

export function createSessionUiState(sessionId: SessionId): SessionUiState {
  return {
    sessionId,
    journal: [],
    pendingBySeq: {},
    rows: [],
    todos: [],
    replacements: [],
    agentStatus: 'idle',
  }
}

export function createUiState(): UiState {
  return {
    phase: 'booting',
    sessions: {},
    runtimeCursor: {},
  }
}
