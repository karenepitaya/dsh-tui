import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from '../terminal/text-layout.ts'
import { pluginPhaseLabel, type RuntimeLibraryView, type RuntimeSettingFieldView } from '../runtime-library/surface.ts'
import type { TerminalViewport, UiCursor, UiFrame } from './frame.ts'
import type { DshTuiSemanticRole } from './theme.ts'
import { secondaryModalFill, secondaryModalHeader, secondaryModalPair, secondaryModalRow, secondaryModalSplit, type SecondaryModalRow } from './modal.ts'
import { focusedWindowStart, inlineText, secondaryModalFrame } from './workspace-rows.ts'
import { promptProjection } from './prompt-projection.ts'

interface CapabilityLensDetailLine {
  readonly text: string
  readonly tone: DshTuiSemanticRole
  readonly bold?: boolean
  readonly dim?: boolean
  readonly selected?: boolean
}

function runtimeValueLabel(field: RuntimeSettingFieldView): string {
  if (field.source === 'secret') return field.secretSet === true ? 'configured' : 'not set'
  try {
    const value = JSON.stringify(field.value)
    return inlineText(value === undefined ? 'undefined' : value)
  } catch {
    return 'unprintable'
  }
}

function runtimeFieldTone(field: RuntimeSettingFieldView): DshTuiSemanticRole {
  if (field.selected) return 'accent'
  switch (field.source) {
    case 'user': return 'success'
    case 'base': return 'telemetry'
    case 'secret': return 'warning'
    case 'default': return 'muted'
  }
}

function runtimeSettingsDetail(view: RuntimeLibraryView): CapabilityLensDetailLine[] {
  const lines: CapabilityLensDetailLine[] = []
  if (view.settings.error !== undefined) {
    lines.push({ text: `Error  ${inlineText(view.settings.error)}`, tone: 'error', bold: true })
  }
  if (view.settings.stale) {
    lines.push({ text: 'Showing last good redacted descriptor', tone: 'warning', bold: true })
  }
  const selected = view.settings.selected
  if (selected === undefined) {
    lines.push({
      text: view.settings.available
        ? view.query.text.trim() === '' ? 'No registered settings namespaces' : 'No matching namespaces'
        : 'Settings service is unavailable',
      tone: 'muted',
      dim: true,
    })
    return lines
  }
  const defaults = selected.fields.filter(field => field.source === 'default').length
  const bases = selected.fields.filter(field => field.source === 'base').length
  const users = selected.fields.filter(field => field.source === 'user').length
  const secrets = selected.fields.filter(field => field.source === 'secret').length
  lines.push(
    { text: `Layer stack  ${inlineText(selected.namespace)}`, tone: 'interaction', bold: true },
    { text: `○ DEFAULT     ${defaults} inherited`, tone: 'muted', dim: true },
    { text: `◇ BASE        ${bases} composed`, tone: 'telemetry', bold: bases > 0 },
    { text: `◆ USER        ${users} override${users === 1 ? '' : 's'}`, tone: users > 0 ? 'success' : 'muted', bold: users > 0 },
    ...(secrets === 0 ? [] : [{ text: `◈ SECRET      ${secrets} redacted slot${secrets === 1 ? '' : 's'}`, tone: 'warning' as const, bold: true }]),
    {
      text: `● EFFECTIVE   ${selected.applies.toUpperCase()} · R${selected.revision}`,
      tone: selected.applies === 'live' ? 'success' : 'warning',
      bold: true,
    },
    { text: 'Field map', tone: 'interaction', bold: true },
    ...selected.fields.map(field => ({
      text: `${field.selected ? '›' : ' '} ${field.source.toUpperCase().padEnd(7)} ${inlineText(field.pathLabel)}  ${runtimeValueLabel(field)}`,
      tone: runtimeFieldTone(field),
      bold: field.selected,
      dim: field.source === 'default' && !field.selected,
      selected: field.selected,
    })),
  )
  return lines
}

function runtimePluginsDetail(view: RuntimeLibraryView): CapabilityLensDetailLine[] {
  const lines: CapabilityLensDetailLine[] = []
  if (view.plugins.error !== undefined) {
    lines.push({ text: `Error  ${inlineText(view.plugins.error)}`, tone: 'error', bold: true })
  }
  const selected = view.plugins.selected
  if (selected === undefined) {
    lines.push({
      text: view.plugins.available
        ? view.query.text.trim() === '' ? 'No Loader plugin entries' : 'No matching Loader entries'
        : 'Loader inventory is unavailable',
      tone: 'muted',
      dim: true,
    })
    return lines
  }
  const phase = pluginPhaseLabel(selected.fiberPhase)
  const phaseSymbol = selected.fiberPhase === 'active'
    ? '●'
    : selected.fiberPhase === 'failed' ? '×' : selected.fiberPhase === null ? '○' : '◐'
  const lifecycle = `CONFIGURED  ━━━  ${selected.enabled ? 'ENABLED' : 'DISABLED'}  ━━━  ${phaseSymbol} ${phase.toUpperCase()}`
  lines.push(
    { text: 'Lifecycle rail', tone: 'interaction', bold: true },
    {
      text: lifecycle,
      tone: selected.fiberPhase === 'failed'
        ? 'error'
        : selected.enabled && selected.fiberPhase === 'active' ? 'success' : 'warning',
      bold: true,
    },
    { text: `Module  ${inlineText(selected.moduleName)}`, tone: 'primary', bold: true },
    { text: `Entry   ${inlineText(selected.entryId)}`, tone: 'telemetry' },
    { text: `Config  ${selected.enabled ? 'enabled' : 'disabled'}`, tone: selected.enabled ? 'success' : 'warning' },
    { text: `Fiber   ${phaseSymbol} ${phase}`, tone: selected.fiberPhase === 'failed' ? 'error' : 'primary' },
    { text: '', tone: 'primary' },
    { text: 'Authority  Loader snapshot · read only', tone: 'muted', dim: true },
    { text: 'Not projected  provenance · history · health', tone: 'muted', dim: true },
  )
  return lines
}

function runtimeLibraryFooter(view: RuntimeLibraryView): string {
  if (view.pending) return 'Settings write in progress · Esc close'
  if (view.focus === 'editor') return 'Type JSON · Enter apply · Esc cancel'
  if (view.searchFocused) return 'Search · Enter apply · Tab region · Esc back'
  if (view.focus === 'detail') return view.tab === 'settings'
    ? 'j/k field · PgUp/PgDn scroll · Enter edit · Ctrl+S inherit · Tab list'
    : 'j/k scroll · PgUp/PgDn page · Enter refresh · Tab list'
  return 'j/k move · / i search · Tab detail · [ ] tabs · Esc back'
}

export function runtimeLibraryDetailViewport(view: RuntimeLibraryView, viewport: TerminalViewport): {
  readonly lines: readonly CapabilityLensDetailLine[]
  readonly offset: number
  readonly maxOffset: number
} {
  const split = viewport.columns >= 100
  const leftColumns = Math.max(24, Math.min(44, Math.floor((viewport.columns - 3) * 0.37)))
  const width = Math.max(1, split ? viewport.columns - leftColumns - 3 : viewport.columns - 2)
  const height = Math.max(0, viewport.rows - 5)
  const source = view.tab === 'settings' ? runtimeSettingsDetail(view) : runtimePluginsDetail(view)
  if (view.notice !== undefined) source.unshift({ text: `Saved  ${inlineText(view.notice)}`, tone: 'success', bold: true })
  if (view.error !== undefined) source.unshift({ text: `Error  ${inlineText(view.error)}`, tone: 'error', bold: true })
  if (view.pending) source.unshift({ text: 'Writing through official SettingsProvider…', tone: 'warning', bold: true })
  const lines = source.flatMap(line => wrapTextWithAnsi(line.text, width).map(text => ({ ...line, text: stripTerminalSequences(text) })))
  const selected = lines.findIndex(line => line.selected === true)
  const maxOffset = Math.max(0, lines.length - height)
  const status = view.error !== undefined || view.notice !== undefined || view.pending
  const follow = !status && view.focus !== 'catalog' && selected >= height ? Math.max(0, selected - Math.floor(height / 3)) : 0
  const offset = Math.max(0, Math.min(maxOffset, view.detailScrollOffset ?? follow))
  return { lines: lines.slice(offset, offset + height), offset, maxOffset }
}

function runtimeLibraryListRow(
  view: RuntimeLibraryView,
  index: number,
  columns: number,
): { readonly text: string; readonly selected: boolean } | undefined {
  if (view.tab === 'settings') {
    const row = view.settings.rows[index]
    if (row === undefined) return undefined
    const badge = `${row.applies === 'live' ? '● LIVE' : '◐ RESTART'} · U${row.overrideCount} · S${row.secretCount}`
    return {
      text: secondaryModalPair(`${row.selected ? '▰' : ' '} ${inlineText(row.namespace)}`, badge, columns),
      selected: row.selected,
    }
  }
  const row = view.plugins.rows[index]
  if (row === undefined) return undefined
  const phase = pluginPhaseLabel(row.fiberPhase)
  const phaseSymbol = row.fiberPhase === 'active'
    ? '●'
    : row.fiberPhase === 'failed' ? '×' : row.fiberPhase === null ? '○' : '◐'
  const badge = row.enabled ? `${phaseSymbol} ${phase.toUpperCase()}` : '○ OFF'
  return {
    text: secondaryModalPair(`${row.selected ? '▰' : ' '} ${inlineText(row.entryId)}`, badge, columns),
    selected: row.selected,
  }
}

export function renderRuntimeLibraryFrame(
  view: RuntimeLibraryView,
  viewport: TerminalViewport,
): UiFrame {
  const { columns, rows } = viewport
  const header = secondaryModalRow(
    secondaryModalHeader('Runtime library', columns),
    'accent',
    { bold: true },
  )
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  const settingsOverrides = view.settings.rows.reduce((total, row) => total + row.overrideCount, 0)
  const settingsTab = `${view.tab === 'settings' ? '▰' : ' '} SETTINGS ${view.settings.totalCount} · U${settingsOverrides}`
  const pluginsTab = `${view.tab === 'plugins' ? '▰' : ' '} PLUGINS ${view.plugins.totalCount} · ${view.plugins.activeCount} ACTIVE`
  const tabs = secondaryModalRow(
    secondaryModalPair(`  ${settingsTab}    ${pluginsTab}`, 'APP GLOBAL', columns),
    'telemetry',
    { bold: true },
  )
  if (rows === 2) return secondaryModalFrame(viewport, [header, tabs])

  const editing = view.focus === 'editor' && view.editor !== undefined
  const inputState = editing ? view.editor!.input : view.query
  const inputPrefix = editing
    ? `  ${view.editor!.secret ? 'Secret JSON' : 'Value JSON'} › `
    : '  Search › '
  const inputProjection = promptProjection(
    inputState,
    Math.max(1, columns - visibleWidth(inputPrefix)),
    '',
  )
  const input = secondaryModalRow(
    secondaryModalFill(`${inputPrefix}${inputProjection.line}`, columns),
    editing ? 'warning' : view.searchFocused ? 'composer' : 'muted',
    { bold: editing || view.searchFocused },
  )
  const cursor: UiCursor | undefined = editing || view.searchFocused
    ? { row: 2, column: Math.min(columns - 1, visibleWidth(inputPrefix) + inputProjection.column) }
    : undefined
  if (rows === 3) return secondaryModalFrame(viewport, [header, tabs, input], cursor)

  const leftColumns = Math.max(24, Math.min(44, Math.floor((columns - 3) * 0.37)))
  const split = columns >= 100
  const detailsOnly = !split && view.focus !== 'catalog'
  const selectedCount = view.tab === 'settings' ? view.settings.rows.length : view.plugins.rows.length
  const totalCount = view.tab === 'settings' ? view.settings.totalCount : view.plugins.totalCount
  const authority = view.tab === 'settings'
    ? `${view.settings.writable ? 'WRITE' : 'READ'} · ${view.settings.documentBacked ? 'USER FILE' : 'MEMORY'} · G${view.settings.generation}`
    : `READ · ${view.plugins.failedCount} FAILED`
  const section = secondaryModalRow(
    split ? secondaryModalSplit(
      secondaryModalPair(
        view.tab === 'settings' ? '  Namespaces' : '  Loader entries',
        `${selectedCount}/${totalCount}`,
        leftColumns,
      ),
      secondaryModalPair(
        view.tab === 'settings' ? '  Layer stack' : '  Lifecycle rail',
        authority,
        Math.max(1, columns - leftColumns - 3),
      ),
      columns,
      leftColumns,
    ) : secondaryModalPair(
      detailsOnly ? view.tab === 'settings' ? '  Fields' : '  Plugin details' : view.tab === 'settings' ? '  Namespaces' : '  Loader entries',
      authority,
      columns,
    ),
    'interaction',
    { bold: true },
  )
  const footer = secondaryModalRow(
    secondaryModalFill(`  ${runtimeLibraryFooter(view)}`, columns),
    'muted',
    { dim: true },
  )
  if (rows === 4) return secondaryModalFrame(viewport, [header, tabs, input, footer], cursor)

  const bodySlots = rows - 5
  const selectedIndex = view.tab === 'settings'
    ? Math.max(0, view.settings.rows.findIndex(row => row.selected))
    : Math.max(0, view.plugins.rows.findIndex(row => row.selected))
  const listCount = view.tab === 'settings' ? view.settings.rows.length : view.plugins.rows.length
  const start = focusedWindowStart(listCount, selectedIndex, bodySlots)
  const detail = runtimeLibraryDetailViewport(view, viewport).lines
  const body: SecondaryModalRow[] = []
  for (let index = 0; index < bodySlots; index += 1) {
    const list = detailsOnly ? undefined : runtimeLibraryListRow(view, start + index, split ? leftColumns : columns)
    const item = split || detailsOnly || listCount === 0 ? detail[index] : undefined
    body.push(secondaryModalRow(
      split ? secondaryModalSplit(list?.text ?? '', item?.text ?? '', columns, leftColumns)
        : secondaryModalFill(detailsOnly || listCount === 0 ? item?.text ?? '' : list?.text ?? '', columns),
      item?.tone === 'error'
        ? 'error'
        : list?.selected === true && view.focus === 'catalog'
          ? 'accent'
          : item?.tone ?? (list?.selected === true ? 'telemetry' : 'primary'),
      {
        bold: list?.selected === true || item?.bold === true,
        dim: list?.selected !== true && item?.dim === true,
        selected: list?.selected === true && view.focus === 'catalog' && !view.searchFocused,
      },
    ))
  }
  return secondaryModalFrame(viewport, [header, tabs, input, section, ...body, footer], cursor, split ? leftColumns : undefined)
}
