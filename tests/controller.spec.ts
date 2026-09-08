import { describe, expect, it, vi } from 'vitest'
import {
  DshTuiController,
  type DshTuiApplicationPort,
} from '../src/app/controller.ts'
import type { DshTuiFeatureHostPort } from '../src/app/feature-host.ts'
import * as systemClipboard from '../src/terminal/clipboard.ts'
import type { FeatureSessionRuntimePort } from '../src/app/feature-session-runtime.ts'
import { createNavigationState, transitionNavigation } from '../src/navigation/state.ts'
import { createSlotRegistry } from '../src/layout/slots.ts'
import { resolveLayout, type LayoutRegion } from '../src/layout/strategy.ts'
import type { CommandMenuCandidate } from '../src/command/menu.ts'
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
  SubmitOptions,
  SubmitResult,
} from '../src/runtime/port.ts'
import { DshSubmitRejectedError } from '../src/runtime/port.ts'
import type {
  ClipboardPort,
  PromptImageBytes,
  PromptImageInput,
  SessionAttachmentPort,
  SessionAttachmentSnapshot,
} from '../src/attachment/port.ts'
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
import type { SessionToolsSnapshot } from '../src/tool/port.ts'
import type {
  SessionPermissionSelectOptions,
  SessionPermissionSnapshot,
} from '../src/permission/port.ts'
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
  SettingsCatalogPort,
  SettingsCatalogSnapshot,
  SettingsMutationRequest,
} from '../src/settings/port.ts'
import type {
  PluginInventoryPort,
  PluginInventorySnapshot,
} from '../src/plugin-inventory/port.ts'
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
import type {
  SessionForkPort,
  SessionForkRequest,
} from '../src/session/fork-port.ts'
import { createSessionBinding, type SessionBinding } from '../src/session/binding.ts'
import type {
  TerminalDriver,
  TerminalDriverCallbacks,
  TerminalDriverState,
} from '../src/terminal/driver.ts'
import type { TerminalInputAction } from '../src/terminal/input.ts'
import type { TerminalViewport, UiFrame } from '../src/ui/frame.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import { SessionNavigationHost } from '../src/app/session-navigation-host.ts'
import type { PreferenceSource } from '../src/preferences/application.ts'
import { DSH_TUI_PREFERENCES_SCHEMA } from '../src/dsh/preferences-settings.ts'
import { DEFAULT_DSH_TUI_PREFERENCES } from '../src/preferences/contracts.ts'
import { SETTINGS_FEATURE_ID, SETTINGS_ROUTE_ID } from '../src/features/settings/factory.ts'
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

class FakeSession implements DshRuntimePort, DshInteractionPort, DshCommandPort, SessionModePort, SessionAttachmentPort {
  readonly eventsSource = new AsyncSource<DshTuiEvent>()
  readonly interactionsSource = new AsyncSource<InteractionSnapshot>()
  readonly submitted: { readonly input: SubmitInput; readonly delivery: Delivery }[] = []
  readonly submitSignals: (AbortSignal | undefined)[] = []
  readonly cancellations: CancelCause[] = []
  readonly responses: InteractionResponse[] = []
  readonly commandExecutions: {
    readonly line: string
    readonly signal: AbortSignal
    readonly images?: readonly PromptImageInput[]
  }[] = []
  readonly preparedImagePaths: string[] = []
  readonly preparedImageSignals: (AbortSignal | undefined)[] = []
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
  readonly toolsListeners = new Set<() => void>()
  readonly permissionListeners = new Set<() => void>()
  readonly permissionSelections: {
    readonly value: string
    readonly options: SessionPermissionSelectOptions | undefined
  }[] = []
  commands: readonly DshCommandDescriptor[] = []
  commandExecution: DshCommandExecution | undefined = {
    commandId: 'command-1',
    result: { kind: 'success' },
  }
  executeCommandOverride: (
    line: string,
    signal: AbortSignal,
    images?: readonly PromptImageInput[],
  ) => Promise<DshCommandExecution | undefined> | undefined = () => undefined
  attachmentState: SessionAttachmentSnapshot = { available: false }
  prepareImageOverride: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<PromptImageInput> = async path => ({
    name: path.split(/[\\/]/u).at(-1) ?? path,
    mediaType: 'image/png',
    bytes: 4,
    data: new Uint8Array([1, 2, 3, 4]),
  })
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
  throwOnToolsSubscribe: unknown
  throwOnToolsUnsubscribe: unknown
  throwOnPermissionsSubscribe: unknown
  throwOnPermissionsUnsubscribe: unknown
  onCommandSubscribe: (() => void) | undefined
  eventsOverride: EventFactory | undefined
  interactionsOverride: InteractionFactory | undefined
  replayStatus: 'idle' | 'running' | 'disposed' = 'idle'
  caughtUpGate: Promise<void> | undefined
  caughtUpCount = 0
  responseReceipt: InteractionReceipt = { accepted: true }
  submitGate: Promise<void> | undefined
  submitIgnoresAbort = false
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
  toolsUnsubscribeCount = 0
  permissionsUnsubscribeCount = 0
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
  modelSnapshotCount = 0
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
  toolsState: SessionToolsSnapshot = {
    available: false,
    stale: false,
    generation: 0,
    tools: [],
  }
  permissionState: SessionPermissionSnapshot = {
    available: false,
    writable: false,
    stale: false,
    generation: 0,
    selecting: false,
    options: [],
  }
  selectPermissionOverride: (
    value: string,
    options?: SessionPermissionSelectOptions,
  ) => Promise<void> = async value => {
    const permission = this.permissionState.options.find(option => option.value === value)?.permission
    this.permissionState = {
      ...this.permissionState,
      generation: this.permissionState.generation + 1,
      currentValue: value,
      ...(permission === undefined ? {} : { currentPermission: permission }),
    }
    for (const listener of [...this.permissionListeners]) listener()
  }

  async submit(
    input: SubmitInput,
    delivery: Delivery,
    options?: SubmitOptions,
  ): Promise<SubmitResult> {
    this.submitted.push({ input, delivery })
    this.submitSignals.push(options?.signal)
    await this.submitGate
    if (!this.submitIgnoresAbort) options?.signal?.throwIfAborted()
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
    images?: readonly PromptImageInput[],
  ): Promise<DshCommandExecution | undefined> {
    this.commandExecutions.push({
      line,
      signal,
      ...(images === undefined ? {} : { images }),
    })
    const overridden = this.executeCommandOverride(line, signal, images)
    return overridden ?? this.commandExecution
  }

  attachmentSnapshot(): SessionAttachmentSnapshot {
    return this.attachmentState
  }

  prepareImage(path: string, signal?: AbortSignal): Promise<PromptImageInput> {
    this.preparedImagePaths.push(path)
    this.preparedImageSignals.push(signal)
    return this.prepareImageOverride(path, signal)
  }

  prepareImageBytes(input: PromptImageBytes, signal?: AbortSignal): Promise<PromptImageInput> {
    this.preparedImageSignals.push(signal)
    return Promise.resolve({ ...input, bytes: input.data.byteLength })
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

  toolsSnapshot(): SessionToolsSnapshot {
    return structuredClone(this.toolsState)
  }

  onToolsChanged(listener: () => void): () => void {
    if (this.throwOnToolsSubscribe !== undefined) throw this.throwOnToolsSubscribe
    this.toolsListeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.toolsUnsubscribeCount += 1
      this.toolsListeners.delete(listener)
      if (this.throwOnToolsUnsubscribe !== undefined) throw this.throwOnToolsUnsubscribe
    }
  }

  changeTools(snapshot: SessionToolsSnapshot): void {
    this.toolsState = snapshot
    for (const listener of [...this.toolsListeners]) listener()
  }

  disposeTools(): void {
    this.toolsListeners.clear()
  }

  permissionSnapshot(): SessionPermissionSnapshot {
    return structuredClone(this.permissionState)
  }

  selectPermission(
    value: string,
    options?: SessionPermissionSelectOptions,
  ): Promise<void> {
    this.permissionSelections.push({ value, options })
    return this.selectPermissionOverride(value, options)
  }

  onPermissionsChanged(listener: () => void): () => void {
    if (this.throwOnPermissionsSubscribe !== undefined) {
      throw this.throwOnPermissionsSubscribe
    }
    this.permissionListeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.permissionsUnsubscribeCount += 1
      this.permissionListeners.delete(listener)
      if (this.throwOnPermissionsUnsubscribe !== undefined) {
        throw this.throwOnPermissionsUnsubscribe
      }
    }
  }

  changePermissions(snapshot: SessionPermissionSnapshot): void {
    this.permissionState = snapshot
    for (const listener of [...this.permissionListeners]) listener()
  }

  disposePermissions(): void {
    this.permissionListeners.clear()
  }

  modelSnapshot(): SessionModelSnapshot {
    this.modelSnapshotCount += 1
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
    this.disposeTools()
    this.disposePermissions()
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
  deferConversationFlatFallback = false

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

class FakeFeatureSession implements FeatureSessionRuntimePort {
  activateOverride: FeatureSessionRuntimePort['activate'] = async () => 'active'
  readonly activate = vi.fn((
    source: Parameters<FeatureSessionRuntimePort['activate']>[0],
    viewport: Parameters<FeatureSessionRuntimePort['activate']>[1],
  ) => this.activateOverride(source, viewport))
  readonly resize = vi.fn(async (
    _viewport: Parameters<FeatureSessionRuntimePort['resize']>[0],
  ) => {})
  readonly themeChanged = vi.fn(async () => {})
  readonly snapshot = vi.fn<FeatureSessionRuntimePort['snapshot']>(() => undefined)
  readonly onChanged = vi.fn((
    _listener: Parameters<FeatureSessionRuntimePort['onChanged']>[0],
  ) => () => {})
  readonly deactivate = vi.fn(async () => {})
  readonly dispose = vi.fn(async () => {})
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
  return { type: 'interaction/snapshot', sessionId, pending: pending.map(item => (
    item.kind !== 'approval' || item.evidence !== undefined ? item : {
      ...item,
      evidence: {
        source: 'tool/call', arguments: '{"command":"Get-Location"}', cwd: 'D:/workspace',
        currentPermission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
        requestedPermission: { kind: 'tool-call' }, missing: [],
      },
    }
  )) }
}

class FakeFork implements SessionForkPort {
  readonly requests: SessionForkRequest[] = []
  forkOverride: (
    request: SessionForkRequest,
  ) => Promise<ActivatedSessionLease> = async request => {
    throw new Error(`no fake fork for ${request.sourceSessionId}`)
  }

  forkSession(request: SessionForkRequest): Promise<ActivatedSessionLease> {
    this.requests.push(request)
    return this.forkOverride(request)
  }
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

class FakeSettings implements SettingsCatalogPort {
  readonly listeners = new Set<() => void>()
  readonly mutations: SettingsMutationRequest[] = []
  unsubscribeCount = 0
  throwOnUnsubscribe: unknown
  snapshot: SettingsCatalogSnapshot = {
    available: true,
    writable: true,
    documentBacked: true,
    generation: 3,
    namespaces: [{
      namespace: 'agent-loop',
      schema: {},
      value: { maxSteps: 30, policy: 'balanced' },
      base: { maxSteps: 20 },
      user: { policy: 'balanced' },
      revision: 7,
      applies: 'live',
      secrets: [{ path: ['apiKey'], set: true }],
    }],
  }
  mutateOverride: (request: SettingsMutationRequest) => Promise<void> = async () => {}

  settingsSnapshot(): SettingsCatalogSnapshot {
    return structuredClone(this.snapshot)
  }

  onSettingsChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.unsubscribeCount += 1
      this.listeners.delete(listener)
      if (this.throwOnUnsubscribe !== undefined) throw this.throwOnUnsubscribe
    }
  }

  async mutateSettings(request: SettingsMutationRequest): Promise<void> {
    this.mutations.push(structuredClone(request))
    await this.mutateOverride(request)
  }

  change(snapshot: SettingsCatalogSnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener()
  }
}

class FakePluginInventory implements PluginInventoryPort {
  snapshot: PluginInventorySnapshot = {
    available: true,
    entries: [
      {
        entryId: 'settings',
        moduleName: '@deepseek-ai/dsh-settings-file',
        enabled: true,
        fiberPhase: 'active',
      },
      {
        entryId: 'web',
        moduleName: '@deepseek-ai/dsh-web',
        enabled: false,
        fiberPhase: 'failed',
      },
    ],
  }
  reads = 0

  pluginInventorySnapshot(): PluginInventorySnapshot {
    this.reads += 1
    return structuredClone(this.snapshot)
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

function selectableToolsSnapshot(
  overrides: Partial<SessionToolsSnapshot> = {},
): SessionToolsSnapshot {
  return {
    available: true,
    stale: false,
    generation: 1,
    tools: [
      {
        name: 'read_file',
        description: 'Read one file',
        group: 'core',
        parameterNames: ['path'],
        requiredParameterNames: ['path'],
      },
      {
        name: 'mcp__github__create_issue',
        description: 'Create an issue',
        group: 'mcp',
        parameterNames: ['owner', 'title'],
        requiredParameterNames: ['owner'],
      },
      {
        name: 'run_code',
        description: 'Programmatic tool transport',
        group: 'transport',
        parameterNames: ['code'],
        requiredParameterNames: ['code'],
      },
    ],
    ...overrides,
  }
}

function selectablePermissionSnapshot(
  overrides: Partial<SessionPermissionSnapshot> = {},
): SessionPermissionSnapshot {
  return {
    available: true,
    writable: true,
    stale: false,
    generation: 1,
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

function createProduct(options: {
  readonly clipboard?: ClipboardPort
  readonly session?: FakeSession
  readonly activation?: FakeActivation
  readonly inspection?: FakeInspection
  readonly fork?: FakeFork
  readonly catalog?: FakeCatalog
  readonly providers?: FakeProviders
  readonly settings?: FakeSettings
  readonly pluginInventory?: FakePluginInventory
  readonly terminal?: FakeTerminal
  readonly application?: FakeApplication
  readonly toolCards?: ToolCardRendererRegistry
  readonly features?: DshTuiFeatureHostPort
  readonly featureSession?: FeatureSessionRuntimePort
  readonly sessionNavigation?: SessionNavigationHost
  readonly preferences?: PreferenceSource
  readonly sessionRelease?: () => Promise<void>
  readonly terminalStartMode?: 'start' | 'adopt-running'
} = {}): {
  readonly controller: DshTuiController
  readonly session: FakeSession
  readonly catalog: FakeCatalog
  readonly fork: FakeFork | undefined
  readonly providers: FakeProviders | undefined
  readonly settings: FakeSettings | undefined
  readonly pluginInventory: FakePluginInventory | undefined
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
    ...(options.clipboard === undefined ? {} : { clipboard: options.clipboard }),
    ...(options.sessionRelease === undefined ? {} : { sessionRelease: options.sessionRelease }),
    ...(options.activation === undefined ? {} : { activation: options.activation }),
    ...(options.inspection === undefined ? {} : { inspection: options.inspection }),
    ...(options.fork === undefined ? {} : { fork: options.fork }),
    catalog,
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.pluginInventory === undefined
      ? {}
      : { pluginInventory: options.pluginInventory }),
    terminal,
    application,
    ...(options.toolCards === undefined ? {} : { toolCards: options.toolCards }),
    ...(options.features === undefined ? {} : { features: options.features }),
    ...(options.featureSession === undefined
      ? {}
      : { featureSession: options.featureSession }),
    ...(options.sessionNavigation === undefined ? {} : { sessionNavigation: options.sessionNavigation }),
    ...(options.preferences === undefined ? {} : { preferences: options.preferences }),
    ...(options.terminalStartMode === undefined
      ? {}
      : { terminalStartMode: options.terminalStartMode }),
    frameIntervalMs: 1,
  })
  return {
    controller,
    session,
    catalog,
    fork: options.fork,
    providers: options.providers,
    settings: options.settings,
    pluginInventory: options.pluginInventory,
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

function workspaceOpen(frame: UiFrame | undefined, title: string): boolean {
  return frame?.overlay === undefined && (frame?.lines[0]?.includes(`${title}`) === true || (title === 'Settings' && frame?.lines[0]?.includes('设置') === true))
}

function secondarySurfaceOpen(frame: UiFrame | undefined): boolean {
  return frame?.overlay !== undefined || frame?.styleSpans?.[0]?.[0]?.style.backgroundRole === 'panelBackground'
}

function expectWorkspace(frame: UiFrame, title: string): void {
  expect(workspaceOpen(frame, title)).toBe(true)
  expect(frame.lines).toHaveLength(frame.viewport.rows)
  expect(frame.lines.at(-1)).toContain('Esc back')
  expect(frame.styleSpans?.[0]?.[0]?.style).toMatchObject({ backgroundRole: 'panelBackground', fill: true })
}

describe('DshTuiController repair glue', () => {
  it('shows approval details and session scope, blocks uninspectable grants and clears remembered approval scopes', async () => {
    const session = new FakeSession()
    const permissions = selectablePermissionSnapshot()
    session.permissionState = { ...permissions, options: permissions.options.map((option, index) => index === 0
      ? { ...option, description: 'word '.repeat(70) + 'END_METADATA' } : option) }
    const clearSessionApprovals = vi.fn().mockReturnValueOnce(1).mockReturnValue(0)
    Object.assign(session, { clearSessionApprovals })
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 120, rows: 30 })
    session.interactionsSource.push(snapshot([{ id: 'approval:remember-ui', kind: 'approval', sessionId: session.sessionId,
      approvalId: 'remember-ui-audit', toolName: 'pwsh', callId: 'remember-ui-call', allowSession: true,
      reason: 'Requested operation explanation. '.repeat(8),
    }]))
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    await waitFor(() => binding.interactionEditor.active?.kind === 'approval')
    terminal.input({ type: 'toggle-transcript-details' })
    expect(binding.interactionEditor.active).toMatchObject({ detailsExpanded: true })
    terminal.input({ type: 'page-down' })
    terminal.input({ type: 'page-up' })
    terminal.input({ type: 'toggle-transcript-details' })
    expect(binding.interactionEditor.active).toMatchObject({ detailsExpanded: false, scrollOffset: 0 })
    terminal.input({ type: 'insert', text: '3' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('All pwsh calls') === true)
    terminal.resize({ columns: 60, rows: 4 })
    terminal.input({ type: 'submit' })
    expect(session.responses).toHaveLength(0)
    expect(binding.interactionEditor.active).toMatchObject({ selectedIndex: 1 })
    terminal.input({ type: 'insert', text: '1' })
    terminal.input({ type: 'submit' })
    expect(session.responses).toHaveLength(0)
    expect(binding.interactionEditor.active).toMatchObject({ selectedIndex: 1 })
    terminal.resize({ columns: 120, rows: 30 })
    expect(binding.interactionEditor.active).toMatchObject({ selectedIndex: 1 })
    terminal.input({ type: 'insert', text: '3' })
    terminal.input({ type: 'submit' })
    expect(session.responses.at(-1)).toMatchObject({ outcome: 'allowed-session' })
    session.interactionsSource.push({ ...snapshot(), rememberedApprovalCount: 1 })
    await waitFor(() => binding.interactionEditor.active === undefined)
    terminal.input({ type: 'insert', text: '/permission' })
    terminal.input({ type: 'submit' })
    await waitFor(() => binding.permissionPicker.open)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 remembered approval scopes') === true)
    terminal.resize({ columns: 80, rows: 8 })
    terminal.input({ type: 'complete' })
    terminal.input({ type: 'page-down' })
    terminal.input({ type: 'page-down' })
    await waitFor(() => terminal.frames.at(-1)?.viewport.columns === 80 && terminal.frames.at(-1)?.lines.join('\n').includes('END_METADATA') === true)
    terminal.resize({ columns: 120, rows: 30 })
    terminal.input({ type: 'insert', text: 'r' })
    expect(clearSessionApprovals).toHaveBeenCalledTimes(1)
    expect(binding.commandNotice).toContain('Remembered approvals cleared')
    terminal.input({ type: 'insert', text: 'r' })
    expect(binding.commandNotice).toContain('No remembered')
    Object.assign(session, { clearSessionApprovals: undefined })
    terminal.input({ type: 'insert', text: 'r' })
    expect(clearSessionApprovals).toHaveBeenCalledTimes(2)
    terminal.input({ type: 'escape' })
    await controller.requestExit('user')
  })

  it('routes no-input model and mode aliases to canonical Features before official commands', async () => {
    const openRoute = vi.fn(async (_route: string) => {})
    const features = {
      navigation: { value: 'chat', route: { kind: 'chat' }, mode: 'insert', focus: { kind: 'composer' }, overlays: [] },
      start: async () => {}, openRoute, onChanged: () => () => {},
      snapshot: () => ({ availableRoutes: [{ id: 'models', featureId: 'models' }, { id: 'modes', featureId: 'modes' }] }),
      dispatchTerminalAction: () => ({ handled: false, completion: Promise.resolve() }),
    } as unknown as DshTuiFeatureHostPort
    const session = new FakeSession()
    session.commands = [
      { name: 'model', description: 'model', input: { hint: '<model>' } },
      { name: 'mode', description: 'mode', input: { hint: '<mode>' } },
    ]
    const { controller, terminal } = createProduct({ session, features })
    await controller.start()
    const candidates = (controller as unknown as { commandCandidates(): readonly CommandMenuCandidate[] }).commandCandidates()
    expect(candidates.filter(candidate => ['model', 'models'].includes(candidate.command.name)).map(candidate => candidate.command.name)).toEqual(['models'])
    expect(candidates.filter(candidate => ['mode', 'modes'].includes(candidate.command.name)).map(candidate => candidate.command.name)).toEqual(['modes'])
    for (const alias of ['model', 'mode']) {
      terminal.input({ type: 'insert', text: `/${alias}` })
      terminal.input({ type: 'submit' })
      await waitFor(() => openRoute.mock.calls.some(([route]) => route === `${alias}s`))
    }
    expect(session.commandExecutions).toEqual([])
    terminal.input({ type: 'insert', text: '/model vision' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.some(call => call.line === '/model vision'))
    await controller.requestExit('user')
  })

  it('returns from a searched Runtime Library in one Esc and preserves the composer draft', async () => {
    const { controller, terminal } = createProduct({ settings: new FakeSettings() })
    await controller.start()
    terminal.input({ type: 'insert', text: 'draft remains' })
    const internals = controller as unknown as {
      openRuntimeLibrary(): void
      runtimeLibrary: { open: boolean }
      currentBinding: SessionBinding
    }
    internals.openRuntimeLibrary()
    terminal.input({ type: 'insert', text: 'agent' })
    terminal.input({ type: 'escape' })
    expect(internals.runtimeLibrary.open).toBe(false)
    expect(internals.currentBinding.prompt.text).toBe('draft remains')
    await controller.requestExit('user')
  })

  it('preserves a draft when opening and escaping the legacy Sessions directory', async () => {
    const { controller, terminal } = createProduct()
    await controller.start()
    terminal.input({ type: 'insert', text: 'session draft' })
    const seam = controller as unknown as { openLocalSessionPicker(): void; currentBinding: SessionBinding }
    seam.openLocalSessionPicker()
    terminal.input({ type: 'insert', text: 'search' })
    terminal.input({ type: 'escape' })
    expect(seam.currentBinding.prompt.text).toBe('session draft')
    await controller.requestExit('user')
  })

  it.each(['model', 'mode'] as const)('falls back to the legacy %s picker if the Feature is unavailable', async alias => {
    const features = {
      navigation: { value: 'chat', route: { kind: 'chat' }, mode: 'insert', focus: { kind: 'composer' }, overlays: [] },
      start: async () => {}, openRoute: async () => { throw new Error('Feature unavailable') }, onChanged: () => () => {},
      snapshot: () => ({ availableRoutes: [{ id: `${alias}s`, featureId: `${alias}s` }] }),
      dispatchTerminalAction: () => ({ handled: false, completion: Promise.resolve() }),
    } as unknown as DshTuiFeatureHostPort
    const { controller, terminal, session } = createProduct({ features })
    session.modeState = selectableModeSnapshot()
    await controller.start()
    terminal.input({ type: 'insert', text: `/${alias}` })
    terminal.input({ type: 'submit' })
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    await waitFor(() => binding[alias === 'model' ? 'modelPicker' : 'modePicker'].open)
    terminal.input({ type: 'escape' })
    await controller.requestExit('user')
  })

  it.each([
    ['skills', 'skillPicker'], ['tools', 'toolBrowser'], ['mcp', 'mcpBrowser'],
    ['permission', 'permissionPicker'],
  ] as const)('keeps %s navigation safe when its detail viewport shrinks to one row', async (command, key) => {
    const session = new FakeSession()
    session.skillsState = selectableSkillsSnapshot()
    session.toolsState = selectableToolsSnapshot()
    session.permissionState = selectablePermissionSnapshot()
    session.modelState = selectableModelSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 120, rows: 24 })
    terminal.input({ type: 'insert', text: `/${command}` })
    terminal.input({ type: 'submit' })
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    await waitFor(() => binding[key].open)
    terminal.input({ type: 'page-down' })
    terminal.input({ type: 'insert', text: 'l' })
    expect(binding[key].navigation?.focus).toBe('details')
    terminal.input({ type: 'page-down' })
    terminal.resize({ columns: 40, rows: 1 })
    terminal.input({ type: 'page-down' })
    terminal.input({ type: 'page-up' })
    expect(binding[key].navigation).toMatchObject({ focus: 'details', detailOffset: 0 })
    terminal.input({ type: 'insert', text: 'h' })
    expect(binding[key].navigation?.focus).toBe('list')
    if (command === 'tools' || command === 'mcp') terminal.input({ type: 'submit' })
    terminal.input({ type: 'escape' })
    expect(binding[key].open).toBe(false)
    expect(session.submitted).toEqual([])
    expect(session.commandExecutions).toEqual([])
    expect(session.permissionSelections).toEqual([])
    expect(session.modelSelections).toEqual([])
    await controller.requestExit('user')
  })

  it('pastes clipboard images beside the unchanged draft and inserts ordinary clipboard text', async () => {
    const read = vi.fn<ClipboardPort['read']>()
      .mockResolvedValueOnce({ kind: 'image', image: {
        name: 'clipboard.png', mediaType: 'image/png', data: new Uint8Array([1, 2]),
      } })
      .mockResolvedValueOnce({ kind: 'text', text: ' copied' })
    const { controller, session, terminal } = createProduct({ clipboard: { read } })
    session.attachmentState = { available: true, maxImageBytes: 16, maxImagesPerMessage: 2 }
    await controller.start()
    terminal.input({ type: 'insert', text: 'draft' })
    terminal.input({ type: 'paste-image' })
    await waitFor(() => read.mock.calls.length === 1)
    await waitFor(() => controller.pendingAttachmentCount === 0)
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    expect(binding.prompt.text).toBe('draft')
    expect(binding.promptImages).toHaveLength(1)
    terminal.input({ type: 'paste-image' })
    await waitFor(() => read.mock.calls.length === 2 && controller.pendingAttachmentCount === 0)
    expect(binding.prompt.text).toBe('draft copied')
    await controller.requestExit('user')
  })

  it('routes parameterized permission commands through a default-cancel confirmation', async () => {
    const session = new FakeSession()
    session.commands = [{ name: 'permission', description: 'permission', input: { hint: '<preset>' } }]
    session.permissionState = selectablePermissionSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 120, rows: 24 })
    terminal.input({ type: 'insert', text: '/permission danger-full-access' })
    terminal.input({ type: 'submit' })
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    expect(binding.permissionPicker).toMatchObject({ open: true, selectedValue: 'danger-full-access' })
    expect(session.commandExecutions).toEqual([])
    terminal.input({ type: 'submit' })
    expect(binding.permissionPicker.confirmation?.selectedIndex).toBe(0)
    terminal.input({ type: 'move-right' })
    expect(binding.permissionPicker.confirmation?.selectedIndex).toBe(1)
    terminal.input({ type: 'move-left' })
    for (const action of [{ type: 'complete' }, { type: 'newline' }, { type: 'insert', text: 'y' }] as const) {
      terminal.input(action)
      expect(binding.permissionPicker.confirmation?.selectedIndex).toBe(0)
      expect(session.permissionSelections).toEqual([])
    }
    terminal.input({ type: 'submit' })
    expect(session.permissionSelections).toEqual([])
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.permissionSelections.length === 1)
    expect(session.permissionSelections[0]?.options?.confirmation).toEqual({
      fromValue: 'workspace-write', toValue: 'danger-full-access', generation: 1,
    })
    await controller.requestExit('user')
  })

  it('blocks unknown and missing-policy permission values without forwarding a generic command', async () => {
    const session = new FakeSession()
    session.permissionState = selectablePermissionSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.input({ type: 'insert', text: '/permission unknown' })
    terminal.input({ type: 'submit' })
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    expect(binding.commandNotice).toBe('Unknown permission preset: unknown')
    terminal.input({ type: 'escape' })
    session.permissionState = { ...session.permissionState, options: session.permissionState.options.map(({ permission: _policy, ...option }) => option) }
    terminal.input({ type: 'insert', text: '/permission danger-full-access' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'submit' })
    expect(binding.commandNotice).toContain('policy details are unavailable')
    expect(session.commandExecutions).toEqual([])
    expect(session.permissionSelections).toEqual([])
    await controller.requestExit('user')
  })

  it('preserves drafts for empty, non-image, unavailable and rejected clipboard images', async () => {
    const image = { name: 'clipboard.png', mediaType: 'image/png' as const, data: new Uint8Array([1, 2]) }
    const read = vi.fn<ClipboardPort['read']>()
    const { controller, session, terminal } = createProduct({ clipboard: { read } })
    await controller.start()
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    for (const [content, notice] of [
      [{ kind: 'empty' }, 'Clipboard is empty'],
      [{ kind: 'text', text: 'do not insert' }, 'does not contain an image'],
      [{ kind: 'image', image }, 'preparation is unavailable'],
    ] as const) {
      read.mockResolvedValueOnce(content)
      binding.prompt = createPromptEditorState('/paste-image')
      terminal.input({ type: 'submit' })
      await waitFor(() => controller.pendingAttachmentCount === 0)
      expect(binding.prompt.text).toBe('/paste-image')
      expect(binding.commandNotice).toContain(notice)
      expect(binding.promptImages).toEqual([])
    }
    session.attachmentState = { available: true }
    Object.defineProperty(session, 'prepareImageBytes', { configurable: true, value: undefined })
    read.mockResolvedValueOnce({ kind: 'image', image })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingAttachmentCount === 0)
    expect(binding.commandNotice).toContain('preparation is unavailable')
    Object.defineProperty(session, 'prepareImageBytes', { configurable: true, value: async () => { throw new Error('official image rejection') } })
    read.mockResolvedValueOnce({ kind: 'image', image })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingAttachmentCount === 0)
    expect(binding.commandNotice).toContain('official image rejection')
    expect(binding.prompt.text).toBe('/paste-image')
    binding.prompt = createPromptEditorState('/paste-image extra')
    terminal.input({ type: 'submit' })
    expect(binding.commandNotice).toBe('Local /paste-image does not accept input')
    expect(read).toHaveBeenCalledTimes(5)
    await controller.requestExit('user')
  })

  it('shares image count and aggregate limits and only consumes the successful paste command', async () => {
    const image = { name: 'clipboard.png', mediaType: 'image/png' as const, data: new Uint8Array([1, 2]) }
    const read = vi.fn<ClipboardPort['read']>().mockResolvedValue({ kind: 'image', image })
    const { controller, session, terminal } = createProduct({ clipboard: { read } })
    session.attachmentState = { available: true, maxImagesPerMessage: 1 }
    await controller.start()
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    binding.prompt = createPromptEditorState('/paste-image')
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingAttachmentCount === 0)
    expect(binding.prompt.text).toBe('')
    expect(binding.promptImages).toHaveLength(1)
    terminal.input({ type: 'paste-image' })
    await waitFor(() => controller.pendingAttachmentCount === 0)
    expect(binding.commandNotice).toContain('At most 1 images')
    session.attachmentState = { available: true, maxMessageImageBytes: 3 }
    terminal.input({ type: 'paste-image' })
    await waitFor(() => controller.pendingAttachmentCount === 0)
    expect(binding.commandNotice).toContain('aggregate image-byte limit')
    expect(binding.promptImages).toHaveLength(1)
    await controller.requestExit('user')
  })

  it('keeps a newer draft when the paste-image menu action finishes', async () => {
    const image = { name: 'clipboard.png', mediaType: 'image/png' as const, data: new Uint8Array([1]) }
    const reading = Promise.withResolvers<Awaited<ReturnType<ClipboardPort['read']>>>()
    const { controller, session, terminal } = createProduct({ clipboard: { read: () => reading.promise } })
    session.attachmentState = { available: true }
    session.permissionState = selectablePermissionSnapshot()
    await controller.start()
    const seam = controller as unknown as {
      currentBinding: SessionBinding
      openLocalCommand(name: string): void
      openLocalPermissionPicker(): void
    }
    seam.currentBinding.prompt = createPromptEditorState('/paste-image')
    seam.openLocalCommand('paste-image')
    seam.currentBinding.prompt = createPromptEditorState('newer draft')
    reading.resolve({ kind: 'image', image })
    await waitFor(() => controller.pendingAttachmentCount === 0)
    expect(seam.currentBinding.prompt.text).toBe('newer draft')
    seam.openLocalPermissionPicker()
    terminal.input({ type: 'escape' })
    expect(seam.currentBinding.prompt.text).toBe('newer draft')
    await controller.requestExit('user')
  })

  it('uses the default clipboard factory without touching the real clipboard', async () => {
    const read = vi.fn<ClipboardPort['read']>().mockResolvedValue({ kind: 'text', text: 'native seam' })
    const factory = vi.spyOn(systemClipboard, 'createSystemClipboardPort').mockReturnValue({ read })
    const { controller, terminal } = createProduct()
    try {
      await controller.start()
      terminal.input({ type: 'paste-image' })
      await waitFor(() => controller.pendingAttachmentCount === 0)
      expect(factory).toHaveBeenCalledOnce()
      expect((controller as unknown as { currentBinding: SessionBinding }).currentBinding.prompt.text).toBe('native seam')
      await controller.requestExit('user')
    } finally { factory.mockRestore() }
  })

  it('serializes clipboard reads and ignores late cancelled, stale or replaced ownership', async () => {
    const image = { name: 'clipboard.png', mediaType: 'image/png' as const, data: new Uint8Array([1, 2]) }
    const read = vi.fn<ClipboardPort['read']>()
    const { controller, session, terminal } = createProduct({ clipboard: { read } })
    session.attachmentState = { available: true }
    await controller.start()
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    binding.prompt = createPromptEditorState('retained')
    for (const scenario of ['cancel', 'epoch', 'reject', 'validate-cancel', 'validate-epoch', 'edited', 'replaced'] as const) {
      const reading = Promise.withResolvers<Awaited<ReturnType<ClipboardPort['read']>>>()
      const validating = Promise.withResolvers<PromptImageInput>()
      read.mockReturnValueOnce(reading.promise)
      const prepare = vi.spyOn(session, 'prepareImageBytes').mockReturnValue(validating.promise)
      terminal.input({ type: 'paste-image' })
      const task = binding.attachmentTask!
      terminal.input({ type: 'paste-image' })
      expect(binding.commandNotice).toBe('Wait for the image to finish loading')
      await waitFor(() => read.mock.results.at(-1)?.value === reading.promise)
      if (scenario === 'cancel' || scenario === 'reject') terminal.input({ type: 'interrupt' })
      if (scenario === 'epoch') (binding as unknown as { epoch: number }).epoch += 1
      if (scenario === 'reject') reading.reject(new Error('late cancelled rejection'))
      else reading.resolve({ kind: 'image', image })
      if (scenario.startsWith('validate') || scenario === 'edited' || scenario === 'replaced') {
        await waitFor(() => prepare.mock.calls.length === 1)
        if (scenario === 'validate-cancel') terminal.input({ type: 'interrupt' })
        if (scenario === 'validate-epoch') (binding as unknown as { epoch: number }).epoch += 1
        if (scenario === 'edited') terminal.input({ type: 'insert', text: ' newer' })
        if (scenario === 'replaced') {
          binding.attachmentTask = Promise.resolve()
          binding.attachmentAbort = new AbortController()
        }
        validating.resolve({ ...image, bytes: 2 })
      }
      await task
      if (scenario === 'replaced') {
        expect(binding.attachmentTask).toBeDefined()
        expect(binding.attachmentAbort?.signal.aborted).toBe(false)
        binding.attachmentTask = undefined
        binding.attachmentAbort = undefined
      }
      prepare.mockRestore()
    }
    expect(binding.prompt.text).toBe('retained newer')
    expect(binding.promptImages).toHaveLength(2)
    const closing = Promise.withResolvers<Awaited<ReturnType<ClipboardPort['read']>>>()
    read.mockReturnValueOnce(closing.promise)
    terminal.input({ type: 'paste-image' })
    await waitFor(() => read.mock.results.at(-1)?.value === closing.promise)
    const exit = controller.requestExit('user')
    closing.reject(new Error('closed clipboard'))
    await exit
  })

  it('scrolls approval evidence with vertical arrows without changing its selected action', async () => {
    const { controller, session, terminal } = createProduct()
    await controller.start()
    terminal.resize({ columns: 80, rows: 8 })
    session.interactionsSource.push(snapshot([{
      id: 'approval:scroll', kind: 'approval', sessionId: session.sessionId,
      approvalId: 'scroll', toolName: 'pwsh', callId: 'scroll',
      reason: 'Long explanation requiring scrolling. '.repeat(15),
    }]))
    const internals = controller as unknown as { currentBinding: SessionBinding }
    await waitFor(() => internals.currentBinding.interactionEditor.active?.kind === 'approval')
    terminal.input({ type: 'toggle-transcript-details' })
    terminal.input({ type: 'move-down' })
    expect(internals.currentBinding.interactionEditor.active).toMatchObject({ selectedIndex: 1, scrollOffset: 1 })
    terminal.input({ type: 'move-left' })
    expect(internals.currentBinding.interactionEditor.active).toMatchObject({ selectedIndex: 0, scrollOffset: 0 })
    terminal.input({ type: 'move-right' })
    expect(internals.currentBinding.interactionEditor.active).toMatchObject({ selectedIndex: 1, scrollOffset: 0 })
    terminal.input({ type: 'move-up' })
    expect(internals.currentBinding.interactionEditor.active).toMatchObject({ selectedIndex: 1, scrollOffset: 0 })
    for (let index = 0; index < 100; index += 1) terminal.input({ type: 'move-down' })
    const scrollOffset = () => (internals.currentBinding.interactionEditor.active as { scrollOffset: number }).scrollOffset
    const end = scrollOffset()
    expect(end).toBeLessThan(100)
    terminal.input({ type: 'move-up' })
    expect(scrollOffset()).toBe(end - 1)
    terminal.resize({ columns: 120, rows: 30 })
    expect(scrollOffset()).toBeLessThan(end)
    terminal.input({ type: 'toggle-transcript-details' })
    expect(scrollOffset()).toBe(0)
    terminal.input({ type: 'escape' })
    expect(session.responses.at(-1)).toMatchObject({ outcome: 'rejected' })
    await controller.requestExit('user')
  })

  it.each([{ columns: 80, rows: 1 }, { columns: 80, rows: 3 }, { columns: 80, rows: 6 }, { columns: 39, rows: 24 }])(
    'blocks a permission widening confirmation after resizing to $columns x $rows', async viewport => {
      const session = new FakeSession()
      session.permissionState = selectablePermissionSnapshot()
      const { controller, terminal } = createProduct({ session })
      await controller.start()
      terminal.resize({ columns: 120, rows: 30 })
      terminal.input({ type: 'insert', text: '/permission danger-full-access' })
      terminal.input({ type: 'submit' })
      terminal.input({ type: 'submit' })
      terminal.input({ type: 'move-right' })
      terminal.resize(viewport)
      terminal.input({ type: 'submit' })
      expect((controller as unknown as { currentBinding: SessionBinding }).currentBinding.permissionSelectTask).toBeUndefined()
      expect(session.permissionSelections).toEqual([])
      const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
      expect(binding.commandNotice).toContain('Terminal too small')
      terminal.input({ type: 'move-left' })
      terminal.input({ type: 'submit' })
      expect(binding.permissionPicker.confirmation).toBeUndefined()
      expect(session.permissionSelections).toEqual([])
      terminal.input({ type: 'submit' })
      terminal.input({ type: 'move-right' })
      terminal.resize({ columns: 120, rows: 30 })
      terminal.input({ type: 'submit' })
      await waitFor(() => session.permissionSelections.length === 1)
      expect(session.permissionSelections[0]?.value).toBe('danger-full-access')
      await controller.requestExit('user')
    },
  )

  it.each([
    { columns: 39, rows: 12 },
    { columns: 80, rows: 3 },
  ])('blocks Allow at $columns x $rows while retaining Reject and the image draft', async viewport => {
    const { controller, session, terminal } = createProduct()
    session.attachmentState = { available: true, maxImagesPerMessage: 2 }
    await controller.start()
    terminal.input({ type: 'insert', text: '/attach approval-draft.png' })
    terminal.input({ type: 'submit' })
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    await waitFor(() => binding.promptImages.length === 1)
    terminal.input({ type: 'insert', text: 'preserved approval draft' })
    terminal.resize(viewport)
    session.interactionsSource.push(snapshot([{
      id: 'approval:small', kind: 'approval', sessionId: session.sessionId,
      approvalId: 'small', toolName: 'pwsh', callId: 'small',
    }]))
    await waitFor(() => binding.interactionEditor.active?.kind === 'approval')
    expect(binding.interactionEditor.active).toMatchObject({ selectedIndex: 1 })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'submit' })
    expect(session.responses).toEqual([])
    expect(binding.interactionEditor.active?.error).toContain('too small')
    terminal.input({ type: 'insert', text: 'y' })
    terminal.input({ type: 'submit' })
    expect(session.responses).toEqual([])
    terminal.input({ type: 'backspace' })
    terminal.input({ type: 'insert', text: '1' })
    terminal.input({ type: 'submit' })
    expect(session.responses).toEqual([])
    expect(binding.interactionEditor.active?.error).toContain('too small')
    terminal.input({ type: 'backspace' })
    terminal.input({ type: 'insert', text: '2' })
    terminal.input({ type: 'submit' })
    expect(session.responses.at(-1)).toMatchObject({ id: 'approval:small', outcome: 'rejected' })
    expect(binding.prompt.text).toBe('preserved approval draft')
    expect(binding.promptImages).toMatchObject([{ name: 'approval-draft.png' }])
    expect(session.submitted).toEqual([])
    await controller.requestExit('user')
  })
})

describe('DshTuiController pumps and rendering', () => {
  it('observes presentation preferences without resetting the current Session view or composer', async () => {
    let value = { ...DEFAULT_DSH_TUI_PREFERENCES, defaultTranscriptMode: 'verbose' as const }
    let changed!: () => void
    const stop = vi.fn()
    const product = createProduct({ preferences: {
      snapshot: () => value,
      onChanged: listener => { changed = () => listener(value); return stop },
    } })
    changed()
    await product.controller.start()
    product.terminal.input({ type: 'insert', text: 'draft remains' })
    value = { ...value, density: 'comfortable', reducedMotion: true }
    changed()
    await waitFor(() => product.terminal.frames.at(-1)?.conversation?.density === 'comfortable')
    expect(product.terminal.frames.at(-1)?.conversation?.composer).toBe('draft remains')
    expect(product.terminal.frames.at(-1)?.conversation?.reducedMotion).toBe(true)
    await product.controller.requestExit('user')
    expect(stop).toHaveBeenCalledOnce()
  })

  it('handles current-session activation and reports a missing navigation capability', async () => {
    const sessionNavigation = new SessionNavigationHost()
    const product = createProduct({ sessionNavigation })
    await product.controller.start()
    const signal = new AbortController().signal
    await sessionNavigation.navigate({ kind: 'activate', sessionId: product.session.sessionId, intent: 'attach-live', signal })
    await expect(sessionNavigation.navigate({ kind: 'activate', sessionId: 'other', intent: 'attach-live', signal })).rejects.toThrow('activation is unavailable')
    await product.controller.requestExit('user')
  })
  it('lets a Feature switch and fork through the existing lease transaction without opening the legacy picker', async () => {
    const sessionNavigation = new SessionNavigationHost()
    const activation = new FakeActivation()
    const target = new FakeSession('feature-target')
    target.interactionsSource.push(snapshot([], target.sessionId))
    const targetRelease = vi.fn(async () => { await target.dispose() })
    activation.activateOverride = async () => ({ port: target, release: targetRelease })
    const fork = new FakeFork()
    const child = new FakeSession('feature-child')
    child.interactionsSource.push(snapshot([], child.sessionId))
    fork.forkOverride = async () => ({ port: child, release: async () => { await child.dispose() } })
    const product = createProduct({ sessionNavigation, activation, fork })
    await product.controller.start()
    product.terminal.input({ type: 'insert', text: 'keep my draft' })
    const signal = new AbortController().signal
    await sessionNavigation.navigate({ kind: 'activate', sessionId: target.sessionId, intent: 'attach-live', signal })
    expect(sessionNavigation.snapshot().sessionId).toBe(target.sessionId)
    await sessionNavigation.navigate({ kind: 'activate', sessionId: 'session-a', intent: 'attach-live', signal })
    expect(product.terminal.frames.at(-1)?.conversation?.composer).toBe('keep my draft')
    await sessionNavigation.navigate({ kind: 'fork', sessionId: 'session-a', signal })
    expect(sessionNavigation.snapshot().sessionId).toBe(child.sessionId)
    expect(fork.requests[0]?.sourceSessionId).toBe('session-a')
    await product.controller.requestExit('user')
    expect(targetRelease).toHaveBeenCalledOnce()
    expect(sessionNavigation.snapshot()).toEqual({ busy: true })
  })

  it('contains failed Feature navigation and releases a late cancelled lease', async () => {
    const sessionNavigation = new SessionNavigationHost()
    const activation = new FakeActivation()
    const product = createProduct({ sessionNavigation, activation })
    await product.controller.start()
    const request = { kind: 'activate' as const, sessionId: 'late', intent: 'attach-live' as const }
    await expect(sessionNavigation.navigate({ ...request, signal: new AbortController().signal })).rejects.toThrow('no fake activation')
    await expect(sessionNavigation.navigate({ kind: 'fork', sessionId: 'session-a', signal: new AbortController().signal })).rejects.toThrow('unavailable')
    const pending = Promise.withResolvers<ActivatedSessionLease>()
    activation.activateOverride = () => pending.promise
    const abort = new AbortController()
    const task = sessionNavigation.navigate({ ...request, signal: abort.signal })
    const expected = expect(task).rejects.toThrow('cancel navigation')
    abort.abort(new Error('cancel navigation'))
    const release = vi.fn(async () => {})
    pending.resolve({ port: new FakeSession('late'), release })
    await expected
    expect(release).toHaveBeenCalledOnce()
    expect(sessionNavigation.snapshot().sessionId).toBe('session-a')
    await product.controller.requestExit('user')
  })

  it('activates the initial Feature Session, resizes it, and deactivates before release', async () => {
    const order: string[] = []
    const session = new FakeSession()
    const featureSession = new FakeFeatureSession()
    featureSession.deactivate.mockImplementation(async () => {
      order.push('feature-session:deactivate')
    })
    const release = vi.fn(async () => {
      order.push('session:release')
      await session.dispose()
    })
    const product = createProduct({ session, featureSession, sessionRelease: release })
    const changed = featureSession.onChanged.mock.calls[0]![0]
    changed(undefined)
    expect(product.terminal.frames).toEqual([])
    await product.controller.start()
    expect(featureSession.activate).toHaveBeenCalledExactlyOnceWith(
      session,
      { columns: 60, rows: 12 },
    )

    product.terminal.resize({ columns: 91, rows: 27 })
    await waitFor(() => featureSession.resize.mock.calls.length === 1)
    expect(featureSession.resize).toHaveBeenCalledExactlyOnceWith({ columns: 91, rows: 27 })

    const route = { kind: 'workspace', featureId: 'probe', pane: 'content' } as const
    const surface = {
      host: {
        navigation: transitionNavigation(createNavigationState(), { type: 'navigate', route }).state,
        routes: [], commands: [], resources: [], regions: [], issues: [], slots: createSlotRegistry<LayoutRegion>(),
      },
      layout: resolveLayout(product.terminal.viewport, route, []), surfaces: [],
    }
    featureSession.snapshot.mockReturnValue(surface)
    changed(surface)
    await waitFor(() => product.terminal.frames.at(-1)?.conversation === undefined)
    expect(product.terminal.frames.at(-1)?.title).toContain('session-a')

    await product.controller.requestExit('user')
    expect(order).toEqual(['feature-session:deactivate', 'session:release'])
    expect(featureSession.deactivate.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    )
  })

  it('rolls Feature Session activation back when navigation is cancelled during hydration', async () => {
    const featureSession = new FakeFeatureSession()
    const sessionNavigation = new SessionNavigationHost()
    const activation = new FakeActivation()
    const target = new FakeSession('target-feature')
    target.interactionsSource.push(snapshot([], target.sessionId))
    activation.activateOverride = async () => ({ port: target, release: () => target.dispose() })
    const product = createProduct({ featureSession, sessionNavigation, activation })
    await product.controller.start()
    const pending = Promise.withResolvers<'active'>()
    featureSession.activate.mockImplementation(async source => source === target ? await pending.promise : 'active')
    const owner = new AbortController()
    const task = sessionNavigation.navigate({
      kind: 'activate',
      sessionId: target.sessionId,
      intent: 'attach-live',
      signal: owner.signal,
      cancellation: { cancel: reason => { owner.abort(reason) } },
    })
    await waitFor(() => featureSession.activate.mock.calls.some(call => call[0] === target))
    product.terminal.input({ type: 'escape' })
    expect(owner.signal.aborted).toBe(true)
    const rejected = expect(task).rejects.toThrow('session switch cancelled by user')
    pending.resolve('active')
    await rejected
    expect(featureSession.activate).toHaveBeenLastCalledWith(product.session, product.terminal.viewport)
    expect(sessionNavigation.snapshot().sessionId).toBe(product.session.sessionId)
    expect(target.disposeCount).toBe(1)
    featureSession.resize.mockRejectedValueOnce(new Error('layout failure'))
    product.terminal.resize({ columns: 100, rows: 25 })
    expect(await product.controller.wait()).toMatchObject({ ok: false, reason: 'fatal' })
  })

  it('keeps the internal rollback fallback for navigation callers without a cancellation sink', async () => {
    const featureSession = new FakeFeatureSession()
    const sessionNavigation = new SessionNavigationHost()
    const activation = new FakeActivation()
    const target = new FakeSession('target-legacy-navigation')
    target.interactionsSource.push(snapshot([], target.sessionId))
    activation.activateOverride = async () => ({ port: target, release: () => target.dispose() })
    const product = createProduct({ featureSession, sessionNavigation, activation })
    await product.controller.start()
    const pending = Promise.withResolvers<'active'>()
    featureSession.activate.mockImplementation(async source => source === target ? await pending.promise : 'active')
    const task = sessionNavigation.navigate({
      kind: 'activate', sessionId: target.sessionId, intent: 'attach-live',
      signal: new AbortController().signal,
    })
    const rejected = expect(task).rejects.toThrow('Session navigation did not commit')
    await waitFor(() => featureSession.activate.mock.calls.some(call => call[0] === target))

    product.terminal.input({ type: 'escape' })
    pending.resolve('active')
    await rejected
    expect(sessionNavigation.snapshot().sessionId).toBe(product.session.sessionId)
    expect(target.disposeCount).toBe(1)
    await product.controller.requestExit('user')
  })

  it('propagates Shell cancellation for an external fork and releases its late child', async () => {
    const sessionNavigation = new SessionNavigationHost()
    const opened = Promise.withResolvers<ActivatedSessionLease>()
    const child = new FakeSession('late-external-fork-child')
    const release = vi.fn(async () => {})
    const fork = new FakeFork()
    fork.forkOverride = async () => await opened.promise
    const product = createProduct({ sessionNavigation, fork })
    await product.controller.start()
    const owner = new AbortController()
    const task = sessionNavigation.navigate({
      kind: 'fork',
      sessionId: product.session.sessionId,
      signal: owner.signal,
      cancellation: { cancel: reason => { owner.abort(reason) } },
    })
    const rejected = expect(task).rejects.toThrow('session fork cancelled by user')
    await waitFor(() => fork.requests.length === 1)

    product.terminal.input({ type: 'escape' })
    expect(owner.signal.aborted).toBe(true)
    opened.resolve({ port: child, release })
    await rejected
    expect(release).toHaveBeenCalledOnce()
    expect(sessionNavigation.snapshot().sessionId).toBe(product.session.sessionId)
    await product.controller.requestExit('user')
  })

  it('keeps second-interrupt forced recovery after propagating external navigation cancellation', async () => {
    const featureSession = new FakeFeatureSession()
    const sessionNavigation = new SessionNavigationHost()
    const activation = new FakeActivation()
    const target = new FakeSession('target-forced-feature')
    target.interactionsSource.push(snapshot([], target.sessionId))
    activation.activateOverride = async () => ({ port: target, release: () => target.dispose() })
    const product = createProduct({ featureSession, sessionNavigation, activation })
    await product.controller.start()
    const pending = Promise.withResolvers<'active'>()
    featureSession.activate.mockImplementation(async source => source === target ? await pending.promise : 'active')
    const owner = new AbortController()
    const task = sessionNavigation.navigate({
      kind: 'activate',
      sessionId: target.sessionId,
      intent: 'attach-live',
      signal: owner.signal,
      cancellation: { cancel: reason => { owner.abort(reason) } },
    })
    const rejected = expect(task).rejects.toThrow('session switch cancelled by user')
    await waitFor(() => featureSession.activate.mock.calls.some(call => call[0] === target))

    product.terminal.input({ type: 'interrupt' })
    expect(owner.signal.aborted).toBe(true)
    expect(product.controller.state).toBe('running')
    product.terminal.input({ type: 'interrupt' })
    await expect(product.controller.wait()).resolves.toMatchObject({ ok: false, reason: 'forced' })

    pending.resolve('active')
    await rejected
    await waitFor(() => target.disposeCount === 1)
  })

  it('starts and dispatches through the generic Feature Host seam', async () => {
    let changed: (() => void) | undefined
    const unsubscribe = vi.fn()
    const start = vi.fn(async () => {})
    const dispatchTerminalAction = vi.fn(() => ({
      handled: true,
      completion: Promise.resolve(),
    }))
    const features = {
      start,
      dispatchTerminalAction,
      onChanged(listener: () => void) {
        changed = listener
        return unsubscribe
      },
    } as unknown as DshTuiFeatureHostPort
    const product = createProduct({ features })

    changed?.()
    expect(product.terminal.frames).toEqual([])
    await product.controller.start()
    await waitFor(() => product.terminal.frames.length > 0)
    expect(start).toHaveBeenCalledOnce()
    const beforeFeatureInvalidation = product.terminal.frames.length
    changed?.()
    await waitFor(() => product.terminal.frames.length > beforeFeatureInvalidation)

    product.terminal.input({ type: 'insert', text: 'owned by fake feature' })
    expect(dispatchTerminalAction).toHaveBeenCalledWith({
      type: 'insert',
      text: 'owned by fake feature',
    })
    expect(product.terminal.frames.at(-1)?.conversation?.composer).toBe('')

    await product.controller.requestExit('user')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('projects dormant Feature routes into slash commands without a route-specific branch', async () => {
    const openRoute = vi.fn(async () => {})
    const features = {
      navigation: {
        value: 'chat',
        route: { kind: 'chat' },
        mode: 'insert',
        focus: { kind: 'composer' },
        overlays: [],
      },
      start: async () => {},
      openRoute,
      snapshot: () => ({
        availableRoutes: [
          { id: 'chat', featureId: 'legacy.chat' },
          { id: 'sessions', featureId: 'sessions' },
          { id: 'diff', featureId: 'diff' },
          { id: 'diff.inspector', featureId: 'diff' },
        ],
      }),
      onChanged: () => () => {},
      dispatchTerminalAction: () => ({ handled: false, completion: Promise.resolve() }),
    } as unknown as DshTuiFeatureHostPort
    const product = createProduct({ features })
    await product.controller.start()
    await waitFor(() => product.terminal.frames.length > 0)

    const internals = product.controller as unknown as {
      commandCandidates(): readonly CommandMenuCandidate[]
    }
    expect(internals.commandCandidates().map(candidate => candidate.command.name)).toContain('diff')

    product.terminal.input({ type: 'insert', text: '/diff' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => openRoute.mock.calls.length === 1)
    expect(openRoute).toHaveBeenCalledExactlyOnceWith('diff')
    expect(product.terminal.frames.at(-1)?.conversation?.composer).toBe('')

    product.terminal.input({ type: 'insert', text: '/diff extra' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => product.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /diff does not accept input',
    ) === true)
    expect(openRoute).toHaveBeenCalledOnce()

    for (let index = 0; index < '/diff extra'.length; index++) product.terminal.input({ type: 'backspace' })
    openRoute.mockRejectedValueOnce(new Error('route unavailable'))
    product.terminal.input({ type: 'insert', text: '/diff' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => product.terminal.frames.at(-1)?.lines.join('\n').includes('Feature route unavailable: route unavailable') === true)

    await product.controller.requestExit('user')
  })

  it.each(['success', 'failure'])('does not write a late Feature route %s into a replacement Session', async outcome => {
    const pending = Promise.withResolvers<void>()
    const features = {
      start: async () => {},
      openRoute: vi.fn(() => pending.promise),
      snapshot: () => ({ availableRoutes: [{ id: 'diff', featureId: 'diff' }] }),
      onChanged: () => () => {},
      dispatchTerminalAction: () => ({ handled: false, completion: Promise.resolve() }),
    } as unknown as DshTuiFeatureHostPort
    const navigation = new SessionNavigationHost()
    const activation = new FakeActivation()
    const target = new FakeSession('replacement')
    target.interactionsSource.push(snapshot([], target.sessionId))
    activation.activateOverride = async () => ({ port: target, release: () => target.dispose() })
    const product = createProduct({ features, sessionNavigation: navigation, activation })
    await product.controller.start()
    product.terminal.input({ type: 'insert', text: '/diff' })
    product.terminal.input({ type: 'submit' })
    await navigation.navigate({ kind: 'activate', sessionId: target.sessionId, intent: 'attach-live', signal: new AbortController().signal })
    if (outcome === 'failure') pending.reject(new Error('stale route error'))
    else pending.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(product.terminal.frames.at(-1)?.lines.join('\n')).not.toContain('stale route error')
    await product.controller.requestExit('user')
  })

  it('ignores superseded route completions and joins the latest route during shutdown', async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    let availableRoutes: readonly { id: string; featureId: string }[] | undefined
    const features = {
      start: async () => {},
      openRoute: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      snapshot: () => ({ availableRoutes }),
      onChanged: () => () => {},
      dispatchTerminalAction: () => ({ handled: false, completion: Promise.resolve() }),
    } as unknown as DshTuiFeatureHostPort
    const product = createProduct({ features })
    const seam = product.controller as unknown as { tryOpenFeatureRoute(line: string): boolean; featureRouteTask?: Promise<void> }
    await product.controller.start()
    expect(seam.tryOpenFeatureRoute('/diff')).toBe(false)
    availableRoutes = []
    expect(seam.tryOpenFeatureRoute('/diff')).toBe(false)
    availableRoutes = [{ id: 'diff', featureId: 'diff' }]
    expect(seam.tryOpenFeatureRoute('/not-a-feature')).toBe(false)
    expect(seam.tryOpenFeatureRoute('/diff extra')).toBe(true)
    expect(features.openRoute).not.toHaveBeenCalled()
    expect(seam.tryOpenFeatureRoute('/diff')).toBe(true)
    const earlier = seam.featureRouteTask!
    expect(seam.tryOpenFeatureRoute('/diff')).toBe(true)
    const latest = seam.featureRouteTask!
    first.resolve()
    await earlier
    expect(seam.featureRouteTask).toBe(latest)
    const stopped = product.controller.requestExit('user')
    second.reject(new Error('late shutdown route failure'))
    await stopped
    expect(product.terminal.frames.at(-1)?.lines.join('\n')).not.toContain('late shutdown route failure')
  })

  it.each(['success', 'failure'])('preserves staged images when a Feature route opens with %s', async outcome => {
    const image: PromptImageInput = { name: 'keep.png', mediaType: 'image/png', bytes: 2, data: new Uint8Array([1, 2]) }
    const features = {
      start: async () => {},
      openRoute: vi.fn(async () => { if (outcome === 'failure') throw new Error('unavailable') }),
      snapshot: () => ({ availableRoutes: [{ id: 'diff', featureId: 'diff' }] }),
      onChanged: () => () => {},
      dispatchTerminalAction: () => ({ handled: false, completion: Promise.resolve() }),
    } as unknown as DshTuiFeatureHostPort
    const product = createProduct({ features })
    const seam = product.controller as unknown as { currentBinding: SessionBinding; tryOpenFeatureRoute(line: string): boolean; featureRouteTask?: Promise<void> }
    await product.controller.start()
    seam.currentBinding.promptImages = [image]
    expect(seam.tryOpenFeatureRoute('/diff')).toBe(true)
    await seam.featureRouteTask
    expect(seam.currentBinding.promptImages).toEqual([image])
    await product.controller.requestExit('user')
  })

  it('releases a fork candidate when cancelled during Feature activation', async () => {
    const featureSession = new FakeFeatureSession()
    const sessionNavigation = new SessionNavigationHost()
    const fork = new FakeFork()
    const child = new FakeSession('cancelled-child')
    child.interactionsSource.push(snapshot([], child.sessionId))
    const release = vi.fn(async () => child.dispose())
    fork.forkOverride = async () => ({ port: child, release })
    const product = createProduct({ featureSession, sessionNavigation, fork })
    await product.controller.start()
    const pending = Promise.withResolvers<'active'>()
    featureSession.activate.mockImplementation(async source => source === child ? await pending.promise : 'active')
    const abort = new AbortController()
    const task = sessionNavigation.navigate({ kind: 'fork', sessionId: 'session-a', signal: abort.signal })
    await waitFor(() => featureSession.activate.mock.calls.some(call => call[0] === child))
    const rejected = expect(task).rejects.toThrow('cancel fork')
    abort.abort(new Error('cancel fork'))
    pending.resolve('active')
    await rejected
    expect(release).toHaveBeenCalledOnce()
    expect(featureSession.activate).toHaveBeenLastCalledWith(product.session, product.terminal.viewport)
    expect(sessionNavigation.snapshot().sessionId).toBe('session-a')
    await product.controller.requestExit('user')
  })

  it('contains asynchronous failures from the generic Feature Host seam', async () => {
    const completion = Promise.withResolvers<void>()
    const features = {
      start: async () => {},
      dispatchTerminalAction: () => ({ handled: true, completion: completion.promise }),
      onChanged: () => () => {},
    } as unknown as DshTuiFeatureHostPort
    const product = createProduct({ features })
    await product.controller.start()

    product.terminal.input({ type: 'insert', text: 'trigger feature failure' })
    completion.reject(new Error('feature command failed'))

    const result = await product.controller.wait()
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(String(resultError(result))).toContain('feature command failed')
  })

  it('keeps ordinary prompt typing off command and model catalog hot paths', async () => {
    const product = createProduct()
    await product.controller.start()
    await waitFor(() => product.terminal.frames.length > 0)
    const initialFrames = product.terminal.frames.length
    const initialModelReads = product.session.modelSnapshotCount
    const internals = product.controller as unknown as {
      commandCandidates(): readonly unknown[]
    }
    const candidates = vi.spyOn(internals, 'commandCandidates')

    product.terminal.input({ type: 'insert', text: 'ordinary prompt text' })
    await waitFor(() => product.terminal.frames.length > initialFrames)

    expect(candidates).not.toHaveBeenCalled()
    expect(product.session.modelSnapshotCount).toBe(initialModelReads)
    await product.controller.requestExit('user')
  })

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

  it('keeps transcript details Session-local and compact by default', async () => {
    const product = createProduct()
    await product.controller.start()
    await waitFor(() => product.terminal.frames.length > 0)

    const internals = product.controller as unknown as {
      readonly currentBinding: SessionBinding
      readonly prompt: { readonly text: string; readonly cursor: number }
    }
    expect(internals.currentBinding.transcriptViewMode).toBe('compact')

    product.terminal.input({ type: 'insert', text: 'draft stays put' })
    await waitFor(() => internals.prompt.text === 'draft stays put')
    const draft = internals.prompt
    const framesBeforeToggle = product.terminal.frames.length

    product.terminal.input({ type: 'toggle-transcript-details' })
    await waitFor(() => (
      internals.currentBinding.transcriptViewMode === 'verbose'
      && product.terminal.frames.length > framesBeforeToggle
    ))
    expect(internals.prompt).toEqual(draft)

    product.terminal.input({ type: 'toggle-transcript-details' })
    await waitFor(() => internals.currentBinding.transcriptViewMode === 'compact')

    await product.controller.requestExit('user')
  })

  it('does not schedule frames for subsequent folded reasoning-only deltas', async () => {
    const product = createProduct()
    await product.controller.start()
    product.session.eventsSource.push(runtime(0, 'agent/created', 'running'))
    product.session.eventsSource.push(durable(0, {
      type: 'turn/start',
      data: { turn: 1 },
    }))
    product.session.eventsSource.push(durable(1, {
      type: 'user/message',
      data: {
        message: message('reasoning-input', 'user', 'Keep the reasoning private'),
        surfaceOp: 'append',
      },
    }))
    product.session.eventsSource.push(durable(2, {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'reasoning-delta', index: 0, text: 'first private token' },
      },
    }))
    await waitFor(() => (
      product.terminal.frames.at(-1)?.conversation?.agentRequest?.phase === 'reasoning'
    ))
    expect(JSON.stringify(
      product.terminal.frames.at(-1)?.conversation?.nodes ?? [],
    )).not.toContain('first private token')
    await new Promise(resolve => setTimeout(resolve, 5))
    const afterFirst = product.terminal.frames.length

    for (let index = 1; index <= 4; index += 1) {
      product.session.eventsSource.push(durable(index + 2, {
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: { type: 'reasoning-delta', index, text: ` hidden ${index}` },
        },
      }))
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(product.terminal.frames).toHaveLength(afterFirst)

    product.session.eventsSource.push(durable(8, {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'visible answer' },
      },
    }))
    await waitFor(() => product.terminal.frames.length > afterFirst)
    expect(product.terminal.frames.at(-1)?.conversation?.agentRequest).toMatchObject({
      phase: 'responding',
    })
    expect(JSON.stringify(product.terminal.frames.at(-1)?.conversation?.nodes ?? []))
      .not.toContain('visible answer')

    product.session.eventsSource.push(durable(7, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: message('assistant-1', 'assistant', 'visible answer'),
        surfaceOp: 'append',
      },
    }))
    await waitFor(() => product.terminal.frames.at(-1)?.conversation?.nodes.some(node => (
      (node.kind === 'assistant' || node.kind === 'assistant-draft')
      && node.text === 'visible answer'
    )) === true)
    expect(product.terminal.frames.at(-1)?.conversation?.agentRequest).toBeUndefined()
    await product.controller.requestExit('user')
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
      && frame.lines.join('\n').includes('1 Allow once')
    )))

    expect(terminal.frames.at(-1)?.overlay).toBeUndefined()
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('2 Reject')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Esc reject')
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
  it('shows submitted immediately and cancels admission instead of exiting before runtime status', async () => {
    const { controller, session, terminal, application } = createProduct()
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))
    await waitFor(() => terminal.frames.length > 0)

    const gate = deferred()
    session.submitGate = gate.promise
    terminal.input({ type: 'insert', text: 'inspect this' })
    terminal.input({ type: 'submit' })

    await waitFor(() => session.submitted.length === 1)
    await waitFor(() => (
      terminal.frames.at(-1)?.conversation?.agentRequest?.phase === 'submitted'
    ))
    expect(terminal.frames.at(-1)?.conversation?.composer).toBe('')
    const binding = (controller as unknown as { readonly currentBinding: SessionBinding })
      .currentBinding
    expect(binding.submitAbort?.signal).toBe(session.submitSignals[0])
    expect(binding.agentRequest?.phase).toBe('submitted')

    terminal.input({ type: 'interrupt' })
    expect(terminal.state).toBe('running')
    expect(application.requestCount).toBe(0)
    expect(binding.submitAbort?.signal.aborted).toBe(true)
    expect(session.submitSignals[0]?.aborted).toBe(true)

    gate.resolve()
    await waitFor(() => controller.pendingSubmitCount === 0)
    await waitFor(() => (
      terminal.frames.at(-1)?.conversation?.agentRequest?.phase === 'cancelled'
    ))
    expect(terminal.frames.at(-1)?.conversation?.composer).toBe('inspect this')
    expect(session.cancellations).toEqual([])

    await controller.requestExit('user')
  })

  it('cancels an accepted prompt while runtime status is still lagging at idle', async () => {
    const { controller, session, terminal, application } = createProduct()
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))

    terminal.input({ type: 'insert', text: 'accepted before status' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingSubmitCount === 0)
    await waitFor(() => (
      terminal.frames.at(-1)?.conversation?.agentRequest?.phase === 'waiting'
    ))

    terminal.input({ type: 'interrupt' })
    expect(session.cancellations).toEqual([{ kind: 'user' }])
    expect(application.requestCount).toBe(0)
    expect(terminal.state).toBe('running')

    session.eventsSource.push(runtime(1, 'agent/status', 'idle'))
    await waitFor(() => (
      terminal.frames.at(-1)?.conversation?.agentRequest?.phase === 'cancelled'
    ))
    await controller.requestExit('user')
  })

  it('settles an accepted maintenance cancellation without terminal runtime events', async () => {
    const { controller, session, terminal, application } = createProduct()
    const idle = deferred()
    session.idleGate = idle.promise
    session.onCancel = () => idle.resolve()
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))

    terminal.input({ type: 'insert', text: 'run maintenance' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingSubmitCount === 0)
    await waitFor(() => (
      terminal.frames.at(-1)?.conversation?.agentRequest?.phase === 'waiting'
    ))

    terminal.input({ type: 'interrupt' })

    expect(session.cancellations).toEqual([{ kind: 'user' }])
    expect(application.requestCount).toBe(0)
    expect(terminal.state).toBe('running')
    await waitFor(() => session.whenIdleCount === 1)
    await waitFor(() => (
      terminal.frames.at(-1)?.conversation?.agentRequest?.phase === 'cancelled'
    ))

    await controller.requestExit('user')
  })

  it('forces terminal recovery when cancellation receives a second interrupt', async () => {
    const { controller, session, terminal } = createProduct()
    const submit = deferred()
    session.submitGate = submit.promise
    session.submitIgnoresAbort = true
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))

    terminal.input({ type: 'insert', text: 'stuck admission' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)

    terminal.input({ type: 'interrupt' })
    const binding = (controller as unknown as { readonly currentBinding: SessionBinding })
      .currentBinding
    expect(binding.agentRequest?.cancelRequested).toBe(true)
    terminal.input({ type: 'interrupt' })
    submit.resolve()

    await expect(controller.wait()).resolves.toMatchObject({ ok: false, reason: 'forced' })
  })

  it('cancels stale running status after a durable turn has already settled', async () => {
    const owned = createProduct()
    await owned.controller.start()
    owned.session.eventsSource.push(runtime(0, 'agent/created', 'running'))
    owned.session.eventsSource.push(durable(0, {
      type: 'turn/start',
      data: { turn: 1 },
    }))
    owned.session.eventsSource.push(durable(1, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    }))
    const ownedBinding = (owned.controller as unknown as {
      readonly currentBinding: SessionBinding
    }).currentBinding
    await waitFor(() => ownedBinding.agentRequest?.phase === 'succeeded')

    owned.terminal.input({ type: 'interrupt' })
    expect(owned.session.cancellations).toEqual([{ kind: 'user' }])
    owned.session.eventsSource.push(runtime(2, 'agent/status', 'idle'))
    await owned.controller.requestExit('user')

    const borrowedSession = new FakeSession('borrowed-stale-running', false)
    const borrowed = createProduct({ session: borrowedSession })
    await borrowed.controller.start()
    borrowedSession.eventsSource.push(runtime(
      0,
      'agent/created',
      'running',
      borrowedSession.sessionId,
    ))
    borrowedSession.eventsSource.push(durable(0, {
      type: 'turn/start',
      data: { turn: 1 },
    }, borrowedSession.sessionId))
    borrowedSession.eventsSource.push(durable(1, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    }, borrowedSession.sessionId))
    const borrowedBinding = (borrowed.controller as unknown as {
      readonly currentBinding: SessionBinding
    }).currentBinding
    await waitFor(() => borrowedBinding.agentRequest?.phase === 'succeeded')

    borrowed.terminal.input({ type: 'interrupt' })
    await expect(borrowed.controller.wait()).resolves.toMatchObject({
      ok: true,
      reason: 'user',
    })
    expect(borrowedSession.cancellations).toEqual([])
  })

  it('treats a rejected cancellation idle barrier as fatal', async () => {
    const { controller, session, terminal } = createProduct()
    const idle = Promise.withResolvers<void>()
    session.idleGate = idle.promise
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))

    terminal.input({ type: 'insert', text: 'maintenance with broken barrier' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingSubmitCount === 0)
    terminal.input({ type: 'interrupt' })
    await waitFor(() => session.whenIdleCount === 1)
    idle.reject(new Error('idle barrier rejected'))

    const result = await controller.wait()
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(String(resultError(result))).toContain(
      'request cancellation reconciliation failed: idle barrier rejected',
    )
  })

  it('cancels an abort-ignoring late admission even when running arrives first', async () => {
    const { controller, session, terminal } = createProduct()
    const submit = deferred()
    const idle = deferred()
    session.submitGate = submit.promise
    session.submitIgnoresAbort = true
    session.idleGate = idle.promise
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))

    terminal.input({ type: 'insert', text: 'late admission' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    session.eventsSource.push(runtime(1, 'agent/status', 'running'))
    await waitFor(() => {
      const binding = (controller as unknown as { readonly currentBinding: SessionBinding })
        .currentBinding
      return binding.agentRequest?.accepted === true
    })
    terminal.input({ type: 'interrupt' })
    expect(session.cancellations).toEqual([{ kind: 'user' }])
    await waitFor(() => session.whenIdleCount === 1)
    submit.resolve()

    await waitFor(() => controller.pendingSubmitCount === 0)
    expect(session.cancellations).toEqual([{ kind: 'user' }])
    expect(session.whenIdleCount).toBe(1)
    idle.resolve()
    await waitFor(() => (
      terminal.frames.at(-1)?.conversation?.agentRequest?.phase === 'cancelled'
    ))

    await controller.requestExit('user')
  })

  it('settles a host-aborted borrowed submission without cancelling its Agent', async () => {
    const session = new FakeSession('borrowed-aborted-submit', false)
    const product = createProduct({ session })
    const submit = deferred()
    session.submitGate = submit.promise
    session.submitIgnoresAbort = true
    await product.controller.start()
    session.eventsSource.push(runtime(0, 'agent/created', 'idle', session.sessionId))

    product.terminal.input({ type: 'insert', text: 'borrowed admission' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    const internals = product.controller as unknown as {
      readonly currentBinding: SessionBinding
      reconcileAgentRequestCancellation(binding: SessionBinding): void
    }
    internals.currentBinding.submitAbort?.abort('Host stopped the local submission')
    submit.resolve()

    await waitFor(() => product.controller.pendingSubmitCount === 0)
    expect(internals.currentBinding.agentRequest).toMatchObject({
      phase: 'cancelled',
      cancelRequested: false,
    })
    expect(internals.currentBinding.requestCancelDispatched).toBe(false)
    expect(session.cancellations).toEqual([])

    internals.reconcileAgentRequestCancellation(internals.currentBinding)
    await waitFor(() => internals.currentBinding.requestCancelTask === undefined)
    expect(session.whenIdleCount).toBe(1)
    expect(internals.currentBinding.agentRequest?.phase).toBe('cancelled')
    await product.controller.requestExit('user')
  })

  it('contains a cancellation throw after a fatal host-side submission abort', async () => {
    const { controller, session, terminal } = createProduct()
    const submit = deferred()
    session.submitGate = submit.promise
    session.submitIgnoresAbort = true
    session.throwOnCancel = new Error('cancel transport failed')
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))

    terminal.input({ type: 'insert', text: 'fatal admission' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    const internals = controller as unknown as {
      readonly currentBinding: SessionBinding
      recordFatal(error: unknown): void
    }
    internals.recordFatal(new Error('primary controller failure'))
    internals.currentBinding.submitAbort?.abort('Fatal controller failure')
    submit.resolve()

    const result = await controller.wait()
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(String(resultError(result))).toContain('primary controller failure')
  })

  it('ignores a late cancellation-barrier rejection after forced shutdown', async () => {
    const { controller, session, terminal } = createProduct()
    const idle = Promise.withResolvers<void>()
    session.idleGate = idle.promise
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))

    terminal.input({ type: 'insert', text: 'accepted cancellation' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingSubmitCount === 0)
    terminal.input({ type: 'interrupt' })
    await waitFor(() => session.whenIdleCount === 1)
    const binding = (controller as unknown as { readonly currentBinding: SessionBinding })
      .currentBinding
    const cancellation = binding.requestCancelTask!

    terminal.input({ type: 'interrupt' })
    idle.reject(new Error('late closed barrier rejection'))
    await cancellation
    await expect(controller.wait()).resolves.toMatchObject({ ok: false, reason: 'forced' })
  })

  it('fences stale submit and cancellation continuations from current UI state', async () => {
    const submitProduct = createProduct()
    const submit = deferred()
    submitProduct.session.submitGate = submit.promise
    await submitProduct.controller.start()
    submitProduct.session.eventsSource.push(runtime(0, 'agent/created'))
    submitProduct.terminal.input({ type: 'insert', text: 'stale submit result' })
    submitProduct.terminal.input({ type: 'submit' })
    await waitFor(() => submitProduct.session.submitted.length === 1)

    const submitBinding = (submitProduct.controller as unknown as {
      readonly currentBinding: SessionBinding
    }).currentBinding
    const replacementAbort = new AbortController()
    submitBinding.role = 'background'
    submitBinding.submitAbort = replacementAbort
    submit.resolve()
    await waitFor(() => submitBinding.submitTask === undefined)
    expect(submitBinding.submitAbort).toBe(replacementAbort)

    submitBinding.role = 'current'
    submitBinding.submitAbort = undefined
    await submitProduct.controller.requestExit('user')

    const current = createProduct()
    await current.controller.start()
    const backgroundPort = new FakeSession('background-cancellation')
    const idle = deferred()
    backgroundPort.idleGate = idle.promise
    const background = createSessionBinding(
      991,
      backgroundPort,
      'background',
      async () => {},
    )
    background.agentRequest = {
      phase: 'waiting',
      description: 'Cancelling request',
      pendingInputs: [],
      accepted: true,
      cancelRequested: true,
    }
    const cancellationProbe = current.controller as unknown as {
      readonly bindings: Set<SessionBinding>
      reconcileAgentRequestCancellation(binding: SessionBinding): void
      closeBinding(binding: SessionBinding): Promise<void>
    }
    cancellationProbe.bindings.add(background)
    cancellationProbe.reconcileAgentRequestCancellation(background)
    const staleCancellation = background.requestCancelTask!
    const replacementCancellation = Promise.resolve()
    background.requestCancelTask = replacementCancellation
    idle.resolve()
    await staleCancellation

    expect(background.agentRequest).toMatchObject({
      phase: 'cancelled',
      cancelRequested: false,
    })
    expect(background.requestCancelTask).toBe(replacementCancellation)
    background.requestCancelTask = undefined
    await cancellationProbe.closeBinding(background)
    await current.controller.requestExit('user')
  })

  it('reconciles a completed durable turn that arrives before submit resolves', async () => {
    const { controller, session, terminal } = createProduct()
    const submit = deferred()
    session.submitGate = submit.promise
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))

    terminal.input({ type: 'insert', text: 'fast durable turn' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)

    session.eventsSource.push(durable(0, {
      type: 'turn/start',
      data: { turn: 1 },
    }))
    session.eventsSource.push(durable(1, {
      type: 'user/message',
      data: {
        message: message('input-1', 'user', 'fast durable turn'),
        surfaceOp: 'append',
      },
    }))
    session.eventsSource.push(durable(2, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    }))
    session.eventsSource.push(runtime(1, 'agent/status', 'idle'))
    await waitFor(() => {
      const binding = (controller as unknown as { readonly currentBinding: SessionBinding })
        .currentBinding
      return binding.agentRequest?.phase === 'failed'
    })

    submit.resolve()
    await waitFor(() => controller.pendingSubmitCount === 0)
    await waitFor(() => {
      const binding = (controller as unknown as { readonly currentBinding: SessionBinding })
        .currentBinding
      return binding.agentRequest?.phase === 'succeeded'
    })
    await waitFor(() => terminal.frames.at(-1)?.conversation?.agentRequest === undefined)

    await controller.requestExit('user')
  })

  it('keeps a completed prompt terminal across standalone compaction so Ctrl+C exits', async () => {
    const { controller, session, terminal, application } = createProduct()
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))

    terminal.input({ type: 'insert', text: 'compact after this request' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingSubmitCount === 0)
    session.eventsSource.push(durable(0, {
      type: 'turn/start',
      data: { turn: 1 },
    }))
    session.eventsSource.push(durable(1, {
      type: 'user/message',
      data: {
        message: message('input-1', 'user', 'compact after this request'),
        surfaceOp: 'append',
      },
    }))
    session.eventsSource.push(durable(2, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    }))
    session.eventsSource.push(runtime(1, 'agent/status', 'idle'))
    await waitFor(() => {
      const binding = (controller as unknown as { readonly currentBinding: SessionBinding })
        .currentBinding
      return binding.agentRequest?.phase === 'succeeded'
    })
    await waitFor(() => terminal.frames.at(-1)?.conversation?.agentRequest === undefined)

    session.eventsSource.push(durable(3, {
      type: 'command/run',
      data: { commandId: 'compact-command', name: 'compact', source: { kind: 'user' } },
    }))
    session.eventsSource.push(durable(4, {
      type: 'compaction/start',
      data: {
        compactionId: 'compact-1',
        sourceCommandId: 'compact-command',
        turn: null,
      },
    }))
    session.eventsSource.push(durable(5, {
      type: 'compaction/summary',
      data: {
        compactionId: 'compact-1',
        sourceCommandId: 'compact-command',
        shadowedRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        shadowedTokenCount: 10,
        provider: 'test',
        model: 'test',
      },
    }))
    session.eventsSource.push(durable(6, {
      type: 'user/message',
      data: {
        message: message('checkpoint-1', 'user', 'compacted context', 'plugin'),
        surfaceOp: { op: 'replace', start: 1, end: 1 },
      },
    }))
    session.eventsSource.push(durable(7, {
      type: 'compaction/end',
      data: {
        compactionId: 'compact-1',
        sourceCommandId: 'compact-command',
        turn: null,
      },
    }))
    session.eventsSource.push(durable(8, {
      type: 'command/done',
      data: {
        commandId: 'compact-command',
        kind: 'success',
        text: 'Compacted 1 history item.',
        sourceEventSeq: 5,
      },
    }))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Compacted 1 history item.',
    ) === true)
    const binding = (controller as unknown as { readonly currentBinding: SessionBinding })
      .currentBinding
    expect(binding.agentRequest?.phase).toBe('succeeded')
    expect(terminal.frames.at(-1)?.conversation?.agentRequest).toBeUndefined()

    terminal.input({ type: 'interrupt' })
    await expect(controller.wait()).resolves.toMatchObject({ ok: true, reason: 'user' })
    expect(application.requestCount).toBe(1)
  })

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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === false)
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]?.input.text).toBe('preserved draft')
    await controller.requestExit('user')
  })

  it('routes multi-select, custom answers, navigation, and explicit skips through the official response', async () => {
    const { controller, session, terminal } = createProduct()
    await controller.start()
    session.interactionsSource.push(snapshot([{
      id: 'question:composer',
      kind: 'question',
      sessionId: session.sessionId,
      questions: [
        {
          id: 'colors',
          header: 'Palette',
          question: 'Choose colors and optionally explain',
          multiSelect: true,
          options: [{ label: 'Red' }, { label: 'Blue' }],
        },
        {
          id: 'notes',
          question: 'Anything else?',
          options: [{ label: 'Done' }],
        },
      ],
    }]))

    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('multiple choice') === true)
    terminal.input({ type: 'backspace' })
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'move-right' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Anything else?') === true)
    terminal.input({ type: 'move-left' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Choose colors') === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('☑ Red') === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'insert', text: 'warm shade' })
    terminal.input({ type: 'complete' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Anything else?') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('● 1')
    terminal.input({ type: 'save-default' })

    expect(session.responses.at(-1)).toEqual({
      id: 'question:composer',
      kind: 'question',
      outcome: {
        kind: 'answered',
        answer: {
          answers: [
            { id: 'colors', selected: ['Red'], custom: 'warm shade' },
            { id: 'notes', selected: [] },
          ],
        },
      },
    })

    session.interactionsSource.push(snapshot([{
      id: 'question:empty-controller',
      kind: 'question',
      sessionId: session.sessionId,
      questions: [],
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('No question payload') === true)
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'escape' })
    expect(session.responses.at(-1)).toMatchObject({
      id: 'question:empty-controller',
      outcome: { kind: 'cancelled' },
    })
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

    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('▌ Plan review') === true)
    let output = terminal.frames.at(-1)!.lines.join('\n')
    expect(output).toContain('Approve this implementation plan?')
    expect(output).toContain('›  Approve')
    expect(output).toContain('more plan lines in the tool card')
    expect(terminal.frames.at(-1)?.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })

    terminal.input({ type: 'insert', text: 'cannot edit this' })
    terminal.input({ type: 'toggle-goal-actions' })
    expect(terminal.frames.at(-1)!.lines.join('\n')).toContain('›  Approve')
    terminal.input({ type: 'move-left' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('›  Keep planning') === true)
    terminal.input({ type: 'move-up' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('›  Discuss') === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-right' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('›  Approve') === true)
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)

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
    await waitFor(() => terminal.frames.at(-1)?.conversation?.dock?.role !== 'command')
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
    expect(terminal.frames.at(-1)?.conversation?.dock?.role).toBe('command')
    expect(terminal.frames.at(-1)?.overlay).toBeUndefined()
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)

    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'complete' })
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('1 Allow once')
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('/compact —')
    expect(session.responses).toEqual([])

    session.interactionsSource.push(snapshot())
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === false)
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

describe('DshTuiController image attachment composer', () => {
  it('stages a quoted image path, renders a compact rail, and submits text or image-only prompts', async () => {
    const session = new FakeSession()
    session.attachmentState = {
      available: true,
      maxImageBytes: 1_024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4_096,
      mediaTypes: ['image/png'],
    }
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/attach "screens/panel.png"' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.preparedImagePaths.length === 1)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('IMAGES 1') === true)
    expect(session.preparedImagePaths).toEqual(['screens/panel.png'])
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('[1] panel.png · 4 B')

    terminal.input({ type: 'insert', text: 'inspect this image' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]).toEqual({
      input: {
        text: 'inspect this image',
        images: [{
          name: 'panel.png',
          mediaType: 'image/png',
          bytes: 4,
          data: new Uint8Array([1, 2, 3, 4]),
        }],
      },
      delivery: 'followup',
    })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('IMAGES 1') === false)

    terminal.input({ type: 'insert', text: '/attach panel.png' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.preparedImagePaths.length === 2)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('IMAGES 1') === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 2)
    expect(session.submitted[1]?.input).toMatchObject({ text: '', images: [{ name: 'panel.png' }] })

    await controller.requestExit('user')
  })

  it('keeps image drafts on recoverable prompt and command refusals', async () => {
    const session = new FakeSession()
    session.attachmentState = {
      available: true,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 32,
    }
    const inspect: DshCommandDescriptor = {
      name: 'inspect-image',
      description: 'Inspect image',
      input: { hint: '<target>', images: true },
    }
    const compact: DshCommandDescriptor = {
      name: 'compact',
      description: 'Compact context',
    }
    session.commands = [inspect, compact]
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/attach panel.png' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.preparedImagePaths.length === 1)
    session.throwOnSubmit = new DshSubmitRejectedError(
      'the selected model is text-only',
      'MODEL_DOES_NOT_SUPPORT_IMAGES',
    )
    terminal.input({ type: 'insert', text: 'describe it' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'the selected model is text-only',
    ) === true)
    expect(controller.state).toBe('running')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('> describe it')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('IMAGES 1')

    session.throwOnSubmit = undefined
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.length === 2)
    terminal.input({ type: 'insert', text: '/attach panel.png' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.preparedImagePaths.length === 2)
    session.executeCommandOverride = async () => ({
      commandId: 'image-command-error',
      result: { kind: 'error', text: 'command refused image' },
    })
    terminal.input({ type: 'insert', text: '/inspect-image target' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.length === 1)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'command refused image',
    ) === true)
    expect(session.commandExecutions[0]?.images).toHaveLength(1)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('> /inspect-image target')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('IMAGES 1')

    session.executeCommandOverride = async () => ({
      commandId: 'image-command-success',
      result: { kind: 'success' },
    })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.length === 2)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('IMAGES 1') === false)

    terminal.input({ type: 'insert', text: '/attach panel.png' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.preparedImagePaths.length === 3)
    terminal.input({ type: 'insert', text: '/compact' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '/compact does not accept image attachments',
    ) === true)
    expect(session.commandExecutions).toHaveLength(2)
    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('IMAGES 1') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('IMAGES 1')

    await controller.requestExit('user')
  })

  it('enforces staging limits and aborts a pending image read during shutdown', async () => {
    const session = new FakeSession()
    session.attachmentState = {
      available: true,
      maxImagesPerMessage: 1,
      maxMessageImageBytes: 3,
    }
    session.prepareImageOverride = async path => ({
      name: path,
      mediaType: 'image/png',
      bytes: 4,
      data: new Uint8Array([1, 2, 3, 4]),
    })
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/attach too-large.png' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'aggregate image-byte limit',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('> /attach too-large.png')

    const pending = new FakeSession('pending-image')
    pending.attachmentState = { available: true, maxImagesPerMessage: 2 }
    pending.prepareImageOverride = (_path, signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    })
    const product = createProduct({ session: pending })
    await product.controller.start()
    product.terminal.input({ type: 'insert', text: '/attach pending.png' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => pending.preparedImageSignals.length === 1)
    const exit = product.controller.requestExit('user')
    await waitFor(() => pending.preparedImageSignals[0]?.aborted === true)
    await expect(exit).resolves.toMatchObject({ ok: true, reason: 'user' })

    await controller.requestExit('user')
  })

  it('manages staged image drafts and contains invalid or unavailable attachment input', async () => {
    const session = new FakeSession()
    session.attachmentState = {
      available: true,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 64,
    }
    const { controller } = createProduct({ session })
    await controller.start()
    const probe = controller as unknown as {
      currentBinding: {
        prompt: ReturnType<typeof createPromptEditorState>
        promptImages: PromptImageInput[]
        commandNotice?: string
      }
      openLocalCommand(name: string): void
      runAttachCommand(rawInput: string): void
      submitPrompt(): void
    }
    const waitForAttachment = async () => {
      expect(controller.pendingAttachmentCount).toBe(1)
      await waitFor(() => controller.pendingAttachmentCount === 0)
    }

    probe.openLocalCommand('attach')
    expect(probe.currentBinding.prompt.text).toBe('/attach ')
    probe.runAttachCommand('')
    expect(probe.currentBinding.prompt.text).toBe('/attach ')

    probe.runAttachCommand('clear')
    expect(probe.currentBinding.commandNotice).toBe('No staged images')
    probe.runAttachCommand('a')
    await waitForAttachment()
    probe.runAttachCommand("'second.png'")
    await waitForAttachment()
    expect(session.preparedImagePaths).toEqual(['a', 'second.png'])
    expect(probe.currentBinding.promptImages).toHaveLength(2)

    probe.runAttachCommand('third.png')
    expect(probe.currentBinding.commandNotice).toContain('At most 2 images')
    expect(session.preparedImagePaths).toHaveLength(2)
    probe.runAttachCommand('remove 3')
    expect(probe.currentBinding.commandNotice).toBe('No staged image 3')
    probe.runAttachCommand('remove 1')
    expect(probe.currentBinding.commandNotice).toBe('Removed a')
    expect(probe.currentBinding.promptImages.map(image => image.name)).toEqual(['second.png'])
    probe.runAttachCommand('remove')
    expect(probe.currentBinding.commandNotice).toBe('Use /attach remove N')
    probe.runAttachCommand('clear')
    expect(probe.currentBinding.commandNotice).toBe('Cleared 1 staged image')

    probe.runAttachCommand('first.png')
    await waitForAttachment()
    probe.runAttachCommand('second.png')
    await waitForAttachment()
    probe.runAttachCommand('clear')
    expect(probe.currentBinding.commandNotice).toBe('Cleared 2 staged images')

    probe.runAttachCommand('""')
    expect(probe.currentBinding.commandNotice).toBe('Image path is empty')
    session.prepareImageOverride = async () => { throw 'decode failed' }
    probe.runAttachCommand(' broken.png')
    await waitForAttachment()
    expect(probe.currentBinding.commandNotice).toBe('Image not attached: decode failed')
    expect(probe.currentBinding.prompt.text).toBe('/attach broken.png')

    probe.currentBinding.prompt = createPromptEditorState('/attachment')
    probe.submitPrompt()
    await waitFor(() => session.submitted.length === 1)
    expect(session.submitted[0]?.input).toEqual({ text: '/attachment' })

    session.attachmentState = { available: false }
    probe.runAttachCommand('offline.png')
    expect(probe.currentBinding.commandNotice).toBe('Image attachments are unavailable')
    await controller.requestExit('user')

    const missingSnapshot = new FakeSession('missing-attachment-snapshot')
    Object.defineProperty(missingSnapshot, 'attachmentSnapshot', {
      configurable: true,
      value: undefined,
    })
    const missingSnapshotProduct = createProduct({ session: missingSnapshot })
    await missingSnapshotProduct.controller.start()
    const missingSnapshotProbe = missingSnapshotProduct.controller as unknown as {
      runAttachCommand(rawInput: string): void
      currentBinding: { commandNotice?: string }
    }
    missingSnapshotProbe.runAttachCommand('panel.png')
    expect(missingSnapshotProbe.currentBinding.commandNotice)
      .toBe('Image attachments are unavailable')
    await missingSnapshotProduct.controller.requestExit('user')

    const missingPrepare = new FakeSession('missing-image-prepare')
    missingPrepare.attachmentState = { available: true }
    Object.defineProperty(missingPrepare, 'prepareImage', {
      configurable: true,
      value: undefined,
    })
    const missingPrepareProduct = createProduct({ session: missingPrepare })
    await missingPrepareProduct.controller.start()
    const missingPrepareProbe = missingPrepareProduct.controller as unknown as {
      runAttachCommand(rawInput: string): void
      currentBinding: { commandNotice?: string }
    }
    missingPrepareProbe.runAttachCommand('panel.png')
    expect(missingPrepareProbe.currentBinding.commandNotice)
      .toBe('Image attachments are unavailable')
    await missingPrepareProduct.controller.requestExit('user')
  })

  it('blocks submit during image loading and escalates repeated Ctrl+C safely', async () => {
    const session = new FakeSession('cancel-image-load')
    session.attachmentState = { available: true, maxImagesPerMessage: 2 }
    const gate = Promise.withResolvers<PromptImageInput>()
    session.prepareImageOverride = () => gate.promise
    const product = createProduct({ session })
    await product.controller.start()
    expect(product.controller.pendingAttachmentCount).toBe(0)

    product.terminal.input({ type: 'insert', text: '/attach pending.png' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => product.controller.pendingAttachmentCount === 1)
    product.terminal.input({ type: 'insert', text: 'send after loading' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => product.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Wait for the image to finish loading',
    ) === true)
    expect(session.submitted).toEqual([])

    product.terminal.input({ type: 'interrupt' })
    expect(session.preparedImageSignals[0]?.aborted).toBe(true)
    expect(product.application.forceCount).toBe(0)
    gate.resolve({
      name: 'pending.png',
      mediaType: 'image/png',
      bytes: 1,
      data: new Uint8Array([1]),
    })
    await waitFor(() => product.controller.pendingAttachmentCount === 0)
    expect((product.controller as unknown as {
      currentBinding: { promptImages: PromptImageInput[] }
    }).currentBinding.promptImages).toEqual([])
    await product.controller.requestExit('user')

    const forced = new FakeSession('force-image-load')
    forced.attachmentState = { available: true }
    forced.prepareImageOverride = () => new Promise(() => undefined)
    const forcedProduct = createProduct({ session: forced })
    await forcedProduct.controller.start()
    forcedProduct.terminal.input({ type: 'insert', text: '/attach stuck.png' })
    forcedProduct.terminal.input({ type: 'submit' })
    await waitFor(() => forcedProduct.controller.pendingAttachmentCount === 1)
    forcedProduct.terminal.input({ type: 'interrupt' })
    forcedProduct.terminal.input({ type: 'interrupt' })
    await expect(forcedProduct.controller.wait()).resolves.toMatchObject({
      ok: false,
      reason: 'forced',
    })
    expect(forcedProduct.application.forceCount).toBe(1)
    expect(forcedProduct.controller.pendingAttachmentCount).toBe(1)
  })

  it('does not overwrite newer drafts when image, prompt, or command work finishes late', async () => {
    const image = (name: string, bytes = 1): PromptImageInput => ({
      name,
      mediaType: 'image/png',
      bytes,
      data: new Uint8Array(bytes),
    })
    type AttachmentBindingProbe = {
      prompt: ReturnType<typeof createPromptEditorState>
      promptImages: PromptImageInput[]
      commandNotice?: string
      attachmentTask: Promise<void> | undefined
      attachmentAbort: AbortController | undefined
    }

    const attachmentSession = new FakeSession('late-image-work')
    attachmentSession.attachmentState = {
      available: true,
      maxMessageImageBytes: 3,
    }
    const aggregate = Promise.withResolvers<PromptImageInput>()
    attachmentSession.prepareImageOverride = () => aggregate.promise
    const attachmentProduct = createProduct({ session: attachmentSession })
    await attachmentProduct.controller.start()
    const attachmentProbe = attachmentProduct.controller as unknown as {
      currentBinding: AttachmentBindingProbe
      runAttachCommand(rawInput: string): void
    }

    attachmentProbe.runAttachCommand(' large.png')
    attachmentProduct.terminal.input({ type: 'insert', text: 'new aggregate draft' })
    aggregate.resolve(image('large.png', 4))
    await waitFor(() => attachmentProduct.controller.pendingAttachmentCount === 0)
    expect(attachmentProbe.currentBinding.prompt.text).toBe('new aggregate draft')
    expect(attachmentProbe.currentBinding.commandNotice).toContain('aggregate image-byte limit')

    const rejected = Promise.withResolvers<PromptImageInput>()
    attachmentSession.prepareImageOverride = () => rejected.promise
    attachmentProbe.currentBinding.prompt = createPromptEditorState()
    attachmentProbe.runAttachCommand(' broken.png')
    attachmentProduct.terminal.input({ type: 'insert', text: 'new error draft' })
    rejected.reject(new Error('decode failed late'))
    await waitFor(() => attachmentProduct.controller.pendingAttachmentCount === 0)
    expect(attachmentProbe.currentBinding.prompt.text).toBe('new error draft')
    expect(attachmentProbe.currentBinding.commandNotice).toContain('decode failed late')

    const stale = Promise.withResolvers<PromptImageInput>()
    attachmentSession.prepareImageOverride = () => stale.promise
    attachmentProbe.currentBinding.prompt = createPromptEditorState()
    attachmentProbe.runAttachCommand(' stale.png')
    const staleTask = attachmentProbe.currentBinding.attachmentTask!
    const replacementTask = Promise.resolve()
    const replacementAbort = new AbortController()
    attachmentProbe.currentBinding.attachmentTask = replacementTask
    attachmentProbe.currentBinding.attachmentAbort = replacementAbort
    stale.resolve(image('stale.png'))
    await staleTask
    expect(attachmentProbe.currentBinding.attachmentTask).toBe(replacementTask)
    expect(attachmentProbe.currentBinding.attachmentAbort).toBe(replacementAbort)
    attachmentProbe.currentBinding.attachmentTask = undefined
    attachmentProbe.currentBinding.attachmentAbort = undefined
    await attachmentProduct.controller.requestExit('user')

    const promptSession = new FakeSession('late-prompt-work')
    promptSession.attachmentState = { available: true }
    const promptProduct = createProduct({ session: promptSession })
    await promptProduct.controller.start()
    promptProduct.terminal.input({ type: 'insert', text: '/attach original.png' })
    promptProduct.terminal.input({ type: 'submit' })
    await waitFor(() => promptProduct.controller.pendingAttachmentCount === 0)
    const promptGate = deferred()
    promptSession.submitGate = promptGate.promise
    promptSession.throwOnSubmit = new DshSubmitRejectedError(
      'model changed while sending',
      'MODEL_DOES_NOT_SUPPORT_IMAGES',
    )
    promptProduct.terminal.input({ type: 'insert', text: 'old prompt' })
    promptProduct.terminal.input({ type: 'submit' })
    await waitFor(() => promptSession.submitted.length === 1)
    const promptProbe = promptProduct.controller as unknown as {
      currentBinding: { promptImages: PromptImageInput[] }
    }
    promptProbe.currentBinding.promptImages = [image('newer.png')]
    promptGate.resolve()
    await waitFor(() => promptProduct.controller.pendingSubmitCount === 0)
    expect(promptProbe.currentBinding.promptImages.map(candidate => candidate.name))
      .toEqual(['newer.png'])
    await promptProduct.controller.requestExit('user')

    const command: DshCommandDescriptor = {
      name: 'inspect-image',
      description: 'Inspect an image',
      input: { hint: '<image>', images: true },
    }
    const commandSession = new FakeSession('late-command-work')
    commandSession.attachmentState = { available: true, maxImagesPerMessage: 4 }
    commandSession.commands = [command]
    const commandProduct = createProduct({ session: commandSession })
    await commandProduct.controller.start()
    const commandProbe = commandProduct.controller as unknown as {
      currentBinding: {
        prompt: ReturnType<typeof createPromptEditorState>
        promptImages: PromptImageInput[]
        commandNotice?: string
      }
    }
    const stage = async (name: string) => {
      const expected = commandSession.preparedImagePaths.length + 1
      commandProduct.terminal.input({ type: 'insert', text: `/attach ${name}` })
      commandProduct.terminal.input({ type: 'submit' })
      await waitFor(() => commandSession.preparedImagePaths.length === expected)
      await waitFor(() => commandProduct.controller.pendingAttachmentCount === 0)
    }

    await stage('original.png')
    const execution = Promise.withResolvers<DshCommandExecution | undefined>()
    commandSession.executeCommandOverride = () => execution.promise
    commandProduct.terminal.input({ type: 'insert', text: '/inspect-image target' })
    commandProduct.terminal.input({ type: 'submit' })
    await waitFor(() => commandSession.commandExecutions.length === 1)
    commandProbe.currentBinding.promptImages = [image('replacement.png')]
    commandProduct.terminal.input({ type: 'insert', text: 'replacement command draft' })
    execution.resolve({
      commandId: 'late-command-error',
      result: { kind: 'error', text: 'late command failure' },
    })
    await waitFor(() => commandProduct.controller.pendingCommandCount === 0)
    expect(commandProbe.currentBinding.promptImages.map(candidate => candidate.name))
      .toEqual(['replacement.png'])
    expect(commandProbe.currentBinding.prompt.text).toBe('replacement command draft')

    commandProbe.currentBinding.prompt = createPromptEditorState()
    commandProbe.currentBinding.promptImages = []
    commandSession.executeCommandOverride = async () => ({
      commandId: 'missing-error-text',
      result: { kind: 'error' },
    } as unknown as DshCommandExecution)
    commandProduct.terminal.input({ type: 'insert', text: '/inspect-image target' })
    commandProduct.terminal.input({ type: 'submit' })
    await waitFor(() => commandProduct.controller.pendingCommandCount === 0)
    expect(commandProbe.currentBinding.commandNotice).toBe('Command failed: request rejected')

    await stage('rejected.png')
    commandSession.executeCommandOverride = () => Promise.reject(new Error('transport rejected'))
    commandProduct.terminal.input({ type: 'insert', text: '/inspect-image target' })
    commandProduct.terminal.input({ type: 'submit' })
    await waitFor(() => commandProduct.controller.pendingCommandCount === 0)
    expect(commandProbe.currentBinding.prompt.text).toBe('/inspect-image target')
    expect(commandProbe.currentBinding.commandNotice).toContain('transport rejected')

    commandProbe.currentBinding.prompt = createPromptEditorState()
    commandProbe.currentBinding.promptImages = []
    await stage('rejected-with-replacement.png')
    const commandRejection = Promise.withResolvers<DshCommandExecution | undefined>()
    commandSession.executeCommandOverride = () => commandRejection.promise
    commandProduct.terminal.input({ type: 'insert', text: '/inspect-image target' })
    commandProduct.terminal.input({ type: 'submit' })
    await waitFor(() => commandSession.commandExecutions.length === 4)
    commandProbe.currentBinding.promptImages = [image('new-command-image.png')]
    commandProduct.terminal.input({ type: 'insert', text: 'new command text' })
    commandRejection.reject(new Error('late transport rejection'))
    await waitFor(() => commandProduct.controller.pendingCommandCount === 0)
    expect(commandProbe.currentBinding.promptImages.map(candidate => candidate.name))
      .toEqual(['new-command-image.png'])
    expect(commandProbe.currentBinding.prompt.text).toBe('new command text')
    await commandProduct.controller.requestExit('user')
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
      'Mode',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('◆ Standard')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('current · default · system')
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
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Mode') === true)
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
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Mode') === true)
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
      { type: 'toggle-transcript-details' },
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
      '1 Allow once',
    ) === true)
    expect(terminal.frames.at(-1)?.lines[0]).not.toContain('Mode')

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
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Mode') === true)
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

  it('opens no-input /mode locally, keeps official arguments, and contains cancellation', async () => {
    const official = new FakeSession()
    official.modeState = selectableModeSnapshot()
    official.commands = [{ name: 'mode', description: 'Official mode command', input: { hint: '<mode>' } }]
    const first = createProduct({ session: official })
    await first.controller.start()
    first.terminal.input({ type: 'insert', text: '/mode' })
    first.terminal.input({ type: 'submit' })
    await waitFor(() => official.modeRefreshSignals.length === 1)
    expect(official.commandExecutions).toEqual([])
    first.terminal.input({ type: 'escape' })
    first.terminal.input({ type: 'insert', text: '/mode code' })
    first.terminal.input({ type: 'submit' })
    await waitFor(() => official.commandExecutions.length === 1)
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Skills') === true)
    const opened = terminal.frames.at(-1)?.lines.join('\n') ?? ''
    expect(opened).toContain('Invoke  user ✓')
    expect(opened).not.toContain('Source  workspace · filesystem')
    expect(opened).not.toContain('Up/Down')

    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'insert', text: 'research' })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'move-home' })
    terminal.input({ type: 'move-end' })
    terminal.input({ type: 'delete' })
    terminal.input({ type: 'submit' })
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Skills') === true)
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Skills') === true)

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
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('Skills')

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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Skills') === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'newline' })
    terminal.input({ type: 'save-default' })
    terminal.input({ type: 'toggle-reasoning' })
    terminal.input({ type: 'toggle-transcript-details' })
    terminal.input({ type: 'toggle-goal-actions' })
    terminal.input({ type: 'toggle-activity' })
    terminal.input({ type: 'ignored' })
    terminal.input({ type: 'escape' })

    terminal.input({ type: 'insert', text: '/skills' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Skills') === true)
    terminal.input({ type: 'interrupt' })

    terminal.input({ type: 'insert', text: '/skills' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Skills') === true)
    session.changeSkills(selectableSkillsSnapshot({ skills: [] }))
    terminal.input({ type: 'submit' })
    expect((controller as unknown as { commandNotice?: string }).commandNotice)
      .toBe('No skill is available to insert')
    terminal.input({ type: 'escape' })

    session.changeSkills(selectableSkillsSnapshot())
    terminal.input({ type: 'insert', text: '/skills' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Skills') === true)
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

describe('DshTuiController tool capability directory', () => {
  it('opens, filters, and closes the exact-Agent catalog without executing tools', async () => {
    const session = new FakeSession()
    session.toolsState = selectableToolsSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 120, rows: 24 })

    terminal.input({ type: 'insert', text: '/too' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/tools') === true)
    terminal.input({ type: 'insert', text: 'ls' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Tools',
    ) === true)
    const opened = terminal.frames.at(-1)!
    expectWorkspace(opened, 'Tools')
    expect(opened.lines.join('\n')).toContain('mcp__github__create_issue')
    expect(opened.lines.join('\n')).not.toContain('Code transport')
    expect(session.submitted).toEqual([])
    expect(session.commandExecutions).toEqual([])

    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'insert', text: 'github owner' })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'move-home' })
    terminal.input({ type: 'move-end' })
    terminal.input({ type: 'delete' })
    terminal.input({ type: 'backspace' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'mcp__github__create_issue',
    ) === true)
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'newline' })
    terminal.input({ type: 'complete' })
    terminal.input({ type: 'save-default' })
    terminal.input({ type: 'toggle-reasoning' })
    terminal.input({ type: 'toggle-transcript-details' })
    terminal.input({ type: 'toggle-goal-actions' })
    terminal.input({ type: 'toggle-activity' })
    terminal.input({ type: 'ignored' })
    terminal.input({ type: 'escape' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))

    terminal.input({ type: 'insert', text: '/tools unexpected' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /tools does not accept input',
    ) === true)
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/toolsx' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(item => item.input.text === '/toolsx'))
    terminal.input({ type: 'insert', text: 'ordinary prompt' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(item => item.input.text === 'ordinary prompt'))
    await controller.requestExit('user')
  })

  it('reconciles registry changes, closes for interactions, and yields to official /tools', async () => {
    const session = new FakeSession()
    session.toolsState = selectableToolsSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 120, rows: 24 })
    terminal.input({ type: 'insert', text: '/tools' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Tools',
    ) === true)

    session.changeTools(selectableToolsSnapshot({
      generation: 2,
      stale: true,
      error: 'registry snapshot failed',
    }))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'registry snapshot failed',
    ) === true)

    session.interactionsSource.push({
      type: 'interaction/snapshot',
      sessionId: session.sessionId,
      pending: [{
        id: 'approval-1',
        kind: 'approval',
        sessionId: session.sessionId,
        approvalId: 'approval-1',
        toolName: 'write_file',
        callId: 'call-1',
      }],
    })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Allow disabled') === true)
    expect(terminal.frames.at(-1)?.lines[0]).not.toContain('Tools')

    session.interactionsSource.push(snapshot([], session.sessionId))
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    await waitFor(() => binding.interactionEditor.active === undefined)
    session.changeTools(selectableToolsSnapshot({ generation: 3 }))
    terminal.input({ type: 'insert', text: '/tools' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Tools',
    ) === true)
    session.changeCommands([{ name: 'tools', description: 'Official Tools command' }])
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Official /tools command is now registered',
    ) === true)
    terminal.input({ type: 'insert', text: '/tools' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.some(call => call.line === '/tools'))
    await controller.requestExit('user')
  })

  it('contains unavailable compatibility ports and subscription teardown failures', async () => {
    const noPort = new FakeSession()
    Object.defineProperty(noPort, 'toolsSnapshot', { value: undefined })
    Object.defineProperty(noPort, 'onToolsChanged', { value: undefined })
    const first = createProduct({ session: noPort })
    await first.controller.start()
    const unavailable = first.controller as unknown as {
      openLocalToolBrowser(): void
    }
    unavailable.openLocalToolBrowser()
    expect((first.controller as unknown as { commandNotice?: string }).commandNotice)
      .toBe('Tool capabilities are unavailable in this Agent composition')
    await first.controller.requestExit('user')

    const session = new FakeSession()
    session.toolsState = selectableToolsSnapshot()
    const second = createProduct({ session })
    await second.controller.start()
    const staleListener = [...session.toolsListeners][0]!

    const backgroundPort = new FakeSession('tools-background')
    backgroundPort.toolsState = selectableToolsSnapshot()
    const background = createSessionBinding(101, backgroundPort, 'background', async () => {})
    background.tools = backgroundPort.toolsSnapshot()
    background.toolsSubscription = () => { throw new Error('background tools unsubscribe failed') }
    const internal = second.controller as unknown as {
      bindings: Set<SessionBinding>
      handleToolsChanged(binding: SessionBinding): void
      closeBinding(binding: SessionBinding): Promise<void>
    }
    internal.bindings.add(background)
    internal.handleToolsChanged(background)
    await expect(internal.closeBinding(background)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'background tools unsubscribe failed' })],
    })

    session.throwOnToolsUnsubscribe = new Error('tools unsubscribe failed')
    const result = await second.controller.requestExit('user')
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.some(issue => (
      issue.phase === 'stop-input'
      && String(issue.error).includes('tools unsubscribe failed')
    ))).toBe(true)
    expect(() => staleListener()).not.toThrow()
  })
})

describe('DshTuiController MCP capability surface', () => {
  it('browses exact-Agent MCP tools locally and yields focus to Session interactions', async () => {
    const session = new FakeSession()
    session.toolsState = selectableToolsSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 140, rows: 30 })

    terminal.input({ type: 'insert', text: '/mc' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/mcp') === true)
    terminal.input({ type: 'complete' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'MCP',
    ) === true)
    expectWorkspace(terminal.frames.at(-1)!, 'MCP')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('create_issue')
    expect(session.submitted).toEqual([])
    expect(session.commandExecutions).toEqual([])

    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'insert', text: 'github owner' })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'move-home' })
    terminal.input({ type: 'move-end' })
    terminal.input({ type: 'delete' })
    terminal.input({ type: 'backspace' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'newline' })
    terminal.input({ type: 'complete' })
    terminal.input({ type: 'save-default' })
    terminal.input({ type: 'toggle-reasoning' })
    terminal.input({ type: 'toggle-transcript-details' })
    terminal.input({ type: 'toggle-goal-actions' })
    terminal.input({ type: 'toggle-activity' })
    terminal.input({ type: 'ignored' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('create_issue') === true)
    terminal.input({ type: 'escape' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))
    terminal.input({ type: 'insert', text: '/mcp' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'MCP',
    ) === true)

    session.changeTools(selectableToolsSnapshot({
      generation: 2,
      stale: true,
      error: 'registry snapshot failed',
    }))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'registry snapshot failed',
    ) === true)

    session.interactionsSource.push(snapshot([{
      id: 'approval:mcp-focus',
      kind: 'approval',
      sessionId: session.sessionId,
      approvalId: 'approval-mcp-focus',
      toolName: 'mcp__github__create_issue',
      callId: 'mcp-focus',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '1 Allow once',
    ) === true)
    expect(terminal.frames.at(-1)?.lines[0]).not.toContain('MCP')

    session.interactionsSource.push(snapshot())
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '1 Allow once',
    ) === false)
    terminal.input({ type: 'insert', text: '/mcp' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/mcp') === true)
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'MCP',
    ) === true)
    terminal.input({ type: 'interrupt' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))

    terminal.input({ type: 'insert', text: '/mcp unexpected' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /mcp does not accept input',
    ) === true)
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/mcpx' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(item => item.input.text === '/mcpx'))

    terminal.input({ type: 'insert', text: '/mcp' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'MCP',
    ) === true)
    session.changeCommands([{ name: 'mcp', description: 'Official MCP command' }])
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Official /mcp command is now registered',
    ) === true)
    terminal.input({ type: 'insert', text: '/mcp' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.some(call => call.line === '/mcp'))

    await controller.requestExit('user')
  })

  it('contains an unavailable compatibility port without claiming MCP health', async () => {
    const session = new FakeSession()
    Object.defineProperty(session, 'toolsSnapshot', { value: undefined })
    Object.defineProperty(session, 'onToolsChanged', { value: undefined })
    const { controller } = createProduct({ session })
    await controller.start()
    const internal = controller as unknown as {
      openLocalMcpCapabilityBrowser(): void
      commandNotice?: string
    }
    internal.openLocalMcpCapabilityBrowser()
    expect(internal.commandNotice).toBe(
      'MCP capabilities are unavailable in this Agent composition',
    )
    await controller.requestExit('user')
  })
})

describe('DshTuiController Runtime Library', () => {
  function formSettings(): FakeSettings {
    const settings = new FakeSettings()
    settings.snapshot = { ...settings.snapshot, namespaces: [{
      namespace: 'dsh-tui', schema: DSH_TUI_PREFERENCES_SCHEMA.toJSON(),
      value: structuredClone(DEFAULT_DSH_TUI_PREFERENCES),
      base: structuredClone(DEFAULT_DSH_TUI_PREFERENCES), user: {},
      revision: 7, applies: 'live', secrets: [],
    }] }
    return settings
  }

  it.each(['disconnect', 'remove'] as const)('requires readable provider %s confirmation while keeping cancellation available', async action => {
    const providers = new FakeProviders()
    providers.snapshot = { ...providers.snapshot, providers: [{ ...providers.snapshot.providers[0]!,
      canDisconnect: true, credential: { kind: 'api-key', configured: true, writable: true },
      configuration: { namespace: 'llm-pi-ai', path: ['providers', 'deepseek-official'], revision: 3, writable: true },
    }] }
    const settings = formSettings()
    settings.snapshot = { ...settings.snapshot, namespaces: [...settings.snapshot.namespaces, {
      namespace: 'llm-pi-ai', schema: {}, value: { providers: { 'deepseek-official': {} } },
      user: { providers: { 'deepseek-official': {} } }, revision: 3, applies: 'live', secrets: [],
    }] }
    const { controller, terminal } = createProduct({ settings, providers })
    const internal = controller as unknown as { settingsProviders: import('../src/settings/providers-controller.ts').SettingsProvidersController }
    const openConfirmation = () => {
      const dialog = internal.settingsProviders.view()!.dialog!
      const target = dialog.rows.findIndex(row => row.id === action)
      expect(target).toBeGreaterThanOrEqual(0)
      for (let index = dialog.selection; index < target; index++) terminal.input({ type: 'complete' })
      terminal.input({ type: 'submit' })
    }
    await controller.start()
    terminal.resize({ columns: 80, rows: 6 })
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'insert', text: ']' })
    await waitFor(() => controller.pendingProviderCount === 0)
    terminal.input({ type: 'insert', text: 'n' })
    terminal.input({ type: 'submit' })
    openConfirmation()
    terminal.input({ type: 'move-right' })
    expect(internal.settingsProviders.view()?.dialog?.selection).toBe(0)
    terminal.input({ type: 'submit' })
    expect(internal.settingsProviders.view()?.dialog?.kind).toBe('manage')
    openConfirmation()
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingProviderCount === 0)
    expect(providers.disconnectCalls).toEqual([])
    expect(settings.mutations).toEqual([])
    expect(internal.settingsProviders.view()?.dialog?.kind).toBe(action === 'disconnect' ? 'confirm-disconnect' : 'confirm-remove')
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'submit' })
    expect(internal.settingsProviders.view()?.dialog?.kind).toBe('manage')
    openConfirmation()
    terminal.input({ type: 'complete' })
    terminal.resize({ columns: 120, rows: 30 })
    await waitFor(() => terminal.frames.at(-1)?.settingsWorkspace?.modal?.kind === 'confirmation')
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingProviderCount === 0)
    if (action === 'disconnect') expect(providers.disconnectCalls).toEqual([{ provider: 'deepseek-official', signal: expect.any(AbortSignal) }])
    else expect(settings.mutations).toEqual([{ namespace: 'llm-pi-ai', path: ['providers', 'deepseek-official'], expectedRevision: 3, operation: 'unset' }])
    await controller.requestExit('user')
  })

  it.each([false, true])('keeps provider form focus and scoped advanced navigation (reverse=%s)', async reverse => {
    const providers = new FakeProviders()
    providers.snapshot = { ...providers.snapshot, providers: [{ ...providers.snapshot.providers[0]!,
      configuration: { namespace: 'llm-pi-ai', path: ['providers', 'deepseek-official'], revision: 1, writable: true },
    }] }
    const { controller, terminal } = createProduct({ settings: formSettings(), providers })
    const internal = controller as unknown as { runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState }
    await controller.start()
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'insert', text: ']' })
    await waitFor(() => controller.pendingProviderCount === 0)
    terminal.input({ type: 'complete', ...(reverse ? { reverse: true } : {}) })
    expect(internal.runtimeLibrary.page!.focus).toBe(reverse ? 'tabs' : 'actions')
    if (reverse) {
      terminal.input({ type: 'submit' })
      terminal.input({ type: 'move-down' })
      terminal.input({ type: 'submit' })
    } else terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.settingsWorkspace?.modal !== undefined)
    if (!reverse) terminal.input({ type: 'submit' })
    terminal.input({ type: 'insert', text: 'a' })
    expect(internal.runtimeLibrary.page).toBeUndefined()
    expect(internal.runtimeLibrary.settingsSelection).toBe('llm-pi-ai')
    expect(internal.runtimeLibrary.focus).toBe('detail')
    await controller.requestExit('user')
  })

  it('keeps Settings drafts and their discard confirmation when leaving the provider page', async () => {
    const settings = formSettings()
    const providers = new FakeProviders()
    const { controller, terminal } = createProduct({ settings, providers })
    const internal = controller as unknown as { runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState }
    await controller.start()
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-right' })
    expect(Object.keys(internal.runtimeLibrary.page!.drafts)).not.toHaveLength(0)
    terminal.input({ type: 'insert', text: ']' })
    await waitFor(() => controller.pendingProviderCount === 0)
    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'insert', text: 'a' })
    expect(internal.runtimeLibrary.page!.notice).toContain('请先保存或取消')
    terminal.input({ type: 'insert', text: 'q' })
    expect(internal.runtimeLibrary.page!.confirmation).toBe('discard')
    await waitFor(() => terminal.frames.at(-1)?.settingsWorkspace?.modal?.kind === 'confirmation')
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '[' })
    expect(internal.runtimeLibrary.page!.section).toBe('general')
    expect(Object.keys(internal.runtimeLibrary.page!.drafts)).not.toHaveLength(0)
    expect(settings.mutations).toEqual([])
    await controller.requestExit('user')
  })

  it('keeps provider keys from changing hidden schema and cleans up subscriptions at exit', async () => {
    const providers = new FakeProviders()
    const { controller, terminal } = createProduct({ settings: formSettings(), providers })
    const internal = controller as unknown as { runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState }
    await controller.start()
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'insert', text: ']' })
    await waitFor(() => controller.pendingProviderCount === 0)
    terminal.input({ type: 'move-right' })
    expect(internal.runtimeLibrary.page!.picker).toBeUndefined()
    terminal.input({ type: 'toggle-transcript-details' })
    expect(internal.runtimeLibrary.page).toBeUndefined()
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'insert', text: ']' })
    await waitFor(() => controller.pendingProviderCount === 0)
    providers.throwOnUnsubscribe = new Error('provider cleanup failure')
    const result = await controller.requestExit('user')
    expect(result.ok).toBe(true)
    expect(providers.listeners.size).toBe(0)
  })

  it('opens the provider directory as a modal, keeps its keys local, and returns to Settings', async () => {
    const providers = new FakeProviders()
    const { controller, terminal, session } = createProduct({ settings: formSettings(), providers })
    const internal = controller as unknown as { runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState }
    await controller.start()
    terminal.resize({ columns: 100, rows: 28 })
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'insert', text: ']' })
    await waitFor(() => terminal.frames.at(-1)?.settingsWorkspace?.headerAction !== undefined)
    expect(terminal.frames.at(-1)!.lines.join('\n')).toContain('添加提供商')
    expect(terminal.frames.at(-1)!.lines.join('\n')).not.toContain('supportsStore')
    terminal.input({ type: 'insert', text: 'n' })
    await waitFor(() => terminal.frames.at(-1)?.settingsWorkspace?.modal?.title === '添加提供商')
    terminal.input({ type: 'insert', text: 'DeepSeek' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.settingsWorkspace?.modal?.title === 'DeepSeek')
    terminal.input({ type: 'insert', text: ']' })
    terminal.input({ type: 'complete' })
    expect(internal.runtimeLibrary.page!.section).toBe('models')
    terminal.input({ type: 'insert', text: 'q' })
    await waitFor(() => terminal.frames.at(-1)?.settingsWorkspace?.modal === undefined)
    expect(providers.connectCalls).toEqual([])
    expect(session.submitted).toEqual([])
    terminal.input({ type: 'insert', text: 'q' })
    expect(internal.runtimeLibrary.open).toBe(false)
    await controller.requestExit('user')
  })

  it.each(['arrows', 'vim', 'both'] as const)('honors %s navigation in Settings without intercepting typed search and editor text', async navigationKeys => {
    const settings = formSettings()
    settings.snapshot = { ...settings.snapshot, namespaces: [...settings.snapshot.namespaces, {
      namespace: 'shell', schema: { type: 'object', dict: { cwd: { type: 'string' } } },
      value: { cwd: '' }, revision: 1, applies: 'live', secrets: [],
    }] }
    const { controller, terminal, session } = createProduct({ settings, preferences: {
      snapshot: () => ({ ...DEFAULT_DSH_TUI_PREFERENCES, navigationKeys }), onChanged: () => () => {},
    } })
    const internal = controller as unknown as { runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState }
    await controller.start()
    terminal.resize({ columns: 120, rows: 30 })
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'insert', text: 'j' })
    expect(internal.runtimeLibrary.page!.selection).toBe(navigationKeys === 'arrows' ? 0 : 1)
    terminal.input({ type: 'insert', text: 'k' })
    terminal.input({ type: 'move-down' })
    expect(internal.runtimeLibrary.page!.selection).toBe(navigationKeys === 'vim' ? 0 : 1)
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'insert', text: 'l' })
    expect(Object.values(internal.runtimeLibrary.page!.drafts).map(draft => draft.value))
      .toEqual(navigationKeys === 'arrows' ? [] : ['cordis'])
    terminal.input({ type: 'insert', text: 'h' })
    expect(internal.runtimeLibrary.page!.drafts).toEqual({})
    terminal.input({ type: 'insert', text: 'j', paste: true })
    expect(internal.runtimeLibrary.page!.selection).toBe(0)
    terminal.input({ type: 'insert', text: '/' })
    for (const text of 'hjklq') terminal.input({ type: 'insert', text })
    terminal.input({ type: 'move-left' })
    expect(internal.runtimeLibrary.page!.query).toMatchObject({ text: 'hjklq', cursor: 4 })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: ']' })
    terminal.input({ type: 'insert', text: ']' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'toggle-transcript-details' })
    expect(internal.runtimeLibrary.page!.notice).toContain('请先保存或取消')
    for (const text of 'hjklq') terminal.input({ type: 'insert', text })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'insert', text: 'X' })
    expect(internal.runtimeLibrary.page!.editor?.input.text).toBe('hjklXq')
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'toggle-transcript-details' })
    expect(internal.runtimeLibrary.page).toMatchObject({ confirmation: 'discard', confirmIndex: 0 })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'submit' })
    expect(internal.runtimeLibrary.open).toBe(false)
    expect(settings.mutations).toEqual([])
    expect(session.submitted).toEqual([])
    await controller.requestExit('user')
  })

  it.each(['arrows', 'vim', 'both'] as const)('keeps Settings select lists modal with %s navigation and contextual q exit', async navigationKeys => {
    const settings = formSettings()
    const { controller, terminal, session } = createProduct({ settings, preferences: {
      snapshot: () => ({ ...DEFAULT_DSH_TUI_PREFERENCES, navigationKeys }), onChanged: () => () => {},
    } })
    const internal = controller as unknown as { runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState }
    await controller.start()
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'insert', text: 'q' })
    expect(internal.runtimeLibrary.open).toBe(false)
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'submit' })
    expect(internal.runtimeLibrary.page).toMatchObject({ picker: { selection: 0 }, drafts: {} })
    terminal.input({ type: 'insert', text: 'j' })
    expect(internal.runtimeLibrary.page!.picker?.selection).toBe(navigationKeys === 'arrows' ? 0 : 1)
    terminal.input({ type: 'insert', text: 'k' })
    terminal.input({ type: 'move-down' })
    expect(internal.runtimeLibrary.page!.picker?.selection).toBe(navigationKeys === 'vim' ? 0 : 1)
    terminal.input({ type: 'toggle-transcript-details' })
    expect(internal.runtimeLibrary.page!.picker).toBeDefined()
    expect(internal.runtimeLibrary.page!.notice).toContain('请先保存或取消')
    terminal.input({ type: 'insert', text: 'q' })
    expect(internal.runtimeLibrary.page!.picker).toBeUndefined()
    expect(internal.runtimeLibrary.page!.drafts).toEqual({})
    expect(internal.runtimeLibrary.open).toBe(true)
    terminal.input({ type: 'submit' })
    terminal.input(navigationKeys === 'vim' ? { type: 'insert', text: 'j' } : { type: 'move-down' })
    terminal.input({ type: 'submit' })
    expect(Object.values(internal.runtimeLibrary.page!.drafts).map(draft => draft.value)).toEqual(['cordis'])
    terminal.input({ type: 'insert', text: 'q' })
    expect(internal.runtimeLibrary.page!.confirmation).toBe('discard')
    terminal.input({ type: 'insert', text: 'q' })
    expect(internal.runtimeLibrary.page!.confirmation).toBeUndefined()
    expect(Object.keys(internal.runtimeLibrary.page!.drafts)).toHaveLength(1)
    terminal.input({ type: 'insert', text: 'q' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'submit' })
    expect(internal.runtimeLibrary.open).toBe(false)
    expect(settings.mutations).toEqual([])
    expect(session.submitted).toEqual([])
    await controller.requestExit('user')
  })

  it.each(['set', 'unset'] as const)('requires readable permission confirmation before a %s enables full access for new sessions', async operation => {
    const settings = formSettings()
    settings.snapshot = { ...settings.snapshot, namespaces: [{
      namespace: 'permission', schema: { type: 'object', dict: { defaultPreset: { type: 'union', list: [
        { type: 'const', value: 'workspace-write' }, { type: 'const', value: 'danger-full-access' },
      ] } } }, value: { defaultPreset: 'workspace-write' },
      base: { defaultPreset: operation === 'unset' ? 'danger-full-access' : 'workspace-write' },
      user: { defaultPreset: 'workspace-write' }, revision: 4, applies: 'live', secrets: [],
    }] }
    const { controller, terminal, session } = createProduct({ settings })
    const internal = controller as unknown as { runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState }
    await controller.start()
    terminal.resize({ columns: 80, rows: 6 })
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    if (operation === 'set') terminal.input({ type: 'move-right' })
    else {
      terminal.input({ type: 'complete' })
      terminal.input({ type: 'move-right' })
      terminal.input({ type: 'move-right' })
      terminal.input({ type: 'submit' })
      terminal.input({ type: 'move-right' })
      terminal.input({ type: 'submit' })
    }
    terminal.input({ type: 'save-default' })
    expect(internal.runtimeLibrary.page).toMatchObject({ confirmation: 'permission', confirmIndex: 0 })
    terminal.input({ type: 'submit' })
    expect(settings.mutations).toEqual([])
    terminal.input({ type: 'save-default' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'submit' })
    expect(internal.runtimeLibrary.page!.error).toContain('请放大终端')
    expect(settings.mutations).toEqual([])
    terminal.resize({ columns: 120, rows: 30 })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('新会话可访问工作目录外的文件并运行命令。') === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => settings.mutations.length === 1 && controller.pendingSettingsCount === 0)
    expect(settings.mutations[0]).toEqual({ namespace: 'permission', path: [], expectedRevision: 4,
      operation: 'batch', changes: [operation === 'set'
        ? { operation: 'set', path: ['defaultPreset'], value: 'danger-full-access' }
        : { operation: 'unset', path: ['defaultPreset'] }],
    })
    expect(session.permissionSelections).toEqual([])
    await controller.requestExit('user')
  })

  it('offers only valid preset choices and keeps unnamed presets usable without recomposing the current session', async () => {
    const settings = formSettings()
    settings.snapshot = { ...settings.snapshot, namespaces: [{
      namespace: 'agent-presets', schema: { type: 'object', dict: { default: { type: 'string' } } },
      value: { default: 'named' }, base: { default: 'named' }, revision: 2, applies: 'live', secrets: [],
    }] }
    const session = new FakeSession()
    const entry = selectableModeSnapshot().presets[0]!
    const { name: _name, ...unnamed } = entry
    session.modeState = selectableModeSnapshot({ presets: [
      { ...entry, id: 'named', name: '我的助手' },
      { ...entry, id: 'broken', name: '不可用预设', broken: 'Cannot parse preset' },
      { ...unnamed, id: 'fallback-id' },
    ] })
    const { controller, terminal } = createProduct({ settings, session })
    const internal = controller as unknown as { runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState }
    await controller.start()
    terminal.resize({ columns: 120, rows: 30 })
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    expect(internal.runtimeLibrary.settings.presetChoices).toEqual([
      { id: 'named', name: '我的助手' }, { id: 'fallback-id', name: 'fallback-id' },
    ])
    terminal.input({ type: 'insert', text: '[' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('我的助手') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('不可用预设')
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'save-default' })
    await waitFor(() => settings.mutations.length === 1 && controller.pendingSettingsCount === 0)
    expect(settings.mutations[0]).toMatchObject({ namespace: 'agent-presets', changes: [{ operation: 'set', path: ['default'], value: 'fallback-id' }] })
    expect(session.modeSelections).toEqual([])
    await controller.requestExit('user')
  })

  it('retains only failed namespace drafts after a partial form save and keeps service errors private', async () => {
    const settings = formSettings()
    settings.snapshot = { ...settings.snapshot, namespaces: [...settings.snapshot.namespaces, {
      namespace: 'shell', schema: { type: 'object', dict: { enabled: { type: 'boolean' } } },
      value: { enabled: false }, revision: 9, applies: 'live', secrets: [],
    }] }
    settings.mutateOverride = async request => {
      if (request.namespace === 'shell') throw new Error('SECRET_PROVIDER_PAYLOAD')
    }
    const { controller, terminal } = createProduct({ settings })
    const internal = controller as unknown as { runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState }
    await controller.start()
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'insert', text: ']' })
    terminal.input({ type: 'insert', text: ']' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'save-default' })
    await waitFor(() => settings.mutations.length === 2 && controller.pendingSettingsCount === 0)
    expect(settings.mutations.map(request => request.namespace)).toEqual(['dsh-tui', 'shell'])
    expect(Object.values(internal.runtimeLibrary.page!.drafts).map(draft => draft.field.namespace)).toEqual(['shell'])
    expect(internal.runtimeLibrary.page!.notice).toContain('部分设置未保存')
    expect(internal.runtimeLibrary.page!.error).toContain('无法保存设置')
    expect(internal.runtimeLibrary.page!.error).not.toContain('SECRET_PROVIDER_PAYLOAD')
    settings.mutateOverride = async () => {}
    terminal.input({ type: 'save-default' })
    await waitFor(() => settings.mutations.length === 3 && controller.pendingSettingsCount === 0)
    expect(settings.mutations[2]?.namespace).toBe('shell')
    expect(internal.runtimeLibrary.page!.drafts).toEqual({})
    await controller.requestExit('user')
  })

  it('contains a late form-save request when no Settings authority exists', async () => {
    const { controller, terminal } = createProduct({ pluginInventory: new FakePluginInventory() })
    const internal = controller as unknown as {
      runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState
      beginSettingsPageSave(requests: readonly SettingsMutationRequest[]): void
    }
    await controller.start()
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    expect(internal.runtimeLibrary.settings.available).toBe(false)
    internal.beginSettingsPageSave([{ namespace: 'dsh-tui', path: [], expectedRevision: 1,
      operation: 'batch', changes: [{ operation: 'set', path: ['density'], value: 'comfortable' }],
    }])
    expect(controller.pendingSettingsCount).toBe(1)
    await waitFor(() => controller.pendingSettingsCount === 0)
    expect(internal.runtimeLibrary.settings).toMatchObject({ available: false, writable: false })
    expect(internal.runtimeLibrary.page?.pending).toBe(false)
    await expect(controller.requestExit('user')).resolves.toMatchObject({ ok: true })
  })

  it('keeps the reset confirmation in the form until it is canceled before opening advanced settings', async () => {
    const settings = formSettings()
    const { controller, terminal } = createProduct({ settings })
    const internal = controller as unknown as { runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState }
    await controller.start()
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'complete' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'submit' })
    expect(internal.runtimeLibrary.page).toMatchObject({ confirmation: 'reset', drafts: {} })
    terminal.input({ type: 'toggle-transcript-details' })
    expect(internal.runtimeLibrary.page).toMatchObject({ confirmation: 'reset', confirmIndex: 0 })
    expect(internal.runtimeLibrary.page!.notice).toContain('请先保存或取消')
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'toggle-transcript-details' })
    expect(internal.runtimeLibrary.page).toBeUndefined()
    expect(internal.runtimeLibrary.open).toBe(true)
    expect(settings.mutations).toEqual([])
    await controller.requestExit('user')
  })

  it('opens the user form, stages typed choices, and saves them together without invoking the model', async () => {
    const settings = formSettings()
    const { controller, terminal, session } = createProduct({ settings })
    await controller.start()
    terminal.resize({ columns: 120, rows: 30 })
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('主题') === true)
    const text = terminal.frames.at(-1)!.lines.join('\n')
    expect(text).toContain('保存更改')
    expect(text).not.toContain('Namespace')
    expect(text).not.toContain('version')
    expect(text).not.toContain('Effective values')
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'move-right' })
    expect(settings.mutations).toHaveLength(0)
    terminal.input({ type: 'toggle-transcript-details' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('请先保存或取消') === true)
    terminal.input({ type: 'save-default' })
    await waitFor(() => settings.mutations.length === 1 && controller.pendingSettingsCount === 0)
    expect(settings.mutations[0]).toEqual({
      namespace: 'dsh-tui', path: [], expectedRevision: 7, operation: 'batch',
      changes: [
        { operation: 'set', path: ['theme', 'preset'], value: 'cordis' },
        { operation: 'set', path: ['density'], value: 'comfortable' },
      ],
    })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'escape' })
    expect(session.submitted).toEqual([])
    expect(session.commandExecutions).toEqual([])
    await controller.requestExit('user')
  })

  it('keeps form drafts on revision conflict and never displays provider exception contents', async () => {
    const settings = formSettings()
    settings.mutateOverride = async () => { throw new Error('revision conflict; private payload') }
    const { controller, terminal } = createProduct({ settings })
    await controller.start()
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'save-default' })
    await waitFor(() => settings.mutations.length === 1 && controller.pendingSettingsCount === 0)
    const internal = controller as unknown as { runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState }
    expect(Object.keys(internal.runtimeLibrary.page!.drafts)).toHaveLength(1)
    expect(internal.runtimeLibrary.page!.error).toContain('配置已在其他地方更改')
    expect(internal.runtimeLibrary.page!.error).not.toContain('private payload')
    settings.mutateOverride = async () => { throw new Error('arbitrary failure') }
    terminal.input({ type: 'save-default' })
    await waitFor(() => settings.mutations.length === 2 && controller.pendingSettingsCount === 0)
    expect(internal.runtimeLibrary.page!.error).toContain('无法保存设置')
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'submit' })
    expect(internal.runtimeLibrary.open).toBe(false)
    await controller.requestExit('user')
  })

  it('joins a pending form save after an approval replaces the page', async () => {
    const gate = deferred()
    const settings = formSettings()
    settings.mutateOverride = () => gate.promise
    const { controller, terminal, session, application } = createProduct({ settings })
    await controller.start()
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'save-default' })
    terminal.input({ type: 'toggle-transcript-details' })
    await waitFor(() => controller.pendingSettingsCount === 1)
    session.interactionsSource.push(snapshot([{
      id: 'approval:form-save', kind: 'approval', sessionId: session.sessionId,
      approvalId: 'approval-form-save', toolName: 'write_file', callId: 'form-save',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)
    const stopping = controller.requestExit('signal')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(application.requestCount).toBe(0)
    gate.resolve()
    await expect(stopping).resolves.toMatchObject({ ok: true })
    expect(controller.pendingSettingsCount).toBe(0)
  })

  it('keeps Normal search, region focus, and bounded paging separate from the chat draft', async () => {
    const settings = new FakeSettings()
    const pluginInventory = new FakePluginInventory()
    pluginInventory.snapshot = { available: true, entries: [{
      entryId: 'long-plugin', moduleName: `${'module路径'.repeat(100)}PLUGIN_END`, enabled: true, fiberPhase: 'active',
    }] }
    const { controller, session, terminal } = createProduct({ settings, pluginInventory })
    await controller.start()
    terminal.resize({ columns: 80, rows: 14 })
    terminal.input({ type: 'insert', text: 'preserved settings draft' })
    const internal = controller as unknown as {
      runtimeLibrary: import('../src/runtime-library/surface.ts').RuntimeLibraryState
      currentBinding: SessionBinding
      openLocalCommand(name: string): void
    }
    internal.openLocalCommand('settings')
    terminal.input({ type: 'toggle-transcript-details' })
    expect(internal.runtimeLibrary).toMatchObject({ open: true, focus: 'catalog', searchFocused: false })
    for (const text of ['j', 'k', 'h']) terminal.input({ type: 'insert', text })
    terminal.input({ type: 'insert', text: 'ignored paste', paste: true })
    expect(internal.runtimeLibrary.query.text).toBe('')
    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'insert', text: 'jkl' })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'move-right' })
    expect(internal.runtimeLibrary.query.text).toBe('jkl')
    terminal.input({ type: 'page-down' })
    terminal.input({ type: 'submit' })
    expect(internal.runtimeLibrary.searchFocused).toBe(false)
    for (const type of ['backspace', 'delete', 'move-home', 'move-end'] as const) terminal.input({ type })
    expect(internal.runtimeLibrary.query.text).toBe('jkl')
    terminal.input({ type: 'complete' })
    expect(internal.runtimeLibrary.focus).toBe('detail')
    terminal.input({ type: 'complete', reverse: true })
    expect(internal.runtimeLibrary.focus).toBe('catalog')
    terminal.input({ type: 'insert', text: ']' })
    terminal.input({ type: 'insert', text: 'l' })
    expect(internal.runtimeLibrary).toMatchObject({ tab: 'plugins', focus: 'detail' })
    for (const text of ['l', 'j', 'k']) terminal.input({ type: 'insert', text })
    terminal.input({ type: 'move-down' })
    for (let index = 0; index < 20; index += 1) terminal.input({ type: 'page-down' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PLUGIN_END') === true)
    const end = internal.runtimeLibrary.detailScrollOffset
    terminal.input({ type: 'page-down' })
    expect(internal.runtimeLibrary.detailScrollOffset).toBe(end)
    terminal.input({ type: 'page-up' })
    terminal.input({ type: 'move-up' })
    expect(internal.runtimeLibrary.detailScrollOffset).toBeLessThan(end!)
    terminal.input({ type: 'insert', text: 'h' })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'move-left' })
    expect(internal.runtimeLibrary.focus).toBe('catalog')
    terminal.input({ type: 'insert', text: 'i' })
    terminal.input({ type: 'escape' })
    expect(internal.runtimeLibrary.open).toBe(false)
    expect(internal.currentBinding.prompt.text).toBe('preserved settings draft')
    expect(settings.mutations).toEqual([])
    expect(session.submitted).toEqual([])
    expect(session.commandExecutions).toEqual([])
    await controller.requestExit('user')
  })

  it('keeps DSH /settings available beside the TUI /preferences Feature', async () => {
    const features = {
      start: async () => {},
      openRoute: vi.fn(async () => {}),
      snapshot: () => ({ availableRoutes: [{ id: SETTINGS_ROUTE_ID, featureId: SETTINGS_FEATURE_ID }] }),
      onChanged: () => () => {},
      dispatchTerminalAction: () => ({ handled: false, completion: Promise.resolve() }),
    } as unknown as DshTuiFeatureHostPort
    const product = createProduct({ features, settings: new FakeSettings() })
    await product.controller.start()
    product.terminal.input({ type: 'insert', text: '/preferences' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => vi.mocked(features.openRoute).mock.calls.length === 1)
    expect(features.openRoute).toHaveBeenCalledWith('preferences')
    product.terminal.input({ type: 'insert', text: '/settings' })
    product.terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(product.terminal.frames.at(-1), 'Settings'))
    expect(features.openRoute).toHaveBeenCalledOnce()
    expect(product.session.submitted).toEqual([])
    await product.controller.requestExit('user')
  })

  it('routes /settings locally, edits through CAS mutate, and refreshes Loader inventory', async () => {
    const session = new FakeSession()
    const settings = new FakeSettings()
    const pluginInventory = new FakePluginInventory()
    const { controller, terminal } = createProduct({ session, settings, pluginInventory })
    await controller.start()
    terminal.resize({ columns: 160, rows: 42 })
    expect(controller.pendingSettingsCount).toBe(0)
    settings.change({ ...settings.snapshot, generation: 4 })

    terminal.input({ type: 'insert', text: '/set' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('/settings') === true)
    terminal.input({ type: 'complete' })
    terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(terminal.frames.at(-1), 'Settings'))
    terminal.input({ type: 'toggle-transcript-details' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.trim() === 'Settings')
    expectWorkspace(terminal.frames.at(-1)!, 'Settings')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Effective values')
    expect(session.submitted).toEqual([])
    expect(session.commandExecutions).toEqual([])
    settings.change({ ...settings.snapshot, generation: 5 })
    await waitFor(() => (controller as unknown as { runtimeLibrary: { settings: { generation: number } } }).runtimeLibrary.settings.generation === 5)

    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'newline' })
    terminal.input({ type: 'toggle-reasoning' })
    terminal.input({ type: 'toggle-transcript-details' })
    terminal.input({ type: 'toggle-goal-actions' })
    terminal.input({ type: 'toggle-activity' })
    terminal.input({ type: 'ignored' })

    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'save-default' })
    await waitFor(() => settings.mutations.length === 1)
    expect(settings.mutations[0]).toEqual({
      namespace: 'agent-loop',
      path: ['maxSteps'],
      operation: 'unset',
      expectedRevision: 7,
    })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Inherited maxSteps from the lower settings layer',
    ) === true)

    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-left' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'backspace' })
    terminal.input({ type: 'backspace' })
    terminal.input({ type: 'insert', text: '42' })
    terminal.input({ type: 'submit' })
    await waitFor(() => settings.mutations.length === 2)
    expect(settings.mutations[1]).toEqual({
      namespace: 'agent-loop',
      path: ['maxSteps'],
      operation: 'set',
      value: 42,
      expectedRevision: 7,
    })

    const readsBefore = pluginInventory.reads
    terminal.input({ type: 'insert', text: ']' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Read-only · Enter refresh',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Selected plugin',
    )
    terminal.input({ type: 'submit' })
    await waitFor(() => pluginInventory.reads > readsBefore)

    terminal.input({ type: 'insert', text: '[' })
    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'insert', text: 'agent' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Agent loop') === true)
    terminal.input({ type: 'escape' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))

    terminal.input({ type: 'insert', text: '/settings unexpected' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /settings does not accept input',
    ) === true)
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(terminal.frames.at(-1), 'Settings'))
    terminal.input({ type: 'escape' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))
    terminal.input({ type: 'insert', text: '/settingsx' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(item => item.input.text === '/settingsx'))
    terminal.input({ type: 'insert', text: 'continue with the normal Agent runtime' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(item => (
      item.input.text === 'continue with the normal Agent runtime'
    )))
    await controller.requestExit('user')
  })

  it('contains mutation failures and missing Settings or Loader authorities', async () => {
    const settings = new FakeSettings()
    settings.mutateOverride = async () => { throw new Error('revision conflict') }
    const settingsOnly = createProduct({ settings })
    await settingsOnly.controller.start()

    settingsOnly.terminal.input({ type: 'insert', text: '/settings' })
    settingsOnly.terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(settingsOnly.terminal.frames.at(-1), 'Settings'))
    settingsOnly.terminal.input({ type: 'toggle-transcript-details' })
    settingsOnly.terminal.input({ type: 'submit' })
    settingsOnly.terminal.input({ type: 'save-default' })
    await waitFor(() => settingsOnly.terminal.frames.at(-1)?.lines.join('\n').includes(
      'revision conflict',
    ) === true)
    expect(settingsOnly.controller.pendingSettingsCount).toBe(0)

    const lateSettingsListener = [...settings.listeners][0]!
    const settingsInternal = settingsOnly.controller as unknown as {
      finishSettingsMutation(task: Promise<void>, error: string | undefined): void
    }
    settingsInternal.finishSettingsMutation(Promise.resolve(), undefined)
    await settingsOnly.controller.requestExit('user')
    lateSettingsListener()

    const pluginOnly = createProduct({ pluginInventory: new FakePluginInventory() })
    await pluginOnly.controller.start()
    pluginOnly.terminal.input({ type: 'insert', text: '/settings' })
    pluginOnly.terminal.input({ type: 'submit' })
    pluginOnly.terminal.input({ type: 'toggle-transcript-details' })
    await waitFor(() => workspaceOpen(pluginOnly.terminal.frames.at(-1), 'Plugins'))
    const pluginInternal = pluginOnly.controller as unknown as {
      beginSettingsMutation(request: SettingsMutationRequest): void
      readonly runtimeLibrary: { readonly tab: string; readonly error?: string }
    }
    expect(pluginInternal.runtimeLibrary.tab).toBe('plugins')
    pluginInternal.beginSettingsMutation({
      namespace: 'agent-loop',
      path: ['maxSteps'],
      operation: 'unset',
      expectedRevision: 0,
    })
    expect(pluginInternal.runtimeLibrary.error).toBe('Settings service is unavailable')
    await pluginOnly.controller.requestExit('user')
  })

  it('yields the fixed overlay to interactions and an official /settings command', async () => {
    const session = new FakeSession()
    const settings = new FakeSettings()
    const pluginInventory = new FakePluginInventory()
    const { controller, terminal } = createProduct({ session, settings, pluginInventory })
    await controller.start()
    terminal.resize({ columns: 140, rows: 32 })

    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(terminal.frames.at(-1), 'Settings'))
    session.interactionsSource.push(snapshot([{
      id: 'approval:settings-focus',
      kind: 'approval',
      sessionId: session.sessionId,
      approvalId: 'approval-settings-focus',
      toolName: 'write_file',
      callId: 'settings-focus',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '1 Allow once',
    ) === true)
    expect(terminal.frames.at(-1)?.lines[0]).not.toContain('Settings')

    session.interactionsSource.push(snapshot())
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '1 Allow once',
    ) === false)
    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(terminal.frames.at(-1), 'Settings'))
    session.changeCommands([{ name: 'settings', description: 'Official settings command' }])
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Official /settings command is now registered',
    ) === true)

    terminal.input({ type: 'insert', text: '/settings' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.some(call => call.line === '/settings'))
    await controller.requestExit('user')
  })

  it('joins an in-flight settings write and reports subscription teardown failures', async () => {
    const gate = deferred()
    const settings = new FakeSettings()
    settings.mutateOverride = async () => { await gate.promise }
    const application = new FakeApplication()
    const first = createProduct({
      settings,
      pluginInventory: new FakePluginInventory(),
      application,
    })
    await first.controller.start()
    first.terminal.input({ type: 'insert', text: '/settings' })
    first.terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(first.terminal.frames.at(-1), 'Settings'))
    first.terminal.input({ type: 'toggle-transcript-details' })
    first.terminal.input({ type: 'submit' })
    first.terminal.input({ type: 'move-down' })
    first.terminal.input({ type: 'save-default' })
    await waitFor(() => first.controller.pendingSettingsCount === 1)

    first.terminal.input({ type: 'escape' })
    await waitFor(() => !secondarySurfaceOpen(first.terminal.frames.at(-1)))
    first.terminal.input({ type: 'insert', text: '/settings' })
    first.terminal.input({ type: 'submit' })
    const firstInternal = first.controller as unknown as { readonly commandNotice?: string }
    await waitFor(() => firstInternal.commandNotice === 'Settings write is still committing')

    const shutdown = first.controller.requestExit('signal')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(first.controller.state).toBe('stopping')
    expect(application.requestCount).toBe(0)
    gate.resolve()
    await expect(shutdown).resolves.toMatchObject({ ok: true, reason: 'signal' })
    expect(settings.unsubscribeCount).toBe(1)

    const broken = new FakeSettings()
    broken.throwOnUnsubscribe = new Error('settings observer teardown failed')
    const second = createProduct({ settings: broken })
    await second.controller.start()
    const result = await second.controller.requestExit('user')
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(result.shutdown.issues.some(issue => (
      issue.phase === 'stop-input'
      && String(issue.error).includes('settings observer teardown failed')
    ))).toBe(true)
  })
})

describe('DshTuiController request-attempt recovery surface', () => {
  function emitRetry(session: FakeSession): void {
    session.eventsSource.push(durable(0, { type: 'turn/start', data: { turn: 1 } }))
    session.eventsSource.push(durable(1, {
      type: 'step/start',
      data: { turn: 1, step: 1 },
    }))
    session.eventsSource.push(durable(2, {
      type: 'llm/retry',
      data: {
        retryId: 'retry-controller',
        turn: 1,
        step: 1,
        provider: 'deepseek-official',
        mode: 'normal',
        policyKey: 'normal',
        retry: 1,
        maxRetries: 5,
        delayMs: 750,
        failure: {
          message: 'provider busy', code: 'RATE_LIMIT', status: 429, requestId: 'request-first',
        },
      },
    }))
    session.eventsSource.push(durable(3, {
      type: 'llm/retry-started',
      data: { retryId: 'retry-controller', turn: 1, step: 1, retry: 1 },
    }))
    session.eventsSource.push(durable(4, {
      type: 'llm/retry',
      data: {
        retryId: 'retry-controller',
        turn: 1,
        step: 1,
        provider: 'deepseek-official',
        mode: 'normal',
        policyKey: 'normal',
        retry: 2,
        maxRetries: 5,
        delayMs: 1_000,
        failure: {
          message: 'provider still busy', code: 'RATE_LIMIT', status: 429, requestId: 'request-second',
        },
      },
    }))
  }

  it('opens /attempts locally over the retained conversation and keeps retry input out of the Agent', async () => {
    const session = new FakeSession()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 140, rows: 36 })
    emitRetry(session)
    await waitFor(() => terminal.frames.at(-1)?.conversation?.statusline?.text.includes(
      'RETRY 3/6',
    ) === true)

    terminal.input({ type: 'insert', text: '/attempts' })
    terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(terminal.frames.at(-1), 'Request recovery'))
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('×01 ─ ×02 ─ ◆03')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Request id  request-second')
    expect(session.submitted).toEqual([])
    expect(session.commandExecutions).toEqual([])

    terminal.input({ type: 'insert', text: 'ignored while overlay owns focus' })
    terminal.resize({ columns: 80, rows: 9 })
    await waitFor(() => terminal.frames.at(-1)?.viewport.columns === 80)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('Recovery path')
    terminal.input({ type: 'insert', text: 'l' })
    await waitFor(() => terminal.frames.at(-1)?.styleSpans?.flat().some(span => span.style.backgroundRole === 'selectionBackground') === false)
    for (let page = 0; page < 5; page += 1) terminal.input({ type: 'page-down' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Retry chain') === true)
    const attemptEnd = terminal.frames.at(-1)?.lines.join('\n')
    terminal.input({ type: 'insert', text: 'k' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n') !== attemptEnd)
    terminal.input({ type: 'page-up' })
    terminal.input({ type: 'complete', reverse: true })
    await waitFor(() => terminal.frames.at(-1)?.styleSpans?.flat().some(span => span.style.backgroundRole === 'selectionBackground') === true)
    terminal.input({ type: 'page-down' })
    terminal.resize({ columns: 140, rows: 36 })
    await waitFor(() => terminal.frames.at(-1)?.viewport.columns === 140)
    terminal.input({ type: 'move-left' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Request id  request-first',
    ) === true)
    terminal.input({ type: 'move-right' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Request id  request-second',
    ) === true)
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))
    terminal.input({ type: 'insert', text: '/attempts ' })
    terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(terminal.frames.at(-1), 'Request recovery'))
    terminal.input({ type: 'interrupt' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))
    terminal.input({ type: 'insert', text: '/attempts unexpected' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /attempts does not accept input',
    ) === true)
    await controller.requestExit('user')
  })

  it('does not capture slash-command names that merely share the attempts prefix', async () => {
    const session = new FakeSession()
    const { controller, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/attemptsx' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(call => call.input.text === '/attemptsx'))
    await controller.requestExit('user')
  })

  it('yields to pending interactions and late official /attempts ownership', async () => {
    const session = new FakeSession()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    emitRetry(session)

    terminal.input({ type: 'insert', text: '/attempts' })
    terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(terminal.frames.at(-1), 'Request recovery'))
    session.interactionsSource.push(snapshot([{
      id: 'approval:attempt-focus',
      kind: 'approval',
      sessionId: session.sessionId,
      approvalId: 'approval-attempt-focus',
      toolName: 'write_file',
      callId: 'attempt-focus',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '1 Allow once',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('Request recovery')

    terminal.input({ type: 'escape' })
    session.interactionsSource.push(snapshot())
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '1 Allow once',
    ) === false)
    terminal.input({ type: 'insert', text: '/attempts' })
    terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(terminal.frames.at(-1), 'Request recovery'))
    session.changeCommands([{
      name: 'attempts',
      description: 'Official request-attempt diagnostics',
    }])
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Official /attempts command is now registered',
    ) === true)

    terminal.input({ type: 'insert', text: '/attempts' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.some(call => call.line === '/attempts'))
    terminal.input({ type: 'insert', text: '/attempts unexpected' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(call => call.input.text === '/attempts unexpected'))
    await controller.requestExit('user')
  })
})

describe('DshTuiController request-route surface', () => {
  function emitRoutes(session: FakeSession): void {
    session.eventsSource.push(durable(0, {
      type: 'request/header',
      data: {
        reason: 'initial',
        config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      },
    }))
    session.eventsSource.push(durable(1, {
      type: 'request/context',
      data: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        contextWindow: 1_000_000,
      },
    }))
  }

  it('opens /route locally over retained conversation and keeps it out of the Agent', async () => {
    const session = new FakeSession()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 150, rows: 38 })
    emitRoutes(session)

    terminal.input({ type: 'insert', text: '/route' })
    terminal.input({ type: 'submit' })
    await waitFor(() => (
      workspaceOpen(terminal.frames.at(-1), 'Model route')
      && terminal.frames.at(-1)?.lines.join('\n').includes(
        'deepseek-official/deepseek-v4-flash',
      ) === true
    ))
    const opened = terminal.frames.at(-1)!
    expect(opened.lines.join('\n')).toContain('Model route')
    expect(opened.lines.join('\n')).toContain('deepseek-official/deepseek-v4-flash')
    expect(opened.lines.join('\n')).toContain('Context window  1M')
    expect(opened.conversation).toBeUndefined()
    expect(session.submitted).toEqual([])
    expect(session.commandExecutions).toEqual([])

    terminal.input({ type: 'insert', text: 'ignored while route owns focus' })
    terminal.resize({ columns: 80, rows: 8 })
    await waitFor(() => terminal.frames.at(-1)?.viewport.columns === 80)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('State  CURRENT')
    terminal.input({ type: 'complete' })
    await waitFor(() => (controller as unknown as { currentBinding: SessionBinding }).currentBinding.routeNavigation?.focus === 'details')
    for (let page = 0; page < 5; page += 1) terminal.input({ type: 'page-down' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Authority') === true)
    const routeEnd = terminal.frames.at(-1)?.lines.join('\n')
    terminal.input({ type: 'move-up' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n') !== routeEnd)
    terminal.input({ type: 'page-up' })
    terminal.input({ type: 'insert', text: 'h' })
    await waitFor(() => (controller as unknown as { currentBinding: SessionBinding }).currentBinding.routeNavigation?.focus === 'list')
    terminal.input({ type: 'page-up' })
    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))

    terminal.input({ type: 'insert', text: '/route ' })
    terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(terminal.frames.at(-1), 'Model route'))
    terminal.input({ type: 'interrupt' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))

    terminal.input({ type: 'insert', text: '/route unexpected' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Local /route does not accept input',
    ) === true)
    terminal.input({ type: 'escape' })

    terminal.input({ type: 'insert', text: '/routex' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(call => call.input.text === '/routex'))
    await controller.requestExit('user')
  })

  it('yields route focus to interactions and late official command ownership', async () => {
    const session = new FakeSession()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    emitRoutes(session)

    terminal.input({ type: 'insert', text: '/route' })
    terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(terminal.frames.at(-1), 'Model route'))
    session.interactionsSource.push(snapshot([{
      id: 'approval:route-focus',
      kind: 'approval',
      sessionId: session.sessionId,
      approvalId: 'approval-route-focus',
      toolName: 'write_file',
      callId: 'route-focus',
    }]))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '1 Allow once',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('Model route')

    terminal.input({ type: 'escape' })
    session.interactionsSource.push(snapshot())
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '1 Allow once',
    ) === false)
    terminal.input({ type: 'insert', text: '/route' })
    terminal.input({ type: 'submit' })
    await waitFor(() => workspaceOpen(terminal.frames.at(-1), 'Model route'))

    session.changeCommands([{
      name: 'route',
      description: 'Official route inspection',
    }])
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Official /route command is now registered',
    ) === true)
    terminal.input({ type: 'insert', text: '/route' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.commandExecutions.some(call => call.line === '/route'))
    terminal.input({ type: 'insert', text: '/route unexpected' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(call => call.input.text === '/route unexpected'))
    await controller.requestExit('user')
  })
})

describe('DshTuiController permission control', () => {
  it('opens the official preset projection and switches through the permission port', async () => {
    const session = new FakeSession()
    session.commands = [{
      name: 'permission',
      description: 'Switch permission preset',
      input: { hint: '<preset>' },
    }]
    session.permissionState = selectablePermissionSnapshot()
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 120, rows: 24 })

    terminal.input({ type: 'insert', text: '/permission' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Permission Presets',
    ) === true)
    const opened = terminal.frames.at(-1)!
    expectWorkspace(opened, 'Permission Presets')
    expect(opened.lines.join('\n')).toContain('Current  workspace-write')
    expect(opened.lines.join('\n')).toContain('Target  workspace-write')
    expect(opened.lines.join('\n')).toContain('Write inside the workspace')
    expect(session.commandExecutions).toEqual([])

    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Permission preset switched: danger-full-access',
    ) === true)
    expect(session.permissionSelections).toHaveLength(1)
    expect(session.permissionSelections[0]).toMatchObject({ value: 'danger-full-access' })
    expect(session.permissionSelections[0]?.options?.signal).toBeInstanceOf(AbortSignal)
    expect(session.commandExecutions).toEqual([])

    terminal.input({ type: 'insert', text: '/permission' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Permission Presets',
    ) === true)
    terminal.input({ type: 'move-up' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Target  workspace-write',
    ) === true)
    terminal.input({ type: 'escape' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))

    terminal.input({ type: 'insert', text: '/permission workspace-write' })
    terminal.input({ type: 'submit' })
    expect((controller as unknown as { currentBinding: SessionBinding }).currentBinding.permissionPicker)
      .toMatchObject({ open: true, selectedValue: 'workspace-write' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.permissionSelections.length === 2)
    expect(session.commandExecutions).toEqual([])
    await controller.requestExit('user')
    expect(session.permissionsUnsubscribeCount).toBe(1)
  })

  it('honors the exact command boundary and serializes asynchronous permission ownership', async () => {
    const session = new FakeSession()
    session.commands = []
    session.permissionState = selectablePermissionSnapshot()
    const firstSelection = Promise.withResolvers<void>()
    session.selectPermissionOverride = async () => { await firstSelection.promise }
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 100, rows: 18 })

    terminal.input({ type: 'insert', text: '/permissionx' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.submitted.some(call => call.input.text === '/permissionx'))

    session.changePermissions({
      available: false,
      writable: false,
      stale: false,
      generation: 1,
      selecting: false,
      options: [],
    })
    terminal.input({ type: 'insert', text: '/permission' })
    terminal.input({ type: 'submit' })
    expect(session.submitted.some(call => call.input.text === '/permission')).toBe(false)
    expect((controller as unknown as { commandNotice?: string }).commandNotice)
      .toContain('unavailable')

    session.changePermissions(selectablePermissionSnapshot({ generation: 2 }))
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Permission Presets',
    ) === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'submit' })
    await waitFor(() => session.permissionSelections.length === 1)
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'A permission switch is already running',
    ) === true)
    firstSelection.resolve()

    const internal = controller as unknown as {
      currentBinding: SessionBinding
      bindings: Set<SessionBinding>
      beginPermissionSelection(binding: SessionBinding, value: string): void
      closeBinding(binding: SessionBinding): Promise<void>
    }
    await waitFor(() => internal.currentBinding.permissionSelectTask === undefined)

    session.selectPermissionOverride = async (_value, options) => {
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => { reject(new Error('selection aborted')) },
          { once: true },
        )
      })
    }
    internal.beginPermissionSelection(internal.currentBinding, 'danger-full-access')
    await waitFor(() => session.permissionSelections.length === 2)
    internal.currentBinding.permissionSelectAbort?.abort('test abort without closing binding')
    await waitFor(() => internal.currentBinding.permissionSelectTask === undefined)

    const staleSuccess = Promise.withResolvers<void>()
    session.selectPermissionOverride = async () => { await staleSuccess.promise }
    internal.beginPermissionSelection(internal.currentBinding, 'danger-full-access')
    await waitFor(() => internal.currentBinding.permissionSelectTask !== undefined)
    internal.currentBinding.permissionSelectGeneration += 1
    staleSuccess.resolve()
    await waitFor(() => internal.currentBinding.permissionSelectTask === undefined)

    const staleFailure = Promise.withResolvers<void>()
    session.selectPermissionOverride = async () => { await staleFailure.promise }
    internal.beginPermissionSelection(internal.currentBinding, 'danger-full-access')
    await waitFor(() => internal.currentBinding.permissionSelectTask !== undefined)
    internal.currentBinding.permissionSelectGeneration += 1
    staleFailure.reject(new Error('stale permission failure'))
    await waitFor(() => internal.currentBinding.permissionSelectTask === undefined)

    const backgroundPort = new FakeSession('permission-selection-background')
    backgroundPort.permissionState = selectablePermissionSnapshot()
    const background = createSessionBinding(303, backgroundPort, 'background', async () => {})
    background.permissions = backgroundPort.permissionSnapshot()
    internal.bindings.add(background)
    internal.beginPermissionSelection(background, 'danger-full-access')
    await waitFor(() => background.permissionSelectTask === undefined)
    expect(backgroundPort.permissionSelections).toHaveLength(1)
    await internal.closeBinding(background)

    await controller.requestExit('user')
  })

  it('keeps stale/read-only/error states visible and contains modal-only input', async () => {
    const session = new FakeSession()
    session.commands = [{
      name: 'permission',
      description: 'Switch permission preset',
      input: { hint: '<preset>' },
    }]
    session.permissionState = selectablePermissionSnapshot({ writable: false })
    const { controller, terminal } = createProduct({ session })
    await controller.start()
    terminal.resize({ columns: 100, rows: 18 })
    terminal.input({ type: 'insert', text: '/permission' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Read only') === true)

    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Official permission switching is unavailable',
    ) === true)

    session.changePermissions(selectablePermissionSnapshot({
      stale: true,
      error: 'projection snapshot failed',
    }))
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Projection changed · showing the last known policy',
    ) === true)

    session.selectPermissionOverride = async () => {
      throw new Error('policy rejected')
    }
    session.changePermissions(selectablePermissionSnapshot({ generation: 3 }))
    for (const action of [
      { type: 'insert', text: 'x' },
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
      { type: 'toggle-transcript-details' },
      { type: 'toggle-goal-actions' },
      { type: 'toggle-activity' },
      { type: 'ignored' },
    ] as const) terminal.input(action)
    terminal.input({ type: 'submit' })
    terminal.input({ type: 'move-right' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Permission switch failed: policy rejected',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Confirm permission change · Default: Cancel',
    )
    terminal.input({ type: 'interrupt' })
    terminal.input({ type: 'interrupt' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))
    await controller.requestExit('user')
  })

  it('closes for pending interactions and contains optional seams and teardown failures', async () => {
    const missing = new FakeSession()
    Object.defineProperty(missing, 'permissionSnapshot', { value: undefined })
    Object.defineProperty(missing, 'onPermissionsChanged', { value: undefined })
    Object.defineProperty(missing, 'selectPermission', { value: undefined })
    const first = createProduct({ session: missing })
    await first.controller.start()
    ;(first.controller as unknown as { openLocalPermissionPicker(): void })
      .openLocalPermissionPicker()
    expect((first.controller as unknown as { commandNotice?: string }).commandNotice)
      .toBe('Permission presets are unavailable in this Session composition')
    const firstInternal = first.controller as unknown as {
      currentBinding: SessionBinding
      beginPermissionSelection(binding: SessionBinding, value: string): void
      commandNotice?: string
    }
    firstInternal.beginPermissionSelection(firstInternal.currentBinding, 'workspace-write')
    expect(firstInternal.commandNotice)
      .toBe('Permission switching is unavailable in this Session lease')
    await first.controller.requestExit('user')

    const session = new FakeSession()
    session.commands = [{
      name: 'permission',
      description: 'Switch permission preset',
      input: { hint: '<preset>' },
    }]
    session.permissionState = selectablePermissionSnapshot()
    const second = createProduct({ session })
    await second.controller.start()
    second.terminal.input({ type: 'insert', text: '/permission' })
    second.terminal.input({ type: 'submit' })
    await waitFor(() => second.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Permission Presets',
    ) === true)
    session.interactionsSource.push({
      type: 'interaction/snapshot',
      sessionId: session.sessionId,
      pending: [{
        id: 'approval-permission',
        kind: 'approval',
        sessionId: session.sessionId,
        approvalId: 'approval-permission',
        toolName: 'write_file',
        callId: 'call-permission',
      }],
    })
    await waitFor(() => second.terminal.frames.at(-1)?.lines.join('\n').includes(
      'Incomplete evidence · Allow disabled',
    ) === true)
    expect(second.terminal.frames.at(-1)?.lines.join('\n')).not.toContain(
      'Permission Presets',
    )

    const backgroundPort = new FakeSession('permission-background')
    backgroundPort.permissionState = selectablePermissionSnapshot()
    const background = createSessionBinding(202, backgroundPort, 'background', async () => {})
    background.permissions = backgroundPort.permissionSnapshot()
    background.permissionsSubscription = () => {
      throw new Error('background permission unsubscribe failed')
    }
    const internal = second.controller as unknown as {
      bindings: Set<SessionBinding>
      handlePermissionsChanged(binding: SessionBinding): void
      closeBinding(binding: SessionBinding): Promise<void>
    }
    internal.bindings.add(background)
    internal.handlePermissionsChanged(background)
    await expect(internal.closeBinding(background)).rejects.toMatchObject({
      errors: [expect.objectContaining({
        message: 'background permission unsubscribe failed',
      })],
    })

    const staleListener = [...session.permissionListeners][0]!
    session.throwOnPermissionsUnsubscribe = new Error('permission unsubscribe failed')
    const result = await second.controller.requestExit('user')
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    expect(() => staleListener()).not.toThrow()
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
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Models') === true)
    terminal.input({ type: 'page-down' })
    terminal.input({ type: 'page-up' })
    expect(session.modelSelections).toEqual([])
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
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Models') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Provider A')

    terminal.input({ type: 'move-up' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Reasoning effort') === true)
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Models') === true)
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Reasoning effort') === true)
    terminal.input({ type: 'save-default' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Model switched and saved as default: provider-a/model-a · opaque/high',
    ) === true)

    const lateModelListener = [...session.modelListeners][0]
    await controller.requestExit('user')
    expect(session.modelListeners.size).toBe(0)
    expect(() => lateModelListener?.()).not.toThrow()
  })

  it('opens no-input /model locally and refuses the picker while the Agent is running', async () => {
    const official = new FakeSession()
    official.modelState = selectableModelSnapshot()
    official.commands = [{ name: 'model', description: 'Official model command' }]
    official.commandExecution = { commandId: 'official-model', result: { kind: 'success' } }
    const first = createProduct({ session: official })
    await first.controller.start()
    first.terminal.input({ type: 'insert', text: '/model' })
    first.terminal.input({ type: 'submit' })
    await waitFor(() => official.modelRefreshSignals.length === 1)
    expect(official.commandExecutions).toEqual([])
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
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Models') === true)
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('Models')

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
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Models') === true)
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

  it('opens local model navigation after completion is dismissed even with an official command', async () => {
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
    official.modelState = selectableModelSnapshot()
    official.commands = [{ name: 'model', description: 'Official model command' }]
    official.commandExecution = { commandId: 'official-model', result: { kind: 'success' } }
    const second = createProduct({ session: official })
    await second.controller.start()
    second.terminal.input({ type: 'insert', text: '/model' })
    second.terminal.input({ type: 'escape' })
    second.terminal.input({ type: 'submit' })
    await waitFor(() => official.modelRefreshSignals.length === 1)
    expect(official.commandExecutions).toEqual([])
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
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Manage providers')
    terminal.input({ type: 'complete' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Connections') === true)
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
    await waitFor(() => local.terminal.frames.at(-1)?.lines[0]?.includes('Connections') === true)
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
      await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Connections') === true)
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
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Connections') === true)
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
      '1 Allow once',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('Connections')
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
    expect(exitProduct.terminal.frames.at(-1)?.conversation?.dock?.role).toBe('command')
    expect(exitProduct.terminal.frames.at(-1)?.overlay).toBeUndefined()
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
      'A command is already running',
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
    details.terminal.input({ type: 'toggle-transcript-details' })
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
    await waitFor(() => terminal.frames.at(-1)?.conversation?.dock?.role === 'command')
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('COMMANDS')
    expect(terminal.frames.at(-1)?.conversation?.composer).toBe('/')
    expect(terminal.frames.at(-1)?.overlay).toBeUndefined()
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('GOAL BLOCKED')
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('GOAL ACTIONS')

    session.interactionsSource.push(snapshot([], session.sessionId))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === false)
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Activity') === true)
    expectWorkspace(terminal.frames.at(-1)!, 'Activity')

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
    await waitFor(() => {
      const text = terminal.frames.at(-1)?.lines.join('\n') ?? ''
      return text.includes('Stop Review the Jobs adapter?') && text.includes('Enter confirm')
    })
    const binding = (controller as unknown as { currentBinding: SessionBinding }).currentBinding
    for (const action of [
      { type: 'move-left' }, { type: 'move-right' }, { type: 'complete' }, { type: 'complete', reverse: true },
      { type: 'newline' }, { type: 'insert', text: 'y' },
    ] as const) {
      terminal.input(action)
      expect(binding.activityCenter).toMatchObject({ tab: 'jobs', confirmStop: true })
      expect(session.jobActionCalls).toEqual([])
    }
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
    await waitFor(() => {
      const text = terminal.frames.at(-1)?.lines.join('\n') ?? ''
      return text.includes('Review the Jobs adapter') && text.includes('STOPPING')
    })
    terminal.input({ type: 'toggle-activity' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))
    terminal.input({ type: 'toggle-activity' })
    terminal.input({ type: 'escape' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))
    terminal.input({ type: 'toggle-activity' })
    terminal.input({ type: 'interrupt' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))

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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Activity') === true)
    terminal.input({ type: 'toggle-goal-actions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('GOAL ACTIONS') === true)
    terminal.input({ type: 'toggle-activity' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Activity') === true)

    session.jobActionReceipt = {
      accepted: false,
      code: 'job-reference-stale',
      message: 'select again',
    }
    terminal.input({ type: 'insert', text: 'K' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'job-reference-stale: select again',
    ) === true)

    session.throwOnJobAction = 'kill exploded'
    terminal.input({ type: 'insert', text: 'K' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'job-action-failed: kill exploded',
    ) === true)
    session.throwOnJobAction = undefined
    session.jobActionReceipt = { accepted: true, outcome: 'already-finished' }
    terminal.input({ type: 'insert', text: 'K' })
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)
    expect(terminal.frames.at(-1)?.overlay).toBeUndefined()
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('1 Allow once')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('2 Reject')
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
    expectWorkspace(unavailable.terminal.frames.at(-1)!, 'Activity')
    await unavailable.controller.requestExit('user')

    const noActions = new FakeJobsSession()
    noActions.jobsState = jobsSnapshot()
    Object.defineProperty(noActions, 'runJobAction', { value: undefined })
    const missing = createProduct({ session: noActions })
    await missing.controller.start()
    missing.terminal.input({ type: 'toggle-activity' })
    missing.terminal.input({ type: 'insert', text: 'K' })
    await waitFor(() => {
      const text = missing.terminal.frames.at(-1)?.lines.join('\n') ?? ''
      return text.includes('Stop Review the Jobs adapter?') && text.includes('Enter confirm')
    })
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
    terminal.input({ type: 'insert', text: ']' })
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
    terminal.input({ type: 'insert', text: 'K' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'subagent-reference-stale: select again',
    ) === true)

    session.throwOnDelegationAction = 'interrupt exploded'
    terminal.input({ type: 'insert', text: 'K' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'subagent-action-failed: interrupt exploded',
    ) === true)
    session.throwOnDelegationAction = undefined
    session.delegationActionReceipt = { accepted: true, outcome: 'already-idle' }
    terminal.input({ type: 'insert', text: 'K' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Subagent child-live is already idle',
    ) === true)

    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'delete' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Subagent idle cannot be stopped',
    ) === true)
    terminal.input({ type: 'insert', text: ']' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('WORKFLOWS') === true)
    terminal.input({ type: 'delete' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'no independent cancel authority',
    ) === true)
    terminal.input({ type: 'insert', text: '[' })
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'SUBAGENTS 2 · 1 LIVE',
    ) === true)
    terminal.input({ type: 'escape' })
    await waitFor(() => !secondarySurfaceOpen(terminal.frames.at(-1)))

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
    await waitFor(() => workspaceOpen(exact.terminal.frames.at(-1), 'Activity'))

    exact.terminal.input({ type: 'escape' })
    exactPrompt.openLocalCommand('activity')
    await waitFor(() => workspaceOpen(exact.terminal.frames.at(-1), 'Activity'))
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
    official.terminal.input({ type: 'insert', text: '/' })
    await waitFor(() => official.terminal.frames.at(-1)?.conversation?.dock?.role === 'command')
    official.terminal.input({ type: 'escape' })
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
    product.terminal.input({ type: 'insert', text: ']' })
    product.terminal.input({ type: 'insert', text: 'K' })
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
      'Context',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('HEALTHY · 50%')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('~64K / 128K')
    expect(session.submitted).toEqual([])
    expect(session.commandExecutions).toEqual([])

    session.changeContext(contextSnapshot(8_000, 5))
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'HEALTHY · 6%',
    ) === true)
    terminal.input({ type: 'insert', text: 'ignored while panel is open' })
    expect(session.submitted).toEqual([])

    terminal.resize({ columns: 80, rows: 5 })
    await waitFor(() => terminal.frames.at(-1)?.viewport.columns === 80)
    for (let page = 0; page < 5; page += 1) terminal.input({ type: 'page-down' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Official projection · seq 5') === true)
    const contextEnd = terminal.frames.at(-1)?.lines.join('\n')
    terminal.input({ type: 'insert', text: 'k' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n') !== contextEnd)
    for (let page = 0; page < 5; page += 1) terminal.input({ type: 'page-up' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('HEALTHY · 6%') === true)

    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '~8K/128K 6%',
    ) === true)

    terminal.input({ type: 'insert', text: '/context' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '/context',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Inspect context',
    )
    terminal.input({ type: 'escape' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes(
      'Context',
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
      'Context',
    )
    await official.controller.requestExit('user')

    const lateSession = new FakeContextSession()
    lateSession.contextState = contextSnapshot(32_000, 7)
    const late = createProduct({ session: lateSession })
    await late.controller.start()
    late.terminal.input({ type: 'insert', text: '/context' })
    late.terminal.input({ type: 'submit' })
    await waitFor(() => late.terminal.frames.at(-1)?.lines[0]?.includes(
      'Context',
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
      'Context',
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
      '1 Allow once',
    ) === true)
    expect(terminal.frames.at(-1)?.lines[0]).not.toContain(
      'Context',
    )
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('1 Allow once')

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
      'Sessions',
    ) === true)

    const screen = terminal.frames.at(-1)?.lines.join('\n') ?? ''
    expect(screen).toContain('current')
    expect(screen).toContain('cold')
    expect(screen).toContain('live-c')
    expect(screen).toContain('running')
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Sessions') === false)
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

  it('lets an observed official /sessions command win ownership while keeping concise palette copy', async () => {
    const session = new FakeSession()
    session.commands = [{
      name: 'sessions',
      description: 'Official sessions command',
    }]
    const { controller, catalog, terminal } = createProduct({ session })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Browse sessions',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('Official sessions command')
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
      'Sessions',
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).not.toContain('[DSH-TUI/local]')

    session.interactionsSource.push(snapshot())
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === false)
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
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Sessions') === true)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => inspection.requests.length === 2)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'history for cold-child',
    ) === true)
    expect(activation.requests).toEqual([])
    expect(terminal.frames.at(-1)?.lines.at(-1)).not.toContain('A resume')
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
      '▌ Resume cold session',
    ) === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('cold-confirm')
    expect(activation.requests).toEqual([])

    terminal.input({ type: 'insert', text: 'ignored while confirming' })
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      '▌ Resume cold session',
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
      '▌ Resume cold session',
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
      '▌ Resume cold session',
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
      'Session switching is not implemented',
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)
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

describe('DshTuiController session fork', () => {
  const currentEntry = {
    sessionId: 'session-a',
    createdAt: 30,
    cwd: 'D:\\current',
    isSubagent: false,
    attached: true,
    durablePresence: 'observed' as const,
    liveStatus: 'idle' as const,
  }
  const coldEntry = {
    sessionId: 'cold-source',
    createdAt: 20,
    cwd: 'D:\\cold',
    isSubagent: false,
    creationAgentPreset: 'code',
    attached: false,
    durablePresence: 'observed' as const,
  }

  it('confirms an exact source, hydrates the official child lease, and keeps the source alive', async () => {
    const source = new FakeSession('session-a')
    const child = new FakeSession('fork-child')
    const featureSession = new FakeFeatureSession()
    child.interactionsSource.push(snapshot([], 'fork-child'))
    let childReleases = 0
    const fork = new FakeFork()
    fork.forkOverride = async () => ({
      port: child,
      release: async () => { childReleases += 1 },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, coldEntry])
    const { controller, terminal } = createProduct({
      session: source,
      catalog,
      fork,
      featureSession,
    })
    await controller.start()
    terminal.resize({ columns: 160, rows: 18 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'insert', text: 'F' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '▌ Fork session',
    ) === true)
    const confirmation = terminal.frames.at(-1)?.lines.join('\n') ?? ''
    expect(confirmation).toContain('cold-source')
    expect(confirmation).toContain('Last completed turn')
    expect(confirmation).toContain('source remains unchanged')
    expect(fork.requests).toEqual([])

    terminal.input({ type: 'submit' })
    await waitFor(() => fork.requests.length === 1)
    expect(fork.requests[0]).toMatchObject({ sourceSessionId: 'cold-source' })
    expect(fork.requests[0]?.signal.aborted).toBe(false)
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('fork-child') === true)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Forked from cold-source')
    expect(controller.pendingForkCount).toBe(0)
    expect(featureSession.activate.mock.calls.map(call => call[0])).toEqual([source, child])
    expect(source.disposeCount).toBe(0)
    expect(childReleases).toBe(0)

    await controller.requestExit('user')
    expect(source.disposeCount).toBe(1)
    expect(childReleases).toBe(1)
    expect(child.disposeCount).toBe(0)
  })

  it('navigates cold inspection metadata with vim and page keys then exits with one Escape', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([...catalog.snapshot.sessions, {
      sessionId: 'cold-navigation', createdAt: 20, isSubagent: false, attached: false, durablePresence: 'observed',
    }])
    const inspection = new FakeInspection()
    const history = inspectionHistorySnapshot('cold-navigation', 'history')
    inspection.inspectOverride = async () => ({ ...history, header: { ...history.header,
      cwd: 'D:/' + 'directory/'.repeat(80) + ' CWD-END', creationAgentPreset: 'PRESET-END' } })
    const { controller, terminal, session } = createProduct({ catalog, inspection })
    await controller.start()
    terminal.resize({ columns: 80, rows: 6 })
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('history 19') === true)
    terminal.input({ type: 'insert', text: 'k' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('history 18') === true)
    terminal.input({ type: 'insert', text: 'j' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('history 19') === true)
    terminal.input({ type: 'page-up' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('history 17') === true)
    terminal.input({ type: 'page-down' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('history 19') === true)
    for (let index = 0; index < 40 && !terminal.frames.at(-1)?.lines.join('\n').includes('CWD-END'); index += 1) {
      const count = terminal.frames.length
      terminal.input({ type: 'insert', text: 'k' })
      await waitFor(() => terminal.frames.length > count)
    }
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('CWD-END')
    for (let index = 0; index < 100; index += 1) terminal.input({ type: 'page-up' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Storage unchanged') === true)
    for (let index = 0; index < 100; index += 1) terminal.input({ type: 'page-down' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('history 19') === true)
    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Session inspection') === false)
    expect(inspection.requests).toHaveLength(1)
    expect(session.submitted).toEqual([])
    await controller.requestExit('user')
  })

  it('does not commit a fork child when Feature Session activation fails', async () => {
    const source = new FakeSession('session-a')
    const child = new FakeSession('fork-child')
    child.interactionsSource.push(snapshot([], 'fork-child'))
    const featureSession = new FakeFeatureSession()
    featureSession.activateOverride = async candidate => {
      if (candidate === child) throw new Error('fork Feature activation failed')
      return 'active'
    }
    let releases = 0
    const fork = new FakeFork()
    fork.forkOverride = async () => ({
      port: child,
      release: async () => { releases += 1 },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry])
    const { controller, terminal } = createProduct({
      session: source,
      catalog,
      fork,
      featureSession,
    })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'insert', text: 'f' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingForkCount === 0 && releases === 1)

    expect(featureSession.activate.mock.calls.map(call => call[0])).toEqual([source, child])
    const internals = controller as unknown as {
      readonly currentBinding: SessionBinding
      readonly catalogNotice: string | undefined
    }
    expect(internals.currentBinding.port).toBe(source)
    expect(internals.catalogNotice).toBe('Session fork failed: fork Feature activation failed')
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Session fork failed',
    ) === true)
    await controller.requestExit('user')
  })

  it('returns from confirmation without creating a child', async () => {
    const fork = new FakeFork()
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry])
    const { controller, terminal } = createProduct({ catalog, fork })
    await controller.start()
    terminal.resize({ columns: 160, rows: 18 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'insert', text: 'f' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('▌ Fork session') === true)
    terminal.input({ type: 'move-down' })
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('▌ Fork session')
    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Sessions',
    ) === true)

    expect(fork.requests).toEqual([])
    expect(terminal.frames.at(-1)?.lines.at(-1)).toContain('F fork')
    await controller.requestExit('user')
  })

  it('explains unavailable, empty, and busy fork entry states without starting work', async () => {
    const unavailableCatalog = new FakeCatalog()
    unavailableCatalog.snapshot = catalogSnapshot([currentEntry])
    const unavailable = createProduct({ catalog: unavailableCatalog })
    await unavailable.controller.start()
    unavailable.terminal.resize({ columns: 160, rows: 18 })
    unavailable.terminal.input({ type: 'insert', text: '/sessions' })
    unavailable.terminal.input({ type: 'submit' })
    await waitFor(() => unavailableCatalog.signals.length === 1)
    unavailable.terminal.input({ type: 'insert', text: 'f' })
    const unavailableInternal = unavailable.controller as unknown as {
      readonly catalogNotice: string | undefined
      beginSessionFork(source: unknown): void
    }
    expect(unavailableInternal.catalogNotice).toBe(
      'Session fork is unavailable in this runtime composition',
    )
    unavailableInternal.beginSessionFork(currentEntry)
    expect(unavailable.controller.pendingForkCount).toBe(0)
    await unavailable.controller.requestExit('user')

    const emptyFork = new FakeFork()
    const emptyCatalog = new FakeCatalog()
    emptyCatalog.snapshot = catalogSnapshot([])
    const empty = createProduct({ catalog: emptyCatalog, fork: emptyFork })
    await empty.controller.start()
    empty.terminal.resize({ columns: 160, rows: 18 })
    empty.terminal.input({ type: 'insert', text: '/sessions' })
    empty.terminal.input({ type: 'submit' })
    await waitFor(() => emptyCatalog.signals.length === 1)
    empty.terminal.input({ type: 'insert', text: 'f' })
    expect((empty.controller as unknown as { readonly catalogNotice?: string }).catalogNotice)
      .toBe('Select a session to fork')
    expect(emptyFork.requests).toEqual([])
    await empty.controller.requestExit('user')

    const busyFork = new FakeFork()
    const busyCatalog = new FakeCatalog()
    busyCatalog.snapshot = catalogSnapshot([currentEntry])
    const busy = createProduct({ catalog: busyCatalog, fork: busyFork })
    const submit = deferred<void>()
    busy.session.submitGate = submit.promise
    await busy.controller.start()
    busy.terminal.resize({ columns: 160, rows: 18 })
    busy.terminal.input({ type: 'insert', text: 'work' })
    busy.terminal.input({ type: 'submit' })
    await waitFor(() => busy.session.submitted.length === 1)
    busy.terminal.input({ type: 'insert', text: '/sessions' })
    busy.terminal.input({ type: 'submit' })
    await waitFor(() => busyCatalog.signals.length === 1)
    busy.terminal.input({ type: 'insert', text: 'f' })
    expect((busy.controller as unknown as { readonly catalogNotice?: string }).catalogNotice)
      .toBe('Wait for the current session operation before forking')
    expect(busyFork.requests).toEqual([])
    submit.resolve()
    await waitFor(() => busy.controller.pendingSubmitCount === 0)
    await busy.controller.requestExit('user')
  })

  it('returns a fork failure to Sessions and releases a same-id defensive rejection', async () => {
    const fork = new FakeFork()
    const wrong = new FakeSession('session-a')
    let releases = 0
    fork.forkOverride = async () => ({
      port: wrong,
      release: async () => { releases += 1 },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry])
    const { controller, terminal } = createProduct({ catalog, fork })
    await controller.start()
    terminal.resize({ columns: 160, rows: 18 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'insert', text: 'f' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingForkCount === 0 && releases === 1)

    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Session fork failed: fork returned the source session instead of a new child',
    )
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Sessions')
    expect(wrong.disposeCount).toBe(0)
    await controller.requestExit('user')
  })

  it('rejects a fork child whose id is already owned by another open binding', async () => {
    const fork = new FakeFork()
    const duplicate = new FakeSession('session-a')
    let releases = 0
    fork.forkOverride = async () => ({
      port: duplicate,
      release: async () => { releases += 1 },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry, coldEntry])
    const { controller, terminal } = createProduct({ catalog, fork })
    await controller.start()
    terminal.resize({ columns: 160, rows: 18 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'insert', text: 'f' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingForkCount === 0 && releases === 1)

    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('fork returned already-open')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('session-a')
    expect(duplicate.disposeCount).toBe(0)
    await controller.requestExit('user')
  })

  it('aborts a late fork, releases its borrowed child, and leaves Sessions usable', async () => {
    const opened = deferred<ActivatedSessionLease>()
    const child = new FakeSession('late-fork-child')
    let releases = 0
    const fork = new FakeFork()
    fork.forkOverride = async () => await opened.promise
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry])
    const { controller, terminal } = createProduct({ catalog, fork })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'insert', text: 'f' })
    terminal.input({ type: 'submit' })
    await waitFor(() => fork.requests.length === 1)
    expect(controller.pendingForkCount).toBe(1)
    terminal.input({ type: 'insert', text: 'ignored while forking' })
    terminal.input({ type: 'escape' })
    expect(fork.requests[0]?.signal.aborted).toBe(true)
    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Cancelling session fork',
    ) === true)

    opened.resolve({
      port: child,
      release: async () => { releases += 1 },
    })
    await waitFor(() => controller.pendingForkCount === 0)
    expect(releases).toBe(1)
    expect(child.disposeCount).toBe(0)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('Sessions')

    await controller.requestExit('user')
  })

  it('lets a pending interaction dismiss Sessions and abort the in-flight fork', async () => {
    const opened = deferred<ActivatedSessionLease>()
    const child = new FakeSession('interaction-cancelled-child')
    let releases = 0
    const fork = new FakeFork()
    fork.forkOverride = async () => await opened.promise
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry])
    const { controller, session, terminal } = createProduct({ catalog, fork })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'insert', text: 'f' })
    terminal.input({ type: 'submit' })
    await waitFor(() => fork.requests.length === 1)
    session.interactionsSource.push(snapshot([{
      id: 'approval:source',
      kind: 'approval',
      sessionId: 'session-a',
      approvalId: 'approval-source',
      toolName: 'pwsh',
      callId: 'call-source',
    }]))
    await waitFor(() => fork.requests[0]?.signal.aborted === true)
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      '1 Allow once',
    ) === true)

    opened.resolve({
      port: child,
      release: async () => { releases += 1 },
    })
    await waitFor(() => controller.pendingForkCount === 0)
    expect(releases).toBe(1)
    await controller.requestExit('user')
  })

  it('forces terminal recovery on a second interrupt when fork creation ignores abort', async () => {
    const opened = deferred<ActivatedSessionLease>()
    const child = new FakeSession('forced-fork-child')
    let releases = 0
    const fork = new FakeFork()
    fork.forkOverride = async () => await opened.promise
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry])
    const { controller, terminal, application } = createProduct({ catalog, fork })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'insert', text: 'f' })
    terminal.input({ type: 'submit' })
    await waitFor(() => fork.requests.length === 1)
    terminal.input({ type: 'interrupt' })
    expect(fork.requests[0]?.signal.aborted).toBe(true)
    terminal.input({ type: 'interrupt' })

    await expect(controller.wait()).resolves.toMatchObject({ ok: false, reason: 'forced' })
    expect(application.forceCount).toBe(1)
    opened.resolve({
      port: child,
      release: async () => { releases += 1 },
    })
    await waitFor(() => controller.pendingForkCount === 0)
    expect(releases).toBe(1)
  })

  it('rolls back synchronous candidate cancellation with and without release failure', async () => {
    for (const releaseFailure of [undefined, new Error('candidate release failed')]) {
      const child = new FakeSession('setup-cancelled-child')
      child.interactionsSource.push(snapshot([], child.sessionId))
      let releases = 0
      const fork = new FakeFork()
      fork.forkOverride = async () => ({
        port: child,
        release: async () => {
          releases += 1
          if (releaseFailure !== undefined) throw releaseFailure
        },
      })
      const catalog = new FakeCatalog()
      catalog.snapshot = catalogSnapshot([currentEntry])
      const product = createProduct({ catalog, fork })
      child.onCommandSubscribe = () => {
        product.terminal.input({ type: 'escape' })
      }
      await product.controller.start()

      product.terminal.input({ type: 'insert', text: '/sessions' })
      product.terminal.input({ type: 'submit' })
      await waitFor(() => catalog.signals.length === 1)
      product.terminal.input({ type: 'insert', text: 'f' })
      product.terminal.input({ type: 'submit' })
      await waitFor(() => product.controller.pendingForkCount === 0)

      expect(fork.requests[0]?.signal.aborted).toBe(true)
      expect(releases).toBe(1)
      expect(product.terminal.frames.at(-1)?.lines.join('\n')).toContain('session-a')
      if (releaseFailure !== undefined) {
        expect(product.terminal.frames.at(-1)?.lines.join('\n')).toContain(
          'Session fork cleanup failed',
        )
      }
      await product.controller.requestExit('user')
    }
  })

  it('fences cancellation after candidate readiness and reports finalizer failure', async () => {
    const child = new FakeSession('readiness-fenced-child')
    const releaseRuntime = deferred()
    let terminal!: FakeTerminal
    child.eventsOverride = options => (
      async function* (): AsyncIterable<DshTuiEvent> {
        await releaseRuntime.promise
        options?.onCaughtUp?.({ lastSeq: -1, status: 'idle' })
        queueMicrotask(() => {
          queueMicrotask(() => { terminal.input({ type: 'escape' }) })
        })
        yield* child.eventsSource.iterate(options?.signal)
      }
    )()
    child.interactionsSource.push(snapshot([], child.sessionId))
    let releases = 0
    const fork = new FakeFork()
    fork.forkOverride = async () => ({
      port: child,
      release: async () => {
        releases += 1
        throw new Error('fenced release failed')
      },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry])
    const product = createProduct({ catalog, fork })
    terminal = product.terminal
    await product.controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'insert', text: 'f' })
    terminal.input({ type: 'submit' })
    await waitFor(() => child.interactionsSource.waiters.length === 1)
    releaseRuntime.resolve()
    await waitFor(() => product.controller.pendingForkCount === 0)

    expect(fork.requests[0]?.signal.aborted).toBe(true)
    expect(releases).toBe(1)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain(
      'Session fork cleanup failed',
    )
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('session-a')
    await product.controller.requestExit('user')
  })

  it('contains candidate hydration and release failures inside the fork transaction', async () => {
    const child = new FakeSession('failed-fork-child')
    child.eventsOverride = async function* (): AsyncIterable<DshTuiEvent> {
      throw new Error('fork candidate replay failed')
    }
    child.interactionsSource.push(snapshot([], child.sessionId))
    let releases = 0
    const fork = new FakeFork()
    fork.forkOverride = async () => ({
      port: child,
      release: async () => {
        releases += 1
        throw new Error('fork candidate release failed')
      },
    })
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry])
    const { controller, terminal } = createProduct({ catalog, fork })
    await controller.start()
    terminal.resize({ columns: 160, rows: 18 })

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'insert', text: 'f' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingForkCount === 0)

    const screen = terminal.frames.at(-1)?.lines.join('\n') ?? ''
    expect(screen).toContain('Session fork failed: runtime pump failed: fork candidate replay failed')
    expect(screen).toContain('cleanup failed')
    expect(releases).toBe(1)
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('session-a')
    await controller.requestExit('user')
  })

  it('reports a late fork release failure during shutdown', async () => {
    const opened = deferred<ActivatedSessionLease>()
    const child = new FakeSession('shutdown-fork-child')
    let releases = 0
    const fork = new FakeFork()
    fork.forkOverride = async () => await opened.promise
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot([currentEntry])
    const { controller, terminal } = createProduct({ catalog, fork })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'insert', text: 'f' })
    terminal.input({ type: 'submit' })
    await waitFor(() => fork.requests.length === 1)
    const exiting = controller.requestExit('user')
    opened.resolve({
      port: child,
      release: async () => {
        releases += 1
        throw new Error('shutdown fork release failed')
      },
    })

    const result = await exiting
    expect(result).toMatchObject({ ok: false, reason: 'fatal' })
    const cancelIssue = result.shutdown.issues.find(issue => issue.phase === 'cancel-agent')
    expect(String(cancelIssue?.error)).toContain('session fork cleanup failed')
    expect(String((cancelIssue?.error as Error).cause)).toContain('shutdown fork release failed')
    expect(releases).toBe(1)
    expect(child.disposeCount).toBe(0)
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
    const featureSession = new FakeFeatureSession()
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
      featureSession,
    })
    await controller.start()
    terminal.resize({ columns: 180, rows: 12 })
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('provider-a/source-model')

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    expect(terminal.frames.at(-1)?.lines[0]).toContain('Sessions')
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)
    expect(featureSession.activate.mock.calls.map(call => call[0])).toEqual([source, target])
    expect(terminal.frames.at(-1)?.overlay).toBeUndefined()
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('1 Allow once')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('2 Reject')
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
    expect(featureSession.activate.mock.calls.map(call => call[0])).toEqual([
      source,
      target,
      source,
    ])
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('provider-a/source-model-updated')

    expect(activation.requests).toHaveLength(1)
    expect(source.disposeCount).toBe(0)
    expect(target.disposeCount).toBe(0)
    await controller.requestExit('user')
    expect(source.disposeCount).toBe(1)
    expect(target.disposeCount).toBe(1)
    expect(terminal.restoreCount).toBe(1)
  })

  it('does not commit a switch candidate when Feature Session activation fails', async () => {
    const source = new FakeSession('session-a')
    const target = new FakeSession('session-b')
    target.interactionsSource.push(snapshot([], 'session-b'))
    const featureSession = new FakeFeatureSession()
    featureSession.activateOverride = async candidate => {
      if (candidate === target) throw new Error('switch Feature activation failed')
      return 'active'
    }
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
      featureSession,
    })
    await controller.start()

    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => catalog.signals.length === 1)
    terminal.input({ type: 'move-down' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingSwitchCount === 0 && releases === 1)

    expect(featureSession.activate.mock.calls.map(call => call[0])).toEqual([source, target])
    const current = (controller as unknown as { readonly currentBinding: SessionBinding })
      .currentBinding
    expect(current.port).toBe(source)
    expect(current.commandNotice).toBe('Session switch failed: switch Feature activation failed')
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes(
      'Session switch failed',
    ) === true)
    await controller.requestExit('user')
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
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('1 Allow once')
    expect(terminal.frames.at(-1)?.overlay).toBeUndefined()
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('1 Allow once')
    expect(terminal.frames.at(-1)?.lines.join('\n')).toContain('2 Reject')
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)
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

  it('cancels an accepted request during shutdown before running status arrives', async () => {
    const { controller, session, terminal } = createProduct()
    const idle = deferred()
    session.idleGate = idle.promise
    session.onCancel = () => idle.resolve()
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created'))

    terminal.input({ type: 'insert', text: 'accepted but status lags' })
    terminal.input({ type: 'submit' })
    await waitFor(() => controller.pendingSubmitCount === 0)

    const result = await controller.requestExit('user')

    expect(result).toMatchObject({ ok: true, reason: 'user' })
    expect(session.cancellations).toEqual([{ kind: 'user' }])
    expect(session.whenIdleCount).toBe(1)
  })

  it('cancels hidden maintenance during shutdown even while public status is idle', async () => {
    const { controller, session } = createProduct()
    const maintenance = deferred()
    session.idleGate = maintenance.promise
    session.onCancel = () => maintenance.resolve()
    await controller.start()
    session.eventsSource.push(runtime(0, 'agent/created', 'idle'))
    await waitFor(() => {
      const binding = (controller as unknown as { readonly currentBinding: SessionBinding })
        .currentBinding
      return binding.runtimeStatusObserved
    })

    const result = await controller.requestExit('user')

    expect(result).toMatchObject({ ok: true, reason: 'user' })
    expect(session.cancellations).toEqual([{ kind: 'user' }])
    expect(session.whenIdleCount).toBe(1)
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
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('1 Allow once') === true)
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

describe('DshTuiController legacy Sessions Workspace navigation', () => {
  it('applies search without switching, reaches long details, preserves refresh/fork shortcuts and escapes once', async () => {
    const catalog = new FakeCatalog()
    catalog.snapshot = catalogSnapshot(Array.from({ length: 12 }, (_, index) => ({
      sessionId: index === 11 ? 'rf-target' : `other-${index}`, createdAt: index, isSubagent: false,
      attached: false, durablePresence: 'observed' as const,
      cwd: `${'D:\\项目\\long-path '.repeat(80)}PATH_END`,
    })))
    const { controller, terminal, session } = createProduct({ catalog })
    const seam = controller as unknown as {
      sessionPicker: { navigation?: { focus: string; detailOffset: number }; query?: { text: string } }
      currentBinding: SessionBinding
    }
    await controller.start()
    terminal.resize({ columns: 80, rows: 12 })
    terminal.input({ type: 'insert', text: '/sessions' })
    terminal.input({ type: 'submit' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('Sessions') === true && catalog.signals.length === 1)
    terminal.input({ type: 'insert', text: '/' })
    terminal.input({ type: 'insert', text: 'r' })
    terminal.input({ type: 'insert', text: 'f' })
    expect(seam.sessionPicker.query?.text).toBe('rf')
    expect(catalog.signals).toHaveLength(1)
    terminal.input({ type: 'submit' })
    expect(seam.sessionPicker.navigation?.focus).toBe('list')
    expect(session.submitted).toEqual([])
    terminal.input({ type: 'page-down' })
    terminal.input({ type: 'complete' })
    expect(seam.sessionPicker.navigation?.focus).toBe('details')
    for (let index = 0; index < 20; index += 1) terminal.input({ type: 'page-down' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('PATH_END') === true)
    const offset = seam.sessionPicker.navigation!.detailOffset
    terminal.input({ type: 'insert', text: 'k' })
    expect(seam.sessionPicker.navigation?.detailOffset).toBe(offset - 1)
    for (const columns of [100, 140, 200, 80]) terminal.resize({ columns, rows: 12 })
    expect(catalog.signals).toHaveLength(1)
    terminal.input({ type: 'insert', text: 'h' })
    terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => catalog.signals.length === 2)
    terminal.input({ type: 'insert', text: 'f' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Session fork is unavailable') === true)
    catalog.listOverride = async () => { throw new Error('Session refresh offline') }
    terminal.input({ type: 'insert', text: 'r' })
    await waitFor(() => terminal.frames.at(-1)?.lines.join('\n').includes('Session refresh offline') === true)
    terminal.resize({ columns: 80, rows: 1 })
    terminal.input({ type: 'insert', text: 'l' })
    terminal.resize({ columns: 80, rows: 12 })
    terminal.input({ type: 'insert', text: 'i' })
    terminal.input({ type: 'backspace' })
    terminal.input({ type: 'newline' })
    terminal.input({ type: 'escape' })
    await waitFor(() => terminal.frames.at(-1)?.lines[0]?.includes('DSH-TUI ·') === true)
    expect(seam.currentBinding.prompt.text).toBe('')
    expect(session.commandExecutions).toEqual([])
    await controller.requestExit('user')
  })
})
