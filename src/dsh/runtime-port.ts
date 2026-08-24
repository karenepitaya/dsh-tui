import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentSetup,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId as OfficialSessionId } from '@deepseek-ai/dsh-session'
import type SessionStore from '@deepseek-ai/dsh-session'
import type {
  RuntimeDshEnvelope,
} from '../runtime/events.ts'
import {
  createDshEventDelivery,
  type DshEventDelivery,
} from '../runtime/delivery.ts'
import type {
  CancelCause,
  Delivery,
  DshRuntimePort,
  RuntimeEventOptions,
  SubmitInput,
  SubmitResult,
} from '../runtime/port.ts'
import type { AgentPresetSelectionPlan } from '../preset/catalog-port.ts'
import { WakeQueue } from '../runtime/wake-queue.ts'
import { convertSessionEvent } from './session-event-adapter.ts'
import { DshToolPresentationProjector } from './tool-presentation.ts'

export interface OpenDshRuntimeBase {
  readonly selection?: ModelSelection
  readonly maxTokens?: number
  readonly signal?: AbortSignal
  readonly setup?: AgentSetup
}

export type OpenDshRuntimeOptions = OpenDshRuntimeBase & (
  | {
      readonly mode?: 'create'
      readonly sessionId?: string
      readonly cwd?: string
      readonly agentPreset?: string
      readonly agentPresetPlan?: AgentPresetSelectionPlan
    }
  | {
      readonly mode: 'resume'
      readonly sessionId: string
      readonly cwd?: never
      readonly agentPresetPlan?: never
    }
)

export type DshAgentRuntimeLease =
  | {
      readonly ownership: 'owned'
      readonly handle: AgentHandle
    }
  | {
      readonly ownership: 'borrowed'
      readonly agent: Agent
    }

/** Keep the preset profile free of context-global capability registrations. */
export function installPresetProfileIsolation(ctx: Context): () => void {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('DSH Tool service is unavailable')
  const assertIsolated = (): void => {
    const globalTools = tools.schemas()
      .map(schema => schema.name)
      .filter(name => name !== RUN_CODE_NAME)
      .sort()
    if (globalTools.length > 0) {
      throw new Error(
        'DSH preset profile has global tools outside an Agent scope: '
        + globalTools.join(', '),
      )
    }
  }
  assertIsolated()
  return ctx.on('tools/change', assertIsolated)
}

function presetSourceKey(preset: {
  readonly id: string
  readonly trust?: unknown
  readonly path?: unknown
}): string {
  return JSON.stringify([preset.id, preset.trust, preset.path])
}

function plannedSourceKey(plan: AgentPresetSelectionPlan): string {
  return JSON.stringify([plan.id, plan.trust, plan.sourcePath])
}

/** Official in-process DSH Agent adapter with explicit teardown ownership. */
export class DshAgentRuntimePort implements DshRuntimePort {
  readonly sessionId: string

  private readonly agent: Agent
  private readonly subscribers = new Set<WakeQueue>()
  private readonly stopListeners: Array<() => void>
  private readonly sourceId: string
  private readonly createdAt = Date.now()
  private lastStatus: 'idle' | 'running'
  private latestStatusEvent: RuntimeDshEnvelope | undefined
  private ordinal = 0
  private disposedEvent: RuntimeDshEnvelope | undefined
  private closing = false
  private disposePromise: Promise<void> | undefined
  private listenersStopped = false

  constructor(
    ctx: Context,
    private readonly sessions: SessionStore,
    private readonly lease: DshAgentRuntimeLease,
    sourceId = `live-${randomUUID()}`,
    stopPresetProfileIsolation?: () => void,
  ) {
    this.agent = lease.ownership === 'owned' ? lease.handle.agent : lease.agent
    this.sessionId = this.agent.session.id
    this.sourceId = sourceId
    this.lastStatus = this.agent.status
    const stopListeners: Array<() => void> = []
    try {
      stopListeners.push(ctx.on('session/event', (session) => {
        if (session !== this.agent.session) return
        this.wakeSubscribers()
      }))
      stopListeners.push(ctx.on('agent/status', ({ agent, status }) => {
        if (agent !== this.agent) return
        if (this.disposedEvent !== undefined) return
        this.lastStatus = status
        this.ordinal += 1
        this.latestStatusEvent = {
          plane: 'runtime',
          sessionId: this.sessionId,
          sourceId: this.sourceId,
          ordinal: this.ordinal,
          time: Date.now(),
          type: 'agent/status',
          data: { status },
        }
        this.wakeSubscribers()
      }))
      stopListeners.push(ctx.on('agent/disposed', ({ agent }) => {
        if (agent !== this.agent) return
        this.ordinal += 1
        const event: RuntimeDshEnvelope = {
          plane: 'runtime',
          sessionId: this.sessionId,
          sourceId: this.sourceId,
          ordinal: this.ordinal,
          time: Date.now(),
          type: 'agent/disposed',
          data: {},
        }
        this.disposedEvent = event
        this.wakeSubscribers()
        for (const queue of this.subscribers) queue.close()
        this.stopObserving()
      }))
      if (stopPresetProfileIsolation !== undefined) {
        stopListeners.push(stopPresetProfileIsolation)
      }
    } catch (error: unknown) {
      for (const stop of stopListeners.reverse()) stop()
      throw error
    }
    this.stopListeners = stopListeners
  }

  async *events(options: RuntimeEventOptions = {}): AsyncIterable<DshEventDelivery> {
    if (this.closing || options.signal?.aborted === true) return

    const queue = new WakeQueue()
    const signal = options.signal
    const shouldStop = () => this.closing || signal?.aborted === true
    const onAbort = () => { queue.close() }
    this.subscribers.add(queue)
    signal?.addEventListener('abort', onAbort, { once: true })
    let lastSeq = options.afterSeq ?? -1
    let lastRuntimeOrdinal = this.latestStatusEvent?.ordinal ?? 0
    let caughtUp = false
    const toolPresentation = new DshToolPresentationProjector(this.agent.ctx, this.agent)

    try {
      const created: RuntimeDshEnvelope = {
        plane: 'runtime',
        sessionId: this.sessionId,
        sourceId: this.sourceId,
        ordinal: 0,
        time: this.createdAt,
        type: 'agent/created',
        data: { status: this.lastStatus },
      }
      yield createDshEventDelivery(created)

      while (true) {
        if (shouldStop()) return
        const snapshot = this.agent.session.events
        for (let index = Math.max(0, lastSeq + 1); index < snapshot.length; index += 1) {
          if (shouldStop()) return
          const event = snapshot[index]!
          lastSeq = event.seq
          yield createDshEventDelivery(
            convertSessionEvent(this.sessionId, event),
            toolPresentation.project(event),
          )
        }

        const status = this.latestStatusEvent
        if (status !== undefined && status.ordinal > lastRuntimeOrdinal) {
          lastRuntimeOrdinal = status.ordinal
          yield createDshEventDelivery(status)
          continue
        }

        const disposed = this.disposedEvent
        if (disposed !== undefined && disposed.ordinal > lastRuntimeOrdinal) {
          lastRuntimeOrdinal = disposed.ordinal
          yield createDshEventDelivery(disposed)
          if (shouldStop()) return
          options.onCaughtUp?.({
            lastSeq: snapshot.at(-1)?.seq ?? -1,
            status: 'disposed',
          })
          return
        }

        if (!caughtUp && queue.pendingCount !== 0) {
          await queue.next()
          continue
        }

        if (!caughtUp) {
          if (shouldStop()) return
          caughtUp = true
          options.onCaughtUp?.({
            lastSeq: snapshot.at(-1)?.seq ?? -1,
            status: this.lastStatus,
          })
        }

        const next = await queue.next()
        if (next.done) return
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.subscribers.delete(queue)
      queue.close()
    }
  }

  async submit(input: SubmitInput, delivery: Delivery): Promise<SubmitResult> {
    this.ensureAvailable()
    const message = createUserMessage({
      content: [{ type: 'text', text: input.text }],
      source: { kind: 'user' },
    })
    if (delivery === 'followup') this.agent.followup(message)
    else this.agent.steer(message)
    return { inputId: message.id }
  }

  cancel(cause: CancelCause, options?: { readonly keepInbox?: boolean }): void {
    this.ensureAvailable()
    this.agent.cancel(cause, options)
  }

  whenIdle(): Promise<void> {
    this.ensureAvailable()
    return this.agent.whenIdle()
  }

  async flush(): Promise<void> {
    this.ensureAvailable()
    await this.sessions.flush(this.agent.session)
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.closing = true
    this.disposePromise = (async () => {
      try {
        if (this.lease.ownership === 'owned') await this.lease.handle.dispose()
      } finally {
        this.stopObserving()
        for (const queue of this.subscribers) queue.close()
        this.subscribers.clear()
      }
    })()
    return this.disposePromise
  }

  private ensureAvailable(): void {
    if (this.closing || this.disposedEvent !== undefined) {
      throw new Error('DSH runtime port is closed')
    }
  }

  private wakeSubscribers(): void {
    for (const queue of this.subscribers) queue.wake()
  }

  private stopObserving(): void {
    if (this.listenersStopped) return
    this.listenersStopped = true
    for (const stop of this.stopListeners) stop()
  }
}

/** Create or resume an official DSH Agent and retain its teardown capability. */
export async function openDshRuntimePort(
  ctx: Context,
  options: OpenDshRuntimeOptions,
): Promise<DshAgentRuntimePort> {
  await ctx.get('loader')?.await()
  if (options.mode === 'resume') {
    throw new Error(
      'DSH cold resume is blocked until exact model/preset restore for "'
      + options.sessionId
      + '" is implemented',
    )
  }
  const stopPresetProfileIsolation = installPresetProfileIsolation(ctx)
  try {
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const presets = ctx.get('agentPresets')
    if (agents === undefined || sessions === undefined || presets === undefined) {
      throw new Error('DSH Agent/Session/Preset services are unavailable')
    }
    const preset = await presets.resolve(options.agentPreset)
    if (
      options.agentPresetPlan !== undefined
      && presetSourceKey(preset) !== plannedSourceKey(options.agentPresetPlan)
    ) {
      throw new Error(
        'DSH Agent preset source changed after the startup picker observation',
      )
    }

    const selection = options.selection ?? ctx.get('agentDefaultModel')?.currentSelection()
    if (selection === undefined) throw new Error('DSH model selection is unavailable')

    const setup: AgentSetup = async (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      const mountedPreset = await presets.mount(agentCtx, preset.id)
      if (presetSourceKey(mountedPreset) !== presetSourceKey(preset)) {
        throw new Error(
          'DSH Agent preset source changed during unpublished mount',
        )
      }
      const assertPlannedPreset = (): void => {
        const actual = presets.composedPreset(agentCtx)
        if (actual !== preset.id) {
          throw new Error(
            'DSH Agent preset changed before publication: expected "'
            + preset.id
            + '", got '
            + (actual === undefined ? 'none' : '"' + actual + '"'),
          )
        }
      }
      const upstreamCommit = await options.setup?.(agentCtx)
      assertPlannedPreset()
      return {
        commit: () => {
          assertPlannedPreset()
          upstreamCommit?.commit()
          assertPlannedPreset()
        },
      }
    }
    const agentOptions = {
      provider: selection.provider,
      model: selection.model,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    }
    const shared = {
      agentOptions,
      setup,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }
    const handle = await agents.create({
      ...shared,
      sessionId: OfficialSessionId(options.sessionId ?? `session-${randomUUID()}`),
      meta: {
        cwd: options.cwd ?? process.cwd(),
        agentPreset: preset.id,
      },
    })
    try {
      return new DshAgentRuntimePort(ctx, sessions, {
        ownership: 'owned',
        handle,
      }, undefined, stopPresetProfileIsolation)
    } catch (error: unknown) {
      try {
        await handle.dispose()
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [error, disposeError],
          'DSH runtime port construction and Agent rollback failed',
        )
      }
      throw error
    }
  } catch (error: unknown) {
    stopPresetProfileIsolation()
    throw error
  }
}
