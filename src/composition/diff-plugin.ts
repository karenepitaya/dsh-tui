import type { Context } from '@deepseek-ai/cordis'
import { registerDshTuiExtensionFeature } from '../adapters/cordis-feature-service.ts'
import { diffFeature } from '../features/diff/factory.ts'

export const name = 'dsh-tui-diff'
export const inject = ['dshTuiFeatures']

/** Register the optional Diff workspace behind this row's Cordis fiber. */
export function apply(ctx: Context): void {
  registerDshTuiExtensionFeature(ctx, ctx.dshTuiFeatures, diffFeature)
}

export { diffFeature }
