import type { ResourceScope } from './scope-manager.ts'
import { ScopeManager } from './scope-manager.ts'

/** Internal token; the experimental Feature service contract stays scope-free. */
export const applicationScopeHost = Symbol('dsh-tui.application-scope-host')

/** DSH-agnostic access to the one application-owned scope tree. */
export interface ApplicationScopeHost {
  readonly appScope: ResourceScope
  createRuntimeSessionScope(label: string): ResourceScope
}

/** Internal owner used only when an adapter is embedded without the Cordis Kernel. */
export interface StandaloneApplicationScopeHost extends ApplicationScopeHost {
  dispose(reason?: unknown): Promise<void>
}

/**
 * Allocate one isolated application tree for direct adapter embedding/tests.
 * Shipped Cordis composition supplies its Kernel-owned ApplicationScopeHost.
 */
export function createStandaloneApplicationScopeHost(
  label: string,
): StandaloneApplicationScopeHost {
  const scopes = new ScopeManager(label)
  return Object.freeze({
    appScope: scopes.app,
    createRuntimeSessionScope: (sessionLabel: string) => scopes.createSession(sessionLabel),
    dispose: (reason?: unknown) => reason === undefined
      ? scopes.dispose()
      : scopes.dispose(reason),
  })
}

export interface ApplicationScopeHostProvider {
  [applicationScopeHost](): ApplicationScopeHost
}

/** Resolve the internal kernel seam without widening DshTuiFeatureService. */
export function requireApplicationScopeHost(value: unknown): ApplicationScopeHost {
  const provider = value as Partial<ApplicationScopeHostProvider> | undefined
  const resolve = provider?.[applicationScopeHost]
  if (typeof resolve !== 'function') {
    throw new Error('DSH-TUI kernel does not expose its application scope host')
  }
  return resolve.call(provider)
}

/** Internal carrier used by Product to derive ActiveSurfaceScope later. */
export const runtimeSessionScope = Symbol('dsh-tui.runtime-session-scope')

export interface RuntimeSessionScopeCarrier {
  readonly [runtimeSessionScope]: ResourceScope | undefined
}

export function runtimeSessionScopeOf(value: unknown): ResourceScope | undefined {
  return (value as Partial<RuntimeSessionScopeCarrier> | undefined)?.[runtimeSessionScope]
}
