import type { Context } from '@deepseek-ai/cordis'
import { registerDshTuiExtensionFeature } from '../adapters/cordis-feature-service.ts'
import { modelsFeature } from '../features/models/factory.ts'

export const name = 'dsh-tui-models'
export const inject = ['dshTuiFeatures']

/** Register the optional Models workspace behind this row's Cordis fiber. */
export function apply(ctx: Context): void {
  registerDshTuiExtensionFeature(ctx, ctx.dshTuiFeatures, modelsFeature)
}

export { modelsFeature }
