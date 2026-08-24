import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentRegistry,
  type AgentSetup,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import type AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import type AgentPresets from '@deepseek-ai/dsh-agent-presets'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { SessionId as OfficialSessionId, type Session } from '@deepseek-ai/dsh-session'
import type SessionStore from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import {
  deriveColdResumePlan,
  type ColdResumePlan,
} from './cold-resume-plan.ts'
import { installPresetProfileIsolation } from './runtime-port.ts'
import { isDelegatedSession } from './session-eligibility.ts'

const MAX_RESUME_ATTEMPTS = 2

export interface DshColdResumeRequest {
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly selection?: ModelSelection
  readonly maxTokens?: number
  readonly setup?: AgentSetup
}

export class DshColdResumeBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`DSH cold resume for "${sessionId}" is already owned by DSH-TUI`)
  }
}

export class DshColdResumeSemanticDriftError extends Error {
  constructor(readonly sessionId: string) {
    super(`DSH cold resume semantics changed before publication for "${sessionId}"`)
  }
}

export class DshColdResumeExternalWinnerError extends Error {
  constructor(readonly sessionId: string, cause: unknown) {
    super('DSH external live Agent/Session won the cold resume race for "' + sessionId + '"', {
      cause,
    })
  }
}

interface ResumeFlight {
  readonly sessionId: string
  readonly token: symbol
  state: 'resuming' | 'owned' | 'disposing'
  readonly flightSettled: PromiseWithResolvers<void>
  readonly releaseSettled: PromiseWithResolvers<void>
  disposeOwned?: () => Promise<void>
}

interface ResumeServices {
  readonly agents: AgentRegistry
  readonly sessions: SessionStore
  readonly persistence: SessionPersistence
  readonly presets: AgentPresets
  readonly defaultModel: AgentDefaultModel
}

function presetSourceKey(preset: Pick<AgentPreset, 'id' | 'trust' | 'path'>): string {
  return JSON.stringify([preset.id, preset.trust, preset.path])
}

function modelSelectionKey(selection: ModelSelection): string {
  return JSON.stringify([
    selection.provider,
    selection.model,
    selection.reasoningEffort,
  ])
}

/** Shared ownership boundary for exact cold resume entry points. */
export class DshColdResumeCoordinator {
  private readonly flights = new Map<string, ResumeFlight>()
  private readonly hostAbort = new AbortController()
  private readonly acquisitions = new Set<Promise<AgentHandle>>()
  private accepting = true
  private disposePromise: Promise<void> | undefined

  constructor(private readonly ctx: Context) {}

  isReserved(sessionId: string): boolean {
    return this.flights.has(sessionId)
  }

  acquireOwned(request: DshColdResumeRequest): Promise<AgentHandle> {
    if (!this.accepting) {
      return Promise.reject(new Error('DSH cold resume coordinator is disposed'))
    }
    const task = this.runAcquireOwned({
      ...request,
      signal: AbortSignal.any([request.signal, this.hostAbort.signal]),
    })
    this.acquisitions.add(task)
    void task.then(
      () => { this.acquisitions.delete(task) },
      () => { this.acquisitions.delete(task) },
    )
    return task
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.accepting = false
    this.hostAbort.abort(new Error('DSH cold resume coordinator disposed'))
    this.disposePromise = (async () => {
      const errors: unknown[] = []
      const acquisitions = await Promise.allSettled([...this.acquisitions])
      for (const result of acquisitions) {
        if (
          result.status === 'rejected'
          && result.reason !== this.hostAbort.signal.reason
        ) errors.push(result.reason)
      }
      const releases = await Promise.allSettled(
        [...this.flights.values()]
          .map(flight => flight.disposeOwned)
          .filter((dispose): dispose is () => Promise<void> => dispose !== undefined)
          .map(dispose => dispose()),
      )
      for (const result of releases) {
        if (result.status === 'rejected') errors.push(result.reason)
      }
      if (errors.length !== 0) {
        throw new AggregateError(errors, 'DSH cold resume coordinator disposal failed')
      }
    })()
    return this.disposePromise
  }

  private async runAcquireOwned(request: DshColdResumeRequest): Promise<AgentHandle> {
    await this.ctx.get('loader')?.await()
    request.signal.throwIfAborted()
    const sessionId = OfficialSessionId(request.sessionId)

    while (true) {
      const existing = this.flights.get(sessionId)
      if (existing === undefined) break
      if (existing.state === 'owned') throw new DshColdResumeBusyError(sessionId)
      await this.waitForSettlement(
        existing.state === 'resuming'
          ? existing.flightSettled.promise
          : existing.releaseSettled.promise,
        request.signal,
      )
    }

    const services = this.services()
    const preexistingAgent = services.agents.get(sessionId)
    const preexistingSession = services.sessions.get(sessionId)
    const preexisting = this.externalPublishedAgent(
      services,
      preexistingAgent,
      preexistingSession,
    )
    if (preexisting !== undefined) {
      throw new DshColdResumeExternalWinnerError(
        sessionId,
        new Error('an exact live Agent/Session was already published'),
      )
    }
    const stopPresetProfileIsolation = installPresetProfileIsolation(this.ctx)
    const flight: ResumeFlight = {
      sessionId,
      token: Symbol(sessionId),
      state: 'resuming',
      flightSettled: Promise.withResolvers<void>(),
      releaseSettled: Promise.withResolvers<void>(),
    }
    this.flights.set(sessionId, flight)
    let handedOff = false
    try {
      const acquired = await this.resumeWithRetry(
        request,
        sessionId,
        flight,
        services,
        stopPresetProfileIsolation,
      )
      try {
        request.signal.throwIfAborted()
      } catch (error: unknown) {
        await this.rollbackPublished(
          error,
          acquired,
          flight,
          services,
          stopPresetProfileIsolation,
          'DSH cold resume was cancelled before handoff and rollback failed',
        )
      }
      const handle = this.ownedHandle(
        acquired,
        flight,
        services,
        stopPresetProfileIsolation,
      )
      flight.state = 'owned'
      flight.flightSettled.resolve()
      handedOff = true
      return handle
    } finally {
      if (!handedOff && flight.state === 'resuming') {
        stopPresetProfileIsolation()
        if (this.flights.get(sessionId) === flight) this.flights.delete(sessionId)
        flight.flightSettled.resolve()
        flight.releaseSettled.resolve()
      }
    }
  }

  private services(): ResumeServices {
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    const persistence = this.ctx.get('sessionPersistence')
    const presets = this.ctx.get('agentPresets')
    const defaultModel = this.ctx.get('agentDefaultModel')
    if (
      agents === undefined
      || sessions === undefined
      || persistence === undefined
      || presets === undefined
      || defaultModel === undefined
    ) {
      throw new Error(
        'DSH Agent/Session/Persistence/Preset/default-model services are unavailable',
      )
    }
    return { agents, sessions, persistence, presets, defaultModel }
  }

  private async resumeWithRetry(
    request: DshColdResumeRequest,
    sessionId: string,
    flight: ResumeFlight,
    services: ResumeServices,
    stopPresetProfileIsolation: () => void,
  ): Promise<AgentHandle> {
    for (let attempt = 0; attempt < MAX_RESUME_ATTEMPTS; attempt += 1) {
      request.signal.throwIfAborted()
      const inspection = await services.persistence.inspect(
        OfficialSessionId(sessionId),
        request.signal,
      )
      request.signal.throwIfAborted()
      const plan = await this.derivePlan(inspection, request, services)
      try {
        return await this.resumeAttempt(
          request,
          flight,
          services,
          plan,
          stopPresetProfileIsolation,
        )
      } catch (error: unknown) {
        if (request.signal.aborted) request.signal.throwIfAborted()
        if (
          !(error instanceof DshColdResumeSemanticDriftError)
          || attempt + 1 >= MAX_RESUME_ATTEMPTS
        ) throw error
      }
    }
    /* v8 ignore next -- the bounded loop either returns or throws. */
    throw new Error(`DSH cold resume retry invariant failed for "${sessionId}"`)
  }

  private async derivePlan(
    inspection: SessionInspection,
    request: DshColdResumeRequest,
    services: ResumeServices,
  ): Promise<ColdResumePlan> {
    const defaultSelection = services.defaultModel.currentSelection()
    if (defaultSelection === undefined) {
      throw new Error('DSH model selection is unavailable')
    }
    return await deriveColdResumePlan(inspection, {
      sessionId: request.sessionId,
      ...(request.selection === undefined
        ? {}
        : { explicitSelection: request.selection }),
      ...(request.maxTokens === undefined
        ? {}
        : { explicitMaxTokens: request.maxTokens }),
      defaultSelection,
      defaultPresetId: services.presets.defaultId,
      resolvePreset: id => services.presets.resolve(id),
    })
  }

  private async resumeAttempt(
    request: DshColdResumeRequest,
    flight: ResumeFlight,
    services: ResumeServices,
    plan: ColdResumePlan,
    stopPresetProfileIsolation: () => void,
  ): Promise<AgentHandle> {
    let candidate: Agent | undefined
    const setup: AgentSetup = async (agentCtx) => {
      const agent = agentCtx.agent
      if (agent === undefined) {
        throw new Error('DSH Agent setup did not expose its unpublished Agent')
      }
      candidate = agent
      this.assertCandidateIdentity(agent, plan.sessionId)
      const preparedPlan = await this.derivePlan({
        meta: agent.session.header,
        events: agent.session.events,
      }, request, services)
      if (preparedPlan.fingerprint !== plan.fingerprint) {
        throw new DshColdResumeSemanticDriftError(plan.sessionId)
      }
      this.assertUnpublishedAuthority(
        request.signal,
        flight,
        services,
        agent,
        plan,
        false,
      )

      installModelSelection(agentCtx, {
        current: plan.selection,
        assembled: undefined,
      })
      const mounted = await services.presets.mount(agentCtx, plan.preset.id)
      if (presetSourceKey(mounted) !== presetSourceKey(plan.preset)) {
        throw new DshColdResumeSemanticDriftError(plan.sessionId)
      }
      const downstream = await request.setup?.(agentCtx)
      this.assertUnpublishedAuthority(request.signal, flight, services, agent, plan)
      return {
        commit: () => {
          this.assertCommitFallbacks(services, plan)
          this.assertUnpublishedAuthority(request.signal, flight, services, agent, plan)
          downstream?.commit()
          this.assertCommitFallbacks(services, plan)
          this.assertUnpublishedAuthority(request.signal, flight, services, agent, plan)
        },
      }
    }

    const officialSessionId = OfficialSessionId(plan.sessionId)
    const agentBeforeResume = services.agents.get(officialSessionId)
    const sessionBeforeResume = services.sessions.get(officialSessionId)
    const winnerBeforeResume = this.externalPublishedAgent(
      services,
      agentBeforeResume,
      sessionBeforeResume,
      candidate,
    )
    if (winnerBeforeResume !== undefined) {
      throw new DshColdResumeExternalWinnerError(
        plan.sessionId,
        new Error('an exact live Agent/Session was published before resume setup'),
      )
    }
    let handle: AgentHandle
    try {
      handle = await services.agents.resume({
        resumeSessionId: OfficialSessionId(plan.sessionId),
        agentOptions: {
          provider: plan.selection.provider,
          model: plan.selection.model,
          ...(plan.maxTokens === undefined ? {} : { maxTokens: plan.maxTokens }),
        },
        setup,
        signal: request.signal,
      })
    } catch (error: unknown) {
      if (agentBeforeResume === undefined && sessionBeforeResume === undefined) {
        const external = this.externalPublishedAgent(
          services,
          services.agents.get(officialSessionId),
          services.sessions.get(officialSessionId),
          candidate,
        )
        if (external !== undefined) {
          throw new DshColdResumeExternalWinnerError(plan.sessionId, error)
        }
      }
      throw error
    }
    try {
      request.signal.throwIfAborted()
      if (candidate !== handle.agent) {
        throw new Error(`DSH resume returned a different Agent for "${plan.sessionId}"`)
      }
      this.assertPublishedAuthority(flight, services, handle.agent, plan)
      return handle
    } catch (error: unknown) {
      return await this.rollbackPublished(
        error,
        handle,
        flight,
        services,
        stopPresetProfileIsolation,
        'DSH cold resume post-publication check and rollback failed',
      )
    }
  }

  private externalPublishedAgent(
    services: ResumeServices,
    agent: Agent | undefined,
    session: Session | undefined,
    candidate?: Agent,
  ): Agent | undefined {
    if (agent === undefined || agent === candidate) return undefined
    if (
      session !== agent.session
      || isDelegatedSession(agent.session.header)
      || !services.agents.roots().includes(agent)
    ) return undefined
    return agent
  }

  private async rollbackPublished(
    error: unknown,
    handle: AgentHandle,
    flight: ResumeFlight,
    services: ResumeServices,
    stopPresetProfileIsolation: () => void,
    message: string,
  ): Promise<never> {
    const rollback = this.ownedHandle(
      handle,
      flight,
      services,
      stopPresetProfileIsolation,
    )
    try {
      await rollback.dispose()
    } catch (disposeError: unknown) {
      if (this.flights.get(flight.sessionId) === flight) {
        flight.state = 'owned'
        flight.flightSettled.resolve()
      }
      throw new AggregateError([error, disposeError], message)
    }
    throw error
  }

  private assertCandidateIdentity(agent: Agent, sessionId: string): void {
    if (agent.id !== sessionId || agent.session.id !== sessionId) {
      throw new Error(`DSH cold resume prepared the wrong Agent/Session for "${sessionId}"`)
    }
  }

  private assertUnpublishedAuthority(
    signal: AbortSignal,
    flight: ResumeFlight,
    services: ResumeServices,
    agent: Agent,
    plan: ColdResumePlan,
    requireMountedPreset = true,
  ): void {
    signal.throwIfAborted()
    if (
      this.flights.get(plan.sessionId) !== flight
      || flight.state !== 'resuming'
      || agent.id !== plan.sessionId
      || agent.session.id !== plan.sessionId
      || services.agents.get(OfficialSessionId(plan.sessionId)) !== undefined
      || services.sessions.get(OfficialSessionId(plan.sessionId)) !== undefined
      || (
        requireMountedPreset
        && services.presets.composedPreset(agent.ctx) !== plan.preset.id
      )
    ) {
      throw new Error(
        `DSH cold resume unpublished authority changed for "${plan.sessionId}"`,
      )
    }
  }

  private assertCommitFallbacks(
    services: ResumeServices,
    plan: ColdResumePlan,
  ): void {
    const currentSelection = services.defaultModel.currentSelection()
    if (
      plan.provenance.route === 'default'
      && (
        currentSelection === undefined
        || modelSelectionKey(currentSelection) !== modelSelectionKey(plan.selection)
      )
    ) {
      throw new Error(`DSH default model changed before resume publication for "${plan.sessionId}"`)
    }
    if (
      plan.preset.provenance === 'default'
      && services.presets.defaultId !== plan.preset.id
    ) {
      throw new Error(`DSH default preset changed before resume publication for "${plan.sessionId}"`)
    }
  }

  private assertPublishedAuthority(
    flight: ResumeFlight,
    services: ResumeServices,
    agent: Agent,
    plan: ColdResumePlan,
  ): void {
    const options = agent.options
    if (
      this.flights.get(plan.sessionId) !== flight
      || flight.state !== 'resuming'
      || agent.id !== plan.sessionId
      || agent.session.id !== plan.sessionId
      || services.agents.get(OfficialSessionId(plan.sessionId)) !== agent
      || services.sessions.get(OfficialSessionId(plan.sessionId)) !== agent.session
      || !services.agents.roots().includes(agent)
      || services.presets.composedPreset(agent.ctx) !== plan.preset.id
      || options.provider !== plan.selection.provider
      || options.model !== plan.selection.model
      || options.maxTokens !== plan.maxTokens
    ) {
      throw new Error(`DSH cold resume publication changed for "${plan.sessionId}"`)
    }
  }

  private ownedHandle(
    handle: AgentHandle,
    flight: ResumeFlight,
    services: ResumeServices,
    stopPresetProfileIsolation: () => void,
  ): AgentHandle {
    let disposePromise: Promise<void> | undefined
    const owned: AgentHandle = {
      agent: handle.agent,
      dispose: () => {
        if (disposePromise !== undefined) return disposePromise
        flight.state = 'disposing'
        flight.flightSettled.resolve()
        disposePromise = (async () => {
          let disposalError: unknown | undefined
          try {
            await handle.dispose()
          } catch (error: unknown) {
            disposalError = error
          }
          const stillLive =
            services.agents.get(OfficialSessionId(flight.sessionId)) === handle.agent
            || services.sessions.get(OfficialSessionId(flight.sessionId)) === handle.agent.session
          if (!stillLive) {
            stopPresetProfileIsolation()
            if (this.flights.get(flight.sessionId) === flight) {
              this.flights.delete(flight.sessionId)
            }
            delete flight.disposeOwned
            flight.releaseSettled.resolve()
          }
          if (disposalError !== undefined) throw disposalError
          if (stillLive) {
            throw new Error(
              `DSH cold resume disposal left Agent/Session live for "${flight.sessionId}"`,
            )
          }
        })()
        return disposePromise
      },
    }
    flight.disposeOwned = owned.dispose
    return owned
  }

  private async waitForSettlement(
    settlement: Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => { reject(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
      void settlement.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort)
      })
    })
  }
}
