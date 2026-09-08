import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { DshProviderConnection } from '../src/dsh/provider-connection.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function fixture(
  stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  metadata: Partial<LlmResolvedModelInfo> = {},
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const dispatch = vi.fn(stream)
  class TestAdapter extends LlmAdapter {
    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return Promise.resolve({ provider, id: model, name: model, ...metadata })
    }
    override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      return dispatch(options)
    }
  }
  ctx.llm.registerAdapter(['test-provider'], new TestAdapter())
  ctx.llm.registerConfigurableProviders([{
    provider: 'test-provider', displayName: 'Test Provider',
    settingsNs: 'test-settings', settingsPath: [],
  }, {
    provider: 'dormant', displayName: 'Dormant',
    settingsNs: 'test-settings', settingsPath: ['dormant'],
  }])
  return { ctx, port: new DshProviderConnection(ctx), dispatch }
}

async function* successful(): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', index: 0, text: 'OK' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

describe('DshProviderConnection.test', () => {
  it('reports a missing official LLM service explicitly', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(new DshProviderConnection(ctx).test('test-provider', 'test-model'))
      .rejects.toThrow('DSH LLM service is unavailable')
  })

  it('keeps the provider-owned default reasoning effort and respects a smaller output default', async () => {
    const { port, dispatch } = await fixture(successful, {
      defaultMaxTokens: 64,
      reasoning: {
        defaultEffort: ReasoningEffortId('balanced'),
        efforts: [{ id: ReasoningEffortId('balanced'), name: 'Balanced' }],
      },
    })
    await port.test('test-provider', 'test-model')
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ maxTokens: 64, reasoningEffort: 'balanced' })
  })

  it.each([undefined, { code: 'sk-private-secret' }])('sanitizes thrown adapter preparation failures %#', async error => {
    const { ctx, port } = await fixture(successful)
    vi.spyOn(ctx.llm, 'prepareCall').mockRejectedValueOnce(error)
    await expect(port.test('test-provider', 'test-model')).rejects.toThrow('Provider test failed (PROVIDER_ERROR)')
  })

  it('cancels pending model metadata without dispatching a later request', async () => {
    const { ctx, port, dispatch } = await fixture(successful)
    const pending = Promise.withResolvers<LlmResolvedModelInfo>()
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockReturnValueOnce(pending.promise)
    const abort = new AbortController()
    const rejected = expect(port.test('test-provider', 'test-model', { signal: abort.signal }))
      .rejects.toThrow('cancelled metadata')
    abort.abort(new Error('cancelled metadata'))
    await rejected
    pending.resolve({ provider: 'test-provider', id: 'test-model', name: 'Test Model' })
    await Promise.resolve()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reports text returned at the output limit as a limited response', async () => {
    const { port } = await fixture(async function* () {
      yield { type: 'text-delta', index: 0, text: 'OK' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })
    await expect(port.test('test-provider', 'test-model')).resolves.toMatchObject({ outcome: 'limited' })
  })

  it('distinguishes an exhausted reasoning budget from a connection failure', async () => {
    const { port } = await fixture(async function* () {
      yield { type: 'reasoning-delta', index: 0, text: 'thinking' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })
    await expect(port.test('test-provider', 'test-model')).rejects.toThrow('服务已响应，但测试输出额度不足')
  })

  it('rejects trailing chunks after the terminal response', async () => {
    const { port } = await fixture(async function* () {
      yield* successful()
      yield { type: 'text-delta', index: 0, text: 'unexpected' }
    })
    await expect(port.test('test-provider', 'test-model')).rejects.toThrow('after its terminal response')
  })

  it('uses an isolated official LLM request without session, files, tools, or settings services', async () => {
    const { port, dispatch } = await fixture(successful)
    const result = await port.test('test-provider', 'test-model')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const options = dispatch.mock.calls[0]![0]
    expect(options).toMatchObject({
      provider: 'test-provider', model: 'test-model', maxTokens: 128, tools: [],
      messages: [{
        role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }],
        source: { kind: 'plugin', plugin: 'dsh-tui-provider-test' },
      }],
    })
    expect(options.messages).toHaveLength(1)
    expect(options.sessionId).toBeUndefined()
    expect(options.system).toBeUndefined()
    expect(options.purpose).toBeUndefined()
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(Object.isFrozen(options)).toBe(true)
  })

  it('accepts a completed text block when the adapter does not send text deltas', async () => {
    const { port } = await fixture(async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await expect(port.test('test-provider', 'test-model')).resolves.toEqual({
      elapsedMs: expect.any(Number), outcome: 'completed',
    })
  })

  it.each(['unknown', 'dormant'])('rejects unavailable provider %s before dispatch', async provider => {
    const { port, dispatch } = await fixture(successful)
    await expect(port.test(provider, 'test-model')).rejects.toThrow(/Unknown|not active/)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rejects empty model ids before dispatch', async () => {
    const { port, dispatch } = await fixture(successful)
    await expect(port.test('test-provider', '  ')).rejects.toThrow('model')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each([0, -1, NaN, Infinity, 2_147_483_648])('rejects invalid timeout %s', async timeoutMs => {
    const { port, dispatch } = await fixture(successful)
    await expect(port.test('test-provider', 'test-model', { timeoutMs })).rejects.toThrow('timeout')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch when the caller already cancelled', async () => {
    const { port, dispatch } = await fixture(successful)
    const abort = new AbortController()
    abort.abort(new Error('cancelled by caller'))
    await expect(port.test('test-provider', 'test-model', { signal: abort.signal }))
      .rejects.toThrow('cancelled by caller')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('cancels a pending adapter read and settles even if the adapter ignores cancellation', async () => {
    const pending = Promise.withResolvers<IteratorResult<StreamChunk>>()
    const close = vi.fn(async () => ({ done: true as const, value: undefined }))
    const { port, dispatch } = await fixture(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => pending.promise, return: close }),
    }))
    const abort = new AbortController()
    const operation = port.test('test-provider', 'test-model', { signal: abort.signal })
    const rejected = expect(operation).rejects.toThrow('cancelled by caller')
    await vi.waitFor(() => { expect(dispatch).toHaveBeenCalledTimes(1) })
    abort.abort(new Error('cancelled by caller'))
    await rejected
    expect(dispatch.mock.calls[0]![0].signal?.aborted).toBe(true)
    pending.resolve({ done: true, value: undefined })
  })

  it('enforces the default timeout and aborts the official request', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<IteratorResult<StreamChunk>>()
    const { port, dispatch } = await fixture(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => pending.promise }),
    }))
    const rejected = expect(port.test('test-provider', 'test-model')).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(dispatch.mock.calls[0]![0].signal?.aborted).toBe(true)
    pending.resolve({ done: true, value: undefined })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors a custom timeout and clears the timer after success', async () => {
    vi.useFakeTimers()
    const { port } = await fixture(successful)
    await port.test('test-provider', 'test-model', { timeoutMs: 500 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a normalized provider failure after partial text without exposing provider secrets', async () => {
    const { port } = await fixture(async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      throw new LlmError('rejected token sk-private', 'AUTH')
    })
    const failure = await port.test('test-provider', 'test-model').catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('AUTH')
    expect((failure as Error).message).not.toContain('sk-private')
  })

  it.each([
    { kind: 'tool-calls' as const },
    { kind: 'aborted' as const, failure: { code: 'ABORTED', message: 'private detail' } },
  ])('does not report terminal $kind as a successful test', async reason => {
    const { port } = await fixture(async function* () {
      yield { type: 'text-delta', index: 0, text: 'OK' }
      yield { type: 'finish', reason }
    })
    await expect(port.test('test-provider', 'test-model')).rejects.toThrow('Provider test')
  })

  it.each([
    [],
    [{ type: 'text-delta', index: 0, text: 'OK' }],
    [{ type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'text-delta', index: 0, text: '  ' }, { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'finish', reason: { kind: 'stop' } }],
  ] satisfies StreamChunk[][])('rejects incomplete or non-text responses %#', async (...chunks) => {
    const { port } = await fixture(async function* () { yield* chunks })
    await expect(port.test('test-provider', 'test-model')).rejects.toThrow('Provider test')
  })
})
