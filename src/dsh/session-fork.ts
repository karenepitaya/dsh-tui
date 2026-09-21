import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import type AgentPresets from '@deepseek-ai/dsh-agent-presets'
import {
  SessionId,
  type SessionEvent,
  type SessionHeader,
  type SessionLogOffset,
  type SessionStore,
} from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { AgentPresetSelectionPlan } from '../preset/catalog-port.ts'
import type { DshTuiSessionPort } from '../runtime/tui-session-port.ts'
import type {
  SessionForkPort,
  SessionForkRequest,
} from '../session/fork-port.ts'
import { deriveColdResumePlan } from './cold-resume-plan.ts'
import { snapshotSessionEvents } from './session-events.ts'
import { planDshSessionFork } from './session-fork-plan.ts'

export interface OpenDshForkSessionRequest {
  readonly mode: 'fork'
  readonly sessionId: string
  readonly parentSessionId: string
  readonly seed: readonly SessionEvent[]
  readonly cwd?: string
  readonly agentPreset: string
  readonly agentPresetPlan: AgentPresetSelectionPlan
  readonly selection: ModelSelection
  readonly maxTokens?: number
  readonly signal: AbortSignal
}

export type OpenDshForkSession = (
  request: OpenDshForkSessionRequest,
) => Promise<DshTuiSessionPort>

interface ForkSource {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
}

interface CompositionServices {
  readonly presets: AgentPresets
  readonly defaultModel: AgentDefaultModel
}

/** Official-service adapter that turns a completed source prefix into an owned TUI Agent. */
export class DshSessionFork implements SessionForkPort {
  constructor(
    private readonly ctx: Context,
    private readonly open: OpenDshForkSession,
  ) {}

  async forkSession(request: SessionForkRequest) {
    request.signal.throwIfAborted()
    const source = await this.readSource(request)
    request.signal.throwIfAborted()
    const fork = planDshSessionFork(
      request.sourceSessionId,
      source.events,
      request.atSeq,
    )
    const { presets, defaultModel } = this.compositionServices()
    const defaultSelection = defaultModel.currentSelection()
    if (defaultSelection === undefined) {
      throw new Error('DSH model selection is unavailable')
    }
    const composition = await deriveColdResumePlan({
      meta: source.header,
      inheritedEventCount: source.inheritedEventCount,
      events: fork.seed,
    }, {
      sessionId: request.sourceSessionId,
      allowDelegatedSource: true,
      defaultSelection,
      defaultPresetId: presets.defaultId,
      resolvePreset: id => presets.resolve(id),
    })
    request.signal.throwIfAborted()

    const childSessionId = `session-${randomUUID()}`
    const port = await this.open({
      mode: 'fork',
      sessionId: childSessionId,
      parentSessionId: request.sourceSessionId,
      seed: fork.seed,
      ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
      agentPreset: composition.preset.id,
      agentPresetPlan: {
        id: composition.preset.id,
        trust: composition.preset.trust,
        sourcePath: composition.preset.path,
      },
      selection: composition.selection,
      ...(composition.maxTokens === undefined
        ? {}
        : { maxTokens: composition.maxTokens }),
      signal: request.signal,
    })
    if (request.signal.aborted) {
      const reason = request.signal.reason
      try {
        await port.dispose()
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [reason, cleanupError],
          `DSH fork cancellation rollback failed for "${childSessionId}"`,
        )
      }
      throw reason
    }
    return {
      port,
      release: () => port.dispose(),
    }
  }

  private async readSource(request: SessionForkRequest): Promise<ForkSource> {
    const sessions = this.ctx.get('sessions') as SessionStore | undefined
    if (sessions === undefined) throw new Error('DSH Session service is unavailable')
    const id = SessionId(request.sourceSessionId)
    const live = sessions.get(id)
    if (live !== undefined) {
      return {
        header: live.header,
        inheritedEventCount: live.inheritedEventCount,
        events: [...snapshotSessionEvents(live)],
      }
    }

    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error(
        `DSH Session persistence service is unavailable for "${request.sourceSessionId}"`,
      )
    }
    let inspected: SessionInspection
    try {
      const handle = await persistence.open(id, 'read', { signal: request.signal })
      try {
        const { events } = await handle.read(undefined, undefined, {
          signal: request.signal,
        })
        inspected = {
          meta: handle.header,
          inheritedEventCount: handle.inheritedEventCount,
          events,
        }
      } finally {
        await handle.close()
      }
    } catch (error: unknown) {
      request.signal.throwIfAborted()
      throw error
    }
    request.signal.throwIfAborted()
    if (inspected.meta.id !== id) {
      throw new Error(
        `DSH fork inspection returned "${inspected.meta.id}" for "${request.sourceSessionId}"`,
      )
    }
    return {
      header: inspected.meta,
      inheritedEventCount: inspected.inheritedEventCount,
      events: [...inspected.events],
    }
  }

  private compositionServices(): CompositionServices {
    const presets = this.ctx.get('agentPresets')
    const defaultModel = this.ctx.get('agentDefaultModel')
    if (presets === undefined || defaultModel === undefined) {
      throw new Error('DSH Preset/default-model services are unavailable')
    }
    return { presets, defaultModel }
  }
}
