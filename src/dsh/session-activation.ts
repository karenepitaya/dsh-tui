import type { Context } from '@deepseek-ai/cordis'
import { SessionId as OfficialSessionId } from '@deepseek-ai/dsh-session'
import type {
  ActivatedSessionLease,
  SessionActivationPort,
  SessionActivationRequest,
} from '../session/activation-port.ts'
import {
  DshAgentRuntimePort,
  installPresetProfileIsolation,
} from './runtime-port.ts'
import { isDelegatedSession } from './session-eligibility.ts'
import type { DshModelSelectionHub } from './model-selection.ts'
import {
  type DshSessionPortComposer,
  type PreparedDshSessionPort,
} from './session-port-composer.ts'

/** Borrow one exact live root Agent without assuming ownership of its lifecycle. */
export class DshLiveSessionActivation implements SessionActivationPort {
  constructor(
    private readonly ctx: Context,
    private readonly sessionComposer: DshSessionPortComposer,
    private readonly modelHub?: DshModelSelectionHub,
  ) {}

  async activateSession(
    request: SessionActivationRequest,
  ): Promise<ActivatedSessionLease> {
    if (request.intent !== 'attach-live') {
      throw new Error(
        `DSH live activation cannot satisfy "${request.intent}" for "${request.sessionId}"`,
      )
    }
    request.signal.throwIfAborted()
    const agents = this.ctx.get('agents')
    if (agents === undefined) throw new Error('DSH Agent service is unavailable')
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('DSH Session service is unavailable')

    const sessionId = OfficialSessionId(request.sessionId)
    const agent = agents.get(sessionId)
    if (agent === undefined) {
      if (sessions.get(sessionId) !== undefined) {
        throw new Error(
          `DSH live Session exists without a live Agent for "${sessionId}"; retry activation`,
        )
      }
      throw new Error(
        `DSH cold activation is blocked until model/preset restore for "${sessionId}" is implemented`,
      )
    }
    if (isDelegatedSession(agent.session.header)) {
      throw new Error(`DSH-TUI cannot activate subagent session "${sessionId}"`)
    }
    if (!agents.roots().includes(agent)) {
      throw new Error(`DSH session "${sessionId}" is not a live root Agent`)
    }
    if (sessions.get(sessionId) !== agent.session) {
      throw new Error(
        `DSH Agent/Session identity is transitioning for "${sessionId}"; retry activation`,
      )
    }

    const stopPresetProfileIsolation = installPresetProfileIsolation(this.ctx)
    const sessionScope = this.sessionComposer.createSessionScope(`dsh:live:${sessionId}`)
    let runtime: DshAgentRuntimePort | undefined
    let prepared: PreparedDshSessionPort | undefined
    let completionStarted = false
    try {
      runtime = new DshAgentRuntimePort(this.ctx, sessions, {
        ownership: 'borrowed',
        agent,
      }, undefined, stopPresetProfileIsolation, this.modelHub)
      prepared = await this.sessionComposer.prepare(agent, sessionScope)
      request.signal.throwIfAborted()
      if (
        agents.get(sessionId) !== agent
        || sessions.get(sessionId) !== agent.session
        || !agents.roots().includes(agent)
      ) {
        throw new Error(
          `DSH live ownership changed during activation for "${sessionId}"; retry activation`,
        )
      }
      completionStarted = true
      const port = await this.sessionComposer.complete(prepared, runtime)
      return {
        port,
        release: () => port.dispose(),
      }
    } catch (error: unknown) {
      if (completionStarted) throw error
      const failures: unknown[] = [error]
      if (runtime === undefined) stopPresetProfileIsolation()
      try {
        if (prepared !== undefined) {
          await this.sessionComposer.release(prepared, 'DSH live activation failed')
        } else {
          await sessionScope.dispose('DSH live activation failed')
        }
      } catch (cleanupError: unknown) {
        failures.push(cleanupError)
      }
      try {
        await runtime?.dispose()
      } catch (cleanupError: unknown) {
        failures.push(cleanupError)
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'DSH live activation and rollback failed')
      }
      throw error
    }
  }
}
