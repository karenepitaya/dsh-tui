import { createCapabilityToken } from '../kernel/capability.ts'
import type { DshTuiPreferencesV1 } from './contracts.ts'
import type { DshTuiPreferenceSnapshot } from './repository.ts'

export interface DshTuiPreferencesApplicationStatus {
  readonly available: boolean
  readonly writable: boolean
  readonly documentBacked: boolean
}

/** Canonical application-scoped preference seam for Product and Settings UI. */
export interface DshTuiPreferencesApplicationPort {
  status(): DshTuiPreferencesApplicationStatus
  read(): Promise<DshTuiPreferenceSnapshot>
  write(
    expectedRevision: number,
    preferences: DshTuiPreferencesV1,
  ): Promise<DshTuiPreferenceSnapshot>
  onChanged(listener: () => void): () => void
}

export const DSH_TUI_PREFERENCES_CAPABILITY = createCapabilityToken<
  DshTuiPreferencesApplicationPort
>('dsh-tui.preferences/v1', 'application')
