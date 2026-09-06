import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Agent,
  AgentHandle,
  AgentSetupCommit,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type SessionStore from '@deepseek-ai/dsh-session'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { CallId, createToolResultMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  DshAgentRuntimePort,
  DshSubmitRejectedError,
  openDshRuntimePort,
  type DshTuiEvent,
} from '../src/internal.ts'
import type { DshEventDelivery } from '../src/runtime/delivery.ts'
import type { DshModelSelectionHub } from '../src/dsh/model-selection.ts'

interface Bench {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly handle: AgentHandle
  readonly sessions: SessionStore
  readonly port: DshAgentRuntimePort
  readonly followups: unknown[]
  readonly steers: unknown[]
  readonly cancel: ReturnType<typeof vi.fn>
  readonly idle: ReturnType<typeof vi.fn>
  readonly flush: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
}

const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    recursive: true,
    force: true,
  })))
})

function createBench(
  id = 'session-a',
  ownership: 'owned' | 'borrowed' = 'owned',
  options: {
    readonly cwd?: string
    readonly modelHub?: DshModelSelectionHub
  } = {},
): Bench {
  const ctx = new Context()
  contexts.push(ctx)
  const sessionId = SessionId(id)
  const initial = Session.create(sessionId)
  const session = options.cwd === undefined
    ? initial
    : Session.create(sessionId, undefined, { ...initial.header, cwd: options.cwd })
  const followups: unknown[] = []
  const steers: unknown[] = []
  const cancel = vi.fn()
  const idle = vi.fn(() => Promise.resolve())
  const flush = vi.fn(() => Promise.resolve(true))
  const dispose = vi.fn(() => Promise.resolve())
  const agent = {
    id: session.id,
    options: {},
    session,
    inbox: {},
    status: 'idle',
    ctx,
    cancel,
    whenIdle: idle,
    runMaintenance: () => Promise.reject(new Error('not used')),
    send: () => {},
    followup: (message: unknown) => { followups.push(message) },
    steer: (message: unknown) => { steers.push(message) },
    inject: () => {},
  } as unknown as Agent
  const handle = { agent, dispose } as AgentHandle
  const sessions = { flush } as unknown as SessionStore
  const lease = ownership === 'owned'
    ? { ownership: 'owned' as const, handle }
    : { ownership: 'borrowed' as const, agent }
  const port = new DshAgentRuntimePort(
    ctx,
    sessions,
    lease,
    'live-test',
    undefined,
    options.modelHub,
  )
  return {
    ctx,
    session,
    agent,
    handle,
    sessions,
    port,
    followups,
    steers,
    cancel,
    idle,
    flush,
    dispose,
  }
}

function runtimeListenerCount(ctx: Context): number {
  const labels = new Set([
    'ctx.on("session/event")',
    'ctx.on("agent/status")',
    'ctx.on("agent/disposed")',
  ])
  return ctx.fiber.getEffects().filter(effect => labels.has(effect.label)).length
}

function toolChangeListenerCount(ctx: Context): number {
  return ctx.fiber.getEffects().filter(
    effect => effect.label === 'ctx.on("tools/change")',
  ).length
}

async function nextEvent(
  iterator: AsyncIterator<DshTuiEvent>,
): Promise<DshTuiEvent> {
  const result = await iterator.next()
  if (result.done) throw new Error('expected an event')
  return result.value
}

function provideEmptyToolRuntime(ctx: Context): void {
  ctx.provide('tools', { schemas: () => [] } as never)
}

async function provideOfficialToolRuntime(
  ctx: Context,
  mode: 'native' | 'code' | 'both' = 'native',
): Promise<void> {
  ctx.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
  } as never)
  await ctx.plugin(ToolRuntime, { mode })
}

function globalTool(name: string) {
  return defineContentToolFixture({
    name,
    description: `test tool ${name}`,
    parameters: {},
    async execute() { return [] },
  })
}

const IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 16,
  maxImagesPerMessage: 3,
  maxMessageImageBytes: 32,
  maxImagePixels: 1_000_000,
  maxImageDimension: 2_000,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg'] as const),
})

function provideImageServices(bench: Bench) {
  const state: {
    modelInfo: {
      readonly provider: string
      readonly id: string
      readonly name: string
      readonly inputModalities?: readonly ('text' | 'image')[]
    }
    resolveError?: unknown
    saveError?: unknown
    validateError?: unknown
  } = {
    modelInfo: {
      provider: 'route',
      id: 'vision',
      name: 'Vision',
      inputModalities: ['text', 'image'],
    },
  }
  const validateImage = vi.fn(async () => {
    if (state.validateError !== undefined) throw state.validateError
  })
  const saveImages = vi.fn(async (images: readonly {
    readonly data: Uint8Array
    readonly mediaType: 'image/png' | 'image/jpeg'
    readonly name?: string
  }[]) => {
    if (state.saveError !== undefined) throw state.saveError
    return images.map((image, index) => ({
      attachmentId: `attachment-${index + 1}`,
      mediaType: image.mediaType,
      bytes: image.data.byteLength,
      width: 1,
      height: 1,
      ...(image.name === undefined ? {} : { name: image.name }),
    }))
  })
  const resolveModelInfo = vi.fn(async () => {
    if (state.resolveError !== undefined) throw state.resolveError
    return state.modelInfo
  })
  bench.ctx.provide('attachments', {
    imageLimits: IMAGE_LIMITS,
    validateImage,
    saveImages,
  } as never)
  bench.ctx.provide('llm', { resolveModelInfo } as never)
  return { state, validateImage, saveImages, resolveModelInfo }
}

describe('DshAgentRuntimePort', () => {
  it('prepares clipboard image bytes with the official validator without saving a file', async () => {
    const bench = createBench('clipboard-image')
    const services = provideImageServices(bench)
    const source = new Uint8Array([1, 2, 3])
    const image = await bench.port.prepareImageBytes({
      name: 'clipboard.png', mediaType: 'image/png', data: source,
    })
    expect(image).toEqual({ name: 'clipboard.png', mediaType: 'image/png', data: source, bytes: 3 })
    expect(image.data).not.toBe(source)
    expect(Object.isFrozen(image)).toBe(true)
    expect(services.validateImage).toHaveBeenCalledExactlyOnceWith(image)
    expect(services.saveImages).not.toHaveBeenCalled()
    source[0] = 99
    expect(image.data[0]).toBe(1)
  })

  it('rejects invalid clipboard bytes, official validation failures, and cancelled preparation', async () => {
    const bench = createBench('clipboard-invalid')
    const input = { name: 'clipboard.png', mediaType: 'image/png' as const, data: new Uint8Array([1]) }
    await expect(bench.port.prepareImageBytes(input)).rejects.toThrow('Image attachments are unavailable')
    const services = provideImageServices(bench)
    await expect(bench.port.prepareImageBytes({ ...input, data: [] as unknown as Uint8Array }))
      .rejects.toThrow('Image data must be bytes')
    await expect(bench.port.prepareImageBytes({ ...input, data: new Uint8Array() }))
      .rejects.toThrow('Image data is empty')
    await expect(bench.port.prepareImageBytes({ ...input, mediaType: 'image/svg+xml' as never }))
      .rejects.toThrow('Only PNG, JPEG, WebP, and GIF images are supported')
    await expect(bench.port.prepareImageBytes({ ...input, mediaType: 'image/gif' }))
      .rejects.toThrow('Image type image/gif is not accepted by this deployment')
    await expect(bench.port.prepareImageBytes({ ...input, data: new Uint8Array(17) }))
      .rejects.toThrow('per-image byte limit')
    expect(services.validateImage).not.toHaveBeenCalled()
    services.state.validateError = new AttachmentError('pixels invalid', 'INVALID_IMAGE')
    await expect(bench.port.prepareImageBytes(input)).rejects.toThrow('pixels invalid')
    services.state.validateError = undefined
    const abort = new AbortController()
    services.validateImage.mockImplementationOnce(async () => { abort.abort(new Error('session changed')) })
    await expect(bench.port.prepareImageBytes(input, abort.signal)).rejects.toThrow('session changed')
    await expect(bench.port.prepareImageBytes(input, abort.signal)).rejects.toThrow('session changed')
    expect(services.saveImages).not.toHaveBeenCalled()
  })

  it('keeps official model admission authoritative for prepared clipboard images', async () => {
    const bench = createBench('clipboard-text-only-model')
    const services = provideImageServices(bench)
    bench.ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'vision' }),
    } as never)
    services.state.modelInfo = { provider: 'route', id: 'vision', name: 'Text', inputModalities: ['text'] }
    const image = await bench.port.prepareImageBytes({
      name: 'clipboard.png', mediaType: 'image/png', data: new Uint8Array([1]),
    })
    await expect(bench.port.submit({ text: 'inspect', images: [image] }, 'followup'))
      .rejects.toMatchObject({ code: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
    expect(services.saveImages).not.toHaveBeenCalled()
    expect(bench.followups).toEqual([])
  })

  it('delivers exact-scope Tool presentation beside durable events', async () => {
    const bench = createBench()
    const presentCall = vi.fn(() => ({
      card: 'generic' as const,
      title: 'Read a.ts',
      kind: 'read' as const,
    }))
    const presentResult = vi.fn(() => ({
      card: 'read' as const,
      path: 'a.ts',
      offset: 1,
      lines: [{ number: 1, text: 'hello' }],
      totalLines: 1,
    }))
    const get = vi.fn(() => ({ presentCall, presentResult }))
    bench.ctx.provide('tools', { get } as never)

    const callId = CallId('call-rich')
    const call = bench.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: 'read',
      arguments: '{"path":"a.ts"}',
    })
    const message = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    })
    const result = bench.session.append('tool/result', {
      turn: 1,
      step: 1,
      message,
      meta: { path: 'a.ts' },
    }, { surfaceOp: 'append' })

    const iterator = bench.port.events()[Symbol.asyncIterator]()
    await nextEvent(iterator)
    const callDelivery = (await iterator.next()).value as DshEventDelivery
    const resultDelivery = (await iterator.next()).value as DshEventDelivery
    expect(callDelivery.event).toMatchObject({ seq: call.seq, type: 'tool/call' })
    expect(callDelivery.toolPresentation).toMatchObject({
      for: 'call',
      view: { phase: 'call', card: 'generic', title: 'Read a.ts' },
    })
    expect(resultDelivery.event).toMatchObject({ seq: result.seq, type: 'tool/result' })
    expect(resultDelivery.toolPresentation).toMatchObject({
      for: 'result',
      view: { phase: 'result', card: 'read', path: 'a.ts' },
    })
    expect(get).toHaveBeenNthCalledWith(1, 'read', bench.agent)
    expect(get).toHaveBeenNthCalledWith(2, 'read', bench.agent)

    const reconnect = bench.port.events({ afterSeq: call.seq })[Symbol.asyncIterator]()
    await nextEvent(reconnect)
    const detachedResult = (await reconnect.next()).value as DshEventDelivery
    expect(detachedResult.event).toMatchObject({ seq: result.seq, type: 'tool/result' })
    expect(detachedResult.toolPresentation).toEqual({ for: 'result', view: null })
    await iterator.return?.()
    await reconnect.return?.()
  })

  it('routes input and lifecycle calls to the owned official AgentHandle', async () => {
    const bench = createBench()

    const followup = await bench.port.submit({ text: 'next' }, 'followup')
    const steer = await bench.port.submit({ text: 'now' }, 'steer')
    expect(followup.inputId).toEqual(expect.any(String))
    expect(steer.inputId).toEqual(expect.any(String))
    expect(followup.inputId).not.toBe(steer.inputId)
    expect(bench.followups).toEqual([
      expect.objectContaining({ role: 'user', source: { kind: 'user' } }),
    ])
    expect(bench.steers).toEqual([
      expect.objectContaining({ role: 'user', source: { kind: 'user' } }),
    ])

    bench.port.cancel({ kind: 'hook', reason: 'policy' }, { keepInbox: true })
    expect(bench.cancel).toHaveBeenCalledWith(
      { kind: 'hook', reason: 'policy' },
      { keepInbox: true },
    )
    await bench.port.whenIdle()
    await bench.port.flush()
    expect(bench.idle).toHaveBeenCalledOnce()
    expect(bench.flush).toHaveBeenCalledWith(bench.session)

    const first = bench.port.dispose()
    const second = bench.port.dispose()
    expect(second).toBe(first)
    await first
    expect(bench.dispose).toHaveBeenCalledOnce()
    await expect(bench.port.submit({ text: 'late' }, 'followup')).rejects.toThrow('closed')
    expect(() => bench.port.cancel({ kind: 'user' })).toThrow('closed')
    expect(() => bench.port.whenIdle()).toThrow('closed')
    await expect(bench.port.flush()).rejects.toThrow('closed')
  })

  it('rejects a pre-aborted prompt before it reaches the Agent inbox', async () => {
    const bench = createBench()
    const abort = new AbortController()
    abort.abort(new Error('cancel before enqueue'))

    await expect(bench.port.submit(
      { text: 'must not be sent' },
      'followup',
      { signal: abort.signal },
    )).rejects.toThrow('cancel before enqueue')
    expect(bench.followups).toEqual([])
    expect(bench.steers).toEqual([])
  })

  it('prepares local images and commits durable image references before user messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-image-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'panel.png'), new Uint8Array([1, 2, 3, 4]))
    const bench = createBench('image-submit', 'owned', { cwd: directory })
    expect(bench.port.attachmentSnapshot()).toEqual({ available: false })
    bench.ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'vision' }),
    } as never)
    const services = provideImageServices(bench)

    expect(bench.port.attachmentSnapshot()).toEqual({
      available: true,
      maxImageBytes: 16,
      maxImagesPerMessage: 3,
      maxMessageImageBytes: 32,
      mediaTypes: ['image/png', 'image/jpeg'],
    })
    const relative = await bench.port.prepareImage('panel.png')
    const absolute = await bench.port.prepareImage(join(directory, 'panel.png'))
    expect(relative).toEqual({
      name: 'panel.png',
      mediaType: 'image/png',
      bytes: 4,
      data: new Uint8Array([1, 2, 3, 4]),
    })
    expect(Object.isFrozen(relative)).toBe(true)
    expect(absolute).toEqual(relative)
    expect(services.validateImage).toHaveBeenCalledTimes(2)

    const noCwd = createBench('image-submit-no-cwd')
    noCwd.ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'vision' }),
    } as never)
    const noCwdServices = provideImageServices(noCwd)
    await expect(noCwd.port.prepareImage(join(directory, 'panel.png'))).resolves.toMatchObject({
      name: 'panel.png',
      mediaType: 'image/png',
      bytes: 4,
    })
    expect(noCwdServices.validateImage).toHaveBeenCalledOnce()

    await bench.port.submit({ text: 'inspect this', images: [relative] }, 'followup')
    await bench.port.submit({ text: '', images: [absolute] }, 'steer')

    expect(services.resolveModelInfo).toHaveBeenCalledTimes(2)
    expect(services.resolveModelInfo).toHaveBeenCalledWith('route', 'vision')
    expect(services.saveImages).toHaveBeenCalledTimes(2)
    expect(bench.followups[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'inspect this' }, {
        type: 'image',
        attachment: {
          attachmentId: 'attachment-1',
          mediaType: 'image/png',
          name: 'panel.png',
        },
      }],
      source: { kind: 'user' },
    })
    expect(bench.steers[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'attachment-1' } }],
    })
    expect(JSON.stringify(bench.followups[0])).not.toContain(directory)
  })

  it('contains caller-correctable image preparation and admission failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-image-errors-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'small.png'), new Uint8Array([1, 2, 3]))
    await writeFile(join(directory, 'large.png'), new Uint8Array(17))
    await writeFile(join(directory, 'note.txt'), 'not an image')
    await mkdir(join(directory, 'folder.png'))
    const bench = createBench('image-errors', 'owned', { cwd: directory })

    await expect(bench.port.prepareImage('small.png')).rejects.toThrow(
      'Image attachments are unavailable',
    )
    bench.ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'vision' }),
    } as never)
    const services = provideImageServices(bench)
    await expect(bench.port.prepareImage('')).rejects.toThrow('Image path is empty')
    await expect(bench.port.prepareImage('note.txt')).rejects.toThrow(
      'Only PNG, JPEG, WebP, and GIF images are supported',
    )
    await expect(bench.port.prepareImage('small.gif')).rejects.toThrow(
      'Image type image/gif is not accepted by this deployment',
    )
    await expect(bench.port.prepareImage('folder.png')).rejects.toThrow(
      'does not name a regular file',
    )
    await expect(bench.port.prepareImage('large.png')).rejects.toThrow(
      'per-image byte limit',
    )
    const cancelled = new AbortController()
    cancelled.abort(new Error('attachment cancelled'))
    await expect(bench.port.prepareImage('small.png', cancelled.signal)).rejects.toThrow(
      'attachment cancelled',
    )
    services.state.validateError = new AttachmentError('pixels invalid', 'INVALID_IMAGE')
    await expect(bench.port.prepareImage('small.png')).rejects.toThrow('pixels invalid')
    services.state.validateError = undefined

    services.state.resolveError = 'catalog unavailable'
    await expect(bench.port.submit({ text: 'x', images: [{
      name: 'small.png', mediaType: 'image/png', bytes: 3, data: new Uint8Array([1, 2, 3]),
    }] }, 'followup')).rejects.toMatchObject({
      name: 'DshSubmitRejectedError',
      code: 'MODEL_IMAGE_CAPABILITY_UNAVAILABLE',
    })
    services.state.resolveError = undefined
    services.state.modelInfo = {
      provider: 'route', id: 'vision', name: 'Text only', inputModalities: ['text'],
    }
    await expect(bench.port.submit({ text: 'x', images: [{
      name: 'small.png', mediaType: 'image/png', bytes: 3, data: new Uint8Array([1, 2, 3]),
    }] }, 'followup')).rejects.toMatchObject({ code: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
    services.state.modelInfo = { provider: 'route', id: 'vision', name: 'Unspecified' }
    await expect(bench.port.submit({ text: 'x', images: [{
      name: 'small.png', mediaType: 'image/png', bytes: 3, data: new Uint8Array([1, 2, 3]),
    }] }, 'followup')).rejects.toMatchObject({ code: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
    services.state.modelInfo = {
      provider: 'route', id: 'vision', name: 'Vision', inputModalities: ['text', 'image'],
    }
    services.state.saveError = new AttachmentError('batch too large', 'IMAGES_TOO_LARGE')
    await expect(bench.port.submit({ text: 'x', images: [{
      name: 'small.png', mediaType: 'image/png', bytes: 3, data: new Uint8Array([1, 2, 3]),
    }] }, 'followup')).rejects.toMatchObject({ code: 'IMAGES_TOO_LARGE' })
    services.state.saveError = new Error('disk offline')
    await expect(bench.port.submit({ text: 'x', images: [{
      name: 'small.png', mediaType: 'image/png', bytes: 3, data: new Uint8Array([1, 2, 3]),
    }] }, 'followup')).rejects.toMatchObject({ code: 'IMAGE_ADMISSION_FAILED' })
    expect(bench.followups).toEqual([])
  })

  it('uses the exact-Agent model critical section and contains missing runtime composition', async () => {
    const withStableModelSelection = vi.fn(async (
      _agent: Agent,
      operation: (selection: { provider: string; model: string }) => Promise<unknown>,
    ) => operation({ provider: 'route', model: 'hub-vision' }))
    const bench = createBench('image-model-hub', 'owned', {
      modelHub: { withStableModelSelection } as unknown as DshModelSelectionHub,
    })
    const services = provideImageServices(bench)
    const image = {
      name: 'hub.png', mediaType: 'image/png' as const, bytes: 1, data: new Uint8Array([1]),
    }

    await bench.port.submit({ text: 'hub', images: [image] }, 'followup')
    expect(withStableModelSelection).toHaveBeenCalledOnce()
    expect(services.resolveModelInfo).toHaveBeenCalledWith('route', 'hub-vision')

    const missing = createBench('image-missing-services')
    missing.ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'vision' }),
    } as never)
    await expect(missing.port.submit({ text: 'x', images: [image] }, 'followup'))
      .rejects.toMatchObject({ code: 'ATTACHMENTS_UNAVAILABLE' })

    const noSelection = createBench('image-missing-selection')
    provideImageServices(noSelection)
    await expect(noSelection.port.submit({ text: 'x', images: [image] }, 'followup'))
      .rejects.toMatchObject({ code: 'IMAGE_PROMPT_REJECTED' })

    const options = createBench('image-options-selection')
    Object.assign(options.agent, {
      options: { provider: 'route', model: 'options-vision', reasoningEffort: 'high' },
    })
    const optionsServices = provideImageServices(options)
    await options.port.submit({ text: 'x', images: [image] }, 'followup')
    expect(optionsServices.resolveModelInfo).toHaveBeenCalledWith('route', 'options-vision')

    const optionsWithoutEffort = createBench('image-options-selection-no-effort')
    Object.assign(optionsWithoutEffort.agent, {
      options: { provider: 'route', model: 'options-vision-no-effort' },
    })
    const optionsWithoutEffortServices = provideImageServices(optionsWithoutEffort)
    await optionsWithoutEffort.port.submit({ text: 'x', images: [image] }, 'followup')
    expect(optionsWithoutEffortServices.resolveModelInfo)
      .toHaveBeenCalledWith('route', 'options-vision-no-effort')

    const durable = createBench('image-durable-selection')
    durable.session.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'route',
          model: 'durable-vision',
          reasoningEffort: ReasoningEffortId('high'),
        },
      },
    })
    const durableServices = provideImageServices(durable)
    await durable.port.submit({ text: 'x', images: [image] }, 'followup')
    expect(durableServices.resolveModelInfo).toHaveBeenCalledWith('route', 'durable-vision')

    const durableWithoutEffort = createBench('image-durable-selection-no-effort')
    durableWithoutEffort.session.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'route',
          model: 'durable-vision-no-effort',
        },
      },
    })
    const durableWithoutEffortServices = provideImageServices(durableWithoutEffort)
    await durableWithoutEffort.port.submit({ text: 'x', images: [image] }, 'followup')
    expect(durableWithoutEffortServices.resolveModelInfo)
      .toHaveBeenCalledWith('route', 'durable-vision-no-effort')

    const failingHub = createBench('image-hub-rejection', 'owned', {
      modelHub: {
        withStableModelSelection: () => Promise.reject(new Error('selection lock closed')),
      } as unknown as DshModelSelectionHub,
    })
    await expect(failingHub.port.submit({ text: 'x', images: [image] }, 'followup'))
      .rejects.toEqual(expect.objectContaining({
        name: 'DshSubmitRejectedError',
        code: 'IMAGE_PROMPT_REJECTED',
        message: expect.stringContaining('selection lock closed'),
      }))
    expect(DshSubmitRejectedError).toBeDefined()
  })

  it('releases only TUI observation when a borrowed exact Agent is disposed', async () => {
    const bench = createBench('borrowed-session', 'borrowed')
    expect(runtimeListenerCount(bench.ctx)).toBe(3)
    expect(bench.port.ownsAgentLifecycle).toBe(false)

    await bench.port.submit({ text: 'borrowed input' }, 'followup')
    expect(() => bench.port.cancel({ kind: 'parent' })).toThrow(
      'cannot cancel an Agent owned by another Host',
    )
    await bench.port.whenIdle()
    await bench.port.flush()
    expect(bench.followups).toHaveLength(1)
    expect(bench.cancel).not.toHaveBeenCalled()
    expect(bench.idle).toHaveBeenCalledOnce()
    expect(bench.flush).toHaveBeenCalledWith(bench.session)

    const iterator = bench.port.events()[Symbol.asyncIterator]()
    await nextEvent(iterator)
    const waiting = iterator.next()
    await Promise.resolve()
    await expect(bench.port.dispose()).resolves.toBeUndefined()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })

    expect(bench.dispose).not.toHaveBeenCalled()
    expect(runtimeListenerCount(bench.ctx)).toBe(0)
    bench.ctx.emit('agent/status', { agent: bench.agent, status: 'running' })
    expect(bench.dispose).not.toHaveBeenCalled()
    await expect(bench.port.submit({ text: 'late' }, 'followup')).rejects.toThrow('closed')
  })

  it('replays afterSeq, filters foreign objects, and streams live durable/runtime events', async () => {
    const bench = createBench()
    const zero = bench.session.append('turn/start', { turn: 1 })
    const one = bench.session.append('step/start', { turn: 1, step: 1 })
    const iterator = bench.port.events({ afterSeq: 0 })[Symbol.asyncIterator]()

    expect(await nextEvent(iterator)).toMatchObject({
      plane: 'runtime',
      type: 'agent/created',
      sourceId: 'live-test',
      ordinal: 0,
      data: { status: 'idle' },
    })
    expect(await nextEvent(iterator)).toMatchObject({ plane: 'durable', seq: one.seq })

    const foreignSession = Session.create(SessionId('session-foreign'))
    const foreignEvent = foreignSession.append('turn/start', { turn: 99 })
    const two = bench.session.append('step/end', { turn: 1, step: 1 })
    const pendingDurable = iterator.next()
    bench.ctx.emit('session/event', foreignSession, foreignEvent)
    bench.ctx.emit('session/event', bench.session, two)
    await expect(pendingDurable).resolves.toMatchObject({
      done: false,
      value: { plane: 'durable', seq: two.seq, type: 'step/end' },
    })

    const foreignAgent = { ...bench.agent, id: SessionId('agent-foreign') } as Agent
    const pendingStatus = iterator.next()
    bench.ctx.emit('agent/status', { agent: foreignAgent, status: 'running' })
    bench.ctx.emit('agent/status', { agent: bench.agent, status: 'running' })
    await expect(pendingStatus).resolves.toMatchObject({
      done: false,
      value: {
        plane: 'runtime',
        type: 'agent/status',
        ordinal: 1,
        data: { status: 'running' },
      },
    })

    const pendingDone = iterator.next()
    await bench.port.dispose()
    await expect(pendingDone).resolves.toMatchObject({ done: true })
    expect(zero.seq).toBe(0)
  })

  it('subscribes before snapshot and removes snapshot/live overlap inside the stream', async () => {
    const bench = createBench()
    const iterator = bench.port.events()[Symbol.asyncIterator]()
    await nextEvent(iterator)

    const zero = bench.session.append('turn/start', { turn: 1 })
    bench.ctx.emit('session/event', bench.session, zero)
    expect(await nextEvent(iterator)).toMatchObject({ plane: 'durable', seq: 0 })

    const pending = iterator.next()
    const one = bench.session.append('step/start', { turn: 1, step: 1 })
    bench.ctx.emit('session/event', bench.session, one)
    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { plane: 'durable', seq: 1 },
    })

    await bench.port.dispose()
  })

  it('signals an empty replay boundary once before waiting for live work', async () => {
    const bench = createBench()
    const abort = new AbortController()
    const onCaughtUp = vi.fn()
    const iterator = bench.port.events({
      signal: abort.signal,
      onCaughtUp,
    })[Symbol.asyncIterator]()

    expect(await nextEvent(iterator)).toMatchObject({ type: 'agent/created' })
    const waiting = iterator.next()
    await vi.waitFor(() => {
      expect(onCaughtUp).toHaveBeenCalledExactlyOnceWith({
        lastSeq: -1,
        status: 'idle',
      })
    })

    abort.abort()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
    expect(onCaughtUp).toHaveBeenCalledTimes(1)
    await bench.port.dispose()
  })

  it('includes a live append that races the initial replay before signaling caught up', async () => {
    const bench = createBench()
    bench.session.append('turn/start', { turn: 1 })
    const abort = new AbortController()
    const onCaughtUp = vi.fn()
    const iterator = bench.port.events({
      signal: abort.signal,
      onCaughtUp,
    })[Symbol.asyncIterator]()

    await nextEvent(iterator)
    expect(await nextEvent(iterator)).toMatchObject({ plane: 'durable', seq: 0 })
    const raced = bench.session.append('step/start', { turn: 1, step: 1 })
    bench.ctx.emit('session/event', bench.session, raced)
    expect(await nextEvent(iterator)).toMatchObject({ plane: 'durable', seq: 1 })

    const waiting = iterator.next()
    await vi.waitFor(() => {
      expect(onCaughtUp).toHaveBeenCalledExactlyOnceWith({
        lastSeq: 1,
        status: 'idle',
      })
    })
    abort.abort()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
    await bench.port.dispose()
  })

  it('reconciles a status change during replay before signaling caught up', async () => {
    const bench = createBench()
    bench.session.append('turn/start', { turn: 1 })
    const abort = new AbortController()
    const onCaughtUp = vi.fn()
    const iterator = bench.port.events({
      signal: abort.signal,
      onCaughtUp,
    })[Symbol.asyncIterator]()

    await nextEvent(iterator)
    bench.ctx.emit('agent/status', { agent: bench.agent, status: 'running' })
    expect(await nextEvent(iterator)).toMatchObject({ plane: 'durable', seq: 0 })
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'agent/status',
      data: { status: 'running' },
    })

    const waiting = iterator.next()
    await vi.waitFor(() => {
      expect(onCaughtUp).toHaveBeenCalledExactlyOnceWith({
        lastSeq: 0,
        status: 'running',
      })
    })
    abort.abort()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
    await bench.port.dispose()
  })

  it('reconciles terminal disposal during replay before ending the stream', async () => {
    const bench = createBench()
    bench.session.append('turn/start', { turn: 1 })
    const onCaughtUp = vi.fn()
    const iterator = bench.port.events({ onCaughtUp })[Symbol.asyncIterator]()

    await nextEvent(iterator)
    bench.ctx.emit('agent/disposed', { agent: bench.agent })
    expect(await nextEvent(iterator)).toMatchObject({ plane: 'durable', seq: 0 })
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'agent/disposed',
      data: {},
    })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(onCaughtUp).toHaveBeenCalledExactlyOnceWith({
      lastSeq: 0,
      status: 'disposed',
    })
    await bench.port.dispose()
  })

  it('reports an empty durable tail when disposal wins the initial replay', async () => {
    const bench = createBench()
    const onCaughtUp = vi.fn()
    const iterator = bench.port.events({ onCaughtUp })[Symbol.asyncIterator]()

    await nextEvent(iterator)
    bench.ctx.emit('agent/disposed', { agent: bench.agent })
    expect(await nextEvent(iterator)).toMatchObject({ type: 'agent/disposed' })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(onCaughtUp).toHaveBeenCalledExactlyOnceWith({
      lastSeq: -1,
      status: 'disposed',
    })
    await bench.port.dispose()
  })

  it('does not signal caught up when aborted before the replay boundary', async () => {
    const bench = createBench()
    const abort = new AbortController()
    const onCaughtUp = vi.fn()
    const iterator = bench.port.events({
      signal: abort.signal,
      onCaughtUp,
    })[Symbol.asyncIterator]()

    await nextEvent(iterator)
    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(onCaughtUp).not.toHaveBeenCalled()
    await bench.port.dispose()
  })

  it('stops replay without signaling when aborted between durable events', async () => {
    const bench = createBench()
    bench.session.append('turn/start', { turn: 1 })
    bench.session.append('step/start', { turn: 1, step: 1 })
    const abort = new AbortController()
    const onCaughtUp = vi.fn()
    const iterator = bench.port.events({
      signal: abort.signal,
      onCaughtUp,
    })[Symbol.asyncIterator]()

    await nextEvent(iterator)
    expect(await nextEvent(iterator)).toMatchObject({ plane: 'durable', seq: 0 })
    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(onCaughtUp).not.toHaveBeenCalled()
    await bench.port.dispose()
  })

  it('does not signal when aborted after the final replay event but before its boundary', async () => {
    const bench = createBench()
    bench.session.append('turn/start', { turn: 1 })
    const abort = new AbortController()
    const onCaughtUp = vi.fn()
    const iterator = bench.port.events({
      signal: abort.signal,
      onCaughtUp,
    })[Symbol.asyncIterator]()

    await nextEvent(iterator)
    expect(await nextEvent(iterator)).toMatchObject({ plane: 'durable', seq: 0 })
    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(onCaughtUp).not.toHaveBeenCalled()
    await bench.port.dispose()
  })

  it('does not signal when aborted after terminal disposal is delivered', async () => {
    const bench = createBench()
    const abort = new AbortController()
    const onCaughtUp = vi.fn()
    const iterator = bench.port.events({
      signal: abort.signal,
      onCaughtUp,
    })[Symbol.asyncIterator]()

    await nextEvent(iterator)
    bench.ctx.emit('agent/disposed', { agent: bench.agent })
    expect(await nextEvent(iterator)).toMatchObject({ type: 'agent/disposed' })
    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(onCaughtUp).not.toHaveBeenCalled()
    await bench.port.dispose()
  })

  it('isolates a caught-up callback failure to its consumer', async () => {
    const bench = createBench()
    const callbackFailure = new Error('caught-up callback failed')
    const failed = bench.port.events({
      onCaughtUp: () => { throw callbackFailure },
    })[Symbol.asyncIterator]()

    await nextEvent(failed)
    await expect(failed.next()).rejects.toBe(callbackFailure)

    const abort = new AbortController()
    const onCaughtUp = vi.fn()
    const healthy = bench.port.events({
      signal: abort.signal,
      onCaughtUp,
    })[Symbol.asyncIterator]()
    await nextEvent(healthy)
    const waiting = healthy.next()
    await vi.waitFor(() => {
      expect(onCaughtUp).toHaveBeenCalledExactlyOnceWith({
        lastSeq: -1,
        status: 'idle',
      })
    })
    abort.abort()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
    await bench.port.dispose()
  })

  it('rescans every durable seq after a conflated burst wake', async () => {
    const bench = createBench()
    const iterator = bench.port.events()[Symbol.asyncIterator]()
    await nextEvent(iterator)

    const first = iterator.next()
    await Promise.resolve()
    const total = 1_024
    for (let seq = 0; seq < total; seq += 1) {
      const event = bench.session.append('turn/start', { turn: seq })
      bench.ctx.emit('session/event', bench.session, event)
    }

    const events = [await first]
    for (let index = 1; index < total; index += 1) events.push(await iterator.next())
    expect(events.every(result => !result.done)).toBe(true)
    expect(events.map(result => result.value?.seq)).toEqual(
      Array.from({ length: total }, (_, seq) => seq),
    )
    await bench.port.dispose()
  })

  it('coalesces intermediate statuses but always delivers terminal disposal', async () => {
    const bench = createBench()
    const iterator = bench.port.events()[Symbol.asyncIterator]()
    await nextEvent(iterator)

    const pending = iterator.next()
    await Promise.resolve()
    const statusCount = 100
    for (let ordinal = 1; ordinal <= statusCount; ordinal += 1) {
      bench.ctx.emit('agent/status', {
        agent: bench.agent,
        status: ordinal % 2 === 0 ? 'idle' : 'running',
      })
    }
    bench.ctx.emit('agent/disposed', { agent: bench.agent })
    bench.ctx.emit('agent/status', { agent: bench.agent, status: 'running' })

    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { type: 'agent/status', ordinal: statusCount },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'agent/disposed', ordinal: statusCount + 1 },
    })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await bench.port.dispose()
  })

  it('ignores a reentrant status after Agent disposal wins', async () => {
    const bench = createBench('disposed-status-race')
    const iterator = bench.port.events()[Symbol.asyncIterator]()
    await nextEvent(iterator)
    const subscribers = (bench.port as unknown as {
      readonly subscribers: Set<{ wake(): void }>
    }).subscribers
    const queue = [...subscribers][0]!
    const wake = queue.wake.bind(queue)
    queue.wake = () => {
      bench.ctx.emit('agent/status', { agent: bench.agent, status: 'running' })
      wake()
    }

    bench.ctx.emit('agent/disposed', { agent: bench.agent })

    expect(await nextEvent(iterator)).toMatchObject({
      type: 'agent/disposed',
      ordinal: 1,
    })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await bench.port.dispose()
  })

  it('honors AbortSignal and preserves an externally disposed lifecycle for resubscribe', async () => {
    const bench = createBench()
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const empty = bench.port.events({ signal: alreadyAborted.signal })[Symbol.asyncIterator]()
    await expect(empty.next()).resolves.toMatchObject({ done: true })

    bench.ctx.emit('agent/status', { agent: bench.agent, status: 'running' })
    const controller = new AbortController()
    const aborted = bench.port.events({ signal: controller.signal })[Symbol.asyncIterator]()
    expect(await nextEvent(aborted)).toMatchObject({
      type: 'agent/created',
      data: { status: 'running' },
    })
    const waiting = aborted.next()
    controller.abort()
    bench.ctx.emit('agent/status', { agent: bench.agent, status: 'idle' })
    await expect(waiting).resolves.toMatchObject({ done: true })

    const betweenPullsController = new AbortController()
    const betweenPulls = bench.port.events({
      signal: betweenPullsController.signal,
    })[Symbol.asyncIterator]()
    await nextEvent(betweenPulls)
    betweenPullsController.abort()
    await expect(betweenPulls.next()).resolves.toMatchObject({ done: true })

    const live = bench.port.events()[Symbol.asyncIterator]()
    await nextEvent(live)
    const foreignAgent = { ...bench.agent, id: SessionId('agent-foreign') } as Agent
    bench.ctx.emit('agent/disposed', { agent: foreignAgent })
    bench.ctx.emit('agent/disposed', { agent: bench.agent })
    expect(await nextEvent(live)).toMatchObject({
      type: 'agent/disposed',
      ordinal: 3,
    })
    await expect(live.next()).resolves.toMatchObject({ done: true })

    const replayDisposed = bench.port.events()[Symbol.asyncIterator]()
    expect(await nextEvent(replayDisposed)).toMatchObject({ type: 'agent/created' })
    expect(await nextEvent(replayDisposed)).toMatchObject({ type: 'agent/disposed' })
    await expect(replayDisposed.next()).resolves.toMatchObject({ done: true })
    await expect(bench.port.submit({ text: 'late' }, 'steer')).rejects.toThrow('closed')
    await bench.port.dispose()
  })

  it('stops snapshot replay if owned disposal starts after subscription', async () => {
    const bench = createBench()
    bench.session.append('turn/start', { turn: 1 })
    const iterator = bench.port.events()[Symbol.asyncIterator]()
    await nextEvent(iterator)

    const disposal = bench.port.dispose()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await disposal
  })
})

describe('openDshRuntimePort', () => {
  it.each(['native', 'code', 'both'] as const)(
    'keeps the global-tool gate live while any fresh port remains in %s mode',
    async (mode) => {
    const ctx = new Context()
    contexts.push(ctx)
    await provideOfficialToolRuntime(ctx, mode)
    const transportNames = mode === 'native' ? [] : ['run_code']
    const mounted = new WeakMap<Context, string>()
    const handles: AgentHandle[] = []
    let scopedChanges = 0
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agentPresets', {
      resolve: async () => {
        expect(toolChangeListenerCount(ctx)).toBe(handles.length + 1)
        await Promise.resolve()
        expect(toolChangeListenerCount(ctx)).toBe(handles.length + 1)
        return { id: 'standard' }
      },
      mount: async (agentCtx: Context) => {
        expect(toolChangeListenerCount(ctx)).toBe(handles.length + 1)
        expect(() => { ctx.emit('tools/change') }).not.toThrow()
        scopedChanges += 1
        mounted.set(agentCtx, 'standard')
        return { id: 'standard' }
      },
      composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
    } as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions): Promise<AgentHandle> => {
        const session = Session.create(options.sessionId)
        const agent = {
          id: session.id,
          options: {},
          session,
          status: 'idle',
          ctx,
          followup: () => {},
          steer: () => {},
          cancel: () => {},
          whenIdle: () => Promise.resolve(),
        } as unknown as Agent
        const agentCtx = createScope(ctx, agent).ctx.extend({ agent })
        Object.assign(agent, { ctx: agentCtx })
        const commit = await options.setup?.(agentCtx)
        commit?.commit()
        const handle = {
          agent,
          dispose: vi.fn(() => Promise.resolve()),
        } as AgentHandle
        handles.push(handle)
        return handle
      },
    } as never)

    const first = await openDshRuntimePort(ctx, {
      mode: 'create',
      sessionId: 'guarded-first',
      selection: { provider: 'test', model: 'test' },
    })
    const second = await openDshRuntimePort(ctx, {
      mode: 'create',
      sessionId: 'guarded-second',
      selection: { provider: 'test', model: 'test' },
    })
    expect(scopedChanges).toBe(2)
    expect(toolChangeListenerCount(ctx)).toBe(2)

    expect(() => { ctx.tools.register(globalTool('late-global')) })
      .toThrow(/global tools.*late-global/i)
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(transportNames)

    await first.dispose()
    await first.dispose()
    expect(toolChangeListenerCount(ctx)).toBe(1)
    expect(() => { ctx.tools.register(globalTool('still-guarded')) })
      .toThrow(/global tools.*still-guarded/i)
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(transportNames)

    ctx.emit('agent/disposed', { agent: handles[1]!.agent })
    expect(toolChangeListenerCount(ctx)).toBe(0)
    await second.dispose()
    await second.dispose()
    expect(toolChangeListenerCount(ctx)).toBe(0)
    const unregister = ctx.tools.register(globalTool('after-runtime'))
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'after-runtime',
      ...transportNames,
    ])
    unregister()
    },
  )

  it('removes the global-tool gate when Agent creation fails', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await provideOfficialToolRuntime(ctx)
    const failure = new Error('Agent create failed')
    const mounted = new WeakMap<Context, string>()
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agentPresets', {
      resolve: async () => ({ id: 'standard' }),
      mount: async (agentCtx: Context) => {
        expect(toolChangeListenerCount(ctx)).toBe(1)
        expect(() => { ctx.emit('tools/change') }).not.toThrow()
        mounted.set(agentCtx, 'standard')
        return { id: 'standard' }
      },
      composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
    } as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions): Promise<AgentHandle> => {
        const session = Session.create(options.sessionId)
        const agent = {
          id: session.id,
          options: {},
          session,
          status: 'idle',
          ctx,
        } as unknown as Agent
        const agentCtx = createScope(ctx, agent).ctx.extend({ agent })
        Object.assign(agent, { ctx: agentCtx })
        await options.setup?.(agentCtx)
        throw failure
      },
    } as never)

    await expect(openDshRuntimePort(ctx, {
      mode: 'create',
      sessionId: 'create-failure',
      selection: { provider: 'test', model: 'test' },
    })).rejects.toBe(failure)
    expect(toolChangeListenerCount(ctx)).toBe(0)
    const unregister = ctx.tools.register(globalTool('after-failure'))
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['after-failure'])
    unregister()
  })

  it('rolls back the owned Agent and partial observers when port construction fails', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await provideOfficialToolRuntime(ctx)
    const failure = new Error('runtime listener registration failed')
    const mounted = new WeakMap<Context, string>()
    const dispose = vi.fn(() => Promise.resolve())
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agentPresets', {
      resolve: async () => ({ id: 'standard' }),
      mount: async (agentCtx: Context) => {
        mounted.set(agentCtx, 'standard')
        return { id: 'standard' }
      },
      composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
    } as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions): Promise<AgentHandle> => {
        const session = Session.create(options.sessionId)
        const agent = {
          id: session.id,
          options: {},
          session,
          status: 'idle',
          ctx,
        } as unknown as Agent
        const agentCtx = createScope(ctx, agent).ctx.extend({ agent })
        Object.assign(agent, { ctx: agentCtx })
        const commit = await options.setup?.(agentCtx)
        commit?.commit()
        return { agent, dispose }
      },
    } as never)
    ctx.on('internal/listener', (name) => {
      if (name === 'agent/status') throw failure
    })

    await expect(openDshRuntimePort(ctx, {
      mode: 'create',
      sessionId: 'construction-failure',
      selection: { provider: 'test', model: 'test' },
    })).rejects.toBe(failure)
    expect(dispose).toHaveBeenCalledOnce()
    expect(runtimeListenerCount(ctx)).toBe(0)
    expect(toolChangeListenerCount(ctx)).toBe(0)

    const rollbackFailure = new Error('Agent rollback failed')
    dispose.mockRejectedValueOnce(rollbackFailure)
    let aggregate: unknown
    try {
      await openDshRuntimePort(ctx, {
        mode: 'create',
        sessionId: 'construction-and-rollback-failure',
        selection: { provider: 'test', model: 'test' },
      })
    } catch (error: unknown) {
      aggregate = error
    }
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as AggregateError).message)
      .toBe('DSH runtime port construction and Agent rollback failed')
    expect((aggregate as AggregateError).errors).toEqual([failure, rollbackFailure])
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(runtimeListenerCount(ctx)).toBe(0)
    expect(toolChangeListenerCount(ctx)).toBe(0)

    const unregister = ctx.tools.register(globalTool('after-construction-failure'))
    expect(ctx.tools.schemas().map(schema => schema.name))
      .toEqual(['after-construction-failure'])
    unregister()
  })

  it('aggregates an unpublished handle adoption failure with handle disposal failure', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await provideOfficialToolRuntime(ctx)
    const mounted = new WeakMap<Context, string>()
    const disposeFailure = new Error('unpublished handle disposal failed')
    let failHandleDisposal = false
    const dispose = vi.fn(async () => {
      if (failHandleDisposal) throw disposeFailure
    })
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agentPresets', {
      resolve: async () => ({ id: 'standard' }),
      mount: async (agentCtx: Context) => {
        mounted.set(agentCtx, 'standard')
        return { id: 'standard' }
      },
      composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
    } as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions): Promise<AgentHandle> => {
        const session = Session.create(options.sessionId)
        const agent = {
          id: session.id,
          options: {},
          session,
          status: 'idle',
          ctx,
        } as unknown as Agent
        const agentCtx = createScope(ctx, agent).ctx.extend({ agent })
        Object.assign(agent, { ctx: agentCtx })
        await options.setup?.(agentCtx)
        return { agent, dispose }
      },
    } as never)

    const adoptionFailure = await openDshRuntimePort(ctx, {
      mode: 'create',
      sessionId: 'handle-adoption-failure',
      selection: { provider: 'test', model: 'test' },
    }).catch((error: unknown) => error)
    expect(adoptionFailure).toMatchObject({
      message: expect.stringContaining('before bootstrap commit'),
    })

    failHandleDisposal = true
    const failure = await openDshRuntimePort(ctx, {
      mode: 'create',
      sessionId: 'handle-adoption-and-disposal-failure',
      selection: { provider: 'test', model: 'test' },
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({
      name: 'AggregateError',
      message: 'DSH runtime Agent handle adoption and disposal failed',
      errors: [
        expect.objectContaining({ message: expect.stringContaining('before bootstrap commit') }),
        disposeFailure,
      ],
    })
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(toolChangeListenerCount(ctx)).toBe(0)
  })

  it('mounts exact presets for create and blocks inexact cold resume', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    const loaderAwait = vi.fn(() => Promise.resolve())
    const flush = vi.fn(() => Promise.resolve(true))
    const created: CreateAgentOptions[] = []
    const metaSnapshots: Array<CreateAgentOptions['meta']> = []
    const resumed: ResumeAgentOptions[] = []
    const setupResults: Array<AgentSetupCommit | void> = []
    const unpublishedContexts: Context[] = []
    const presetCalls: string[] = []
    const mounted = new WeakMap<Context, string>()
    let inSetup = false
    const resolvePreset = vi.fn(async (id?: string) => {
      const resolved = id ?? 'standard'
      return {
        id: resolved,
        trust: 'system' as const,
        path: `D:\\presets\\${resolved}\\agent.cordis.yml`,
      }
    })
    const mountPreset = vi.fn(async (agentCtx: Context, id?: string) => {
      expect(inSetup).toBe(true)
      expect(agentCtx).not.toBe(ctx)
      const resolved = id ?? 'standard'
      presetCalls.push('mount:' + resolved)
      mounted.set(agentCtx, resolved)
      return {
        id: resolved,
        trust: 'system' as const,
        path: `D:\\presets\\${resolved}\\agent.cordis.yml`,
      }
    })
    const composedPreset = vi.fn((agentCtx: Context) => mounted.get(agentCtx))

    function handleFor(id: string): {
      readonly agentCtx: Context
      readonly handle: AgentHandle
    } {
      const session = Session.create(SessionId(id))
      const agent = {
        id: session.id,
        options: {},
        session,
        status: 'idle',
        ctx,
        followup: () => {},
        steer: () => {},
        cancel: () => {},
        whenIdle: () => Promise.resolve(),
      } as unknown as Agent
      const agentCtx = createScope(ctx, agent).ctx.extend({ agent })
      Object.assign(agent, { ctx: agentCtx })
      return {
        agentCtx,
        handle: { agent, dispose: () => Promise.resolve() },
      }
    }

    ctx.provide('loader', { await: loaderAwait } as never)
    provideEmptyToolRuntime(ctx)
    ctx.provide('sessions', { flush } as never)
    ctx.provide('agentPresets', {
      resolve: resolvePreset,
      mount: mountPreset,
      composedPreset,
    } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
    } as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions) => {
        const prepared = handleFor(options.sessionId)
        created.push(options)
        metaSnapshots.push(options.meta === undefined ? undefined : { ...options.meta })
        unpublishedContexts.push(prepared.agentCtx)
        let commit: AgentSetupCommit | void
        inSetup = true
        try {
          commit = await options.setup?.(prepared.agentCtx)
          setupResults.push(commit)
        } finally {
          inSetup = false
        }
        expect((await ctx.systemPrompt.assemble({ scope: prepared.handle.agent })).sections)
          .toContainEqual(expect.objectContaining({ name: 'dsh-tui:agent-guidance' }))
        expect((await ctx.systemPrompt.assemble()).sections)
          .not.toContainEqual(expect.objectContaining({ name: 'dsh-tui:agent-guidance' }))
        commit?.commit()
        return prepared.handle
      },
      resume: async (options: ResumeAgentOptions) => {
        resumed.push(options)
        setupResults.push(await options.setup?.(ctx))
        return handleFor(options.resumeSessionId).handle
      },
    } as never)

    const defaultPort = await openDshRuntimePort(ctx, { mode: 'create' })
    expect(loaderAwait).toHaveBeenCalledOnce()
    expect(created[0]).toMatchObject({
      sessionId: expect.stringMatching(/^session-/),
      meta: { cwd: process.cwd(), agentPreset: 'standard' },
      agentOptions: { provider: 'default-provider', model: 'default-model' },
    })
    expect(metaSnapshots[0]).toEqual({
      cwd: process.cwd(),
      agentPreset: 'standard',
    })

    const commit: AgentSetupCommit = { commit: vi.fn() }
    const signal = new AbortController().signal
    const explicitPort = await openDshRuntimePort(ctx, {
      mode: 'create',
      sessionId: 'named-session',
      cwd: 'D:\\Projects\\DSH-Project',
      agentPreset: 'minimal',
      agentPresetPlan: {
        id: 'minimal',
        trust: 'system',
        sourcePath: 'D:\\presets\\minimal\\agent.cordis.yml',
      },
      selection: { provider: 'p', model: 'm' },
      maxTokens: 2048,
      signal,
      setup: () => {
        presetCalls.push('upstream:minimal')
        return commit
      },
    })
    expect(created[1]).toMatchObject({
      sessionId: 'named-session',
      meta: {
        cwd: 'D:\\Projects\\DSH-Project',
        agentPreset: 'minimal',
      },
      agentOptions: { provider: 'p', model: 'm', maxTokens: 2048 },
      signal,
    })
    expect(metaSnapshots[1]).toEqual({
      cwd: 'D:\\Projects\\DSH-Project',
      agentPreset: 'minimal',
    })
    expect(setupResults[1]).not.toBe(commit)
    expect(setupResults[1]?.commit).toEqual(expect.any(Function))
    expect(commit.commit).toHaveBeenCalledOnce()
    expect(resolvePreset.mock.calls).toEqual([[undefined], ['minimal']])
    expect(mountPreset.mock.calls).toEqual([
      [unpublishedContexts[0], 'standard'],
      [unpublishedContexts[1], 'minimal'],
    ])
    expect(presetCalls).toEqual([
      'mount:standard',
      'mount:minimal',
      'upstream:minimal',
    ])

    const forkSource = Session.create(SessionId('fork-source'))
    forkSource.append('turn/start', { turn: 1 })
    forkSource.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const installModel = vi.fn()
    const forkPort = await openDshRuntimePort(ctx, {
      mode: 'fork',
      sessionId: 'fork-child',
      parentSessionId: forkSource.id,
      seed: forkSource.events,
      agentPreset: 'research',
      agentPresetPlan: {
        id: 'research',
        trust: 'system',
        sourcePath: 'D:\\presets\\research\\agent.cordis.yml',
      },
      selection: { provider: 'fork-provider', model: 'fork-model' },
    }, { install: installModel } as unknown as DshModelSelectionHub)
    expect(created[2]).toMatchObject({
      sessionId: 'fork-child',
      seed: forkSource.events,
      meta: {
        parentSession: 'fork-source',
        seedLength: 2,
        agentPreset: 'research',
      },
      agentOptions: { provider: 'fork-provider', model: 'fork-model' },
    })
    expect(metaSnapshots[2]).toEqual({
      parentSession: 'fork-source',
      seedLength: 2,
      agentPreset: 'research',
    })
    expect(resolvePreset.mock.calls).toEqual([[undefined], ['minimal'], ['research']])
    expect(mountPreset.mock.calls[2]).toEqual([unpublishedContexts[2], 'research'])
    expect(installModel).toHaveBeenCalledExactlyOnceWith(
      unpublishedContexts[2],
      { provider: 'fork-provider', model: 'fork-model' },
    )

    const forkWithCwdPort = await openDshRuntimePort(ctx, {
      mode: 'fork',
      sessionId: 'fork-child-with-cwd',
      parentSessionId: forkSource.id,
      seed: forkSource.events,
      cwd: 'D:\\fork-workspace',
      agentPreset: 'research',
      agentPresetPlan: {
        id: 'research',
        trust: 'system',
        sourcePath: 'D:\\presets\\research\\agent.cordis.yml',
      },
      selection: { provider: 'fork-provider', model: 'fork-model' },
    })
    expect(created[3]?.meta).toEqual({
      cwd: 'D:\\fork-workspace',
      parentSession: 'fork-source',
      seedLength: 2,
      agentPreset: 'research',
    })

    await expect(openDshRuntimePort(ctx, {
      mode: 'resume',
      sessionId: 'persisted-session',
      selection: { provider: 'p2', model: 'm2' },
    })).rejects.toThrow('cold resume is blocked until exact model/preset restore')
    expect(resumed).toEqual([])

    await Promise.all([
      defaultPort.dispose(),
      explicitPort.dispose(),
      forkPort.dispose(),
      forkWithCwdPort.dispose(),
    ])
  })

  it('rejects global tool leakage after Loader settles and before Agent creation', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const order: string[] = []
    const create = vi.fn()
    const schemas = vi.fn(() => {
      order.push('schemas')
      return [{ name: 'global-shell' }]
    })
    ctx.provide('loader', {
      await: async () => { order.push('loader') },
    } as never)
    ctx.provide('tools', { schemas } as never)
    ctx.provide('agents', { create } as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('agentPresets', {
      resolve: async () => ({ id: 'standard' }),
    } as never)

    await expect(openDshRuntimePort(ctx, {
      mode: 'create',
      selection: { provider: 'test', model: 'test' },
    })).rejects.toThrow(/global tools.*global-shell/i)
    expect(order).toEqual(['loader', 'schemas'])
    expect(schemas).toHaveBeenCalledExactlyOnceWith()
    expect(create).not.toHaveBeenCalled()
  })

  it('does not run upstream setup or publish a port when preset mount rejects', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const failure = new Error('preset mount failed')
    const upstreamSetup = vi.fn()
    let published = false
    provideEmptyToolRuntime(ctx)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test', model: 'test' }),
    } as never)
    ctx.provide('agentPresets', {
      resolve: async () => ({ id: 'standard' }),
      mount: () => Promise.reject(failure),
    } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions) => {
        await options.setup?.(ctx)
        published = true
        throw new Error('unreachable')
      },
    } as never)

    await expect(openDshRuntimePort(ctx, {
      mode: 'create',
      sessionId: 'mount-failure',
      setup: upstreamSetup,
    })).rejects.toBe(failure)
    expect(upstreamSetup).not.toHaveBeenCalled()
    expect(published).toBe(false)
  })

  it('rejects a stale picker source before allocating an Agent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const create = vi.fn()
    provideEmptyToolRuntime(ctx)
    ctx.provide('agents', { create } as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('agentPresets', {
      resolve: async () => ({
        id: 'standard',
        trust: 'user',
        path: 'D:\\user-presets\\standard\\agent.cordis.yml',
      }),
    } as never)

    await expect(openDshRuntimePort(ctx, {
      mode: 'create',
      agentPreset: 'standard',
      agentPresetPlan: {
        id: 'standard',
        trust: 'system',
        sourcePath: 'D:\\shipped-presets\\standard\\agent.cordis.yml',
      },
      selection: { provider: 'test', model: 'test' },
    })).rejects.toThrow('source changed after the startup picker observation')
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects preset source drift during unpublished mount', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const upstreamSetup = vi.fn()
    let published = false
    provideEmptyToolRuntime(ctx)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agentPresets', {
      resolve: async () => ({
        id: 'standard',
        trust: 'system',
        path: 'D:\\shipped-presets\\standard\\agent.cordis.yml',
      }),
      mount: async () => ({
        id: 'standard',
        trust: 'system',
        path: 'D:\\other-shipped-root\\standard\\agent.cordis.yml',
      }),
    } as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions) => {
        await options.setup?.(ctx)
        published = true
        throw new Error('unreachable')
      },
    } as never)

    await expect(openDshRuntimePort(ctx, {
      mode: 'create',
      sessionId: 'mount-source-drift',
      agentPreset: 'standard',
      selection: { provider: 'test', model: 'test' },
      setup: upstreamSetup,
    })).rejects.toThrow('source changed during unpublished mount')
    expect(upstreamSetup).not.toHaveBeenCalled()
    expect(published).toBe(false)
  })

  it.each([
    {
      caseName: 'setup to another preset',
      phase: 'setup',
      driftTo: 'minimal',
      expectedCommitCalls: 0,
      expectedError: 'got "minimal"',
    },
    {
      caseName: 'setup to no preset',
      phase: 'setup',
      driftTo: undefined,
      expectedCommitCalls: 0,
      expectedError: 'got none',
    },
    {
      caseName: 'commit to another preset',
      phase: 'commit',
      driftTo: 'minimal',
      expectedCommitCalls: 1,
      expectedError: 'got "minimal"',
    },
  ] as const)('fails closed when the preset drifts during $caseName', async ({
    caseName,
    phase,
    driftTo,
    expectedCommitCalls,
    expectedError,
  }) => {
    const ctx = new Context()
    contexts.push(ctx)
    const mounted = new WeakMap<Context, string>()
    const drift = (agentCtx: Context): void => {
      if (driftTo === undefined) mounted.delete(agentCtx)
      else mounted.set(agentCtx, driftTo)
    }
    const upstreamCommit = vi.fn((agentCtx: Context) => {
      if (phase === 'commit') drift(agentCtx)
    })
    const upstreamSetup = vi.fn((agentCtx: Context): AgentSetupCommit => {
      if (phase === 'setup') drift(agentCtx)
      return { commit: () => { upstreamCommit(agentCtx) } }
    })
    let published = false
    provideEmptyToolRuntime(ctx)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agentPresets', {
      resolve: async () => ({ id: 'standard' }),
      mount: async (agentCtx: Context) => {
        mounted.set(agentCtx, 'standard')
        return { id: 'standard' }
      },
      composedPreset: (agentCtx: Context) => mounted.get(agentCtx),
    } as never)
    ctx.provide('agents', {
      create: async (options: CreateAgentOptions): Promise<AgentHandle> => {
        const session = Session.create(options.sessionId)
        const agent = {
          id: session.id,
          options: {},
          session,
          status: 'idle',
          ctx,
          followup: () => {},
          steer: () => {},
          cancel: () => {},
          whenIdle: () => Promise.resolve(),
        } as unknown as Agent
        const agentCtx = ctx.extend({ agent })
        Object.assign(agent, { ctx: agentCtx })
        const commit = await options.setup?.(agentCtx)
        commit?.commit()
        published = true
        return { agent, dispose: () => Promise.resolve() }
      },
    } as never)

    await expect(openDshRuntimePort(ctx, {
      mode: 'create',
      sessionId: 'preset-drift-' + caseName.replaceAll(' ', '-'),
      selection: { provider: 'test', model: 'test' },
      setup: upstreamSetup,
    })).rejects.toThrow(expectedError)
    expect(upstreamSetup).toHaveBeenCalledOnce()
    expect(upstreamCommit).toHaveBeenCalledTimes(expectedCommitCalls)
    expect(published).toBe(false)
  })

  it('fails clearly when required services or model selection are unavailable', async () => {
    const missingTools = new Context()
    contexts.push(missingTools)
    await expect(openDshRuntimePort(missingTools, {
      mode: 'create',
      selection: { provider: 'p', model: 'm' },
    })).rejects.toThrow('Tool service is unavailable')
    expect(toolChangeListenerCount(missingTools)).toBe(0)

    const missingServices = new Context()
    contexts.push(missingServices)
    provideEmptyToolRuntime(missingServices)
    await expect(openDshRuntimePort(missingServices, {
      mode: 'create',
      selection: { provider: 'p', model: 'm' },
    })).rejects.toThrow('Agent/Session/Preset services')

    const missingSelection = new Context()
    contexts.push(missingSelection)
    provideEmptyToolRuntime(missingSelection)
    missingSelection.provide('agents', {} as never)
    missingSelection.provide('sessions', {} as never)
    missingSelection.provide('agentPresets', {
      resolve: async () => ({ id: 'standard' }),
    } as never)
    await expect(openDshRuntimePort(missingSelection, { mode: 'create' }))
      .rejects.toThrow('model selection')
  })
})
