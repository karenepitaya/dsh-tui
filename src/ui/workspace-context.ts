import type { SessionContextSnapshot } from '../context/port.ts'
import type { SessionCompactionState } from '../transcript/state.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'
import type { DshTuiSemanticRole } from './theme.ts'
import {
  secondaryModalChrome,
  secondaryModalFill,
  secondaryModalKeybar,
  secondaryModalPair,
  secondaryModalRow,
  secondaryModalSection,
  type SecondaryModalRow,
} from './modal.ts'
import { billedInputTokens, cacheHitPercent, contextOccupancy, formatTokenCount } from './context-metrics.ts'
import { fillModalRows, inlineText, secondaryModalFrame } from './workspace-rows.ts'
import { legacyDetailViewport } from './legacy-detail-rows.ts'

function dimension(value: number): number {
  return Math.max(1, Math.floor(value))
}

function contextCapacityBar(percent: number, width: number): string {
  const slots = Math.max(1, Math.floor(width))
  const filled = Math.max(0, Math.min(slots, Math.round(percent * slots / 100)))
  return '█'.repeat(filled) + '░'.repeat(slots - filled)
}

/** Render the complete official token-meter projection; do not reconstruct it locally. */
export function contextDetailViewport(
  context: SessionContextSnapshot,
  sessionId: string,
  viewport: TerminalViewport,
  compaction?: SessionCompactionState,
  offset = 0,
): ReturnType<typeof legacyDetailViewport<SecondaryModalRow>> {
  const columns = dimension(viewport.columns)
  const rows = dimension(viewport.rows)
  const occupancy = contextOccupancy(context)
  const pressure = context.pressure
  const breakdown = context.breakdown
  const usage = context.usage
  if (!context.available) {
    return legacyDetailViewport([
      secondaryModalRow(`  Session  ${inlineText(sessionId)}`, 'telemetry', { bold: true }),
      secondaryModalRow('  Token meter offline', 'warning', { bold: true }),
      secondaryModalRow('  Official projections are not composed.', 'primary'),
      secondaryModalRow('  Local estimates remain disabled.', 'muted'),
    ], columns, rows - 2, offset)
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
    `  Session  ${inlineText(sessionId)}  ·  ${promptSource}`,
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
    `  Compact ${compactionText} · ${sourceText}`,
    compaction?.phase === 'running' ? 'warning' : 'muted',
  )
  const fullBody: SecondaryModalRow[] = [
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
  return legacyDetailViewport(fullBody, columns, rows - 2, offset)
}

export function renderContextFrame(
  context: SessionContextSnapshot,
  sessionId: string,
  viewport: TerminalViewport,
  compaction?: SessionCompactionState,
  offset = 0,
): UiFrame {
  const normalized = { columns: dimension(viewport.columns), rows: dimension(viewport.rows) }
  const header = secondaryModalChrome('Context', 'Pressure', normalized.columns)
  if (normalized.rows === 1) return secondaryModalFrame(normalized, [header])
  const footer = secondaryModalRow(
    secondaryModalKeybar('↑↓/j/k scroll · /compact maintain context', normalized.columns), 'muted')
  const body = contextDetailViewport(context, sessionId, normalized, compaction, offset).rows
    .map(row => ({ ...row, text: secondaryModalFill(row.text, normalized.columns) }))
  return secondaryModalFrame(normalized, fillModalRows([header, ...body], normalized, footer))
}
