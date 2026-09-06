import type { Context } from '@deepseek-ai/cordis'
import { registerDshTuiExtensionFeature } from '../adapters/cordis-feature-service.ts'
import { settingsFeature } from '../features/settings/factory.ts'

export const name = 'dsh-tui-settings'
export const inject = ['dshTuiFeatures']

/** Register the optional Settings workspace behind this row's Cordis fiber. */
export function apply(ctx: Context): void {
  registerDshTuiExtensionFeature(ctx, ctx.dshTuiFeatures, settingsFeature)
}

export { settingsFeature }
