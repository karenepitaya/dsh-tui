import { describe, expect, it } from 'vitest'
import {
  ShutdownCoordinator,
  type ShutdownHooks,
} from '../src/internal.ts'

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function hooks(
  trace: string[],
  overrides: Partial<ShutdownHooks> = {},
): ShutdownHooks {
  return {
    stopAcceptingInput: () => { trace.push('stop-input') },
    settleInteractions: () => { trace.push('settle-interactions') },
    cancelAgent: () => { trace.push('cancel-agent') },
    whenAgentIdle: () => { trace.push('wait-agent-idle') },
    flushSession: () => { trace.push('flush-session') },
    disposeRuntime: () => { trace.push('dispose-runtime') },
    restoreTerminal: () => { trace.push('restore-terminal') },
    requestAppExit: () => { trace.push('request-app-exit') },
    forceExit: () => { trace.push('force-exit') },
    ...overrides,
  }
}

describe('ShutdownCoordinator', () => {
  it('runs graceful shutdown in order and shares one promise', async () => {
    const trace: string[] = []
    const coordinator = new ShutdownCoordinator(hooks(trace))
    expect(coordinator.currentState).toBe('running')
    const first = coordinator.graceful()
    const second = coordinator.graceful()
    expect(second).toBe(first)
    await expect(first).resolves.toEqual({ mode: 'graceful', issues: [] })
    expect(coordinator.currentState).toBe('stopped')
    expect(trace).toEqual([
      'stop-input',
      'settle-interactions',
      'cancel-agent',
      'wait-agent-idle',
      'flush-session',
      'dispose-runtime',
      'restore-terminal',
      'request-app-exit',
    ])
    await expect(coordinator.interrupt()).resolves.toEqual({ mode: 'graceful', issues: [] })
  })

  it('contains failures and continues every graceful cleanup phase', async () => {
    const trace: string[] = []
    const coordinator = new ShutdownCoordinator(hooks(trace, {
      settleInteractions: () => {
        trace.push('settle-interactions')
        throw new Error('settlement failed')
      },
      flushSession: async () => {
        trace.push('flush-session')
        throw new Error('flush failed')
      },
    }))

    const result = await coordinator.graceful()
    expect(result.mode).toBe('graceful')
    expect(result.issues.map(issue => issue.phase)).toEqual([
      'settle-interactions',
      'flush-session',
    ])
    expect(trace.at(-1)).toBe('request-app-exit')
  })

  it('uses a second interrupt to force a stuck graceful phase', async () => {
    const trace: string[] = []
    const idle = deferred()
    const coordinator = new ShutdownCoordinator(hooks(trace, {
      whenAgentIdle: () => {
        trace.push('wait-agent-idle')
        return idle.promise
      },
    }))

    const first = coordinator.interrupt()
    await viWaitFor(() => trace.includes('wait-agent-idle'))
    const second = coordinator.interrupt()
    await expect(second).resolves.toMatchObject({ mode: 'forced' })
    await expect(first).resolves.toMatchObject({ mode: 'forced' })
    expect(trace).toEqual([
      'stop-input',
      'settle-interactions',
      'cancel-agent',
      'wait-agent-idle',
      'restore-terminal',
      'force-exit',
    ])
    idle.resolve()
  })

  it('makes direct force idempotent and captures terminal/force failures', async () => {
    const trace: string[] = []
    const coordinator = new ShutdownCoordinator(hooks(trace, {
      settleInteractions: () => {
        trace.push('settle-interactions')
        throw new Error('settlement failed')
      },
      restoreTerminal: () => {
        trace.push('restore-terminal')
        throw new Error('terminal failed')
      },
      forceExit: async () => {
        trace.push('force-exit')
        throw new Error('force failed')
      },
    }))
    const first = coordinator.force()
    const second = coordinator.force()
    expect(second).toBe(first)
    const result = await first
    expect(result).toMatchObject({ mode: 'forced' })
    expect(result.issues.map(issue => issue.phase)).toEqual([
      'settle-interactions',
      'restore-terminal',
      'force-exit',
    ])
    expect(trace).toEqual([
      'settle-interactions',
      'restore-terminal',
      'force-exit',
    ])
    expect(coordinator.currentState).toBe('stopped')
    await expect(coordinator.graceful()).resolves.toBe(result)
    await expect(coordinator.interrupt()).resolves.toBe(result)
  })
})

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition was not reached')
}
