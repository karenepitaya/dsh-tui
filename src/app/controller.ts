import {
  applyInteractionReceipt,
  moveApprovalSelection,
  movePlanReviewSelection,
  moveQuestionFocus,
  moveQuestionPage,
  prepareInteractionCancel,
  prepareQuestionContinue,
  prepareQuestionSkip,
  prepareInteractionSubmit,
  reconcileInteractionEditor,
  reduceInteractionEditor,
  selectDshTuiInputMode,
  type InteractionEditorCommand,
  type InteractionEditorState,
} from '../interaction/editor.ts'
import type {
  InteractionSnapshot,
  PendingApprovalInteraction,
} from '../interaction/port.ts'
import type { SessionNavigationHost } from './session-navigation-host.ts'
import type { WebHostPort, WebHostSummary } from './web-host.ts'
import type { PreferenceSource } from '../preferences/application.ts'
import type { SessionNavigationRequest } from '../session/navigation-port.ts'
import { navigateLegacyDirectory } from '../navigation/legacy-directory.ts'
import { permissionConfirmationLayout, renderPermissionWorkspace } from '../ui/permission-workspace.ts'
import { buildApprovalDock } from '../ui/approval-dock.ts'
import { secondarySurfaceGeometry } from '../ui/secondary-surface.ts'
import { statusDetailViewport } from '../ui/status-frame.ts'
import type {
  DshTuiModelSelection,
  SessionModelSnapshot,
} from '../model/port.ts'
import type { SessionModeSnapshot } from '../mode/port.ts'
import type { SessionSkillsSnapshot } from '../skill/port.ts'
import type { SessionToolsSnapshot } from '../tool/port.ts'
import type {
  SettingsCatalogPort,
  SettingsCatalogSnapshot,
  SettingsMutationRequest,
} from '../settings/port.ts'
import { SettingsPageSession } from '../settings/page-session.ts'
import type { SettingsProvidersController } from '../settings/providers-controller.ts'
import { renderSettingsProvidersFrame } from '../ui/settings-providers-frame.ts'
import type {
  PluginInventoryPort,
  PluginInventorySnapshot,
} from '../plugin-inventory/port.ts'
import type { RuntimeLibraryState } from '../runtime-library/surface.ts'
import type { PermissionConfirmation, SessionPermissionSnapshot } from '../permission/port.ts'
import {
  applyPermissionPickerAction,
  createPermissionPickerState,
  openPermissionPicker,
  reconcilePermissionPicker,
  selectPermissionPicker,
  type PermissionPickerAction,
  type PermissionPickerOutcome,
} from '../permission/picker.ts'
import type { SessionContextSnapshot } from '../context/port.ts'
import type {
  SessionWorkbenchGoalActionReceipt,
  SessionWorkbenchSnapshot,
} from '../workbench/port.ts'
import {
  applyGoalActionSurfaceAction,
  createGoalActionSurfaceState,
  goalActionTarget,
  openGoalActionSurface,
  reconcileGoalActionSurface,
  reduceGoalActionSurfaceEditor,
  rejectGoalActionSurface,
  selectGoalActionSurface,
  type GoalActionSurfaceAction,
} from '../workbench/goal-actions.ts'
import type {
  SessionJobsSnapshot,
} from '../activity/port.ts'
import type {
  SessionDelegationSnapshot,
} from '../activity/delegation-port.ts'
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
import type { AgentStatus, DshTuiEvent } from '../runtime/events.ts'
import { unpackDshEventDelivery } from '../runtime/delivery.ts'
import {
  DshSubmitRejectedError,
  type RuntimeReplayBoundary,
} from '../runtime/port.ts'
import type {
  ClipboardPort,
  PromptImageInput,
  SessionAttachmentSnapshot,
} from '../attachment/port.ts'
import { imageStagingError } from '../attachment/composer.ts'
import { createSystemClipboardPort } from '../terminal/clipboard.ts'
import { approvalLayoutBudget } from '../presentation/approval-layout.ts'
import { renderSettingsPageFrame } from '../ui/settings-page-frame.ts'
import type {
  SessionCatalogPort,
} from '../session/catalog-port.ts'
import type {
  SessionInspectionPort,
} from '../session/inspection-port.ts'
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
import type { SessionForkPort } from '../session/fork-port.ts'
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
  acceptAgentRequest,
  beginAgentRequest,
  isAgentRequestActive,
  reduceAgentRequestEvent,
  rejectAgentRequest,
  requestAgentCancellation,
  settleAgentRequestCancellation,
  settleAgentRequestFromTurnEnd,
  type AgentRequestLifecycleState,
} from '../presentation/agent-request.ts'
import {
  DshTuiFrameProjectionCache,
  renderDshFrame,
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
import type { DshTuiFeatureHostPort } from './feature-host.ts'
import {
  createFeatureRouteCommandBridge,
  type FeatureRouteCommandBridge,
  type FeatureRouteCommandDispatch,
} from './feature-route-command-bridge.ts'
import type { FeatureSessionRuntimePort } from './feature-session-runtime.ts'

export type DshTuiProductPort = DshTuiSessionLease

export interface DshTuiApplicationPort {
  requestExit(): void | Promise<void>
  forceExit(): void | Promise<void>
}

export type DshTuiControllerState = 'idle' | 'running' | 'stopping' | 'stopped'
export type DshTuiExitReason = 'user' | 'signal' | 'runtime-disposed' | 'web-handoff'

export type DshTuiControllerResult =
  | {
      readonly ok: true
      readonly reason: DshTuiExitReason
      readonly shutdown: ShutdownResult
      /** Session facts for the runner's web-host phase; only with reason 'web-handoff'. */
      readonly webHostSummary?: WebHostSummary
    }
  | {
      readonly ok: false
      readonly reason: 'fatal' | 'forced'
      readonly error?: unknown
      readonly shutdown: ShutdownResult
    }

export interface DshTuiControllerOptions {
  readonly clipboard?: ClipboardPort
  readonly session: DshTuiProductPort
  /** Exact initial lease release; borrowed ports must not be disposed as owned Agents. */
  readonly sessionRelease?: () => Promise<void>
  /** Optional until product composition can safely distinguish live attach from cold resume. */
  readonly activation?: SessionActivationPort
  /** Optional read-only logical snapshot capability; it never activates a Session. */
  readonly inspection?: SessionInspectionPort
  /** Optional owned child-Session creation seam. */
  readonly fork?: SessionForkPort
  readonly catalog: SessionCatalogPort
  /** App-global official Provider connection capability; independent of Session leases. */
  readonly providers?: ProviderConnectionPort
  /** App-global official SettingsProvider projection; descriptors are redacted. */
  readonly settings?: SettingsCatalogPort
  /** App-global point-in-time Loader inventory; intentionally read only. */
  readonly pluginInventory?: PluginInventoryPort
  readonly terminal: TerminalDriver
  readonly terminalStartMode?: 'start' | 'adopt-running'
  readonly application: DshTuiApplicationPort
  /** Optional web host for `/web`; absent in legacy embedders and focused tests. */
  readonly webHost?: WebHostPort
  /** Product-owned, effect-scoped rich Tool card renderer set. */
  readonly toolCards?: ToolCardRendererRegistry
  /** Generic microkernel bridge; omitted by legacy embedders and focused tests. */
  readonly features?: DshTuiFeatureHostPort
  /** Session-scoped Feature/Surface transaction boundary owned by Product. */
  readonly featureSession?: FeatureSessionRuntimePort
  readonly sessionNavigation?: SessionNavigationHost
  readonly preferences?: PreferenceSource
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

function modelSelectionLabel(selection: DshTuiModelSelection): string {
  return `${selection.provider}/${selection.model}`
    + (selection.reasoningEffort === undefined ? '' : ` · ${selection.reasoningEffort}`)
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
  failure?: unknown
}

interface SessionForkAttempt {
  readonly source: SessionBinding
  readonly sourceRow: { readonly sessionId: string }
  readonly abort: AbortController
  task: Promise<void>
  failure?: unknown
}

interface BindingReadinessCallbacks {
  readonly onRuntimeCaughtUp: (boundary: RuntimeReplayBoundary) => void
  readonly onInteractionObserved: () => void
  readonly onFailure: (error: unknown) => void
}

/** Routes that exist for navigation but must not surface as slash commands. */
const HIDDEN_COMMAND_ROUTE_IDS: readonly string[] = ['chat']

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

const LOCAL_MODE_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'mode',
  description: 'Switch Agent mode',
})

const LOCAL_SKILLS_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'skills',
  description: 'Browse and invoke available skills',
})

const LOCAL_TOOLS_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'tools',
  description: 'Browse this Agent capability catalog',
})

const LOCAL_MCP_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'mcp',
  description: 'Inspect MCP capabilities mounted on this Agent',
})

const LOCAL_SETTINGS_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'settings',
  description: 'Inspect runtime settings and mounted plugins',
})

const LOCAL_SETTINGS_CANDIDATE: CommandMenuCandidate = Object.freeze({
  origin: 'local',
  command: LOCAL_SETTINGS_COMMAND,
})

const LOCAL_STATUS_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'status',
  description: 'Inspect context, request recovery, and model routing',
})

const LOCAL_STATUS_CANDIDATE: CommandMenuCandidate = Object.freeze({
  origin: 'local',
  command: LOCAL_STATUS_COMMAND,
})

const LOCAL_ATTACH_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'attach',
  description: 'Add an image to the next prompt',
  input: { hint: '<path|clear|remove N>' },
})

const LOCAL_EXIT_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'exit',
  description: 'Safely flush the Session and close DSH-TUI',
})

const LOCAL_EXIT_CANDIDATE: CommandMenuCandidate = Object.freeze({
  origin: 'local',
  command: LOCAL_EXIT_COMMAND,
})

const LOCAL_WEB_COMMAND: DshCommandDescriptor = Object.freeze({
  name: 'web',
  description: 'Close DSH-TUI and continue in the web UI',
})

const LOCAL_WEB_CANDIDATE: CommandMenuCandidate = Object.freeze({
  origin: 'local',
  command: LOCAL_WEB_COMMAND,
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

function localModeInput(line: string): string | undefined {
  const prefix = '/mode'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

function localSkillsInput(line: string): string | undefined {
  const prefix = '/skills'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

function localToolsInput(line: string): string | undefined {
  const prefix = '/tools'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

function localMcpInput(line: string): string | undefined {
  const prefix = '/mcp'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

function localSettingsInput(line: string): string | undefined {
  const prefix = '/settings'
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

function localStatusInput(line: string): string | undefined {
  const prefix = '/status'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

function localActivityInput(line: string): string | undefined {
  const prefix = '/activity'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

const LOCAL_STATUS_ALIAS_NAMES = ['context', 'attempts', 'route'] as const

/** Hidden typed-only aliases that open the merged Status page. */
function localStatusAliasInput(line: string): { readonly name: string; readonly input: string } | undefined {
  for (const name of LOCAL_STATUS_ALIAS_NAMES) {
    const prefix = `/${name}`
    if (!line.startsWith(prefix)) continue
    const boundary = line[prefix.length]
    if (boundary !== undefined && !/\s/u.test(boundary)) continue
    return { name, input: line.slice(prefix.length) }
  }
  return undefined
}

function localAttachInput(line: string): string | undefined {
  const prefix = '/attach'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

function unquoteImagePath(value: string): string {
  const path = value.trim()
  if (path.length < 2) return path
  const first = path[0]
  const last = path.at(-1)
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? path.slice(1, -1)
    : path
}

function localPermissionInput(line: string): string | undefined {
  const prefix = '/permission'
  if (!line.startsWith(prefix)) return undefined
  const boundary = line[prefix.length]
  if (boundary !== undefined && !/\s/u.test(boundary)) return undefined
  return line.slice(prefix.length)
}

function localSafetyInput(line: string, command: 'exit' | 'stop' | 'web'): string | undefined {
  const prefix = `/${command}`
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
      | 'toggle-transcript-details'
      | 'toggle-goal-actions'
      | 'toggle-activity'
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

function isFoldedReasoningContinuation(ui: UiState, event: DshTuiEvent): boolean {
  if (
    event.type !== 'assistant/chunk'
    || event.data.chunk.type !== 'reasoning-delta'
  ) return false
  /* v8 ignore next -- a selected binding always owns its exact Session UI before events pump. */
  const rows = ui.sessions[event.sessionId]?.rows ?? []
  const key = `draft:${event.data.turn}:${event.data.step}`
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (row.key !== key) continue
    return row.kind === 'assistant-draft' && row.reasoning !== ''
  }
  return false
}

function sameAgentRequestStatus(
  left: AgentRequestLifecycleState | undefined,
  right: AgentRequestLifecycleState | undefined,
): boolean {
  return left?.phase === right?.phase
    && left?.description === right?.description
    && left?.turn === right?.turn
}

export class DshTuiController {
  private readonly abort = new AbortController()
  private readonly scheduler: FrameScheduler
  private readonly frameProjectionCache = new DshTuiFrameProjectionCache()
  private readonly settingsPage: SettingsPageSession
  private readonly shutdown: ShutdownCoordinator
  private readonly completion: Promise<DshTuiControllerResult>
  private resolveCompletion!: (result: DshTuiControllerResult) => void
  private phase: DshTuiControllerState = 'idle'
  private viewport: TerminalViewport
  private readonly bindings = new Set<SessionBinding>()
  private readonly hydratedBindings = new WeakSet<SessionBinding>()
  private nextBindingEpoch = 0
  private nextFollowRequest = 0
  private nextSubmissionTicket = 0
  private readonly reasoningBySession = new Map<string, true>()
  private currentBinding: SessionBinding
  private pendingWebHostSummary: WebHostSummary | undefined
  private webHandoffTask: Promise<void> | undefined
  private switchAttempt: SessionSwitchAttempt | undefined
  private forkAttempt: SessionForkAttempt | undefined
  private switchCleanupError: unknown | undefined
  private forkCleanupError: unknown | undefined
  private settingsSubscription: (() => void) | undefined
  private featureHostSubscription: (() => void) | undefined
  private featureSessionSubscription: (() => void) | undefined
  private sessionNavigationSubscription: (() => void) | undefined
  private preferenceSubscription: (() => void) | undefined
  private featureRouteTask: Promise<void> | undefined
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
    this.featureHostSubscription = options.features?.onChanged(() => {
      if (this.phase === 'running') this.scheduler.invalidate('immediate')
    })
    this.featureSessionSubscription = options.featureSession?.onChanged(() => {
      if (this.phase === 'running') this.scheduler.invalidate('immediate')
    })
    this.preferenceSubscription = options.preferences?.onChanged(() => {
      if (this.phase === 'running') this.scheduler.invalidate('immediate')
    })
    this.sessionNavigationSubscription = options.sessionNavigation?.bind({
      snapshot: () => ({
        sessionId: this.session.sessionId,
        busy: this.phase !== 'running' || this.navigationBusy(),
      }),
      navigate: request => this.navigateSession(request),
    })
    this.settingsPage = new SettingsPageSession({
      settings: options.settings,
      providers: options.providers,
      settingsSnapshot: () => this.settingsSnapshot(),
      pluginInventorySnapshot: () => this.pluginInventorySnapshot(),
      navigationKeys: () => this.options.preferences?.snapshot().navigationKeys ?? 'both',
      uiLanguage: () => this.options.preferences?.snapshot().uiLanguage ?? 'en',
      viewport: () => this.viewport,
      invalidate: () => {
        if (this.phase === 'running') this.scheduler.invalidate('immediate')
      },
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

  private modelSnapshot(binding = this.currentBinding): SessionModelSnapshot {
    return binding.model
  }

  private refreshModelSnapshot(binding = this.currentBinding): SessionModelSnapshot {
    const snapshot = binding.port.modelSnapshot()
    binding.model = snapshot
    return snapshot
  }

  private modeSnapshot(binding = this.currentBinding): SessionModeSnapshot {
    return binding.port.modeSnapshot?.() ?? {
      available: false,
      loading: false,
      selecting: false,
      locked: false,
      presets: [],
    }
  }

  private skillsSnapshot(binding = this.currentBinding): SessionSkillsSnapshot {
    return binding.port.skillsSnapshot?.() ?? {
      available: false,
      loading: false,
      complete: true,
      stale: false,
      generation: 0,
      skills: [],
    }
  }

  private toolsSnapshot(binding = this.currentBinding): SessionToolsSnapshot {
    return binding.port.toolsSnapshot?.() ?? {
      available: false,
      stale: false,
      generation: 0,
      tools: [],
    }
  }

  private settingsSnapshot(): SettingsCatalogSnapshot {
    const snapshot = this.options.settings?.settingsSnapshot() ?? {
      available: false,
      writable: false,
      documentBacked: false,
      generation: 0,
      namespaces: [],
    }
    return { ...snapshot, presetChoices: this.modeSnapshot().presets
      .filter(preset => preset.broken === undefined)
      .map(preset => ({ id: preset.id, name: preset.name ?? preset.id })) }
  }

  private pluginInventorySnapshot(): PluginInventorySnapshot {
    return this.options.pluginInventory?.pluginInventorySnapshot() ?? {
      available: false,
      entries: [],
    }
  }

  private permissionSnapshot(
    binding = this.currentBinding,
  ): SessionPermissionSnapshot {
    return binding.port.permissionSnapshot?.() ?? {
      available: false,
      writable: false,
      stale: false,
      generation: 0,
      selecting: false,
      options: [],
    }
  }

  private contextSnapshot(binding = this.currentBinding): SessionContextSnapshot {
    return binding.port.contextSnapshot?.() ?? { available: false }
  }

  private attachmentSnapshot(
    binding = this.currentBinding,
  ): SessionAttachmentSnapshot {
    return binding.port.attachmentSnapshot?.() ?? { available: false }
  }

  private workbenchSnapshot(binding = this.currentBinding): SessionWorkbenchSnapshot {
    return binding.port.workbenchSnapshot?.() ?? { available: false }
  }

  private jobsSnapshot(binding = this.currentBinding): SessionJobsSnapshot {
    return binding.port.jobsSnapshot?.() ?? {
      available: false,
      generation: 0,
      jobs: [],
    }
  }

  private delegationSnapshot(
    binding = this.currentBinding,
  ): SessionDelegationSnapshot {
    return binding.port.delegationSnapshot?.() ?? {
      available: false,
      generation: 0,
      loading: false,
      subagentsAvailable: false,
      subagents: [],
      workflows: [],
    }
  }

  private createBinding(
    port: DshTuiSessionLease,
    role: SessionBinding['role'],
    release: () => Promise<void>,
  ): SessionBinding {
    const binding = createSessionBinding(++this.nextBindingEpoch, port, role, release)
    binding.transcriptViewMode = this.options.preferences?.snapshot().defaultTranscriptMode ?? 'compact'
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

  get pendingAttachmentCount(): 0 | 1 {
    return this.currentBinding.attachmentTask === undefined ? 0 : 1
  }

  get pendingSwitchCount(): 0 | 1 {
    return this.switchAttempt === undefined ? 0 : 1
  }

  get pendingForkCount(): 0 | 1 {
    return this.forkAttempt === undefined ? 0 : 1
  }

  get pendingModelCount(): number {
    return Number(this.currentBinding.modelRefreshTask !== undefined)
      + Number(this.currentBinding.modelSelectTask !== undefined)
  }

  get pendingModeCount(): number {
    return Number(this.currentBinding.modeRefreshTask !== undefined)
      + Number(this.currentBinding.modeSelectTask !== undefined)
  }

  get pendingSkillsCount(): 0 | 1 {
    return this.currentBinding.skillsRefreshTask === undefined ? 0 : 1
  }

  get pendingProviderCount(): number {
    return this.settingsProviders?.pendingCount ?? 0
  }

  get pendingSettingsCount(): 0 | 1 {
    return this.settingsPage.pendingCount
  }

  /** Compatibility seam for tests; the settings page session owns this state. */
  get runtimeLibrary(): RuntimeLibraryState {
    return this.settingsPage.snapshot
  }

  /** Compatibility seam for tests; the settings page session owns this controller. */
  get settingsProviders(): SettingsProvidersController | undefined {
    return this.settingsPage.providers
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
      await this.options.features?.start()
      await this.options.featureSession?.activate(this.currentBinding.port, this.viewport)
      this.settingsSubscription = this.options.settings?.onSettingsChanged(() => {
        this.guardCallback(() => {
          if (this.phase === 'running') this.settingsPage.reconcile()
        })
      })
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
    binding.modeSubscription = binding.port.onModesChanged?.(() => {
      this.guardCallback(() => this.handleModesChanged(binding))
    })
    binding.skillsSubscription = binding.port.onSkillsChanged?.(() => {
      this.guardCallback(() => this.handleSkillsChanged(binding))
    })
    binding.toolsSubscription = binding.port.onToolsChanged?.(() => {
      this.guardCallback(() => this.handleToolsChanged(binding))
    })
    binding.permissionsSubscription = binding.port.onPermissionsChanged?.(() => {
      this.guardCallback(() => this.handlePermissionsChanged(binding))
    })
    binding.contextSubscription = binding.port.onContextChanged?.(() => {
      this.guardCallback(() => this.handleContextChanged(binding))
    })
    binding.workbenchSubscription = binding.port.onWorkbenchChanged?.(() => {
      this.guardCallback(() => this.handleWorkbenchChanged(binding))
    })
    binding.jobsSubscription = binding.port.onJobsChanged?.(() => {
      this.guardCallback(() => this.handleJobsChanged(binding))
    })
    binding.delegationSubscription = binding.port.onDelegationChanged?.(() => {
      this.guardCallback(() => this.handleDelegationChanged(binding))
    })
    binding.context = this.contextSnapshot(binding)
    binding.model = binding.port.modelSnapshot()
    binding.mode = this.modeSnapshot(binding)
    binding.skills = this.skillsSnapshot(binding)
    binding.tools = this.toolsSnapshot(binding)
    binding.permissions = this.permissionSnapshot(binding)
    binding.workbench = this.workbenchSnapshot(binding)
    binding.jobs = this.jobsSnapshot(binding)
    binding.delegation = this.delegationSnapshot(binding)
    this.refreshCommands(binding)
    this.beginSkillsRefresh(binding)
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
        const foldedReasoningContinuation = !this.sessionReasoningExpanded(event.sessionId)
          && isFoldedReasoningContinuation(binding.ui, event)
        const previousRequest = binding.agentRequest
        if (event.plane === 'runtime') binding.runtimeStatusObserved = true
        binding.ui = reduceUiEvent(binding.ui, event)
        binding.ui = applyToolPresentation(binding.ui, event, toolPresentation)
        if (binding.agentRequest !== undefined || binding.runtimeStatusObserved) {
          binding.agentRequest = reduceAgentRequestEvent(
            binding.agentRequest,
            event,
            toolPresentation,
          )
        }
        disposed ||= event.plane === 'runtime' && event.type === 'agent/disposed'
        let chromeChanged = false
        if (
          this.isCurrentBinding(binding, epoch)
          && (
            !foldedReasoningContinuation
            || !sameAgentRequestStatus(previousRequest, binding.agentRequest)
            || chromeChanged
          )
        ) {
          this.scheduler.invalidate('coalesced')
        }
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
          && this.settingsPage.isOpen
        ) {
          this.settingsPage.dismiss()
          binding.commandNotice = 'Runtime library closed for a pending interaction'
        }
        if (
          this.isCurrentBinding(binding, epoch)
          && binding.interactionEditor.active !== undefined
          && binding.permissionPicker.open
        ) {
          this.dismissPermissionPicker(binding)
          binding.commandNotice = 'Permission control closed for a pending interaction'
        }
        if (
          this.isCurrentBinding(binding, epoch)
          && binding.interactionEditor.active !== undefined
          && binding.statusPanelOpen
        ) {
          binding.statusPanelOpen = false
          binding.commandNotice = 'Status panel closed for a pending interaction'
        }
        if (
          this.switchAttempt?.source === binding
          && binding.interactionEditor.active !== undefined
        ) {
          this.switchAttempt.abort.abort('source session requires interaction')
          binding.commandNotice = 'Session switch cancelled: answer the pending interaction first'
        }
        if (
          this.isCurrentBinding(binding, epoch)
          && binding.interactionEditor.active !== undefined
          && binding.goalActions.open
        ) {
          binding.goalActions = createGoalActionSurfaceState()
          binding.commandNotice = 'Goal actions closed for a pending interaction'
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
    const statusPanel = this.interactionEditor.active === undefined
      && this.currentBinding.statusPanelOpen
    let permissionPicker = this.interactionEditor.active === undefined
      && !statusPanel
      ? selectPermissionPicker(
          this.currentBinding.permissionPicker,
          this.currentBinding.permissions,
        )
      : undefined
    if (permissionPicker !== undefined) permissionPicker = {
      ...permissionPicker, rememberedApprovalCount: this.interaction?.rememberedApprovalCount ?? 0,
    }
    const runtimeLibrary = this.interactionEditor.active === undefined
      && permissionPicker === undefined
      && !statusPanel
      ? this.settingsPage.view()
      : undefined
    if (runtimeLibrary?.page !== undefined && (this.interaction?.pending.length ?? 0) === 0) {
      const { page, providers } = this.settingsPage.viewForFrame(runtimeLibrary.page)
      const options = { deferLayout: this.options.terminal.deferSettingsLayout === true }
      return providers === undefined ? renderSettingsPageFrame(page, this.viewport, options)
        : renderSettingsProvidersFrame(providers, page, this.viewport, options)
    }
    const goalActions = this.interactionEditor.active === undefined
      && permissionPicker === undefined
      && runtimeLibrary === undefined
      && !statusPanel
      ? selectGoalActionSurface(
          this.currentBinding.goalActions,
          this.currentBinding.workbench,
        )
      : undefined
    const commandMenu = this.interactionEditor.active === undefined
      && permissionPicker === undefined
      && runtimeLibrary === undefined
      && goalActions === undefined
      && !statusPanel
      ? this.currentCommandMenu()
      : undefined
    const featureSurface = this.options.featureSession?.snapshot()
    return renderDshFrame({
      ui: this.ui,
      ...(featureSurface === undefined ? {} : { featureSurface }),
      model: this.modelSnapshot(),
      context: this.currentBinding.context,
      workbench: this.currentBinding.workbench,
      jobs: this.currentBinding.jobs,
      ...(statusPanel ? { statusPanel: true, statusPanelOffset: this.currentBinding.statusPanelOffset } : {}),
      interaction: this.interaction,
      prompt: this.prompt,
      attachments: this.currentBinding.promptImages.map(image => ({
        name: image.name,
        mediaType: image.mediaType,
        bytes: image.bytes,
      })),
      input: selectDshTuiInputMode(this.prompt, this.interactionEditor),
      ...(goalActions === undefined ? {} : { goalActions }),
      ...(runtimeLibrary === undefined ? {} : { runtimeLibrary }),
      ...(permissionPicker === undefined ? {} : { permissionPicker }),
      ...(commandMenu === undefined ? {} : { commandMenu }),
      ...(this.commandNotice === undefined ? {} : { commandNotice: this.commandNotice }),
      commandPending: this.commandTask !== undefined
        || this.currentBinding.attachmentTask !== undefined
        || this.featureRouteTask !== undefined,
      ...(this.options.toolCards === undefined ? {} : { toolCards: this.options.toolCards }),
      projectionCache: this.frameProjectionCache,
      bindingEpoch: this.currentBinding.epoch,
      reasoningExpanded: this.sessionReasoningExpanded(this.session.sessionId),
      transcriptViewMode: this.currentBinding.transcriptViewMode,
      ...(this.options.preferences === undefined ? {} : { preferences: this.options.preferences.snapshot() }),
      ...(this.currentBinding.agentRequest === undefined
        ? {}
        : { agentRequest: this.currentBinding.agentRequest }),
      followRequest: this.currentBinding.followRequest,
    }, this.viewport, {
      deferFlatFallback: this.options.terminal.deferConversationFlatFallback === true,
      deferLayout: this.options.terminal.deferSettingsLayout === true,
    })
  }

  private currentCommandMenu(): CommandMenuView | undefined {
    if (
      !this.prompt.text.startsWith('/')
      || /\s/u.test(this.prompt.text)
      || this.commandMenu.dismissedDraft === this.prompt.text
    ) return undefined
    return selectCommandMenu(this.commandMenu, this.prompt, this.commandCandidates())
  }

  private hasOfficialSessionsCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_SESSIONS_COMMAND.name)
  }

  private hasOfficialModelCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_MODEL_COMMAND.name)
  }

  private hasOfficialModeCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_MODE_COMMAND.name)
  }

  private hasOfficialSkillsCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_SKILLS_COMMAND.name)
  }

  private hasOfficialToolsCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_TOOLS_COMMAND.name)
  }

  private hasOfficialMcpCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_MCP_COMMAND.name)
  }

  private hasOfficialSettingsCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_SETTINGS_COMMAND.name)
  }

  private hasOfficialConnectCommand(): boolean {
    return this.hasOfficialCommand('connect')
  }

  private hasOfficialStatusCommand(): boolean {
    return this.hasOfficialCommand(LOCAL_STATUS_COMMAND.name)
  }

  private hasOfficialCommand(name: string): boolean {
    return this.commands.some(command => command.name === name)
  }

  private featureRouteCommandBridge(): FeatureRouteCommandBridge | undefined {
    const host = this.options.features
    if (host === undefined) return undefined
    const routes = host.snapshot().availableRoutes ?? []
    if (routes.length === 0) return undefined
    return createFeatureRouteCommandBridge(routes, [
      ...this.commands,
      LOCAL_ATTACH_COMMAND,
      LOCAL_EXIT_COMMAND,
    ], HIDDEN_COMMAND_ROUTE_IDS)
  }

  private commandCandidates(): readonly CommandMenuCandidate[] {
    const reserved = new Set([
      LOCAL_ATTACH_COMMAND.name,
      LOCAL_EXIT_COMMAND.name,
    ])
    const featureRoutes = this.commandCatalogReady
      ? this.featureRouteCommandBridge()?.candidates ?? []
      : []
    const featureRouteNames = new Set(
      featureRoutes.map(candidate => candidate.command.name),
    )
    const visibleCommand = (name: string) => !(name === 'model' && featureRouteNames.has('models'))
      && !(name === 'mode' && featureRouteNames.has('modes'))
    const official = this.commands.filter(command => !reserved.has(command.name) && visibleCommand(command.name)).map(command => ({
      origin: 'official' as const,
      command,
    }))
    const legacyLocal = this.commandCatalogReady
      ? [
          this.hasOfficialSessionsCommand() ? undefined : LOCAL_SESSIONS_CANDIDATE,
          (this.options.settings === undefined && this.options.pluginInventory === undefined)
            || this.hasOfficialSettingsCommand()
            ? undefined
            : LOCAL_SETTINGS_CANDIDATE,
          this.hasOfficialStatusCommand() ? undefined : LOCAL_STATUS_CANDIDATE,
        ].filter((candidate): candidate is CommandMenuCandidate => candidate !== undefined)
      : []
    const local = [
      ...featureRoutes,
      ...legacyLocal.filter(candidate => !featureRouteNames.has(candidate.command.name)
        && visibleCommand(candidate.command.name)),
    ]
    const claimedNames = new Set([
      ...official.map(candidate => candidate.command.name),
      ...local.map(candidate => candidate.command.name),
      LOCAL_EXIT_COMMAND.name,
      LOCAL_WEB_COMMAND.name,
    ])
    const skills = this.currentBinding.skills.skills
      .filter(skill => !claimedNames.has(skill.name))
      .map((skill): CommandMenuCandidate => ({
        origin: 'skill',
        command: Object.freeze({
          name: skill.name,
          description: skill.description,
        }),
      }))
    return [
      ...official,
      ...local,
      ...skills,
      LOCAL_WEB_CANDIDATE,
      LOCAL_EXIT_CANDIDATE,
    ]
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
        && this.hasOfficialSettingsCommand()
        && this.settingsPage.isOpen
      ) {
        this.settingsPage.dismiss()
        binding.commandNotice = 'Official /settings command is now registered'
      }
      if (
        this.isCurrentBinding(binding)
        && this.hasOfficialStatusCommand()
        && binding.statusPanelOpen
      ) {
        binding.statusPanelOpen = false
        binding.commandNotice = 'Official /status command is now registered'
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
    if (this.interactionEditor.active?.kind === 'approval') this.scrollApprovalEvidence(this.interactionEditor.active, 0)
    const featureResize = this.options.featureSession?.resize(viewport)
    if (featureResize !== undefined) {
      void featureResize.catch((error: unknown) => { this.fail(error) })
    }
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
    if (this.switchAttempt !== undefined) {
      if (action.type === 'interrupt' || action.type === 'escape') {
        if (!this.switchAttempt.abort.signal.aborted) {
          const reason = new Error('DSH-TUI session switch cancelled by user')
          this.options.sessionNavigation?.cancelPending(reason)
          if (!this.switchAttempt.abort.signal.aborted) this.switchAttempt.abort.abort(reason)
          this.currentBinding.commandNotice = 'Cancelling session switch'
          this.scheduler.invalidate('immediate')
        } else if (action.type === 'interrupt') {
          this.forceShutdown()
        }
      }
      return
    }
    if (this.forkAttempt !== undefined) {
      if (action.type === 'interrupt' || action.type === 'escape') {
        if (!this.forkAttempt.abort.signal.aborted) {
          const reason = new Error('DSH-TUI session fork cancelled by user')
          this.options.sessionNavigation?.cancelPending(reason)
          if (!this.forkAttempt.abort.signal.aborted) this.forkAttempt.abort.abort(reason)
          this.currentBinding.commandNotice = 'Cancelling session fork'
          this.scheduler.invalidate('immediate')
        } else if (action.type === 'interrupt') {
          this.forceShutdown()
        }
      }
      return
    }
    if (this.currentBinding.permissionPicker.open) {
      this.handlePermissionPickerInput(action)
      return
    }
    if (this.settingsPage.isOpen) {
      this.settingsPage.handleInput(action)
      return
    }
    if (this.currentBinding.statusPanelOpen) {
      this.handleStatusPanelInput(action)
      return
    }
    if (this.currentBinding.goalActions.open) {
      this.handleGoalActionInput(action)
      return
    }
    const featureDispatch = this.options.features?.dispatchTerminalAction(action)
    if (featureDispatch?.handled === true) {
      void featureDispatch.completion.catch((error: unknown) => { this.fail(error) })
      return
    }
    if (action.type === 'toggle-goal-actions') {
      this.openGoalActions()
      return
    }
    if (action.type === 'toggle-activity') {
      this.toggleActivityRoute()
      return
    }
    if (action.type === 'toggle-reasoning') {
      this.toggleSessionReasoning(this.session.sessionId)
      this.scheduler.invalidate('immediate')
      return
    }
    if (action.type === 'toggle-transcript-details') {
      this.currentBinding.transcriptViewMode = this.currentBinding.transcriptViewMode === 'compact'
        ? 'verbose'
        : 'compact'
      this.scheduler.invalidate('immediate')
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
      || action.type === 'toggle-transcript-details'
      || action.type === 'toggle-goal-actions'
      || action.type === 'toggle-activity'
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

  private scrollApprovalEvidence(active: Extract<InteractionEditorState['active'], { kind: 'approval' }>, delta: number): void {
    const snapshot = this.interaction!
    const item = snapshot.pending.find(item => item.id === active.interactionId) as PendingApprovalInteraction
    const dock = buildApprovalDock(item, snapshot, selectDshTuiInputMode(this.prompt, this.interactionEditor),
      this.viewport.columns, approvalLayoutBudget(this.viewport).dockRows)
    const { offset, maxOffset } = dock.evidenceViewport
    this.interactionEditor = { ...this.interactionEditor, active: {
      ...active, scrollOffset: Math.max(0, Math.min(maxOffset, offset + delta)),
    } }
  }

  private handleInteractionInput(action: TerminalInputAction): void {
    if (action.type === 'submit') {
      const snapshot = this.interaction
      if (snapshot !== undefined) {
        const command = prepareInteractionSubmit(this.interactionEditor, snapshot)
        if (this.interactionEditor.active?.kind === 'approval'
          && command.response?.kind === 'approval' && command.response.outcome !== 'rejected'
          && (!approvalLayoutBudget(this.viewport).canInspect
            || (this.interactionEditor.active.allowSession === true && this.viewport.columns < 64 && approvalLayoutBudget(this.viewport).dockRows < 5))) {
          this.interactionEditor = { ...this.interactionEditor, active: {
            ...this.interactionEditor.active!, selectedIndex: 1, editor: createPromptEditorState(), scrollOffset: 0,
            error: 'Terminal too small to inspect approval evidence; enlarge it or Reject',
          } }
          this.scheduler.invalidate('immediate')
          return
        }
        this.applyInteractionCommand(command)
      }
      return
    }
    if (action.type === 'interrupt' || action.type === 'escape') {
      this.applyInteractionCommand(prepareInteractionCancel(this.interactionEditor))
      return
    }
    if (this.interactionEditor.active?.kind === 'approval') {
      if (action.type === 'toggle-transcript-details') {
        this.interactionEditor = { ...this.interactionEditor, active: {
          ...this.interactionEditor.active, detailsExpanded: !this.interactionEditor.active.detailsExpanded, scrollOffset: 0,
        } }
        this.scheduler.invalidate('immediate')
        return
      }
      if (action.type === 'page-up' || action.type === 'page-down') {
        this.scrollApprovalEvidence(this.interactionEditor.active, (action.type === 'page-up' ? -1 : 1) * 6)
        this.scheduler.invalidate('immediate')
        return
      }
      if (action.type === 'move-up' || action.type === 'move-down') {
        this.scrollApprovalEvidence(this.interactionEditor.active, action.type === 'move-up' ? -1 : 1)
        this.scheduler.invalidate('immediate')
        return
      }
      if (
        action.type === 'move-left'
        || action.type === 'move-right'
      ) {
        this.interactionEditor = moveApprovalSelection(
          this.interactionEditor,
          action.type === 'move-left'
            ? 'previous'
            : 'next',
        )
        this.scheduler.invalidate('immediate')
        return
      }
    }
    if (this.interactionEditor.active?.kind === 'plan-review') {
      if (
        action.type === 'move-left'
        || action.type === 'move-up'
        || action.type === 'move-right'
        || action.type === 'move-down'
      ) {
        this.interactionEditor = movePlanReviewSelection(
          this.interactionEditor,
          action.type === 'move-left' || action.type === 'move-up'
            ? 'previous'
            : 'next',
        )
        this.scheduler.invalidate('immediate')
      }
      return
    }
    if (this.interactionEditor.active?.kind === 'question') {
      const snapshot = this.interaction
      /* v8 ignore next -- the snapshot can disappear between subscription callbacks and input dispatch. */
      if (snapshot === undefined) return
      if (action.type === 'move-up' || action.type === 'move-down') {
        this.interactionEditor = moveQuestionFocus(
          this.interactionEditor,
          action.type === 'move-up' ? 'previous' : 'next',
        )
        this.scheduler.invalidate('immediate')
        return
      }
      if (action.type === 'complete') {
        this.applyInteractionCommand(
          prepareQuestionContinue(this.interactionEditor, snapshot),
        )
        return
      }
      if (action.type === 'save-default') {
        this.applyInteractionCommand(
          prepareQuestionSkip(this.interactionEditor, snapshot),
        )
        return
      }
      if (action.type === 'move-left' || action.type === 'move-right') {
        const active = this.interactionEditor.active
        const draft = active.drafts[active.questionIndex]
        if (draft !== undefined && active.optionIndex < draft.optionLabels.length) {
          this.interactionEditor = moveQuestionPage(
            this.interactionEditor,
            action.type === 'move-left' ? 'previous' : 'next',
          )
          this.scheduler.invalidate('immediate')
          return
        }
      }
    }
    if (
      action.type === 'move-up'
      || action.type === 'move-down'
      || action.type === 'complete'
      || action.type === 'save-default'
      || action.type === 'toggle-reasoning'
      || action.type === 'toggle-transcript-details'
      || action.type === 'toggle-goal-actions'
      || action.type === 'toggle-activity'
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

  private navigationBusy(): boolean {
    const binding = this.currentBinding
    return this.switchAttempt !== undefined || this.forkAttempt !== undefined
      || this.interactionEditor.active !== undefined
      || binding.submitTask !== undefined || binding.attachmentTask !== undefined
      || binding.commandTask !== undefined || binding.modeSelectTask !== undefined
      || binding.modelSelectTask !== undefined || binding.skillsRefreshTask !== undefined
  }

  /** Feature-owned navigation hands off to the candidate/commit transactions below. */
  private async navigateSession(request: SessionNavigationRequest): Promise<void> {
    request.signal.throwIfAborted()
    if (request.kind === 'activate' && request.sessionId === this.session.sessionId) return
    const source = this.currentBinding
    let attempt: SessionSwitchAttempt | SessionForkAttempt
    if (request.kind === 'activate') {
      if (this.options.activation === undefined) throw new Error('Session activation is unavailable')
      this.beginSessionSwitch(request.sessionId, request.intent)
      attempt = this.switchAttempt!
    } else {
      if (this.options.fork === undefined) throw new Error('Session fork is unavailable')
      const fork: SessionForkAttempt = {
        source, sourceRow: { sessionId: request.sessionId },
        abort: new AbortController(), task: Promise.resolve(),
      }
      this.forkAttempt = fork
      fork.task = Promise.resolve().then(() => this.runSessionFork(fork))
      attempt = fork
    }
    const cancel = (): void => { attempt.abort.abort(request.signal.reason) }
    request.signal.addEventListener('abort', cancel, { once: true })
    try {
      await attempt.task
      request.signal.throwIfAborted()
      if (attempt.failure !== undefined) throw attempt.failure
      if (this.currentBinding === source) throw new Error('Session navigation did not commit')
    } finally {
      request.signal.removeEventListener('abort', cancel)
    }
  }

  private isCurrentFork(attempt: SessionForkAttempt): boolean {
    return this.phase === 'running'
      && this.forkAttempt === attempt
      && this.isCurrentBinding(attempt.source)
      && !attempt.abort.signal.aborted
  }

  private async runSessionFork(attempt: SessionForkAttempt): Promise<void> {
    let candidate: SessionBinding | undefined
    let looseLease: ActivatedSessionLease | undefined
    try {
      looseLease = await this.options.fork!.forkSession({
        sourceSessionId: attempt.sourceRow.sessionId,
        signal: attempt.abort.signal,
      })
      if (!this.isCurrentFork(attempt)) return
      if (looseLease.port.sessionId === attempt.sourceRow.sessionId) {
        throw new Error('fork returned the source session instead of a new child')
      }
      if (this.findOpenBinding(looseLease.port.sessionId) !== undefined) {
        throw new Error(`fork returned already-open session "${looseLease.port.sessionId}"`)
      }
      const acquired = looseLease
      candidate = this.createBinding(acquired.port, 'candidate', () => acquired.release())
      looseLease = undefined
      await this.hydrateBinding(
        candidate,
        attempt.abort.signal,
        'session fork was cancelled',
      )
      if (!this.isCurrentFork(attempt)) return
      if (!await this.activateFeatureSessionForTransition(
        candidate.port,
        attempt.source.port,
        () => this.isCurrentFork(attempt),
      )) return
      attempt.source.role = 'background'
      attempt.source.commandNotice = undefined
      candidate.role = 'current'
      candidate.commandNotice = `Forked from ${attempt.sourceRow.sessionId}`
      this.currentBinding = candidate
      this.forkAttempt = undefined
    } catch (error: unknown) {
      const cleanupError = await this.cleanupFailedCandidate(candidate, looseLease)
      looseLease = undefined
      if (!this.isCurrentFork(attempt)) {
        attempt.failure = error
        if (cleanupError !== undefined) this.recordForkCleanupFailure(attempt, cleanupError)
        return
      }
      const detail = commandMessageOf(error)
      attempt.failure = cleanupError === undefined ? error
        : new AggregateError([error, cleanupError], 'Session transaction and cleanup failed')
      attempt.source.commandNotice = cleanupError === undefined
        ? `Session fork failed: ${detail}`
        : `Session fork failed: ${detail}; cleanup failed: ${cleanupMessageOf(cleanupError)}`
    } finally {
      let cleanupError: unknown | undefined
      if (candidate !== undefined && candidate.role === 'candidate') {
        cleanupError = await this.cleanupFailedCandidate(candidate, undefined)
      } else if (looseLease !== undefined) {
        cleanupError = await this.cleanupFailedCandidate(undefined, looseLease)
      }
      if (cleanupError !== undefined) this.recordForkCleanupFailure(attempt, cleanupError)
      if (this.forkAttempt === attempt) this.forkAttempt = undefined
      if (this.phase === 'running') this.scheduler.invalidate('immediate')
    }
  }

  private recordForkCleanupFailure(
    attempt: SessionForkAttempt,
    error: unknown,
  ): void {
    if (this.phase === 'running' && this.isCurrentBinding(attempt.source)) {
      attempt.source.commandNotice =
        `Session fork cleanup failed: ${cleanupMessageOf(error)}`
      this.scheduler.invalidate('immediate')
      return
    }
    this.forkCleanupError ??= error
  }

  private beginSessionSwitch(
    targetSessionId: string,
    intent: SessionActivationRequest['intent'],
  ): void {
    const source = this.currentBinding
    if (
      source.submitTask !== undefined
      || source.attachmentTask !== undefined
      || source.commandTask !== undefined
      || source.modeSelectTask !== undefined
      || source.modelSelectTask !== undefined
      || source.skillsRefreshTask !== undefined
    ) {
      source.commandNotice = 'Wait for the current session operation before switching'
      return
    }

    const cached = this.findOpenBinding(targetSessionId)
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
        await this.commitSessionSwitch(attempt, cached)
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
      await this.commitSessionSwitch(attempt, candidate)
    } catch (error: unknown) {
      const cleanupError = await this.cleanupFailedCandidate(candidate, looseLease)
      looseLease = undefined
      if (!this.isCurrentSwitch(attempt)) {
        attempt.failure = error
        if (cleanupError !== undefined) {
          this.recordSwitchCleanupFailure(attempt, cleanupError)
        }
        return
      }
      const detail = commandMessageOf(error)
      attempt.source.commandNotice = cleanupError === undefined
        ? `Session switch failed: ${detail}`
        : `Session switch failed: ${detail}; cleanup failed: ${cleanupMessageOf(cleanupError)}`
      attempt.failure = cleanupError === undefined ? error
        : new AggregateError([error, cleanupError], 'Session transaction and cleanup failed')
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

  private async commitSessionSwitch(
    attempt: SessionSwitchAttempt,
    target: SessionBinding,
  ): Promise<void> {
    if (!await this.activateFeatureSessionForTransition(
      target.port,
      attempt.source.port,
      () => this.isCurrentSwitch(attempt),
    )) return
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
    binding.attachmentAbort?.abort('DSH-TUI binding closed')
    binding.commandAbort?.abort('DSH-TUI binding closed')
    binding.modelRefreshAbort?.abort('DSH-TUI binding closed')
    binding.modelSelectAbort?.abort('DSH-TUI binding closed')
    binding.modeRefreshAbort?.abort('DSH-TUI binding closed')
    binding.modeSelectAbort?.abort('DSH-TUI binding closed')
    binding.permissionSelectAbort?.abort('DSH-TUI binding closed')
    binding.skillsRefreshAbort?.abort('DSH-TUI binding closed')
    const errors: unknown[] = []
    const stopCommands = binding.commandSubscription
    const stopModels = binding.modelSubscription
    const stopModes = binding.modeSubscription
    const stopSkills = binding.skillsSubscription
    const stopTools = binding.toolsSubscription
    const stopPermissions = binding.permissionsSubscription
    const stopContext = binding.contextSubscription
    const stopWorkbench = binding.workbenchSubscription
    const stopJobs = binding.jobsSubscription
    const stopDelegation = binding.delegationSubscription
    binding.commandSubscription = undefined
    binding.modelSubscription = undefined
    binding.modeSubscription = undefined
    binding.skillsSubscription = undefined
    binding.toolsSubscription = undefined
    binding.permissionsSubscription = undefined
    binding.contextSubscription = undefined
    binding.workbenchSubscription = undefined
    binding.jobsSubscription = undefined
    binding.delegationSubscription = undefined
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
      stopModes?.()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      stopSkills?.()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      stopTools?.()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      stopPermissions?.()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      stopContext?.()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      stopWorkbench?.()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      stopJobs?.()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      stopDelegation?.()
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
        binding.attachmentTask ?? Promise.resolve(),
        binding.modelRefreshTask ?? Promise.resolve(),
        binding.modelSelectTask ?? Promise.resolve(),
        binding.modeRefreshTask ?? Promise.resolve(),
        binding.modeSelectTask ?? Promise.resolve(),
        binding.permissionSelectTask ?? Promise.resolve(),
        binding.skillsRefreshTask ?? Promise.resolve(),
      ])
      this.bindings.delete(binding)
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, `DSH-TUI binding ${binding.epoch} release failed`)
    }
  }

  private startWebHandoff(): void {
    if (this.options.webHost === undefined) {
      this.commandNotice = 'Local /web is unavailable in this environment'
      this.scheduler.invalidate('immediate')
      return
    }
    if (this.webHandoffTask !== undefined) return
    const binding = this.currentBinding
    const current = this.modelSnapshot(binding).current
    this.webHandoffTask = Promise.resolve()
    this.webHandoffTask
      .then(() => this.options.catalog.listSessions({}))
      .catch(() => undefined)
      .then((snapshot) => {
        const entry = snapshot?.sessions.find(
          candidate => candidate.sessionId === binding.port.sessionId,
        )
        this.pendingWebHostSummary = {
          sessionId: binding.port.sessionId,
          ...(entry?.cwd === undefined ? {} : { cwd: entry.cwd }),
          ...(current === undefined ? {} : { model: modelSelectionLabel(current) }),
          ...(entry === undefined ? {} : { startedAt: entry.createdAt }),
        }
      })
      .finally(() => {
        this.webHandoffTask = undefined
        if (this.phase === 'running') this.beginGraceful('web-handoff')
      })
  }

  private openLocalCommand(name: string): void {
    if (name === LOCAL_EXIT_COMMAND.name) {
      this.beginGraceful('user')
      return
    }
    if (name === LOCAL_WEB_COMMAND.name) {
      this.startWebHandoff()
      return
    }
    if (name === 'model' || name === 'mode') {
      this.openModelModeAlias(name)
      return
    }
    if (this.tryOpenFeatureRoute(`/${name}`)) return
    if (name === LOCAL_SESSIONS_COMMAND.name) {
      this.commandNotice = `Local /${name} is unavailable in this environment`
      this.scheduler.invalidate('immediate')
      return
    }
    if (
      name === LOCAL_SKILLS_COMMAND.name
      || name === LOCAL_TOOLS_COMMAND.name
      || name === LOCAL_MCP_COMMAND.name
    ) {
      if (this.tryOpenFeatureRoute('/capabilities')) return
      this.commandNotice = `Local /${name} is unavailable in this environment`
      this.scheduler.invalidate('immediate')
      return
    }
    if (name === LOCAL_SETTINGS_COMMAND.name) {
      this.openRuntimeLibrary()
      return
    }
    if (name === LOCAL_STATUS_COMMAND.name) {
      this.openLocalStatusPanel()
      return
    }
    if (name === 'connect') {
      this.openLocalSettingsProviders()
    }
  }

  private openModelModeAlias(name: 'model' | 'mode'): void {
    if (this.tryOpenFeatureRoute(`/${name}s`)) return
    this.commandNotice = `Local /${name} is unavailable in this environment`
    this.scheduler.invalidate('immediate')
  }

  private toggleActivityRoute(): void {
    const host = this.options.features
    const route = host?.snapshot().navigation.route
    if (route?.kind === 'workspace' && route.featureId === 'activity') {
      void host!.openRoute('chat').catch((error: unknown) => { this.fail(error) })
      this.scheduler.invalidate('immediate')
      return
    }
    if (this.tryOpenFeatureRoute('/activity')) return
    this.commandNotice = 'Local /activity is unavailable in this environment'
    this.scheduler.invalidate('immediate')
  }

  private consumeNavigationPrompt(binding: SessionBinding, names: readonly string[]): void {
    if (names.some(name => binding.prompt.text.trim() === `/${name}`)) {
      binding.prompt = createPromptEditorState()
    }
  }

  private tryOpenFeatureRoute(line: string, unavailable?: () => void): boolean {
    const host = this.options.features
    const bridge = this.featureRouteCommandBridge()
    if (host === undefined || bridge === undefined) return false
    const dispatch = bridge.tryOpen(line, host)
    if (dispatch.kind === 'not-feature-route') return false
    if (dispatch.kind === 'invalid-input') {
      this.commandNotice = `Local /${dispatch.command.name} does not accept input`
      this.scheduler.invalidate('immediate')
      return true
    }
    this.beginFeatureRouteOpen(dispatch, unavailable)
    return true
  }

  private beginFeatureRouteOpen(
    dispatch: Extract<FeatureRouteCommandDispatch, { readonly kind: 'opened' }>,
    unavailable?: () => void,
  ): void {
    const binding = this.currentBinding
    this.consumeNavigationPrompt(binding, [
      dispatch.routeId,
      ...(dispatch.routeId === 'models' ? ['model'] : dispatch.routeId === 'modes' ? ['mode'] : []),
      ...(dispatch.routeId === 'capabilities' ? ['skills', 'tools', 'mcp'] : []),
    ])
    this.commandMenu = createCommandMenuState()
    this.commandNotice = `Opening /${dispatch.routeId}`
    const task = dispatch.completion.then(
      () => {
        if (this.featureRouteTask !== task || this.phase !== 'running' || !this.isCurrentBinding(binding)) return
        this.commandNotice = undefined
      },
      (error: unknown) => {
        if (this.featureRouteTask !== task || this.phase !== 'running' || !this.isCurrentBinding(binding)) return
        this.commandNotice = `Feature route unavailable: ${commandMessageOf(error)}`
        unavailable?.()
      },
    ).finally(() => {
      if (this.featureRouteTask === task) this.featureRouteTask = undefined
      if (this.phase === 'running') this.scheduler.invalidate('immediate')
    })
    this.featureRouteTask = task
    this.scheduler.invalidate('immediate')
  }

  private async activateFeatureSessionForTransition(
    target: DshTuiProductPort,
    source: DshTuiProductPort,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const runtime = this.options.featureSession
    if (runtime === undefined) return isCurrent()
    await runtime.activate(target, this.viewport)
    if (isCurrent()) return true
    await runtime.activate(source, this.viewport)
    return false
  }

  private openGoalActions(): void {
    const binding = this.currentBinding
    const snapshot = binding.workbench
    const goal = goalActionTarget(snapshot)
    if (goal === undefined) {
      if (snapshot.goal === undefined) {
        binding.commandNotice = 'Goal projections are unavailable in this Session composition'
      } else if (binding.prompt.text.trim() !== '') {
        binding.commandNotice = 'Goal creation uses /goal; finish or clear the current draft first'
      } else {
        binding.prompt = createPromptEditorState('/goal ')
        binding.commandMenu = createCommandMenuState()
        binding.commandNotice = 'Goal creation stays on the official /goal command'
      }
      this.scheduler.invalidate('immediate')
      return
    }
    if (binding.port.runGoalAction === undefined) {
      binding.commandNotice = 'Goal actions are unavailable in this Session lease'
      this.scheduler.invalidate('immediate')
      return
    }
    binding.commandMenu = createCommandMenuState()
    binding.commandNotice = undefined
    binding.goalActions = openGoalActionSurface(binding.goalActions, snapshot)
    this.scheduler.invalidate('immediate')
  }

  private handleGoalActionInput(action: TerminalInputAction): void {
    const binding = this.currentBinding
    if (action.type === 'toggle-activity') {
      binding.goalActions = createGoalActionSurfaceState()
      this.toggleActivityRoute()
      return
    }
    let surfaceAction: GoalActionSurfaceAction | undefined
    switch (action.type) {
      case 'move-up':
      case 'move-down':
        surfaceAction = action
        break
      case 'submit':
        surfaceAction = { type: 'enter' }
        break
      case 'escape':
      case 'interrupt':
      case 'toggle-goal-actions':
        surfaceAction = { type: 'escape' }
        break
      case 'insert':
      case 'backspace':
      case 'delete':
      case 'move-left':
      case 'move-right':
      case 'move-home':
      case 'move-end': {
        const editorAction = promptAction(action)
        /* v8 ignore next -- every action in this narrowed branch maps to an editor action. */
        if (editorAction === undefined) return
        const state = reduceGoalActionSurfaceEditor(binding.goalActions, editorAction)
        if (state !== binding.goalActions) {
          binding.goalActions = state
          this.scheduler.invalidate('immediate')
        }
        return
      }
      case 'newline':
      case 'complete':
      case 'save-default':
      case 'toggle-reasoning':
      case 'toggle-transcript-details':
      case 'paste-image':
      case 'page-up':
      case 'page-down':
      case 'ignored':
        return
    }

    const transition = applyGoalActionSurfaceAction(
      binding.goalActions,
      binding.workbench,
      surfaceAction,
    )
    binding.goalActions = transition.state
    if (transition.outcome?.kind === 'execute') {
      let receipt: SessionWorkbenchGoalActionReceipt
      try {
        // Opening this surface already proved the immutable Session lease owns the capability.
        receipt = binding.port.runGoalAction!(transition.outcome.action)
      } catch (error: unknown) {
        receipt = {
          accepted: false,
          code: 'goal-action-failed',
          message: commandMessageOf(error),
        }
      }
      if (receipt.accepted) {
        binding.goalActions = createGoalActionSurfaceState()
        binding.commandNotice = transition.outcome.successMessage
      } else {
        binding.goalActions = rejectGoalActionSurface(
          binding.goalActions,
          `${receipt.code}: ${receipt.message}`,
        )
      }
    }
    this.scheduler.invalidate('immediate')
  }

  private openLocalStatusPanel(): void {
    this.prompt = createPromptEditorState()
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    this.currentBinding.context = this.contextSnapshot()
    this.currentBinding.statusPanelOpen = true
    this.currentBinding.statusPanelOffset = 0
    this.scheduler.invalidate('immediate')
  }

  private handleStatusPanelInput(action: TerminalInputAction): void {
    const binding = this.currentBinding
    const active = this.activeSession(binding)
    const viewport = statusDetailViewport({
      sessionId: binding.port.sessionId,
      context: binding.context,
      ...(active?.compaction === undefined ? {} : { compaction: active.compaction }),
      ...(active?.llmAttempts === undefined ? {} : { attempts: active.llmAttempts }),
      ...(active?.requestRoutes === undefined ? {} : { routes: active.requestRoutes }),
    }, this.viewport, binding.statusPanelOffset)
    const navigation = navigateLegacyDirectory(
      { navigation: { focus: 'details', detailOffset: viewport.offset } }, action,
      { searchEnabled: false, maxDetailOffset: viewport.maxOffset, pageSize: Math.max(1, this.viewport.rows - 2) },
    )
    binding.statusPanelOffset = navigation.navigation.detailOffset
    this.scheduler.invalidate('immediate')
    if (
      action.type !== 'interrupt'
      && action.type !== 'escape'
      && action.type !== 'submit'
    ) return
    binding.statusPanelOpen = false
    this.scheduler.invalidate('immediate')
  }

  private openLocalSettingsProviders(): void {
    if (this.settingsPage.providers === undefined) {
      this.commandNotice = 'Provider connection is unavailable in this Host composition'
      this.scheduler.invalidate('immediate')
      return
    }
    this.prompt = createPromptEditorState()
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    this.settingsPage.openAtProviders()
  }

  private handleModesChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    this.refreshModeDerivedState(binding)
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private refreshModeDerivedState(binding: SessionBinding): void {
    binding.mode = this.modeSnapshot(binding)
    binding.skills = this.skillsSnapshot(binding)
    binding.tools = this.toolsSnapshot(binding)
    binding.permissions = this.permissionSnapshot(binding)
    binding.permissionPicker = reconcilePermissionPicker(
      binding.permissionPicker,
      binding.permissions,
    )
    binding.context = this.contextSnapshot(binding)
    binding.workbench = this.workbenchSnapshot(binding)
    binding.jobs = this.jobsSnapshot(binding)
    binding.delegation = this.delegationSnapshot(binding)
    binding.goalActions = reconcileGoalActionSurface(binding.goalActions, binding.workbench)
    this.refreshCommands(binding)
    this.beginSkillsRefresh(binding)
  }

  private handleSkillsChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    binding.skills = this.skillsSnapshot(binding)
    this.refreshCommands(binding)
    if (!binding.skills.complete && !binding.skills.loading) {
      this.beginSkillsRefresh(binding)
    }
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private beginSkillsRefresh(binding: SessionBinding): void {
    const refresh = binding.port.refreshSkills
    binding.skills = this.skillsSnapshot(binding)
    if (refresh === undefined || !binding.skills.available) return
    if (binding.skillsRefreshTask !== undefined) return
    const epoch = binding.epoch
    const generation = ++binding.skillsRefreshGeneration
    const abort = new AbortController()
    binding.skillsRefreshAbort = abort
    let task!: Promise<void>
    task = Promise.resolve()
      .then(() => refresh.call(binding.port, abort.signal))
      .catch(() => {
        // Prewarm for `/<skill-name>` menu candidates stays silent on failure.
      })
      .finally(() => {
        binding.skillsRefreshTask = undefined
        binding.skillsRefreshAbort = undefined
        if (!this.isExactSkillsRefresh(binding, epoch, generation)) return
        binding.skills = this.skillsSnapshot(binding)
        this.refreshCommands(binding)
        if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
      })
    binding.skillsRefreshTask = task
  }

  private isExactSkillsRefresh(
    binding: SessionBinding,
    epoch: number,
    generation: number,
  ): boolean {
    return binding.skillsRefreshGeneration === generation
      && this.isBindingOpen(binding, epoch)
  }

  private handleToolsChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    binding.tools = this.toolsSnapshot(binding)
    this.refreshCommands(binding)
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private openRuntimeLibrary(): void {
    if (this.settingsPage.pendingCount !== 0) {
      this.commandNotice = 'Settings write is still committing'
      this.scheduler.invalidate('immediate')
      return
    }
    this.consumeNavigationPrompt(this.currentBinding, ['settings'])
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    this.settingsPage.open()
    this.scheduler.invalidate('immediate')
  }

  /** Compatibility seams for tests; the settings page session owns the mutation plumbing. */
  beginSettingsMutation(request: SettingsMutationRequest): void {
    this.settingsPage.beginSettingsMutation(request)
  }

  beginSettingsPageSave(requests: readonly SettingsMutationRequest[]): void {
    this.settingsPage.beginSettingsPageSave(requests)
  }

  finishSettingsMutation(task: Promise<void>, error: string | undefined): void {
    this.settingsPage.finishSettingsMutation(task, error)
  }

  private openLocalPermissionPicker(value = ''): void {
    const binding = this.currentBinding
    binding.permissions = this.permissionSnapshot(binding)
    if (!binding.permissions.available) {
      binding.commandNotice = 'Permission presets are unavailable in this Session composition'
      this.scheduler.invalidate('immediate')
      return
    }
    if (localPermissionInput(binding.prompt.text) !== undefined) binding.prompt = createPromptEditorState()
    binding.commandMenu = createCommandMenuState()
    binding.commandNotice = undefined
    binding.permissionPicker = openPermissionPicker(
      binding.permissionPicker,
      binding.permissions,
    )
    if (value !== '') {
      const index = binding.permissions.options.findIndex(option => option.value === value)
      if (index < 0) binding.commandNotice = `Unknown permission preset: ${value}`
      else binding.permissionPicker = { open: true, selectedIndex: index, selectedValue: value }
    }
    this.scheduler.invalidate('immediate')
  }

  private handlePermissionPickerInput(action: TerminalInputAction): void {
    const binding = this.currentBinding
    if (binding.permissionPicker.confirmation === undefined && action.type === 'insert' && action.text === 'r') {
      const count = binding.port.clearSessionApprovals?.() ?? 0
      binding.commandNotice = count > 0 ? 'Remembered approvals cleared. Future requests will ask again.' : 'No remembered approvals in this session.'
      this.scheduler.invalidate('immediate')
      return
    }
    if (binding.permissionPicker.confirmation === undefined) {
      const pickerView = { ...selectPermissionPicker(binding.permissionPicker, binding.permissions)!,
        rememberedApprovalCount: this.interaction?.rememberedApprovalCount ?? 0 }
      const maxDetailOffset = renderPermissionWorkspace(pickerView, this.viewport, binding.commandNotice).detailMaxOffset ?? 0
      const navigation = navigateLegacyDirectory(binding.permissionPicker, action, { searchEnabled: false, maxDetailOffset, pageSize: Math.max(1, this.viewport.rows - 4) })
      binding.permissionPicker = { ...binding.permissionPicker, navigation: navigation.navigation }
      if (navigation.action === undefined) {
        this.scheduler.invalidate('immediate')
        return
      }
      action = navigation.action
    }
    let pickerAction: PermissionPickerAction | undefined
    switch (action.type) {
      case 'move-up':
      case 'move-down':
        pickerAction = action
        break
      case 'move-left':
        pickerAction = { type: 'confirm-previous' }
        break
      case 'move-right':
        pickerAction = { type: 'confirm-next' }
        break
      case 'submit':
        pickerAction = { type: 'enter' }
        break
      case 'escape':
      case 'interrupt':
        pickerAction = { type: 'escape' }
        break
      default:
        break
    }
    if (pickerAction === undefined) return
    if (pickerAction.type === 'enter' && binding.permissionPicker.confirmation?.selectedIndex === 1
      && !permissionConfirmationLayout(selectPermissionPicker(binding.permissionPicker, binding.permissions)!,
        secondarySurfaceGeometry(this.viewport, 'compact').viewport).canInspect) {
      binding.commandNotice = 'Terminal too small to inspect permission changes; enlarge it or Cancel'
      this.scheduler.invalidate('immediate')
      return
    }
    const transition = applyPermissionPickerAction(
      binding.permissionPicker,
      binding.permissions,
      pickerAction,
    )
    binding.permissionPicker = { ...transition.state, navigation: binding.permissionPicker.navigation! }
    this.handlePermissionPickerOutcome(binding, transition.outcome)
    this.scheduler.invalidate('immediate')
  }

  private handlePermissionPickerOutcome(
    binding: SessionBinding,
    outcome: PermissionPickerOutcome | undefined,
  ): void {
    if (outcome === undefined) return
    switch (outcome.kind) {
      case 'selected':
        this.beginPermissionSelection(binding, outcome.value, outcome.confirmation)
        return
      case 'confirmation-required':
        binding.commandNotice = 'Review the wider permission policy; Cancel is selected by default'
        return
      case 'cancelled':
        this.dismissPermissionPicker(binding)
        return
      case 'blocked':
        binding.commandNotice = {
          unavailable: 'Permission presets are unavailable in this Session composition',
          stale: 'Permission state is stale; wait for the live Session projection',
          'read-only': 'Official permission switching is unavailable in this Session lease',
          selecting: 'A permission switch is already running',
          unchanged: 'This Session already uses the selected permission preset',
          'current-only': 'Custom permission state is current-only and cannot be selected',
          'no-selection': 'No permission preset is available to select',
          'missing-policy': 'Permission policy details are unavailable; switching is blocked',
        }[outcome.reason]
    }
  }

  private handlePermissionsChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    binding.permissions = this.permissionSnapshot(binding)
    binding.permissionPicker = reconcilePermissionPicker(
      binding.permissionPicker,
      binding.permissions,
    )
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private dismissPermissionPicker(binding = this.currentBinding): void {
    binding.permissionPicker = createPermissionPickerState()
    binding.permissionSelectGeneration += 1
    binding.permissionSelectAbort?.abort('DSH-TUI permission control closed')
    this.scheduler.invalidate('immediate')
  }

  private beginPermissionSelection(binding: SessionBinding, value: string, confirmation?: PermissionConfirmation): void {
    const select = binding.port.selectPermission
    if (select === undefined) {
      binding.commandNotice = 'Permission switching is unavailable in this Session lease'
      this.scheduler.invalidate('immediate')
      return
    }
    if (binding.permissionSelectTask !== undefined) {
      binding.commandNotice = 'A permission switch is already running'
      this.scheduler.invalidate('immediate')
      return
    }
    const epoch = binding.epoch
    const generation = ++binding.permissionSelectGeneration
    const abort = new AbortController()
    binding.permissionSelectAbort = abort
    let task!: Promise<void>
    task = Promise.resolve()
      .then(() => select.call(binding.port, value, {
        signal: abort.signal,
        ...(confirmation === undefined ? {} : { confirmation }),
      }))
      .then(() => {
        if (!this.isExactPermissionSelection(binding, epoch, generation)) return
        binding.permissions = this.permissionSnapshot(binding)
        binding.permissionPicker = createPermissionPickerState()
        binding.commandNotice = `Permission preset switched: ${value}`
      })
      .catch((error: unknown) => {
        if (!this.isExactPermissionSelection(binding, epoch, generation)) return
        if (abort.signal.aborted) return
        binding.permissions = this.permissionSnapshot(binding)
        binding.permissionPicker = reconcilePermissionPicker(
          binding.permissionPicker,
          binding.permissions,
        )
        binding.commandNotice = `Permission switch failed: ${commandMessageOf(error)}`
      })
      .finally(() => {
        binding.permissionSelectTask = undefined
        binding.permissionSelectAbort = undefined
        if (!this.isExactPermissionSelection(binding, epoch, generation)) return
        binding.permissions = this.permissionSnapshot(binding)
        if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
      })
    binding.permissionSelectTask = task
  }

  private isExactPermissionSelection(
    binding: SessionBinding,
    epoch: number,
    generation: number,
  ): boolean {
    return binding.permissionSelectGeneration === generation
      && this.isBindingOpen(binding, epoch)
  }

  private handleModelsChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    this.refreshModelSnapshot(binding)
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private handleContextChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    binding.context = this.contextSnapshot(binding)
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private handleWorkbenchChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    binding.workbench = this.workbenchSnapshot(binding)
    binding.goalActions = reconcileGoalActionSurface(
      binding.goalActions,
      binding.workbench,
    )
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private handleJobsChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    binding.jobs = this.jobsSnapshot(binding)
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private handleDelegationChanged(binding: SessionBinding): void {
    if (this.phase !== 'running' || !this.isBindingOpen(binding)) return
    binding.delegation = this.delegationSnapshot(binding)
    if (this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
  }

  private handlePromptInput(
    action: Exclude<TerminalInputAction, {
      readonly type:
        | 'toggle-reasoning'
        | 'toggle-transcript-details'
        | 'toggle-goal-actions'
        | 'toggle-activity'
    }>,
  ): void {
    if (action.type === 'paste-image') {
      this.runClipboardPaste()
      return
    }
    if (action.type === 'interrupt') {
      if (this.currentBinding.attachmentTask !== undefined) {
        const abort = this.currentBinding.attachmentAbort!
        if (!abort.signal.aborted) {
          abort.abort('DSH-TUI image loading cancelled by user')
          this.commandNotice = 'Cancelling image load'
          this.scheduler.invalidate('immediate')
        } else {
          this.forceShutdown()
        }
        return
      }
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
      const request = this.currentBinding.agentRequest
      if (isAgentRequestActive(request)) {
        if (!this.session.ownsAgentLifecycle) {
          this.beginGraceful('user')
          return
        }
        if (request.cancelRequested) {
          this.forceShutdown()
          return
        }
        const submitAbort = this.currentBinding.submitAbort
        if (submitAbort !== undefined && !submitAbort.signal.aborted) {
          submitAbort.abort(new Error('Prompt submission cancelled by user'))
        }
        const cancelAgent = status === 'running' || request.accepted
        this.currentBinding.agentRequest = requestAgentCancellation(request, cancelAgent)
        if (cancelAgent) {
          this.session.cancel({ kind: 'user' })
          this.currentBinding.requestCancelDispatched = true
          this.reconcileAgentRequestCancellation(this.currentBinding)
        }
        this.commandNotice = 'Cancelling request'
        this.scheduler.invalidate('immediate')
        return
      }
      if (status === 'running') {
        if (!this.session.ownsAgentLifecycle) {
          this.beginGraceful('user')
          return
        }
        this.session.cancel({ kind: 'user' })
      } else if (this.prompt.text !== '' || this.currentBinding.promptImages.length > 0) {
        this.prompt = createPromptEditorState()
        this.currentBinding.promptImages = []
        this.scheduler.invalidate('immediate')
      } else {
        this.beginGraceful(status === 'disposed' ? 'runtime-disposed' : 'user')
      }
      return
    }
    if (action.type === 'submit' && this.currentBinding.modeSelectTask !== undefined) {
      this.commandNotice = 'Agent mode selection is still being validated'
      this.scheduler.invalidate('immediate')
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
      if (localPermissionInput(this.prompt.text) !== undefined
        || /^\/(?:model|mode)\s*$/u.test(this.prompt.text)) {
        this.submitPrompt()
        return
      }
      const selected = menu?.candidates[menu.selectedIndex]
      if (selected !== undefined) {
        if (selected.origin === 'skill') {
          this.completeMenuCandidate(selected)
        } else if (selected.origin === 'local') {
          if (this.prompt.text.trim() === `/${selected.command.name}`) {
            this.openLocalCommand(selected.command.name)
          } else {
            this.submitPrompt()
          }
        } else if (selected.command.input !== undefined) {
          this.completeCommand(selected.command)
        } else {
          this.executeCommandLine(`/${selected.command.name}`, selected.command)
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
      } else if (this.prompt.text !== '' || this.currentBinding.promptImages.length > 0) {
        this.prompt = createPromptEditorState()
        this.currentBinding.promptImages = []
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
    if (this.submitTask !== undefined) return
    if (this.currentBinding.attachmentTask !== undefined) {
      this.commandNotice = 'Wait for the image to finish loading'
      this.scheduler.invalidate('immediate')
      return
    }
    if (this.prompt.text.trim() === '' && this.currentBinding.promptImages.length === 0) return
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
    if (text.trim() === '/model' || text.trim() === '/mode') {
      this.openModelModeAlias(text.trim() === '/model' ? 'model' : 'mode')
      return
    }
    for (const command of ['exit', 'stop', 'web'] as const) {
      const input = localSafetyInput(text, command)
      if (input === undefined) continue
      if (input.trim() !== '') {
        this.commandNotice = `Local /${command} does not accept input`
        this.scheduler.invalidate('immediate')
      } else {
        this.openLocalCommand(command)
      }
      return
    }
    const attachInput = localAttachInput(text)
    if (attachInput !== undefined) {
      this.runAttachCommand(attachInput)
      return
    }
    const permissionInput = localPermissionInput(text)
    if (permissionInput !== undefined) {
      this.openLocalPermissionPicker(permissionInput.trim())
      return
    }
    if (text.startsWith('/') && !this.commandCatalogReady) {
      this.commandNotice ??= 'Command catalog is unavailable'
      this.scheduler.invalidate('immediate')
      return
    }
    if (this.tryOpenFeatureRoute(text)) return
    const localInput = this.hasOfficialSessionsCommand()
      ? undefined
      : localSessionsInput(text)
    if (localInput !== undefined) {
      if (localInput.trim() !== '') {
        this.commandNotice = 'Local /sessions does not accept input'
      } else {
        this.commandNotice = 'Local /sessions is unavailable in this environment'
      }
      this.scheduler.invalidate('immediate')
      return
    }
    const localModel = this.hasOfficialModelCommand()
      ? undefined
      : localModelInput(text)
    if (localModel !== undefined) {
      this.commandNotice = 'Local /model does not accept input'
      this.scheduler.invalidate('immediate')
      return
    }
    const localMode = !this.currentBinding.mode.available || this.hasOfficialModeCommand()
      ? undefined
      : localModeInput(text)
    if (localMode !== undefined) {
      this.commandNotice = 'Local /mode does not accept input'
      this.scheduler.invalidate('immediate')
      return
    }
    const localSkills = !this.currentBinding.skills.available || this.hasOfficialSkillsCommand()
      ? undefined
      : localSkillsInput(text)
    if (localSkills !== undefined) {
      if (localSkills.trim() !== '') {
        this.commandNotice = 'Local /skills does not accept input'
        this.scheduler.invalidate('immediate')
      } else if (!this.tryOpenFeatureRoute('/capabilities')) {
        this.commandNotice = 'Local /skills is unavailable in this environment'
        this.scheduler.invalidate('immediate')
      }
      return
    }
    const localTools = !this.currentBinding.tools.available || this.hasOfficialToolsCommand()
      ? undefined
      : localToolsInput(text)
    if (localTools !== undefined) {
      if (localTools.trim() !== '') {
        this.commandNotice = 'Local /tools does not accept input'
        this.scheduler.invalidate('immediate')
      } else if (!this.tryOpenFeatureRoute('/capabilities')) {
        this.commandNotice = 'Local /tools is unavailable in this environment'
        this.scheduler.invalidate('immediate')
      }
      return
    }
    const localMcp = !this.currentBinding.tools.available || this.hasOfficialMcpCommand()
      ? undefined
      : localMcpInput(text)
    if (localMcp !== undefined) {
      if (localMcp.trim() !== '') {
        this.commandNotice = 'Local /mcp does not accept input'
        this.scheduler.invalidate('immediate')
      } else if (!this.tryOpenFeatureRoute('/capabilities')) {
        this.commandNotice = 'Local /mcp is unavailable in this environment'
        this.scheduler.invalidate('immediate')
      }
      return
    }
    const localSettings = (this.options.settings === undefined
      && this.options.pluginInventory === undefined)
      || this.hasOfficialSettingsCommand()
      ? undefined
      : localSettingsInput(text)
    if (localSettings !== undefined) {
      if (localSettings.trim() !== '') {
        this.commandNotice = 'Local /settings does not accept input'
        this.scheduler.invalidate('immediate')
      } else {
        this.openRuntimeLibrary()
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
        this.openLocalSettingsProviders()
      }
      return
    }
    const localActivity = this.hasOfficialCommand('activity')
      ? undefined
      : localActivityInput(text)
    if (localActivity !== undefined) {
      if (localActivity.trim() !== '') {
        this.commandNotice = 'Local /activity does not accept input'
      } else {
        this.commandNotice = 'Local /activity is unavailable in this environment'
      }
      this.scheduler.invalidate('immediate')
      return
    }
    const localStatus = this.hasOfficialStatusCommand()
      ? undefined
      : localStatusInput(text)
    if (localStatus !== undefined) {
      if (localStatus.trim() !== '') {
        this.commandNotice = 'Local /status does not accept input'
        this.scheduler.invalidate('immediate')
      } else {
        this.openLocalStatusPanel()
      }
      return
    }
    const statusAlias = localStatusAliasInput(text)
    if (statusAlias !== undefined && !this.hasOfficialCommand(statusAlias.name)) {
      if (statusAlias.input.trim() !== '') {
        this.commandNotice = `Local /${statusAlias.name} does not accept input`
        this.scheduler.invalidate('immediate')
      } else {
        this.openLocalStatusPanel()
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
      this.executeCommandLine(text, decision.command)
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
    if (candidate.origin === 'skill') {
      this.prompt = createPromptEditorState(`/${candidate.command.name} `)
      this.commandMenu = createCommandMenuState()
      this.commandNotice = undefined
      this.scheduler.invalidate('immediate')
      return
    }
    if (candidate.origin === 'local') {
      this.prompt = createPromptEditorState(`/${candidate.command.name}`)
      this.commandMenu = createCommandMenuState()
      this.commandNotice = undefined
      this.scheduler.invalidate('immediate')
      return
    }
    this.completeCommand(candidate.command)
  }

  private runAttachCommand(rawInput: string): void {
    const binding = this.currentBinding
    const value = rawInput.trim()
    if (value === '') {
      binding.prompt = createPromptEditorState('/attach ')
      binding.commandMenu = createCommandMenuState()
      binding.commandNotice = 'Add an image path, or use clear / remove N'
      this.scheduler.invalidate('immediate')
      return
    }
    if (value === 'clear') {
      const count = binding.promptImages.length
      binding.promptImages = []
      binding.prompt = createPromptEditorState()
      binding.commandMenu = createCommandMenuState()
      binding.commandNotice = count === 0 ? 'No staged images' : `Cleared ${count} staged image${count === 1 ? '' : 's'}`
      this.scheduler.invalidate('immediate')
      return
    }
    const remove = /^remove\s+(\d+)$/u.exec(value)
    if (remove !== null) {
      const index = Number(remove[1]) - 1
      const image = binding.promptImages[index]
      if (image === undefined) {
        binding.commandNotice = `No staged image ${remove[1]}`
      } else {
        binding.promptImages = binding.promptImages.filter((_, candidate) => candidate !== index)
        binding.prompt = createPromptEditorState()
        binding.commandMenu = createCommandMenuState()
        binding.commandNotice = `Removed ${image.name}`
      }
      this.scheduler.invalidate('immediate')
      return
    }
    if (value === 'remove') {
      binding.commandNotice = 'Use /attach remove N'
      this.scheduler.invalidate('immediate')
      return
    }
    const prepare = binding.port.prepareImage
    const snapshot = this.attachmentSnapshot(binding)
    if (!snapshot.available || prepare === undefined) {
      binding.commandNotice = 'Image attachments are unavailable'
      this.scheduler.invalidate('immediate')
      return
    }
    if (
      snapshot.maxImagesPerMessage !== undefined
      && binding.promptImages.length >= snapshot.maxImagesPerMessage
    ) {
      binding.commandNotice = `At most ${snapshot.maxImagesPerMessage} images can be sent together`
      this.scheduler.invalidate('immediate')
      return
    }
    const path = unquoteImagePath(value)
    if (path === '') {
      binding.commandNotice = 'Image path is empty'
      this.scheduler.invalidate('immediate')
      return
    }
    const line = `/attach${rawInput}`
    const abort = new AbortController()
    binding.attachmentAbort = abort
    binding.prompt = createPromptEditorState()
    binding.commandMenu = createCommandMenuState()
    binding.commandNotice = 'Loading image…'
    this.scheduler.invalidate('immediate')

    let task!: Promise<void>
    task = Promise.resolve()
      .then(() => prepare.call(binding.port, path, abort.signal))
      .then(
        (image: PromptImageInput) => {
          if (!this.isBindingOpen(binding) || abort.signal.aborted) return
          const stagingError = imageStagingError(binding.promptImages, image, snapshot)
          if (stagingError !== undefined) {
            binding.commandNotice = stagingError
            if (this.isCurrentBinding(binding) && binding.prompt.text === '') {
              binding.prompt = createPromptEditorState(line)
            }
            return
          }
          binding.promptImages = [...binding.promptImages, image]
          binding.commandNotice = `Attached ${image.name}`
        },
        (error: unknown) => {
          if (!this.isBindingOpen(binding) || abort.signal.aborted) return
          if (this.isCurrentBinding(binding) && binding.prompt.text === '') {
            binding.prompt = createPromptEditorState(line)
          }
          binding.commandNotice = `Image not attached: ${commandMessageOf(error)}`
        },
      )
      .finally(() => {
        if (binding.attachmentTask === task) binding.attachmentTask = undefined
        if (binding.attachmentAbort === abort) binding.attachmentAbort = undefined
        if (this.phase === 'running' && this.isCurrentBinding(binding)) {
          this.scheduler.invalidate('immediate')
        }
      })
    binding.attachmentTask = task
  }

  private runClipboardPaste(): void {
    const binding = this.currentBinding
    if (binding.attachmentTask !== undefined) {
      binding.commandNotice = 'Wait for the image to finish loading'
      this.scheduler.invalidate('immediate')
      return
    }
    const epoch = binding.epoch
    const snapshot = this.attachmentSnapshot(binding)
    const abort = new AbortController()
    binding.attachmentAbort = abort
    binding.commandNotice = 'Reading clipboard…'
    this.scheduler.invalidate('immediate')
    let task!: Promise<void>
    task = Promise.resolve().then(async () => {
      const content = await (this.options.clipboard ?? createSystemClipboardPort()).read({
        signal: abort.signal,
        ...(snapshot.maxImageBytes === undefined ? {} : { maxImageBytes: snapshot.maxImageBytes }),
      })
      if (!this.isCurrentBinding(binding, epoch) || abort.signal.aborted) return
      if (content.kind === 'empty') throw new Error('Clipboard is empty')
      if (content.kind === 'text') {
        binding.prompt = reducePromptEditor(binding.prompt, { type: 'insert', text: content.text })
        binding.commandNotice = undefined
        return
      }
      const prepare = binding.port.prepareImageBytes
      if (!snapshot.available || prepare === undefined) throw new Error('Clipboard image preparation is unavailable')
      const image = await prepare.call(binding.port, content.image, abort.signal)
      if (!this.isCurrentBinding(binding, epoch) || abort.signal.aborted) return
      const stagingError = imageStagingError(binding.promptImages, image, snapshot)
      if (stagingError !== undefined) throw new Error(stagingError)
      binding.promptImages = [...binding.promptImages, image]
      binding.commandMenu = createCommandMenuState()
      binding.commandNotice = `Attached ${image.name}`
    }).catch((error: unknown) => {
      if (!this.isCurrentBinding(binding, epoch) || abort.signal.aborted) return
      binding.commandNotice = `Clipboard not pasted: ${commandMessageOf(error)}`
    }).finally(() => {
      if (binding.attachmentTask === task) binding.attachmentTask = undefined
      if (binding.attachmentAbort === abort) binding.attachmentAbort = undefined
      if (this.phase === 'running' && this.isCurrentBinding(binding)) this.scheduler.invalidate('immediate')
    })
    binding.attachmentTask = task
  }

  private submitRuntimePrompt(text: string, status: AgentStatus): void {
    const binding = this.currentBinding
    const delivery = status === 'running' || isAgentRequestActive(binding.agentRequest)
      ? 'steer'
      : 'followup'
    const images = binding.promptImages
    const ticket = ++this.nextSubmissionTicket
    const abort = new AbortController()
    binding.agentRequest = beginAgentRequest(binding.agentRequest, ticket)
    binding.requestCancelDispatched = false
    binding.submitAbort = abort
    binding.followRequest = ++this.nextFollowRequest
    this.prompt = createPromptEditorState()
    binding.promptImages = []
    const clearedPrompt = binding.prompt
    const clearedImages = binding.promptImages
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    this.scheduler.invalidate('immediate')

    let task!: Promise<void>
    task = Promise.resolve()
      .then(() => binding.port.submit(
        { text, ...(images.length === 0 ? {} : { images }) },
        delivery,
        { signal: abort.signal },
      ))
      .then(
        result => {
          if (abort.signal.aborted) {
            const request = binding.agentRequest
            if (
              binding.port.ownsAgentLifecycle
              && !binding.requestCancelDispatched
            ) {
              try {
                binding.port.cancel(this.hasFatalError
                  ? { kind: 'hook', reason: 'DSH-TUI controller failure' }
                  : { kind: 'user' })
                binding.requestCancelDispatched = true
              } catch (error: unknown) {
                this.failBinding(binding, error)
                return
              }
            }
            /* v8 ignore next -- beginAgentRequest installs this state before submit can settle. */
            if (request !== undefined) {
              binding.agentRequest = request.cancelRequested
                ? requestAgentCancellation({ ...request, accepted: true }, true)
                : settleAgentRequestCancellation(request, 'Prompt cancelled')
            }
            if (binding.requestCancelDispatched) {
              this.reconcileAgentRequestCancellation(binding)
            }
            if (this.phase === 'running' && this.isCurrentBinding(binding)) {
              this.scheduler.invalidate('immediate')
            }
            return
          }
          const active = this.activeSession(binding)
          const observed = active?.rows.find(row => (
            row.kind === 'user' && row.message.id === result.inputId
          ))
          let request = acceptAgentRequest(
            binding.agentRequest,
            ticket,
            result.inputId,
            observed !== undefined,
          )
          if (
            request !== undefined
            && observed?.kind === 'user'
            && active?.lastTurnEnd !== undefined
            && active.openTurn === undefined
            && active.lastTurnEnd.seq > observed.seq
          ) {
            request = settleAgentRequestFromTurnEnd(request, active.lastTurnEnd.reason)
          }
          binding.agentRequest = request
          if (this.phase === 'running' && this.isCurrentBinding(binding)) {
            this.scheduler.invalidate('immediate')
          }
        },
        (error: unknown) => {
          if (binding.prompt === clearedPrompt && binding.promptImages === clearedImages && binding.attachmentTask === undefined) {
            binding.prompt = createPromptEditorState(text)
            binding.promptImages = images
          }
          if (abort.signal.aborted) {
            const rejected = rejectAgentRequest(
              binding.agentRequest,
              ticket,
              this.agentStatus(binding) === 'running',
            )
            binding.agentRequest = {
              ...rejected,
              phase: 'cancelled',
              description: 'Prompt cancelled',
              cancelRequested: false,
            }
            binding.commandNotice = 'Prompt cancelled before it was sent'
            if (this.phase === 'running' && this.isCurrentBinding(binding)) {
              this.scheduler.invalidate('immediate')
            }
            return
          }
          binding.agentRequest = rejectAgentRequest(
            binding.agentRequest,
            ticket,
            this.agentStatus(binding) === 'running',
          )
          if (error instanceof DshSubmitRejectedError) {
            binding.commandNotice = `Prompt not sent: ${error.message}`
            this.scheduler.invalidate('immediate')
            return
          }
          this.fail(error)
        },
      )
      .finally(() => {
        binding.submitTask = undefined
        if (binding.submitAbort === abort) binding.submitAbort = undefined
      })
    binding.submitTask = task
  }

  /**
   * Official maintenance work can accept and cancel a prompt without emitting
   * turn or running/idle events. Reconcile against the port's authoritative
   * idle barrier so the transient activity cannot remain stuck on cancelling.
   */
  private reconcileAgentRequestCancellation(binding: SessionBinding): void {
    if (binding.requestCancelTask !== undefined) return
    const epoch = binding.epoch
    const task = Promise.resolve()
      .then(() => binding.port.whenIdle())
      .then(
        () => {
          if (!this.isBindingOpen(binding, epoch)) return
          const request = binding.agentRequest
          if (request?.cancelRequested !== true) return
          binding.agentRequest = settleAgentRequestCancellation(request)
          if (this.phase === 'running' && this.isCurrentBinding(binding, epoch)) {
            this.scheduler.invalidate('immediate')
          }
        },
        (error: unknown) => {
          if (!this.isBindingOpen(binding, epoch)) return
          this.failBinding(binding, new Error(
            `request cancellation reconciliation failed: ${messageOf(error)}`,
            { cause: error },
          ))
        },
      )
      .finally(() => {
        if (binding.requestCancelTask === task) binding.requestCancelTask = undefined
      })
    binding.requestCancelTask = task
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

  private executeCommandLine(line: string, command: DshCommandDescriptor): void {
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
    const images = binding.promptImages
    if (images.length > 0 && command.input?.images !== true) {
      binding.commandNotice = `/${command.name} does not accept image attachments`
      this.scheduler.invalidate('immediate')
      return
    }
    const abort = new AbortController()
    binding.commandAbort = abort
    this.prompt = createPromptEditorState()
    binding.promptImages = []
    this.commandMenu = createCommandMenuState()
    this.commandNotice = undefined
    this.scheduler.invalidate('immediate')

    const clearedPrompt = binding.prompt
    const clearedImages = binding.promptImages
    const task = Promise.resolve()
      .then(() => binding.port.executeCommand(line, abort.signal, images))
      .then(
        (execution) => {
          if (execution?.result.kind === 'success') return
          if (binding.prompt === clearedPrompt && binding.promptImages === clearedImages && binding.attachmentTask === undefined) {
            binding.promptImages = images
            if (images.length > 0 || execution === undefined) binding.prompt = createPromptEditorState(line)
          }
          if (execution !== undefined) {
            binding.commandNotice = `Command failed: ${execution.result.text ?? 'request rejected'}`
            return
          }
          this.refreshCommands(binding)
          binding.commandNotice = `Command was not admitted: ${line}`
        },
        (error: unknown) => {
          if (binding.prompt === clearedPrompt && binding.promptImages === clearedImages && binding.attachmentTask === undefined) {
            binding.promptImages = images
            if (images.length > 0) binding.prompt = createPromptEditorState(line)
          }
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
      this.forkAttempt?.abort.abort('DSH-TUI is shutting down')
      try {
        this.options.terminal.stopAcceptingInput()
      } catch (error: unknown) {
        errors.push(error)
      }
      this.settingsPage.quiesce()
      const stopSettings = this.settingsSubscription
      this.settingsSubscription = undefined
      try {
        stopSettings?.()
      } catch (error: unknown) {
        errors.push(error)
      }
      for (const binding of this.bindings) {
        const stopCommands = binding.commandSubscription
        const stopModels = binding.modelSubscription
        const stopModes = binding.modeSubscription
        const stopSkills = binding.skillsSubscription
        const stopTools = binding.toolsSubscription
        const stopContext = binding.contextSubscription
        const stopWorkbench = binding.workbenchSubscription
        const stopJobs = binding.jobsSubscription
        const stopDelegation = binding.delegationSubscription
        binding.commandSubscription = undefined
        binding.modelSubscription = undefined
        binding.modeSubscription = undefined
        binding.skillsSubscription = undefined
        binding.toolsSubscription = undefined
        binding.contextSubscription = undefined
        binding.workbenchSubscription = undefined
        binding.jobsSubscription = undefined
        binding.delegationSubscription = undefined
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
          stopModes?.()
        } catch (error: unknown) {
          errors.push(error)
        }
        try {
          stopSkills?.()
        } catch (error: unknown) {
          errors.push(error)
        }
        try {
          stopTools?.()
        } catch (error: unknown) {
          errors.push(error)
        }
        try {
          stopContext?.()
        } catch (error: unknown) {
          errors.push(error)
        }
        try {
          stopWorkbench?.()
        } catch (error: unknown) {
          errors.push(error)
        }
        try {
          stopJobs?.()
        } catch (error: unknown) {
          errors.push(error)
        }
        try {
          stopDelegation?.()
        } catch (error: unknown) {
          errors.push(error)
        }
        binding.commandAbort?.abort('DSH-TUI is shutting down')
        binding.submitAbort?.abort('DSH-TUI is shutting down')
        binding.attachmentAbort?.abort('DSH-TUI is shutting down')
        binding.modelRefreshAbort?.abort('DSH-TUI is shutting down')
        binding.modelSelectGeneration += 1
        binding.modelSelectAbort?.abort('DSH-TUI is shutting down')
        binding.modeRefreshAbort?.abort('DSH-TUI is shutting down')
        binding.modeSelectGeneration += 1
        binding.modeSelectAbort?.abort('DSH-TUI is shutting down')
        binding.skillsRefreshAbort?.abort('DSH-TUI is shutting down')
        binding.abort.abort('DSH-TUI is shutting down')
      }
      this.settingsPage.dismiss()
      this.featureHostSubscription?.()
      this.featureHostSubscription = undefined
      this.featureSessionSubscription?.()
      this.featureSessionSubscription = undefined
      this.sessionNavigationSubscription?.()
      this.sessionNavigationSubscription = undefined
      this.preferenceSubscription?.()
      this.preferenceSubscription = undefined
      this.currentBinding.statusPanelOpen = false
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
    await this.forkAttempt?.task
    await this.featureRouteTask
    const pending = [...this.bindings].flatMap(binding => [
      binding.submitTask,
      binding.attachmentTask,
      binding.commandTask,
      binding.modelRefreshTask,
      binding.modelSelectTask,
      binding.modeRefreshTask,
      binding.modeSelectTask,
      binding.skillsRefreshTask,
    ]).filter((task): task is Promise<void> => task !== undefined)
    await Promise.all(pending)
    await this.settingsPage.waitForIdle()
    const switchCleanupError = this.switchCleanupError
    this.switchCleanupError = undefined
    const forkCleanupError = this.forkCleanupError
    this.forkCleanupError = undefined
    const errors: unknown[] = []
    if (switchCleanupError !== undefined) {
      errors.push(new Error(
          `session switch cleanup failed: ${cleanupMessageOf(switchCleanupError)}`,
          { cause: switchCleanupError },
      ))
    }
    if (forkCleanupError !== undefined) {
      errors.push(new Error(
        `session fork cleanup failed: ${cleanupMessageOf(forkCleanupError)}`,
        { cause: forkCleanupError },
      ))
    }
    const binding = this.currentBinding
    const request = binding.agentRequest
    const requestCancellationAlreadyDispatched = isAgentRequestActive(request)
      && request.cancelRequested
      && binding.requestCancelDispatched
    if (
      binding.port.ownsAgentLifecycle
      && this.agentStatus(binding) !== 'disposed'
      && !requestCancellationAlreadyDispatched
    ) {
      try {
        binding.port.cancel(this.hasFatalError
          ? { kind: 'hook', reason: 'DSH-TUI controller failure' }
          : { kind: 'user' })
        if (isAgentRequestActive(request)) binding.requestCancelDispatched = true
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
    const featureResult = await Promise.allSettled([
      this.options.featureSession?.deactivate() ?? Promise.resolve(),
    ])
    const bindingResults = await Promise.allSettled(
      [...this.bindings].map(binding => this.closeBinding(binding)),
    )
    const errors = [...featureResult, ...bindingResults]
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
            ...(this.requestedReason === 'web-handoff'
              ? { webHostSummary: this.pendingWebHostSummary! }
              : {}),
            shutdown,
          }
    this.completedResult = result
    this.resolveCompletion(result)
  }
}
