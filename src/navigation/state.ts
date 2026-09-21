export type NavigationMode = 'insert' | 'normal'
export type WorkspacePane = 'navigator' | 'content' | 'inspector'

export interface ChatRoute {
  readonly kind: 'chat'
}

export interface WorkspaceRoute {
  readonly kind: 'workspace'
  readonly featureId: string
  readonly pane: WorkspacePane
}

export type NavigationRoute = ChatRoute | WorkspaceRoute

export interface NavigationOverlay {
  readonly id: string
  readonly kind: 'permission' | 'question' | 'plan-review' | 'custom'
  readonly featureId: string
}

export type NavigationFocus =
  | { readonly kind: 'composer' }
  | { readonly kind: 'feature'; readonly featureId: string }
  | {
      readonly kind: 'overlay'
      readonly overlayId: string
      readonly featureId: string
    }

interface NavigationStateBase {
  readonly mode: NavigationMode
  readonly focus: NavigationFocus
  readonly overlays: readonly NavigationOverlay[]
}

export type NavigationState =
  | NavigationStateBase & { readonly value: 'chat'; readonly route: ChatRoute }
  | NavigationStateBase & { readonly value: 'workspace'; readonly route: WorkspaceRoute }

export type NavigationEvent =
  | { readonly type: 'navigate'; readonly route: NavigationRoute }
  | { readonly type: 'set-mode'; readonly mode: NavigationMode }
  | { readonly type: 'select-pane'; readonly pane: WorkspacePane }
  | { readonly type: 'push-overlay'; readonly overlay: NavigationOverlay }
  | { readonly type: 'pop-overlay' }
  | { readonly type: 'feature-disposed'; readonly featureId: string }

export type NavigationEffect =
  | {
      readonly type: 'route-changed'
      readonly previous: NavigationRoute
      readonly next: NavigationRoute
    }
  | { readonly type: 'pane-changed'; readonly pane: WorkspacePane }
  | { readonly type: 'overlay-opened'; readonly overlay: NavigationOverlay }
  | {
      readonly type: 'overlay-closed'
      readonly overlay: NavigationOverlay
      readonly reason: 'dismissed' | 'owner-disposed'
    }
  | { readonly type: 'focus-requested'; readonly target: NavigationFocus }

export interface NavigationTransition {
  readonly state: NavigationState
  readonly effects: readonly NavigationEffect[]
}

const EMPTY_EFFECTS: readonly NavigationEffect[] = Object.freeze([])

/* v8 ignore next 3 -- all public discriminated unions are exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled navigation value: ${String(value)}`)
}

function freezeRoute(route: NavigationRoute): NavigationRoute {
  return Object.freeze({ ...route })
}

function freezeOverlay(overlay: NavigationOverlay): NavigationOverlay {
  return Object.freeze({ ...overlay })
}

function freezeFocus(focus: NavigationFocus): NavigationFocus {
  return Object.freeze({ ...focus })
}

export function routeFeatureId(route: NavigationRoute): string {
  switch (route.kind) {
    case 'chat':
      return 'chat'
    case 'workspace':
      return route.featureId
    /* v8 ignore next 2 -- NavigationRoute is exhausted above. */
    default:
      return assertNever(route)
  }
}

function defaultMode(route: NavigationRoute): NavigationMode {
  return route.kind === 'chat' ? 'insert' : 'normal'
}

function focusFor(
  route: NavigationRoute,
  mode: NavigationMode,
  overlays: readonly NavigationOverlay[],
): NavigationFocus {
  const overlay = overlays.at(-1)
  if (overlay !== undefined) {
    return freezeFocus({
      kind: 'overlay',
      overlayId: overlay.id,
      featureId: overlay.featureId,
    })
  }
  if (mode === 'insert' && route.kind === 'chat') {
    return freezeFocus({ kind: 'composer' })
  }
  return freezeFocus({ kind: 'feature', featureId: routeFeatureId(route) })
}

function freezeState(
  route: NavigationRoute,
  mode: NavigationMode,
  overlays: readonly NavigationOverlay[],
): NavigationState {
  const frozenRoute = freezeRoute(route)
  const frozenOverlays = Object.freeze(overlays.map(freezeOverlay))
  const common = {
    mode,
    focus: focusFor(frozenRoute, mode, frozenOverlays),
    overlays: frozenOverlays,
  }
  switch (frozenRoute.kind) {
    case 'chat':
      return Object.freeze({ ...common, value: 'chat', route: frozenRoute })
    case 'workspace':
      return Object.freeze({ ...common, value: 'workspace', route: frozenRoute })
    /* v8 ignore next 2 -- freezeRoute preserves the NavigationRoute discriminant. */
    default:
      return assertNever(frozenRoute)
  }
}

function sameRoute(left: NavigationRoute, right: NavigationRoute): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'chat':
      return true
    case 'workspace':
      return right.kind === 'workspace'
        && left.featureId === right.featureId
        && left.pane === right.pane
    /* v8 ignore next 2 -- NavigationRoute is exhausted above. */
    default:
      return assertNever(left)
  }
}

function transition(
  state: NavigationState,
  effects: readonly NavigationEffect[],
): NavigationTransition {
  return Object.freeze({ state, effects: Object.freeze([...effects]) })
}

function unchanged(state: NavigationState): NavigationTransition {
  return Object.freeze({ state, effects: EMPTY_EFFECTS })
}

export function createNavigationState(): NavigationState {
  return freezeState({ kind: 'chat' }, 'insert', [])
}

export function transitionNavigation(
  state: NavigationState,
  event: NavigationEvent,
): NavigationTransition {
  switch (event.type) {
    case 'navigate': {
      if (state.overlays.length > 0 || sameRoute(state.route, event.route)) {
        return unchanged(state)
      }
      const next = freezeState(event.route, defaultMode(event.route), [])
      return transition(next, [
        Object.freeze({
          type: 'route-changed',
          previous: state.route,
          next: next.route,
        }),
        Object.freeze({ type: 'focus-requested', target: next.focus }),
      ])
    }
    case 'set-mode': {
      if (state.mode === event.mode) return unchanged(state)
      const next = freezeState(state.route, event.mode, state.overlays)
      return transition(next, [
        Object.freeze({ type: 'focus-requested', target: next.focus }),
      ])
    }
    case 'select-pane': {
      if (state.overlays.length > 0 || state.route.kind === 'chat') return unchanged(state)
      if (state.route.pane === event.pane) return unchanged(state)
      const route: NavigationRoute = { ...state.route, pane: event.pane }
      const next = freezeState(route, state.mode, state.overlays)
      return transition(next, [
        Object.freeze({ type: 'pane-changed', pane: event.pane }),
        Object.freeze({ type: 'focus-requested', target: next.focus }),
      ])
    }
    case 'push-overlay': {
      if (state.overlays.some(overlay => overlay.id === event.overlay.id)) {
        throw new Error(`Duplicate overlay id: ${event.overlay.id}`)
      }
      const overlay = freezeOverlay(event.overlay)
      const next = freezeState(state.route, state.mode, [...state.overlays, overlay])
      return transition(next, [
        Object.freeze({ type: 'overlay-opened', overlay }),
        Object.freeze({ type: 'focus-requested', target: next.focus }),
      ])
    }
    case 'pop-overlay': {
      const overlay = state.overlays.at(-1)
      if (overlay === undefined) return unchanged(state)
      const next = freezeState(state.route, state.mode, state.overlays.slice(0, -1))
      return transition(next, [
        Object.freeze({ type: 'overlay-closed', overlay, reason: 'dismissed' }),
        Object.freeze({ type: 'focus-requested', target: next.focus }),
      ])
    }
    case 'feature-disposed': {
      const removed = state.overlays.filter(overlay => overlay.featureId === event.featureId)
      const activeDisposed = routeFeatureId(state.route) === event.featureId
      if (removed.length === 0 && !activeDisposed) return unchanged(state)
      const overlays = state.overlays.filter(overlay => overlay.featureId !== event.featureId)
      const route: NavigationRoute = activeDisposed ? { kind: 'chat' } : state.route
      const mode = activeDisposed ? 'insert' : state.mode
      const next = freezeState(route, mode, overlays)
      const effects: NavigationEffect[] = removed.map(overlay => Object.freeze({
        type: 'overlay-closed' as const,
        overlay,
        reason: 'owner-disposed' as const,
      }))
      if (activeDisposed) {
        effects.push(Object.freeze({
          type: 'route-changed',
          previous: state.route,
          next: next.route,
        }))
      }
      effects.push(Object.freeze({ type: 'focus-requested', target: next.focus }))
      return transition(next, effects)
    }
    /* v8 ignore next 2 -- NavigationEvent is exhausted above. */
    default:
      return assertNever(event)
  }
}
