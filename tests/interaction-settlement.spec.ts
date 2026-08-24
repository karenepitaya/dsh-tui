import { describe, expect, it } from 'vitest'
import {
  InteractionSettlement,
  InteractionSettlementError,
} from '../src/internal.ts'

type Outcome =
  | { readonly kind: 'answered'; readonly value: string }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'disposed' }

const aborted: Outcome = { kind: 'aborted' }
const disposed: Outcome = { kind: 'disposed' }

function registry(): InteractionSettlement<Outcome> {
  return new InteractionSettlement({ aborted, disposed })
}

describe('InteractionSettlement', () => {
  it('settles an answer exactly once without retaining historical ids', async () => {
    const interactions = registry()
    const pending = interactions.open('q1')
    expect(interactions.pendingCount).toBe(1)
    expect(interactions.resolve('q1', { kind: 'answered', value: 'yes' })).toBe(true)
    await expect(pending).resolves.toEqual({ kind: 'answered', value: 'yes' })
    expect(interactions.pendingCount).toBe(0)
    expect(interactions.resolve('q1', { kind: 'answered', value: 'late' })).toBe(false)
    expect(interactions.abort('q1')).toBe(false)
    const reused = interactions.open('q1')
    interactions.abort('q1')
    await expect(reused).resolves.toEqual(aborted)
  })

  it('isolates concurrent ids and treats unknown ids as not pending', async () => {
    const interactions = registry()
    const first = interactions.open('q1')
    const second = interactions.open('q2')
    expect(() => interactions.open('q2')).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_ID' }),
    )
    expect(interactions.resolve('missing', aborted)).toBe(false)
    expect(interactions.abort('missing')).toBe(false)

    interactions.resolve('q2', { kind: 'answered', value: 'two' })
    interactions.abort('q1')
    await expect(first).resolves.toEqual(aborted)
    await expect(second).resolves.toEqual({ kind: 'answered', value: 'two' })
  })

  it('lets AbortSignal win and discards a late answer', async () => {
    const interactions = registry()
    const controller = new AbortController()
    const pending = interactions.open('approval', controller.signal)
    controller.abort()
    await expect(pending).resolves.toEqual(aborted)
    expect(interactions.resolve('approval', { kind: 'answered', value: 'grant' })).toBe(false)

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(interactions.open('pre-aborted', alreadyAborted.signal)).resolves.toEqual(aborted)
  })

  it('settles every pending request on disposal and refuses new work', async () => {
    const interactions = registry()
    const first = interactions.open('q1')
    const second = interactions.open('a1')
    interactions.dispose()
    interactions.dispose()

    await expect(first).resolves.toEqual(disposed)
    await expect(second).resolves.toEqual(disposed)
    expect(interactions.pendingCount).toBe(0)
    expect(() => interactions.open('late')).toThrowError(
      expect.objectContaining({ code: 'REGISTRY_DISPOSED' }),
    )
  })

  it('exposes a stable typed error', () => {
    const error = new InteractionSettlementError('bad', 'DUPLICATE_ID')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('InteractionSettlementError')
    expect(error.message).toBe('bad')
    expect(error.code).toBe('DUPLICATE_ID')
  })
})
