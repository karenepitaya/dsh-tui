import { describe, expect, it, vi } from 'vitest'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'
import {
  prepareAgentBootstrap,
  type AgentBootstrapContributor,
  type PreparedAgentBootstrapContribution,
} from '../src/runtime/agent-bootstrap.ts'

interface ContributorHarness {
  readonly contributor: AgentBootstrapContributor<{ readonly session: string }>
  readonly commit: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
  setActive(active: boolean): void
}

function contributor(
  id: string,
  order: string[],
  options: {
    readonly commit?: () => unknown
    readonly prepare?: () => void | Promise<void>
    readonly dispose?: () => void | Promise<void>
  } = {},
): ContributorHarness {
  let active = true
  const commit = vi.fn(() => {
    order.push(`commit:${id}`)
    return options.commit?.()
  })
  const dispose = vi.fn(async () => {
    order.push(`dispose:${id}`)
    await options.dispose?.()
  })
  return {
    contributor: {
      id,
      get active() {
        return active
      },
      prepare: async (context): Promise<PreparedAgentBootstrapContribution> => {
        expect(context).toEqual({ session: 'session-a' })
        order.push(`prepare:${id}`)
        await options.prepare?.()
        return { commit, dispose }
      },
    },
    commit,
    dispose,
    setActive(next) {
      active = next
    },
  }
}

describe('Agent bootstrap composer', () => {
  it('snapshots contributors, prepares and commits in order, then rolls back once in reverse', async () => {
    const manager = new ScopeManager()
    const scope = manager.createSession('session-a')
    const order: string[] = []
    const first = contributor('first', order)
    const second = contributor('second', order)
    const contributors = [first.contributor, second.contributor]

    const bootstrap = await prepareAgentBootstrap(
      scope,
      { session: 'session-a' },
      contributors,
    )
    contributors.reverse()

    expect(order).toEqual(['prepare:first', 'prepare:second'])
    expect(bootstrap.commit()).toBeUndefined()
    expect(() => bootstrap.commit()).toThrow('Agent bootstrap is already committed')
    expect(order).toEqual([
      'prepare:first',
      'prepare:second',
      'commit:first',
      'commit:second',
    ])

    const rollback = bootstrap.rollback()
    expect(bootstrap.rollback()).toBe(rollback)
    await rollback
    await scope.dispose()
    expect(order.slice(-2)).toEqual(['dispose:second', 'dispose:first'])
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()
    await manager.dispose()
  })

  it('checks contributor and session activity before preparation and before any commit', async () => {
    const manager = new ScopeManager()
    const initialScope = manager.createSession('initial-inactive')
    const initiallyInactive = contributor('inactive', [])
    initiallyInactive.setActive(false)
    await expect(prepareAgentBootstrap(
      initialScope,
      { session: 'session-a' },
      [initiallyInactive.contributor],
    )).rejects.toThrow('Agent bootstrap contributor "inactive" is inactive')

    const scope = manager.createSession('commit-inactive')
    const order: string[] = []
    const first = contributor('first', order)
    const second = contributor('second', order)
    const bootstrap = await prepareAgentBootstrap(
      scope,
      { session: 'session-a' },
      [first.contributor, second.contributor],
    )
    second.setActive(false)

    expect(() => bootstrap.commit()).toThrow(
      'Agent bootstrap contributor "second" is inactive',
    )
    expect(first.commit).not.toHaveBeenCalled()
    expect(second.commit).not.toHaveBeenCalled()
    await expect(bootstrap.rollback()).resolves.toBeUndefined()
    expect(order.slice(-2)).toEqual(['dispose:second', 'dispose:first'])
    expect(() => bootstrap.commit()).toThrow('Agent bootstrap is rolled back')

    const disposedScope = manager.createSession('disposed')
    await disposedScope.dispose()
    await expect(prepareAgentBootstrap(
      disposedScope,
      { session: 'session-a' },
      [],
    )).rejects.toThrow('Agent bootstrap requires an active session scope')
    await expect(prepareAgentBootstrap(
      manager.app,
      { session: 'session-a' },
      [],
    )).rejects.toThrow('Agent bootstrap requires an active session scope')
    await manager.dispose()
  })

  it('rechecks each contributor immediately before its commit', async () => {
    const manager = new ScopeManager()
    const scope = manager.createSession('session-a')
    const order: string[] = []
    let second!: ContributorHarness
    const first = contributor('first', order, {
      commit: () => { second.setActive(false) },
    })
    second = contributor('second', order)
    const bootstrap = await prepareAgentBootstrap(
      scope,
      { session: 'session-a' },
      [first.contributor, second.contributor],
    )

    expect(() => bootstrap.commit()).toThrow(
      'Agent bootstrap contributor "second" is inactive',
    )
    expect(first.commit).toHaveBeenCalledOnce()
    expect(second.commit).not.toHaveBeenCalled()
    await bootstrap.rollback()
    expect(order).toEqual([
      'prepare:first',
      'prepare:second',
      'commit:first',
      'dispose:second',
      'dispose:first',
    ])
    await manager.dispose()
  })

  it('cleans a late contribution before prior records when activity changes during prepare', async () => {
    const manager = new ScopeManager()
    const scope = manager.createSession('session-a')
    const order: string[] = []
    const first = contributor('first', order)
    let late!: ContributorHarness
    late = contributor('late', order, {
      prepare: () => { late.setActive(false) },
    })

    await expect(prepareAgentBootstrap(
      scope,
      { session: 'session-a' },
      [first.contributor, late.contributor],
    )).rejects.toThrow('Agent bootstrap contributor "late" is inactive')
    expect(order).toEqual([
      'prepare:first',
      'prepare:late',
      'dispose:late',
      'dispose:first',
    ])
    await scope.dispose()
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(late.dispose).toHaveBeenCalledOnce()
    await manager.dispose()
  })

  it('preserves preparation failure first and aggregates rollback failures in reverse order', async () => {
    const manager = new ScopeManager()
    const scope = manager.createSession('session-a')
    const order: string[] = []
    const firstDisposal = new Error('first disposal failed')
    const secondDisposal = new Error('second disposal failed')
    const preparation = new Error('third preparation failed')
    const first = contributor('first', order, {
      dispose: () => { throw firstDisposal },
    })
    const second = contributor('second', order, {
      dispose: () => { throw secondDisposal },
    })
    const third = contributor('third', order, {
      prepare: () => { throw preparation },
    })

    const failure = await prepareAgentBootstrap(
      scope,
      { session: 'session-a' },
      [first.contributor, second.contributor, third.contributor],
    ).catch((error: unknown) => error)

    expect(order).toEqual([
      'prepare:first',
      'prepare:second',
      'prepare:third',
      'dispose:second',
      'dispose:first',
    ])
    expect(failure).toEqual(expect.objectContaining({
      name: 'AggregateError',
      message: 'Agent bootstrap preparation failed and rollback failed',
    }))
    expect((failure as AggregateError).errors).toEqual([
      preparation,
      secondDisposal,
      firstDisposal,
    ])
    await scope.dispose()
    await manager.dispose()
  })

  it('keeps commit synchronous, prevents retry, and aggregates its later rollback failure', async () => {
    const manager = new ScopeManager()
    const scope = manager.createSession('session-a')
    const order: string[] = []
    const commitFailure = new Error('second commit failed')
    const thirdDisposal = new Error('third disposal failed')
    const first = contributor('first', order)
    const second = contributor('second', order, {
      commit: () => { throw commitFailure },
    })
    const third = contributor('third', order, {
      dispose: () => { throw thirdDisposal },
    })
    const bootstrap = await prepareAgentBootstrap(
      scope,
      { session: 'session-a' },
      [first.contributor, second.contributor, third.contributor],
    )

    expect(() => bootstrap.commit()).toThrow(commitFailure)
    expect(third.commit).not.toHaveBeenCalled()
    expect(() => bootstrap.commit()).toThrow('Agent bootstrap commit cannot be retried')
    const failure = await bootstrap.rollback().catch((error: unknown) => error)

    expect(order.slice(3)).toEqual([
      'commit:first',
      'commit:second',
      'dispose:third',
      'dispose:second',
      'dispose:first',
    ])
    expect(failure).toEqual(expect.objectContaining({
      name: 'AggregateError',
      message: 'Agent bootstrap commit failed and rollback failed',
    }))
    expect((failure as AggregateError).errors).toEqual([
      commitFailure,
      thirdDisposal,
    ])
    await manager.dispose()
  })

  it('rejects a thenable commit and malformed contributor contracts without partial commit', async () => {
    const manager = new ScopeManager()
    const scope = manager.createSession('session-a')
    const order: string[] = []
    const asynchronous = contributor('async', order, {
      commit: () => Promise.resolve(),
    })
    const after = contributor('after', order)
    const bootstrap = await prepareAgentBootstrap(
      scope,
      { session: 'session-a' },
      [asynchronous.contributor, after.contributor],
    )

    expect(() => bootstrap.commit()).toThrow(
      'Agent bootstrap contributor "async" returned an asynchronous commit',
    )
    expect(after.commit).not.toHaveBeenCalled()
    await bootstrap.rollback()

    for (const id of ['', ' padded ']) {
      await expect(prepareAgentBootstrap(
        manager.createSession(`invalid-${id.length}`),
        { session: 'session-a' },
        [{ id, active: true, prepare: vi.fn() }],
      )).rejects.toThrow('must have a non-empty trimmed id and prepare function')
    }
    const duplicate = contributor('duplicate', [])
    await expect(prepareAgentBootstrap(
      manager.createSession('duplicate'),
      { session: 'session-a' },
      [duplicate.contributor, duplicate.contributor],
    )).rejects.toThrow('Agent bootstrap contributor "duplicate" is duplicated')
    await manager.dispose()
  })

  it('rejects a reentrant commit and marks the transaction as non-retryable', async () => {
    const manager = new ScopeManager()
    const scope = manager.createSession('session-a')
    let bootstrap!: Awaited<ReturnType<typeof prepareAgentBootstrap>>
    const recursive = contributor('recursive', [], {
      commit: () => bootstrap.commit(),
    })
    bootstrap = await prepareAgentBootstrap(
      scope,
      { session: 'session-a' },
      [recursive.contributor],
    )

    expect(() => bootstrap.commit()).toThrow(
      'Agent bootstrap commit is already in progress',
    )
    expect(() => bootstrap.commit()).toThrow('Agent bootstrap commit cannot be retried')
    await bootstrap.rollback()
    await manager.dispose()
  })

  it('cleans a malformed returned contribution and reports an explicit rollback AggregateError', async () => {
    const manager = new ScopeManager()
    const malformedScope = manager.createSession('malformed')
    const partialDispose = vi.fn(() => { throw new Error('partial cleanup failed') })
    const malformed: AgentBootstrapContributor<{ readonly session: string }> = {
      id: 'malformed',
      active: true,
      prepare: () => ({
        commit: 'invalid',
        dispose: partialDispose,
      } as unknown as PreparedAgentBootstrapContribution),
    }
    const malformedFailure = await prepareAgentBootstrap(
      malformedScope,
      { session: 'session-a' },
      [malformed],
    ).catch((error: unknown) => error)
    expect((malformedFailure as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('returned an invalid contribution'),
      }),
      expect.objectContaining({ message: 'partial cleanup failed' }),
    ])
    expect(partialDispose).toHaveBeenCalledOnce()

    const rollbackScope = manager.createSession('rollback')
    const firstFailure = new Error('first failed')
    const secondFailure = new Error('second failed')
    const first = contributor('first', [], {
      dispose: () => { throw firstFailure },
    })
    const second = contributor('second', [], {
      dispose: () => { throw secondFailure },
    })
    const bootstrap = await prepareAgentBootstrap(
      rollbackScope,
      { session: 'session-a' },
      [first.contributor, second.contributor],
    )
    const failure = await bootstrap.rollback().catch((error: unknown) => error)
    expect(failure).toEqual(expect.objectContaining({
      name: 'AggregateError',
      message: 'Agent bootstrap rollback failed',
    }))
    expect((failure as AggregateError).errors).toEqual([secondFailure, firstFailure])
    expect(() => bootstrap.commit()).toThrow('Agent bootstrap is rolled back')
    await manager.dispose()
  })
})
