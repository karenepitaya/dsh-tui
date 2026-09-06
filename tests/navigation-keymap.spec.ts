import { describe, expect, it } from 'vitest'
import {
  mapTerminalKey,
  routeUiCommand,
  type TerminalKey,
  type UiCommand,
} from '../src/navigation/commands.ts'
import { createNavigationState, transitionNavigation } from '../src/navigation/state.ts'

describe('navigation keymap and semantic command routing', () => {
  it('keeps text editing intact in Insert mode, including hjkl', () => {
    const navigation = createNavigationState()
    expect(mapTerminalKey({ type: 'text', text: 'j' }, { navigation }))
      .toEqual({ type: 'edit.insert', text: 'j' })
    expect(mapTerminalKey({ type: 'paste', text: 'hello\n世界' }, { navigation }))
      .toEqual({ type: 'edit.insert', text: 'hello\n世界' })
    expect(mapTerminalKey({ type: 'named', key: 'left' }, { navigation }))
      .toEqual({ type: 'edit.move', direction: 'left' })
    expect(mapTerminalKey({ type: 'named', key: 'right' }, { navigation }))
      .toEqual({ type: 'edit.move', direction: 'right' })
    expect(mapTerminalKey({ type: 'named', key: 'up' }, { navigation }))
      .toEqual({ type: 'edit.move', direction: 'up' })
    expect(mapTerminalKey({ type: 'named', key: 'down' }, { navigation }))
      .toEqual({ type: 'edit.move', direction: 'down' })
    expect(mapTerminalKey({ type: 'named', key: 'enter' }, { navigation }))
      .toEqual({ type: 'action.submit' })
    expect(mapTerminalKey({ type: 'named', key: 'enter', shift: true }, { navigation }))
      .toEqual({ type: 'edit.newline' })
    expect(mapTerminalKey({ type: 'named', key: 'backspace' }, { navigation }))
      .toEqual({ type: 'edit.delete-backward' })
    expect(mapTerminalKey({ type: 'named', key: 'delete' }, { navigation }))
      .toEqual({ type: 'edit.delete-forward' })
    expect(mapTerminalKey({ type: 'named', key: 'tab' }, { navigation }))
      .toEqual({ type: 'edit.complete' })
    expect(mapTerminalKey({ type: 'named', key: 'home' }, { navigation }))
      .toEqual({ type: 'edit.move-boundary', boundary: 'start' })
    expect(mapTerminalKey({ type: 'named', key: 'end' }, { navigation }))
      .toEqual({ type: 'edit.move-boundary', boundary: 'end' })
    expect(mapTerminalKey({ type: 'named', key: 'escape' }, { navigation }))
      .toEqual({ type: 'mode.set', mode: 'normal' })
  })

  it('maps hjkl only in Normal mode and supports secondary-surface navigation', () => {
    const diff = transitionNavigation(createNavigationState(), {
      type: 'navigate',
      route: { kind: 'diff', featureId: 'diff', pane: 'content' },
    }).state
    const workspace = transitionNavigation(createNavigationState(), {
      type: 'navigate',
      route: { kind: 'workspace', featureId: 'sessions', pane: 'navigator' },
    }).state

    for (const [text, direction] of [
      ['h', 'left'],
      ['j', 'down'],
      ['k', 'up'],
      ['l', 'right'],
    ] as const) {
      expect(mapTerminalKey({ type: 'text', text }, { navigation: diff }))
        .toEqual({ type: 'navigation.move', direction })
      expect(mapTerminalKey({ type: 'text', text }, { navigation: workspace }))
        .toEqual(direction === 'left' || direction === 'right'
          ? { type: 'navigation.focus', direction: direction === 'left' ? 'previous' : 'next' }
          : { type: 'navigation.move', direction })
    }
    expect(mapTerminalKey({ type: 'named', key: 'up' }, { navigation: diff }))
      .toEqual({ type: 'navigation.move', direction: 'up' })
    expect(mapTerminalKey({ type: 'named', key: 'enter' }, { navigation: diff }))
      .toEqual({ type: 'navigation.activate' })
    expect(mapTerminalKey({ type: 'named', key: 'escape' }, { navigation: diff }))
      .toEqual({ type: 'navigation.back' })
    const searching = transitionNavigation(workspace, { type: 'set-mode', mode: 'insert' }).state
    expect(mapTerminalKey({ type: 'named', key: 'escape' }, { navigation: searching }))
      .toEqual({ type: 'navigation.back' })
    expect(mapTerminalKey({ type: 'text', text: 'i' }, { navigation: diff }))
      .toEqual({ type: 'mode.set', mode: 'insert' })
    expect(mapTerminalKey({ type: 'text', text: 'x' }, { navigation: diff }))
      .toBeUndefined()
    expect(mapTerminalKey({ type: 'paste', text: 'j' }, { navigation: diff }))
      .toBeUndefined()

    expect(mapTerminalKey({ type: 'named', key: 'left' }, { navigation: diff }))
      .toEqual({ type: 'navigation.move', direction: 'left' })
    expect(mapTerminalKey({ type: 'named', key: 'right' }, { navigation: diff }))
      .toEqual({ type: 'navigation.move', direction: 'right' })
    expect(mapTerminalKey({ type: 'named', key: 'down' }, { navigation: diff }))
      .toEqual({ type: 'navigation.move', direction: 'down' })
    expect(mapTerminalKey({ type: 'named', key: 'page-up' }, { navigation: diff }))
      .toEqual({ type: 'navigation.page', direction: 'up' })
    expect(mapTerminalKey({ type: 'named', key: 'page-down' }, { navigation: diff }))
      .toEqual({ type: 'navigation.page', direction: 'down' })
    expect(mapTerminalKey({ type: 'named', key: 'tab' }, { navigation: diff }))
      .toEqual({ type: 'navigation.focus', direction: 'next' })
    for (const key of ['backspace', 'delete', 'home', 'end'] as const) {
      expect(mapTerminalKey({ type: 'named', key }, { navigation: diff })).toBeUndefined()
    }
  })

  it('gives global control keys precedence and ignores unsupported modifiers', () => {
    const navigation = createNavigationState()
    expect(mapTerminalKey({ type: 'text', text: 'o', ctrl: true }, { navigation }))
      .toEqual({ type: 'transcript.toggle-details' })
    expect(mapTerminalKey({ type: 'text', text: 'c', ctrl: true }, { navigation }))
      .toEqual({ type: 'app.interrupt' })
    expect(mapTerminalKey({ type: 'text', text: 'x', ctrl: true }, { navigation }))
      .toBeUndefined()
    expect(mapTerminalKey({ type: 'text', text: 'x', alt: true }, { navigation }))
      .toBeUndefined()
    expect(mapTerminalKey({ type: 'named', key: 'enter', ctrl: true }, { navigation }))
      .toBeUndefined()
    expect(mapTerminalKey({ type: 'named', key: 'enter', alt: true }, { navigation }))
      .toBeUndefined()
    expect(mapTerminalKey({ type: 'named', key: 'page-up' }, { navigation }))
      .toEqual({ type: 'navigation.page', direction: 'up' })
    expect(mapTerminalKey({ type: 'named', key: 'page-down' }, { navigation }))
      .toEqual({ type: 'navigation.page', direction: 'down' })
    expect(mapTerminalKey({ type: 'named', key: 'tab', shift: true }, { navigation }))
      .toEqual({ type: 'edit.complete', reverse: true })
  })

  it('routes commands to shell, composer, the active feature, or top overlay', () => {
    const chat = createNavigationState()
    expect(routeUiCommand(chat, { type: 'app.interrupt' })).toEqual({
      target: { kind: 'shell' },
      command: { type: 'app.interrupt' },
    })
    expect(routeUiCommand(chat, { type: 'transcript.toggle-details' })).toEqual({
      target: { kind: 'shell' },
      command: { type: 'transcript.toggle-details' },
    })
    expect(routeUiCommand(chat, { type: 'mode.set', mode: 'normal' })).toEqual({
      target: { kind: 'shell' },
      command: { type: 'mode.set', mode: 'normal' },
    })
    expect(routeUiCommand(chat, { type: 'edit.insert', text: 'a' })).toEqual({
      target: { kind: 'composer' },
      command: { type: 'edit.insert', text: 'a' },
    })

    const diff = transitionNavigation(chat, {
      type: 'navigate',
      route: { kind: 'diff', featureId: 'diff', pane: 'content' },
    }).state
    expect(routeUiCommand(diff, {
      type: 'navigation.move',
      direction: 'down',
    })).toEqual({
      target: { kind: 'feature', featureId: 'diff' },
      command: { type: 'navigation.move', direction: 'down' },
    })
    expect(routeUiCommand(diff, { type: 'edit.insert', text: '/' })).toEqual({
      target: { kind: 'feature', featureId: 'diff' },
      command: { type: 'edit.insert', text: '/' },
    })
    const diffInsert = transitionNavigation(diff, {
      type: 'set-mode',
      mode: 'insert',
    }).state
    expect(routeUiCommand(diffInsert, { type: 'edit.insert', text: '/' })).toEqual({
      target: { kind: 'feature', featureId: 'diff' },
      command: { type: 'edit.insert', text: '/' },
    })

    const overlaid = transitionNavigation(diff, {
      type: 'push-overlay',
      overlay: { id: 'plan', kind: 'plan-review', featureId: 'chat' },
    }).state
    expect(routeUiCommand(overlaid, { type: 'navigation.activate' })).toEqual({
      target: { kind: 'overlay', overlayId: 'plan', featureId: 'chat' },
      command: { type: 'navigation.activate' },
    })
  })

  it('freezes mapped and routed command values', () => {
    const navigation = createNavigationState()
    const key: TerminalKey = { type: 'text', text: 'hello' }
    const command = mapTerminalKey(key, { navigation })!
    const routed = routeUiCommand(navigation, command)!
    expect(Object.isFrozen(command)).toBe(true)
    expect(Object.isFrozen(routed)).toBe(true)
    expect(Object.isFrozen(routed.target)).toBe(true)

    const allCommands: readonly UiCommand[] = [
      { type: 'edit.newline' },
      { type: 'edit.delete-backward' },
      { type: 'edit.delete-forward' },
      { type: 'edit.complete' },
      { type: 'edit.move', direction: 'left' },
      { type: 'edit.move-boundary', boundary: 'start' },
      { type: 'action.submit' },
      { type: 'navigation.move', direction: 'right' },
      { type: 'navigation.page', direction: 'down' },
      { type: 'navigation.activate' },
      { type: 'navigation.back' },
    ]
    expect(allCommands.map(item => routeUiCommand(navigation, item)?.target.kind))
      .toEqual([
        'composer',
        'composer',
        'composer',
        'composer',
        'composer',
        'composer',
        'composer',
        'feature',
        'feature',
        'feature',
        'feature',
      ])
  })
})
