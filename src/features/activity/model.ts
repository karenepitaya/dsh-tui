import {
  createActivityFeatureState,
  transitionActivityFeature,
  type ActivityFeatureEffect,
  type ActivityFeatureEvent,
  type ActivityFeatureState,
} from './machine.ts'

export type ActivityStateListener = (state: ActivityFeatureState) => void
export type ActivityEffectListener = (effect: ActivityFeatureEffect) => void

/** Read-only state carried by semantic UiNodes. */
export interface ActivityFeatureStateSource {
  snapshot(): ActivityFeatureState
  onChanged(listener: ActivityStateListener): () => void
}

/** Feature-owned model; reducers remain pure and effects are interpreted elsewhere. */
export interface ActivityFeatureModel extends ActivityFeatureStateSource {
  dispatch(event: ActivityFeatureEvent): readonly ActivityFeatureEffect[]
  onEffect(listener: ActivityEffectListener): () => void
  dispose(): void
}

export function createActivityFeatureModel(): ActivityFeatureModel {
  let current = createActivityFeatureState()
  let disposed = false
  const stateListeners = new Set<ActivityStateListener>()
  const effectListeners = new Set<ActivityEffectListener>()

  const assertActive = (): void => {
    if (disposed) throw new Error('Activity Feature model is disposed')
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
    onChanged: (listener: ActivityStateListener) => {
      assertActive()
      stateListeners.add(listener)
      return remove(stateListeners, listener)
    },
    dispatch: (event: ActivityFeatureEvent) => {
      assertActive()
      const result = transitionActivityFeature(current, event)
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
            // One effect adapter cannot block independent resource adapters.
          }
        }
      }
      return result.effects
    },
    onEffect: (listener: ActivityEffectListener) => {
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
