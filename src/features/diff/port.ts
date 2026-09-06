import { createCapabilityToken, type MaybePromise } from '../../kernel/capability.ts'
import type { ScopeDisposer } from '../../lifecycle/scope-manager.ts'

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed'
export type DiffLineKind = 'context' | 'added' | 'removed'

export interface DiffLine {
  readonly kind: DiffLineKind
  readonly oldLine?: number
  readonly newLine?: number
  readonly text: string
}

export interface DiffHunk {
  /** Stable and unique within one DiffDocument. */
  readonly id: string
  readonly header: string
  readonly lines: readonly DiffLine[]
}

export interface DiffFile {
  readonly path: string
  readonly previousPath?: string
  readonly status: DiffFileStatus
  readonly hunks: readonly DiffHunk[]
}

/** Adapter-produced, renderer-independent diff details for one content digest. */
export interface DiffDocument {
  readonly digest: string
  readonly title?: string
  readonly files: readonly DiffFile[]
}

/** Cheap identity probe used before the expensive diff computation. */
export interface DiffContentReference {
  readonly digest: string
}

export interface DiffDescribeContext {
  readonly signal: AbortSignal
}

export interface DiffComputeContext {
  readonly reference: DiffContentReference
  readonly signal: AbortSignal
}

export interface DiffWatchContext {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

/**
 * DSH-free capability seam. The outer adapter decides whether details come
 * from a durable transcript projection, a worktree, or another implementation.
 */
export interface DiffWorkspacePort {
  describeCurrent(
    context: DiffDescribeContext,
  ): MaybePromise<DiffContentReference | null | undefined>
  compute(context: DiffComputeContext): MaybePromise<DiffDocument>
  watch?(context: DiffWatchContext): void | ScopeDisposer
}

export const DIFF_WORKSPACE_CAPABILITY = createCapabilityToken<DiffWorkspacePort>(
  'dsh-tui.diff.workspace/v1',
  'session',
)
