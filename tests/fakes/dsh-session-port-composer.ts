import type { Context } from '@deepseek-ai/cordis'
import {
  createStandaloneApplicationScopeHost,
  type ApplicationScopeHost,
} from '../../src/lifecycle/application-scope-host.ts'
import { SessionCapabilityFactoryRegistry } from '../../src/runtime/session-capability.ts'
import type { DshInteractionHub } from '../../src/dsh/interaction-hub.ts'
import {
  DshModelSelectionHub,
} from '../../src/dsh/model-selection.ts'
import {
  createDshSessionCapabilityFactories,
  DshSessionCorePort,
} from '../../src/dsh/session-capability-factories.ts'
import { DshSessionPortComposer } from '../../src/dsh/session-port-composer.ts'

export interface DshSessionPortComposerFixture {
  readonly composer: DshSessionPortComposer
  dispose(): Promise<void>
}

/** App-local test composition matching the production Kernel ownership tree. */
export function createDshSessionPortComposerFixture(
  ctx: Context,
  interactionHub: DshInteractionHub,
  modelHub?: DshModelSelectionHub,
  applicationScopes?: ApplicationScopeHost,
): DshSessionPortComposerFixture {
  const ownedScopes = applicationScopes === undefined
    ? createStandaloneApplicationScopeHost('test-dsh-session-composer')
    : undefined
  const scopes = applicationScopes ?? ownedScopes!
  const ownedModelHub = modelHub === undefined ? new DshModelSelectionHub(ctx) : undefined
  const resolvedModelHub = modelHub ?? ownedModelHub!
  const registry = new SessionCapabilityFactoryRegistry<DshSessionCorePort>(
    scopes.appScope,
  )
  const capabilityFactoryRegistration = createDshSessionCapabilityFactories(
    ctx,
    resolvedModelHub,
  ).register(registry)
  const composer = new DshSessionPortComposer(interactionHub, scopes, registry)

  return Object.freeze({
    composer,
    async dispose() {
      const errors: unknown[] = []
      try {
        await composer.disposeSessions()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await capabilityFactoryRegistration.dispose()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await registry.dispose()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await ownedModelHub?.dispose()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await ownedScopes?.dispose('test DSH session composer disposed')
      } catch (error: unknown) {
        errors.push(error)
      }
      if (errors.length !== 0) {
        throw new AggregateError(errors, 'test DSH session composer disposal failed')
      }
    },
  })
}
