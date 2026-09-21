import type { DshTuiView } from './frame.ts'
import type { LegacyWorkspaceDescriptor } from './legacy-workspace.ts'

/** Match renderDshFrame priority. Confirmations stay short. */
export function legacyWorkspaceDescriptor(view: DshTuiView): LegacyWorkspaceDescriptor | undefined {
  if (view.permissionPicker !== undefined) return view.permissionPicker.confirmation === undefined
    ? { title: 'Permission Presets', focus: view.permissionPicker.navigation?.focus === 'details' ? 'details' : 'list' } : undefined
  if (view.runtimeLibrary !== undefined) return {
    title: view.runtimeLibrary.tab === 'settings' ? 'Settings' : 'Plugins',
    focus: view.runtimeLibrary.focus === 'catalog' ? 'list' : view.runtimeLibrary.focus === 'detail' ? 'details' : 'editor',
  }
  if (view.statusPanel === true) return { title: 'Status', focus: 'details' }
  return undefined
}
