import { describe, expect, it } from 'vitest'
import {
  createNavigationState,
  routeFeatureId,
  transitionNavigation,
  type NavigationState,
} from '../src/navigation/state.ts'

describe('navigation state machine', () => {
  it('starts in chat insert mode and navigates secondary routes in normal mode', () => {
    const initial = createNavigationState()
    expect(initial).toEqual({
      value: 'chat',
      route: { kind: 'chat' },
      mode: 'insert',
      focus: { kind: 'composer' },
      overlays: [],
    })

    const diff = transitionNavigation(initial, {
      type: 'navigate',
      route: { kind: 'diff', featureId: 'diff', pane: 'content' },
    })
    expect(diff.state).toMatchObject({
      value: 'diff',
      mode: 'normal',
      focus: { kind: 'feature', featureId: 'diff' },
    })
    expect(diff.effects).toEqual([
      {
        type: 'route-changed',
        previous: { kind: 'chat' },
        next: { kind: 'diff', featureId: 'diff', pane: 'content' },
      },
      { type: 'focus-requested', target: { kind: 'feature', featureId: 'diff' } },
    ])

    const workspace = transitionNavigation(diff.state, {
      type: 'navigate',
      route: { kind: 'workspace', featureId: 'sessions', pane: 'navigator' },
    })
    expect(workspace.state).toMatchObject({
      value: 'workspace',
      route: { featureId: 'sessions', pane: 'navigator' },
      mode: 'normal',
    })

    const chat = transitionNavigation(workspace.state, {
      type: 'navigate',
      route: { kind: 'chat' },
    })
    expect(chat.state).toMatchObject({
      value: 'chat',
      mode: 'insert',
      focus: { kind: 'composer' },
    })
  })

  it('manages overlays as a LIFO stack and blocks route changes while one is active', () => {
    const initial = createNavigationState()
    const permission = {
      id: 'permission-1',
      kind: 'permission' as const,
      featureId: 'chat',
    }
    const question = {
      id: 'question-1',
      kind: 'question' as const,
      featureId: 'chat',
    }
    const first = transitionNavigation(initial, { type: 'push-overlay', overlay: permission })
    expect(first.state).toMatchObject({
      focus: { kind: 'overlay', overlayId: 'permission-1', featureId: 'chat' },
      overlays: [permission],
    })
    expect(first.effects).toEqual([
      { type: 'overlay-opened', overlay: permission },
      {
        type: 'focus-requested',
        target: { kind: 'overlay', overlayId: 'permission-1', featureId: 'chat' },
      },
    ])

    const second = transitionNavigation(first.state, {
      type: 'push-overlay',
      overlay: question,
    })
    expect(second.state.overlays).toEqual([permission, question])

    const blocked = transitionNavigation(second.state, {
      type: 'navigate',
      route: { kind: 'workspace', featureId: 'sessions', pane: 'navigator' },
    })
    expect(blocked.state).toBe(second.state)
    expect(blocked.effects).toEqual([])

    const popped = transitionNavigation(second.state, { type: 'pop-overlay' })
    expect(popped.state.overlays).toEqual([permission])
    expect(popped.state.focus).toEqual({
      kind: 'overlay',
      overlayId: 'permission-1',
      featureId: 'chat',
    })
    expect(popped.effects).toEqual([
      { type: 'overlay-closed', overlay: question, reason: 'dismissed' },
      {
        type: 'focus-requested',
        target: { kind: 'overlay', overlayId: 'permission-1', featureId: 'chat' },
      },
    ])

    const closed = transitionNavigation(popped.state, { type: 'pop-overlay' })
    expect(closed.state.focus).toEqual({ kind: 'composer' })
    expect(transitionNavigation(closed.state, { type: 'pop-overlay' })).toEqual({
      state: closed.state,
      effects: [],
    })
    expect(() => transitionNavigation(first.state, {
      type: 'push-overlay',
      overlay: permission,
    })).toThrow('Duplicate overlay id: permission-1')
  })

  it('changes mode and panes only where the event is valid', () => {
    const chat = createNavigationState()
    const normal = transitionNavigation(chat, { type: 'set-mode', mode: 'normal' })
    expect(normal.state).toMatchObject({ value: 'chat', mode: 'normal' })
    expect(normal.effects).toEqual([
      { type: 'focus-requested', target: { kind: 'feature', featureId: 'chat' } },
    ])
    expect(transitionNavigation(normal.state, { type: 'set-mode', mode: 'normal' }))
      .toEqual({ state: normal.state, effects: [] })
    expect(transitionNavigation(normal.state, { type: 'select-pane', pane: 'inspector' }))
      .toEqual({ state: normal.state, effects: [] })

    const workspace = transitionNavigation(chat, {
      type: 'navigate',
      route: { kind: 'workspace', featureId: 'sessions', pane: 'navigator' },
    }).state
    const workspaceInsert = transitionNavigation(workspace, {
      type: 'set-mode',
      mode: 'insert',
    })
    expect(workspaceInsert.state.focus).toEqual({ kind: 'feature', featureId: 'sessions' })
    const content = transitionNavigation(workspace, {
      type: 'select-pane',
      pane: 'content',
    })
    expect(content.state.route).toEqual({
      kind: 'workspace',
      featureId: 'sessions',
      pane: 'content',
    })
    expect(content.effects).toEqual([
      { type: 'pane-changed', pane: 'content' },
      { type: 'focus-requested', target: { kind: 'feature', featureId: 'sessions' } },
    ])
    expect(transitionNavigation(content.state, {
      type: 'select-pane',
      pane: 'content',
    })).toEqual({ state: content.state, effects: [] })

    const diff = transitionNavigation(chat, {
      type: 'navigate',
      route: { kind: 'diff', featureId: 'diff', pane: 'content' },
    }).state
    expect(transitionNavigation(diff, {
      type: 'select-pane',
      pane: 'navigator',
    })).toEqual({ state: diff, effects: [] })
    expect(transitionNavigation(diff, {
      type: 'select-pane',
      pane: 'inspector',
    }).state.route).toEqual({ kind: 'diff', featureId: 'diff', pane: 'inspector' })

    const covered = transitionNavigation(diff, {
      type: 'push-overlay',
      overlay: { id: 'covered', kind: 'custom', featureId: 'chat' },
    }).state
    expect(transitionNavigation(covered, {
      type: 'select-pane',
      pane: 'inspector',
    })).toEqual({ state: covered, effects: [] })
  })

  it('recognizes equal and changed route identities for every route kind', () => {
    const chat = createNavigationState()
    expect(transitionNavigation(chat, { type: 'navigate', route: { kind: 'chat' } }))
      .toEqual({ state: chat, effects: [] })

    const diff = transitionNavigation(chat, {
      type: 'navigate',
      route: { kind: 'diff', featureId: 'diff', pane: 'content' },
    }).state
    expect(transitionNavigation(diff, {
      type: 'navigate',
      route: { kind: 'diff', featureId: 'diff', pane: 'content' },
    })).toEqual({ state: diff, effects: [] })
    expect(transitionNavigation(diff, {
      type: 'navigate',
      route: { kind: 'diff', featureId: 'other-diff', pane: 'content' },
    }).state.route).toMatchObject({ featureId: 'other-diff' })
    expect(transitionNavigation(diff, {
      type: 'navigate',
      route: { kind: 'diff', featureId: 'diff', pane: 'inspector' },
    }).state.route).toMatchObject({ pane: 'inspector' })

    const workspace = transitionNavigation(chat, {
      type: 'navigate',
      route: { kind: 'workspace', featureId: 'sessions', pane: 'navigator' },
    }).state
    expect(transitionNavigation(workspace, {
      type: 'navigate',
      route: { kind: 'workspace', featureId: 'sessions', pane: 'navigator' },
    })).toEqual({ state: workspace, effects: [] })
    expect(transitionNavigation(workspace, {
      type: 'navigate',
      route: { kind: 'workspace', featureId: 'tools', pane: 'navigator' },
    }).state.route).toMatchObject({ featureId: 'tools' })
    expect(transitionNavigation(workspace, {
      type: 'navigate',
      route: { kind: 'workspace', featureId: 'sessions', pane: 'content' },
    }).state.route).toMatchObject({ pane: 'content' })
  })

  it('disposes owned overlays and returns an unloaded active feature to chat', () => {
    const workspace = transitionNavigation(createNavigationState(), {
      type: 'navigate',
      route: { kind: 'workspace', featureId: 'sessions', pane: 'navigator' },
    }).state
    const withSessionsOverlay = transitionNavigation(workspace, {
      type: 'push-overlay',
      overlay: { id: 'session-help', kind: 'custom', featureId: 'sessions' },
    }).state
    const withChatOverlay = transitionNavigation(withSessionsOverlay, {
      type: 'push-overlay',
      overlay: { id: 'global-question', kind: 'question', featureId: 'chat' },
    }).state

    const disposed = transitionNavigation(withChatOverlay, {
      type: 'feature-disposed',
      featureId: 'sessions',
    })
    expect(disposed.state).toEqual({
      value: 'chat',
      route: { kind: 'chat' },
      mode: 'insert',
      focus: { kind: 'overlay', overlayId: 'global-question', featureId: 'chat' },
      overlays: [{ id: 'global-question', kind: 'question', featureId: 'chat' }],
    })
    expect(disposed.effects).toEqual([
      {
        type: 'overlay-closed',
        overlay: { id: 'session-help', kind: 'custom', featureId: 'sessions' },
        reason: 'owner-disposed',
      },
      {
        type: 'route-changed',
        previous: { kind: 'workspace', featureId: 'sessions', pane: 'navigator' },
        next: { kind: 'chat' },
      },
      {
        type: 'focus-requested',
        target: { kind: 'overlay', overlayId: 'global-question', featureId: 'chat' },
      },
    ])

    const unchanged = transitionNavigation(disposed.state, {
      type: 'feature-disposed',
      featureId: 'missing',
    })
    expect(unchanged).toEqual({ state: disposed.state, effects: [] })

    const overlayOnly = transitionNavigation(createNavigationState(), {
      type: 'push-overlay',
      overlay: { id: 'optional', kind: 'custom', featureId: 'optional-feature' },
    }).state
    const removedOnly = transitionNavigation(overlayOnly, {
      type: 'feature-disposed',
      featureId: 'optional-feature',
    })
    expect(removedOnly.state).toMatchObject({ value: 'chat', focus: { kind: 'composer' } })
    expect(removedOnly.effects).toEqual([
      {
        type: 'overlay-closed',
        overlay: { id: 'optional', kind: 'custom', featureId: 'optional-feature' },
        reason: 'owner-disposed',
      },
      { type: 'focus-requested', target: { kind: 'composer' } },
    ])
  })

  it('reports the active feature for every route variant', () => {
    expect(routeFeatureId({ kind: 'chat' })).toBe('chat')
    expect(routeFeatureId({ kind: 'diff', featureId: 'diff', pane: 'content' })).toBe('diff')
    expect(routeFeatureId({
      kind: 'workspace',
      featureId: 'sessions',
      pane: 'navigator',
    })).toBe('sessions')

    const frozen: NavigationState = createNavigationState()
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.route)).toBe(true)
    expect(Object.isFrozen(frozen.focus)).toBe(true)
    expect(Object.isFrozen(frozen.overlays)).toBe(true)
  })
})
