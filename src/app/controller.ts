import {
  applyInteractionReceipt,
  prepareInteractionCancel,
  prepareInteractionSubmit,
  reconcileInteractionEditor,
  reduceInteractionEditor,
  selectDshTuiInputMode,
  type InteractionEditorCommand,
  type InteractionEditorState,
} from '../interaction/editor.ts'
import type {
  InteractionSnapshot,
} from '../interaction/port.ts'
import {
  applyModelPickerAction,
  createModelPickerState,
  openModelPicker,
  reconcileModelPicker,
  selectModelPicker,
  type ModelPickerAction,
  type ModelPickerOutcome,
  type ModelPickerState,
} from '../model/picker.ts'
import type {
  DshTuiModelSelection,
  SessionModelSnapshot,
} from '../model/port.ts'
import type { SessionContextSnapshot } from '../context/port.ts'
import { ProviderConnectController } from '../provider/connect-controller.ts'
import type { ProviderConnectionPort } from '../provider/port.ts'
import type {
  DshCommandDescriptor,
} from '../command/port.ts'
import {
  commandCompletion,
  createCommandMenuState,
  decideCommandDispatch,
  dismissCommandMenu,
  moveCommandMenuSelection,
  selectCommandMenu,
  type CommandMenuCandidate,
  type CommandMenuState,
  type CommandMenuView,
} from '../command/menu.ts'
import {
  ShutdownCoordinator,
  type ShutdownResult,
} from '../lifecycle/shutdown.ts'
import type { AgentStatus } from '../runtime/events.ts'
import { unpackDshEventDelivery } from '../runtime/delivery.ts'
import type { RuntimeReplayBoundary } from '../runtime/port.ts'
import type {
  SessionCatalogEntry,
  SessionCatalogPort,
  SessionCatalogSnapshot,
} from '../session/catalog-port.ts'
import type {
  SessionInspectionPort,
  SessionInspectionSnapshot,
} from '../session/inspection-port.ts'
import { projectSessionInspection } from '../session/inspection-projection.ts'
import {
  applySessionPickerAction,
  createSessionPickerState,
  openSessionPicker as openSessionPickerState,
  reconcileSessionPicker,
  selectSessionPicker,
  type SessionPickerOutcome,
  type SessionPickerState,
} from '../session/picker.ts'
import {
  createSessionBinding,
  type DshTuiSessionLease,
  type SessionBinding,
} from '../session/binding.ts'
import type {
  ActivatedSessionLease,
  SessionActivationPort,
  SessionActivationRequest,
} from '../session/activation-port.ts'
import type {
  TerminalDriver,
  TerminalDriverCallbacks,
} from '../terminal/driver.ts'
import type { TerminalInputAction } from '../terminal/input.ts'
import {
  applyToolPresentation,
  reduceUiEvent,
  setUiPhase,
} from '../transcript/reducer.ts'
import type { UiState } from '../transcript/state.ts'
import type { ToolCardRendererRegistry } from '../presentation/tool-card-renderers.ts'
import {
  COLD_RESUME_CONFIRMATION_MIN_COLUMNS,
  COLD_RESUME_CONFIRMATION_MIN_ROWS,
  coldResumeConfirmationFits,
  renderDshFrame,
  sessionInspectionMaxScrollOffset,
  type SessionInspectionCatalogObservation,
  type SessionInspectionPanel,
  type TerminalViewport,
  type UiFrame,
} from '../ui/frame.ts'
import { FrameScheduler } from '../ui/frame-scheduler.ts'
import {
  createPromptEditorState,
  reducePromptEditor,
  type PromptEditorAction,
  type PromptEditorState,
} from '../ui/prompt-editor.ts'

export type DshTuiProductPort = DshTuiSessionLease

export interface DshTuiApplicationPort {
  requestExit(): void | Promise<void>
  forceExit(): void | Promise<void>
}

export type DshTuiControllerState = 'idle' | 'running' | 'stopping' | 'stopped'
export type DshTuiExitReason = 'user' | 'signal' | 'runtime-disposed'

export type DshTuiControllerResult =
  | {
      readonly ok: true
      readonly reason: DshTuiExitReason
      readonly shutdown: ShutdownResult
    }
  | {
      readonly ok: false
      readonly reason: 'fatal' | 'forced'
      readonly error?: unknown
      readonly shutdown: ShutdownResult
    }

export interface DshTuiControllerOptions {
  readonly session: DshTuiProductPort
  /** Exact initial lease release; borrowed ports must not be disposed as owned Agents. */
  readonly sessionRelease?: () => Promise<void>
  /** Optional until product composition can safely distinguish live attach from cold resume. */
  readonly activation?: SessionActivationPort
  /** Optional read-only logical snapshot capability; it never activates a Session. */
  readonly inspection?: SessionInspectionPort
  readonly catalog: SessionCatalogPort
  /** App-global official Provider connection capability; independent of Session leases. */
  readonly providers?: ProviderConnectionPort
  readonly terminal: TerminalDriver
  readonly terminalStartMode?: 'start' | 'adopt-running'
  readonly application: DshTuiApplicationPort
  /** Product-owned, effect-scoped rich Tool card renderer set. */
  readonly toolCards?: ToolCardRendererRegistry
  /** Test seam; product composition uses the scheduler's 16 ms default. */
  readonly frameIntervalMs?: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeMessageOf(error: unknown, fallback: string): string {
  try {
    const message = error instanceof Error ? error.message : String(error)
    return message.trim() === '' ? fallback : message
  } catch {
    return fallback
  }
}

function commandMessageOf(error: unknown): string {
  return safeMessageOf(error, 'unknown command error')
}

function cleanupMessageOf(error: unknown): string {
  const message = commandMessageOf(error)
  return error instanceof AggregateError
    ? [message, ...error.errors.map(commandMessageOf)].join(': ')
    : message
}

function catalogMessageOf(error: unknown): string {
  return safeMessageOf(error, 'unknown catalog error')
}

function inspectionMessageOf(error: unknown): string {
  return safeMessageOf(error, 'unknown inspection error')
}

function sameModelSelection(
  left: DshTuiModelSelection | undefined,
  right: DshTuiModelSelection | undefined,
): boolean {
  return left?.provider === right?.provider
    && left?.model === right?.model
    && left?.reasoningEffort === right?.reasoningEffort
}

function modelSelectionLabel(selection: DshTuiModelSelection): string {
  return `${selection.provider}/${selection.model}`
    + (selection.reasoningEffort === undefined ? '' : ` · ${selection.reasoningEffort}`)
}

function assertSessionInspectionIdentity(
  requestedSessionId: string,
  snapshot: SessionInspectionSnapshot,
): void {
  if (snapshot.header.sessionId !== requestedSessionId) {
    throw new Error(
      `Inspection snapshot session "${snapshot.header.sessionId}" does not match requested session "${requestedSessionId}"`,
    )
  }
}

interface ReadinessSignal {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

function readinessSignal(): ReadinessSignal {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

interface SessionSwitchAttempt {
  readonly source: SessionBinding
  readonly targetSessionId: string
  readonly intent: SessionActivationRequest['intent']
  readonly abort: AbortController
  task: Promise<void>
}

interface ReadySessionInspection {
  readonly snapshot: SessionInspectionSnapshot
  readonly projection: UiState
  readonly scrollOffset: number
  readonly refreshing: boolean
  readonly error?: string
  readonly notice?: string
}

type SessionInspectionState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading'; readonly sessionId: string }
  | { readonly kind: 'error'; readonly sessionId: string; readonly message: string }
  | { readonly kind: 'ready'; readonly value: ReadySessionInspection }
  | { readonly kind: 'confirm-resume'; readonly value: ReadySessionInspection }

type OpenSessionInspectionState = Exclude<
  SessionInspectionState,
  { readonly kind: 'closed' }
>

interface SessionInspectionAttempt {
  readonly source: SessionBinding
  readonly sourceEpoch: number
  readonly sessionId: string
  readonly abort: AbortController
  readonly previous?: ReadySessionInspection
  task: Promise<void>
}

interface BindingReadinessCallbacks {
  readonly onRuntimeCaughtUp: (boundary: RuntimeReplayBoundary) => void
  readonly onInteractionObserved: () => void
  readonly onFailure: (error: unknown) => void
}

const LOCAL_SESSIONS_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'sessions',
  description: 'Browse sessions',
})

const LOCAL_SESSIONS_CANDIDATE: CommandMenuCandidate = Object.freeze({
  origin: 'local',
  command: LOCAL_SESSIONS_COMMAND,
})

const LOCAL_MODEL_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'model',
  description: 'Choose model and reasoning effort',
})

const LOCAL_MODEL_CANDIDATE: CommandMenuCandidate = Object.freeze({
  origin: 'local',
  command: LOCAL_MODEL_COMMAND,
})

const LOCAL_CONNECT_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'connect',
  description: 'Connect, reconnect, or disconnect an official Provider',
})

const LOCAL_CONNECT_CANDIDATE: CommandMenuCandidate = Object.freeze({
  origin: 'local',
  command: LOCAL_CONNECT_COMMAND,
})

const LOCAL_CONTEXT_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'context',
  description: 'Inspect official context pressure and token usage',
})

const LOCAL_CONTEXT_CANDIDATE: CommandMenuCandidate = Object.freeze({
  origin: 'local',
  command: LOCAL_CONTEXT_COMMAND,
})

const EMPTY_SESSION_CATALOG: SessionCatalogSnapshot = Object.freeze({
  durability: 'unavailable',
  sessions: Object.freeze([]),
})

const SESSION_REASONING_STATE_LIMIT = 32

function localSessionsInput(line: string): string | undefined {
  const prefix = '/sessions'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

function localModelInput(line: string): string | undefined {
  const prefix = '/model'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

function localConnectInput(line: string): string | undefined {
  const prefix = '/connect'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

function localContextInput(line: string): string | undefined {
  const prefix = '/context'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

type EditorInputAction = Exclude<
  TerminalInputAction,
  {
    readonly type:
      | 'submit'
      | 'interrupt'
      | 'escape'
      | 'move-up'
      | 'move-down'
      | 'complete'
      | 'save-default'
      | 'toggle-reasoning'
  }
>

function promptAction(action: EditorInputAction): PromptEditorAction | undefined {
  switch (action.type) {
    case 'insert': return action
    case 'newline': return action
    case 'backspace': return action
    case 'delete': return action
    case 'move-left': return action
    case 'move-right': return action
    case 'move-home': return action
    case 'move-end': return action
    case 'ignored':
      return undefined
  }
}

export class DshTuiController {
  private readonly abort = new AbortController()
  private readonly scheduler: FrameScheduler
  private readonly providerConnect: ProviderConnectController | undefined
  private readonly shutdown: ShutdownCoordinator
  private readonly completion: Promise<DshTuiControllerResult>
  private resolveCompletion!: (result: DshTuiControllerResult) => void
  private phase: DshTuiControllerState = 'idle'
  private viewport: TerminalViewport
  private readonly bindings = new Set<SessionBinding>()
  private readonly hydratedBindings = new WeakSet<SessionBinding>()
  private nextBindingEpoch = 0
  private nextFollowRequest = 0
  private readonly reasoningBySession = new Map<string, true>()
  private currentBinding: SessionBinding
  private catalogSnapshot: SessionCatalogSnapshot = EMPTY_SESSION_CATALOG
  private catalogLoaded = false
  private catalogLoading = false
  private catalogError: string | undefined
  private catalogNotice: string | undefined
  private catalogGeneration = 0
  private catalogTask: Promise<void> | undefined
  private catalogAbort: AbortController | undefined
  private sessionPicker: SessionPickerState = createSessionPickerState()
  private inspectionState: SessionInspectionState = { kind: 'closed' }
  private inspectionAttempt: SessionInspectionAttempt | undefined
  private readonly inspectionTasks = new Set<Promise<void>>()
  private switchAttempt: SessionSwitchAttempt | undefined
  private switchCleanupError: unknown | undefined
  private requestedReason: DshTuiExitReason = 'user'
  private hasFatalError = false
  private fatalError: unknown
  private completedResult: DshTuiControllerResult | undefined
  private quiesced = false
  private quiesceError: unknown

  constructor(private readonly options: DshTuiControllerOptions) {
    this.viewport = options.terminal.viewport
    this.currentBinding = this.createBinding(
      options.session,
      'current',
      options.sessionRelease ?? (() => options.session.dispose()),
    )
    this.completion = new Promise(resolve => { this.resolveCompletion = resolve })
    this.scheduler = new FrameScheduler({
      buildFrame: () => this.buildFrame(),
      render: frame => options.terminal.render(frame),
      onFatal: error => this.fail(error),
      ...(options.frameIntervalMs === undefined
        ? {}
        : { frameIntervalMs: options.frameIntervalMs }),
    })
    this.providerConnect = options.providers === undefined
      ? undefined
      : new ProviderConnectController(options.providers, () => {
          if (this.phase === 'running') this.scheduler.invalidate('immediate')
        })
    this.shutdown = new ShutdownCoordinator({
      stopAcceptingInput: () => this.quiesce(),
      settleInteractions: () => this.settleInteractions(),
      cancelAgent: () => this.cancelForShutdown(),
      whenAgentIdle: () => this.waitForAgent(),
      flushSession: () => this.flushSession(),
      disposeRuntime: () => this.disposeAndJoinPumps(),
      restoreTerminal: () => options.terminal.restore(),
      requestAppExit: () => options.application.requestExit(),
      forceExit: () => options.application.forceExit(),
    })
  }

  private get session(): DshTuiSessionLease {
    return this.currentBinding.port
  }

  private get ui(): UiState {
    return this.currentBinding.ui
  }

  private set ui(value: UiState) {
    this.currentBinding.ui = value
  }

  private get prompt(): PromptEditorState {
    return this.currentBinding.prompt
  }

  private set prompt(value: PromptEditorState) {
    this.currentBinding.prompt = value
  }

  private get interaction(): InteractionSnapshot | undefined {
    return this.currentBinding.interaction
  }

  private set interaction(value: InteractionSnapshot | undefined) {
    this.currentBinding.interaction = value
  }

  private get interactionEditor(): InteractionEditorState {
    return this.currentBinding.interactionEditor
  }

  private set interactionEditor(value: InteractionEditorState) {
    this.currentBinding.interactionEditor = value
  }

  private get commands(): readonly DshCommandDescriptor[] {
    return this.currentBinding.commands
  }

  private get commandCatalogReady(): boolean {
    return this.currentBinding.commandCatalogReady
  }

  private get commandMenu(): CommandMenuState {
    return this.currentBinding.commandMenu
  }

  private set commandMenu(value: CommandMenuState) {
    this.currentBinding.commandMenu = value
  }

  private get commandNotice(): string | undefined {
    return this.currentBinding.commandNotice
  }

  private set commandNotice(value: string | undefined) {
    this.currentBinding.commandNotice = value
  }

  private get commandTask(): Promise<void> | undefined {
    return this.currentBinding.commandTask
  }

  private get commandAbort(): AbortController | undefined {
    return this.currentBinding.commandAbort
  }

  private get submitTask(): Promise<void> | undefined {
    return this.currentBinding.submitTask
  }

  private get modelPicker(): ModelPickerState {
    return this.currentBinding.modelPicker
  }

  private modelSnapshot(binding = this.currentBinding): SessionModelSnapshot {
    return binding.port.modelSnapshot()
  }

  private contextSnapshot(binding = this.currentBinding): SessionContextSnapshot {
    return binding.port.contextSnapshot?.() ?? { available: false }
  }

  private createBinding(
    port: DshTuiSessionLease,
    role: SessionBinding['role'],
    release: () => Promise<void>,
  ): SessionBinding {
    const binding = createSessionBinding(++this.nextBindingEpoch, port, role, release)
    binding.ui = setUiPhase(binding.ui, 'booting')
    this.bindings.add(binding)
    return binding
  }

  get state(): DshTuiControllerState {
    return this.phase
  }

  get pendingSubmitCount(): 0 | 1 {
    return this.submitTask === undefined ? 0 : 1
  }

  get pendingCommandCount(): 0 | 1 {
    return this.commandTask === undefined ? 0 : 1
  }

  get pendingCatalogCount(): 0 | 1 {
    return this.catalogTask === undefined ? 0 : 1
  }

  get pendingSwitchCount(): 0 | 1 {
    return this.switchAttempt === undefined ? 0 : 1
  }

  get pendingInspectionCount(): number {
    return this.inspectionTasks.size
  }

  get pendingModelCount(): number {
    return Number(this.currentBinding.modelRefreshTask !== undefined)
      + Number(this.currentBinding.modelSelectTask !== undefined)
  }

  get pendingProviderCount(): number {
    return this.providerConnect?.pendingCount ?? 0
  }

  async start(): Promise<void> {
    if (this.phase !== 'idle') throw new Error('DSH-TUI controller is already started')
    this.phase = 'running'
    try {
      const callbacks: TerminalDriverCallbacks = {
        onInput: action => this.guardCallback(() => this.handleInput(action)),
        onResize: viewport => this.guardCallback(() => this.handleResize(viewport)),
      }
      if (this.options.terminalStartMode === 'adopt-running') {
        this.options.terminal.handoff(callbacks)
      } else {
        this.options.terminal.start(callbacks)
      }
      this.scheduler.invalidate('immediate')
      await this.hydrateBinding(
        this.currentBinding,
        this.currentBinding.abort.signal,
        'initial session hydration was cancelled',
      )
    } catch (error: unknown) {
      if (this.phase !== 'running' && this.currentBinding.abort.signal.aborted) {
        await this.completion
        return
      }
      this.fail(error)
      await this.completion
      throw error
    }
  }

  private startBinding(
    binding: SessionBinding,
    readiness: BindingReadinessCallbacks,
  ): void {
    binding.commandSubscription = binding.port.onCommandsChanged(() => {
      this.guardCallback(() => this.handleCommandsChanged(binding))
    })
    binding.modelSubscription = binding.port.onModelsChanged(() => {
      this.guardCallback(() => this.handleModelsChanged(binding))
    })
    binding.contextSubscription = binding.port.onContextChanged?.(() => {
      this.guardCallback(() => this.handleContextChanged(binding))
    })
    binding.context = this.contextSnapshot(binding)
    this.refreshCommands(binding)
    binding.runtimePump = this.pumpRuntime(binding, readiness)
    binding.interactionPump = this.pumpInteractions(binding, readiness)
  }

  private async hydrateBinding(
    binding: SessionBinding,
    signal: AbortSignal,
    cancellationMessage: string,
  ): Promise<void> {
    const runtimeReady = readinessSignal()
    const interactionReady = readinessSignal()
    const reject = (error: unknown): void => {
      runtimeReady.reject(error)
      interactionReady.reject(error)
    }
    this.startBinding(binding, {
      onRuntimeCaughtUp: () => { runtimeReady.resolve() },
      onInteractionObserved: () => { interactionReady.resolve() },
      onFailure: reject,
    })
    await this.waitForBindingReadiness(
      signal,
      Promise.all([runtimeReady.promise, interactionReady.promise]),
      cancellationMessage,
    )
    if (binding.failure !== undefined) throw binding.failure
    if (this.agentStatus(binding) === 'disposed') {
      const label = binding.role === 'candidate' ? 'target session' : 'session'
      throw new Error(`${label} "${binding.port.sessionId}" is disposed`)
    }
    this.hydratedBindings.add(binding)
    binding.ui = setUiPhase(binding.ui, 'ready')
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  requestExit(reason: 'user' | 'signal'): Promise<DshTuiControllerResult> {
    if (this.phase === 'stopped') return this.completion
    if (this.phase === 'stopping') {
      this.forceShutdown()
      return this.completion
    }
    this.beginGraceful(reason)
    return this.completion
  }

  wait(): Promise<DshTuiControllerResult> {
    return this.completion
  }

  private async pumpRuntime(
    binding: SessionBinding,
    readiness: BindingReadinessCallbacks,
  ): Promise<void> {
    const epoch = binding.epoch
    const signal = binding.abort.signal
    let disposed = false
    try {
      for await (const delivery of binding.port.events({
        signal,
        onCaughtUp: readiness.onRuntimeCaughtUp,
      })) {
        if (!this.isBindingOpen(binding, epoch)) return
        const { event, toolPresentation } = unpackDshEventDelivery(delivery)
        this.assertSession(binding, event.sessionId, 'runtime event')
        if (event.plane === 'runtime') binding.runtimeStatusObserved = true
        binding.ui = reduceUiEvent(binding.ui, event)
        binding.ui = applyToolPresentation(binding.ui, event, toolPresentation)
        disposed ||= event.plane === 'runtime' && event.type === 'agent/disposed'
        if (
          this.isCurrentBinding(binding, epoch)
          && binding.modelPicker.open
          && this.agentStatus(binding) !== 'idle'
        ) {
          this.dismissModelPicker(binding)
          binding.commandNotice = 'Model picker closed because the Agent is no longer idle'
        }
        if (
          this.isCurrentBinding(binding, epoch)
          && this.providerConnect?.isOpen === true
          && this.agentStatus(binding) !== 'idle'
        ) {
          this.providerConnect.close('Agent is no longer idle')
          binding.commandNotice = 'Provider connection closed because the Agent is no longer idle'
        }
        if (this.isCurrentBinding(binding, epoch)) this.scheduler.invalidate('coalesced')
        const compatibility = this.activeSession(binding)?.compatibilityError
        if (compatibility !== undefined) {
          throw new Error(`${compatibility.code}: ${compatibility.message}`)
        }
      }
      if (!this.isBindingOpen(binding, epoch)) return
      if (!disposed) throw new Error('runtime pump ended unexpectedly')
      if (this.isCurrentBinding(binding, epoch)) this.beginGraceful('runtime-disposed')
    } catch (error: unknown) {
      if (!this.isBindingOpen(binding, epoch)) return
      const failure = new Error(`runtime pump failed: ${messageOf(error)}`, { cause: error })
      readiness.onFailure(failure)
      this.failBinding(binding, failure)
    }
  }

  private async pumpInteractions(
    binding: SessionBinding,
    readiness: BindingReadinessCallbacks,
  ): Promise<void> {
    const epoch = binding.epoch
    const signal = binding.abort.signal
    let observed = false
    try {
      for await (
        const snapshot of binding.port.interactions({ signal })
      ) {
        if (!this.isBindingOpen(binding, epoch)) return
        this.assertSession(binding, snapshot.sessionId, 'interaction snapshot')
        binding.interaction = snapshot
        binding.interactionEditor = reconcileInteractionEditor(
          binding.interactionEditor,
          snapshot,
        )
        if (!observed) {
          observed = true
          readiness.onInteractionObserved()
        }
        if (
          this.isCurrentBinding(binding, epoch)
          && binding.interactionEditor.active !== undefined
          && this.sessionPicker.open
        ) {
          this.dismissSessionPicker()
        }
        if (
          this.isCurrentBinding(binding, epoch)
          && binding.interactionEditor.active !== undefined
          && binding.modelPicker.open
        ) {
          this.dismissModelPicker(binding)
          binding.commandNotice = 'Model picker closed for a pending interaction'
        }
        if (
          this.isCurrentBinding(binding, epoch)
          && binding.interactionEditor.active !== undefined
          && this.providerConnect?.isOpen === true
        ) {
          this.providerConnect.close('pending Session interaction')
          binding.commandNotice = 'Provider connection closed for a pending interaction'
        }
        if (
          this.isCurrentBinding(binding, epoch)
          && binding.interactionEditor.active !== undefined
          && binding.contextPanelOpen
        ) {
          binding.contextPanelOpen = false
          binding.commandNotice = 'Context panel closed for a pending interaction'
        }
        if (
          this.switchAttempt?.source === binding
          && binding.interactionEditor.active !== undefined
        ) {
          this.switchAttempt.abort.abort('source session requires interaction')
          binding.commandNotice = 'Session switch cancelled: answer the pending interaction first'
        }
        if (this.isCurrentBinding(binding, epoch)) this.scheduler.invalidate('immediate')
      }
      if (this.isBindingOpen(binding, epoch)) {
        throw new Error('interaction pump ended unexpectedly')
      }
    } catch (error: unknown) {
      if (!this.isBindingOpen(binding, epoch)) return
      const failure = new Error(`interaction pump failed: ${messageOf(error)}`, { cause: error })
      readiness.onFailure(failure)
      this.failBinding(binding, failure)
    }
  }

  private isBindingOpen(binding: SessionBinding, epoch = binding.epoch): boolean {
    return this.bindings.has(binding)
      && binding.epoch === epoch
      && binding.role !== 'closed'
      && !binding.abort.signal.aborted
  }

  private isCurrentBinding(binding: SessionBinding, epoch = binding.epoch): boolean {
    return this.currentBinding === binding
      && binding.epoch === epoch
      && binding.role === 'current'
  }

  private failBinding(binding: SessionBinding, error: unknown): void {
    binding.failure ??= error
    if (this.isCurrentBinding(binding)) this.fail(error)
  }

  private assertSession(
    binding: SessionBinding,
    sessionId: string,
    source: string,
  ): void {
    if (sessionId !== binding.port.sessionId) {
      throw new Error(
        `${source} belongs to "${sessionId}", expected "${binding.port.sessionId}"`,
      )
    }
  }

  private activeSession(binding = this.currentBinding): UiState['sessions'][string] | undefined {
    return binding.ui.sessions[binding.port.sessionId]
  }

  private buildFrame(): UiFrame {
    const providerConnect = this.interactionEditor.active === undefined
      ? this.providerConnect?.view()
      : undefined
    const inspection = this.interactionEditor.active === undefined
      && providerConnect === undefined
      ? this.currentInspectionPanel()
      : undefined
    const pickerView = this.interactionEditor.active === undefined
      && providerConnect === undefined
      && inspection === undefined
      ? selectSessionPicker(
          this.sessionPicker,
          this.catalogSnapshot,
          this.session.sessionId,
        )
      : undefined
    const contextPanel = this.interactionEditor.active === undefined
      && providerConnect === undefined
      && inspection === undefined
      && pickerView === undefined
      && this.currentBinding.contextPanelOpen
    const model = this.modelSnapshot()
    const modelPicker = this.interactionEditor.active === undefined
      && inspection === undefined
      && pickerView === undefined
      && !contextPanel
      ? selectModelPicker(this.modelPicker, model)
      : undefined
    const commandMenu = this.interactionEditor.active === undefined
      && pickerView === undefined
      && modelPicker === undefined
      && !contextPanel
      ? this.currentCommandMenu()
      : undefined
    return renderDshFrame({
      ui: this.ui,
      model,
      context: this.currentBinding.context,
      contextPanel,
      interaction: this.interaction,
      prompt: this.prompt,
      input: selectDshTuiInputMode(this.prompt, this.interactionEditor),
      ...(commandMenu === undefined ? {} : { commandMenu }),
      ...(this.commandNotice === undefined ? {} : { commandNotice: this.commandNotice }),
      commandPending: this.commandTask !== undefined,
      ...(this.options.toolCards === undefined ? {} : { toolCards: this.options.toolCards }),
      bindingEpoch: this.currentBinding.epoch,
      reasoningExpanded: this.sessionReasoningExpanded(this.session.sessionId),
      followRequest: this.currentBinding.followRequest,
      ...(inspection === undefined ? {} : { sessionInspection: inspection }),
      ...(modelPicker === undefined ? {} : { modelPicker }),
      ...(providerConnect === undefined ? {} : { providerConnect }),
      ...(pickerView === undefined
        ? {}
        : {
            sessionPicker: {
              view: pickerView,
              loading: this.catalogLoading,
              loaded: this.catalogLoaded,
              ...(this.options.activation === undefined
                ? {}
                : { liveActivation: true }),
              ...(this.options.inspection === undefined
                ? {}
                : { inspection: true }),
              ...(this.catalogError === undefined ? {} : { error: this.catalogError }),
              ...(this.catalogNotice === undefined ? {} : { notice: this.catalogNotice }),
            },
          }),
    }, this.viewport)
  }

  private currentInspectionPanel(): SessionInspectionPanel | undefined {
    switch (this.inspectionState.kind) {
      case 'closed':
        return undefined
      case 'loading':
        return {
          kind: 'loading',
          sessionId: this.inspectionState.sessionId,
        }
      case 'error':
        return {
          kind: 'error',
          sessionId: this.inspectionState.sessionId,
          message: this.inspectionState.message,
        }
      case 'ready': {
        return this.readyInspectionPanel(this.inspectionState.value)
      }
      case 'confirm-resume': {
        const value = this.inspectionState.value
        return {
          kind: 'confirm-resume',
          sessionId: value.snapshot.header.sessionId,
          header: value.snapshot.header,
          observation: this.inspectionObservation(value.snapshot.header.sessionId),
        }
      }
    }
  }

  private readyInspectionPanel(
    value: ReadySessionInspection,
  ): Extract<SessionInspectionPanel, { kind: 'ready' }> {
    return {
      kind: 'ready',
      sessionId: value.snapshot.header.sessionId,
      header: value.snapshot.header,
      projection: value.projection,
      scrollOffset: value.scrollOffset,
      refreshing: value.refreshing,
      observation: this.inspectionObservation(value.snapshot.header.sessionId),
      ...(this.canResumeColdInspection(value) ? { canResumeCold: true } : {}),
      ...(value.error === undefined ? {} : { error: value.error }),
      ...(value.notice === undefined ? {} : { notice: value.notice }),
    }
  }

  private inspectionObservation(
    sessionId: string,
  ): SessionInspectionCatalogObservation {
    const entry = this.catalogSnapshot.sessions.find(candidate => (
      candidate.sessionId === sessionId
    ))
    if (entry === undefined) return { kind: 'missing' }
    return {
      kind: 'observed',
      relation: entry.attached ? 'other-live' : 'cold',
      durablePresence: entry.durablePresence,
      ...(entry.liveStatus === undefined ? {} : { liveStatus: entry.liveStatus }),
    }
  }

  private currentCommandMenu(): CommandMenuView | undefined {
    return selectCommandMenu(this.commandMenu, this.prompt, this.commandCandidates())
  }

  private hasOfficialSessionsCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_SESSIONS_COMMAND.name)
  }

  private hasOfficialModelCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_MODEL_COMMAND.name)
  }

  private hasOfficialConnectCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_CONNECT_COMMAND.name)
  }

  private hasOfficialContextCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_CONTEXT_COMMAND.name)
  }

  private hasOfficialCommand(name: string): boolean {
    return this.commands.some(command => command.name === name)
  }

  private commandCandidates(): readonly CommandMenuCandidate[] {
    const official = this.commands.map(command => ({
      origin: 'official' as const,
      command,
    }))
    const local = this.commandCatalogReady
      ? [
          this.hasOfficialSessionsCommand() ? undefined : LOCAL_SESSIONS_CANDIDATE,
          this.hasOfficialModelCommand() ? undefined : LOCAL_MODEL_CANDIDATE,
          this.options.providers === undefined || this.hasOfficialConnectCommand()
            ? undefined
            : LOCAL_CONNECT_CANDIDATE,
          this.session.contextSnapshot === undefined || this.hasOfficialContextCommand()
            ? undefined
            : LOCAL_CONTEXT_CANDIDATE,
        ].filter((candidate): candidate is CommandMenuCandidate => candidate !== undefined)
      : []
    return [...official, ...local]
  }

  private handleCommandsChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    this.refreshCommands(binding)
  }

  private refreshCommands(binding = this.currentBinding): void {
    try {
      binding.commands = binding.port.listCommands()
      binding.commandCatalogReady = true
      binding.commandNotice = undefined
      if (
        this.isCurrentBinding(binding)
        && this.hasOfficialSessionsCommand()
        && this.sessionPicker.open
      ) {
        this.dismissSessionPicker()
        binding.commandNotice = 'Official /sessions command is now registered'
      }
      if (
        this.isCurrentBinding(binding)
        && this.hasOfficialModelCommand()
        && binding.modelPicker.open
      ) {
        this.dismissModelPicker(binding)
        binding.commandNotice = 'Official /model command is now registered'
      }
      if (
        this.isCurrentBinding(binding)
        && this.hasOfficialConnectCommand()
        && this.providerConnect?.isOpen === true
      ) {
        this.providerConnect.close('official /connect command registered')
        binding.commandNotice = 'Official /connect command is now registered'
      }
      if (
        this.isCurrentBinding(binding)
        && this.hasOfficialContextCommand()
        && binding.contextPanelOpen
      ) {
        binding.contextPanelOpen = false
        binding.commandNotice = 'Official /context command is now registered'
      }
    } catch (error: unknown) {
      binding.commandCatalogReady = false
      binding.commandNotice = `Command catalog unavailable: ${commandMessageOf(error)}`
    }
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private handleResize(viewport: TerminalViewport): void {
    if (this.phase !== 'running') return
    this.viewport = viewport
    this.scheduler.invalidate('immediate')
  }

  private handleInput(action: TerminalInputAction): void {
    if (this.phase !== 'running') {
      if (this.phase === 'stopping' && action.type === 'interrupt') {
        this.forceShutdown()
      }
      return
    }
    if (!this.hydratedBindings.has(this.currentBinding)) {
      this.handleBootingInput(action)
      return
    }
    if (this.interactionEditor.active !== undefined) {
      this.handleInteractionInput(action)
      return
    }
    if (this.providerConnect?.isOpen === true) {
      this.providerConnect.handleInput(action)
      return
    }
    if (this.switchAttempt !== undefined) {
      if (action.type === 'interrupt' || action.type === 'escape') {
        if (!this.switchAttempt.abort.signal.aborted) {
          this.switchAttempt.abort.abort('DSH-TUI session switch cancelled by user')
          this.currentBinding.commandNotice = 'Cancelling session switch'
          this.scheduler.invalidate('immediate')
        } else if (action.type === 'interrupt') {
          this.forceShutdown()
        }
      }
      return
    }
    const inspectionState = this.inspectionState
    if (inspectionState.kind !== 'closed') {
      this.handleSessionInspectionInput(inspectionState, action)
      return
    }
    if (this.sessionPicker.open) {
      this.handleSessionPickerInput(action)
      return
    }
    if (this.modelPicker.open) {
      this.handleModelPickerInput(action)
      return
    }
    if (this.currentBinding.contextPanelOpen) {
      this.handleContextPanelInput(action)
      return
    }
    if (action.type === 'toggle-reasoning') {
      this.toggleSessionReasoning(this.session.sessionId)
      this.scheduler.invalidate('immediate')
      return
    }
    if (
      (this.currentBinding.modelSelectTask !== undefined
        || this.currentBinding.modelRefreshTask !== undefined)
      && action.type === 'interrupt'
    ) {
      const abort = this.currentBinding.modelSelectAbort
        ?? this.currentBinding.modelRefreshAbort
      if (abort !== undefined && !abort.signal.aborted) {
        abort.abort('DSH-TUI model operation cancelled by user')
        this.commandNotice = 'Cancelling model operation'
        this.scheduler.invalidate('immediate')
      } else {
        this.forceShutdown()
      }
      return
    }
    this.handlePromptInput(action)
  }

  private handleBootingInput(action: TerminalInputAction): void {
    if (action.type === 'interrupt') {
      this.beginGraceful('user')
      return
    }
    if (action.type === 'submit') {
      this.commandNotice = 'Startup is still in progress'
      this.scheduler.invalidate('immediate')
      return
    }
    if (
      action.type === 'escape'
      || action.type === 'save-default'
      || action.type === 'toggle-reasoning'
      || action.type === 'move-up'
      || action.type === 'move-down'
      || action.type === 'complete'
    ) return
    const editorAction = promptAction(action)
    if (editorAction === undefined) return
    const prompt = reducePromptEditor(this.prompt, editorAction)
    if (prompt === this.prompt) return
    this.prompt = prompt
    this.commandNotice = undefined
    this.scheduler.invalidate('immediate')
  }

  private handleSessionInspectionInput(
    state: OpenSessionInspectionState,
    action: TerminalInputAction,
  ): void {
    if (state.kind === 'confirm-resume') {
      if (action.type === 'interrupt' || action.type === 'escape') {
        this.inspectionState = { kind: 'ready', value: state.value }
        this.scheduler.invalidate('immediate')
        return
      }
      if (action.type !== 'submit') return
      if (!this.canResumeColdInspection(state.value)) {
        const notice = coldResumeConfirmationFits(this.viewport)
          ? 'Cold resume cancelled because the latest catalog observation is no longer an observed cold root'
          : `Cold resume confirmation requires at least ${COLD_RESUME_CONFIRMATION_MIN_COLUMNS}x${COLD_RESUME_CONFIRMATION_MIN_ROWS}`
        this.inspectionState = {
          kind: 'ready',
          value: {
            ...state.value,
            notice,
          },
        }
        this.scheduler.invalidate('immediate')
        return
      }
      const targetSessionId = state.value.snapshot.header.sessionId
      this.closeSessionInspection('DSH-TUI cold resume confirmed by user')
      this.beginSessionSwitch(targetSessionId, 'resume-cold')
      return
    }
    if (action.type === 'interrupt' || action.type === 'escape') {
      this.closeSessionInspection('DSH-TUI session inspection cancelled by user')
      return
    }
    if (state.kind === 'loading') return
    if (state.kind === 'error') {
      if (action.type === 'insert' && action.text.toLowerCase() === 'r') {
        this.beginSessionInspection(state.sessionId)
      }
      return
    }
    if (action.type === 'insert' && action.text.toLowerCase() === 'a') {
      if (this.canResumeColdInspection(state.value)) {
        this.inspectionState = { kind: 'confirm-resume', value: state.value }
        this.scheduler.invalidate('immediate')
      } else if (
        this.isColdResumeTargetEligible(state.value)
        && !coldResumeConfirmationFits(this.viewport)
      ) {
        this.inspectionState = {
          kind: 'ready',
          value: {
            ...state.value,
            notice: `Cold resume confirmation requires at least ${COLD_RESUME_CONFIRMATION_MIN_COLUMNS}x${COLD_RESUME_CONFIRMATION_MIN_ROWS}`,
          },
        }
        this.scheduler.invalidate('immediate')
      }
      return
    }
    if (action.type === 'insert' && action.text.toLowerCase() === 'r') {
      if (!state.value.refreshing) {
        this.beginSessionInspection(state.value.snapshot.header.sessionId, state.value)
      }
      return
    }
    if (action.type !== 'move-up' && action.type !== 'move-down') return
    const delta = action.type === 'move-up' ? 1 : -1
    const maxOffset = sessionInspectionMaxScrollOffset(
      this.readyInspectionPanel(state.value),
      this.viewport,
    )
    const currentOffset = Math.min(
      maxOffset,
      Math.max(0, Math.floor(state.value.scrollOffset)),
    )
    const scrollOffset = Math.min(
      maxOffset,
      Math.max(0, currentOffset + delta),
    )
    if (scrollOffset === state.value.scrollOffset) return
    this.inspectionState = {
      kind: 'ready',
      value: { ...state.value, scrollOffset },
    }
    this.scheduler.invalidate('immediate')
  }

  private handleInteractionInput(action: TerminalInputAction): void {
    if (action.type === 'submit') {
      const snapshot = this.interaction
      if (snapshot !== undefined) {
        this.applyInteractionCommand(
          prepareInteractionSubmit(this.interactionEditor, snapshot),
        )
      }
      return
    }
    if (action.type === 'interrupt' || action.type === 'escape') {
      this.applyInteractionCommand(prepareInteractionCancel(this.interactionEditor))
      return
    }
    if (
      action.type === 'move-up'
      || action.type === 'move-down'
      || action.type === 'complete'
      || action.type === 'save-default'
      || action.type === 'toggle-reasoning'
    ) return
    const editorAction = promptAction(action)
    if (editorAction === undefined) return
    const state = reduceInteractionEditor(this.interactionEditor, editorAction)
    if (state === this.interactionEditor) return
    this.interactionEditor = state
    this.scheduler.invalidate('immediate')
  }

  private applyInteractionCommand(command: InteractionEditorCommand): void {
    this.interactionEditor = command.state
    if (command.response !== undefined) {
      const receipt = this.session.respond(command.response)
      this.interactionEditor = applyInteractionReceipt(this.interactionEditor, receipt)
      if (this.interaction !== undefined) {
        this.interactionEditor = reconcileInteractionEditor(
          this.interactionEditor,
          this.interaction,
        )
      }
    }
    this.scheduler.invalidate('immediate')
  }

  private handleSessionPickerInput(action: TerminalInputAction): void {
    if (action.type === 'interrupt' || action.type === 'escape') {
      this.dismissSessionPicker()
      return
    }
    if (action.type === 'insert' && (action.text === 'r' || action.text === 'R')) {
      this.refreshSessionCatalog()
      return
    }
    const pickerAction = action.type === 'move-up' || action.type === 'move-down'
      ? { type: action.type } as const
      : action.type === 'submit'
        ? { type: 'enter' as const }
        : undefined
    if (pickerAction === undefined) return
    const transition = applySessionPickerAction(
      this.sessionPicker,
      this.catalogSnapshot,
      this.session.sessionId,
      pickerAction,
    )
    this.sessionPicker = transition.state
    this.applySessionPickerOutcome(transition.outcome)
    this.scheduler.invalidate('immediate')
  }

  private applySessionPickerOutcome(outcome: SessionPickerOutcome | undefined): void {
    if (outcome === undefined || outcome.kind === 'dismissed') return
    if (outcome.kind === 'read-only') {
      const selected = this.catalogSnapshot.sessions.find(
        entry => entry.sessionId === outcome.sessionId,
      )
      if (
        selected !== undefined
        && (outcome.relation === 'cold' || selected.isSubagent)
        && this.isInspectable(selected)
      ) {
        this.beginSessionInspection(selected.sessionId)
      } else if (selected?.isSubagent === true) {
        this.catalogNotice = `Subagent session ${outcome.sessionId} cannot use generic activation`
      } else if (outcome.relation === 'cold') {
        this.catalogNotice = this.options.inspection === undefined
          ? `Session ${outcome.sessionId} requires read-only inspection before cold resume`
          : `Session ${outcome.sessionId} durable snapshot was not observed`
      } else if (this.options.activation === undefined) {
        this.catalogNotice = `Session switching is not implemented for ${outcome.relation} session ${outcome.sessionId}`
      } else {
        this.beginSessionSwitch(outcome.sessionId, 'attach-live')
      }
      return
    }
    this.catalogNotice = outcome.reason === 'already-current'
      ? `Already viewing session ${outcome.sessionId}`
      : 'No sessions are available'
  }

  private isInspectable(entry: SessionCatalogEntry): boolean {
    return this.options.inspection !== undefined
      && this.catalogSnapshot.durability === 'available'
      && entry.durablePresence === 'observed'
  }

  private canResumeColdInspection(value: ReadySessionInspection): boolean {
    return coldResumeConfirmationFits(this.viewport)
      && this.isColdResumeTargetEligible(value)
  }

  private isColdResumeTargetEligible(value: ReadySessionInspection): boolean {
    if (
      this.options.activation === undefined
      || value.refreshing
      || value.snapshot.header.isSubagent
      || this.catalogTask !== undefined
      || !this.catalogLoaded
      || this.catalogSnapshot.durability !== 'available'
      || this.currentBinding.submitTask !== undefined
      || this.currentBinding.commandTask !== undefined
      || value.snapshot.header.sessionId === this.currentBinding.port.sessionId
      || this.findOpenBinding(value.snapshot.header.sessionId) !== undefined
    ) return false
    const entry = this.catalogSnapshot.sessions.find(candidate => (
      candidate.sessionId === value.snapshot.header.sessionId
    ))
    return entry !== undefined
      && !entry.isSubagent
      && !entry.attached
      && entry.durablePresence === 'observed'
  }

  private beginSessionInspection(
    sessionId: string,
    previous?: ReadySessionInspection,
  ): void {
    const source = this.currentBinding
    const abort = new AbortController()
    const attempt: SessionInspectionAttempt = {
      source,
      sourceEpoch: source.epoch,
      sessionId,
      abort,
      ...(previous === undefined ? {} : { previous }),
      task: Promise.resolve(),
    }
    this.inspectionAttempt = attempt
    this.catalogNotice = undefined
    if (previous === undefined) {
      this.inspectionState = { kind: 'loading', sessionId }
    } else {
      const {
        error: _previousError,
        notice: _previousNotice,
        ...value
      } = previous
      this.inspectionState = {
        kind: 'ready',
        value: {
          ...value,
          refreshing: true,
        },
      }
    }
    attempt.task = Promise.resolve().then(() => this.runSessionInspection(attempt))
    this.inspectionTasks.add(attempt.task)
    this.scheduler.invalidate('immediate')
  }

  private isCurrentInspection(attempt: SessionInspectionAttempt): boolean {
    return this.phase === 'running'
      && this.inspectionAttempt === attempt
      && this.currentBinding === attempt.source
      && this.currentBinding.epoch === attempt.sourceEpoch
      && this.sessionPicker.open
      && !attempt.abort.signal.aborted
  }

  private async runSessionInspection(attempt: SessionInspectionAttempt): Promise<void> {
    try {
      const snapshot = await this.options.inspection!.inspectSession({
        sessionId: attempt.sessionId,
        signal: attempt.abort.signal,
      })
      if (!this.isCurrentInspection(attempt)) return
      assertSessionInspectionIdentity(attempt.sessionId, snapshot)
      const projection = await projectSessionInspection(snapshot, attempt.abort.signal)
      this.inspectionState = {
        kind: 'ready',
        value: {
          snapshot,
          projection,
          scrollOffset: attempt.previous?.scrollOffset ?? 0,
          refreshing: false,
        },
      }
    } catch (error: unknown) {
      if (!this.isCurrentInspection(attempt)) return
      const detail = inspectionMessageOf(error)
      this.inspectionState = attempt.previous === undefined
        ? { kind: 'error', sessionId: attempt.sessionId, message: detail }
        : {
            kind: 'ready',
            value: {
              ...attempt.previous,
              refreshing: false,
              error: detail,
            },
          }
    } finally {
      this.inspectionTasks.delete(attempt.task)
      if (this.inspectionAttempt === attempt) this.inspectionAttempt = undefined
      if (this.phase === 'running') this.scheduler.invalidate('immediate')
    }
  }

  private closeSessionInspection(reason: unknown): void {
    const attempt = this.inspectionAttempt
    if (attempt !== undefined && !attempt.abort.signal.aborted) {
      attempt.abort.abort(reason)
    }
    this.inspectionAttempt = undefined
    this.inspectionState = { kind: 'closed' }
    if (this.phase === 'running') this.scheduler.invalidate('immediate')
  }

  private beginSessionSwitch(
    targetSessionId: string,
    intent: SessionActivationRequest['intent'],
  ): void {
    const source = this.currentBinding
    if (
      source.submitTask !== undefined
      || source.commandTask !== undefined
      || source.modelSelectTask !== undefined
    ) {
      this.catalogNotice = 'Wait for the current session operation before switching'
      return
    }

    const cached = this.findOpenBinding(targetSessionId)
    this.dismissSessionPicker()
    source.commandNotice = `Preparing session ${targetSessionId}`
    const abort = new AbortController()
    const attempt: SessionSwitchAttempt = {
      source,
      targetSessionId,
      intent,
      abort,
      task: Promise.resolve(),
    }
    this.switchAttempt = attempt
    attempt.task = this.runSessionSwitch(attempt, cached)
    this.scheduler.invalidate('immediate')
  }

  private findOpenBinding(sessionId: string): SessionBinding | undefined {
    return [...this.bindings].find(binding => (
      binding.role !== 'closed' && binding.port.sessionId === sessionId
    ))
  }

  private isCurrentSwitch(attempt: SessionSwitchAttempt): boolean {
    return this.phase === 'running'
      && this.switchAttempt === attempt
      && this.isCurrentBinding(attempt.source)
      && !attempt.abort.signal.aborted
  }

  private async runSessionSwitch(
    attempt: SessionSwitchAttempt,
    cached: SessionBinding | undefined,
  ): Promise<void> {
    let candidate: SessionBinding | undefined
    let looseLease: ActivatedSessionLease | undefined
    try {
      if (cached !== undefined) {
        if (cached.failure !== undefined) throw cached.failure
        if (this.agentStatus(cached) === 'disposed') {
          throw new Error(`target session "${attempt.targetSessionId}" is disposed`)
        }
        this.commitSessionSwitch(attempt, cached)
        return
      }

      looseLease = await this.options.activation!.activateSession({
        intent: attempt.intent,
        sessionId: attempt.targetSessionId,
        signal: attempt.abort.signal,
      })
      if (!this.isCurrentSwitch(attempt)) return
      if (looseLease.port.sessionId !== attempt.targetSessionId) {
        throw new Error(
          `activated session "${looseLease.port.sessionId}" does not match "${attempt.targetSessionId}"`,
        )
      }

      const acquired = looseLease
      candidate = this.createBinding(acquired.port, 'candidate', () => acquired.release())
      looseLease = undefined
      await this.stageCandidate(attempt, candidate)
      if (!this.isCurrentSwitch(attempt)) return
      this.commitSessionSwitch(attempt, candidate)
    } catch (error: unknown) {
      const cleanupError = await this.cleanupFailedCandidate(candidate, looseLease)
      looseLease = undefined
      if (!this.isCurrentSwitch(attempt)) {
        if (cleanupError !== undefined) {
          this.recordSwitchCleanupFailure(attempt, cleanupError)
        }
        return
      }
      const detail = commandMessageOf(error)
      attempt.source.commandNotice = cleanupError === undefined
        ? `Session switch failed: ${detail}`
        : `Session switch failed: ${detail}; cleanup failed: ${cleanupMessageOf(cleanupError)}`
    } finally {
      let cleanupError: unknown | undefined
      if (candidate !== undefined && candidate.role === 'candidate') {
        cleanupError = await this.cleanupFailedCandidate(candidate, undefined)
      } else if (looseLease !== undefined) {
        cleanupError = await this.cleanupFailedCandidate(undefined, looseLease)
      }
      if (cleanupError !== undefined) {
        this.recordSwitchCleanupFailure(attempt, cleanupError)
      }
      if (this.switchAttempt === attempt) this.switchAttempt = undefined
      if (this.phase === 'running') this.scheduler.invalidate('immediate')
    }
  }

  private async stageCandidate(
    attempt: SessionSwitchAttempt,
    candidate: SessionBinding,
  ): Promise<void> {
    await this.hydrateBinding(
      candidate,
      attempt.abort.signal,
      'session switch was cancelled',
    )
  }

  private async waitForBindingReadiness(
    signal: AbortSignal,
    readiness: Promise<unknown>,
    cancellationMessage: string,
  ): Promise<void> {
    if (signal.aborted) throw new Error(cancellationMessage)
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => { reject(new Error(cancellationMessage)) }
      signal.addEventListener('abort', onAbort, { once: true })
      void readiness.then(
        () => { resolve() },
        (error: unknown) => { reject(error) },
      ).finally(() => {
        signal.removeEventListener('abort', onAbort)
      })
    })
  }

  private commitSessionSwitch(
    attempt: SessionSwitchAttempt,
    target: SessionBinding,
  ): void {
    attempt.source.role = 'background'
    attempt.source.commandNotice = undefined
    target.role = 'current'
    target.commandNotice = `Viewing session ${target.port.sessionId}`
    this.currentBinding = target
    this.switchAttempt = undefined
    this.scheduler.invalidate('immediate')
  }

  private async cleanupFailedCandidate(
    candidate: SessionBinding | undefined,
    looseLease: ActivatedSessionLease | undefined,
  ): Promise<unknown | undefined> {
    try {
      if (candidate !== undefined) await this.closeBinding(candidate)
      else await looseLease?.release()
      return undefined
    } catch (error: unknown) {
      return error
    }
  }

  private recordSwitchCleanupFailure(
    attempt: SessionSwitchAttempt,
    error: unknown,
  ): void {
    if (this.phase === 'running' && this.isCurrentBinding(attempt.source)) {
      attempt.source.commandNotice =
        `Session switch cleanup failed: ${cleanupMessageOf(error)}`
      this.scheduler.invalidate('immediate')
      return
    }
    this.switchCleanupError ??= error
  }

  private closeBinding(binding: SessionBinding): Promise<void> {
    binding.closeTask ??= this.closeBindingOwned(binding)
    return binding.closeTask
  }

  private async closeBindingOwned(binding: SessionBinding): Promise<void> {
    binding.role = 'closed'
    binding.abort.abort('DSH-TUI binding closed')
    binding.commandAbort?.abort('DSH-TUI binding closed')
    binding.modelRefreshAbort?.abort('DSH-TUI binding closed')
    binding.modelSelectAbort?.abort('DSH-TUI binding closed')
    const errors: unknown[] = []
    const stopCommands = binding.commandSubscription
    const stopModels = binding.modelSubscription
    const stopContext = binding.contextSubscription
    binding.commandSubscription = undefined
    binding.modelSubscription = undefined
    binding.contextSubscription = undefined
    try {
      stopCommands?.()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      stopModels?.()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      stopContext?.()
    } catch (error: unknown) {
      errors.push(error)
    }
    // Session-switch admission keeps candidate/background bindings task-free.
    // Graceful shutdown drains the current binding's task before closing it.
    try {
      binding.releaseTask ??= Promise.resolve().then(() => binding.release())
      await binding.releaseTask
    } catch (error: unknown) {
      errors.push(error)
    } finally {
      await Promise.allSettled([
        binding.runtimePump ?? Promise.resolve(),
        binding.interactionPump ?? Promise.resolve(),
        binding.modelRefreshTask ?? Promise.resolve(),
        binding.modelSelectTask ?? Promise.resolve(),
      ])
      this.bindings.delete(binding)
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, `DSH-TUI binding ${binding.epoch} release failed`)
    }
  }

  private openLocalCommand(name: string): void {
    if (name === LOCAL_SESSIONS_COMMAND.name) {
      this.openLocalSessionPicker()
      return
    }
    if (name === LOCAL_MODEL_COMMAND.name) {
      this.openLocalModelPicker()
      return
    }
    if (name === LOCAL_CONTEXT_COMMAND.name) {
      this.openLocalContextPanel()
      return
    }
    this.openLocalProviderConnect()
  }

  private openLocalContextPanel(): void {
    /* v8 ignore next 5 -- the local command is exposed only when this capability exists */
    if (this.session.contextSnapshot === undefined) {
      this.commandNotice = 'Context projections are unavailable in this Session lease'
      this.scheduler.invalidate('immediate')
      return
    }
    this.prompt = createPromptEditorState()
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    this.currentBinding.context = this.contextSnapshot()
    this.currentBinding.contextPanelOpen = true
    this.scheduler.invalidate('immediate')
  }

  private handleContextPanelInput(action: TerminalInputAction): void {
    if (
      action.type !== 'interrupt'
      && action.type !== 'escape'
      && action.type !== 'submit'
    ) return
    this.currentBinding.contextPanelOpen = false
    this.scheduler.invalidate('immediate')
  }

  private openLocalProviderConnect(): void {
    const providerConnect = this.providerConnect
    /* v8 ignore next -- /connect is exposed locally only when this controller exists */
    if (providerConnect === undefined) {
      this.commandNotice = 'Provider connection is unavailable in this Host composition'
      this.scheduler.invalidate('immediate')
      return
    }
    if (this.agentStatus() !== 'idle') {
      this.commandNotice = 'Provider connection is available only while the Agent is idle'
      this.scheduler.invalidate('immediate')
      return
    }
    this.prompt = createPromptEditorState()
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    providerConnect.open()
  }

  private openLocalModelPicker(): void {
    const binding = this.currentBinding
    if (this.agentStatus(binding) !== 'idle') {
      binding.commandNotice = 'Model picker is available only while the Agent is idle'
      this.scheduler.invalidate('immediate')
      return
    }
    this.prompt = createPromptEditorState()
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    binding.modelPicker = openModelPicker(
      binding.modelPicker,
      this.modelSnapshot(binding),
    )
    this.scheduler.invalidate('immediate')
    this.beginModelRefresh(binding)
  }

  private handleModelPickerInput(action: TerminalInputAction): void {
    let pickerAction: ModelPickerAction | undefined
    switch (action.type) {
      case 'move-up':
      case 'move-down':
        pickerAction = action
        break
      case 'submit':
        pickerAction = { type: 'enter' }
        break
      case 'save-default':
        pickerAction = action
        break
      case 'escape':
      case 'interrupt':
        pickerAction = { type: 'escape' }
        break
      case 'insert':
        if (action.text.toLowerCase() === 'r') pickerAction = { type: 'refresh' }
        break
      case 'newline':
      case 'backspace':
      case 'delete':
      case 'move-left':
      case 'move-right':
      case 'complete':
      case 'move-home':
      case 'move-end':
      case 'toggle-reasoning':
      case 'ignored':
        break
    }
    if (pickerAction === undefined) return

    const binding = this.currentBinding
    const transition = applyModelPickerAction(
      binding.modelPicker,
      this.modelSnapshot(binding),
      pickerAction,
    )
    binding.modelPicker = transition.state
    this.handleModelPickerOutcome(binding, transition.outcome)
    this.scheduler.invalidate('immediate')
  }

  private handleModelPickerOutcome(
    binding: SessionBinding,
    outcome: ModelPickerOutcome | undefined,
  ): void {
    if (outcome === undefined) return
    switch (outcome.kind) {
      case 'selected':
        this.beginModelSelection(binding, outcome.selection, outcome.saveDefault)
        return
      case 'refresh-requested':
        this.beginModelRefresh(binding)
        return
      case 'cancelled':
        this.dismissModelPicker(binding)
        return
      case 'blocked': {
        const messages: Record<typeof outcome.reason, string> = {
          'read-only': 'This Agent model is managed by another Host',
          unroutable: 'The selected Provider is not currently routable',
          selecting: 'A model selection is already running',
          'no-selection': 'No model is available to select',
        }
        binding.commandNotice = messages[outcome.reason]
      }
    }
  }

  private handleModelsChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    binding.modelPicker = reconcileModelPicker(
      binding.modelPicker,
      this.modelSnapshot(binding),
    )
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private handleContextChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    binding.context = this.contextSnapshot(binding)
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private dismissModelPicker(binding = this.currentBinding): void {
    binding.modelPicker = createModelPickerState()
    binding.modelRefreshGeneration += 1
    binding.modelRefreshAbort?.abort('DSH-TUI model picker closed')
    this.scheduler.invalidate('immediate')
  }

  private beginModelRefresh(binding: SessionBinding): void {
    if (binding.modelRefreshTask !== undefined) {
      binding.commandNotice = 'Model catalog refresh is already running'
      this.scheduler.invalidate('immediate')
      return
    }
    const epoch = binding.epoch
    const generation = ++binding.modelRefreshGeneration
    const abort = new AbortController()
    binding.modelRefreshAbort = abort
    let task!: Promise<void>
    task = Promise.resolve()
      .then(() => binding.port.refreshModels(abort.signal))
      .catch((error: unknown) => {
        if (!this.isExactModelRefresh(binding, epoch, generation)) return
        binding.commandNotice = `Model catalog refresh failed: ${commandMessageOf(error)}`
      })
      .finally(() => {
        binding.modelRefreshTask = undefined
        binding.modelRefreshAbort = undefined
        if (!this.isExactModelRefresh(binding, epoch, generation)) return
        binding.modelPicker = reconcileModelPicker(
          binding.modelPicker,
          this.modelSnapshot(binding),
        )
        this.scheduler.invalidate('immediate')
      })
    binding.modelRefreshTask = task
  }

  private isExactModelRefresh(
    binding: SessionBinding,
    epoch: number,
    generation: number,
  ): boolean {
    if (binding.modelRefreshGeneration !== generation) return false
    return this.isBindingOpen(binding, epoch)
  }

  private beginModelSelection(
    binding: SessionBinding,
    selection: DshTuiModelSelection,
    saveDefault: boolean,
  ): void {
    const epoch = binding.epoch
    const generation = ++binding.modelSelectGeneration
    const abort = new AbortController()
    binding.modelSelectAbort = abort
    let task!: Promise<void>
    task = Promise.resolve()
      .then(() => binding.port.selectModel(selection, {
        saveDefault,
        signal: abort.signal,
      }))
      .then(() => {
        if (!this.isExactModelSelection(binding, epoch, generation)) return
        binding.commandNotice = saveDefault
          ? `Model switched and saved as default: ${modelSelectionLabel(selection)}`
          : `Model switched: ${modelSelectionLabel(selection)}`
      })
      .catch((error: unknown) => {
        if (!this.isExactModelSelection(binding, epoch, generation)) return
        if (abort.signal.aborted) return
        const detail = commandMessageOf(error)
        const current = this.modelSnapshot(binding).current
        binding.commandNotice = saveDefault && sameModelSelection(current, selection)
          ? `Model switched, but default was not saved: ${detail}`
          : `Model switch failed: ${detail}`
      })
      .finally(() => {
        binding.modelSelectTask = undefined
        binding.modelSelectAbort = undefined
        if (!this.isExactModelSelection(binding, epoch, generation)) return
        this.scheduler.invalidate('immediate')
      })
    binding.modelSelectTask = task
  }

  private isExactModelSelection(
    binding: SessionBinding,
    epoch: number,
    generation: number,
  ): boolean {
    if (binding.modelSelectGeneration !== generation) return false
    return this.isBindingOpen(binding, epoch)
  }

  private openLocalSessionPicker(): void {
    if (this.commandTask !== undefined) {
      this.commandNotice = 'A command is already running'
      this.scheduler.invalidate('immediate')
      return
    }
    this.prompt = createPromptEditorState()
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    this.catalogNotice = undefined
    this.sessionPicker = openSessionPickerState(
      this.sessionPicker,
      this.catalogSnapshot,
      this.session.sessionId,
    )
    if (this.catalogTask === undefined) {
      this.refreshSessionCatalog()
    } else {
      this.catalogLoading = true
      this.catalogNotice = 'Waiting for the previous catalog refresh to stop'
      this.scheduler.invalidate('immediate')
    }
  }

  private dismissSessionPicker(): void {
    this.closeSessionInspection('DSH-TUI session picker closed')
    if (this.sessionPicker.open) {
      this.sessionPicker = applySessionPickerAction(
        this.sessionPicker,
        this.catalogSnapshot,
        this.session.sessionId,
        { type: 'escape' },
      ).state
    }
    this.catalogGeneration += 1
    this.catalogAbort?.abort('DSH-TUI session picker closed')
    this.catalogLoading = false
    this.catalogNotice = undefined
    if (this.phase === 'running') this.scheduler.invalidate('immediate')
  }

  private refreshSessionCatalog(): void {
    if (this.catalogTask !== undefined) {
      this.catalogNotice = 'A catalog refresh is already running'
      this.scheduler.invalidate('immediate')
      return
    }

    const binding = this.currentBinding
    const generation = ++this.catalogGeneration
    const abort = new AbortController()
    this.catalogAbort = abort
    this.catalogLoading = true
    this.catalogError = undefined
    this.catalogNotice = undefined
    this.scheduler.invalidate('immediate')

    let task!: Promise<void>
    task = Promise.resolve()
      .then(() => this.options.catalog.listSessions({ signal: abort.signal }))
      .then((snapshot) => {
        if (!this.isCurrentCatalogRequest(binding, generation, task, abort)) return
        this.catalogSnapshot = snapshot
        this.catalogLoaded = true
        this.catalogError = undefined
        this.sessionPicker = reconcileSessionPicker(
          this.sessionPicker,
          snapshot,
          binding.port.sessionId,
        )
      })
      .catch((error: unknown) => {
        if (!this.isCurrentCatalogRequest(binding, generation, task, abort)) return
        this.catalogError = `Catalog unavailable: ${catalogMessageOf(error)}`
      })
      .finally(() => {
        this.catalogTask = undefined
        this.catalogAbort = undefined
        const restart = this.phase === 'running'
          && this.sessionPicker.open
          && generation !== this.catalogGeneration
        if (generation === this.catalogGeneration) this.catalogLoading = false
        if (restart) {
          this.catalogLoading = false
          this.refreshSessionCatalog()
        } else if (this.phase === 'running') {
          this.scheduler.invalidate('immediate')
        }
      })
    this.catalogTask = task
  }

  private isCurrentCatalogRequest(
    binding: SessionBinding,
    generation: number,
    task: Promise<void>,
    abort: AbortController,
  ): boolean {
    return this.phase === 'running'
      && this.isCurrentBinding(binding)
      && this.sessionPicker.open
      && this.catalogGeneration === generation
      && this.catalogTask === task
      && this.catalogAbort === abort
      && !abort.signal.aborted
  }

  private handlePromptInput(
    action: Exclude<TerminalInputAction, { readonly type: 'toggle-reasoning' }>,
  ): void {
    if (action.type === 'interrupt') {
      if (this.commandTask !== undefined) {
        if (!this.commandAbort!.signal.aborted) {
          this.commandAbort!.abort('DSH-TUI command cancelled by user')
          this.commandNotice = 'Cancelling command'
          this.scheduler.invalidate('immediate')
        } else {
          this.forceShutdown()
        }
        return
      }
      const status = this.agentStatus()
      if (status === 'running') {
        if (!this.session.ownsAgentLifecycle) {
          this.beginGraceful('user')
          return
        }
        this.session.cancel({ kind: 'user' })
      } else if (this.prompt.text !== '') {
        this.prompt = createPromptEditorState()
        this.scheduler.invalidate('immediate')
      } else {
        this.beginGraceful(status === 'disposed' ? 'runtime-disposed' : 'user')
      }
      return
    }
    if (action.type === 'submit' && this.currentBinding.modelSelectTask !== undefined) {
      this.commandNotice = 'Model selection is still being validated'
      this.scheduler.invalidate('immediate')
      return
    }
    const menu = this.currentCommandMenu()
    if (action.type === 'move-up' || action.type === 'move-down') {
      if (menu === undefined) return
      this.commandMenu = moveCommandMenuSelection(
        this.commandMenu,
        menu,
        action.type === 'move-up' ? 'up' : 'down',
      )
      this.scheduler.invalidate('immediate')
      return
    }
    if (action.type === 'complete') {
      const selected = menu?.candidates[menu.selectedIndex]
      if (selected !== undefined) this.completeMenuCandidate(selected)
      return
    }
    if (action.type === 'submit') {
      const selected = menu?.candidates[menu.selectedIndex]
      if (selected !== undefined) {
        if (selected.origin === 'local') {
          this.openLocalCommand(selected.command.name)
        } else if (selected.command.input !== undefined) {
          this.completeCommand(selected.command)
        } else {
          this.executeCommandLine(`/${selected.command.name}`)
        }
        return
      }
      this.submitPrompt()
      return
    }
    if (action.type === 'escape') {
      if (menu !== undefined) {
        this.commandMenu = dismissCommandMenu(this.commandMenu, this.prompt)
        this.scheduler.invalidate('immediate')
      } else if (this.prompt.text !== '') {
        this.prompt = createPromptEditorState()
        this.scheduler.invalidate('immediate')
      }
      return
    }
    if (action.type === 'save-default') return
    const editorAction = promptAction(action)
    if (editorAction === undefined) return
    const prompt = reducePromptEditor(this.prompt, editorAction)
    if (prompt === this.prompt) return
    this.prompt = prompt
    this.scheduler.invalidate('immediate')
  }

  private submitPrompt(): void {
    if (this.submitTask !== undefined || this.prompt.text.trim() === '') return
    if (this.commandTask !== undefined) {
      this.commandNotice = 'A command is already running'
      this.scheduler.invalidate('immediate')
      return
    }
    const status = this.agentStatus()
    if (status === 'disposed') {
      this.beginGraceful('runtime-disposed')
      return
    }
    const text = this.prompt.text
    if (text.startsWith('/') && !this.commandCatalogReady) {
      this.commandNotice ??= 'Command catalog is unavailable'
      this.scheduler.invalidate('immediate')
      return
    }
    const localInput = this.hasOfficialSessionsCommand()
      ? undefined
      : localSessionsInput(text)
    if (localInput !== undefined) {
      if (localInput.trim() !== '') {
        this.commandNotice = 'Local /sessions does not accept input'
        this.scheduler.invalidate('immediate')
      } else {
        this.openLocalSessionPicker()
      }
      return
    }
    const localModel = this.hasOfficialModelCommand()
      ? undefined
      : localModelInput(text)
    if (localModel !== undefined) {
      if (localModel.trim() !== '') {
        this.commandNotice = 'Local /model does not accept input'
        this.scheduler.invalidate('immediate')
      } else {
        this.openLocalModelPicker()
      }
      return
    }
    const localConnect = this.options.providers === undefined || this.hasOfficialConnectCommand()
      ? undefined
      : localConnectInput(text)
    if (localConnect !== undefined) {
      if (localConnect.trim() !== '') {
        this.commandNotice = 'Local /connect does not accept input'
        this.scheduler.invalidate('immediate')
      } else {
        this.openLocalProviderConnect()
      }
      return
    }
    const localContext = this.session.contextSnapshot === undefined || this.hasOfficialContextCommand()
      ? undefined
      : localContextInput(text)
    if (localContext !== undefined) {
      if (localContext.trim() !== '') {
        this.commandNotice = 'Local /context does not accept input'
        this.scheduler.invalidate('immediate')
      } else {
        this.openLocalContextPanel()
      }
      return
    }
    let parsed
    try {
      parsed = this.session.parseCommand(text)
    } catch (error: unknown) {
      this.commandNotice = `Command routing failed: ${commandMessageOf(error)}`
      this.scheduler.invalidate('immediate')
      return
    }
    const decision = decideCommandDispatch(parsed, this.commands)
    if (decision.kind === 'complete') {
      this.completeCommand(decision.command)
      return
    }
    if (decision.kind === 'execute') {
      this.executeCommandLine(text)
      return
    }
    this.submitRuntimePrompt(text, status)
  }

  private completeCommand(command: DshCommandDescriptor): void {
    this.prompt = createPromptEditorState(commandCompletion(command))
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    this.scheduler.invalidate('immediate')
  }

  private completeMenuCandidate(candidate: CommandMenuCandidate): void {
    if (candidate.origin === 'local') {
      this.prompt = createPromptEditorState(`/${candidate.command.name}`)
      this.commandMenu = createCommandMenuState()
      this.commandNotice = undefined
      this.scheduler.invalidate('immediate')
      return
    }
    this.completeCommand(candidate.command)
  }

  private submitRuntimePrompt(text: string, status: AgentStatus): void {
    const binding = this.currentBinding
    const delivery = status === 'running' ? 'steer' : 'followup'
    binding.followRequest = ++this.nextFollowRequest
    this.prompt = createPromptEditorState()
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    this.scheduler.invalidate('immediate')

    const task = Promise.resolve()
      .then(() => binding.port.submit({ text }, delivery))
      .then(
        () => undefined,
        (error: unknown) => {
          if (binding.prompt.text === '') binding.prompt = createPromptEditorState(text)
          this.fail(error)
        },
      )
      .finally(() => {
        binding.submitTask = undefined
      })
    binding.submitTask = task
  }

  private sessionReasoningExpanded(sessionId: string): boolean {
    if (!this.reasoningBySession.has(sessionId)) return false
    this.reasoningBySession.delete(sessionId)
    this.reasoningBySession.set(sessionId, true)
    return true
  }

  private toggleSessionReasoning(sessionId: string): void {
    if (this.reasoningBySession.has(sessionId)) {
      this.reasoningBySession.delete(sessionId)
      return
    }
    this.reasoningBySession.set(sessionId, true)
    while (this.reasoningBySession.size > SESSION_REASONING_STATE_LIMIT) {
      const oldest = this.reasoningBySession.keys().next().value as string | undefined
      /* v8 ignore next -- Map size is positive inside the bounded loop. */
      if (oldest === undefined) break
      this.reasoningBySession.delete(oldest)
    }
  }

  private executeCommandLine(line: string): void {
    if (this.commandTask !== undefined) {
      this.commandNotice = 'A command is already running'
      this.scheduler.invalidate('immediate')
      return
    }
    if (this.agentStatus() === 'disposed') {
      this.beginGraceful('runtime-disposed')
      return
    }

    const binding = this.currentBinding
    const abort = new AbortController()
    binding.commandAbort = abort
    this.prompt = createPromptEditorState()
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    this.scheduler.invalidate('immediate')

    const task = Promise.resolve()
      .then(() => binding.port.executeCommand(line, abort.signal))
      .then(
        (execution) => {
          if (execution !== undefined) return
          this.refreshCommands(binding)
          if (this.phase === 'running' && binding.prompt.text === '') {
            binding.prompt = createPromptEditorState(line)
          }
          binding.commandNotice = `Command was not admitted: ${line}`
        },
        (error: unknown) => {
          binding.commandNotice = `Command failed: ${commandMessageOf(error)}`
        },
      )
      .finally(() => {
        binding.commandTask = undefined
        binding.commandAbort = undefined
        this.scheduler.invalidate('immediate')
      })
    binding.commandTask = task
  }

  private agentStatus(binding = this.currentBinding): AgentStatus {
    return this.activeSession(binding)?.agentStatus ?? 'idle'
  }

  private beginGraceful(reason: DshTuiExitReason): void {
    if (this.phase === 'stopped') return
    if (!this.hasFatalError) this.requestedReason = reason
    this.phase = 'stopping'
    void this.observeShutdown(this.shutdown.graceful())
  }

  private forceShutdown(): void {
    if (this.phase === 'stopped') return
    this.phase = 'stopping'
    try {
      this.quiesce()
    } catch (error: unknown) {
      this.recordFatal(error)
    }
    void this.observeShutdown(this.shutdown.force())
  }

  private fail(error: unknown): void {
    if (this.phase === 'stopped') return
    this.recordFatal(error)
    this.beginGraceful(this.requestedReason)
  }

  private recordFatal(error: unknown): void {
    if (this.hasFatalError) return
    this.hasFatalError = true
    this.fatalError = error
  }

  private guardCallback(callback: () => void): void {
    try {
      callback()
    } catch (error: unknown) {
      this.fail(error)
    }
  }

  private quiesce(): void {
    if (!this.quiesced) {
      this.quiesced = true
      const errors: unknown[] = []
      this.switchAttempt?.abort.abort('DSH-TUI is shutting down')
      try {
        this.options.terminal.stopAcceptingInput()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        this.providerConnect?.quiesce()
      } catch (error: unknown) {
        errors.push(error)
      }
      for (const binding of this.bindings) {
        const stopCommands = binding.commandSubscription
        const stopModels = binding.modelSubscription
        const stopContext = binding.contextSubscription
        binding.commandSubscription = undefined
        binding.modelSubscription = undefined
        binding.contextSubscription = undefined
        try {
          stopCommands?.()
        } catch (error: unknown) {
          errors.push(error)
        }
        try {
          stopModels?.()
        } catch (error: unknown) {
          errors.push(error)
        }
        try {
          stopContext?.()
        } catch (error: unknown) {
          errors.push(error)
        }
        binding.commandAbort?.abort('DSH-TUI is shutting down')
        binding.modelRefreshAbort?.abort('DSH-TUI is shutting down')
        binding.modelSelectGeneration += 1
        binding.modelSelectAbort?.abort('DSH-TUI is shutting down')
        binding.abort.abort('DSH-TUI is shutting down')
      }
      this.dismissSessionPicker()
      this.dismissModelPicker()
      this.scheduler.close()
      this.abort.abort()
      this.ui = setUiPhase(this.ui, 'stopping')
      this.quiesceError = errors.length === 0
        ? undefined
        : errors.length === 1
          ? errors[0]
          : new AggregateError(errors, 'DSH-TUI input quiesce failed')
    }
    if (this.quiesceError !== undefined) throw this.quiesceError
  }

  private settleInteractions(): void {
    const errors: unknown[] = []
    for (const binding of this.bindings) {
      try {
        binding.port.disposeInteractions()
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'DSH-TUI interaction settlement failed')
    }
  }

  private async cancelForShutdown(): Promise<void> {
    await this.switchAttempt?.task
    await Promise.all([...this.inspectionTasks])
    const pending = [...this.bindings].flatMap(binding => [
      binding.submitTask,
      binding.commandTask,
      binding.modelRefreshTask,
      binding.modelSelectTask,
    ]).filter((task): task is Promise<void> => task !== undefined)
    await Promise.all(pending)
    await this.providerConnect?.waitForIdle()
    await this.catalogTask
    const switchCleanupError = this.switchCleanupError
    this.switchCleanupError = undefined
    const errors: unknown[] = switchCleanupError === undefined
      ? []
      : [new Error(
          `session switch cleanup failed: ${cleanupMessageOf(switchCleanupError)}`,
          { cause: switchCleanupError },
        )]
    const binding = this.currentBinding
    if (
      binding.port.ownsAgentLifecycle
      && (!binding.runtimeStatusObserved || this.agentStatus(binding) === 'running')
    ) {
      try {
        binding.port.cancel(this.hasFatalError
          ? { kind: 'hook', reason: 'DSH-TUI controller failure' }
          : { kind: 'user' })
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'DSH-TUI shutdown cancellation failed')
    }
  }

  private async waitForAgent(): Promise<void> {
    const binding = this.currentBinding
    if (!binding.port.ownsAgentLifecycle || this.agentStatus(binding) === 'disposed') return
    await binding.port.whenIdle()
  }

  private async flushSession(): Promise<void> {
    const binding = this.currentBinding
    if (!binding.port.ownsAgentLifecycle || this.agentStatus(binding) === 'disposed') return
    await binding.port.flush()
  }

  private async disposeAndJoinPumps(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.bindings].map(binding => this.closeBinding(binding)),
    )
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'DSH-TUI binding release failed')
    }
  }

  private async observeShutdown(promise: Promise<ShutdownResult>): Promise<void> {
    try {
      this.finish(await promise)
    } catch (error: unknown) {
      this.recordFatal(error)
      this.finish({
        mode: 'forced',
        issues: [{ phase: 'force-exit', error }],
      })
    }
  }

  private finish(shutdown: ShutdownResult): void {
    if (this.completedResult !== undefined) return
    this.phase = 'stopped'
    this.reasoningBySession.clear()
    this.ui = setUiPhase(this.ui, 'stopped')
    const issueError = shutdown.issues.length === 0
      ? undefined
      : new AggregateError(
          shutdown.issues.map(issue => issue.error),
          'DSH-TUI shutdown completed with cleanup issues',
        )
    const result: DshTuiControllerResult = shutdown.mode === 'forced'
      ? {
          ok: false,
          reason: 'forced',
          ...(this.hasFatalError
            ? { error: this.fatalError }
            : issueError === undefined ? {} : { error: issueError }),
          shutdown,
        }
      : this.hasFatalError || issueError !== undefined
        ? {
            ok: false,
            reason: 'fatal',
            error: this.hasFatalError ? this.fatalError : issueError,
            shutdown,
          }
        : {
            ok: true,
            reason: this.requestedReason,
            shutdown,
          }
    this.completedResult = result
    this.resolveCompletion(result)
  }
}
