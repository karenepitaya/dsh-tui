import type { Context } from '@deepseek-ai/cordis'
import { provideDshTuiFeatures } from './cordis-feature-service.ts'
import type { DshTuiFeatureService } from '../kernel/feature-service.ts'
import {
  claimDshTuiComposition,
  createDshTuiCompositionOwner,
  SPLIT_COMPOSITION_OWNER_ID,
} from '../composition/ownership.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshTuiFeatures: DshTuiFeatureService
  }
}

/** Cordis ownership adapter for the app-scoped DSH-TUI microkernel. */
export {
  CordisDshTuiFeatureService,
  provideDshTuiFeatures,
} from './cordis-feature-service.ts'
export type {
  DshTuiFeatureOwner,
  DshTuiFeatureServiceOptions,
} from './cordis-feature-service.ts'

export const name = 'dsh-tui-kernel'
export const inject = []
export const provide = 'dshTuiFeatures'

/** Publish a dormant kernel; the Product owns the explicit start boundary. */
export function apply(ctx: Context): void {
  claimDshTuiComposition(
    ctx,
    'split',
    createDshTuiCompositionOwner(SPLIT_COMPOSITION_OWNER_ID),
  )
  const owner = provideDshTuiFeatures(ctx)
  ctx.effect(
    () => () => owner.dispose(),
    'dsh-tui-kernel: feature owner',
  )
}
