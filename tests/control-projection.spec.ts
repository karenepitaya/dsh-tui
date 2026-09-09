import { describe, expect, it } from 'vitest'
import { buttonSegment, choiceText } from '../src/presentation/control-projection.ts'

describe('shared controls in plain-text frame hosts', () => {
  it('keeps action intent and focus separate from disabled and busy state', () => {
    expect(buttonSegment({ label: 'Delete', focused: true, intent: 'danger' }))
      .toEqual({ text: '› Delete', tone: 'error', bold: true })
    expect(buttonSegment({ label: 'Save', intent: 'primary' }).tone).toBe('accent')
    expect(buttonSegment({ label: 'Cancel', focused: true }))
      .toEqual({ text: '› Cancel', tone: 'accent', bold: true })
    expect(buttonSegment({ label: 'Cancel' }))
      .toEqual({ text: '  Cancel', tone: 'primary', bold: false })
    expect(buttonSegment({ label: 'Delete', focused: true, intent: 'danger', disabled: true }))
      .toMatchObject({ tone: 'muted', bold: false })
    expect(buttonSegment({ label: 'Save', intent: 'primary', busy: true }))
      .toMatchObject({ tone: 'muted', bold: false })
  })

  it('shares radio and multi-select marks without leaking terminal sequences', () => {
    expect(choiceText('模型', true)).toBe('› 模型')
    expect(choiceText('模型', false, { checked: true, kind: 'radio' })).toBe('  ◉ 模型')
    expect(choiceText('模型', true, { checked: false, kind: 'radio' })).toBe('› ○ 模型')
    expect(choiceText('工具', true, { checked: true, kind: 'multi' })).toBe('› ☑ 工具')
    expect(choiceText('工具', false, { checked: false, kind: 'multi' })).toBe('  ☐ 工具')
    const text = choiceText('\x1b[31m模型\x1b[0m\n名称', true, { badge: '\x1b[32m已配置', tone: 'success' })
    expect(text).toBe('› 模型 名称 已配置')
    expect(text).not.toContain('\x1b')
    expect(buttonSegment({ label: '\x1b[31m允许\x1b[0m', focused: true }).text).toBe('› 允许')
  })
})
