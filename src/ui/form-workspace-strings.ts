import { FORM_WORKSPACE_STRINGS_ZH, type FormWorkspaceStrings } from 'pi-tui-orbs'

/** English is the library built-in; only Chinese needs an explicit bag. */
export function formWorkspaceStrings(language: string | undefined): FormWorkspaceStrings | undefined {
  return language === 'zh' ? FORM_WORKSPACE_STRINGS_ZH : undefined
}
