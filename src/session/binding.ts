import type { DshCommandDescriptor, DshCommandPort } from '../command/port.ts'
import {
  createCommandMenuState,
  type CommandMenuState,
} from '../command/menu.ts'
import {
  createInteractionEditorState,
  type InteractionEditorState,
} from '../interaction/editor.ts'
import type {
  DshInteractionPort,
  InteractionSnapshot,
} from '../interaction/port.ts'
import type { DshRuntimePort } from '../runtime/port.ts'
import type { AgentRequestLifecycleState } from '../presentation/agent-request.ts'
import type { TranscriptViewMode } from '../presentation/transcript-view.ts'
import type { LegacyDirectoryNavigation } from '../navigation/legacy-directory.ts'
import type {
  PromptImageInput,
  SessionAttachmentPort,
} from '../attachment/port.ts'
import type { SessionModelPort, SessionModelSnapshot } from '../model/port.ts'
import type {
  SessionContextPort,
  SessionContextSnapshot,
} from '../context/port.ts'
import type {
  SessionWorkbenchPort,
  SessionWorkbenchSnapshot,
} from '../workbench/port.ts'
import {
  createGoalActionSurfaceState,
  type GoalActionSurfaceState,
} from '../workbench/goal-actions.ts'
import type {
  SessionJobsPort,
  SessionJobsSnapshot,
} from '../activity/port.ts'
import {
  createJobsActivityState,
  type JobsActivityState,
} from '../activity/jobs-activity.ts'
import type {
  SessionDelegationPort,
  SessionDelegationSnapshot,
} from '../activity/delegation-port.ts'
import {
  createActivityCenterState,
  type ActivityCenterState,
} from '../activity/center.ts'
import {
  createModelPickerState,
  type ModelPickerState,
} from '../model/picker.ts'
import type { SessionModePort, SessionModeSnapshot } from '../mode/port.ts'
import {
  createModePickerState,
  type ModePickerState,
} from '../mode/picker.ts'
import type { SessionSkillsPort, SessionSkillsSnapshot } from '../skill/port.ts'
import {
  createSkillPickerState,
  type SkillPickerState,
} from '../skill/picker.ts'
import type { SessionToolsPort, SessionToolsSnapshot } from '../tool/port.ts'
import {
  createToolBrowserState,
  type ToolBrowserState,
} from '../tool/browser.ts'
import {
  createMcpCapabilityBrowserState,
  type McpCapabilityBrowserState,
} from '../mcp/capabilities.ts'
import {
  createAttemptPanelState,
  type AttemptPanelState,
} from '../llm/attempts.ts'
import {
  createRoutePanelState,
  type RoutePanelState,
} from '../llm/routes.ts'
import type {
  SessionPermissionPort,
  SessionPermissionSnapshot,
} from '../permission/port.ts'
import {
  createPermissionPickerState,
  type PermissionPickerState,
} from '../permission/picker.ts'
import { selectSession } from '../transcript/reducer.ts'
import { createUiState, type UiState } from '../transcript/state.ts'
import {
  createPromptEditorState,
  type PromptEditorState,
} from '../ui/prompt-editor.ts'

/** One exact live-session capability set bound to one controller epoch. */
export type DshTuiSessionLease = DshRuntimePort
  & DshInteractionPort
  & DshCommandPort
  & SessionModelPort
  & Partial<SessionModePort>
  & Partial<SessionSkillsPort>
  & Partial<SessionContextPort>
  & Partial<SessionWorkbenchPort>
  & Partial<SessionJobsPort>
  & Partial<SessionDelegationPort>
  & Partial<SessionToolsPort>
  & Partial<SessionPermissionPort>
  & Partial<SessionAttachmentPort>

export type SessionBindingRole = 'candidate' | 'current' | 'background' | 'closed'

/**
 * Session-local controller state. The epoch distinguishes two lifecycles that
 * reuse the same durable session id; async continuations must retain this exact
 * object instead of resolving through the controller's current pointer.
 */
export interface SessionBinding {
  readonly epoch: number
  readonly port: DshTuiSessionLease
  readonly abort: AbortController
  /** Exact capability release; borrowed implementations must be non-destructive. */
  readonly release: () => Promise<void>
  role: SessionBindingRole
  ui: UiState
  prompt: PromptEditorState
  interaction: InteractionSnapshot | undefined
  interactionEditor: InteractionEditorState
  commands: readonly DshCommandDescriptor[]
  commandCatalogReady: boolean
  commandMenu: CommandMenuState
  commandNotice: string | undefined
  commandSubscription: (() => void) | undefined
  commandTask: Promise<void> | undefined
  commandAbort: AbortController | undefined
  model: SessionModelSnapshot
  modelPicker: ModelPickerState
  modelNavigation: LegacyDirectoryNavigation
  modelSubscription: (() => void) | undefined
  modelRefreshTask: Promise<void> | undefined
  modelRefreshAbort: AbortController | undefined
  modelRefreshGeneration: number
  modelSelectTask: Promise<void> | undefined
  modelSelectAbort: AbortController | undefined
  modelSelectGeneration: number
  mode: SessionModeSnapshot
  modePicker: ModePickerState
  modeNavigation: LegacyDirectoryNavigation
  modeSubscription: (() => void) | undefined
  modeRefreshTask: Promise<void> | undefined
  modeRefreshAbort: AbortController | undefined
  modeRefreshGeneration: number
  modeSelectTask: Promise<void> | undefined
  modeSelectAbort: AbortController | undefined
  modeSelectGeneration: number
  skills: SessionSkillsSnapshot
  skillPicker: SkillPickerState
  skillsSubscription: (() => void) | undefined
  skillsRefreshTask: Promise<void> | undefined
  skillsRefreshAbort: AbortController | undefined
  skillsRefreshGeneration: number
  tools: SessionToolsSnapshot
  toolBrowser: ToolBrowserState
  mcpBrowser: McpCapabilityBrowserState
  attemptPanel: AttemptPanelState
  routePanel: RoutePanelState
  attemptNavigation: LegacyDirectoryNavigation
  routeNavigation: LegacyDirectoryNavigation
  toolsSubscription: (() => void) | undefined
  permissions: SessionPermissionSnapshot
  permissionPicker: PermissionPickerState
  permissionsSubscription: (() => void) | undefined
  permissionSelectTask: Promise<void> | undefined
  permissionSelectAbort: AbortController | undefined
  permissionSelectGeneration: number
  context: SessionContextSnapshot
  contextPanelOpen: boolean
  contextPanelOffset: number
  contextSubscription: (() => void) | undefined
  workbench: SessionWorkbenchSnapshot
  workbenchSubscription: (() => void) | undefined
  goalActions: GoalActionSurfaceState
  jobs: SessionJobsSnapshot
  jobsSubscription: (() => void) | undefined
  jobsActivity: JobsActivityState
  delegation: SessionDelegationSnapshot
  delegationSubscription: (() => void) | undefined
  delegationRefreshTask: Promise<void> | undefined
  delegationRefreshAbort: AbortController | undefined
  activityCenter: ActivityCenterState
  activityNavigation: LegacyDirectoryNavigation
  followRequest: number
  agentRequest: AgentRequestLifecycleState | undefined
  transcriptViewMode: TranscriptViewMode
  runtimePump: Promise<void> | undefined
  interactionPump: Promise<void> | undefined
  submitTask: Promise<void> | undefined
  submitAbort: AbortController | undefined
  requestCancelTask: Promise<void> | undefined
  requestCancelDispatched: boolean
  promptImages: readonly PromptImageInput[]
  attachmentTask: Promise<void> | undefined
  attachmentAbort: AbortController | undefined
  runtimeStatusObserved: boolean
  failure: unknown | undefined
  releaseTask: Promise<void> | undefined
  closeTask: Promise<void> | undefined
}

export function createSessionBinding(
  epoch: number,
  port: DshTuiSessionLease,
  role: SessionBindingRole,
  release: () => Promise<void>,
): SessionBinding {
  return {
    epoch,
    port,
    abort: new AbortController(),
    release,
    role,
    ui: selectSession(createUiState(), port.sessionId),
    prompt: createPromptEditorState(),
    interaction: undefined,
    interactionEditor: createInteractionEditorState(),
    commands: [],
    commandCatalogReady: false,
    commandMenu: createCommandMenuState(),
    commandNotice: undefined,
    commandSubscription: undefined,
    commandTask: undefined,
    commandAbort: undefined,
    model: {
      routable: false,
      writable: false,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
    },
    modelPicker: createModelPickerState(),
    modelNavigation: { focus: 'list', detailOffset: 0 },
    modelSubscription: undefined,
    modelRefreshTask: undefined,
    modelRefreshAbort: undefined,
    modelRefreshGeneration: 0,
    modelSelectTask: undefined,
    modelSelectAbort: undefined,
    modelSelectGeneration: 0,
    mode: {
      available: false,
      loading: false,
      selecting: false,
      locked: false,
      presets: [],
    },
    modePicker: createModePickerState(),
    modeNavigation: { focus: 'list', detailOffset: 0 },
    modeSubscription: undefined,
    modeRefreshTask: undefined,
    modeRefreshAbort: undefined,
    modeRefreshGeneration: 0,
    modeSelectTask: undefined,
    modeSelectAbort: undefined,
    modeSelectGeneration: 0,
    skills: {
      available: false,
      loading: false,
      complete: true,
      stale: false,
      generation: 0,
      skills: [],
    },
    skillPicker: createSkillPickerState(),
    skillsSubscription: undefined,
    skillsRefreshTask: undefined,
    skillsRefreshAbort: undefined,
    skillsRefreshGeneration: 0,
    tools: {
      available: false,
      stale: false,
      generation: 0,
      tools: [],
    },
    toolBrowser: createToolBrowserState(),
    mcpBrowser: createMcpCapabilityBrowserState(),
    attemptPanel: createAttemptPanelState(),
    routePanel: createRoutePanelState(),
    attemptNavigation: { focus: 'list', detailOffset: 0 },
    routeNavigation: { focus: 'list', detailOffset: 0 },
    toolsSubscription: undefined,
    permissions: {
      available: false,
      writable: false,
      stale: false,
      generation: 0,
      selecting: false,
      options: [],
    },
    permissionPicker: createPermissionPickerState(),
    permissionsSubscription: undefined,
    permissionSelectTask: undefined,
    permissionSelectAbort: undefined,
    permissionSelectGeneration: 0,
    context: { available: false },
    contextPanelOpen: false,
    contextPanelOffset: 0,
    contextSubscription: undefined,
    workbench: { available: false },
    workbenchSubscription: undefined,
    goalActions: createGoalActionSurfaceState(),
    jobs: { available: false, generation: 0, jobs: [] },
    jobsSubscription: undefined,
    jobsActivity: createJobsActivityState(),
    delegation: {
      available: false,
      generation: 0,
      loading: false,
      subagentsAvailable: false,
      subagents: [],
      workflows: [],
    },
    delegationSubscription: undefined,
    delegationRefreshTask: undefined,
    delegationRefreshAbort: undefined,
    activityCenter: createActivityCenterState(),
    activityNavigation: { focus: 'list', detailOffset: 0 },
    followRequest: 0,
    agentRequest: undefined,
    transcriptViewMode: 'compact',
    runtimePump: undefined,
    interactionPump: undefined,
    submitTask: undefined,
    submitAbort: undefined,
    requestCancelTask: undefined,
    requestCancelDispatched: false,
    promptImages: [],
    attachmentTask: undefined,
    attachmentAbort: undefined,
    runtimeStatusObserved: false,
    failure: undefined,
    releaseTask: undefined,
    closeTask: undefined,
  }
}
