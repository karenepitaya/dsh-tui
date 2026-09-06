import type { PermissionPickerRow, PermissionPickerView } from '../permission/picker.ts'
import type { PermissionPolicy } from '../permission/port.ts'
import { approvalPolicyDescription } from '../permission/policy.ts'
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from '../terminal/text-layout.ts'
import type { TerminalViewport, UiFrame } from './frame.ts'
import { focusedWindowStart, secondaryModalFrame } from './workspace-rows.ts'
import type { DshTuiSemanticRole } from './theme.ts'
import type { LegacyDirectoryFrame } from './workspace-capability.ts'
import {
  secondaryModalFill,
  secondaryModalHeader,
  secondaryModalPair,
  secondaryModalRow,
  secondaryModalSection,
  secondaryModalSplit,
  type SecondaryModalRow,
} from './modal.ts'

function inline(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?|\n/gu, '↵')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '�')
}

function rowsOf(text: string, columns: number, tone: DshTuiSemanticRole = 'muted'): SecondaryModalRow[] {
  return wrapTextWithAnsi(inline(text), Math.max(1, columns - 4))
    .map(line => secondaryModalRow(secondaryModalFill(`  ${line}`, columns), tone))
}

function policyRows(current: PermissionPolicy | undefined, target: PermissionPolicy | undefined, columns: number): SecondaryModalRow[] {
  if (current === undefined || target === undefined) {
    return rowsOf('Policy metadata unavailable · inspection only', columns, 'warning')
  }
  return [
    ...rowsOf(`Sandbox  ${current.sandboxMode} → ${target.sandboxMode}`, columns, 'telemetry'),
    ...rowsOf(`Approval  ${current.approvalPolicy} → ${target.approvalPolicy}`, columns, 'telemetry'),
    ...rowsOf(approvalPolicyDescription(target.approvalPolicy), columns),
    ...(current.approvalPolicy === target.approvalPolicy ? [] : rowsOf(approvalPolicyDescription(current.approvalPolicy), columns)),
  ]
}

const CANCEL_LABEL = 'Cancel · keep current permissions'
const CONFIRM_LABEL = 'Confirm change · apply official preset'

/** Shared by the short confirmation renderer and its input gate. */
export function permissionConfirmationLayout(view: PermissionPickerView, viewport: TerminalViewport): {
  readonly body: readonly SecondaryModalRow[]
  readonly canInspect: boolean
} {
  const confirmation = view.confirmation!
  const { columns, rows } = viewport
  const body = [
    ...rowsOf('Confirm permission change · Default: Cancel', columns, 'warning'),
    ...policyRows(confirmation.currentPermission, confirmation.targetPermission, columns),
    ...rowsOf('This widens session permissions. Only this official preset is applied.', columns, 'warning'),
  ]
  const railWidth = visibleWidth(`  Current  ${inline(confirmation.fromValue)}`)
    + visibleWidth(`Target  ${inline(confirmation.toValue)}`) + 2
  const actionWidth = Math.max(visibleWidth(`› ${CANCEL_LABEL}`), visibleWidth(`› ${CONFIRM_LABEL}`))
  return { body, canInspect: columns >= Math.max(railWidth, actionWidth) && rows >= body.length + 5 }
}

function presetRow(row: PermissionPickerRow, selected: boolean, columns: number): SecondaryModalRow {
  const badge = !row.selectable ? 'current only' : row.isCurrent ? 'current' : selected ? 'candidate' : ''
  return secondaryModalRow(secondaryModalPair(
    `${selected ? '›' : ' '}  ${inline(row.name)}`, badge, columns,
  ), selected ? 'accent' : row.isCurrent ? 'success' : !row.selectable ? 'warning' : 'primary', {
    bold: selected || row.isCurrent, selected,
  })
}

function complete(viewport: TerminalViewport, rows: readonly SecondaryModalRow[]): UiFrame {
  return {
    title: 'DSH-TUI', viewport,
    lines: rows.map(row => row.text), lineStyles: rows.map(row => row.style),
  }
}

/** Official preset policy facts and explicit widening confirmation; never grants authority. */
export function renderPermissionWorkspace(
  view: PermissionPickerView,
  viewport: TerminalViewport,
  notice?: string,
): LegacyDirectoryFrame {
  const { columns, rows } = viewport
  const header = secondaryModalRow(secondaryModalHeader('Session permissions', columns), 'accent', { bold: true })
  if (rows === 1) return complete(viewport, [header])
  const selected = view.rows[view.selectedIndex]
  const confirmation = view.confirmation
  const current = confirmation?.fromValue ?? view.currentValue ?? 'unknown'
  const target = confirmation?.toValue ?? selected?.value ?? 'none'
  const currentPolicy = confirmation?.currentPermission ?? view.currentPermission
  const targetPolicy = confirmation?.targetPermission ?? selected?.permission
  const rail = secondaryModalRow(secondaryModalPair(
    `  Current  ${inline(current)}`, `Target  ${inline(target)}`, columns,
  ), 'telemetry', { bold: true })
  const state = !view.available ? 'Unavailable' : view.stale ? 'Stale' : view.selecting ? 'Applying'
    : !view.writable ? 'Read only' : currentPolicy === undefined || targetPolicy === undefined ? 'Missing policy facts' : 'Ready'
  const writable = view.available && view.writable && !view.stale && !view.selecting
    && currentPolicy !== undefined && targetPolicy !== undefined && selected?.selectable === true
  const status = [
    ...(view.error === undefined ? [] : rowsOf(`Error: ${view.error}`, columns, 'error')),
    ...(view.selecting ? rowsOf('Applying the official /permission command…', columns) : []),
    ...(view.stale ? rowsOf('Projection changed · showing the last known policy', columns, 'warning') : []),
    ...(notice === undefined ? [] : rowsOf(`Notice: ${notice}`, columns, 'warning')),
    ...(!view.available ? rowsOf('Permission presets are unavailable', columns, 'warning') : []),
    ...(view.available && !view.writable ? rowsOf('Official write command unavailable · inspection only', columns, 'warning') : []),
  ]
  const fill = (count: number): SecondaryModalRow[] => Array.from({ length: count }, () => (
    secondaryModalRow(secondaryModalFill('', columns), 'primary')
  ))

  if (confirmation !== undefined) {
    const layout = permissionConfirmationLayout(view, viewport)
    const cancel = confirmation.selectedIndex === 0
    const compactChoice = secondaryModalRow(secondaryModalFill(
      `${cancel ? '›' : ' '} Cancel    ${cancel ? ' ' : '›'} Confirm change${layout.canInspect ? '' : ' [disabled]'}`, columns,
    ), 'interaction', { selected: true })
    const footer = secondaryModalRow(secondaryModalPair(
      !layout.canInspect ? '  Terminal too small · change blocked'
        : writable ? `  ←→ choose · Enter ${cancel ? 'Cancel' : 'Confirm'}` : '  Inspection only · change blocked', 'Esc back', columns,
    ), 'muted')
    if (rows === 2) return complete(viewport, [header, compactChoice])
    if (rows === 3) return complete(viewport, [header, compactChoice, footer])
    if (rows === 4) return complete(viewport, [header, rail, compactChoice, footer])
    const choices = [
      secondaryModalRow(secondaryModalFill(`${cancel ? '›' : ' '} ${CANCEL_LABEL}`, columns), 'interaction', { selected: cancel }),
      secondaryModalRow(secondaryModalFill(`${cancel ? ' ' : '›'} ${CONFIRM_LABEL}${layout.canInspect ? '' : ' [disabled]'}`, columns), 'warning', { selected: !cancel }),
    ]
    const body = [
      ...layout.body,
      ...status,
    ].slice(0, rows - 5)
    return complete(viewport, [header, rail, ...body, ...fill(rows - 5 - body.length), ...choices, footer])
  }

  if (rows === 2) return complete(viewport, [header, rail])
  const focus = view.navigation?.focus ?? 'list'
  const footer = secondaryModalRow(secondaryModalPair(
    `  j/k ↑↓ move · ${writable ? 'Enter review/apply' : 'Inspection only'} · Focus: ${focus} · Tab/⇧Tab h/l regions`, 'Esc back', columns,
  ), 'muted')
  if (rows === 3) return complete(viewport, [header, rail, footer])
  const split = columns >= 100
  const leftColumns = Math.min(38, Math.floor(columns * 0.32))
  const detailColumns = split ? Math.max(1, columns - leftColumns - 3) : columns
  const bodySlots = rows - 4
  const detail = [
    secondaryModalRow(secondaryModalFill(writable ? 'Selection · official preset' : 'Selection · inspection only', detailColumns), 'interaction', { bold: true }),
    ...policyRows(currentPolicy, targetPolicy, detailColumns),
    ...(selected?.description === undefined ? [] : rowsOf(`Preset description: ${selected.description}`, detailColumns)),
    ...status.flatMap(row => rowsOf(row.text.replace(/^[│ ]+|[│ ]+$/gu, ''), detailColumns, row.style.tone)),
  ]
  const detailOffset = Math.max(0, Math.min(view.navigation?.detailOffset ?? 0, detail.length - bodySlots))
  const range = detail.length > bodySlots ? ` · Detail ${detailOffset + 1}–${Math.min(detail.length, detailOffset + bodySlots)}/${detail.length}` : ''
  const section = secondaryModalRow(secondaryModalSection('Policies', columns, `${view.totalCount} · ${state}${range}`), 'interaction', { bold: true })
  const start = focusedWindowStart(view.rows.length, view.selectedIndex, bodySlots)
  const body = Array.from({ length: bodySlots }, (_, index) => {
    const item = view.rows[start + index]
    const selectedItem = item !== undefined && start + index === view.selectedIndex
    const entry = item === undefined ? undefined : presetRow(item, selectedItem, split ? leftColumns : columns)
    const line = detail[detailOffset + index]
    const plain = (row: SecondaryModalRow | undefined): string => row?.text.replace(/^[│]|[│]$/gu, '').trimEnd() ?? ''
    if (split) return secondaryModalRow(secondaryModalSplit(entry === undefined && index === 0 && view.rows.length === 0 ? 'No permission profiles found' : plain(entry), plain(line), columns, leftColumns),
      line?.style.tone === 'error' ? 'error' : selectedItem ? 'accent' : line?.style.tone ?? 'primary', { selected: selectedItem })
    if (focus === 'details') return line ?? secondaryModalRow(secondaryModalFill('', columns), 'primary')
    return entry ?? secondaryModalRow(secondaryModalFill(index === 0 && view.rows.length === 0 ? 'No permission profiles found' : '', columns), 'primary')
  })
  return { ...secondaryModalFrame(viewport, [header, rail, section, ...body, footer], undefined, split ? leftColumns : undefined),
    detailMaxOffset: Math.max(0, detail.length - bodySlots) }
}
