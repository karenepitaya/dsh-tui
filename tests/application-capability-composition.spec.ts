import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  provideDshTuiFeatures,
  registerDshTuiApplicationCapability,
} from '../src/adapters/cordis-feature-service.ts'
import { createCapabilityToken } from '../src/kernel/capability.ts'
import {
  FEATURE_API_VERSION,
  type FeatureFactory,
} from '../src/kernel/feature.ts'

describe('composition-owned application capabilities', () => {
  it('is unavailable while missing, activates when registered, and follows its owner fiber', async () => {
    const root = new Context()
    const features = provideDshTuiFeatures(root)
    const token = createCapabilityToken<{ readonly label: string }>(
      'test.application-catalog/v1',
      'application',
    )
    const disposeFeature = vi.fn()
    const createFeature = vi.fn(() => ({
      contributions: {},
      dispose: disposeFeature,
    }))
    const feature: FeatureFactory<readonly [typeof token]> = {
      manifest: {
        id: 'test.application-capability-consumer',
        apiVersion: FEATURE_API_VERSION,
        scope: 'application',
        activation: 'eager',
        required: false,
        requires: [token],
      },
      create: createFeature,
    }
    const missingRegistration = features.service.registerFeature(feature)

    await expect(features.service.start()).resolves.toMatchObject([{
      featureId: feature.manifest.id,
      state: 'unavailable',
    }])
    expect(createFeature).not.toHaveBeenCalled()
    await missingRegistration.release()

    const releaseProvider = vi.fn()
    let capabilityRegistration!: ReturnType<typeof registerDshTuiApplicationCapability>
    const providerRow = root.plugin({
      name: 'test-application-capability-provider',
      apply(ctx) {
        capabilityRegistration = registerDshTuiApplicationCapability(
          ctx,
          features.service,
          {
            token,
            create: ({ scope }) => {
              expect(scope.kind).toBe('app')
              return {
                value: Object.freeze({ label: 'catalog' }),
                release: releaseProvider,
              }
            },
          },
        )
      },
    })
    await providerRow

    const featureRegistration = features.service.registerFeature(feature)
    await expect(featureRegistration.activation).resolves.toEqual({
      featureId: feature.manifest.id,
      state: 'active',
    })
    expect(createFeature).toHaveBeenCalledWith(expect.objectContaining({
      dependencies: [{ token, value: { label: 'catalog' } }],
    }))

    await providerRow.dispose()
    await vi.waitFor(() => expect(features.service.status(feature.manifest.id)).toMatchObject({
      featureId: feature.manifest.id,
      state: 'unavailable',
    }))
    expect(capabilityRegistration.active).toBe(false)
    expect(disposeFeature).toHaveBeenCalledOnce()
    expect(releaseProvider).toHaveBeenCalledOnce()

    await featureRegistration.release()
    await features.dispose()
    await root.fiber.dispose()
  })

  it('supports an external lease without registering another Cordis disposer', async () => {
    const root = new Context()
    const features = provideDshTuiFeatures(root)
    const token = createCapabilityToken('test.external-application/v1', 'application')
    let registration!: ReturnType<typeof registerDshTuiApplicationCapability>
    const providerRow = root.plugin({
      name: 'test-external-application-capability-provider',
      apply(ctx) {
        registration = registerDshTuiApplicationCapability(
          ctx,
          features.service,
          {
            token,
            create: () => ({ value: undefined, release() {} }),
          },
          'external',
        )
      },
    })
    await providerRow

    await providerRow.dispose()
    expect(registration.active).toBe(true)
    await registration.release()
    expect(registration.active).toBe(false)

    expect(() => registerDshTuiApplicationCapability(
      root,
      features.service,
      {
        token: createCapabilityToken('test.wrong-scope/v1', 'session'),
        create: () => ({ value: undefined, release() {} }),
      },
    )).toThrow('must declare application scope')
    expect(() => registerDshTuiApplicationCapability(
      root,
      {} as never,
      {
        token,
        create: () => ({ value: undefined, release() {} }),
      },
    )).toThrow('does not support package-owned application capabilities')

    await features.dispose()
    await root.fiber.dispose()
  })
})
