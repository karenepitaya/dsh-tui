import { describe, expect, it, vi } from 'vitest'
import { DshTuiRootResources } from '../src/composition/root-resources.ts'

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('root composition resources', () => {
  it('settles consumers before providers and reverses built-in workspace registrations', async () => {
    const product = deferred()
    const diff = deferred()
    const sessions = deferred()
    const models = deferred()
    const modes = deferred()
    const skills = deferred()
    const tools = deferred()
    const mcp = deferred()
    const settings = deferred()
    const adapter = deferred()
    const legacy = deferred()
    const preferences = deferred()
    const kernel = deferred()
    const calls: string[] = []
    const resources = new DshTuiRootResources()
    resources.product = {
      runner: {} as never,
      completion: Promise.resolve(),
      dispose: vi.fn(async () => {
        calls.push('product')
        await product.promise
      }),
    }
    resources.workspaceFeatures.push(
      {
        featureId: 'sessions',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => {
          calls.push('sessions')
          await sessions.promise
        }),
      },
      {
        featureId: 'diff',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => {
          calls.push('diff')
          await diff.promise
        }),
      },
      {
        featureId: 'models',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => {
          calls.push('models')
          await models.promise
        }),
      },
      {
        featureId: 'modes',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => {
          calls.push('modes')
          await modes.promise
        }),
      },
      {
        featureId: 'skills',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => {
          calls.push('skills')
          await skills.promise
        }),
      },
      {
        featureId: 'tools',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => {
          calls.push('tools')
          await tools.promise
        }),
      },
      {
        featureId: 'mcp',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => {
          calls.push('mcp')
          await mcp.promise
        }),
      },
      {
        featureId: 'settings',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => {
          calls.push('settings')
          await settings.promise
        }),
      },
    )
    resources.dshRc2Adapter = {
      service: {} as never,
      dispose: vi.fn(async () => {
        calls.push('adapter')
        await adapter.promise
      }),
    }
    resources.legacyChatFeature = {
      featureId: 'legacy.chat',
      active: true,
      activation: Promise.resolve(undefined),
      release: vi.fn(async () => {
        calls.push('legacy')
        await legacy.promise
      }),
    }
    resources.preferences = {
      service: {} as never,
      capability: {} as never,
      dispose: vi.fn(async () => {
        calls.push('preferences')
        await preferences.promise
      }),
    }
    resources.kernel = {
      service: {} as never,
      slotDefinitions: [],
      ready: Promise.resolve([]),
      dispose: vi.fn(async () => {
        calls.push('kernel')
        await kernel.promise
      }),
    }

    const first = resources.dispose()
    expect(resources.dispose()).toBe(first)
    await vi.waitFor(() => expect(calls).toEqual(['product']))

    product.resolve()
    await vi.waitFor(() => expect(calls).toEqual(['product', 'settings']))

    settings.resolve()
    await vi.waitFor(() => expect(calls).toEqual(['product', 'settings', 'mcp']))

    mcp.resolve()
    await vi.waitFor(() => expect(calls).toEqual([
      'product',
      'settings',
      'mcp',
      'tools',
    ]))

    tools.resolve()
    await vi.waitFor(() => expect(calls).toEqual([
      'product',
      'settings',
      'mcp',
      'tools',
      'skills',
    ]))

    skills.resolve()
    await vi.waitFor(() => expect(calls).toEqual([
      'product',
      'settings',
      'mcp',
      'tools',
      'skills',
      'modes',
    ]))

    modes.resolve()
    await vi.waitFor(() => expect(calls).toEqual([
      'product',
      'settings',
      'mcp',
      'tools',
      'skills',
      'modes',
      'models',
    ]))

    models.resolve()
    await vi.waitFor(() => expect(calls).toEqual([
      'product',
      'settings',
      'mcp',
      'tools',
      'skills',
      'modes',
      'models',
      'diff',
    ]))

    diff.resolve()
    await vi.waitFor(() => expect(calls).toEqual([
      'product',
      'settings',
      'mcp',
      'tools',
      'skills',
      'modes',
      'models',
      'diff',
      'sessions',
    ]))

    sessions.resolve()
    await vi.waitFor(() => expect(calls).toEqual([
      'product',
      'settings',
      'mcp',
      'tools',
      'skills',
      'modes',
      'models',
      'diff',
      'sessions',
      'adapter',
    ]))

    adapter.resolve()
    await vi.waitFor(() => expect(calls).toEqual([
      'product',
      'settings',
      'mcp',
      'tools',
      'skills',
      'modes',
      'models',
      'diff',
      'sessions',
      'adapter',
      'legacy',
    ]))

    legacy.resolve()
    await vi.waitFor(() => expect(calls).toEqual([
      'product',
      'settings',
      'mcp',
      'tools',
      'skills',
      'modes',
      'models',
      'diff',
      'sessions',
      'adapter',
      'legacy',
      'preferences',
    ]))

    preferences.resolve()
    await vi.waitFor(() => expect(calls).toEqual([
      'product',
      'settings',
      'mcp',
      'tools',
      'skills',
      'modes',
      'models',
      'diff',
      'sessions',
      'adapter',
      'legacy',
      'preferences',
      'kernel',
    ]))

    kernel.resolve()
    await expect(first).resolves.toBeUndefined()
  })

  it('continues the strict chain after failures and reports them together', async () => {
    const calls: string[] = []
    const resources = new DshTuiRootResources()
    resources.product = {
      runner: {} as never,
      completion: Promise.resolve(),
      dispose: vi.fn(async () => {
        calls.push('product')
        throw new Error('product failed')
      }),
    }
    resources.workspaceFeatures.push(
      {
        featureId: 'sessions',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => { calls.push('sessions') }),
      },
      {
        featureId: 'diff',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => {
          calls.push('diff')
          throw new Error('diff failed')
        }),
      },
      {
        featureId: 'models',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => { calls.push('models') }),
      },
      {
        featureId: 'modes',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => { calls.push('modes') }),
      },
      {
        featureId: 'skills',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => { calls.push('skills') }),
      },
      {
        featureId: 'tools',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => { calls.push('tools') }),
      },
      {
        featureId: 'mcp',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => { calls.push('mcp') }),
      },
      {
        featureId: 'settings',
        active: true,
        activation: Promise.resolve(undefined),
        release: vi.fn(async () => { calls.push('settings') }),
      },
    )
    resources.dshRc2Adapter = {
      service: {} as never,
      dispose: vi.fn(async () => {
        calls.push('adapter')
        throw new Error('adapter failed')
      }),
    }
    resources.legacyChatFeature = {
      featureId: 'legacy.chat',
      active: true,
      activation: Promise.resolve(undefined),
      release: vi.fn(async () => {
        calls.push('legacy')
        throw new Error('legacy failed')
      }),
    }
    resources.preferences = {
      service: {} as never,
      capability: {} as never,
      dispose: vi.fn(async () => {
        calls.push('preferences')
        throw new Error('preferences failed')
      }),
    }
    resources.kernel = {
      service: {} as never,
      slotDefinitions: [],
      ready: Promise.resolve([]),
      dispose: vi.fn(async () => { calls.push('kernel') }),
    }

    await expect(resources.dispose()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: 'product failed' }),
        expect.objectContaining({ message: 'diff failed' }),
        expect.objectContaining({ message: 'adapter failed' }),
        expect.objectContaining({ message: 'legacy failed' }),
        expect.objectContaining({ message: 'preferences failed' }),
      ],
    })
    expect(calls).toEqual([
      'product',
      'settings',
      'mcp',
      'tools',
      'skills',
      'modes',
      'models',
      'diff',
      'sessions',
      'adapter',
      'legacy',
      'preferences',
      'kernel',
    ])
  })
})
