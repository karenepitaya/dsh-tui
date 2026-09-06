import type { TerminalInputAction } from '../terminal/input.ts'
import type { PromptEditorAction } from '../ui/prompt-editor.ts'

export interface LegacyDirectoryNavigation {
  readonly focus: 'list' | 'search' | 'details'
  readonly detailOffset: number
}

export interface LegacyDirectoryState {
  readonly navigation?: LegacyDirectoryNavigation
}

export type LegacyDirectorySelectionAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'submit' }
  | { readonly type: 'escape' }
  | { readonly type: 'edit'; readonly action: PromptEditorAction }

/** Drop terminal commands with no catalog meaning before calling domain reducers. */
export function legacyDirectorySelectionAction(input: TerminalInputAction): LegacyDirectorySelectionAction | undefined {
  if (input.type === 'move-up' || input.type === 'move-down' || input.type === 'submit') return input
  if (input.type === 'escape' || input.type === 'interrupt') return { type: 'escape' }
  const edits: readonly TerminalInputAction['type'][] = ['insert', 'backspace', 'delete', 'move-left', 'move-right', 'move-home', 'move-end']
  return edits.includes(input.type) ? { type: 'edit', action: input as PromptEditorAction } : undefined
}

/** List-only legacy pages keep ordinary action shortcuts alongside vim movement. */
export function legacyListInput(input: TerminalInputAction): TerminalInputAction {
  if (input.type !== 'insert' || input.paste === true) return input
  const directions = { j: 'move-down', k: 'move-up', h: 'move-left', l: 'move-right' } as const
  return Object.hasOwn(directions, input.text) ? { type: directions[input.text as keyof typeof directions] } : input
}

/** Local keyboard navigation shared by the remaining catalog adapters. */
export function navigateLegacyDirectory(
  state: LegacyDirectoryState,
  input: TerminalInputAction,
  options: { readonly searchEnabled?: boolean; readonly maxDetailOffset?: number; readonly pageSize?: number } = {},
): { readonly navigation: LegacyDirectoryNavigation; readonly action?: TerminalInputAction } {
  const navigation = state.navigation ?? { focus: 'list', detailOffset: 0 }
  const forward = (action: TerminalInputAction) => ({ navigation, action })
  const focus = (value: LegacyDirectoryNavigation['focus']) => ({ navigation: { ...navigation, focus: value } })
  if (input.type === 'escape' || input.type === 'interrupt') return forward(input)
  if (input.type === 'complete') {
    const regions: readonly LegacyDirectoryNavigation['focus'][] = options.searchEnabled === false ? ['list', 'details'] : ['list', 'details', 'search']
    const index = regions.indexOf(navigation.focus)
    return focus(regions[(index + (input.reverse === true ? regions.length - 1 : 1)) % regions.length]!)
  }
  if (navigation.focus === 'search') {
    return input.type === 'submit' ? focus('list') : forward(input)
  }
  let action = input
  if (input.type === 'insert') {
    if (input.paste === true) return { navigation }
    if (options.searchEnabled !== false && (input.text === '/' || input.text === 'i')) return focus('search')
    const direction = { h: 'move-left', j: 'move-down', k: 'move-up', l: 'move-right' } as const
    if (!Object.hasOwn(direction, input.text)) return { navigation }
    action = { type: direction[input.text as keyof typeof direction] }
  }
  if (action.type === 'move-left') return focus('list')
  if (action.type === 'move-right') return focus('details')
  if (action.type === 'move-up' || action.type === 'move-down' || action.type === 'page-up' || action.type === 'page-down') {
    if (navigation.focus === 'details') {
      const maximum = options.maxDetailOffset ?? Number.MAX_SAFE_INTEGER
      const current = Math.min(navigation.detailOffset, maximum)
      const delta = action.type === 'page-up' || action.type === 'page-down' ? options.pageSize ?? 10 : 1
      const direction = action.type === 'move-up' || action.type === 'page-up' ? -1 : 1
      return { navigation: { ...navigation, detailOffset: Math.max(0, Math.min(maximum, current + direction * delta)) } }
    }
    return { navigation: { ...navigation, detailOffset: 0 }, action }
  }
  return action.type === 'submit' ? forward(action) : { navigation }
}
