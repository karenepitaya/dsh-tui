import type { DshTuiProductMount } from './product-plugin.ts'
import type { DshTuiRuntimeOwner } from '../runtime/service.ts'
import type { DshTuiFeatureRegistrationLease } from '../kernel/feature-service.ts'
import type { DshTuiFeatureOwner } from '../adapters/cordis-feature-service.ts'
import type { DshTuiPreferencesAdapterMount } from './preferences-plugin.ts'

/**
 * Explicit owner chain for the backward-compatible one-row composition.
 *
 * Cordis may dispose sibling effects concurrently. Keeping all material
 * owners behind one effect makes the safety order an application invariant:
 * terminal/product first, then workspace consumers in reverse registration
 * order, then the DSH adapter, legacy Chat, and finally the Kernel.
 */
export class DshTuiRootResources {
  product: DshTuiProductMount | undefined
  readonly workspaceFeatures: DshTuiFeatureRegistrationLease[] = []
  dshRc2Adapter: DshTuiRuntimeOwner | undefined
  legacyChatFeature: DshTuiFeatureRegistrationLease | undefined
  preferences: DshTuiPreferencesAdapterMount | undefined
  kernel: DshTuiFeatureOwner | undefined

  #disposeTask: Promise<void> | undefined

  dispose(): Promise<void> {
    this.#disposeTask ??= this.#disposeInOrder()
    return this.#disposeTask
  }

  async #disposeInOrder(): Promise<void> {
    const errors: unknown[] = []
    for (const release of [
      () => this.product?.dispose(),
      ...[...this.workspaceFeatures]
        .reverse()
        .map(feature => () => feature.release()),
      () => this.dshRc2Adapter?.dispose(),
      () => this.legacyChatFeature?.release(),
      () => this.preferences?.dispose(),
      () => this.kernel?.dispose(),
    ]) {
      try {
        await release()
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'dsh-tui root composition disposal failed')
    }
  }
}
