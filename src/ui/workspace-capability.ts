import type { SkillPickerView } from '../skill/picker.ts'
import type { ToolBrowserView } from '../tool/browser.ts'
import type { McpCapabilityBrowserView } from '../mcp/capabilities.ts'
import type { LegacyDirectoryState } from '../navigation/legacy-directory.ts'
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from '../terminal/text-layout.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'
import type { DshTuiSemanticRole } from './theme.ts'
import type { PromptEditorState } from './prompt-editor.ts'
import { promptProjection } from './prompt-projection.ts'
import { secondaryModalFill, secondaryModalHeader, secondaryModalPair, secondaryModalRow, secondaryModalSection, secondaryModalSplit, type SecondaryModalRow } from './modal.ts'
import { focusedWindowStart, inlineText, secondaryModalFrame } from './workspace-rows.ts'

function wrap(text: string, columns: number): string[] {
  return wrapTextWithAnsi(inlineText(text), Math.max(1, columns)).map(stripTerminalSequences)
}

function skillResourceLabel(
  resource: SkillPickerView['rows'][number]['resourceBase'],
): string | undefined {
  if (resource === undefined) return undefined
  switch (resource.kind) {
    case 'directory': return resource.path
    case 'url': return resource.url
    case 'opaque': return resource.description
  }
}

interface CapabilityLensListRow {
  readonly label: string
  readonly badge: string
}

export interface CapabilityLensDetailLine {
  readonly text: string
  readonly tone: DshTuiSemanticRole
  readonly bold?: boolean
  readonly dim?: boolean
}

export interface LegacyDirectoryFrame extends UiFrame {
  readonly detailMaxOffset?: number
}

export interface CapabilityLensOptions extends LegacyDirectoryState {
  readonly title: string
  readonly sectionLabel: string
  readonly query: PromptEditorState
  readonly rows: readonly CapabilityLensListRow[]
  readonly selectedIndex: number
  readonly summary: string
  readonly detail: readonly CapabilityLensDetailLine[]
  readonly footerLeft: string
}

export function capabilityLensLeftColumns(columns: number): number {
  return columns < 100 ? Math.max(1, columns - 2) : Math.max(18, Math.min(38, Math.floor((columns - 3) * 0.32)))
}

export function renderCapabilityLensFrame(options: CapabilityLensOptions, viewport: TerminalViewport): LegacyDirectoryFrame {
  const { columns, rows } = viewport
  const focus = options.navigation?.focus ?? 'list'
  const split = columns >= 100
  const header = secondaryModalRow(secondaryModalHeader(options.title, columns), 'accent', { bold: true })
  if (rows === 1) return secondaryModalFrame(viewport, [header])
  const searchPrefix = '  Search › '
  const editor = promptProjection(options.query, Math.max(1, columns - visibleWidth(searchPrefix)), '')
  const search = secondaryModalRow(secondaryModalFill(`${searchPrefix}${editor.line}`, columns), 'composer', { bold: true })
  const cursor = focus === 'search' ? { row: 1, column: Math.min(columns - 1, visibleWidth(searchPrefix) + editor.column) } : undefined
  if (rows === 2) return secondaryModalFrame(viewport, [header, search])
  const footer = secondaryModalRow(secondaryModalPair(
    `  ${focus === 'search' ? 'Enter results' : options.footerLeft.trim()} · / i search · Tab details · h/l focus · j/k move`,
    'Esc back', columns), 'muted')
  if (rows === 3) return secondaryModalFrame(viewport, [header, search, footer], cursor)
  const bodySlots = rows - 4
  const leftColumns = capabilityLensLeftColumns(columns)
  const detailWidth = split ? columns - leftColumns - 3 : Math.max(1, columns - 4)
  const details = options.detail.flatMap(line => wrap(line.text, detailWidth).map(text => ({ ...line, text })))
  const detailOffset = Math.max(0, Math.min(options.navigation?.detailOffset ?? 0, details.length - bodySlots))
  const range = details.length > bodySlots ? ` · Detail ${detailOffset + 1}–${Math.min(details.length, detailOffset + bodySlots)}/${details.length}` : ''
  const section = secondaryModalRow(secondaryModalSection(options.sectionLabel, columns, `${options.summary}${range}`), 'interaction', { bold: true })
  const notices = !split && focus !== 'details' && options.rows.length > 0
    ? details.filter(line => line.tone === 'error' || line.tone === 'warning').slice(0, Math.min(2, Math.max(0, bodySlots - 1))) : []
  const start = focusedWindowStart(options.rows.length, options.selectedIndex, bodySlots - notices.length)
  const body: SecondaryModalRow[] = []
  for (let index = 0; index < bodySlots; index += 1) {
    const notice = notices[index]
    if (notice !== undefined) {
      body.push(secondaryModalRow(secondaryModalFill(`  ${notice.text}`, columns), notice.tone, { bold: notice.bold === true }))
      continue
    }
    const itemIndex = start + index - notices.length
    const item = options.rows[itemIndex]
    const selected = item !== undefined && itemIndex === options.selectedIndex
    const detail = details[detailOffset + index]
    const left = item === undefined ? '' : secondaryModalPair(`${selected ? '›' : ' '} ${item.label}`, item.badge, leftColumns)
    if (split) {
      body.push(secondaryModalRow(secondaryModalSplit(left, detail?.text ?? '', columns, leftColumns),
        detail?.tone === 'error' ? 'error' : selected ? 'accent' : detail?.tone ?? 'primary',
        { bold: selected || detail?.bold === true, selected }))
    } else if (focus === 'details' || options.rows.length === 0) {
      body.push(secondaryModalRow(secondaryModalFill(`  ${detail?.text ?? ''}`, columns), detail?.tone ?? 'primary', { bold: detail?.bold === true }))
    } else {
      body.push(secondaryModalRow(secondaryModalFill(left, columns), selected ? 'accent' : 'primary', { bold: selected, selected }))
    }
  }
  return { ...secondaryModalFrame(viewport, [header, search, section, ...body, footer], cursor, split ? leftColumns : undefined),
    detailMaxOffset: Math.max(0, details.length - bodySlots) }
}

function skillPickerDetailLines(
  view: SkillPickerView,
  columns: number,
): CapabilityLensDetailLine[] {
  const selected = view.rows[view.selectedIndex]
  const status: CapabilityLensDetailLine[] = []
  if (view.error !== undefined) {
    status.push({ text: `Error  ${inlineText(view.error)}`, tone: 'error', bold: true })
  }
  if (view.loading) {
    status.push({ text: 'Refreshing catalog…', tone: 'warning', bold: true })
  }
  if (!view.complete) {
    status.push({
      text: view.stale
        ? 'Catalog changed · showing the last complete view'
        : 'Catalog discovery is incomplete',
      tone: 'warning',
    })
  }
  if (!view.available) {
    return [
      ...status,
      { text: 'Skills are unavailable in this Agent composition', tone: 'muted', dim: true },
    ]
  }
  if (selected === undefined) {
    return [
      ...status,
      {
        text: view.error !== undefined ? 'Could not load skills · Reopen /skills to retry'
          : view.query.text.trim() === '' ? 'No user-invocable skills · Check skill configuration'
            : 'No matching skills · Edit or clear the search',
        tone: 'muted',
        dim: true,
      },
    ]
  }
  const width = Math.max(1, columns)
  const resource = skillResourceLabel(selected.resourceBase)
  return [
    ...status,
    { text: `Selected  /${inlineText(selected.name)}`, tone: 'interaction', bold: true },
    ...wrap(`About  ${inlineText(selected.description)}`, width)
      .map(text => ({ text, tone: 'primary' as const })),
    ...(selected.whenToUse === undefined
      ? []
      : wrap(`When  ${inlineText(selected.whenToUse)}`, width)
          .map(text => ({ text, tone: 'primary' as const }))),
    {
      text: `Invoke  user ✓ · model ${selected.modelInvocable ? '✓' : '—'}`,
      tone: 'success',
      bold: true,
    },
    { text: `Enter inserts /${inlineText(selected.name)} into your Chat draft`, tone: 'primary' },
    ...(view.navigation?.focus === 'details' ? [
      { text: `Source  ${inlineText(selected.source)} · ${inlineText(selected.provider)}`, tone: 'muted' as const, dim: true },
      ...(resource === undefined ? [] : [{ text: `Base  ${inlineText(resource)}`, tone: 'muted' as const, dim: true }]),
    ] : []),
  ]
}

export function renderSkillPickerFrame(
  view: SkillPickerView,
  viewport: TerminalViewport,
): LegacyDirectoryFrame {
  const { columns, rows } = viewport
  const leftColumns = capabilityLensLeftColumns(columns)
  const rightColumns = columns < 100 ? Math.max(1, columns - 4) : Math.max(1, columns - leftColumns - 3)
  return renderCapabilityLensFrame({
    title: 'Skills',
    sectionLabel: 'Capabilities',
    query: view.query,
    rows: view.rows.map(skill => ({
      label: `/${inlineText(skill.name)} · ${inlineText(skill.description)}`,
      badge: '',
    })),
    selectedIndex: view.selectedIndex,
    summary: `${view.rows.length}/${view.totalCount}${view.loading ? ' · Refreshing' : ''}`,
    detail: skillPickerDetailLines(view, rightColumns),
    footerLeft: '  ↑↓ move · Enter insert',
    ...(view.navigation === undefined ? {} : { navigation: view.navigation }),
  }, { columns, rows })
}

function toolGroupLabel(group: ToolBrowserView['rows'][number]['group']): string {
  switch (group) {
    case 'core': return 'Core'
    case 'mcp': return 'MCP'
    case 'transport': return 'Code transport'
  }
}

export function renderToolBrowserFrame(
  view: ToolBrowserView,
  viewport: TerminalViewport,
): LegacyDirectoryFrame {
  const { columns, rows } = viewport
  const selected = view.selected
  const required = new Set(selected?.requiredParameterNames ?? [])
  const leftColumns = capabilityLensLeftColumns(columns)
  const detailWidth = columns < 100 ? Math.max(1, columns - 4) : Math.max(1, columns - leftColumns - 3)
  const parameters = selected?.parameterNames.map(name => (
    required.has(name) ? `${inlineText(name)}*` : inlineText(name)
  )).join(', ')
  const detail: CapabilityLensDetailLine[] = []
  if (view.error !== undefined) {
    detail.push({ text: `Error  ${inlineText(view.error)}`, tone: 'error', bold: true })
    if (view.stale) detail.push({ text: 'Showing last good catalog', tone: 'warning' })
  }
  if (selected === undefined) {
    detail.push({
      text: view.error !== undefined ? 'Could not load tools · Reopen /tools to retry'
        : !view.available ? 'Capability registry unavailable'
          : view.query.text.trim() === '' ? 'No tools available · Check /settings'
            : 'No matching tools · Edit or clear the search',
      tone: 'muted',
      dim: true,
    })
  } else {
    detail.push(
      { text: `Selected  ${inlineText(selected.name)}`, tone: 'interaction', bold: true },
      ...wrap(`About  ${inlineText(selected.description)}`, detailWidth)
        .map(text => ({ text, tone: 'primary' as const })),
      { text: 'Ask in Chat to use this tool', tone: 'primary' },
    )
    if (view.navigation?.focus === 'details') detail.push(
      { text: `Kind  ${toolGroupLabel(selected.group)}`, tone: 'telemetry', bold: true },
      {
        text: `Inputs  ${selected.requiredParameterNames.length} required · ${selected.parameterNames.length} total`,
        tone: 'primary',
      },
      ...wrap(`Params  ${parameters === '' ? 'none' : parameters}`, detailWidth)
        .map(text => ({ text, tone: 'muted' as const, dim: true })),
      {
        text: `Scope  exact Agent · generation ${view.generation}`,
        tone: 'muted',
        dim: true,
      },
    )
  }

  return renderCapabilityLensFrame({
    title: 'Tools',
    sectionLabel: 'Capabilities',
    query: view.query,
    rows: view.rows.map(tool => ({
      label: `${inlineText(tool.name)} · ${inlineText(tool.description)}`,
      badge: '',
    })),
    selectedIndex: view.selectedIndex,
    summary: `${view.rows.length}/${view.totalCount}`,
    detail,
    footerLeft: '  ↑↓ move · Ask in Chat',
    ...(view.navigation === undefined ? {} : { navigation: view.navigation }),
  }, { columns, rows })
}

export function renderMcpCapabilityFrame(
  view: McpCapabilityBrowserView,
  viewport: TerminalViewport,
): LegacyDirectoryFrame {
  const { columns, rows } = viewport
  const selected = view.selected
  const required = new Set(selected?.requiredParameterNames ?? [])
  const leftColumns = capabilityLensLeftColumns(columns)
  const detailWidth = columns < 100 ? Math.max(1, columns - 4) : Math.max(1, columns - leftColumns - 3)
  const parameters = selected?.parameterNames.map(name => (
    required.has(name) ? `${inlineText(name)}*` : inlineText(name)
  )).join(', ')
  const detail: CapabilityLensDetailLine[] = []
  if (view.error !== undefined) {
    detail.push({ text: `Error  ${inlineText(view.error)}`, tone: 'error', bold: true })
  }
  if (view.stale) {
    detail.push({ text: 'Showing last good ToolRuntime view', tone: 'warning' })
  }
  if (selected === undefined) {
    detail.push({
      text: view.error !== undefined ? 'Could not load MCP tools · Reopen /mcp to retry'
        : !view.available ? 'MCP tools are unavailable in this session'
          : view.query.text.trim() === ''
            ? 'No MCP tools available in this session · Check /settings'
            : 'No matching MCP tools · Edit or clear the search',
      tone: 'muted',
      dim: true,
    })
  } else {
    detail.push(
      { text: `Namespace  ${inlineText(selected.serverName)}`, tone: 'interaction', bold: true },
      { text: `Tool  ${inlineText(selected.toolName)}`, tone: 'telemetry', bold: true },
      ...wrap(`About  ${inlineText(selected.description)}`, detailWidth)
        .map(text => ({ text, tone: 'primary' as const })),
      { text: 'Ask in Chat to use this tool', tone: 'primary' },
    )
    if (view.navigation?.focus === 'details') detail.push(
      {
        text: `Inputs  ${selected.requiredParameterNames.length} required · ${selected.parameterNames.length} total`,
        tone: 'primary',
      },
      ...wrap(`Params  ${parameters === '' ? 'none' : parameters}`, detailWidth)
        .map(text => ({ text, tone: 'muted' as const, dim: true })),
      {
        text: `Mounted  exact Agent · generation ${view.generation}`,
        tone: 'success',
        bold: true,
      },
    )
  }
  return renderCapabilityLensFrame({
    title: 'MCP capabilities',
    sectionLabel: 'Mounted tools',
    query: view.query,
    rows: view.rows.map(tool => ({
      label: `${inlineText(tool.serverName)} / ${inlineText(tool.toolName)} · ${inlineText(tool.description)}`,
      badge: '',
    })),
    selectedIndex: view.selectedIndex,
    summary: `${view.rows.length}/${view.totalCount} tools`,
    detail,
    footerLeft: '  ↑↓ move · Ask in Chat',
    ...(view.navigation === undefined ? {} : { navigation: view.navigation }),
  }, { columns, rows })
}
