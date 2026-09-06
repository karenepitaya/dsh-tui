import {
  createModelsFeatureState,
  transitionModelsFeature,
  type ModelsFeatureEffect,
  type ModelsFeatureEvent,
  type ModelsFeatureState,
} from './machine.ts'

export type ModelsStateListener = (state: ModelsFeatureState) => void
export type ModelsEffectListener = (effect: ModelsFeatureEffect) => void

export interface ModelsFeatureStateSource {
  snapshot(): ModelsFeatureState
  onChanged(listener: ModelsStateListener): () => void
}

export interface ModelsFeatureModel extends ModelsFeatureStateSource {
  dispatch(event: ModelsFeatureEvent): readonly ModelsFeatureEffect[]
  onEffect(listener: ModelsEffectListener): () => void
  dispose(): void
}

export function createModelsFeatureModel(): ModelsFeatureModel {
  let current = createModelsFeatureState()
  let disposed = false
  const listeners = new Set<ModelsStateListener>()
  const effectListeners = new Set<ModelsEffectListener>()

  const assertActive = (): void => {
    if (disposed) throw new Error('Models Feature model is disposed')
  }

  return Object.freeze({
    snapshot: () => current,
    onChanged: (listener: ModelsStateListener) => {
      assertActive()
      listeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
      }
    },
    onEffect: (listener: ModelsEffectListener) => {
      assertActive()
      effectListeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        effectListeners.delete(listener)
      }
    },
    dispatch: (event: ModelsFeatureEvent) => {
      assertActive()
      const transition = transitionModelsFeature(current, event)
      if (transition.state !== current) {
        current = transition.state
        for (const listener of [...listeners]) {
          try {
            listener(current)
          } catch {
            // A presentation listener cannot poison Feature state.
          }
        }
      }
      for (const effect of transition.effects) {
        for (const listener of [...effectListeners]) {
          try {
            listener(effect)
          } catch {
            // One effect adapter cannot poison other consumers.
          }
        }
      }
      return transition.effects
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      listeners.clear()
      effectListeners.clear()
    },
  })
}
