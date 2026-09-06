import type {
  CapabilityFactoryContext,
  CapabilityRegistrationLease,
} from './capability-registry.ts'
import type { CapabilityFactory } from './capability.ts'
import type {
  FeatureContributions,
  FeatureFactory,
  FeatureRequirements,
} from './feature.ts'
import type { FeatureRegistrationLease } from './feature-registry.ts'
import type {
  FeatureRegistrationProvenance,
  RegisteredFeatureSnapshot,
} from './feature-registry.ts'
import type {
  FeatureSessionBindingLease,
  FeatureSessionBindingOptions,
} from './feature-session.ts'
import type {
  ActiveFeatureUnloadedEvent,
  FeatureStatus,
  RequiredFeatureFailureEvent,
} from './feature-supervisor.ts'

export type DshTuiFeatureLifecycleSubscription = () => void | Promise<void>

export interface DshTuiFeatureRegistrationLease extends FeatureRegistrationLease {
  /** Eager activation result when registered after the service has started. */
  readonly activation: Promise<FeatureStatus | undefined>
}

/** Registry-owned provenance; a Feature cannot elevate its own slot authority. */
export interface ActiveFeatureContributionSnapshot {
  readonly featureId: string
  readonly provenance: FeatureRegistrationProvenance
  readonly contributions: FeatureContributions
}

/** Experimental, DSH-agnostic public surface of the app-scoped microkernel. */
export interface DshTuiFeatureService {
  readonly ready: Promise<readonly FeatureStatus[]>
  start(): Promise<readonly FeatureStatus[]>
  registerFeature<
    TRequirements extends FeatureRequirements,
    TContributions extends FeatureContributions,
  >(
    factory: FeatureFactory<TRequirements, TContributions>,
  ): DshTuiFeatureRegistrationLease
  registerCapability<TValue>(
    factory: CapabilityFactory<TValue, CapabilityFactoryContext>,
  ): CapabilityRegistrationLease
  bindSession(options: FeatureSessionBindingOptions): Promise<FeatureSessionBindingLease>
  onActiveFeatureUnloaded(
    listener: (event: ActiveFeatureUnloadedEvent) => void | Promise<void>,
  ): DshTuiFeatureLifecycleSubscription
  onRequiredFeatureFailure(
    listener: (event: RequiredFeatureFailureEvent) => void | Promise<void>,
  ): DshTuiFeatureLifecycleSubscription
  activateRoute(route: string): Promise<readonly FeatureStatus[]>
  activateCommand(commandId: string): Promise<readonly FeatureStatus[]>
  activateFeature(featureId: string): Promise<FeatureStatus>
  status(featureId: string): FeatureStatus | undefined
  contributionsFor(featureId: string): FeatureContributions | undefined
  /** Immutable static catalog; available before on-route/on-command activation. */
  listRegisteredFeatures(): readonly RegisteredFeatureSnapshot[]
  listActiveContributions(): readonly ActiveFeatureContributionSnapshot[]
}
