/** Product-owned projection of Harness context and token accounting. */
export interface SessionContextPressure {
  /** Provider-reported prompt size for the most recent request. */
  readonly pressureTokens?: number
  /** Projected prompt size for the next request after surface changes. */
  readonly projectedTokens?: number
  /** Latest model route capacity advertised by its adapter. */
  readonly contextWindow?: number
}

/** Heuristic composition of the next model request. */
export interface SessionContextBreakdown {
  readonly systemTokens: number
  readonly toolsTokens: number
  readonly messageTokens: number
}

/** Cumulative provider-reported usage over the durable Session log. */
export interface SessionTokenUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Detached view of one Session's official token-meter projections. */
export interface SessionContextSnapshot {
  readonly available: boolean
  readonly asOfSeq?: number
  readonly pressure?: SessionContextPressure
  readonly breakdown?: SessionContextBreakdown
  readonly usage?: SessionTokenUsage
}

/** Optional context-meter capability carried by a live TUI Session lease. */
export interface SessionContextPort {
  contextSnapshot(): SessionContextSnapshot
  onContextChanged(listener: () => void): () => void
  disposeContext(): void
}

const UNAVAILABLE_CONTEXT_SNAPSHOT: SessionContextSnapshot = Object.freeze({
  available: false,
})

/** Compatibility seam for profiles without Harness token-meter projections. */
export function createUnavailableSessionContextPort(): SessionContextPort {
  return {
    contextSnapshot: () => UNAVAILABLE_CONTEXT_SNAPSHOT,
    onContextChanged: () => () => {},
    disposeContext: () => {},
  }
}
