import { describe, expect, it } from 'vitest'
import { ThemeBinding } from '../src/ui/theme-binding.ts'
import { createDshTuiTheme, type DshTuiTheme } from '../src/ui/theme.ts'

describe('retained theme binding', () => {
  it('keeps a stable reference while forwarding every style to the new palette', () => {
    const capabilities = { colorSupported: true, noColor: false, dumbTerminal: false, colorLevel: 'truecolor' as const }
    const binding = new ThemeBinding(createDshTuiTheme({ preset: 'mono' }, capabilities))
    const handle = binding.value
    const next = createDshTuiTheme({ colors: { accent: 'red' } }, capabilities)
    binding.update(next)
    expect(binding.value).toBe(handle)
    for (const key of ['preset', 'colorEnabled', 'styleEnabled', 'colorLevel', 'semantic', 'colors'] as const) expect(handle[key]).toBe(next[key])
    for (const key of ['bold', 'dim', 'inverse', 'italic', 'underline'] as const satisfies readonly (keyof DshTuiTheme)[]) expect(handle[key]('text')).toBe(next[key]('text'))
    expect(handle.paint('accent', 'text')).toBe(next.paint('accent', 'text'))
    expect(handle.paintBackground('userBarBackground', 'text')).toBe(next.paintBackground('userBarBackground', 'text'))
    expect(handle.background('red', 'text')).toBe(next.background('red', 'text'))
  })
})
