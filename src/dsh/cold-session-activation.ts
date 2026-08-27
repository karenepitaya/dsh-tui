import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId as OfficialSessionId } from '@deepseek-ai/dsh-session'
import type {
  ActivatedSessionLease,
  SessionActivationPort,
  SessionActivationRequest,
} from '../session/activation-port.ts'
import { DshTuiSessionPort } from '../runtime/tui-session-port.ts'
import { DshCommandSession } from './command-session.ts'
import {
  DshColdResumeBusyError,
  DshColdResumeExternalWinnerError,
  type DshColdResumeCoordinator,
} from './cold-resume-coordinator.ts'
import {
  DshInteractionHub,
  type DshInteractionSession,
} from './interaction-hub.ts'
import { DshAgentRuntimePort } from './runtime-port.ts'
import { DshLiveSessionActivation } from './session-activation.ts'
import {
  officialModelSelection,
  type DshModelSelectionHub,
} from './model-selection.ts'
import type { SessionModelPort } from '../model/port.ts'
import type { SessionContextPort } from '../context/port.ts'
import type { SessionWorkbenchPort } from '../workbench/port.ts'
import type { SessionJobsPort } from '../activity/port.ts'
import type { SessionDelegationPort } from '../activity/delegation-port.ts'
import type { SessionModePort } from '../mode/port.ts'
import { DshSessionContextMeter } from './context-meter.ts'
import { DshSessionWorkbench } from './workbench.ts'
import { DshSessionJobs } from './jobs.ts'
import { DshSessionDelegation } from './delegation-activity.ts'
import { DshSessionMode } from './agent-mode.ts'

/** Resume one cold root under owned authority, with exact live-winner adoption. */
export class DshColdSessionActivation implements SessionActivationPort {
  private readonly live: DshLiveSessionActivation

  constructor(
    private readonly ctx: Context,
    private readonly hub: DshInteractionHub,
    private readonly coordinator: DshColdResumeCoordinator,
    private readonly modelHub?: DshModelSelectionHub,
  ) {
    this.live = new DshLiveSessionActivation(ctx, hub, modelHub)
  }

  async activateSession(
    request: SessionActivationRequest,
  ): Promise<ActivatedSessionLease> {
    if (request.intent !== 'resume-cold') {
      throw new Error(
        `DSH cold activation cannot satisfy "${request.intent}" for "${request.sessionId}"`,
      )
    }
    request.signal.throwIfAborted()
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('DSH Session service is unavailable')

    let commands: DshCommandSession | undefined
    let interaction: DshInteractionSession | undefined
    let handle: AgentHandle | undefined
    let runtime: DshAgentRuntimePort | undefined
    let models: SessionModelPort | undefined
    let context: SessionContextPort | undefined
    let workbench: SessionWorkbenchPort | undefined
    let jobs: SessionJobsPort | undefined
    let modes: SessionModePort | undefined
    let delegation: SessionDelegationPort | undefined
    let acquiredOwned = false
    try {
      handle = await this.coordinator.acquireOwned({
        sessionId: request.sessionId,
        signal: request.signal,
        ...(request.selection === undefined
          ? {}
          : { selection: officialModelSelection(request.selection) }),
        setup: (agentCtx) => {
          const agent = agentCtx.agent
          if (agent === undefined) {
            throw new Error('DSH Agent setup did not expose its unpublished Agent')
          }
          commands = new DshCommandSession(this.ctx, agent)
          workbench = new DshSessionWorkbench(this.ctx, agent.session, agent)
          jobs = new DshSessionJobs(agent)
          modes = new DshSessionMode(this.ctx, agent)
          delegation = new DshSessionDelegation(this.ctx, agent)
          interaction = this.hub.attach({
            sessionId: agent.session.id,
            agent,
            session: agent.session,
          })
          models = this.modelHub?.attach(agent)
          context = new DshSessionContextMeter(this.ctx, agent.session)
        },
      })
      acquiredOwned = true
      request.signal.throwIfAborted()
      if (commands === undefined || interaction === undefined) {
        throw new Error('DSH cold interaction setup did not run')
      }

      runtime = new DshAgentRuntimePort(this.ctx, sessions, {
        ownership: 'owned',
        handle,
      })
      handle = undefined
      const port = new DshTuiSessionPort(
        runtime,
        interaction,
        commands,
        models,
        context,
        workbench,
        jobs,
        modes,
        delegation,
      )
      runtime = undefined
      interaction = undefined
      commands = undefined
      models = undefined
      context = undefined
      workbench = undefined
      jobs = undefined
      modes = undefined
      delegation = undefined
      return {
        port,
        release: () => port.dispose(),
      }
    } catch (error: unknown) {
      const cleanupError = await this.rollback(
        commands,
        interaction,
        runtime,
        handle,
        models,
        context,
        workbench,
        jobs,
        modes,
        delegation,
      )
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [error, cleanupError],
          'DSH cold activation and rollback failed',
        )
      }
      if (
        acquiredOwned
        || error instanceof DshColdResumeBusyError
        || this.coordinator.isReserved(request.sessionId)
      ) throw error
      if (request.signal.aborted) request.signal.throwIfAborted()
      if (!(error instanceof DshColdResumeExternalWinnerError)) throw error

      const agents = this.ctx.get('agents')
      const external = agents?.get(OfficialSessionId(request.sessionId))
      if (external === undefined) throw error
      try {
        return await this.live.activateSession({
          intent: 'attach-live',
          sessionId: request.sessionId,
          signal: request.signal,
        })
      } catch (adoptionError: unknown) {
        throw new AggregateError(
          [error, adoptionError],
          `DSH cold resume and external live adoption failed for "${request.sessionId}"`,
        )
      }
    }
  }

  private async rollback(
    commands: DshCommandSession | undefined,
    interaction: DshInteractionSession | undefined,
    runtime: DshAgentRuntimePort | undefined,
    handle: AgentHandle | undefined,
    models?: SessionModelPort,
    context?: SessionContextPort,
    workbench?: SessionWorkbenchPort,
    jobs?: SessionJobsPort,
    modes?: SessionModePort,
    delegation?: SessionDelegationPort,
  ): Promise<unknown | undefined> {
    const errors: unknown[] = []
    try {
      commands?.disposeCommands()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      interaction?.disposeInteractions()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      models?.disposeModels()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      context?.disposeContext()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      workbench?.disposeWorkbench()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      jobs?.disposeJobs()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      modes?.disposeModes()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      delegation?.disposeDelegation()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      if (runtime !== undefined) await runtime.dispose()
      else await handle?.dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
    if (errors.length === 0) return undefined
    if (errors.length === 1) return errors[0]
    return new AggregateError(errors, 'DSH cold activation rollback failed')
  }
}

/** Dispatch explicit activation intents without inferring side effects from catalog state. */
export class DshSessionActivation implements SessionActivationPort {
  private readonly live: DshLiveSessionActivation
  private readonly cold: DshColdSessionActivation

  constructor(
    ctx: Context,
    hub: DshInteractionHub,
    coordinator: DshColdResumeCoordinator,
    modelHub?: DshModelSelectionHub,
  ) {
    this.live = new DshLiveSessionActivation(ctx, hub, modelHub)
    this.cold = new DshColdSessionActivation(ctx, hub, coordinator, modelHub)
  }

  activateSession(request: SessionActivationRequest): Promise<ActivatedSessionLease> {
    return request.intent === 'attach-live'
      ? this.live.activateSession(request)
      : this.cold.activateSession(request)
  }
}
