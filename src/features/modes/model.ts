import {
  createModesFeatureState,
  transitionModesFeature,
  type ModesFeatureEffect,
  type ModesFeatureEvent,
  type ModesFeatureState,
} from './machine.ts'

export type ModesStateListener = (state: ModesFeatureState) => void
export type ModesEffectListener = (effect: ModesFeatureEffect) => void

export interface ModesFeatureStateSource {
  snapshot(): ModesFeatureState
  onChanged(listener: ModesStateListener): () => void
}

export interface ModesFeatureModel extends ModesFeatureStateSource {
  dispatch(event: ModesFeatureEvent): readonly ModesFeatureEffect[]
  onEffect(listener: ModesEffectListener): () => void
  dispose(): void
}

export function createModesFeatureModel(): ModesFeatureModel {
  let current = createModesFeatureState()
  let disposed = false
  const stateListeners = new Set<ModesStateListener>()
  const effectListeners = new Set<ModesEffectListener>()

  const assertActive = (): void => {
    if (disposed) throw new Error('Modes Feature model is disposed')
  }
  const remove = <T>(listeners: Set<T>, listener: T): (() => void) => {
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners.delete(listener)
    }
  }

  return Object.freeze({
    snapshot: () => current,
    onChanged: (listener: ModesStateListener) => {
      assertActive()
      stateListeners.add(listener)
      return remove(stateListeners, listener)
    },
    dispatch: (event: ModesFeatureEvent) => {
      assertActive()
      const result = transitionModesFeature(current, event)
      if (result.state !== current) {
        current = result.state
        for (const listener of [...stateListeners]) {
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
    onEffect: (listener: ModesEffectListener) => {
      assertActive()
      effectListeners.add(listener)
      return remove(effectListeners, listener)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      stateListeners.clear()
      effectListeners.clear()
    },
  })
}

