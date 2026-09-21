import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  provideDshTuiFeatures,
  registerDshTuiExtensionFeature,
} from '../src/adapters/cordis-feature-service.ts'
import {
  apply as applyCapabilities,
  inject as capabilitiesInject,
  name as capabilitiesName,
} from '../src/features/capabilities-entry.ts'
import {
  apply as applyModels,
  inject as modelsInject,
  name as modelsName,
} from '../src/features/models-entry.ts'
import {
  apply as applyModes,
  inject as modesInject,
  name as modesName,
} from '../src/features/modes-entry.ts'
import { legacyChatFeature } from '../src/features/legacy-chat.ts'
import { sessionsFeature } from '../src/features/sessions/factory.ts'
import {
  apply as applyActivity,
  inject as activityInject,
  name as activityName,
} from '../src/features/activity-entry.ts'
import {
  apply as applySessions,
  inject as sessionsInject,
  name as sessionsName,
} from '../src/features/sessions-entry.ts'

describe('built-in Feature rows', () => {
  it('binds every workspace Feature registration to its own row fiber', async () => {
    const root = new Context()
    const features = provideDshTuiFeatures(root)
    const sessionsRow = root.plugin({
      name: sessionsName,
      inject: sessionsInject,
      apply: applySessions,
    })
    const activityRow = root.plugin({
      name: activityName,
      inject: activityInject,
      apply: applyActivity,
    })
    const modelsRow = root.plugin({
      name: modelsName,
      inject: modelsInject,
      apply: applyModels,
    })
    const modesRow = root.plugin({
      name: modesName,
      inject: modesInject,
      apply: applyModes,
    })
    const capabilitiesRow = root.plugin({
      name: capabilitiesName,
      inject: capabilitiesInject,
      apply: applyCapabilities,
    })
    await Promise.all([
      sessionsRow,
      activityRow,
      modelsRow,
      modesRow,
      capabilitiesRow,
    ])

    for (const featureId of [
      'sessions', 'activity', 'models', 'modes', 'capabilities',
    ]) {
      expect(features.service.status(featureId)).toEqual({
        featureId,
        state: 'inactive',
      })
    }
    expect(features.service.listRegisteredFeatures().map(
      snapshot => snapshot.manifest.id,
    )).toEqual([
      'sessions', 'activity', 'models', 'modes', 'capabilities',
    ])

    await modelsRow.dispose()
    expect(features.service.status('models')).toBeUndefined()
    expect(features.service.status('sessions')).toEqual({
      featureId: 'sessions',
      state: 'inactive',
    })

    await Promise.all([
      capabilitiesRow.dispose(),
      modesRow.dispose(),
      activityRow.dispose(),
      sessionsRow.dispose(),
    ])
    for (const featureId of [
      'sessions', 'activity', 'models', 'modes', 'capabilities',
    ]) {
      expect(features.service.status(featureId)).toBeUndefined()
    }
    await features.dispose()
    await root.fiber.dispose()
  })

  it('keeps package-owned workspace rows under extension slot authority', async () => {
    const root = new Context()
    const features = provideDshTuiFeatures(root)

    expect(() => registerDshTuiExtensionFeature(
      root,
      {} as never,
      sessionsFeature,
    )).toThrow('does not support owned extension Feature installation')
    expect(() => registerDshTuiExtensionFeature(
      root,
      features.service,
      legacyChatFeature,
      'external',
    )).toThrow(/cannot contribute to protected slot "shell\.root"/u)

    await features.dispose()
    await root.fiber.dispose()
  })

  it('supports an explicit extension lease for the serial Root owner', async () => {
    const root = new Context()
    const features = provideDshTuiFeatures(root)
    let registration!: ReturnType<typeof registerDshTuiExtensionFeature>
    const row = root.plugin({
      name: 'test-external-sessions-registration',
      apply(ctx) {
        registration = registerDshTuiExtensionFeature(
          ctx,
          features.service,
          sessionsFeature,
          'external',
        )
      },
    })
    await row

    await row.dispose()
    expect(registration.active).toBe(true)
    expect(features.service.status('sessions')).toEqual({
      featureId: 'sessions',
      state: 'inactive',
    })

    await registration.release()
    expect(registration.active).toBe(false)
    expect(features.service.status('sessions')).toBeUndefined()
    await features.dispose()
    await root.fiber.dispose()
  })
})
