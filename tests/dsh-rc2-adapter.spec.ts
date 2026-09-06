import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityRegistrationLease } from '../src/kernel/capability-registry.ts'
import type { DshTuiFeatureService } from '../src/kernel/feature-service.ts'
import type { DshTuiRuntimeOwner } from '../src/runtime/service.ts'

const mocked = vi.hoisted(() => ({
  register: vi.fn(),
  provideRuntime: vi.fn(),
  requireHost: vi.fn(),
}))

vi.mock('../src/adapters/cordis-feature-service.ts', () => ({
  registerDshTuiApplicationCapability: mocked.register,
}))

vi.mock('../src/dsh/runtime-service.ts', () => ({
  provideDshTuiRuntime: mocked.provideRuntime,
}))

vi.mock('../src/lifecycle/application-scope-host.ts', () => ({
  requireApplicationScopeHost: mocked.requireHost,
}))

import {
  apply,
  mountDshTuiDshRc2Adapter,
} from '../src/adapters/dsh-rc2.ts'

function capability(
  release = vi.fn(async () => {}),
): CapabilityRegistrationLease {
  return {
    tokenId: 'dsh-tui.sessions-workspace/v1',
    active: true,
    release,
  } as CapabilityRegistrationLease
}

function runtimeOwner(dispose = vi.fn(async () => {})): DshTuiRuntimeOwner {
  return {
    service: {
      catalog: Object.freeze({ id: 'catalog' }),
      inspection: Object.freeze({ id: 'inspection' }),
      activation: Object.freeze({ id: 'activation' }),
      fork: Object.freeze({ id: 'fork' }),
    } as never,
    dispose,
  }
}

function context(features: DshTuiFeatureService) {
  const effects: Array<() => void | Promise<void>> = []
  const effect = vi.fn((create: () => () => void | Promise<void>) => {
    effects.push(create())
    return { dispose: vi.fn(async () => {}) }
  })
  return {
    value: {
      dshTuiFeatures: features,
      effect,
    } as unknown as Context,
    effects,
    effect,
  }
}

describe('DSH rc.2 Cordis adapter owner', () => {
  beforeEach(() => {
    mocked.register.mockReset()
    mocked.provideRuntime.mockReset()
    mocked.requireHost.mockReset()
  })

  it('publishes Sessions workspace after runtime construction and follows its fiber', async () => {
    const features = Object.freeze({}) as DshTuiFeatureService
    const fixture = context(features)
    const registration = capability()
    const owner = runtimeOwner()
    const host = Object.freeze({ id: 'scope-host' })
    let createCapability: (() => unknown) | undefined
    let earlyFailure: unknown
    mocked.register.mockImplementation((_ctx, passedFeatures, definition) => {
      expect(passedFeatures).toBe(features)
      createCapability = definition.create
      try {
        definition.create()
      } catch (error: unknown) {
        earlyFailure = error
      }
      return registration
    })
    mocked.requireHost.mockReturnValue(host)
    mocked.provideRuntime.mockReturnValue(owner)

    apply(fixture.value)

    expect(earlyFailure).toEqual(new Error('DSH rc.2 runtime is unavailable'))
    expect(mocked.provideRuntime).toHaveBeenCalledWith(fixture.value, host)
    expect(fixture.effect).toHaveBeenCalledOnce()
    const acquired = createCapability?.() as {
      readonly value: Record<string, unknown>
      release(): void
    }
    expect(acquired.value).toEqual({
      catalog: owner.service.catalog,
      inspection: owner.service.inspection,
      activation: owner.service.activation,
      fork: owner.service.fork,
    })
    expect(acquired.release()).toBeUndefined()

    await fixture.effects[0]?.()
    expect(registration.release).toHaveBeenCalledOnce()
    expect(owner.dispose).toHaveBeenCalledOnce()
  })

  it('rolls back Sessions registration when runtime construction fails', async () => {
    const features = Object.freeze({}) as DshTuiFeatureService
    const fixture = context(features)
    const registration = capability(vi.fn(async () => {
      throw new Error('registration rollback failed')
    }))
    const runtimeFailure = new Error('runtime construction failed')
    mocked.register.mockReturnValue(registration)
    mocked.requireHost.mockReturnValue(Object.freeze({}))
    mocked.provideRuntime.mockImplementation(() => { throw runtimeFailure })

    expect(() => mountDshTuiDshRc2Adapter(
      fixture.value,
      features,
    )).toThrow(runtimeFailure)
    await vi.waitFor(() => {
      expect(registration.release).toHaveBeenCalledOnce()
    })
  })

  it('memoizes external teardown and aggregates both owner failures', async () => {
    const features = Object.freeze({}) as DshTuiFeatureService
    const fixture = context(features)
    const registrationFailure = new Error('Sessions registration release failed')
    const runtimeFailure = new Error('runtime owner release failed')
    const registration = capability(vi.fn(async () => { throw registrationFailure }))
    const owner = runtimeOwner(vi.fn(async () => { throw runtimeFailure }))
    mocked.register.mockReturnValue(registration)
    mocked.requireHost.mockReturnValue(Object.freeze({}))
    mocked.provideRuntime.mockReturnValue(owner)
    const mount = mountDshTuiDshRc2Adapter(
      fixture.value,
      features,
      'external',
    )

    expect(fixture.effect).not.toHaveBeenCalled()
    const first = mount.dispose()
    expect(mount.dispose()).toBe(first)
    await expect(first).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [registrationFailure, runtimeFailure],
    })
    expect(registration.release).toHaveBeenCalledOnce()
    expect(owner.dispose).toHaveBeenCalledOnce()
  })
})
