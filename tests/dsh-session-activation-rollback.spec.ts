import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourceScope } from '../src/lifecycle/scope-manager.ts'
import type { DshSessionPortComposer } from '../src/dsh/session-port-composer.ts'

const mocked = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  installIsolation: vi.fn(),
}))

vi.mock('../src/dsh/runtime-port.ts', () => ({
  DshAgentRuntimePort: function MockDshAgentRuntimePort(...args: unknown[]) {
    return mocked.createRuntime(...args)
  },
  installPresetProfileIsolation: mocked.installIsolation,
}))

import { DshLiveSessionActivation } from '../src/dsh/session-activation.ts'

function activationContext(sessionId: string): {
  readonly ctx: Context
  readonly agent: Agent
} {
  const session = Session.create(SessionId(sessionId))
  const agent = { id: session.id, session } as unknown as Agent
  const agents = {
    get: vi.fn(() => agent),
    roots: vi.fn(() => [agent]),
  }
  const sessions = { get: vi.fn(() => session) }
  const ctx = {
    get: (name: string) => name === 'agents'
      ? agents
      : name === 'sessions'
        ? sessions
        : undefined,
  } as unknown as Context
  return { ctx, agent }
}

describe('live Session activation rollback ownership', () => {
  beforeEach(() => {
    mocked.createRuntime.mockReset()
    mocked.installIsolation.mockReset()
    mocked.installIsolation.mockReturnValue(vi.fn())
  })

  it('leaves rollback to the composer after legacy completion starts', async () => {
    const { ctx, agent } = activationContext('completion-started')
    const runtime = { dispose: vi.fn(async () => {}) }
    mocked.createRuntime.mockReturnValue(runtime)
    const ownedScope = { dispose: vi.fn(async () => {}) } as unknown as ResourceScope
    const prepared = Object.freeze({ core: Object.freeze({}), capabilities: Object.freeze({}) })
    const completionFailure = new Error('legacy projection failed')
    const composer = {
      createSessionScope: vi.fn(() => ownedScope),
      prepare: vi.fn(async (exactAgent: Agent) => {
        expect(exactAgent).toBe(agent)
        return prepared
      }),
      complete: vi.fn(async () => { throw completionFailure }),
      release: vi.fn(async () => {}),
    } as unknown as DshSessionPortComposer

    await expect(new DshLiveSessionActivation(ctx, composer).activateSession({
      intent: 'attach-live',
      sessionId: 'completion-started',
      signal: new AbortController().signal,
    })).rejects.toBe(completionFailure)

    expect(composer.release).not.toHaveBeenCalled()
    expect(ownedScope.dispose).not.toHaveBeenCalled()
    expect(runtime.dispose).not.toHaveBeenCalled()
  })

  it('aggregates scope and runtime failures before completion owns rollback', async () => {
    const { ctx } = activationContext('pre-completion-failure')
    const primary = new Error('prepare failed')
    const scopeFailure = new Error('session scope cleanup failed')
    const runtimeFailure = new Error('borrowed runtime cleanup failed')
    const runtime = {
      dispose: vi.fn(async () => { throw runtimeFailure }),
    }
    mocked.createRuntime.mockReturnValue(runtime)
    const ownedScope = {
      dispose: vi.fn(async () => { throw scopeFailure }),
    } as unknown as ResourceScope
    const composer = {
      createSessionScope: vi.fn(() => ownedScope),
      prepare: vi.fn(async () => { throw primary }),
      complete: vi.fn(),
      release: vi.fn(),
    } as unknown as DshSessionPortComposer

    await expect(new DshLiveSessionActivation(ctx, composer).activateSession({
      intent: 'attach-live',
      sessionId: 'pre-completion-failure',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'DSH live activation and rollback failed',
      errors: [primary, scopeFailure, runtimeFailure],
    })
    expect(ownedScope.dispose).toHaveBeenCalledWith('DSH live activation failed')
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })
})
