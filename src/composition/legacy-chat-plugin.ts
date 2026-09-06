import type { Context } from '@deepseek-ai/cordis'
import { registerDshTuiCoreFeature } from '../adapters/cordis-feature-service.ts'
import { legacyChatFeature } from '../features/legacy-chat.ts'

export interface DshTuiLegacyChatMount {
  readonly featureId: 'legacy.chat'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshTuiLegacyChat: DshTuiLegacyChatMount
  }
}

export const name = 'dsh-tui-legacy-chat'
export const inject = ['dshTuiFeatures']
export const provide = 'dshTuiLegacyChat'

/** Register the package-owned Chat strangler before publishing its boot marker. */
export function apply(ctx: Context): void {
  registerDshTuiCoreFeature(ctx, ctx.dshTuiFeatures, legacyChatFeature)
  ctx.provide('dshTuiLegacyChat', Object.freeze({ featureId: 'legacy.chat' }))
}

export { legacyChatFeature }
