import type { DshTuiView } from './frame.ts'
import type { LegacyWorkspaceDescriptor } from './legacy-workspace.ts'
import { activityWorkspaceDetails, connectionWorkspaceDetails, modelWorkspaceDetails, modeWorkspaceDetails } from './workspace-directory-details.ts'

/** Match renderDshFrame priority. Authentication and confirmations stay short. */
export function legacyWorkspaceDescriptor(view: DshTuiView): LegacyWorkspaceDescriptor | undefined {
  if (view.providerConnect !== undefined) {
    return view.providerConnect.stage === 'providers' ? { title: 'Connections', focus: view.providerConnect.navigation?.focus === 'details' ? 'details' : 'list',
      detailLines: connectionWorkspaceDetails(view.providerConnect), detailOffset: view.providerConnect.navigation?.detailOffset ?? 0, detailActionHints: 'Enter connect' } : undefined
  }
  if (view.sessionFork !== undefined) return undefined
  if (view.sessionInspection !== undefined) {
    return view.sessionInspection.kind === 'confirm-resume' ? undefined : { title: 'Session inspection', focus: 'details' }
  }
  if (view.sessionPicker !== undefined) return { title: 'Sessions', focus: view.sessionPicker.view.navigation?.focus === 'details' ? 'details' : 'list' }
  if (view.permissionPicker !== undefined) return view.permissionPicker.confirmation === undefined
    ? { title: 'Permission Presets', focus: view.permissionPicker.navigation?.focus === 'details' ? 'details' : 'list' } : undefined
  if (view.modePicker !== undefined) return { title: 'Mode', focus: view.modeNavigation?.focus === 'details' ? 'details' : 'list',
    detailLines: modeWorkspaceDetails(view.modePicker), detailOffset: view.modeNavigation?.detailOffset ?? 0, detailActionHints: view.modePicker.locked ? 'Mode locked' : 'Enter apply' }
  if (view.skillPicker !== undefined) return { title: 'Skills', focus: view.skillPicker.navigation?.focus === 'details' ? 'details' : 'list' }
  if (view.toolBrowser !== undefined) return { title: 'Tools', focus: view.toolBrowser.navigation?.focus === 'details' ? 'details' : 'list' }
  if (view.mcpBrowser !== undefined) return { title: 'MCP', focus: view.mcpBrowser.navigation?.focus === 'details' ? 'details' : 'list' }
  if (view.runtimeLibrary !== undefined) return {
    title: view.runtimeLibrary.tab === 'settings' ? 'Settings' : 'Plugins',
    focus: view.runtimeLibrary.focus === 'catalog' ? 'list' : view.runtimeLibrary.focus === 'detail' ? 'details' : 'editor',
  }
  if (view.modelPicker !== undefined) return { title: view.modelPicker.stage === 'reasoning' ? 'Models · Reasoning effort' : 'Models', focus: view.modelNavigation?.focus === 'details' ? 'details' : 'list',
    detailLines: modelWorkspaceDetails(view.modelPicker), detailOffset: view.modelNavigation?.detailOffset ?? 0,
    detailActionHints: !view.modelPicker.writable ? 'Read-only' : view.modelPicker.stage === 'reasoning' ? 'Enter switch' : 'Enter reasoning/select' }
  if (view.activityCenter !== undefined) return view.activityCenter.confirmStop ? undefined : { title: 'Activity', focus: view.activityNavigation?.focus === 'details' ? 'details' : 'list',
    detailLines: activityWorkspaceDetails(view.activityCenter), detailOffset: view.activityNavigation?.detailOffset ?? 0, detailActionHints: 'K/Delete stop' }
  if (view.jobsActivity !== undefined) return view.jobsActivity.confirmKill ? undefined : { title: 'Jobs', focus: 'list' }
  if (view.contextPanel === true) return { title: 'Context', focus: 'details' }
  if (view.attemptPanel !== undefined) return { title: 'Request recovery', focus: view.attemptNavigation?.focus === 'details' ? 'details' : 'list' }
  if (view.routePanel !== undefined) return { title: 'Model route', focus: view.routeNavigation?.focus === 'details' ? 'details' : 'list' }
  return undefined
}
