import type {
  CapabilityScope,
  CapabilityToken,
  MaybePromise,
} from './capability.ts'
import type { ResourceScope } from '../lifecycle/scope-manager.ts'

export const FEATURE_API_VERSION = 1

export type FeatureScope = CapabilityScope
export type FeatureActivation = 'eager' | 'on-command' | 'on-route'
export type FeatureSlotCardinality = 'single' | 'multiple'

export type FeatureRequirements = readonly CapabilityToken<unknown>[]

export type CapabilityValue<TToken extends CapabilityToken<unknown>> =
  TToken extends CapabilityToken<infer TValue> ? TValue : never

export interface ResolvedFeatureDependency<
  TToken extends CapabilityToken<unknown> = CapabilityToken<unknown>,
> {
  readonly token: TToken
  readonly value: CapabilityValue<TToken>
}

export type ResolveRequirements<TRequirements extends FeatureRequirements> = {
  readonly [TIndex in keyof TRequirements]:
    TRequirements[TIndex] extends CapabilityToken<unknown>
      ? ResolvedFeatureDependency<TRequirements[TIndex]>
      : never
}

export interface FeatureCreateContext<
  TDependencies extends readonly ResolvedFeatureDependency[] =
    readonly ResolvedFeatureDependency[],
> {
  readonly scope: ResourceScope
  readonly dependencies: TDependencies
}

export interface FeatureManifest<
  TRequirements extends FeatureRequirements = FeatureRequirements,
> {
  readonly id: string
  readonly apiVersion: number
  readonly scope: FeatureScope
  readonly activation: FeatureActivation
  readonly required: boolean
  /** Required even when empty so dependencies never become ambient. */
  readonly requires: TRequirements
}

/** Static declarations used for trigger lookup and conflict preflight. */
export interface FeatureSurfaceDeclaration {
  readonly slot: string
  readonly cardinality: FeatureSlotCardinality
}

export interface FeatureContributionDeclarations {
  readonly routes?: readonly string[]
  readonly commands?: readonly string[]
  readonly keymaps?: readonly string[]
  readonly resources?: readonly string[]
  readonly surfaces?: readonly FeatureSurfaceDeclaration[]
}

export interface FeatureContribution<TValue = unknown> {
  readonly id: string
  readonly value: TValue
}

export interface FeatureSurfaceContribution<TValue = unknown>
  extends FeatureContribution<TValue> {
  readonly slot: string
}

export interface FeatureContributions<
  TRoute = unknown,
  TCommand = unknown,
  TKeymap = unknown,
  TResource = unknown,
  TSurface = unknown,
> {
  readonly routes?: readonly FeatureContribution<TRoute>[]
  readonly commands?: readonly FeatureContribution<TCommand>[]
  readonly keymaps?: readonly FeatureContribution<TKeymap>[]
  readonly resources?: readonly FeatureContribution<TResource>[]
  readonly surfaces?: readonly FeatureSurfaceContribution<TSurface>[]
}

export interface FeatureInstance<
  TContributions extends FeatureContributions = FeatureContributions,
> {
  readonly contributions: TContributions
  dispose(): MaybePromise<void>
}

export interface FeatureFactory<
  TRequirements extends FeatureRequirements = FeatureRequirements,
  TContributions extends FeatureContributions = FeatureContributions,
> {
  readonly manifest: FeatureManifest<TRequirements>
  readonly declarations?: FeatureContributionDeclarations
  create(
    context: FeatureCreateContext<ResolveRequirements<TRequirements>>,
  ): MaybePromise<FeatureInstance<TContributions>>
}
