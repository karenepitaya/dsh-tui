import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { DshAgentPresetCatalog } from '../src/dsh/agent-preset-catalog.ts'
import type { AgentPresetCatalogSnapshot } from '../src/preset/catalog-port.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function expectDeeplyFrozen(snapshot: AgentPresetCatalogSnapshot): void {
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(snapshot.presets)).toBe(true)
  expect(snapshot.presets.every(Object.isFrozen)).toBe(true)
}

describe('official DSH agent preset catalog adapter', () => {
  it('fails clearly when the AgentPresets service is unavailable', () => {
    const ctx = new Context()
    contexts.push(ctx)

    expect(() => new DshAgentPresetCatalog(ctx)).toThrow(
      'DSH AgentPresets service is unavailable',
    )
  })

  it('returns a detached, deeply frozen snapshot in official roster order', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    let defaultId = 'minimal'
    let roster: AgentPreset[] = [{
      id: 'custom',
      trust: 'user',
      path: 'D:\\DSH\\.agent-presets\\custom\\agent.cordis.yml',
      name: 'Custom',
      description: 'Local composition',
      broken: 'composition is not valid YAML',
    }, {
      id: 'minimal',
      trust: 'system',
      path: 'D:\\DSH\\presets\\minimal\\agent.cordis.yml',
    }]
    const list = vi.fn(async () => roster)
    ctx.provide('agentPresets', {
      get defaultId() { return defaultId },
      list,
    } as never)
    const catalog = new DshAgentPresetCatalog(ctx)

    const first = await catalog.listPresets()

    expect(first).toEqual({
      defaultId: 'minimal',
      presets: [{
        id: 'custom',
        trust: 'user',
        name: 'Custom',
        description: 'Local composition',
        broken: 'composition is not valid YAML',
        sourcePath: 'D:\\DSH\\.agent-presets\\custom\\agent.cordis.yml',
        isDefault: false,
      }, {
        id: 'minimal',
        trust: 'system',
        sourcePath: 'D:\\DSH\\presets\\minimal\\agent.cordis.yml',
        isDefault: true,
      }],
    })
    expectDeeplyFrozen(first)
    expect(first.presets).not.toBe(roster)
    expect(first.presets[0]).not.toBe(roster[0])

    ;(roster[0] as { name?: string }).name = 'Changed after projection'
    defaultId = 'missing-default'
    roster = [roster[1]!, roster[0]!]

    expect(first.presets[0]?.name).toBe('Custom')
    await expect(catalog.listPresets()).resolves.toEqual({
      defaultId: 'missing-default',
      presets: [{
        id: 'minimal',
        trust: 'system',
        sourcePath: 'D:\\DSH\\presets\\minimal\\agent.cordis.yml',
        isDefault: false,
      }, {
        id: 'custom',
        trust: 'user',
        name: 'Changed after projection',
        description: 'Local composition',
        broken: 'composition is not valid YAML',
        sourcePath: 'D:\\DSH\\.agent-presets\\custom\\agent.cordis.yml',
        isDefault: false,
      }],
    })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('checks cancellation before and after the asynchronous official read', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const listing = Promise.withResolvers<AgentPreset[]>()
    const list = vi.fn(() => listing.promise)
    let defaultReads = 0
    ctx.provide('agentPresets', {
      get defaultId() {
        defaultReads += 1
        return 'standard'
      },
      list,
    } as never)
    const catalog = new DshAgentPresetCatalog(ctx)

    const before = new AbortController()
    const beforeReason = { kind: 'cancel-before' }
    before.abort(beforeReason)
    await catalog.listPresets({ signal: before.signal }).then(
      () => { throw new Error('expected pre-aborted catalog read to reject') },
      error => { expect(error).toBe(beforeReason) },
    )
    expect(defaultReads).toBe(0)
    expect(list).not.toHaveBeenCalled()

    const during = new AbortController()
    const operation = catalog.listPresets({ signal: during.signal })
    expect(defaultReads).toBe(1)
    expect(list).toHaveBeenCalledOnce()
    const duringReason = { kind: 'cancel-during' }
    during.abort(duringReason)
    listing.resolve([])
    await operation.then(
      () => { throw new Error('expected post-aborted catalog read to reject') },
      error => { expect(error).toBe(duringReason) },
    )
  })

  it('propagates an official roster failure without inventing a fallback', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const failure = { kind: 'preset-root-unreadable' }
    ctx.provide('agentPresets', {
      defaultId: 'standard',
      list: vi.fn(() => Promise.reject(failure)),
    } as never)
    const catalog = new DshAgentPresetCatalog(ctx)

    await catalog.listPresets().then(
      () => { throw new Error('expected listPresets to reject') },
      error => { expect(error).toBe(failure) },
    )
  })
})
