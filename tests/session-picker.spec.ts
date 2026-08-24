import { describe, expect, it } from 'vitest'
import type {
  SessionCatalogEntry,
  SessionCatalogSnapshot,
} from '../src/session/catalog-port.ts'
import {
  SESSION_PICKER_LIMIT,
  applySessionPickerAction,
  createSessionPickerState,
  openSessionPicker,
  reconcileSessionPicker,
  selectSessionPicker,
} from '../src/session/picker.ts'

function entry(
  sessionId: string,
  overrides: Partial<SessionCatalogEntry> = {},
): SessionCatalogEntry {
  return {
    sessionId,
    createdAt: 100,
    isSubagent: false,
    attached: false,
    durablePresence: 'observed',
    ...overrides,
  }
}

function snapshot(
  sessions: readonly SessionCatalogEntry[],
  durability: SessionCatalogSnapshot['durability'] = 'available',
): SessionCatalogSnapshot {
  return { durability, sessions }
}

describe('session picker projection', () => {
  it('expresses current, cold, other-live, and unavailable durability independently', () => {
    const available = snapshot([
      entry('current', { attached: true, liveStatus: 'idle' }),
      entry('cold', { cwd: 'D:\\work', creationAgentPreset: 'coding' }),
      entry('live', {
        attached: true,
        durablePresence: 'not-observed',
        liveStatus: 'running',
        parentSessionId: 'parent',
        isSubagent: true,
      }),
    ])
    const state = openSessionPicker(createSessionPickerState(), available, 'current')
    const view = selectSessionPicker(state, available, 'current')

    expect(view).toMatchObject({
      durability: 'available',
      selectedIndex: 0,
      selectedSessionId: 'current',
      offset: 0,
      totalCount: 3,
      rows: [
        {
          sessionId: 'current',
          relation: 'current',
          durablePresence: 'observed',
          liveStatus: 'idle',
        },
        {
          sessionId: 'cold',
          relation: 'cold',
          cwd: 'D:\\work',
          creationAgentPreset: 'coding',
        },
        {
          sessionId: 'live',
          relation: 'other-live',
          durablePresence: 'not-observed',
          liveStatus: 'running',
          parentSessionId: 'parent',
          isSubagent: true,
        },
      ],
    })

    const unavailable = snapshot([
      entry('current', { attached: true, durablePresence: 'unavailable' }),
      entry('live', { attached: true, durablePresence: 'unavailable' }),
    ], 'unavailable')
    expect(selectSessionPicker(
      openSessionPicker(createSessionPickerState(), unavailable, 'current'),
      unavailable,
      'current',
    )).toMatchObject({
      durability: 'unavailable',
      rows: [
        { sessionId: 'current', relation: 'current', durablePresence: 'unavailable' },
        { sessionId: 'live', relation: 'other-live', durablePresence: 'unavailable' },
      ],
    })
  })

  it('returns a bounded, detached, deeply frozen view without sanitizing hostile strings', () => {
    const hostile = entry('session-\u001b[31m', {
      cwd: 'D:\\unsafe\nline',
      creationAgentPreset: 'preset\u0000raw',
    })
    const mutableSessions = Array.from(
      { length: SESSION_PICKER_LIMIT + 3 },
      (_, index) => index === 0 ? hostile : entry(`session-${index}`),
    )
    const catalog = snapshot(mutableSessions)
    const view = selectSessionPicker(
      openSessionPicker(createSessionPickerState(), catalog),
      catalog,
    )!

    expect(view.rows).toHaveLength(SESSION_PICKER_LIMIT)
    expect(view.totalCount).toBe(SESSION_PICKER_LIMIT + 3)
    expect(view.rows[0]).toMatchObject({
      sessionId: 'session-\u001b[31m',
      cwd: 'D:\\unsafe\nline',
      creationAgentPreset: 'preset\u0000raw',
    })
    expect(view.rows[0]).not.toBe(hostile)
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.rows)).toBe(true)
    expect(view.rows.every(Object.isFrozen)).toBe(true)

    ;(hostile as { sessionId: string }).sessionId = 'mutated'
    ;(mutableSessions as SessionCatalogEntry[])[0] = entry('replaced')
    expect(view.rows[0]?.sessionId).toBe('session-\u001b[31m')
  })
})

describe('session picker reconciliation', () => {
  it('keeps selection stable by sessionId across reorder and clamps a removed target', () => {
    const initial = snapshot([entry('a'), entry('b'), entry('c')])
    let state = openSessionPicker(createSessionPickerState(), initial, 'a')
    expect(openSessionPicker(state, initial, 'a')).toBe(state)
    state = applySessionPickerAction(state, initial, 'a', { type: 'move-down' }).state
    expect(state).toMatchObject({ selectedSessionId: 'b', selectedIndex: 1 })

    const reordered = snapshot([entry('c'), entry('a'), entry('b')])
    const closedWithSelection = applySessionPickerAction(
      state,
      initial,
      'a',
      { type: 'escape' },
    ).state
    expect(openSessionPicker(closedWithSelection, reordered, 'a')).toMatchObject({
      open: true,
      selectedSessionId: 'b',
      selectedIndex: 2,
    })
    state = reconcileSessionPicker(state, reordered, 'a')
    expect(state).toMatchObject({ selectedSessionId: 'b', selectedIndex: 2 })

    const removed = snapshot([entry('c'), entry('a')])
    state = reconcileSessionPicker(state, removed, 'a')
    expect(state).toMatchObject({ selectedSessionId: 'a', selectedIndex: 1 })

    state = reconcileSessionPicker(state, snapshot([]), 'a')
    expect(state).toEqual({ open: true, selectedIndex: -1 })
    expect(selectSessionPicker(state, snapshot([]), 'a')).toMatchObject({
      rows: [],
      selectedIndex: -1,
      totalCount: 0,
    })
  })

  it('scrolls a bounded window, clamps movement, and preserves closed state on refresh', () => {
    const catalog = snapshot(Array.from(
      { length: SESSION_PICKER_LIMIT + 2 },
      (_, index) => entry(`s-${index}`),
    ))
    let state = openSessionPicker(createSessionPickerState(), catalog, 's-0')
    for (let index = 0; index < SESSION_PICKER_LIMIT; index += 1) {
      state = applySessionPickerAction(state, catalog, 's-0', { type: 'move-down' }).state
    }
    const view = selectSessionPicker(state, catalog, 's-0')!
    expect(view).toMatchObject({
      offset: 1,
      selectedIndex: SESSION_PICKER_LIMIT - 1,
      selectedSessionId: `s-${SESSION_PICKER_LIMIT}`,
    })
    expect(view.rows[view.selectedIndex]?.sessionId).toBe(`s-${SESSION_PICKER_LIMIT}`)

    const moved = applySessionPickerAction(state, catalog, 's-0', { type: 'move-down' }).state
    const atEnd = applySessionPickerAction(moved, catalog, 's-0', { type: 'move-down' }).state
    expect(atEnd).toBe(moved)
    expect(selectSessionPicker(moved, catalog, 's-0')!.offset).toBe(2)
    state = applySessionPickerAction(moved, catalog, 's-0', { type: 'move-up' }).state
    expect(state.selectedSessionId).toBe(`s-${SESSION_PICKER_LIMIT}`)

    const closed = createSessionPickerState()
    expect(reconcileSessionPicker(closed, catalog, 's-0')).toBe(closed)
    expect(selectSessionPicker(closed, catalog, 's-0')).toBeUndefined()
    expect(applySessionPickerAction(closed, catalog, 's-0', { type: 'move-down' })).toEqual({
      state: closed,
    })
  })
})

describe('session picker decisions', () => {
  it('dismisses on Escape and makes Enter read-only or an explicit no-op', () => {
    const catalog = snapshot([
      entry('current', { attached: true }),
      entry('cold'),
      entry('live', { attached: true, durablePresence: 'not-observed' }),
    ])
    let state = openSessionPicker(createSessionPickerState(), catalog, 'current')
    expect(applySessionPickerAction(state, catalog, 'current', { type: 'enter' })).toEqual({
      state,
      outcome: { kind: 'noop', reason: 'already-current', sessionId: 'current' },
    })

    state = applySessionPickerAction(state, catalog, 'current', { type: 'move-down' }).state
    expect(applySessionPickerAction(state, catalog, 'current', { type: 'enter' })).toEqual({
      state,
      outcome: {
        kind: 'read-only',
        reason: 'session-switch-not-implemented',
        sessionId: 'cold',
        relation: 'cold',
      },
    })

    state = applySessionPickerAction(state, catalog, 'current', { type: 'move-down' }).state
    expect(applySessionPickerAction(state, catalog, 'current', { type: 'enter' })).toEqual({
      state,
      outcome: {
        kind: 'read-only',
        reason: 'session-switch-not-implemented',
        sessionId: 'live',
        relation: 'other-live',
      },
    })

    const escaped = applySessionPickerAction(state, catalog, 'current', { type: 'escape' })
    expect(escaped).toEqual({ state: { ...state, open: false }, outcome: { kind: 'dismissed' } })

    const empty = snapshot([])
    const emptyState = openSessionPicker(createSessionPickerState(), empty, 'current')
    expect(applySessionPickerAction(emptyState, empty, 'current', { type: 'move-down' })).toEqual({
      state: emptyState,
    })
    expect(applySessionPickerAction(emptyState, empty, 'current', { type: 'enter' })).toEqual({
      state: emptyState,
      outcome: { kind: 'noop', reason: 'no-selection' },
    })
  })
})
