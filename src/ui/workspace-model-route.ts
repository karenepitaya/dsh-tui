import type { RequestRouteEpoch, RoutePanelView } from '../llm/routes.ts'
import { formatTokenCount } from './context-metrics.ts'
import type { DshTuiSemanticRole } from './theme.ts'
import { inlineText } from './workspace-rows.ts'

function routeReasonLabel(reason: RequestRouteEpoch['reason']): string {
  switch (reason) {
    case 'initial': return 'INITIAL'
    case 'resume': return 'RESUME'
    case 'change': return 'CHANGE'
    case 'series': return 'SERIES'
  }
}

function routeReasonTone(reason: RequestRouteEpoch['reason']): DshTuiSemanticRole {
  switch (reason) {
    case 'initial': return 'success'
    case 'resume': return 'telemetry'
    case 'change': return 'warning'
    case 'series': return 'telemetry'
  }
}

export function routeRail(view: Pick<RoutePanelView, 'rows' | 'omittedEpochCount'>): string {
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

function routeFieldSource(
  value: unknown,
  adapterDefault: true | undefined,
): string {
  if (adapterDefault === true) return 'adapter default'
  return value === undefined ? 'unset' : 'caller'
}

export function routeDetailRows(
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