import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { renderDshFrame } from '../src/ui/frame.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import { createUiState } from '../src/transcript/state.ts'
import { reduceUiEvent, selectSession } from '../src/transcript/reducer.ts'
import type { InteractionSnapshot } from '../src/interaction/port.ts'
import { durable, message } from './fixtures.ts'
import { approvalLayoutBudget } from '../src/presentation/approval-layout.ts'
import type { ModelPickerView } from '../src/model/picker.ts'

const approval: InteractionSnapshot = {
  type: 'interaction/snapshot', sessionId: 'session-a', pending: [{
    kind: 'approval', id: 'approval', approvalId: 'approval', sessionId: 'session-a',
    callId: 'call', toolName: 'pwsh', reason: 'Read the clock',
    evidence: { source: 'tool/call', arguments: '{"command":"Get-Date"}',
      cwd: 'D:\\Projects\\项目', currentPermission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
      requestedPermission: { kind: 'sandbox-escalation', sandboxMode: 'danger-full-access' }, missing: [] },
  }],
}

describe('repair frame contracts', () => {
  it('retains grouped routes and selected-model facts in a tall narrow model catalog', () => {
    const picker: ModelPickerView = {
      stage: 'models', selectedModelIndex: 0, selectedEffortIndex: -1, efforts: [],
      selectedModel: { provider: 'a', model: 'model' }, current: { provider: 'a', model: 'model' },
      routable: true, writable: true, loading: false, selecting: false, failures: [],
      groups: ['a', 'b'].map(provider => ({ id: provider, name: `Provider ${provider}`, models: [{
        provider, providerName: provider, id: 'model', name: `Model ${provider}`, efforts: [],
        isCurrent: provider === 'a', isDefault: false, catalogued: true, routable: true,
      }] })),
    }
    const view = { ui: createUiState(), prompt: createPromptEditorState(), interaction: undefined, modelPicker: picker }
    const narrow = renderDshFrame(view, { columns: 60, rows: 30 }).lines.join('\n')
    for (const content of ['Provider a', 'Provider b', 'SELECTED MODEL', 'Route  a/model', 'State  current', 'Reasoning']) expect(narrow).toContain(content)
    for (const extra of [
      { error: 'connection lost', writable: false, loading: true, failures: [{ provider: 'b', message: 'offline' }] },
      { groups: [], selecting: true },
      { groups: [], loading: true },
    ]) {
      const frame = renderDshFrame({ ...view, modelPicker: { ...picker, ...extra } }, { columns: 100, rows: 20 })
      if ('error' in extra) expect(frame.lines.join('\n')).toContain('Error: connection lost')
      else expect(frame.lines.join('\n')).toContain('No model catalog entries available')
      expect(frame.lines.join('\n')).toContain('Esc back')
    }
  })

  it('retains cancelled tool status in the flat verbose projection', () => {
    let ui = selectSession(createUiState(), 'session-a')
    ui = reduceUiEvent(ui, durable(0, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call', name: 'pwsh', arguments: '{}' } }))
    ui = reduceUiEvent(ui, durable(1, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } }))
    const frame = renderDshFrame({ ui, prompt: createPromptEditorState(), interaction: undefined, transcriptViewMode: 'verbose' }, { columns: 80, rows: 24 })
    expect(frame.lines.join('\n')).toContain('CANCELLED')
    expect(frame.lines.join('\n')).not.toContain('✓ DONE')
  })

  it('keeps a blocked session action visible alongside escape in a two-row workspace', () => {
    const frame = renderDshFrame({ ui: createUiState(), prompt: createPromptEditorState(), interaction: undefined,
      sessionInspection: { kind: 'ready', sessionId: 'cold', header: { sessionId: 'cold', createdAt: 0, isSubagent: false },
        projection: createUiState(), scrollOffset: 0, refreshing: false, observation: { kind: 'missing' },
        notice: 'Cold resume requires a larger terminal',
      },
    }, { columns: 40, rows: 2 })
    expect(frame.lines.join('\n')).toContain('Notice: Cold resume')
    expect(frame.lines.join('\n')).toContain('Esc back')
    expect(frame.overlay).toBeUndefined()
  })

  it.each([1, 2, 3, 4, 8, 12, 13, 24])('shares the approval safety budget at %i rows', rows => {
    const prompt = createPromptEditorState('preserved draft')
    const viewport = { columns: 80, rows }
    const budget = approvalLayoutBudget(viewport)
    for (const deferFlatFallback of [false, true]) {
      const frame = renderDshFrame({ ui: createUiState(), prompt, interaction: approval,
        input: { kind: 'approval', interactionId: 'approval', editor: createPromptEditorState(), selectedIndex: 1 },
      }, viewport, { deferFlatFallback })
      expect(frame.cursor).toBeUndefined()
      expect(frame.overlay).toBeUndefined()
      expect(frame.lines.length).toBeLessThanOrEqual(rows)
      if (budget.compactOnly) {
        expect(frame.conversation).toBeUndefined()
        expect(frame.lineStyles?.every(style => style?.backgroundRole === 'panelBackground')).toBe(true)
        expect(frame.lines.join('\n')).not.toContain('preserved draft')
        expect(frame.lines.join('\n')).toContain(budget.canInspect ? '2 Reject' : 'Terminal too small')
      } else {
        expect(frame.conversation?.dock?.lines.length).toBeLessThanOrEqual(budget.dockRows)
        expect(frame.conversation?.dock?.lines.length).toBeGreaterThanOrEqual(4)
        expect(frame.conversation?.composer).toBe('preserved draft')
        expect(frame.conversation?.composerDisabled).toBe(true)
        expect(frame.conversation?.composerMaxRows).toBeGreaterThan(0)
      }
      expect(prompt.text).toBe('preserved draft')
    }
  })

  it('docks approval above the unchanged draft without covering the transcript', () => {
    const ui = reduceUiEvent(selectSession(createUiState(), 'session-a'), durable(0, {
      type: 'user/message', data: { message: message('user', 'user', 'Visible conversation'), surfaceOp: 'append' },
    }))
    const frame = renderDshFrame({ ui, prompt: createPromptEditorState('keep this draft'),
      interaction: approval, input: { kind: 'approval', interactionId: 'approval',
        editor: createPromptEditorState(), selectedIndex: 1 },
    }, { columns: 100, rows: 30 })
    expect(frame.overlay).toBeUndefined()
    expect(frame.conversation?.composer).toBe('keep this draft')
    expect(frame.conversation?.dock?.lines.join('\n')).toContain('Get-Date')
    expect(frame.lines.join('\n')).toContain('Visible conversation')
    const approvalRow = frame.lines.findIndex(line => line.includes('Allow pwsh?'))
    const composerRow = frame.lines.findIndex(line => line.startsWith('╭'))
    expect(approvalRow).toBeGreaterThan(0)
    expect(composerRow).toBeGreaterThan(approvalRow)
    expect(frame.conversation?.dock?.lines.join('\n')).toContain('› 2 Reject')
  })

  it.each(['', 'hello', 'two\nlines'])('keeps one solid composer appearance for %j', text => {
    const frame = renderDshFrame({ ui: createUiState(), prompt: createPromptEditorState(text), interaction: undefined },
      { columns: 80, rows: 24 })
    expect(frame.conversation?.composerBoxed).toBe(true)
    expect(frame.lines.join('\n')).not.toContain('PROMPT')
    const top = frame.lines.findIndex(line => line.startsWith('╭'))
    expect(frame.lines[top - 1]).toBe('')
    expect(frame.lineStyles?.[top]?.backgroundRole).toBe('inputBackground')
  })

  it('keeps image summaries inside the composer and all lines bounded', () => {
    const frame = renderDshFrame({ ui: createUiState(), prompt: createPromptEditorState('draft'), interaction: undefined,
      attachments: [{ name: '图片.png', mediaType: 'image/png', bytes: 10 }],
    }, { columns: 80, rows: 24 })
    const top = frame.lines.findIndex(line => line.startsWith('╭'))
    const image = frame.lines.findIndex(line => line.includes('图片.png'))
    const bottom = frame.lines.findIndex(line => line.startsWith('╰'))
    expect(image).toBeGreaterThan(top)
    expect(image).toBeLessThan(bottom)
    for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
  })

  it('shows internal tool errors as failed in verbose and counts them in compact', () => {
    let ui = selectSession(createUiState(), 'session-a')
    ui = reduceUiEvent(ui, durable(0, { type: 'tool/result', data: { turn: 1, step: 1, callId: 'call',
      isError: true, message: message('result', 'user', 'Permission denied', 'tool'), surfaceOp: 'append' } }))
    for (const transcriptViewMode of ['compact', 'verbose'] as const) {
      const frame = renderDshFrame({ ui, transcriptViewMode, prompt: createPromptEditorState(), interaction: undefined },
        { columns: 100, rows: 24 })
      expect(frame.lines.join('\n')).toMatch(/failed|FAILED/)
      expect(frame.lines.join('\n')).not.toContain('✓ DONE')
    }
  })
})
