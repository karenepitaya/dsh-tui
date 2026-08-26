import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DshSessionContextMeter } from '../src/dsh/context-meter.ts'
import type {
  SessionContextBreakdown,
  SessionContextPressure,
  SessionTokenUsage,
} from '../src/context/port.ts'

const identitySchema = {
  parse<T>(value: T): T {
    return structuredClone(value)
  },
}

function eventUsage(event: SessionEvent): {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
} | undefined {
  if (event.type !== 'assistant/chunk' || event.data.chunk.type !== 'usage') {
    return undefined
  }
  const usage = event.data.chunk.usage
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

/** Install small fixture folds under token-meter's public projection keys. */
function registerTokenMeterContract(ctx: Context): void {
  const registry = ctx.sessionProjections
  registry.register({
    key: 'contextPressure',
    stateSchema: identitySchema,
    init: (): SessionContextPressure => ({}),
    apply: (state: SessionContextPressure, event: SessionEvent): SessionContextPressure => {
      if (event.type === 'request/context') {
        return event.data.contextWindow === undefined
          ? state
          : { ...state, contextWindow: event.data.contextWindow }
      }
      const usage = eventUsage(event)
      if (usage === undefined) return state
      const pressureTokens = usage.inputTokens
        + usage.cacheReadTokens
        + usage.cacheWriteTokens
      return { ...state, pressureTokens, projectedTokens: pressureTokens }
    },
    wire: { viewSchema: identitySchema, view: (state: SessionContextPressure) => state },
    stateVersion: 0,
  } as never)
  registry.register({
    key: 'contextBreakdown',
    stateSchema: identitySchema,
    init: (): SessionContextBreakdown => ({
      systemTokens: 0,
      toolsTokens: 0,
      messageTokens: 0,
    }),
    apply: (state: SessionContextBreakdown): SessionContextBreakdown => state,
    wire: { viewSchema: identitySchema, view: (state: SessionContextBreakdown) => state },
    stateVersion: 0,
  } as never)
  registry.register({
    key: 'tokenUsage',
    stateSchema: identitySchema,
    init: (): SessionTokenUsage => ({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    apply: (state: SessionTokenUsage, event: SessionEvent): SessionTokenUsage => {
      const usage = eventUsage(event)
      if (usage === undefined) return state
      return {
        uncachedInputTokens: state.uncachedInputTokens + usage.inputTokens,
        outputTokens: state.outputTokens + usage.outputTokens,
        cacheReadTokens: state.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens + usage.cacheWriteTokens,
      }
    },
    wire: { viewSchema: identitySchema, view: (state: SessionTokenUsage) => state },
    stateVersion: 0,
  } as never)
}

async function harness(): Promise<{
  readonly ctx: Context
  readonly session: Session
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  registerTokenMeterContract(ctx)
  return { ctx, session: ctx.sessions.create() }
}

function recordUsage(
  session: Session,
  usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
  } = {
    inputTokens: 32_000,
    outputTokens: 800,
    cacheReadTokens: 4_000,
    cacheWriteTokens: 200,
  },
): void {
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/context', {
    provider: 'mock',
    model: 'large',
    contextWindow: 128_000,
  })
  session.append('assistant/chunk', {
    turn: 1,
    step: 1,
    chunk: { type: 'usage', usage },
  })
}

describe('official DSH context-meter projection adapter', () => {
  it('attaches when Cordis activates the projection registry after the adapter', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const meter = new DshSessionContextMeter(ctx, session)
    let observed = 0
    meter.onContextChanged(() => { observed += 1 })

    try {
      expect(meter.contextSnapshot()).toEqual({ available: false })

      await ctx.plugin(SessionProjectionRegistry)
      registerTokenMeterContract(ctx)
      recordUsage(session)

      expect(meter.contextSnapshot().pressure).toEqual({
        pressureTokens: 36_200,
        projectedTokens: 36_200,
        contextWindow: 128_000,
      })
      expect(observed).toBeGreaterThan(0)
    } finally {
      meter.disposeContext()
      await ctx.fiber.dispose()
    }
  })

  it('reads the official pressure, breakdown, and durable usage contract', async () => {
    const { ctx, session } = await harness()
    const meter = new DshSessionContextMeter(ctx, session)
    await new Promise<void>(resolve => { setImmediate(resolve) })

    expect(meter.contextSnapshot()).toEqual({
      available: true,
      asOfSeq: -1,
      pressure: {},
      breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
      usage: {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })

    recordUsage(session)
    const snapshot = meter.contextSnapshot()
    expect(snapshot).toEqual({
      available: true,
      asOfSeq: 2,
      pressure: {
        pressureTokens: 36_200,
        projectedTokens: 36_200,
        contextWindow: 128_000,
      },
      breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
      usage: {
        uncachedInputTokens: 32_000,
        outputTokens: 800,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 200,
      },
    })

    const pressure = snapshot.pressure as { pressureTokens?: number }
    pressure.pressureTokens = 1
    expect(meter.contextSnapshot().pressure?.pressureTokens).toBe(36_200)

    meter.disposeContext()
    await ctx.fiber.dispose()
  })

  it('contains a late Cordis callback and reports an asynchronous binding cleanup failure', async () => {
    const cleanupFailure = new Error('projection binding cleanup failed')
    const logError = vi.fn()
    const dispose = vi.fn(() => Promise.reject(cleanupFailure))
    let activate: (() => unknown) | undefined
    const ctx = {
      get: () => undefined,
      inject: (_deps: unknown, callback: (ctx: Context) => unknown) => {
        activate = () => callback({} as Context)
        return { dispose }
      },
      logger: { error: logError },
    } as unknown as Context
    const meter = new DshSessionContextMeter(ctx, {} as Session)

    meter.disposeContext()
    expect(() => activate?.()).not.toThrow()
    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledExactlyOnceWith(cleanupFailure)
    })
    expect(dispose).toHaveBeenCalledOnce()
    expect(meter.contextSnapshot()).toEqual({ available: false })
  })

  it('reuses one projection listener when Cordis re-announces the same registry', () => {
    const stopChanged = vi.fn()
    const registry = {
      onChanged: vi.fn(() => stopChanged),
      snapshot: vi.fn(() => ({ values: {}, asOfSeq: -1 })),
    } as unknown as SessionProjectionRegistry
    let activate: ((ctx: Context) => unknown) | undefined
    const dispose = vi.fn(() => Promise.resolve())
    const ctx = {
      get: () => registry,
      inject: (_deps: unknown, callback: (ctx: Context) => unknown) => {
        activate = callback
        return { dispose }
      },
      logger: { error: vi.fn() },
    } as unknown as Context
    const meter = new DshSessionContextMeter(ctx, {} as Session)

    expect(registry.onChanged).toHaveBeenCalledOnce()
    expect(activate?.({ sessionProjections: registry } as Context)).toBeTypeOf('function')
    expect(registry.onChanged).toHaveBeenCalledOnce()

    meter.disposeContext()
    expect(stopChanged).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('notifies only for this Session and contains observer failures', async () => {
    const { ctx, session } = await harness()
    const other = ctx.sessions.create()
    const meter = new DshSessionContextMeter(ctx, session)
    let observed = 0
    meter.onContextChanged(() => { throw new Error('view failed') })
    const stop = meter.onContextChanged(() => { observed += 1 })

    recordUsage(other, { inputTokens: 1, outputTokens: 1 })
    expect(observed).toBe(0)
    expect(() => recordUsage(session)).not.toThrow()
    expect(observed).toBeGreaterThan(0)

    const beforeStop = observed
    stop()
    stop()
    session.append('request/context', {
      provider: 'mock',
      model: 'larger',
      contextWindow: 256_000,
    })
    expect(observed).toBe(beforeStop)

    meter.disposeContext()
    meter.disposeContext()
    expect(meter.contextSnapshot()).toEqual({ available: false })
    expect(meter.onContextChanged(() => { observed += 1 })()).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reports capability absence without inventing a local estimate', async () => {
    const withoutRegistry = new Context()
    await withoutRegistry.plugin(SessionStore)
    const noRegistrySession = withoutRegistry.sessions.create()
    const noRegistry = new DshSessionContextMeter(withoutRegistry, noRegistrySession)
    expect(noRegistry.contextSnapshot()).toEqual({ available: false })
    noRegistry.disposeContext()
    await withoutRegistry.fiber.dispose()

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create()
    const noMeter = new DshSessionContextMeter(ctx, session)
    expect(noMeter.contextSnapshot()).toEqual({ available: false, asOfSeq: -1 })
    noMeter.disposeContext()
    await ctx.fiber.dispose()
  })
})
