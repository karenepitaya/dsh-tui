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
import type { SessionModelPort } from '../model/port.ts'
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
import {
  createModelPickerState,
  type ModelPickerState,
} from '../model/picker.ts'
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
  & Partial<SessionContextPort>
  & Partial<SessionWorkbenchPort>
  & Partial<SessionJobsPort>

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
  modelPicker: ModelPickerState
  modelSubscription: (() => void) | undefined
  modelRefreshTask: Promise<void> | undefined
  modelRefreshAbort: AbortController | undefined
  modelRefreshGeneration: number
  modelSelectTask: Promise<void> | undefined
  modelSelectAbort: AbortController | undefined
  modelSelectGeneration: number
  context: SessionContextSnapshot
  contextPanelOpen: boolean
  contextSubscription: (() => void) | undefined
  workbench: SessionWorkbenchSnapshot
  workbenchSubscription: (() => void) | undefined
  goalActions: GoalActionSurfaceState
  jobs: SessionJobsSnapshot
  jobsSubscription: (() => void) | undefined
  jobsActivity: JobsActivityState
  followRequest: number
  toolDetailsExpanded: boolean
  runtimePump: Promise<void> | undefined
  interactionPump: Promise<void> | undefined
  submitTask: Promise<void> | undefined
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
    modelPicker: createModelPickerState(),
    modelSubscription: undefined,
    modelRefreshTask: undefined,
    modelRefreshAbort: undefined,
    modelRefreshGeneration: 0,
    modelSelectTask: undefined,
    modelSelectAbort: undefined,
    modelSelectGeneration: 0,
    context: { available: false },
    contextPanelOpen: false,
    contextSubscription: undefined,
    workbench: { available: false },
    workbenchSubscription: undefined,
    goalActions: createGoalActionSurfaceState(),
    jobs: { available: false, generation: 0, jobs: [] },
    jobsSubscription: undefined,
    jobsActivity: createJobsActivityState(),
    followRequest: 0,
    toolDetailsExpanded: false,
    runtimePump: undefined,
    interactionPump: undefined,
    submitTask: undefined,
    runtimeStatusObserved: false,
    failure: undefined,
    releaseTask: undefined,
    closeTask: undefined,
  }
}
