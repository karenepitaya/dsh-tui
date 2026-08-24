import { describe, expect, it } from 'vitest'
import { LatestValueQueue } from '../src/interaction/latest-value-queue.ts'

describe('LatestValueQueue', () => {
  it('conflates backlog, drains its newest value, and ignores writes after close', async () => {
    const queue = new LatestValueQueue<number>()
    queue.push(1)
    queue.push(2)
    queue.close()
    queue.close()
    queue.push(3)
    await expect(queue.next()).resolves.toEqual({ done: false, value: 2 })
    await expect(queue.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('delivers directly to a waiting consumer', async () => {
    const queue = new LatestValueQueue<number>()
    const waiting = queue.next()
    queue.push(4)
    await expect(waiting).resolves.toEqual({ done: false, value: 4 })
  })

  it('closes a waiting consumer', async () => {
    const queue = new LatestValueQueue<number>()
    const waiting = queue.next()
    queue.close()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
  })
})
