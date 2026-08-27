import type {
  DshTuiEvent,
  DurableDshEnvelope,
  RuntimeDshEnvelope,
  SurfaceOp,
} from '../runtime/events.ts'
import type { DshToolPresentationAnnotation } from '../dsh/tool-presentation.ts'
import {
  UI_PROJECTION_LIMITS,
  createSessionUiState,
  type AssistantDraftRow,
  type AssistantRow,
  type CommandCompactionSummary,
  type CommandRow,
  type ContextReplacement,
  type SessionUiState,
  type ToolRow,
  type TranscriptRow,
  type UiFailure,
  type UiState,
  type UserRow,
} from './state.ts'

function journalStart(session: SessionUiState): number {
  return session.journalStartSeq ?? 0
}

function nextDurableSeq(session: SessionUiState): number {
  return journalStart(session) + session.journal.length
}

function withRows(
  session: SessionUiState,
  rows: readonly TranscriptRow[],
): SessionUiState {
  const overflow = Math.max(0, rows.length - UI_PROJECTION_LIMITS.transcriptRows)
  return {
    ...session,
    rows: overflow === 0 ? rows : rows.slice(overflow),
    ...(overflow === 0
      ? {}
      : { omittedRowCount: (session.omittedRowCount ?? 0) + overflow }),
  }
}

function withReplacement(
  session: SessionUiState,
  value: ContextReplacement,
): SessionUiState {
  const replacements = [...session.replacements, value]
  const overflow = Math.max(0, replacements.length - UI_PROJECTION_LIMITS.replacements)
  return {
    ...session,
    replacements: overflow === 0 ? replacements : replacements.slice(overflow),
    ...(overflow === 0
      ? {}
      : {
          omittedReplacementCount:
            (session.omittedReplacementCount ?? 0) + overflow,
        }),
  }
}

function stepKey(turn: number, step: number): `${number}:${number}` {
  return `${turn}:${step}`
}

function toolKey(turn: number, step: number, callId: string): `${number}:${number}:${string}` {
  return `${turn}:${step}:${callId}`
}

function commandKey(commandId: string): `command:${string}` {
  return `command:${commandId}`
}

function failure(code: string, message: string): UiFailure {
  return { code, message }
}

function withFailure(session: SessionUiState, value: UiFailure): SessionUiState {
  return {
    ...session,
    compatibilityError: session.compatibilityError ?? value,
  }
}

function sameDurableEvent(left: DurableDshEnvelope, right: DurableDshEnvelope): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function replacement(
  event: DurableDshEnvelope,
  eventType: ContextReplacement['eventType'],
  surfaceOp: Exclude<SurfaceOp, 'append'>,
): ContextReplacement {
  return {
    seq: event.seq,
    eventType,
    start: surfaceOp.start,
    end: surfaceOp.end,
  }
}

function replaceRow(
  rows: readonly TranscriptRow[],
  index: number,
  row: TranscriptRow | undefined,
): readonly TranscriptRow[] {
  if (index < 0) return row === undefined ? rows : [...rows, row]
  if (row === undefined) return [...rows.slice(0, index), ...rows.slice(index + 1)]
  return rows.with(index, row)
}

function projectUserMessage(
  session: SessionUiState,
  event: Extract<DurableDshEnvelope, { type: 'user/message' }>,
): SessionUiState {
  if (event.data.surfaceOp !== 'append') {
    return withReplacement(
      session,
      replacement(event, event.type, event.data.surfaceOp),
    )
  }
  if (event.data.message.sourceKind !== 'user') return session
  const row: UserRow = {
    kind: 'user',
    key: `event:${event.seq}`,
    seq: event.seq,
    message: event.data.message,
  }
  return withRows(session, [...session.rows, row])
}

function projectAssistantChunk(
  session: SessionUiState,
  event: Extract<DurableDshEnvelope, { type: 'assistant/chunk' }>,
): SessionUiState {
  if (event.data.chunk.type === 'unsupported') return session
  const key = `draft:${stepKey(event.data.turn, event.data.step)}` as const
  const index = session.rows.findIndex(row => row.key === key)
  const existing = index < 0 ? undefined : session.rows[index]
  const allChunks = existing?.kind === 'assistant-draft'
    ? [...existing.chunks, { seq: event.seq, chunk: event.data.chunk }]
    : [{ seq: event.seq, chunk: event.data.chunk }]
  const overflow = Math.max(0, allChunks.length - UI_PROJECTION_LIMITS.draftChunks)
  const chunks = overflow === 0 ? allChunks : allChunks.slice(overflow)
  const omittedChunkCount =
    (existing?.kind === 'assistant-draft' ? existing.omittedChunkCount ?? 0 : 0) + overflow
  const row: AssistantDraftRow = {
    kind: 'assistant-draft',
    key,
    firstSeq: existing?.kind === 'assistant-draft' ? existing.firstSeq : event.seq,
    turn: event.data.turn,
    step: event.data.step,
    chunks,
    ...(omittedChunkCount === 0 ? {} : { omittedChunkCount }),
  }
  return withRows(session, replaceRow(session.rows, index, row))
}

function projectAssistantMessage(
  session: SessionUiState,
  event: Extract<DurableDshEnvelope, { type: 'assistant/message' }>,
): SessionUiState {
  const draftKey = `draft:${stepKey(event.data.turn, event.data.step)}`
  const draftIndex = session.rows.findIndex(row => row.key === draftKey)
  if (event.data.surfaceOp !== 'append') {
    return withReplacement(
      withRows(session, replaceRow(session.rows, draftIndex, undefined)),
      replacement(event, event.type, event.data.surfaceOp),
    )
  }
  if (event.data.message.content.length === 0) {
    return withRows(session, replaceRow(session.rows, draftIndex, undefined))
  }
  const row: AssistantRow = {
    kind: 'assistant',
    key: `event:${event.seq}`,
    seq: event.seq,
    turn: event.data.turn,
    step: event.data.step,
    message: event.data.message,
    ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
    interrupted: event.data.interrupted === true,
  }
  return withRows(session, replaceRow(session.rows, draftIndex, row))
}

function projectToolCall(
  session: SessionUiState,
  event: Extract<DurableDshEnvelope, { type: 'tool/call' }>,
): SessionUiState {
  const key = `tool:${toolKey(event.data.turn, event.data.step, event.data.callId)}` as const
  const index = session.rows.findIndex(row => row.key === key)
  const previous = index < 0 ? undefined : session.rows[index]
  const row: ToolRow = {
    ...(previous?.kind === 'tool' ? previous : {}),
    kind: 'tool',
    key,
    turn: event.data.turn,
    step: event.data.step,
    callId: event.data.callId,
    callSeq: event.seq,
    name: event.data.name,
    arguments: event.data.arguments,
  }
  return withRows(session, replaceRow(session.rows, index, row))
}

function projectToolResult(
  session: SessionUiState,
  event: Extract<DurableDshEnvelope, { type: 'tool/result' }>,
): SessionUiState {
  if (event.data.surfaceOp !== 'append') {
    return withReplacement(
      session,
      replacement(event, event.type, event.data.surfaceOp),
    )
  }
  const key = `tool:${toolKey(event.data.turn, event.data.step, event.data.callId)}` as const
  const index = session.rows.findIndex(row => row.key === key)
  const previous = index < 0 ? undefined : session.rows[index]
  const callFields = previous?.kind === 'tool' && previous.callSeq !== undefined
    ? {
        callSeq: previous.callSeq,
        name: previous.name!,
        arguments: previous.arguments!,
        ...(previous.callPresentation === undefined
          ? {}
          : { callPresentation: previous.callPresentation }),
      }
    : {}
  const row: ToolRow = {
    kind: 'tool',
    key,
    turn: event.data.turn,
    step: event.data.step,
    callId: event.data.callId,
    ...callFields,
    resultSeq: event.seq,
    result: event.data.message,
    ...(event.data.error === undefined ? {} : { error: event.data.error }),
    ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
  }
  return withRows(session, replaceRow(session.rows, index, row))
}

function projectCommandRun(
  session: SessionUiState,
  event: Extract<DurableDshEnvelope, { type: 'command/run' }>,
): SessionUiState {
  const key = commandKey(event.data.commandId)
  const index = session.rows.findIndex(row => row.key === key)
  // Transcript key namespaces are disjoint, so a command:* match is a CommandRow.
  const previous = index < 0 ? undefined : session.rows[index] as CommandRow
  if (previous?.runSeq !== undefined) {
    return withRows(session, replaceRow(session.rows, index, {
      ...previous,
      protocolDiagnostics: {
        ...previous.protocolDiagnostics,
        duplicateRun: true,
      },
    }))
  }

  const run = {
    runSeq: event.seq,
    name: event.data.name,
    ...(event.data.args === undefined ? {} : { args: event.data.args }),
    source: event.data.source,
  }
  const row: CommandRow = previous === undefined
    ? {
        kind: 'command',
        key,
        commandId: event.data.commandId,
        status: 'running',
        ...run,
      }
    : { ...previous, ...run }
  return withRows(session, replaceRow(session.rows, index, row))
}

function projectCommandDone(
  session: SessionUiState,
  event: Extract<DurableDshEnvelope, { type: 'command/done' }>,
): SessionUiState {
  const key = commandKey(event.data.commandId)
  const index = session.rows.findIndex(row => row.key === key)
  const previous = index < 0 ? undefined : session.rows[index] as CommandRow
  if (previous?.doneSeq !== undefined) {
    return withRows(session, replaceRow(session.rows, index, {
      ...previous,
      protocolDiagnostics: {
        ...previous.protocolDiagnostics,
        duplicateDone: true,
      },
    }))
  }

  const done = {
    status: event.data.kind,
    doneSeq: event.seq,
    ...(event.data.text === undefined ? {} : { text: event.data.text }),
    ...(event.data.sourceEventSeq === undefined
      ? {}
      : { sourceEventSeq: event.data.sourceEventSeq }),
  } as const
  const row: CommandRow = previous === undefined
    ? {
        kind: 'command',
        key,
        commandId: event.data.commandId,
        ...done,
        protocolDiagnostics: { doneWithoutRun: true },
      }
    : { ...previous, ...done }
  return withRows(session, replaceRow(session.rows, index, row))
}

function compactionSummary(
  event: Extract<DurableDshEnvelope, { type: 'compaction/summary' }>,
): CommandCompactionSummary {
  return {
    compactionId: event.data.compactionId,
    summarySeq: event.seq,
    shadowedItemCount: event.data.shadowedSeqs.length,
    shadowedTokenCount: event.data.shadowedTokenCount,
    provider: event.data.provider,
    model: event.data.model,
  }
}

function projectCompactionStart(
  session: SessionUiState,
  event: Extract<DurableDshEnvelope, { type: 'compaction/start' }>,
): SessionUiState {
  return {
    ...session,
    compaction: {
      compactionId: event.data.compactionId,
      ...(event.data.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: event.data.sourceCommandId }),
      phase: 'running',
      startSeq: event.seq,
    },
  }
}

function projectCompactionSummary(
  session: SessionUiState,
  event: Extract<DurableDshEnvelope, { type: 'compaction/summary' }>,
): SessionUiState {
  const summary = compactionSummary(event)
  const current = session.compaction?.compactionId === event.data.compactionId
    ? session.compaction
    : undefined
  const sourceCommandId = event.data.sourceCommandId ?? current?.sourceCommandId
  let next: SessionUiState = {
    ...session,
    compaction: {
      ...summary,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      phase: 'running',
      startSeq: current?.startSeq ?? event.seq,
    },
  }
  const commandId = event.data.sourceCommandId
  if (commandId === undefined) return next
  const index = next.rows.findIndex(row => row.key === commandKey(commandId))
  const row = next.rows[index]
  if (row?.kind !== 'command') return next
  next = withRows(next, replaceRow(next.rows, index, { ...row, compaction: summary }))
  return next
}

function projectCompactionEnd(
  session: SessionUiState,
  event: Extract<DurableDshEnvelope, { type: 'compaction/end' }>,
): SessionUiState {
  const current = session.compaction?.compactionId === event.data.compactionId
    ? session.compaction
    : undefined
  const sourceCommandId = event.data.sourceCommandId ?? current?.sourceCommandId
  return {
    ...session,
    compaction: {
      ...(current ?? {
        compactionId: event.data.compactionId,
        phase: 'running' as const,
        startSeq: event.seq,
      }),
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      phase: event.data.error === undefined ? 'completed' : 'failed',
      endSeq: event.seq,
      ...(event.data.error === undefined ? {} : { error: event.data.error }),
    },
  }
}

function projectDurable(session: SessionUiState, event: DurableDshEnvelope): SessionUiState {
  switch (event.type) {
    case 'turn/start':
      return {
        ...session,
        todos: [],
        openTurn: event.data.turn,
        lastTurnEnd: undefined,
      }
    case 'turn/end':
      return {
        ...session,
        openTurn: undefined,
        openStep: undefined,
        lastTurnEnd: event.data,
      }
    case 'step/start':
      return {
        ...session,
        openTurn: event.data.turn,
        openStep: event.data,
      }
    case 'step/end':
      return { ...session, openStep: undefined }
    case 'user/message':
      return projectUserMessage(session, event)
    case 'assistant/chunk':
      return projectAssistantChunk(session, event)
    case 'assistant/message':
      return projectAssistantMessage(session, event)
    case 'command/run':
      return projectCommandRun(session, event)
    case 'command/done':
      return projectCommandDone(session, event)
    case 'compaction/start':
      return projectCompactionStart(session, event)
    case 'compaction/summary':
      return projectCompactionSummary(session, event)
    case 'compaction/end':
      return projectCompactionEnd(session, event)
    case 'tool/call':
      return projectToolCall(session, event)
    case 'tool/result':
      return projectToolResult(session, event)
    case 'todo/write':
      return { ...session, todos: event.data.todos }
    case 'session/observed':
      return session
    case 'session/unsupported':
      return withFailure(
        session,
        failure(
          'UNSUPPORTED_REQUIRED_EVENT',
          `required DSH session event "${event.data.sourceType}" is unsupported`,
        ),
      )
  }
}

function applyDurableToSession(
  original: SessionUiState,
  incoming: DurableDshEnvelope,
): SessionUiState {
  if (!Number.isSafeInteger(incoming.seq) || incoming.seq < 0) {
    return withFailure(
      original,
      failure('INVALID_SEQUENCE', `durable event seq must be a non-negative safe integer, got ${incoming.seq}`),
    )
  }
  if (original.compatibilityError !== undefined) return original

  const expectedSeq = nextDurableSeq(original)
  if (incoming.seq < expectedSeq) {
    const retainedStart = journalStart(original)
    // The authoritative Session.events log owns old payloads. Once an event is
    // outside this bounded comparison tail, its seq is intentionally idempotent.
    if (incoming.seq < retainedStart) return original
    const existing = original.journal[incoming.seq - retainedStart]
    if (existing !== undefined && sameDurableEvent(existing, incoming)) return original
    return withFailure(
      original,
      failure('CONFLICTING_DUPLICATE', `durable event seq ${incoming.seq} conflicts with the applied journal`),
    )
  }

  const pending = { ...original.pendingBySeq }
  const waiting = pending[incoming.seq]
  if (waiting !== undefined) {
    if (sameDurableEvent(waiting, incoming)) return original
    return withFailure(
      original,
      failure('CONFLICTING_DUPLICATE', `durable event seq ${incoming.seq} conflicts with a buffered event`),
    )
  }
  if (
    incoming.seq > expectedSeq
    && Object.keys(pending).length >= UI_PROJECTION_LIMITS.pendingEvents
  ) {
    return withFailure(
      original,
      failure(
        'PROJECTION_RESYNC_REQUIRED',
        `durable gap cache exceeded ${UI_PROJECTION_LIMITS.pendingEvents} events before seq ${expectedSeq}; rebuild from authoritative Session.events`,
      ),
    )
  }
  pending[incoming.seq] = incoming

  let current: SessionUiState = { ...original, pendingBySeq: pending }
  while (current.compatibilityError === undefined) {
    const nextSeq = nextDurableSeq(current)
    const next = pending[nextSeq]
    if (next === undefined) break
    delete pending[nextSeq]
    const projected = projectDurable(current, next)
    const journal = [...current.journal, next]
    const journalOverflow = Math.max(
      0,
      journal.length - UI_PROJECTION_LIMITS.journalEvents,
    )
    current = {
      ...projected,
      journal: journalOverflow === 0 ? journal : journal.slice(journalOverflow),
      ...(journalOverflow === 0
        ? {}
        : { journalStartSeq: journalStart(current) + journalOverflow }),
      pendingBySeq: { ...pending },
    }
  }
  return current
}

function applyRuntimeToSession(
  session: SessionUiState,
  event: RuntimeDshEnvelope,
): SessionUiState {
  switch (event.type) {
    case 'agent/created':
      return {
        ...session,
        liveSourceId: event.sourceId,
        agentStatus: event.data.status,
      }
    case 'agent/status':
      return session.liveSourceId === event.sourceId
        ? { ...session, agentStatus: event.data.status }
        : session
    case 'agent/disposed':
      return session.liveSourceId === event.sourceId
        ? { ...session, liveSourceId: undefined, agentStatus: 'disposed' }
        : session
  }
}

function withSession(state: UiState, session: SessionUiState): UiState {
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [session.sessionId]: session,
    },
  }
}

export function selectSession(state: UiState, sessionId: string): UiState {
  const session = state.sessions[sessionId] ?? createSessionUiState(sessionId)
  return {
    ...withSession(state, session),
    phase: state.phase === 'booting' ? 'ready' : state.phase,
    activeSessionId: sessionId,
  }
}

export function setUiPhase(state: UiState, phase: UiState['phase']): UiState {
  return { ...state, phase }
}

export function reduceUiEvent(state: UiState, event: DshTuiEvent): UiState {
  const session = state.sessions[event.sessionId] ?? createSessionUiState(event.sessionId)
  if (event.plane === 'durable') {
    return withSession(state, applyDurableToSession(session, event))
  }

  const previousOrdinal = state.runtimeCursor[event.sourceId] ?? -1
  if (event.ordinal <= previousOrdinal) return state
  const nextState = withSession(state, applyRuntimeToSession(session, event))
  return {
    ...nextState,
    runtimeCursor: {
      ...state.runtimeCursor,
      [event.sourceId]: event.ordinal,
    },
  }
}

/**
 * Apply one non-durable presentation annotation after its durable event has
 * folded. Re-delivering the same seq with a different view updates only the
 * ToolRow and can never create a durable duplicate conflict.
 */
export function applyToolPresentation(
  state: UiState,
  event: DshTuiEvent,
  annotation: DshToolPresentationAnnotation | undefined,
): UiState {
  if (annotation === undefined || event.plane !== 'durable') return state
  if (event.type !== 'tool/call' && event.type !== 'tool/result') return state
  if (
    (event.type === 'tool/call' && annotation.for !== 'call')
    || (event.type === 'tool/result' && annotation.for !== 'result')
  ) return state

  const session = state.sessions[event.sessionId]
  if (session === undefined) return state
  const key = `tool:${toolKey(event.data.turn, event.data.step, event.data.callId)}`
  const index = session.rows.findIndex(row => row.key === key)
  const current = session.rows[index]
  if (index < 0 || current?.kind !== 'tool') return state

  let row: ToolRow
  if (annotation.for === 'call') {
    if (annotation.view === null) {
      const { callPresentation: _removed, ...fallback } = current
      row = fallback
    } else {
      row = { ...current, callPresentation: annotation.view }
    }
  } else if (annotation.view === null) {
    const { resultPresentation: _removed, ...fallback } = current
    row = fallback
  } else {
    row = { ...current, resultPresentation: annotation.view }
  }

  return withSession(state, withRows(
    session,
    replaceRow(session.rows, index, row),
  ))
}

export function replayUiEvents(
  sessionId: string,
  events: readonly DurableDshEnvelope[],
): UiState {
  let state = selectSession({
    phase: 'booting',
    sessions: {},
    runtimeCursor: {},
  }, sessionId)
  for (const event of events) state = reduceUiEvent(state, event)
  return state
}
