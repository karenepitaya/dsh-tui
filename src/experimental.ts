export type {} from '@deepseek-ai/cordis'
import type { DshTuiFeatureService } from './kernel/feature-service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshTuiFeatures: DshTuiFeatureService
  }
}

/**
 * Experimental extension surface. These contracts are intentionally not part
 * of the stable root API until Sessions, Diff, and a DSH upgrade have exercised
 * them end to end.
 */
export * from './kernel/index.ts'
export * from './app/feature-host.ts'
export * from './layout/slots.ts'
export * from './layout/strategy.ts'
export * from './lifecycle/effect-runner.ts'
export * from './lifecycle/machines.ts'
export * from './lifecycle/scope-manager.ts'
export * from './navigation/commands.ts'
export * from './navigation/state.ts'
export * from './preferences/codec.ts'
export * from './preferences/contracts.ts'
export * from './preferences/migrations.ts'
export * from './preferences/repository.ts'
export * from './presentation/feature-surface.ts'
export * from './resource/resource-coordinator.ts'
export * from './session/runtime-memory.ts'
