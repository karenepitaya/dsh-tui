import type {
  DurableDshEnvelope,
  UiLlmFailure,
  UiLlmRetryScheduled,
} from '../runtime/events.ts'

const ATTEMPT_CHAIN_LIMIT = 16
const ATTEMPT_RECORD_LIMIT = 64

export type LlmAttemptPhase =
  | 'backoff'
  | 'requesting'
  | 'recovered'
  | 'failed'
  | 'cancelled'
  | 'rerouted'
  | 'reconfigured'

/** One failed provider request and the retry wait it scheduled. */
export interface LlmAttemptRecord {
  readonly retry: number
  readonly scheduledSeq: number
  readonly scheduledAt: number
  readonly delayMs: number
  readonly failure: UiLlmFailure
  readonly startedSeq?: number
  readonly startedAt?: number
}

/** One provider-and-policy retry chain inside an open Agent step. */
export interface LlmAttemptChain {
  readonly retryId: string
  readonly turn: number
  readonly step: number
  readonly phase: LlmAttemptPhase
  readonly provider: string
  readonly mode: UiLlmRetryScheduled['mode']
  readonly policyKey: string
  readonly maxRetries?: number
  readonly attempts: readonly LlmAttemptRecord[]
  readonly omittedAttemptCount?: number
  readonly finalSeq?: number
}

/** Bounded display projection; the official Session log remains authoritative. */
export interface SessionLlmAttemptState {
  readonly chains: readonly LlmAttemptChain[]
  readonly activeRetryId?: string
  readonly omittedChainCount?: number
}

export interface AttemptPanelView {
  readonly rows: readonly LlmAttemptChain[]
  readonly selectedIndex: number
  readonly selected?: LlmAttemptChain
  readonly selectedAttemptIndex: number
  readonly selectedAttempt?: LlmAttemptRecord
  readonly omittedChainCount: number
}

function terminal(phase: LlmAttemptPhase): boolean {
  return phase === 'recovered'
    || phase === 'failed'
    || phase === 'cancelled'
    || phase === 'rerouted'
    || phase === 'reconfigured'
}

function replaceChain(
  chains: readonly LlmAttemptChain[],
  index: number,
  chain: LlmAttemptChain,
): readonly LlmAttemptChain[] {
  return chains.with(index, chain)
}

function boundedAttempts(
  chain: LlmAttemptChain | undefined,
  attempt: LlmAttemptRecord,
): Pick<LlmAttemptChain, 'attempts' | 'omittedAttemptCount'> {
  const attempts = [...(chain?.attempts ?? []), attempt]
  const overflow = Math.max(0, attempts.length - ATTEMPT_RECORD_LIMIT)
  return {
    attempts: overflow === 0 ? attempts : attempts.slice(overflow),
    ...(overflow === 0
      ? chain?.omittedAttemptCount === undefined ? {} : { omittedAttemptCount: chain.omittedAttemptCount }
      : { omittedAttemptCount: (chain?.omittedAttemptCount ?? 0) + overflow }),
  }
}

function withoutActive(state: SessionLlmAttemptState): SessionLlmAttemptState {
  const { activeRetryId: _removed, ...rest } = state
  return rest
}

export function activeLlmAttemptChain(
  state: SessionLlmAttemptState | undefined,
): LlmAttemptChain | undefined {
  if (state?.activeRetryId === undefined) return undefined
  return state.chains.find(chain => chain.retryId === state.activeRetryId)
}

/** Fold one official scheduled-wait record and fence a route/policy change. */
export function projectLlmRetry(
  state: SessionLlmAttemptState | undefined,
  event: Extract<DurableDshEnvelope, { type: 'llm/retry' }>,
): SessionLlmAttemptState {
  const current: SessionLlmAttemptState = state ?? { chains: [] }
  let chains = current.chains
  const existingIndex = chains.findIndex(chain => chain.retryId === event.data.retryId)
  if (existingIndex < 0 && current.activeRetryId !== undefined) {
    const priorIndex = chains.findIndex(chain => chain.retryId === current.activeRetryId)
    const prior = chains[priorIndex]
    if (prior !== undefined
      && !terminal(prior.phase)
      && prior.turn === event.data.turn
      && prior.step === event.data.step) {
      chains = replaceChain(chains, priorIndex, {
        ...prior,
        phase: prior.provider === event.data.provider ? 'reconfigured' : 'rerouted',
        finalSeq: event.seq,
      })
    }
  }

  const index = chains.findIndex(chain => chain.retryId === event.data.retryId)
  const previous = index < 0 ? undefined : chains[index]
  const record: LlmAttemptRecord = {
    retry: event.data.retry,
    scheduledSeq: event.seq,
    scheduledAt: event.time,
    delayMs: event.data.delayMs,
    failure: event.data.failure,
  }
  const bounded = boundedAttempts(previous, record)
  const chain: LlmAttemptChain = {
    retryId: event.data.retryId,
    turn: event.data.turn,
    step: event.data.step,
    phase: 'backoff',
    provider: event.data.provider,
    mode: event.data.mode,
    policyKey: event.data.policyKey,
    ...('maxRetries' in event.data ? { maxRetries: event.data.maxRetries } : {}),
    ...bounded,
  }
  const nextChains = index < 0 ? [...chains, chain] : replaceChain(chains, index, chain)
  const overflow = Math.max(0, nextChains.length - ATTEMPT_CHAIN_LIMIT)
  return {
    chains: overflow === 0 ? nextChains : nextChains.slice(overflow),
    activeRetryId: chain.retryId,
    ...(overflow === 0
      ? current.omittedChainCount === undefined ? {} : { omittedChainCount: current.omittedChainCount }
      : { omittedChainCount: (current.omittedChainCount ?? 0) + overflow }),
  }
}

/** Pair the official post-wait transition with its scheduled attempt. */
export function projectLlmRetryStarted(
  state: SessionLlmAttemptState | undefined,
  event: Extract<DurableDshEnvelope, { type: 'llm/retry-started' }>,
): SessionLlmAttemptState | undefined {
  if (state === undefined) return state
  const chainIndex = state.chains.findIndex(chain => chain.retryId === event.data.retryId)
  const chain = state.chains[chainIndex]
  if (chain === undefined) return state
  const attemptIndex = chain.attempts.findIndex(attempt => attempt.retry === event.data.retry)
  const attempt = chain.attempts[attemptIndex]
  if (attempt === undefined) return state
  const attempts = chain.attempts.with(attemptIndex, {
    ...attempt,
    startedSeq: event.seq,
    startedAt: event.time,
  })
  return {
    ...state,
    chains: replaceChain(state.chains, chainIndex, {
      ...chain,
      phase: 'requesting',
      attempts,
    }),
    activeRetryId: chain.retryId,
  }
}

/** A durable assistant message proves that the open retry path recovered. */
export function settleLlmAttemptMessage(
  state: SessionLlmAttemptState | undefined,
  event: Extract<DurableDshEnvelope, { type: 'assistant/message' }>,
): SessionLlmAttemptState | undefined {
  const chain = activeLlmAttemptChain(state)
  if (state === undefined || chain === undefined || terminal(chain.phase)
    || event.data.interrupted === true
    || chain.turn !== event.data.turn || chain.step !== event.data.step) return state
  const index = state.chains.findIndex(item => item.retryId === chain.retryId)
  return withoutActive({
    ...state,
    chains: replaceChain(state.chains, index, {
      ...chain,
      phase: 'recovered',
      finalSeq: event.seq,
    }),
  })
}

function reasonKind(reason: unknown): string {
  return typeof reason === 'object' && reason !== null
    && typeof (reason as Readonly<Record<string, unknown>>).kind === 'string'
    ? String((reason as Readonly<Record<string, unknown>>).kind)
    : 'unknown'
}

/** Terminal turn evidence settles any still-open path without fabricating attempts. */
export function settleLlmAttemptTurn(
  state: SessionLlmAttemptState | undefined,
  event: Extract<DurableDshEnvelope, { type: 'turn/end' }>,
): SessionLlmAttemptState | undefined {
  if (state === undefined) return state
  const kind = reasonKind(event.data.reason)
  let changed = false
  const chains = state.chains.map((chain): LlmAttemptChain => {
    if (chain.turn !== event.data.turn || terminal(chain.phase)) return chain
    changed = true
    return {
      ...chain,
      phase: kind === 'aborted'
        ? 'cancelled'
        : kind === 'completed' ? 'recovered' : 'failed',
      finalSeq: event.seq,
    }
  })
  if (!changed) return state
  const active = state.activeRetryId === undefined
    ? undefined
    : chains.find(chain => chain.retryId === state.activeRetryId)
  const { activeRetryId: _removed, ...rest } = state
  return {
    ...rest,
    chains,
    ...(active !== undefined && !terminal(active.phase)
      ? { activeRetryId: active.retryId }
      : {}),
  }
}

/** Read-only projection with the default latest selection; the Status page owns no selection state. */
export function selectAttemptPanel(
  attempts: SessionLlmAttemptState | undefined,
): AttemptPanelView {
  const rows = [...(attempts?.chains ?? [])].reverse()
  const selected = activeLlmAttemptChain(attempts) ?? rows[0]
  const selectedAttemptIndex = selected === undefined || selected.attempts.length === 0
    ? -1
    : selected.attempts.length - 1
  const selectedAttempt = selected?.attempts[selectedAttemptIndex]
  return {
    rows,
    selectedIndex: selected === undefined
      ? -1
      : rows.findIndex(row => row.retryId === selected.retryId),
    ...(selected === undefined ? {} : { selected }),
    selectedAttemptIndex,
    ...(selectedAttempt === undefined ? {} : { selectedAttempt }),
    omittedChainCount: attempts?.omittedChainCount ?? 0,
  }
}
