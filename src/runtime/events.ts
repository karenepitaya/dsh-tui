/** Stable product-owned session identity. The real adapter preserves DSH ids verbatim. */
export type SessionId = string

/** Stable product-owned live lifecycle identity. It is never persisted as a DSH session id. */
export type LiveSourceId = string

export type AgentStatus = 'idle' | 'running' | 'disposed'

export interface UiMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly sourceKind: string
  readonly content: readonly unknown[]
}

export interface UiTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

export interface UiTodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** Product-owned view of the merge-extensible official command producer. */
export interface UiCommandSource {
  readonly kind: string
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
    readonly chunk: unknown
  }
  'assistant/message': {
    readonly turn: number
    readonly step: number
    readonly message: UiMessage
    readonly surfaceOp: SurfaceOp
    readonly usage?: UiTokenUsage
    readonly interrupted?: true
  }
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
