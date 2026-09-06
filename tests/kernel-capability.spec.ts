import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createCapabilityToken,
  type CapabilityFactory,
  type CapabilityLease,
  type CapabilityScope,
  type CapabilityToken,
} from '../src/kernel/capability.ts'

interface Clock {
  now(): number
}

describe('capability contracts', () => {
  it('preserves value type and scope from token through factory and lease', async () => {
    const token = createCapabilityToken<Clock>('runtime.clock/v1', 'application')
    let released = false
    const factory: CapabilityFactory<Clock, { readonly epoch: number }> = {
      token,
      create: ({ epoch }) => ({
        value: { now: () => epoch },
        release: () => {
          released = true
        },
      }),
    }

    const lease = await factory.create({ epoch: 42 })

    expectTypeOf(token).toEqualTypeOf<CapabilityToken<Clock>>()
    expectTypeOf(lease).toEqualTypeOf<CapabilityLease<Clock>>()
    expect(token).toEqual({ id: 'runtime.clock/v1', scope: 'application' })
    expect(Object.isFrozen(token)).toBe(true)
    expect(lease.value.now()).toBe(42)
    await lease.release()
    expect(released).toBe(true)
  })

  it('rejects malformed versioned ids and scopes at runtime', () => {
    for (const id of ['', 'runtime.clock', 'runtime clock/v1', 'runtime.clock/v01']) {
      expect(() => createCapabilityToken(id as `${string}/v${number}`, 'session')).toThrowError(
        'Capability id must match <name>/v<number> without whitespace',
      )
    }
    expect(() => createCapabilityToken(
      'runtime.clock/v1',
      'request' as CapabilityScope,
    )).toThrowError('Capability scope must be application or session')
  })
})
