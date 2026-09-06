import type { Context } from '@deepseek-ai/cordis'
import { registerDshTuiExtensionFeature } from '../adapters/cordis-feature-service.ts'
import { toolsFeature } from '../features/tools/factory.ts'

export const name = 'dsh-tui-tools'
export const inject = ['dshTuiFeatures']

/** Register the optional Tools workspace behind this row's Cordis fiber. */
export function apply(ctx: Context): void {
  registerDshTuiExtensionFeature(ctx, ctx.dshTuiFeatures, toolsFeature)
}

export { toolsFeature }
