import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CapabilityToken } from '../src/kernel/capability.ts'
import {
  createStandaloneApplicationScopeHost,
  runtimeSessionScopeOf,
  type ApplicationScopeHost,
} from '../src/lifecycle/application-scope-host.ts'
import type { ResourceScope } from '../src/lifecycle/scope-manager.ts'
import type { DshRuntimePort } from '../src/runtime/port.ts'
import { runtimeSessionCapabilitiesOf } from '../src/runtime/runtime-session.ts'
import type {
  SessionCapabilityFactoryRegistry,
  SessionCapabilityLease,
} from '../src/runtime/session-capability.ts'
import type {
  DshInteractionHub,
  DshInteractionSession,
} from '../src/dsh/interaction-hub.ts'
import {
  DshSessionCorePort,
} from '../src/dsh/session-capability-factories.ts'
import {
  DshSessionPortComposer,
  type PreparedDshSessionPort,
} from '../src/dsh/session-port-composer.ts'

function agent(sessionId: string): Agent {
  return {
    id: sessionId,
    session: { id: sessionId },
  } as unknown as Agent
}

function interaction(sessionId: string, dispose = vi.fn()): DshInteractionSession {
  return {
    sessionId,
    interactions: vi.fn(() => Object.freeze({}) as AsyncIterable<never>),
    respond: vi.fn(() => ({ accepted: false as const, reason: 'not-pending' as const })),
    disposeInteractions: dispose,
  } as unknown as DshInteractionSession
}

function scope(options: {
  readonly defer?: ResourceScope['defer']
  readonly dispose?: ResourceScope['dispose']
} = {}): ResourceScope {
  return {
    kind: 'session',
    disposed: false,
    signal: new AbortController().signal,
    defer: options.defer ?? vi.fn(() => async () => {}),
    dispose: options.dispose ?? vi.fn(async () => {}),
  } as unknown as ResourceScope
}

function capabilityBinding(
  core: DshSessionCorePort,
  ownedScope: ResourceScope,
  options: {
    readonly acquire?: SessionCapabilityLease<DshSessionCorePort>['acquire']
    readonly release?: SessionCapabilityLease<DshSessionCorePort>['release']
  } = {},
): SessionCapabilityLease<DshSessionCorePort> {
  return {
    core,
    scope: ownedScope,
    acquire: options.acquire ?? vi.fn(async <TValue>(_token: CapabilityToken<TValue>) => {
      throw new Error('optional capability unavailable')
    }),
    release: options.release ?? vi.fn(async () => {}),
  }
}

function runtime(
  sessionId: string,
  options: {
    readonly dispose?: DshRuntimePort['dispose']
    readonly ownsAgentLifecycle?: boolean | (() => boolean)
  } = {},
): DshRuntimePort {
  const port = {
    sessionId,
    events: vi.fn(() => Object.freeze({}) as AsyncIterable<never>),
    submit: vi.fn(async () => ({ inputId: 'input-1' })),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    dispose: options.dispose ?? vi.fn(async () => {}),
  }
  Object.defineProperty(port, 'ownsAgentLifecycle', {
    enumerable: true,
    get: typeof options.ownsAgentLifecycle === 'function'
      ? options.ownsAgentLifecycle
      : () => options.ownsAgentLifecycle ?? false,
  })
  return port as unknown as DshRuntimePort
}

function composer(options: {
  readonly attach?: DshInteractionHub['attach']
  readonly bind?: SessionCapabilityFactoryRegistry<DshSessionCorePort>['bind']
  readonly createScope?: ApplicationScopeHost['createRuntimeSessionScope']
} = {}): DshSessionPortComposer {
  const hub = {
    attach: options.attach ?? vi.fn(() => interaction('default')),
  } as unknown as DshInteractionHub
  const scopes = {
    appScope: scope() as never,
    createRuntimeSessionScope: options.createScope ?? vi.fn(() => scope()),
  } satisfies ApplicationScopeHost
  const registry = {
    bind: options.bind ?? vi.fn(() => { throw new Error('unexpected bind') }),
  } as unknown as SessionCapabilityFactoryRegistry<DshSessionCorePort>
  return new DshSessionPortComposer(hub, scopes, registry)
}

function prepared(
  sessionId: string,
  release: SessionCapabilityLease<DshSessionCorePort>['release'] = vi.fn(async () => {}),
): {
  readonly value: PreparedDshSessionPort
  readonly binding: SessionCapabilityLease<DshSessionCorePort>
  readonly scope: ResourceScope
} {
  const ownedScope = scope()
  const core = new DshSessionCorePort(agent(sessionId), interaction(sessionId))
  const binding = capabilityBinding(core, ownedScope, { release })
  return { value: { core, capabilities: binding }, binding, scope: ownedScope }
}

describe('DSH session port composer rollback', () => {
  it('owns standalone session scopes through the default application teardown', async () => {
    const host = createStandaloneApplicationScopeHost('composer-standalone')
    const sessionScope = host.createRuntimeSessionScope('owned-session')

    await host.dispose()

    expect(host.appScope.disposed).toBe(true)
    expect(sessionScope.disposed).toBe(true)
  })

  it('disposes the unpublished interaction and scope when binding fails', async () => {
    const rawFailure = new Error('bind failed')
    const disposeInteractions = vi.fn(() => { throw new Error('interaction cleanup failed') })
    const disposeScope = vi.fn(async () => { throw new Error('scope cleanup failed') })
    const ownedScope = scope({ dispose: disposeScope })
    const value = composer({
      attach: vi.fn(() => interaction('prepare-failure', disposeInteractions)),
      bind: vi.fn(() => { throw rawFailure }),
      createScope: vi.fn(() => ownedScope),
    })

    expect(value.createSessionScope('prepare-failure')).toBe(ownedScope)
    await expect(value.prepare(agent('prepare-failure'), ownedScope)).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [rawFailure, expect.any(Error), expect.any(Error)],
    })
    expect(disposeInteractions).toHaveBeenCalledOnce()
    expect(disposeScope).toHaveBeenCalledWith('DSH unpublished capability setup failed')
  })

  it('rethrows the original setup error when no rollback step fails', async () => {
    const rawFailure = new Error('attach failed')
    const disposeScope = vi.fn(async () => {})
    const value = composer({
      attach: vi.fn(() => { throw rawFailure }),
    })

    await expect(value.prepare(
      agent('attach-failure'),
      scope({ dispose: disposeScope }),
    )).rejects.toBe(rawFailure)
    expect(disposeScope).toHaveBeenCalledOnce()
  })

  it('releases a bound capability lease when scope publication fails', async () => {
    const publicationFailure = new Error('scope publication failed')
    const releaseFailure = new Error('binding cleanup failed')
    const release = vi.fn(async () => { throw releaseFailure })
    const ownedScope = scope({
      defer: vi.fn(() => { throw publicationFailure }),
    })
    const value = composer({
      attach: vi.fn(() => interaction('publication-failure')),
      bind: vi.fn((core: DshSessionCorePort) => capabilityBinding(
        core,
        ownedScope,
        { release },
      )),
    })

    await expect(value.prepare(agent('publication-failure'), ownedScope)).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [publicationFailure, releaseFailure],
    })
    expect(release).toHaveBeenCalledWith('DSH unpublished capability setup failed')
  })

  it('rolls back both the prepared binding and an unattached runtime', async () => {
    const releaseFailure = new Error('binding release failed')
    const runtimeFailure = new Error('runtime release failed')
    const release = vi.fn(async () => { throw releaseFailure })
    const dispose = vi.fn(async () => { throw runtimeFailure })
    const state = prepared('expected-session', release)
    const value = composer()

    await expect(value.completeSession(
      state.value,
      runtime('different-session', { dispose }),
    )).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.any(Error), releaseFailure, runtimeFailure],
    })
    expect(release).toHaveBeenCalledWith('DSH session composition failed')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not dispose a runtime after ownership transferred to the core', async () => {
    const constructionFailure = new Error('lease construction failed')
    const release = vi.fn(async () => {})
    const state = prepared('transferred-session', release)
    let capabilityReads = 0
    const unstable = {
      core: state.value.core,
      get capabilities() {
        capabilityReads += 1
        if (capabilityReads === 1) throw constructionFailure
        return state.binding
      },
    } as PreparedDshSessionPort
    const dispose = vi.fn(async () => {})

    await expect(composer().completeSession(
      unstable,
      runtime('transferred-session', { dispose }),
    )).rejects.toBe(constructionFailure)
    expect(release).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
  })
})

describe('DSH session port composer compatibility projection', () => {
  it('exposes the runtime scope and rolls back a failed legacy projection', async () => {
    const projectionFailure = new Error('legacy projection failed')
    const release = vi.fn(async () => {})
    const state = prepared('legacy-failure', release)
    const value = composer()
    const session = await value.completeSession(
      state.value,
      runtime('legacy-failure'),
    )
    expect(runtimeSessionScopeOf(session)).toBe(state.scope)
    expect(runtimeSessionCapabilitiesOf(session)).toBe(session.capabilities)
    await expect(session.capabilities.acquire({} as CapabilityToken<never>)).rejects.toThrow(
      'optional capability unavailable',
    )
    await value.release(state.value, 'explicit prepared release')
    expect(release).toHaveBeenCalledWith('explicit prepared release')
    await value.disposeSessions()

    const next = prepared('legacy-direct-failure', release)
    await expect(composer().complete(
      next.value,
      runtime('legacy-direct-failure', {
        ownsAgentLifecycle: () => { throw projectionFailure },
      }),
    )).rejects.toBe(projectionFailure)
    expect(release).toHaveBeenCalledWith('DSH legacy session projection failed')
  })

  it('aggregates a legacy projection failure with its rollback failure', async () => {
    const projectionFailure = new Error('legacy projection failed')
    const releaseFailure = new Error('legacy rollback failed')
    const release = vi.fn(async () => { throw releaseFailure })
    const state = prepared('legacy-aggregate', release)

    await expect(composer().complete(
      state.value,
      runtime('legacy-aggregate', {
        ownsAgentLifecycle: () => { throw projectionFailure },
      }),
    )).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [projectionFailure, releaseFailure],
    })
  })

  it('aggregates active session release failures during adapter disposal', async () => {
    const releaseFailure = new Error('active binding release failed')
    const release = vi.fn(async () => { throw releaseFailure })
    const ownedScope = scope()
    const value = composer({
      attach: vi.fn(() => interaction('active-session')),
      bind: vi.fn((core: DshSessionCorePort) => capabilityBinding(
        core,
        ownedScope,
        { release },
      )),
    })
    await value.prepare(agent('active-session'), ownedScope)

    await expect(value.disposeSessions()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [releaseFailure],
    })
    expect(release).toHaveBeenCalledWith('DSH-TUI runtime adapter disposed')
  })
})
