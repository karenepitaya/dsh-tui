import { describe, expect, it } from 'vitest'
import {
  DshTuiController,
  type DshTuiApplicationPort,
} from '../src/app/controller.ts'
import { ToolCardRendererRegistry } from '../src/presentation/tool-card-renderers.ts'
import type {
  DshCommandDescriptor,
  DshCommandExecution,
  DshCommandPort,
  DshParsedCommand,
} from '../src/command/port.ts'
import type {
  DshInteractionPort,
  InteractionEventOptions,
  InteractionReceipt,
  InteractionResponse,
  InteractionSnapshot,
} from '../src/interaction/port.ts'
import type { DshTuiEvent, RuntimeDshEnvelope } from '../src/runtime/events.ts'
import type {
  CancelCause,
  Delivery,
  DshRuntimePort,
  RuntimeEventOptions,
  SubmitInput,
  SubmitResult,
} from '../src/runtime/port.ts'
import type {
  DshTuiModelSelection,
  SessionModelSelectOptions,
  SessionModelSnapshot,
} from '../src/model/port.ts'
import type {
  SessionModePort,
  SessionModeSelectOptions,
  SessionModeSnapshot,
} from '../src/mode/port.ts'
import type { SessionSkillsSnapshot } from '../src/skill/port.ts'
import type { SessionContextSnapshot } from '../src/context/port.ts'
import type {
  SessionWorkbenchGoalAction,
  SessionWorkbenchGoalActionReceipt,
  SessionWorkbenchSnapshot,
} from '../src/workbench/port.ts'
import type {
  SessionJobAction,
  SessionJobActionReceipt,
  SessionJobsSnapshot,
} from '../src/activity/port.ts'
import type {
  SessionDelegationAction,
  SessionDelegationActionReceipt,
  SessionDelegationSnapshot,
} from '../src/activity/delegation-port.ts'
import type {
  ProviderAuthorizationInteraction,
  ProviderConnectOutcome,
  ProviderConnectionOptions,
  ProviderConnectionPort,
  ProviderConnectionSnapshot,
} from '../src/provider/port.ts'
import type {
  SessionCatalogListOptions,
  SessionCatalogPort,
  SessionCatalogSnapshot,
} from '../src/session/catalog-port.ts'
import type {
  SessionInspectionPort,
  SessionInspectionRequest,
  SessionInspectionSnapshot,
} from '../src/session/inspection-port.ts'
import type {
  ActivatedSessionLease,
  SessionActivationPort,
  SessionActivationRequest,
} from '../src/session/activation-port.ts'
import { createSessionBinding, type SessionBinding } from '../src/session/binding.ts'
import type {
  TerminalDriver,
  TerminalDriverCallbacks,
  TerminalDriverState,
} from '../src/terminal/driver.ts'
import type { TerminalInputAction } from '../src/terminal/input.ts'
import type { TerminalViewport, UiFrame } from '../src/ui/frame.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import type { UiState } from '../src/transcript/state.ts'
import { durable, message } from './fixtures.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

type SourceItem<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly error: unknown }

class AsyncSource<T> {
  readonly pending: SourceItem<T>[] = []
  readonly waiters: {
    readonly resolve: (result: IteratorResult<T>) => void
    readonly reject: (error: unknown) => void
  }[] = []
  subscriptions = 0
  aborts = 0
  closed = false

  push(value: T): void {
    if (this.closed) return
    this.deliver({ kind: 'value', value })
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    this.deliver({ kind: 'done' })
  }

  fail(error: unknown): void {
    if (this.closed) return
    this.closed = true
    this.deliver({ kind: 'error', error })
  }

  async *iterate(signal?: AbortSignal): AsyncIterable<T> {
    this.subscriptions += 1
    const onAbort = (): void => {
      this.aborts += 1
      this.end()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) onAbort()
    try {
      while (true) {
        const next = await this.next()
        if (next.done) return
        yield next.value
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private next(): Promise<IteratorResult<T>> {
    const item = this.pending.shift()
    if (item !== undefined) return this.result(item)
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }) })
  }

  private deliver(item: SourceItem<T>): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) {
      this.pending.push(item)
      return
    }
    if (item.kind === 'error') waiter.reject(item.error)
    else if (item.kind === 'done') waiter.resolve({ done: true, value: undefined })
    else waiter.resolve({ done: false, value: item.value })
  }

  private result(item: SourceItem<T>): Promise<IteratorResult<T>> {
    if (item.kind === 'error') return Promise.reject(item.error)
    if (item.kind === 'done') return Promise.resolve({ done: true, value: undefined })
    return Promise.resolve({ done: false, value: item.value })
  }
}

type EventFactory = (options?: RuntimeEventOptions) => AsyncIterable<DshTuiEvent>
type InteractionFactory = (
  options?: InteractionEventOptions,
) => AsyncIterable<InteractionSnapshot>

function catalogSnapshot(
  sessions: SessionCatalogSnapshot['sessions'] = [],
  durability: SessionCatalogSnapshot['durability'] = 'available',
): SessionCatalogSnapshot {
  return { durability, sessions }
}

function inspectionSnapshot(
  sessionId: string,
  text: string,
  isSubagent = false,
): SessionInspectionSnapshot {
  return {
    header: {
      sessionId,
      createdAt: 10,
      isSubagent,
      ...(isSubagent ? { parentSessionId: 'parent' } : {}),
    },
    events: [durable(0, {
      type: 'user/message',
      data: {
        message: message(`message-${sessionId}`, 'user', text),
        surfaceOp: 'append',
      },
    }, sessionId)],
  }
}

function inspectionHistorySnapshot(
  sessionId: string,
  prefix: string,
  count = 20,
): SessionInspectionSnapshot {
  return {
    header: {
      sessionId,
      createdAt: 10,
      isSubagent: false,
    },
    events: Array.from({ length: count }, (_, seq) => durable(seq, {
      type: 'user/message',
      data: {
        message: message(`message-${sessionId}-${seq}`, 'user', `${prefix} ${seq}`),
        surfaceOp: 'append',
      },
    }, sessionId)),
  }
}

class FakeCatalog implements SessionCatalogPort {
  readonly signals: (AbortSignal | undefined)[] = []
  snapshot: SessionCatalogSnapshot = catalogSnapshot([{
    sessionId: 'session-a',
    createdAt: 1,
    isSubagent: false,
    attached: true,
    durablePresence: 'not-observed',
    liveStatus: 'idle',
  }])
  listOverride: (
    options?: SessionCatalogListOptions,
  ) => Promise<SessionCatalogSnapshot> = async () => this.snapshot

  listSessions(options?: SessionCatalogListOptions): Promise<SessionCatalogSnapshot> {
    this.signals.push(options?.signal)
    return this.listOverride(options)
  }
}

class FakeActivation implements SessionActivationPort {
  readonly requests: SessionActivationRequest[] = []
  activateOverride: (
    request: SessionActivationRequest,
  ) => Promise<ActivatedSessionLease> = async request => {
    throw new Error(`no fake activation for ${request.sessionId}`)
  }

  activateSession(request: SessionActivationRequest): Promise<ActivatedSessionLease> {
    this.requests.push(request)
    return this.activateOverride(request)
  }
}

class FakeInspection implements SessionInspectionPort {
  readonly requests: SessionInspectionRequest[] = []
  inspectOverride: (
    request: SessionInspectionRequest,
  ) => Promise<SessionInspectionSnapshot> = async request => {
    throw new Error(`no fake inspection for ${request.sessionId}`)
  }

  inspectSession(request: SessionInspectionRequest): Promise<SessionInspectionSnapshot> {
    this.requests.push(request)
    return this.inspectOverride(request)
  }
}

class FakeSession implements DshRuntimePort, DshInteractionPort, DshCommandPort, SessionModePort {
  readonly eventsSource = new AsyncSource<DshTuiEvent>()
  readonly interactionsSource = new AsyncSource<InteractionSnapshot>()
  readonly submitted: { readonly input: SubmitInput; readonly delivery: Delivery }[] = []
  readonly cancellations: CancelCause[] = []
  readonly responses: InteractionResponse[] = []
  readonly commandExecutions: {
    readonly line: string
    readonly signal: AbortSignal
  }[] = []
  readonly commandListeners = new Set<() => void>()
  readonly modelListeners = new Set<() => void>()
  readonly modelRefreshSignals: (AbortSignal | undefined)[] = []
  readonly modelSelections: {
    readonly selection: DshTuiModelSelection
    readonly options: SessionModelSelectOptions | undefined
  }[] = []
  readonly modeListeners = new Set<() => void>()
  readonly modeRefreshSignals: (AbortSignal | undefined)[] = []
  readonly modeSelections: {
    readonly modeId: string
    readonly options: SessionModeSelectOptions | undefined
  }[] = []
  readonly skillsListeners = new Set<() => void>()
  readonly skillsRefreshSignals: (AbortSignal | undefined)[] = []
  commands: readonly DshCommandDescriptor[] = []
  commandExecution: DshCommandExecution | undefined = {
    commandId: 'command-1',
    result: { kind: 'success' },
  }
  executeCommandOverride: (
    line: string,
    signal: AbortSignal,
  ) => Promise<DshCommandExecution | undefined> | undefined = () => undefined
  throwOnListCommands: unknown
  throwOnParseCommand: unknown
  throwOnCommandSubscribe: unknown
  throwOnCommandUnsubscribe: unknown
  throwOnModelSubscribe: unknown
  throwOnModelUnsubscribe: unknown
  throwOnModeSubscribe: unknown
  throwOnModeUnsubscribe: unknown
  throwOnSkillsSubscribe: unknown
  throwOnSkillsUnsubscribe: unknown
  onCommandSubscribe: (() => void) | undefined
  eventsOverride: EventFactory | undefined
  interactionsOverride: InteractionFactory | undefined
  replayStatus: 'idle' | 'running' | 'disposed' = 'idle'
  caughtUpGate: Promise<void> | undefined
  caughtUpCount = 0
  responseReceipt: InteractionReceipt = { accepted: true }
  submitGate: Promise<void> | undefined
  idleGate: Promise<void> | undefined
  throwOnCancel: unknown
  onCancel: (() => void) | undefined
  throwOnRespond: unknown
  throwOnSubmit: unknown
  throwOnDispose: unknown
  throwOnDisposeInteractions: unknown
  whenIdleCount = 0
  flushCount = 0
  disposeInteractionsCount = 0
  disposeCommandsCount = 0
  commandUnsubscribeCount = 0
  modelUnsubscribeCount = 0
  modeUnsubscribeCount = 0
  skillsUnsubscribeCount = 0
  listCommandsCount = 0
  disposeCount = 0

  constructor(
    readonly sessionId = 'session-a',
    readonly ownsAgentLifecycle = true,
  ) {}

  events(options?: RuntimeEventOptions): AsyncIterable<DshTuiEvent> {
    return this.eventsOverride?.(options) ?? this.iterateEvents(options)
  }

  private async *iterateEvents(options?: RuntimeEventOptions): AsyncIterable<DshTuiEvent> {
    await this.caughtUpGate
    if (options?.signal?.aborted === true) return
    this.caughtUpCount += 1
    options?.onCaughtUp?.({ lastSeq: -1, status: this.replayStatus })
    yield* this.eventsSource.iterate(options?.signal)
  }

  interactions(options?: InteractionEventOptions): AsyncIterable<InteractionSnapshot> {
    return this.interactionsOverride?.(options)
      ?? this.interactionsSource.iterate(options?.signal)
  }
  modelState: SessionModelSnapshot = {
    routable: false,
    writable: false,
    loading: false,
    selecting: false,
    groups: [],
    failures: [],
  }
  refreshModelsOverride: (signal?: AbortSignal) => Promise<void> = async () => {}
  selectModelOverride: (
    selection: DshTuiModelSelection,
    options?: SessionModelSelectOptions,
  ) => Promise<void> = async () => {}
  modeState: SessionModeSnapshot = {
    available: false,
    loading: false,
    selecting: false,
    locked: false,
    presets: [],
  }
  refreshModesOverride: (signal?: AbortSignal) => Promise<void> = async () => {}
  selectModeOverride: (
    modeId: string,
    options?: SessionModeSelectOptions,
  ) => Promise<void> = async () => {}
  skillsState: SessionSkillsSnapshot = {
    available: false,
    loading: false,
    complete: true,
    stale: false,
    generation: 0,
    skills: [],
  }
  refreshSkillsOverride: (signal?: AbortSignal) => Promise<void> = async () => {}

  async submit(input: SubmitInput, delivery: Delivery): Promise<SubmitResult> {
    this.submitted.push({ input, delivery })
    await this.submitGate
    if (this.throwOnSubmit !== undefined) throw this.throwOnSubmit
    return { inputId: `input-${this.submitted.length}` }
  }

  cancel(cause: CancelCause): void {
    if (this.throwOnCancel !== undefined) throw this.throwOnCancel
    this.cancellations.push(cause)
    this.onCancel?.()
  }

  async whenIdle(): Promise<void> {
    this.whenIdleCount += 1
    await this.idleGate
  }

  async flush(): Promise<void> {
    this.flushCount += 1
  }

  respond(response: InteractionResponse): InteractionReceipt {
    if (this.throwOnRespond !== undefined) throw this.throwOnRespond
    this.responses.push(response)
    return this.responseReceipt
  }

  listCommands(): readonly DshCommandDescriptor[] {
    this.listCommandsCount += 1
    if (this.throwOnListCommands !== undefined) throw this.throwOnListCommands
    return this.commands
  }

  parseCommand(line: string): DshParsedCommand | undefined {
    if (this.throwOnParseCommand !== undefined) throw this.throwOnParseCommand
    const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
    const name = match?.[1]
    return name === undefined ? undefined : { name, rawInput: line.slice(match![0].length) }
  }

  async executeCommand(
    line: string,
    signal: AbortSignal,
  ): Promise<DshCommandExecution | undefined> {
    this.commandExecutions.push({ line, signal })
    const overridden = this.executeCommandOverride(line, signal)
    return overridden ?? this.commandExecution
  }

  onCommandsChanged(listener: () => void): () => void {
    if (this.throwOnCommandSubscribe !== undefined) throw this.throwOnCommandSubscribe
    this.commandListeners.add(listener)
    this.onCommandSubscribe?.()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.commandUnsubscribeCount += 1
      this.commandListeners.delete(listener)
      if (this.throwOnCommandUnsubscribe !== undefined) {
        throw this.throwOnCommandUnsubscribe
      }
    }
  }

  changeCommands(commands: readonly DshCommandDescriptor[]): void {
    this.commands = commands
    for (const listener of [...this.commandListeners]) listener()
  }

  disposeCommands(): void {
    this.disposeCommandsCount += 1
    this.commandListeners.clear()
  }

  skillsSnapshot(): SessionSkillsSnapshot {
    return structuredClone(this.skillsState)
  }

  refreshSkills(signal?: AbortSignal): Promise<void> {
    this.skillsRefreshSignals.push(signal)
    return this.refreshSkillsOverride(signal)
  }

  onSkillsChanged(listener: () => void): () => void {
    if (this.throwOnSkillsSubscribe !== undefined) throw this.throwOnSkillsSubscribe
    this.skillsListeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.skillsUnsubscribeCount += 1
      this.skillsListeners.delete(listener)
      if (this.throwOnSkillsUnsubscribe !== undefined) throw this.throwOnSkillsUnsubscribe
    }
  }

  changeSkills(snapshot: SessionSkillsSnapshot): void {
    this.skillsState = snapshot
    for (const listener of [...this.skillsListeners]) listener()
  }

  disposeSkills(): void {
    this.skillsListeners.clear()
  }

  modelSnapshot(): SessionModelSnapshot {
    return this.modelState
  }

  refreshModels(signal?: AbortSignal): Promise<void> {
    this.modelRefreshSignals.push(signal)
    return this.refreshModelsOverride(signal)
  }

  selectModel(
    selection: DshTuiModelSelection,
    options?: SessionModelSelectOptions,
  ): Promise<void> {
    this.modelSelections.push({ selection, options })
    return this.selectModelOverride(selection, options)
  }

  onModelsChanged(listener: () => void): () => void {
    if (this.throwOnModelSubscribe !== undefined) throw this.throwOnModelSubscribe
    this.modelListeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.modelUnsubscribeCount += 1
      this.modelListeners.delete(listener)
      if (this.throwOnModelUnsubscribe !== undefined) throw this.throwOnModelUnsubscribe
    }
  }

  changeModelState(state: SessionModelSnapshot): void {
    this.modelState = state
    for (const listener of [...this.modelListeners]) listener()
  }

  disposeModels(): void {
    this.modelListeners.clear()
  }

  modeSnapshot(): SessionModeSnapshot {
    return structuredClone(this.modeState)
  }

  refreshModes(signal?: AbortSignal): Promise<void> {
    this.modeRefreshSignals.push(signal)
    return this.refreshModesOverride(signal)
  }

  selectMode(modeId: string, options?: SessionModeSelectOptions): Promise<void> {
    this.modeSelections.push({ modeId, options })
    return this.selectModeOverride(modeId, options)
  }

  onModesChanged(listener: () => void): () => void {
    if (this.throwOnModeSubscribe !== undefined) throw this.throwOnModeSubscribe
    this.modeListeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.modeUnsubscribeCount += 1
      this.modeListeners.delete(listener)
      if (this.throwOnModeUnsubscribe !== undefined) throw this.throwOnModeUnsubscribe
    }
  }

  changeModeState(state: SessionModeSnapshot): void {
    this.modeState = state
    for (const listener of [...this.modeListeners]) listener()
  }

  disposeModes(): void {
    this.modeListeners.clear()
  }

  disposeInteractions(): void {
    this.disposeInteractionsCount += 1
    if (this.throwOnDisposeInteractions !== undefined) {
      throw this.throwOnDisposeInteractions
    }
    this.interactionsSource.end()
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1
    this.disposeCommands()
    this.disposeModels()
    this.disposeModes()
    this.disposeInteractions()
    this.eventsSource.end()
    if (this.throwOnDispose !== undefined) throw this.throwOnDispose
  }
}

class FakeTerminal implements TerminalDriver {
  private callbacks: TerminalDriverCallbacks | undefined
  private currentViewport: TerminalViewport = { columns: 60, rows: 12 }
  currentState: TerminalDriverState = 'idle'
  readonly frames: UiFrame[] = []
  startCount = 0
  handoffCount = 0
  stopCount = 0
  restoreCount = 0
  throwOnStart: unknown
  throwOnHandoff: unknown
  throwOnRender: unknown
  throwOnStop: unknown

  get state(): TerminalDriverState {
    return this.currentState
  }

  get viewport(): TerminalViewport {
    return this.currentViewport
  }

  start(callbacks: TerminalDriverCallbacks): void {
    this.startCount += 1
    if (this.throwOnStart !== undefined) {
      this.currentState = 'restored'
      throw this.throwOnStart
    }
    this.callbacks = callbacks
    this.currentState = 'running'
  }

  handoff(callbacks: TerminalDriverCallbacks): void {
    this.handoffCount += 1
    if (this.throwOnHandoff !== undefined) throw this.throwOnHandoff
    this.callbacks = callbacks
  }

  render(frame: UiFrame): void {
    if (this.throwOnRender !== undefined) throw this.throwOnRender
    this.frames.push(frame)
  }

  stopAcceptingInput(): void {
    this.stopCount += 1
    if (this.throwOnStop !== undefined) throw this.throwOnStop
    if (this.currentState === 'running') this.currentState = 'quiescing'
  }

  restore(): void {
    if (this.currentState === 'restored') return
    this.restoreCount += 1
    this.currentState = 'restored'
  }

  input(action: TerminalInputAction): void {
    if (this.currentState === 'quiescing' && action.type !== 'interrupt') return
    this.callbacks?.onInput(action)
  }

  resize(viewport: TerminalViewport): void {
    this.currentViewport = viewport
    this.callbacks?.onResize(viewport)
  }
}

class FakeApplication implements DshTuiApplicationPort {
  requestCount = 0
  forceCount = 0
  throwOnForce: unknown

  requestExit(): void {
    this.requestCount += 1
  }

  forceExit(): void {
    this.forceCount += 1
    if (this.throwOnForce !== undefined) throw this.throwOnForce
  }
}

function runtime(
  ordinal: number,
  type: RuntimeDshEnvelope['type'],
  status: 'idle' | 'running' = 'idle',
  sessionId = 'session-a',
): RuntimeDshEnvelope {
  const common = {
    plane: 'runtime' as const,
    sessionId,
    sourceId: 'live-a',
    ordinal,
    time: ordinal,
  }
  if (type === 'agent/disposed') return { ...common, type, data: {} }
  return { ...common, type, data: { status } }
}

function snapshot(
  pending: InteractionSnapshot['pending'] = [],
  sessionId = 'session-a',
): InteractionSnapshot {
  return { type: 'interaction/snapshot', sessionId, pending }
}

class FakeContextSession extends FakeSession {
  readonly contextListeners = new Set<() => void>()
  contextState: SessionContextSnapshot = { available: false }
  contextUnsubscribeCount = 0
  throwOnContextUnsubscribe: unknown

  contextSnapshot(): SessionContextSnapshot {
    return structuredClone(this.contextState)
  }

  onContextChanged(listener: () => void): () => void {
    this.contextListeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.contextUnsubscribeCount += 1
      this.contextListeners.delete(listener)
      if (this.throwOnContextUnsubscribe !== undefined) {
        throw this.throwOnContextUnsubscribe
      }
    }
  }

  changeContext(snapshot: SessionContextSnapshot): void {
    this.contextState = snapshot
    for (const listener of [...this.contextListeners]) listener()
  }

  disposeContext(): void {
    this.contextListeners.clear()
  }
}

class FakeWorkbenchSession extends FakeSession {
  readonly workbenchListeners = new Set<() => void>()
  readonly goalActionCalls: SessionWorkbenchGoalAction[] = []
  workbenchState: SessionWorkbenchSnapshot = { available: false }
  goalActionReceipt: SessionWorkbenchGoalActionReceipt = { accepted: true }
  workbenchUnsubscribeCount = 0
  throwOnWorkbenchUnsubscribe: unknown
  throwOnGoalAction: unknown

  workbenchSnapshot(): SessionWorkbenchSnapshot {
    return structuredClone(this.workbenchState)
  }

  onWorkbenchChanged(listener: () => void): () => void {
    this.workbenchListeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.workbenchUnsubscribeCount += 1
      this.workbenchListeners.delete(listener)
      if (this.throwOnWorkbenchUnsubscribe !== undefined) {
        throw this.throwOnWorkbenchUnsubscribe
      }
    }
  }

  changeWorkbench(snapshot: SessionWorkbenchSnapshot): void {
    this.workbenchState = snapshot
    for (const listener of [...this.workbenchListeners]) listener()
  }

  runGoalAction(action: SessionWorkbenchGoalAction): SessionWorkbenchGoalActionReceipt {
    this.goalActionCalls.push(structuredClone(action))
    if (this.throwOnGoalAction !== undefined) throw this.throwOnGoalAction
    return this.goalActionReceipt
  }

  disposeWorkbench(): void {
    this.workbenchListeners.clear()
  }
}

class FakeJobsSession extends FakeWorkbenchSession {
  readonly jobsListeners = new Set<() => void>()
  readonly jobActionCalls: SessionJobAction[] = []
  jobsState: SessionJobsSnapshot = { available: false, generation: 0, jobs: [] }
  jobActionReceipt: SessionJobActionReceipt = {
    accepted: true,
    outcome: 'requested',
  }
  jobsUnsubscribeCount = 0
  throwOnJobsUnsubscribe: unknown
  throwOnJobAction: unknown

  jobsSnapshot(): SessionJobsSnapshot {
    return structuredClone(this.jobsState)
  }

  onJobsChanged(listener: () => void): () => void {
    this.jobsListeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.jobsUnsubscribeCount += 1
      this.jobsListeners.delete(listener)
      if (this.throwOnJobsUnsubscribe !== undefined) throw this.throwOnJobsUnsubscribe
    }
  }

  changeJobs(snapshot: SessionJobsSnapshot): void {
    this.jobsState = snapshot
    for (const listener of [...this.jobsListeners]) listener()
  }

  runJobAction(action: SessionJobAction): SessionJobActionReceipt {
    this.jobActionCalls.push(structuredClone(action))
    if (this.throwOnJobAction !== undefined) throw this.throwOnJobAction
    return this.jobActionReceipt
  }

  disposeJobs(): void {
    this.jobsListeners.clear()
  }
}

class FakeDelegationSession extends FakeJobsSession {
  readonly delegationListeners = new Set<() => void>()
  readonly delegationActionCalls: SessionDelegationAction[] = []
  readonly delegationRefreshSignals: (AbortSignal | undefined)[] = []
  delegationState: SessionDelegationSnapshot = {
    available: false,
    generation: 0,
    loading: false,
    subagentsAvailable: false,
    subagents: [],
    workflows: [],
  }
  delegationActionReceipt: SessionDelegationActionReceipt = {
    accepted: true,
    outcome: 'requested',
  }
  refreshDelegationOverride: (signal?: AbortSignal) => Promise<void> = async () => {}
  delegationUnsubscribeCount = 0
  throwOnDelegationUnsubscribe: unknown
  throwOnDelegationAction: unknown

  delegationSnapshot(): SessionDelegationSnapshot {
    return structuredClone(this.delegationState)
  }

  refreshDelegation(signal?: AbortSignal): Promise<void> {
    this.delegationRefreshSignals.push(signal)
    return this.refreshDelegationOverride(signal)
  }

  onDelegationChanged(listener: () => void): () => void {
    this.delegationListeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.delegationUnsubscribeCount += 1
      this.delegationListeners.delete(listener)
      if (this.throwOnDelegationUnsubscribe !== undefined) {
        throw this.throwOnDelegationUnsubscribe
      }
    }
  }

  changeDelegation(snapshot: SessionDelegationSnapshot): void {
    this.delegationState = snapshot
    for (const listener of [...this.delegationListeners]) listener()
  }

  runDelegationAction(action: SessionDelegationAction): SessionDelegationActionReceipt {
    this.delegationActionCalls.push(structuredClone(action))
    if (this.throwOnDelegationAction !== undefined) throw this.throwOnDelegationAction
    return this.delegationActionReceipt
  }

  disposeDelegation(): void {
    this.delegationListeners.clear()
  }
}

class FakeProviders implements ProviderConnectionPort {
  readonly listeners = new Set<() => void>()
  readonly listSignals: (AbortSignal | undefined)[] = []
  readonly connectCalls: {
    readonly provider: string
    readonly method: string
    readonly interaction: ProviderAuthorizationInteraction
    readonly signal: AbortSignal | undefined
  }[] = []
  readonly disconnectCalls: {
    readonly provider: string
    readonly signal: AbortSignal | undefined
  }[] = []
  throwOnUnsubscribe: unknown
  snapshot: ProviderConnectionSnapshot = {
    writable: true,
    providers: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      active: true,
      configured: true,
      connected: false,
      credential: { kind: 'missing', configured: false, writable: true },
      methods: [{ id: 'api-key', label: 'Enter API key' }],
      canDisconnect: false,
    }],
  }
  listOverride: (
    options?: ProviderConnectionOptions,
  ) => Promise<ProviderConnectionSnapshot> = async () => this.snapshot
  connectOverride: (
    provider: string,
    method: string,
    interaction: ProviderAuthorizationInteraction,
    options?: ProviderConnectionOptions,
  ) => Promise<ProviderConnectOutcome> = async () => ({ status: 'connected' })
  disconnectOverride: (
    provider: string,
    options?: ProviderConnectionOptions,
  ) => Promise<void> = async () => undefined

  list(options?: ProviderConnectionOptions): Promise<ProviderConnectionSnapshot> {
    this.listSignals.push(options?.signal)
    return this.listOverride(options)
  }

  connect(
    provider: string,
    method: string,
    interaction: ProviderAuthorizationInteraction,
    options?: ProviderConnectionOptions,
  ): Promise<ProviderConnectOutcome> {
    this.connectCalls.push({ provider, method, interaction, signal: options?.signal })
    return this.connectOverride(provider, method, interaction, options)
  }

  disconnect(provider: string, options?: ProviderConnectionOptions): Promise<void> {
    this.disconnectCalls.push({ provider, signal: options?.signal })
    return this.disconnectOverride(provider, options)
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.throwOnUnsubscribe !== undefined) throw this.throwOnUnsubscribe
    }
  }

  change(snapshot: ProviderConnectionSnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener()
  }
}

function selectableModelSnapshot(
  overrides: Partial<SessionModelSnapshot> = {},
): SessionModelSnapshot {
  return {
    current: { provider: 'provider-a', model: 'model-a' },
    defaultSelection: { provider: 'provider-a', model: 'model-a' },
    routable: true,
    writable: true,
    loading: false,
    selecting: false,
    groups: [{
      id: 'provider-a',
      name: 'Provider A',
      models: [{
        provider: 'provider-a',
        providerName: 'Provider A',
        id: 'model-a',
        name: 'Model A',
        efforts: [
          { id: 'low', name: 'Low', isDefault: true },
          { id: 'opaque/high', name: 'High', isDefault: false },
        ],
      }],
    }],
    failures: [],
    ...overrides,
  }
}

function selectableModeSnapshot(
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
        description: 'Programmatic tool calling',
        isDefault: false,
      },
    ],
    ...overrides,
  }
}

function selectableSkillsSnapshot(
  overrides: Partial<SessionSkillsSnapshot> = {},
): SessionSkillsSnapshot {
  return {
    available: true,
    loading: false,
    complete: true,
    stale: false,
    generation: 1,
    skills: [
      {
        name: 'review',
        description: 'Review source changes',
        whenToUse: 'When a patch needs inspection',
        modelInvocable: true,
        source: 'workspace',
        provider: 'filesystem',
        resourceBase: { kind: 'directory', path: 'D:\\workspace\\.agents\\skills\\review' },
      },
      {
        name: 'research',
        description: 'Find primary evidence',
        modelInvocable: false,
        source: 'user',
        provider: 'filesystem',
      },
    ],
    ...overrides,
  }
}

function createProduct(options: {
  readonly session?: FakeSession
  readonly activation?: FakeActivation
  readonly inspection?: FakeInspection
  readonly catalog?: FakeCatalog
  readonly providers?: FakeProviders
  readonly terminal?: FakeTerminal
  readonly application?: FakeApplication
  readonly toolCards?: ToolCardRendererRegistry
  readonly terminalStartMode?: 'start' | 'adopt-running'
} = {}): {
  readonly controller: DshTuiController
  readonly session: FakeSession
  readonly catalog: FakeCatalog
  readonly providers: FakeProviders | undefined
  readonly terminal: FakeTerminal
  readonly application: FakeApplication
} {
  const session = options.session ?? new FakeSession()
  session.interactionsSource.push(snapshot([], session.sessionId))
  const catalog = options.catalog ?? new FakeCatalog()
  const terminal = options.terminal ?? new FakeTerminal()
  const application = options.application ?? new FakeApplication()
  const controller = new DshTuiController({
    session,
    ...(options.activation === undefined ? {} : { activation: options.activation }),
    ...(options.inspection === undefined ? {} : { inspection: options.inspection }),
    catalog,
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    terminal,
    application,
    ...(options.toolCards === undefined ? {} : { toolCards: options.toolCards }),
    ...(options.terminalStartMode === undefined
      ? {}
      : { terminalStartMode: options.terminalStartMode }),
    frameIntervalMs: 1,
  })
  return {
    controller,
    session,
    catalog,
    providers: options.providers,
    terminal,
    application,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition was not reached')
}

function resultError(
  result: Awaited<ReturnType<DshTuiController['wait']>>,
): unknown {
  if (result.ok) throw new Error('expected a failed controller result')
  return result.error
}

describe('DshTuiController pumps and rendering', () => {
  it('keeps reasoning expansion transient, Session-scoped, and bounded to 32 entries', async () => {
    const product = createProduct()
    await product.controller.start()
    await waitFor(() => product.terminal.frames.length > 0)

    expect(product.terminal.frames.at(-1)?.conversation?.reasoningExpanded).toBe(false)
    product.terminal.input({ type: 'toggle-reasoning' })
    await waitFor(() => (
      product.terminal.frames.at(-1)?.conversation?.reasoningExpanded === true
    ))
    product.terminal.input({ type: 'toggle-reasoning' })
    await waitFor(() => (
      product.terminal.frames.at(-1)?.conversation?.reasoningExpanded === false
    ))

    const internals = product.controller as unknown as {
      reasoningBySession: Map<string, true>
      toggleSessionReasoning(sessionId: string): void
    }
    for (let index = 0; index < 33; index += 1) {
      internals.toggleSessionReasoning(`background-${index}`)
    }
    expect(internals.reasoningBySession.size).toBe(32)
    expect(internals.reasoningBySession.has('session-a')).toBe(false)
    expect(internals.reasoningBySession.has('background-0')).toBe(false)
    expect(internals.reasoningBySession.has('background-32')).toBe(true)

    await product.controller.requestExit('user')
    expect(internals.reasoningBySession.size).toBe(0)
  })

  it('keeps the initial binding booting until replay and interactions hydrate without losing the draft', async () => {
    const session = new FakeSession()
    const runtimeReady = deferred()
    const interactionReady = deferred()
    session.caughtUpGate = runtimeReady.promise
    session.interactionsOverride = options => (async function* () {
      await interactionReady.promise
      if (options?.signal?.aborted === true) return
      yield snapshot([], session.sessionId)
      yield* session.interactionsSource.iterate(options?.signal)
    })()
    const product = createProduct({ session })
    let started = false
    const starting = product.controller.start().then(() => { started = true })

    try {
      await waitFor(() => product.terminal.frames.length > 0)
      product.terminal.input({ type: 'insert', text: 'draft while hydrating' })
      product.terminal.input({ type: 'submit' })

      expect(started).toBe(false)
      expect(session.submitted).toEqual([])
      expect(product.terminal.frames.at(-1)?.lines[0]).toContain('booting')

      runtimeReady.resolve()
      await waitFor(() => session.caughtUpCount === 1)
      expect(started).toBe(false)

      interactionReady.resolve()
      await starting
      product.terminal.input({ type: 'submit' })
      await waitFor(() => session.submitted.length === 1)
      expect(session.submitted[0]).toMatchObject({
        input: { text: 'draft while hydrating' },
        delivery: 'followup',
      })
    } finally {
      runtimeReady.resolve()
      interactionReady.resolve()
      await starting.catch(() => undefined)
      await product.controller.requestExit('user')
    }
  })

  it('cancels initial hydration from Ctrl+C and restores the terminal exactly once', async () => {
    const session = new FakeSession()
    const runtimeReady = deferred()
    const interactionReady = deferred()
    session.caughtUpGate = runtimeReady.promise
    session.interactionsOverride = options => (async function* () {
      await interactionReady.promise
      if (options?.signal?.aborted === true) return
      yield snapshot([], session.sessionId)
    })()
    const product = createProduct({ session })
    const starting = product.controller.start()

    await waitFor(() => product.terminal.frames.length > 0)
    for (const action of [
      { type: 'escape' },
      { type: 'save-default' },
      { type: 'move-up' },
      { type: 'move-down' },
      { type: 'complete' },
      { type: 'ignored' },
      { type: 'backspace' },
    ] as const) product.terminal.input(action)
    product.terminal.input({ type: 'interrupt' })
    runtimeReady.resolve()
    interactionReady.resolve()

    await starting
    const result = await product.controller.wait()
    expect(result).toMatchObject({ ok: true, reason: 'user' })
    expect(session.submitted).toEqual([])
    expect(session.disposeCount).toBe(1)
    expect(product.terminal.restoreCount).toBe(1)
  })

  it('fails closed when the initial hydrated Agent is already disposed', async () => {
    const session = new FakeSession()
    session.eventsOverride = options => (async function* () {
      yield runtime(0, 'agent/created')
      yield runtime(1, 'agent/disposed')
      options?.onCaughtUp?.({ lastSeq: -1, status: 'disposed' })
      yield* session.eventsSource.iterate(options?.signal)
    })()
    const product = createProduct({ session })

    await expect(product.controller.start()).rejects.toThrow(
      'session "session-a" is disposed',
    )
    await expect(product.controller.wait()).resolves.toMatchObject({
      ok: false,
      reason: 'fatal',
    })
    expect(product.terminal.restoreCount).toBe(1)
  })

  it('subscribes both pumps, conflates frames, and renders the latest viewport', async () => {
    const { controller, session, terminal, application } = createProduct()
    await controller.start()
    await waitFor(() => (
      session.eventsSource.subscriptions === 1
      && session.interactionsSource.subscriptions === 1
      && terminal.frames.length > 0
    ))

    session.eventsSource.push(runtime(0, 'agent/created'))
    for (let seq = 0; seq < 5; seq += 1) {
      session.eventsSource.push(durable(seq, {
        type: 'user/message',
        data: {
          message: message(`user-${seq}`, 'user', `row ${seq}`),
          surfaceOp: 'append',
        },
      }))
    }
    session.interactionsSource.push(snapshot([{
      id: 'approval:1',
      kind: 'approval',
      sessionId: 'session-a',
      approvalId: 'approval-1',
      toolName: 'pwsh',
      callId: 'call-1',
    }]))
    terminal.resize({ columns: 42, rows: 9 })

    await waitFor(() => terminal.frames.some(frame => (
      frame.viewport.columns === 42
      && frame.lines.join('\n').includes('PERMISSION REQUIRED')
    )))

    expect(terminal.frames.at(-1)?.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })
    session.interactionsSource.push(snapshot())
    await waitFor(() => (
      terminal.frames.at(-1)?.viewport.columns === 42
      && terminal.frames.at(-1)?.lines.join('\n').includes('row 4') === true
    ))
    expect(terminal.frames.length).toBeLessThan(10)
    const resultPromise = controller.requestExit('user')
    const result = await resultPromise
    expect(result).toMatchObject({ ok: true, reason: 'user' })
    expect(session.eventsSource.aborts).toBe(1)
    expect(session.interactionsSource.aborts).toBe(1)
    expect(session.disposeInteractionsCount).toBe(2)
    expect(session.disposeCount).toBe(1)
    expect(terminal.startCount).toBe(1)
    expect(terminal.handoffCount).toBe(0)
    expect(terminal.stopCount).toBe(1)
    expect(terminal.restoreCount).toBe(1)
    expect(application.requestCount).toBe(1)
    expect(application.forceCount).toBe(0)
    await expect(controller.wait()).resolves.toBe(result)
  })

  it('passes an explicit effect-owned Tool card registry into frame rendering', async () => {
    const toolCards = new ToolCardRendererRegistry()
    const { controller, terminal } = createProduct({ toolCards })

    await controller.start()
    await waitFor(() => terminal.frames.length > 0)
    expect(terminal.frames.at(-1)?.lines[0]).toContain('DSH-TUI')
    await controller.requestExit('user')
  })

  it('adopts a running terminal without restarting it', async () => {
    const terminal = new FakeTerminal()
    terminal.currentState = 'running'
    const { controller, session } = createProduct({
      terminal,
      terminalStartMode: 'adopt-running',
    })

    await controller.start()
    await waitFor(() => (
      session.eventsSource.subscriptions === 1
      && session.interactionsSource.subscriptions === 1
      && terminal.frames.length > 0
    ))
    terminal.input({ type: 'insert', text: 'adopted' })
    terminal.resize({ columns: 43, rows: 8 })
    await waitFor(() => terminal.frames.some(frame => (
      frame.viewport.columns === 43
      && frame.lines.join('\n').includes('adopted')
    )))

    expect(terminal.startCount).toBe(0)
    expect(terminal.handoffCount).toBe(1)
    await controller.requestExit('user')
    expect(terminal.restoreCount).toBe(1)
  })

  it('treats an unexpected interaction end as fatal and aborts the runtime pump', async () => {
    const { controller, session, terminal } = createProduct()
    await controller.start()
    await waitFor(() => session.interactionsSource.subscriptions === 1)

    session.interactionsSource.end()
    const result = await controller.wait()

    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(String(resultError(result))).toContain('interaction pump ended unexpectedly')
    expect(session.eventsSource.aborts).toBe(1)
    expect(terminal.state).toBe('restored')
  })

  it('treats runtime failure or an undisposed end as fatal', async () => {
    const failed = createProduct()
    await failed.controller.start()
    failed.session.eventsSource.fail(new Error('runtime exploded'))
    const failedResult = await failed.controller.wait()
    expect(failedResult).toMatchObject({ ok: false, reason: 'fatal' })
    expect(String(resultError(failedResult))).toContain('runtime pump failed')

    const ended = createProduct()
    await ended.controller.start()
    ended.session.eventsSource.end()
    const endedResult = await ended.controller.wait()
    expect(endedResult).toMatchObject({ ok: false, reason: 'fatal' })
    expect(String(resultError(endedResult))).toContain('runtime pump ended unexpectedly')

    const nonError = createProduct()
    await nonError.controller.start()
    nonError.session.eventsSource.fail('string explosion')
    expect(String(resultError(await nonError.controller.wait()))).toContain('string explosion')
  })

  it('allows the runtime stream to end after agent/disposed', async () => {
    const { controller, session, application } = createProduct()
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))
    session.eventsSource.push(runtime(1, 'agent/disposed'))
    session.eventsSource.end()

    const result = await controller.wait()
    expect(result).toMatchObject({ ok: true, reason: 'runtime-disposed' })
    expect(session.whenIdleCount).toBe(0)
    expect(session.flushCount).toBe(0)
    expect(application.requestCount).toBe(1)
  })

  it('rejects cross-session pump values and reducer compatibility failures', async () => {
    const wrongEvent = createProduct()
    await wrongEvent.controller.start()
    wrongEvent.session.eventsSource.push(runtime(0, 'agent/created', 'idle', 'other'))
    expect(await wrongEvent.controller.wait()).toMatchObject({ ok: false, reason: 'fatal' })

    const wrongSnapshot = createProduct()
    await wrongSnapshot.controller.start()
    wrongSnapshot.session.interactionsSource.push(snapshot([], 'other'))
    expect(await wrongSnapshot.controller.wait()).toMatchObject({ ok: false, reason: 'fatal' })

    const incompatible = createProduct()
    await incompatible.controller.start()
    incompatible.session.eventsSource.push(durable(0, {
      type: 'session/unsupported',
      data: { sourceType: 'future-required' },
    }))
    const result = await incompatible.controller.wait()
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(String(resultError(result))).toContain('UNSUPPORTED_REQUIRED_EVENT')
  })
})

describe('DshTuiController input routing', () => {
  it('routes idle submit to followup, running submit to steer, and allows one pending submit', async () => {
    const { controller, session, terminal } = createProduct()
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))
    await waitFor(() => terminal.frames.length > 0)

    const gate = deferred()
    session.submitGate = gate.promise
    terminal.input({ type: 'insert', text: 'first' })
    terminal.input({ type: 'newline' })
    terminal.input({ type: 'backspace' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]).toEqual({
      input: { text: 'first' },
      delivery: 'followup',
    })

    terminal.input({ type: 'insert', text: 'second' })
    terminal.input({ type: 'submit' })
    expect(session.submitted).toHaveLength(1)
    gate.resolve()
    session.submitGate = undefined
    await waitFor(() => controller.pendingSubmitCount === 0)

    session.eventsSource.push(runtime(1, 'agent/status', 'running'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('running') === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 2)
    expect(session.submitted[1]).toEqual({
      input: { text: 'second' },
      delivery: 'steer',
    })

    terminal.input({ type: 'interrupt' })
    expect(session.cancellations).toEqual([{ kind: 'user' }])
    await controller.requestExit('user')
  })

  it('clears a draft before exiting and ignores blank, escape, and ignored actions', async () => {
    const { controller, session, terminal } = createProduct()
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))
    terminal.input({ type: 'save-default' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: 'draft' })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'move-home' })
    terminal.input({ type: 'move-end' })
    terminal.input({ type: 'delete' })
    terminal.input({ type: 'ignored' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    expect(session.submitted).toEqual([])

    terminal.input({ type: 'insert', text: 'again' })
    terminal.input({ type: 'interrupt' })
    terminal.input({ type: 'submit' })
    expect(session.submitted).toEqual([])

    terminal.input({ type: 'insert', text: '   ' })
    terminal.input({ type: 'submit' })
    expect(session.submitted).toEqual([])
    terminal.input({ type: 'interrupt' })
    terminal.input({ type: 'interrupt' })

    const result = await controller.wait()
    expect(result).toMatchObject({ ok: true, reason: 'user' })
  })

  it('answers and cancels interactions without consuming the normal prompt', async () => {
    const { controller, session, terminal } = createProduct()
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))
    terminal.input({ type: 'insert', text: 'preserved draft' })

    session.interactionsSource.push(snapshot([{
      id: 'question:1',
      kind: 'question',
      sessionId: 'session-a',
      questions: [
        {
          id: 'choice',
          question: 'Choose',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
        { id: 'detail', question: 'Why?' },
      ],
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Choose') === true)
    terminal.input({ type: 'ignored' })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'insert', text: '1' })
    terminal.input({ type: 'submit' })
    expect(session.responses).toEqual([])
    terminal.input({ type: 'insert', text: 'because' })
    terminal.input({ type: 'submit' })
    expect(session.responses).toEqual([{
      id: 'question:1',
      kind: 'question',
      outcome: {
        kind: 'answered',
        answer: {
          answers: [
            { id: 'choice', selected: ['Yes'] },
            { id: 'detail', selected: [], custom: 'because' },
          ],
        },
      },
    }])

    session.interactionsSource.push(snapshot([{
      id: 'approval:1',
      kind: 'approval',
      sessionId: 'session-a',
      approvalId: 'approval-1',
      toolName: 'pwsh',
      callId: 'call-1',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === true)
    terminal.input({ type: 'insert', text: 'invalid' })
    terminal.input({ type: 'submit' })
    expect(session.responses).toHaveLength(1)
    terminal.input({ type: 'backspace' })
    terminal.input({ type: 'escape' })
    expect(session.responses.at(-1)).toEqual({
      id: 'approval:1',
      kind: 'approval',
      outcome: 'rejected',
    })

    session.interactionsSource.push(snapshot())
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === false)
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]?.input.text).toBe('preserved draft')
    await controller.requestExit('user')
  })

  it('presents official plan review as a read-only decision dock and returns exact labels', async () => {
    const { controller, session, terminal } = createProduct()
    await controller.start()
    terminal.resize({ columns: 100, rows: 24 })
    session.interactionsSource.push(snapshot([{
      id: 'plan-review:1',
      kind: 'question',
      sessionId: session.sessionId,
      questions: [{
        id: 'plan-review',
        question: 'Approve this implementation plan?',
        detail: '# Ship workbench\n\n- inspect\n- implement\n- verify\n- report',
        options: [
          { label: 'Approve', description: 'Carry out the plan.' },
          { label: 'Keep planning', description: 'Revise the plan.' },
        ],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    }]))

    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PLAN REVIEW') === true)
    let output = terminal.frames.at(-1)!.lines.join('\n')
    expect(output).toContain('Decision: Approve this implementation plan?')
    expect(output).toContain('› [Approve]')
    expect(output).toContain('more plan lines in the tool card')
    expect(terminal.frames.at(-1)?.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })

    terminal.input({ type: 'insert', text: 'cannot edit this' })
    terminal.input({ type: 'toggle-goal-actions' })
    expect(terminal.frames.at(-1)!.lines.join('\n')).toContain('› [Approve]')
    terminal.input({ type: 'move-left' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('› [Keep planning]') === true)
    terminal.input({ type: 'move-up' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('› [Discuss]') === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-right' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('› [Approve]') === true)
    terminal.input({ type: 'submit' })
    expect(session.responses.at(-1)).toEqual({
      id: 'plan-review:1',
      kind: 'question',
      outcome: {
        kind: 'answered',
        answer: { answers: [{ id: 'plan-review', selected: ['Approve'] }] },
      },
    })

    session.interactionsSource.push(snapshot([{
      id: 'plan-review:2',
      kind: 'question',
      sessionId: session.sessionId,
      questions: [{
        id: 'plan-review',
        question: 'Approve the reduced plan?',
        detail: '# Reduced plan',
        options: [{ label: 'Approve' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Approve the reduced plan?') === true)
    terminal.input({ type: 'escape' })
    expect(session.responses.at(-1)).toEqual({
      id: 'plan-review:2',
      kind: 'question',
      outcome: { kind: 'cancelled' },
    })
    output = terminal.frames.at(-1)!.lines.join('\n')
    expect(output).not.toContain('goal>')
    await controller.requestExit('user')
  })

  it('applies invalid and not-pending receipts and routes Ctrl+C through the active modal', async () => {
    const { controller, session, terminal } = createProduct()
    await controller.start()
    session.interactionsSource.push(snapshot([{
      id: 'approval:1',
      kind: 'approval',
      sessionId: 'session-a',
      approvalId: 'approval-1',
      toolName: 'write',
      callId: 'call-1',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === true)

    session.responseReceipt = {
      accepted: false,
      reason: 'invalid-response',
      message: 'retry response',
    }
    terminal.input({ type: 'insert', text: 'y' })
    terminal.input({ type: 'submit' })
    expect(session.responses).toHaveLength(1)
    terminal.input({ type: 'insert', text: 'n' })

    session.responseReceipt = { accepted: false, reason: 'not-pending' }
    terminal.input({ type: 'interrupt' })
    expect(session.responses).toHaveLength(2)
    expect(controller.state).toBe('running')
    await controller.requestExit('user')
  })
})

describe('DshTuiController command routing', () => {
  const compact: DshCommandDescriptor = {
    name: 'compact',
    description: 'Compact the session',
  }
  const goal: DshCommandDescriptor = {
    name: 'goal',
    description: 'Set a goal',
    input: { hint: '<goal>' },
  }

  it('completes input commands and keeps unknown or argued no-input commands on the model lane', async () => {
    const session = new FakeSession()
    session.commands = [compact, goal]
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/goal' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/goal ') === true)
    expect(session.commandExecutions).toEqual([])
    expect(session.submitted).toEqual([])

    terminal.input({ type: 'insert', text: 'build it' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.length === 1)
    expect(session.commandExecutions[0]?.line).toBe('/goal build it')

    terminal.input({ type: 'insert', text: '/compact now' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]?.input.text).toBe('/compact now')

    terminal.input({ type: 'insert', text: '/missing' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 2)
    expect(session.submitted[1]?.input.text).toBe('/missing')

    terminal.input({ type: 'insert', text: '/compact' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.length === 2)
    expect(session.commandExecutions[1]?.line).toBe('/compact')

    await controller.requestExit('user')
  })

  it('navigates the live menu, completes with Tab, and clamps a stale selection', async () => {
    const session = new FakeSession()
    session.commands = [compact, goal]
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'complete' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/goal ') === true)
    expect(session.commandExecutions).toEqual([])
    terminal.input({ type: 'escape' })

    const feedback: DshCommandDescriptor = {
      name: 'feedback',
      description: 'Send feedback',
      input: { hint: '<feedback>' },
    }
    session.changeCommands([feedback])
    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'complete' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/feedback ') === true)

    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.overlay === undefined)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('/feedback —')

    await controller.requestExit('user')
    expect(session.commandUnsubscribeCount).toBe(1)
  })

  it('Tab-completes an inputless official command without leaking a separator into the model lane', async () => {
    const session = new FakeSession()
    session.commands = [compact]
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/comp' })
    terminal.input({ type: 'complete' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/compact') === true)
    expect(terminal.frames.at(-1)?.overlay?.kind).toBe('palette')
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.length === 1)

    expect(session.commandExecutions[0]?.line).toBe('/compact')
    expect(session.submitted).toEqual([])
    await controller.requestExit('user')
  })

  it('blocks slash submission while the catalog is unavailable and restores only an untouched admission miss', async () => {
    const session = new FakeSession()
    session.commands = [compact]
    session.throwOnListCommands = new Error('catalog offline')
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/model' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/model') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('/model —')
    terminal.input({ type: 'submit' })
    expect(session.modelRefreshSignals).toEqual([])
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/compact' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('catalog offline') === true)
    expect(session.submitted).toEqual([])
    expect(session.commandExecutions).toEqual([])

    session.throwOnListCommands = undefined
    session.commandExecution = undefined
    session.changeCommands([compact])
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.length === 1)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/compact') === true)

    const gate = deferred<DshCommandExecution | undefined>()
    session.executeCommandOverride = () => gate.promise
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.length === 2)
    terminal.input({ type: 'insert', text: 'replacement' })
    gate.resolve(undefined)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('> replacement') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('> /compact')

    await controller.requestExit('user')
  })

  it('contains command rejection and aborts then awaits a pending command before disposal', async () => {
    const session = new FakeSession()
    session.commands = [compact]
    session.executeCommandOverride = () => Promise.reject(new Error('command rejected'))
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/compact' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('command rejected') === true)
    expect(controller.state).toBe('running')
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('> /compact')

    const gate = deferred<DshCommandExecution | undefined>()
    session.executeCommandOverride = () => gate.promise
    terminal.input({ type: 'insert', text: '/compact' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.length === 2)
    const resultPromise = controller.requestExit('user')
    await waitFor(() => session.commandExecutions[1]?.signal.aborted === true)
    expect(session.disposeCount).toBe(0)
    gate.resolve({ commandId: 'command-2', result: { kind: 'success' } })
    const result = await resultPromise
    expect(result).toMatchObject({ ok: true, reason: 'user' })
    expect(session.disposeCount).toBe(1)
    expect(session.commandUnsubscribeCount).toBe(1)
  })

  it('keeps interaction priority, ignores menu keys without a menu, and completes a dismissed exact input command', async () => {
    const session = new FakeSession()
    session.commands = [compact, goal]
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    session.interactionsSource.push(snapshot([{
      id: 'approval:command-priority',
      kind: 'approval',
      sessionId: 'session-a',
      approvalId: 'approval-command-priority',
      callId: 'call-command-priority',
      toolName: 'pwsh',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === true)

    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'complete' })
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('PERMISSION REQUIRED')
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('/compact —')
    expect(session.responses).toEqual([])

    session.interactionsSource.push(snapshot())
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === false)
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'complete' })
    terminal.input({ type: 'insert', text: '/goal' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/goal ') === true)
    expect(session.commandExecutions).toEqual([])

    await controller.requestExit('user')
  })

  it('allows one pending command, aborts it on first Ctrl+C, and forces on the second', async () => {
    const session = new FakeSession()
    session.commands = [compact]
    session.executeCommandOverride = () => new Promise(() => undefined)
    const { controller, catalog, terminal, application } = createProduct({ session })
    await controller.start()
    expect(controller.pendingCommandCount).toBe(0)

    terminal.input({ type: 'insert', text: '/compact' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.length === 1)
    expect(controller.pendingCommandCount).toBe(1)

    terminal.input({ type: 'insert', text: 'ordinary' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('already running') === true)
    expect(session.submitted).toEqual([])
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/se' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'A command is already running',
    ) === true)
    expect(catalog.signals).toEqual([])
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/compact' })
    terminal.input({ type: 'submit' })
    expect(session.commandExecutions).toHaveLength(1)

    terminal.input({ type: 'interrupt' })
    expect(session.commandExecutions[0]?.signal.aborted).toBe(true)
    expect(application.forceCount).toBe(0)
    expect(session.cancellations).toEqual([])
    terminal.input({ type: 'interrupt' })
    const result = await controller.wait()
    expect(result).toMatchObject({ ok: false, reason: 'forced' })
    expect(application.forceCount).toBe(1)
    expect(terminal.restoreCount).toBe(1)
    expect(controller.pendingCommandCount).toBe(1)
  })

  it('contains hostile catalog, parser, and non-Error execution failures as notices', async () => {
    const session = new FakeSession()
    session.commands = [compact]
    session.throwOnListCommands = ''
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('unknown command error') === true)

    session.throwOnListCommands = undefined
    session.changeCommands([compact])
    const hostile = { toString(): string { throw new Error('cannot stringify') } }
    session.throwOnParseCommand = hostile
    terminal.input({ type: 'insert', text: '/missing' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Command routing failed: unknown') === true)

    session.throwOnParseCommand = 'parser string failure'
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('parser string failure') === true)

    session.throwOnParseCommand = undefined
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'escape' })
    session.executeCommandOverride = () => Promise.reject('execution string failure')
    terminal.input({ type: 'insert', text: '/compact' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('execution string failure') === true)
    expect(controller.state).toBe('running')

    await controller.requestExit('user')
  })

  it('does not execute an exact command after the owned agent is disposed', async () => {
    const session = new FakeSession()
    session.commands = [compact]
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))
    session.eventsSource.push(runtime(1, 'agent/disposed'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('disposed') === true)

    terminal.input({ type: 'insert', text: '/compact' })
    terminal.input({ type: 'submit' })
    await expect(controller.wait()).resolves.toMatchObject({
      ok: true,
      reason: 'runtime-disposed',
    })
    expect(session.commandExecutions).toEqual([])
  })
})

describe('DshTuiController Agent mode picker', () => {
  it('keeps optional mode seams defensive and ignores non-current mode notifications', async () => {
    const session = new FakeSession()
    Object.defineProperty(session, 'modeSnapshot', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(session, 'refreshModes', {
      configurable: true,
      value: undefined,
    })
    const { controller } = createProduct({ session })
    await controller.start()

    const probe = controller as unknown as {
      currentBinding: object
      openLocalCommand(name: string): void
      beginModeRefresh(binding: object): void
      createBinding(
        port: FakeSession,
        role: 'candidate',
        release: () => Promise<void>,
      ): object
      handleModesChanged(binding: object): void
    }
    probe.openLocalCommand('mode')
    expect((controller as unknown as { commandNotice?: string }).commandNotice)
      .toBe('Agent modes are unavailable in this Session composition')
    probe.beginModeRefresh(probe.currentBinding)

    const candidatePort = new FakeSession('mode-candidate')
    candidatePort.modeState = selectableModeSnapshot()
    const candidate = probe.createBinding(
      candidatePort,
      'candidate',
      () => candidatePort.dispose(),
    )
    probe.handleModesChanged(candidate)

    await controller.requestExit('user')
  })

  it('uses the cached roster immediately and blocks prompt submission until recompose commits', async () => {
    const session = new FakeSession()
    const modes = selectableModeSnapshot()
    session.modeState = modes
    const selection = Promise.withResolvers<void>()
    session.selectModeOverride = async modeId => {
      await selection.promise
      session.changeModeState({ ...modes, current: modeId })
    }
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 120, rows: 14 })

    terminal.input({ type: 'insert', text: '/mode' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes(
      'AGENT MODE',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Standard  current · default')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('PTC Mode')
    expect(session.modeRefreshSignals).toHaveLength(1)

    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingModeCount === 1)
    expect(session.modeSelections[0]).toMatchObject({ modeId: 'code' })
    expect(session.modeSelections[0]?.options?.signal).toBeInstanceOf(AbortSignal)

    terminal.input({ type: 'insert', text: 'continue after mode switch' })
    terminal.input({ type: 'submit' })
    expect(session.submitted).toEqual([])
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Agent mode selection is still being validated',
    ) === true)

    selection.resolve()
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Agent mode switched: code',
    ) === true)
    expect(session.modeSnapshot().current).toBe('code')
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]?.input.text).toBe('continue after mode switch')

    const lateListener = [...session.modeListeners][0]
    await controller.requestExit('user')
    expect(session.modeUnsubscribeCount).toBe(1)
    expect(session.modeListeners.size).toBe(0)
    expect(() => lateListener?.()).not.toThrow()
  })

  it('renders every blocked mode outcome without entering a DSH command or model turn', async () => {
    const session = new FakeSession()
    session.modeState = selectableModeSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 140, rows: 14 })

    const open = async (): Promise<void> => {
      terminal.input({ type: 'insert', text: '/mode' })
      terminal.input({ type: 'submit' })
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('AGENT MODE') === true)
    }
    const expectNotice = async (message: string): Promise<void> => {
      await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(message) === true)
      terminal.input({ type: 'escape' })
    }

    await open()
    terminal.input({ type: 'submit' })
    await expectNotice('This Agent is already using the selected mode')

    session.changeModeState(selectableModeSnapshot({ locked: true }))
    await open()
    terminal.input({ type: 'submit' })
    await expectNotice('Agent mode is fixed after the first turn')

    session.changeModeState(selectableModeSnapshot({ selecting: true }))
    await open()
    terminal.input({ type: 'submit' })
    await expectNotice('A mode switch is already running')

    session.changeModeState(selectableModeSnapshot({
      presets: [{
        id: 'broken',
        trust: 'user',
        sourcePath: 'D:\\presets\\broken\\agent.cordis.yml',
        broken: 'invalid composition',
        isDefault: false,
      }],
      current: 'missing',
    }))
    await open()
    terminal.input({ type: 'submit' })
    await expectNotice('Mode broken is unavailable: invalid composition')

    session.changeModeState({
      available: true,
      loading: false,
      selecting: false,
      locked: false,
      presets: [],
    })
    await open()
    terminal.input({ type: 'submit' })
    await expectNotice('No Agent mode is available to select')

    session.changeModeState(selectableModeSnapshot())
    await open()
    session.changeModeState({
      available: false,
      loading: false,
      selecting: false,
      locked: false,
      presets: [],
    })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Agent modes are unavailable',
    ) === true)
    terminal.input({ type: 'submit' })
    await expectNotice('Agent modes are unavailable in this Session composition')

    expect(session.commandExecutions).toEqual([])
    expect(session.submitted).toEqual([])
    expect(session.modeSelections).toEqual([])
    await controller.requestExit('user')
  })

  it('fences refresh work when official commands, runtime activity, or interactions take focus', async () => {
    const session = new FakeSession()
    session.modeState = selectableModeSnapshot()
    const firstRefresh = Promise.withResolvers<void>()
    session.refreshModesOverride = async signal => {
      await firstRefresh.promise
      signal?.throwIfAborted()
    }
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 140, rows: 14 })

    const open = async (): Promise<void> => {
      terminal.input({ type: 'insert', text: '/mode' })
      terminal.input({ type: 'submit' })
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('AGENT MODE') === true)
    }

    await open()
    await waitFor(() => controller.pendingModeCount === 1)
    for (const action of [
      { type: 'newline' },
      { type: 'backspace' },
      { type: 'delete' },
      { type: 'move-left' },
      { type: 'move-right' },
      { type: 'complete' },
      { type: 'move-home' },
      { type: 'move-end' },
      { type: 'save-default' },
      { type: 'toggle-reasoning' },
      { type: 'toggle-tool-details' },
      { type: 'toggle-goal-actions' },
      { type: 'toggle-activity' },
      { type: 'ignored' },
      { type: 'insert', text: 'not-refresh' },
    ] as const) terminal.input(action)
    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Agent mode refresh is already running',
    ) === true)

    session.changeCommands([{ name: 'mode', description: 'Official mode command' }])
    await waitFor(() => session.modeRefreshSignals[0]?.aborted === true)
    firstRefresh.resolve()
    await waitFor(() => controller.pendingModeCount === 0)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Official /mode command is now registered',
    )

    session.changeCommands([])
    session.refreshModesOverride = async () => { throw new Error('preset catalog exploded') }
    await open()
    await waitFor(() => controller.pendingModeCount === 0)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Agent mode refresh failed: preset catalog exploded',
    ) === true)
    terminal.input({ type: 'escape' })

    session.refreshModesOverride = async () => {}
    await open()
    session.eventsSource.push(runtime(0, 'agent/created', 'running'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Agent mode is fixed after the first turn starts',
    ) === true)
    session.eventsSource.push(runtime(1, 'agent/status', 'idle'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('idle') === true)

    await open()
    session.interactionsSource.push(snapshot([{
      id: 'approval:mode-focus',
      kind: 'approval',
      sessionId: session.sessionId,
      approvalId: 'approval-mode-focus',
      toolName: 'pwsh',
      callId: 'mode-focus',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'PERMISSION REQUIRED',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('AGENT MODE')

    terminal.input({ type: 'escape' })
    await controller.requestExit('user')
  })

  it('contains refresh cancellation while the picker is closed', async () => {
    const session = new FakeSession()
    session.modeState = selectableModeSnapshot()
    const refresh = deferred()
    session.refreshModesOverride = async signal => {
      await refresh.promise
      signal?.throwIfAborted()
    }
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    const probe = controller as unknown as {
      currentBinding: object
      beginModeRefresh(binding: object): void
    }

    probe.beginModeRefresh(probe.currentBinding)
    await waitFor(() => controller.pendingModeCount === 1)
    terminal.input({ type: 'interrupt' })
    expect(session.modeRefreshSignals[0]?.aborted).toBe(true)
    refresh.resolve()
    await waitFor(() => controller.pendingModeCount === 0)
    expect((controller as unknown as { commandNotice?: string }).commandNotice)
      .toBe('Cancelling mode operation')
    await controller.requestExit('user')
  })

  it('reports unavailable and failed selections, and suppresses an admitted cancellation', async () => {
    const session = new FakeSession()
    session.modeState = selectableModeSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    const notice = (): string | undefined => (
      controller as unknown as { commandNotice?: string }
    ).commandNotice
    const openCode = async (): Promise<void> => {
      terminal.input({ type: 'insert', text: '/mode' })
      terminal.input({ type: 'submit' })
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('AGENT MODE') === true)
      terminal.input({ type: 'move-down' })
    }

    await openCode()
    Object.defineProperty(session, 'selectMode', {
      configurable: true,
      value: undefined,
    })
    terminal.input({ type: 'submit' })
    expect(notice()).toBe('Agent mode selection is unavailable in this Session lease')
    delete (session as unknown as { selectMode?: FakeSession['selectMode'] }).selectMode

    session.selectModeOverride = async () => { throw new Error('recompose rejected') }
    await openCode()
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingModeCount === 0)
    expect(notice()).toBe('Agent mode switch failed: recompose rejected')

    const selection = deferred()
    session.selectModeOverride = async (_modeId, options) => {
      await selection.promise
      options?.signal?.throwIfAborted()
    }
    await openCode()
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingModeCount === 1)
    terminal.input({ type: 'interrupt' })
    expect(session.modeSelections.at(-1)?.options?.signal?.aborted).toBe(true)
    selection.resolve()
    await waitFor(() => controller.pendingModeCount === 0)
    expect(notice()).toBe('Cancelling mode operation')

    const lateFailure = deferred()
    session.selectModeOverride = async () => {
      await lateFailure.promise
      throw new Error('late recompose rejection')
    }
    await openCode()
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingModeCount === 1)
    terminal.input({ type: 'interrupt' })
    session.throwOnModeUnsubscribe = new Error('mode unsubscribe failed')
    terminal.input({ type: 'interrupt' })
    lateFailure.resolve()
    await waitFor(() => controller.pendingModeCount === 0)
    await expect(controller.wait()).resolves.toMatchObject({ ok: false, reason: 'forced' })
  })

  it('lets official /mode win, rejects direct local input, and contains cancellation', async () => {
    const official = new FakeSession()
    official.modeState = selectableModeSnapshot()
    official.commands = [{ name: 'mode', description: 'Official mode command' }]
    const first = createProduct({ session: official })
    await first.controller.start()
    first.terminal.input({ type: 'insert', text: '/mode' })
    first.terminal.input({ type: 'submit' })
    await waitFor(() => official.commandExecutions.length === 1)
    expect(official.modeRefreshSignals).toEqual([])
    await first.controller.requestExit('user')

    const local = new FakeSession()
    local.modeState = selectableModeSnapshot()
    const second = createProduct({ session: local })
    await second.controller.start()
    second.terminal.input({ type: 'insert', text: '/mode code' })
    second.terminal.input({ type: 'submit' })
    await waitFor(() => second.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /mode does not accept input',
    ) === true)
    second.terminal.input({ type: 'escape' })
    second.terminal.input({ type: 'insert', text: '/modex' })
    second.terminal.input({ type: 'submit' })
    await waitFor(() => local.submitted.some(item => item.input.text === '/modex'))
    await second.controller.requestExit('user')

    const running = new FakeSession()
    running.modeState = selectableModeSnapshot()
    const third = createProduct({ session: running })
    await third.controller.start()
    running.eventsSource.push(runtime(0, 'agent/created', 'running'))
    await waitFor(() => third.terminal.frames.at(-1)?.lines[0]?.includes('running') === true)
    third.terminal.input({ type: 'insert', text: '/mode' })
    third.terminal.input({ type: 'submit' })
    expect((third.controller as unknown as { commandNotice?: string }).commandNotice)
      .toBe('Mode picker is available only while the Agent is idle')
    expect(running.modeRefreshSignals).toEqual([])
    await third.controller.requestExit('user')

    const pending = new FakeSession()
    pending.modeState = selectableModeSnapshot()
    const gate = deferred()
    pending.selectModeOverride = async () => {
      await gate.promise
    }
    const fourth = createProduct({ session: pending })
    await fourth.controller.start()
    fourth.terminal.input({ type: 'insert', text: '/mode' })
    fourth.terminal.input({ type: 'submit' })
    fourth.terminal.input({ type: 'move-down' })
    fourth.terminal.input({ type: 'submit' })
    await waitFor(() => fourth.controller.pendingModeCount === 1)
    fourth.terminal.input({ type: 'interrupt' })
    await waitFor(() => pending.modeSelections[0]?.options?.signal?.aborted === true)
    fourth.terminal.input({ type: 'interrupt' })
    gate.resolve()
    await expect(fourth.controller.wait()).resolves.toMatchObject({ ok: false, reason: 'forced' })
  })
})

describe('DshTuiController Skills surface', () => {
  it('prewarms the scoped catalog and inserts a skill token without executing it in the TUI', async () => {
    const session = new FakeSession()
    session.skillsState = selectableSkillsSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    await waitFor(() => session.skillsRefreshSignals.length === 1)
    await waitFor(() => controller.pendingSkillsCount === 0)

    terminal.input({ type: 'insert', text: '/rev' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/review') === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('> /review ') === true)
    expect(session.submitted).toEqual([])

    terminal.input({ type: 'insert', text: 'inspect this patch' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]?.input.text).toBe('/review inspect this patch')
    expect(session.commandExecutions).toEqual([])
    await controller.requestExit('user')
  })

  it('browses and filters Skills in a fixed overlay, then returns the literal token to the composer', async () => {
    const session = new FakeSession()
    session.skillsState = selectableSkillsSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 120, rows: 24 })
    await waitFor(() => controller.pendingSkillsCount === 0)

    terminal.input({ type: 'insert', text: '/skills' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('SKILLS · 2') === true)
    const opened = terminal.frames.at(-1)?.lines.join('\n') ?? ''
    expect(opened).toContain('Call   USER ✓')
    expect(opened).toContain('From   workspace · filesystem')
    expect(opened).not.toContain('Up/Down')

    terminal.input({ type: 'insert', text: 'research' })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'move-home' })
    terminal.input({ type: 'move-end' })
    terminal.input({ type: 'delete' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('> /research ') === true)
    expect(session.submitted).toEqual([])

    terminal.input({ type: 'insert', text: 'collect evidence' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]?.input.text).toBe('/research collect evidence')

    terminal.input({ type: 'insert', text: '/skills unexpected' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /skills does not accept input',
    ) === true)
    await controller.requestExit('user')
  })

  it('refetches invalidated catalogs, preserves collisions for commands, and yields to official /skills', async () => {
    const session = new FakeSession()
    session.skillsState = selectableSkillsSnapshot({
      skills: [
        ...selectableSkillsSnapshot().skills,
        {
          name: 'compact',
          description: 'Colliding Skill',
          modelInvocable: true,
          source: 'workspace',
          provider: 'filesystem',
        },
      ],
    })
    session.commands = [{ name: 'compact', description: 'Official compact' }]
    const refreshGate = deferred()
    let refreshCount = 0
    session.refreshSkillsOverride = async () => {
      refreshCount += 1
      if (refreshCount === 2) await refreshGate.promise
    }
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    await waitFor(() => controller.pendingSkillsCount === 0)

    terminal.input({ type: 'insert', text: '/compact' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.length === 1)
    expect(session.commandExecutions[0]?.line).toBe('/compact')

    session.changeSkills(selectableSkillsSnapshot({
      generation: 2,
      complete: false,
      stale: true,
    }))
    await waitFor(() => controller.pendingSkillsCount === 1)
    expect(session.skillsRefreshSignals).toHaveLength(2)
    refreshGate.resolve()
    await waitFor(() => controller.pendingSkillsCount === 0)

    terminal.input({ type: 'insert', text: '/skills' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('SKILLS ·') === true)
    session.changeCommands([
      { name: 'compact', description: 'Official compact' },
      { name: 'skills', description: 'Official Skills command' },
    ])
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Official /skills command is now registered',
    ) === true)

    terminal.input({ type: 'insert', text: '/skills' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.some(call => call.line === '/skills'))
    await controller.requestExit('user')
  })

  it('closes the Skills overlay for interactions and contains refresh and teardown failures', async () => {
    const session = new FakeSession()
    session.skillsState = selectableSkillsSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    await waitFor(() => controller.pendingSkillsCount === 0)
    terminal.input({ type: 'insert', text: '/skills' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('SKILLS ·') === true)

    session.interactionsSource.push({
      type: 'interaction/snapshot',
      sessionId: session.sessionId,
      pending: [{
        id: 'question-1',
        kind: 'question',
        sessionId: session.sessionId,
        questions: [{ id: 'q1', question: 'Continue?' }],
      }],
    })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Continue?') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('SKILLS ·')

    session.interactionsSource.push({
      type: 'interaction/snapshot',
      sessionId: session.sessionId,
      pending: [],
    })
    session.refreshSkillsOverride = async () => { throw new Error('catalog failed') }
    session.changeSkills(selectableSkillsSnapshot({ generation: 3, complete: false }))
    await waitFor(() => controller.pendingSkillsCount === 0)
    expect(session.skillsState.complete).toBe(false)

    session.throwOnSkillsUnsubscribe = new Error('skills unsubscribe failed')
    const result = await controller.requestExit('user')
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.some(issue => (
      issue.phase === 'stop-input'
      && String(issue.error).includes('skills unsubscribe failed')
    ))).toBe(true)
  })

  it('covers direct /skills routing, lookalike prompts, cancellation, and blocked picks', async () => {
    const session = new FakeSession()
    session.skillsState = selectableSkillsSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    await waitFor(() => controller.pendingSkillsCount === 0)

    terminal.input({ type: 'insert', text: '/skills' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('SKILLS ·') === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'newline' })
    terminal.input({ type: 'save-default' })
    terminal.input({ type: 'toggle-reasoning' })
    terminal.input({ type: 'toggle-tool-details' })
    terminal.input({ type: 'toggle-goal-actions' })
    terminal.input({ type: 'toggle-activity' })
    terminal.input({ type: 'ignored' })
    terminal.input({ type: 'escape' })

    terminal.input({ type: 'insert', text: '/skills' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('SKILLS ·') === true)
    terminal.input({ type: 'interrupt' })

    terminal.input({ type: 'insert', text: '/skills' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('SKILLS ·') === true)
    session.changeSkills(selectableSkillsSnapshot({ skills: [] }))
    terminal.input({ type: 'submit' })
    expect((controller as unknown as { commandNotice?: string }).commandNotice)
      .toBe('No skill is available to insert')
    terminal.input({ type: 'escape' })

    session.changeSkills(selectableSkillsSnapshot())
    terminal.input({ type: 'insert', text: '/skills' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('SKILLS ·') === true)
    session.changeSkills(selectableSkillsSnapshot({ available: false }))
    terminal.input({ type: 'submit' })
    expect((controller as unknown as { commandNotice?: string }).commandNotice)
      .toBe('Skills are unavailable in this Agent composition')
    terminal.input({ type: 'escape' })

    session.changeSkills(selectableSkillsSnapshot())
    terminal.input({ type: 'insert', text: '/skillsx' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(item => item.input.text === '/skillsx'))
    await controller.requestExit('user')
  })

  it('contains refresh races and unavailable compatibility ports', async () => {
    const noPort = new FakeSession()
    Object.defineProperty(noPort, 'skillsSnapshot', { value: undefined })
    Object.defineProperty(noPort, 'refreshSkills', { value: undefined })
    Object.defineProperty(noPort, 'onSkillsChanged', { value: undefined })
    const first = createProduct({ session: noPort })
    await first.controller.start()
    expect(first.controller.pendingSkillsCount).toBe(0)
    await first.controller.requestExit('user')

    const unavailable = new FakeSession()
    const second = createProduct({ session: unavailable })
    await second.controller.start()
    const internalUnavailable = second.controller as unknown as {
      openLocalSkillPicker(): void
      currentBinding: { skills: SessionSkillsSnapshot }
    }
    internalUnavailable.openLocalSkillPicker()
    expect((second.controller as unknown as { commandNotice?: string }).commandNotice)
      .toBe('Skills are unavailable in this Agent composition')
    internalUnavailable.currentBinding.skills = selectableSkillsSnapshot()
    Object.defineProperty(unavailable, 'refreshSkills', { value: undefined })
    internalUnavailable.openLocalSkillPicker()
    await second.controller.requestExit('user')

    const racing = new FakeSession()
    racing.skillsState = selectableSkillsSnapshot()
    const gate = Promise.withResolvers<void>()
    racing.refreshSkillsOverride = async signal => {
      if (racing.skillsRefreshSignals.length === 1) return
      await gate.promise
      signal?.throwIfAborted()
    }
    const third = createProduct({ session: racing })
    await third.controller.start()
    await waitFor(() => third.controller.pendingSkillsCount === 0)
    const backgroundPort = new FakeSession('skills-background')
    backgroundPort.skillsState = selectableSkillsSnapshot()
    const background = createSessionBinding(99, backgroundPort, 'background', async () => {})
    const internalBackground = third.controller as unknown as {
      bindings: Set<SessionBinding>
      handleSkillsChanged(binding: SessionBinding): void
      beginSkillsRefresh(binding: SessionBinding): void
      closeBinding(binding: SessionBinding): Promise<void>
    }
    internalBackground.bindings.add(background)
    background.skills = selectableSkillsSnapshot()
    internalBackground.handleSkillsChanged(background)
    internalBackground.beginSkillsRefresh(background)
    await background.skillsRefreshTask
    await internalBackground.closeBinding(background)

    racing.changeSkills(selectableSkillsSnapshot({ generation: 2, complete: false }))
    await waitFor(() => third.controller.pendingSkillsCount === 1)
    racing.changeSkills(selectableSkillsSnapshot({ generation: 3, complete: false }))
    const internalRacing = third.controller as unknown as {
      currentBinding: {
        skillsRefreshAbort?: AbortController
        skillsRefreshGeneration: number
      }
    }
    internalRacing.currentBinding.skillsRefreshAbort?.abort('test cancellation')
    gate.resolve()
    await waitFor(() => third.controller.pendingSkillsCount === 0)

    const staleGate = Promise.withResolvers<void>()
    racing.refreshSkillsOverride = async () => {
      await staleGate.promise
      throw new Error('obsolete refresh failure')
    }
    racing.changeSkills(selectableSkillsSnapshot({ generation: 4, complete: false }))
    await waitFor(() => third.controller.pendingSkillsCount === 1)
    internalRacing.currentBinding.skillsRefreshGeneration += 1
    staleGate.resolve()
    await waitFor(() => third.controller.pendingSkillsCount === 0)

    racing.refreshSkillsOverride = async () => { throw new Error('visible refresh failure') }
    racing.changeSkills(selectableSkillsSnapshot({ generation: 5, complete: true }))
    third.terminal.input({ type: 'insert', text: '/skills' })
    third.terminal.input({ type: 'submit' })
    await waitFor(() => racing.skillsRefreshSignals.length >= 3)
    await waitFor(() => third.controller.pendingSkillsCount === 0)

    const staleListener = [...racing.skillsListeners][0]!
    const binding = (third.controller as unknown as {
      currentBinding: object
      closeBinding(binding: object): Promise<void>
    }).currentBinding
    racing.throwOnSkillsUnsubscribe = new Error('binding skills unsubscribe failed')
    await expect((third.controller as unknown as {
      closeBinding(binding: object): Promise<void>
    }).closeBinding(binding)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'binding skills unsubscribe failed' })],
    })
    expect(() => staleListener()).not.toThrow()
    await expect(third.controller.requestExit('user')).resolves.toMatchObject({ ok: true })
  })
})

describe('DshTuiController model picker', () => {
  it('keeps the draft but blocks prompt submission until model validation commits', async () => {
    const session = new FakeSession()
    const modelState = selectableModelSnapshot({
      current: { provider: 'provider-a', model: 'before' },
      groups: [{
        id: 'provider-a',
        name: 'Provider A',
        models: [{
          provider: 'provider-a',
          providerName: 'Provider A',
          id: 'after',
          name: 'After',
          efforts: [],
        }],
      }],
    })
    session.modelState = modelState
    const validation = Promise.withResolvers<void>()
    session.selectModelOverride = async selection => {
      await validation.promise
      session.changeModelState({ ...modelState, current: selection })
    }
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 120, rows: 12 })

    terminal.input({ type: 'insert', text: '/model' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('MODELS ·') === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingModelCount === 1)

    terminal.input({ type: 'insert', text: 'use the selected model' })
    terminal.input({ type: 'submit' })
    expect(session.submitted).toEqual([])
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model selection is still being validated',
    ) === true)

    validation.resolve()
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model switched: provider-a/after',
    ) === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]?.input.text).toBe('use the selected model')
    await controller.requestExit('user')
  })

  it('uses cached catalog immediately, selects opaque reasoning, and keeps a switched Session when default saving fails', async () => {
    const session = new FakeSession()
    session.modelState = selectableModelSnapshot()
    session.selectModelOverride = async selection => {
      session.changeModelState(selectableModelSnapshot({
        current: selection,
        error: 'settings document is locked',
      }))
      throw new Error('settings document is locked')
    }
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 160, rows: 12 })

    terminal.input({ type: 'insert', text: '/model' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.modelRefreshSignals.length === 1)
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('MODELS ·') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Provider A')

    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('REASONING EFFORT') === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'save-default' })
    await waitFor(() => session.modelSelections.length === 1)

    expect(session.modelSelections[0]).toMatchObject({
      selection: {
        provider: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'opaque/high',
      },
      options: { saveDefault: true },
    })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model switched, but default was not saved: settings document is locked',
    ) === true)
    expect(session.modelSnapshot().current?.reasoningEffort).toBe('opaque/high')

    session.selectModelOverride = async selection => {
      session.changeModelState(selectableModelSnapshot({ current: selection }))
    }
    terminal.input({ type: 'insert', text: '/model' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('MODELS ·') === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('REASONING EFFORT') === true)
    terminal.input({ type: 'save-default' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model switched and saved as default: provider-a/model-a · opaque/high',
    ) === true)

    const lateModelListener = [...session.modelListeners][0]
    await controller.requestExit('user')
    expect(session.modelListeners.size).toBe(0)
    expect(() => lateModelListener?.()).not.toThrow()
  })

  it('lets an official /model command win and refuses the local picker while the Agent is running', async () => {
    const official = new FakeSession()
    official.modelState = selectableModelSnapshot()
    official.commands = [{ name: 'model', description: 'Official model command' }]
    official.commandExecution = { commandId: 'official-model', result: { kind: 'success' } }
    const first = createProduct({ session: official })
    await first.controller.start()
    first.terminal.input({ type: 'insert', text: '/model' })
    first.terminal.input({ type: 'submit' })
    await waitFor(() => official.commandExecutions.length === 1)
    expect(official.modelRefreshSignals).toEqual([])
    await first.controller.requestExit('user')

    const running = new FakeSession()
    running.modelState = selectableModelSnapshot()
    const second = createProduct({ session: running })
    await second.controller.start()
    second.terminal.resize({ columns: 160, rows: 12 })
    running.eventsSource.push(runtime(0, 'agent/created', 'running'))
    await waitFor(() => second.terminal.frames.at(-1)?.lines[0]?.includes('running') === true)
    second.terminal.input({ type: 'insert', text: '/model' })
    second.terminal.input({ type: 'submit' })
    await waitFor(() => second.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model picker is available only while the Agent is idle',
    ) === true)
    expect(running.modelRefreshSignals).toEqual([])
    expect(running.submitted).toEqual([])
    await second.controller.requestExit('user')
  })

  it('refreshes in the background and closes the picker on official registration, running, or interaction focus', async () => {
    const session = new FakeSession()
    session.modelState = selectableModelSnapshot()
    const firstRefresh = Promise.withResolvers<void>()
    session.refreshModelsOverride = async () => { await firstRefresh.promise }
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })

    const open = async (): Promise<void> => {
      terminal.input({ type: 'insert', text: '/model' })
      terminal.input({ type: 'submit' })
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('MODELS ·') === true)
    }

    await open()
    await waitFor(() => controller.pendingModelCount === 1)
    for (const action of [
      { type: 'newline' },
      { type: 'backspace' },
      { type: 'delete' },
      { type: 'move-left' },
      { type: 'move-right' },
      { type: 'complete' },
      { type: 'move-home' },
      { type: 'move-end' },
      { type: 'ignored' },
      { type: 'insert', text: 'not-refresh' },
    ] as const) terminal.input(action)
    terminal.input({ type: 'insert', text: 'R' })
    expect(session.modelRefreshSignals).toHaveLength(1)

    session.changeCommands([{ name: 'model', description: 'Official model command' }])
    await waitFor(() => session.modelRefreshSignals[0]?.aborted === true)
    firstRefresh.reject(new Error('late catalog failure'))
    await waitFor(() => controller.pendingModelCount === 0)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Official /model command is now registered',
    )

    session.changeCommands([])
    session.refreshModelsOverride = async () => { throw new Error('catalog exploded') }
    await open()
    await waitFor(() => controller.pendingModelCount === 0)
    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model catalog refresh failed: catalog exploded',
    ) === true)

    session.refreshModelsOverride = async () => {}
    await open()
    session.eventsSource.push(runtime(0, 'agent/created', 'running'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model picker closed because the Agent is no longer idle',
    ) === true)
    session.eventsSource.push(runtime(1, 'agent/status', 'idle'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('idle') === true)

    await open()
    session.interactionsSource.push(snapshot([{
      id: 'approval:model-focus',
      kind: 'approval',
      sessionId: session.sessionId,
      approvalId: 'approval-model-focus',
      toolName: 'pwsh',
      callId: 'model-focus',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('MODELS · DSH runtime')

    terminal.input({ type: 'escape' })
    await controller.requestExit('user')
  })

  it('contains blocked selections, direct-input errors, and successful or rejected Session-only switches', async () => {
    const session = new FakeSession()
    session.modelState = selectableModelSnapshot({ writable: false })
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })

    const open = async (): Promise<void> => {
      terminal.input({ type: 'insert', text: '/model' })
      terminal.input({ type: 'submit' })
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('MODELS ·') === true)
    }
    const notice = (): string | undefined => (
      controller as unknown as { commandNotice?: string }
    ).commandNotice

    await open()
    terminal.input({ type: 'submit' })
    expect(notice()).toBe('This Agent model is managed by another Host')
    terminal.input({ type: 'escape' })

    session.changeModelState(selectableModelSnapshot({ routable: false }))
    await open()
    terminal.input({ type: 'submit' })
    expect(notice()).toBe('The selected Provider is not currently routable')
    terminal.input({ type: 'escape' })

    session.changeModelState({
      routable: true,
      writable: true,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
    })
    await open()
    terminal.input({ type: 'submit' })
    expect(notice()).toBe('No model is available to select')
    terminal.input({ type: 'escape' })

    session.changeModelState(selectableModelSnapshot({ selecting: true }))
    await open()
    terminal.input({ type: 'submit' })
    expect(notice()).toBe('A model selection is already running')
    terminal.input({ type: 'escape' })

    session.changeModelState(selectableModelSnapshot({
      current: { provider: 'provider-a', model: 'plain-model' },
      groups: [{
        id: 'provider-a',
        name: 'Provider A',
        models: [{
          provider: 'provider-a',
          providerName: 'Provider A',
          id: 'plain-model',
          name: 'Plain Model',
          efforts: [],
        }],
      }],
    }))
    session.selectModelOverride = async selection => {
      session.changeModelState(selectableModelSnapshot({
        current: selection,
        groups: session.modelState.groups,
      }))
    }
    await open()
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model switched: provider-a/plain-model',
    ) === true)

    session.changeModelState(selectableModelSnapshot({
      current: { provider: 'provider-a', model: 'rejected-model' },
      groups: [{
        id: 'provider-a',
        name: 'Provider A',
        models: [{
          provider: 'provider-a',
          providerName: 'Provider A',
          id: 'rejected-model',
          name: 'Rejected Model',
          efforts: [],
        }],
      }],
    }))
    session.selectModelOverride = async () => { throw new Error('route validation failed') }
    await open()
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model switch failed: route validation failed',
    ) === true)

    terminal.input({ type: 'insert', text: '/model explicit' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /model does not accept input',
    ) === true)
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/modelx' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(item => item.input.text === '/modelx'))

    await controller.requestExit('user')
  })

  it('aborts a pending model selection on first Ctrl+C and forces terminal recovery on the second', async () => {
    const session = new FakeSession()
    session.modelState = selectableModelSnapshot({
      current: { provider: 'provider-a', model: 'slow-model' },
      groups: [{
        id: 'provider-a',
        name: 'Provider A',
        models: [{
          provider: 'provider-a',
          providerName: 'Provider A',
          id: 'slow-model',
          name: 'Slow Model',
          efforts: [],
        }],
      }],
    })
    const selected = deferred()
    session.selectModelOverride = async () => { await selected.promise }
    session.throwOnModelUnsubscribe = new Error('model unsubscribe failed')
    const { controller, terminal, application } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/model' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingModelCount === 1)
    expect(controller.pendingModelCount).toBe(1)

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model selection is still being validated',
    ) === true)
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/model' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model selection is still being validated',
    ) === true)
    terminal.input({ type: 'interrupt' })
    expect(session.modelSelections[0]?.options?.signal?.aborted).toBe(true)
    terminal.input({ type: 'interrupt' })
    selected.resolve()

    const result = await controller.wait()
    expect(result).toMatchObject({ ok: false, reason: 'forced' })
    expect(application.forceCount).toBe(1)
    expect(terminal.restoreCount).toBe(1)
  })

  it('suppresses an aborted model rejection and quarantines a rejection that arrives after shutdown', async () => {
    const aborting = new FakeSession()
    aborting.modelState = selectableModelSnapshot({
      groups: [{
        id: 'provider-a',
        name: 'Provider A',
        models: [{
          provider: 'provider-a',
          providerName: 'Provider A',
          id: 'model-a',
          name: 'Model A',
          efforts: [],
        }],
      }],
    })
    aborting.selectModelOverride = async (_selection, options) => {
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new Error('selection aborted'))
        }, { once: true })
      })
    }
    const first = createProduct({ session: aborting })
    await first.controller.start()
    first.terminal.input({ type: 'insert', text: '/model' })
    first.terminal.input({ type: 'submit' })
    first.terminal.input({ type: 'submit' })
    await waitFor(() => first.controller.pendingModelCount === 1)
    first.terminal.input({ type: 'interrupt' })
    await waitFor(() => first.controller.pendingModelCount === 0)
    await first.controller.requestExit('user')

    const late = new FakeSession()
    late.modelState = aborting.modelState
    const completion = Promise.withResolvers<void>()
    late.selectModelOverride = async () => { await completion.promise }
    const second = createProduct({ session: late })
    await second.controller.start()
    second.terminal.input({ type: 'insert', text: '/model' })
    second.terminal.input({ type: 'submit' })
    second.terminal.input({ type: 'submit' })
    await waitFor(() => second.controller.pendingModelCount === 1)
    const exiting = second.controller.requestExit('user')
    completion.reject(new Error('late selection rejection'))
    await expect(exiting).resolves.toMatchObject({ ok: true, reason: 'user' })
  })

  it('cancels a still-running catalog refresh after a Session-only selection closes the picker', async () => {
    const session = new FakeSession()
    session.modelState = selectableModelSnapshot({
      groups: [{
        id: 'provider-a',
        name: 'Provider A',
        models: [{
          provider: 'provider-a',
          providerName: 'Provider A',
          id: 'model-a',
          name: 'Model A',
          efforts: [],
        }],
      }],
    })
    const refresh = deferred()
    session.refreshModelsOverride = async () => { await refresh.promise }
    session.selectModelOverride = async selection => {
      session.changeModelState(selectableModelSnapshot({
        current: selection,
        groups: session.modelState.groups,
      }))
    }
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.input({ type: 'insert', text: '/model' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model switched: provider-a/model-a',
    ) === true)
    expect(controller.pendingModelCount).toBe(1)

    terminal.input({ type: 'interrupt' })
    expect(session.modelRefreshSignals[0]?.aborted).toBe(true)
    refresh.resolve()
    await waitFor(() => controller.pendingModelCount === 0)
    await controller.requestExit('user')
  })

  it('routes exact local and official model commands after command completion is dismissed', async () => {
    const local = new FakeSession()
    local.modelState = selectableModelSnapshot()
    const first = createProduct({ session: local })
    await first.controller.start()
    first.terminal.input({ type: 'insert', text: '/model' })
    first.terminal.input({ type: 'escape' })
    first.terminal.input({ type: 'submit' })
    await waitFor(() => local.modelRefreshSignals.length === 1)
    first.terminal.input({ type: 'escape' })
    await first.controller.requestExit('user')

    const official = new FakeSession()
    official.commands = [{ name: 'model', description: 'Official model command' }]
    official.commandExecution = { commandId: 'official-model', result: { kind: 'success' } }
    const second = createProduct({ session: official })
    await second.controller.start()
    second.terminal.input({ type: 'insert', text: '/model' })
    second.terminal.input({ type: 'escape' })
    second.terminal.input({ type: 'submit' })
    await waitFor(() => official.commandExecutions.length === 1)
    await second.controller.requestExit('user')
  })
})

describe('DshTuiController Provider connection surface', () => {
  it('discovers /connect and completes an official secret flow without rendering the key', async () => {
    const providers = new FakeProviders()
    const promptStarted = deferred<void>()
    providers.connectOverride = async (_provider, _method, interaction) => {
      promptStarted.resolve()
      const key = await interaction.prompt({ kind: 'secret', message: 'DeepSeek API key' })
      expect(key).toBe('sk-controller-secret')
      providers.snapshot = {
        writable: true,
        providers: [{
          ...providers.snapshot.providers[0]!,
          connected: true,
          credential: { kind: 'reference', configured: true, writable: true },
          canDisconnect: true,
        }],
      }
      providers.change(providers.snapshot)
      return { status: 'connected' }
    }
    const { controller, terminal, session } = createProduct({ providers })
    await controller.start()
    terminal.resize({ columns: 120, rows: 12 })

    terminal.input({ type: 'insert', text: '/con' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/connect') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Connect, reconnect, or disconnect')
    terminal.input({ type: 'complete' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('PROVIDERS · DSH/official') === true)
    expect(providers.listSignals).toHaveLength(1)

    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Connect DeepSeek') === true)
    terminal.input({ type: 'submit' })
    await promptStarted.promise
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('secret ›') === true)
    expect(controller.pendingProviderCount).toBe(1)
    terminal.input({ type: 'insert', text: 'sk-controller-secret' })
    await waitFor(() => terminal.frames.at(-1)?.cursor !== undefined)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('sk-controller-secret')
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingProviderCount === 0)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('DeepSeek connected') === true)
    expect(providers.connectCalls).toHaveLength(1)
    expect(session.submitted).toEqual([])

    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('DSH-TUI ·') === true)
    await controller.requestExit('user')
  })

  it('recognizes exact /connect boundaries and lets an official command win', async () => {
    expect(createProduct().controller.pendingProviderCount).toBe(0)
    const providers = new FakeProviders()
    const local = createProduct({ providers })
    await local.controller.start()

    local.terminal.input({ type: 'insert', text: '/connectx' })
    local.terminal.input({ type: 'submit' })
    await waitFor(() => local.session.submitted.length === 1)
    expect(local.session.submitted[0]?.input.text).toBe('/connectx')

    local.terminal.input({ type: 'insert', text: '/connect argument' })
    local.terminal.input({ type: 'submit' })
    await waitFor(() => local.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /connect does not accept input',
    ) === true)
    expect(providers.listSignals).toEqual([])

    local.terminal.input({ type: 'escape' })
    local.terminal.input({ type: 'insert', text: '/connect' })
    await waitFor(() => local.terminal.frames.at(-1)?.lines.join('\n').includes('/connect') === true)
    local.terminal.input({ type: 'escape' })
    local.terminal.input({ type: 'submit' })
    await waitFor(() => local.terminal.frames.at(-1)?.lines[0]?.includes('PROVIDERS ·') === true)
    local.terminal.input({ type: 'escape' })
    local.terminal.input({ type: 'insert', text: 'ordinary prompt' })
    local.terminal.input({ type: 'submit' })
    await waitFor(() => local.session.submitted.length === 2)
    expect(local.session.submitted[1]?.input.text).toBe('ordinary prompt')
    await local.controller.requestExit('user')

    const officialSession = new FakeSession()
    officialSession.commands = [{ name: 'connect', description: 'Official connect command' }]
    officialSession.commandExecution = { commandId: 'official-connect', result: { kind: 'success' } }
    const officialProviders = new FakeProviders()
    const official = createProduct({ session: officialSession, providers: officialProviders })
    await official.controller.start()
    official.terminal.input({ type: 'insert', text: '/connect' })
    official.terminal.input({ type: 'submit' })
    await waitFor(() => officialSession.commandExecutions.length === 1)
    expect(officialProviders.listSignals).toEqual([])
    expect(officialSession.commandExecutions[0]?.line).toBe('/connect')
    await official.controller.requestExit('user')
  })

  it('closes the local surface on official registration, Agent activity, or Session interaction', async () => {
    const providers = new FakeProviders()
    const session = new FakeSession()
    const { controller, terminal } = createProduct({ session, providers })
    await controller.start()
    terminal.resize({ columns: 120, rows: 10 })

    const open = async (): Promise<void> => {
      terminal.input({ type: 'insert', text: '/connect' })
      terminal.input({ type: 'submit' })
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('PROVIDERS ·') === true)
    }

    await open()
    session.changeCommands([{ name: 'connect', description: 'Official connect' }])
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Official /connect command is now registered',
    ) === true)
    expect(providers.listeners.size).toBe(0)

    session.changeCommands([])
    session.eventsSource.push(runtime(0, 'agent/created', 'running'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('running') === true)
    terminal.input({ type: 'insert', text: '/connect' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Provider connection is available only while the Agent is idle',
    ) === true)
    expect(providers.listeners.size).toBe(0)

    const frameCountBeforeIdle = terminal.frames.length
    session.eventsSource.push(runtime(1, 'agent/status', 'idle'))
    await waitFor(() => terminal.frames.length > frameCountBeforeIdle)
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('PROVIDERS ·') === true)
    session.eventsSource.push(runtime(2, 'agent/status', 'running'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Provider connection closed because the Agent is no longer idle',
    ) === true)

    session.eventsSource.push(runtime(3, 'agent/status', 'idle'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('idle') === true)
    await open()
    session.interactionsSource.push(snapshot([{
      id: 'approval:provider-focus',
      kind: 'approval',
      sessionId: session.sessionId,
      approvalId: 'approval-provider-focus',
      toolName: 'pwsh',
      callId: 'provider-focus',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'PERMISSION REQUIRED',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('PROVIDERS · DSH/official')
    expect(providers.listeners.size).toBe(0)

    terminal.input({ type: 'escape' })
    await controller.requestExit('user')
  })

  it('aborts and joins a pending Provider directory read during shutdown', async () => {
    const providers = new FakeProviders()
    providers.listOverride = options => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        reject(new Error('directory read aborted'))
      }, { once: true })
    })
    const { controller, terminal } = createProduct({ providers })
    await controller.start()
    terminal.input({ type: 'insert', text: '/connect' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingProviderCount === 1)

    const result = await controller.requestExit('user')
    expect(result).toMatchObject({ ok: true, reason: 'user' })
    expect(providers.listSignals[0]?.aborted).toBe(true)
    expect(providers.listeners.size).toBe(0)
    expect(controller.pendingProviderCount).toBe(0)
  })

  it('contains a Provider subscription failure during input quiesce', async () => {
    const providers = new FakeProviders()
    providers.throwOnUnsubscribe = new Error('provider unsubscribe failed')
    const { controller, terminal } = createProduct({ providers })
    await controller.start()
    terminal.input({ type: 'insert', text: '/connect' })
    terminal.input({ type: 'submit' })
    await waitFor(() => providers.listeners.size === 1)

    const result = await controller.requestExit('user')
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.some(issue => (
      issue.phase === 'stop-input'
      && String(issue.error).includes('provider unsubscribe failed')
    ))).toBe(true)
  })
})

describe('DshTuiController official workbench surface', () => {
  function missionSnapshot(
    phase: 'active' | 'paused' | 'blocked' = 'active',
  ): SessionWorkbenchSnapshot {
    return {
      available: true,
      asOfSeq: phase === 'active' ? 4 : 8,
      goal: {
        id: 'goal-workbench',
        revision: phase === 'active' ? 1 : phase === 'paused' ? 2 : 3,
        objective: 'Ship the first-party workbench',
        phase,
        ...(phase === 'blocked'
          ? { blockedReason: { code: 'review', message: 'Waiting for review' } }
          : {}),
        maxGoalRounds: 8,
        roundsStarted: 3,
        createdAt: 10,
        updatedAt: 20,
      },
      plan: { active: true, pending: false },
      todos: [
        { content: 'Adapt projections', status: 'completed' },
        { content: 'Render mission rail', status: 'in_progress' },
      ],
    }
  }

  it('owns discoverable safe exit and active-turn stop commands even without a catalog', async () => {
    const exiting = new FakeSession()
    exiting.throwOnListCommands = new Error('catalog offline')
    const exitProduct = createProduct({ session: exiting })
    await exitProduct.controller.start()

    const frameCount = exitProduct.terminal.frames.length
    exitProduct.terminal.input({ type: 'insert', text: '/' })
    await waitFor(() => exitProduct.terminal.frames.length > frameCount)
    expect(exitProduct.terminal.frames.at(-1)?.overlay?.kind).toBe('palette')
    expect(exitProduct.terminal.frames.at(-1)?.lines.join('\n')).toContain('/exit')
    exitProduct.terminal.input({ type: 'insert', text: 'exit' })
    exitProduct.terminal.input({ type: 'submit' })
    const exitResult = await exitProduct.controller.wait()
    expect(exitResult).toMatchObject({ ok: true, reason: 'user' })
    expect(exitProduct.terminal.restoreCount).toBe(1)
    expect(exitProduct.application.requestCount).toBe(1)
    expect(exiting.submitted).toEqual([])
    expect(exiting.commandExecutions).toEqual([])

    const running = new FakeSession()
    running.throwOnListCommands = new Error('catalog offline')
    const stopProduct = createProduct({ session: running })
    await stopProduct.controller.start()
    running.eventsSource.push(runtime(0, 'agent/created'))
    running.eventsSource.push(runtime(1, 'agent/status', 'running'))
    await waitFor(() => stopProduct.terminal.frames.at(-1)?.lines[0]?.includes('running') === true)
    stopProduct.terminal.input({ type: 'insert', text: '/stop' })
    stopProduct.terminal.input({ type: 'submit' })
    await waitFor(() => running.cancellations.length === 1)
    expect(running.cancellations).toEqual([{ kind: 'user' }])
    expect(running.submitted).toEqual([])
    expect(stopProduct.controller.state).toBe('running')
    await stopProduct.controller.requestExit('user')
  })

  it('rejects safety-command arguments, reports idle or foreign turns, and toggles Tool Run detail', async () => {
    for (const command of ['/exit later', '/stop later', '/exit-now']) {
      const session = new FakeSession()
      session.throwOnListCommands = new Error('catalog offline')
      const product = createProduct({ session })
      await product.controller.start()
      const frameCount = product.terminal.frames.length
      product.terminal.input({ type: 'insert', text: command })
      product.terminal.input({ type: 'submit' })
      await waitFor(() => product.terminal.frames.length > frameCount)
      const expected = command === '/exit-now'
        ? 'Command catalog unavailable: catalog offline'
        : `Local /${command.startsWith('/exit') ? 'exit' : 'stop'} does not accept input`
      expect(product.terminal.frames.at(-1)?.lines.join('\n'), command).toContain(expected)
      expect(product.controller.state).toBe('running')
      expect(session.cancellations).toEqual([])
      await product.controller.requestExit('user')
    }

    const idle = createProduct()
    await idle.controller.start()
    idle.terminal.input({ type: 'insert', text: '/stop' })
    idle.terminal.input({ type: 'submit' })
    await waitFor(() => idle.terminal.frames.at(-1)?.lines.join('\n').includes(
      'No active Agent turn to stop',
    ) === true)
    await idle.controller.requestExit('user')

    const dismissed = createProduct()
    await dismissed.controller.start()
    dismissed.terminal.input({ type: 'insert', text: '/stop' })
    dismissed.terminal.input({ type: 'escape' })
    dismissed.terminal.input({ type: 'submit' })
    await waitFor(() => dismissed.terminal.frames.at(-1)?.lines.join('\n').includes(
      'No active Agent turn to stop',
    ) === true)
    await dismissed.controller.requestExit('user')

    const busySession = new FakeSession()
    busySession.commands = [{ name: 'compact', description: 'Compact' }]
    const commandGate = deferred<DshCommandExecution | undefined>()
    busySession.executeCommandOverride = () => commandGate.promise
    const busy = createProduct({ session: busySession })
    await busy.controller.start()
    busy.terminal.input({ type: 'insert', text: '/compact' })
    busy.terminal.input({ type: 'submit' })
    await waitFor(() => busy.controller.pendingCommandCount === 1)
    busy.terminal.input({ type: 'insert', text: '/sessions' })
    busy.terminal.input({ type: 'submit' })
    await waitFor(() => busy.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Running command…',
    ) === true)
    commandGate.resolve({ commandId: 'busy-command', result: { kind: 'success' } })
    await waitFor(() => busy.controller.pendingCommandCount === 0)
    await busy.controller.requestExit('user')

    const foreignSession = new FakeSession('session-a', false)
    const foreign = createProduct({ session: foreignSession })
    await foreign.controller.start()
    foreignSession.eventsSource.push(runtime(0, 'agent/created', 'running'))
    await waitFor(() => foreign.terminal.frames.at(-1)?.lines[0]?.includes('running') === true)
    foreign.terminal.input({ type: 'insert', text: '/stop' })
    foreign.terminal.input({ type: 'submit' })
    await waitFor(() => foreign.terminal.frames.at(-1)?.lines.join('\n').includes(
      'controlled by another Host',
    ) === true)
    expect(foreignSession.cancellations).toEqual([])
    await foreign.controller.requestExit('user')

    const details = createProduct()
    await details.controller.start()
    details.terminal.resize({ columns: 140, rows: 24 })
    details.session.eventsSource.push(runtime(0, 'agent/created', 'running'))
    await waitFor(() => details.terminal.frames.at(-1)?.lines[0]?.includes('running') === true)
    const beforeToggle = details.terminal.frames.length
    details.terminal.input({ type: 'toggle-tool-details' })
    await waitFor(() => details.terminal.frames.length > beforeToggle)
    expect(details.terminal.frames.at(-1)?.lines.join('\n')).not.toContain('Ctrl+O')
    await details.controller.requestExit('user')
  })

  it('rehydrates and repaints the official Goal, Plan, and Todo projections', async () => {
    const session = new FakeWorkbenchSession()
    session.workbenchState = missionSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 100, rows: 24 })

    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'GOAL ACTIVE · round 3/8 · PLAN ON · TODO 1/2',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('WORKBENCH DASHBOARD')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('● Render mission rail')
    expect(session.workbenchListeners.size).toBe(1)

    session.changeWorkbench(missionSnapshot('blocked'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Waiting for review',
    ) === true)

    terminal.input({ type: 'insert', text: '/' })
    await waitFor(() => terminal.frames.at(-1)?.overlay?.kind === 'palette')
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('COMMANDS')
    expect(terminal.frames.at(-1)?.lines.at(-1)).toContain('> /')
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('GOAL BLOCKED')
    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'GOAL BLOCKED',
    ) === true)

    const lateChange = [...session.workbenchListeners][0]!
    await controller.requestExit('user')
    expect(session.workbenchUnsubscribeCount).toBe(1)
    expect(session.workbenchListeners.size).toBe(0)
    expect(() => lateChange()).not.toThrow()
  })

  it('routes Ctrl+G pause/resume through exact official Goal revisions without optimistic projection', async () => {
    const session = new FakeWorkbenchSession()
    session.workbenchState = missionSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 100, rows: 24 })

    terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('GOAL ACTIONS') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('goal> Pause goal')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('[DSH/official]')

    terminal.input({ type: 'submit' })
    await waitFor(() => session.goalActionCalls.length === 1)
    expect(session.goalActionCalls[0]).toEqual({
      kind: 'pause',
      ref: { id: 'goal-workbench', revision: 1 },
    })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Notice: Goal paused') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('GOAL ACTIVE')

    session.changeWorkbench(missionSnapshot('paused'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('GOAL PAUSED') === true)
    terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('goal> Resume goal') === true)
    terminal.input({ type: 'submit' })
    expect(session.goalActionCalls[1]).toEqual({
      kind: 'resume',
      ref: { id: 'goal-workbench', revision: 2 },
    })

    terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('GOAL ACTIONS') === true)
    terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('GOAL ACTIONS') === false)
    await controller.requestExit('user')
  })

  it('edits, confirms clear, and keeps official Goal failures actionable', async () => {
    const session = new FakeWorkbenchSession()
    session.workbenchState = missionSnapshot('blocked')
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 100, rows: 24 })

    terminal.input({ type: 'toggle-goal-actions' })
    terminal.input({ type: 'move-up' })
    for (const action of [
      { type: 'newline' },
      { type: 'complete' },
      { type: 'save-default' },
      { type: 'toggle-reasoning' },
      { type: 'ignored' },
      { type: 'insert', text: 'ignored while in the menu' },
    ] as const) terminal.input(action)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Type the replacement objective') === true)
    for (const action of [
      { type: 'backspace' },
      { type: 'delete' },
      { type: 'move-left' },
      { type: 'move-right' },
      { type: 'move-home' },
      { type: 'move-end' },
    ] as const) terminal.input(action)
    terminal.input({ type: 'insert', text: 'Revised objective' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'goal> Revised objective',
    ) === true)

    session.goalActionReceipt = {
      accepted: false,
      code: 'goal-stale',
      message: 'Refresh the official revision.',
    }
    terminal.input({ type: 'submit' })
    expect(session.goalActionCalls.at(-1)).toEqual({
      kind: 'edit',
      ref: { id: 'goal-workbench', revision: 3 },
      objective: 'Revised objective',
    })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'goal-stale: Refresh the official revision.',
    ) === true)

    terminal.input({ type: 'escape' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'This writes the official tombstone',
    ) === true)
    session.goalActionReceipt = { accepted: true }
    terminal.input({ type: 'submit' })
    expect(session.goalActionCalls.at(-1)).toEqual({
      kind: 'clear',
      ref: { id: 'goal-workbench', revision: 3 },
    })

    session.throwOnGoalAction = 'Goal service exploded'
    terminal.input({ type: 'toggle-goal-actions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'goal-action-failed: Goal service exploded',
    ) === true)
    terminal.input({ type: 'interrupt' })
    await controller.requestExit('user')
  })

  it('keeps Goal creation on /goal and explains unavailable projections or actions', async () => {
    const session = new FakeWorkbenchSession()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 100, rows: 24 })

    terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Goal projections are unavailable',
    ) === true)

    session.changeWorkbench({ available: true, goal: null })
    terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/goal ') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Goal creation stays on the official /goal command',
    )
    terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'finish or clear the current draft first',
    ) === true)
    await controller.requestExit('user')

    const noActions = new FakeWorkbenchSession()
    noActions.workbenchState = missionSnapshot()
    Object.defineProperty(noActions, 'runGoalAction', { value: undefined })
    const unavailable = createProduct({ session: noActions })
    await unavailable.controller.start()
    unavailable.terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => unavailable.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Goal actions are unavailable in this Session lease',
    ) === true)
    await unavailable.controller.requestExit('user')
  })

  it('yields an open Goal action dock to a pending interaction or removed Goal', async () => {
    const session = new FakeWorkbenchSession()
    session.workbenchState = missionSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('GOAL ACTIONS') === true)

    session.interactionsSource.push(snapshot([{
      id: 'approval-over-goal',
      kind: 'approval',
      sessionId: session.sessionId,
      approvalId: 'approval-over-goal',
      callId: 'call-over-goal',
      toolName: 'read',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('GOAL ACTIONS')

    session.interactionsSource.push(snapshot([], session.sessionId))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === false)
    terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('GOAL ACTIONS') === true)
    session.changeWorkbench({ available: true, goal: null })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('GOAL ACTIONS') === false)
    await controller.requestExit('user')
  })

  it('contains a workbench subscription failure during input quiesce', async () => {
    const session = new FakeWorkbenchSession()
    session.throwOnWorkbenchUnsubscribe = new Error('workbench unsubscribe failed')
    const { controller } = createProduct({ session })
    await controller.start()

    const result = await controller.requestExit('user')
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.some(issue => (
      issue.phase === 'stop-input'
      && String(issue.error).includes('workbench unsubscribe failed')
    ))).toBe(true)
  })
})

describe('DshTuiController official Jobs Activity surface', () => {
  function jobsSnapshot(
    status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed' = 'running',
    generation = 4,
  ): SessionJobsSnapshot {
    return {
      available: true,
      generation,
      jobs: [
        {
          id: 'bash-1',
          kind: 'bash',
          label: 'pnpm test',
          status: 'completed',
          detail: 'exit code: 0',
          startedAt: 10,
          finishedAt: 20,
          reported: false,
        },
        {
          id: 'subagent-1',
          kind: 'subagent',
          label: 'Review the Jobs adapter',
          status,
          ...(status === 'running' || status === 'stopping'
            ? {}
            : { finishedAt: 40 }),
          startedAt: 30,
          reported: status !== 'running',
        },
      ],
    }
  }

  it('rehydrates live Activity cards and routes a confirmed stop through the exact job ref', async () => {
    const session = new FakeJobsSession()
    session.jobsState = jobsSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 100, rows: 28 })

    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('JOBS 1') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('ACTIVITY · subagent-1')
    expect(session.jobsListeners.size).toBe(1)

    terminal.input({ type: 'toggle-activity' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('ACTIVITY') === true)
    expect(terminal.frames.at(-1)?.overlay).toMatchObject({
      kind: 'directory',
      anchor: 'center',
    })

    for (const action of [
      { type: 'newline' },
      { type: 'backspace' },
      { type: 'move-home' },
      { type: 'move-end' },
      { type: 'save-default' },
      { type: 'toggle-reasoning' },
      { type: 'ignored' },
      { type: 'insert', text: 'x' },
    ] as const) terminal.input(action)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'insert', text: 'K' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Stop Review the Jobs adapter?  Enter confirm',
    ) === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => session.jobActionCalls.length === 1)
    expect(session.jobActionCalls[0]).toEqual({
      kind: 'kill',
      ref: { id: 'subagent-1', startedAt: 30, generation: 4 },
    })
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Notice: Stop requested for subagent-1',
    )

    session.changeJobs(jobsSnapshot('stopping'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Review the Jobs adapter  stopping',
    ) === true)
    terminal.input({ type: 'toggle-activity' })
    await waitFor(() => terminal.frames.at(-1)?.overlay === undefined)
    terminal.input({ type: 'toggle-activity' })
    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.overlay === undefined)
    terminal.input({ type: 'toggle-activity' })
    terminal.input({ type: 'interrupt' })
    await waitFor(() => terminal.frames.at(-1)?.overlay === undefined)

    const lateChange = [...session.jobsListeners][0]!
    await controller.requestExit('user')
    expect(session.jobsUnsubscribeCount).toBe(1)
    expect(session.jobsListeners.size).toBe(0)
    expect(() => lateChange()).not.toThrow()
  })

  it('switches focus with Goal, contains action failures, and yields to interactions', async () => {
    const session = new FakeJobsSession()
    session.jobsState = jobsSnapshot()
    session.workbenchState = {
      available: true,
      goal: {
        id: 'goal-with-jobs',
        revision: 2,
        objective: 'Integrate Jobs Activity',
        phase: 'active',
        maxGoalRounds: 8,
        roundsStarted: 2,
        createdAt: 1,
        updatedAt: 2,
      },
    }
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 100, rows: 28 })

    terminal.input({ type: 'toggle-activity' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('ACTIVITY') === true)
    terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('GOAL ACTIONS') === true)
    terminal.input({ type: 'toggle-activity' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('ACTIVITY') === true)

    session.jobActionReceipt = {
      accepted: false,
      code: 'job-reference-stale',
      message: 'select again',
    }
    terminal.input({ type: 'insert', text: 'k' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'job-reference-stale: select again',
    ) === true)

    session.throwOnJobAction = 'kill exploded'
    terminal.input({ type: 'insert', text: 'k' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'job-action-failed: kill exploded',
    ) === true)
    session.throwOnJobAction = undefined
    session.jobActionReceipt = { accepted: true, outcome: 'already-finished' }
    terminal.input({ type: 'insert', text: 'k' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Job subagent-1 already finished',
    ) === true)

    session.interactionsSource.push(snapshot([{
      id: 'approval-over-activity',
      kind: 'approval',
      sessionId: session.sessionId,
      approvalId: 'approval-over-activity',
      callId: 'call-over-activity',
      toolName: 'bash',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === true)
    expect(terminal.frames.at(-1)?.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })
    await controller.requestExit('user')
  })

  it('explains unavailable registry and missing action capabilities', async () => {
    const unavailableSession = new FakeJobsSession()
    const unavailable = createProduct({ session: unavailableSession })
    await unavailable.controller.start()
    unavailable.terminal.input({ type: 'toggle-activity' })
    await waitFor(() => unavailable.terminal.frames.at(-1)?.lines.join('\n').includes(
      'No background Jobs in this Session.',
    ) === true)
    expect(unavailable.terminal.frames.at(-1)?.overlay?.kind).toBe('directory')
    await unavailable.controller.requestExit('user')

    const noActions = new FakeJobsSession()
    noActions.jobsState = jobsSnapshot()
    Object.defineProperty(noActions, 'runJobAction', { value: undefined })
    const missing = createProduct({ session: noActions })
    await missing.controller.start()
    missing.terminal.input({ type: 'toggle-activity' })
    missing.terminal.input({ type: 'insert', text: 'k' })
    await waitFor(() => missing.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Stop Review the Jobs adapter?  Enter confirm',
    ) === true)
    missing.terminal.input({ type: 'submit' })
    await waitFor(() => missing.terminal.frames.at(-1)?.lines.join('\n').includes(
      'jobs-capability-unavailable',
    ) === true)
    await missing.controller.requestExit('user')
  })

  it('contains a Jobs subscription failure during input quiesce', async () => {
    const session = new FakeJobsSession()
    session.throwOnJobsUnsubscribe = new Error('jobs unsubscribe failed')
    const { controller } = createProduct({ session })
    await controller.start()

    const result = await controller.requestExit('user')
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.some(issue => (
      issue.phase === 'stop-input'
      && String(issue.error).includes('jobs unsubscribe failed')
    ))).toBe(true)
  })
})

describe('DshTuiController Subagent and Workflow Activity Center', () => {
  function delegationSnapshot(
    overrides: Partial<SessionDelegationSnapshot> = {},
  ): SessionDelegationSnapshot {
    return {
      available: true,
      generation: 6,
      loading: false,
      subagentsAvailable: true,
      subagents: [
        {
          id: 'child-live', parentId: 'session-a', depth: 1,
          mode: 'continuable', label: 'Live child', status: 'running',
          hasChildren: false, interruptible: true,
        },
        {
          id: 'child-idle', parentId: 'session-a', depth: 1,
          mode: 'continuable', label: 'Idle child', status: 'idle',
          hasChildren: false, interruptible: false,
        },
      ],
      workflows: [{
        id: 'run-1', name: 'Review workflow', status: 'running', startSeq: 3,
        phases: [{
          key: 'missing', phase: null,
          members: [{
            seq: 1, label: 'Review', childId: 'child-live', status: 'running',
          }],
        }],
      }],
      ...overrides,
    }
  }

  it('navigates tabs and routes Subagent control without inventing Workflow cancel authority', async () => {
    const session = new FakeDelegationSession()
    session.delegationState = delegationSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 110, rows: 30 })
    expect(session.delegationListeners.size).toBe(1)
    expect(controller.pendingDelegationCount).toBe(0)

    terminal.input({ type: 'toggle-activity' })
    terminal.input({ type: 'move-right' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('SUBAGENTS') === true)
    terminal.input({ type: 'delete' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Stop Live child?',
    ) === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => session.delegationActionCalls.length === 1)
    expect(session.delegationActionCalls[0]).toEqual({
      kind: 'interrupt-subagent',
      ref: { id: 'child-live', parentId: 'session-a', generation: 6 },
    })
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Notice: Interrupt requested for child-live',
    )

    session.delegationActionReceipt = {
      accepted: false,
      code: 'subagent-reference-stale',
      message: 'select again',
    }
    terminal.input({ type: 'insert', text: 'k' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'subagent-reference-stale: select again',
    ) === true)

    session.throwOnDelegationAction = 'interrupt exploded'
    terminal.input({ type: 'insert', text: 'k' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'subagent-action-failed: interrupt exploded',
    ) === true)
    session.throwOnDelegationAction = undefined
    session.delegationActionReceipt = { accepted: true, outcome: 'already-idle' }
    terminal.input({ type: 'insert', text: 'k' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Subagent child-live is already idle',
    ) === true)

    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'delete' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Subagent idle cannot be stopped',
    ) === true)
    terminal.input({ type: 'move-right' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('WORKFLOWS') === true)
    terminal.input({ type: 'delete' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'no independent cancel authority',
    ) === true)
    terminal.input({ type: 'move-left' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('SUBAGENTS') === true)

    const gate = deferred()
    session.refreshDelegationOverride = async () => { await gate.promise }
    terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => controller.pendingDelegationCount === 1)
    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'refresh is already running',
    ) === true)
    gate.resolve()
    await waitFor(() => controller.pendingDelegationCount === 0)

    session.changeDelegation(delegationSnapshot({ generation: 7, workflows: [] }))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Subagents 2/1') === true)
    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.overlay === undefined)

    const lateChange = [...session.delegationListeners][0]!
    await controller.requestExit('user')
    expect(session.delegationUnsubscribeCount).toBe(1)
    expect(() => lateChange()).not.toThrow()
  })

  it('handles local and official /activity command ownership precisely', async () => {
    const localSession = new FakeDelegationSession()
    localSession.delegationState = delegationSnapshot()
    const local = createProduct({ session: localSession })
    await local.controller.start()

    local.terminal.input({ type: 'insert', text: '/activity argument' })
    local.terminal.input({ type: 'submit' })
    await waitFor(() => local.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /activity does not accept input',
    ) === true)
    await local.controller.requestExit('user')

    const boundarySession = new FakeDelegationSession()
    boundarySession.delegationState = delegationSnapshot()
    const boundary = createProduct({ session: boundarySession })
    await boundary.controller.start()
    boundary.terminal.input({ type: 'insert', text: '/activityx' })
    boundary.terminal.input({ type: 'submit' })
    await waitFor(() => boundarySession.submitted.some(item => item.input.text === '/activityx'))
    await boundary.controller.requestExit('user')

    const exactSession = new FakeDelegationSession()
    exactSession.delegationState = delegationSnapshot()
    const exact = createProduct({ session: exactSession })
    await exact.controller.start()
    const exactPrompt = exact.controller as unknown as {
      prompt: ReturnType<typeof createPromptEditorState>
      submitPrompt(): void
      openLocalCommand(name: string): void
    }
    exactPrompt.prompt = createPromptEditorState('/activity')
    exactPrompt.submitPrompt()
    await waitFor(() => exact.terminal.frames.at(-1)?.overlay?.kind === 'directory')

    exact.terminal.input({ type: 'escape' })
    exactPrompt.openLocalCommand('activity')
    await waitFor(() => exact.terminal.frames.at(-1)?.overlay?.kind === 'directory')
    await exact.controller.requestExit('user')

    const officialSession = new FakeDelegationSession()
    officialSession.delegationState = delegationSnapshot()
    officialSession.commands = [{ name: 'activity', description: 'Official activity command' }]
    officialSession.commandExecution = {
      commandId: 'official-activity',
      result: { kind: 'success' },
    }
    const official = createProduct({ session: officialSession })
    await official.controller.start()
    const officialPrompt = official.controller as unknown as {
      prompt: ReturnType<typeof createPromptEditorState>
      submitPrompt(): void
    }
    officialPrompt.prompt = createPromptEditorState('/activity')
    officialPrompt.submitPrompt()
    await waitFor(() => officialSession.commandExecutions.length === 1)
    expect(official.terminal.frames.at(-1)?.overlay).toBeUndefined()
    await official.controller.requestExit('user')
  })

  it('auto-refreshes an empty mounted Subagent catalog', async () => {
    const session = new FakeDelegationSession()
    session.delegationState = delegationSnapshot({ subagents: [] })
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.input({ type: 'toggle-activity' })
    await waitFor(() => session.delegationRefreshSignals.length === 1)
    await waitFor(() => controller.pendingDelegationCount === 0)
    await controller.requestExit('user')
  })

  it('keeps background delegation refresh and notifications out of the current frame', async () => {
    const session = new FakeDelegationSession()
    const { controller } = createProduct({ session })
    await controller.start()
    const candidatePort = new FakeDelegationSession('delegation-candidate')
    candidatePort.delegationState = delegationSnapshot({ generation: 12 })
    const probe = controller as unknown as {
      createBinding(
        port: FakeDelegationSession,
        role: 'candidate',
        release: () => Promise<void>,
      ): {
        delegationRefreshTask?: Promise<void>
        delegationSubscription?: () => void
      }
      beginDelegationRefresh(binding: object): void
      handleDelegationChanged(binding: object): void
      closeBinding(binding: object): Promise<void>
    }
    const candidate = probe.createBinding(
      candidatePort,
      'candidate',
      () => candidatePort.dispose(),
    )
    probe.handleDelegationChanged(candidate)
    probe.beginDelegationRefresh(candidate)
    await candidate.delegationRefreshTask

    candidate.delegationSubscription = () => {
      throw new Error('candidate delegation unsubscribe failed')
    }
    await expect(probe.closeBinding(candidate)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'candidate delegation unsubscribe failed' })],
    })
    await controller.requestExit('user')
  })

  it('contains missing capabilities, refresh failures, and action failures in the overlay', async () => {
    const session = new FakeDelegationSession()
    session.delegationState = delegationSnapshot()
    Object.defineProperty(session, 'runDelegationAction', { value: undefined })
    const product = createProduct({ session })
    await product.controller.start()
    product.terminal.resize({ columns: 110, rows: 30 })
    product.terminal.input({ type: 'toggle-activity' })
    product.terminal.input({ type: 'move-right' })
    product.terminal.input({ type: 'insert', text: 'k' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => product.terminal.frames.at(-1)?.lines.join('\n').includes(
      'delegation-capability-unavailable',
    ) === true)

    Object.defineProperty(session, 'refreshDelegation', { value: undefined })
    product.terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => product.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Subagent catalog refresh is unavailable',
    ) === true)
    await product.controller.requestExit('user')

    const failing = new FakeDelegationSession()
    failing.delegationState = delegationSnapshot()
    failing.refreshDelegationOverride = async () => { throw new Error('refresh exploded') }
    const failed = createProduct({ session: failing })
    await failed.controller.start()
    failed.terminal.input({ type: 'toggle-activity' })
    failed.terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => failed.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Subagent refresh failed: refresh exploded',
    ) === true)
    await failed.controller.requestExit('user')
  })

  it('aborts refresh and reports delegation unsubscribe failures during safe shutdown', async () => {
    const session = new FakeDelegationSession()
    session.delegationState = delegationSnapshot()
    const aborted = deferred<void>()
    session.refreshDelegationOverride = signal => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        aborted.resolve()
        reject(new Error('refresh aborted'))
      }, { once: true })
    })
    session.throwOnDelegationUnsubscribe = new Error('delegation unsubscribe failed')
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.input({ type: 'toggle-activity' })
    terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => controller.pendingDelegationCount === 1)
    const resultPromise = controller.requestExit('user')
    await aborted.promise
    const result = await resultPromise
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.some(issue => (
      issue.phase === 'stop-input'
      && String(issue.error).includes('delegation unsubscribe failed')
    ))).toBe(true)
  })
})

describe('DshTuiController official context-meter surface', () => {
  function contextSnapshot(
    projectedTokens: number,
    asOfSeq: number,
  ): SessionContextSnapshot {
    return {
      available: true,
      asOfSeq,
      pressure: {
        pressureTokens: 72_000,
        projectedTokens,
        contextWindow: 128_000,
      },
      breakdown: {
        systemTokens: 1_000,
        toolsTokens: 2_000,
        messageTokens: 5_000,
      },
      usage: {
        uncachedInputTokens: 70_000,
        outputTokens: 900,
        cacheReadTokens: 2_000,
        cacheWriteTokens: 0,
      },
    }
  }

  it('shows live official occupancy and routes local /context without entering the model lane', async () => {
    const session = new FakeContextSession()
    session.contextState = contextSnapshot(64_000, 4)
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 120, rows: 10 })

    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'CTX [━━━━····] ~64K/128K 50%',
    ) === true)
    expect(session.contextListeners.size).toBe(1)

    terminal.input({ type: 'insert', text: '/context' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes(
      'CONTEXT WINDOW',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      '50%  ·  ~64K / 128K  ·  HEALTHY',
    )
    expect(session.submitted).toEqual([])
    expect(session.commandExecutions).toEqual([])

    session.changeContext(contextSnapshot(8_000, 5))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '6%  ·  ~8K / 128K  ·  HEALTHY',
    ) === true)
    terminal.input({ type: 'insert', text: 'ignored while panel is open' })
    expect(session.submitted).toEqual([])

    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '~8K/128K 6%',
    ) === true)

    terminal.input({ type: 'insert', text: '/context' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '/context',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Inspect official context pressure and token usage',
    )
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes(
      'CONTEXT WINDOW',
    ) === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '~8K/128K 6%',
    ) === true)

    terminal.input({ type: 'insert', text: '/context argument' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /context does not accept input',
    ) === true)
    expect(session.submitted).toEqual([])

    const lateChange = [...session.contextListeners][0]!
    await controller.requestExit('user')
    expect(session.contextUnsubscribeCount).toBe(1)
    expect(session.contextListeners.size).toBe(0)
    expect(() => lateChange()).not.toThrow()
  })

  it('does not claim ordinary prompts or longer slash-command names', async () => {
    const session = new FakeContextSession()
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    for (const text of ['plain prompt', '/contextual']) {
      terminal.input({ type: 'insert', text })
      terminal.input({ type: 'submit' })
      await waitFor(() => controller.pendingSubmitCount === 0)
    }

    expect(session.submitted.map(entry => entry.input.text)).toEqual([
      'plain prompt',
      '/contextual',
    ])
    await controller.requestExit('user')
  })

  it('contains a context subscription failure during input quiesce', async () => {
    const session = new FakeContextSession()
    session.throwOnContextUnsubscribe = new Error('context unsubscribe failed')
    const { controller } = createProduct({ session })
    await controller.start()

    const result = await controller.requestExit('user')
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.some(issue => (
      issue.phase === 'stop-input'
      && String(issue.error).includes('context unsubscribe failed')
    ))).toBe(true)
  })

  it('lets an official /context command win and closes a local panel on late registration', async () => {
    const officialSession = new FakeContextSession()
    officialSession.contextState = contextSnapshot(16_000, 6)
    officialSession.commands = [{
      name: 'context',
      description: 'Official context command',
    }]
    officialSession.commandExecution = {
      commandId: 'official-context',
      result: { kind: 'success' },
    }
    const official = createProduct({ session: officialSession })
    await official.controller.start()
    official.terminal.input({ type: 'insert', text: '/context' })
    official.terminal.input({ type: 'submit' })
    await waitFor(() => officialSession.commandExecutions.length === 1)
    expect(officialSession.commandExecutions[0]?.line).toBe('/context')
    expect(official.terminal.frames.at(-1)?.lines[0]).not.toContain(
      'CONTEXT WINDOW',
    )
    await official.controller.requestExit('user')

    const lateSession = new FakeContextSession()
    lateSession.contextState = contextSnapshot(32_000, 7)
    const late = createProduct({ session: lateSession })
    await late.controller.start()
    late.terminal.input({ type: 'insert', text: '/context' })
    late.terminal.input({ type: 'submit' })
    await waitFor(() => late.terminal.frames.at(-1)?.lines[0]?.includes(
      'CONTEXT WINDOW',
    ) === true)
    lateSession.changeCommands([{
      name: 'context',
      description: 'Official context command',
    }])
    await waitFor(() => late.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Official /context command is now registered',
    ) === true)
    expect(late.terminal.frames.at(-1)?.lines[0]).toContain('DSH-TUI ·')
    await late.controller.requestExit('user')
  })

  it('closes the read-only panel when a Session interaction needs focus', async () => {
    const session = new FakeContextSession()
    session.contextState = contextSnapshot(24_000, 8)
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.input({ type: 'insert', text: '/context' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes(
      'CONTEXT WINDOW',
    ) === true)

    session.interactionsSource.push(snapshot([{
      id: 'approval:context-focus',
      kind: 'approval',
      sessionId: session.sessionId,
      approvalId: 'approval-context-focus',
      toolName: 'pwsh',
      callId: 'context-focus',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'PERMISSION REQUIRED',
    ) === true)
    expect(terminal.frames.at(-1)?.lines[0]).not.toContain(
      'CONTEXT WINDOW',
    )
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('PERMISSION REQUIRED')

    terminal.input({ type: 'escape' })
    session.interactionsSource.push(snapshot())
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Context panel closed for a pending interaction',
    ) === true)
    await controller.requestExit('user')
  })
})

describe('DshTuiController read-only session picker', () => {
  const currentEntry = {
    sessionId: 'session-a',
    createdAt: 30,
    isSubagent: false,
    attached: true,
    durablePresence: 'observed' as const,
    liveStatus: 'idle' as const,
  }

  it('discovers the marked local action, browses bounded facts, and never enters a DSH lane', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([
      currentEntry,
      {
        sessionId: 'cold-b',
        createdAt: 20,
        cwd: 'D:\\cold',
        isSubagent: false,
        attached: false,
        durablePresence: 'observed',
      },
      {
        sessionId: 'live-c',
        createdAt: 10,
        isSubagent: true,
        attached: true,
        durablePresence: 'not-observed',
        liveStatus: 'running',
      },
    ])
    const { controller, session, terminal } = createProduct({ catalog })
    await controller.start()

    terminal.input({ type: 'insert', text: '/se' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Browse sessions') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('[DSH-TUI/local]')
    terminal.input({ type: 'complete' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/sessions') === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'SESSIONS · DSH/local',
    ) === true)

    const screen = terminal.frames.at(-1)?.lines.join('\n') ?? ''
    expect(screen).toContain('current')
    expect(screen).toContain('cold')
    expect(screen).toContain('other-live')
    expect(session.commandExecutions).toEqual([])
    expect(session.submitted).toEqual([])

    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Already viewing session session-a',
    ) === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'requires read-only inspection',
    ) === true)
    catalog.snapshot = catalogSnapshot([])
    terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => catalog.signals.length === 2)
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'No sessions are available',
    ) === true)

    terminal.input({ type: 'insert', text: 'must-not-leak' })
    terminal.input({ type: 'complete' })
    terminal.input({ type: 'newline' })
    terminal.input({ type: 'interrupt' })
    expect(controller.state).toBe('running')
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('SESSIONS ·') === false)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('must-not-leak')

    await controller.requestExit('user')
  })

  it('recognizes only the exact local /sessions token boundary', async () => {
    const { controller, session, catalog, terminal } = createProduct()
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessionsx' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]?.input.text).toBe('/sessionsx')

    terminal.input({ type: 'insert', text: '/sessions argument' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /sessions does not accept input',
    ) === true)
    expect(catalog.signals).toEqual([])
    terminal.input({ type: 'escape' })

    terminal.input({ type: 'insert', text: '/sessions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Browse sessions') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('[DSH-TUI/local]')
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    expect(session.commandExecutions).toEqual([])

    terminal.input({ type: 'escape' })
    await controller.requestExit('user')
  })

  it('lets an observed official /sessions command win the collision', async () => {
    const session = new FakeSession()
    session.commands = [{
      name: 'sessions',
      description: 'Official sessions command',
    }]
    const { controller, catalog, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Official sessions command',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('Browse sessions')
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.length === 1)

    expect(session.commandExecutions[0]?.line).toBe('/sessions')
    expect(catalog.signals).toEqual([])
    await controller.requestExit('user')
  })

  it('dismisses the local picker if an official /sessions command appears', async () => {
    const session = new FakeSession()
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'SESSIONS · DSH/local',
    ) === true)

    session.changeCommands([{
      name: 'sessions',
      description: 'Official sessions command',
    }])
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Official /sessions command is now registered',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('[DSH-TUI/local]')

    await controller.requestExit('user')
  })

  it('keeps the last snapshot on failure and fences a result delivered after dismissal', async () => {
    const catalog = new FakeCatalog()
    const stale = deferred<SessionCatalogSnapshot>()
    const hostile = { toString(): string { throw new Error('cannot stringify catalog failure') } }
    let call = 0
    catalog.listOverride = async () => {
      call += 1
      if (call === 1) {
        return catalogSnapshot([currentEntry, {
          sessionId: 'cold-stable',
          createdAt: 10,
          isSubagent: false,
          attached: false,
          durablePresence: 'observed',
        }])
      }
      if (call === 2) return await stale.promise
      if (call === 3) throw new Error('catalog exploded')
      if (call === 4) throw ''
      throw hostile
    }
    const { controller, terminal } = createProduct({ catalog })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('cold-stable') === true)
    terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => controller.pendingCatalogCount === 1 && catalog.signals.length === 2)
    terminal.input({ type: 'escape' })
    expect(catalog.signals[1]?.aborted).toBe(true)
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Waiting for the previous catalog refresh',
    ) === true)
    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'A catalog refresh is already running',
    ) === true)
    stale.resolve(catalogSnapshot([{
      sessionId: 'stale-must-not-mount',
      createdAt: 999,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
    }]))
    await waitFor(() => catalog.signals.length === 3 && controller.pendingCatalogCount === 0)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('stale-must-not-mount')
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Catalog unavailable: catalog exploded',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('cold-stable')
    expect(controller.state).toBe('running')

    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 4)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Catalog unavailable: unknown catalog error',
    ) === true)

    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 5)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Catalog unavailable: unknown catalog error',
    ) === true)

    await controller.requestExit('user')
  })

  it('yields to an interaction and aborts then awaits catalog work during shutdown', async () => {
    const catalog = new FakeCatalog()
    const listing = deferred<SessionCatalogSnapshot>()
    catalog.listOverride = options => listing.promise.finally(() => {
      options?.signal?.throwIfAborted()
    })
    const { controller, session, terminal } = createProduct({ catalog })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    session.interactionsSource.push(snapshot([{
      id: 'approval:catalog-priority',
      kind: 'approval',
      sessionId: 'session-a',
      approvalId: 'approval-catalog-priority',
      toolName: 'read',
      callId: 'call-catalog-priority',
    }]))
    await waitFor(() => catalog.signals[0]?.aborted === true)
    listing.resolve(catalogSnapshot([currentEntry]))
    await waitFor(() => controller.pendingCatalogCount === 0)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('[DSH-TUI/local]')

    session.interactionsSource.push(snapshot())
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === false)
    const shutdownListing = deferred<SessionCatalogSnapshot>()
    catalog.listOverride = options => shutdownListing.promise.finally(() => {
      options?.signal?.throwIfAborted()
    })
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingCatalogCount === 1)
    const exit = controller.requestExit('user')
    await waitFor(() => catalog.signals.at(-1)?.aborted === true)
    expect(session.disposeCount).toBe(0)
    shutdownListing.resolve(catalogSnapshot())
    await expect(exit).resolves.toMatchObject({ ok: true, reason: 'user' })
    expect(controller.pendingCatalogCount).toBe(0)
    expect(session.disposeCount).toBe(1)
  })
})

describe('DshTuiController session inspection', () => {
  const current = {
    sessionId: 'session-a',
    createdAt: 30,
    isSubagent: false,
    attached: true,
    durablePresence: 'observed' as const,
    liveStatus: 'idle' as const,
  }

  it('inspects cold root and subagent snapshots without entering activation', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([current, {
      sessionId: 'cold-root',
      createdAt: 20,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
    }, {
      sessionId: 'cold-child',
      createdAt: 10,
      parentSessionId: 'parent',
      isSubagent: true,
      attached: false,
      durablePresence: 'observed',
    }])
    const inspection = new FakeInspection()
    inspection.inspectOverride = async request => inspectionSnapshot(
      request.sessionId,
      `history for ${request.sessionId}`,
      request.sessionId === 'cold-child',
    )
    const activation = new FakeActivation()
    const { controller, terminal } = createProduct({ catalog, inspection, activation })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => inspection.requests.length === 1)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'history for cold-root',
    ) === true)
    expect(inspection.requests[0]?.sessionId).toBe('cold-root')
    expect(activation.requests).toEqual([])
    expect(controller.pendingInspectionCount).toBe(0)

    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('SESSIONS') === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => inspection.requests.length === 2)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'history for cold-child',
    ) === true)
    expect(activation.requests).toEqual([])
    expect(terminal.frames.at(-1)?.lines.at(-1)).not.toContain('a resume')
    terminal.input({ type: 'insert', text: 'a' })
    expect(activation.requests).toEqual([])

    terminal.input({ type: 'escape' })
    await controller.requestExit('user')
  })

  it('requires an explicit cold-resume warning and a second Enter after inspection', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([current, {
      sessionId: 'cold-confirm',
      createdAt: 20,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
    }])
    const inspection = new FakeInspection()
    inspection.inspectOverride = async request => inspectionSnapshot(
      request.sessionId,
      'history remains read-only until confirmation',
    )
    const activation = new FakeActivation()
    activation.activateOverride = async () => {
      throw new Error('cold activation sentinel')
    }
    const { controller, terminal } = createProduct({ catalog, inspection, activation })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'history remains read-only until confirmation',
    ) === true)
    expect(activation.requests).toEqual([])

    terminal.input({ type: 'insert', text: 'a' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Resume may repair or append durable storage',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('cold-confirm')
    expect(activation.requests).toEqual([])

    terminal.input({ type: 'insert', text: 'ignored while confirming' })
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Cold resume confirmation',
    )
    expect(activation.requests).toEqual([])

    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'history remains read-only until confirmation',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Storage unchanged')
    expect(activation.requests).toEqual([])

    terminal.resize({ columns: 40, rows: 2 })
    terminal.input({ type: 'insert', text: 'a' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Notice: Cold resume',
    ) === true)
    expect(activation.requests).toEqual([])

    terminal.resize({ columns: 60, rows: 12 })
    terminal.input({ type: 'insert', text: 'a' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Cold resume confirmation',
    ) === true)
    terminal.resize({ columns: 40, rows: 2 })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Resize to at least 60x7',
    ) === true)
    terminal.input({ type: 'submit' })
    terminal.resize({ columns: 60, rows: 12 })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Notice: Cold resume',
    ) === true)
    expect(activation.requests).toEqual([])

    terminal.input({ type: 'insert', text: 'a' })
    terminal.input({ type: 'submit' })
    await waitFor(() => activation.requests.length === 1)
    expect(activation.requests[0]).toMatchObject({
      intent: 'resume-cold',
      sessionId: 'cold-confirm',
    })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'cold activation sentinel',
    ) === true)

    await controller.requestExit('user')
  })

  it('rechecks the latest cold-root observation at confirmation time', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([current, {
      sessionId: 'cold-drift',
      createdAt: 20,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
    }])
    const inspection = new FakeInspection()
    inspection.inspectOverride = async request => inspectionSnapshot(
      request.sessionId,
      'drift inspection',
    )
    const activation = new FakeActivation()
    const { controller, terminal } = createProduct({ catalog, inspection, activation })
    await controller.start()
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'drift inspection',
    ) === true)
    terminal.input({ type: 'insert', text: 'a' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Cold resume confirmation',
    ) === true)

    Object.assign(
      controller as unknown as { catalogSnapshot: SessionCatalogSnapshot },
      { catalogSnapshot: catalogSnapshot([current]) },
    )
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Notice: Cold resume cancelled because',
    ) === true)
    expect(activation.requests).toEqual([])
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Storage unchanged')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Notice: Cold resume cancelled because',
    )
    await controller.requestExit('user')
  })

  it('never falls from a cold picker row into generic activation without inspection', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([current, {
      sessionId: 'cold-no-inspection',
      createdAt: 20,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
    }])
    const activation = new FakeActivation()
    const { controller, terminal } = createProduct({ catalog, activation })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'cold-no-inspection',
    ) === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'requires read-only inspection',
    ) === true)
    expect(activation.requests).toEqual([])
    await controller.requestExit('user')
  })

  it('explains that other-live switching is unavailable without an activation port', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([current, {
      sessionId: 'live-without-activation',
      createdAt: 20,
      isSubagent: false,
      attached: true,
      liveStatus: 'running',
      durablePresence: 'observed',
    }])
    const { controller, terminal } = createProduct({ catalog })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'live-without-activation',
    ) === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Session switching is not implemented for other-live session live-without-activation',
    ) === true)
    await controller.requestExit('user')
  })

  it('keeps other-live root selection on the exact activation path', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([current, {
      sessionId: 'live-root',
      createdAt: 20,
      isSubagent: false,
      attached: true,
      durablePresence: 'observed',
      liveStatus: 'idle',
    }])
    const inspection = new FakeInspection()
    const activation = new FakeActivation()
    activation.activateOverride = async () => { throw new Error('activation sentinel') }
    const { controller, terminal } = createProduct({ catalog, inspection, activation })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => activation.requests.length === 1)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'activation sentinel',
    ) === true)
    expect(activation.requests[0]?.sessionId).toBe('live-root')
    expect(activation.requests[0]?.intent).toBe('attach-live')
    expect(inspection.requests).toEqual([])

    await controller.requestExit('user')
  })

  it('renders latest external-live and missing catalog observations without changing the snapshot', async () => {
    const target = {
      sessionId: 'cold-observation',
      createdAt: 20,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed' as const,
    }
    const liveListing = Promise.withResolvers<SessionCatalogSnapshot>()
    const liveCatalog = new FakeCatalog()
    liveCatalog.snapshot = catalogSnapshot([current, target])
    let liveLists = 0
    liveCatalog.listOverride = () => {
      liveLists += 1
      return liveLists === 1 ? Promise.resolve(liveCatalog.snapshot) : liveListing.promise
    }
    const liveInspection = new FakeInspection()
    liveInspection.inspectOverride = async request => inspectionSnapshot(
      request.sessionId,
      'stable observed history',
    )
    const live = createProduct({
      catalog: liveCatalog,
      inspection: liveInspection,
    })
    await live.controller.start()
    live.terminal.resize({ columns: 160, rows: 12 })
    live.terminal.input({ type: 'insert', text: '/sessions' })
    live.terminal.input({ type: 'submit' })
    await waitFor(() => liveCatalog.signals.length === 1)
    await waitFor(() => live.terminal.frames.at(-1)?.lines.join('\n').includes(
      'cold-observation',
    ) === true)
    live.terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => liveCatalog.signals.length === 2)
    live.terminal.input({ type: 'move-down' })
    live.terminal.input({ type: 'submit' })
    await waitFor(() => live.terminal.frames.at(-1)?.lines.join('\n').includes(
      'stable observed history',
    ) === true)
    liveListing.resolve(catalogSnapshot([current, {
      ...target,
      attached: true,
      liveStatus: 'running',
    }]))
    await waitFor(() => live.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Latest catalog observation: other-live · durable:observed · live:running',
    ) === true)
    expect(live.terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'stable observed history',
    )
    live.terminal.input({ type: 'escape' })
    await live.controller.requestExit('user')

    const missingListing = Promise.withResolvers<SessionCatalogSnapshot>()
    const missingCatalog = new FakeCatalog()
    missingCatalog.snapshot = catalogSnapshot([current, target])
    let missingLists = 0
    missingCatalog.listOverride = () => {
      missingLists += 1
      return missingLists === 1
        ? Promise.resolve(missingCatalog.snapshot)
        : missingListing.promise
    }
    const missingInspection = new FakeInspection()
    missingInspection.inspectOverride = async request => inspectionSnapshot(
      request.sessionId,
      'stable missing history',
    )
    const missing = createProduct({
      catalog: missingCatalog,
      inspection: missingInspection,
    })
    await missing.controller.start()
    missing.terminal.resize({ columns: 160, rows: 12 })
    missing.terminal.input({ type: 'insert', text: '/sessions' })
    missing.terminal.input({ type: 'submit' })
    await waitFor(() => missingCatalog.signals.length === 1)
    await waitFor(() => missing.terminal.frames.at(-1)?.lines.join('\n').includes(
      'cold-observation',
    ) === true)
    missing.terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => missingCatalog.signals.length === 2)
    missing.terminal.input({ type: 'move-down' })
    missing.terminal.input({ type: 'submit' })
    await waitFor(() => missing.terminal.frames.at(-1)?.lines.join('\n').includes(
      'stable missing history',
    ) === true)
    missingListing.resolve(catalogSnapshot([current]))
    await waitFor(() => missing.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Latest catalog observation: missing',
    ) === true)
    expect(missing.terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'stable missing history',
    )
    missing.terminal.input({ type: 'escape' })
    await missing.controller.requestExit('user')
  })

  it('fails closed on a mismatched inspection identity and retries the exact target', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([current, {
      sessionId: 'cold-id',
      createdAt: 20,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
    }])
    const eventRetry = Promise.withResolvers<SessionInspectionSnapshot>()
    const exactRetry = Promise.withResolvers<SessionInspectionSnapshot>()
    let call = 0
    const inspection = new FakeInspection()
    inspection.inspectOverride = () => {
      call += 1
      if (call === 1) {
        return Promise.resolve(inspectionSnapshot('wrong-id', 'must never render'))
      }
      return call === 2 ? eventRetry.promise : exactRetry.promise
    }
    const { controller, terminal } = createProduct({ catalog, inspection })
    await controller.start()
    terminal.resize({ columns: 160, rows: 12 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'does not match requested session',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('must never render')

    terminal.input({ type: 'insert', text: 'x' })
    terminal.input({ type: 'submit' })
    expect(inspection.requests).toHaveLength(1)
    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => inspection.requests.length === 2)
    expect(inspection.requests[1]?.sessionId).toBe('cold-id')
    terminal.input({ type: 'insert', text: 'r' })
    terminal.input({ type: 'move-up' })
    expect(inspection.requests).toHaveLength(2)

    const mismatchedEvent = inspectionSnapshot('cold-id', 'wrong event history')
    eventRetry.resolve({
      ...mismatchedEvent,
      events: [{
        ...mismatchedEvent.events[0]!,
        sessionId: 'wrong-event',
      }],
    })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Inspection event 0 session',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('wrong event history')

    terminal.input({ type: 'insert', text: 'R' })
    await waitFor(() => inspection.requests.length === 3)
    expect(inspection.requests[2]?.sessionId).toBe('cold-id')
    exactRetry.resolve(inspectionSnapshot('cold-id', 'exact retry history'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'exact retry history',
    ) === true)
    terminal.input({ type: 'escape' })
    await controller.requestExit('user')
  })

  it('bounds inspection scroll state and suppresses duplicate refresh while preserving position', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([current, {
      sessionId: 'cold-scroll',
      createdAt: 20,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
    }])
    const initial = Promise.withResolvers<SessionInspectionSnapshot>()
    const refresh = Promise.withResolvers<SessionInspectionSnapshot>()
    let call = 0
    const inspection = new FakeInspection()
    inspection.inspectOverride = () => {
      call += 1
      return call === 1 ? initial.promise : refresh.promise
    }
    const { controller, terminal } = createProduct({ catalog, inspection })
    await controller.start()
    terminal.resize({ columns: 100, rows: 10 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => inspection.requests.length === 1)
    terminal.input({ type: 'insert', text: 'r' })
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'submit' })
    expect(inspection.requests).toHaveLength(1)

    initial.resolve(inspectionHistorySnapshot('cold-scroll', 'history'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('history 19') === true)
    terminal.input({ type: 'insert', text: 'x' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-down' })
    for (let index = 0; index < 100; index += 1) {
      terminal.input({ type: 'move-up' })
    }
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('history 0') === true)
    const oldest = terminal.frames.at(-1)?.lines.join('\n')
    const frameCount = terminal.frames.length
    terminal.input({ type: 'move-down' })
    await waitFor(() => terminal.frames.length > frameCount)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toBe(oldest)

    terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => inspection.requests.length === 2)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Refreshing') === true)
    terminal.input({ type: 'insert', text: 'R' })
    expect(inspection.requests).toHaveLength(2)
    refresh.resolve(inspectionHistorySnapshot('cold-scroll', 'refreshed'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('refreshed') === true)

    terminal.input({ type: 'escape' })
    await controller.requestExit('user')
  })

  it('fences a cancelled late result and preserves a ready snapshot on refresh failure', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([current, {
      sessionId: 'cold-a',
      createdAt: 20,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
    }, {
      sessionId: 'cold-b',
      createdAt: 10,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
    }])
    const a = Promise.withResolvers<SessionInspectionSnapshot>()
    const b = Promise.withResolvers<SessionInspectionSnapshot>()
    const refresh = Promise.withResolvers<SessionInspectionSnapshot>()
    let bCalls = 0
    const inspection = new FakeInspection()
    inspection.inspectOverride = request => {
      if (request.sessionId === 'cold-a') return a.promise
      bCalls += 1
      return bCalls === 1 ? b.promise : refresh.promise
    }
    const { controller, terminal } = createProduct({ catalog, inspection })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => inspection.requests.length === 1)
    terminal.input({ type: 'escape' })
    expect(inspection.requests[0]?.signal.aborted).toBe(true)

    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => inspection.requests.length === 2)
    b.resolve(inspectionSnapshot('cold-b', 'newest B snapshot'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'newest B snapshot',
    ) === true)
    a.resolve(inspectionSnapshot('cold-a', 'stale A must not render'))
    await waitFor(() => controller.pendingInspectionCount === 0)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('stale A must not render')

    terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => inspection.requests.length === 3)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Refreshing') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('newest B snapshot')
    refresh.reject(new Error('refresh failed safely'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'refresh failed safely',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('newest B snapshot')

    terminal.input({ type: 'escape' })
    await controller.requestExit('user')
  })

  it('yields immediately to a current interaction and discards a late inspection', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([current, {
      sessionId: 'cold-interaction',
      createdAt: 20,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
    }])
    const pending = Promise.withResolvers<SessionInspectionSnapshot>()
    const inspection = new FakeInspection()
    inspection.inspectOverride = () => pending.promise
    const { controller, session, terminal } = createProduct({ catalog, inspection })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => inspection.requests.length === 1)
    session.interactionsSource.push(snapshot([{
      id: 'approval:inspection-priority',
      kind: 'approval',
      sessionId: 'session-a',
      approvalId: 'approval-inspection-priority',
      toolName: 'read',
      callId: 'call-inspection-priority',
    }]))
    await waitFor(() => inspection.requests[0]?.signal.aborted === true)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === true)
    pending.reject(new Error('late hidden inspection failure'))
    await waitFor(() => controller.pendingInspectionCount === 0)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain(
      'late hidden inspection failure',
    )

    session.interactionsSource.push(snapshot())
    await controller.requestExit('user')
  })

  it('does not inspect an unobserved durable target and aborts then joins inspection on shutdown', async () => {
    const unavailableCatalog = new FakeCatalog()
    unavailableCatalog.snapshot = catalogSnapshot([current, {
      sessionId: 'not-durable',
      createdAt: 20,
      isSubagent: false,
      attached: false,
      durablePresence: 'not-observed',
    }])
    const unavailableInspection = new FakeInspection()
    const unavailable = createProduct({
      catalog: unavailableCatalog,
      inspection: unavailableInspection,
    })
    await unavailable.controller.start()
    unavailable.terminal.input({ type: 'insert', text: '/sessions' })
    unavailable.terminal.input({ type: 'submit' })
    await waitFor(() => unavailableCatalog.signals.length === 1)
    await waitFor(() => unavailable.terminal.frames.at(-1)?.lines.join('\n').includes(
      'not-durable',
    ) === true)
    unavailable.terminal.input({ type: 'move-down' })
    unavailable.terminal.input({ type: 'submit' })
    await waitFor(() => unavailable.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Session not-durable durable snapshot',
    ) === true)
    expect(unavailableInspection.requests).toEqual([])
    unavailable.terminal.input({ type: 'escape' })
    await unavailable.controller.requestExit('user')

    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([current, {
      sessionId: 'cold-shutdown',
      createdAt: 20,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
    }])
    const pending = Promise.withResolvers<SessionInspectionSnapshot>()
    const inspection = new FakeInspection()
    inspection.inspectOverride = () => pending.promise
    const product = createProduct({ catalog, inspection })
    await product.controller.start()
    product.terminal.input({ type: 'insert', text: '/sessions' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    product.terminal.input({ type: 'move-down' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => inspection.requests.length === 1)

    let settled = false
    const exit = product.controller.requestExit('user').finally(() => { settled = true })
    await waitFor(() => inspection.requests[0]?.signal.aborted === true)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(settled).toBe(false)
    pending.resolve(inspectionSnapshot('cold-shutdown', 'must not publish'))
    await expect(exit).resolves.toMatchObject({ ok: true, reason: 'user' })
    expect(product.controller.pendingInspectionCount).toBe(0)
    expect(product.terminal.frames.at(-1)?.lines.join('\n')).not.toContain('must not publish')
  })
})

describe('DshTuiController session binding switch', () => {
  const currentEntry = {
    sessionId: 'session-a',
    createdAt: 20,
    isSubagent: false,
    attached: true,
    durablePresence: 'observed' as const,
    liveStatus: 'idle' as const,
  }
  const targetEntry = {
    sessionId: 'session-b',
    createdAt: 10,
    isSubagent: false,
    attached: true,
    durablePresence: 'not-observed' as const,
    liveStatus: 'running' as const,
  }

  it('stages an exact target, commits once ready, and keeps the source binding alive', async () => {
    const source = new FakeSession('session-a')
    const target = new FakeContextSession('session-b')
    const targetWorkbenchListeners = new Set<() => void>()
    let targetWorkbench: SessionWorkbenchSnapshot = { available: false }
    Object.assign(target, {
      workbenchSnapshot: () => structuredClone(targetWorkbench),
      onWorkbenchChanged: (listener: () => void) => {
        targetWorkbenchListeners.add(listener)
        return () => { targetWorkbenchListeners.delete(listener) }
      },
    })
    source.modelState = selectableModelSnapshot({
      current: { provider: 'provider-a', model: 'source-model' },
    })
    target.modelState = selectableModelSnapshot({
      current: { provider: 'provider-b', model: 'target-model' },
    })
    const activation = new FakeActivation()
    activation.activateOverride = async () => ({
      port: target,
      release: () => target.dispose(),
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal } = createProduct({
      session: source,
      activation,
      catalog,
    })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('provider-a/source-model')

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    expect(terminal.frames.at(-1)?.lines[0]).toContain('SESSIONS · DSH/local')
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => activation.requests.length === 1)

    expect(activation.requests[0]?.sessionId).toBe('session-b')
    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')
    expect(source.disposeCount).toBe(0)
    expect(target.disposeCount).toBe(0)

    await waitFor(() => target.contextListeners.size === 1)
    target.changeContext({
      available: true,
      pressure: { projectedTokens: 24_000, contextWindow: 128_000 },
    })
    await waitFor(() => targetWorkbenchListeners.size === 1)
    targetWorkbench = {
      available: true,
      goal: {
        id: 'goal-target',
        revision: 1,
        objective: 'Switch without losing mission state',
        phase: 'active',
        maxGoalRounds: 4,
        roundsStarted: 1,
        createdAt: 10,
        updatedAt: 20,
      },
      plan: { active: true, pending: false },
      todos: [{ content: 'Promote target binding', status: 'in_progress' }],
    }
    for (const listener of [...targetWorkbenchListeners]) listener()
    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')

    target.eventsSource.push(runtime(0, 'agent/created', 'running', 'session-b'))
    target.interactionsSource.push(snapshot([{
      id: 'approval:target',
      kind: 'approval',
      sessionId: 'session-b',
      approvalId: 'approval-target',
      toolName: 'pwsh',
      callId: 'call-target',
    }], 'session-b'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === true)
    expect(terminal.frames.at(-1)?.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })
    expect(terminal.startCount).toBe(1)
    expect(terminal.restoreCount).toBe(0)
    expect(source.disposeCount).toBe(0)

    source.changeModelState(selectableModelSnapshot({
      current: { provider: 'provider-a', model: 'source-model-updated' },
    }))

    terminal.input({ type: 'escape' })
    target.interactionsSource.push(snapshot([], 'session-b'))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'GOAL active · PLAN on',
    ) === true)
    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-b')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('provider-b/target-model')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('~24K/128K 19%')
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('source-model-updated')
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 2)
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('session-a') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('provider-a/source-model-updated')

    expect(activation.requests).toHaveLength(1)
    expect(source.disposeCount).toBe(0)
    expect(target.disposeCount).toBe(0)
    await controller.requestExit('user')
    expect(source.disposeCount).toBe(1)
    expect(target.disposeCount).toBe(1)
    expect(terminal.restoreCount).toBe(1)
  })

  it('keeps the source current when activation rejects', async () => {
    const activation = new FakeActivation()
    activation.activateOverride = async () => { throw new Error('target activation failed') }
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, session, terminal } = createProduct({ activation, catalog })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => activation.requests.length === 1)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Session switch failed: target activation failed',
    ) === true)

    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')
    expect(session.disposeCount).toBe(0)
    expect(controller.state).toBe('running')
    await controller.requestExit('user')
  })

  it('releases a late borrowed activation without disposing its Agent-facing port', async () => {
    const activated = deferred<ActivatedSessionLease>()
    const target = new FakeSession('session-b')
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => await activated.promise
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, session, terminal } = createProduct({ activation, catalog })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => activation.requests.length === 1)
    terminal.input({ type: 'insert', text: 'ignored while switching' })
    expect(activation.requests[0]?.signal.aborted).toBe(false)
    expect(controller.pendingSwitchCount).toBe(1)
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'escape' })
    expect(activation.requests[0]?.signal.aborted).toBe(true)

    activated.resolve({
      port: target,
      release: async () => { releases += 1 },
    })
    await waitFor(() => controller.pendingSwitchCount === 0)
    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')
    expect(releases).toBe(1)
    expect(target.disposeCount).toBe(0)
    expect(session.disposeCount).toBe(0)

    await controller.requestExit('user')
    expect(session.disposeCount).toBe(1)
    expect(target.disposeCount).toBe(0)
  })

  it('reports a late release failure after an interactive switch cancellation', async () => {
    const activated = deferred<ActivatedSessionLease>()
    const target = new FakeSession('session-b')
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => await activated.promise
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal } = createProduct({ activation, catalog })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => activation.requests.length === 1)
    terminal.input({ type: 'escape' })
    activated.resolve({
      port: target,
      release: async () => {
        releases += 1
        throw new Error('late borrowed release failed')
      },
    })
    await waitFor(() => controller.pendingSwitchCount === 0)

    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Session switch cleanup failed: late borrowed release failed',
    )
    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')
    expect(controller.state).toBe('running')
    expect(releases).toBe(1)
    expect(target.disposeCount).toBe(0)
    await expect(controller.requestExit('user')).resolves.toMatchObject({ ok: true })
  })

  it('cancels a staged candidate when the source receives an interaction', async () => {
    const source = new FakeSession('session-a')
    const target = new FakeSession('session-b')
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => ({
      port: target,
      release: async () => { releases += 1 },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal } = createProduct({
      session: source,
      activation,
      catalog,
    })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => target.caughtUpCount === 1)
    expect(controller.pendingSwitchCount).toBe(1)

    source.interactionsSource.push(snapshot([{
      id: 'approval:source',
      kind: 'approval',
      sessionId: 'session-a',
      approvalId: 'approval-source',
      toolName: 'pwsh',
      callId: 'call-source',
    }]))
    await waitFor(() => controller.pendingSwitchCount === 0)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('PERMISSION REQUIRED')
    expect(terminal.frames.at(-1)?.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })
    expect(releases).toBe(1)
    expect(target.disposeCount).toBe(0)

    terminal.input({ type: 'escape' })
    source.interactionsSource.push(snapshot([], 'session-a'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('session-a') === true)
    await controller.requestExit('user')
  })

  it('waits for a late activation during shutdown, releases it, and restores once', async () => {
    const activated = deferred<ActivatedSessionLease>()
    const target = new FakeSession('session-b')
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => await activated.promise
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal } = createProduct({ activation, catalog })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => activation.requests.length === 1)
    const exiting = controller.requestExit('user')
    await Promise.resolve()
    expect(terminal.restoreCount).toBe(0)

    activated.resolve({
      port: target,
      release: async () => { releases += 1 },
    })
    await expect(exiting).resolves.toMatchObject({ ok: true, reason: 'user' })
    expect(releases).toBe(1)
    expect(target.disposeCount).toBe(0)
    expect(terminal.restoreCount).toBe(1)
  })

  it('reports a late activation release failure as a shutdown cleanup issue', async () => {
    const activated = deferred<ActivatedSessionLease>()
    const target = new FakeSession('session-b')
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => await activated.promise
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, session, terminal } = createProduct({ activation, catalog })
    session.throwOnCancel = new Error('shutdown cancel failed too')
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => activation.requests.length === 1)
    const exiting = controller.requestExit('user')
    activated.resolve({
      port: target,
      release: async () => {
        releases += 1
        throw new Error('shutdown borrowed release failed')
      },
    })

    const result = await exiting
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    const cancelIssue = result.shutdown.issues.find(issue => issue.phase === 'cancel-agent')
    expect(cancelIssue?.error).toBeInstanceOf(AggregateError)
    expect((cancelIssue?.error as AggregateError).errors.map(String).join('\n')).toContain(
      'shutdown borrowed release failed',
    )
    expect((cancelIssue?.error as AggregateError).errors.map(String).join('\n')).toContain(
      'shutdown cancel failed too',
    )
    expect(session.cancellations).toEqual([])
    expect(releases).toBe(1)
    expect(target.disposeCount).toBe(0)
    expect(terminal.restoreCount).toBe(1)
  })

  it('forces terminal recovery on a second interrupt when activation ignores abort', async () => {
    const activated = deferred<ActivatedSessionLease>()
    const target = new FakeSession('session-b')
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => await activated.promise
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal, application } = createProduct({ activation, catalog })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => activation.requests.length === 1)
    terminal.input({ type: 'interrupt' })
    expect(activation.requests[0]?.signal.aborted).toBe(true)
    expect(controller.state).toBe('running')
    terminal.input({ type: 'interrupt' })

    await expect(controller.wait()).resolves.toMatchObject({
      ok: false,
      reason: 'forced',
    })
    expect(application.forceCount).toBe(1)
    expect(terminal.restoreCount).toBe(1)

    activated.resolve({
      port: target,
      release: async () => { releases += 1 },
    })
    await waitFor(() => controller.pendingSwitchCount === 0)
    expect(releases).toBe(1)
    expect(target.disposeCount).toBe(0)
  })

  it('blocks subagents and a switch attempted while source submit is pending', async () => {
    const activation = new FakeActivation()
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, {
      ...targetEntry,
      isSubagent: true,
      parentSessionId: 'parent',
    }])
    const { controller, session, terminal } = createProduct({ activation, catalog })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Subagent session session-b cannot use generic activation',
    ) === true)
    expect(activation.requests).toEqual([])

    terminal.input({ type: 'escape' })
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const submit = deferred<void>()
    session.submitGate = submit.promise
    terminal.input({ type: 'insert', text: 'work' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 2)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Wait for the current session operation before switching',
    ) === true)
    expect(activation.requests).toEqual([])

    submit.resolve()
    await waitFor(() => controller.pendingSubmitCount === 0)
    terminal.input({ type: 'escape' })
    await controller.requestExit('user')
  })

  it('rejects a wrong-id activation and reports release failure without leaving source', async () => {
    const wrong = new FakeSession('wrong-session')
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => ({
      port: wrong,
      release: async () => {
        releases += 1
        throw new Error('borrowed release failed')
      },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal } = createProduct({ activation, catalog })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingSwitchCount === 0)

    const screen = terminal.frames.at(-1)?.lines.join('\n') ?? ''
    expect(screen).toContain('activated session "wrong-session" does not match "session-b"')
    expect(screen).toContain('cleanup failed: borrowed release failed')
    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')
    expect(releases).toBe(1)
    expect(wrong.disposeCount).toBe(0)
    await controller.requestExit('user')
  })

  it('contains candidate pump failure and release cleanup inside the switch transaction', async () => {
    const target = new FakeContextSession('session-b')
    target.throwOnCommandUnsubscribe = new Error('candidate unsubscribe failed')
    target.throwOnModelUnsubscribe = new Error('candidate model unsubscribe failed')
    target.throwOnModeUnsubscribe = new Error('candidate mode unsubscribe failed')
    target.throwOnContextUnsubscribe = new Error('candidate context unsubscribe failed')
    Object.assign(target, {
      workbenchSnapshot: () => ({ available: false }),
      onWorkbenchChanged: () => () => {
        throw new Error('candidate workbench unsubscribe failed')
      },
      jobsSnapshot: () => ({ available: false, generation: 0, jobs: [] }),
      onJobsChanged: (listener: () => void) => {
        listener()
        return () => {
          throw new Error('candidate Jobs unsubscribe failed')
        }
      },
    })
    target.eventsOverride = async function* (): AsyncIterable<DshTuiEvent> {
      throw new Error('candidate replay exploded')
    }
    target.interactionsSource.push(snapshot([], 'session-b'))
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => ({
      port: target,
      release: async () => { releases += 1 },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal } = createProduct({ activation, catalog })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingSwitchCount === 0)

    const screen = terminal.frames.at(-1)?.lines.join('\n') ?? ''
    expect(screen).toContain('candidate replay exploded')
    expect(screen).toContain('cleanup failed')
    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')
    expect(releases).toBe(1)
    expect(controller.state).toBe('running')
    await controller.requestExit('user')
  })

  it('rejects a candidate that disposes before interaction hydration completes', async () => {
    const target = new FakeSession('session-b')
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => ({
      port: target,
      release: async () => { releases += 1 },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal } = createProduct({ activation, catalog })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => target.eventsSource.waiters.length === 1)
    const replayWaiter = target.eventsSource.waiters[0]
    target.eventsSource.push(runtime(0, 'agent/created', 'idle', 'session-b'))
    await waitFor(() => (
      target.eventsSource.waiters.length === 1
      && target.eventsSource.waiters[0] !== replayWaiter
    ))
    const liveWaiter = target.eventsSource.waiters[0]
    target.eventsSource.push(runtime(1, 'agent/disposed', 'idle', 'session-b'))
    await waitFor(() => (
      target.eventsSource.waiters.length === 1
      && target.eventsSource.waiters[0] !== liveWaiter
    ))
    target.interactionsSource.push(snapshot([], 'session-b'))
    await waitFor(() => controller.pendingSwitchCount === 0)

    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'target session "session-b" is disposed',
    )
    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')
    expect(releases).toBe(1)
    expect(target.disposeCount).toBe(0)
    await controller.requestExit('user')
  })

  it('rejects a candidate pump failure observed after both readiness barriers', async () => {
    const target = new FakeSession('session-b')
    const releaseRuntime = deferred()
    target.eventsOverride = options => (
      async function* (): AsyncIterable<DshTuiEvent> {
        await releaseRuntime.promise
        options?.onCaughtUp?.({ lastSeq: -1, status: 'idle' })
        throw new Error('candidate failed after readiness')
      }
    )()
    target.interactionsSource.push(snapshot([], 'session-b'))
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => ({
      port: target,
      release: async () => { releases += 1 },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal } = createProduct({ activation, catalog })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => target.interactionsSource.waiters.length === 1)
    releaseRuntime.resolve()
    await waitFor(() => controller.pendingSwitchCount === 0)

    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'candidate failed after readiness',
    )
    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')
    expect(releases).toBe(1)
    await controller.requestExit('user')
  })

  it('honors cancellation observed synchronously during candidate setup', async () => {
    const target = new FakeSession('session-b')
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => ({
      port: target,
      release: async () => {
        releases += 1
        throw new Error('setup cancellation release failed')
      },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal } = createProduct({ activation, catalog })
    target.onCommandSubscribe = () => {
      terminal.input({ type: 'escape' })
    }
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingSwitchCount === 0)

    expect(activation.requests[0]?.signal.aborted).toBe(true)
    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Session switch cleanup failed: DSH-TUI binding 2 release failed',
    )
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'setup cancellation release failed',
    )
    expect(target.commandUnsubscribeCount).toBe(1)
    expect(releases).toBe(1)
    await controller.requestExit('user')
  })

  it('fences a cancellation delivered after readiness resolves but before commit', async () => {
    const releaseRuntime = deferred()
    const target = new FakeSession('session-b')
    let terminal!: FakeTerminal
    target.eventsOverride = options => (
      async function* (): AsyncIterable<DshTuiEvent> {
        await releaseRuntime.promise
        options?.onCaughtUp?.({ lastSeq: -1, status: 'idle' })
        queueMicrotask(() => {
          queueMicrotask(() => {
            terminal.input({ type: 'escape' })
          })
        })
        yield* target.eventsSource.iterate(options?.signal)
      }
    )()
    target.interactionsSource.push(snapshot([], 'session-b'))
    let releases = 0
    const activation = new FakeActivation()
    activation.activateOverride = async () => ({
      port: target,
      release: async () => { releases += 1 },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const product = createProduct({ activation, catalog })
    terminal = product.terminal
    await product.controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => target.interactionsSource.waiters.length === 1)
    releaseRuntime.resolve()
    await waitFor(() => product.controller.pendingSwitchCount === 0)

    expect(activation.requests[0]?.signal.aborted).toBe(true)
    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')
    expect(releases).toBe(1)
    expect(target.disposeCount).toBe(0)
    await product.controller.requestExit('user')
  })

  it('contains a background binding failure and refuses to switch back into it', async () => {
    const source = new FakeSession('session-a')
    const target = new FakeSession('session-b')
    const activation = new FakeActivation()
    activation.activateOverride = async () => ({
      port: target,
      release: () => target.dispose(),
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal } = createProduct({
      session: source,
      activation,
      catalog,
    })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    target.interactionsSource.push(snapshot([], 'session-b'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('session-b') === true)

    source.eventsSource.fail(new Error('background replay failed'))
    await Promise.resolve()
    expect(controller.state).toBe('running')
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 2)
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Session switch failed: runtime pump failed: background replay failed',
    ) === true)

    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-b')
    expect(activation.requests).toHaveLength(1)
    await controller.requestExit('user')
  })

  it('keeps a disposed background binding isolated and refuses cached re-entry', async () => {
    const source = new FakeSession('session-a')
    const target = new FakeSession('session-b')
    const activation = new FakeActivation()
    activation.activateOverride = async () => ({
      port: target,
      release: () => target.dispose(),
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, targetEntry])
    const { controller, terminal } = createProduct({
      session: source,
      activation,
      catalog,
    })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    target.interactionsSource.push(snapshot([], 'session-b'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('session-b') === true)

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 2)
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('session-a') === true)

    await waitFor(() => target.eventsSource.waiters.length === 1)
    const liveWaiter = target.eventsSource.waiters[0]
    target.eventsSource.push(runtime(0, 'agent/created', 'idle', 'session-b'))
    await waitFor(() => (
      target.eventsSource.waiters.length === 1
      && target.eventsSource.waiters[0] !== liveWaiter
    ))
    const disposedWaiter = target.eventsSource.waiters[0]
    target.eventsSource.push(runtime(1, 'agent/disposed', 'idle', 'session-b'))
    await waitFor(() => (
      target.eventsSource.waiters.length === 1
      && target.eventsSource.waiters[0] !== disposedWaiter
    ))
    target.eventsSource.end()
    await Promise.resolve()
    expect(controller.state).toBe('running')

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 3)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'target session "session-b" is disposed',
    ) === true)

    expect(terminal.frames.at(-1)?.lines[0]).toContain('session-a')
    expect(activation.requests).toHaveLength(1)
    await controller.requestExit('user')
  })
})

describe('DshTuiController shutdown and failure containment', () => {
  it('detaches a borrowed running Agent without cancelling, waiting, or flushing it', async () => {
    const session = new FakeSession('borrowed-external', false)
    session.replayStatus = 'running'
    session.idleGate = Promise.withResolvers<void>().promise
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    session.eventsSource.push(runtime(0, 'agent/created', 'running', session.sessionId))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes(' · running') === true)
    terminal.input({ type: 'interrupt' })
    await expect(controller.wait()).resolves.toMatchObject({ ok: true, reason: 'user' })
    expect(session.cancellations).toEqual([])
    expect(session.whenIdleCount).toBe(0)
    expect(session.flushCount).toBe(0)
    expect(session.disposeCount).toBe(1)
    expect(terminal.restoreCount).toBe(1)
  })

  it('uses a second interrupt to force a stuck graceful shutdown', async () => {
    const { controller, session, terminal, application } = createProduct()
    const idle = deferred()
    session.idleGate = idle.promise
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created', 'running'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('running') === true)

    const stopping = controller.requestExit('signal')
    await waitFor(() => session.whenIdleCount === 1)
    expect(controller.state).toBe('stopping')
    terminal.input({ type: 'insert', text: 'ignored' })
    terminal.input({ type: 'interrupt' })

    const result = await stopping
    expect(result).toMatchObject({ ok: false, reason: 'forced' })
    expect(application.forceCount).toBe(1)
    expect(application.requestCount).toBe(0)
    expect(terminal.restoreCount).toBe(1)
    idle.resolve()
  })

  it('contains start and render failures and restores the terminal', async () => {
    const startFailure = createProduct()
    startFailure.terminal.throwOnStart = new Error('start failed')
    await expect(startFailure.controller.start()).rejects.toThrow('start failed')
    const startResult = await startFailure.controller.wait()
    expect(startResult).toMatchObject({ ok: false, reason: 'fatal' })
    expect(startFailure.session.disposeCount).toBe(1)
    expect(startFailure.terminal.state).toBe('restored')

    const renderFailure = createProduct()
    renderFailure.terminal.throwOnRender = new Error('render failed')
    await renderFailure.controller.start()
    const renderResult = await renderFailure.controller.wait()
    expect(renderResult).toMatchObject({ ok: false, reason: 'fatal' })
    expect(String(resultError(renderResult))).toContain('render failed')
    expect(renderFailure.terminal.restoreCount).toBe(1)
  })

  it('contains terminal handoff failure before starting session pumps', async () => {
    const terminal = new FakeTerminal()
    terminal.currentState = 'running'
    terminal.throwOnHandoff = new Error('handoff failed')
    const failure = createProduct({
      terminal,
      terminalStartMode: 'adopt-running',
    })

    await expect(failure.controller.start()).rejects.toThrow('handoff failed')
    const result = await failure.controller.wait()
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(String(resultError(result))).toContain('handoff failed')
    expect(terminal.startCount).toBe(0)
    expect(terminal.handoffCount).toBe(1)
    expect(failure.session.eventsSource.subscriptions).toBe(0)
    expect(failure.session.interactionsSource.subscriptions).toBe(0)
    expect(failure.session.disposeCount).toBe(1)
    expect(terminal.restoreCount).toBe(1)
    expect(terminal.state).toBe('restored')
  })

  it('keeps terminal callbacks total when cancel or stop throws', async () => {
    const cancelFailure = createProduct()
    cancelFailure.session.throwOnCancel = new Error('cancel failed')
    await cancelFailure.controller.start()
    cancelFailure.session.eventsSource.push(runtime(0, 'agent/created', 'running'))
    await waitFor(() => cancelFailure.terminal.frames.at(-1)?.lines[0]?.includes('running') === true)
    expect(() => cancelFailure.terminal.input({ type: 'interrupt' })).not.toThrow()
    const cancelResult = await cancelFailure.controller.wait()
    expect(cancelResult).toMatchObject({ ok: false, reason: 'fatal' })

    const stopFailure = createProduct()
    stopFailure.terminal.throwOnStop = new Error('stop failed')
    await stopFailure.controller.start()
    const stopResult = await stopFailure.controller.requestExit('user')
    expect(stopResult).toMatchObject({ ok: false, reason: 'fatal' })
    expect(stopResult.shutdown.issues.map(issue => issue.phase)).toContain('stop-input')
    expect(stopFailure.terminal.state).toBe('restored')
  })

  it('contains command unsubscribe plus stop failures and ignores a captured late registry callback', async () => {
    const session = new FakeSession()
    session.commands = [{ name: 'compact', description: 'Compact' }]
    session.throwOnCommandUnsubscribe = new Error('unsubscribe failed')
    const terminal = new FakeTerminal()
    terminal.throwOnStop = new Error('stop failed too')
    const { controller } = createProduct({ session, terminal })
    await controller.start()
    const lateChange = [...session.commandListeners][0]!
    expect(session.listCommandsCount).toBe(1)

    const result = await controller.requestExit('user')
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.some(issue => (
      String(issue.error).includes('DSH-TUI input quiesce failed')
    ))).toBe(true)
    expect(terminal.restoreCount).toBe(1)
    lateChange()
    expect(session.listCommandsCount).toBe(1)
  })

  it('reports interaction settlement failures and still restores the terminal', async () => {
    const session = new FakeSession()
    session.throwOnDisposeInteractions = new Error('interaction settlement failed')
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    const result = await controller.requestExit('user')

    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.map(issue => issue.phase)).toContain('settle-interactions')
    expect(result.shutdown.issues.some(issue => (
      issue.phase === 'settle-interactions'
      && String(issue.error).includes('DSH-TUI interaction settlement failed')
    ))).toBe(true)
    expect(terminal.restoreCount).toBe(1)
  })

  it('settles and releases every binding while cancelling only the current Agent', async () => {
    const source = new FakeSession('session-a')
    const target = new FakeSession('session-b')
    const activation = new FakeActivation()
    activation.activateOverride = async () => ({
      port: target,
      release: () => target.dispose(),
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([{
      sessionId: 'session-a',
      createdAt: 1,
      isSubagent: false,
      attached: true,
      durablePresence: 'not-observed',
      liveStatus: 'idle',
    }, {
      sessionId: 'session-b',
      createdAt: 10,
      isSubagent: false,
      attached: true,
      durablePresence: 'not-observed',
      liveStatus: 'running',
    }])
    const { controller, terminal } = createProduct({
      session: source,
      activation,
      catalog,
    })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    target.eventsSource.push(runtime(0, 'agent/created', 'running', 'session-b'))
    target.interactionsSource.push(snapshot([], 'session-b'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('session-b') === true)
    source.throwOnDisposeInteractions = new Error('background settlement failed')

    const result = await controller.requestExit('user')

    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.map(issue => issue.phase)).toContain('settle-interactions')
    expect(source.cancellations).toEqual([])
    expect(target.cancellations).toEqual([{ kind: 'user' }])
    expect(source.disposeInteractionsCount).toBe(2)
    expect(target.disposeInteractionsCount).toBe(2)
    expect(source.disposeCount).toBe(1)
    expect(target.disposeCount).toBe(1)
    expect(terminal.restoreCount).toBe(1)
  })

  it('joins pumps after a dispose failure and reports cleanup issues', async () => {
    const { controller, session, terminal } = createProduct()
    session.throwOnDispose = new Error('dispose failed')
    await controller.start()
    const result = await controller.requestExit('user')

    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.map(issue => issue.phase)).toContain('dispose-runtime')
    expect(session.eventsSource.aborts).toBe(1)
    expect(session.interactionsSource.aborts).toBe(1)
    expect(terminal.state).toBe('restored')
  })

  it('does not reduce a value yielded after the pump abort barrier', async () => {
    const session = new FakeSession()
    session.eventsOverride = options => (async function* (): AsyncIterable<DshTuiEvent> {
      options?.onCaughtUp?.({ lastSeq: -1, status: 'idle' })
      yield runtime(0, 'agent/created')
      await new Promise<void>(resolve => {
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      yield durable(0, {
        type: 'user/message',
        data: {
          message: message('late', 'user', 'must not be reduced'),
          surfaceOp: 'append',
        },
      })
    })()
    const { controller } = createProduct({ session })
    await controller.start()
    await waitFor(() => controller.state === 'running')
    const result = await controller.requestExit('user')

    expect(result).toMatchObject({ ok: true })
    const internal = controller as unknown as {
      readonly ui: { readonly sessions: Record<string, { readonly rows: readonly unknown[] }> }
    }
    expect(internal.ui.sessions['session-a']?.rows).toEqual([])
  })

  it('does not apply an interaction yielded after abort and ignores post-abort pump errors', async () => {
    const interactionLate = new FakeSession()
    interactionLate.interactionsOverride = options => (
      async function* (): AsyncIterable<InteractionSnapshot> {
        yield snapshot()
        await new Promise<void>(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        yield snapshot([{
          id: 'late',
          kind: 'approval',
          sessionId: 'session-a',
          approvalId: 'late',
          toolName: 'late',
          callId: 'late',
        }])
      }
    )()
    const lateProduct = createProduct({ session: interactionLate })
    await lateProduct.controller.start()
    await waitFor(() => (
      (lateProduct.controller as unknown as {
        readonly interaction: InteractionSnapshot | undefined
      }).interaction !== undefined
    ))
    const lateResult = await lateProduct.controller.requestExit('user')
    expect(lateResult).toMatchObject({ ok: true })
    const lateInternal = lateProduct.controller as unknown as {
      readonly interaction: InteractionSnapshot | undefined
    }
    expect(lateInternal.interaction?.pending).toEqual([])

    const throwing = new FakeSession()
    throwing.eventsOverride = options => (
      async function* (): AsyncIterable<DshTuiEvent> {
        options?.onCaughtUp?.({ lastSeq: -1, status: 'idle' })
        await new Promise<void>(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        throw 'late runtime error'
      }
    )()
    throwing.interactionsOverride = options => (
      async function* (): AsyncIterable<InteractionSnapshot> {
        yield snapshot()
        await new Promise<void>(resolve => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        throw new Error('late interaction error')
      }
    )()
    const throwingProduct = createProduct({ session: throwing })
    await throwingProduct.controller.start()
    await expect(throwingProduct.controller.requestExit('user')).resolves.toMatchObject({
      ok: true,
    })
  })

  it('exits cleanly when submit or interrupt observes an already disposed agent', async () => {
    const submitDisposed = createProduct()
    await submitDisposed.controller.start()
    submitDisposed.session.eventsSource.push(runtime(0, 'agent/created'))
    submitDisposed.session.eventsSource.push(runtime(1, 'agent/disposed'))
    await waitFor(() => (
      submitDisposed.terminal.frames.at(-1)?.lines[0]?.includes('disposed') === true
    ))
    submitDisposed.terminal.input({ type: 'insert', text: 'unsent' })
    submitDisposed.terminal.input({ type: 'submit' })
    await expect(submitDisposed.controller.wait()).resolves.toMatchObject({
      ok: true,
      reason: 'runtime-disposed',
    })
    expect(submitDisposed.session.submitted).toEqual([])

    const interruptDisposed = createProduct()
    await interruptDisposed.controller.start()
    interruptDisposed.session.eventsSource.push(runtime(0, 'agent/created'))
    interruptDisposed.session.eventsSource.push(runtime(1, 'agent/disposed'))
    await waitFor(() => (
      interruptDisposed.terminal.frames.at(-1)?.lines[0]?.includes('disposed') === true
    ))
    interruptDisposed.terminal.input({ type: 'interrupt' })
    await expect(interruptDisposed.controller.wait()).resolves.toMatchObject({
      ok: true,
      reason: 'runtime-disposed',
    })
  })

  it('uses the default frame interval and the idle fallback when projection is absent', async () => {
    const session = new FakeSession()
    session.interactionsSource.push(snapshot([], session.sessionId))
    const terminal = new FakeTerminal()
    const application = new FakeApplication()
    const controller = new DshTuiController({
      session,
      catalog: new FakeCatalog(),
      terminal,
      application,
    })
    const internal = controller as unknown as {
      ui: UiState
    }
    internal.ui = { phase: 'ready', sessions: {}, runtimeCursor: {} }
    await controller.start()
    terminal.input({ type: 'insert', text: 'fallback' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]?.delivery).toBe('followup')
    await controller.requestExit('user')
    const frames = terminal.frames.length
    terminal.resize({ columns: 10, rows: 3 })
    expect(terminal.frames).toHaveLength(frames)
  })

  it('keeps missing-snapshot interaction paths fail closed', async () => {
    const { controller, session, terminal } = createProduct()
    await controller.start()
    session.interactionsSource.push(snapshot([{
      id: 'approval:1',
      kind: 'approval',
      sessionId: 'session-a',
      approvalId: 'approval-1',
      toolName: 'write',
      callId: 'call-1',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === true)
    const internal = controller as unknown as {
      interaction: InteractionSnapshot | undefined
    }
    internal.interaction = undefined
    terminal.input({ type: 'submit' })
    expect(session.responses).toEqual([])
    terminal.input({ type: 'escape' })
    expect(session.responses).toHaveLength(1)
    await controller.requestExit('user')
  })

  it('keeps one submit task and waits for it before shutdown cancellation', async () => {
    const { controller, session, terminal } = createProduct()
    const submit = deferred()
    session.submitGate = submit.promise
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created', 'running'))
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('running') === true)
    terminal.input({ type: 'insert', text: 'race' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)

    const stopping = controller.requestExit('user')
    await Promise.resolve()
    expect(session.cancellations).toEqual([])
    submit.resolve()
    const result = await stopping
    expect(result).toMatchObject({ ok: true })
    expect(session.cancellations).toEqual([{ kind: 'user' }])
  })

  it('cancels conservatively when graceful exit wins the first runtime status event', async () => {
    const { controller, session } = createProduct()
    const idle = deferred()
    session.idleGate = idle.promise
    session.onCancel = () => idle.resolve()
    await controller.start()

    const exiting = controller.requestExit('user')
    await new Promise(resolve => setTimeout(resolve, 5))
    const cancellations = [...session.cancellations]
    idle.resolve()
    await exiting

    expect(cancellations).toEqual([{ kind: 'user' }])
  })

  it('restores a failed submit draft only when the user has not typed a replacement', async () => {
    const empty = createProduct()
    empty.session.throwOnSubmit = new Error('submit failed')
    await empty.controller.start()
    empty.terminal.input({ type: 'insert', text: 'recover me' })
    empty.terminal.input({ type: 'submit' })
    const emptyResult = await empty.controller.wait()
    expect(emptyResult).toMatchObject({ ok: false, reason: 'fatal' })
    const emptyInternal = empty.controller as unknown as {
      readonly prompt: { readonly text: string }
    }
    expect(emptyInternal.prompt.text).toBe('recover me')

    const replaced = createProduct()
    const gate = deferred()
    replaced.session.submitGate = gate.promise
    replaced.session.throwOnSubmit = new Error('submit failed later')
    await replaced.controller.start()
    replaced.terminal.input({ type: 'insert', text: 'old draft' })
    replaced.terminal.input({ type: 'submit' })
    await waitFor(() => replaced.session.submitted.length === 1)
    replaced.terminal.input({ type: 'insert', text: 'new draft' })
    gate.resolve()
    const replacedResult = await replaced.controller.wait()
    expect(replacedResult).toMatchObject({ ok: false, reason: 'fatal' })
    const replacedInternal = replaced.controller as unknown as {
      readonly prompt: { readonly text: string }
    }
    expect(replacedInternal.prompt.text).toBe('new draft')
  })

  it('contains a synchronous interaction response failure inside the input callback', async () => {
    const { controller, session, terminal } = createProduct()
    session.throwOnRespond = new Error('respond failed')
    await controller.start()
    session.interactionsSource.push(snapshot([{
      id: 'approval:1',
      kind: 'approval',
      sessionId: 'session-a',
      approvalId: 'approval-1',
      toolName: 'write',
      callId: 'call-1',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PERMISSION REQUIRED') === true)
    terminal.input({ type: 'insert', text: 'y' })
    expect(() => terminal.input({ type: 'submit' })).not.toThrow()
    const result = await controller.wait()
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(String(resultError(result))).toContain('respond failed')
  })

  it('guards lifecycle idempotency and ignores input outside the running phase', async () => {
    const { controller, terminal } = createProduct()
    terminal.input({ type: 'insert', text: 'before start' })
    await controller.start()
    await expect(controller.start()).rejects.toThrow('already started')
    terminal.input({ type: 'ignored' })

    const first = controller.requestExit('user')
    const second = controller.requestExit('signal')
    const [result, forced] = await Promise.all([first, second])
    expect(forced).toBe(result)
    expect(result).toMatchObject({ ok: false, reason: 'forced' })
    terminal.input({ type: 'insert', text: 'after stop' })
    await expect(controller.requestExit('user')).resolves.toBe(result)
  })

  it('records forced preparation and force-exit failures without leaking callbacks', async () => {
    const stopFailure = createProduct()
    stopFailure.terminal.throwOnStop = new Error('force preparation failed')
    await stopFailure.controller.start()
    const first = stopFailure.controller.requestExit('user')
    const second = stopFailure.controller.requestExit('signal')
    expect(await second).toBe(await first)
    const stopped = await first
    expect(stopped).toMatchObject({ ok: false, reason: 'forced' })
    expect(String(resultError(stopped))).toContain('force preparation failed')

    const forceFailure = createProduct()
    forceFailure.application.throwOnForce = new Error('force exit failed')
    await forceFailure.controller.start()
    const graceful = forceFailure.controller.requestExit('user')
    const forced = forceFailure.controller.requestExit('signal')
    expect(await forced).toBe(await graceful)
    const result = await graceful
    expect(result).toMatchObject({ ok: false, reason: 'forced' })
    expect(result.shutdown.issues.map(issue => issue.phase)).toContain('force-exit')
    expect(resultError(result)).toBeInstanceOf(AggregateError)
  })

  it('makes private fatal/shutdown guards idempotent after completion', async () => {
    const { controller } = createProduct()
    await controller.start()
    const result = await controller.requestExit('user')
    const internal = controller as unknown as {
      beginGraceful(reason: 'user'): void
      forceShutdown(): void
      fail(error: unknown): void
      recordFatal(error: unknown): void
      observeShutdown(promise: Promise<never>): Promise<void>
    }
    internal.beginGraceful('user')
    internal.forceShutdown()
    internal.fail(new Error('ignored after stop'))
    internal.recordFatal(new Error('first late error'))
    internal.recordFatal(new Error('second late error'))
    await internal.observeShutdown(Promise.reject(new Error('observer failed')))
    await expect(controller.wait()).resolves.toBe(result)
  })
})
