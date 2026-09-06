import {
  isCapabilityId,
  isCapabilityScope,
  type MaybePromise,
} from './capability.ts'
import {
  FEATURE_API_VERSION,
  type FeatureActivation,
  type FeatureContributionDeclarations,
  type FeatureContributions,
  type FeatureFactory,
  type FeatureManifest,
  type FeatureRequirements,
} from './feature.ts'

export type FeatureRegistrationErrorCode =
  | 'invalid-factory'
  | 'invalid-manifest'
  | 'invalid-id'
  | 'unsupported-api-version'
  | 'invalid-scope'
  | 'invalid-activation'
  | 'invalid-required'
  | 'implicit-requires'
  | 'invalid-requirement'
  | 'duplicate-requirement'
  | 'capability-scope-mismatch'
  | 'invalid-declarations'
  | 'invalid-activation-declaration'
  | 'duplicate-declaration'
  | 'duplicate-id'
  | 'duplicate-route'
  | 'duplicate-surface-declaration'
  | 'duplicate-single-slot'
  | 'invalid-slot-catalog'
  | 'duplicate-slot-definition'
  | 'unknown-slot'
  | 'slot-cardinality-mismatch'
  | 'protected-slot'
  | 'invalid-provenance'

export type FeatureRegistrationAuthority = 'core' | 'extension'

export interface FeatureRegistrationProvenance {
  readonly authority: FeatureRegistrationAuthority
  readonly required: boolean
}

export interface FeatureRegistrationOptions {
  /** Set only by the product composition; public feature services always use extension. */
  readonly authority?: FeatureRegistrationAuthority
}

export class FeatureRegistrationError extends Error {
  readonly code: FeatureRegistrationErrorCode

  constructor(code: FeatureRegistrationErrorCode, message: string) {
    super(message)
    this.name = 'FeatureRegistrationError'
    this.code = code
  }
}

export interface FeatureRegistrationLease {
  readonly featureId: string
  readonly active: boolean
  release(): Promise<void>
}

export type RegisteredFeatureFactory = FeatureFactory<FeatureRequirements, FeatureContributions>
export type FeatureUnregisteredListener = (
  factory: RegisteredFeatureFactory,
) => MaybePromise<void>

export interface RegisteredFeatureSnapshot {
  readonly manifest: FeatureManifest
  readonly declarations: Required<FeatureContributionDeclarations>
}

/** Product-owned slot policy. Feature declarations must conform to this catalog. */
export interface FeatureSlotDefinition {
  readonly id: string
  readonly cardinality: 'single' | 'list'
  readonly protection: 'public' | 'protected'
}

const EMPTY_DECLARATIONS: Required<FeatureContributionDeclarations> = Object.freeze({
  routes: Object.freeze([]),
  commands: Object.freeze([]),
  keymaps: Object.freeze([]),
  resources: Object.freeze([]),
  surfaces: Object.freeze([]),
})

/** Composition-time registry: factories and static metadata, never instances. */
export class FeatureRegistry {
  readonly supportedApiVersion: number
  readonly #slotDefinitions: ReadonlyMap<string, FeatureSlotDefinition> | undefined
  readonly #factories = new Map<string, RegisteredFeatureFactory>()
  readonly #snapshots = new Map<string, RegisteredFeatureSnapshot>()
  readonly #factorySnapshots = new WeakMap<RegisteredFeatureFactory, RegisteredFeatureSnapshot>()
  readonly #provenance = new Map<string, FeatureRegistrationProvenance>()
  readonly #factoryProvenance = new WeakMap<RegisteredFeatureFactory, FeatureRegistrationProvenance>()
  readonly #unregisteredListeners = new Set<FeatureUnregisteredListener>()

  constructor(
    supportedApiVersion = FEATURE_API_VERSION,
    slotDefinitions?: readonly FeatureSlotDefinition[],
  ) {
    this.supportedApiVersion = supportedApiVersion
    this.#slotDefinitions = slotDefinitions === undefined
      ? undefined
      : validateSlotCatalog(slotDefinitions)
  }

  get size(): number {
    return this.#factories.size
  }

  get(id: string): RegisteredFeatureFactory | undefined {
    return this.#factories.get(id)
  }

  list(): readonly RegisteredFeatureFactory[] {
    return [...this.#factories.values()]
  }

  snapshotOf(
    feature: string | RegisteredFeatureFactory,
  ): RegisteredFeatureSnapshot | undefined {
    return typeof feature === 'string'
      ? this.#snapshots.get(feature)
      : this.#factorySnapshots.get(feature)
  }

  provenanceOf(
    feature: string | RegisteredFeatureFactory,
  ): FeatureRegistrationProvenance | undefined {
    return typeof feature === 'string'
      ? this.#provenance.get(feature)
      : this.#factoryProvenance.get(feature)
  }

  onUnregistered(listener: FeatureUnregisteredListener): () => void {
    this.#unregisteredListeners.add(listener)
    return () => {
      this.#unregisteredListeners.delete(listener)
    }
  }

  register<
    TRequirements extends FeatureRequirements,
    TContributions extends FeatureContributions,
  >(
    factory: FeatureFactory<TRequirements, TContributions>,
    options: FeatureRegistrationOptions = {},
  ): FeatureRegistrationLease {
    const candidate = this.#validateFactory(factory)
    const authority = options.authority ?? 'extension'
    if (authority !== 'core' && authority !== 'extension') {
      throw new FeatureRegistrationError(
        'invalid-provenance',
        `Feature "${candidate.manifest.id}" has invalid registration authority`,
      )
    }
    if (this.#factories.has(candidate.manifest.id)) {
      throw new FeatureRegistrationError(
        'duplicate-id',
        `Feature "${candidate.manifest.id}" is already registered`,
      )
    }
    this.#assertSlotPolicies(candidate, authority)
    this.#assertNoContributionConflicts(candidate)

    const stored = factory as RegisteredFeatureFactory
    this.#factories.set(candidate.manifest.id, stored)
    this.#snapshots.set(candidate.manifest.id, candidate)
    this.#factorySnapshots.set(stored, candidate)
    const provenance = Object.freeze({
      authority,
      required: candidate.manifest.required,
    })
    this.#provenance.set(candidate.manifest.id, provenance)
    this.#factoryProvenance.set(stored, provenance)
    let active = true
    return {
      featureId: candidate.manifest.id,
      get active() {
        return active
      },
      release: async () => {
        if (!active) return
        active = false
        /* v8 ignore else -- an active lease is the only owner of its registered id. */
        if (this.#factories.get(candidate.manifest.id) === stored) {
          this.#factories.delete(candidate.manifest.id)
          this.#snapshots.delete(candidate.manifest.id)
          this.#provenance.delete(candidate.manifest.id)
        }
        await Promise.all(
          [...this.#unregisteredListeners].map(listener => listener(stored)),
        )
      },
    }
  }

  #validateFactory(factory: FeatureFactory): RegisteredFeatureSnapshot {
    if (factory === null || typeof factory !== 'object' || typeof factory.create !== 'function') {
      throw new FeatureRegistrationError(
        'invalid-factory',
        'Feature factory must be an object with a create function',
      )
    }
    const manifest = factory?.manifest
    if (manifest === null || typeof manifest !== 'object') {
      throw new FeatureRegistrationError('invalid-manifest', 'Feature manifest is required')
    }
    const id = requireTrimmedString(manifest.id, 'Feature id', 'invalid-id')
    if (manifest.apiVersion !== this.supportedApiVersion) {
      throw new FeatureRegistrationError(
        'unsupported-api-version',
        `Feature "${id}" uses API version ${String(manifest.apiVersion)}; expected ${this.supportedApiVersion}`,
      )
    }
    if (!isCapabilityScope(manifest.scope)) {
      throw new FeatureRegistrationError('invalid-scope', `Feature "${id}" has an invalid scope`)
    }
    if (!isFeatureActivation(manifest.activation)) {
      throw new FeatureRegistrationError(
        'invalid-activation',
        `Feature "${id}" has an invalid activation policy`,
      )
    }
    if (typeof manifest.required !== 'boolean') {
      throw new FeatureRegistrationError(
        'invalid-required',
        `Feature "${id}" must declare whether it is required`,
      )
    }
    const requirements = this.#validateRequirements(manifest, id)
    const declarations = validateDeclarations(factory.declarations, id)
    if (manifest.activation === 'on-command' && declarations.commands.length === 0) {
      throw new FeatureRegistrationError(
        'invalid-activation-declaration',
        `Feature "${id}" activates on command but declares no commands`,
      )
    }
    if (manifest.activation === 'on-route' && declarations.routes.length === 0) {
      throw new FeatureRegistrationError(
        'invalid-activation-declaration',
        `Feature "${id}" activates on route but declares no routes`,
      )
    }
    const immutableManifest: FeatureManifest = Object.freeze({
      id,
      apiVersion: manifest.apiVersion,
      scope: manifest.scope,
      activation: manifest.activation,
      required: manifest.required,
      requires: requirements,
    })
    return Object.freeze({ manifest: immutableManifest, declarations })
  }

  #validateRequirements(
    manifest: FeatureManifest,
    featureId: string,
  ): FeatureRequirements {
    if (!Array.isArray(manifest.requires)) {
      throw new FeatureRegistrationError(
        'implicit-requires',
        `Feature "${featureId}" must declare a requires array`,
      )
    }
    const requirementIds = new Set<string>()
    const requirements: CapabilityRequirementSnapshot[] = []
    for (const requirement of manifest.requires) {
      if (requirement === null
        || typeof requirement !== 'object'
        || !isCapabilityId(requirement.id)
        || !isCapabilityScope(requirement.scope)) {
        throw new FeatureRegistrationError(
          'invalid-requirement',
          `Feature "${featureId}" has an invalid capability requirement`,
        )
      }
      if (manifest.scope === 'application' && requirement.scope === 'session') {
        throw new FeatureRegistrationError(
          'capability-scope-mismatch',
          `Application feature "${featureId}" cannot require session capability "${requirement.id}"`,
        )
      }
      if (requirementIds.has(requirement.id)) {
        throw new FeatureRegistrationError(
          'duplicate-requirement',
          `Feature "${featureId}" requires capability "${requirement.id}" more than once`,
        )
      }
      requirementIds.add(requirement.id)
      requirements.push(Object.freeze({ id: requirement.id, scope: requirement.scope }))
    }
    return Object.freeze(requirements)
  }

  #assertNoContributionConflicts(candidate: RegisteredFeatureSnapshot): void {
    for (const factory of this.#factories.values()) {
      const registeredSnapshot = this.#factorySnapshots.get(factory)
      /* v8 ignore next 3 -- registered factories and snapshots are stored atomically. */
      if (registeredSnapshot === undefined) {
        throw new Error('Registered feature has no immutable snapshot')
      }
      const registered = registeredSnapshot.declarations
      for (const route of candidate.declarations.routes) {
        if (registered.routes.includes(route)) {
          throw new FeatureRegistrationError(
            'duplicate-route',
            `Route "${route}" is already declared by feature "${registeredSnapshot.manifest.id}"`,
          )
        }
      }
      for (const surface of candidate.declarations.surfaces) {
        const conflict = registered.surfaces.find(existing => existing.slot === surface.slot)
        const productSlot = this.#slotDefinitions?.get(surface.slot)
        if (conflict !== undefined
          && (productSlot?.cardinality === 'single'
            || surface.cardinality === 'single'
            || conflict.cardinality === 'single')) {
          throw new FeatureRegistrationError(
            'duplicate-single-slot',
            `Single-owner slot "${surface.slot}" is already declared by feature "${registeredSnapshot.manifest.id}"`,
          )
        }
      }
    }
  }

  #assertSlotPolicies(
    candidate: RegisteredFeatureSnapshot,
    authority: FeatureRegistrationAuthority,
  ): void {
    if (this.#slotDefinitions === undefined) return
    for (const surface of candidate.declarations.surfaces) {
      const definition = this.#slotDefinitions.get(surface.slot)
      if (definition === undefined) {
        throw new FeatureRegistrationError(
          'unknown-slot',
          `Feature "${candidate.manifest.id}" declares unknown slot "${surface.slot}"`,
        )
      }
      const expected = definition.cardinality === 'list' ? 'multiple' : 'single'
      if (surface.cardinality !== expected) {
        throw new FeatureRegistrationError(
          'slot-cardinality-mismatch',
          `Feature "${candidate.manifest.id}" declares slot "${surface.slot}" as ${surface.cardinality}; product catalog requires ${expected}`,
        )
      }
      if (definition.protection === 'protected' && authority !== 'core') {
        throw new FeatureRegistrationError(
          'protected-slot',
          `Extension feature "${candidate.manifest.id}" cannot contribute to protected slot "${surface.slot}"`,
        )
      }
    }
  }
}

type CapabilityRequirementSnapshot = FeatureRequirements[number]

function validateDeclarations(
  declarations: FeatureContributionDeclarations | undefined,
  featureId: string,
): Required<FeatureContributionDeclarations> {
  if (declarations === undefined) return EMPTY_DECLARATIONS
  if (declarations === null || typeof declarations !== 'object') {
    throw new FeatureRegistrationError(
      'invalid-declarations',
      `Feature "${featureId}" has invalid contribution declarations`,
    )
  }
  const routes = validateNames(declarations.routes, featureId, 'routes')
  const commands = validateNames(declarations.commands, featureId, 'commands')
  const keymaps = validateNames(declarations.keymaps, featureId, 'keymaps')
  const resources = validateNames(declarations.resources, featureId, 'resources')
  const surfaces = declarations.surfaces ?? []
  if (!Array.isArray(surfaces)) {
    throw new FeatureRegistrationError(
      'invalid-declarations',
      `Feature "${featureId}" surfaces must be an array`,
    )
  }
  const surfaceSlots = new Set<string>()
  for (const surface of surfaces) {
    if (surface === null || typeof surface !== 'object') {
      throw new FeatureRegistrationError(
        'invalid-declarations',
        `Feature "${featureId}" has an invalid surface declaration`,
      )
    }
    const slot = requireTrimmedString(
      surface.slot,
      'Feature surface slot',
      'invalid-declarations',
    )
    if (surface.cardinality !== 'single' && surface.cardinality !== 'multiple') {
      throw new FeatureRegistrationError(
        'invalid-declarations',
        `Feature "${featureId}" surface "${slot}" has invalid cardinality`,
      )
    }
    if (surfaceSlots.has(slot)) {
      throw new FeatureRegistrationError(
        'duplicate-surface-declaration',
        `Feature "${featureId}" declares surface slot "${slot}" more than once`,
      )
    }
    surfaceSlots.add(slot)
  }
  const immutableSurfaces = Object.freeze(surfaces.map(surface => Object.freeze({
    slot: surface.slot,
    cardinality: surface.cardinality,
  })))
  return Object.freeze({
    routes,
    commands,
    keymaps,
    resources,
    surfaces: immutableSurfaces,
  })
}

function validateNames(
  values: readonly string[] | undefined,
  featureId: string,
  kind: string,
): readonly string[] {
  if (values === undefined) return Object.freeze([])
  if (!Array.isArray(values)) {
    throw new FeatureRegistrationError(
      'invalid-declarations',
      `Feature "${featureId}" ${kind} must be an array`,
    )
  }
  const names = new Set<string>()
  for (const value of values) {
    const name = requireTrimmedString(value, `Feature ${kind}`, 'invalid-declarations')
    if (names.has(name)) {
      const code = kind === 'routes' ? 'duplicate-route' : 'duplicate-declaration'
      throw new FeatureRegistrationError(
        code,
        `Feature "${featureId}" declares ${kind} entry "${name}" more than once`,
      )
    }
    names.add(name)
  }
  return Object.freeze([...values])
}

function isFeatureActivation(value: unknown): value is FeatureActivation {
  return value === 'eager' || value === 'on-command' || value === 'on-route'
}

function requireTrimmedString(
  value: unknown,
  label: string,
  code: FeatureRegistrationErrorCode,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new FeatureRegistrationError(code, `${label} must be a non-empty trimmed string`)
  }
  return value
}

function validateSlotCatalog(
  definitions: readonly FeatureSlotDefinition[],
): ReadonlyMap<string, FeatureSlotDefinition> {
  if (!Array.isArray(definitions)) {
    throw new FeatureRegistrationError(
      'invalid-slot-catalog',
      'Feature slot catalog must be an array',
    )
  }
  const catalog = new Map<string, FeatureSlotDefinition>()
  for (const candidate of definitions) {
    if (candidate === null
      || typeof candidate !== 'object'
      || typeof candidate.id !== 'string'
      || candidate.id.length === 0
      || candidate.id.trim() !== candidate.id
      || (candidate.cardinality !== 'single' && candidate.cardinality !== 'list')
      || (candidate.protection !== 'public' && candidate.protection !== 'protected')) {
      throw new FeatureRegistrationError(
        'invalid-slot-catalog',
        'Feature slot catalog contains an invalid definition',
      )
    }
    if (catalog.has(candidate.id)) {
      throw new FeatureRegistrationError(
        'duplicate-slot-definition',
        `Feature slot catalog defines "${candidate.id}" more than once`,
      )
    }
    catalog.set(candidate.id, Object.freeze({ ...candidate }))
  }
  return catalog
}
