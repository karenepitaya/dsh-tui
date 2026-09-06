/** Compatibility root import; the DSH-backed owner remains inside adapters/. */
export {
  apply,
  inject,
  mountDshTuiPreferencesAdapter,
  name,
  provide,
  type DshTuiPreferencesAdapterLifecycle,
  type DshTuiPreferencesAdapterMount,
} from '../adapters/preferences.ts'
