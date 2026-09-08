import { describe, expect, it } from 'vitest'
import { visibleWidth } from '../src/terminal/text-layout.ts'
import type { PermissionPickerView } from '../src/permission/picker.ts'
import { renderPermissionWorkspace } from '../src/ui/permission-workspace.ts'

const view: PermissionPickerView = {
  available: true, writable: true, stale: false, selecting: false, generation: 1,
  offset: 0, totalCount: 3, selectedIndex: 1, selectedValue: 'wide', currentValue: 'work',
  currentPermission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
  rows: [
    { value: 'work', name: 'Workspace', isCurrent: true, selectable: true,
      permission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' } },
    { value: 'wide', name: 'Full access', isCurrent: false, selectable: true,
      permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' } },
    { value: 'custom', name: 'Custom', isCurrent: false, selectable: false },
  ],
}

function render(input = view, viewport = { columns: 120, rows: 20 }, notice?: string) {
  return renderPermissionWorkspace(input, viewport, notice)
}

describe('permission policy workspace', () => {
  it('reaches long preset descriptions in the single active detail region and retains error tone in wide layout', () => {
    const viewport = { columns: 78, rows: 10 }
    const described = { ...view, rows: view.rows.map(row => ({ ...row, description: `${'policy explanation '.repeat(100)}END_OF_PRESET` })), navigation: { focus: 'details' as const, detailOffset: 0 } }
    const first = render(described, viewport)
    expect(first.detailMaxOffset).toBeGreaterThan(0)
    expect(first.lines.join('\n')).not.toContain('END_OF_PRESET')
    const last = render({ ...described, navigation: { focus: 'details', detailOffset: first.detailMaxOffset! } }, viewport)
    expect(last.lines.join('\n')).toContain('END_OF_PRESET')
    expect(last.lines.join('\n')).not.toContain('Custom')
    expect(render({ ...view, navigation: { focus: 'details', detailOffset: 999 } }, { columns: 78, rows: 30 }).lines).toHaveLength(30)
    const error = render({ ...view, error: 'policy source failed' })
    const index = error.lines.findIndex(line => line.includes('policy source failed'))
    expect(index).toBeGreaterThan(0)
    expect(error.lineStyles?.[index]?.tone).toBe('error')
  })
  it('shows actual current/target policy and never as automatic rejection, not auto-approval', () => {
    const frame = render()
    const output = frame.lines.join('\n')
    expect(output).toContain('Current  work')
    expect(output).toContain('Target  wide')
    expect(output).toContain('workspace-write → danger-full-access')
    expect(output).toContain('ask → never')
    expect(output).toContain('approval requests are rejected automatically')
    expect(output).toContain('Custom')
    expect(output).not.toContain('auto-approve')
    expect(frame.lineStyles?.every(style => style?.background === 'black')).toBe(true)
  })

  it.each([0, 1] as const)('keeps the explicit widening confirmation and selected choice visible: %s', selectedIndex => {
    const frame = render({ ...view, confirmation: {
      fromValue: 'work', toValue: 'wide', generation: 1,
      currentPermission: view.currentPermission!, targetPermission: view.rows[1]!.permission!,
      selectedIndex,
    } })
    const output = frame.lines.join('\n')
    expect(output).toContain('Confirm permission change')
    expect(output).toContain('workspace-write → danger-full-access')
    expect(output).toContain('ask → never')
    expect(output).toContain('Default: Cancel')
    expect(output).toContain('←→ choose')
    const selectedRow = frame.lines.findIndex(line => line.includes(selectedIndex === 0 ? '› Cancel' : '› Confirm change'))
    expect(selectedRow).toBeGreaterThan(0)
    expect(frame.lineStyles?.[selectedRow]?.inverse).toBe(true)
  })

  it('never invents missing boundaries and keeps custom presets inspection-only', () => {
    const { currentPermission: _omitted, ...missing } = view
    const frame = render({ ...missing, rows: [{ value: 'custom', name: 'Custom', isCurrent: true, selectable: false }], selectedIndex: 0 })
    expect(frame.lines.join('\n')).toContain('Policy metadata unavailable')
    expect(frame.lines.join('\n')).toContain('inspection only')
    expect(frame.lines.join('\n')).not.toContain('Enter apply')
  })

  it('bounds hostile text and every short viewport without hiding the selected preset', () => {
    for (let rows = 1; rows <= 22; rows += 1) {
      for (const columns of [1, 2, 20, 48, 78]) {
        const frame = render({ ...view, error: 'failure\u001b[2J\u0007\nnext', rows: view.rows.map(row => ({ ...row, description: 'wide 界'.repeat(500) })) }, { columns, rows }, 'note\u001b[31m\r\u0000')
        expect(frame.lines.length).toBeLessThanOrEqual(rows)
        for (const line of frame.lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
          expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u)
        }
      }
    }
  })

  it('shows availability, freshness, applying, read-only and empty states without action hints', () => {
    const states = [
      { available: false, label: 'Unavailable' },
      { stale: true, label: 'Stale' },
      { selecting: true, label: 'Applying' },
      { writable: false, label: 'Read only' },
    ]
    for (const { label, ...state } of states) {
      const output = render({ ...view, ...state }).lines.join('\n')
      expect(output).toContain(label)
      expect(output).toContain('inspection only')
      expect(output).not.toContain('Enter apply')
    }
    const { currentValue: _omitted, ...unknown } = view
    const empty = render({ ...unknown, available: false, rows: [], selectedIndex: -1, totalCount: 0 })
    expect(empty.lines.join('\n')).toContain('No permission profiles found')
    expect(empty.lines.join('\n')).toContain('Current  unknown')
    expect(empty.lines.join('\n')).toContain('Target  none')
    expect(render({ ...view, rows: [], selectedIndex: -1, totalCount: 0 }, { columns: 78, rows: 12 })
      .lines.join('\n')).toContain('No permission profiles found')
  })

  it('marks current, candidate, unselected and custom entries separately and keeps list selection in view', () => {
    const rows = [
      view.rows[0]!, view.rows[1]!,
      { value: 'read', name: 'Read only', selectable: true, isCurrent: false,
        permission: { sandboxMode: 'read-only' as const, approvalPolicy: 'ask' as const } },
      view.rows[2]!,
    ]
    for (const selectedIndex of [0, 2, 3]) {
      const frame = render({ ...view, rows, selectedIndex, totalCount: 4 }, { columns: 78, rows: 24 })
      const output = frame.lines.join('\n')
      expect(output).toContain(`›  ${rows[selectedIndex]!.name}`)
      expect(output).toContain('current only')
      expect(output).toContain('Workspace')
    }
    const list = Array.from({ length: 12 }, (_, index) => ({
      value: `preset-${index}`, name: `Preset ${index}`, selectable: true, isCurrent: false,
      permission: view.currentPermission!,
    }))
    expect(render({ ...view, rows: list, selectedIndex: 11, totalCount: 12 }, { columns: 78, rows: 8 })
      .lines.join('\n')).toContain('Preset 11')
  })

  it('preserves explicit cancel/confirm selection in short, stale and read-only confirmation views', () => {
    for (const selectedIndex of [0, 1] as const) {
      for (const rows of [1, 2, 3, 4, 5, 8, 20]) {
        for (const writable of [true, false]) {
          const frame = render({ ...view, writable, confirmation: {
            fromValue: 'work', toValue: 'wide', generation: 1,
            currentPermission: view.currentPermission!, targetPermission: view.rows[1]!.permission!,
            selectedIndex,
          } }, { columns: 78, rows })
          expect(frame.lines).toHaveLength(rows)
          if (rows > 1) expect(frame.lines.join('\n')).toContain(selectedIndex === 0 ? '› Cancel' : '› Confirm change')
          if (rows > 2 && !writable) expect(frame.lines.join('\n')).toContain('change blocked')
        }
      }
    }
  })
})
