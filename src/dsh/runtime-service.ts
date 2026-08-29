import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { DshTuiModelSelection, SessionModelPort } from '../model/port.ts'
import type { ProviderConnectionPort } from '../provider/port.ts'
import type { SessionContextPort } from '../context/port.ts'
import type { SessionWorkbenchPort } from '../workbench/port.ts'
import type { SessionJobsPort } from '../activity/port.ts'
import type { SessionDelegationPort } from '../activity/delegation-port.ts'
import type { SessionModePort } from '../mode/port.ts'
import type { SessionSkillsPort } from '../skill/port.ts'
import type { SessionToolsPort } from '../tool/port.ts'
import type { SessionPermissionPort } from '../permission/port.ts'
import { DshTuiSessionPort } from '../runtime/tui-session-port.ts'
import type { AgentPresetCatalogPort } from '../preset/catalog-port.ts'
import type { SessionActivationPort } from '../session/activation-port.ts'
import type { SessionCatalogPort } from '../session/catalog-port.ts'
import type { SessionInspectionPort } from '../session/inspection-port.ts'
import type { SessionForkPort } from '../session/fork-port.ts'
import { DshAgentPresetCatalog } from './agent-preset-catalog.ts'
import { DshColdResumeCoordinator } from './cold-resume-coordinator.ts'
import { DshSessionActivation } from './cold-session-activation.ts'
import { DshCommandSession } from './command-session.ts'
import {
  DshInteractionHub,
  type DshInteractionSession,
} from './interaction-hub.ts'
import {
  openDshRuntimePort,
  type DshAgentRuntimePort,
  type OpenDshRuntimeOptions,
} from './runtime-port.ts'
import { DshSessionCatalog } from './session-catalog.ts'
import { DshSessionInspection } from './session-inspection.ts'
import { DshSessionFork } from './session-fork.ts'
import { DshProviderConnection } from './provider-connection.ts'
import { DshSessionContextMeter } from './context-meter.ts'
import { DshSessionWorkbench } from './workbench.ts'
import { DshSessionJobs } from './jobs.ts'
import { DshSessionDelegation } from './delegation-activity.ts'
import { DshSessionMode } from './agent-mode.ts'
import { DshSessionSkills } from './session-skills.ts'
import { DshSessionTools } from './session-tools.ts'
import { DshSessionPermissions } from './session-permissions.ts'
import {
  DshModelSelectionHub,
  officialModelSelection,
} from './model-selection.ts'

type OpenDshTuiRuntimeOptions = Extract<
  OpenDshRuntimeOptions,
  { readonly mode?: 'create' }
>

export type OpenDshTuiSessionOptions = Omit<
  OpenDshTuiRuntimeOptions,
  'selection'
> & {
  readonly selection?: DshTuiModelSelection
}

type OpenDshTuiForkSessionOptions = Extract<
  OpenDshRuntimeOptions,
  { readonly mode: 'fork' }
>

type OpenDshTuiInternalSessionOptions =
  | OpenDshTuiSessionOptions
  | OpenDshTuiForkSessionOptions

export interface DshTuiRuntimeService {
  readonly catalog: SessionCatalogPort
  readonly activation: SessionActivationPort
  readonly inspection: SessionInspectionPort
  readonly fork: SessionForkPort
  readonly presets: AgentPresetCatalogPort
  readonly providers: ProviderConnectionPort
  open(options: OpenDshTuiSessionOptions): Promise<DshTuiSessionPort>
}

export interface DshTuiRuntimeOwner {
  readonly service: DshTuiRuntimeService
  dispose(): Promise<void>
}

/** Provide the Host-facing TUI service and retain its non-Cordis runtime owners. */
export function provideDshTuiRuntime(ctx: Context): DshTuiRuntimeOwner {
  const catalog = new DshSessionCatalog(ctx)
  const interactionHub = new DshInteractionHub(ctx)
  const modelHub = new DshModelSelectionHub(ctx)
  const coordinator = new DshColdResumeCoordinator(ctx, modelHub)
  const activation = new DshSessionActivation(
    ctx,
    interactionHub,
    coordinator,
    modelHub,
  )
  const inspection = new DshSessionInspection(ctx)
  const fork = new DshSessionFork(
    ctx,
    options => openDshTuiSession(ctx, interactionHub, modelHub, options),
  )
  const presets = new DshAgentPresetCatalog(ctx)
  const providers = new DshProviderConnection(ctx)
  const service: DshTuiRuntimeService = {
    catalog,
    activation,
    inspection,
    fork,
    presets,
    providers,
    open: options => openDshTuiSession(ctx, interactionHub, modelHub, options),
  }
  ctx.provide('dshTui', service)
  return {
    service,
    async dispose() {
      try {
        await coordinator.dispose()
      } finally {
        try {
          interactionHub.dispose()
        } finally {
          await modelHub.dispose()
        }
      }
    },
  }
}

/** Compose DSH's unpublished Agent setup with the TUI interaction adapters. */
async function openDshTuiSession(
  ctx: Context,
  interactionHub: DshInteractionHub,
  modelHub: DshModelSelectionHub,
  options: OpenDshTuiInternalSessionOptions,
): Promise<DshTuiSessionPort> {
  let prepared: {
    readonly agent: Agent
    readonly commands: DshCommandSession
    readonly interaction: DshInteractionSession
    readonly models: SessionModelPort
    readonly context: SessionContextPort
    readonly workbench: SessionWorkbenchPort
    readonly jobs: SessionJobsPort
    readonly modes: SessionModePort
    readonly skills: SessionSkillsPort
    readonly delegation: SessionDelegationPort
  } | undefined
  let runtime: DshAgentRuntimePort | undefined
  let tools: SessionToolsPort | undefined
  let permissions: SessionPermissionPort | undefined
  const upstreamSetup = options.setup
  const { selection, ...runtimeOptions } = options
  const setup: AgentSetup = async (agentCtx) => {
    // openDshRuntimePort installs through modelHub before invoking this setup;
    // that exact-Agent boundary already rejects a missing unpublished Agent.
    const agent = agentCtx.agent!
    const commands = new DshCommandSession(ctx, agent)
    let session: DshInteractionSession | undefined
    let models: SessionModelPort | undefined
    let context: SessionContextPort | undefined
    let workbench: SessionWorkbenchPort | undefined
    let jobs: SessionJobsPort | undefined
    let modes: SessionModePort | undefined
    let skills: SessionSkillsPort | undefined
    let delegation: SessionDelegationPort | undefined
    try {
      workbench = new DshSessionWorkbench(ctx, agent.session, agent)
      jobs = new DshSessionJobs(agent)
      modes = new DshSessionMode(ctx, agent)
      skills = new DshSessionSkills(ctx, agent)
      delegation = new DshSessionDelegation(ctx, agent)
      session = interactionHub.attach({
        sessionId: agent.session.id,
        agent,
        session: agent.session,
      })
      models = modelHub.attach(agent)
      context = new DshSessionContextMeter(ctx, agent.session)
      prepared = {
        agent,
        commands,
        interaction: session,
        models,
        context,
        workbench,
        jobs,
        modes,
        skills,
        delegation,
      }
    } catch (error: unknown) {
      delegation?.disposeDelegation()
      skills?.disposeSkills()
      modes?.disposeModes()
      jobs?.disposeJobs()
      workbench?.disposeWorkbench()
      context?.disposeContext()
      models?.disposeModels()
      session?.disposeInteractions()
      commands.disposeCommands()
      throw error
    }
    return await upstreamSetup?.(agentCtx)
  }

  try {
    runtime = await openDshRuntimePort(ctx, {
      ...runtimeOptions,
      ...(selection === undefined
        ? {}
        : { selection: officialModelSelection(selection) }),
      setup,
    }, modelHub)
    if (prepared === undefined) {
      throw new Error('DSH interaction setup did not run')
    }
    // AgentLoop publishes the prepared Agent only after setup completes. Build
    // the exact-Agent catalog here so its first snapshot cannot depend on a
    // later tools/change event to discover the live registry identity.
    tools = new DshSessionTools(ctx, prepared.agent)
    permissions = new DshSessionPermissions(ctx, prepared.agent)
    return new DshTuiSessionPort(
      runtime,
      prepared.interaction,
      prepared.commands,
      prepared.models,
      prepared.context,
      prepared.workbench,
      prepared.jobs,
      prepared.modes,
      prepared.delegation,
      prepared.skills,
      tools,
      permissions,
    )
  } catch (error: unknown) {
    try {
      prepared?.commands.disposeCommands()
    } finally {
      try {
        prepared?.interaction.disposeInteractions()
      } finally {
        try {
          prepared?.models.disposeModels()
        } finally {
          try {
            prepared?.context.disposeContext()
          } finally {
            try {
              prepared?.modes.disposeModes()
            } finally {
              try {
                prepared?.skills.disposeSkills()
              } finally {
                try {
                  tools?.disposeTools()
                } finally {
                  try {
                    permissions?.disposePermissions()
                  } finally {
                    try {
                      prepared?.delegation.disposeDelegation()
                    } finally {
                      try {
                        prepared?.workbench.disposeWorkbench()
                      } finally {
                        try {
                          prepared?.jobs.disposeJobs()
                        } finally {
                          await runtime?.dispose()
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    throw error
  }
}
