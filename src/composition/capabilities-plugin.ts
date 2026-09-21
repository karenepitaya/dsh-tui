import type { Context } from '@deepseek-ai/cordis'
import { registerDshTuiExtensionFeature } from '../adapters/cordis-feature-service.ts'
import { capabilitiesFeature } from '../features/capabilities/factory.ts'

export const name = 'dsh-tui-capabilities'
export const inject = ['dshTuiFeatures']

/** Register the optional Capabilities workspace behind this row's Cordis fiber. */
export function apply(ctx: Context): void {
  registerDshTuiExtensionFeature(ctx, ctx.dshTuiFeatures, capabilitiesFeature)
}

export { capabilitiesFeature }
