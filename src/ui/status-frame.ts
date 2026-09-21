import { FormWorkspace, type FormWorkspaceModel } from 'pi-tui-orbs'
import type { SessionContextSnapshot } from '../context/port.ts'
import type { SessionCompactionState } from '../transcript/state.ts'
import { selectAttemptPanel, type SessionLlmAttemptState } from '../llm/attempts.ts'
import { selectRoutePanel, type SessionRequestRouteState } from '../llm/routes.ts'
import { formWorkspaceStrings } from './form-workspace-strings.ts'
import { legacyDetailViewport } from './legacy-detail-rows.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'
import { contextDetailRows } from './workspace-context.ts'
import { attemptDetailRows, attemptSummary } from './workspace-request-recovery.ts'
import { routeDetailRows, routeRail } from './workspace-model-route.ts'
import { secondaryModalPair, secondaryModalSection } from './modal.ts'

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

export interface StatusFrameOptions {
  readonly uiLanguage?: string
  readonly deferLayout?: boolean
  /** Scroll offset in wrapped body lines; the controller owns the value. */
  readonly scrollOffset?: number
}

/** Rows re-create the three-section read-only body the secondary panel owned. */
export function statusDetailRows(
  projection: StatusPanelProjection,
  columns: number,
): readonly { readonly text: string; readonly tone: string; readonly bold?: boolean }[] {
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
  const emptyRow = (text: string) => ({ text: `  ${text}`, tone: 'muted' })
  return [
    { text: secondaryModalSection('Context', columns, ''), tone: 'interaction', bold: true },
    ...contextDetailRows(projection.context, projection.sessionId, columns, projection.compaction)
      .map(row => ({ text: row.text, tone: row.style.tone, ...(row.style.bold === undefined ? {} : { bold: row.style.bold }) })),
    { text: secondaryModalSection('Request recovery', columns, ''), tone: 'interaction', bold: true },
    ...(attempts.rows.length === 0
      ? [emptyRow('No provider recovery has been scheduled.')]
      : [
          {
            text: secondaryModalPair(`  ${recoverySummary.text}`, `${recoverySummary.active ? 'active' : 'settled'}`, columns),
            tone: recoverySummary.active ? 'warning' : 'telemetry',
            bold: true,
          },
          ...attemptRows.map(row => ({ text: `  ${row.text}`, tone: row.tone, ...(row.bold === undefined ? {} : { bold: row.bold }) })),
        ]),
    { text: secondaryModalSection('Model route', columns, ''), tone: 'interaction', bold: true },
    ...(routes.rows.length === 0
      ? [emptyRow('Send a prompt to materialize the official route.')]
      : [
          {
            text: secondaryModalPair(
              `  ${routeRail(routes)}`,
              `${routes.rows.length + routes.omittedEpochCount} epochs`
                + (currentRoute === undefined
                  ? ''
                  : ` · ${currentRoute.config.provider}/${currentRoute.config.model}`),
              columns,
            ),
            tone: 'telemetry',
            bold: true,
          },
          ...routeRows.map(row => ({ text: `  ${row.text}`, tone: row.tone, ...(row.bold === undefined ? {} : { bold: row.bold }) })),
        ]),
  ]
}

/** The same wrapped-line window the input handler uses for scroll bounds. */
export function statusFormModel(
  projection: StatusPanelProjection,
  viewport: TerminalViewport,
  options: StatusFrameOptions = {},
): FormWorkspaceModel {
  const strings = formWorkspaceStrings(options.uiLanguage)
  const columns = dimension(viewport.columns)
  // The controller's scroll offset is a wrapped-line window (the same
  // legacyDetailViewport bounds the input handler uses), so slice the section
  // rows through the same viewport before listing. The list body renders one
  // line per item below a 2-line header, a category line, and the help footer,
  // so the window capacity matches rows - 4.
  const windowRows = legacyDetailViewport(
    statusDetailRows(projection, columns),
    columns,
    Math.max(1, Math.floor(viewport.rows) - 4),
    Math.max(0, Math.floor(options.scrollOffset ?? 0)),
  ).rows
  return {
    height: Math.max(1, Math.floor(viewport.rows)),
    header: 'Status',
    categories: [{ id: 'status', label: 'Diagnostics' }],
    activeCategoryId: 'status',
    focus: 'content',
    searchHidden: true,
    actions: [],
    groups: [],
    dirtyCount: 0,
    body: {
      kind: 'list',
      items: windowRows.map((row, index) => ({
        id: `status-${index}`,
        // Detail rows are padded to the page width; collapse the runs of
        // spaces so paired values survive the narrower content panel.
        label: row.text.trim().replace(/ {3,}/gu, '  '),
      })),
      selectedIndex: 0,
    },
    help: '↑↓ move · Enter / Esc / q close',
    ...(strings === undefined ? {} : { strings }),
  }
}

export function renderStatusFormFrame(
  projection: StatusPanelProjection,
  viewport: TerminalViewport,
  options: StatusFrameOptions = {},
): UiFrame {
  const bounded = {
    columns: dimension(viewport.columns),
    rows: dimension(viewport.rows),
  }
  const model = statusFormModel(projection, bounded, options)
  if (options.deferLayout === true) {
    return { title: 'Status', viewport: bounded, lines: [], formWorkspace: model }
  }
  const component = new FormWorkspace(model)
  const lines = component.render(bounded.columns)
  const cursor = component.getCursor()
  return {
    title: 'Status',
    viewport: bounded,
    lines,
    formWorkspace: model,
    ...(cursor === undefined ? {} : { cursor }),
  }
}

export function statusDetailViewport(
  projection: StatusPanelProjection,
  viewport: TerminalViewport,
  offset: number,
): {
  readonly rows: readonly { readonly text: string; readonly tone: string; readonly bold?: boolean }[]
  readonly offset: number
  readonly maxOffset: number
} {
  return legacyDetailViewport(
    statusDetailRows(projection, dimension(viewport.columns)),
    dimension(viewport.columns),
    dimension(viewport.rows) - 4,
    offset,
  )
}
