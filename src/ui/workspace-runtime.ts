import { choiceText } from '../presentation/control-projection.ts'
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from '../terminal/text-layout.ts'
import { pluginPhaseLabel, runtimeSettingsName, runtimeSettingName, runtimePluginName, type RuntimeLibraryView, type RuntimeSettingFieldView } from '../runtime-library/surface.ts'
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

function runtimeSettingsDetail(view: RuntimeLibraryView): CapabilityLensDetailLine[] {
  const lines: CapabilityLensDetailLine[] = []
  if (view.settings.error !== undefined) {
    lines.push({ text: `Error  ${inlineText(view.settings.error)}`, tone: 'error', bold: true })
  }
  if (view.settings.stale) {
    lines.push({ text: 'Showing last known settings · Reopen /settings to refresh', tone: 'warning', bold: true })
  }
  const selected = view.settings.selected
  if (selected === undefined) {
    lines.push({
      text: view.settings.error !== undefined ? 'Could not load settings · Reopen /settings to retry'
        : view.settings.available
          ? view.query.text.trim() === '' ? 'No registered settings · Check the application configuration' : 'No matching settings · Edit or clear the search'
          : 'Settings service is unavailable',
      tone: 'muted',
      dim: true,
    })
    return lines
  }
  const details = view.focus !== 'catalog'
  lines.push(
    { text: runtimeSettingsName(selected.namespace), tone: 'interaction', bold: true },
    {
      text: selected.applies === 'live' ? 'Applies immediately' : 'Applies after restart',
      tone: selected.applies === 'live' ? 'primary' : 'warning',
    },
    { text: view.settings.writable ? details ? 'Enter edit · Ctrl+S inherit' : 'Enter or Tab to choose a setting' : 'Read-only · Change the application configuration', tone: 'muted' },
    ...selected.fields.map(field => ({
      text: choiceText(`${inlineText(runtimeSettingName(selected.namespace, field.pathLabel))}  ${runtimeValueLabel(field)}${details ? ` · ${field.source}` : ''}`, details && field.selected),
      tone: details && field.selected ? 'accent' as const : 'primary' as const,
      bold: details && field.selected,
      selected: details && field.selected,
    })),
  )
  if (details) lines.push(
    { text: `Namespace  ${inlineText(selected.namespace)}`, tone: 'muted' },
    { text: `Revision  ${selected.revision} · ${view.settings.documentBacked ? 'User file' : 'In memory'}`, tone: 'muted' },
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
      text: view.plugins.error !== undefined ? 'Could not load plugins · Enter to retry'
        : view.plugins.available
          ? view.query.text.trim() === '' ? 'No plugins configured · Check the application configuration' : 'No matching plugins · Edit or clear the search'
          : 'Plugin list is unavailable',
      tone: 'muted',
      dim: true,
    })
    return lines
  }
  const phase = pluginPhaseLabel(selected.fiberPhase)
  lines.push(
    { text: runtimePluginName(selected.moduleName), tone: 'interaction', bold: true },
    {
      text: `${selected.enabled ? '' : 'Disabled in configuration · '}${phase.toUpperCase()}`,
      tone: selected.fiberPhase === 'failed'
        ? 'error'
        : selected.enabled && selected.fiberPhase === 'active' ? 'success' : 'warning',
      bold: true,
    },
    { text: 'Enter refresh · Change plugins in the application configuration', tone: 'muted' },
  )
  if (view.focus !== 'catalog') lines.push(
    { text: `Module  ${inlineText(selected.moduleName)}`, tone: 'muted' },
    { text: `Entry   ${inlineText(selected.entryId)}`, tone: 'muted' },
    { text: 'Read-only plugin inventory', tone: 'muted' },
  )
  return lines
}

function runtimeLibraryFooter(view: RuntimeLibraryView): string {
  if (view.pending) return 'Settings write in progress · Esc close'
  if (view.focus === 'editor') return 'Type JSON · Enter apply · Esc cancel'
  if (view.searchFocused) return 'Search · Enter results · Tab details · Esc back'
  if (view.focus === 'detail') return view.tab === 'settings'
    ? view.settings.writable
      ? 'j/k field · PgUp/PgDn scroll · Enter edit · Ctrl+S inherit · Tab list'
      : 'j/k field · PgUp/PgDn scroll · Tab list · Read-only'
    : 'j/k scroll · PgUp/PgDn page · Enter refresh · Tab list'
  return view.tab === 'settings'
    ? 'j/k move · Enter settings · / i search · Tab details · [ ] tabs · Esc back'
    : 'j/k move · Enter refresh · / i search · Tab details · [ ] tabs · Esc back'
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
    const badge = row.applies === 'live' ? 'Live' : 'Restart'
    const preview = row.selected ? view.settings.selected?.fields.slice(0, 2).map(field => `${runtimeSettingName(row.namespace, field.pathLabel)} ${runtimeValueLabel(field)}`).join(' · ') : undefined
    return {
      text: secondaryModalPair(choiceText(`${inlineText(runtimeSettingsName(row.namespace))}${columns > 44 && preview ? ` · ${preview}` : ''}`, row.selected), badge, columns),
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
    text: secondaryModalPair(choiceText(inlineText(runtimePluginName(row.moduleName)), row.selected), badge, columns),
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
  const settingsTab = `${view.tab === 'settings' ? '▰' : ' '} SETTINGS ${view.settings.totalCount}`
  const pluginsTab = `${view.tab === 'plugins' ? '▰' : ' '} PLUGINS ${view.plugins.totalCount}`
  const tabs = secondaryModalRow(
    secondaryModalPair(`  ${settingsTab}    ${pluginsTab}`, 'Application', columns),
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
    ? `${view.settings.documentBacked ? 'Saved for your user' : 'This application only'}${view.settings.writable ? '' : ' · Read-only'}`
    : 'Read-only · Enter refresh'
  const section = secondaryModalRow(
    split ? secondaryModalSplit(
      secondaryModalPair(
        view.tab === 'settings' ? '  Settings' : '  Plugins',
        `${selectedCount}/${totalCount}`,
        leftColumns,
      ),
      secondaryModalPair(
        view.tab === 'settings' ? '  Effective values' : '  Selected plugin',
        authority,
        Math.max(1, columns - leftColumns - 3),
      ),
      columns,
      leftColumns,
    ) : secondaryModalPair(
      detailsOnly ? view.tab === 'settings' ? '  Settings' : '  Plugin details' : view.tab === 'settings' ? '  Settings' : '  Plugins',
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
