import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { provideDshTuiFeatures } from '../src/adapters/cordis-feature-service.ts'
import {
  apply as applyKernel,
  inject as kernelInject,
  name as kernelName,
  provide as kernelProvide,
} from '../src/adapters/cordis.ts'
import {
  apply as applyDshRc2,
  inject as dshRc2Inject,
  mountDshTuiDshRc2Adapter,
  name as dshRc2Name,
  provide as dshRc2Provide,
} from '../src/adapters/dsh-rc2.ts'
import { DshSettingsCatalog } from '../src/dsh/settings-catalog.ts'
import {
  SESSIONS_WORKSPACE_CAPABILITY,
  type SessionsWorkspacePort,
} from '../src/features/sessions/port.ts'
import {
  FEATURE_API_VERSION,
  type FeatureFactory,
} from '../src/kernel/feature.ts'
import {
  claimDshTuiComposition,
  createDshTuiCompositionOwner,
  ROOT_COMPOSITION_OWNER_ID,
} from '../src/composition/ownership.ts'

function provideRequiredDshRc2Services(ctx: Context): void {
  ctx.provide('agentDefaultModel', {
    currentSelection: () => undefined,
  } as never)
  ctx.provide('agentPresets', {
    defaultId: 'standard',
    list: async () => [],
  } as never)
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('approval', {} as never)
  ctx.provide('commands', {} as never)
  ctx.provide('llm', {} as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('tools', {} as never)
  ctx.provide('userQuestions', {
    registerProvider: () => () => {},
  } as never)
}

function eagerFeature(id: string, create: FeatureFactory['create']): FeatureFactory {
  return {
    manifest: {
      id,
      apiVersion: FEATURE_API_VERSION,
      scope: 'application',
      activation: 'eager',
      required: false,
      requires: [],
    },
    create,
  }
}

describe('Cordis kernel row', () => {
  it('exports a dependency-free service row', () => {
    expect(kernelName).toBe('dsh-tui-kernel')
    expect(kernelInject).toEqual([])
    expect(kernelProvide).toBe('dshTuiFeatures')
  })

  it('provides isolated inert kernels and revokes them with each row fiber', async () => {
    const first = new Context()
    const second = new Context()
    const firstRow = first.plugin({
      name: kernelName,
      inject: kernelInject,
      provide: kernelProvide,
      apply: applyKernel,
    })
    const secondRow = second.plugin({
      name: kernelName,
      inject: kernelInject,
      provide: kernelProvide,
      apply: applyKernel,
    })
    await Promise.all([firstRow, secondRow])

    const firstService = first.get('dshTuiFeatures')
    const secondService = second.get('dshTuiFeatures')
    expect(firstService).toBeDefined()
    expect(secondService).toBeDefined()
    expect(first.get('dshTuiCompositionOwnership')?.mode).toBe('split')
    expect(second.get('dshTuiCompositionOwnership')?.mode).toBe('split')

    const create = vi.fn(() => ({ contributions: {}, dispose() {} }))
    firstService?.registerFeature(eagerFeature('test.kernel.inert', create))
    expect(create).not.toHaveBeenCalled()
    expect(firstService?.status('test.kernel.inert')).toEqual({
      featureId: 'test.kernel.inert',
      state: 'inactive',
    })
    expect(secondService?.status('test.kernel.inert')).toBeUndefined()

    await firstRow.dispose()
    expect(first.get('dshTuiFeatures')).toBeUndefined()
    expect(first.get('dshTuiCompositionOwnership')).toBeUndefined()
    expect(second.get('dshTuiFeatures')).toBeDefined()

    await secondRow.dispose()
    expect(second.get('dshTuiFeatures')).toBeUndefined()
    expect(second.get('dshTuiCompositionOwnership')).toBeUndefined()
    await Promise.all([first.fiber.dispose(), second.fiber.dispose()])
  })

  it('accepts only an idempotent claim from the same semantic owner', async () => {
    const ctx = new Context()
    const owner = createDshTuiCompositionOwner(ROOT_COMPOSITION_OWNER_ID)
    const first = claimDshTuiComposition(ctx, 'root', owner)

    expect(
      claimDshTuiComposition(ctx, 'root', owner),
    ).toBe(first)
    expect(() => claimDshTuiComposition(
      ctx,
      'root',
      createDshTuiCompositionOwner('test.other-root'),
    )).toThrow(
      'composition ownership conflict: existing=root:dsh-tui.root, requested=root:test.other-root',
    )
    expect(() => claimDshTuiComposition(
      ctx,
      'root',
      createDshTuiCompositionOwner(ROOT_COMPOSITION_OWNER_ID),
    )).toThrow('composition ownership conflict')

    await ctx.fiber.dispose()
  })
})

describe('DSH rc.2 adapter row', () => {
  it('exports only the services required to construct the runtime adapter', () => {
    expect(dshRc2Name).toBe('dsh-tui-dsh-rc2')
    expect(dshRc2Inject).toEqual([
      'dshTuiFeatures',
      'agentDefaultModel',
      'agentPresets',
      'agents',
      'approval',
      'commands',
      'llm',
      'sessions',
      'tools',
      'userQuestions',
    ])
    expect(dshRc2Inject).not.toContain('sessionQuery')
    expect(dshRc2Provide).toBe('dshTui')
  })

  it('provides an unavailable catalog without SessionQuery and disposes with its fiber', async () => {
    const ctx = new Context()
    provideRequiredDshRc2Services(ctx)
    const kernelRow = ctx.plugin({
      name: kernelName,
      inject: kernelInject,
      provide: kernelProvide,
      apply: applyKernel,
    })
    await kernelRow
    const features = ctx.get('dshTuiFeatures')!
    let workspace!: SessionsWorkspacePort
    const disposeConsumer = vi.fn()
    const consumer = features.registerFeature({
      manifest: {
        id: 'test.sessions-workspace-consumer',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [SESSIONS_WORKSPACE_CAPABILITY],
      },
      create: ({ dependencies }) => {
        workspace = dependencies[0]!.value
        return { contributions: {}, dispose: disposeConsumer }
      },
    })
    const disposeSettings = vi.spyOn(DshSettingsCatalog.prototype, 'disposeSettings')
    const row = ctx.plugin({
      name: dshRc2Name,
      inject: dshRc2Inject,
      provide: dshRc2Provide,
      apply: applyDshRc2,
    })
    await row

    const runtime = ctx.get('dshTui')
    expect(runtime).toBeDefined()
    await expect(features.start()).resolves.toMatchObject([{
      featureId: 'test.sessions-workspace-consumer',
      state: 'active',
    }])
    expect(workspace).toEqual({
      catalog: runtime?.catalog,
      inspection: runtime?.inspection,
      activation: runtime?.activation,
      fork: runtime?.fork,
    })
    await expect(runtime?.catalog.listSessions()).resolves.toEqual({
      durability: 'unavailable',
      sessions: [],
    })

    await row.dispose()
    expect(ctx.get('dshTui')).toBeUndefined()
    expect(disposeSettings).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(features.status('test.sessions-workspace-consumer')).toMatchObject({
      state: 'unavailable',
    }))
    expect(disposeConsumer).toHaveBeenCalledOnce()
    await consumer.release()
    await kernelRow.dispose()
    await ctx.fiber.dispose()
  })

  it('revokes the external Sessions capability before disposing its runtime owner', async () => {
    const ctx = new Context()
    provideRequiredDshRc2Services(ctx)
    const features = provideDshTuiFeatures(ctx)
    const mount = mountDshTuiDshRc2Adapter(ctx, features.service, 'external')
    const runtimeDisposals: boolean[] = []
    vi.spyOn(
      mount.service.settings as DshSettingsCatalog,
      'disposeSettings',
    ).mockImplementation(async () => {
      runtimeDisposals.push(mount.sessionsWorkspace.active)
    })

    await mount.dispose()
    expect(runtimeDisposals).toEqual([false])
    expect(mount.sessionsWorkspace.active).toBe(false)

    await features.dispose()
    await ctx.fiber.dispose()
  })

  it('isolates Sessions capability invalidation between two Cordis contexts', async () => {
    const contexts = [new Context(), new Context()] as const
    for (const ctx of contexts) provideRequiredDshRc2Services(ctx)
    const kernels = contexts.map(ctx => ctx.plugin({
      name: kernelName,
      inject: kernelInject,
      provide: kernelProvide,
      apply: applyKernel,
    }))
    await Promise.all(kernels)

    const featureIds = ['test.sessions.first', 'test.sessions.second'] as const
    const featureServices = contexts.map(ctx => ctx.get('dshTuiFeatures')!)
    const registrations = featureServices.map((features, index) => features.registerFeature({
      manifest: {
        id: featureIds[index]!,
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [SESSIONS_WORKSPACE_CAPABILITY],
      },
      create: () => ({ contributions: {}, dispose() {} }),
    }))
    const rows = contexts.map(ctx => ctx.plugin({
      name: dshRc2Name,
      inject: dshRc2Inject,
      provide: dshRc2Provide,
      apply: applyDshRc2,
    }))
    await Promise.all(rows)
    await Promise.all(featureServices.map(features => features.start()))
    const firstFeatures = featureServices[0]!
    const secondFeatures = featureServices[1]!
    expect(firstFeatures.status(featureIds[0])).toMatchObject({ state: 'active' })
    expect(secondFeatures.status(featureIds[1])).toMatchObject({ state: 'active' })

    await rows[0]!.dispose()
    await vi.waitFor(() => expect(firstFeatures.status(featureIds[0])).toMatchObject({
      state: 'unavailable',
    }))
    expect(secondFeatures.status(featureIds[1])).toMatchObject({ state: 'active' })
    expect(contexts[1].get('dshTui')).toBeDefined()

    await rows[1]!.dispose()
    await Promise.all(registrations.map(registration => registration.release()))
    await Promise.all(kernels.map(kernel => kernel.dispose()))
    await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
  })
})
