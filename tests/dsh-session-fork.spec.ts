import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  Session,
  SessionId,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { DshTuiSessionPort } from '../src/runtime/tui-session-port.ts'
import {
  DshSessionFork,
  type OpenDshForkSessionRequest,
} from '../src/dsh/session-fork.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function fakePort(sessionId: string, dispose = vi.fn(() => Promise.resolve())): DshTuiSessionPort {
  return { sessionId, dispose } as unknown as DshTuiSessionPort
}

function preset(id: string) {
  return {
    id,
    trust: 'system' as const,
    path: `D:\\presets\\${id}\\agent.cordis.yml`,
  }
}

function provideComposition(ctx: Context): void {
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
  } as never)
  ctx.provide('agentPresets', {
    defaultId: 'standard',
    resolve: async (id?: string) => preset(id ?? 'standard'),
  } as never)
}

function completedSession(
  id: string,
  header: Partial<SessionHeader> = {},
): Session {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: 1,
    ...header,
  })
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    reason: 'initial',
    header: {
      config: {
        provider: 'historic-provider',
        model: 'historic-model',
        reasoningEffort: ReasoningEffortId('high'),
        maxTokens: 4096,
      },
    },
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

describe('DshSessionFork', () => {
  it('opens a live source fork with inherited route, preset, cwd, and lineage', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    provideComposition(ctx)
    const source = ctx.sessions.create(SessionId('session-source'), {
      meta: { cwd: 'D:\\workspace', agentPreset: 'coding' },
    })
    source.append('turn/start', { turn: 1 })
    source.append('request/header', {
      reason: 'initial',
      header: {
        config: {
          provider: 'historic-provider',
          model: 'historic-model',
          reasoningEffort: ReasoningEffortId('high'),
          maxTokens: 2048,
        },
      },
    })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    source.append('agent-preset/selected', { agentPreset: 'research' })
    const opened: OpenDshForkSessionRequest[] = []
    const dispose = vi.fn(() => Promise.resolve())
    const fork = new DshSessionFork(ctx, async (request) => {
      opened.push(request)
      return fakePort(request.sessionId, dispose)
    })

    const lease = await fork.forkSession({
      sourceSessionId: source.id,
      signal: new AbortController().signal,
    })

    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      mode: 'fork',
      parentSessionId: 'session-source',
      cwd: 'D:\\workspace',
      agentPreset: 'research',
      agentPresetPlan: {
        id: 'research',
        trust: 'system',
        sourcePath: 'D:\\presets\\research\\agent.cordis.yml',
      },
      selection: {
        provider: 'historic-provider',
        model: 'historic-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
      maxTokens: 2048,
    })
    expect(opened[0]?.seed.map(event => event.type)).toEqual([
      'turn/start',
      'request/header',
      'turn/end',
      'agent-preset/selected',
    ])
    expect(lease.port.sessionId).toBe(opened[0]?.sessionId)
    await lease.release()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('forks a persisted delegated source without activating the source Agent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    provideComposition(ctx)
    const source = completedSession('session-cold-child', {
      cwd: 'D:\\cold',
      parentSession: SessionId('session-owner'),
      origin: 'subagent',
      delegationDepth: 2,
      agentPreset: 'research',
    })
    const inspect = vi.fn(() => Promise.resolve({
      meta: source.header,
      events: [...source.events],
    }))
    ctx.provide('sessionPersistence', { inspect } as never)
    const open = vi.fn(async (request: OpenDshForkSessionRequest) => fakePort(request.sessionId))
    const fork = new DshSessionFork(ctx, open)

    await fork.forkSession({
      sourceSessionId: source.id,
      atSeq: 1,
      signal: new AbortController().signal,
    })

    expect(inspect).toHaveBeenCalledExactlyOnceWith(
      SessionId('session-cold-child'),
      expect.any(AbortSignal),
    )
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'session-cold-child',
      cwd: 'D:\\cold',
      agentPreset: 'research',
    }))
    expect(ctx.sessions.get(SessionId('session-cold-child'))).toBeUndefined()
  })

  it('rejects unavailable and mismatched cold sources', async () => {
    const missing = new Context()
    contexts.push(missing)
    await missing.plugin(SessionStore)
    provideComposition(missing)
    const missingFork = new DshSessionFork(missing, async request => fakePort(request.sessionId))
    await expect(missingFork.forkSession({
      sourceSessionId: 'missing',
      signal: new AbortController().signal,
    })).rejects.toThrow('persistence service is unavailable')

    const mismatch = new Context()
    contexts.push(mismatch)
    await mismatch.plugin(SessionStore)
    provideComposition(mismatch)
    const other = completedSession('other')
    mismatch.provide('sessionPersistence', {
      inspect: () => Promise.resolve({ meta: other.header, events: other.events }),
    } as never)
    const mismatchFork = new DshSessionFork(
      mismatch,
      async request => fakePort(request.sessionId),
    )
    await expect(mismatchFork.forkSession({
      sourceSessionId: 'requested',
      signal: new AbortController().signal,
    })).rejects.toThrow('returned "other" for "requested"')
  })

  it('rolls back a child published as cancellation wins handoff', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    provideComposition(ctx)
    const source = ctx.sessions.create(SessionId('session-source'))
    source.append('turn/start', { turn: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const abort = new AbortController()
    const dispose = vi.fn(() => Promise.resolve())
    const fork = new DshSessionFork(ctx, async request => {
      abort.abort(new Error('cancelled after publication'))
      return fakePort(request.sessionId, dispose)
    })

    await expect(fork.forkSession({
      sourceSessionId: source.id,
      signal: abort.signal,
    })).rejects.toThrow('cancelled after publication')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('aggregates a failed cancellation rollback with the abort reason', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    provideComposition(ctx)
    const source = ctx.sessions.create(SessionId('session-source'))
    source.append('turn/start', { turn: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const abort = new AbortController()
    const fork = new DshSessionFork(ctx, async request => {
      abort.abort(new Error('cancelled after publication'))
      return fakePort(request.sessionId, vi.fn(() => Promise.reject(
        new Error('child dispose failed'),
      )))
    })

    const failure = await fork.forkSession({
      sourceSessionId: source.id,
      signal: abort.signal,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toContain('cancellation rollback failed')
    expect((failure as AggregateError).errors.map(String).join('\n')).toContain(
      'cancelled after publication',
    )
    expect((failure as AggregateError).errors.map(String).join('\n')).toContain(
      'child dispose failed',
    )
  })

  it('preserves persistence failures unless inspection observes cancellation', async () => {
    const failed = new Context()
    contexts.push(failed)
    await failed.plugin(SessionStore)
    provideComposition(failed)
    failed.provide('sessionPersistence', {
      inspect: () => Promise.reject(new Error('inspection failed')),
    } as never)
    await expect(new DshSessionFork(
      failed,
      async request => fakePort(request.sessionId),
    ).forkSession({
      sourceSessionId: 'cold-source',
      signal: new AbortController().signal,
    })).rejects.toThrow('inspection failed')

    const cancelled = new Context()
    contexts.push(cancelled)
    await cancelled.plugin(SessionStore)
    provideComposition(cancelled)
    const abort = new AbortController()
    cancelled.provide('sessionPersistence', {
      inspect: () => {
        abort.abort(new Error('inspection cancelled'))
        return Promise.reject(new Error('storage transport failed'))
      },
    } as never)
    await expect(new DshSessionFork(
      cancelled,
      async request => fakePort(request.sessionId),
    ).forkSession({
      sourceSessionId: 'cold-source',
      signal: abort.signal,
    })).rejects.toThrow('inspection cancelled')
  })

  it('fails closed when the official default model has no current selection', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    const source = ctx.sessions.create(SessionId('session-source'))
    source.append('turn/start', { turn: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => undefined,
    } as never)
    ctx.provide('agentPresets', {
      defaultId: 'standard',
      resolve: async (id?: string) => preset(id ?? 'standard'),
    } as never)

    await expect(new DshSessionFork(
      ctx,
      async request => fakePort(request.sessionId),
    ).forkSession({
      sourceSessionId: source.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('model selection is unavailable')
  })

  it('requires the official composition and Session services', async () => {
    const missingSession = new Context()
    contexts.push(missingSession)
    provideComposition(missingSession)
    await expect(new DshSessionFork(
      missingSession,
      async request => fakePort(request.sessionId),
    ).forkSession({
      sourceSessionId: 'source',
      signal: new AbortController().signal,
    })).rejects.toThrow('Session service is unavailable')

    const missingComposition = new Context()
    contexts.push(missingComposition)
    await missingComposition.plugin(SessionStore)
    const source = missingComposition.sessions.create(SessionId('source'))
    source.append('turn/start', { turn: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(new DshSessionFork(
      missingComposition,
      async request => fakePort(request.sessionId),
    ).forkSession({
      sourceSessionId: source.id,
      signal: new AbortController().signal,
    })).rejects.toThrow('Preset/default-model services are unavailable')
  })
})
