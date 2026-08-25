import type {
  DshModelCatalogEntry,
  DshModelProviderFailure,
  DshTuiModelSelection,
  SessionModelSnapshot,
} from './port.ts'

export type ModelPickerStage = 'models' | 'reasoning'

export interface ModelPickerState {
  readonly open: boolean
  readonly stage: ModelPickerStage
  readonly selectedModel?: DshTuiModelSelection
  /** Absolute index across all model rows, excluding provider headings. */
  readonly selectedModelIndex: number
  readonly selectedEffortKey?: string
  readonly selectedEffortIndex: number
}

export interface ModelPickerModelRow extends DshModelCatalogEntry {
  readonly retainedReasoningEffort?: string
  readonly isCurrent: boolean
  readonly isDefault: boolean
  readonly catalogued: boolean
  readonly routable: boolean
}

export interface ModelPickerProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelPickerModelRow[]
}

export type ModelPickerEffortRow =
  | {
      readonly kind: 'provider-default'
      readonly name: 'Provider default'
      readonly isDefault: true
    }
  | {
      readonly kind: 'effort'
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly isDefault: boolean
    }

export interface ModelPickerView {
  readonly stage: ModelPickerStage
  readonly groups: readonly ModelPickerProviderGroup[]
  readonly selectedModel?: DshTuiModelSelection
  readonly selectedModelIndex: number
  readonly efforts: readonly ModelPickerEffortRow[]
  readonly selectedEffortIndex: number
  readonly current?: DshTuiModelSelection
  readonly defaultSelection?: DshTuiModelSelection
  readonly routable: boolean
  readonly writable: boolean
  readonly loading: boolean
  readonly selecting: boolean
  readonly failures: readonly DshModelProviderFailure[]
  readonly error?: string
}

export type ModelPickerAction =
  | { readonly type: 'move-up' }
  | { readonly type: 'move-down' }
  | { readonly type: 'enter' }
  | { readonly type: 'save-default' }
  | { readonly type: 'refresh' }
  | { readonly type: 'escape' }

export type ModelPickerOutcome =
  | {
      readonly kind: 'selected'
      readonly selection: DshTuiModelSelection
      readonly saveDefault: boolean
    }
  | {
      readonly kind: 'blocked'
      readonly reason: 'read-only' | 'unroutable' | 'selecting' | 'no-selection'
    }
  | { readonly kind: 'refresh-requested' }
  | { readonly kind: 'cancelled' }

export interface ModelPickerTransition {
  readonly state: ModelPickerState
  readonly outcome?: ModelPickerOutcome
}

function sameModel(
  left: DshTuiModelSelection | undefined,
  right: DshTuiModelSelection | undefined,
): boolean {
  return left?.provider === right?.provider && left?.model === right?.model
}

function rowSelection(row: ModelPickerModelRow): DshTuiModelSelection {
  return Object.freeze({
    provider: row.provider,
    model: row.id,
    ...(row.retainedReasoningEffort === undefined
      ? {}
      : { reasoningEffort: row.retainedReasoningEffort }),
  })
}

function syntheticEntry(
  selection: DshTuiModelSelection,
  routable: boolean,
  snapshot: SessionModelSnapshot,
): ModelPickerModelRow {
  return Object.freeze({
    provider: selection.provider,
    providerName: selection.provider,
    id: selection.model,
    name: selection.model,
    efforts: Object.freeze([]),
    ...(selection.reasoningEffort === undefined
      ? {}
      : { retainedReasoningEffort: selection.reasoningEffort }),
    isCurrent: sameModel(selection, snapshot.current),
    isDefault: sameModel(selection, snapshot.defaultSelection),
    catalogued: false,
    routable,
  })
}

function projectEntry(
  entry: DshModelCatalogEntry,
  snapshot: SessionModelSnapshot,
): ModelPickerModelRow {
  const selection = { provider: entry.provider, model: entry.id }
  const isCurrent = sameModel(selection, snapshot.current)
  const isDefault = sameModel(selection, snapshot.defaultSelection)
  const retainedReasoningEffort = entry.efforts.length === 0
    ? isCurrent
      ? snapshot.current?.reasoningEffort
      : isDefault
        ? snapshot.defaultSelection?.reasoningEffort
        : undefined
    : undefined
  return Object.freeze({
    ...entry,
    ...(retainedReasoningEffort === undefined ? {} : { retainedReasoningEffort }),
    isCurrent,
    isDefault,
    catalogued: true,
    routable: isCurrent ? snapshot.routable : true,
  })
}

function findRow(
  groups: readonly ModelPickerProviderGroup[],
  selection: DshTuiModelSelection,
): ModelPickerModelRow | undefined {
  for (const group of groups) {
    const row = group.models.find(model => (
      model.provider === selection.provider && model.id === selection.model
    ))
    if (row !== undefined) return row
  }
  return undefined
}

function insertSynthetic(
  groups: ModelPickerProviderGroup[],
  selection: DshTuiModelSelection | undefined,
  snapshot: SessionModelSnapshot,
  placement: 'first' | 'last',
  activeProviders: ReadonlySet<string>,
): void {
  if (selection === undefined || findRow(groups, selection) !== undefined) return
  const groupIndex = groups.findIndex(group => group.id === selection.provider)
  const current = sameModel(selection, snapshot.current)
  const routable = current
    ? snapshot.routable
    : activeProviders.has(selection.provider)
  const row = syntheticEntry(selection, routable, snapshot)
  if (groupIndex >= 0) {
    const group = groups[groupIndex]!
    groups[groupIndex] = Object.freeze({
      ...group,
      models: Object.freeze(placement === 'first'
        ? [row, ...group.models]
        : [...group.models, row]),
    })
    return
  }
  const group = Object.freeze({
    id: selection.provider,
    name: selection.provider,
    models: Object.freeze([row]),
  })
  if (placement === 'first') groups.unshift(group)
  else groups.push(group)
}

function projectGroups(snapshot: SessionModelSnapshot): readonly ModelPickerProviderGroup[] {
  const activeProviders = new Set([
    ...snapshot.groups.map(group => group.id),
    ...snapshot.failures.map(failure => failure.provider),
  ])
  const groups: ModelPickerProviderGroup[] = snapshot.groups.map(group => Object.freeze({
    id: group.id,
    name: group.name,
    models: Object.freeze(group.models.map(model => projectEntry(model, snapshot))),
  }))
  insertSynthetic(groups, snapshot.current, snapshot, 'first', activeProviders)
  insertSynthetic(groups, snapshot.defaultSelection, snapshot, 'last', activeProviders)
  return Object.freeze(groups)
}

function flatModels(
  groups: readonly ModelPickerProviderGroup[],
): readonly ModelPickerModelRow[] {
  return groups.flatMap(group => group.models)
}

function clampedIndex(index: number, count: number): number {
  if (count === 0) return -1
  return Math.min(count - 1, Math.max(0, index))
}

function preferredModelIndex(
  models: readonly ModelPickerModelRow[],
  snapshot: SessionModelSnapshot,
): number {
  const current = snapshot.current === undefined
    ? -1
    : models.findIndex(row => sameModel(rowSelection(row), snapshot.current))
  if (current >= 0) return current
  const fallback = snapshot.defaultSelection === undefined
    ? -1
    : models.findIndex(row => sameModel(rowSelection(row), snapshot.defaultSelection))
  return fallback >= 0 ? fallback : clampedIndex(0, models.length)
}

function effortKey(row: ModelPickerEffortRow): string {
  return row.kind === 'provider-default' ? 'provider-default' : `effort:${row.id}`
}

function effortRows(model: ModelPickerModelRow): readonly ModelPickerEffortRow[] {
  const hasDefault = model.efforts.some(effort => effort.isDefault)
  const rows: ModelPickerEffortRow[] = hasDefault
    ? []
    : [{ kind: 'provider-default', name: 'Provider default', isDefault: true }]
  for (const effort of model.efforts) {
    rows.push(Object.freeze({
      kind: 'effort',
      id: effort.id,
      name: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
      isDefault: effort.isDefault,
    }))
  }
  return Object.freeze(rows)
}

function preferredEffortIndex(
  rows: readonly ModelPickerEffortRow[],
  model: ModelPickerModelRow,
  snapshot: SessionModelSnapshot,
): number {
  if (sameModel(rowSelection(model), snapshot.current)
    && snapshot.current?.reasoningEffort !== undefined) {
    const current = rows.findIndex(row => (
      row.kind === 'effort' && row.id === snapshot.current?.reasoningEffort
    ))
    if (current >= 0) return current
  }
  const adapterDefault = rows.findIndex(row => row.isDefault)
  /* effortRows() always materializes either an adapter default or Provider default. */
  return adapterDefault
}

function stateAt(
  open: boolean,
  stage: ModelPickerStage,
  models: readonly ModelPickerModelRow[],
  modelIndex: number,
  effortRowsForModel: readonly ModelPickerEffortRow[],
  effortIndex: number,
): ModelPickerState {
  const model = models[modelIndex]
  const effort = effortRowsForModel[effortIndex]
  return Object.freeze({
    open,
    stage,
    ...(model === undefined ? {} : { selectedModel: rowSelection(model) }),
    selectedModelIndex: model === undefined ? -1 : modelIndex,
    ...(effort === undefined ? {} : { selectedEffortKey: effortKey(effort) }),
    selectedEffortIndex: effort === undefined ? -1 : effortIndex,
  })
}

function sameState(left: ModelPickerState, right: ModelPickerState): boolean {
  return left.open === right.open
    && left.stage === right.stage
    && sameModel(left.selectedModel, right.selectedModel)
    && left.selectedModelIndex === right.selectedModelIndex
    && left.selectedEffortKey === right.selectedEffortKey
    && left.selectedEffortIndex === right.selectedEffortIndex
}

export function createModelPickerState(): ModelPickerState {
  return Object.freeze({
    open: false,
    stage: 'models',
    selectedModelIndex: -1,
    selectedEffortIndex: -1,
  })
}

function reconciledState(
  state: ModelPickerState,
  snapshot: SessionModelSnapshot,
  forceOpen: boolean,
): ModelPickerState {
  const groups = projectGroups(snapshot)
  const models = flatModels(groups)
  const stableIndex = state.selectedModel === undefined
    ? -1
    : models.findIndex(row => sameModel(rowSelection(row), state.selectedModel))
  const selectedIndex = stableIndex >= 0
    ? stableIndex
    : preferredModelIndex(models, snapshot)
  const selected = models[selectedIndex]
  const efforts = selected === undefined ? [] : effortRows(selected)
  const stage = state.stage === 'reasoning' && selected?.efforts.length !== 0
    ? 'reasoning'
    : 'models'
  const stableEffortIndex = state.selectedEffortKey === undefined
    ? -1
    : efforts.findIndex(row => effortKey(row) === state.selectedEffortKey)
  const selectedEffortIndex = stage === 'reasoning'
    ? stableEffortIndex >= 0
      ? stableEffortIndex
      : preferredEffortIndex(efforts, selected!, snapshot)
    : -1
  const next = stateAt(
    forceOpen || state.open,
    stage,
    models,
    selectedIndex,
    efforts,
    selectedEffortIndex,
  )
  return sameState(state, next) ? state : next
}

export function openModelPicker(
  state: ModelPickerState,
  snapshot: SessionModelSnapshot,
): ModelPickerState {
  const opening = !state.open && state.stage === 'reasoning'
    ? Object.freeze({
        open: false,
        stage: 'models' as const,
        ...(state.selectedModel === undefined ? {} : { selectedModel: state.selectedModel }),
        selectedModelIndex: state.selectedModelIndex,
        selectedEffortIndex: -1,
      })
    : state
  return reconciledState(opening, snapshot, true)
}

export function reconcileModelPicker(
  state: ModelPickerState,
  snapshot: SessionModelSnapshot,
): ModelPickerState {
  return state.open ? reconciledState(state, snapshot, false) : state
}

export function selectModelPicker(
  state: ModelPickerState,
  snapshot: SessionModelSnapshot,
): ModelPickerView | undefined {
  if (!state.open) return undefined
  const reconciled = reconcileModelPicker(state, snapshot)
  const groups = projectGroups(snapshot)
  const models = flatModels(groups)
  const selected = models[reconciled.selectedModelIndex]
  const efforts = reconciled.stage === 'reasoning' && selected !== undefined
    ? effortRows(selected)
    : Object.freeze([])
  return Object.freeze({
    stage: reconciled.stage,
    groups,
    ...(reconciled.selectedModel === undefined
      ? {}
      : { selectedModel: reconciled.selectedModel }),
    selectedModelIndex: reconciled.selectedModelIndex,
    efforts,
    selectedEffortIndex: reconciled.selectedEffortIndex,
    ...(snapshot.current === undefined ? {} : { current: snapshot.current }),
    ...(snapshot.defaultSelection === undefined
      ? {}
      : { defaultSelection: snapshot.defaultSelection }),
    routable: snapshot.routable,
    writable: snapshot.writable,
    loading: snapshot.loading,
    selecting: snapshot.selecting,
    failures: snapshot.failures,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  })
}

function move(
  state: ModelPickerState,
  snapshot: SessionModelSnapshot,
  direction: 'up' | 'down',
): ModelPickerState {
  const groups = projectGroups(snapshot)
  const models = flatModels(groups)
  if (state.stage === 'models') {
    const delta = direction === 'up' ? -1 : 1
    const index = clampedIndex(state.selectedModelIndex + delta, models.length)
    if (index === state.selectedModelIndex) return state
    return stateAt(true, 'models', models, index, [], -1)
  }
  const selected = models[state.selectedModelIndex]!
  const efforts = effortRows(selected)
  const delta = direction === 'up' ? -1 : 1
  const effortIndex = clampedIndex(state.selectedEffortIndex + delta, efforts.length)
  if (effortIndex === state.selectedEffortIndex) return state
  return stateAt(true, 'reasoning', models, state.selectedModelIndex, efforts, effortIndex)
}

function selectedOutcome(
  state: ModelPickerState,
  snapshot: SessionModelSnapshot,
  saveDefault: boolean,
): ModelPickerTransition {
  if (snapshot.selecting) {
    return { state, outcome: { kind: 'blocked', reason: 'selecting' } }
  }
  if (!snapshot.writable) {
    return { state, outcome: { kind: 'blocked', reason: 'read-only' } }
  }
  const models = flatModels(projectGroups(snapshot))
  const model = models[state.selectedModelIndex]
  if (model === undefined) {
    return { state, outcome: { kind: 'blocked', reason: 'no-selection' } }
  }
  if (!model.routable) {
    return { state, outcome: { kind: 'blocked', reason: 'unroutable' } }
  }
  if (state.stage === 'models' && model.efforts.length > 0) {
    const efforts = effortRows(model)
    const effortIndex = preferredEffortIndex(efforts, model, snapshot)
    return {
      state: stateAt(
        true,
        'reasoning',
        models,
        state.selectedModelIndex,
        efforts,
        effortIndex,
      ),
    }
  }
  const effort = state.stage === 'reasoning'
    ? effortRows(model)[state.selectedEffortIndex]
    : undefined
  const selection = Object.freeze({
    ...rowSelection(model),
    ...(effort?.kind === 'effort' ? { reasoningEffort: effort.id } : {}),
  })
  return {
    state: Object.freeze({
      open: false,
      stage: 'models',
      selectedModel: rowSelection(model),
      selectedModelIndex: state.selectedModelIndex,
      selectedEffortIndex: -1,
    }),
    outcome: { kind: 'selected', selection, saveDefault },
  }
}

export function applyModelPickerAction(
  state: ModelPickerState,
  snapshot: SessionModelSnapshot,
  action: ModelPickerAction,
): ModelPickerTransition {
  if (!state.open) return { state }
  const reconciled = reconcileModelPicker(state, snapshot)
  switch (action.type) {
    case 'move-up':
      return { state: move(reconciled, snapshot, 'up') }
    case 'move-down':
      return { state: move(reconciled, snapshot, 'down') }
    case 'refresh':
      return { state: reconciled, outcome: { kind: 'refresh-requested' } }
    case 'escape':
      return reconciled.stage === 'reasoning'
        ? {
            state: Object.freeze({
              open: true,
              stage: 'models',
              selectedModel: reconciled.selectedModel!,
              selectedModelIndex: reconciled.selectedModelIndex,
              selectedEffortIndex: -1,
            }),
          }
        : {
            state: Object.freeze({ ...reconciled, open: false }),
            outcome: { kind: 'cancelled' },
          }
    case 'enter':
      return selectedOutcome(reconciled, snapshot, false)
    case 'save-default':
      return selectedOutcome(reconciled, snapshot, true)
  }
}
