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
import { selectSession } from '../transcript/reducer.ts'
import { createUiState, type UiState } from '../transcript/state.ts'
import {
  createPromptEditorState,
  type PromptEditorState,
} from '../ui/prompt-editor.ts'

/** One exact live-session capability set bound to one controller epoch. */
export type DshTuiSessionLease = DshRuntimePort & DshInteractionPort & DshCommandPort

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
    runtimePump: undefined,
    interactionPump: undefined,
    submitTask: undefined,
    runtimeStatusObserved: false,
    failure: undefined,
    releaseTask: undefined,
    closeTask: undefined,
  }
}
