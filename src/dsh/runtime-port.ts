import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import {
  type Agent,
  type AgentHandle,
  type AgentSetup,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentRef,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  SessionId as OfficialSessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type SessionStore from '@deepseek-ai/dsh-session'
import type {
  RuntimeDshEnvelope,
} from '../runtime/events.ts'
import {
  createDshEventDelivery,
  type DshEventDelivery,
} from '../runtime/delivery.ts'
import { DshSubmitRejectedError } from '../runtime/port.ts'
import type {
  CancelCause,
  Delivery,
  DshRuntimePort,
  RuntimeEventOptions,
  SubmitInput,
  SubmitOptions,
  SubmitResult,
} from '../runtime/port.ts'
import type {
  PromptImageBytes,
  PromptImageInput,
  PromptImageMediaType,
  SessionAttachmentPort,
  SessionAttachmentSnapshot,
} from '../attachment/port.ts'
import type { AgentPresetSelectionPlan } from '../preset/catalog-port.ts'
import { WakeQueue } from '../runtime/wake-queue.ts'
import { convertSessionEvent } from './session-event-adapter.ts'
import { DshToolPresentationProjector } from './tool-presentation.ts'
import type { DshModelSelectionHub } from './model-selection.ts'
import {
  createDshRc2AgentBootstrapAttempt,
  dshRc2PresetSourceKey,
  installDshRc2ModelSelection,
  rollbackDshRc2AgentBootstrap,
  type DshRc2AgentBootstrapAttempt,
} from '../compat/dsh-rc2/agent-bootstrap.ts'
import {
  createStandaloneApplicationScopeHost,
} from '../lifecycle/application-scope-host.ts'
import type { ResourceScope } from '../lifecycle/scope-manager.ts'
import { installDshAgentGuidance } from './agent-guidance.ts'

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
      readonly mode: 'fork'
      readonly sessionId: string
      readonly parentSessionId: string
      readonly seed: readonly SessionEvent[]
      readonly cwd?: string
      readonly agentPreset: string
      readonly agentPresetPlan: AgentPresetSelectionPlan
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

const IMAGE_MEDIA_TYPES: Readonly<Record<string, PromptImageMediaType>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
})

function imageMediaType(path: string): PromptImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES[extname(path).toLowerCase()]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function plannedSourceKey(plan: AgentPresetSelectionPlan): string {
  return dshRc2PresetSourceKey({
    id: plan.id,
    trust: plan.trust,
    path: plan.sourcePath,
  })
}

/** Official in-process DSH Agent adapter with explicit teardown ownership. */
export class DshAgentRuntimePort implements DshRuntimePort, SessionAttachmentPort {
  readonly sessionId: string
  readonly ownsAgentLifecycle: boolean

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
    private readonly ctx: Context,
    private readonly sessions: SessionStore,
    private readonly lease: DshAgentRuntimeLease,
    sourceId = `live-${randomUUID()}`,
    stopPresetProfileIsolation?: () => void,
    private readonly modelHub?: DshModelSelectionHub,
  ) {
    this.agent = lease.ownership === 'owned' ? lease.handle.agent : lease.agent
    this.ownsAgentLifecycle = lease.ownership === 'owned'
    this.sessionId = this.agent.session.id
    this.sourceId = sourceId
    this.lastStatus = this.agent.status
    const stopListeners: Array<() => void> = []
    try {
      stopListeners.push(this.ctx.on('session/event', (session) => {
        if (session !== this.agent.session) return
        this.wakeSubscribers()
      }))
      stopListeners.push(this.ctx.on('agent/status', ({ agent, status }) => {
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
      stopListeners.push(this.ctx.on('agent/disposed', ({ agent }) => {
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

  async submit(
    input: SubmitInput,
    delivery: Delivery,
    options: SubmitOptions = {},
  ): Promise<SubmitResult> {
    this.ensureAvailable()
    options.signal?.throwIfAborted()
    const images = input.images ?? []
    if (images.length === 0) {
      const message = createUserMessage({
        content: [{ type: 'text', text: input.text }],
        source: { kind: 'user' },
      })
      options.signal?.throwIfAborted()
      if (delivery === 'followup') this.agent.followup(message)
      else this.agent.steer(message)
      return { inputId: message.id }
    }

    const admit = async (selection: ModelSelection): Promise<SubmitResult> => {
      options.signal?.throwIfAborted()
      const llm = this.ctx.get('llm')
      const attachments = this.ctx.get('attachments')
      if (llm === undefined || attachments === undefined) {
        throw new DshSubmitRejectedError(
          'Image attachments are unavailable in this runtime composition.',
          'ATTACHMENTS_UNAVAILABLE',
        )
      }
      let modelInfo
      try {
        modelInfo = await llm.resolveModelInfo(selection.provider, selection.model)
        options.signal?.throwIfAborted()
      } catch (error: unknown) {
        throw new DshSubmitRejectedError(
          `Could not verify image support for model "${selection.model}": ${errorMessage(error)}`,
          'MODEL_IMAGE_CAPABILITY_UNAVAILABLE',
          { cause: error },
        )
      }
      if (
        modelInfo.inputModalities === undefined
        || !modelInfo.inputModalities.includes('image')
      ) {
        throw new DshSubmitRejectedError(
          `Model "${selection.model}" does not support image input.`,
          'MODEL_DOES_NOT_SUPPORT_IMAGES',
        )
      }

      let refs: readonly ImageAttachmentRef[]
      try {
        refs = await attachments.saveImages(images.map((image): SaveImageAttachment => ({
          data: image.data,
          mediaType: image.mediaType,
          name: image.name,
        })))
        options.signal?.throwIfAborted()
      } catch (error: unknown) {
        throw new DshSubmitRejectedError(
          error instanceof AttachmentError ? error.message : `Image admission failed: ${errorMessage(error)}`,
          error instanceof AttachmentError ? error.code : 'IMAGE_ADMISSION_FAILED',
          { cause: error },
        )
      }
      const content: ContentBlock[] = [
        ...(input.text === '' ? [] : [{ type: 'text' as const, text: input.text }]),
        ...refs.map(attachment => ({ type: 'image' as const, attachment })),
      ]
      const message = createUserMessage({ content, source: { kind: 'user' } })
      options.signal?.throwIfAborted()
      if (delivery === 'followup') this.agent.followup(message)
      else this.agent.steer(message)
      return { inputId: message.id }
    }

    try {
      return this.modelHub === undefined
        ? await admit(this.currentModelSelection())
        : await this.modelHub.withStableModelSelection(this.agent, admit)
    } catch (error: unknown) {
      if (error instanceof DshSubmitRejectedError) throw error
      throw new DshSubmitRejectedError(
        `Image prompt was not sent: ${errorMessage(error)}`,
        'IMAGE_PROMPT_REJECTED',
        { cause: error },
      )
    }
  }

  attachmentSnapshot(): SessionAttachmentSnapshot {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) return { available: false }
    const limits = attachments.imageLimits
    return {
      available: true,
      maxImageBytes: limits.maxImageBytes,
      maxImagesPerMessage: limits.maxImagesPerMessage,
      maxMessageImageBytes: limits.maxMessageImageBytes,
      mediaTypes: [...limits.mediaTypes],
    }
  }

  async prepareImage(path: string, signal?: AbortSignal): Promise<PromptImageInput> {
    this.ensureAvailable()
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) throw new Error('Image attachments are unavailable')
    const requested = path.trim()
    if (requested === '') throw new Error('Image path is empty')
    const mediaType = imageMediaType(requested)
    if (mediaType === undefined) {
      throw new Error('Only PNG, JPEG, WebP, and GIF images are supported')
    }
    if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
      throw new Error(`Image type ${mediaType} is not accepted by this deployment`)
    }
    const cwd = this.agent.session.header.cwd ?? process.cwd()
    const absolute = isAbsolute(requested) ? requested : resolve(cwd, requested)
    signal?.throwIfAborted()
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error('Image path does not name a regular file')
    if (info.size > attachments.imageLimits.maxImageBytes) {
      throw new Error('Image exceeds the configured per-image byte limit')
    }
    const data = new Uint8Array(await readFile(absolute, { signal }))
    return this.prepareImageBytes({
      name: basename(absolute),
      mediaType,
      data,
    }, signal)
  }

  async prepareImageBytes(input: PromptImageBytes, signal?: AbortSignal): Promise<PromptImageInput> {
    this.ensureAvailable()
    signal?.throwIfAborted()
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) throw new Error('Image attachments are unavailable')
    if (!(input.data instanceof Uint8Array)) throw new Error('Image data must be bytes')
    if (input.data.byteLength === 0) throw new Error('Image data is empty')
    if (!Object.values(IMAGE_MEDIA_TYPES).includes(input.mediaType)) {
      throw new Error('Only PNG, JPEG, WebP, and GIF images are supported')
    }
    if (!attachments.imageLimits.mediaTypes.includes(input.mediaType)) {
      throw new Error(`Image type ${input.mediaType} is not accepted by this deployment`)
    }
    if (input.data.byteLength > attachments.imageLimits.maxImageBytes) {
      throw new Error('Image exceeds the configured per-image byte limit')
    }
    const data = new Uint8Array(input.data)
    const image: PromptImageInput = {
      name: input.name,
      mediaType: input.mediaType,
      bytes: data.byteLength,
      data,
    }
    await attachments.validateImage(image)
    signal?.throwIfAborted()
    return Object.freeze(image)
  }

  private currentModelSelection(): ModelSelection {
    const config = this.agent.session.requestHeader()?.config
    if (config !== undefined) {
      return {
        provider: config.provider,
        model: config.model,
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: config.reasoningEffort }),
      }
    }
    const options = this.agent.options as Partial<ModelSelection>
    if (options.provider !== undefined && options.model !== undefined) {
      return {
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.reasoningEffort }),
      }
    }
    const fallback = this.ctx.get('agentDefaultModel')?.currentSelection()
    if (fallback !== undefined) return fallback
    throw new Error('Current model selection is unavailable')
  }

  cancel(cause: CancelCause, options?: { readonly keepInbox?: boolean }): void {
    this.ensureAvailable()
    if (!this.ownsAgentLifecycle) {
      throw new Error('DSH borrowed runtime cannot cancel an Agent owned by another Host')
    }
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
  modelHub?: DshModelSelectionHub,
  runtimeSessionScope?: ResourceScope,
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
  const targetSessionId = options.sessionId ?? `session-${randomUUID()}`
  const standaloneScopes = runtimeSessionScope === undefined
    ? createStandaloneApplicationScopeHost('dsh-runtime-port-standalone')
    : undefined
  const bootstrapScope = runtimeSessionScope
    ?? standaloneScopes!.createRuntimeSessionScope(`dsh:${targetSessionId}`)
  let bootstrap: DshRc2AgentBootstrapAttempt<Context> | undefined
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
      && dshRc2PresetSourceKey(preset) !== plannedSourceKey(options.agentPresetPlan)
    ) {
      throw new Error(
        'DSH Agent preset source changed after the startup picker observation',
      )
    }

    const selection = options.selection ?? ctx.get('agentDefaultModel')?.currentSelection()
    if (selection === undefined) throw new Error('DSH model selection is unavailable')

    const assertPlannedPreset = (agentCtx: Context): void => {
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
    bootstrap = createDshRc2AgentBootstrapAttempt(
      bootstrapScope,
      {
        installModel: (agentCtx) => {
          if (modelHub === undefined) {
            return installDshRc2ModelSelection(agentCtx, selection)
          }
          modelHub.install(agentCtx, selection)
        },
        mountPreset: async (agentCtx) => {
          const mountedPreset = await presets.mount(agentCtx, preset.id)
          if (dshRc2PresetSourceKey(mountedPreset) !== dshRc2PresetSourceKey(preset)) {
            throw new Error('DSH Agent preset source changed during unpublished mount')
          }
        },
        installGuidance: installDshAgentGuidance,
        setupDownstream: agentCtx => options.setup?.(agentCtx),
        afterPrepare: assertPlannedPreset,
        beforeCommit: assertPlannedPreset,
        afterCommit: assertPlannedPreset,
      },
    )
    const setup: AgentSetup = agentCtx => bootstrap!.setup(agentCtx)
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
    const meta = options.mode === 'fork'
      ? {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          parentSession: OfficialSessionId(options.parentSessionId),
          seedLength: options.seed.length,
          agentPreset: preset.id,
        }
      : {
          cwd: options.cwd ?? process.cwd(),
          agentPreset: preset.id,
        }
    const createdHandle = await agents.create({
      ...shared,
      sessionId: OfficialSessionId(targetSessionId),
      meta,
      ...(options.mode === 'fork' ? { seed: options.seed } : {}),
    })
    let handle: AgentHandle
    try {
      handle = bootstrap.ownHandle(
        createdHandle,
        standaloneScopes === undefined
          ? undefined
          : () => standaloneScopes.dispose('DSH runtime port disposed'),
      )
    } catch (error: unknown) {
      try {
        await createdHandle.dispose()
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [error, disposeError],
          'DSH runtime Agent handle adoption and disposal failed',
        )
      }
      throw error
    }
    try {
      return new DshAgentRuntimePort(ctx, sessions, {
        ownership: 'owned',
        handle,
      }, undefined, stopPresetProfileIsolation, modelHub)
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
    let failure = error
    if (bootstrap !== undefined) {
      try {
        await rollbackDshRc2AgentBootstrap(
          error,
          bootstrap,
          'DSH runtime Agent bootstrap and rollback failed',
        )
      } catch (rollbackError: unknown) {
        failure = rollbackError
      }
    }
    if (standaloneScopes !== undefined) {
      try {
        await standaloneScopes.dispose('DSH runtime port open failed')
      } catch (scopeError: unknown) {
        failure = new AggregateError(
          [failure, scopeError],
          'DSH runtime Agent bootstrap and scope rollback failed',
        )
      }
    }
    stopPresetProfileIsolation()
    throw failure
  }
}
