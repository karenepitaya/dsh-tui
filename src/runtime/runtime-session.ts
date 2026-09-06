import type { CapabilityLease, CapabilityToken } from '../kernel/capability.ts'
import type { CoreSessionPort } from './core-session-port.ts'
import type { DshTuiSessionPort } from './tui-session-port.ts'

/** Chat/safety core without lifecycle methods owned by the enclosing lease. */
export type RuntimeSessionCorePort = Omit<
  CoreSessionPort,
  'dispose' | 'disposeInteractions'
>

/** Typed, lazy access to optional session capabilities. */
export interface RuntimeSessionCapabilityResolver {
  acquire<TValue>(token: CapabilityToken<TValue>): Promise<CapabilityLease<TValue>>
}

/** Internal bridge used by Product when an activation still returns a legacy port. */
export const runtimeSessionCapabilities = Symbol('dsh-tui.runtime-session-capabilities')

export interface RuntimeSessionCapabilityCarrier {
  readonly [runtimeSessionCapabilities]: RuntimeSessionCapabilityResolver | undefined
}

export function runtimeSessionCapabilitiesOf(
  value: unknown,
): RuntimeSessionCapabilityResolver | undefined {
  return (value as Partial<RuntimeSessionCapabilityCarrier> | undefined)
    ?.[runtimeSessionCapabilities]
}

/**
 * Product-facing session ownership boundary.
 *
 * The core is always present. Optional capabilities are constructed only when
 * acquired. The legacy aggregate port is an explicit compatibility projection.
 */
export interface RuntimeSessionLease {
  readonly core: RuntimeSessionCorePort
  readonly capabilities: RuntimeSessionCapabilityResolver
  asLegacyPort(): Promise<DshTuiSessionPort>
  release(reason?: unknown): Promise<void>
}
