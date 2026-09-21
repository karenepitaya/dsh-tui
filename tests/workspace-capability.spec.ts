import { describe, expect, it } from 'vitest'
import { renderCapabilityLensFrame } from '../src/ui/workspace-capability.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'

const query = createPromptEditorState()

describe('capability directory layout and reachable details', () => {
  it('renders empty generic detail slots without fabricating content or selections', () => {
    const options = { title: 'Tools', sectionLabel: 'Capabilities', query, rows: [], selectedIndex: -1, summary: 'empty', detail: [], footerLeft: 'read only' }
    for (const columns of [80, 120]) {
      const frame = renderCapabilityLensFrame({ ...options, navigation: { focus: 'details', detailOffset: 99 } }, { columns, rows: 12 })
      expect(frame.detailMaxOffset).toBe(0)
      expect(frame.lineStyles?.every(style => style?.inverse !== true)).toBe(true)
    }
  })
})
