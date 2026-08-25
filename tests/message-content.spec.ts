import { describe, expect, it } from 'vitest'
import {
  projectUiAssistantChunks,
  projectUiMessageContent,
} from '../src/presentation/message-content.ts'

describe('product-owned message presentation projection', () => {
  it('keeps visible text, reasoning, attachments, calls, and unknown markers disjoint', () => {
    const projection = projectUiMessageContent([
      { type: 'reasoning', text: 'think ' },
      { type: 'text', text: 'answer ' },
      { type: 'reasoning', text: 'more' },
      { type: 'text', text: 'continued' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'attachment-1',
          mediaType: 'image/png',
          bytes: 16,
          width: 2,
          height: 2,
        },
      },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
      { type: 'unsupported', sourceType: 'plugin-private-text' },
    ])

    expect(projection.text).toBe('answer continued')
    expect(projection.reasoning).toBe('think more')
    expect(projection.images).toHaveLength(1)
    expect(projection.toolCalls).toHaveLength(1)
    expect(projection.unsupported).toEqual([
      { type: 'unsupported', sourceType: 'plugin-private-text' },
    ])
  })

  it('folds only typed text and reasoning deltas', () => {
    expect(projectUiAssistantChunks([
      { type: 'unsupported', sourceType: 'block-start' },
      { type: 'reasoning-delta', index: 0, text: 'think' },
      { type: 'unsupported', sourceType: 'block-end' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'unsupported', sourceType: 'finish' },
    ])).toEqual({ text: 'answer', reasoning: 'think' })
  })
})
