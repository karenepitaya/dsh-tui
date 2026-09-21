import {
  applyMcpCapabilityBrowserAction,
  createMcpCapabilityBrowserState,
  openMcpCapabilityBrowser,
  reconcileMcpCapabilityBrowser,
  type McpCapabilityBrowserState,
} from '../../mcp/capabilities.ts'
import type { SessionToolsSnapshot } from '../../tool/port.ts'
import type { PromptEditorAction } from '../../ui/prompt-editor.ts'
import { detachMcpToolsSnapshot } from './projectors.ts'

export type McpFeaturePhase = 'idle' | 'loading' | 'ready' | 'refreshing' | 'failed'

export interface McpRequestStamp {
  readonly scopeEpoch: number
  readonly requestId: number
}

export interface McpFeatureState {
  readonly phase: McpFeaturePhase
  readonly browser: McpCapabilityBrowserState
  readonly snapshot?: SessionToolsSnapshot | undefined
  readonly request?: McpRequestStamp | undefined
  readonly error?: string | undefined
}

export type McpFeatureEvent =
  | { readonly type: 'load.started'; readonly request: McpRequestStamp }
  | {
      readonly type: 'load.succeeded'
      readonly request: McpRequestStamp
      readonly snapshot: SessionToolsSnapshot
    }
  | { readonly type: 'load.failed'; readonly request: McpRequestStamp; readonly message: string }
  | { readonly type: 'snapshot.changed'; readonly snapshot: SessionToolsSnapshot }
  | { readonly type: 'snapshot.failed'; readonly message: string }
  | { readonly type: 'selection.move'; readonly direction: 'up' | 'down' }
  | { readonly type: 'query.edit'; readonly action: PromptEditorAction }
  | { readonly type: 'refresh.requested' }

export type McpFeatureEffect = {
  readonly type: 'resource.refresh'
  readonly resourceId: 'mcp.catalog'
}

export interface McpFeatureTransition {
  readonly state: McpFeatureState
  readonly effects: readonly McpFeatureEffect[]
}

const NO_EFFECTS: readonly McpFeatureEffect[] = Object.freeze([])

function sameRequest(
  left: McpRequestStamp | undefined,
  right: McpRequestStamp,
): boolean {
  return left?.scopeEpoch === right.scopeEpoch && left.requestId === right.requestId
}

function browserFor(
  browser: McpCapabilityBrowserState,
  snapshot: SessionToolsSnapshot,
): McpCapabilityBrowserState {
  return browser.open
    ? reconcileMcpCapabilityBrowser(browser, snapshot)
    : openMcpCapabilityBrowser(browser, snapshot)
}

function update(
  state: McpFeatureState,
  patch: Partial<McpFeatureState>,
  effects: readonly McpFeatureEffect[] = NO_EFFECTS,
): McpFeatureTransition {
  return Object.freeze({ state: Object.freeze({ ...state, ...patch }), effects })
}

function unchanged(
  state: McpFeatureState,
  effects: readonly McpFeatureEffect[] = NO_EFFECTS,
): McpFeatureTransition {
  return Object.freeze({ state, effects })
}

export function createMcpFeatureState(): McpFeatureState {
  return Object.freeze({
    phase: 'idle',
    browser: createMcpCapabilityBrowserState(),
  })
}

export function transitionMcpFeature(
  state: McpFeatureState,
  event: McpFeatureEvent,
): McpFeatureTransition {
  switch (event.type) {
    case 'load.started':
      return update(state, {
        phase: state.snapshot === undefined ? 'loading' : 'refreshing',
        request: Object.freeze({ ...event.request }),
        error: undefined,
      })
    case 'load.succeeded': {
      if (!sameRequest(state.request, event.request)) return unchanged(state)
      const snapshot = detachMcpToolsSnapshot(event.snapshot)
      return update(state, {
        phase: snapshot.error === undefined ? 'ready' : 'failed',
        snapshot,
        request: undefined,
        error: snapshot.error,
        browser: browserFor(state.browser, snapshot),
      })
    }
    case 'load.failed':
      return sameRequest(state.request, event.request)
        ? update(state, { phase: 'failed', request: undefined, error: event.message })
        : unchanged(state)
    case 'snapshot.changed': {
      const snapshot = detachMcpToolsSnapshot(event.snapshot)
      return update(state, {
        phase: snapshot.error === undefined ? 'ready' : 'failed',
        snapshot,
        error: snapshot.error,
        browser: browserFor(state.browser, snapshot),
      })
    }
    case 'snapshot.failed':
      return update(state, { phase: 'failed', error: event.message })
    case 'selection.move': {
      if (state.snapshot === undefined) return unchanged(state)
      const transition = applyMcpCapabilityBrowserAction(
        state.browser,
        state.snapshot,
        { type: event.direction === 'up' ? 'move-up' : 'move-down' },
      )
      return transition.state === state.browser
        ? unchanged(state)
        : update(state, { browser: transition.state })
    }
    case 'query.edit': {
      if (state.snapshot === undefined) return unchanged(state)
      const transition = applyMcpCapabilityBrowserAction(
        state.browser,
        state.snapshot,
        { type: 'edit', action: event.action },
      )
      return transition.state === state.browser
        ? unchanged(state)
        : update(state, { browser: transition.state })
    }
    case 'refresh.requested':
      return unchanged(state, [Object.freeze({
        type: 'resource.refresh',
        resourceId: 'mcp.catalog',
      })])
    /* v8 ignore next 2 -- McpFeatureEvent is exhausted above. */
    default:
      return assertNever(event)
  }
}

/* v8 ignore next 3 -- exported discriminated union is exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled MCP Feature event: ${String(value)}`)
}
