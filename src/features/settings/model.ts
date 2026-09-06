import {
  createSettingsFeatureState,
  transitionSettingsFeature,
  type SettingsFeatureEffect,
  type SettingsFeatureEvent,
  type SettingsFeatureState,
} from './machine.ts'

export type SettingsStateListener = (state: SettingsFeatureState) => void
export type SettingsEffectListener = (effect: SettingsFeatureEffect) => void

export interface SettingsFeatureStateSource {
  snapshot(): SettingsFeatureState
  onChanged(listener: SettingsStateListener): () => void
}

export interface SettingsFeatureModel extends SettingsFeatureStateSource {
  dispatch(event: SettingsFeatureEvent): readonly SettingsFeatureEffect[]
  onEffect(listener: SettingsEffectListener): () => void
  dispose(): void
}

export function createSettingsFeatureModel(): SettingsFeatureModel {
  let current = createSettingsFeatureState()
  let disposed = false
  const stateListeners = new Set<SettingsStateListener>()
  const effectListeners = new Set<SettingsEffectListener>()

  const assertActive = (): void => {
    if (disposed) throw new Error('Settings Feature model is disposed')
  }

  return Object.freeze({
    snapshot: () => current,
    onChanged: (listener: SettingsStateListener) => {
      assertActive()
      stateListeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        stateListeners.delete(listener)
      }
    },
    onEffect: (listener: SettingsEffectListener) => {
      assertActive()
      effectListeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        effectListeners.delete(listener)
      }
    },
    dispatch: (event: SettingsFeatureEvent) => {
      assertActive()
      const result = transitionSettingsFeature(current, event)
      if (result.state !== current) {
        current = result.state
        for (const listener of [...stateListeners]) {
          try {
            listener(current)
          } catch {
            // A presentation listener cannot poison Feature state.
          }
        }
      }
      for (const effect of result.effects) {
        for (const listener of [...effectListeners]) {
          try {
            listener(effect)
          } catch {
            // An effect observer cannot prevent the command owner from running it.
          }
        }
      }
      return result.effects
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      stateListeners.clear()
      effectListeners.clear()
    },
  })
}
