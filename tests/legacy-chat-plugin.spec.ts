import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  CordisDshTuiFeatureService,
  provideDshTuiFeatures,
  type DshTuiFeatureOwner,
} from '../src/adapters/cordis-feature-service.ts'
import {
  apply,
  inject,
  name,
  provide,
} from '../src/composition/legacy-chat-plugin.ts'

describe('legacy Chat Cordis row', () => {
  it('registers core Chat before publishing its marker and releases both with its fiber', async () => {
    const root = new Context()
    let owner!: DshTuiFeatureOwner
    const kernel = root.plugin({
      name: 'test-dsh-tui-kernel',
      apply(ctx) {
        owner = provideDshTuiFeatures(ctx)
        ctx.effect(() => () => owner.dispose())
      },
    })
    await kernel
    expect(owner.service.status('legacy.chat')).toBeUndefined()

    const legacy = root.plugin({ name, inject, provide, apply })
    await legacy

    expect(root.get('dshTuiLegacyChat')).toEqual({ featureId: 'legacy.chat' })
    expect(owner.service.status('legacy.chat')).toEqual({
      featureId: 'legacy.chat',
      state: 'inactive',
    })
    await owner.service.start()
    expect(owner.service.status('legacy.chat')).toEqual({
      featureId: 'legacy.chat',
      state: 'active',
    })
    expect(owner.service.listActiveContributions()).toEqual([
      expect.objectContaining({
        featureId: 'legacy.chat',
        provenance: { authority: 'core', required: true },
      }),
    ])

    await legacy.dispose()
    expect(root.get('dshTuiLegacyChat')).toBeUndefined()
    expect(owner.service.status('legacy.chat')).toBeUndefined()

    await kernel.dispose()
    await root.fiber.dispose()
  })

  it('does not publish a second marker when core registration fails', async () => {
    const root = new Context()
    const service = new CordisDshTuiFeatureService(root)
    const first = root.plugin({ name, inject, provide, apply })
    await first
    const duplicate = root.plugin({ name, inject, provide, apply })

    await expect(duplicate).rejects.toThrow('already registered')
    expect(root.get('dshTuiLegacyChat')).toEqual({ featureId: 'legacy.chat' })
    expect(service.status('legacy.chat')).toEqual({
      featureId: 'legacy.chat',
      state: 'inactive',
    })

    await duplicate.dispose()
    await first.dispose()
    await service.dispose()
    await root.fiber.dispose()
  })
})
