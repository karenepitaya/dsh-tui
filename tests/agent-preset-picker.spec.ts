import { describe, expect, it } from 'vitest'
import type {
  AgentPresetCatalogEntry,
  AgentPresetCatalogSnapshot,
} from '../src/preset/catalog-port.ts'
import {
  STARTUP_PRESET_PICKER_LIMIT,
  applyStartupPresetPickerAction,
  createStartupPresetPickerState,
  openStartupPresetPicker,
  reconcileStartupPresetPicker,
  selectStartupPresetPicker,
} from '../src/preset/picker.ts'

function preset(
  id: string,
  overrides: Partial<AgentPresetCatalogEntry> = {},
): AgentPresetCatalogEntry {
  return Object.freeze({
    id,
    trust: 'system',
    sourcePath: `D:\\presets\\${id}\\agent.yml`,
    isDefault: false,
    ...overrides,
  })
}

function catalog(
  presets: readonly AgentPresetCatalogEntry[],
  defaultId = 'standard',
): AgentPresetCatalogSnapshot {
  return Object.freeze({
    defaultId,
    presets: Object.freeze([...presets]),
  })
}

describe('startup AgentPreset picker projection', () => {
  it('prefers the declared default even when broken, then healthy and first-row fallbacks', () => {
    const brokenDefault = catalog([
      preset('healthy', {
        name: 'Healthy',
        description: 'A healthy composition.',
      }),
      preset('broken-default', {
        isDefault: true,
        broken: 'composition is invalid',
      }),
    ], 'broken-default')
    const defaultState = openStartupPresetPicker(
      createStartupPresetPickerState(),
      brokenDefault,
    )
    const defaultView = selectStartupPresetPicker(defaultState, brokenDefault)!

    expect(defaultView).toMatchObject({
      selectedIndex: 1,
      selectedPresetId: 'broken-default',
      defaultId: 'broken-default',
      defaultMissing: false,
      totalCount: 2,
    })
    expect(defaultView.rows[1]).toEqual({
      id: 'broken-default',
      trust: 'system',
      isDefault: true,
      broken: 'composition is invalid',
    })
    expect(defaultView.rows[1]).not.toHaveProperty('sourcePath')
    expect(defaultView.rows[0]).toMatchObject({
      name: 'Healthy',
      description: 'A healthy composition.',
    })

    const missingDefault = catalog([
      preset('broken-first', { broken: 'missing composition' }),
      preset('healthy-second'),
    ], 'missing-default')
    const healthyFallback = selectStartupPresetPicker(
      openStartupPresetPicker(createStartupPresetPickerState(), missingDefault),
      missingDefault,
    )!
    expect(healthyFallback).toMatchObject({
      selectedPresetId: 'healthy-second',
      selectedIndex: 1,
      defaultMissing: true,
    })

    const allBroken = catalog([
      preset('first', { broken: 'bad first' }),
      preset('second', { broken: 'bad second' }),
    ], 'missing-default')
    expect(selectStartupPresetPicker(
      openStartupPresetPicker(createStartupPresetPickerState(), allBroken),
      allBroken,
    )).toMatchObject({
      selectedPresetId: 'first',
      selectedIndex: 0,
      defaultMissing: true,
    })
  })

  it('keeps a stable id selected across refresh/reorder and bounds the visible window to eight', () => {
    const initial = catalog(Array.from(
      { length: STARTUP_PRESET_PICKER_LIMIT + 3 },
      (_, index) => preset(`preset-${index}`, { isDefault: index === 0 }),
    ), 'preset-0')
    let state = openStartupPresetPicker(createStartupPresetPickerState(), initial)
    for (let index = 0; index < STARTUP_PRESET_PICKER_LIMIT + 1; index += 1) {
      state = applyStartupPresetPickerAction(state, initial, { type: 'move-down' }).state
    }
    const scrolled = selectStartupPresetPicker(state, initial)!

    expect(scrolled.rows).toHaveLength(STARTUP_PRESET_PICKER_LIMIT)
    expect(scrolled).toMatchObject({
      selectedPresetId: 'preset-9',
      selectedIndex: STARTUP_PRESET_PICKER_LIMIT - 1,
      offset: 2,
      totalCount: STARTUP_PRESET_PICKER_LIMIT + 3,
    })
    expect(scrolled.rows[scrolled.selectedIndex]?.id).toBe('preset-9')
    expect(scrolled.rows.every(row => !('sourcePath' in row))).toBe(true)

    const selected = initial.presets[9]!
    const reordered = catalog([
      selected,
      ...initial.presets.filter(row => row.id !== selected.id),
    ], 'preset-0')
    state = reconcileStartupPresetPicker(state, reordered)
    expect(selectStartupPresetPicker(state, reordered)).toMatchObject({
      selectedPresetId: 'preset-9',
      selectedIndex: 0,
      offset: 0,
    })
  })
})

describe('startup AgentPreset picker decisions', () => {
  it('blocks broken rows with their reason and returns only an exact healthy plan', () => {
    const snapshot = catalog([
      preset('broken', {
        isDefault: true,
        broken: 'composition cannot be loaded',
      }),
      preset('user-preset', {
        trust: 'user',
        sourcePath: 'D:\\user\\presets\\user-preset\\agent.yml',
      }),
    ], 'broken')
    let state = openStartupPresetPicker(createStartupPresetPickerState(), snapshot)

    const blocked = applyStartupPresetPickerAction(state, snapshot, { type: 'enter' })
    expect(blocked).toEqual({
      state,
      outcome: {
        kind: 'blocked',
        reason: 'broken',
        presetId: 'broken',
        message: 'composition cannot be loaded',
      },
    })

    state = applyStartupPresetPickerAction(state, snapshot, { type: 'move-down' }).state
    const selected = applyStartupPresetPickerAction(state, snapshot, { type: 'enter' })
    expect(selected).toEqual({
      state: {
        open: false,
        selectedPresetId: 'user-preset',
        selectedIndex: 1,
      },
      outcome: {
        kind: 'selected',
        plan: {
          id: 'user-preset',
          trust: 'user',
          sourcePath: 'D:\\user\\presets\\user-preset\\agent.yml',
        },
      },
    })
  })

  it('revalidates the selected id against the latest snapshot before producing a plan', () => {
    const initial = catalog([
      preset('standard', { isDefault: true }),
      preset('target', { sourcePath: 'D:\\old\\agent.yml' }),
    ])
    let state = openStartupPresetPicker(createStartupPresetPickerState(), initial)
    state = applyStartupPresetPickerAction(state, initial, { type: 'move-down' }).state

    const refreshed = catalog([
      preset('target', {
        trust: 'user',
        sourcePath: 'D:\\new\\agent.yml',
      }),
      preset('standard', { isDefault: true }),
    ])
    expect(applyStartupPresetPickerAction(state, refreshed, { type: 'enter' }).outcome)
      .toEqual({
        kind: 'selected',
        plan: {
          id: 'target',
          trust: 'user',
          sourcePath: 'D:\\new\\agent.yml',
        },
      })

    const removed = catalog([
      preset('standard', { isDefault: true }),
      preset('replacement'),
    ])
    const invalidated = applyStartupPresetPickerAction(state, removed, { type: 'enter' })
    expect(invalidated).toMatchObject({
      state: {
        open: true,
        selectedPresetId: 'target',
        selectedIndex: -1,
      },
      outcome: {
        kind: 'blocked',
        reason: 'selection-missing',
        presetId: 'target',
      },
    })
    expect(invalidated.outcome).not.toHaveProperty('plan')
  })

  it('emits refresh and cancellation outcomes without selecting a preset', () => {
    const snapshot = catalog([preset('standard', { isDefault: true })])
    const open = openStartupPresetPicker(createStartupPresetPickerState(), snapshot)

    expect(applyStartupPresetPickerAction(open, snapshot, { type: 'refresh' })).toEqual({
      state: open,
      outcome: { kind: 'refresh-requested' },
    })
    expect(applyStartupPresetPickerAction(open, snapshot, { type: 'escape' })).toEqual({
      state: {
        open: false,
        selectedPresetId: 'standard',
        selectedIndex: 0,
      },
      outcome: { kind: 'cancelled' },
    })

    const empty = catalog([], 'missing-default')
    const emptyState = openStartupPresetPicker(createStartupPresetPickerState(), empty)
    expect(selectStartupPresetPicker(emptyState, empty)).toEqual({
      rows: [],
      selectedIndex: -1,
      offset: 0,
      totalCount: 0,
      defaultId: 'missing-default',
      defaultMissing: true,
    })
    expect(applyStartupPresetPickerAction(emptyState, empty, { type: 'enter' }))
      .toEqual({
        state: emptyState,
        outcome: { kind: 'blocked', reason: 'no-selection' },
      })
  })

  it('handles closed state, movement boundaries, invalidation, and stale reopen safely', () => {
    const snapshot = catalog([
      preset('standard', {
        isDefault: true,
        description: 'Default description',
      }),
      preset('second'),
    ])
    const closed = createStartupPresetPickerState()

    expect(reconcileStartupPresetPicker(closed, snapshot)).toBe(closed)
    expect(selectStartupPresetPicker(closed, snapshot)).toBeUndefined()
    expect(applyStartupPresetPickerAction(closed, snapshot, { type: 'move-down' }))
      .toEqual({ state: closed })

    let state = openStartupPresetPicker(closed, snapshot)
    expect(openStartupPresetPicker(state, snapshot)).toBe(state)
    expect(applyStartupPresetPickerAction(state, snapshot, { type: 'move-up' }).state)
      .toBe(state)

    state = applyStartupPresetPickerAction(state, snapshot, { type: 'move-down' }).state
    expect(state.selectedPresetId).toBe('second')
    expect(applyStartupPresetPickerAction(state, snapshot, { type: 'move-down' }).state)
      .toBe(state)

    const cancelled = applyStartupPresetPickerAction(
      state,
      snapshot,
      { type: 'escape' },
    ).state
    expect(openStartupPresetPicker(cancelled, snapshot)).toMatchObject({
      open: true,
      selectedPresetId: 'second',
      selectedIndex: 1,
    })

    const removed = catalog([
      preset('replacement', { isDefault: true }),
      preset('other'),
    ], 'replacement')
    const invalidated = reconcileStartupPresetPicker(state, removed)
    expect(invalidated).toMatchObject({
      open: true,
      selectedPresetId: 'second',
      selectedIndex: -1,
    })
    expect(reconcileStartupPresetPicker(invalidated, removed)).toBe(invalidated)
    expect(applyStartupPresetPickerAction(
      invalidated,
      removed,
      { type: 'move-down' },
    ).state).toMatchObject({
      selectedPresetId: 'replacement',
      selectedIndex: 0,
    })
    expect(openStartupPresetPicker(cancelled, removed)).toMatchObject({
      selectedPresetId: 'replacement',
      selectedIndex: 0,
    })

    const brokenRefresh = catalog([
      preset('second', { broken: 'newly broken' }),
      preset('standard', { isDefault: true }),
    ])
    expect(applyStartupPresetPickerAction(state, brokenRefresh, { type: 'enter' }))
      .toMatchObject({
        state: { selectedPresetId: 'second', selectedIndex: 0 },
        outcome: { kind: 'blocked', reason: 'broken', message: 'newly broken' },
      })

    const empty = catalog([], 'missing')
    const emptyOpen = openStartupPresetPicker(closed, empty)
    expect(applyStartupPresetPickerAction(
      emptyOpen,
      empty,
      { type: 'move-down' },
    ).state).toBe(emptyOpen)
    expect(reconcileStartupPresetPicker(emptyOpen, snapshot)).toMatchObject({
      selectedPresetId: 'standard',
      selectedIndex: 0,
    })
  })
})
