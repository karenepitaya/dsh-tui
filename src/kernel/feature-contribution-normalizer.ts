import type {
  FeatureContribution,
  FeatureContributions,
  FeatureSurfaceContribution,
} from './feature.ts'
import type { RegisteredFeatureSnapshot } from './feature-registry.ts'

export type FeatureContributionContractErrorCode =
  | 'invalid-envelope'
  | 'unknown-contribution-kind'
  | 'invalid-collection'
  | 'invalid-contribution'
  | 'invalid-id'
  | 'invalid-slot'
  | 'undeclared-contribution'
  | 'undeclared-slot'
  | 'duplicate-contribution'

export class FeatureContributionContractError extends Error {
  readonly code: FeatureContributionContractErrorCode
  readonly featureId: string

  constructor(
    code: FeatureContributionContractErrorCode,
    featureId: string,
    message: string,
  ) {
    super(message)
    this.name = 'FeatureContributionContractError'
    this.code = code
    this.featureId = featureId
  }
}

const CONTRIBUTION_KINDS = Object.freeze([
  'routes',
  'commands',
  'keymaps',
  'resources',
  'surfaces',
] as const)

type ContributionKind = typeof CONTRIBUTION_KINDS[number]
type PlainContributionKind = Exclude<ContributionKind, 'surfaces'>

/**
 * Validates the runtime projection against the immutable registration contract.
 * Opaque contribution values keep their identity; only the publishable topology
 * is copied and frozen.
 */
export function normalizeFeatureContributions(
  factory: RegisteredFeatureSnapshot,
  input: unknown,
): FeatureContributions {
  const featureId = factory.manifest.id
  if (!isRecord(input)) {
    throw contractError(
      'invalid-envelope',
      featureId,
      'runtime contributions must be an object',
    )
  }
  const allowedKinds = new Set<string>(CONTRIBUTION_KINDS)
  for (const key of Object.keys(input)) {
    if (!allowedKinds.has(key)) {
      throw contractError(
        'unknown-contribution-kind',
        featureId,
        `runtime contributions contain unknown kind "${key}"`,
      )
    }
  }

  const normalized: Partial<Record<ContributionKind, readonly unknown[]>> = {}
  for (const kind of CONTRIBUTION_KINDS) {
    if (!Object.hasOwn(input, kind)) continue
    const collection = input[kind]
    if (!Array.isArray(collection)) {
      throw contractError(
        'invalid-collection',
        featureId,
        `runtime ${kind} contributions must be an array`,
      )
    }
    normalized[kind] = kind === 'surfaces'
      ? normalizeSurfaces(factory, collection)
      : normalizePlainContributions(factory, kind, collection)
  }
  return Object.freeze(normalized) as FeatureContributions
}

function normalizePlainContributions(
  factory: RegisteredFeatureSnapshot,
  kind: PlainContributionKind,
  collection: readonly unknown[],
): readonly FeatureContribution[] {
  const featureId = factory.manifest.id
  const declarations = new Set(factory.declarations[kind])
  const ids = new Set<string>()
  const normalized: FeatureContribution[] = []
  for (const candidate of collection) {
    const contribution = requireContribution(candidate, featureId, kind)
    const id = requireTrimmedString(contribution.id, featureId, kind, 'id')
    if (!declarations.has(id)) {
      throw contractError(
        'undeclared-contribution',
        featureId,
        `runtime ${kind} contribution "${id}" was not declared`,
      )
    }
    if (ids.has(id)) {
      throw contractError(
        'duplicate-contribution',
        featureId,
        `runtime ${kind} contribution "${id}" appears more than once`,
      )
    }
    ids.add(id)
    normalized.push(Object.freeze({ id, value: contribution.value }))
  }
  return Object.freeze(normalized)
}

function normalizeSurfaces(
  factory: RegisteredFeatureSnapshot,
  collection: readonly unknown[],
): readonly FeatureSurfaceContribution[] {
  const featureId = factory.manifest.id
  const declarations = new Set(factory.declarations.surfaces.map(surface => surface.slot))
  const ids = new Set<string>()
  const normalized: FeatureSurfaceContribution[] = []
  for (const candidate of collection) {
    const contribution = requireContribution(candidate, featureId, 'surfaces')
    const id = requireTrimmedString(contribution.id, featureId, 'surfaces', 'id')
    const slot = requireTrimmedString(contribution.slot, featureId, 'surfaces', 'slot')
    if (!declarations.has(slot)) {
      throw contractError(
        'undeclared-slot',
        featureId,
        `runtime surface "${id}" targets undeclared slot "${slot}"`,
      )
    }
    if (ids.has(id)) {
      throw contractError(
        'duplicate-contribution',
        featureId,
        `runtime surface contribution "${id}" appears more than once`,
      )
    }
    ids.add(id)
    normalized.push(Object.freeze({ id, slot, value: contribution.value }))
  }
  return Object.freeze(normalized)
}

function requireContribution(
  input: unknown,
  featureId: string,
  kind: ContributionKind,
): Record<string, unknown> {
  if (!isRecord(input) || !Object.hasOwn(input, 'value')) {
    throw contractError(
      'invalid-contribution',
      featureId,
      `runtime ${kind} entries must be objects with an own value property`,
    )
  }
  return input
}

function requireTrimmedString(
  input: unknown,
  featureId: string,
  kind: ContributionKind,
  field: 'id' | 'slot',
): string {
  if (typeof input !== 'string' || input.length === 0 || input.trim() !== input) {
    const code = field === 'id' ? 'invalid-id' : 'invalid-slot'
    throw contractError(
      code,
      featureId,
      `runtime ${kind} ${field} must be a non-empty trimmed string`,
    )
  }
  return input
}

function contractError(
  code: FeatureContributionContractErrorCode,
  featureId: string,
  detail: string,
): FeatureContributionContractError {
  return new FeatureContributionContractError(
    code,
    featureId,
    `Feature "${featureId}" ${detail}`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
