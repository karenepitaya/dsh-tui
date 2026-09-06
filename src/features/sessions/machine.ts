import type { SessionCatalogSnapshot } from '../../session/catalog-port.ts'
import type { SessionNavigationSnapshot } from '../../session/navigation-port.ts'
import {
  detachSessionsCatalogSnapshot,
  projectSessionsCatalogSnapshot,
  type SessionsCatalogProjection,
  type SessionsCatalogRow,
  type SessionsCatalogSelection,
  type SessionsInspectionProjection,
} from './projectors.ts'

export const SESSIONS_CATALOG_RESOURCE_ID = 'sessions.catalog'
export const SESSIONS_INSPECTION_RESOURCE_ID = 'sessions.inspection'
export const SESSIONS_INSPECTOR_ROUTE_ID = 'sessions.inspector'

export interface SessionsRequestStamp {
  readonly scopeEpoch: number
  readonly requestId: number
}

export type SessionsCatalogState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'loading'
      readonly request: SessionsRequestStamp
    }
  | {
      readonly phase: 'ready'
      readonly snapshot: SessionCatalogSnapshot
    }
  | {
      readonly phase: 'refreshing'
      readonly request: SessionsRequestStamp
      readonly snapshot: SessionCatalogSnapshot
    }
  | {
      readonly phase: 'failed'
      readonly message: string
      readonly snapshot?: SessionCatalogSnapshot
    }

export type SessionsInspectionState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'loading'
      readonly sessionId: string
      readonly request?: SessionsRequestStamp
      readonly previous?: SessionsInspectionProjection
    }
  | {
      readonly phase: 'ready'
      readonly projection: SessionsInspectionProjection
    }
  | {
      readonly phase: 'refreshing'
      readonly sessionId: string
      readonly request: SessionsRequestStamp
      readonly projection: SessionsInspectionProjection
    }
  | {
      readonly phase: 'failed'
      readonly sessionId: string
      readonly message: string
      readonly previous?: SessionsInspectionProjection
    }

export type SessionsOperationAction = 'attach-live' | 'resume-cold' | 'fork'

export type SessionsOperationState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'confirm-resume'; readonly sessionId: string }
  | { readonly phase: 'confirm-fork'; readonly sessionId: string }
  | {
      readonly phase: 'running'
      readonly action: SessionsOperationAction
      readonly sessionId: string
      readonly requestId: number
    }
  | {
      readonly phase: 'failed'
      readonly action: SessionsOperationAction
      readonly sessionId: string
      readonly message: string
    }

export interface SessionsFeatureState {
  readonly query: string
  readonly selection: SessionsCatalogSelection
  readonly catalog: SessionsCatalogState
  readonly inspection: SessionsInspectionState
  readonly navigation: SessionNavigationSnapshot
  readonly operation: SessionsOperationState
}

export type SessionsFeatureEvent =
  | {
      readonly type: 'catalog.load-started'
      readonly request: SessionsRequestStamp
    }
  | {
      readonly type: 'catalog.loaded'
      readonly request: SessionsRequestStamp
      readonly snapshot: SessionCatalogSnapshot
    }
  | {
      readonly type: 'catalog.failed'
      readonly request: SessionsRequestStamp
      readonly message: string
    }
  | { readonly type: 'catalog.refresh-requested' }
  | {
      readonly type: 'navigation.changed'
      readonly snapshot: SessionNavigationSnapshot
    }
  | { readonly type: 'query.changed'; readonly query: string }
  | {
      readonly type: 'selection.move'
      readonly direction: 'up' | 'down'
      readonly amount?: number
    }
  | { readonly type: 'selection.activated'; readonly requestId?: number }
  | { readonly type: 'resume.requested' }
  | { readonly type: 'fork.requested' }
  | { readonly type: 'confirmation.accepted'; readonly requestId: number }
  | { readonly type: 'back.requested' }
  | { readonly type: 'navigation.succeeded'; readonly requestId: number }
  | {
      readonly type: 'navigation.failed'
      readonly requestId: number
      readonly message: string
    }
  | { readonly type: 'navigation.cancelled'; readonly requestId: number }
  | {
      readonly type: 'inspection.load-started'
      readonly sessionId: string
      readonly request: SessionsRequestStamp
    }
  | {
      readonly type: 'inspection.loaded'
      readonly sessionId: string
      readonly request: SessionsRequestStamp
      readonly projection: SessionsInspectionProjection
    }
  | {
      readonly type: 'inspection.failed'
      readonly sessionId: string
      readonly request: SessionsRequestStamp
      readonly message: string
    }
  | { readonly type: 'inspection.refresh-requested' }
  | { readonly type: 'inspection.closed' }

export type SessionsFeatureEffect =
  | {
      readonly type: 'resource.refresh'
      readonly resourceId:
        | typeof SESSIONS_CATALOG_RESOURCE_ID
        | typeof SESSIONS_INSPECTION_RESOURCE_ID
    }
  | { readonly type: 'route.open'; readonly routeId: string }
  | {
      readonly type: 'session.navigate'
      readonly requestId: number
      readonly request:
        | {
            readonly kind: 'activate'
            readonly sessionId: string
            readonly intent: 'attach-live' | 'resume-cold'
          }
        | { readonly kind: 'fork'; readonly sessionId: string }
    }
  | { readonly type: 'session.cancel'; readonly requestId: number }

export interface SessionsFeatureTransition {
  readonly state: SessionsFeatureState
  readonly effects: readonly SessionsFeatureEffect[]
}

const NO_EFFECTS: readonly SessionsFeatureEffect[] = Object.freeze([])

function freezeRequest(request: SessionsRequestStamp): SessionsRequestStamp {
  return Object.freeze({ ...request })
}

function freezeSelection(selection: SessionsCatalogSelection): SessionsCatalogSelection {
  return Object.freeze({ ...selection })
}

function freezeNavigation(snapshot: SessionNavigationSnapshot): SessionNavigationSnapshot {
  return Object.freeze({
    ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
    busy: snapshot.busy,
  })
}

function stateWith(
  state: SessionsFeatureState,
  patch: Partial<SessionsFeatureState>,
): SessionsFeatureState {
  return Object.freeze({ ...state, ...patch })
}

function transition(
  state: SessionsFeatureState,
  effects: readonly SessionsFeatureEffect[] = NO_EFFECTS,
): SessionsFeatureTransition {
  return Object.freeze({ state, effects: Object.freeze([...effects]) })
}

function unchanged(state: SessionsFeatureState): SessionsFeatureTransition {
  return Object.freeze({ state, effects: NO_EFFECTS })
}

function sameRequest(
  left: SessionsRequestStamp | undefined,
  right: SessionsRequestStamp,
): boolean {
  return left?.scopeEpoch === right.scopeEpoch && left.requestId === right.requestId
}

function catalogSnapshotOf(state: SessionsCatalogState): SessionCatalogSnapshot | undefined {
  switch (state.phase) {
    case 'idle':
    case 'loading':
      return undefined
    case 'ready':
    case 'refreshing':
      return state.snapshot
    case 'failed':
      return state.snapshot
    /* v8 ignore next 2 -- SessionsCatalogState is exhausted above. */
    default:
      return assertNever(state)
  }
}

function pendingCatalogRequest(state: SessionsCatalogState): SessionsRequestStamp | undefined {
  return state.phase === 'loading' || state.phase === 'refreshing'
    ? state.request
    : undefined
}

function pendingInspectionRequest(
  state: SessionsInspectionState,
): SessionsRequestStamp | undefined {
  return state.phase === 'loading' || state.phase === 'refreshing'
    ? state.request
    : undefined
}

function selectedCatalogRow(state: SessionsFeatureState): SessionsCatalogRow | undefined {
  const projection = projectSessionsCatalog(state)
  return projection.rows[projection.selectedIndex]
}

function failedOperation(
  action: SessionsOperationAction,
  sessionId: string,
  message: string,
): SessionsOperationState {
  return Object.freeze({ phase: 'failed', action, sessionId, message })
}

function navigationBlocked(
  state: SessionsFeatureState,
  action: SessionsOperationAction,
  sessionId: string,
): SessionsFeatureTransition | undefined {
  if (state.navigation.busy || state.operation.phase === 'running') {
    return transition(stateWith(state, {
      operation: failedOperation(action, sessionId, 'Another session operation is already running'),
    }))
  }
  return undefined
}

function startInspection(
  state: SessionsFeatureState,
  sessionId: string,
): SessionsFeatureTransition {
  const inspection = requestedInspectionState(state.inspection, sessionId)
  return transition(stateWith(state, {
    inspection,
    operation: Object.freeze({ phase: 'idle' }),
  }), [
    Object.freeze({
      type: 'resource.refresh',
      resourceId: SESSIONS_INSPECTION_RESOURCE_ID,
    }),
    Object.freeze({ type: 'route.open', routeId: SESSIONS_INSPECTOR_ROUTE_ID }),
  ])
}

function requestedInspectionState(
  state: SessionsInspectionState,
  sessionId: string,
): SessionsInspectionState {
  const previous = inspectionProjectionOf(state, sessionId)
  return Object.freeze({
    phase: 'loading',
    sessionId,
    ...(previous === undefined ? {} : { previous }),
  })
}

function startNavigation(
  state: SessionsFeatureState,
  requestId: number,
  action: SessionsOperationAction,
  sessionId: string,
): SessionsFeatureTransition {
  const request = action === 'fork'
    ? Object.freeze({ kind: 'fork' as const, sessionId })
    : Object.freeze({ kind: 'activate' as const, sessionId, intent: action })
  return transition(stateWith(state, {
    operation: Object.freeze({ phase: 'running', action, sessionId, requestId }),
  }), [Object.freeze({ type: 'session.navigate', requestId, request })])
}

function reconciledSelection(
  snapshot: SessionCatalogSnapshot | undefined,
  query: string,
  selection: SessionsCatalogSelection,
): SessionsCatalogSelection {
  const projection = projectSessionsCatalogSnapshot(snapshot, query, selection)
  return freezeSelection({
    index: projection.selectedIndex,
    ...(projection.selectedSessionId === undefined
      ? {}
      : { sessionId: projection.selectedSessionId }),
  })
}

function inspectionProjectionOf(
  state: SessionsInspectionState,
  sessionId: string,
): SessionsInspectionProjection | undefined {
  switch (state.phase) {
    case 'idle':
      return undefined
    case 'loading':
      return state.sessionId === sessionId ? state.previous : undefined
    case 'ready':
      return state.projection.sessionId === sessionId ? state.projection : undefined
    case 'refreshing':
      return state.sessionId === sessionId ? state.projection : undefined
    case 'failed':
      return state.sessionId === sessionId ? state.previous : undefined
    /* v8 ignore next 2 -- SessionsInspectionState is exhausted above. */
    default:
      return assertNever(state)
  }
}

/* v8 ignore next 3 -- exported discriminated unions are exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Sessions Feature value: ${String(value)}`)
}

export function createSessionsFeatureState(): SessionsFeatureState {
  return Object.freeze({
    query: '',
    selection: freezeSelection({ index: -1 }),
    catalog: Object.freeze({ phase: 'idle' }),
    inspection: Object.freeze({ phase: 'idle' }),
    navigation: freezeNavigation({ busy: false }),
    operation: Object.freeze({ phase: 'idle' }),
  })
}

export function projectSessionsCatalog(
  state: SessionsFeatureState,
): SessionsCatalogProjection {
  return projectSessionsCatalogSnapshot(
    catalogSnapshotOf(state.catalog),
    state.query,
    state.selection,
    state.navigation.sessionId,
  )
}

export function inspectionTargetSessionId(
  state: SessionsFeatureState,
): string | undefined {
  switch (state.inspection.phase) {
    case 'idle':
      return undefined
    case 'loading':
    case 'refreshing':
    case 'failed':
      return state.inspection.sessionId
    case 'ready':
      return state.inspection.projection.sessionId
    /* v8 ignore next 2 -- SessionsInspectionState is exhausted above. */
    default:
      return assertNever(state.inspection)
  }
}

export function transitionSessionsFeature(
  state: SessionsFeatureState,
  event: SessionsFeatureEvent,
): SessionsFeatureTransition {
  switch (event.type) {
    case 'catalog.load-started': {
      const snapshot = catalogSnapshotOf(state.catalog)
      const catalog: SessionsCatalogState = snapshot === undefined
        ? Object.freeze({ phase: 'loading', request: freezeRequest(event.request) })
        : Object.freeze({
            phase: 'refreshing',
            request: freezeRequest(event.request),
            snapshot,
          })
      return transition(stateWith(state, { catalog }))
    }
    case 'catalog.loaded': {
      if (!sameRequest(pendingCatalogRequest(state.catalog), event.request)) {
        return unchanged(state)
      }
      const snapshot = detachSessionsCatalogSnapshot(event.snapshot)
      return transition(stateWith(state, {
        catalog: Object.freeze({ phase: 'ready', snapshot }),
        selection: reconciledSelection(snapshot, state.query, state.selection),
      }))
    }
    case 'catalog.failed': {
      if (!sameRequest(pendingCatalogRequest(state.catalog), event.request)) {
        return unchanged(state)
      }
      const snapshot = catalogSnapshotOf(state.catalog)
      return transition(stateWith(state, {
        catalog: Object.freeze({
          phase: 'failed',
          message: event.message,
          ...(snapshot === undefined ? {} : { snapshot }),
        }),
      }))
    }
    case 'catalog.refresh-requested':
      return transition(state, [Object.freeze({
        type: 'resource.refresh',
        resourceId: SESSIONS_CATALOG_RESOURCE_ID,
      })])
    case 'navigation.changed':
      return transition(stateWith(state, {
        navigation: freezeNavigation(event.snapshot),
      }))
    case 'query.changed': {
      if (event.query === state.query) return unchanged(state)
      const snapshot = catalogSnapshotOf(state.catalog)
      return transition(stateWith(state, {
        query: event.query,
        selection: reconciledSelection(snapshot, event.query, state.selection),
      }))
    }
    case 'selection.move': {
      const projection = projectSessionsCatalog(state)
      if (projection.selectedIndex < 0) return unchanged(state)
      const amount = Math.max(1, Math.floor(event.amount ?? 1))
      const delta = event.direction === 'up' ? -amount : amount
      const index = Math.min(
        projection.rows.length - 1,
        Math.max(0, projection.selectedIndex + delta),
      )
      if (index === projection.selectedIndex) return unchanged(state)
      const selected = projection.rows[index]!
      return transition(stateWith(state, {
        selection: freezeSelection({ index, sessionId: selected.sessionId }),
      }))
    }
    case 'selection.activated': {
      const selected = selectedCatalogRow(state)
      if (selected === undefined) return unchanged(state)
      if (selected.relation === 'current') {
        return transition(state, [Object.freeze({ type: 'route.open', routeId: 'chat' })])
      }
      const blocked = navigationBlocked(state, 'attach-live', selected.sessionId)
      if (blocked !== undefined) return blocked
      if (state.navigation.sessionId !== undefined
        && selected.relation === 'other-live'
        && !selected.isSubagent) {
          return startNavigation(
            state,
            event.requestId ?? 0,
            'attach-live',
          selected.sessionId,
        )
      }
      if (selected.durablePresence !== 'observed'
        || projectSessionsCatalog(state).durability !== 'available') {
        return transition(stateWith(state, {
          operation: failedOperation(
            'resume-cold',
            selected.sessionId,
            'Durable inspection is unavailable for this session',
          ),
        }))
      }
      return startInspection(state, selected.sessionId)
    }
    case 'resume.requested': {
      const selected = selectedCatalogRow(state)
      const inspected = state.inspection.phase === 'ready'
        ? state.inspection.projection.sessionId
        : undefined
      const sessionId = selected?.sessionId ?? inspected
      if (sessionId === undefined) return unchanged(state)
      const blocked = navigationBlocked(state, 'resume-cold', sessionId)
      if (blocked !== undefined) return blocked
      if (selected === undefined
        || selected.sessionId !== inspected
        || selected.relation !== 'cold'
        || selected.isSubagent
        || selected.durablePresence !== 'observed'
        || projectSessionsCatalog(state).durability !== 'available') {
        return transition(stateWith(state, {
          operation: failedOperation(
            'resume-cold',
            sessionId,
            'Inspect an observed cold root session before resuming it',
          ),
        }))
      }
      return transition(stateWith(state, {
        operation: Object.freeze({ phase: 'confirm-resume', sessionId }),
      }))
    }
    case 'fork.requested': {
      const selected = selectedCatalogRow(state)
      if (selected === undefined) return unchanged(state)
      const blocked = navigationBlocked(state, 'fork', selected.sessionId)
      if (blocked !== undefined) return blocked
      return transition(stateWith(state, {
        operation: Object.freeze({
          phase: 'confirm-fork',
          sessionId: selected.sessionId,
        }),
      }))
    }
    case 'confirmation.accepted': {
      if (state.operation.phase !== 'confirm-resume'
        && state.operation.phase !== 'confirm-fork') return unchanged(state)
      const action = state.operation.phase === 'confirm-resume' ? 'resume-cold' : 'fork'
      const blocked = navigationBlocked(state, action, state.operation.sessionId)
      if (blocked !== undefined) return blocked
      return startNavigation(
        state,
        event.requestId,
        action,
        state.operation.sessionId,
      )
    }
    case 'back.requested':
      if (state.operation.phase === 'running') {
        return transition(stateWith(state, {
          operation: Object.freeze({ phase: 'idle' }),
        }), [Object.freeze({
          type: 'session.cancel',
          requestId: state.operation.requestId,
        })])
      }
      if (state.operation.phase !== 'idle') {
        return transition(stateWith(state, {
          operation: Object.freeze({ phase: 'idle' }),
        }))
      }
      return transition(state, [Object.freeze({ type: 'route.open', routeId: 'chat' })])
    case 'navigation.succeeded':
      return state.operation.phase === 'running'
        && state.operation.requestId === event.requestId
        ? transition(stateWith(state, {
            operation: Object.freeze({ phase: 'idle' }),
          }))
        : unchanged(state)
    case 'navigation.failed':
      return state.operation.phase === 'running'
        && state.operation.requestId === event.requestId
        ? transition(stateWith(state, {
            operation: failedOperation(
              state.operation.action,
              state.operation.sessionId,
              event.message,
            ),
          }))
        : unchanged(state)
    case 'navigation.cancelled':
      return state.operation.phase === 'running'
        && state.operation.requestId === event.requestId
        ? transition(stateWith(state, {
            operation: Object.freeze({ phase: 'idle' }),
          }))
        : unchanged(state)
    case 'inspection.load-started': {
      if (inspectionTargetSessionId(state) !== event.sessionId) return unchanged(state)
      const previous = inspectionProjectionOf(state.inspection, event.sessionId)
      const inspection: SessionsInspectionState = previous === undefined
        ? Object.freeze({
            phase: 'loading',
            sessionId: event.sessionId,
            request: freezeRequest(event.request),
          })
        : Object.freeze({
            phase: 'refreshing',
            sessionId: event.sessionId,
            request: freezeRequest(event.request),
            projection: previous,
          })
      return transition(stateWith(state, { inspection }))
    }
    case 'inspection.loaded': {
      if (inspectionTargetSessionId(state) !== event.sessionId
        || !sameRequest(pendingInspectionRequest(state.inspection), event.request)) {
        return unchanged(state)
      }
      return transition(stateWith(state, {
        inspection: Object.freeze({ phase: 'ready', projection: event.projection }),
      }))
    }
    case 'inspection.failed': {
      if (inspectionTargetSessionId(state) !== event.sessionId
        || !sameRequest(pendingInspectionRequest(state.inspection), event.request)) {
        return unchanged(state)
      }
      const previous = inspectionProjectionOf(state.inspection, event.sessionId)
      return transition(stateWith(state, {
        inspection: Object.freeze({
          phase: 'failed',
          sessionId: event.sessionId,
          message: event.message,
          ...(previous === undefined ? {} : { previous }),
        }),
      }))
    }
    case 'inspection.refresh-requested': {
      const sessionId = inspectionTargetSessionId(state)
      if (sessionId === undefined) return unchanged(state)
      return transition(stateWith(state, {
        inspection: requestedInspectionState(state.inspection, sessionId),
      }), [Object.freeze({
        type: 'resource.refresh',
        resourceId: SESSIONS_INSPECTION_RESOURCE_ID,
      })])
    }
    case 'inspection.closed':
      return state.inspection.phase === 'idle'
        ? unchanged(state)
        : transition(stateWith(state, {
            inspection: Object.freeze({ phase: 'idle' }),
          }))
    /* v8 ignore next 2 -- SessionsFeatureEvent is exhausted above. */
    default:
      return assertNever(event)
  }
}
