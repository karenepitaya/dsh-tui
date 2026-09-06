import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type {
  SessionContextBreakdown,
  SessionContextPort,
  SessionContextPressure,
  SessionContextSnapshot,
  SessionTokenUsage,
} from '../context/port.ts'

/**
 * Adapter-owned declaration of the public token-meter projection surface.
 * The runtime capability remains optional; this package does not import or
 * mount token-meter itself.
 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    readonly contextPressure: SessionContextPressure
    readonly contextBreakdown: SessionContextBreakdown
    readonly tokenUsage: SessionTokenUsage
  }
}

const CONTEXT_PROJECTION_KEYS: readonly string[] = Object.freeze([
  'contextPressure',
  'contextBreakdown',
  'tokenUsage',
])

function clonePressure(value: SessionContextPressure): SessionContextPressure {
  return {
    ...(value.pressureTokens === undefined
      ? {}
      : { pressureTokens: value.pressureTokens }),
    ...(value.projectedTokens === undefined
      ? {}
      : { projectedTokens: value.projectedTokens }),
    ...(value.contextWindow === undefined
      ? {}
      : { contextWindow: value.contextWindow }),
  }
}

function cloneBreakdown(value: SessionContextBreakdown): SessionContextBreakdown {
  return {
    systemTokens: value.systemTokens,
    toolsTokens: value.toolsTokens,
    messageTokens: value.messageTokens,
  }
}

function cloneUsage(value: SessionTokenUsage): SessionTokenUsage {
  return {
    uncachedInputTokens: value.uncachedInputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
  }
}

/** Same-process adapter over the official session-projection registry. */
export class DshSessionContextMeter implements SessionContextPort {
  private registry: SessionProjectionRegistry | undefined
  private readonly listeners = new Set<() => void>()
  private stopProjection: (() => void) | undefined
  private readonly stopRegistryBinding: () => void
  private disposed = false

  constructor(
    ctx: Context,
    private readonly session: Session,
  ) {
    const activeRegistry = ctx.get('sessionProjections')
    if (activeRegistry !== undefined) this.attach(activeRegistry)

    const projectionFiber = ctx.inject(['sessionProjections'], (projectionCtx) => {
      if (this.disposed) return
      return this.attach(projectionCtx.sessionProjections)
    })
    this.stopRegistryBinding = () => {
      void projectionFiber.dispose().catch(error => ctx.logger.error(error))
    }
  }

  private attach(registry: SessionProjectionRegistry): () => void {
    if (this.registry === registry) return this.stopProjection!

    this.stopProjection?.()
    this.registry = registry
    let active = true
    const stopChanged = registry.onChanged((changedSession, key) => {
      if (
        this.disposed
        || changedSession !== this.session
        || !CONTEXT_PROJECTION_KEYS.includes(key)
      ) return
      this.notify()
    })
    const release = () => {
      if (!active) return
      active = false
      stopChanged()
      this.stopProjection = undefined
      this.registry = undefined
      if (!this.disposed) this.notify()
    }
    this.stopProjection = release
    this.notify()
    return release
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A view observer cannot veto the official projection drive.
      }
    }
  }

  contextSnapshot(): SessionContextSnapshot {
    if (this.disposed || this.registry === undefined) return { available: false }
    const snapshot = this.registry.snapshot(this.session)
    const pressure = snapshot.values.contextPressure
    const breakdown = snapshot.values.contextBreakdown
    const usage = snapshot.values.tokenUsage
    const available = pressure !== undefined
      || breakdown !== undefined
      || usage !== undefined
    return {
      available,
      asOfSeq: snapshot.asOfSeq,
      ...(pressure === undefined ? {} : { pressure: clonePressure(pressure) }),
      ...(breakdown === undefined ? {} : { breakdown: cloneBreakdown(breakdown) }),
      ...(usage === undefined ? {} : { usage: cloneUsage(usage) }),
    }
  }

  onContextChanged(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  disposeContext(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopProjection?.()
    this.stopRegistryBinding()
    this.listeners.clear()
  }
}
