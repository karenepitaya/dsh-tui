import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityRegistrationLease } from '../src/kernel/capability-registry.ts'
import type { DshTuiFeatureService } from '../src/kernel/feature-service.ts'
import type { DshTuiPreferencesSettingsOwner } from '../src/dsh/preferences-settings.ts'

const mocked = vi.hoisted(() => ({
  register: vi.fn(),
  providePreferences: vi.fn(),
}))

vi.mock('../src/adapters/cordis-feature-service.ts', () => ({
  registerDshTuiApplicationCapability: mocked.register,
}))

vi.mock('../src/dsh/preferences-settings.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/dsh/preferences-settings.ts')>(),
  provideDshTuiPreferencesSettings: mocked.providePreferences,
}))

import {
  apply,
  mountDshTuiPreferencesAdapter,
} from '../src/adapters/preferences.ts'

function owner(dispose = vi.fn(async () => {})): DshTuiPreferencesSettingsOwner {
  return {
    service: {
      status: vi.fn(() => ({
        available: false,
        writable: false,
        documentBacked: false,
      })),
      read: vi.fn(),
      write: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    } as never,
    dispose,
  }
}

function capability(
  release = vi.fn(async () => {}),
): CapabilityRegistrationLease {
  return {
    tokenId: 'dsh-tui.preferences/v1',
    active: true,
    release,
  } as CapabilityRegistrationLease
}

function context(features: DshTuiFeatureService) {
  const effects: Array<() => void | Promise<void>> = []
  const provide = vi.fn()
  const effect = vi.fn((create: () => () => void | Promise<void>) => {
    effects.push(create())
    return { dispose: vi.fn(async () => {}) }
  })
  return {
    value: {
      dshTuiFeatures: features,
      provide,
      effect,
    } as unknown as Context,
    effects,
    provide,
    effect,
  }
}

describe('Preferences Cordis adapter owner', () => {
  beforeEach(() => {
    mocked.register.mockReset()
    mocked.providePreferences.mockReset()
  })

  it('publishes one capability and binds its owner to the Cordis lifecycle', async () => {
    const features = Object.freeze({}) as DshTuiFeatureService
    const fixture = context(features)
    const preferencesOwner = owner()
    const registration = capability()
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
    mocked.providePreferences.mockReturnValue(preferencesOwner)

    apply(fixture.value)

    expect(earlyFailure).toEqual(new Error('DSH-TUI Preferences service is unavailable'))
    expect(mocked.providePreferences).toHaveBeenCalledWith(fixture.value, {})
    expect(fixture.provide).toHaveBeenCalledWith(
      'dshTuiPreferences',
      preferencesOwner.service,
    )
    expect(fixture.effect).toHaveBeenCalledOnce()
    const acquired = createCapability?.() as {
      readonly value: unknown
      release(): void
    }
    expect(acquired.value).toBe(preferencesOwner.service)
    expect(acquired.release()).toBeUndefined()

    await fixture.effects[0]?.()
    expect(registration.release).toHaveBeenCalledOnce()
    expect(preferencesOwner.dispose).toHaveBeenCalledOnce()
  })

  it('releases capability registration when the Settings owner cannot mount', async () => {
    const features = Object.freeze({}) as DshTuiFeatureService
    const fixture = context(features)
    const releaseFailure = new Error('capability rollback failed')
    const registration = capability(vi.fn(async () => { throw releaseFailure }))
    const mountFailure = new Error('preferences mount failed')
    mocked.register.mockReturnValue(registration)
    mocked.providePreferences.mockImplementation(() => { throw mountFailure })

    expect(() => mountDshTuiPreferencesAdapter(
      fixture.value,
      features,
    )).toThrow(mountFailure)
    await vi.waitFor(() => {
      expect(registration.release).toHaveBeenCalledOnce()
    })
    expect(fixture.provide).not.toHaveBeenCalled()
  })

  it('memoizes external teardown and aggregates both owner failures', async () => {
    const features = Object.freeze({}) as DshTuiFeatureService
    const fixture = context(features)
    const capabilityFailure = new Error('capability release failed')
    const ownerFailure = new Error('settings owner release failed')
    const registration = capability(vi.fn(async () => { throw capabilityFailure }))
    const preferencesOwner = owner(vi.fn(async () => { throw ownerFailure }))
    mocked.register.mockReturnValue(registration)
    mocked.providePreferences.mockReturnValue(preferencesOwner)
    const mount = mountDshTuiPreferencesAdapter(
      fixture.value,
      features,
      { rowConfig: { density: 'comfortable' } },
      'external',
    )

    expect(fixture.effect).not.toHaveBeenCalled()
    const first = mount.dispose()
    expect(mount.dispose()).toBe(first)
    await expect(first).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [capabilityFailure, ownerFailure],
    })
    expect(registration.release).toHaveBeenCalledOnce()
    expect(preferencesOwner.dispose).toHaveBeenCalledOnce()
  })
})
