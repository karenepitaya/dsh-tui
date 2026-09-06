import { describe, expect, it, vi } from 'vitest'
import {
  ScopeManager,
  type ResourceScope,
} from '../src/lifecycle/scope-manager.ts'

function ownedEntryCount(scope: ResourceScope): number {
  const entries: unknown = Reflect.get(scope, 'entries')
  if (Array.isArray(entries)) return entries.length
  if (entries instanceof Set) return entries.size
  throw new TypeError('ResourceScope ownership entries are not inspectable')
}

function ownedEntries(scope: ResourceScope): readonly { release(): Promise<void> }[] {
  const entries: unknown = Reflect.get(scope, 'entries')
  if (Array.isArray(entries)) return entries as { release(): Promise<void> }[]
  if (entries instanceof Set) return [...entries] as { release(): Promise<void> }[]
  throw new TypeError('ResourceScope ownership entries are not inspectable')
}

describe('ScopeManager', () => {
  it('creates the supported hierarchy and disposes descendants and resources in reverse order', async () => {
    const order: string[] = []
    const manager = new ScopeManager('product')
    const session = manager.createSession('session-a')
    session.defer(() => { order.push('session:first') })
    const surface = session.child('surface', 'chat')
    surface.defer(() => { order.push('surface:first') })
    const overlay = surface.child('overlay', 'permission')
    overlay.defer(() => { order.push('overlay:first') })
    const request = overlay.child('request', 'load')
    request.defer(() => { order.push('request:first') })
    const motion = request.child('motion', 'orb')
    motion.defer(() => { order.push('motion:first') })
    surface.defer(() => { order.push('surface:last') })
    session.defer(() => { order.push('session:last') })

    expect(manager.app.kind).toBe('app')
    expect(manager.app.label).toBe('product')
    expect(session.parent).toBe(manager.app)
    expect(surface.parent).toBe(session)
    expect(overlay.parent).toBe(surface)
    expect(request.parent).toBe(overlay)
    expect(motion.parent).toBe(request)
    expect(new Set([
      manager.app.epoch,
      session.epoch,
      surface.epoch,
      overlay.epoch,
      request.epoch,
      motion.epoch,
    ]).size).toBe(6)

    await session.dispose('session closed')

    expect(order).toEqual([
      'session:last',
      'surface:last',
      'motion:first',
      'request:first',
      'overlay:first',
      'surface:first',
      'session:first',
    ])
    for (const scope of [session, surface, overlay, request, motion]) {
      expect(scope.disposed).toBe(true)
      expect(scope.signal.aborted).toBe(true)
      expect(scope.signal.reason).toBe('session closed')
    }
    expect(manager.app.disposed).toBe(false)
  })

  it('supports session-owned requests and surface-owned motion without widening disposal', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const request = session.child('request', 'turn')
    const surface = session.child('surface', 'chat')
    const motion = surface.child('motion', 'activity')
    const sibling = session.child('surface', 'sessions')

    await surface.dispose()

    expect(surface.signal.aborted).toBe(true)
    expect(motion.signal.aborted).toBe(true)
    expect(session.signal.aborted).toBe(false)
    expect(request.signal.aborted).toBe(false)
    expect(sibling.signal.aborted).toBe(false)

    await manager.dispose()
    expect(manager.app.disposed).toBe(true)
    expect(session.signal.aborted).toBe(true)
    expect(request.signal.aborted).toBe(true)
    expect(sibling.signal.aborted).toBe(true)
  })

  it('forgets completed child ownership instead of retaining every historical scope', async () => {
    const manager = new ScopeManager()

    for (let index = 0; index < 512; index += 1) {
      const session = manager.createSession(`session-${index}`)
      await session.dispose('session replaced')
      expect(ownedEntryCount(manager.app)).toBe(0)
    }

    await manager.dispose()
  })

  it('makes an already captured parent ownership entry inert after child disposal', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const [ownership] = ownedEntries(manager.app)
    const cleanup = vi.fn()
    session.defer(cleanup)

    await session.dispose('session replaced')
    await ownership!.release()

    expect(cleanup).toHaveBeenCalledOnce()
    expect(ownedEntryCount(manager.app)).toBe(0)
    await manager.dispose()
  })

  it('coalesces parent and child disposal races without cleaning the child twice', async () => {
    let finishChild!: () => void
    const childBlocked = new Promise<void>((resolve) => { finishChild = resolve })
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const surface = session.child('surface', 'chat')
    const cleanup = vi.fn(() => childBlocked)
    surface.defer(cleanup)

    const childDisposal = surface.dispose('surface replaced')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(ownedEntryCount(session)).toBe(1)

    const parentDisposal = session.dispose('session closed')
    expect(cleanup).toHaveBeenCalledOnce()

    finishChild()
    await Promise.all([childDisposal, parentDisposal])

    expect(cleanup).toHaveBeenCalledOnce()
    expect(ownedEntryCount(manager.app)).toBe(0)
    await manager.dispose()
  })

  it('releases an owned resource exactly once before scope disposal', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const dispose = vi.fn()
    const release = session.defer(dispose)

    await release()
    await release()
    await session.dispose()

    expect(dispose).toHaveBeenCalledOnce()
  })

  it('continues reverse disposal and reports all cleanup failures', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const order: string[] = []
    const first = new Error('first failure')
    const second = new Error('second failure')
    session.defer(() => {
      order.push('first')
      throw first
    })
    session.defer(async () => {
      order.push('second')
      throw second
    })

    const failure = await session.dispose().catch((error: unknown) => error)

    expect(order).toEqual(['second', 'first'])
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([second, first])
  })

  it('rejects invalid and post-disposal ownership changes', async () => {
    const manager = new ScopeManager()
    expect(() => manager.app.child('motion', 'invalid')).toThrow(
      'app scope cannot own motion scope',
    )
    const session = manager.createSession('session-a')
    const motion = session.child('request', 'turn').child('motion', 'orb')
    expect(() => motion.child('motion', 'nested')).toThrow(
      'motion scope cannot own motion scope',
    )

    await session.dispose()
    expect(() => session.child('surface', 'late')).toThrow('session scope is disposed')
    expect(() => session.defer(() => {})).toThrow('session scope is disposed')
    await expect(session.dispose()).resolves.toBeUndefined()

    await manager.dispose()
    expect(() => manager.createSession('late-session')).toThrow('app scope is disposed')
    await expect(manager.dispose()).resolves.toBeUndefined()
  })

  it('propagates a parent abort immediately even while an earlier disposer is pending', async () => {
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => { finish = resolve })
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const surface = session.child('surface', 'chat')
    session.defer(() => blocked)

    const disposal = session.dispose(new Error('closing'))

    expect(surface.signal.aborted).toBe(true)
    expect(surface.signal.reason).toBeInstanceOf(Error)
    expect(surface.disposed).toBe(false)
    expect(() => surface.child('motion', 'late')).toThrow('surface scope is disposed')
    expect(() => surface.defer(() => {})).toThrow('surface scope is disposed')
    finish()
    await disposal
  })

  it('can broadcast abort before cleanup while preserving dispose as the single owner', async () => {
    const manager = new ScopeManager()
    const session = manager.createSession('session-a')
    const cleanup = vi.fn()
    session.defer(cleanup)

    manager.abort('shutdown requested')

    expect(manager.app.signal.aborted).toBe(true)
    expect(session.signal.aborted).toBe(true)
    expect(session.signal.reason).toBe('shutdown requested')
    expect(manager.app.disposed).toBe(false)
    expect(session.disposed).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()

    await manager.dispose('shutdown complete')
    expect(cleanup).toHaveBeenCalledOnce()
    await expect(manager.dispose()).resolves.toBeUndefined()
  })

  it('accepts an asynchronous resource disposer and exposes stable scope identity', async () => {
    const manager = new ScopeManager()
    const session: ResourceScope = manager.createSession('session-a')
    let released = false
    session.defer(async () => {
      await Promise.resolve()
      released = true
    })

    expect(session.id).toBe(`session:${session.epoch}:session-a`)
    await session.dispose()
    expect(released).toBe(true)
  })
})
