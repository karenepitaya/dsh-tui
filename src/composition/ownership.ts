import type { Context } from '@deepseek-ai/cordis'

export type DshTuiCompositionMode = 'root' | 'split'

export const ROOT_COMPOSITION_OWNER_ID = 'dsh-tui.root'
export const SPLIT_COMPOSITION_OWNER_ID = 'dsh-tui.split'

export interface DshTuiCompositionOwner {
  readonly id: string
}

export interface DshTuiCompositionOwnership {
  readonly mode: DshTuiCompositionMode
  readonly owner: DshTuiCompositionOwner
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshTuiCompositionOwnership: DshTuiCompositionOwnership
  }
}

/**
 * Claim the single composition mode in this Cordis scope before allocating
 * any DSH-TUI owner. Re-entry is valid only for the same semantic owner.
 */
export function claimDshTuiComposition(
  ctx: Context,
  mode: DshTuiCompositionMode,
  owner: DshTuiCompositionOwner,
): DshTuiCompositionOwnership {
  const existing = ctx.get('dshTuiCompositionOwnership')
  if (existing !== undefined) {
    if (existing.mode === mode && existing.owner === owner) return existing
    throw new Error(
      'dsh-tui: composition ownership conflict: '
      + `existing=${existing.mode}:${existing.owner.id}, `
      + `requested=${mode}:${owner.id}`,
    )
  }

  const ownership = Object.freeze({ mode, owner })
  ctx.provide('dshTuiCompositionOwnership', ownership)
  return ownership
}

/** Create one mount-local identity; equal labels do not imply shared ownership. */
export function createDshTuiCompositionOwner(
  id: string,
): DshTuiCompositionOwner {
  return Object.freeze({ id })
}
