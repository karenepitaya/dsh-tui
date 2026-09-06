import type { RequestRouteEpoch, RoutePanelView } from '../llm/routes.ts'
import { formatTokenCount } from './context-metrics.ts'
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

function routeReasonLabel(reason: RequestRouteEpoch['reason']): string {
  switch (reason) {
    case 'initial': return 'INITIAL'
    case 'resume': return 'RESUME'
    case 'change': return 'CHANGE'
  }
}

function routeReasonTone(reason: RequestRouteEpoch['reason']): DshTuiSemanticRole {
  switch (reason) {
    case 'initial': return 'success'
    case 'resume': return 'telemetry'
    case 'change': return 'warning'
  }
}

function routeRail(view: RoutePanelView): string {
  const chronological = [...view.rows].reverse()
  const visible = chronological.slice(-6)
  const hidden = view.omittedEpochCount + chronological.length - visible.length
  const firstOrdinal = view.omittedEpochCount + chronological.length - visible.length + 1
  const parts = visible.map((epoch, index) => {
    const current = epoch.headerSeq === view.rows[0]?.headerSeq
    const symbol = current ? '◉' : epoch.reason === 'initial' ? '◆' : epoch.reason === 'resume' ? '↻' : '◇'
    return `${symbol}${String(firstOrdinal + index).padStart(2, '0')}`
  })
  return `${hidden === 0 ? '' : `…${hidden} ─ `}${parts.join(' ─ ') || '∅'}`
}

function routeEpochRow(
  epoch: RequestRouteEpoch,
  selected: boolean,
  current: boolean,
  ordinal: number,
): string {
  const symbol = current ? '◉' : epoch.reason === 'initial' ? '◆' : epoch.reason === 'resume' ? '↻' : '◇'
  return `${selected ? '›' : ' '} ${symbol}${String(ordinal).padStart(2, '0')}  ${routeReasonLabel(epoch.reason).padEnd(7)}  ${inlineText(epoch.config.provider)}/${inlineText(epoch.config.model)}`
}

function routeFieldSource(
  value: unknown,
  adapterDefault: true | undefined,
): string {
  if (adapterDefault === true) return 'adapter default'
  return value === undefined ? 'unset' : 'caller'
}

function routeDetailRows(
  selected: RequestRouteEpoch | undefined,
  currentHeaderSeq: number | undefined,
): readonly {
  readonly text: string
  readonly tone: DshTuiSemanticRole
  readonly bold?: boolean
}[] {
  if (selected === undefined) return []
  const config = selected.config
  const effortSource = routeFieldSource(
    config.reasoningEffort,
    selected.adapterDefaults?.reasoningEffort,
  )
  const maxSource = routeFieldSource(config.maxTokens, selected.adapterDefaults?.maxTokens)
  return [
    {
      text: `State  ${selected.headerSeq === currentHeaderSeq ? 'CURRENT' : 'HISTORY'}`,
      tone: selected.headerSeq === currentHeaderSeq ? 'success' : 'muted',
      bold: true,
    },
    { text: `Provider  ${inlineText(config.provider)}`, tone: 'telemetry', bold: true },
    { text: `Model  ${inlineText(config.model)}`, tone: 'primary' },
    {
      text: `Effort  ${config.reasoningEffort === undefined ? '—' : inlineText(config.reasoningEffort)} · ${effortSource}`,
      tone: 'interaction',
    },
    {
      text: `Max output  ${config.maxTokens === undefined ? '—' : formatTokenCount(config.maxTokens)} · ${maxSource}`,
      tone: 'interaction',
    },
    {
      text: `Temperature  ${config.temperature === undefined ? '—' : config.temperature}`,
      tone: 'primary',
    },
    {
      text: `Stop sequences  ${config.stop === undefined ? '—' : config.stop.length}`,
      tone: 'primary',
    },
    {
      text: `Context window  ${selected.context?.contextWindow === undefined ? 'not advertised' : formatTokenCount(selected.context.contextWindow)}`,
      tone: selected.context?.contextWindow === undefined ? 'muted' : 'success',
    },
    {
      text: `Header  ${routeReasonLabel(selected.reason)} · seq ${selected.headerSeq}`,
      tone: routeReasonTone(selected.reason),
    },
    {
      text: 'Authority  Official request/header + request/context',
      tone: 'muted',
    },
  ]
}

export function routeDetailViewport(
  view: RoutePanelView,
  viewport: TerminalViewport,
  offset: number,
): ReturnType<typeof legacyDetailViewport<ReturnType<typeof routeDetailRows>[number]>> {
  const leftColumns = Math.max(28, Math.min(50, Math.floor((viewport.columns - 3) * 0.44)))
  return legacyDetailViewport(routeDetailRows(view.selected, view.rows[0]?.headerSeq),
    viewport.columns < 100 ? viewport.columns - 4 : viewport.columns - leftColumns - 3,
    viewport.rows - 4, offset)
}

export function renderRouteFrame(
  view: RoutePanelView,
  viewport: TerminalViewport,
  navigation?: LegacyDirectoryNavigation,
): UiFrame {
  const { columns, rows } = viewport
  const split = columns >= 100
  const detailFocused = navigation?.focus === 'details'
  const header = secondaryModalRow(
    secondaryModalHeader('Model route', columns),
    'accent',
    { bold: true },
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  const footer = secondaryModalRow(
    secondaryModalPair(`  ↑↓ ${detailFocused ? 'scroll details' : 'inspect route epoch'} · h/l/Tab focus`, 'Esc close', columns),
    'muted',
    { dim: true },
  )
  if (rows === 2) return secondaryModalFrame(viewport, [header, footer])
  const current = view.rows[0]
  const summary = secondaryModalRow(
    secondaryModalPair(
      `  ${routeRail(view)}`,
      `${view.rows.length + view.omittedEpochCount} epochs${current === undefined ? '' : ` · ${inlineText(current.config.provider)}/${inlineText(current.config.model)}`}`,
      columns,
    ),
    current === undefined ? 'muted' : 'telemetry',
    { bold: true },
  )
  if (rows === 3) return secondaryModalFrame(viewport, [header, summary, footer])
  const section = secondaryModalRow(
    secondaryModalSection(split || !detailFocused ? 'Route epochs' : 'Effective request', columns,
      split ? 'Effective request' : ''),
    'interaction',
    { bold: true },
  )
  const bodySlots = rows - 4
  const start = focusedWindowStart(view.rows.length, view.selectedIndex, bodySlots)
  const visible = view.rows.slice(start, start + bodySlots)
  const details = routeDetailViewport(view, viewport, navigation?.detailOffset ?? 0).rows
  const leftColumns = Math.max(28, Math.min(50, Math.floor((columns - 3) * 0.44)))
  const body = Array.from({ length: bodySlots }, (_, index): SecondaryModalRow => {
    const epoch = visible[index]
    const absoluteIndex = start + index
    const selected = epoch !== undefined && absoluteIndex === view.selectedIndex
    const detail = details[index]
    if (!split) {
      const text = detailFocused
        ? detail?.text ?? (index === 0 ? 'Send a prompt to materialize the official route.' : '')
        : epoch === undefined ? (index === 0 ? '  ∅  No route epochs recorded' : '')
          : routeEpochRow(epoch, selected, epoch.headerSeq === current?.headerSeq,
            view.omittedEpochCount + view.rows.length - absoluteIndex)
      return secondaryModalRow(secondaryModalFill(`  ${text}`, columns),
        detailFocused ? detail?.tone ?? 'muted' : selected ? 'accent' : 'primary',
        { bold: detailFocused ? detail?.bold === true : selected, selected: !detailFocused && selected })
    }
    if (epoch === undefined && detail === undefined && index === 0 && view.rows.length === 0) {
      return secondaryModalRow(
        secondaryModalSplit('  ∅  No route epochs recorded', 'Send a prompt to materialize the official route.', columns, leftColumns),
        'muted',
        { dim: true },
      )
    }
    const ordinal = view.omittedEpochCount + view.rows.length - absoluteIndex
    return secondaryModalRow(
      secondaryModalSplit(
        epoch === undefined ? '' : routeEpochRow(
          epoch,
          selected,
          epoch.headerSeq === current?.headerSeq,
          ordinal,
        ),
        detail?.text ?? '',
        columns,
        leftColumns,
      ),
      selected ? 'accent' : epoch === undefined ? detail?.tone ?? 'primary' : routeReasonTone(epoch.reason),
      { bold: selected || detail?.bold === true, selected },
    )
  })
  return secondaryModalFrame(viewport, [header, summary, section, ...body, footer], undefined, split ? leftColumns : undefined)
}
