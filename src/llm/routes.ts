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

/** Read-only projection with the default latest selection; the Status page owns no selection state. */
export function selectRoutePanel(
  routes: SessionRequestRouteState | undefined,
): RoutePanelView {
  const rows = [...(routes?.epochs ?? [])].reverse()
  return {
    rows,
    selectedIndex: rows.length === 0 ? -1 : 0,
    ...(rows[0] === undefined ? {} : { selected: rows[0] }),
    omittedEpochCount: routes?.omittedEpochCount ?? 0,
  }
}
