import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StandaloneApplicationScopeHost } from '../src/lifecycle/application-scope-host.ts'

const mocked = vi.hoisted(() => ({
  createStandalone: vi.fn(),
}))

vi.mock('../src/lifecycle/application-scope-host.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lifecycle/application-scope-host.ts')>(),
  createStandaloneApplicationScopeHost: mocked.createStandalone,
}))

import { openDshRuntimePort } from '../src/dsh/runtime-port.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  mocked.createStandalone.mockReset()
})

describe('standalone DSH runtime rollback', () => {
  it('aggregates scope disposal failure with the primary open failure', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('tools', { schemas: () => [] } as never)
    const scopeFailure = new Error('standalone scope disposal failed')
    const dispose = vi.fn(async () => { throw scopeFailure })
    mocked.createStandalone.mockReturnValue({
      appScope: Object.freeze({}),
      createRuntimeSessionScope: vi.fn(() => Object.freeze({})),
      dispose,
    } as unknown as StandaloneApplicationScopeHost)

    const failure = await openDshRuntimePort(ctx, {
      mode: 'create',
      sessionId: 'standalone-scope-failure',
      selection: { provider: 'test', model: 'test' },
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({
      name: 'AggregateError',
      message: 'DSH runtime Agent bootstrap and scope rollback failed',
      errors: [
        expect.objectContaining({
          message: 'DSH Agent/Session/Preset services are unavailable',
        }),
        scopeFailure,
      ],
    })
    expect(dispose).toHaveBeenCalledExactlyOnceWith('DSH runtime port open failed')
  })
})
