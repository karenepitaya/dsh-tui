import type { Context } from '@deepseek-ai/cordis'
import { registerDshTuiExtensionFeature } from '../adapters/cordis-feature-service.ts'
import { activityFeature } from '../features/activity/factory.ts'

export const name = 'dsh-tui-activity'
export const inject = ['dshTuiFeatures']

/** Register the optional Activity workspace behind this row's Cordis fiber. */
export function apply(ctx: Context): void {
  registerDshTuiExtensionFeature(ctx, ctx.dshTuiFeatures, activityFeature)
}

export { activityFeature }
