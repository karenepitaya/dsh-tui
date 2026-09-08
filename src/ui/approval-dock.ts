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
  const disabled = evidenceError !== undefined || (item.allowSession === true && width < 64 && height < 5)
  const queue = `${position < 0 ? '?' : position + 1}/${snapshot.pending.length}`
  const evidence = item.evidence
  const current = evidence?.currentPermission
  const requested = evidence?.requestedPermission
  const fullAccess = requested?.kind === 'sandbox-escalation' ? requested.sandboxMode : current?.sandboxMode
  const access = fullAccess === 'danger-full-access' ? 'Full access'
    : fullAccess === 'workspace-write' ? 'Write within the workspace' : fullAccess === 'read-only' ? 'Read only' : 'Access unknown'
  let args: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(evidence?.arguments ?? '')
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
  } catch { /* Keep malformed input visible; the adapter validates its evidence. */ }
  const command = typeof args?.['command'] === 'string' ? args['command'] : undefined
  const description = typeof args?.['description'] === 'string' ? args['description'] : undefined
  const explanation = typeof args?.['justification'] === 'string' ? args['justification'] : item.reason
  const remember = item.allowSession === true
  const fields: (readonly [string, string, DshTuiSemanticRole])[] = [
    ...(evidenceError === undefined ? [] : [['Incomplete evidence', evidenceError, 'warning'] as const]),
    ...(active?.error === undefined ? [] : [['Response error', active.error, 'warning'] as const]),
    ...(remember && active?.selectedIndex === 2 ? [['For this session', 'All ' + item.toolName + ' calls from this working folder with ' + access + '. Revoke in /permission; cleared on disconnect.', 'warning'] as const] : []),
    ...(description === undefined ? [] : [['Request', description, 'primary'] as const]),
    [command === undefined ? 'Input' : 'Command', command ?? evidence?.arguments ?? 'unavailable', 'code'],
    ['Working folder', evidence?.cwd ?? 'unavailable', 'primary'],
    ['Access', access + (requested?.kind === 'sandbox-escalation' ? ' for this call; session policy unchanged' : '; session policy unchanged'), 'warning'],
    ...(explanation === undefined || explanation === description ? [] : [['Why', explanation, 'muted'] as const]),
  ]
  if (active?.detailsExpanded === true) fields.push(
    ['Tool / call', item.toolName + ' / ' + item.callId, 'muted'],
    ['Current permission', current === undefined ? 'unavailable' : current.sandboxMode + ' / ' + current.approvalPolicy, 'muted'],
    ['Arguments', evidence?.arguments ?? 'unavailable', 'code'],
    ['Evidence source', evidence?.source ?? 'unavailable', 'muted'],
    ['Approval / session', item.approvalId + ' / ' + item.sessionId, 'muted'],
  )
  let truncated = false
  const body = fields.flatMap(([label, value, tone]) => {
    truncated ||= value.length > APPROVAL_FIELD_DISPLAY_LIMIT
    const wrapped = wrapTextWithAnsi(`${label}: ${escaped(value)}`, width)
    const visible = active?.detailsExpanded !== true && (label === 'Request' || label === 'Why') && wrapped.length > 2
      ? [wrapped[0]!, truncateToWidth(wrapped[1]!, width - 1, '') + '…'] : wrapped
    return visible.map(line => styled(line, width, tone))
  })
  if (truncated) body.push(styled('Truncated display: a field exceeds 65,536 characters; raw evidence is unchanged.', width, 'warning'))
  const actionRows = remember && width < 64 ? 2 : 1
  const bodyRows = Math.max(0, height - 2 - actionRows)
  const offset = Math.min(Math.max(0, Math.floor(active?.scrollOffset ?? 0) || 0), Math.max(0, body.length - bodyRows))
  const selected = disabled ? 1 : active?.selectedIndex === 0 ? 0 : remember && active?.selectedIndex === 2 ? 2 : 1
  const allow = `${selected === 0 ? '›' : ' '} 1 Allow once${disabled ? ' [disabled]' : ''}`
  const reject = `${selected === 1 ? '›' : ' '} 2 Reject`
  const actionSegments: ConversationStyledSegment[] = [
    { text: allow, tone: disabled ? 'muted' : selected === 0 ? 'accent' : 'primary', bold: selected === 0 },
    { text: '   ', tone: 'muted' },
    { text: reject, tone: selected === 1 ? 'warning' : 'primary', bold: selected === 1 },
  ]
  const sessionAction: ConversationStyledSegment = {
    text: (selected === 2 ? '›' : ' ') + ' 3 Allow for session' + (disabled ? ' [disabled]' : ''),
    tone: disabled ? 'muted' : selected === 2 ? 'accent' : 'primary', bold: selected === 2,
  }
  if (remember && actionRows === 1) actionSegments.push({ text: '   ', tone: 'muted' }, sessionAction)
  const header = disabled ? '─ ' + queue + ' · ' + (evidenceError === undefined ? 'Terminal too small' : 'Incomplete evidence') + ' · Allow disabled'
    : '─ Allow ' + escaped(item.toolName) + '? · ' + access + ' · ' + queue
  const range = `${offset + 1}-${Math.min(body.length, offset + bodyRows)}/${body.length}`
  const footer = 'Esc reject · ←→ choose · Enter · Ctrl+O ' + (active?.detailsExpanded === true ? 'less' : 'details') + ' · ↑↓ ' + range + (truncated ? ' · truncated' : '')
  return dock([
    styled(header, width, disabled ? 'warning' : 'interaction', true),
    ...body.slice(offset, offset + bodyRows),
    ...Array.from({ length: Math.max(0, bodyRows - body.length) }, () => styled('', width, 'primary')),
    { segments: actionSegments },
    ...(remember && actionRows === 2 ? [{ segments: [sessionAction] }] : []),
    styled(footer, width, 'muted'),
  ], disabled, { offset, maxOffset: Math.max(0, body.length - bodyRows) })
}
