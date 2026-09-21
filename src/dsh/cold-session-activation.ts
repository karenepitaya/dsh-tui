import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId as OfficialSessionId } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {
  ActivatedSessionLease,
  SessionActivationPort,
  SessionActivationRequest,
} from '../session/activation-port.ts'
import {
  DshColdResumeBusyError,
  DshColdResumeExternalWinnerError,
  type DshColdResumeCoordinator,
} from './cold-resume-coordinator.ts'
import { DshAgentRuntimePort } from './runtime-port.ts'
import { DshLiveSessionActivation } from './session-activation.ts'
import {
  officialModelSelection,
  type DshModelSelectionHub,
} from './model-selection.ts'
import {
  type DshSessionPortComposer,
  type PreparedDshSessionPort,
} from './session-port-composer.ts'

/** Resume one cold root under owned authority, with exact live-winner adoption. */
export class DshColdSessionActivation implements SessionActivationPort {
  private readonly live: DshLiveSessionActivation

  constructor(
    private readonly ctx: Context,
    private readonly coordinator: DshColdResumeCoordinator,
    private readonly sessionComposer: DshSessionPortComposer,
    private readonly modelHub?: DshModelSelectionHub,
  ) {
    this.live = new DshLiveSessionActivation(ctx, sessionComposer, modelHub)
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

    let handle: AgentHandle | undefined
    let runtime: DshAgentRuntimePort | undefined
    let prepared: PreparedDshSessionPort | undefined
    let acquiredOwned = false
    let completionStarted = false
    try {
      handle = await this.coordinator.acquireOwned({
        sessionId: request.sessionId,
        signal: request.signal,
        ...(request.selection === undefined
          ? {}
          : { selection: officialModelSelection(request.selection) }),
        setup: async (agentCtx, runtimeSessionScope) => {
          // The unpublished Agent IS its scope key (the exact-scope identity
          // installDshAgentGuidance also asserts); 0.1.5 dropped Context.agent.
          const agent = scopeOf(agentCtx) as Agent | undefined
          if (agent === undefined) {
            throw new Error('DSH Agent setup did not expose its unpublished Agent')
          }
          prepared = await this.sessionComposer.prepare(agent, runtimeSessionScope)
        },
      })
      acquiredOwned = true
      request.signal.throwIfAborted()
      if (prepared === undefined) {
        throw new Error('DSH cold interaction setup did not run')
      }
      runtime = new DshAgentRuntimePort(this.ctx, sessions, {
        ownership: 'owned',
        handle,
      }, undefined, undefined, this.modelHub)
      handle = undefined
      completionStarted = true
      const port = await this.sessionComposer.complete(prepared, runtime)
      runtime = undefined
      return {
        port,
        release: () => port.dispose(),
      }
    } catch (error: unknown) {
      const cleanupError = completionStarted
        ? undefined
        : await this.rollback(prepared, runtime, handle)
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
    prepared: PreparedDshSessionPort | undefined,
    runtime: DshAgentRuntimePort | undefined,
    handle: AgentHandle | undefined,
  ): Promise<unknown | undefined> {
    const errors: unknown[] = []
    try {
      if (prepared !== undefined) {
        await this.sessionComposer.release(prepared, 'DSH cold activation failed')
      }
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
    coordinator: DshColdResumeCoordinator,
    sessionComposer: DshSessionPortComposer,
    modelHub?: DshModelSelectionHub,
  ) {
    this.live = new DshLiveSessionActivation(ctx, sessionComposer, modelHub)
    this.cold = new DshColdSessionActivation(
      ctx,
      coordinator,
      sessionComposer,
      modelHub,
    )
  }

  activateSession(request: SessionActivationRequest): Promise<ActivatedSessionLease> {
    return request.intent === 'attach-live'
      ? this.live.activateSession(request)
      : this.cold.activateSession(request)
  }
}
