import type { PromptImageInput, SessionAttachmentSnapshot } from './port.ts'

/** Shared staging checks for both file paths and clipboard images. */
export function imageStagingError(
  images: readonly PromptImageInput[],
  image: PromptImageInput,
  limits: SessionAttachmentSnapshot,
): string | undefined {
  if (limits.maxImagesPerMessage !== undefined && images.length >= limits.maxImagesPerMessage) {
    return `At most ${limits.maxImagesPerMessage} images can be sent together`
  }
  const bytes = images.reduce((total, item) => total + item.bytes, image.bytes)
  return limits.maxMessageImageBytes !== undefined && bytes > limits.maxMessageImageBytes
    ? 'Staged images exceed the aggregate image-byte limit'
    : undefined
}
