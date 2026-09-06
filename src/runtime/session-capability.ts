import {
  isCapabilityId,
  isCapabilityScope,
  type CapabilityFactory,
  type CapabilityLease,
  type CapabilityToken,
} from '../kernel/capability.ts'
import {
  CapabilityRegistry,
  CapabilityRegistryError,
  type CapabilityFactoryContext,
  type CapabilityRegistrationLease,
} from '../kernel/capability-registry.ts'
import type { ResourceScope } from '../lifecycle/scope-manager.ts'
import type { CoreSessionPort } from './core-session-port.ts'

export interface SessionCapabilityFactoryContext<
  TCore extends CoreSessionPort = CoreSessionPort,
> extends CapabilityFactoryContext {
  readonly core: TCore
}

export type SessionCapabilityFactory<
  TValue,
  TCore extends CoreSessionPort = CoreSessionPort,
> = CapabilityFactory<TValue, SessionCapabilityFactoryContext<TCore>>

export interface SessionCapabilityFactoryProvenance {
  readonly ownerId: string
  readonly generation: number
}

export interface SessionCapabilityFactoryRegistrationLease {
  readonly tokenId: string
  readonly provenance: SessionCapabilityFactoryProvenance
  readonly active: boolean
  release(): Promise<void>
}

export interface SessionCapabilityLease<
  TCore extends CoreSessionPort = CoreSessionPort,
> {
  readonly core: TCore
  readonly scope: ResourceScope
  acquire<TValue>(token: CapabilityToken<TValue>): Promise<CapabilityLease<TValue>>
  release(reason?: unknown): Promise<void>
}

export interface ComposeSessionCapabilityLeaseOptions<
  TCore extends CoreSessionPort = CoreSessionPort,
> {
  readonly core: TCore
  readonly scope: ResourceScope
  readonly factories: readonly SessionCapabilityFactory<unknown, TCore>[]
}

interface SessionCapabilityFactoryRecord<TCore extends CoreSessionPort> {
  readonly factory: SessionCapabilityFactory<unknown, TCore>
  readonly provenance: SessionCapabilityFactoryProvenance
  active: boolean
  releaseTask: Promise<void> | undefined
}

interface InstalledSessionCapabilityFactory<TCore extends CoreSessionPort> {
  readonly record: SessionCapabilityFactoryRecord<TCore>
  readonly registration: CapabilityRegistrationLease
}

/**
 * App-owned provider catalog for optional session capabilities.
 *
 * Registrations are live: a factory registered after bind() is installed into
 * every active binding. Provider generations are identity checked so a slow
 * old disposer can never remove a replacement generation.
 */
export class SessionCapabilityFactoryRegistry<
  TCore extends CoreSessionPort = CoreSessionPort,
> {
  readonly #scope: ResourceScope
  readonly #records = new Map<string, SessionCapabilityFactoryRecord<TCore>>()
  readonly #retiredTokenIds = new Set<string>()
  readonly #bindings = new Set<BoundSessionCapabilityLease<TCore>>()
  readonly #pendingRetirements = new Set<Promise<void>>()
  readonly #releaseFromScope: () => Promise<void>
  #disposeTask: Promise<void> | undefined
  #ownedDisposeTask: Promise<void> | undefined
  #disposed = false

  constructor(scope: ResourceScope) {
    assertActiveApplicationScope(scope)
    this.#scope = scope
    this.#releaseFromScope = scope.defer(() => this.#startDispose())
  }

  get size(): number {
    return this.#records.size
  }

  register<TValue>(
    factory: SessionCapabilityFactory<TValue, TCore>,
    provenance: SessionCapabilityFactoryProvenance,
  ): SessionCapabilityFactoryRegistrationLease {
    this.#assertActive()
    const storedFactory = snapshotFactory(factory)
    const storedProvenance = snapshotProvenance(provenance)
    const tokenId = storedFactory.token.id
    if (this.#records.has(tokenId)) {
      throw new CapabilityRegistryError(
        'duplicate-token',
        `Session capability "${tokenId}" is already registered`,
      )
    }

    const record: SessionCapabilityFactoryRecord<TCore> = {
      factory: storedFactory,
      provenance: storedProvenance,
      active: true,
      releaseTask: undefined,
    }
    this.#records.set(tokenId, record)
    this.#retiredTokenIds.delete(tokenId)
    try {
      for (const binding of this.#bindings) binding.install(record)
    /* v8 ignore start -- validated snapshots and registry uniqueness make install failure unreachable. */
    } catch (error: unknown) {
      record.active = false
      this.#records.delete(tokenId)
      this.#retiredTokenIds.add(tokenId)
      const retireTask = this.#retireFromBindings(record)
      void retireTask.catch(() => {})
      throw error
    }
    /* v8 ignore stop */

    return Object.freeze({
      tokenId,
      provenance: storedProvenance,
      get active() {
        return record.active
      },
      release: () => this.#releaseRecord(record),
    })
  }

  bind(core: TCore, scope: ResourceScope): SessionCapabilityLease<TCore> {
    this.#assertActive()
    assertOwnedActiveSessionScope(scope, this.#scope)
    scope.defer(() => core.dispose())
    const binding = new BoundSessionCapabilityLease(
      this,
      core,
      scope,
      this.#retiredTokenIds,
    )
    this.#bindings.add(binding)
    for (const record of this.#records.values()) binding.install(record)
    return Object.freeze(binding)
  }

  dispose(): Promise<void> {
    if (this.#disposeTask !== undefined) return this.#disposeTask
    if (this.#ownedDisposeTask !== undefined) {
      return this.#disposeTask = this.#ownedDisposeTask
    }
    return this.#disposeTask = this.#releaseFromScope()
  }

  detach(binding: BoundSessionCapabilityLease<TCore>): void {
    this.#bindings.delete(binding)
  }

  #assertActive(): void {
    if (this.#disposed || this.#scope.disposed || this.#scope.signal.aborted) {
      throw new CapabilityRegistryError(
        'capability-unavailable',
        'Session capability factory registry is disposed',
      )
    }
  }

  #releaseRecord(
    record: SessionCapabilityFactoryRecord<TCore>,
  ): Promise<void> {
    if (record.releaseTask !== undefined) return record.releaseTask
    record.active = false
    const tokenId = record.factory.token.id
    /* v8 ignore else -- only the exact active registration lease can reach this path. */
    if (this.#records.get(tokenId) === record) this.#records.delete(tokenId)
    this.#retiredTokenIds.add(tokenId)
    record.releaseTask = this.#trackRetirement(this.#retireFromBindings(record))
    return record.releaseTask
  }

  #startDispose(): Promise<void> {
    this.#ownedDisposeTask ??= this.#runDispose()
    return this.#ownedDisposeTask
  }

  async #runDispose(): Promise<void> {
    this.#disposed = true
    const records = [...this.#records.values()].reverse()
    this.#records.clear()
    const errors: unknown[] = []
    for (const retirement of [...this.#pendingRetirements]) {
      try {
        await retirement
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    for (const record of records) {
      record.active = false
      this.#retiredTokenIds.add(record.factory.token.id)
      record.releaseTask ??= this.#trackRetirement(this.#retireFromBindings(record))
      try {
        await record.releaseTask
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'Session capability registry disposal failed')
    }
  }

  #trackRetirement(retirement: Promise<void>): Promise<void> {
    this.#pendingRetirements.add(retirement)
    void retirement.then(
      () => { this.#pendingRetirements.delete(retirement) },
      () => { this.#pendingRetirements.delete(retirement) },
    )
    return retirement
  }

  async #retireFromBindings(
    record: SessionCapabilityFactoryRecord<TCore>,
  ): Promise<void> {
    const errors: unknown[] = []
    for (const binding of [...this.#bindings].reverse()) {
      try {
        await binding.retire(record)
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    if (errors.length !== 0) {
      throw new AggregateError(
        errors,
        `Session capability "${record.factory.token.id}" retirement failed`,
      )
    }
  }
}

class BoundSessionCapabilityLease<
  TCore extends CoreSessionPort,
> implements SessionCapabilityLease<TCore> {
  readonly #capabilities = new CapabilityRegistry()
  readonly #installed = new Map<string, InstalledSessionCapabilityFactory<TCore>>()
  readonly #retiredTokenIds: Set<string>
  #releaseTask: Promise<void> | undefined
  #closing = false

  constructor(
    private readonly owner: SessionCapabilityFactoryRegistry<TCore>,
    readonly core: TCore,
    readonly scope: ResourceScope,
    retiredTokenIds: ReadonlySet<string>,
  ) {
    this.#retiredTokenIds = new Set(retiredTokenIds)
    scope.defer(() => this.#releaseInstalled())
  }

  install(record: SessionCapabilityFactoryRecord<TCore>): void {
    if (this.#closing || this.scope.disposed || this.scope.signal.aborted) return
    const tokenId = record.factory.token.id
    /* v8 ignore next 6 -- app registry token uniqueness is projected synchronously. */
    if (this.#installed.has(tokenId)) {
      throw new CapabilityRegistryError(
        'duplicate-token',
        `Session capability "${tokenId}" is already installed in this binding`,
      )
    }
    const registration = this.#capabilities.register({
      token: record.factory.token,
      create: ({ scope }) => record.factory.create({
        core: this.core,
        scope,
      }),
    })
    this.#installed.set(tokenId, { record, registration })
    this.#retiredTokenIds.delete(tokenId)
  }

  retire(record: SessionCapabilityFactoryRecord<TCore>): Promise<void> {
    const tokenId = record.factory.token.id
    const installed = this.#installed.get(tokenId)
    /* v8 ignore next -- retirement dispatch snapshots only bindings carrying this generation. */
    if (installed?.record !== record) return Promise.resolve()
    this.#installed.delete(tokenId)
    this.#retiredTokenIds.add(tokenId)
    return installed.registration.release()
  }

  async acquire<TValue>(
    token: CapabilityToken<TValue>,
  ): Promise<CapabilityLease<TValue>> {
    assertActiveSessionScope(this.scope)
    assertSessionCapabilityToken(token)
    if (!this.#installed.has(token.id) && this.#retiredTokenIds.has(token.id)) {
      throw new CapabilityRegistryError(
        'capability-unavailable',
        `Session capability "${token.id}" provider is no longer available`,
      )
    }
    return await this.#capabilities.acquire(token, this.scope)
  }

  release(reason: unknown = 'session capability lease released'): Promise<void> {
    if (this.#releaseTask !== undefined) return this.#releaseTask
    this.#closing = true
    this.owner.detach(this)
    this.#releaseTask = this.scope.dispose(reason)
    return this.#releaseTask
  }

  async #releaseInstalled(): Promise<void> {
    this.#closing = true
    this.owner.detach(this)
    const installed = [...this.#installed.values()].reverse()
    this.#installed.clear()
    const errors: unknown[] = []
    for (const entry of installed) {
      this.#retiredTokenIds.add(entry.record.factory.token.id)
      try {
        await entry.registration.release()
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'Session capability binding disposal failed')
    }
  }
}

/** Bind exact Core identity to one session-local capability registry and owner scope. */
export function composeSessionCapabilityLease<TCore extends CoreSessionPort>(
  options: ComposeSessionCapabilityLeaseOptions<TCore>,
): SessionCapabilityLease<TCore> {
  const { core, scope } = options
  assertActiveSessionScope(scope)
  const factories = validateFactories(options.factories)
  const appScope = requireApplicationParent(scope)
  const registry = new SessionCapabilityFactoryRegistry<TCore>(appScope)
  for (const [index, factory] of factories.entries()) {
    registry.register(factory, {
      ownerId: 'runtime.compose-session-capability',
      generation: index + 1,
    })
  }
  const binding = registry.bind(core, scope)
  scope.defer(() => registry.dispose())
  return binding
}

function validateFactories<TCore extends CoreSessionPort>(
  factories: readonly SessionCapabilityFactory<unknown, TCore>[],
): readonly SessionCapabilityFactory<unknown, TCore>[] {
  const snapshot = [...factories]
  const ids = new Set<string>()
  for (const factory of snapshot) {
    if (factory === null || typeof factory !== 'object' || typeof factory.create !== 'function') {
      throw new CapabilityRegistryError(
        'invalid-factory',
        'Session capability factory must be an object with a create function',
      )
    }
    const { token } = factory
    if (!isCapabilityId(token?.id) || !isCapabilityScope(token?.scope)) {
      throw new CapabilityRegistryError(
        'invalid-token',
        'Session capability factory has an invalid token',
      )
    }
    if (token.scope !== 'session') {
      throw new CapabilityRegistryError(
        'scope-mismatch',
        `Session capability "${token.id}" must declare session scope`,
      )
    }
    if (ids.has(token.id)) {
      throw new CapabilityRegistryError(
        'duplicate-token',
        `Session capability "${token.id}" is duplicated`,
      )
    }
    ids.add(token.id)
  }
  return snapshot
}

function assertActiveSessionScope(scope: ResourceScope): void {
  if (scope.kind !== 'session' || scope.disposed || scope.signal.aborted) {
    throw new CapabilityRegistryError(
      'scope-mismatch',
      'Session capability lease requires an active session scope',
    )
  }
}

function assertActiveApplicationScope(scope: ResourceScope): void {
  if (scope.kind !== 'app' || scope.disposed || scope.signal.aborted) {
    throw new CapabilityRegistryError(
      'scope-mismatch',
      'Session capability factory registry requires an active application scope',
    )
  }
}

function assertOwnedActiveSessionScope(
  scope: ResourceScope,
  owner: ResourceScope,
): void {
  assertActiveSessionScope(scope)
  if (scope.parent !== owner) {
    throw new CapabilityRegistryError(
      'scope-mismatch',
      'Session capability binding must belong to the registry application scope',
    )
  }
}

function requireApplicationParent(scope: ResourceScope): ResourceScope {
  const parent = scope.parent
  if (parent === undefined || parent.kind !== 'app') {
    throw new CapabilityRegistryError(
      'scope-mismatch',
      'Session capability lease requires an application parent scope',
    )
  }
  return parent
}

function assertSessionCapabilityToken(
  token: CapabilityToken<unknown>,
): void {
  if (token === null
    || typeof token !== 'object'
    || !isCapabilityId(token.id)
    || !isCapabilityScope(token.scope)) {
    throw new CapabilityRegistryError('invalid-token', 'Capability token is invalid')
  }
  if (token.scope !== 'session') {
    throw new CapabilityRegistryError(
      'scope-mismatch',
      `Capability "${token.id}" requires application scope`,
    )
  }
}

function snapshotFactory<
  TValue,
  TCore extends CoreSessionPort,
>(
  factory: SessionCapabilityFactory<TValue, TCore>,
): SessionCapabilityFactory<unknown, TCore> {
  validateFactories([factory])
  const token = Object.freeze({
    id: factory.token.id,
    scope: factory.token.scope,
  }) as CapabilityToken<unknown>
  const create = factory.create.bind(factory)
  return Object.freeze({ token, create })
}

function snapshotProvenance(
  provenance: SessionCapabilityFactoryProvenance,
): SessionCapabilityFactoryProvenance {
  if (provenance === null
    || typeof provenance !== 'object'
    || typeof provenance.ownerId !== 'string'
    || provenance.ownerId.length === 0
    || provenance.ownerId.trim() !== provenance.ownerId
    || !Number.isSafeInteger(provenance.generation)
    || provenance.generation < 1) {
    throw new CapabilityRegistryError(
      'invalid-provenance',
      'Session capability provenance requires a trimmed ownerId and positive generation',
    )
  }
  return Object.freeze({
    ownerId: provenance.ownerId,
    generation: provenance.generation,
  })
}
