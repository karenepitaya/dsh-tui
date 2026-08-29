/** Stable product-owned session identity. The real adapter preserves DSH ids verbatim. */
export type SessionId = string

/** Stable product-owned live lifecycle identity. It is never persisted as a DSH session id. */
export type LiveSourceId = string

export type AgentStatus = 'idle' | 'running' | 'disposed'

export interface UiTextContentBlock {
  readonly type: 'text'
  readonly text: string
}

export interface UiReasoningContentBlock {
  readonly type: 'reasoning'
  readonly text: string
}

/** Product-owned, display-safe copy of one durable DSH image reference. */
export interface UiImageAttachmentRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: {
    readonly width: number
    readonly height: number
  }
}

export interface UiImageContentBlock {
  readonly type: 'image'
  readonly attachment: UiImageAttachmentRef
}

export interface UiToolCallContentBlock {
  readonly type: 'tool-call'
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/**
 * Forward-compatible content marker. The adapter intentionally retains no
 * arbitrary payload, so an extension block cannot smuggle `.text` into the
 * visible answer before DSH-TUI explicitly understands that vocabulary.
 */
export interface UiUnsupportedContentBlock {
  readonly type: 'unsupported'
  readonly sourceType: string
}

export type UiContentBlock =
  | UiTextContentBlock
  | UiReasoningContentBlock
  | UiImageContentBlock
  | UiToolCallContentBlock
  | UiUnsupportedContentBlock

export interface UiMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly sourceKind: string
  readonly content: readonly UiContentBlock[]
}

export interface UiTextDelta {
  readonly type: 'text-delta'
  readonly index: number
  readonly text: string
}

export interface UiReasoningDelta {
  readonly type: 'reasoning-delta'
  readonly index: number
  readonly text: string
}

export type UiAssistantDelta = UiTextDelta | UiReasoningDelta

/**
 * A durable stream chunk that has no direct transcript projection. Control
 * chunks still occupy their original journal seq but carry no untrusted body.
 */
export interface UiUnsupportedAssistantChunk {
  readonly type: 'unsupported'
  readonly sourceType: string
}

export type UiAssistantChunk = UiAssistantDelta | UiUnsupportedAssistantChunk

export interface UiTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** Display-safe provider-neutral failure facts from the official LLM boundary. */
export interface UiLlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
}

/** One durable retry wait scheduled by the official provider-owned policy. */
export type UiLlmRetryScheduled =
  | {
      readonly retryId: string
      readonly turn: number
      readonly step: number
      readonly provider: string
      readonly mode: 'normal'
      readonly policyKey: string
      readonly retry: number
      readonly maxRetries: number
      readonly delayMs: number
      readonly failure: UiLlmFailure
    }
  | {
      readonly retryId: string
      readonly turn: number
      readonly step: number
      readonly provider: string
      readonly mode: 'always'
      readonly policyKey: string
      readonly retry: number
      readonly delayMs: number
      readonly failure: UiLlmFailure
    }

/** Durable transition written after the wait and before the next request. */
export interface UiLlmRetryStarted {
  readonly retryId: string
  readonly turn: number
  readonly step: number
  readonly retry: number
}

/** Display-safe request configuration projected from an official header epoch. */
export interface UiRequestCallConfig {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
}

/** Marks effective fields supplied by the exact resolved adapter. */
export interface UiRequestAdapterDefaults {
  readonly reasoningEffort?: true
  readonly maxTokens?: true
}

/** Safe subset of one durable official request-header snapshot. */
export interface UiRequestHeaderSnapshot {
  readonly reason: 'initial' | 'resume' | 'change'
  readonly config: UiRequestCallConfig
  readonly adapterDefaults?: UiRequestAdapterDefaults
}

/** Registered route capacity recorded for the next request. */
export interface UiRequestContext {
  readonly provider: string
  readonly model: string
  readonly contextWindow?: number
}

export interface UiTodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** Product-owned view of the merge-extensible official command producer. */
export interface UiCommandSource {
  readonly kind: string
}

/** Product-owned identity shared by one official compaction transaction. */
export interface UiCompactionLifecycle {
  readonly compactionId: string
  readonly sourceCommandId?: string
  readonly turn: number | null
}

/** Display-safe accounting from an official compaction summary event. */
export interface UiCompactionSummary {
  readonly compactionId: string
  readonly sourceCommandId?: string
  readonly shadowedRange: { readonly start: number; readonly end: number }
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly provider: string
  readonly model: string
}

export type SurfaceOp =
  | 'append'
  | { readonly op: 'replace'; readonly start: number; readonly end: number }

export interface DshDurableEventMap {
  'turn/start': { readonly turn: number }
  'turn/end': { readonly turn: number; readonly reason: unknown }
  'step/start': { readonly turn: number; readonly step: number }
  'step/end': { readonly turn: number; readonly step: number }
  'user/message': {
    readonly message: UiMessage
    readonly surfaceOp: SurfaceOp
  }
  'assistant/chunk': {
    readonly turn: number
    readonly step: number
    readonly chunk: UiAssistantChunk
  }
  'assistant/message': {
    readonly turn: number
    readonly step: number
    readonly message: UiMessage
    readonly surfaceOp: SurfaceOp
    readonly usage?: UiTokenUsage
    readonly interrupted?: true
  }
  'llm/retry': UiLlmRetryScheduled
  'llm/retry-started': UiLlmRetryStarted
  'request/header': UiRequestHeaderSnapshot
  'request/context': UiRequestContext
  'command/run': {
    readonly commandId: string
    readonly name: string
    /** Verbatim parser rawInput. Absent means the command intentionally did not record input. */
    readonly args?: string
    readonly source: UiCommandSource
  }
  'command/done': {
    readonly commandId: string
    readonly kind: 'success' | 'error'
    readonly text?: string
    readonly sourceEventSeq?: number
  }
  'compaction/start': UiCompactionLifecycle
  'compaction/summary': UiCompactionSummary
  'compaction/end': UiCompactionLifecycle & { readonly error?: string }
  'tool/call': {
    readonly turn: number
    readonly step: number
    readonly callId: string
    readonly name: string
    readonly arguments: string
  }
  'tool/result': {
    readonly turn: number
    readonly step: number
    readonly callId: string
    readonly message: UiMessage
    readonly surfaceOp: SurfaceOp
    readonly error?: { readonly name: string; readonly code: string }
    readonly meta?: unknown
  }
  'todo/write': { readonly todos: readonly UiTodoItem[] }
  /**
   * A recognized DSH event with no M0 projection. Keeping the envelope advances
   * the contiguous durable cursor instead of introducing a false gap.
   */
  'session/observed': {
    readonly sourceType: string
    readonly ignorable: boolean
  }
  /**
   * A required event that this adapter version cannot reconstruct. The reducer
   * records a compatibility failure and refuses to pretend replay succeeded.
   */
  'session/unsupported': { readonly sourceType: string }
}

export type DshDurableEvent = {
  [K in keyof DshDurableEventMap]: {
    readonly type: K
    readonly data: DshDurableEventMap[K]
  }
}[keyof DshDurableEventMap]

export type DurableDshEnvelope = DshDurableEvent & {
  readonly plane: 'durable'
  readonly sessionId: SessionId
  /** DSH invariant: the canonical session log stores event n at seq n. */
  readonly seq: number
  readonly time: number
  /** Preserved so duplicate comparison includes the official compatibility marker. */
  readonly ignorable?: true
  /** Preserved for replay diagnostics and surface replacement provenance. */
  readonly sourceEventSeqs?: readonly number[]
}

export interface DshRuntimeEventMap {
  'agent/created': { readonly status: 'idle' | 'running' }
  'agent/status': { readonly status: 'idle' | 'running' }
  'agent/disposed': Record<string, never>
}

export type DshRuntimeEvent = {
  [K in keyof DshRuntimeEventMap]: {
    readonly type: K
    readonly data: DshRuntimeEventMap[K]
  }
}[keyof DshRuntimeEventMap]

export type RuntimeDshEnvelope = DshRuntimeEvent & {
  readonly plane: 'runtime'
  readonly sessionId: SessionId
  readonly sourceId: LiveSourceId
  /** Product-owned order within one live source; it is not a durable session seq. */
  readonly ordinal: number
  readonly time: number
}

export type DshTuiEvent = DurableDshEnvelope | RuntimeDshEnvelope
