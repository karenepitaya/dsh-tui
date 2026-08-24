import { describe, expect, it } from 'vitest'
import { WakeQueue } from '../src/runtime/wake-queue.ts'

describe('WakeQueue', () => {
  it('conflates any backlog to one pending wake and drains it before close', async () => {
    const queue = new WakeQueue()
    queue.wake()
    queue.wake()
    expect(queue.pendingCount).toBe(1)
    queue.close()
    queue.close()
    queue.wake()
    await expect(queue.next()).resolves.toEqual({ done: false, value: undefined })
    expect(queue.pendingCount).toBe(0)
    await expect(queue.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('wakes or closes a waiting consumer directly', async () => {
    const awake = new WakeQueue()
    const waiting = awake.next()
    awake.wake()
    await expect(waiting).resolves.toEqual({ done: false, value: undefined })

    const closed = new WakeQueue()
    const ending = closed.next()
    closed.close()
    await expect(ending).resolves.toEqual({ done: true, value: undefined })
  })
})
