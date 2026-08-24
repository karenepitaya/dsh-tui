import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  Config,
  DshTuiRuntimeService,
  OpenDshTuiSessionOptions,
} from '../src/index.ts'

describe('package root public API', () => {
  it('exports only the Cordis plugin entrypoints at runtime', async () => {
    const api = await import('../src/index.ts')

    expect(Object.keys(api).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
    expect('default' in api).toBe(false)
    expect(api.Config).toBeDefined()
  })

  it('keeps the owner service contracts available as types', () => {
    expectTypeOf<Config>().not.toBeAny()
    expectTypeOf<DshTuiRuntimeService>().not.toBeAny()
    expectTypeOf<OpenDshTuiSessionOptions>().not.toBeAny()
  })
})
