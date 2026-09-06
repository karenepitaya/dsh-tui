import {
  createToolsFeatureState,
  transitionToolsFeature,
  type ToolsFeatureEffect,
  type ToolsFeatureEvent,
  type ToolsFeatureState,
} from './machine.ts'

export type ToolsStateListener = (state: ToolsFeatureState) => void
export type ToolsEffectListener = (effect: ToolsFeatureEffect) => void

export interface ToolsFeatureStateSource {
  snapshot(): ToolsFeatureState
  onChanged(listener: ToolsStateListener): () => void
}

export interface ToolsFeatureModel extends ToolsFeatureStateSource {
  dispatch(event: ToolsFeatureEvent): readonly ToolsFeatureEffect[]
  onEffect(listener: ToolsEffectListener): () => void
  dispose(): void
}

export function createToolsFeatureModel(): ToolsFeatureModel {
  let current = createToolsFeatureState()
  let disposed = false
  const listeners = new Set<ToolsStateListener>()
  const effectListeners = new Set<ToolsEffectListener>()
  const assertActive = (): void => {
    if (disposed) throw new Error('Tools Feature model is disposed')
  }
  return Object.freeze({
    snapshot: () => current,
    onChanged: (listener: ToolsStateListener) => {
      assertActive()
      listeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
      }
    },
    dispatch: (event: ToolsFeatureEvent) => {
      assertActive()
      const result = transitionToolsFeature(current, event)
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
    onEffect: (listener: ToolsEffectListener) => {
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
