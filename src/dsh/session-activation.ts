import type { Context } from '@deepseek-ai/cordis'
import { SessionId as OfficialSessionId } from '@deepseek-ai/dsh-session'
import type {
  ActivatedSessionLease,
  SessionActivationPort,
  SessionActivationRequest,
} from '../session/activation-port.ts'
import { DshTuiSessionPort } from '../runtime/tui-session-port.ts'
import { DshCommandSession } from './command-session.ts'
import {
  DshInteractionHub,
  type DshInteractionSession,
} from './interaction-hub.ts'
import {
  DshAgentRuntimePort,
  installPresetProfileIsolation,
} from './runtime-port.ts'
import { isDelegatedSession } from './session-eligibility.ts'
import type { DshModelSelectionHub } from './model-selection.ts'
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

/** Borrow one exact live root Agent without assuming ownership of its lifecycle. */
export class DshLiveSessionActivation implements SessionActivationPort {
  constructor(
    private readonly ctx: Context,
    private readonly hub: DshInteractionHub,
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
    let runtime: DshAgentRuntimePort | undefined
    let commands: DshCommandSession | undefined
    let interaction: DshInteractionSession | undefined
    let models: SessionModelPort | undefined
    let context: SessionContextPort | undefined
    let workbench: SessionWorkbenchPort | undefined
    let jobs: SessionJobsPort | undefined
    let modes: SessionModePort | undefined
    let delegation: SessionDelegationPort | undefined
    try {
      runtime = new DshAgentRuntimePort(this.ctx, sessions, {
        ownership: 'borrowed',
        agent,
      }, undefined, stopPresetProfileIsolation)
      commands = new DshCommandSession(this.ctx, agent)
      workbench = new DshSessionWorkbench(this.ctx, agent.session, agent)
      jobs = new DshSessionJobs(agent)
      modes = new DshSessionMode(this.ctx, agent)
      delegation = new DshSessionDelegation(this.ctx, agent)
      interaction = this.hub.attach({
        sessionId,
        agent,
        session: agent.session,
      })
      models = this.modelHub?.attach(agent)
      context = new DshSessionContextMeter(this.ctx, agent.session)
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
      return {
        port,
        release: () => port.dispose(),
      }
    } catch (error: unknown) {
      if (runtime === undefined) stopPresetProfileIsolation()
      try {
        commands?.disposeCommands()
      } finally {
        try {
          interaction?.disposeInteractions()
        } finally {
          try {
            models?.disposeModels()
          } finally {
            try {
              context?.disposeContext()
            } finally {
              try {
                modes?.disposeModes()
              } finally {
                try {
                  delegation?.disposeDelegation()
                } finally {
                  try {
                    workbench?.disposeWorkbench()
                  } finally {
                    try {
                      jobs?.disposeJobs()
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
}
