import type {
  DshCommandDescriptor,
  DshCommandExecution,
  DshCommandPort,
  DshParsedCommand,
} from '../command/port.ts'
import type {
  DshInteractionPort,
  InteractionEventOptions,
  InteractionReceipt,
  InteractionResponse,
  InteractionSnapshot,
} from '../interaction/port.ts'
import type {
  CancelCause,
  Delivery,
  DshRuntimePort,
  RuntimeEventOptions,
  SubmitInput,
  SubmitResult,
} from './port.ts'
import type { SessionId } from './events.ts'
import type { DshRuntimeEventItem } from './delivery.ts'
import {
  createUnavailableSessionModelPort,
  type DshTuiModelSelection,
  type SessionModelPort,
  type SessionModelSelectOptions,
  type SessionModelSnapshot,
} from '../model/port.ts'
import {
  createUnavailableSessionContextPort,
  type SessionContextPort,
  type SessionContextSnapshot,
} from '../context/port.ts'
import {
  createUnavailableSessionWorkbenchPort,
  type SessionWorkbenchGoalAction,
  type SessionWorkbenchGoalActionReceipt,
  type SessionWorkbenchPort,
  type SessionWorkbenchSnapshot,
} from '../workbench/port.ts'
import {
  createUnavailableSessionJobsPort,
  type SessionJobAction,
  type SessionJobActionReceipt,
  type SessionJobsPort,
  type SessionJobsSnapshot,
} from '../activity/port.ts'
import {
  createUnavailableSessionDelegationPort,
  type SessionDelegationAction,
  type SessionDelegationActionReceipt,
  type SessionDelegationPort,
  type SessionDelegationSnapshot,
} from '../activity/delegation-port.ts'
import {
  createUnavailableSessionModePort,
  type SessionModePort,
  type SessionModeSelectOptions,
  type SessionModeSnapshot,
} from '../mode/port.ts'
import {
  createUnavailableSessionSkillsPort,
  type SessionSkillsPort,
  type SessionSkillsSnapshot,
} from '../skill/port.ts'
import {
  createUnavailableSessionToolsPort,
  type SessionToolsPort,
  type SessionToolsSnapshot,
} from '../tool/port.ts'
import {
  createUnavailableSessionPermissionPort,
  type SessionPermissionPort,
  type SessionPermissionSelectOptions,
  type SessionPermissionSnapshot,
} from '../permission/port.ts'

/** One live DSH session composed from the product-owned Harness capability seams. */
export class DshTuiSessionPort implements DshRuntimePort, DshInteractionPort, DshCommandPort, SessionModelPort, SessionContextPort, SessionWorkbenchPort, SessionJobsPort, SessionModePort, SessionSkillsPort, SessionDelegationPort, SessionToolsPort, SessionPermissionPort {
  readonly sessionId: SessionId
  readonly ownsAgentLifecycle: boolean
  private disposePromise: Promise<void> | undefined

  constructor(
    private readonly runtime: DshRuntimePort,
    private readonly interaction: DshInteractionPort,
    private readonly commands: DshCommandPort,
    private readonly models: SessionModelPort = createUnavailableSessionModelPort(),
    private readonly context: SessionContextPort = createUnavailableSessionContextPort(),
    private readonly workbench: SessionWorkbenchPort = createUnavailableSessionWorkbenchPort(),
    private readonly jobs: SessionJobsPort = createUnavailableSessionJobsPort(),
    private readonly modes: SessionModePort = createUnavailableSessionModePort(),
    private readonly delegation: SessionDelegationPort = createUnavailableSessionDelegationPort(),
    private readonly skills: SessionSkillsPort = createUnavailableSessionSkillsPort(),
    private readonly tools: SessionToolsPort = createUnavailableSessionToolsPort(),
    private readonly permissions: SessionPermissionPort = createUnavailableSessionPermissionPort(),
  ) {
    this.sessionId = runtime.sessionId
    this.ownsAgentLifecycle = runtime.ownsAgentLifecycle
  }

  events(options?: RuntimeEventOptions): AsyncIterable<DshRuntimeEventItem> {
    return this.runtime.events(options)
  }

  submit(input: SubmitInput, delivery: Delivery): Promise<SubmitResult> {
    return this.runtime.submit(input, delivery)
  }

  cancel(cause: CancelCause, options?: { readonly keepInbox?: boolean }): void {
    this.runtime.cancel(cause, options)
  }

  whenIdle(): Promise<void> {
    return this.runtime.whenIdle()
  }

  flush(): Promise<void> {
    return this.runtime.flush()
  }

  interactions(options?: InteractionEventOptions): AsyncIterable<InteractionSnapshot> {
    return this.interaction.interactions(options)
  }

  respond(response: InteractionResponse): InteractionReceipt {
    return this.interaction.respond(response)
  }

  disposeInteractions(): void {
    this.interaction.disposeInteractions()
  }

  listCommands(): readonly DshCommandDescriptor[] {
    return this.commands.listCommands()
  }

  parseCommand(line: string): DshParsedCommand | undefined {
    return this.commands.parseCommand(line)
  }

  executeCommand(
    line: string,
    signal: AbortSignal,
  ): Promise<DshCommandExecution | undefined> {
    return this.commands.executeCommand(line, signal)
  }

  onCommandsChanged(listener: () => void): () => void {
    return this.commands.onCommandsChanged(listener)
  }

  disposeCommands(): void {
    this.commands.disposeCommands()
  }

  modelSnapshot(): SessionModelSnapshot {
    return this.models.modelSnapshot()
  }

  refreshModels(signal?: AbortSignal): Promise<void> {
    return this.models.refreshModels(signal)
  }

  selectModel(
    selection: DshTuiModelSelection,
    options?: SessionModelSelectOptions,
  ): Promise<void> {
    return this.models.selectModel(selection, options)
  }

  onModelsChanged(listener: () => void): () => void {
    return this.models.onModelsChanged(listener)
  }

  disposeModels(): void {
    this.models.disposeModels()
  }

  contextSnapshot(): SessionContextSnapshot {
    return this.context.contextSnapshot()
  }

  onContextChanged(listener: () => void): () => void {
    return this.context.onContextChanged(listener)
  }

  disposeContext(): void {
    this.context.disposeContext()
  }

  workbenchSnapshot(): SessionWorkbenchSnapshot {
    return this.workbench.workbenchSnapshot()
  }

  onWorkbenchChanged(listener: () => void): () => void {
    return this.workbench.onWorkbenchChanged(listener)
  }

  runGoalAction(action: SessionWorkbenchGoalAction): SessionWorkbenchGoalActionReceipt {
    return this.workbench.runGoalAction(action)
  }

  disposeWorkbench(): void {
    this.workbench.disposeWorkbench()
  }

  jobsSnapshot(): SessionJobsSnapshot {
    return this.jobs.jobsSnapshot()
  }

  onJobsChanged(listener: () => void): () => void {
    return this.jobs.onJobsChanged(listener)
  }

  runJobAction(action: SessionJobAction): SessionJobActionReceipt {
    return this.jobs.runJobAction(action)
  }

  disposeJobs(): void {
    this.jobs.disposeJobs()
  }

  modeSnapshot(): SessionModeSnapshot {
    return this.modes.modeSnapshot()
  }

  refreshModes(signal?: AbortSignal): Promise<void> {
    return this.modes.refreshModes(signal)
  }

  selectMode(modeId: string, options?: SessionModeSelectOptions): Promise<void> {
    return this.modes.selectMode(modeId, options)
  }

  onModesChanged(listener: () => void): () => void {
    return this.modes.onModesChanged(listener)
  }

  disposeModes(): void {
    this.modes.disposeModes()
  }

  skillsSnapshot(): SessionSkillsSnapshot {
    return this.skills.skillsSnapshot()
  }

  refreshSkills(signal?: AbortSignal): Promise<void> {
    return this.skills.refreshSkills(signal)
  }

  onSkillsChanged(listener: () => void): () => void {
    return this.skills.onSkillsChanged(listener)
  }

  disposeSkills(): void {
    this.skills.disposeSkills()
  }

  toolsSnapshot(): SessionToolsSnapshot {
    return this.tools.toolsSnapshot()
  }

  onToolsChanged(listener: () => void): () => void {
    return this.tools.onToolsChanged(listener)
  }

  disposeTools(): void {
    this.tools.disposeTools()
  }

  permissionSnapshot(): SessionPermissionSnapshot {
    return this.permissions.permissionSnapshot()
  }

  selectPermission(
    value: string,
    options?: SessionPermissionSelectOptions,
  ): Promise<void> {
    return this.permissions.selectPermission(value, options)
  }

  onPermissionsChanged(listener: () => void): () => void {
    return this.permissions.onPermissionsChanged(listener)
  }

  disposePermissions(): void {
    this.permissions.disposePermissions()
  }

  delegationSnapshot(): SessionDelegationSnapshot {
    return this.delegation.delegationSnapshot()
  }

  refreshDelegation(signal?: AbortSignal): Promise<void> {
    return this.delegation.refreshDelegation(signal)
  }

  onDelegationChanged(listener: () => void): () => void {
    return this.delegation.onDelegationChanged(listener)
  }

  runDelegationAction(action: SessionDelegationAction): SessionDelegationActionReceipt {
    return this.delegation.runDelegationAction(action)
  }

  disposeDelegation(): void {
    this.delegation.disposeDelegation()
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOwned()
    return this.disposePromise
  }

  private async disposeOwned(): Promise<void> {
    const errors: unknown[] = []
    try {
      this.commands.disposeCommands()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      this.interaction.disposeInteractions()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      this.models.disposeModels()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      this.context.disposeContext()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      this.workbench.disposeWorkbench()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      this.jobs.disposeJobs()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      this.modes.disposeModes()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      this.skills.disposeSkills()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      this.tools.disposeTools()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      this.permissions.disposePermissions()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      this.delegation.disposeDelegation()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await this.runtime.dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'DSH-TUI session disposal failed')
    }
  }
}
