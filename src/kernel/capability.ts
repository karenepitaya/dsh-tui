declare const capabilityValue: unique symbol

export type MaybePromise<T> = T | PromiseLike<T>
export type CapabilityId = `${string}/v${number}`
export type CapabilityScope = 'application' | 'session'

/** A stable runtime key that also carries value type and lifetime. */
export interface CapabilityToken<TValue> {
  readonly id: CapabilityId
  readonly scope: CapabilityScope
  readonly [capabilityValue]?: TValue
}

/** The owned value returned when a capability is resolved. */
export interface CapabilityLease<TValue> {
  readonly value: TValue
  /** Resolves when the provider or owning scope invalidates this lease. */
  readonly invalidated?: PromiseLike<void>
  release(): MaybePromise<void>
}

export interface CapabilityFactory<TValue, TContext = void> {
  readonly token: CapabilityToken<TValue>
  create(context: TContext): MaybePromise<CapabilityLease<TValue>>
}

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === 'string' && /^\S+\/v(?:0|[1-9]\d*)$/u.test(value)
}

export function isCapabilityScope(value: unknown): value is CapabilityScope {
  return value === 'application' || value === 'session'
}

export function createCapabilityToken<TValue>(
  id: CapabilityId,
  scope: CapabilityScope,
): CapabilityToken<TValue> {
  if (!isCapabilityId(id)) {
    throw new Error('Capability id must match <name>/v<number> without whitespace')
  }
  if (!isCapabilityScope(scope)) {
    throw new Error('Capability scope must be application or session')
  }
  return Object.freeze({ id, scope }) as CapabilityToken<TValue>
}
