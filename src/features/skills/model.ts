import {
  createSkillsFeatureState,
  transitionSkillsFeature,
  type SkillsFeatureEffect,
  type SkillsFeatureEvent,
  type SkillsFeatureState,
} from './machine.ts'

export type SkillsStateListener = (state: SkillsFeatureState) => void
export type SkillsEffectListener = (effect: SkillsFeatureEffect) => void

export interface SkillsFeatureStateSource {
  snapshot(): SkillsFeatureState
  onChanged(listener: SkillsStateListener): () => void
}

export interface SkillsFeatureModel extends SkillsFeatureStateSource {
  dispatch(event: SkillsFeatureEvent): readonly SkillsFeatureEffect[]
  onEffect(listener: SkillsEffectListener): () => void
  dispose(): void
}

export function createSkillsFeatureModel(): SkillsFeatureModel {
  let current = createSkillsFeatureState()
  let disposed = false
  const listeners = new Set<SkillsStateListener>()
  const effectListeners = new Set<SkillsEffectListener>()

  const assertActive = (): void => {
    if (disposed) throw new Error('Skills Feature model is disposed')
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
    onChanged: (listener: SkillsStateListener) => {
      assertActive()
      listeners.add(listener)
      return removeOnce(listeners, listener)
    },
    onEffect: (listener: SkillsEffectListener) => {
      assertActive()
      effectListeners.add(listener)
      return removeOnce(effectListeners, listener)
    },
    dispatch: (event: SkillsFeatureEvent) => {
      assertActive()
      const next = transitionSkillsFeature(current, event)
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
