import { describe, expect, it } from 'vitest'
import { createInteractionEditorState, reconcileInteractionEditor, selectDshTuiInputMode } from '../src/interaction/editor.ts'
import type { DshTuiInputMode } from '../src/interaction/editor.ts'
import type { InteractionSnapshot, PendingApprovalInteraction } from '../src/interaction/port.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'
import { buildApprovalDock } from '../src/ui/approval-dock.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'

function request(): PendingApprovalInteraction {
  return {
    kind: 'approval', id: 'request', sessionId: 'session', approvalId: 'approval', callId: 'call',
    toolName: 'read-file', allowSession: true,
    evidence: {
      source: 'tool/call', arguments: '{"path":"sample.txt"}', cwd: 'D:/fixture',
      currentPermission: { sandboxMode: 'read-only', approvalPolicy: 'ask' },
      requestedPermission: { kind: 'tool-call' }, missing: [],
    },
  }
}

function snapshot(item: PendingApprovalInteraction): InteractionSnapshot {
  return { type: 'interaction/snapshot', sessionId: item.sessionId, pending: [item] }
}

function mode(item: PendingApprovalInteraction): Extract<DshTuiInputMode, { kind: 'approval' }> {
  const input = selectDshTuiInputMode(createPromptEditorState(), reconcileInteractionEditor(createInteractionEditorState(), snapshot(item)))
  if (input.kind !== 'approval') throw new Error('Expected an approval input mode')
  return input
}

describe('session approval display contracts', () => {
  it('projects the third action and preserves expanded evidence state', () => {
    const item = request()
    const state = reconcileInteractionEditor(createInteractionEditorState(), snapshot(item))
    expect(selectDshTuiInputMode(createPromptEditorState('draft'), state)).toMatchObject({
      kind: 'approval', actionCount: 3, selectedIndex: 1,
    })
    if (state.active?.kind !== 'approval') throw new Error('Expected an approval editor')
    expect(selectDshTuiInputMode(createPromptEditorState('draft'), {
      ...state, active: { ...state.active, detailsExpanded: true },
    })).toMatchObject({ kind: 'approval', actionCount: 3, detailsExpanded: true })
  })

  it('keeps decisions and help at the bottom when concise evidence leaves spare rows', () => {
    const item = request()
    const dock = buildApprovalDock(item, snapshot(item), mode(item), 100, 12)
    expect(dock.lines).toHaveLength(12)
    expect(dock.lines[1]).toBe('Input: {"path":"sample.txt"}')
    expect(dock.lines[2]).toBe('Working folder: D:/fixture')
    expect(dock.lines[3]).toBe('Access: Read only; session policy unchanged')
    expect(dock.lines.slice(4, 10)).toEqual(Array(6).fill(''))
    expect(dock.lines[10]).toContain('1 Allow once')
    expect(dock.lines[10]).toContain('› 2 Reject')
    expect(dock.lines[10]).toContain('3 Allow for session')
    expect(dock.lines[11]).toContain('Esc reject')
    expect(dock.evidenceViewport).toEqual({ offset: 0, maxOffset: 0 })
  })

  it('keeps all three choices visible at narrow widths and fails closed without an evidence row', () => {
    const item = request()
    for (const columns of [40, 63, 64]) {
      for (const rows of [4, 5, 10]) {
        const selected = { ...mode(item), kind: 'approval' as const, selectedIndex: 2, interactionId: item.id }
        const dock = buildApprovalDock(item, snapshot(item), selected, columns, rows)
        expect(dock.lines).toHaveLength(rows)
        for (const line of dock.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
        const text = dock.lines.join('\n')
        expect(text).toContain('1 Allow once')
        expect(text).toContain('2 Reject')
        expect(text).toContain('3 Allow for session')
        expect(dock.lines.at(-1)).toContain('Esc reject')
        if (columns < 64 && rows === 4) {
          expect(text).toContain('Terminal too small')
          expect(text).not.toContain('Incomplete evidence')
          expect(text).toContain('1 Allow once [disabled]')
          expect(text).toContain('3 Allow for session [disabled]')
          expect(text).toContain('› 2 Reject')
        } else {
          expect(text).toContain('› 3 Allow for session')
          expect(text).not.toContain('[disabled]')
          expect(dock.lines[1]).not.toBe('')
        }
      }
    }
  })

  it('retains unavailable audit fields in expanded incomplete requests', () => {
    const { evidence: _omitted, ...item } = request()
    const input = { ...mode(item), kind: 'approval' as const, interactionId: item.id, detailsExpanded: true }
    const dock = buildApprovalDock(item, snapshot(item), input, 100, 18)
    const text = dock.lines.join('\n')
    expect(text).toContain('Current permission: unavailable')
    expect(text).toContain('Arguments: unavailable')
    expect(text).toContain('Evidence source: unavailable')
    expect(text).toContain('1 Allow once [disabled]')
    expect(text).toContain('3 Allow for session [disabled]')
    expect(text).toContain('› 2 Reject')
  })
})
