import type { TerminalInputAction } from '../terminal/input.ts'
import type { DshTuiNavigationKeys } from '../preferences/contracts.ts'
import { acceptsNavigationKey } from '../navigation/preferences.ts'
import type {
  ActiveFeatureContributionSnapshot,
  DshTuiFeatureService,
} from '../kernel/feature-service.ts'
import type { ActiveFeatureUnloadedEvent } from '../kernel/feature-supervisor.ts'
import {
  contributeToSlot,
  createDshTuiSlotDefinitions,
  createSlotRegistry,
  type SlotContribution,
  type SlotDefinition,
  type SlotRegistry,
} from '../layout/slots.ts'
import {
  type LayoutRegion,
} from '../layout/strategy.ts'
import {
  FeatureHostContractError,
  requireCommandHandler,
  requireFeatureKeymap,
  requireLayoutRegion,
  requireNavigationRoute,
  requireResourceDefinition,
  type FeatureCommandHandler,
  type FeatureKeymap,
} from './feature-contribution-contract.ts'
import type { ResourceDefinition } from '../resource/resource-coordinator.ts'
import {
  mapTerminalKey,
  routeUiCommand,
  type RoutedUiCommand,
  type TerminalKey,
} from '../navigation/commands.ts'
import {
  createNavigationState,
  routeFeatureId,
  transitionNavigation,
  type NavigationRoute,
  type NavigationState,
  type WorkspacePane,
} from '../navigation/state.ts'

export {
  FeatureHostContractError,
  type FeatureCommandContext,
  type FeatureCommandHandler,
  type FeatureHostContractErrorCode,
} from './feature-contribution-contract.ts'

export interface ProjectedFeatureRoute {
  readonly id: string
  readonly featureId: string
  readonly route: NavigationRoute
}

export interface AvailableFeatureRoute {
  readonly id: string
  readonly featureId: string
}

export interface ProjectedFeatureCommand {
  readonly id: string
  readonly featureId: string
  readonly handler: FeatureCommandHandler
}

export interface ProjectedFeatureResource {
  readonly id: string
  readonly featureId: string
  readonly definition: ResourceDefinition<unknown>
}

export interface ProjectedFeatureKeymap {
  readonly id: string
  readonly featureId: string
  readonly keymap: FeatureKeymap
}

export interface FeatureHostProjectionIssue {
  readonly featureId: string
  readonly error: FeatureHostContractError | Error
}

export interface FeatureHostSnapshot {
  readonly navigation: NavigationState
  /** Static declarations, including dormant on-route Features. */
  readonly availableRoutes?: readonly AvailableFeatureRoute[]
  readonly routes: readonly ProjectedFeatureRoute[]
  readonly commands: readonly ProjectedFeatureCommand[]
  /** Optional only so test and adapter snapshots from the strangler seam remain source-compatible. */
  readonly keymaps?: readonly ProjectedFeatureKeymap[]
  readonly resources: readonly ProjectedFeatureResource[]
  readonly slots: SlotRegistry<LayoutRegion>
  readonly regions: readonly LayoutRegion[]
  readonly issues: readonly FeatureHostProjectionIssue[]
}

export interface FeatureHostDispatch {
  readonly handled: boolean
  readonly completion: Promise<void>
}

interface CompleteFeatureHostSnapshot extends FeatureHostSnapshot {
  readonly availableRoutes: readonly AvailableFeatureRoute[]
  readonly keymaps: readonly ProjectedFeatureKeymap[]
}

export interface DshTuiFeatureHostPort {
  readonly navigation: NavigationState
  start(): Promise<void>
  openRoute(routeId: string): Promise<void>
  dispatchUiCommand(commandId: string, command: RoutedUiCommand): Promise<boolean>
  dispatchTerminalAction(action: TerminalInputAction): FeatureHostDispatch
  handleActiveFeatureUnloaded(event: ActiveFeatureUnloadedEvent): Promise<void>
  snapshot(): FeatureHostSnapshot
  onChanged(listener: (snapshot: FeatureHostSnapshot) => void): () => void
  dispose(): void
}

export interface DshTuiFeatureHostOptions {
  readonly navigationKeys?: () => DshTuiNavigationKeys
  /** Legacy convenience: product-owned additions to the default shell catalog. */
  readonly slots?: readonly SlotDefinition[]
  /** Complete product-owned catalog shared with the FeatureRegistry. */
  readonly slotDefinitions?: readonly SlotDefinition[]
}

const NOT_HANDLED: FeatureHostDispatch = Object.freeze({
  handled: false,
  completion: Promise.resolve(),
})

/**
 * Application-layer Strangler bridge. It activates factories, validates their
 * opaque contribution values, and exposes one immutable shell projection.
 */
export class DshTuiFeatureHost implements DshTuiFeatureHostPort {
  private navigationState = createNavigationState()
  private current: CompleteFeatureHostSnapshot
  private readonly baseSlots: SlotRegistry<LayoutRegion>
  private readonly listeners = new Set<(snapshot: FeatureHostSnapshot) => void>()
  private operation: Promise<void> = Promise.resolve()
  private navigationGeneration = 0
  private pendingRouteGeneration: number | undefined
  private started = false
  private disposed = false

  constructor(
    private readonly service: DshTuiFeatureService,
    private readonly options: DshTuiFeatureHostOptions = {},
  ) {
    if (options.slots !== undefined && options.slotDefinitions !== undefined) {
      throw new Error('Feature host accepts either slots or slotDefinitions, not both')
    }
    const slotDefinitions = options.slotDefinitions
      ?? createDshTuiSlotDefinitions(options.slots)
    this.baseSlots = createSlotRegistry<LayoutRegion>(slotDefinitions)
    this.current = freezeSnapshot(
      this.navigationState,
      this.baseSlots,
      availableRoutes(this.service),
      [],
      [],
      [],
      [],
      [],
    )
  }

  get navigation(): NavigationState {
    return this.navigationState
  }

  start(): Promise<void> {
    const generation = this.navigationGeneration
    return this.enqueue(async () => {
      if (this.started) return
      await this.service.ready
      this.assertUsable()
      this.started = true
      if (this.isCurrent(generation)) await this.openRouteNow('chat', generation)
    })
  }

  openRoute(routeId: string): Promise<void> {
    return this.openRouteNow(routeId, this.invalidateNavigation())
  }

  dispatchUiCommand(commandId: string, command: RoutedUiCommand): Promise<boolean> {
    const generation = this.navigationGeneration
    if (command.command.type === 'mode.set' || command.command.type === 'navigation.back'
      || command.command.type === 'navigation.focus') {
      return this.dispatchUiCommandNow(commandId, command, generation)
    }
    return this.enqueue(() => this.isCurrent(generation)
      ? this.dispatchUiCommandNow(commandId, command, generation)
      : Promise.resolve(false))
  }

  dispatchTerminalAction(action: TerminalInputAction): FeatureHostDispatch {
    if (this.disposed) return NOT_HANDLED
    const key = terminalKeyOf(action)
    if (key !== undefined) {
      if (action.type === 'save-default' && findFeatureBinding(this.current.keymaps, this.navigationState, key) === undefined) return NOT_HANDLED
      return this.dispatchTerminalKey(key)
    }
    const onFeatureSurface = this.navigationState.route.kind !== 'chat'
      || this.navigationState.overlays.length > 0
    if (!onFeatureSurface) return NOT_HANDLED
    return isLegacyShellAction(action)
      ? NOT_HANDLED
      : Object.freeze({ handled: true, completion: Promise.resolve() })
  }

  dispatchTerminalKey(key: TerminalKey): FeatureHostDispatch {
    if (this.disposed) return NOT_HANDLED
    if (key.type === 'named' && key.key === 'escape' && !key.ctrl && !key.alt
      && (this.pendingRouteGeneration !== undefined
        || this.navigationState.route.kind !== 'chat'
        || this.navigationState.overlays.length > 0)) {
      /* A workspace Feature keymap may claim Escape (e.g. closing an in-page modal). */
      const featureBinding = this.pendingRouteGeneration === undefined
        && this.navigationState.overlays.length === 0
        ? findFeatureBinding(this.current.keymaps, this.navigationState, key)
        : undefined
      if (featureBinding !== undefined) {
        const semantic = Object.freeze({
          type: 'feature.command' as const,
          commandId: featureBinding.commandId,
        })
        const routed: RoutedUiCommand = Object.freeze({
          target: featureCommandTarget(this.navigationState),
          command: semantic,
        })
        return Object.freeze({
          handled: true,
          completion: this.dispatchUiCommand(featureBinding.commandId, routed).then(() => {}),
        })
      }
      const routed = routeUiCommand(this.navigationState, { type: 'navigation.back' })
      return Object.freeze({ handled: true, completion: this.dispatchUiCommand('navigation.back', routed).then(() => {}) })
    }
    if (this.navigationState.route.kind === 'chat' && this.navigationState.overlays.length === 0) return NOT_HANDLED
    if (!acceptsNavigationKey(key, this.navigationState.mode, this.options.navigationKeys?.() ?? 'both')) {
      return Object.freeze({ handled: true, completion: Promise.resolve() })
    }
    const value = mapTerminalKey(key, { navigation: this.navigationState })
    if (value !== undefined && isReservedShellCommand(value)) {
      const routed = routeUiCommand(this.navigationState, value)
      if (value.type !== 'mode.set' && value.type !== 'navigation.focus') return NOT_HANDLED
      return Object.freeze({
        handled: true,
        completion: this.dispatchUiCommand(value.type, routed).then(() => {}),
      })
    }
    if (value !== undefined && this.detailScroller() !== undefined
      && (value.type === 'navigation.page'
        || (value.type === 'navigation.move' && (value.direction === 'up' || value.direction === 'down')))) {
      return Object.freeze({
        handled: true,
        completion: this.dispatchUiCommand(value.type, routeUiCommand(this.navigationState, value)).then(() => {}),
      })
    }
    const featureBinding = findFeatureBinding(
      this.current.keymaps,
      this.navigationState,
      key,
    )
    if (featureBinding !== undefined) {
      const semantic = Object.freeze({
        type: 'feature.command' as const,
        commandId: featureBinding.commandId,
      })
      const routed: RoutedUiCommand = Object.freeze({
        target: featureCommandTarget(this.navigationState),
        command: semantic,
      })
      return Object.freeze({
        handled: true,
        completion: this.dispatchUiCommand(featureBinding.commandId, routed).then(() => {}),
      })
    }
    if (value === undefined) {
      return Object.freeze({ handled: true, completion: Promise.resolve() })
    }
    const routed = routeUiCommand(this.navigationState, value)
    if (routed.target.kind === 'composer') return NOT_HANDLED
    return Object.freeze({
      handled: true,
      completion: this.dispatchUiCommand(value.type, routed).then(() => {}),
    })
  }

  handleActiveFeatureUnloaded(event: ActiveFeatureUnloadedEvent): Promise<void> {
    try {
      // Unload is a supervisor callback and may be caused by the active command
      // itself. Applying it immediately avoids queueing behind that command while
      // the command is awaiting its own registration release.
      const transition = transitionNavigation(this.navigationState, {
        type: 'feature-disposed',
        featureId: event.featureId,
      })
      if (transition.state !== this.navigationState) this.invalidateNavigation()
      this.navigationState = transition.state
      this.refresh()
      return Promise.resolve()
    } catch (error: unknown) {
      return Promise.reject(error)
    }
  }

  snapshot(): FeatureHostSnapshot {
    const declared = availableRoutes(this.service)
    if (!sameAvailableRoutes(this.current.availableRoutes, declared)) {
      this.current = freezeSnapshot(
        this.navigationState,
        this.current.slots,
        declared,
        this.current.routes,
        this.current.commands,
        this.current.keymaps,
        this.current.resources,
        this.current.issues,
      )
    }
    return this.current
  }

  onChanged(listener: (snapshot: FeatureHostSnapshot) => void): () => void {
    this.assertUsable()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.invalidateNavigation()
    this.listeners.clear()
  }

  private async openRouteNow(routeId: string, generation: number): Promise<void> {
    this.assertUsable()
    this.pendingRouteGeneration = generation
    try {
      await this.service.activateRoute(routeId)
    } catch (error: unknown) {
      if (this.isCurrent(generation)) throw error
      return
    } finally {
      if (this.pendingRouteGeneration === generation) this.pendingRouteGeneration = undefined
    }
    if (!this.isCurrent(generation)) return
    const projection = projectContributions(
      this.service.listActiveContributions(),
      this.baseSlots,
    )
    const matches = projection.routes.filter(route => route.id === routeId)
    if (matches.length === 0) {
      throw new FeatureHostContractError(
        'missing-route',
        '<host>',
        routeId,
        `Activated route "${routeId}" has no active route contribution`,
      )
    }
    if (matches.length > 1) {
      throw new FeatureHostContractError(
        'ambiguous-route',
        '<host>',
        routeId,
        `Activated route "${routeId}" has multiple active owners`,
      )
    }
    const transition = transitionNavigation(this.navigationState, {
      type: 'navigate',
      route: matches[0]!.route,
    })
    this.navigationState = transition.state
    this.publish(projection)
  }

  private async dispatchUiCommandNow(
    commandId: string,
    command: RoutedUiCommand,
    generation: number,
  ): Promise<boolean> {
    this.assertUsable()
    if (command.command.type === 'mode.set') {
      if (this.navigationState.route.kind !== 'chat' && this.navigationState.overlays.length === 0) {
        if (command.command.mode === 'insert' && !this.current.commands.some(candidate => (
          candidate.featureId === routeFeatureId(this.navigationState.route) && candidate.id === 'edit.insert'
        ))) return false
        const pane = this.workspacePanes()[0]
        if (pane !== undefined) this.navigationState = transitionNavigation(this.navigationState, {
          type: 'select-pane', pane,
        }).state
      }
      const transition = transitionNavigation(this.navigationState, {
        type: 'set-mode',
        mode: command.command.mode,
      })
      this.navigationState = transition.state
      this.refresh()
      return transition.effects.length > 0
    }
    if (command.command.type === 'navigation.back') {
      this.invalidateNavigation()
      if (this.navigationState.overlays.length > 0) {
        const transition = transitionNavigation(this.navigationState, { type: 'pop-overlay' })
        this.navigationState = transition.state
        this.refresh()
      } else if (this.navigationState.route.kind !== 'chat') {
        this.navigationState = transitionNavigation(this.navigationState, {
          type: 'navigate', route: { kind: 'chat' },
        }).state
        this.refresh()
      }
      return true
    }
    if (command.command.type === 'navigation.focus') {
      const route = this.navigationState.route
      if (route.kind === 'chat' || this.navigationState.overlays.length > 0) return false
      const panes = this.workspacePanes()
      if (panes.length === 0) return false
      const index = Math.max(0, panes.indexOf(route.pane))
      const delta = command.command.direction === 'next' ? 1 : -1
      const pane = panes[(index + delta + panes.length) % panes.length]!
      this.navigationState = transitionNavigation(this.navigationState, { type: 'select-pane', pane }).state
      this.navigationState = transitionNavigation(this.navigationState, { type: 'set-mode', mode: 'normal' }).state
      this.refresh()
      return true
    }

    const navigation = this.navigationState
    if (navigation.route.kind !== 'chat' && navigation.mode === 'normal'
      && navigation.overlays.length === 0
      && (command.command.type === 'navigation.page'
        || (command.command.type === 'navigation.move'
          && (command.command.direction === 'up' || command.command.direction === 'down')))) {
      const node = this.detailScroller()
      if (node !== undefined) {
        const distance = command.command.type === 'navigation.page' ? 10 : 1
        node.scroll(command.command.direction === 'down' ? distance : -distance)
        this.refresh()
        return true
      }
    }

    await this.service.activateCommand(commandId)
    if (!this.isCurrent(generation)) return false
    const projection = this.refresh()
    const targetFeatureId = command.target.kind === 'feature'
      || command.target.kind === 'overlay'
      ? command.target.featureId
      : undefined
    if (targetFeatureId === undefined) return false
    const handler = projection.commands.find(candidate => (
      candidate.id === commandId && candidate.featureId === targetFeatureId
    ))
    if (handler === undefined) return false
    await handler.handler.handle(command, Object.freeze({
      navigation: this.navigationState,
      // A completed command keeps its result, but a callback from an earlier
      // visit cannot navigate a surface that the user has already left.
      openRoute: (routeId: string) => this.isCurrent(generation)
        ? this.openRoute(routeId)
        : Promise.resolve(),
    }))
    // Feature business state is opaque to the host. Republishing the semantic
    // projection after a handled command gives Surface presenters one stable
    // invalidation point without importing or subscribing to Feature models.
    if (!this.disposed) this.refresh()
    return true
  }

  private workspacePanes(): readonly WorkspacePane[] {
    const featureId = routeFeatureId(this.navigationState.route)
    const roles = new Set(this.current.slots.contributions
      .filter(contribution => contribution.featureId === featureId
        && contribution.slotId.startsWith('workspace.'))
      .map(contribution => contribution.value.role))
    return (['navigator', 'content', 'inspector'] as const).filter(pane => roles.has(pane))
  }

  private detailScroller(): { scroll(delta: number): boolean } | undefined {
    const { route, mode, overlays } = this.navigationState
    if (route.kind === 'chat' || mode !== 'normal' || overlays.length > 0) return undefined
    const region = this.current.slots.contributions.find(contribution => (
      contribution.featureId === route.featureId && contribution.value.role === route.pane
    ))?.value
    const node = region?.node as { scroll?: (delta: number) => boolean } | null | undefined
    return typeof node?.scroll === 'function' ? node as { scroll(delta: number): boolean } : undefined
  }

  private invalidateNavigation(): number {
    this.pendingRouteGeneration = undefined
    // Each visit has its own command queue. Old promises still settle for their
    // callers; pending work cannot hold up a newly opened surface.
    this.operation = Promise.resolve()
    return ++this.navigationGeneration
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.navigationGeneration
  }

  private refresh(): FeatureHostSnapshot {
    const projection = projectContributions(
      this.service.listActiveContributions(),
      this.baseSlots,
    )
    return this.publish(projection)
  }

  private publish(
    projection: Omit<CompleteFeatureHostSnapshot, 'navigation' | 'availableRoutes'>,
  ): FeatureHostSnapshot {
    this.current = freezeSnapshot(
      this.navigationState,
      projection.slots,
      availableRoutes(this.service),
      projection.routes,
      projection.commands,
      projection.keymaps,
      projection.resources,
      projection.issues,
    )
    for (const listener of this.listeners) listener(this.current)
    return this.current
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operation.then(operation, operation)
    this.operation = task.then(() => {}, () => {})
    return task
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('DSH-TUI feature host is disposed')
  }
}

interface ContributionProjection extends Omit<
  CompleteFeatureHostSnapshot,
  'navigation' | 'availableRoutes'
> {}

function projectContributions(
  active: readonly ActiveFeatureContributionSnapshot[],
  baseSlots: SlotRegistry<LayoutRegion>,
): ContributionProjection {
  let slots = baseSlots
  const routes: ProjectedFeatureRoute[] = []
  const commands: ProjectedFeatureCommand[] = []
  const keymaps: ProjectedFeatureKeymap[] = []
  const resources: ProjectedFeatureResource[] = []
  const issues: FeatureHostProjectionIssue[] = []

  for (const entry of active) {
    try {
      const projected = projectFeature(entry, slots)
      slots = projected.slots
      routes.push(...projected.routes)
      commands.push(...projected.commands)
      keymaps.push(...projected.keymaps)
      resources.push(...projected.resources)
    } catch (error: unknown) {
      const contractError = error instanceof FeatureHostContractError || error instanceof Error
        ? error
        : new Error(String(error))
      if (entry.provenance.required) throw contractError
      issues.push(Object.freeze({ featureId: entry.featureId, error: contractError }))
    }
  }

  return Object.freeze({
    routes: Object.freeze(routes),
    commands: Object.freeze(commands),
    keymaps: Object.freeze(keymaps),
    resources: Object.freeze(resources),
    slots,
    regions: Object.freeze(slots.contributions.map(item => item.value)),
    issues: Object.freeze(issues),
  })
}

function projectFeature(
  entry: ActiveFeatureContributionSnapshot,
  baseSlots: SlotRegistry<LayoutRegion>,
): Pick<ContributionProjection, 'routes' | 'commands' | 'keymaps' | 'resources' | 'slots'> {
  const routes = (entry.contributions.routes ?? []).map(contribution => {
    const route = requireNavigationRoute(
      entry.featureId,
      contribution.id,
      contribution.value,
      entry.provenance.authority,
    )
    return Object.freeze({ id: contribution.id, featureId: entry.featureId, route })
  })
  const commands = (entry.contributions.commands ?? []).map(contribution => Object.freeze({
    id: contribution.id,
    featureId: entry.featureId,
    handler: requireCommandHandler(entry.featureId, contribution.id, contribution.value),
  }))
  const commandIds = commands.map(command => command.id)
  const keymaps = (entry.contributions.keymaps ?? []).map(contribution => Object.freeze({
    id: contribution.id,
    featureId: entry.featureId,
    keymap: requireFeatureKeymap(
      entry.featureId,
      contribution.id,
      contribution.value,
      commandIds,
    ),
  }))
  const resources = (entry.contributions.resources ?? []).map(contribution => Object.freeze({
    id: contribution.id,
    featureId: entry.featureId,
    definition: requireResourceDefinition(
      entry.featureId,
      contribution.id,
      contribution.value,
    ),
  }))
  let slots = baseSlots
  for (const contribution of entry.contributions.surfaces ?? []) {
    const region = requireLayoutRegion(entry.featureId, contribution.id, contribution.value)
    const slotContribution: SlotContribution<LayoutRegion> = {
      slotId: contribution.slot,
      featureId: entry.featureId,
      authority: entry.provenance.authority,
      contributionId: contribution.id,
      value: region,
    }
    slots = contributeToSlot(slots, slotContribution)
  }
  return Object.freeze({
    routes: Object.freeze(routes),
    commands: Object.freeze(commands),
    keymaps: Object.freeze(keymaps),
    resources: Object.freeze(resources),
    slots,
  })
}

function freezeSnapshot(
  navigation: NavigationState,
  slots: SlotRegistry<LayoutRegion>,
  available: readonly AvailableFeatureRoute[],
  routes: readonly ProjectedFeatureRoute[],
  commands: readonly ProjectedFeatureCommand[],
  keymaps: readonly ProjectedFeatureKeymap[],
  resources: readonly ProjectedFeatureResource[],
  issues: readonly FeatureHostProjectionIssue[],
): CompleteFeatureHostSnapshot {
  return Object.freeze({
    navigation,
    availableRoutes: Object.freeze([...available]),
    routes: Object.freeze([...routes]),
    commands: Object.freeze([...commands]),
    keymaps: Object.freeze([...keymaps]),
    resources: Object.freeze([...resources]),
    slots,
    regions: Object.freeze(slots.contributions.map(item => item.value)),
    issues: Object.freeze([...issues]),
  })
}

function availableRoutes(service: DshTuiFeatureService): readonly AvailableFeatureRoute[] {
  const list = service.listRegisteredFeatures?.()
  if (list === undefined) return Object.freeze([])
  return Object.freeze(list.flatMap(feature => feature.declarations.routes.map(id => (
    Object.freeze({ id, featureId: feature.manifest.id })
  ))))
}

function sameAvailableRoutes(
  left: readonly AvailableFeatureRoute[],
  right: readonly AvailableFeatureRoute[],
): boolean {
  return left.length === right.length && left.every((route, index) => (
    route.id === right[index]?.id && route.featureId === right[index]?.featureId
  ))
}

function isReservedShellCommand(command: import('../navigation/commands.ts').UiCommand): boolean {
  return command.type === 'app.interrupt'
    || command.type === 'transcript.toggle-details'
    || command.type === 'mode.set'
    || command.type === 'navigation.focus'
}

function findFeatureBinding(
  keymaps: readonly ProjectedFeatureKeymap[],
  navigation: NavigationState,
  key: TerminalKey,
): FeatureKeymap['bindings'][number] | undefined {
  const featureId = navigation.overlays.at(-1)?.featureId
    ?? routeFeatureId(navigation.route)
  for (const projected of keymaps) {
    const context = projected.keymap.context
    if (projected.featureId !== featureId
      || context.routeKind !== navigation.route.kind
      || context.mode !== navigation.mode) continue
    const binding = projected.keymap.bindings.find(candidate => keyMatches(candidate, key))
    if (binding !== undefined) return binding
  }
  return undefined
}

function keyMatches(
  binding: FeatureKeymap['bindings'][number],
  key: TerminalKey,
): boolean {
  if (key.type === 'paste') return false
  if ((binding.ctrl === true) !== (key.ctrl === true)
    || (binding.alt === true) !== (key.alt === true)
    || (binding.shift === true) !== (key.shift === true)) return false
  if (key.type === 'text') return key.text === binding.key
  return key.key === binding.key
}

function featureCommandTarget(navigation: NavigationState): RoutedUiCommand['target'] {
  const overlay = navigation.overlays.at(-1)
  if (overlay !== undefined) {
    return Object.freeze({
      kind: 'overlay',
      overlayId: overlay.id,
      featureId: overlay.featureId,
    })
  }
  return Object.freeze({
    kind: 'feature',
    featureId: routeFeatureId(navigation.route),
  })
}

function terminalKeyOf(action: TerminalInputAction): TerminalKey | undefined {
  switch (action.type) {
    case 'insert': return { type: action.paste === true ? 'paste' : 'text', text: action.text }
    case 'newline': return { type: 'named', key: 'enter', shift: true }
    case 'submit': return { type: 'named', key: 'enter' }
    case 'interrupt': return { type: 'text', text: 'c', ctrl: true }
    case 'toggle-transcript-details': return { type: 'text', text: 'o', ctrl: true }
    case 'save-default': return { type: 'text', text: 's', ctrl: true }
    case 'backspace': return { type: 'named', key: 'backspace' }
    case 'delete': return { type: 'named', key: 'delete' }
    case 'move-left': return { type: 'named', key: 'left' }
    case 'move-right': return { type: 'named', key: 'right' }
    case 'move-up': return { type: 'named', key: 'up' }
    case 'move-down': return { type: 'named', key: 'down' }
    case 'page-up': return { type: 'named', key: 'page-up' }
    case 'page-down': return { type: 'named', key: 'page-down' }
    case 'complete': return { type: 'named', key: 'tab', ...(action.reverse ? { shift: true } : {}) }
    case 'move-home': return { type: 'named', key: 'home' }
    case 'move-end': return { type: 'named', key: 'end' }
    case 'escape': return { type: 'named', key: 'escape' }
    case 'toggle-reasoning':
    case 'paste-image':
    case 'toggle-goal-actions':
    case 'toggle-activity':
    case 'ignored':
      return undefined
  }
}

function isLegacyShellAction(action: TerminalInputAction): boolean {
  return action.type === 'interrupt'
    || action.type === 'paste-image'
    || action.type === 'save-default'
    || action.type === 'toggle-reasoning'
    || action.type === 'toggle-transcript-details'
    || action.type === 'toggle-goal-actions'
    || action.type === 'toggle-activity'
}
