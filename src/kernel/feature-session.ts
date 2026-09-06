import type { ResourceScope } from '../lifecycle/scope-manager.ts'
import type { FeatureCapabilityResolver } from './feature-supervisor.ts'

/**
 * DSH-free inputs needed to host session-scoped Features for one runtime
 * session. The caller owns the scope; the returned lease owns the supervisor.
 */
export interface FeatureSessionBindingOptions {
  readonly scope: ResourceScope
  /** Resolves session-scoped requirements; application requirements stay kernel-owned. */
  readonly capabilities: FeatureCapabilityResolver
}

/** Idempotent ownership handle for the currently bound session supervisor. */
export interface FeatureSessionBindingLease {
  readonly active: boolean
  release(): Promise<void>
}
