import type {
  DurableDshEnvelope,
  UiRequestAdapterDefaults,
  UiRequestCallConfig,
  UiRequestContext,
} from '../runtime/events.ts'

const ROUTE_EPOCH_LIMIT = 32

export interface RequestRouteContext extends UiRequestContext {
  readonly contextSeq: number
  readonly contextTime: number
}

/** One full official request-header epoch with matching route capacity when known. */
export interface RequestRouteEpoch {
  readonly headerSeq: number
  readonly headerTime: number
  readonly reason: 'initial' | 'resume' | 'change' | 'series'
  readonly config: UiRequestCallConfig
  readonly adapterDefaults?: UiRequestAdapterDefaults
  readonly context?: RequestRouteContext
}

/** Bounded UI projection; the official Session event log remains authoritative. */
export interface SessionRequestRouteState {
  readonly epochs: readonly RequestRouteEpoch[]
  readonly latestContext?: RequestRouteContext
  readonly omittedEpochCount?: number
}

export interface RoutePanelState {
  readonly open: boolean
  readonly selectedHeaderSeq?: number
}

export type RoutePanelAction =
  | { readonly type: 'move-up' | 'move-down' }
  | { readonly type: 'escape' }

export interface RoutePanelView {
  readonly rows: readonly RequestRouteEpoch[]
  readonly selectedIndex: number
  readonly selected?: RequestRouteEpoch
  readonly omittedEpochCount: number
}

function sameRoute(
  left: Readonly<{ provider: string; model: string }>,
  right: Readonly<{ provider: string; model: string }>,
): boolean {
  return left.provider === right.provider && left.model === right.model
}

/** Fold one safe official request-header snapshot into bounded route history. */
export function projectRequestHeader(
  state: SessionRequestRouteState | undefined,
  event: Extract<DurableDshEnvelope, { type: 'request/header' }>,
): SessionRequestRouteState {
  const current: SessionRequestRouteState = state ?? { epochs: [] }
  const epoch: RequestRouteEpoch = {
    headerSeq: event.seq,
    headerTime: event.time,
    reason: event.data.reason,
    config: event.data.config,
    ...(event.data.adapterDefaults === undefined
      ? {}
      : { adapterDefaults: event.data.adapterDefaults }),
    ...(current.latestContext === undefined
      || !sameRoute(current.latestContext, event.data.config)
      ? {}
      : { context: current.latestContext }),
  }
  const epochs = [...current.epochs, epoch]
  const overflow = Math.max(0, epochs.length - ROUTE_EPOCH_LIMIT)
  return {
    epochs: overflow === 0 ? epochs : epochs.slice(overflow),
    ...(current.latestContext === undefined ? {} : { latestContext: current.latestContext }),
    ...(overflow === 0
      ? current.omittedEpochCount === undefined
        ? {}
        : { omittedEpochCount: current.omittedEpochCount }
      : { omittedEpochCount: (current.omittedEpochCount ?? 0) + overflow }),
  }
}

/** Fold one route-capacity change and correlate it to the current header epoch. */
export function projectRequestContext(
  state: SessionRequestRouteState | undefined,
  event: Extract<DurableDshEnvelope, { type: 'request/context' }>,
): SessionRequestRouteState {
  const current: SessionRequestRouteState = state ?? { epochs: [] }
  const context: RequestRouteContext = {
    ...event.data,
    contextSeq: event.seq,
    contextTime: event.time,
  }
  const latestIndex = current.epochs.length - 1
  const latest = current.epochs[latestIndex]
  const epochs = latest === undefined || !sameRoute(latest.config, context)
    ? current.epochs
    : current.epochs.with(latestIndex, { ...latest, context })
  return {
    ...current,
    epochs,
    latestContext: context,
  }
}

export function createRoutePanelState(): RoutePanelState {
  return { open: false }
}

export function openRoutePanel(
  _state: RoutePanelState,
  routes: SessionRequestRouteState | undefined,
): RoutePanelState {
  const selected = routes?.epochs.at(-1)
  return {
    open: true,
    ...(selected === undefined ? {} : { selectedHeaderSeq: selected.headerSeq }),
  }
}

export function selectRoutePanel(
  state: RoutePanelState,
  routes: SessionRequestRouteState | undefined,
): RoutePanelView | undefined {
  if (!state.open) return undefined
  const rows = [...(routes?.epochs ?? [])].reverse()
  const requestedIndex = rows.findIndex(row => row.headerSeq === state.selectedHeaderSeq)
  const selectedIndex = rows.length === 0 ? -1 : Math.max(0, requestedIndex)
  return {
    rows,
    selectedIndex,
    ...(rows[selectedIndex] === undefined ? {} : { selected: rows[selectedIndex] }),
    omittedEpochCount: routes?.omittedEpochCount ?? 0,
  }
}

export function applyRoutePanelAction(
  state: RoutePanelState,
  routes: SessionRequestRouteState | undefined,
  action: RoutePanelAction,
): { readonly state: RoutePanelState } {
  if (!state.open) return { state }
  if (action.type === 'escape') return { state: createRoutePanelState() }
  const view = selectRoutePanel(state, routes)!
  if (view.rows.length === 0) return { state }
  const delta = action.type === 'move-up' ? -1 : 1
  const index = Math.max(0, Math.min(view.rows.length - 1, view.selectedIndex + delta))
  return {
    state: {
      open: true,
      selectedHeaderSeq: view.rows[index]!.headerSeq,
    },
  }
}
