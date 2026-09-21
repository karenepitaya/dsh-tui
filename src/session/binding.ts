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
import type {
  SessionDelegationPort,
  SessionDelegationSnapshot,
} from '../activity/delegation-port.ts'
import type { SessionModePort, SessionModeSnapshot } from '../mode/port.ts'
import type { SessionSkillsPort, SessionSkillsSnapshot } from '../skill/port.ts'
import type { SessionToolsPort, SessionToolsSnapshot } from '../tool/port.ts'
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
  modelSubscription: (() => void) | undefined
  modelRefreshTask: Promise<void> | undefined
  modelRefreshAbort: AbortController | undefined
  modelRefreshGeneration: number
  modelSelectTask: Promise<void> | undefined
  modelSelectAbort: AbortController | undefined
  modelSelectGeneration: number
  mode: SessionModeSnapshot
  modeSubscription: (() => void) | undefined
  modeRefreshTask: Promise<void> | undefined
  modeRefreshAbort: AbortController | undefined
  modeRefreshGeneration: number
  modeSelectTask: Promise<void> | undefined
  modeSelectAbort: AbortController | undefined
  modeSelectGeneration: number
  skills: SessionSkillsSnapshot
  skillsSubscription: (() => void) | undefined
  skillsRefreshTask: Promise<void> | undefined
  skillsRefreshAbort: AbortController | undefined
  skillsRefreshGeneration: number
  tools: SessionToolsSnapshot
  statusPanelOpen: boolean
  statusPanelOffset: number
  toolsSubscription: (() => void) | undefined
  permissions: SessionPermissionSnapshot
  permissionPicker: PermissionPickerState
  permissionsSubscription: (() => void) | undefined
  permissionSelectTask: Promise<void> | undefined
  permissionSelectAbort: AbortController | undefined
  permissionSelectGeneration: number
  context: SessionContextSnapshot
  contextSubscription: (() => void) | undefined
  workbench: SessionWorkbenchSnapshot
  workbenchSubscription: (() => void) | undefined
  goalActions: GoalActionSurfaceState
  jobs: SessionJobsSnapshot
  jobsSubscription: (() => void) | undefined
  delegation: SessionDelegationSnapshot
  delegationSubscription: (() => void) | undefined
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
    statusPanelOpen: false,
    statusPanelOffset: 0,
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
    contextSubscription: undefined,
    workbench: { available: false },
    workbenchSubscription: undefined,
    goalActions: createGoalActionSurfaceState(),
    jobs: { available: false, generation: 0, jobs: [] },
    jobsSubscription: undefined,
    delegation: {
      available: false,
      generation: 0,
      loading: false,
      subagentsAvailable: false,
      subagents: [],
      workflows: [],
    },
    delegationSubscription: undefined,
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
