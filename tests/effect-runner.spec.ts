import { describe, expect, it, vi } from 'vitest'
import { EffectRunner } from '../src/lifecycle/effect-runner.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

describe('EffectRunner', () => {
  it('executes in an active scope, commits the value, and registers cleanup', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const runner = new EffectRunner()
    const cleanup = vi.fn()
    const commit = vi.fn()

    await expect(runner.run(surface, {
      execute: ({ scope, signal }) => {
        expect(scope).toBe(surface)
        expect(signal).toBe(surface.signal)
        return { value: 42, cleanup }
      },
    }, commit)).resolves.toEqual({ status: 'committed', value: 42 })

    expect(commit).toHaveBeenCalledWith(42)
    expect(cleanup).not.toHaveBeenCalled()
    await surface.dispose()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('does not commit a late completion and cleans its returned resource immediately', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const runner = new EffectRunner()
    const pending = deferred<{ readonly value: string; readonly cleanup: () => void }>()
    const cleanup = vi.fn()
    const commit = vi.fn()
    const task = runner.run(surface, { execute: () => pending.promise }, commit)

    await surface.dispose()
    pending.resolve({ value: 'late', cleanup })

    await expect(task).resolves.toEqual({ status: 'discarded' })
    expect(commit).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('rejects work when the scope is disposed or only parent-aborted', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const disposedSurface = session.child('surface', 'disposed')
    await disposedSurface.dispose()
    const execute = vi.fn(() => ({ value: 1 }))
    const runner = new EffectRunner()
    await expect(runner.run(disposedSurface, { execute })).rejects.toThrow(
      'cannot run an effect in inactive surface scope',
    )
    expect(execute).not.toHaveBeenCalled()

    const abortedSurface = session.child('surface', 'aborted')
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => { finish = resolve })
    session.defer(() => blocked)
    const disposal = session.dispose('parent closing')
    expect(abortedSurface.disposed).toBe(false)
    expect(abortedSurface.signal.aborted).toBe(true)
    await expect(runner.run(abortedSurface, { execute })).rejects.toThrow(
      'cannot run an effect in inactive surface scope',
    )
    finish()
    await disposal
  })

  it('returns synchronous and asynchronous execution errors without breaking scope cleanup', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const runner = new EffectRunner()
    const ownedCleanup = vi.fn()
    surface.defer(ownedCleanup)
    const syncError = new Error('sync failure')
    await expect(runner.run(surface, {
      execute: () => { throw syncError },
    })).rejects.toBe(syncError)
    const asyncError = new Error('async failure')
    await expect(runner.run(surface, {
      execute: async () => { throw asyncError },
    })).rejects.toBe(asyncError)

    await surface.dispose()
    expect(ownedCleanup).toHaveBeenCalledOnce()
  })

  it('keeps registered cleanup when commit throws and supports values without cleanup', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const runner = new EffectRunner()
    const cleanup = vi.fn()
    const commitError = new Error('commit failed')
    await expect(runner.run(surface, {
      execute: () => ({ value: 'value', cleanup }),
    }, () => { throw commitError })).rejects.toBe(commitError)

    await expect(runner.run(surface, {
      execute: () => ({ value: 'plain' }),
    })).resolves.toEqual({ status: 'committed', value: 'plain' })

    await surface.dispose()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('returns a late cleanup error to the caller without committing', async () => {
    const manager = new ScopeManager()
    const surface = manager.createSession('session-a').child('surface', 'chat')
    const runner = new EffectRunner()
    const pending = deferred<{ readonly value: string; readonly cleanup: () => void }>()
    const cleanupError = new Error('late cleanup failed')
    const commit = vi.fn()
    const task = runner.run(surface, { execute: () => pending.promise }, commit)
    await surface.dispose()
    pending.resolve({
      value: 'late',
      cleanup: () => { throw cleanupError },
    })

    await expect(task).rejects.toBe(cleanupError)
    expect(commit).not.toHaveBeenCalled()
  })
})
