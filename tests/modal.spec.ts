import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  secondaryModalContent,
  secondaryModalRow,
  secondaryModalRule,
  secondaryModalSplit,
  secondaryModalStyle,
  secondaryModalTriple,
} from '../src/ui/modal.ts'

describe('secondary modal primitives', () => {
  it('creates an opaque full-row style with optional emphasis', () => {
    expect(secondaryModalStyle('primary')).toEqual({
      tone: 'primary', background: 'black', fill: true,
    })
    expect(secondaryModalStyle('accent', {
      bold: true,
      dim: true,
      selected: true,
    })).toEqual({
      tone: 'accent',
      background: 'black',
      fill: true,
      bold: true,
      dim: true,
      inverse: true,
    })
    const row = secondaryModalRow('selected', 'accent', { selected: true })
    expect(row).toEqual({
      text: 'selected',
      style: {
        tone: 'accent', background: 'black', fill: true, inverse: true,
      },
    })
    expect(Object.isFrozen(row)).toBe(true)
  })

  it('bounds and sanitizes rules and content at every edge', () => {
    expect(secondaryModalRule('X', 1, 'top')).toBe('X')
    expect(secondaryModalRule('Title\x1b[2J', 20, 'top', 'esc')).toBe(
      '╭─ Title ──── esc ─╮',
    )
    expect(secondaryModalRule('Stage', 20, 'middle')).toBe(
      '├─ Stage ──────────┤',
    )
    expect(secondaryModalRule('', 20, 'bottom')).toBe(
      '╰──────────────────╯',
    )
    expect(secondaryModalContent('abcdef', 2)).toBe('ab')
    const content = secondaryModalContent('A\nB\u0000', 10)
    expect(content).toBe('│A↵B�    │')
    expect(visibleWidth(content)).toBe(10)
  })

  it('builds fixed-width two- and three-pane rows without overflow', () => {
    expect(secondaryModalSplit('left', 'right', 3, 1)).toBe('lef')
    expect(secondaryModalSplit('left', 'right', 4, 1)).toBe('left')
    const split = secondaryModalSplit('left', 'right', 20, 7)
    expect(split).toBe('│left   │right     │')
    expect(visibleWidth(split)).toBe(20)
    const boundedSplit = secondaryModalSplit('left', 'right', 10, 99)
    expect(visibleWidth(boundedSplit)).toBe(10)

    expect(secondaryModalTriple('one', 'two', 'three', 5, 1, 1)).toBe('one')
    const triple = secondaryModalTriple('one', 'two', 'three', 24, 5, 7)
    expect(triple).toBe('│one  │two    │three   │')
    expect(visibleWidth(triple)).toBe(24)
    const boundedTriple = secondaryModalTriple('one', 'two', 'three', 10, 99, 99)
    expect(visibleWidth(boundedTriple)).toBe(10)
  })
})
