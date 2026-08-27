import type { Context } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import type { DshTuiModelSelection, SessionModelPort } from '../model/port.ts'
import type { ProviderConnectionPort } from '../provider/port.ts'
import type { SessionContextPort } from '../context/port.ts'
import type { SessionWorkbenchPort } from '../workbench/port.ts'
import type { SessionJobsPort } from '../activity/port.ts'
import type { SessionDelegationPort } from '../activity/delegation-port.ts'
import type { SessionModePort } from '../mode/port.ts'
import { DshTuiSessionPort } from '../runtime/tui-session-port.ts'
import type { AgentPresetCatalogPort } from '../preset/catalog-port.ts'
import type { SessionActivationPort } from '../session/activation-port.ts'
import type { SessionCatalogPort } from '../session/catalog-port.ts'
import type { SessionInspectionPort } from '../session/inspection-port.ts'
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
import { DshProviderConnection } from './provider-connection.ts'
import { DshSessionContextMeter } from './context-meter.ts'
import { DshSessionWorkbench } from './workbench.ts'
import { DshSessionJobs } from './jobs.ts'
import { DshSessionDelegation } from './delegation-activity.ts'
import { DshSessionMode } from './agent-mode.ts'
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

export interface DshTuiRuntimeService {
  readonly catalog: SessionCatalogPort
  readonly activation: SessionActivationPort
  readonly inspection: SessionInspectionPort
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
  const presets = new DshAgentPresetCatalog(ctx)
  const providers = new DshProviderConnection(ctx)
  const service: DshTuiRuntimeService = {
    catalog,
    activation,
    inspection,
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
  options: OpenDshTuiSessionOptions,
): Promise<DshTuiSessionPort> {
  let prepared: {
    readonly commands: DshCommandSession
    readonly interaction: DshInteractionSession
    readonly models: SessionModelPort
    readonly context: SessionContextPort
    readonly workbench: SessionWorkbenchPort
    readonly jobs: SessionJobsPort
    readonly modes: SessionModePort
    readonly delegation: SessionDelegationPort
  } | undefined
  let runtime: DshAgentRuntimePort | undefined
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
    let delegation: SessionDelegationPort | undefined
    try {
      workbench = new DshSessionWorkbench(ctx, agent.session, agent)
      jobs = new DshSessionJobs(agent)
      modes = new DshSessionMode(ctx, agent)
      delegation = new DshSessionDelegation(ctx, agent)
      session = interactionHub.attach({
        sessionId: agent.session.id,
        agent,
        session: agent.session,
      })
      models = modelHub.attach(agent)
      context = new DshSessionContextMeter(ctx, agent.session)
      prepared = {
        commands,
        interaction: session,
        models,
        context,
        workbench,
        jobs,
        modes,
        delegation,
      }
    } catch (error: unknown) {
      delegation?.disposeDelegation()
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
    throw error
  }
}
