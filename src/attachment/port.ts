/** Image media types supported by the official rc.2 attachment contract. */
export type PromptImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'

/** Encoded image bytes before the exact session validates its image policy. */
export interface PromptImageBytes {
  readonly name: string
  readonly mediaType: PromptImageMediaType
  readonly data: Uint8Array
}

export type ClipboardContent =
  | { readonly kind: 'empty' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly image: PromptImageBytes }

export interface ClipboardReadOptions {
  readonly signal?: AbortSignal
  readonly maxImageBytes?: number
}

/** One user-triggered clipboard read; image admission belongs to the session. */
export interface ClipboardPort {
  read(options?: ClipboardReadOptions): Promise<ClipboardContent>
}

/** Unsaved, session-local composer image. The local path never crosses this seam. */
export interface PromptImageInput {
  readonly name: string
  readonly mediaType: PromptImageMediaType
  readonly bytes: number
  readonly data: Uint8Array
}

/** Safe UI projection; neither local path nor binary data reaches the renderer. */
export interface PromptImageView {
  readonly name: string
  readonly mediaType: PromptImageMediaType
  readonly bytes: number
}

/** Product projection of the mounted deployment's authoritative image limits. */
export interface SessionAttachmentSnapshot {
  readonly available: boolean
  readonly maxImageBytes?: number
  readonly maxImagesPerMessage?: number
  readonly maxMessageImageBytes?: number
  readonly mediaTypes?: readonly PromptImageMediaType[]
}

/** Exact-session adapter for preparing a local image without persisting it. */
export interface SessionAttachmentPort {
  attachmentSnapshot(): SessionAttachmentSnapshot
  prepareImage(path: string, signal?: AbortSignal): Promise<PromptImageInput>
  /** Optional for existing embedders that only support image paths. */
  prepareImageBytes?(input: PromptImageBytes, signal?: AbortSignal): Promise<PromptImageInput>
}

export function createUnavailableSessionAttachmentPort(): SessionAttachmentPort {
  return {
    attachmentSnapshot: () => ({ available: false }),
    prepareImage: () => Promise.reject(new Error('Image attachments are unavailable')),
    prepareImageBytes: () => Promise.reject(new Error('Image attachments are unavailable')),
  }
}
