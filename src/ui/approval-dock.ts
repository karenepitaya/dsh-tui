import type { DshTuiInputMode } from '../interaction/editor.ts'
import { APPROVAL_FIELD_DISPLAY_LIMIT, approvalEvidenceError, type InteractionSnapshot, type PendingApprovalInteraction } from '../interaction/port.ts'
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from '../terminal/text-layout.ts'
import type { ConversationDock, ConversationStyledLine, ConversationStyledSegment } from './conversation.ts'
import type { DshTuiSemanticRole } from './theme.ts'

/** Show controls as literal escapes instead of executing or silently hiding argument bytes. */
function escaped(text: string): string {
  return text.slice(0, APPROVAL_FIELD_DISPLAY_LIMIT).replace(
    /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function styled(text: string, columns: number, tone: DshTuiSemanticRole, bold = false): ConversationStyledLine {
  return { segments: [{ text: stripTerminalSequences(truncateToWidth(text, columns, '')), tone, bold }] }
}

type ApprovalDock = ConversationDock & {
  readonly styledLines: readonly ConversationStyledLine[]
  readonly evidenceViewport: { readonly offset: number; readonly maxOffset: number }
}

function dock(lines: readonly ConversationStyledLine[], disabled: boolean, evidenceViewport = { offset: 0, maxOffset: 0 }): ApprovalDock {
  const result = {
    label: 'Permission request', role: 'interaction' as const, inline: true,
    status: disabled ? 'warning' as const : 'running' as const,
    lines: lines.map(line => line.segments.map(segment => segment.text).join('')),
    styledLines: lines,
    evidenceViewport,
  }
  return result
}

/** Fixed decisions around a scrollable, source-attributed exact-call evidence window. */
export function buildApprovalDock(
  item: PendingApprovalInteraction,
  snapshot: InteractionSnapshot,
  input: DshTuiInputMode,
  columns: number,
  maxRows: number,
): ApprovalDock {
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1
  const height = Number.isFinite(maxRows) ? Math.max(1, Math.floor(maxRows)) : 1
  if (height < 4 || width < 40) {
    const warning = height === 1 ? 'Terminal too small · Esc reject' : 'Terminal too small for approval'
    return dock([
      styled(warning, width, 'warning', true),
      ...(height === 1 ? [] : [styled('Esc reject · enlarge terminal to inspect', width, 'warning')]),
    ], true)
  }
  const active = input.kind === 'approval' && input.interactionId === item.id ? input : undefined
  const position = snapshot.pending.findIndex(pending => pending.kind === 'approval'
    && pending.id === item.id && pending.approvalId === item.approvalId
    && pending.callId === item.callId && pending.sessionId === item.sessionId)
  const correlationError = position < 0 || snapshot.sessionId !== item.sessionId
    ? 'Pending request correlation is unavailable.' : undefined
  const evidenceError = correlationError ?? approvalEvidenceError(item)
  const disabled = evidenceError !== undefined
  const queue = `${position < 0 ? '?' : position + 1}/${snapshot.pending.length}`
  const evidence = item.evidence
  const current = evidence?.currentPermission
  const requested = evidence?.requestedPermission
  const fields: readonly (readonly [string, string, DshTuiSemanticRole])[] = [
    ...(evidenceError === undefined ? [] : [['Incomplete evidence', evidenceError, 'warning'] as const]),
    ...(active?.error === undefined ? [] : [['Response error', active.error, 'error'] as const]),
    ['Tool / call', `${item.toolName} / ${item.callId}`, 'tool'],
    ['Cwd', evidence?.cwd ?? 'unavailable', 'telemetry'],
    ['Current permission', current === undefined ? 'unavailable' : `${current.sandboxMode} / ${current.approvalPolicy}`, 'telemetry'],
    ['Requested permission', requested === undefined ? 'unavailable' : requested.kind === 'tool-call'
      ? 'this tool call only; session policy unchanged'
      : `${current?.sandboxMode ?? 'unknown'} → ${requested.sandboxMode} (this call only)`, 'telemetry'],
    ['Arguments', evidence?.arguments ?? 'unavailable', 'code'],
    ['Reason (request explanation, not evidence)', item.reason ?? 'not supplied', 'muted'],
    ['Evidence source', evidence?.source ?? 'unavailable', 'muted'],
    ['Approval / session', `${item.approvalId} / ${item.sessionId}`, 'muted'],
  ]
  let truncated = false
  const body = fields.flatMap(([label, value, tone]) => {
    truncated ||= value.length > APPROVAL_FIELD_DISPLAY_LIMIT
    return wrapTextWithAnsi(`${label}: ${escaped(value)}`, width)
      .map(line => styled(line, width, tone))
  })
  if (truncated) body.push(styled('Truncated display: a field exceeds 65,536 characters; raw evidence is unchanged.', width, 'warning'))
  const bodyRows = Math.min(body.length, height - 3)
  const offset = Math.min(Math.max(0, Math.floor(active?.scrollOffset ?? 0) || 0), body.length - bodyRows)
  const selected = disabled || active?.selectedIndex !== 0 ? 1 : 0
  const allow = `${selected === 0 ? '›' : ' '} 1 Allow once${disabled ? ' [disabled]' : ''}`
  const reject = `${selected === 1 ? '›' : ' '} 2 Reject`
  const actionSegments: readonly ConversationStyledSegment[] = [
    { text: allow, tone: disabled ? 'muted' : selected === 0 ? 'accent' : 'primary', bold: selected === 0 },
    { text: '   ', tone: 'muted' },
    { text: reject, tone: selected === 1 ? 'warning' : 'primary', bold: selected === 1 },
  ]
  const header = disabled ? `─ ${queue} · Incomplete evidence · Allow disabled` : `─ Permission request · ${queue}`
  const range = `${offset + 1}-${offset + bodyRows}/${body.length}`
  const footer = `Esc reject · ←→ Enter · ↑↓ ${range}${truncated ? ' · truncated' : ''}`
  return dock([
    styled(header, width, disabled ? 'warning' : 'interaction', true),
    ...body.slice(offset, offset + bodyRows),
    { segments: actionSegments },
    styled(footer, width, 'muted'),
  ], disabled, { offset, maxOffset: body.length - bodyRows })
}
