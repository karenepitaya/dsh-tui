import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { DshPluginInventory } from '../src/dsh/plugin-inventory.ts'

function harness(entries?: () => Iterable<unknown>) {
  const loader = entries === undefined ? undefined : { entries }
  const injectionDispose = vi.fn(async () => undefined)
  const loggerError = vi.fn()
  let injectCallback: ((serviceCtx: Context) => void | (() => void)) | undefined
  let injectedRelease: (() => void) | undefined
  const ctx = {
    get: (name: string) => name === 'loader' ? loader : undefined,
    inject: (_deps: unknown, callback: (serviceCtx: Context) => void | (() => void)) => {
      injectCallback = callback
      if (loader !== undefined) {
        injectedRelease = callback({ loader } as unknown as Context) ?? undefined
      }
      return { dispose: injectionDispose }
    },
    logger: { error: loggerError },
  } as unknown as Context
  return {
    ctx,
    loader,
    injectionDispose,
    loggerError,
    releaseService: () => { injectedRelease?.() },
    injectService: (next: { entries: () => Iterable<unknown> }) => {
      const release = injectCallback?.({ loader: next } as unknown as Context)
      if (typeof release === 'function') injectedRelease = release
      return release
    },
  }
}

function context(entries?: () => Iterable<unknown>): Context {
  return harness(entries).ctx
}

describe('DSH Loader plugin inventory adapter', () => {
  it('matches the official point-in-time non-group Fiber projection', async () => {
    const adapter = new DshPluginInventory(context(() => [
      { id: 'bundle', options: { id: 'bundle', name: 'bundle', group: true } },
      {
        id: 'settings',
        disabled: false,
        options: { id: 'settings', name: '@deepseek-ai/dsh-settings-file' },
        fiber: { state: 2 },
      },
      {
        id: 'mcp:github',
        disabled: true,
        options: { id: 'github', name: '@deepseek-ai/dsh-mcp-client' },
        fiber: { state: 3 },
      },
      {
        id: 'cold',
        disabled: false,
        options: { id: 'cold', name: './cold-plugin.ts' },
      },
      { id: 'pending', disabled: false, options: { name: 'pending' }, fiber: { state: 0 } },
      { id: 'loading', disabled: false, options: { name: 'loading' }, fiber: { state: 1 } },
      { id: 'unloading', disabled: false, options: { name: 'unloading' }, fiber: { state: 5 } },
      { id: 'disposed', disabled: false, options: { name: 'disposed' }, fiber: { state: 4 } },
      { id: 'unknown', disabled: false, options: { name: 'unknown' }, fiber: { state: 99 } },
    ]))

    expect(adapter.pluginInventorySnapshot()).toEqual({
      available: true,
      entries: [
        {
          entryId: 'settings',
          moduleName: '@deepseek-ai/dsh-settings-file',
          enabled: true,
          fiberPhase: 'active',
        },
        {
          entryId: 'mcp:github',
          moduleName: '@deepseek-ai/dsh-mcp-client',
          enabled: false,
          fiberPhase: 'failed',
        },
        {
          entryId: 'cold',
          moduleName: './cold-plugin.ts',
          enabled: true,
          fiberPhase: null,
        },
        expect.objectContaining({ entryId: 'pending', fiberPhase: 'pending' }),
        expect.objectContaining({ entryId: 'loading', fiberPhase: 'loading' }),
        expect.objectContaining({ entryId: 'unloading', fiberPhase: 'unloading' }),
        expect.objectContaining({ entryId: 'disposed', fiberPhase: null }),
        expect.objectContaining({ entryId: 'unknown', fiberPhase: null }),
      ],
    })
    expect(Object.isFrozen(adapter.pluginInventorySnapshot())).toBe(true)
    expect(Object.isFrozen(adapter.pluginInventorySnapshot().entries)).toBe(true)
    await adapter.disposePluginInventory()
    expect(adapter.pluginInventorySnapshot()).toEqual({ available: false, entries: [] })
    await adapter.disposePluginInventory()
  })

  it('reports Loader absence and read failures as unavailable snapshots', async () => {
    const missing = new DshPluginInventory(context())
    expect(missing.pluginInventorySnapshot()).toEqual({ available: false, entries: [] })
    await missing.disposePluginInventory()

    const broken = new DshPluginInventory(context(() => { throw new Error('loader failed') }))
    expect(broken.pluginInventorySnapshot()).toEqual({
      available: false,
      entries: [],
      error: 'loader failed',
    })
    await broken.disposePluginInventory()
  })

  it('contains Loader replacement, stale release, and opaque failures', async () => {
    const fixture = harness(() => [{
      id: 'one',
      disabled: false,
      options: { name: 'one' },
      fiber: { state: 2 },
    }])
    const adapter = new DshPluginInventory(fixture.ctx)
    const staleRelease = fixture.injectService({
      entries: () => [{ id: 'two', disabled: false, options: { name: 'two' }, fiber: { state: 1 } }],
    })
    expect(adapter.pluginInventorySnapshot()).toMatchObject({
      available: true,
      entries: [expect.objectContaining({ entryId: 'two', fiberPhase: 'loading' })],
    })
    staleRelease?.()
    staleRelease?.()
    expect(adapter.pluginInventorySnapshot()).toEqual({ available: false, entries: [] })

    fixture.injectService({ entries: () => { throw new Error('   ') } })
    expect(adapter.pluginInventorySnapshot().error).toBe('Loader inventory failed')
    fixture.injectService({
      entries: () => {
        throw { toString: () => { throw new Error('hostile stringify') } }
      },
    })
    expect(adapter.pluginInventorySnapshot().error).toBe('Loader inventory failed')

    fixture.injectionDispose.mockRejectedValueOnce(new Error('loader injection dispose failed'))
    await adapter.disposePluginInventory()
    expect(fixture.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'loader injection dispose failed' }),
    )
  })
})
