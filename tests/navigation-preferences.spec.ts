import { describe, expect, it } from 'vitest'
import { acceptsNavigationKey } from '../src/navigation/preferences.ts'

describe('navigation preferences', () => {
  it('filters only unmodified Normal-mode direction keys', () => {
    expect(acceptsNavigationKey({ type: 'text', text: 'j' }, 'normal', 'arrows')).toBe(false)
    expect(acceptsNavigationKey({ type: 'text', text: 'i' }, 'normal', 'arrows')).toBe(true)
    expect(acceptsNavigationKey({ type: 'named', key: 'down' }, 'normal', 'arrows')).toBe(true)
    expect(acceptsNavigationKey({ type: 'named', key: 'down' }, 'normal', 'vim')).toBe(false)
    expect(acceptsNavigationKey({ type: 'named', key: 'enter' }, 'normal', 'vim')).toBe(true)
    expect(acceptsNavigationKey({ type: 'text', text: 'j' }, 'normal', 'vim')).toBe(true)
    expect(acceptsNavigationKey({ type: 'text', text: 'j' }, 'insert', 'arrows')).toBe(true)
    expect(acceptsNavigationKey({ type: 'text', text: 'j' }, 'normal', 'both')).toBe(true)
    expect(acceptsNavigationKey({ type: 'text', text: 'j', ctrl: true }, 'normal', 'arrows')).toBe(true)
    expect(acceptsNavigationKey({ type: 'text', text: 'j', alt: true }, 'normal', 'arrows')).toBe(true)
    expect(acceptsNavigationKey({ type: 'text', text: 'j', shift: true }, 'normal', 'arrows')).toBe(true)
    expect(acceptsNavigationKey({ type: 'paste', text: 'hjkl' }, 'normal', 'vim')).toBe(true)
  })
})
