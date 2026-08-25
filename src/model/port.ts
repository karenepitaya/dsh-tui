/** Product-owned model route; Harness brand types stay behind `src/dsh/`. */
export interface DshTuiModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface DshModelReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly isDefault: boolean
}

export interface DshModelCatalogEntry {
  readonly provider: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly efforts: readonly DshModelReasoningEffort[]
}

export interface DshModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly DshModelCatalogEntry[]
}

export interface DshModelProviderFailure {
  readonly provider: string
  readonly message: string
}

/** Detached view of one exact Agent's model capability and advisory catalog. */
export interface SessionModelSnapshot {
  readonly current?: DshTuiModelSelection
  readonly defaultSelection?: DshTuiModelSelection
  readonly routable: boolean
  readonly writable: boolean
  readonly loading: boolean
  readonly selecting: boolean
  readonly groups: readonly DshModelProviderGroup[]
  readonly failures: readonly DshModelProviderFailure[]
  readonly error?: string
}

export interface SessionModelSelectOptions {
  readonly saveDefault?: boolean
  readonly signal?: AbortSignal
}

/** Model controls composed into one live DSH-TUI Session lease. */
export interface SessionModelPort {
  modelSnapshot(): SessionModelSnapshot
  refreshModels(signal?: AbortSignal): Promise<void>
  selectModel(
    selection: DshTuiModelSelection,
    options?: SessionModelSelectOptions,
  ): Promise<void>
  onModelsChanged(listener: () => void): () => void
  disposeModels(): void
}

const UNAVAILABLE_SNAPSHOT: SessionModelSnapshot = Object.freeze({
  routable: false,
  writable: false,
  loading: false,
  selecting: false,
  groups: Object.freeze([]),
  failures: Object.freeze([]),
})

/** Compatibility seam for tests/embedders that have not composed a model owner. */
export function createUnavailableSessionModelPort(): SessionModelPort {
  return {
    modelSnapshot: () => UNAVAILABLE_SNAPSHOT,
    refreshModels: () => Promise.resolve(),
    selectModel: () => Promise.reject(
      new Error('DSH model selection is unavailable for this Session'),
    ),
    onModelsChanged: () => () => {},
    disposeModels: () => {},
  }
}
