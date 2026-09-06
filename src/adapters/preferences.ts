import type { Context } from '@deepseek-ai/cordis'
import {
  registerDshTuiApplicationCapability,
} from './cordis-feature-service.ts'
import {
  provideDshTuiPreferencesSettings,
  type DshTuiPreferencesSettingsOptions,
  type DshTuiPreferencesSettingsOwner,
} from '../dsh/preferences-settings.ts'
import type { CapabilityRegistrationLease } from '../kernel/capability-registry.ts'
import type { DshTuiFeatureService } from '../kernel/feature-service.ts'
import {
  DSH_TUI_PREFERENCES_CAPABILITY,
  type DshTuiPreferencesApplicationPort,
} from '../preferences/port.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshTuiPreferences: DshTuiPreferencesApplicationPort
  }
}

export {
  DSH_TUI_PREFERENCES_SCHEMA,
  provideDshTuiPreferencesSettings,
  type DshTuiPreferencesSettingsOptions,
  type DshTuiPreferencesSettingsOwner,
} from '../dsh/preferences-settings.ts'
export {
  DSH_TUI_PREFERENCES_CAPABILITY,
  type DshTuiPreferencesApplicationPort,
  type DshTuiPreferencesApplicationStatus,
} from '../preferences/port.ts'

export const name = 'dsh-tui-preferences'
export const inject = ['dshTuiFeatures']
export const provide = 'dshTuiPreferences'

export type DshTuiPreferencesAdapterLifecycle = 'cordis' | 'external'

export interface DshTuiPreferencesAdapterMount extends DshTuiPreferencesSettingsOwner {
  readonly capability: CapabilityRegistrationLease
}

/** Publish the fallback-capable preference view and register its application token. */
export function apply(
  ctx: Context,
  options: DshTuiPreferencesSettingsOptions = {},
): void {
  mountDshTuiPreferencesAdapter(ctx, ctx.dshTuiFeatures, options)
}

/** Compose Preferences behind one serial owner for split and compatibility roots. */
export function mountDshTuiPreferencesAdapter(
  ctx: Context,
  features: DshTuiFeatureService,
  options: DshTuiPreferencesSettingsOptions = {},
  lifecycle: DshTuiPreferencesAdapterLifecycle = 'cordis',
): DshTuiPreferencesAdapterMount {
  let owner: DshTuiPreferencesSettingsOwner | undefined
  const capability = registerDshTuiApplicationCapability(
    ctx,
    features,
    {
      token: DSH_TUI_PREFERENCES_CAPABILITY,
      create: () => {
        if (owner === undefined) {
          throw new Error('DSH-TUI Preferences service is unavailable')
        }
        return Object.freeze({ value: owner.service, release() {} })
      },
    },
    'external',
  )
  try {
    owner = provideDshTuiPreferencesSettings(ctx, options)
  } catch (error: unknown) {
    void capability.release().catch(() => {})
    throw error
  }

  ctx.provide('dshTuiPreferences', owner.service)
  let disposeTask: Promise<void> | undefined
  const mount: DshTuiPreferencesAdapterMount = Object.freeze({
    service: owner.service,
    capability,
    dispose() {
      disposeTask ??= disposePreferences()
      return disposeTask
    },
  })
  if (lifecycle !== 'external') {
    ctx.effect(
      () => () => mount.dispose(),
      'dsh-tui-preferences: adapter owner',
    )
  }
  return mount

  async function disposePreferences(): Promise<void> {
    const errors: unknown[] = []
    try {
      await capability.release()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await owner!.dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'DSH-TUI Preferences adapter disposal failed')
    }
  }
}
