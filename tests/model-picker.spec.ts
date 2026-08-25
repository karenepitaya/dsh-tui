import { describe, expect, it } from 'vitest'
import type { SessionModelSnapshot } from '../src/model/port.ts'
import {
  applyModelPickerAction,
  createModelPickerState,
  openModelPicker,
  reconcileModelPicker,
  selectModelPicker,
} from '../src/model/picker.ts'

function snapshot(
  overrides: Partial<SessionModelSnapshot> = {},
): SessionModelSnapshot {
  return {
    current: { provider: 'deepseek', model: 'deepseek-chat' },
    defaultSelection: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
    routable: true,
    writable: true,
    loading: false,
    selecting: false,
    groups: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          {
            provider: 'deepseek',
            providerName: 'DeepSeek',
            id: 'deepseek-chat',
            name: 'DeepSeek Chat',
            efforts: [],
          },
          {
            provider: 'deepseek',
            providerName: 'DeepSeek',
            id: 'deepseek-reasoner',
            name: 'DeepSeek Reasoner',
            efforts: [
              { id: 'quick', name: 'Quick', isDefault: false },
              { id: 'thorough', name: 'Thorough', isDefault: true },
            ],
          },
        ],
      },
      {
        id: 'xiaomi',
        name: 'Xiaomi Token Plan',
        models: [{
          provider: 'xiaomi',
          providerName: 'Xiaomi Token Plan',
          id: 'mimo-v2.5-pro',
          name: 'MiMo V2.5 Pro',
          efforts: [{ id: 'thinking', name: 'Thinking', isDefault: false }],
        }],
      },
    ],
    failures: [],
    ...overrides,
  }
}

describe('model picker', () => {
  it('projects provider groups and marks current/default selections', () => {
    const catalog = snapshot()
    const state = openModelPicker(createModelPickerState(), catalog)
    const view = selectModelPicker(state, catalog)!

    expect(view.stage).toBe('models')
    expect(view.groups.map(group => group.name)).toEqual([
      'DeepSeek',
      'Xiaomi Token Plan',
    ])
    expect(view.groups[0]!.models[0]).toMatchObject({
      provider: 'deepseek',
      id: 'deepseek-chat',
      isCurrent: true,
      isDefault: false,
      catalogued: true,
      routable: true,
    })
    expect(view.groups[1]!.models[0]).toMatchObject({
      provider: 'xiaomi',
      id: 'mimo-v2.5-pro',
      isCurrent: false,
      isDefault: true,
    })
    expect(view.selectedModel).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('keeps an unlisted current model visible and stable across catalog reorder', () => {
    const initial = snapshot({
      current: {
        provider: 'deepseek',
        model: 'private/model',
        reasoningEffort: 'opaque/private',
      },
    })
    let state = openModelPicker(createModelPickerState(), initial)
    const initialView = selectModelPicker(state, initial)!
    expect(initialView.groups[0]!.models[0]).toMatchObject({
      id: 'private/model',
      isCurrent: true,
      catalogued: false,
      routable: true,
      retainedReasoningEffort: 'opaque/private',
    })
    expect(applyModelPickerAction(state, initial, { type: 'enter' }).outcome).toEqual({
      kind: 'selected',
      selection: {
        provider: 'deepseek',
        model: 'private/model',
        reasoningEffort: 'opaque/private',
      },
      saveDefault: false,
    })

    state = applyModelPickerAction(state, initial, { type: 'move-down' }).state
    const selected = selectModelPicker(state, initial)!.selectedModel
    const reordered = snapshot({
      current: initial.current!,
      groups: [...initial.groups].reverse(),
    })
    const reconciled = reconcileModelPicker(state, reordered)
    expect(selectModelPicker(reconciled, reordered)!.selectedModel).toEqual(selected)
  })

  it('retains current reasoning when listed metadata has no effort vocabulary', () => {
    const catalog = snapshot({
      current: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        reasoningEffort: 'opaque/current',
      },
    })
    const state = openModelPicker(createModelPickerState(), catalog)
    expect(selectModelPicker(state, catalog)!.groups[0]!.models[0]).toMatchObject({
      retainedReasoningEffort: 'opaque/current',
    })
    expect(applyModelPickerAction(state, catalog, { type: 'enter' }).outcome).toEqual({
      kind: 'selected',
      selection: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        reasoningEffort: 'opaque/current',
      },
      saveDefault: false,
    })
  })

  it('retains a listed default reasoning value when the current model is different', () => {
    const catalog = snapshot({
      current: { provider: 'deepseek', model: 'deepseek-reasoner' },
      defaultSelection: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        reasoningEffort: 'opaque/default',
      },
    })
    const view = selectModelPicker(
      openModelPicker(createModelPickerState(), catalog),
      catalog,
    )!
    expect(view.groups[0]!.models[0]).toMatchObject({
      isCurrent: false,
      isDefault: true,
      retainedReasoningEffort: 'opaque/default',
    })
  })

  it('moves from a model into adapter-owned reasoning and emits exact selections', () => {
    const catalog = snapshot()
    let state = openModelPicker(createModelPickerState(), catalog)
    state = applyModelPickerAction(state, catalog, { type: 'move-down' }).state

    const reasoning = applyModelPickerAction(state, catalog, { type: 'enter' })
    expect(reasoning.outcome).toBeUndefined()
    expect(reasoning.state.stage).toBe('reasoning')
    expect(selectModelPicker(reasoning.state, catalog)!.efforts).toEqual([
      { kind: 'effort', id: 'quick', name: 'Quick', isDefault: false },
      { kind: 'effort', id: 'thorough', name: 'Thorough', isDefault: true },
    ])

    const selected = applyModelPickerAction(reasoning.state, catalog, { type: 'enter' })
    expect(selected.outcome).toEqual({
      kind: 'selected',
      selection: {
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        reasoningEffort: 'thorough',
      },
      saveDefault: false,
    })
    expect(selected.state.open).toBe(false)
    expect(openModelPicker(selected.state, catalog).stage).toBe('models')
  })

  it('offers provider default when metadata has no default and supports Ctrl+S intent', () => {
    const catalog = snapshot()
    let state = openModelPicker(createModelPickerState(), catalog)
    state = applyModelPickerAction(state, catalog, { type: 'move-down' }).state
    state = applyModelPickerAction(state, catalog, { type: 'move-down' }).state
    const reasoning = applyModelPickerAction(state, catalog, { type: 'save-default' })
    expect(reasoning.outcome).toBeUndefined()
    expect(reasoning.state.stage).toBe('reasoning')
    state = reasoning.state

    const view = selectModelPicker(state, catalog)!
    expect(view.efforts[0]).toEqual({
      kind: 'provider-default',
      name: 'Provider default',
      isDefault: true,
    })
    const selected = applyModelPickerAction(state, catalog, { type: 'save-default' })
    expect(selected.outcome).toEqual({
      kind: 'selected',
      selection: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      saveDefault: true,
    })
  })

  it('blocks writes for external or unroutable Agents but retains navigation and refresh', () => {
    const readOnly = snapshot({
      writable: false,
      routable: false,
      loading: true,
      failures: [{ provider: 'xiaomi\u001b[2J', message: '目录失败\u0000' }],
      error: 'refresh failed',
    })
    const state = openModelPicker(createModelPickerState(), readOnly)
    expect(selectModelPicker(state, readOnly)).toMatchObject({
      writable: false,
      routable: false,
      loading: true,
      failures: readOnly.failures,
      error: 'refresh failed',
    })
    expect(applyModelPickerAction(state, readOnly, { type: 'enter' }).outcome)
      .toEqual({ kind: 'blocked', reason: 'read-only' })
    expect(applyModelPickerAction(state, readOnly, { type: 'refresh' }).outcome)
      .toEqual({ kind: 'refresh-requested' })
    expect(applyModelPickerAction(state, readOnly, { type: 'escape' }).outcome)
      .toEqual({ kind: 'cancelled' })
  })

  it('does not mistake synthetic groups for active Provider routes', () => {
    const unavailable = snapshot({
      current: { provider: 'offline', model: 'current' },
      defaultSelection: { provider: 'offline', model: 'future' },
      routable: false,
      groups: [],
    })
    const view = selectModelPicker(
      openModelPicker(createModelPickerState(), unavailable),
      unavailable,
    )!
    expect(view.groups[0]!.models).toEqual([
      expect.objectContaining({ id: 'current', routable: false }),
      expect.objectContaining({ id: 'future', routable: false }),
    ])
  })

  it('backs out of reasoning before closing and ignores actions while closed', () => {
    const catalog = snapshot()
    let state = openModelPicker(createModelPickerState(), catalog)
    state = applyModelPickerAction(state, catalog, { type: 'move-down' }).state
    state = applyModelPickerAction(state, catalog, { type: 'enter' }).state

    const back = applyModelPickerAction(state, catalog, { type: 'escape' })
    expect(back.state).toMatchObject({ open: true, stage: 'models' })
    expect(back.outcome).toBeUndefined()
    const closed = applyModelPickerAction(back.state, catalog, { type: 'escape' })
    expect(closed).toMatchObject({
      state: { open: false },
      outcome: { kind: 'cancelled' },
    })
    expect(selectModelPicker(closed.state, catalog)).toBeUndefined()
    expect(applyModelPickerAction(closed.state, catalog, { type: 'move-down' }))
      .toEqual({ state: closed.state })
  })

  it('handles empty, group-only, and default-only snapshots without inventing authority', () => {
    const empty: SessionModelSnapshot = {
      routable: false,
      writable: true,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
    }
    const emptyState = openModelPicker(createModelPickerState(), empty)
    expect(selectModelPicker(emptyState, empty)).toEqual({
      stage: 'models',
      groups: [],
      selectedModelIndex: -1,
      efforts: [],
      selectedEffortIndex: -1,
      routable: false,
      writable: true,
      loading: false,
      selecting: false,
      failures: [],
    })
    expect(applyModelPickerAction(emptyState, empty, { type: 'enter' }).outcome)
      .toEqual({ kind: 'blocked', reason: 'no-selection' })
    expect(applyModelPickerAction(emptyState, empty, { type: 'move-up' }).state)
      .toBe(emptyState)

    const groupOnly: SessionModelSnapshot = {
      ...empty,
      routable: true,
      groups: snapshot().groups.slice(0, 1),
    }
    const groupState = openModelPicker(createModelPickerState(), groupOnly)
    expect(selectModelPicker(groupState, groupOnly)!.selectedModel).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    const atTop = applyModelPickerAction(groupState, groupOnly, { type: 'move-up' })
    expect(atTop.state).toBe(groupState)
    const down = applyModelPickerAction(groupState, groupOnly, { type: 'move-down' }).state
    expect(applyModelPickerAction(down, groupOnly, { type: 'move-up' }).state)
      .toMatchObject({ selectedModelIndex: 0 })

    const defaultOnly: SessionModelSnapshot = {
      ...empty,
      defaultSelection: { provider: 'offline', model: 'future/model' },
    }
    const defaultView = selectModelPicker(
      openModelPicker(createModelPickerState(), defaultOnly),
      defaultOnly,
    )!
    expect(defaultView.groups[0]!.models[0]).toMatchObject({
      id: 'future/model',
      isDefault: true,
      routable: false,
    })
    expect(defaultView.selectedModel).toEqual(defaultOnly.defaultSelection)
  })

  it('preserves a live reasoning effort, descriptions, and stable effort selection', () => {
    const catalog = snapshot({
      current: {
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        reasoningEffort: 'quick',
      },
      groups: [{
        ...snapshot().groups[0]!,
        models: [
          snapshot().groups[0]!.models[0]!,
          {
            ...snapshot().groups[0]!.models[1]!,
            efforts: [
              {
                id: 'quick',
                name: 'Quick',
                description: 'Short reasoning',
                isDefault: false,
              },
              { id: 'thorough', name: 'Thorough', isDefault: true },
            ],
          },
        ],
      }],
    })
    let state = openModelPicker(createModelPickerState(), catalog)
    state = applyModelPickerAction(state, catalog, { type: 'enter' }).state
    let view = selectModelPicker(state, catalog)!
    expect(view.stage).toBe('reasoning')
    expect(view.selectedEffortIndex).toBe(0)
    expect(view.efforts[0]).toMatchObject({ description: 'Short reasoning' })
    expect(reconcileModelPicker(state, catalog)).toBe(state)
    expect(applyModelPickerAction(state, catalog, { type: 'move-up' }).state).toBe(state)

    state = applyModelPickerAction(state, catalog, { type: 'move-down' }).state
    view = selectModelPicker(state, catalog)!
    expect(view.selectedEffortIndex).toBe(1)
    state = applyModelPickerAction(state, catalog, { type: 'move-up' }).state
    expect(selectModelPicker(state, catalog)!.selectedEffortIndex).toBe(0)

    const unknownEffort = snapshot({
      current: {
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        reasoningEffort: 'removed-effort',
      },
    })
    const unknownState = applyModelPickerAction(
      openModelPicker(createModelPickerState(), unknownEffort),
      unknownEffort,
      { type: 'enter' },
    ).state
    expect(selectModelPicker(unknownState, unknownEffort)!.selectedEffortIndex).toBe(1)
  })

  it('distinguishes selecting, unroutable, and direct no-effort selection outcomes', () => {
    const busy = snapshot({ selecting: true })
    const busyState = openModelPicker(createModelPickerState(), busy)
    expect(applyModelPickerAction(busyState, busy, { type: 'enter' }).outcome)
      .toEqual({ kind: 'blocked', reason: 'selecting' })

    const unroutable = snapshot({ routable: false })
    const unroutableState = openModelPicker(createModelPickerState(), unroutable)
    expect(applyModelPickerAction(
      unroutableState,
      unroutable,
      { type: 'save-default' },
    ).outcome).toEqual({ kind: 'blocked', reason: 'unroutable' })

    const direct = applyModelPickerAction(
      openModelPicker(createModelPickerState(), snapshot()),
      snapshot(),
      { type: 'save-default' },
    )
    expect(direct.outcome).toEqual({
      kind: 'selected',
      selection: { provider: 'deepseek', model: 'deepseek-chat' },
      saveDefault: true,
    })
  })

  it('normalizes a closed reasoning state before reopening with or without identity', () => {
    const catalog = snapshot()
    const withoutIdentity = openModelPicker({
      open: false,
      stage: 'reasoning',
      selectedModelIndex: -1,
      selectedEffortIndex: -1,
    }, catalog)
    expect(withoutIdentity).toMatchObject({
      open: true,
      stage: 'models',
      selectedModelIndex: 0,
    })
    const withIdentity = openModelPicker({
      open: false,
      stage: 'reasoning',
      selectedModel: { provider: 'deepseek', model: 'deepseek-reasoner' },
      selectedModelIndex: 1,
      selectedEffortKey: 'effort:quick',
      selectedEffortIndex: 0,
    }, catalog)
    expect(withIdentity).toMatchObject({
      open: true,
      stage: 'models',
      selectedModel: { provider: 'deepseek', model: 'deepseek-reasoner' },
      selectedEffortIndex: -1,
    })

    const unstaged = reconcileModelPicker({
      open: true,
      stage: 'reasoning',
      selectedModel: { provider: 'deepseek', model: 'deepseek-reasoner' },
      selectedModelIndex: 1,
      selectedEffortIndex: -1,
    }, catalog)
    expect(unstaged).toMatchObject({
      stage: 'reasoning',
      selectedEffortKey: 'effort:thorough',
      selectedEffortIndex: 1,
    })

    const closed = createModelPickerState()
    expect(reconcileModelPicker(closed, catalog)).toBe(closed)
  })
})
