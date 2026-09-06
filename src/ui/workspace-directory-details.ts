import type { ActivityCenterView } from '../activity/center.ts'
import type { ModelPickerView } from '../model/picker.ts'
import type { ModePickerView } from '../mode/picker.ts'
import type { ProviderConnectView } from '../provider/connect-controller.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'
import { legacyDetailViewport } from './legacy-detail-rows.ts'
import { secondaryModalFill, secondaryModalRow } from './modal.ts'
import { secondaryModalFrame } from './workspace-rows.ts'

export function modeWorkspaceDetails(view: ModePickerView): readonly string[] {
  const selected = view.rows[view.selectedIndex]
  return [
    ...(view.error === undefined ? [] : [`Error: ${view.error}`]),
    ...(view.locked ? ['Mode locked after the first turn · start a new session to switch'] : []),
    ...(selected === undefined ? ['No Agent mode selected'] : [
      `Mode  ${selected.name ?? selected.id}`,
      `Identity  ${selected.id}`,
      `Trust  ${selected.trust}`,
      ...(selected.description === undefined ? [] : [`Description  ${selected.description}`]),
      ...(selected.broken === undefined ? [] : [`Broken  ${selected.broken}`]),
    ]),
  ]
}

export function modelWorkspaceDetails(view: ModelPickerView): readonly string[] {
  const selection = view.selectedModel
  const selected = selection === undefined ? undefined : view.groups.flatMap(group => group.models)
    .find(row => row.provider === selection.provider && row.id === selection.model)
  const effort = view.efforts[view.selectedEffortIndex]
  return [
    ...(view.error === undefined ? [] : [`Error: ${view.error}`]),
    ...view.failures.map(failure => `Error: ${failure.provider}: ${failure.message}`),
    ...(selected === undefined ? ['No model selected'] : [
      `Model  ${selected.name}`,
      `Route  ${selected.provider}/${selected.id}`,
      `State  ${selected.routable ? 'routable' : 'unroutable'} · ${selected.catalogued ? 'catalogued' : 'retained route'}`,
      ...(selected.description === undefined ? [] : [`Description  ${selected.description}`]),
      ...selected.efforts.map(item => `Reasoning ${item.name}  ${item.description ?? item.id}`),
    ]),
    ...(view.stage !== 'reasoning' ? [] : [effort === undefined ? 'No reasoning option selected'
      : effort.kind === 'provider-default' ? 'Provider decides reasoning effort'
      : `Selected effort  ${effort.name}: ${effort.description ?? effort.id}`]),
  ]
}

export function connectionWorkspaceDetails(view: ProviderConnectView): readonly string[] {
  const selected = view.providers[view.selectedProviderIndex]
  return [
    ...(view.error === undefined ? [] : [`Error: ${view.error}`]),
    ...(view.notice === undefined ? [] : [`Notice: ${view.notice}`]),
    ...(selected === undefined ? ['No Provider selected'] : [
      `Provider  ${selected.name}`,
      `Identity  ${selected.id}`,
      `Connection  ${selected.connected ? 'connected' : 'not connected'}`,
      `Credential  ${selected.credential.kind} · ${selected.credential.configured ? 'configured' : 'not configured'}`,
      ...(selected.credential.source === undefined ? [] : [`Credential source  ${selected.credential.source}`]),
      ...selected.methods.map(method => `Method ${method.id}  ${method.label}`),
    ]),
  ]
}

export function activityWorkspaceDetails(view: ActivityCenterView): readonly string[] {
  const selected = view.rows[view.selectedIndex]
  return [
    ...(view.error === undefined ? [] : [`Error: ${view.error}`]),
    ...(view.notice === undefined ? [] : [`Notice: ${view.notice}`]),
    ...(selected === undefined ? ['No activity selected'] : [selected.title, selected.meta, `Status  ${selected.status}`, ...selected.detail]),
  ]
}

export function workspaceDirectoryDetailViewport(lines: readonly string[], viewport: TerminalViewport, offset = 0) {
  return legacyDetailViewport(lines.map(text => ({ text })), Math.max(1, viewport.columns - 4), Math.max(0, viewport.rows - 2), offset)
}

export function workspaceDirectoryDetailFrame(viewport: TerminalViewport, lines: readonly string[], offset: number, actionHints?: string): UiFrame {
  const details = workspaceDirectoryDetailViewport(lines, viewport, offset)
  const rows = [secondaryModalRow(secondaryModalFill('Details', viewport.columns), 'accent')]
  if (viewport.rows === 1) return secondaryModalFrame(viewport, rows)
  for (let index = 0; index < viewport.rows - 2; index += 1) {
    const text = details.rows[index]?.text ?? ''
    rows.push(secondaryModalRow(secondaryModalFill(`  ${text}`, viewport.columns), text.startsWith('Error:') || text.startsWith('Broken') ? 'error' : 'primary'))
  }
  rows.push(secondaryModalRow(secondaryModalFill(`Esc back${actionHints === undefined ? '' : ` · ${actionHints}`} · Tab h/l focus · j/k PgUp/Down scroll · ${details.offset + 1}/${details.maxOffset + 1}`, viewport.columns), 'muted'))
  return secondaryModalFrame(viewport, rows)
}
