import type { Context } from '@deepseek-ai/cordis'
import { registerDshTuiExtensionFeature } from '../adapters/cordis-feature-service.ts'
import { modesFeature } from '../features/modes/factory.ts'

export const name = 'dsh-tui-modes'
export const inject = ['dshTuiFeatures']

/** Register the optional Modes workspace behind this row's Cordis fiber. */
export function apply(ctx: Context): void {
  registerDshTuiExtensionFeature(ctx, ctx.dshTuiFeatures, modesFeature)
}

export { modesFeature }
