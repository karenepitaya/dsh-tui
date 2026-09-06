import type { Context } from '@deepseek-ai/cordis'
import { registerDshTuiExtensionFeature } from '../adapters/cordis-feature-service.ts'
import { sessionsFeature } from '../features/sessions/factory.ts'

export const name = 'dsh-tui-sessions'
export const inject = ['dshTuiFeatures']

/** Register the optional Sessions workspace behind this row's Cordis fiber. */
export function apply(ctx: Context): void {
  registerDshTuiExtensionFeature(ctx, ctx.dshTuiFeatures, sessionsFeature)
}

export { sessionsFeature }
