import { describe, expect, it } from 'vitest'
import { buildApprovalDock } from '../src/ui/approval-dock.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import type { DshTuiInputMode } from '../src/interaction/editor.ts'
import type { InteractionSnapshot, PendingApprovalInteraction } from '../src/interaction/port.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'

const item: PendingApprovalInteraction = {
  kind: 'approval', id: 'request-b', sessionId: 'session', approvalId: 'audit-b', callId: 'exact-call', toolName: 'pwsh',
  reason: 'The requested command needs wider access.',
  evidence: {
    source: 'tool/call', arguments: '{"command":"echo \\"hello\\"","workdir":"D:/work"}', cwd: 'D:/work',
    currentPermission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
    requestedPermission: { kind: 'sandbox-escalation', sandboxMode: 'danger-full-access' }, missing: [],
  },
}
const snapshot: InteractionSnapshot = { type: 'interaction/snapshot', sessionId: 'session', pending: [
  { kind: 'question', id: 'question-a', sessionId: 'session', questions: [] }, item,
] }
const input: DshTuiInputMode = { kind: 'approval', interactionId: item.id, editor: createPromptEditorState() }

function render(request = item, mode = input, columns = 100, rows = 18, pending = snapshot) {
  return buildApprovalDock(request, pending, mode, columns, rows)
}

describe('fixed inline approval dock', () => {
  it('keeps actual command and access visible when request explanations are long, with full text in details', () => {
    const request = { ...item, evidence: { ...item.evidence!, arguments: JSON.stringify({
      command: 'Remove-Item -LiteralPath "D:/work/tmp.txt"',
      description: 'Requested operation '.repeat(90) + 'DESCRIPTION_END',
      justification: 'The operation needs access '.repeat(90) + 'EXPLANATION_END',
    }) } }
    const pending = { ...snapshot, pending: [request] }
    const summary = render(request, input, 100, 12, pending).lines.join('\n')
    expect(summary).toContain('Command: Remove-Item -LiteralPath "D:/work/tmp.txt"')
    expect(summary).toContain('Working folder: D:/work')
    expect(summary).toContain('Full access')
    expect(summary).toContain('…')
    expect(summary).not.toContain('DESCRIPTION_END')
    expect(summary).not.toContain('EXPLANATION_END')
    const seen: string[] = []
    for (let scrollOffset = 0; scrollOffset < 100; scrollOffset += 6) {
      seen.push(...render(request, { ...input, kind: 'approval', detailsExpanded: true, scrollOffset }, 100, 12, pending).lines)
    }
    expect(seen.join('\n')).toContain('DESCRIPTION_END')
    expect(seen.join('\n')).toContain('EXPLANATION_END')
  })

  it('leads with readable operation and actual access, keeping audit identifiers in explicit details', () => {
    const command = 'Move-Item -LiteralPath "D:\\work\\tmp.txt" -Destination "D:\\tmp.txt"'
    const request = { ...item, allowSession: true, evidence: { ...item.evidence!, arguments: JSON.stringify({
      command, description: 'Move tmp.txt to its parent folder', justification: 'The destination is outside the working folder',
    }) } }
    const pending = { ...snapshot, pending: [request] }
    const plain = render(request, input, 120, 18, pending).lines.join('\n')
    expect(plain).toContain(command)
    expect(plain).toContain('Full access')
    expect(plain).toContain('Move tmp.txt to its parent folder')
    expect(plain).toContain('3 Allow for session')
    for (const hidden of ['exact-call', 'audit-b', 'Evidence source', 'Arguments:', 'Current permission:']) expect(plain).not.toContain(hidden)
    const detailed = render(request, { ...input, kind: 'approval', detailsExpanded: true }, 120, 30, pending).lines.join('\n')
    expect(detailed).toContain('exact-call')
    expect(detailed).toContain('audit-b')
    const remembered = render(request, { ...input, kind: 'approval', selectedIndex: 2 }, 120, 18, pending).lines.join('\n')
    expect(remembered).toContain('All pwsh calls')
    expect(remembered).toContain('/permission')
  })
  it('shows queue, exact call, raw argument boundaries and sourced permissions with reject selected', () => {
    const dock = render(item, { ...input, kind: 'approval', detailsExpanded: true }, 120, 30)
    const text = dock.lines.join('\n')
    expect(dock).toMatchObject({ inline: true, role: 'interaction', label: 'Permission request' })
    for (const expected of ['2/2', 'pwsh / exact-call', 'D:/work', item.evidence!.arguments!,
      'workspace-write / ask', 'Full access for this call', 'session policy unchanged',
      'Why: The requested command needs wider access.', 'tool/call', 'audit-b / session']) expect(text).toContain(expected)
    expect(dock.lines.at(-2)).toContain(' 1 Allow once')
    expect(dock.lines.at(-2)).toContain('› 2 Reject')
    expect(dock.lines.at(-1)).toContain('Esc reject · ←→ choose · Enter')
    expect(text).not.toContain('PROMPT')
    expect(dock.styledLines?.map(line => line.segments.map(segment => segment.text).join(''))).toEqual(dock.lines)
  })

  it('scrolls all normal-size evidence while fixed actions and window range remain at four rows', () => {
    const request = { ...item, evidence: { ...item.evidence!, arguments: 'BEGIN ' + 'echo "quoted argument"; '.repeat(80) + ' END' } }
    const seen: string[] = []
    for (let scrollOffset = 0; scrollOffset < 90; scrollOffset += 1) {
      const dock = render(request, { ...input, kind: 'approval', scrollOffset, detailsExpanded: true }, 72, 4)
      expect(dock.lines).toHaveLength(4)
      expect(dock.lines[0]).toContain('2/2')
      expect(dock.lines[2]).toContain('› 2 Reject')
      expect(dock.lines[3]).toContain('Esc reject')
      expect(dock.lines[3]).toMatch(/\d+-\d+\/\d+/u)
      seen.push(dock.lines[1]!)
    }
    expect(seen.join('\n')).toContain('BEGIN')
    expect(seen.join('\n')).toContain('END')
    expect(seen.join('\n')).toContain('audit-b / session')
  })

  it('pins missing-evidence disabled state while allowing all missing details to scroll', () => {
    const request = { ...item, evidence: { missing: ['first missing fact', 'last missing fact'] } }
    const dock = render(request, { ...input, kind: 'approval', selectedIndex: 0, scrollOffset: 9999 }, 80, 4)
    expect(dock.lines[0]).toContain('Incomplete evidence · Allow disabled')
    expect(dock.lines[2]).toContain('1 Allow once [disabled]')
    expect(dock.lines[2]).toContain('› 2 Reject')
    const top = render(request, input, 100, 18).lines.join('\n')
    expect(top).toContain('first missing fact')
    expect(top).toContain('last missing fact')
    expect(top).toContain('Input: unavailable')
  })

  it('shows explicit once selection, tool-call scope, absent reason and adapter response errors', () => {
    const { reason: _omitted, ...plain } = item
    const request = { ...plain, evidence: { ...item.evidence!, requestedPermission: { kind: 'tool-call' as const } } }
    const dock = render(request, { ...input, kind: 'approval', selectedIndex: 0, error: 'request changed' })
    expect(dock.lines.at(-2)).toContain('› 1 Allow once')
    expect(dock.lines.join('\n')).toContain('session policy unchanged')
    expect(dock.lines.join('\n')).not.toContain('Why:')
    expect(dock.lines.join('\n')).toContain('Response error: request changed')
  })

  it('does not reuse another interaction selection/scroll or display unverifiable queue ownership as grantable', () => {
    for (const mode of [
      { kind: 'prompt' as const, editor: createPromptEditorState() },
      { ...input, kind: 'approval' as const, interactionId: 'other', selectedIndex: 0, scrollOffset: 999 },
    ]) expect(render(item, mode).lines.at(-2)).toContain('› 2 Reject')
    for (const pending of [{ ...snapshot, pending: [] }, { ...snapshot, sessionId: 'other' }]) {
      const dock = render(item, input, 100, 18, pending)
      expect(dock.lines.at(-2)).toContain('[disabled]')
      expect(dock.lines.join('\n')).toContain('correlation is unavailable')
    }
    const { evidence: _omitted, ...withoutEvidence } = item
    expect(render(withoutEvidence).lines.join('\n')).toContain('Approval evidence is unavailable')
    for (const change of [
      { id: 'other' }, { approvalId: 'other' }, { callId: 'other' }, { sessionId: 'other' },
    ]) expect(render(item, input, 100, 18, { ...snapshot, pending: [{ ...item, ...change }] })
      .lines.join('\n')).toContain('correlation is unavailable')
    const { currentPermission: _policy, ...missingCurrent } = item.evidence!
    expect(render({ ...item, evidence: missingCurrent }).lines.join('\n'))
      .toContain('Allow disabled')
  })

  it('escapes controls and directional overrides, bounds huge fields and labels truncated evidence', () => {
    const request = { ...item, toolName: '\u001b[2Jpwsh\u202e', callId: '\u0007call',
      reason: '\u0000\r\n\t\u009b\u2067', evidence: { ...item.evidence!, arguments: 'x'.repeat(70_000) } }
    const first = render(request, input, 100, 18, { ...snapshot, pending: [snapshot.pending[0]!, request] }).lines.join('\n')
    expect(first).toContain('Incomplete evidence · Allow disabled')
    expect(first).toContain('1 Allow once [disabled]')
    const details = render({ ...request, evidence: { ...request.evidence, arguments: '{}' } }, { ...input, kind: 'approval', detailsExpanded: true }, 120, 30).lines.join('\n')
    expect(details).toContain('\\u001b[2Jpwsh\\u202e')
    expect(details).toContain('\\u0007call')
    const last = render(request, { ...input, kind: 'approval', scrollOffset: Infinity }, 80, 10)
    expect(last.lines.join('\n')).toContain('Truncated display')
    expect(last.lines.at(-1)).toContain('truncated')
    expect(last.lines.join('\n')).toContain('\\u0000\\u000d\\u000a\\u0009\\u009b\\u2067')
    for (const line of [...render(request).lines, ...last.lines]) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e\u2067]/u)
  })

  it('labels truncated explanations without disabling complete execution evidence', () => {
    const dock = render({ ...item, reason: 'x'.repeat(65_537) })
    expect(dock.lines.join('\n')).toContain('truncated')
    expect(dock.lines.join('\n')).not.toContain('[disabled]')
  })

  it('keeps both decisions at minimum width and reports undersized terminals instead of clipped actions', () => {
    for (const request of [item, { ...item, evidence: { missing: [] } }]) {
      for (const columns of [1, 2, 39, 40, 80, NaN]) {
        for (const rows of [1, 2, 3, 4, 8, NaN]) {
          const dock = render(request, { ...input, kind: 'approval', scrollOffset: -10 }, columns, rows)
          const width = Number.isNaN(columns) ? 1 : columns
          const height = Number.isNaN(rows) ? 1 : rows
          expect(dock.lines.length).toBeLessThanOrEqual(height)
          for (const line of dock.lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(width)
            expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u)
          }
          if (columns >= 40 && rows >= 4) {
            expect(dock.lines.at(-2)).toContain('1 Allow once')
            expect(dock.lines.at(-2)).toContain('2 Reject')
          }
          if (columns >= 40 && rows < 4) expect(dock.lines.join('\n')).toContain('Esc reject')
        }
      }
    }
  })
})
