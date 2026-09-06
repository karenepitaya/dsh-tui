import { describe, expect, it } from 'vitest'
import {
  applyPermissionPickerAction,
  createPermissionPickerState,
  openPermissionPicker,
  reconcilePermissionPicker,
  selectPermissionPicker,
} from '../src/permission/picker.ts'
import type { SessionPermissionSnapshot } from '../src/permission/port.ts'

function snapshot(
  overrides: Partial<SessionPermissionSnapshot> = {},
): SessionPermissionSnapshot {
  return {
    available: true,
    writable: true,
    stale: false,
    generation: 0,
    selecting: false,
    currentValue: 'workspace-write',
    currentPermission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
    options: [
      {
        value: 'workspace-write',
        name: 'Workspace write',
        description: 'Write inside the workspace and ask before wider access.',
        selectable: true,
        permission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
      },
      {
        value: 'danger-full-access',
        name: 'Full access',
        description: 'Full file access without approval prompts.',
        selectable: true,
        permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
      },
    ],
    ...overrides,
  }
}

describe('permission picker', () => {
  it('requires a deliberate confirmation and drops it when identity or generation changes', () => {
    const permissions = snapshot()
    const target = applyPermissionPickerAction(openPermissionPicker(createPermissionPickerState(), permissions), permissions, { type: 'move-down' }).state
    const review = applyPermissionPickerAction(target, permissions, { type: 'enter' }).state
    const next = applyPermissionPickerAction(review, permissions, { type: 'move-down' }).state
    expect(next.confirmation?.selectedIndex).toBe(1)
    expect(applyPermissionPickerAction(next, permissions, { type: 'move-up' }).state.confirmation?.selectedIndex).toBe(0)
    expect(applyPermissionPickerAction(next, permissions, { type: 'confirm-previous' }).state.confirmation?.selectedIndex).toBe(0)
    expect(applyPermissionPickerAction(review, permissions, { type: 'escape' }).state).toMatchObject({ open: true })
    expect(applyPermissionPickerAction(review, permissions, { type: 'escape' }).state.confirmation).toBeUndefined()
    expect(reconcilePermissionPicker(next, { ...permissions, generation: 1 }).confirmation).toBeUndefined()
    expect(reconcilePermissionPicker(next, { ...permissions, currentValue: 'danger-full-access' }).confirmation).toBeUndefined()
    expect(reconcilePermissionPicker(next, { ...permissions, options: permissions.options.slice(0, 1) }).confirmation).toBeUndefined()
    expect(applyPermissionPickerAction(target, permissions, { type: 'confirm-previous' }).state).toBe(target)
    expect(applyPermissionPickerAction(target, permissions, { type: 'confirm-next' }).state).toBe(target)
  })

  it('permits known narrowing and rejects missing policy metadata', () => {
    const full = snapshot({ currentValue: 'danger-full-access', currentPermission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' } })
    const target = applyPermissionPickerAction(openPermissionPicker(createPermissionPickerState(), full), full, { type: 'move-up' }).state
    const narrowing = { ...full, options: full.options.map(option => ({ ...option, permission: { sandboxMode: 'read-only' as const, approvalPolicy: 'never' as const } })) }
    expect(applyPermissionPickerAction(target, narrowing, { type: 'enter' }).outcome).toEqual({ kind: 'selected', value: 'workspace-write' })
    const { currentPermission: _current, ...missingCurrent } = narrowing
    const { currentValue: _value, ...missingValue } = narrowing
    const missingTarget = { ...narrowing, options: narrowing.options.map(({ permission: _permission, ...option }) => option) }
    for (const permissions of [missingCurrent, missingValue, missingTarget]) {
      expect(applyPermissionPickerAction(target, permissions, { type: 'enter' }).outcome)
        .toEqual({ kind: 'blocked', reason: 'missing-policy' })
    }
  })

  it('opens on the effective preset and exposes a bounded detached view', () => {
    const permissions = snapshot({
      currentValue: 'preset-9',
      options: Array.from({ length: 10 }, (_, index) => ({
        value: `preset-${index}`,
        name: `Preset ${index}`,
        selectable: true,
      })),
    })
    const state = openPermissionPicker(createPermissionPickerState(), permissions)
    const view = selectPermissionPicker(state, permissions)

    expect(view).toMatchObject({
      selectedValue: 'preset-9',
      selectedIndex: 7,
      offset: 2,
      totalCount: 10,
      currentValue: 'preset-9',
    })
    expect(view?.rows[7]).toEqual({
      value: 'preset-9',
      name: 'Preset 9',
      selectable: true,
      isCurrent: true,
    })
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view?.rows)).toBe(true)
    expect(selectPermissionPicker(createPermissionPickerState(), permissions)).toBeUndefined()
  })

  it('keeps selection identity across projection updates and moves without wrapping', () => {
    const permissions = snapshot()
    let state = openPermissionPicker(createPermissionPickerState(), permissions)
    expect(applyPermissionPickerAction(state, permissions, { type: 'move-up' }).state).toBe(state)

    state = applyPermissionPickerAction(state, permissions, { type: 'move-down' }).state
    expect(state.selectedValue).toBe('danger-full-access')
    expect(applyPermissionPickerAction(state, permissions, { type: 'move-down' }).state).toBe(state)

    const reordered = snapshot({ options: [...permissions.options].reverse() })
    const reconciled = reconcilePermissionPicker(state, reordered)
    expect(reconciled.selectedValue).toBe('danger-full-access')
    expect(reconciled.selectedIndex).toBe(0)
    const closed = createPermissionPickerState()
    expect(reconcilePermissionPicker(closed, reordered)).toBe(closed)
  })

  it('requests a different switch target and remains open while the command settles', () => {
    const permissions = snapshot()
    const current = openPermissionPicker(createPermissionPickerState(), permissions)
    const target = applyPermissionPickerAction(
      current,
      permissions,
      { type: 'move-down' },
    ).state

    const review = applyPermissionPickerAction(target, permissions, { type: 'enter' })
    expect(review.outcome).toEqual({ kind: 'confirmation-required', value: 'danger-full-access' })
    expect(selectPermissionPicker(review.state, permissions)?.confirmation?.selectedIndex).toBe(0)
    const repeatEnter = applyPermissionPickerAction(review.state, permissions, { type: 'enter' })
    expect(repeatEnter.outcome).toBeUndefined()
    expect(repeatEnter.state.confirmation).toBeUndefined()
    const confirmed = applyPermissionPickerAction(review.state, permissions, { type: 'confirm-next' })
    const selected = applyPermissionPickerAction(confirmed.state, permissions, { type: 'enter' })
    expect(selected.outcome).toEqual({
      kind: 'selected',
      value: 'danger-full-access',
      confirmation: { fromValue: 'workspace-write', toValue: 'danger-full-access', generation: 0 },
    })
    expect(selected.state.open).toBe(true)

    const cancelled = applyPermissionPickerAction(target, permissions, { type: 'escape' })
    expect(cancelled.outcome).toEqual({ kind: 'cancelled' })
    expect(cancelled.state.open).toBe(false)
  })

  it.each([
    { overrides: { available: false }, reason: 'unavailable' },
    { overrides: { stale: true }, reason: 'stale' },
    { overrides: { writable: false }, reason: 'read-only' },
    { overrides: { selecting: true }, reason: 'selecting' },
  ] as const)('blocks selection while $reason', ({ overrides, reason }) => {
    const permissions = snapshot(overrides)
    const state = applyPermissionPickerAction(
      openPermissionPicker(createPermissionPickerState(), permissions),
      permissions,
      { type: 'move-down' },
    ).state
    expect(applyPermissionPickerAction(state, permissions, { type: 'enter' }).outcome)
      .toEqual({ kind: 'blocked', reason })
  })

  it('blocks unchanged, current-only, and empty selections', () => {
    const permissions = snapshot()
    const current = openPermissionPicker(createPermissionPickerState(), permissions)
    expect(applyPermissionPickerAction(current, permissions, { type: 'enter' }).outcome)
      .toEqual({ kind: 'blocked', reason: 'unchanged' })

    const custom = snapshot({
      currentValue: 'custom',
      options: [{
        value: 'custom',
        name: 'Custom',
        description: 'Current settings do not match a preset.',
        selectable: false,
      }],
    })
    const customState = openPermissionPicker(createPermissionPickerState(), custom)
    expect(applyPermissionPickerAction(customState, custom, { type: 'enter' }).outcome)
      .toEqual({ kind: 'blocked', reason: 'current-only' })

    const empty: SessionPermissionSnapshot = {
      available: true,
      writable: true,
      stale: false,
      generation: 0,
      selecting: false,
      options: [],
    }
    const emptyState = openPermissionPicker(createPermissionPickerState(), empty)
    expect(emptyState.selectedIndex).toBe(-1)
    const emptyView = selectPermissionPicker(emptyState, empty)
    expect(emptyView).toMatchObject({ selectedIndex: -1, rows: [] })
    expect(emptyView).not.toHaveProperty('selectedValue')
    expect(emptyView).not.toHaveProperty('currentValue')
    expect(applyPermissionPickerAction(emptyState, empty, { type: 'move-down' }).state)
      .toBe(emptyState)
    expect(applyPermissionPickerAction(emptyState, empty, { type: 'enter' }).outcome)
      .toEqual({ kind: 'blocked', reason: 'no-selection' })
    expect(applyPermissionPickerAction(createPermissionPickerState(), empty, { type: 'enter' }))
      .toEqual({ state: createPermissionPickerState() })
  })

  it('falls back to the first selectable row and carries projection health', () => {
    const permissions = snapshot({
      currentValue: 'missing',
      stale: true,
      error: 'projection changed',
      options: [
        { value: 'custom', name: 'Custom', selectable: false },
        { value: 'workspace-write', name: 'Workspace write', selectable: true },
      ],
    })
    const state = openPermissionPicker(createPermissionPickerState(), permissions)
    expect(state.selectedValue).toBe('workspace-write')
    expect(selectPermissionPicker(state, permissions)).toMatchObject({
      stale: true,
      error: 'projection changed',
    })

    const currentOnly: SessionPermissionSnapshot = {
      available: true,
      writable: true,
      stale: false,
      generation: 0,
      selecting: false,
      options: [
        { value: 'custom', name: 'Custom', selectable: false },
        { value: 'derived', name: 'Derived', selectable: false },
      ],
    }
    expect(openPermissionPicker(createPermissionPickerState(), currentOnly)).toMatchObject({
      selectedIndex: 0,
      selectedValue: 'custom',
    })
  })
})
