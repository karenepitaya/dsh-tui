import type { SessionContextSnapshot } from '../context/port.ts'
import type { SessionCompactionState } from '../transcript/state.ts'
import { selectAttemptPanel, type SessionLlmAttemptState } from '../llm/attempts.ts'
import { selectRoutePanel, type SessionRequestRouteState } from '../llm/routes.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'
import { contextDetailRows } from './workspace-context.ts'
import { attemptDetailRows, attemptSummary } from './workspace-request-recovery.ts'
import { routeDetailRows, routeRail } from './workspace-model-route.ts'
import {
  secondaryModalChrome,
  secondaryModalFill,
  secondaryModalKeybar,
  secondaryModalPair,
  secondaryModalRow,
  secondaryModalSection,
  type SecondaryModalRow,
} from './modal.ts'
import { fillModalRows, secondaryModalFrame } from './workspace-rows.ts'
import { legacyDetailViewport } from './legacy-detail-rows.ts'

function dimension(value: number): number {
  return Math.max(1, Math.floor(value))
}

/** Everything the merged read-only Status page projects; official sources stay authoritative. */
export interface StatusPanelProjection {
  readonly sessionId: string
  readonly context: SessionContextSnapshot
  readonly compaction?: SessionCompactionState
  readonly attempts?: SessionLlmAttemptState
  readonly routes?: SessionRequestRouteState
}

function emptyRow(text: string): SecondaryModalRow {
  return secondaryModalRow(`  ${text}`, 'muted', { dim: true })
}

export function statusDetailRows(
  projection: StatusPanelProjection,
  columns: number,
): readonly SecondaryModalRow[] {
  const attempts = selectAttemptPanel(projection.attempts)
  const attemptRows = attemptDetailRows(
    attempts.selected,
    attempts.selectedAttempt,
    attempts.selectedAttemptIndex,
  )
  const recoverySummary = attemptSummary(attempts)
  const routes = selectRoutePanel(projection.routes)
  const currentRoute = routes.rows[0]
  const routeRows = routeDetailRows(routes.selected, currentRoute?.headerSeq)
  return [
    secondaryModalRow(secondaryModalSection('Context', columns, ''), 'interaction', { bold: true }),
    ...contextDetailRows(projection.context, projection.sessionId, columns, projection.compaction),
    secondaryModalRow(secondaryModalSection('Request recovery', columns, ''), 'interaction', { bold: true }),
    ...(attempts.rows.length === 0
      ? [emptyRow('No provider recovery has been scheduled.')]
      : [
          secondaryModalRow(
            secondaryModalPair(`  ${recoverySummary.text}`, `${recoverySummary.active ? 'active' : 'settled'}`, columns),
            recoverySummary.active ? 'warning' : 'telemetry',
            { bold: true },
          ),
          ...attemptRows.map(row => secondaryModalRow(`  ${row.text}`, row.tone, { bold: row.bold === true })),
        ]),
    secondaryModalRow(secondaryModalSection('Model route', columns, ''), 'interaction', { bold: true }),
    ...(routes.rows.length === 0
      ? [emptyRow('Send a prompt to materialize the official route.')]
      : [
          secondaryModalRow(
            secondaryModalPair(
              `  ${routeRail(routes)}`,
              `${routes.rows.length + routes.omittedEpochCount} epochs`
                + (currentRoute === undefined
                  ? ''
                  : ` · ${currentRoute.config.provider}/${currentRoute.config.model}`),
              columns,
            ),
            'telemetry',
            { bold: true },
          ),
          ...routeRows.map(row => secondaryModalRow(`  ${row.text}`, row.tone, { bold: row.bold === true })),
        ]),
  ]
}

export function statusDetailViewport(
  projection: StatusPanelProjection,
  viewport: TerminalViewport,
  offset: number,
): ReturnType<typeof legacyDetailViewport<SecondaryModalRow>> {
  const columns = dimension(viewport.columns)
  return legacyDetailViewport(statusDetailRows(projection, columns), columns, dimension(viewport.rows) - 2, offset)
}

export function renderStatusFrame(
  projection: StatusPanelProjection,
  viewport: TerminalViewport,
  offset = 0,
): UiFrame {
  const normalized = { columns: dimension(viewport.columns), rows: dimension(viewport.rows) }
  const header = secondaryModalChrome('Status', 'Diagnostics', normalized.columns)
  if (normalized.rows === 1) return secondaryModalFrame(normalized, [header])
  const footer = secondaryModalRow(
    secondaryModalKeybar('↑↓/j/k scroll · /compact maintain context', normalized.columns), 'muted')
  const body = statusDetailViewport(projection, normalized, offset).rows
    .map(row => ({ ...row, text: secondaryModalFill(row.text, normalized.columns) }))
  return secondaryModalFrame(normalized, fillModalRows([header, ...body], normalized, footer))
}
