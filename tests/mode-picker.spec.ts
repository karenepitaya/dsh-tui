import { describe, expect, it } from 'vitest'
import {
  applyModePickerAction,
  createModePickerState,
  openModePicker,
  reconcileModePicker,
  selectModePicker,
} from '../src/mode/picker.ts'
import type { SessionModeSnapshot } from '../src/mode/port.ts'

function snapshot(
  overrides: Partial<SessionModeSnapshot> = {},
): SessionModeSnapshot {
  return {
    available: true,
    current: 'standard',
    defaultId: 'standard',
    loading: false,
    selecting: false,
    locked: false,
    presets: [
      {
        id: 'standard',
        trust: 'system',
        sourcePath: 'D:\\presets\\standard\\agent.cordis.yml',
        name: 'Standard',
        description: 'Complete coding Agent',
        isDefault: true,
      },
      {
        id: 'code',
        trust: 'system',
        sourcePath: 'D:\\presets\\code\\agent.cordis.yml',
        name: 'PTC Mode',
        isDefault: false,
      },
      {
        id: 'broken',
        trust: 'user',
        sourcePath: 'D:\\presets\\broken\\agent.cordis.yml',
        broken: 'invalid composition',
        isDefault: false,
      },
    ],
    ...overrides,
  }
}

describe('mode picker', () => {
  it('opens on the current mode and exposes only presentation-safe rows', () => {
    const state = openModePicker(createModePickerState(), snapshot())
    const view = selectModePicker(state, snapshot())

    expect(view).toMatchObject({
      selectedIndex: 0,
      selectedModeId: 'standard',
      current: 'standard',
      defaultId: 'standard',
      locked: false,
    })
    expect(view?.rows[0]).toEqual({
      id: 'standard',
      trust: 'system',
      name: 'Standard',
      description: 'Complete coding Agent',
      isCurrent: true,
      isDefault: true,
    })
    expect(view?.rows[0]).not.toHaveProperty('sourcePath')
    expect(selectModePicker(createModePickerState(), snapshot())).toBeUndefined()
  })

  it('keeps stable identity across refresh and bounds the visible window', () => {
    const many = snapshot({
      current: 'mode-9',
      presets: Array.from({ length: 10 }, (_, index) => ({
        id: `mode-${index}`,
        trust: 'system' as const,
        sourcePath: `D:\\presets\\mode-${index}\\agent.cordis.yml`,
        isDefault: index === 0,
      })),
    })
    const opened = openModePicker(createModePickerState(), many)
    const view = selectModePicker(opened, many)
    expect(view).toMatchObject({
      selectedModeId: 'mode-9',
      selectedIndex: 7,
      offset: 2,
      totalCount: 10,
    })

    const reordered = snapshot({ presets: [...many.presets].reverse() })
    const reconciled = reconcileModePicker(opened, reordered)
    expect(reconciled.selectedModeId).toBe('mode-9')
    expect(reconciled.selectedIndex).toBe(0)
    const closed = createModePickerState()
    expect(reconcileModePicker(closed, reordered)).toBe(closed)
  })

  it('moves, refreshes, closes, and selects a healthy different mode', () => {
    const modes = snapshot()
    let state = openModePicker(createModePickerState(), modes)
    expect(applyModePickerAction(state, modes, { type: 'move-up' }).state).toBe(state)
    const down = applyModePickerAction(state, modes, { type: 'move-down' })
    state = down.state
    expect(state.selectedModeId).toBe('code')
    expect(applyModePickerAction(state, modes, { type: 'move-up' }).state.selectedModeId)
      .toBe('standard')
    expect(applyModePickerAction(state, modes, { type: 'refresh' }).outcome)
      .toEqual({ kind: 'refresh-requested' })

    const selected = applyModePickerAction(state, modes, { type: 'enter' })
    expect(selected.outcome).toEqual({ kind: 'selected', modeId: 'code' })
    expect(selected.state.open).toBe(false)

    const cancelled = applyModePickerAction(state, modes, { type: 'escape' })
    expect(cancelled.outcome).toEqual({ kind: 'cancelled' })
    expect(cancelled.state.open).toBe(false)
    expect(applyModePickerAction(createModePickerState(), modes, { type: 'enter' }))
      .toEqual({ state: createModePickerState() })
  })

  it.each([
    { overrides: { available: false }, reason: 'unavailable' },
    { overrides: { selecting: true }, reason: 'selecting' },
    { overrides: { locked: true }, reason: 'locked' },
  ] as const)('blocks selection while $reason', ({ overrides, reason }) => {
    const modes = snapshot(overrides)
    const state = applyModePickerAction(
      openModePicker(createModePickerState(), modes),
      modes,
      { type: 'move-down' },
    ).state
    expect(applyModePickerAction(state, modes, { type: 'enter' }).outcome)
      .toEqual({ kind: 'blocked', reason })
  })

  it('blocks unchanged, broken, and empty selections without closing', () => {
    const modes = snapshot()
    const current = openModePicker(createModePickerState(), modes)
    expect(applyModePickerAction(current, modes, { type: 'enter' }).outcome)
      .toEqual({ kind: 'blocked', reason: 'unchanged' })

    const broken = applyModePickerAction(
      applyModePickerAction(current, modes, { type: 'move-down' }).state,
      modes,
      { type: 'move-down' },
    ).state
    expect(applyModePickerAction(broken, modes, { type: 'enter' }).outcome)
      .toEqual({
        kind: 'blocked',
        reason: 'broken',
        modeId: 'broken',
        message: 'invalid composition',
      })

    const empty: SessionModeSnapshot = {
      available: true,
      loading: false,
      selecting: false,
      locked: false,
      presets: [],
    }
    const emptyState = openModePicker(createModePickerState(), empty)
    expect(emptyState.selectedIndex).toBe(-1)
    expect(applyModePickerAction(emptyState, empty, { type: 'move-down' }).state)
      .toBe(emptyState)
    expect(applyModePickerAction(emptyState, empty, { type: 'enter' }).outcome)
      .toEqual({ kind: 'blocked', reason: 'no-selection' })
  })

  it('falls back from a missing current/default to the first healthy row', () => {
    const defaultFallback = snapshot({ current: 'missing-current', defaultId: 'code' })
    expect(openModePicker(createModePickerState(), defaultFallback).selectedModeId).toBe('code')

    const modes = snapshot({
      current: 'missing-current',
      defaultId: 'missing-default',
      presets: [
        { ...snapshot().presets[2]!, isDefault: false },
        { ...snapshot().presets[1]!, isDefault: false },
      ],
      error: 'roster changed',
      loading: true,
    })
    const state = openModePicker(createModePickerState(), modes)
    expect(state.selectedModeId).toBe('code')
    expect(selectModePicker(state, modes)).toMatchObject({
      loading: true,
      error: 'roster changed',
    })
  })
})
