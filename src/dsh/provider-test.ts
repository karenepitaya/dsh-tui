import {
  createUserMessage,
  deepFreeze,
  type FinishReason,
  type LlmRuntime,
} from '@deepseek-ai/dsh-llm'
import type { ProviderTestOptions, ProviderTestResult } from '../provider/port.ts'

class ProviderTestError extends Error {}

function failureOf(error: unknown): ProviderTestError {
  const rawCode = (error as { readonly code?: unknown } | null | undefined)?.code
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
    ? rawCode : 'PROVIDER_ERROR'
  // Provider messages can echo credentials or URLs; only the stable code crosses the port.
  return new ProviderTestError(`Provider test failed (${code})`)
}

async function runTest(
  llm: LlmRuntime,
  provider: string,
  model: string,
  signal: AbortSignal,
): Promise<'completed' | 'limited'> {
  const info = await llm.resolveModelInfo(provider, model, signal)
  signal.throwIfAborted()
  const prepared = await llm.prepareCall({
    provider,
    model,
    maxTokens: Math.min(128, info.defaultMaxTokens ?? 128),
  }, signal)
  signal.throwIfAborted()
  const request = deepFreeze({
    ...prepared.config,
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'Reply with OK.' }],
      source: { kind: 'plugin', plugin: 'dsh-tui-provider-test' },
    })],
    tools: [],
    signal,
  })
  let hasText = false
  let finish: FinishReason | undefined
  for await (const chunk of prepared.stream(request)) {
    signal.throwIfAborted()
    if (finish !== undefined) throw new ProviderTestError('Provider test returned data after its terminal response')
    if (chunk.type === 'tool-call-delta'
      || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
      || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')) {
      throw new ProviderTestError('Provider test returned an unexpected tool call')
    }
    if (chunk.type === 'text-delta' && chunk.text.trim().length > 0) hasText = true
    if (chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text.trim().length > 0) {
      hasText = true
    }
    if (chunk.type === 'finish') finish = chunk.reason
  }
  signal.throwIfAborted()
  if (finish?.kind === 'error' || finish?.kind === 'aborted') throw failureOf(finish.failure)
  if (finish?.kind === 'max-tokens') {
    if (hasText) return 'limited'
    throw new ProviderTestError('服务已响应，但测试输出额度不足')
  }
  if (finish?.kind !== 'stop' || !hasText) {
    throw new ProviderTestError('Provider test did not return a completed text response')
  }
  return 'completed'
}

/** Official adapter dispatch only: no Agent, Session, credentials, or settings access. */
export async function testProvider(
  llm: LlmRuntime,
  provider: string,
  model: string,
  options: ProviderTestOptions,
): Promise<ProviderTestResult> {
  options.signal?.throwIfAborted()
  if (!llm.listConfigurableProviders().some(entry => entry.provider === provider)) {
    throw new Error(`Unknown configurable Provider "${provider}"`)
  }
  if (!llm.listProviders().some(entry => entry.id === provider)) {
    throw new Error(`Provider "${provider}" is not active; configure it before testing`)
  }
  if (model.trim().length === 0) throw new Error('Provider test requires a model id')
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('Provider test timeout must be a positive integer within the timer range')
  }
  const started = performance.now()
  const abort = new AbortController()
  const onCallerAbort = (): void => { abort.abort(options.signal!.reason) }
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    abort.abort(new ProviderTestError(`Provider test timed out after ${timeoutMs} ms`))
  }, timeoutMs)
  const cancelled = Promise.withResolvers<never>()
  const onAbort = (): void => { cancelled.reject(abort.signal.reason) }
  abort.signal.addEventListener('abort', onAbort, { once: true })
  try {
    // A non-cooperative adapter must not leave the Settings UI waiting forever.
    const outcome = await Promise.race([runTest(llm, provider, model, abort.signal), cancelled.promise])
    return { elapsedMs: Math.max(0, Math.round(performance.now() - started)), outcome }
  } catch (error) {
    if (abort.signal.aborted) throw abort.signal.reason
    if (error instanceof ProviderTestError) throw error
    throw failureOf(error)
  } finally {
    clearTimeout(timer)
    abort.signal.removeEventListener('abort', onAbort)
    options.signal?.removeEventListener('abort', onCallerAbort)
  }
}
