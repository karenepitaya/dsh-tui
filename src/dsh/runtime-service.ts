import type { Context } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
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

export type OpenDshTuiSessionOptions = Extract<
  OpenDshRuntimeOptions,
  { readonly mode?: 'create' }
>

export interface DshTuiRuntimeService {
  readonly catalog: SessionCatalogPort
  readonly activation: SessionActivationPort
  readonly inspection: SessionInspectionPort
  readonly presets: AgentPresetCatalogPort
  open(options: OpenDshTuiSessionOptions): Promise<DshTuiSessionPort>
}

export interface DshTuiRuntimeOwner {
  readonly service: DshTuiRuntimeService
  dispose(): Promise<void>
}

/** Provide the Host-facing TUI service and retain its non-Cordis runtime owners. */
export function provideDshTuiRuntime(ctx: Context): DshTuiRuntimeOwner {
  const catalog = new DshSessionCatalog(ctx)
  const hub = new DshInteractionHub(ctx)
  const coordinator = new DshColdResumeCoordinator(ctx)
  const activation = new DshSessionActivation(ctx, hub, coordinator)
  const inspection = new DshSessionInspection(ctx)
  const presets = new DshAgentPresetCatalog(ctx)
  const service: DshTuiRuntimeService = {
    catalog,
    activation,
    inspection,
    presets,
    open: options => openDshTuiSession(ctx, hub, options),
  }
  ctx.provide('dshTui', service)
  return {
    service,
    async dispose() {
      try {
        await coordinator.dispose()
      } finally {
        hub.dispose()
      }
    },
  }
}

/** Compose DSH's unpublished Agent setup with the TUI interaction adapters. */
async function openDshTuiSession(
  ctx: Context,
  hub: DshInteractionHub,
  options: OpenDshTuiSessionOptions,
): Promise<DshTuiSessionPort> {
  let prepared: {
    readonly commands: DshCommandSession
    readonly interaction: DshInteractionSession
  } | undefined
  let runtime: DshAgentRuntimePort | undefined
  const upstreamSetup = options.setup
  const setup: AgentSetup = async (agentCtx) => {
    const agent = agentCtx.agent
    if (agent === undefined) {
      throw new Error('DSH Agent setup did not expose its unpublished Agent')
    }
    const commands = new DshCommandSession(ctx, agent)
    const session = hub.attach({
      sessionId: agent.session.id,
      agent,
      session: agent.session,
    })
    prepared = { commands, interaction: session }
    return await upstreamSetup?.(agentCtx)
  }

  try {
    runtime = await openDshRuntimePort(ctx, { ...options, setup })
    if (prepared === undefined) {
      throw new Error('DSH interaction setup did not run')
    }
    return new DshTuiSessionPort(
      runtime,
      prepared.interaction,
      prepared.commands,
    )
  } catch (error: unknown) {
    try {
      prepared?.commands.disposeCommands()
    } finally {
      try {
        prepared?.interaction.disposeInteractions()
      } finally {
        await runtime?.dispose()
      }
    }
    throw error
  }
}
