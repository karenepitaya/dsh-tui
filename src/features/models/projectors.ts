import type {
  DshModelCatalogEntry,
  DshModelReasoningEffort,
  DshTuiModelSelection,
  SessionModelSnapshot,
} from '../../model/port.ts'

export interface ModelsChoice {
  readonly key: string
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly modelName: string
  readonly reasoningEffort?: string
  readonly reasoningEffortName: string
  readonly description?: string
  readonly catalogued: boolean
  readonly routable: boolean
  readonly isCurrent: boolean
  readonly isDefault: boolean
  readonly isReasoningDefault: boolean
}

function detachSelection(
  selection: DshTuiModelSelection | undefined,
): DshTuiModelSelection | undefined {
  if (selection === undefined) return undefined
  return Object.freeze({
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
  })
}

function detachEffort(effort: DshModelReasoningEffort): DshModelReasoningEffort {
  return Object.freeze({
    id: effort.id,
    name: effort.name,
    ...(effort.description === undefined ? {} : { description: effort.description }),
    isDefault: effort.isDefault,
  })
}

function detachEntry(entry: DshModelCatalogEntry): DshModelCatalogEntry {
  return Object.freeze({
    provider: entry.provider,
    providerName: entry.providerName,
    id: entry.id,
    name: entry.name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    efforts: Object.freeze(entry.efforts.map(detachEffort)),
  })
}

/** Detach adapter-owned arrays and objects before retaining them as Feature state. */
export function detachModelsSnapshot(snapshot: SessionModelSnapshot): SessionModelSnapshot {
  const current = detachSelection(snapshot.current)
  const defaultSelection = detachSelection(snapshot.defaultSelection)
  return Object.freeze({
    ...(current === undefined ? {} : { current }),
    ...(defaultSelection === undefined ? {} : { defaultSelection }),
    routable: snapshot.routable,
    writable: snapshot.writable,
    loading: snapshot.loading,
    selecting: snapshot.selecting,
    groups: Object.freeze(snapshot.groups.map(group => Object.freeze({
      id: group.id,
      name: group.name,
      models: Object.freeze(group.models.map(detachEntry)),
    }))),
    failures: Object.freeze(snapshot.failures.map(failure => Object.freeze({
      provider: failure.provider,
      message: failure.message,
    }))),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  })
}

export function modelsChoiceKey(selection: DshTuiModelSelection): string {
  return JSON.stringify([
    selection.provider,
    selection.model,
    selection.reasoningEffort ?? null,
  ])
}

function sameSelection(
  left: DshTuiModelSelection | undefined,
  right: DshTuiModelSelection,
): boolean {
  return left?.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

function sameModel(
  left: DshTuiModelSelection | undefined,
  provider: string,
  model: string,
): boolean {
  return left?.provider === provider && left.model === model
}

function choice(
  entry: DshModelCatalogEntry,
  snapshot: SessionModelSnapshot,
  effort: DshModelReasoningEffort | undefined,
  retainedEffort: string | undefined,
): ModelsChoice {
  const reasoningEffort = effort?.id ?? retainedEffort
  const selection: DshTuiModelSelection = {
    provider: entry.provider,
    model: entry.id,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
  const isCurrent = sameSelection(snapshot.current, selection)
  return Object.freeze({
    key: modelsChoiceKey(selection),
    provider: entry.provider,
    providerName: entry.providerName,
    model: entry.id,
    modelName: entry.name,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    reasoningEffortName: effort?.name ?? retainedEffort ?? 'Provider default',
    ...(effort?.description === undefined
      ? entry.description === undefined ? {} : { description: entry.description }
      : { description: effort.description }),
    catalogued: true,
    routable: isCurrent ? snapshot.routable : true,
    isCurrent,
    isDefault: sameSelection(snapshot.defaultSelection, selection),
    isReasoningDefault: effort?.isDefault ?? true,
  })
}

function catalogEntry(
  snapshot: SessionModelSnapshot,
  selection: DshTuiModelSelection,
): DshModelCatalogEntry | undefined {
  return snapshot.groups
    .flatMap(group => group.models)
    .find(entry => entry.provider === selection.provider && entry.id === selection.model)
}

function shouldRetainSelection(
  snapshot: SessionModelSnapshot,
  selection: DshTuiModelSelection,
): boolean {
  const entry = catalogEntry(snapshot, selection)
  if (entry === undefined) return true
  if (selection.reasoningEffort === undefined) return false
  return !entry.efforts.some(effort => effort.id === selection.reasoningEffort)
}

function retainedChoice(
  snapshot: SessionModelSnapshot,
  selection: DshTuiModelSelection,
  activeProviders: ReadonlySet<string>,
): ModelsChoice {
  const entry = catalogEntry(snapshot, selection)
  const isCurrent = sameSelection(snapshot.current, selection)
  return Object.freeze({
    key: modelsChoiceKey(selection),
    provider: selection.provider,
    providerName: entry?.providerName ?? selection.provider,
    model: selection.model,
    modelName: entry?.name ?? selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
    reasoningEffortName: selection.reasoningEffort ?? 'Provider default',
    ...(entry?.description === undefined ? {} : { description: entry.description }),
    catalogued: false,
    routable: isCurrent ? snapshot.routable : activeProviders.has(selection.provider),
    isCurrent,
    isDefault: sameSelection(snapshot.defaultSelection, selection),
    isReasoningDefault: selection.reasoningEffort === undefined,
  })
}

function choicesForEntry(
  entry: DshModelCatalogEntry,
  snapshot: SessionModelSnapshot,
): readonly ModelsChoice[] {
  if (entry.efforts.length === 0) {
    const retainedEffort = sameModel(snapshot.current, entry.provider, entry.id)
      ? snapshot.current?.reasoningEffort
      : sameModel(snapshot.defaultSelection, entry.provider, entry.id)
        ? snapshot.defaultSelection?.reasoningEffort
        : undefined
    return [choice(entry, snapshot, undefined, retainedEffort)]
  }
  const providerDefault = entry.efforts.some(effort => effort.isDefault)
    ? []
    : [choice(entry, snapshot, undefined, undefined)]
  return [...providerDefault, ...entry.efforts.map(effort => (
    choice(entry, snapshot, effort, undefined)
  ))]
}

/** Flatten catalog routes while retaining exact current/default state as guarded rows. */
export function projectModelsChoices(
  snapshot: SessionModelSnapshot | undefined,
): readonly ModelsChoice[] {
  if (snapshot === undefined) return Object.freeze([])
  const catalogued = snapshot.groups.flatMap(group => (
    group.models.flatMap(entry => choicesForEntry(entry, snapshot))
  ))
  const activeProviders = new Set([
    ...snapshot.groups.map(group => group.id),
    ...snapshot.failures.map(failure => failure.provider),
  ])
  const choices: ModelsChoice[] = []
  const keys = new Set(catalogued.map(candidate => candidate.key))
  const current = snapshot.current
  if (
    current !== undefined
    && !keys.has(modelsChoiceKey(current))
    && shouldRetainSelection(snapshot, current)
  ) {
    const retained = retainedChoice(snapshot, current, activeProviders)
    choices.push(retained)
    keys.add(retained.key)
  }
  choices.push(...catalogued)
  const defaultSelection = snapshot.defaultSelection
  if (
    defaultSelection !== undefined
    && !keys.has(modelsChoiceKey(defaultSelection))
    && shouldRetainSelection(snapshot, defaultSelection)
  ) {
    choices.push(retainedChoice(snapshot, defaultSelection, activeProviders))
  }
  return Object.freeze(choices)
}

/** One catalog row per model; reasoning options remain a separate choice. */
export function projectModelRows(snapshot: SessionModelSnapshot | undefined): readonly ModelsChoice[] {
  const grouped = new Map<string, ModelsChoice[]>()
  for (const option of projectModelsChoices(snapshot)) {
    const key = JSON.stringify([option.provider, option.model])
    const group = grouped.get(key) ?? []
    group.push(option)
    grouped.set(key, group)
  }
  return Object.freeze([...grouped.values()].map(options => (
    options.find(option => option.isCurrent)
      ?? options.find(option => sameModel(snapshot!.current, option.provider, option.model) && option.isReasoningDefault)
      ?? options.find(option => option.isDefault)
      ?? options.find(option => option.isReasoningDefault)!
  )))
}

export function modelEffortChoices(
  snapshot: SessionModelSnapshot | undefined,
  model: ModelsChoice | undefined,
): readonly ModelsChoice[] {
  return projectModelsChoices(snapshot).filter(option => (
    option.provider === model?.provider && option.model === model.model
  ))
}

export function modelsChoiceSelection(choiceValue: ModelsChoice): DshTuiModelSelection {
  return Object.freeze({
    provider: choiceValue.provider,
    model: choiceValue.model,
    ...(choiceValue.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: choiceValue.reasoningEffort }),
  })
}
