import { describe, expect, it } from 'vitest'
import { legacyDirectorySelectionAction, legacyListInput, navigateLegacyDirectory, type LegacyDirectoryState } from '../src/navigation/legacy-directory.ts'
import type { TerminalInputAction } from '../src/terminal/input.ts'

describe('legacy catalog keyboard navigation', () => {
  it('only forwards selection, cancellation and editor actions to catalog reducers', () => {
    for (const type of ['move-up', 'move-down', 'submit'] as const) expect(legacyDirectorySelectionAction({ type })).toEqual({ type })
    for (const type of ['escape', 'interrupt'] as const) expect(legacyDirectorySelectionAction({ type })).toEqual({ type: 'escape' })
    expect(legacyDirectorySelectionAction({ type: 'insert', text: 'query' })).toEqual({ type: 'edit', action: { type: 'insert', text: 'query' } })
    expect(legacyDirectorySelectionAction({ type: 'ignored' })).toBeUndefined()
  })
  it('maps list-only vim keys while preserving shortcuts, paste and non-text input', () => {
    for (const [text, type] of [['j', 'move-down'], ['k', 'move-up'], ['h', 'move-left'], ['l', 'move-right']] as const) {
      expect(legacyListInput({ type: 'insert', text })).toEqual({ type })
    }
    for (const action of [{ type: 'submit' }, { type: 'insert', text: 'K' }, { type: 'insert', text: 'k', paste: true }] as const) {
      expect(legacyListInput(action)).toBe(action)
    }
  })

  it('pages and clamps detail scrolling before moving back from the end', () => {
    const details: LegacyDirectoryState = { navigation: { focus: 'details', detailOffset: 100 } }
    expect(navigateLegacyDirectory(details, { type: 'move-up' }, { maxDetailOffset: 20 }).navigation.detailOffset).toBe(19)
    expect(navigateLegacyDirectory(details, { type: 'page-down' }, { maxDetailOffset: 20, pageSize: 6 }).navigation.detailOffset).toBe(20)
    expect(navigateLegacyDirectory({ navigation: { focus: 'details', detailOffset: 12 } }, { type: 'page-up' }).navigation.detailOffset).toBe(2)
    expect(navigateLegacyDirectory({ navigation: { focus: 'details', detailOffset: 0 } }, { type: 'page-down' }, { pageSize: 5 }).navigation.detailOffset).toBe(5)
    expect(navigateLegacyDirectory({}, { type: 'page-up' }).action).toEqual({ type: 'page-up' })
  })
  it('starts on the list, navigates without editing text, and switches regions in both directions', () => {
    expect(navigateLegacyDirectory({}, { type: 'insert', text: 'j' })).toMatchObject({ navigation: { focus: 'list' }, action: { type: 'move-down' } })
    expect(navigateLegacyDirectory({}, { type: 'insert', text: 'k' }).action).toEqual({ type: 'move-up' })
    expect(navigateLegacyDirectory({}, { type: 'insert', text: 'l' }).navigation.focus).toBe('details')
    const details: LegacyDirectoryState = { navigation: { focus: 'details', detailOffset: 5 } }
    expect(navigateLegacyDirectory(details, { type: 'insert', text: 'h' }).navigation.focus).toBe('list')
    expect(navigateLegacyDirectory({}, { type: 'complete' }).navigation.focus).toBe('details')
    expect(navigateLegacyDirectory({}, { type: 'complete', reverse: true }).navigation.focus).toBe('search')
    expect(navigateLegacyDirectory(details, { type: 'complete', reverse: true }).navigation.focus).toBe('list')
  })

  it('enters search explicitly, preserves hjkl as text there, and applies search without picking', () => {
    for (const text of ['/', 'i']) {
      const search = navigateLegacyDirectory({}, { type: 'insert', text })
      expect(search.navigation.focus).toBe('search')
      expect(search.action).toBeUndefined()
      expect(navigateLegacyDirectory(search, { type: 'insert', text: 'hjkl' }).action).toEqual({ type: 'insert', text: 'hjkl' })
      const submitted = navigateLegacyDirectory(search, { type: 'submit' })
      expect(submitted.navigation.focus).toBe('list')
      expect(submitted.action).toBeUndefined()
    }
    for (const text of ['unbound', 'constructor', '/']) {
      expect(navigateLegacyDirectory({}, { type: 'insert', text, paste: true }).action).toBeUndefined()
    }
    expect(navigateLegacyDirectory({}, { type: 'insert', text: 'constructor' }).action).toBeUndefined()
  })

  it('scrolls details independently and resets the offset when list selection moves', () => {
    const details: LegacyDirectoryState = { navigation: { focus: 'details', detailOffset: 0 } }
    expect(navigateLegacyDirectory(details, { type: 'move-up' }).navigation.detailOffset).toBe(0)
    const moved = navigateLegacyDirectory(details, { type: 'move-down' })
    expect(moved.navigation.detailOffset).toBe(1)
    expect(moved.action).toBeUndefined()
    expect(navigateLegacyDirectory(moved, { type: 'move-up' }).navigation.detailOffset).toBe(0)
    expect(navigateLegacyDirectory({ navigation: { focus: 'list', detailOffset: 20 } }, { type: 'move-down' }).navigation.detailOffset).toBe(0)
  })

  it('forwards a single Escape from every region and ignores editing keys in Normal', () => {
    for (const focus of ['list', 'details', 'search'] as const) {
      for (const type of ['escape', 'interrupt'] as const) {
        expect(navigateLegacyDirectory({ navigation: { focus, detailOffset: 0 } }, { type }).action).toEqual({ type })
      }
    }
    for (const type of ['backspace', 'delete', 'ignored', 'move-home', 'move-end', 'save-default'] as const) {
      expect(navigateLegacyDirectory({}, { type }).action).toBeUndefined()
    }
    const submit: TerminalInputAction = { type: 'submit' }
    expect(navigateLegacyDirectory({}, submit).action).toBe(submit)
  })

  it('cycles only real regions in catalogs without search', () => {
    const options = { searchEnabled: false }
    expect(navigateLegacyDirectory({}, { type: 'complete', reverse: true }, options).navigation.focus).toBe('details')
    expect(navigateLegacyDirectory({ navigation: { focus: 'details', detailOffset: 0 } }, { type: 'complete' }, options).navigation.focus).toBe('list')
    for (const text of ['/', 'i']) {
      expect(navigateLegacyDirectory({}, { type: 'insert', text }, options)).toEqual({ navigation: { focus: 'list', detailOffset: 0 } })
    }
  })
})
