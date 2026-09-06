import {
  createMcpFeatureState,
  transitionMcpFeature,
  type McpFeatureEffect,
  type McpFeatureEvent,
  type McpFeatureState,
} from './machine.ts'

export type McpStateListener = (state: McpFeatureState) => void
export type McpEffectListener = (effect: McpFeatureEffect) => void

export interface McpFeatureStateSource {
  snapshot(): McpFeatureState
  onChanged(listener: McpStateListener): () => void
}

export interface McpFeatureModel extends McpFeatureStateSource {
  dispatch(event: McpFeatureEvent): readonly McpFeatureEffect[]
  onEffect(listener: McpEffectListener): () => void
  dispose(): void
}

export function createMcpFeatureModel(): McpFeatureModel {
  let current = createMcpFeatureState()
  let disposed = false
  const listeners = new Set<McpStateListener>()
  const effectListeners = new Set<McpEffectListener>()
  const assertActive = (): void => {
    if (disposed) throw new Error('MCP Feature model is disposed')
  }
  return Object.freeze({
    snapshot: () => current,
    onChanged: (listener: McpStateListener) => {
      assertActive()
      listeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
      }
    },
    dispatch: (event: McpFeatureEvent) => {
      assertActive()
      const result = transitionMcpFeature(current, event)
      if (result.state !== current) {
        current = result.state
        for (const listener of [...listeners]) {
          try {
            listener(current)
          } catch {
            // Presentation listeners cannot poison Feature state.
          }
        }
      }
      for (const effect of result.effects) {
        for (const listener of [...effectListeners]) {
          try {
            listener(effect)
          } catch {
            // One effect adapter cannot block another resource adapter.
          }
        }
      }
      return result.effects
    },
    onEffect: (listener: McpEffectListener) => {
      assertActive()
      effectListeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        effectListeners.delete(listener)
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      listeners.clear()
      effectListeners.clear()
    },
  })
}
