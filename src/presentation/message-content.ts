import type {
  UiAssistantChunk,
  UiContentBlock,
  UiImageContentBlock,
  UiToolCallContentBlock,
  UiUnsupportedContentBlock,
} from '../runtime/events.ts'

export interface UiMessageContentProjection {
  readonly text: string
  readonly reasoning: string
  readonly images: readonly UiImageContentBlock[]
  readonly toolCalls: readonly UiToolCallContentBlock[]
  readonly unsupported: readonly UiUnsupportedContentBlock[]
}

export interface UiAssistantDraftProjection {
  readonly text: string
  readonly reasoning: string
}

/** Fold a typed message without ever treating reasoning or extension payload as final text. */
export function projectUiMessageContent(
  content: readonly UiContentBlock[],
): UiMessageContentProjection {
  let text = ''
  let reasoning = ''
  const images: UiImageContentBlock[] = []
  const toolCalls: UiToolCallContentBlock[] = []
  const unsupported: UiUnsupportedContentBlock[] = []

  for (const block of content) {
    switch (block.type) {
      case 'text':
        text += block.text
        break
      case 'reasoning':
        reasoning += block.text
        break
      case 'image':
        images.push(block)
        break
      case 'tool-call':
        toolCalls.push(block)
        break
      case 'unsupported':
        unsupported.push(block)
        break
    }
  }

  return { text, reasoning, images, toolCalls, unsupported }
}

/** Fold renderable stream deltas; control and future chunks remain journal-only. */
export function projectUiAssistantChunks(
  chunks: readonly UiAssistantChunk[],
): UiAssistantDraftProjection {
  let text = ''
  let reasoning = ''
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'reasoning-delta') reasoning += chunk.text
  }
  return { text, reasoning }
}
