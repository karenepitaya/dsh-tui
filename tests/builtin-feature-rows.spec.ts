import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  provideDshTuiFeatures,
  registerDshTuiExtensionFeature,
} from '../src/adapters/cordis-feature-service.ts'
import {
  apply as applyDiff,
  inject as diffInject,
  name as diffName,
} from '../src/features/diff-entry.ts'
import {
  apply as applyMcp,
  inject as mcpInject,
  name as mcpName,
} from '../src/features/mcp-entry.ts'
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
  apply as applySessions,
  inject as sessionsInject,
  name as sessionsName,
} from '../src/features/sessions-entry.ts'
import {
  apply as applySettings,
  inject as settingsInject,
  name as settingsName,
} from '../src/features/settings-entry.ts'
import {
  apply as applySkills,
  inject as skillsInject,
  name as skillsName,
} from '../src/features/skills-entry.ts'
import {
  apply as applyTools,
  inject as toolsInject,
  name as toolsName,
} from '../src/features/tools-entry.ts'
import {
  apply as applyPreferences,
  inject as preferencesInject,
  name as preferencesName,
  provide as preferencesProvide,
} from '../src/adapters/preferences.ts'

describe('built-in Feature rows', () => {
  it('binds every workspace Feature registration to its own row fiber', async () => {
    const root = new Context()
    const features = provideDshTuiFeatures(root)
    const sessionsRow = root.plugin({
      name: sessionsName,
      inject: sessionsInject,
      apply: applySessions,
    })
    const diffRow = root.plugin({
      name: diffName,
      inject: diffInject,
      apply: applyDiff,
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
    const skillsRow = root.plugin({
      name: skillsName,
      inject: skillsInject,
      apply: applySkills,
    })
    const toolsRow = root.plugin({
      name: toolsName,
      inject: toolsInject,
      apply: applyTools,
    })
    const mcpRow = root.plugin({
      name: mcpName,
      inject: mcpInject,
      apply: applyMcp,
    })
    const settingsRow = root.plugin({
      name: settingsName,
      inject: settingsInject,
      apply: applySettings,
    })
    await Promise.all([
      sessionsRow,
      diffRow,
      modelsRow,
      modesRow,
      skillsRow,
      toolsRow,
      mcpRow,
      settingsRow,
    ])

    for (const featureId of [
      'sessions', 'diff', 'models', 'modes', 'skills', 'tools', 'mcp', 'settings',
    ]) {
      expect(features.service.status(featureId)).toEqual({
        featureId,
        state: 'inactive',
      })
    }
    expect(features.service.listRegisteredFeatures().map(
      snapshot => snapshot.manifest.id,
    )).toEqual([
      'sessions', 'diff', 'models', 'modes', 'skills', 'tools', 'mcp', 'settings',
    ])

    await modelsRow.dispose()
    expect(features.service.status('models')).toBeUndefined()
    expect(features.service.status('sessions')).toEqual({
      featureId: 'sessions',
      state: 'inactive',
    })

    await Promise.all([
      skillsRow.dispose(),
      settingsRow.dispose(),
      mcpRow.dispose(),
      toolsRow.dispose(),
      modesRow.dispose(),
      diffRow.dispose(),
      sessionsRow.dispose(),
    ])
    for (const featureId of [
      'sessions', 'diff', 'models', 'modes', 'skills', 'tools', 'mcp', 'settings',
    ]) {
      expect(features.service.status(featureId)).toBeUndefined()
    }
    await features.dispose()
    await root.fiber.dispose()
  })

  it('publishes Preferences and resolves Settings through one application capability owner', async () => {
    const root = new Context()
    const features = provideDshTuiFeatures(root)
    const preferencesRow = root.plugin({
      name: preferencesName,
      inject: preferencesInject,
      provide: preferencesProvide,
      apply: applyPreferences,
    })
    const settingsRow = root.plugin({
      name: settingsName,
      inject: settingsInject,
      apply: applySettings,
    })
    await Promise.all([preferencesRow, settingsRow])

    expect(root.get('dshTuiPreferences')).toBeDefined()
    await expect(features.service.activateRoute('preferences')).resolves.toContainEqual({
      featureId: 'settings',
      state: 'active',
    })

    await settingsRow.dispose()
    await preferencesRow.dispose()
    expect(features.service.status('settings')).toBeUndefined()
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
