import { describe, expect, it, vi } from 'vitest'
import { PreferenceApplication } from '../src/preferences/application.ts'
import { DEFAULT_DSH_TUI_PREFERENCES } from '../src/preferences/contracts.ts'
import type { DshTuiPreferencesApplicationPort } from '../src/preferences/port.ts'

describe('application preference lifetime', () => {
  it('keeps startup pending until the newest interleaved refresh settles', async () => {
    let changed!: () => void
    const resolves: ((value: Awaited<ReturnType<DshTuiPreferencesApplicationPort['read']>>) => void)[] = []
    const read = vi.fn(() => new Promise<Awaited<ReturnType<DshTuiPreferencesApplicationPort['read']>>>(resolve => {
      resolves.push(resolve)
    }))
    const app = new PreferenceApplication({
      read,
      onChanged: listener => { changed = listener; return () => {} },
    })
    let started = false
    const start = app.start().then(() => { started = true })

    changed()
    expect(read).toHaveBeenCalledTimes(2)
    resolves[0]!({ revision: 1, preferences: DEFAULT_DSH_TUI_PREFERENCES })
    await Promise.resolve()
    expect(started).toBe(false)

    resolves[1]!({
      revision: 2,
      preferences: { ...DEFAULT_DSH_TUI_PREFERENCES, density: 'comfortable' },
    })
    await start
    expect(app.snapshot().density).toBe('comfortable')
    app.dispose()
  })

  it('does not leave startup waiting for an unresolved read after disposal', async () => {
    let reject!: (error: unknown) => void
    const errors = vi.fn()
    const app = new PreferenceApplication({
      read: () => new Promise((_, rejectRead) => { reject = rejectRead }),
      onChanged: () => () => {},
    }, undefined, errors)

    const start = app.start()
    app.dispose()
    await start
    reject(new Error('late read'))
    await Promise.resolve()
    expect(errors).not.toHaveBeenCalled()
  })

  it('loads once, deduplicates notifications, keeps last-good and releases its watch', async () => {
    let changed!: () => void
    const stop = vi.fn()
    const read = vi.fn(async () => ({ revision: 1, preferences: DEFAULT_DSH_TUI_PREFERENCES }))
    const errors = vi.fn()
    const port = { read, onChanged: (listener: () => void) => { changed = listener; return stop } }
    const app = new PreferenceApplication(port, { preset: 'mono' }, errors)
    expect(app.snapshot().theme.preset).toBe('mono')
    const observed = vi.fn()
    const off = app.onChanged(observed)
    const start = app.start()
    expect(app.start()).toBe(start)
    await start
    expect(read).toHaveBeenCalledOnce()
    expect(app.snapshot()).toEqual(DEFAULT_DSH_TUI_PREFERENCES)
    expect(observed).toHaveBeenCalledOnce()
    changed()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(observed).toHaveBeenCalledOnce()
    read.mockRejectedValueOnce(new Error('cannot read'))
    changed()
    await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce())
    expect(app.snapshot()).toEqual(DEFAULT_DSH_TUI_PREFERENCES)
    off()
    off()
    app.dispose()
    app.dispose()
    expect(stop).toHaveBeenCalledOnce()
    changed()
    await app.start()
    expect(read).toHaveBeenCalledTimes(3)
    expect(() => app.onChanged(observed)).toThrow('disposed')
  })

  it('ignores stale loads and loads settling after disposal, including rejection', async () => {
    let changed!: () => void
    const resolves: ((value: Awaited<ReturnType<DshTuiPreferencesApplicationPort['read']>>) => void)[] = []
    const rejects: ((error: unknown) => void)[] = []
    const read = vi.fn(() => new Promise<Awaited<ReturnType<DshTuiPreferencesApplicationPort['read']>>>((resolve, reject) => {
      resolves.push(resolve); rejects.push(reject)
    }))
    const errors = vi.fn()
    const app = new PreferenceApplication({ read, onChanged: listener => { changed = listener; return () => {} } }, undefined, errors)
    const first = app.start()
    changed()
    resolves[1]!({ revision: 2, preferences: { ...DEFAULT_DSH_TUI_PREFERENCES, density: 'comfortable' } })
    await vi.waitFor(() => expect(app.snapshot().density).toBe('comfortable'))
    resolves[0]!({ revision: 1, preferences: DEFAULT_DSH_TUI_PREFERENCES })
    await first
    expect(app.snapshot().density).toBe('comfortable')
    changed()
    changed()
    app.dispose()
    resolves[2]!({ revision: 3, preferences: DEFAULT_DSH_TUI_PREFERENCES })
    rejects[3]!(new Error('late'))
    await Promise.resolve()
    expect(app.snapshot().density).toBe('comfortable')
    expect(errors).not.toHaveBeenCalled()
    const defaults = new PreferenceApplication()
    await defaults.start()
    expect(defaults.snapshot()).toEqual(DEFAULT_DSH_TUI_PREFERENCES)
    defaults.dispose()
    const unavailable = new PreferenceApplication({
      read: async () => { throw new Error('unavailable preferences') },
      onChanged: () => () => {},
    })
    await unavailable.start()
    expect(unavailable.snapshot()).toEqual(DEFAULT_DSH_TUI_PREFERENCES)
    unavailable.dispose()
  })
})
