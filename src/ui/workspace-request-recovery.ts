import type { AttemptPanelView, LlmAttemptChain, LlmAttemptRecord, LlmAttemptPhase } from '../llm/attempts.ts'
import type { DshTuiSemanticRole } from './theme.ts'
import { inlineText } from './workspace-rows.ts'

export function formatRetryDelay(delayMs: number): string {
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
    case 'reconfigured': return 'POLICY CHANGED'
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
    case 'reconfigured': return 'interaction'
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
    case 'reconfigured': return '↻'
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

/** Summary of the bounded recovery projection for the merged Status page. */
export function attemptSummary(
  view: Pick<AttemptPanelView, 'rows' | 'omittedChainCount'>,
): { readonly text: string; readonly active: boolean } {
  const active = view.rows.filter(chain => chain.phase === 'backoff' || chain.phase === 'requesting').length
  const failures = view.rows.reduce((sum, chain) => sum + chain.attempts.length, 0)
  return {
    text: `${view.rows.length + view.omittedChainCount} chains · ${failures} failed requests · ${active} active`,
    active: active > 0,
  }
}

export function attemptDetailRows(
  chain: LlmAttemptChain | undefined,
  selectedAttempt: LlmAttemptRecord | undefined,
  selectedAttemptIndex: number,
): readonly {
  readonly text: string
  readonly tone: DshTuiSemanticRole
  readonly bold?: boolean
}[] {
  if (chain === undefined) return []
  const finiteBudget = chain.mode === 'normal'
    ? `${(chain.maxRetries ?? 0) + 1} total attempts`
    : 'unbounded retries'
  const wait = selectedAttempt === undefined ? '—' : formatRetryDelay(selectedAttempt.delayMs)
  const status = selectedAttempt?.failure.status === undefined
    ? ''
    : ` · HTTP ${selectedAttempt.failure.status}`
  const omitted = chain.omittedAttemptCount === undefined
    ? ''
    : ` · +${chain.omittedAttemptCount} older`
  const requestPosition = selectedAttempt === undefined
    ? `—${omitted}`
    : `${selectedAttemptIndex + 1} / ${chain.attempts.length}`
      + ` · retry ${attemptOrdinal(selectedAttempt.retry)}${omitted}`
  return [
    { text: `Recovery path  ${attemptPath(chain)}`, tone: 'telemetry', bold: true },
    {
      text: `State  ${attemptPhaseLabel(chain.phase)}`
        + (chain.phase === 'backoff' ? ` · WAIT ${wait}` : ''),
      tone: attemptPhaseTone(chain.phase),
      bold: true,
    },
    { text: `Provider  ${inlineText(chain.provider)}`, tone: 'assistant', bold: true },
    {
      text: `Failed request  ${requestPosition}`,
      tone: selectedAttempt === undefined ? 'muted' : 'telemetry',
      bold: selectedAttempt !== undefined,
    },
    {
      text: `Failure  ${selectedAttempt === undefined
        ? '—'
        : inlineText(selectedAttempt.failure.code)}${status}`,
      tone: selectedAttempt === undefined ? 'muted' : 'error',
      bold: selectedAttempt !== undefined,
    },
    ...(selectedAttempt?.failure.requestId === undefined ? [] : [{
      text: `Request id  ${inlineText(selectedAttempt.failure.requestId)}`,
      tone: 'muted' as const,
    }]),
    {
      text: `Retry wait  ${wait}`
        + (selectedAttempt === undefined
          ? ''
          : selectedAttempt.startedSeq === undefined ? ' · scheduled' : ' · completed'),
      tone: selectedAttempt === undefined
        ? 'muted'
        : selectedAttempt.startedSeq === undefined ? 'warning' : 'telemetry',
    },
    ...(selectedAttempt?.failure.providerRetryAfterMs === undefined ? [] : [{
      text: `Provider delay  ${formatRetryDelay(selectedAttempt.failure.providerRetryAfterMs)}`,
      tone: 'warning' as const,
    }]),
    {
      text: `Message  ${selectedAttempt === undefined
        ? '—'
        : inlineText(selectedAttempt.failure.message)}`,
      tone: 'primary',
    },
    { text: `Policy  ${inlineText(chain.mode)} · ${finiteBudget}`, tone: 'interaction' },
    { text: `Turn / step  ${chain.turn} / ${chain.step}`, tone: 'muted' },
    { text: `Retry chain  ${inlineText(chain.retryId)}`, tone: 'muted' },
  ]
}