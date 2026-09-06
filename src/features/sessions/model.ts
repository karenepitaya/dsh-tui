import {
  createSessionsFeatureState,
  transitionSessionsFeature,
  type SessionsFeatureEffect,
  type SessionsFeatureEvent,
  type SessionsFeatureState,
} from './machine.ts'

export type SessionsStateListener = (state: SessionsFeatureState) => void
export type SessionsEffectListener = (effect: SessionsFeatureEffect) => void

/** Read-only state carried by semantic UiNodes. */
export interface SessionsFeatureStateSource {
  snapshot(): SessionsFeatureState
  onChanged(listener: SessionsStateListener): () => void
}

/** Feature-owned model; reducers remain pure and effects are interpreted elsewhere. */
export interface SessionsFeatureModel extends SessionsFeatureStateSource {
  dispatch(event: SessionsFeatureEvent): readonly SessionsFeatureEffect[]
  onEffect(listener: SessionsEffectListener): () => void
  dispose(): void
}

export function createSessionsFeatureModel(): SessionsFeatureModel {
  let current = createSessionsFeatureState()
  let disposed = false
  const stateListeners = new Set<SessionsStateListener>()
  const effectListeners = new Set<SessionsEffectListener>()

  const assertActive = (): void => {
    if (disposed) throw new Error('Sessions Feature model is disposed')
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
    onChanged: (listener: SessionsStateListener) => {
      assertActive()
      stateListeners.add(listener)
      return remove(stateListeners, listener)
    },
    dispatch: (event: SessionsFeatureEvent) => {
      assertActive()
      const result = transitionSessionsFeature(current, event)
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
    onEffect: (listener: SessionsEffectListener) => {
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
