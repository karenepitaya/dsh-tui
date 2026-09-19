import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime, {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  DshModelSelectionHub,
  type DshModelSelectionRef,
} from '../src/dsh/model-selection.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function createAgent(ctx: Context, id: string): Agent {
  const session = Session.create(SessionId(id))
  const agent = {
    id: session.id,
    options: { provider: 'legacy', model: 'legacy-model' },
    session,
    inbox: {},
    status: 'idle',
    ctx,
    cancel: vi.fn(),
    whenIdle: () => Promise.resolve(),
    runMaintenance: () => Promise.reject(new Error('not used')),
    send: vi.fn(),
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
  } as unknown as Agent
  // Harness 0.1.5 removed the Context.agent enhancement; the exact Agent now
  // travels as an explicit install() argument beside its scoped context.
  const agentCtx = ctx.extend({})
  Object.assign(agent, { ctx: agentCtx })
  return agent
}

class ReasoningDefaultAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('balanced'), name: 'Balanced' }],
        defaultEffort: ReasoningEffortId('balanced'),
      },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {}
}

describe('DshModelSelectionHub', () => {
  it('orders exact-Agent image admission with selection commits without serializing validation', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-image-critical-section')
    const validation = Promise.withResolvers<unknown>()
    ctx.provide('llm', {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: async () => [],
      resolveModelInfo: vi.fn(),
      resolveCallConfig: () => validation.promise,
    } as never)
    const hub = new DshModelSelectionHub(ctx)
    const ref = hub.install(agent.ctx, agent, { provider: 'route', model: 'before-image' })
    const port = hub.attach(agent)
    const admission = Promise.withResolvers<void>()
    const order: string[] = []

    const image = hub.withStableModelSelection(agent, async selection => {
      order.push(`image:${selection.model}:start`)
      await admission.promise
      order.push('image:done')
      return 'stored'
    })
    const selection = port.selectModel({ provider: 'route', model: 'after-image' })
    validation.resolve({ provider: 'route', model: 'after-image' })
    await vi.waitFor(() => { expect(order).toEqual(['image:before-image:start']) })
    expect(ref.current).toEqual({ provider: 'route', model: 'before-image' })

    admission.resolve()
    await expect(image).resolves.toBe('stored')
    await selection
    expect(ref.current).toEqual({ provider: 'route', model: 'after-image' })
    await expect(hub.withStableModelSelection(agent, async current => current.model))
      .resolves.toBe('after-image')

    port.disposeModels()
    await hub.dispose()
  })

  it('reads borrowed model precedence and recovers the per-Agent admission chain', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'default-route', model: 'default-model' }),
    } as never)
    const hub = new DshModelSelectionHub(ctx)
    const durable = createAgent(ctx, 'model-image-durable')
    durable.session.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'durable-route',
          model: 'durable-model',
          reasoningEffort: ReasoningEffortId('high'),
        },
      },
    })
    await expect(hub.withStableModelSelection(durable, async selection => selection))
      .resolves.toEqual({
        provider: 'durable-route',
        model: 'durable-model',
        reasoningEffort: ReasoningEffortId('high'),
      })

    const durableWithoutEffort = createAgent(ctx, 'model-image-durable-no-effort')
    durableWithoutEffort.session.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'durable-route',
          model: 'durable-model-no-effort',
        },
      },
    })
    await expect(hub.withStableModelSelection(
      durableWithoutEffort,
      async selection => selection,
    )).resolves.toEqual({
      provider: 'durable-route',
      model: 'durable-model-no-effort',
    })

    const options = createAgent(ctx, 'model-image-options')
    await expect(hub.withStableModelSelection(options, async selection => selection))
      .resolves.toEqual({ provider: 'legacy', model: 'legacy-model' })

    const fallback = createAgent(ctx, 'model-image-default')
    Object.assign(fallback, { options: {} })
    await expect(hub.withStableModelSelection(fallback, async selection => selection))
      .resolves.toEqual({ provider: 'default-route', model: 'default-model' })
    await expect(hub.withStableModelSelection(fallback, async () => {
      throw new Error('admission failed')
    })).rejects.toThrow('admission failed')
    await expect(hub.withStableModelSelection(fallback, async () => 'recovered'))
      .resolves.toBe('recovered')

    const emptyCtx = new Context()
    contexts.push(emptyCtx)
    const emptyHub = new DshModelSelectionHub(emptyCtx)
    const empty = createAgent(emptyCtx, 'model-image-empty')
    Object.assign(empty, { options: {} })
    await expect(emptyHub.withStableModelSelection(empty, async selection => selection))
      .rejects.toThrow('Current model selection is unavailable')
    await emptyHub.dispose()
    await hub.dispose()
    await expect(hub.withStableModelSelection(fallback, async () => 'late'))
      .rejects.toThrow('Hub is disposed')
  })

  it('commits the official LLM-resolved reasoning default', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['route'], new ReasoningDefaultAdapter())
    const agent = createAgent(ctx, 'model-resolved-default')
    const saveSelection = vi.fn(async () => {})
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'before' }),
      saveSelection,
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    const ref = hub.install(agent.ctx, agent, { provider: 'route', model: 'before' })
    const port = hub.attach(agent)

    await port.selectModel({
      provider: 'route',
      model: 'reasoner',
    }, { saveDefault: true })

    const resolved = {
      provider: 'route',
      model: 'reasoner',
      reasoningEffort: ReasoningEffortId('balanced'),
    }
    expect(ref.current).toEqual(resolved)
    expect(port.modelSnapshot().current).toEqual(resolved)
    expect(saveSelection).toHaveBeenCalledExactlyOnceWith(resolved)

    port.disposeModels()
    await hub.dispose()
  })

  it('owns one exact Agent ref and projects partial provider catalogs', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-owned')
    const saveSelection = vi.fn(async () => {})
    const resolveCallConfig = vi.fn(async (selection: unknown) => selection)
    ctx.provide('agents', {
      get: (id: string) => id === agent.id ? agent : undefined,
    } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route-a', model: 'small' }),
      saveSelection,
    } as never)
    ctx.provide('llm', {
      listProviders: () => [
        { id: 'route-a', name: 'Route A' },
        { id: 'route-b', name: 'Route B' },
      ],
      listModels: async (provider: string) => {
        if (provider === 'route-b') throw new Error('catalog offline')
        return [{
          provider,
          id: 'small',
          name: 'Small',
          description: 'Fast model',
        }]
      },
      resolveModelInfo: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: 'Small',
        reasoning: {
          efforts: [
            { id: 'thoughtful', name: 'Thoughtful', description: 'More thought' },
          ],
          defaultEffort: 'thoughtful',
        },
      }),
      resolveCallConfig,
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    const ref = hub.install(agent.ctx, agent, {
      provider: 'route-a',
      model: 'unlisted-current',
    })
    const port = hub.attach(agent)

    await port.refreshModels()
    expect(port.modelSnapshot()).toEqual({
      current: { provider: 'route-a', model: 'unlisted-current' },
      defaultSelection: { provider: 'route-a', model: 'small' },
      routable: true,
      writable: true,
      loading: false,
      selecting: false,
      groups: [{
        id: 'route-a',
        name: 'Route A',
        models: [{
          provider: 'route-a',
          providerName: 'Route A',
          id: 'small',
          name: 'Small',
          description: 'Fast model',
          efforts: [{
            id: 'thoughtful',
            name: 'Thoughtful',
            description: 'More thought',
            isDefault: true,
          }],
        }],
      }, {
        id: 'route-b',
        name: 'Route B',
        models: [],
      }],
      failures: [{ provider: 'route-b', message: 'catalog offline' }],
    })

    await port.selectModel({
      provider: 'route-a',
      model: 'small',
      reasoningEffort: 'thoughtful',
    }, { saveDefault: true })
    expect(resolveCallConfig).toHaveBeenCalledWith({
      provider: 'route-a',
      model: 'small',
      reasoningEffort: 'thoughtful',
    }, expect.any(AbortSignal))
    expect(ref.current).toEqual({
      provider: 'route-a',
      model: 'small',
      reasoningEffort: 'thoughtful',
    })
    expect(saveSelection).toHaveBeenCalledWith(ref.current)

    port.disposeModels()
    await hub.dispose()
  })

  it('keeps external borrowed Agents read-only and reads their durable route', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-external')
    agent.session.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'external-route',
          model: 'external-model',
          reasoningEffort: ReasoningEffortId('opaque-effort'),
        },
      },
    })
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'default', model: 'default' }),
      saveSelection: vi.fn(),
    } as never)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'external-route', name: 'External' }],
      listModels: async () => [],
      resolveModelInfo: vi.fn(),
      resolveCallConfig: vi.fn(),
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    const port = hub.attach(agent)
    expect(port.modelSnapshot()).toMatchObject({
      current: {
        provider: 'external-route',
        model: 'external-model',
        reasoningEffort: 'opaque-effort',
      },
      routable: true,
      writable: false,
    })
    await expect(port.selectModel({
      provider: 'external-route',
      model: 'another',
    })).rejects.toThrow('managed by another Host')

    port.disposeModels()
    await hub.dispose()
  })

  it('commits only the newest validated selection and does not roll back on default-save failure', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-race')
    const pending = new Map<string, PromiseWithResolvers<unknown>>()
    const saveFailure = new Error('settings unavailable')
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'default' }),
      saveSelection: vi.fn(async () => { throw saveFailure }),
    } as never)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: async () => [],
      resolveModelInfo: vi.fn(),
      resolveCallConfig: vi.fn((selection: { model: string }) => {
        const deferred = Promise.withResolvers<unknown>()
        pending.set(selection.model, deferred)
        return deferred.promise
      }),
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    const ref: DshModelSelectionRef = hub.install(agent.ctx, agent, {
      provider: 'route',
      model: 'before',
    })
    const port = hub.attach(agent)
    const first = port.selectModel({ provider: 'route', model: 'first' })
    const second = port.selectModel({ provider: 'route', model: 'second' })
    await vi.waitFor(() => { expect(pending.size).toBe(2) })
    pending.get('second')!.resolve({ provider: 'route', model: 'second' })
    await second
    pending.get('first')!.resolve({ provider: 'route', model: 'first' })
    await first
    expect(ref.current).toEqual({ provider: 'route', model: 'second' })

    const save = port.selectModel({
      provider: 'route',
      model: 'saved',
    }, { saveDefault: true })
    await vi.waitFor(() => { expect(pending.has('saved')).toBe(true) })
    pending.get('saved')!.resolve({ provider: 'route', model: 'saved' })
    await expect(save).rejects.toBe(saveFailure)
    expect(ref.current).toEqual({ provider: 'route', model: 'saved' })
    expect(port.modelSnapshot().error).toBe('settings unavailable')

    port.disposeModels()
    await hub.dispose()
  })

  it('shares validation generations and default-save ordering across exact-Agent ports', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-multi-port')
    const validations = new Map<string, PromiseWithResolvers<unknown>>()
    const saves = new Map<string, PromiseWithResolvers<void>>()
    const saveOrder: string[] = []
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'default' }),
      saveSelection: (selection: { model: string }) => {
        saveOrder.push(selection.model)
        const pending = Promise.withResolvers<void>()
        saves.set(selection.model, pending)
        return pending.promise
      },
    } as never)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: async () => [],
      resolveModelInfo: vi.fn(),
      resolveCallConfig: (selection: { model: string }) => {
        const pending = Promise.withResolvers<unknown>()
        validations.set(selection.model, pending)
        return pending.promise
      },
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    const ref = hub.install(agent.ctx, agent, { provider: 'route', model: 'initial' })
    const firstPort = hub.attach(agent)
    const secondPort = hub.attach(agent)
    const firstChanged = vi.fn()
    const secondChanged = vi.fn()
    firstPort.onModelsChanged(firstChanged)
    secondPort.onModelsChanged(secondChanged)

    const old = firstPort.selectModel({
      provider: 'route', model: 'old',
    }, { saveDefault: true })
    const newest = secondPort.selectModel({
      provider: 'route', model: 'newest',
    }, { saveDefault: true })
    await vi.waitFor(() => { expect(validations.size).toBe(2) })
    const firstChangesBeforePeerCommit = firstChanged.mock.calls.length
    validations.get('newest')!.resolve({ provider: 'route', model: 'newest' })
    await vi.waitFor(() => { expect(saves.has('newest')).toBe(true) })
    expect(firstChanged.mock.calls.length).toBeGreaterThan(firstChangesBeforePeerCommit)
    validations.get('old')!.resolve({ provider: 'route', model: 'old' })
    await expect(old).rejects.toThrow('superseded by another exact-Agent binding')
    expect(ref.current).toEqual({ provider: 'route', model: 'newest' })
    expect(firstPort.modelSnapshot()).toMatchObject({
      current: { provider: 'route', model: 'newest' },
      selecting: false,
      error: 'DSH model selection was superseded by another exact-Agent binding',
    })
    expect(saveOrder).toEqual(['newest'])
    saves.get('newest')!.resolve()
    await newest

    const secondChangesBeforePeerCommit = secondChanged.mock.calls.length
    const firstSave = firstPort.selectModel({
      provider: 'route', model: 'serial-first',
    }, { saveDefault: true })
    validations.get('serial-first')!.resolve({ provider: 'route', model: 'serial-first' })
    await vi.waitFor(() => { expect(saves.has('serial-first')).toBe(true) })
    expect(secondChanged.mock.calls.length).toBeGreaterThan(secondChangesBeforePeerCommit)
    const secondSave = secondPort.selectModel({
      provider: 'route', model: 'serial-second',
    }, { saveDefault: true })
    validations.get('serial-second')!.resolve({ provider: 'route', model: 'serial-second' })
    await vi.waitFor(() => {
      expect(ref.current).toEqual({ provider: 'route', model: 'serial-second' })
    })
    expect(saveOrder).toEqual(['newest', 'serial-first'])
    saves.get('serial-first')!.resolve()
    await firstSave
    await vi.waitFor(() => { expect(saves.has('serial-second')).toBe(true) })
    saves.get('serial-second')!.resolve()
    await secondSave
    expect(saveOrder).toEqual(['newest', 'serial-first', 'serial-second'])

    firstPort.disposeModels()
    secondPort.disposeModels()
    await hub.dispose()
  })

  it('refreshes from owner events, keeps TUI-origin refs across borrowed reattach, and disposes cleanly', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-events')
    let model = 'first'
    const listModels = vi.fn(async (provider: string) => [{
      provider,
      id: model,
      name: model,
    }])
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'first' }),
      saveSelection: vi.fn(),
    } as never)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels,
      resolveModelInfo: async (provider: string, id: string) => ({
        provider,
        id,
        name: id,
      }),
      resolveCallConfig: async (selection: unknown) => selection,
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    hub.install(agent.ctx, agent, { provider: 'route', model: 'first' })
    const firstPort = hub.attach(agent)
    await firstPort.refreshModels()
    expect(firstPort.modelSnapshot().groups[0]?.models[0]?.id).toBe('first')
    firstPort.disposeModels()

    const reattached = hub.attach(agent)
    expect(reattached.modelSnapshot().writable).toBe(true)
    model = 'second'
    ctx.emit('llm/adapters-updated')
    await vi.waitFor(() => {
      expect(reattached.modelSnapshot().groups[0]?.models[0]?.id).toBe('second')
    })
    model = 'third'
    ctx.emit('settings/document-updated', 'llm-test' as never, 1)
    await vi.waitFor(() => {
      expect(reattached.modelSnapshot().groups[0]?.models[0]?.id).toBe('third')
    })

    await hub.dispose()
    await expect(reattached.refreshModels()).rejects.toThrow('disposed')
    expect(listModels).toHaveBeenCalledTimes(3)
  })

  it('keeps the current route visible but marks it unroutable after adapter removal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-route-removal')
    let adapterActive = true
    ctx.provide('llm', {
      listProviders: () => adapterActive
        ? [{ id: 'route', name: 'Route' }]
        : [],
      listModels: async (provider: string) => [{ provider, id: 'current', name: 'Current' }],
      resolveModelInfo: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: model,
      }),
      resolveCallConfig: async (selection: unknown) => selection,
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    hub.install(agent.ctx, agent, { provider: 'route', model: 'current' })
    const port = hub.attach(agent)
    await port.refreshModels()
    expect(port.modelSnapshot()).toMatchObject({
      current: { provider: 'route', model: 'current' },
      routable: true,
    })

    adapterActive = false
    ctx.emit('llm/adapters-updated')
    await vi.waitFor(() => {
      expect(port.modelSnapshot()).toMatchObject({
        current: { provider: 'route', model: 'current' },
        routable: false,
        groups: [],
      })
    })

    await hub.dispose()
  })

  it('aborts and joins catalog, validation, and default-save wrappers during disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-operation-disposal')
    const catalogs: Array<PromiseWithResolvers<readonly unknown[]>> = []
    const validation = Promise.withResolvers<unknown>()
    const callerValidation = Promise.withResolvers<unknown>()
    const save = Promise.withResolvers<void>()
    const saveSelection = vi.fn(() => save.promise)
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'route', model: 'default' }),
      saveSelection,
    } as never)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: () => {
        const pending = Promise.withResolvers<readonly unknown[]>()
        catalogs.push(pending)
        return pending.promise
      },
      resolveModelInfo: vi.fn(),
      resolveCallConfig: (selection: { model: string }) => (
        selection.model === 'pending-validation'
          ? validation.promise
          : selection.model === 'caller-cancelled'
            ? callerValidation.promise
          : Promise.resolve(selection)
      ),
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    hub.install(agent.ctx, agent, { provider: 'route', model: 'initial' })
    const port = hub.attach(agent)

    const callerAbort = new AbortController()
    const cancelledRefresh = port.refreshModels(callerAbort.signal)
    await vi.waitFor(() => { expect(catalogs).toHaveLength(1) })
    callerAbort.abort(new Error('picker closed'))
    await expect(cancelledRefresh).rejects.toThrow('picker closed')
    expect(port.modelSnapshot()).toMatchObject({ loading: false })

    const selectAbort = new AbortController()
    const cancelledSelection = port.selectModel({
      provider: 'route',
      model: 'caller-cancelled',
    }, { signal: selectAbort.signal })
    selectAbort.abort(new Error('selection picker closed'))
    await expect(cancelledSelection).rejects.toThrow('selection picker closed')
    expect(port.modelSnapshot()).toMatchObject({ selecting: false })

    const saving = port.selectModel({
      provider: 'route',
      model: 'pending-save',
    }, { saveDefault: true })
    await vi.waitFor(() => { expect(saveSelection).toHaveBeenCalledOnce() })
    const validating = port.selectModel({
      provider: 'route',
      model: 'pending-validation',
    })
    const refreshing = port.refreshModels()
    await vi.waitFor(() => { expect(catalogs).toHaveLength(2) })

    port.disposeModels()
    let disposed = false
    const disposal = hub.dispose().then(() => { disposed = true })
    const operationResults = await Promise.allSettled([saving, validating, refreshing])
    for (const result of operationResults) {
      expect(result).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: expect.stringContaining('model port disposed') }),
      })
    }
    expect(disposed).toBe(false)
    save.resolve()
    await expect(disposal).resolves.toBeUndefined()
  })

  it('fails closed at exact-Agent lifecycle boundaries and isolates observers', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-lifecycle')
    ctx.provide('llm', {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: async () => [],
      resolveModelInfo: vi.fn(),
      resolveCallConfig: async (selection: unknown) => selection,
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    // Harness 0.1.5 passes the exact Agent to install() explicitly, so the old
    // "did not expose its unpublished Agent" guard no longer exists.
    hub.install(agent.ctx, agent, { provider: 'route', model: 'initial' })
    expect(() => hub.install(agent.ctx, agent, {
      provider: 'route',
      model: 'duplicate',
    })).toThrow('already installed')

    const port = hub.attach(agent)
    const observed = vi.fn()
    const stopObserved = port.onModelsChanged(observed)
    const stopThrowing = port.onModelsChanged(() => {
      throw new Error('view observer failed')
    })
    await port.refreshModels()
    expect(observed).toHaveBeenCalled()
    stopObserved()
    stopObserved()
    stopThrowing()

    port.disposeModels()
    port.disposeModels()
    const stoppedAfterDispose = port.onModelsChanged(observed)
    stoppedAfterDispose()
    const internals = port as unknown as {
      invalidate(): void
      updateState(patch: Record<string, never>): void
    }
    internals.updateState({})
    internals.invalidate()
    await Promise.resolve()

    const firstDispose = hub.dispose()
    expect(hub.dispose()).toBe(firstDispose)
    await firstDispose
    expect(() => hub.install(agent.ctx, agent, {
      provider: 'route',
      model: 'after-dispose',
    })).toThrow('Hub is disposed')
    expect(() => hub.attach(agent)).toThrow('Hub is disposed')
  })

  it('rejects a validated result after its exact Agent selection scope disappears', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-scope-race')
    const validation = Promise.withResolvers<unknown>()
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: async () => [],
      resolveModelInfo: vi.fn(),
      resolveCallConfig: () => validation.promise,
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    const ref = hub.install(agent.ctx, agent, { provider: 'route', model: 'initial' })
    const firstPort = hub.attach(agent)
    const secondPort = hub.attach(agent)
    const selection = firstPort.selectModel({ provider: 'route', model: 'stale' })

    await agent.ctx.fiber.dispose()
    validation.resolve({ provider: 'route', model: 'stale' })
    await expect(selection).rejects.toThrow(
      'exact Agent model selection scope changed during validation',
    )
    expect(ref.current).toEqual({ provider: 'route', model: 'initial' })
    expect(firstPort.modelSnapshot()).toMatchObject({ writable: false, selecting: false })
    expect(secondPort.modelSnapshot()).toMatchObject({ writable: false })

    await hub.dispose()
  })

  it('projects an empty borrowed scope and reports unavailable or failing LLM services', async () => {
    const emptyCtx = new Context()
    contexts.push(emptyCtx)
    const emptyAgent = createAgent(emptyCtx, 'model-empty-services')
    const emptyHub = new DshModelSelectionHub(emptyCtx)
    const emptyPort = emptyHub.attach(emptyAgent)
    expect(emptyPort.modelSnapshot()).toEqual({
      routable: false,
      writable: false,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
    })
    emptyAgent.session.append('request/header', {
      reason: 'initial',
      header: {
        config: { provider: 'durable-route', model: 'durable-model' },
      },
    })
    expect(emptyPort.modelSnapshot().current).toEqual({
      provider: 'durable-route',
      model: 'durable-model',
    })
    await expect(emptyPort.refreshModels()).rejects.toThrow('LLM service is unavailable')
    emptyPort.disposeModels()
    await emptyHub.dispose()

    const failingCtx = new Context()
    contexts.push(failingCtx)
    const failingAgent = createAgent(failingCtx, 'model-failing-provider-scan')
    failingCtx.provide('llm', {
      listProviders: () => { throw 'provider scan failed' },
    } as never)
    const failingHub = new DshModelSelectionHub(failingCtx)
    const failingPort = failingHub.attach(failingAgent)
    await expect(failingPort.refreshModels()).rejects.toBe('provider scan failed')
    expect(failingPort.modelSnapshot()).toMatchObject({
      routable: false,
      writable: false,
      error: 'provider scan failed',
    })
    failingCtx.emit('llm/adapters-updated')
    await Promise.resolve()
    failingPort.disposeModels()
    await failingHub.dispose()
  })

  it('validates inputs, caller signals, default persistence, and the exact Agent before commit', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-validation')
    const impostor = { ...agent } as unknown as Agent
    let exact = true
    ctx.provide('agents', {
      get: () => exact ? agent : impostor,
    } as never)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: async () => [],
      resolveModelInfo: vi.fn(),
      resolveCallConfig: async (selection: unknown) => selection,
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    const ref = hub.install(agent.ctx, agent, { provider: 'route', model: 'initial' })
    const port = hub.attach(agent)
    await expect(port.selectModel({ provider: '', model: 'model' })).rejects.toThrow(
      'non-empty provider and model',
    )
    await expect(port.selectModel({ provider: 'route', model: '' })).rejects.toThrow(
      'non-empty provider and model',
    )

    const refreshSignal = new AbortController().signal
    await port.refreshModels(refreshSignal)
    const selectSignal = new AbortController().signal
    await port.selectModel({ provider: 'route', model: 'selected' }, { signal: selectSignal })
    expect(ref.current).toEqual({ provider: 'route', model: 'selected' })

    await expect(port.selectModel({
      provider: 'route',
      model: 'session-only-after-save-error',
    }, { saveDefault: true })).rejects.toThrow('default-model service is unavailable')
    expect(ref.current).toEqual({
      provider: 'route',
      model: 'session-only-after-save-error',
    })

    exact = false
    await expect(port.selectModel({
      provider: 'route',
      model: 'wrong-exact-agent',
    })).rejects.toThrow('exact Agent changed')
    expect(ref.current).toEqual({
      provider: 'route',
      model: 'session-only-after-save-error',
    })

    const aborted = new AbortController()
    aborted.abort(new Error('caller cancelled'))
    await expect(port.refreshModels(aborted.signal)).rejects.toThrow('caller cancelled')
    await expect(port.selectModel({
      provider: 'route',
      model: 'cancelled',
    }, { signal: aborted.signal })).rejects.toThrow('caller cancelled')

    port.disposeModels()
    await hub.dispose()
  })

  it('keeps last-good provider and model projections across partial catalog failures', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-last-good')
    let phase: 'success' | 'list-failure' | 'new-model-failure' | 'known-model-failure' = 'success'
    ctx.provide('llm', {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: async (provider: string) => {
        if (phase === 'list-failure') throw 'catalog transport failed'
        const id = phase === 'success' ? 'minimal' : 'broken'
        return [{ provider, id, name: id }]
      },
      resolveModelInfo: async (provider: string, model: string) => {
        if (phase === 'new-model-failure' || phase === 'known-model-failure') {
          throw new Error('metadata unavailable')
        }
        return {
          provider,
          id: model,
          name: model,
          reasoning: {
            efforts: [{ id: 'opaque', name: 'Opaque' }],
          },
        }
      },
      resolveCallConfig: async (selection: unknown) => selection,
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    hub.install(agent.ctx, agent, { provider: 'route', model: 'minimal' })
    const port = hub.attach(agent)

    await port.refreshModels()
    expect(port.modelSnapshot()).toMatchObject({
      groups: [{
        id: 'route',
        models: [{
          id: 'minimal',
          efforts: [{ id: 'opaque', isDefault: false }],
        }],
      }],
      failures: [],
    })

    phase = 'list-failure'
    await port.refreshModels()
    expect(port.modelSnapshot()).toMatchObject({
      groups: [{ models: [{ id: 'minimal' }] }],
      failures: [{ provider: 'route', message: 'catalog transport failed' }],
    })

    phase = 'new-model-failure'
    await port.refreshModels()
    expect(port.modelSnapshot()).toMatchObject({
      groups: [{ models: [{ id: 'broken', efforts: [] }] }],
      failures: [{ provider: 'route', message: 'broken: metadata unavailable' }],
    })

    phase = 'known-model-failure'
    await port.refreshModels()
    expect(port.modelSnapshot()).toMatchObject({
      groups: [{ models: [{ id: 'broken', efforts: [] }] }],
      failures: [{ provider: 'route', message: 'broken: metadata unavailable' }],
    })

    port.disposeModels()
    await hub.dispose()
  })

  it('ignores a refresh result that loses its binding generation race', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-refresh-race')
    const pending: Array<PromiseWithResolvers<readonly unknown[]>> = []
    ctx.provide('llm', {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: () => {
        const deferred = Promise.withResolvers<readonly unknown[]>()
        pending.push(deferred)
        return deferred.promise
      },
      resolveModelInfo: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: model,
      }),
      resolveCallConfig: async (selection: unknown) => selection,
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    hub.install(agent.ctx, agent, { provider: 'route', model: 'initial' })
    const port = hub.attach(agent)
    const first = port.refreshModels()
    const second = port.refreshModels()
    await vi.waitFor(() => { expect(pending).toHaveLength(2) })
    pending[1]!.resolve([{ provider: 'route', id: 'newer', name: 'Newer' }])
    await second
    pending[0]!.resolve([{ provider: 'route', id: 'older', name: 'Older' }])
    await first
    expect(port.modelSnapshot().groups[0]?.models[0]?.id).toBe('newer')

    port.disposeModels()
    await hub.dispose()
  })

  it('isolates stale validation and save completions and recovers the serialized save chain', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = createAgent(ctx, 'model-select-generations')
    const validations = new Map<string, PromiseWithResolvers<unknown>>()
    const saves = new Map<string, PromiseWithResolvers<void>>()
    let defaultSelection = { provider: 'route', model: 'default' }
    ctx.provide('agents', { get: () => agent } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => defaultSelection,
      saveSelection: (selection: { provider: string; model: string }) => {
        const deferred = Promise.withResolvers<void>()
        saves.set(selection.model, deferred)
        return deferred.promise.then(() => {
          defaultSelection = { provider: selection.provider, model: selection.model }
        })
      },
    } as never)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'route', name: 'Route' }],
      listModels: async () => [],
      resolveModelInfo: vi.fn(),
      resolveCallConfig: (selection: { model: string }) => {
        const deferred = Promise.withResolvers<unknown>()
        validations.set(selection.model, deferred)
        return deferred.promise
      },
    } as never)

    const hub = new DshModelSelectionHub(ctx)
    const ref = hub.install(agent.ctx, agent, { provider: 'route', model: 'initial' })
    const port = hub.attach(agent)

    const stale = port.selectModel({ provider: 'route', model: 'stale-rejection' })
    const newest = port.selectModel({ provider: 'route', model: 'newest' })
    await vi.waitFor(() => { expect(validations.size).toBe(2) })
    validations.get('newest')!.resolve({ provider: 'route', model: 'newest' })
    await newest
    validations.get('stale-rejection')!.reject(new Error('stale validation failed'))
    await expect(stale).rejects.toThrow('stale validation failed')
    expect(ref.current).toEqual({ provider: 'route', model: 'newest' })
    expect(port.modelSnapshot().error).toBeUndefined()

    const staleSave = port.selectModel({
      provider: 'route',
      model: 'stale-save',
    }, { saveDefault: true })
    validations.get('stale-save')!.resolve({ provider: 'route', model: 'stale-save' })
    await vi.waitFor(() => { expect(saves.has('stale-save')).toBe(true) })
    const afterSave = port.selectModel({ provider: 'route', model: 'after-save' })
    validations.get('after-save')!.resolve({ provider: 'route', model: 'after-save' })
    await afterSave
    saves.get('stale-save')!.resolve()
    await staleSave
    expect(ref.current).toEqual({ provider: 'route', model: 'after-save' })

    const failedSave = port.selectModel({
      provider: 'route',
      model: 'failed-save',
    }, { saveDefault: true })
    validations.get('failed-save')!.resolve({ provider: 'route', model: 'failed-save' })
    await vi.waitFor(() => { expect(saves.has('failed-save')).toBe(true) })
    saves.get('failed-save')!.reject(new Error('save failed'))
    await expect(failedSave).rejects.toThrow('save failed')

    const recoveredSave = port.selectModel({
      provider: 'route',
      model: 'recovered-save',
    }, { saveDefault: true })
    validations.get('recovered-save')!.resolve({ provider: 'route', model: 'recovered-save' })
    await vi.waitFor(() => { expect(saves.has('recovered-save')).toBe(true) })
    saves.get('recovered-save')!.resolve()
    await recoveredSave
    expect(ref.current).toEqual({ provider: 'route', model: 'recovered-save' })
    expect(port.modelSnapshot()).toMatchObject({
      defaultSelection: { provider: 'route', model: 'recovered-save' },
      selecting: false,
    })

    port.disposeModels()
    await hub.dispose()
  })
})
