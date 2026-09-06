import { describe, expect, it } from 'vitest'
import {
  createSessionBinding,
  type DshTuiSessionLease,
} from '../src/session/binding.ts'

describe('SessionBinding', () => {
  it('isolates same-id lifecycles by exact object and monotonic epoch', () => {
    const firstPort = { sessionId: 'same-session' } as DshTuiSessionLease
    const secondPort = { sessionId: 'same-session' } as DshTuiSessionLease
    const first = createSessionBinding(7, firstPort, 'current', async () => {})
    const second = createSessionBinding(8, secondPort, 'candidate', async () => {})

    first.prompt = { text: 'source draft', cursor: 12 }
    first.commandNotice = 'source notice'
    first.transcriptViewMode = 'verbose'

    expect(first).not.toBe(second)
    expect(first.epoch).toBe(7)
    expect(second.epoch).toBe(8)
    expect(first.port).toBe(firstPort)
    expect(second.port).toBe(secondPort)
    expect(first.ui.activeSessionId).toBe('same-session')
    expect(second.ui.activeSessionId).toBe('same-session')
    expect(second.prompt).toEqual({ text: '', cursor: 0 })
    expect(second.commandNotice).toBeUndefined()
    expect(first.transcriptViewMode).toBe('verbose')
    expect(second.transcriptViewMode).toBe('compact')
  })
})
