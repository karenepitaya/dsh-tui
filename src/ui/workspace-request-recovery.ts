import type { AttemptPanelView, LlmAttemptChain, LlmAttemptRecord, LlmAttemptPhase } from '../llm/attempts.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'
import type { DshTuiSemanticRole } from './theme.ts'
import type { LegacyDirectoryNavigation } from '../navigation/legacy-directory.ts'
import { legacyDetailViewport } from './legacy-detail-rows.ts'
import {
  secondaryModalHeader,
  secondaryModalFill,
  secondaryModalPair,
  secondaryModalRow,
  secondaryModalSection,
  secondaryModalSplit,
  type SecondaryModalRow,
} from './modal.ts'
import { focusedWindowStart, inlineText, secondaryModalFrame } from './workspace-rows.ts'

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

function attemptChainRow(chain: LlmAttemptChain, selected: boolean): string {
  const marker = attemptPhaseSymbol(chain.phase)
  return `${selected ? '›' : ' '} ${marker}  T${chain.turn}/S${chain.step}`
    + `  ${inlineText(chain.provider)}  ×${chain.attempts.length}`
}

function attemptDetailRows(
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

export function attemptDetailViewport(
  view: AttemptPanelView,
  viewport: TerminalViewport,
  offset: number,
): ReturnType<typeof legacyDetailViewport<ReturnType<typeof attemptDetailRows>[number]>> {
  const leftColumns = Math.max(24, Math.min(43, Math.floor((viewport.columns - 3) * 0.4)))
  return legacyDetailViewport(attemptDetailRows(view.selected, view.selectedAttempt, view.selectedAttemptIndex),
    viewport.columns < 100 ? viewport.columns - 4 : viewport.columns - leftColumns - 3,
    viewport.rows - 4, offset)
}

export function renderAttemptFrame(
  view: AttemptPanelView,
  viewport: TerminalViewport,
  navigation?: LegacyDirectoryNavigation,
): UiFrame {
  const { columns, rows } = viewport
  const split = columns >= 100
  const detailFocused = navigation?.focus === 'details'
  const active = view.rows.filter(chain => chain.phase === 'backoff' || chain.phase === 'requesting').length
  const failures = view.rows.reduce((sum, chain) => sum + chain.attempts.length, 0)
  const header = secondaryModalRow(
    secondaryModalHeader('Request recovery', columns),
    'accent',
    { bold: true },
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  const footer = secondaryModalRow(
    secondaryModalPair(`  ↑↓ ${detailFocused ? 'scroll details' : 'provider chain'} · ←→ failed request · h/l/Tab focus`, 'Esc close', columns),
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
    secondaryModalSection(split || !detailFocused ? 'Provider chains' : 'Failure inspector', columns,
      split ? 'Failure inspector' : ''),
    'interaction',
    { bold: true },
  )
  const bodySlots = rows - 4
  const start = focusedWindowStart(view.rows.length, view.selectedIndex, bodySlots)
  const visible = view.rows.slice(start, start + bodySlots)
  const details = attemptDetailViewport(view, viewport, navigation?.detailOffset ?? 0).rows
  const leftColumns = Math.max(24, Math.min(43, Math.floor((columns - 3) * 0.4)))
  const body = Array.from({ length: bodySlots }, (_, index): SecondaryModalRow => {
    const chain = visible[index]
    const absoluteIndex = start + index
    const selected = chain !== undefined && absoluteIndex === view.selectedIndex
    const detail = details[index]
    if (!split) {
      const text = detailFocused
        ? detail?.text ?? (index === 0 ? 'No provider recovery has been scheduled.' : '')
        : chain === undefined ? (index === 0 ? '  ∅  No retry history' : '') : attemptChainRow(chain, selected)
      return secondaryModalRow(secondaryModalFill(`  ${text}`, columns),
        detailFocused ? detail?.tone ?? 'muted' : selected ? 'accent' : 'primary',
        { bold: detailFocused ? detail?.bold === true : selected, selected: !detailFocused && selected })
    }
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
  return secondaryModalFrame(viewport, [header, summary, section, ...body, footer], undefined, split ? leftColumns : undefined)
}
