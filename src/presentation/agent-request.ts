import type { DshTuiEvent } from '../runtime/events.ts'
import { projectUiMessageContent } from './message-content.ts'
import { toolResultStatus } from './tool-outcome.ts'
import type { ToolPresentationView } from './types.ts'

type AgentRequestToolAnnotation =
  | {
      readonly for: 'call'
      readonly view: Extract<ToolPresentationView, { readonly phase: 'call' }> | null
    }
  | {
      readonly for: 'result'
      readonly view: Extract<ToolPresentationView, { readonly phase: 'result' }> | null
    }

export type AgentRequestPhase =
  | 'submitted'
  | 'waiting'
  | 'reasoning'
  | 'tool'
  | 'responding'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface AgentRequestStatusView {
  readonly phase: AgentRequestPhase
  readonly description: string
  /** Durable turn correlated to this request; absent before official turn/start. */
  readonly turn?: number
}

export interface PendingAgentInput {
  readonly ticket: number
  readonly inputId?: string
}

/**
 * Session-local presentation bridge between prompt submission and official
 * events. It never creates transcript rows; input ids are reconciled against
 * durable user/message events.
 */
export interface AgentRequestLifecycleState extends AgentRequestStatusView {
  readonly pendingInputs: readonly PendingAgentInput[]
  /** At least one local or official input has crossed the Agent boundary. */
  readonly accepted: boolean
  readonly cancelRequested: boolean
  /** Current turn's failed executions, excluding structured cancellations. */
  readonly toolFailures?: number
  /** Prevent presentation re-deliveries from counting an outcome twice. */
  readonly lastToolResultSeq?: number
}

const ACTIVE_PHASES: readonly AgentRequestPhase[] = Object.freeze([
  'submitted',
  'waiting',
  'reasoning',
  'tool',
  'responding',
])

function withStatus(
  state: AgentRequestLifecycleState,
  phase: AgentRequestPhase,
  description: string,
): AgentRequestLifecycleState {
  return { ...state, phase, description }
}

function freshStatus(
  phase: AgentRequestPhase,
  description: string,
): AgentRequestLifecycleState {
  return { phase, description, pendingInputs: [], accepted: true, cancelRequested: false }
}

export function isAgentRequestActive(
  state: AgentRequestLifecycleState | undefined,
): state is AgentRequestLifecycleState {
  return state !== undefined && ACTIVE_PHASES.includes(state.phase)
}

export function beginAgentRequest(
  state: AgentRequestLifecycleState | undefined,
  ticket: number,
): AgentRequestLifecycleState {
  const pendingInputs = [...(state?.pendingInputs ?? []), { ticket }]
  return {
    ...(isAgentRequestActive(state) ? state : {}),
    phase: 'submitted',
    description: 'Submitting prompt',
    pendingInputs,
    accepted: isAgentRequestActive(state) ? state.accepted : false,
    cancelRequested: false,
  }
}

export function acceptAgentRequest(
  state: AgentRequestLifecycleState | undefined,
  ticket: number,
  inputId: string,
  alreadyObserved = false,
): AgentRequestLifecycleState | undefined {
  if (state === undefined) return undefined
  if (!state.pendingInputs.some(input => input.ticket === ticket)) return state
  const pendingInputs = alreadyObserved
    ? state.pendingInputs.filter(input => input.ticket !== ticket)
    : state.pendingInputs.map(input => (
        input.ticket === ticket ? { ...input, inputId } : input
      ))
  return {
    ...state,
    phase: 'waiting',
    description: 'Waiting for DSH',
    pendingInputs,
    accepted: true,
  }
}

export function rejectAgentRequest(
  state: AgentRequestLifecycleState | undefined,
  ticket: number,
  agentRunning: boolean,
): AgentRequestLifecycleState {
  const pendingInputs = (state?.pendingInputs ?? []).filter(input => input.ticket !== ticket)
  if (agentRunning || pendingInputs.length > 0) {
    return {
      phase: 'waiting',
      description: 'Continuing current request',
      pendingInputs,
      accepted: state?.accepted === true || agentRunning,
      cancelRequested: false,
    }
  }
  return {
    phase: 'failed',
    description: 'Prompt was not sent',
    pendingInputs,
    accepted: false,
    cancelRequested: false,
  }
}

export function requestAgentCancellation(
  state: AgentRequestLifecycleState,
  accepted = state.accepted,
): AgentRequestLifecycleState {
  return {
    ...state,
    phase: 'waiting',
    description: 'Cancelling request',
    pendingInputs: [],
    accepted,
    cancelRequested: true,
  }
}

export function settleAgentRequestCancellation(
  state: AgentRequestLifecycleState,
  description = 'Request cancelled',
): AgentRequestLifecycleState {
  return {
    ...state,
    phase: 'cancelled',
    description,
    pendingInputs: [],
    accepted: false,
    cancelRequested: false,
  }
}

function briefText(value: string, fallback: string): string {
  const clean = value
    .replace(/\r\n?/gu, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '�')
    .replace(/\s+/gu, ' ')
    .trim()
  if (clean === '') return fallback
  const graphemes = Array.from(clean)
  return graphemes.length <= 96 ? clean : `${graphemes.slice(0, 95).join('')}…`
}

function toolDescription(
  event: Extract<DshTuiEvent, { readonly type: 'tool/call' }>,
  annotation?: AgentRequestToolAnnotation,
): string {
  const title = annotation?.for === 'call' && annotation.view !== null
    ? annotation.view.title
    : event.data.name
  return briefText(title, 'Running tool')
}

function turnEndStatus(reasonValue: unknown): AgentRequestStatusView {
  const reason = typeof reasonValue === 'object' && reasonValue !== null
    ? reasonValue as Readonly<Record<string, unknown>>
    : undefined
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
  switch (kind) {
    case 'completed':
      return { phase: 'succeeded', description: 'Request complete' }
    case 'interrupted':
    case 'aborted':
      return { phase: 'cancelled', description: 'Request cancelled' }
    case 'error':
      return { phase: 'failed', description: 'Request failed' }
    case 'blocked':
      return { phase: 'failed', description: 'Request blocked' }
    case 'max-tokens':
      return { phase: 'failed', description: 'Response reached the token limit' }
    default:
      return { phase: 'failed', description: `Request ended: ${briefText(kind, 'unknown')}` }
  }
}

/** Reconcile a submit result that arrived after its durable turn already ended. */
export function settleAgentRequestFromTurnEnd(
  state: AgentRequestLifecycleState,
  reason: unknown,
): AgentRequestLifecycleState {
  const settled = turnEndStatus(reason)
  return {
    ...state,
    ...settled,
    ...(settled.phase === 'succeeded' && (state.toolFailures ?? 0) > 0
      ? {
          description: `Request complete · ${state.toolFailures} tool failure`
            + (state.toolFailures === 1 ? '' : 's'),
        }
      : {}),
    pendingInputs: [],
    accepted: false,
    cancelRequested: false,
  }
}

/** Fold one official event into the current session-local activity view. */
export function reduceAgentRequestEvent(
  state: AgentRequestLifecycleState | undefined,
  event: DshTuiEvent,
  annotation?: AgentRequestToolAnnotation,
): AgentRequestLifecycleState | undefined {
  if (event.plane === 'runtime') {
    if (event.type === 'agent/disposed') {
      return state === undefined
        ? undefined
        : state.cancelRequested
          ? settleAgentRequestCancellation(state, 'Agent stopped')
          : {
              ...withStatus(state, 'failed', 'Agent stopped'),
              pendingInputs: [],
              accepted: false,
            }
    }
    if (event.type === 'agent/created' && event.data.status === 'idle') return state
    if (event.data.status === 'running') {
      const current = state ?? freshStatus('waiting', 'Starting request')
      return {
        ...(ACTIVE_PHASES.includes(current.phase)
          ? current
          : withStatus(current, 'waiting', 'Starting request')),
        accepted: true,
      }
    }
    if (state === undefined || !isAgentRequestActive(state)) return state
    if (state.cancelRequested) return settleAgentRequestCancellation(state)
    return {
      ...withStatus(state, 'failed', 'Request stopped'),
      pendingInputs: [],
      accepted: false,
    }
  }

  if (event.type === 'turn/start' && !isAgentRequestActive(state)) {
    state = freshStatus('waiting', 'Starting request')
  }
  if (state === undefined || !isAgentRequestActive(state)) return state
  switch (event.type) {
    case 'turn/start':
      return {
        ...withStatus(state, 'waiting', 'Starting request'),
        accepted: true,
        turn: event.data.turn,
        toolFailures: state.turn === event.data.turn ? state.toolFailures ?? 0 : 0,
      }
    case 'step/start':
    case 'step/end':
      return {
        ...withStatus(state, 'waiting', 'Preparing next step'),
        turn: event.data.turn,
      }
    case 'user/message': {
      if (event.data.surfaceOp !== 'append' || event.data.message.sourceKind !== 'user') {
        return state
      }
      const pendingInputs = state.pendingInputs.filter(input => (
        input.inputId === undefined || input.inputId !== event.data.message.id
      ))
      return {
        ...state,
        phase: 'waiting',
        description: 'Understanding request',
        pendingInputs,
        accepted: true,
      }
    }
    case 'assistant/chunk':
      if (event.data.chunk.type === 'text-delta') {
        return {
          ...withStatus(state, 'responding', 'Writing response'),
          turn: event.data.turn,
        }
      }
      if (event.data.chunk.type === 'reasoning-delta' && state.phase !== 'responding') {
        return {
          ...withStatus(state, 'reasoning', 'Working through the request'),
          turn: event.data.turn,
        }
      }
      return state
    case 'assistant/message': {
      const content = projectUiMessageContent(event.data.message.content, {
        includeReasoning: false,
      })
      if (content.text !== '') {
        return {
          ...withStatus(state, 'responding', 'Writing response'),
          turn: event.data.turn,
        }
      }
      if (content.toolCalls.length > 0) {
        return {
          ...withStatus(state, 'waiting', 'Preparing tool call'),
          turn: event.data.turn,
        }
      }
      return state
    }
    case 'tool/call':
      return {
        ...withStatus(state, 'tool', toolDescription(event, annotation)),
        turn: event.data.turn,
      }
    case 'tool/result': {
      if (event.data.surfaceOp !== 'append' || event.seq <= (state.lastToolResultSeq ?? -1)) {
        return state
      }
      const status = toolResultStatus(event.data)
      return {
        ...withStatus(
          state,
          'waiting',
          status === 'failed'
            ? 'Tool failed'
            : status === 'cancelled' ? 'Tool cancelled' : 'Reviewing tool result',
        ),
        turn: event.data.turn,
        toolFailures: (state.toolFailures ?? 0) + (status === 'failed' ? 1 : 0),
        lastToolResultSeq: event.seq,
      }
    }
    case 'llm/retry':
      return {
        ...withStatus(
          state,
          'waiting',
          `Retrying request · attempt ${event.data.retry + 1}`,
        ),
        turn: event.data.turn,
      }
    case 'llm/retry-started':
      return {
        ...withStatus(state, 'waiting', 'Requesting again'),
        turn: event.data.turn,
      }
    case 'turn/end': {
      const turnState = { ...state, turn: event.data.turn }
      if (state.cancelRequested) return settleAgentRequestCancellation(turnState)
      if (state.pendingInputs.length > 0) {
        const { turn: _completedTurn, ...queued } = turnState
        return withStatus(queued, 'waiting', 'Waiting for queued prompt')
      }
      return settleAgentRequestFromTurnEnd(turnState, event.data.reason)
    }
    default:
      return state
  }
}
