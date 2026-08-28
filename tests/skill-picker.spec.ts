import { describe, expect, it } from 'vitest'
import {
  applySkillPickerAction,
  createSkillPickerState,
  openSkillPicker,
  reconcileSkillPicker,
  selectSkillPicker,
} from '../src/skill/picker.ts'
import type { SessionSkillEntry, SessionSkillsSnapshot } from '../src/skill/port.ts'

function skill(
  name: string,
  overrides: Partial<SessionSkillEntry> = {},
): SessionSkillEntry {
  return {
    name,
    description: `${name} description`,
    modelInvocable: true,
    source: 'workspace',
    provider: 'filesystem',
    ...overrides,
  }
}

function snapshot(
  skills: readonly SessionSkillEntry[] = [
    skill('review', { whenToUse: 'Inspect source changes' }),
    skill('release', { source: 'user', provider: 'bundle' }),
    skill('research', { description: 'Find primary evidence' }),
  ],
  overrides: Partial<SessionSkillsSnapshot> = {},
): SessionSkillsSnapshot {
  return {
    available: true,
    loading: false,
    complete: true,
    stale: false,
    generation: 1,
    skills,
    ...overrides,
  }
}

describe('skill picker', () => {
  it('opens on the first user-invocable skill and exposes a detached view', () => {
    const catalog = snapshot()
    const closed = createSkillPickerState()
    expect(selectSkillPicker(closed, catalog)).toBeUndefined()
    expect(reconcileSkillPicker(closed, catalog)).toBe(closed)

    const opened = openSkillPicker(closed, catalog)
    expect(opened).toMatchObject({ open: true, selectedIndex: 0, selectedName: 'review' })
    expect(openSkillPicker(opened, catalog)).toBe(opened)
    expect(selectSkillPicker(opened, catalog)).toMatchObject({
      rows: catalog.skills,
      selectedIndex: 0,
      selectedName: 'review',
      totalCount: 3,
      available: true,
      complete: true,
    })
  })

  it('filters every searchable field and keeps selection stable across refreshes', () => {
    const catalog = snapshot()
    let state = openSkillPicker(createSkillPickerState(), catalog)
    state = applySkillPickerAction(state, catalog, { type: 'move-down' }).state
    expect(state.selectedName).toBe('release')

    const refreshed = snapshot([
      skill('new'),
      ...catalog.skills,
    ], { generation: 2, loading: true, complete: false, stale: true, error: 'retrying' })
    state = reconcileSkillPicker(state, refreshed)
    expect(state).toMatchObject({ selectedIndex: 2, selectedName: 'release' })

    const byWhen = applySkillPickerAction(state, refreshed, {
      type: 'edit',
      action: { type: 'insert', text: 'inspect source' },
    }).state
    expect(selectSkillPicker(byWhen, refreshed)).toMatchObject({
      selectedName: 'review',
      loading: true,
      complete: false,
      stale: true,
      error: 'retrying',
    })

    const bySource = applySkillPickerAction(
      openSkillPicker(createSkillPickerState(), catalog),
      catalog,
      { type: 'edit', action: { type: 'insert', text: 'user bundle' } },
    ).state
    expect(selectSkillPicker(bySource, catalog)?.rows.map(row => row.name)).toEqual(['release'])

    const noMatch = applySkillPickerAction(
      openSkillPicker(createSkillPickerState(), catalog),
      catalog,
      { type: 'edit', action: { type: 'insert', text: 'missing' } },
    ).state
    expect(noMatch).toMatchObject({ selectedIndex: -1 })
    expect(selectSkillPicker(noMatch, catalog)?.rows).toEqual([])
  })

  it('moves within bounds, inserts only the selected name, and closes on escape', () => {
    const catalog = snapshot()
    let state = openSkillPicker(createSkillPickerState(), catalog)
    expect(applySkillPickerAction(state, catalog, { type: 'move-up' }).state).toBe(state)
    state = applySkillPickerAction(state, catalog, { type: 'move-down' }).state
    state = applySkillPickerAction(state, catalog, { type: 'move-down' }).state
    expect(state.selectedName).toBe('research')
    expect(applySkillPickerAction(state, catalog, { type: 'move-down' }).state).toBe(state)
    state = applySkillPickerAction(state, catalog, { type: 'move-up' }).state

    const picked = applySkillPickerAction(state, catalog, { type: 'pick' })
    expect(picked).toMatchObject({
      state: { open: false },
      outcome: { kind: 'picked', name: 'release' },
    })

    const reopened = openSkillPicker(picked.state, catalog)
    const cancelled = applySkillPickerAction(reopened, catalog, { type: 'escape' })
    expect(cancelled).toMatchObject({ state: { open: false }, outcome: { kind: 'cancelled' } })
    expect(applySkillPickerAction(cancelled.state, catalog, { type: 'move-down' }))
      .toEqual({ state: cancelled.state })
  })

  it('blocks unavailable or empty catalogs and preserves no-op editor actions', () => {
    const unavailable = snapshot([], { available: false })
    let state = openSkillPicker(createSkillPickerState(), unavailable)
    expect(state.selectedIndex).toBe(-1)
    expect(applySkillPickerAction(state, unavailable, { type: 'move-down' }).state).toBe(state)
    expect(applySkillPickerAction(state, unavailable, { type: 'pick' }).outcome)
      .toEqual({ kind: 'blocked', reason: 'unavailable' })

    const empty = snapshot([])
    state = openSkillPicker(createSkillPickerState(), empty)
    expect(applySkillPickerAction(state, empty, { type: 'pick' }).outcome)
      .toEqual({ kind: 'blocked', reason: 'no-selection' })
    expect(applySkillPickerAction(state, empty, {
      type: 'edit',
      action: { type: 'backspace' },
    }).state).toBe(state)
  })
})
