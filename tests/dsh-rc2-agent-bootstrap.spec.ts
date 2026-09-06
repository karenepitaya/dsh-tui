import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDshRc2AgentBootstrapAttempt as createScopedBootstrapAttempt,
  dshRc2PresetSourceKey,
  rollbackDshRc2AgentBootstrap,
  type DshRc2AgentBootstrapPlan,
} from '../src/compat/dsh-rc2/agent-bootstrap.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'

const scopeManagers: ScopeManager[] = []

afterEach(async () => {
  await Promise.all(scopeManagers.splice(0).map(manager => manager.dispose()))
})

function createDshRc2AgentBootstrapAttempt<TContext>(
  label: string,
  plan: DshRc2AgentBootstrapPlan<TContext>,
) {
  const manager = new ScopeManager(`test:${label}`)
  scopeManagers.push(manager)
  return createScopedBootstrapAttempt(manager.createSession(label), plan)
}

describe('DSH rc2 unpublished Agent bootstrap adapter', () => {
  it('owns scoped Agent guidance before publication and releases it on rollback', async () => {
    const order: string[] = []
    const plan = {
      installModel: () => undefined,
      mountPreset: () => { order.push('preset') },
      installGuidance: () => {
        order.push('guidance')
        return () => { order.push('dispose:guidance') }
      },
      setupDownstream: () => { order.push('downstream') },
    }
    const attempt = createDshRc2AgentBootstrapAttempt('guidance-contract', plan)
    const prepared = await attempt.setup({})
    expect(order).toEqual(['preset', 'guidance', 'downstream'])
    prepared.commit()
    await attempt.rollback()
    expect(order.at(-1)).toBe('dispose:guidance')
  })

  it('prepares before publication, commits synchronously, and cleans in reverse', async () => {
    const order: string[] = []
    const attempt = createDshRc2AgentBootstrapAttempt('fresh-session', {
      beforePrepare: () => { order.push('prepare:guard') },
      installModel: () => {
        order.push('prepare:model')
        return () => { order.push('dispose:model') }
      },
      mountPreset: async () => {
        order.push('prepare:preset')
        return () => { order.push('dispose:preset') }
      },
      setupDownstream: async () => {
        order.push('prepare:downstream')
        return { commit: () => { order.push('commit:downstream') } }
      },
      afterPrepare: () => { order.push('prepare:validated') },
      beforeCommit: () => { order.push('commit:guard-before') },
      afterCommit: () => { order.push('commit:guard-after') },
    })

    const commit = await attempt.setup({ sessionId: 'fresh-session' })
    expect(order).toEqual([
      'prepare:guard',
      'prepare:model',
      'prepare:preset',
      'prepare:downstream',
      'prepare:validated',
    ])
    expect(commit.commit()).toBeUndefined()
    expect(order.slice(-3)).toEqual([
      'commit:guard-before',
      'commit:downstream',
      'commit:guard-after',
    ])

    const handleDispose = vi.fn(async () => { order.push('dispose:handle') })
    const handle = attempt.ownHandle({ agent: { id: 'fresh-session' }, dispose: handleDispose })
    await handle.dispose()
    await handle.dispose()
    expect(order.slice(-3)).toEqual([
      'dispose:handle',
      'dispose:preset',
      'dispose:model',
    ])
    expect(handleDispose).toHaveBeenCalledOnce()
  })

  it('keeps every attempt isolated and rolls a failed commit back once', async () => {
    const firstOrder: string[] = []
    const first = createDshRc2AgentBootstrapAttempt('cold:attempt-1', {
      installModel: () => () => { firstOrder.push('dispose:model') },
      mountPreset: () => () => { firstOrder.push('dispose:preset') },
      setupDownstream: () => ({ commit: () => { throw new Error('commit failed') } }),
    })
    const firstCommit = await first.setup({ attempt: 1 })
    expect(() => firstCommit.commit()).toThrow('commit failed')
    const rollback = first.rollback()
    expect(first.rollback()).toBe(rollback)
    await rollback
    expect(firstOrder).toEqual(['dispose:preset', 'dispose:model'])

    const second = createDshRc2AgentBootstrapAttempt('cold:attempt-2', {
      installModel: () => undefined,
      mountPreset: () => undefined,
    })
    const secondCommit = await second.setup({ attempt: 2 })
    expect(secondCommit.commit()).toBeUndefined()
    await second.rollback()
  })

  it('uses the rc2 preset identity fields without collapsing source provenance', () => {
    expect(dshRc2PresetSourceKey({
      id: 'standard',
      trust: 'system',
      path: 'D:\\presets\\standard\\agent.cordis.yml',
    })).toBe('["standard","system","D:\\\\presets\\\\standard\\\\agent.cordis.yml"]')
    expect(dshRc2PresetSourceKey({ id: 'standard' }))
      .not.toBe(dshRc2PresetSourceKey({ id: 'standard', trust: 'user' }))
  })

  it('rejects setup and ownership protocol misuse', async () => {
    const attempt = createDshRc2AgentBootstrapAttempt('protocol-misuse', {
      installModel: () => undefined,
      mountPreset: () => undefined,
    })
    const rawHandle = { agent: { id: 'protocol-misuse' }, dispose: vi.fn(async () => {}) }

    expect(() => attempt.ownHandle(rawHandle)).toThrow('before bootstrap commit')
    const commit = await attempt.setup({})
    await expect(attempt.setup({})).rejects.toThrow('setup already ran')
    commit.commit()
    const owned = attempt.ownHandle(rawHandle)
    expect(() => attempt.ownHandle(rawHandle)).toThrow('already owns a handle')
    await owned.dispose()
  })

  it('fails a malformed rc2 disposer before preset setup', async () => {
    const mountPreset = vi.fn()
    const attempt = createDshRc2AgentBootstrapAttempt('invalid-disposer', {
      installModel: () => ({ invalid: true }) as never,
      mountPreset,
    })

    await expect(attempt.setup({})).rejects.toThrow('returned an invalid disposer')
    expect(mountPreset).not.toHaveBeenCalled()
  })

  it('reports both Agent-handle and bootstrap cleanup failures', async () => {
    const handleFailure = new Error('handle cleanup failed')
    const bootstrapFailure = new Error('preset cleanup failed')
    const scopeFailure = new Error('scope cleanup failed')
    const attempt = createDshRc2AgentBootstrapAttempt('dual-cleanup-failure', {
      installModel: () => undefined,
      mountPreset: () => () => { throw bootstrapFailure },
    })
    const commit = await attempt.setup({})
    commit.commit()
    const handle = attempt.ownHandle({
      agent: { id: 'dual-cleanup-failure' },
      dispose: vi.fn(async () => { throw handleFailure }),
    }, vi.fn(async () => { throw scopeFailure }))

    const error = await handle.dispose().then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).message)
      .toBe('DSH rc2 Agent handle and bootstrap disposal failed')
    expect((error as AggregateError).errors[0]).toBe(handleFailure)
    expect((error as AggregateError).errors[1]).toBeInstanceOf(AggregateError)
    expect(((error as AggregateError).errors[1] as AggregateError).errors)
      .toContain(bootstrapFailure)
    expect((error as AggregateError).errors[2]).toBe(scopeFailure)
  })

  it('preserves a primary failure and aggregates a rollback failure', async () => {
    const primary = new Error('Agent factory failed')
    await expect(rollbackDshRc2AgentBootstrap(
      primary,
      { rollback: vi.fn(async () => {}) },
      'bootstrap rollback failed',
    )).rejects.toBe(primary)

    const rollbackFailure = new Error('cleanup failed')
    const error = await rollbackDshRc2AgentBootstrap(
      primary,
      { rollback: vi.fn(async () => { throw rollbackFailure }) },
      'bootstrap rollback failed',
    ).then(
      () => undefined,
      reason => reason as unknown,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).message).toBe('bootstrap rollback failed')
    expect((error as AggregateError).errors).toEqual([primary, rollbackFailure])
  })
})
