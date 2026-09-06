import { Service, type Context } from '@deepseek-ai/cordis'
import {
  CapabilityRegistry,
  type CapabilityFactoryContext,
  type CapabilityRegistrationLease,
} from '../kernel/capability-registry.ts'
import type { CapabilityFactory, CapabilityToken } from '../kernel/capability.ts'
import {
  FEATURE_API_VERSION,
  type FeatureContributions,
  type FeatureFactory,
  type FeatureRequirements,
} from '../kernel/feature.ts'
import {
  FeatureRegistry,
  type FeatureRegistrationAuthority,
  type FeatureRegistrationLease,
  type RegisteredFeatureSnapshot,
} from '../kernel/feature-registry.ts'
import type {
  ActiveFeatureContributionSnapshot,
  DshTuiFeatureLifecycleSubscription,
  DshTuiFeatureRegistrationLease,
  DshTuiFeatureService,
} from '../kernel/feature-service.ts'
import type {
  FeatureSessionBindingLease,
  FeatureSessionBindingOptions,
} from '../kernel/feature-session.ts'
import {
  FeatureSupervisor,
  type ActiveFeatureUnloadedEvent,
  type FeatureCapabilityResolver,
  type FeatureContributionNormalizer,
  type FeatureStatus,
  type RequiredFeatureFailureEvent,
} from '../kernel/feature-supervisor.ts'
import {
  createDshTuiSlotDefinitions,
  type SlotDefinition,
} from '../layout/slots.ts'
import { ScopeManager } from '../lifecycle/scope-manager.ts'
import {
  applicationScopeHost,
  type ApplicationScopeHost,
} from '../lifecycle/application-scope-host.ts'
import { normalizeDshTuiFeatureContributions } from '../app/feature-contribution-contract.ts'

export interface DshTuiFeatureServiceOptions {
  /** Product-owned additions to the protected shell slot catalog. */
  readonly slots?: readonly SlotDefinition[]
  /** Product semantic validation performed before a Feature becomes active. */
  readonly normalizeContributions?: FeatureContributionNormalizer
  /** @deprecated Subscribe through the service so the observer follows its caller fiber. */
  readonly onActiveFeatureUnloaded?: (
    event: ActiveFeatureUnloadedEvent,
  ) => void | Promise<void>
  /** @deprecated Subscribe through the service so the observer follows its caller fiber. */
  readonly onRequiredFeatureFailure?: (
    event: RequiredFeatureFailureEvent,
  ) => void | Promise<void>
}

export interface DshTuiFeatureOwner {
  readonly service: CordisDshTuiFeatureService
  readonly slotDefinitions: readonly SlotDefinition[]
  /** Compatibility getter: reading it starts the otherwise dormant kernel. */
  readonly ready: Promise<readonly FeatureStatus[]>
  dispose(): Promise<void>
}

const installCoreFeature = Symbol('dsh-tui.install-core-feature')
const installExtensionFeature = Symbol('dsh-tui.install-extension-feature')
const installApplicationCapability = Symbol('dsh-tui.install-application-capability')

interface CoreFeatureInstaller {
  [installCoreFeature]<
    TRequirements extends FeatureRequirements,
    TContributions extends FeatureContributions,
  >(
    owner: Context,
    factory: FeatureFactory<TRequirements, TContributions>,
    lifecycle?: DshTuiCoreFeatureRegistrationLifecycle,
  ): DshTuiFeatureRegistrationLease
}

interface ExtensionFeatureInstaller {
  [installExtensionFeature]<
    TRequirements extends FeatureRequirements,
    TContributions extends FeatureContributions,
  >(
    owner: Context,
    factory: FeatureFactory<TRequirements, TContributions>,
    lifecycle?: DshTuiExtensionFeatureRegistrationLifecycle,
  ): DshTuiFeatureRegistrationLease
}

interface ApplicationCapabilityInstaller {
  [installApplicationCapability]<TValue>(
    owner: Context,
    factory: CapabilityFactory<TValue, CapabilityFactoryContext>,
    lifecycle?: DshTuiApplicationCapabilityRegistrationLifecycle,
  ): CapabilityRegistrationLease
}

export type DshTuiCoreFeatureRegistrationLifecycle = 'cordis' | 'external'
export type DshTuiExtensionFeatureRegistrationLifecycle = 'cordis' | 'external'
export type DshTuiApplicationCapabilityRegistrationLifecycle = 'cordis' | 'external'

interface BoundFeatureSession {
  readonly supervisor: FeatureSupervisor
  readonly releaseFromScope: () => Promise<void>
  active: boolean
  releaseTask: Promise<void> | undefined
}

/**
 * Composition-only installer for package-owned Features. It is deliberately
 * absent from DshTuiFeatureService so third-party Features cannot claim core
 * slot authority.
 */
export function registerDshTuiCoreFeature<
  TRequirements extends FeatureRequirements,
  TContributions extends FeatureContributions,
>(
  owner: Context,
  service: DshTuiFeatureService,
  factory: FeatureFactory<TRequirements, TContributions>,
  lifecycle: DshTuiCoreFeatureRegistrationLifecycle = 'cordis',
): DshTuiFeatureRegistrationLease {
  const install = (service as DshTuiFeatureService & CoreFeatureInstaller)[installCoreFeature]
  if (typeof install !== 'function') {
    throw new Error('dshTuiFeatures does not support package-owned Feature installation')
  }
  return install.call(service, owner, factory, lifecycle)
}

/**
 * Composition-owned Feature registration for package rows that intentionally
 * retain ordinary extension authority. The supplied row Context owns the
 * default Cordis lifecycle; protected product slots remain unavailable.
 */
export function registerDshTuiExtensionFeature<
  TRequirements extends FeatureRequirements,
  TContributions extends FeatureContributions,
>(
  owner: Context,
  service: DshTuiFeatureService,
  factory: FeatureFactory<TRequirements, TContributions>,
  lifecycle: DshTuiExtensionFeatureRegistrationLifecycle = 'cordis',
): DshTuiFeatureRegistrationLease {
  const install = (
    service as DshTuiFeatureService & ExtensionFeatureInstaller
  )[installExtensionFeature]
  if (typeof install !== 'function') {
    throw new Error('dshTuiFeatures does not support owned extension Feature installation')
  }
  return install.call(service, owner, factory, lifecycle)
}

/**
 * Composition-only application capability installer. The owner selects whether
 * Cordis or an outer serial resource chain releases the registry lease.
 */
export function registerDshTuiApplicationCapability<TValue>(
  owner: Context,
  service: DshTuiFeatureService,
  factory: CapabilityFactory<TValue, CapabilityFactoryContext>,
  lifecycle: DshTuiApplicationCapabilityRegistrationLifecycle = 'cordis',
): CapabilityRegistrationLease {
  const install = (
    service as DshTuiFeatureService & ApplicationCapabilityInstaller
  )[installApplicationCapability]
  if (typeof install !== 'function') {
    throw new Error('dshTuiFeatures does not support package-owned application capabilities')
  }
  return install.call(service, owner, factory, lifecycle)
}

/** App-scoped experimental extension service. Runtime state stays outside the registry. */
export class CordisDshTuiFeatureService extends Service implements DshTuiFeatureService {
  readonly slotDefinitions: readonly SlotDefinition[]
  private readonly features: FeatureRegistry
  private readonly capabilities = new CapabilityRegistry()
  private readonly scopes = new ScopeManager('dsh-tui')
  private readonly normalizeContributions: FeatureContributionNormalizer | undefined
  private readonly applicationScopes: ApplicationScopeHost = Object.freeze({
    appScope: this.scopes.app,
    createRuntimeSessionScope: (label: string) => this.scopes.createSession(label),
  })
  private readonly applicationSupervisor: FeatureSupervisor
  private readonly activeFeatureUnloadedListeners = new Set<(
    event: ActiveFeatureUnloadedEvent,
  ) => void | Promise<void>>()
  private readonly requiredFeatureFailureListeners = new Set<(
    event: RequiredFeatureFailureEvent,
  ) => void | Promise<void>>()
  private startTask: Promise<readonly FeatureStatus[]> | undefined
  private sessionBinding: BoundFeatureSession | undefined
  private sessionTransitionTail: Promise<void> = Promise.resolve()
  private disposeTask: Promise<void> | undefined

  constructor(
    ctx: Context,
    options: DshTuiFeatureServiceOptions = {},
    coreFeatures: readonly FeatureFactory[] = [],
  ) {
    super(ctx, 'dshTuiFeatures')
    this.slotDefinitions = createDshTuiSlotDefinitions(options.slots)
    this.normalizeContributions = options.normalizeContributions
    this.features = new FeatureRegistry(FEATURE_API_VERSION, this.slotDefinitions)
    if (options.onActiveFeatureUnloaded !== undefined) {
      this.activeFeatureUnloadedListeners.add(options.onActiveFeatureUnloaded)
    }
    if (options.onRequiredFeatureFailure !== undefined) {
      this.requiredFeatureFailureListeners.add(options.onRequiredFeatureFailure)
    }
    this.applicationSupervisor = new FeatureSupervisor({
      registry: this.features,
      scopeManager: this.scopes,
      featureScope: 'application',
      capabilities: this.capabilities,
      ...(options.normalizeContributions === undefined
        ? {}
        : { normalizeContributions: options.normalizeContributions }),
      onActiveFeatureUnloaded: event => this.notifyActiveFeatureUnloaded(event),
      onRequiredFeatureFailure: event => this.notifyRequiredFeatureFailure(event),
    })
    for (const feature of coreFeatures) {
      this.registerFeatureWithAuthority(ctx, feature, 'core')
    }
  }

  [applicationScopeHost](): ApplicationScopeHost {
    return this.applicationScopes
  }

  /** Startup is idempotent and activates every currently registered eager feature. */
  start(): Promise<readonly FeatureStatus[]> {
    this.assertUsable()
    this.startTask ??= this.runStart()
    return this.startTask
  }

  get ready(): Promise<readonly FeatureStatus[]> {
    return this.start()
  }

  registerFeature<
    TRequirements extends FeatureRequirements,
    TContributions extends FeatureContributions,
  >(
    factory: FeatureFactory<TRequirements, TContributions>,
  ): DshTuiFeatureRegistrationLease {
    return this.registerFeatureWithAuthority(this.ctx, factory, 'extension')
  }

  [installCoreFeature]<
    TRequirements extends FeatureRequirements,
    TContributions extends FeatureContributions,
  >(
    owner: Context,
    factory: FeatureFactory<TRequirements, TContributions>,
    lifecycle: DshTuiCoreFeatureRegistrationLifecycle = 'cordis',
  ): DshTuiFeatureRegistrationLease {
    return this.registerFeatureWithAuthority(owner, factory, 'core', lifecycle)
  }

  [installExtensionFeature]<
    TRequirements extends FeatureRequirements,
    TContributions extends FeatureContributions,
  >(
    owner: Context,
    factory: FeatureFactory<TRequirements, TContributions>,
    lifecycle: DshTuiExtensionFeatureRegistrationLifecycle = 'cordis',
  ): DshTuiFeatureRegistrationLease {
    return this.registerFeatureWithAuthority(owner, factory, 'extension', lifecycle)
  }

  [installApplicationCapability]<TValue>(
    owner: Context,
    factory: CapabilityFactory<TValue, CapabilityFactoryContext>,
    lifecycle: DshTuiApplicationCapabilityRegistrationLifecycle = 'cordis',
  ): CapabilityRegistrationLease {
    return this.registerApplicationCapabilityWithOwner(owner, factory, lifecycle)
  }

  private registerFeatureWithAuthority<
    TRequirements extends FeatureRequirements,
    TContributions extends FeatureContributions,
  >(
    owner: Context,
    factory: FeatureFactory<TRequirements, TContributions>,
    authority: FeatureRegistrationAuthority,
    lifecycle: DshTuiCoreFeatureRegistrationLifecycle = 'cordis',
  ): DshTuiFeatureRegistrationLease {
    this.assertUsable()
    let registration!: FeatureRegistrationLease
    const release = lifecycle === 'external'
      ? (() => {
          registration = this.features.register(factory, { authority })
          return () => registration.release()
        })()
      : owner.effect(() => {
          registration = this.features.register(factory, { authority })
          return () => registration.release()
        }, 'dsh-tui: feature registration')
    const snapshot = this.features.snapshotOf(factory)
    const activation = this.startTask === undefined
      || snapshot?.manifest.activation !== 'eager'
      ? Promise.resolve(undefined)
      : this.startTask.then(() => this.activateRegisteredEagerFeature(
          factory,
          registration.featureId,
          snapshot.manifest.scope,
        ))
    void activation.catch(() => {})
    return {
      featureId: registration.featureId,
      get active() {
        return registration.active
      },
      activation,
      release,
    }
  }

  registerCapability<TValue>(
    factory: CapabilityFactory<TValue, CapabilityFactoryContext>,
  ): CapabilityRegistrationLease {
    return this.registerApplicationCapabilityWithOwner(this.ctx, factory, 'cordis')
  }

  private registerApplicationCapabilityWithOwner<TValue>(
    owner: Context,
    factory: CapabilityFactory<TValue, CapabilityFactoryContext>,
    lifecycle: DshTuiApplicationCapabilityRegistrationLifecycle,
  ): CapabilityRegistrationLease {
    this.assertUsable()
    if (factory?.token?.scope !== 'application') {
      throw new Error('DSH-TUI application capability must declare application scope')
    }
    let registration!: CapabilityRegistrationLease
    const release = lifecycle === 'external'
      ? (() => {
          registration = this.capabilities.register(factory)
          return () => registration.release()
        })()
      : owner.effect(() => {
          registration = this.capabilities.register(factory)
          return () => registration.release()
        }, 'dsh-tui: application capability registration')
    return {
      tokenId: registration.tokenId,
      get active() {
        return registration.active
      },
      release,
    }
  }

  bindSession(options: FeatureSessionBindingOptions): Promise<FeatureSessionBindingLease> {
    this.assertUsable()
    return this.enqueueSessionTransition(() => this.bindSessionNow(options))
  }

  onActiveFeatureUnloaded(
    listener: (event: ActiveFeatureUnloadedEvent) => void | Promise<void>,
  ): DshTuiFeatureLifecycleSubscription {
    return this.subscribe(
      this.activeFeatureUnloadedListeners,
      listener,
      'dsh-tui: active Feature unload observer',
    )
  }

  onRequiredFeatureFailure(
    listener: (event: RequiredFeatureFailureEvent) => void | Promise<void>,
  ): DshTuiFeatureLifecycleSubscription {
    return this.subscribe(
      this.requiredFeatureFailureListeners,
      listener,
      'dsh-tui: required Feature failure observer',
    )
  }

  async activateRoute(route: string): Promise<readonly FeatureStatus[]> {
    await this.start()
    await this.sessionTransitionTail
    const application = await this.applicationSupervisor.activateRoute(route)
    const session = this.sessionBinding?.active === true
      ? await this.sessionBinding.supervisor.activateRoute(route)
      : []
    return mergeByFeatureId(application, session)
  }

  async activateCommand(commandId: string): Promise<readonly FeatureStatus[]> {
    await this.start()
    await this.sessionTransitionTail
    const application = await this.applicationSupervisor.activateCommand(commandId)
    const session = this.sessionBinding?.active === true
      ? await this.sessionBinding.supervisor.activateCommand(commandId)
      : []
    return mergeByFeatureId(application, session)
  }

  async activateFeature(featureId: string): Promise<FeatureStatus> {
    await this.start()
    await this.sessionTransitionTail
    const snapshot = this.features.snapshotOf(featureId)
    if (snapshot === undefined) throw new Error(`Feature "${featureId}" is not registered`)
    if (snapshot.manifest.scope === 'application') {
      return this.applicationSupervisor.activateFeature(featureId)
    }
    const binding = this.sessionBinding
    if (binding?.active !== true) return { featureId, state: 'inactive' }
    return binding.supervisor.activateFeature(featureId)
  }

  status(featureId: string): FeatureStatus | undefined {
    const active = this.applicationSupervisor.status(featureId)
      ?? this.sessionBinding?.supervisor.status(featureId)
    if (active !== undefined) return active
    const snapshot = this.features.snapshotOf(featureId)
    return snapshot?.manifest.scope === 'session'
      ? { featureId, state: 'inactive' }
      : undefined
  }

  contributionsFor(featureId: string): FeatureContributions | undefined {
    return this.applicationSupervisor.contributionsFor(featureId)
      ?? this.sessionBinding?.supervisor.contributionsFor(featureId)
  }

  listRegisteredFeatures(): readonly RegisteredFeatureSnapshot[] {
    return Object.freeze(this.features.list().map(
      factory => this.features.snapshotOf(factory)!,
    ))
  }

  listActiveContributions(): readonly ActiveFeatureContributionSnapshot[] {
    return mergeByFeatureId(
      this.applicationSupervisor.listActiveContributions(),
      this.sessionBinding?.supervisor.listActiveContributions() ?? [],
    )
  }

  dispose(): Promise<void> {
    this.disposeTask ??= this.runDispose()
    return this.disposeTask
  }

  private subscribe<TListener extends (...args: never[]) => unknown>(
    listeners: Set<TListener>,
    listener: TListener,
    label: string,
  ): DshTuiFeatureLifecycleSubscription {
    this.assertUsable()
    return this.ctx.effect(() => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }, label)
  }

  private notifyActiveFeatureUnloaded(event: ActiveFeatureUnloadedEvent): Promise<void> {
    return notifyFeatureLifecycleListeners(
      this.activeFeatureUnloadedListeners,
      event,
      'Active Feature unload observers failed',
    )
  }

  private notifyRequiredFeatureFailure(event: RequiredFeatureFailureEvent): Promise<void> {
    return notifyFeatureLifecycleListeners(
      this.requiredFeatureFailureListeners,
      event,
      'Required Feature failure observers failed',
    )
  }

  private async runStart(): Promise<readonly FeatureStatus[]> {
    const application = await this.applicationSupervisor.start()
    const binding = this.sessionBinding
    const session = binding?.active === true
      ? await binding.supervisor.start()
      : []
    return mergeByFeatureId(application, session)
  }

  private async activateRegisteredEagerFeature(
    factory: FeatureFactory,
    featureId: string,
    scope: 'application' | 'session',
  ): Promise<FeatureStatus | undefined> {
    await this.sessionTransitionTail
    if (this.features.get(featureId) !== factory) return undefined
    if (scope === 'application') {
      return this.applicationSupervisor.activateFeature(featureId)
    }
    const binding = this.sessionBinding
    if (binding?.active !== true) return undefined
    return binding.supervisor.activateFeature(featureId)
  }

  private enqueueSessionTransition<TValue>(
    operation: () => Promise<TValue>,
  ): Promise<TValue> {
    const task = this.sessionTransitionTail.then(operation, operation)
    this.sessionTransitionTail = task.then(() => {}, () => {})
    return task
  }

  private async bindSessionNow(
    options: FeatureSessionBindingOptions,
  ): Promise<FeatureSessionBindingLease> {
    const shouldStart = this.startTask !== undefined
    if (shouldStart) await this.startTask
    const previous = this.sessionBinding
    if (previous !== undefined) await this.releaseSession(previous)
    this.assertUsable()

    const supervisor = new FeatureSupervisor({
      registry: this.features,
      scopeManager: this.scopes,
      featureScope: 'session',
      sessionScope: options.scope,
      capabilities: this.sessionCapabilityResolver(options.capabilities),
      notifyActiveFeatureUnloadedOnRelease: true,
      ...(this.normalizeContributions === undefined
        ? {}
        : { normalizeContributions: this.normalizeContributions }),
      onActiveFeatureUnloaded: event => this.notifyActiveFeatureUnloaded(event),
      onRequiredFeatureFailure: event => this.notifyRequiredFeatureFailure(event),
    })
    let record!: BoundFeatureSession
    let releaseFromScope: () => Promise<void>
    try {
      releaseFromScope = options.scope.defer(
        () => this.releaseSessionNow(record),
      )
    } catch (error: unknown) {
      await supervisor.dispose()
      throw error
    }
    record = {
      supervisor,
      releaseFromScope,
      active: true,
      releaseTask: undefined,
    }
    this.sessionBinding = record
    try {
      if (shouldStart) await supervisor.start()
    } catch (error: unknown) {
      try {
        await this.releaseSession(record)
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          'Session Feature binding activation cleanup failed',
        )
      }
      throw error
    }

    return {
      get active() {
        return record.active
      },
      release: () => this.enqueueSessionTransition(
        () => this.releaseSession(record),
      ),
    }
  }

  private releaseSession(record: BoundFeatureSession): Promise<void> {
    return record.releaseFromScope()
  }

  private sessionCapabilityResolver(
    sessionCapabilities: FeatureCapabilityResolver,
  ): FeatureCapabilityResolver {
    return Object.freeze({
      resolve: <TValue>(token: CapabilityToken<TValue>, scope: FeatureSessionBindingOptions['scope']) =>
        token.scope === 'application'
        ? this.capabilities.resolve(token, scope)
        : sessionCapabilities.resolve(token, scope),
    })
  }

  private releaseSessionNow(record: BoundFeatureSession): Promise<void> {
    record.releaseTask ??= (async () => {
      record.active = false
      /* v8 ignore else -- a first release always owns the currently published binding. */
      if (this.sessionBinding === record) this.sessionBinding = undefined
      await record.supervisor.dispose()
    })()
    return record.releaseTask
  }

  private async runDispose(): Promise<void> {
    this.scopes.abort('dsh-tui feature service disposed')
    const errors: unknown[] = []
    await this.sessionTransitionTail
    const session = this.sessionBinding
    if (session !== undefined) {
      try {
        await this.releaseSession(session)
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    try {
      await this.applicationSupervisor.dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await this.scopes.dispose('dsh-tui feature service disposed')
    } catch (error: unknown) {
      errors.push(error)
    }
    this.activeFeatureUnloadedListeners.clear()
    this.requiredFeatureFailureListeners.clear()
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'DshTuiFeatureService disposal failed')
    }
  }

  private assertUsable(): void {
    if (this.disposeTask !== undefined) {
      throw new Error('DshTuiFeatureService is disposed')
    }
  }
}

/** Install an inert app microkernel. The Product decides when startup begins. */
export function provideDshTuiFeatures(
  ctx: Context,
  options: DshTuiFeatureServiceOptions = {},
  coreFeatures: readonly FeatureFactory[] = [],
): DshTuiFeatureOwner {
  const service = new CordisDshTuiFeatureService(ctx, {
    ...options,
    normalizeContributions: options.normalizeContributions
      ?? normalizeDshTuiFeatureContributions,
  }, coreFeatures)
  let disposeTask: Promise<void> | undefined
  return {
    service,
    slotDefinitions: service.slotDefinitions,
    get ready() {
      return service.ready
    },
    dispose() {
      disposeTask ??= service.dispose()
      return disposeTask
    },
  }
}

async function notifyFeatureLifecycleListeners<TEvent>(
  listeners: ReadonlySet<(event: TEvent) => void | Promise<void>>,
  event: TEvent,
  message: string,
): Promise<void> {
  const outcomes = await Promise.allSettled(
    [...listeners].map(listener => Promise.resolve().then(() => listener(event))),
  )
  const errors = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    .map(outcome => outcome.reason)
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

function mergeByFeatureId<TItem extends { readonly featureId: string }>(
  ...groups: readonly (readonly TItem[])[]
): readonly TItem[] {
  const items = new Map<string, TItem>()
  for (const group of groups) {
    for (const item of group) {
      /* v8 ignore else -- one registry identity cannot be active in both scope supervisors. */
      if (!items.has(item.featureId)) items.set(item.featureId, item)
    }
  }
  return Object.freeze([...items.values()])
}
