import {
  isCapabilityId,
  isCapabilityScope,
  type CapabilityFactory,
  type CapabilityLease,
  type CapabilityToken,
} from './capability.ts'
import type { ResourceScope } from '../lifecycle/scope-manager.ts'

export interface CapabilityFactoryContext {
  readonly scope: ResourceScope
}

export type RegisteredCapabilityFactory = CapabilityFactory<
  unknown,
  CapabilityFactoryContext
>

export type CapabilityRegistryErrorCode =
  | 'invalid-factory'
  | 'invalid-provenance'
  | 'invalid-token'
  | 'duplicate-token'
  | 'unregistered-token'
  | 'scope-mismatch'
  | 'capability-unavailable'

export class CapabilityRegistryError extends Error {
  readonly code: CapabilityRegistryErrorCode

  constructor(code: CapabilityRegistryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CapabilityRegistryError'
    this.code = code
  }
}

export interface CapabilityRegistrationLease {
  readonly tokenId: string
  readonly active: boolean
  release(): Promise<void>
}

interface CapabilityEntry {
  readonly tokenId: string
  readonly scope: ResourceScope
  readonly factory: RegisteredCapabilityFactory
  readonly createTask: Promise<CapabilityLease<unknown>>
  provider: CapabilityLease<unknown> | undefined
  releaseFromScope: (() => Promise<void>) | undefined
  retireTask: Promise<void> | undefined
  invalidated: boolean
  readonly invalidatedTask: Promise<void>
  readonly signalInvalidated: () => void
  references: number
}

export class CapabilityRegistry {
  readonly #factories = new Map<string, RegisteredCapabilityFactory>()
  readonly #entries = new Map<ResourceScope, Map<string, CapabilityEntry>>()

  get size(): number {
    return this.#factories.size
  }

  get(tokenId: string): RegisteredCapabilityFactory | undefined {
    return this.#factories.get(tokenId)
  }

  register<TValue>(
    factory: CapabilityFactory<TValue, CapabilityFactoryContext>,
  ): CapabilityRegistrationLease {
    if (factory === null || typeof factory !== 'object' || typeof factory.create !== 'function') {
      throw new CapabilityRegistryError(
        'invalid-factory',
        'Capability factory must be an object with a create function',
      )
    }
    const { token } = factory
    if (!isCapabilityId(token?.id) || !isCapabilityScope(token?.scope)) {
      throw new CapabilityRegistryError('invalid-token', 'Capability factory has an invalid token')
    }
    if (this.#factories.has(token.id)) {
      throw new CapabilityRegistryError(
        'duplicate-token',
        `Capability "${token.id}" is already registered`,
      )
    }
    const stored = factory as RegisteredCapabilityFactory
    this.#factories.set(token.id, stored)
    let active = true
    return {
      tokenId: token.id,
      get active() {
        return active
      },
      release: async () => {
        if (!active) return
        active = false
        this.#factories.delete(token.id)
        const retirements: Promise<void>[] = []
        for (const entries of this.#entries.values()) {
          const entry = entries.get(token.id)
          if (entry?.factory === stored) retirements.push(this.#invalidateEntry(entry))
        }
        await Promise.all(retirements)
      },
    }
  }

  resolve<TValue>(
    token: CapabilityToken<TValue>,
    scope: ResourceScope,
  ): Promise<CapabilityLease<TValue>> {
    return this.acquire(token, scope)
  }

  async acquire<TValue>(
    token: CapabilityToken<TValue>,
    scope: ResourceScope,
  ): Promise<CapabilityLease<TValue>> {
    if (token === null
      || typeof token !== 'object'
      || !isCapabilityId(token.id)
      || !isCapabilityScope(token.scope)) {
      throw new CapabilityRegistryError('invalid-token', 'Capability token is invalid')
    }
    const factory = this.#factories.get(token.id)
    if (factory === undefined || factory.token.scope !== token.scope) {
      throw new CapabilityRegistryError(
        'unregistered-token',
        `Capability "${token.id}" is not registered`,
      )
    }
    this.#assertScope(token, scope)
    let entries = this.#entries.get(scope)
    if (entries === undefined) {
      entries = new Map()
      this.#entries.set(scope, entries)
    }
    let entry = entries.get(token.id)
    if (entry === undefined) {
      entry = this.#createEntry(factory, scope, entries)
      entries.set(token.id, entry)
    }
    entry.references += 1
    try {
      const provider = await entry.createTask
      if (entry.invalidated) {
        throw new CapabilityRegistryError(
          'capability-unavailable',
          `Capability "${token.id}" is no longer available`,
        )
      }
      let active = true
      const ownedEntry = entry
      return {
        invalidated: ownedEntry.invalidatedTask,
        get value() {
          if (!active || ownedEntry.invalidated) {
            throw new CapabilityRegistryError(
              'capability-unavailable',
              `Capability "${token.id}" is no longer available`,
            )
          }
          return provider.value as TValue
        },
        release: () => {
          if (!active) return
          active = false
          ownedEntry.references -= 1
        },
      }
    } catch (error: unknown) {
      entry.references -= 1
      if (!entry.invalidated) {
        this.#markInvalidated(entry)
        this.#removeEntry(entry)
      }
      if (error instanceof CapabilityRegistryError) throw error
      throw new CapabilityRegistryError(
        'capability-unavailable',
        `Capability "${token.id}" failed to initialize`,
        error,
      )
    }
  }

  #createEntry(
    factory: RegisteredCapabilityFactory,
    scope: ResourceScope,
    entries: Map<string, CapabilityEntry>,
  ): CapabilityEntry {
    let entry!: CapabilityEntry
    const createTask = (async (): Promise<CapabilityLease<unknown>> => {
      const candidate: unknown = await factory.create({ scope })
      let provider: CapabilityLease<unknown>
      try {
        provider = requireCapabilityLease(candidate)
      } catch (error: unknown) {
        if (hasRelease(candidate)) {
          try {
            await candidate.release()
          } catch (cleanupError: unknown) {
            throw new AggregateError(
              [error, cleanupError],
              'Invalid capability lease cleanup failed',
            )
          }
        }
        throw error
      }
      entry.provider = provider
      if (entry.invalidated) return provider
      try {
        entry.releaseFromScope = scope.defer(() => this.#retireEntry(entry))
      } catch (error: unknown) {
        this.#markInvalidated(entry)
        await provider.release()
        throw error
      }
      return provider
    })()
    let signalInvalidated!: () => void
    const invalidatedTask = new Promise<void>(resolve => {
      signalInvalidated = resolve
    })
    entry = {
      tokenId: factory.token.id,
      scope,
      factory,
      createTask,
      provider: undefined,
      releaseFromScope: undefined,
      retireTask: undefined,
      invalidated: false,
      invalidatedTask,
      signalInvalidated,
      references: 0,
    }
    void createTask.catch(() => {
      if (entries.get(entry.tokenId) === entry) entries.delete(entry.tokenId)
      if (entries.size === 0) this.#entries.delete(scope)
    })
    return entry
  }

  #assertScope(token: CapabilityToken<unknown>, scope: ResourceScope): void {
    const expected = token.scope === 'application' ? 'app' : 'session'
    if (scope.kind !== expected || scope.disposed || scope.signal.aborted) {
      throw new CapabilityRegistryError(
        'scope-mismatch',
        `Capability "${token.id}" requires an active ${token.scope} scope`,
      )
    }
  }

  #invalidateEntry(entry: CapabilityEntry): Promise<void> {
    this.#markInvalidated(entry)
    return entry.releaseFromScope?.() ?? this.#retireEntry(entry)
  }

  #retireEntry(entry: CapabilityEntry): Promise<void> {
    this.#markInvalidated(entry)
    entry.retireTask ??= this.#runRetirement(entry)
    return entry.retireTask
  }

  #markInvalidated(entry: CapabilityEntry): void {
    if (entry.invalidated) return
    entry.invalidated = true
    entry.signalInvalidated()
  }

  async #runRetirement(entry: CapabilityEntry): Promise<void> {
    this.#removeEntry(entry)
    let provider: CapabilityLease<unknown>
    try {
      provider = await entry.createTask
    } catch {
      return
    }
    await provider.release()
  }

  #removeEntry(entry: CapabilityEntry): void {
    const entries = this.#entries.get(entry.scope)
    if (entries?.get(entry.tokenId) !== entry) return
    entries.delete(entry.tokenId)
    if (entries.size === 0) this.#entries.delete(entry.scope)
  }
}

function requireCapabilityLease(value: unknown): CapabilityLease<unknown> {
  if (value === null
    || typeof value !== 'object'
    || !('value' in value)
    || typeof (value as Partial<CapabilityLease<unknown>>).release !== 'function') {
    throw new TypeError('Capability factory returned an invalid lease')
  }
  return value as CapabilityLease<unknown>
}

function hasRelease(value: unknown): value is Pick<CapabilityLease<unknown>, 'release'> {
  return value !== null
    && typeof value === 'object'
    && typeof (value as Partial<CapabilityLease<unknown>>).release === 'function'
}
