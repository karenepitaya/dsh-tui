export interface SessionRuntimeMemoryKey {
  readonly sessionId: string
  readonly bindingEpoch: number
}

export interface SessionRuntimeDraft {
  readonly text: string
  /** Cursor position in grapheme clusters, matching the prompt editor contract. */
  readonly cursor: number
}

export type SessionRuntimeImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'

/** Unsaved attachment bytes owned only by one application process. */
export interface SessionRuntimeAttachment {
  readonly name: string
  readonly mediaType: SessionRuntimeImageMediaType
  readonly bytes: number
  readonly data: Uint8Array
}

/** Semantic transcript position, independent of terminal width and row numbers. */
export interface SessionRuntimeScrollAnchor {
  readonly nodeKey: string
  readonly intraVisualLine: number
  readonly ordinal: number
}

export type SessionRuntimeTranscriptViewMode = 'compact' | 'verbose'

export interface SessionRuntimeSnapshot {
  readonly draft: SessionRuntimeDraft
  readonly attachments: readonly SessionRuntimeAttachment[]
  readonly scrollAnchor: SessionRuntimeScrollAnchor | undefined
  readonly transcriptViewMode: SessionRuntimeTranscriptViewMode
}

function cloneSnapshot(snapshot: SessionRuntimeSnapshot): SessionRuntimeSnapshot {
  const draft = Object.freeze({ ...snapshot.draft })
  const attachments = Object.freeze(snapshot.attachments.map(attachment => Object.freeze({
    name: attachment.name,
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
    data: attachment.data.slice(),
  })))
  const scrollAnchor = snapshot.scrollAnchor === undefined
    ? undefined
    : Object.freeze({ ...snapshot.scrollAnchor })
  return Object.freeze({
    draft,
    attachments,
    scrollAnchor,
    transcriptViewMode: snapshot.transcriptViewMode,
  })
}

/**
 * Process-local UI memory for exact session bindings.
 *
 * The caller owns each instance. Nothing is persisted or shared through module
 * state, and cleanup is explicit at binding, session, and application scope.
 */
export class SessionRuntimeMemory {
  private readonly sessions = new Map<
    string,
    Map<number, SessionRuntimeSnapshot>
  >()

  private entryCount = 0

  get size(): number {
    return this.entryCount
  }

  save(key: SessionRuntimeMemoryKey, snapshot: SessionRuntimeSnapshot): void {
    let epochs = this.sessions.get(key.sessionId)
    if (epochs === undefined) {
      epochs = new Map<number, SessionRuntimeSnapshot>()
      this.sessions.set(key.sessionId, epochs)
    }
    if (!epochs.has(key.bindingEpoch)) this.entryCount += 1
    epochs.set(key.bindingEpoch, cloneSnapshot(snapshot))
  }

  restore(key: SessionRuntimeMemoryKey): SessionRuntimeSnapshot | undefined {
    const snapshot = this.sessions.get(key.sessionId)?.get(key.bindingEpoch)
    return snapshot === undefined ? undefined : cloneSnapshot(snapshot)
  }

  delete(key: SessionRuntimeMemoryKey): boolean {
    const epochs = this.sessions.get(key.sessionId)
    if (epochs === undefined || !epochs.delete(key.bindingEpoch)) return false
    this.entryCount -= 1
    if (epochs.size === 0) this.sessions.delete(key.sessionId)
    return true
  }

  clearSession(sessionId: string): number {
    const epochs = this.sessions.get(sessionId)
    if (epochs === undefined) return 0
    this.sessions.delete(sessionId)
    this.entryCount -= epochs.size
    return epochs.size
  }

  clear(): void {
    this.sessions.clear()
    this.entryCount = 0
  }
}
