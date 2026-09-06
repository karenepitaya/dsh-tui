import { describe, expect, it, vi } from 'vitest'
import { createUnavailableDshCommandPort } from '../src/command/port.ts'

describe('unavailable DSH command port', () => {
  it('keeps every optional command operation inert', async () => {
    const port = createUnavailableDshCommandPort()
    const changed = vi.fn()
    const stop = port.onCommandsChanged(changed)

    expect(port.listCommands()).toEqual([])
    expect(port.parseCommand('/models')).toBeUndefined()
    await expect(port.executeCommand(
      '/models',
      new AbortController().signal,
    )).resolves.toBeUndefined()
    expect(stop()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
    expect(port.disposeCommands()).toBeUndefined()
  })
})
