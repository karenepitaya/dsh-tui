import type { Context } from '@deepseek-ai/cordis'
import { registerDshTuiExtensionFeature } from '../adapters/cordis-feature-service.ts'
import { skillsFeature } from '../features/skills/factory.ts'

export const name = 'dsh-tui-skills'
export const inject = ['dshTuiFeatures']

/** Register the optional Skills workspace behind this row's Cordis fiber. */
export function apply(ctx: Context): void {
  registerDshTuiExtensionFeature(ctx, ctx.dshTuiFeatures, skillsFeature)
}

export { skillsFeature }
