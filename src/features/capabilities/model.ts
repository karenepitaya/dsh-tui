import {
  createCapabilitiesFeatureState,
  transitionCapabilitiesFeature,
  type CapabilitiesFeatureEffect,
  type CapabilitiesFeatureEvent,
  type CapabilitiesFeatureState,
} from './machine.ts'

export type CapabilitiesStateListener = (state: CapabilitiesFeatureState) => void
export type CapabilitiesEffectListener = (effect: CapabilitiesFeatureEffect) => void

export interface CapabilitiesFeatureStateSource {
  snapshot(): CapabilitiesFeatureState
  onChanged(listener: CapabilitiesStateListener): () => void
}

export interface CapabilitiesFeatureModel extends CapabilitiesFeatureStateSource {
  dispatch(event: CapabilitiesFeatureEvent): readonly CapabilitiesFeatureEffect[]
  onEffect(listener: CapabilitiesEffectListener): () => void
  dispose(): void
}

export function createCapabilitiesFeatureModel(): CapabilitiesFeatureModel {
  let current = createCapabilitiesFeatureState()
  let disposed = false
  const listeners = new Set<CapabilitiesStateListener>()
  const effectListeners = new Set<CapabilitiesEffectListener>()

  const assertActive = (): void => {
    if (disposed) throw new Error('Capabilities Feature model is disposed')
  }

  const removeOnce = <T>(listenersSet: Set<T>, listener: T): (() => void) => {
    let active = true
    return () => {
      if (!active) return
      active = false
      listenersSet.delete(listener)
    }
  }

  return Object.freeze({
    snapshot: () => current,
    onChanged: (listener: CapabilitiesStateListener) => {
      assertActive()
      listeners.add(listener)
      return removeOnce(listeners, listener)
    },
    onEffect: (listener: CapabilitiesEffectListener) => {
      assertActive()
      effectListeners.add(listener)
      return removeOnce(effectListeners, listener)
    },
    dispatch: (event: CapabilitiesFeatureEvent) => {
      assertActive()
      const next = transitionCapabilitiesFeature(current, event)
      if (next.state !== current) {
        current = next.state
        for (const listener of [...listeners]) {
          try {
            listener(current)
          } catch {
            // A presentation listener cannot poison Feature state.
          }
        }
      }
      for (const effect of next.effects) {
        for (const listener of [...effectListeners]) {
          try {
            listener(effect)
          } catch {
            // An effect observer cannot poison the Feature machine.
          }
        }
      }
      return next.effects
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      listeners.clear()
      effectListeners.clear()
    },
  })
}
