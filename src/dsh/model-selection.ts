import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import {
  ReasoningEffortId,
  type LlmRuntime,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
import type {
  DshModelCatalogEntry,
  DshModelProviderFailure,
  DshModelProviderGroup,
  DshModelReasoningEffort,
  DshTuiModelSelection,
  SessionModelPort,
  SessionModelSelectOptions,
  SessionModelSnapshot,
} from '../model/port.ts'

export type DshModelSelectionRef = ModelSelectionRef

interface SelectionEntry {
  readonly agent: Agent
  readonly ref: ModelSelectionRef
  readonly disposeRegistration: () => Promise<void>
  readonly ports: Set<DshSessionModelPort>
  selectionGeneration: number
  saveChain: Promise<void>
}

type AgentMutationSerializer = <T>(operation: () => Promise<T>) => Promise<T>

interface InternalModelState {
  current: DshTuiModelSelection | undefined
  defaultSelection: DshTuiModelSelection | undefined
  routable: boolean
  writable: boolean
  loading: boolean
  selecting: boolean
  groups: readonly DshModelProviderGroup[]
  failures: readonly DshModelProviderFailure[]
  error: string | undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function waitForAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function productSelection(
  selection: ModelSelection | DshTuiModelSelection | undefined,
): DshTuiModelSelection | undefined {
  if (selection === undefined) return undefined
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(selection.reasoningEffort) }),
  }
}

/** Convert at the sole product/Harness model-selection boundary. */
export function officialModelSelection(
  selection: DshTuiModelSelection | ModelSelection,
): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(String(selection.reasoningEffort)) }),
  }
}

function cloneEffort(effort: DshModelReasoningEffort): DshModelReasoningEffort {
  return {
    id: effort.id,
    name: effort.name,
    ...(effort.description === undefined ? {} : { description: effort.description }),
    isDefault: effort.isDefault,
  }
}

function cloneEntry(entry: DshModelCatalogEntry): DshModelCatalogEntry {
  return {
    provider: entry.provider,
    providerName: entry.providerName,
    id: entry.id,
    name: entry.name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    efforts: entry.efforts.map(cloneEffort),
  }
}

function cloneGroup(group: DshModelProviderGroup): DshModelProviderGroup {
  return {
    id: group.id,
    name: group.name,
    models: group.models.map(cloneEntry),
  }
}

/**
 * Own the one mutable selection ref installed into each DSH-TUI-origin Agent.
 * Exact live Agents created by another Host never receive another waterfall.
 */
export class DshModelSelectionHub {
  private readonly entries = new Map<Agent, SelectionEntry>()
  private readonly mutationChains = new WeakMap<Agent, Promise<void>>()
  private readonly ports = new Set<DshSessionModelPort>()
  private readonly drainingPorts = new Set<DshSessionModelPort>()
  private readonly stops: Array<() => void>
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(private readonly ctx: Context) {
    this.stops = [
      ctx.on('llm/adapters-updated', () => { this.invalidatePorts() }),
      ctx.on('settings/document-updated', () => { this.invalidatePorts() }),
    ]
  }

  install(
    agentCtx: Context,
    initial: ModelSelection | DshTuiModelSelection,
  ): ModelSelectionRef {
    if (this.disposed) throw new Error('DSH model selection Hub is disposed')
    const agent = agentCtx.agent
    if (agent === undefined) {
      throw new Error('DSH model selection setup did not expose its unpublished Agent')
    }
    if (this.entries.has(agent)) {
      throw new Error(`DSH model selection is already installed for "${agent.id}"`)
    }

    const ref: ModelSelectionRef = {
      current: officialModelSelection(initial),
      assembled: undefined,
    }
    const uninstall = installModelSelection(agentCtx, ref)
    let entry: SelectionEntry
    const disposeRegistration = agentCtx.effect(() => () => {
      this.entries.delete(agent)
      uninstall()
      for (const port of entry.ports) port.selectionChanged()
      entry.ports.clear()
    }, 'dsh-tui: model selection')
    entry = {
      agent,
      ref,
      disposeRegistration,
      ports: new Set(),
      selectionGeneration: 0,
      saveChain: Promise.resolve(),
    }
    this.entries.set(agent, entry)
    return ref
  }

  attach(agent: Agent): SessionModelPort {
    if (this.disposed) throw new Error('DSH model selection Hub is disposed')
    const ownedEntry = this.entries.get(agent)
    const selectionPorts = ownedEntry?.ports ?? new Set<DshSessionModelPort>()
    let port!: DshSessionModelPort
    port = new DshSessionModelPort(
      this.ctx,
      agent,
      () => this.entries.get(agent),
      () => {
        this.ports.delete(port)
        selectionPorts.delete(port)
        this.drainingPorts.add(port)
        void port.whenSettled().then(() => { this.drainingPorts.delete(port) })
      },
      () => {
        for (const peer of selectionPorts) {
          if (peer !== port) peer.selectionChanged()
        }
      },
      operation => this.serializeAgentMutation(agent, operation),
    )
    this.ports.add(port)
    selectionPorts.add(port)
    return port
  }

  /** Keep image admission and selection changes ordered for one exact Agent. */
  withStableModelSelection<T>(
    agent: Agent,
    operation: (selection: ModelSelection) => Promise<T>,
  ): Promise<T> {
    return this.serializeAgentMutation(agent, () => operation(this.readSelection(agent)))
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.disposePromise = (async () => {
      for (const stop of this.stops.splice(0).reverse()) stop()
      const ports = new Set([...this.ports, ...this.drainingPorts])
      for (const port of this.ports) port.disposeModels()
      await Promise.all([...ports].map(port => port.whenSettled()))
      await Promise.all(
        [...this.entries.values()].map(entry => entry.disposeRegistration()),
      )
    })()
    return this.disposePromise
  }

  private invalidatePorts(): void {
    for (const port of this.ports) port.invalidate()
  }

  private serializeAgentMutation<T>(agent: Agent, operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('DSH model selection Hub is disposed'))
    const result = (this.mutationChains.get(agent) ?? Promise.resolve()).then(operation)
    this.mutationChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  private readSelection(agent: Agent): ModelSelection {
    const owned = this.entries.get(agent)?.ref.current
    if (owned !== undefined) return officialModelSelection(owned)
    const config = agent.session.requestHeader()?.config
    if (config !== undefined) {
      return {
        provider: config.provider,
        model: config.model,
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: config.reasoningEffort }),
      }
    }
    const options = agent.options as Partial<ModelSelection>
    if (options.provider !== undefined && options.model !== undefined) {
      return officialModelSelection(options as ModelSelection)
    }
    const fallback = this.ctx.get('agentDefaultModel')?.currentSelection()
    if (fallback !== undefined) return officialModelSelection(fallback)
    throw new Error('Current model selection is unavailable')
  }
}

class DshSessionModelPort implements SessionModelPort {
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private state: InternalModelState
  private providerIds = new Set<string>()
  private refreshGeneration = 0
  private selectGeneration = 0
  private readonly operations = new Set<Promise<unknown>>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly selectionEntry: () => SelectionEntry | undefined,
    private readonly detach: () => void,
    private readonly notifyPeers: () => void,
    private readonly serializeMutation: AgentMutationSerializer,
  ) {
    const providers = this.readProviders()
    this.providerIds = new Set(providers.map(provider => provider.id))
    const current = this.readCurrent()
    this.state = {
      current,
      defaultSelection: this.readDefault(),
      routable: current !== undefined && this.providerIds.has(current.provider),
      writable: this.selectionEntry() !== undefined,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
      error: undefined,
    }
  }

  modelSnapshot(): SessionModelSnapshot {
    const current = this.readCurrent()
    const defaultSelection = this.readDefault()
    const snapshot: SessionModelSnapshot = {
      ...(current === undefined ? {} : { current: productSelection(current)! }),
      ...(defaultSelection === undefined
        ? {}
        : { defaultSelection: productSelection(defaultSelection)! }),
      routable: current !== undefined && this.providerIds.has(current.provider),
      writable: this.selectionEntry() !== undefined && !this.disposed,
      loading: this.state.loading,
      selecting: this.state.selecting,
      groups: this.state.groups.map(cloneGroup),
      failures: this.state.failures.map(failure => ({ ...failure })),
      ...(this.state.error === undefined ? {} : { error: this.state.error }),
    }
    return snapshot
  }

  refreshModels(signal?: AbortSignal): Promise<void> {
    return this.track(this.runRefreshModels(signal))
  }

  private async runRefreshModels(signal?: AbortSignal): Promise<void> {
    this.ensureOpen()
    signal?.throwIfAborted()
    const generation = ++this.refreshGeneration
    const operationSignal = signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([signal, this.lifetime.signal])
    let providers: readonly LlmProviderInfo[]
    try {
      providers = this.requireLlm().listProviders()
    } catch (error: unknown) {
      this.updateState({ loading: false, error: messageOf(error) })
      throw error
    }
    this.providerIds = new Set(providers.map(provider => provider.id))
    this.updateState({ loading: true, error: undefined })

    try {
      const loaded = await Promise.all(
        providers.map(provider => this.loadProvider(provider, operationSignal)),
      )
      operationSignal.throwIfAborted()
      if (generation !== this.refreshGeneration) return

      this.updateState({
        loading: false,
        groups: loaded.map(result => result.group),
        failures: loaded.flatMap(result => result.failures),
        error: undefined,
      })
    } catch (error: unknown) {
      if (generation === this.refreshGeneration && !this.disposed) {
        this.updateState({ loading: false })
      }
      throw error
    }
  }

  selectModel(
    selection: DshTuiModelSelection,
    options: SessionModelSelectOptions = {},
  ): Promise<void> {
    return this.track(this.runSelectModel(selection, options))
  }

  private async runSelectModel(
    selection: DshTuiModelSelection,
    options: SessionModelSelectOptions,
  ): Promise<void> {
    this.ensureOpen()
    if (selection.provider.length === 0 || selection.model.length === 0) {
      throw new Error('DSH model selection needs a non-empty provider and model')
    }
    const entry = this.selectionEntry()
    if (entry === undefined) {
      throw new Error('This Agent model is managed by another Host')
    }
    options.signal?.throwIfAborted()
    const generation = ++this.selectGeneration
    const selectionGeneration = ++entry.selectionGeneration
    const operationSignal = options.signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([options.signal, this.lifetime.signal])
    const candidate = officialModelSelection(selection)
    this.updateState({ selecting: true, error: undefined })

    try {
      const resolved = await waitForAbort(
        this.requireLlm().resolveCallConfig(candidate, operationSignal),
        operationSignal,
      )
      const accepted = await this.serializeMutation(async () => {
        operationSignal.throwIfAborted()
        if (generation !== this.selectGeneration) return undefined
        if (selectionGeneration !== entry.selectionGeneration) {
          throw new Error('DSH model selection was superseded by another exact-Agent binding')
        }
        this.assertExactSelectionEntry(entry)
        const accepted = officialModelSelection(resolved)

        entry.ref.current = accepted
        this.updateState({
          current: productSelection(accepted),
          routable: this.providerIds.has(accepted.provider),
          selecting: options.saveDefault === true,
          error: undefined,
        })
        this.notifyPeers()
        return accepted
      })
      if (accepted === undefined || options.saveDefault !== true) return

      this.assertExactSelectionEntry(entry)
      const defaultModel = this.ctx.get('agentDefaultModel')
      if (defaultModel === undefined) {
        throw new Error('DSH default-model service is unavailable')
      }
      const save = entry.saveChain.catch(() => {}).then(
        () => defaultModel.saveSelection(accepted),
      )
      entry.saveChain = this.track(save)
      await waitForAbort(save, operationSignal)
      this.assertExactSelectionEntry(entry)
      if (generation === this.selectGeneration && !this.disposed) {
        this.updateState({
          defaultSelection: productSelection(accepted),
          selecting: false,
          error: undefined,
        })
        this.notifyPeers()
      }
    } catch (error: unknown) {
      if (generation === this.selectGeneration && !this.disposed) {
        this.updateState({
          selecting: false,
          ...(operationSignal.aborted ? {} : { error: messageOf(error) }),
        })
      }
      throw error
    }
  }

  onModelsChanged(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  disposeModels(): void {
    if (this.disposed) return
    this.disposed = true
    this.refreshGeneration += 1
    this.selectGeneration += 1
    this.lifetime.abort(new Error('DSH Session model port disposed'))
    this.listeners.clear()
    this.detach()
  }

  invalidate(): void {
    void this.refreshModels().catch(() => {})
  }

  async whenSettled(): Promise<void> {
    await Promise.allSettled([...this.operations])
  }

  selectionChanged(): void {
    this.updateState({})
  }

  private async loadProvider(
    provider: LlmProviderInfo,
    signal: AbortSignal,
  ): Promise<{
      readonly group: DshModelProviderGroup
      readonly failures: readonly DshModelProviderFailure[]
    }> {
    const llm = this.requireLlm()
    let models: readonly LlmModelInfo[]
    try {
      models = await waitForAbort(llm.listModels(provider.id), signal)
    } catch (error: unknown) {
      const previous = this.state.groups.find(group => group.id === provider.id)
      return {
        group: previous === undefined
          ? { id: provider.id, name: provider.name, models: [] }
          : { id: provider.id, name: provider.name, models: previous.models },
        failures: [{ provider: provider.id, message: messageOf(error) }],
      }
    }
    signal.throwIfAborted()

    const resolved = await Promise.all(models.map(async (model) => {
      try {
        const info = await waitForAbort(
          llm.resolveModelInfo(provider.id, model.id, signal),
          signal,
        )
        return { entry: this.catalogEntry(provider, model, info) }
      } catch (error: unknown) {
        const previous = this.state.groups
          .find(group => group.id === provider.id)
          ?.models.find(entry => entry.id === model.id)
        return {
          entry: previous ?? this.catalogEntry(provider, model),
          failure: `${model.id}: ${messageOf(error)}`,
        }
      }
    }))
    signal.throwIfAborted()
    const failures = resolved
      .flatMap(result => result.failure === undefined ? [] : [result.failure])
    return {
      group: {
        id: provider.id,
        name: provider.name,
        models: resolved.map(result => result.entry),
      },
      failures: failures.length === 0
        ? []
        : [{ provider: provider.id, message: failures.join('; ') }],
    }
  }

  private catalogEntry(
    provider: LlmProviderInfo,
    model: LlmModelInfo,
    resolved?: LlmResolvedModelInfo,
  ): DshModelCatalogEntry {
    const efforts = resolved?.reasoning?.efforts.map(effort => ({
      id: String(effort.id),
      name: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
      isDefault: resolved.reasoning?.defaultEffort === effort.id,
    })) ?? []
    return {
      provider: provider.id,
      providerName: provider.name,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      efforts,
    }
  }

  private readCurrent(): DshTuiModelSelection | undefined {
    const selected = this.selectionEntry()?.ref.current
    if (selected !== undefined) return productSelection(selected)
    const config = this.agent.session.requestHeader()?.config
    if (config === undefined) return undefined
    return productSelection({
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: config.reasoningEffort }),
    })
  }

  private readDefault(): DshTuiModelSelection | undefined {
    return productSelection(this.ctx.get('agentDefaultModel')?.currentSelection())
  }

  private readProviders(): readonly LlmProviderInfo[] {
    try {
      return this.ctx.get('llm')?.listProviders() ?? []
    } catch {
      return []
    }
  }

  private requireLlm(): LlmRuntime {
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new Error('DSH LLM service is unavailable')
    return llm
  }

  private assertExactAgent(): void {
    const agents = this.ctx.get('agents')
    if (agents !== undefined && agents.get(this.agent.id) !== this.agent) {
      throw new Error('DSH exact Agent changed during model validation')
    }
  }

  private assertExactSelectionEntry(entry: SelectionEntry): void {
    if (this.selectionEntry() !== entry) {
      throw new Error('DSH exact Agent model selection scope changed during validation')
    }
    this.assertExactAgent()
  }

  private ensureOpen(): void {
    if (this.disposed) throw new Error('DSH Session model port is disposed')
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(
      () => { this.operations.delete(operation) },
      () => { this.operations.delete(operation) },
    )
    return operation
  }

  private updateState(patch: Partial<InternalModelState>): void {
    if (this.disposed) return
    this.state = {
      ...this.state,
      ...patch,
      current: this.readCurrent(),
      defaultSelection: this.readDefault(),
    }
    const current = this.state.current
    this.state.routable = current !== undefined && this.providerIds.has(current.provider)
    this.state.writable = this.selectionEntry() !== undefined
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A view observer cannot veto catalog or selection state.
      }
    }
  }
}
