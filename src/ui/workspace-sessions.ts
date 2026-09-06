import type { SessionPickerPanel, TerminalViewport } from './frame.ts'
import { createPromptEditorState } from './prompt-editor.ts'
import { renderCapabilityLensFrame, type CapabilityLensDetailLine, type LegacyDirectoryFrame } from './workspace-capability.ts'
import { secondaryModalFill, secondaryModalPair, secondaryModalRow } from './modal.ts'
import { secondaryModalFrame } from './workspace-rows.ts'

export function renderSessionDirectoryFrame(panel: SessionPickerPanel, viewport: TerminalViewport): LegacyDirectoryFrame {
  const selected = panel.view.rows[panel.view.selectedIndex]
  const detail: CapabilityLensDetailLine[] = []
  if (panel.error !== undefined) detail.push({ text: `Error: ${panel.error}`, tone: 'error', bold: true })
  if (panel.notice !== undefined) detail.push({ text: `Notice: ${panel.notice}`, tone: 'warning' })
  if (panel.loading) detail.push({ text: 'Loading sessions…', tone: 'warning' })
  if (!panel.loaded && !panel.loading) detail.push({ text: 'Session catalog not loaded', tone: 'warning' })
  if (panel.view.durability === 'unavailable') detail.push({ text: 'Live sessions only · durable storage unavailable', tone: 'warning' })
  if (selected === undefined) {
    detail.push({ text: panel.view.query?.text.trim() ? 'No matching sessions' : 'No sessions found', tone: 'muted' })
  } else {
    const action = selected.relation === 'current' ? 'Already open'
      : selected.relation === 'other-live' && panel.liveActivation === true ? 'Switch to live session'
      : panel.inspection === true && selected.durablePresence === 'observed' ? 'Inspect durable history' : 'Explain availability'
    detail.push(
      { text: `Selected session · ${action}`, tone: 'interaction', bold: true },
      { text: `Identity  ${selected.sessionId}`, tone: 'primary' },
      { text: `State  ${selected.relation} · ${selected.liveStatus ?? (selected.attached ? 'attached' : 'offline')}`, tone: 'primary' },
      { text: `Storage  ${selected.durablePresence}`, tone: 'muted' },
      { text: `Owner  ${selected.isSubagent ? `Child of ${selected.parentSessionId ?? 'unknown'}` : 'Root session'}`, tone: 'primary' },
      { text: `Preset  ${selected.creationAgentPreset ?? 'Not recorded'}`, tone: 'primary' },
      { text: `Workspace  ${selected.cwd ?? 'Not recorded'}`, tone: 'primary' },
      { text: `Created  ${selected.createdAt}`, tone: 'muted' },
    )
  }
  const action = panel.liveActivation === true
    ? panel.inspection === true ? 'Enter switch/inspect' : 'Enter switch/explain'
    : panel.inspection === true ? 'Enter inspect/explain' : 'Enter open'
  const frame = renderCapabilityLensFrame({
    title: 'Sessions', sectionLabel: 'Session list', query: panel.view.query ?? createPromptEditorState(),
    rows: panel.view.rows.map(row => ({ label: row.sessionId, badge: row.relation === 'current' ? 'current' : row.relation === 'cold' ? 'cold' : row.liveStatus ?? 'live' })),
    selectedIndex: panel.view.selectedIndex, detail,
    summary: `${panel.view.filteredCount ?? panel.view.totalCount}/${panel.view.totalCount} · ${panel.view.durability === 'available' ? 'Durable' : 'Live only'}`,
    footerLeft: `${action}${panel.forkAvailable === true ? ' · F fork' : ''} · R refresh`,
    ...(panel.view.navigation === undefined ? {} : { navigation: panel.view.navigation }),
  }, viewport)
  if (viewport.rows >= 3 && viewport.rows <= 4 && panel.view.navigation?.focus !== 'search') {
    const body = selected === undefined ? detail : [
      ...detail.filter(line => line.tone === 'error' || (line.tone === 'warning' && !line.text.startsWith('Notice:'))),
      { text: secondaryModalPair(`› ${selected.sessionId}${panel.notice === undefined ? '' : ` · Notice: ${panel.notice}`}`, selected.relation, viewport.columns), tone: 'accent' as const, bold: true },
    ]
    return secondaryModalFrame(viewport, [
      secondaryModalRow(frame.lines[0]!, 'accent', { bold: true }),
      ...Array.from({ length: viewport.rows - 2 }, (_, index) => {
        const line = body[index]
        return secondaryModalRow(secondaryModalFill(line?.text ?? '', viewport.columns), line?.tone ?? 'muted', { bold: line?.bold === true, selected: line?.text.startsWith('›') === true })
      }),
      secondaryModalRow(frame.lines.at(-1)!, 'muted'),
    ])
  }
  return frame
}
