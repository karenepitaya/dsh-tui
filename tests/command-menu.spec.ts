import { describe, expect, it } from 'vitest'
import type { DshCommandDescriptor } from '../src/command/port.ts'
import {
  COMMAND_MENU_LIMIT,
  commandCompletion,
  createCommandMenuState,
  decideCommandDispatch,
  dismissCommandMenu,
  moveCommandMenuSelection,
  selectCommandMenu,
  type CommandMenuCandidate,
} from '../src/command/menu.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'

const commands: readonly DshCommandDescriptor[] = [
  { name: 'compact', description: 'Compact the session' },
  { name: 'feedback', description: 'Send feedback', input: { hint: '<feedback>' } },
  { name: 'goal', description: 'Set a goal', input: { hint: '<goal>' } },
]

const candidates: readonly CommandMenuCandidate[] = commands.map(command => ({
  origin: 'official',
  command,
}))

describe('command menu state', () => {
  it('opens only for an absolute leading token at the cursor and preserves catalog order', () => {
    const state = createCommandMenuState()
    expect(selectCommandMenu(state, createPromptEditorState('/'), candidates)).toMatchObject({
      query: '',
      candidates,
      selectedIndex: 0,
      totalCount: 3,
    })
    expect(selectCommandMenu(state, createPromptEditorState('/go'), candidates)).toMatchObject({
      query: 'go',
      candidates: [candidates[2]],
      selectedIndex: 0,
      totalCount: 1,
    })
    expect(selectCommandMenu(state, createPromptEditorState('/zz'), candidates)).toMatchObject({
      query: 'zz',
      candidates: [],
      selectedIndex: -1,
      totalCount: 0,
    })

    expect(selectCommandMenu(state, createPromptEditorState('goal'), candidates)).toBeUndefined()
    expect(selectCommandMenu(state, createPromptEditorState('/goal x'), candidates)).toBeUndefined()
    expect(selectCommandMenu(state, createPromptEditorState('/goal\nx'), candidates)).toBeUndefined()
    expect(selectCommandMenu(state, { text: '/goal', cursor: 0 }, candidates)).toBeUndefined()
    expect(selectCommandMenu(state, { text: '/goal', cursor: 2 }, candidates)?.query).toBe('g')
    expect(selectCommandMenu(state, createPromptEditorState('/你'), candidates)?.candidates).toEqual([])
  })

  it('keeps every matched command reachable while exposing a bounded visible window', () => {
    const many: readonly CommandMenuCandidate[] = Array.from(
      { length: COMMAND_MENU_LIMIT + 2 },
      (_, index) => ({
        origin: index === 1 ? 'local' : 'official',
        command: { name: `c${index}`, description: `command ${index}` },
      }),
    )
    const initial = selectCommandMenu(
      createCommandMenuState(),
      createPromptEditorState('/'),
      many,
    )!
    expect(initial.candidates).toHaveLength(COMMAND_MENU_LIMIT + 2)
    expect(initial.totalCount).toBe(COMMAND_MENU_LIMIT + 2)
    expect(initial.windowStart).toBe(0)
    expect(initial.candidates[1]).toEqual({
      origin: 'local',
      command: { name: 'c1', description: 'command 1' },
    })

    let scrollingState = createCommandMenuState()
    let scrollingView = initial
    for (let index = 0; index < COMMAND_MENU_LIMIT + 1; index += 1) {
      scrollingState = moveCommandMenuSelection(scrollingState, scrollingView, 'down')
      scrollingView = selectCommandMenu(
        scrollingState,
        createPromptEditorState('/'),
        many,
      )!
    }
    expect(scrollingView.candidates[scrollingView.selectedIndex]?.command.name).toBe('c9')
    expect(scrollingView.windowStart).toBe(2)

    let state = createCommandMenuState()
    let view = selectCommandMenu(state, createPromptEditorState('/'), candidates)!
    state = moveCommandMenuSelection(state, view, 'down')
    view = selectCommandMenu(state, createPromptEditorState('/f'), candidates)!
    expect(view.candidates[view.selectedIndex]?.command.name).toBe('feedback')

    state = moveCommandMenuSelection(state, view, 'down')
    expect(state.selectedName).toBe('feedback')
    state = moveCommandMenuSelection(state, view, 'up')
    expect(state.selectedName).toBe('feedback')

    const replaced = selectCommandMenu(state, createPromptEditorState('/'), [candidates[2]!])!
    expect(replaced.selectedIndex).toBe(0)
    expect(replaced.candidates[0]?.command.name).toBe('goal')

    const empty = selectCommandMenu(state, createPromptEditorState('/z'), candidates)!
    expect(moveCommandMenuSelection(state, empty, 'down')).toBe(state)
  })

  it('dismisses only the exact draft and reopens after the user edits it', () => {
    const prompt = createPromptEditorState('/g')
    const dismissed = dismissCommandMenu(createCommandMenuState(), prompt)
    expect(selectCommandMenu(dismissed, prompt, candidates)).toBeUndefined()
    expect(selectCommandMenu(dismissed, createPromptEditorState('/go'), candidates)).toBeDefined()
    expect(dismissCommandMenu(dismissed, prompt)).toBe(dismissed)
  })
})

describe('command dispatch decision', () => {
  it('distinguishes exact commands, input claims, and ordinary prompt fallthrough', () => {
    expect(decideCommandDispatch(undefined, commands)).toEqual({ kind: 'submit' })
    expect(decideCommandDispatch({ name: 'missing', rawInput: '' }, commands)).toEqual({ kind: 'submit' })
    expect(decideCommandDispatch({ name: 'compact', rawInput: '' }, commands)).toEqual({
      kind: 'execute',
      command: commands[0],
    })
    expect(decideCommandDispatch({ name: 'compact', rawInput: ' now' }, commands)).toEqual({ kind: 'submit' })
    expect(decideCommandDispatch({ name: 'goal', rawInput: '' }, commands)).toEqual({
      kind: 'complete',
      command: commands[2],
    })
    expect(decideCommandDispatch({ name: 'goal', rawInput: ' build it' }, commands)).toEqual({
      kind: 'execute',
      command: commands[2],
    })
    expect(commandCompletion(commands[2]!)).toBe('/goal ')
    expect(commandCompletion(commands[0]!)).toBe('/compact')
  })
})
