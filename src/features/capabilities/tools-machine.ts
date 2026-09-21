import type { PromptEditorAction } from '../../ui/prompt-editor.ts'
import type { SessionToolsSnapshot } from '../../tool/port.ts'
import {
  applyToolBrowserAction,
  createToolBrowserState,
  openToolBrowser,
  reconcileToolBrowser,
  type ToolBrowserState,
} from '../../tool/browser.ts'
import { detachToolsSnapshot } from './projectors.ts'

export type ToolsFeaturePhase = 'idle' | 'loading' | 'ready' | 'refreshing' | 'failed'

export interface ToolsRequestStamp {
  readonly scopeEpoch: number
  readonly requestId: number
}

export interface ToolsFeatureState {
  readonly phase: ToolsFeaturePhase
  readonly browser: ToolBrowserState
  readonly snapshot?: SessionToolsSnapshot | undefined
  readonly request?: ToolsRequestStamp | undefined
  readonly error?: string | undefined
}

export type ToolsFeatureEvent =
  | { readonly type: 'load.started'; readonly request: ToolsRequestStamp }
  | {
      readonly type: 'load.succeeded'
      readonly request: ToolsRequestStamp
      readonly snapshot: SessionToolsSnapshot
    }
  | { readonly type: 'load.failed'; readonly request: ToolsRequestStamp; readonly message: string }
  | { readonly type: 'snapshot.changed'; readonly snapshot: SessionToolsSnapshot }
  | { readonly type: 'snapshot.failed'; readonly message: string }
  | { readonly type: 'selection.move'; readonly direction: 'up' | 'down' }
  | { readonly type: 'query.edit'; readonly action: PromptEditorAction }
  | { readonly type: 'refresh.requested' }

export type ToolsFeatureEffect = {
  readonly type: 'resource.refresh'
  readonly resourceId: 'tools.catalog'
}

export interface ToolsFeatureTransition {
  readonly state: ToolsFeatureState
  readonly effects: readonly ToolsFeatureEffect[]
}

const NO_EFFECTS: readonly ToolsFeatureEffect[] = Object.freeze([])

function freezeRequest(request: ToolsRequestStamp): ToolsRequestStamp {
  return Object.freeze({ ...request })
}

function stateWith(
  state: ToolsFeatureState,
  patch: Partial<ToolsFeatureState>,
): ToolsFeatureState {
  return Object.freeze({ ...state, ...patch })
}

function changed(
  state: ToolsFeatureState,
  effects: readonly ToolsFeatureEffect[] = NO_EFFECTS,
): ToolsFeatureTransition {
  return Object.freeze({ state, effects })
}

function unchanged(
  state: ToolsFeatureState,
  effects: readonly ToolsFeatureEffect[] = NO_EFFECTS,
): ToolsFeatureTransition {
  return Object.freeze({ state, effects })
}

function sameRequest(
  left: ToolsRequestStamp | undefined,
  right: ToolsRequestStamp,
): boolean {
  return left?.scopeEpoch === right.scopeEpoch && left.requestId === right.requestId
}

function browserFor(
  browser: ToolBrowserState,
  snapshot: SessionToolsSnapshot,
): ToolBrowserState {
  return browser.open
    ? reconcileToolBrowser(browser, snapshot)
    : openToolBrowser(browser, snapshot)
}

export function createToolsFeatureState(): ToolsFeatureState {
  return Object.freeze({
    phase: 'idle',
    browser: createToolBrowserState(),
  })
}

export function transitionToolsFeature(
  state: ToolsFeatureState,
  event: ToolsFeatureEvent,
): ToolsFeatureTransition {
  switch (event.type) {
    case 'load.started':
      return changed(stateWith(state, {
        phase: state.snapshot === undefined ? 'loading' : 'refreshing',
        request: freezeRequest(event.request),
        error: undefined,
      }))
    case 'load.succeeded': {
      if (!sameRequest(state.request, event.request)) return unchanged(state)
      const snapshot = detachToolsSnapshot(event.snapshot)
      return changed(stateWith(state, {
        phase: snapshot.error === undefined ? 'ready' : 'failed',
        snapshot,
        request: undefined,
        error: snapshot.error,
        browser: browserFor(state.browser, snapshot),
      }))
    }
    case 'load.failed':
      return sameRequest(state.request, event.request)
        ? changed(stateWith(state, {
            phase: 'failed',
            request: undefined,
            error: event.message,
          }))
        : unchanged(state)
    case 'snapshot.changed': {
      const snapshot = detachToolsSnapshot(event.snapshot)
      return changed(stateWith(state, {
        phase: snapshot.error === undefined ? 'ready' : 'failed',
        snapshot,
        error: snapshot.error,
        browser: browserFor(state.browser, snapshot),
      }))
    }
    case 'snapshot.failed':
      return changed(stateWith(state, { phase: 'failed', error: event.message }))
    case 'selection.move': {
      if (state.snapshot === undefined) return unchanged(state)
      const transition = applyToolBrowserAction(
        state.browser,
        state.snapshot,
        { type: event.direction === 'up' ? 'move-up' : 'move-down' },
      )
      return transition.state === state.browser
        ? unchanged(state)
        : changed(stateWith(state, { browser: transition.state }))
    }
    case 'query.edit': {
      if (state.snapshot === undefined) return unchanged(state)
      const transition = applyToolBrowserAction(
        state.browser,
        state.snapshot,
        { type: 'edit', action: event.action },
      )
      return transition.state === state.browser
        ? unchanged(state)
        : changed(stateWith(state, { browser: transition.state }))
    }
    case 'refresh.requested':
      return unchanged(state, [Object.freeze({
        type: 'resource.refresh',
        resourceId: 'tools.catalog',
      })])
    /* v8 ignore next 2 -- ToolsFeatureEvent is exhausted above. */
    default:
      return assertNever(event)
  }
}

/* v8 ignore next 3 -- exported discriminated union is exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Tools Feature event: ${String(value)}`)
}
