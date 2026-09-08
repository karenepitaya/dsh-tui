import type { SettingsWorkspaceRole, SettingsWorkspaceTheme } from 'pi-tui-orbs'
import { paintProjectedColor, type SemanticColorRole } from '../theme/semantic-colors.ts'
import type { DshTuiTheme } from './theme.ts'

/** Settings uses the same capability-projected palette as the main page. */
export function createSettingsWorkspaceTheme(theme: DshTuiTheme): SettingsWorkspaceTheme {
  // pi-tui containers terminate slices with SGR 0; restore this enclosing surface too.
  const foreground = (color: SemanticColorRole, text: string) => {
    const style = theme.semantic.styles[color]
    return paintProjectedColor(style, text.replaceAll('\x1b[0m', '\x1b[0m' + style.foregroundOpen))
  }
  const background = (color: SemanticColorRole, text: string) => {
    const style = theme.semantic.styles[color]
    return paintProjectedColor(style, text.replaceAll('\x1b[0m', '\x1b[0m' + style.backgroundOpen), 'background')
  }
  const roles: Record<SettingsWorkspaceRole, (text: string) => string> = {
    canvas: text => background('panelBackground', foreground('foreground', text)),
    sidebar: text => background('inputBackground', foreground('foreground', text)),
    panel: text => background('inputBackground', foreground('foreground', text)),
    control: text => background('inactiveSelectionBackground', foreground('foreground', text)),
    text: text => foreground('foreground', text),
    title: text => theme.bold(foreground('emphasis', text)),
    muted: text => foreground('muted', text),
    border: text => foreground('border', text),
    accent: text => theme.bold(foreground('accent', text)),
    success: text => theme.bold(foreground('success', text)),
    focus: text => background('selectionBackground', theme.underline(theme.bold(foreground('accent', text)))),
    selected: text => theme.colorEnabled ? background('selectionBackground', theme.bold(foreground('accent', text))) : theme.inverse(theme.bold(text)),
    button: text => background('inactiveSelectionBackground', foreground('foreground', text)),
    primary: text => theme.colorEnabled ? background('accent', theme.bold(foreground('panelBackground', text))) : theme.inverse(theme.bold(text)),
    warning: text => foreground('warning', text),
    error: text => theme.bold(foreground('error', text)),
    disabled: text => foreground('muted', text),
  }
  return { paint: (role, text) => roles[role](text) }
}
