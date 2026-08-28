/** Product-owned projection of one user-invocable DSH skill. */
export interface SessionSkillEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly source: string
  readonly provider: string
  readonly resourceBase?:
    | { readonly kind: 'directory'; readonly path: string }
    | { readonly kind: 'url'; readonly url: string }
    | { readonly kind: 'opaque'; readonly description: string }
}

/** Detached, last-good catalog view for one exact live Agent. */
export interface SessionSkillsSnapshot {
  readonly available: boolean
  readonly loading: boolean
  /** False means discovery was interrupted by an invalidation and will be retried. */
  readonly complete: boolean
  /** A previous complete catalog is retained while the current observation is incomplete. */
  readonly stale: boolean
  readonly generation: number
  readonly skills: readonly SessionSkillEntry[]
  readonly error?: string
}

/** Product-owned seam over DSH's scoped, cwd-sensitive SkillRegistry. */
export interface SessionSkillsPort {
  skillsSnapshot(): SessionSkillsSnapshot
  refreshSkills(signal?: AbortSignal): Promise<void>
  onSkillsChanged(listener: () => void): () => void
  disposeSkills(): void
}

const UNAVAILABLE_SKILLS_SNAPSHOT: SessionSkillsSnapshot = Object.freeze({
  available: false,
  loading: false,
  complete: true,
  stale: false,
  generation: 0,
  skills: Object.freeze([]),
})

/** Compatibility seam for non-DSH test and embedder leases. */
export function createUnavailableSessionSkillsPort(): SessionSkillsPort {
  return {
    skillsSnapshot: () => UNAVAILABLE_SKILLS_SNAPSHOT,
    refreshSkills: () => Promise.resolve(),
    onSkillsChanged: () => () => {},
    disposeSkills: () => {},
  }
}
