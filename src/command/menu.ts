import type {
  DshCommandDescriptor,
  DshParsedCommand,
} from './port.ts'
import type { PromptEditorState } from '../ui/prompt-editor.ts'

export const COMMAND_MENU_LIMIT = 8

export interface CommandMenuState {
  readonly selectedName?: string
  readonly dismissedDraft?: string
}

export interface CommandMenuCandidate {
  readonly origin: 'official' | 'local'
  readonly command: DshCommandDescriptor
}

export interface CommandMenuView {
  readonly query: string
  readonly candidates: readonly CommandMenuCandidate[]
  readonly selectedIndex: number
  /** First candidate rendered by the bounded command-palette viewport. */
  readonly windowStart?: number
  readonly totalCount: number
}

export type CommandDispatchDecision =
  | { readonly kind: 'submit' }
  | { readonly kind: 'complete'; readonly command: DshCommandDescriptor }
  | { readonly kind: 'execute'; readonly command: DshCommandDescriptor }

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function createCommandMenuState(): CommandMenuState {
  return {}
}

function commandQuery(prompt: PromptEditorState): string | undefined {
  if (!prompt.text.startsWith('/') || /\s/u.test(prompt.text)) return undefined
  const parts = Array.from(graphemeSegmenter.segment(prompt.text), part => part.segment)
  const cursor = Math.min(parts.length, Math.max(0, prompt.cursor))
  if (cursor === 0) return undefined
  const beforeCursor = parts.slice(0, cursor).join('')
  return beforeCursor.slice(1)
}

export function selectCommandMenu(
  state: CommandMenuState,
  prompt: PromptEditorState,
  commands: readonly CommandMenuCandidate[],
): CommandMenuView | undefined {
  const query = commandQuery(prompt)
  if (query === undefined || state.dismissedDraft === prompt.text) return undefined
  const matched = commands.filter(candidate => candidate.command.name.startsWith(query))
  const selected = state.selectedName === undefined
    ? -1
    : matched.findIndex(candidate => candidate.command.name === state.selectedName)
  const selectedIndex = matched.length === 0 ? -1 : Math.max(0, selected)
  const windowStart = selectedIndex < 0
    ? 0
    : Math.min(
        Math.max(0, matched.length - COMMAND_MENU_LIMIT),
        Math.max(0, selectedIndex - COMMAND_MENU_LIMIT + 1),
      )
  return {
    query,
    candidates: matched,
    selectedIndex,
    windowStart,
    totalCount: matched.length,
  }
}

export function moveCommandMenuSelection(
  state: CommandMenuState,
  view: CommandMenuView,
  direction: 'up' | 'down',
): CommandMenuState {
  if (view.candidates.length === 0) return state
  const delta = direction === 'up' ? -1 : 1
  const selectedIndex = Math.min(
    view.candidates.length - 1,
    Math.max(0, view.selectedIndex + delta),
  )
  const selectedName = view.candidates[selectedIndex]!.command.name
  return state.selectedName === selectedName
    ? state
    : { ...state, selectedName }
}

export function dismissCommandMenu(
  state: CommandMenuState,
  prompt: PromptEditorState,
): CommandMenuState {
  return state.dismissedDraft === prompt.text
    ? state
    : { ...state, dismissedDraft: prompt.text }
}

export function commandCompletion(command: DshCommandDescriptor): string {
  return `/${command.name}${command.input === undefined ? '' : ' '}`
}

export function decideCommandDispatch(
  parsed: DshParsedCommand | undefined,
  commands: readonly DshCommandDescriptor[],
): CommandDispatchDecision {
  if (parsed === undefined) return { kind: 'submit' }
  const command = commands.find(candidate => candidate.name === parsed.name)
  if (command === undefined) return { kind: 'submit' }
  if (command.input === undefined) {
    return parsed.rawInput === '' ? { kind: 'execute', command } : { kind: 'submit' }
  }
  return parsed.rawInput === '' ? { kind: 'complete', command } : { kind: 'execute', command }
}
