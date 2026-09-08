import { describe, expect, it, vi } from 'vitest'
import {
  createFeatureRouteCommandBridge,
  type FeatureRouteCommandHost,
  type FeatureRouteCommandSource,
} from '../src/app/feature-route-command-bridge.ts'
import type { DshCommandDescriptor } from '../src/command/port.ts'

function projectedRoute(
  id: string,
  featureId = id,
): FeatureRouteCommandSource {
  return Object.freeze({ id, featureId })
}

function official(...names: readonly string[]): readonly DshCommandDescriptor[] {
  return names.map(name => Object.freeze({ name, description: `Official ${name}` }))
}

describe('feature route command bridge', () => {
  it('projects unique safe main routes into deterministic local menu candidates', () => {
    const bridge = createFeatureRouteCommandBridge([
      projectedRoute('sessions.inspector', 'sessions'),
      projectedRoute('z_route'),
      projectedRoute('sessions'),
      projectedRoute('diff'),
      projectedRoute('a-route'),
      projectedRoute('BadRoute'),
      projectedRoute('2fast'),
      projectedRoute('has space'),
      projectedRoute('你好'),
    ], official())

    expect(bridge.candidates).toEqual([
      {
        origin: 'local',
        command: { name: 'a-route', description: 'Open a-route' },
      },
      {
        origin: 'local',
        command: { name: 'diff', description: 'Open diff' },
      },
      {
        origin: 'local',
        command: { name: 'sessions', description: 'Open sessions' },
      },
      {
        origin: 'local',
        command: { name: 'z_route', description: 'Open z_route' },
      },
    ])
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.isFrozen(bridge.candidates)).toBe(true)
    expect(Object.isFrozen(bridge.candidates[0])).toBe(true)
    expect(Object.isFrozen(bridge.candidates[0]?.command)).toBe(true)
    expect(createFeatureRouteCommandBridge([
      projectedRoute('a'),
      projectedRoute('b'),
    ], official()).candidates.map(candidate => candidate.command.name)).toEqual(['a', 'b'])
    expect(createFeatureRouteCommandBridge([
      projectedRoute('b'),
      projectedRoute('a'),
    ], official()).candidates.map(candidate => candidate.command.name)).toEqual(['a', 'b'])
  })

  it('cedes occupied official names and rejects ambiguous duplicate route commands', () => {
    const bridge = createFeatureRouteCommandBridge([
      projectedRoute('sessions'),
      projectedRoute('diff', 'diff-a'),
      projectedRoute('unique'),
      projectedRoute('diff', 'diff-b'),
      projectedRoute('official-route'),
    ], official('sessions', 'official-route'))
    const host: FeatureRouteCommandHost = { openRoute: vi.fn(async () => {}) }

    expect(bridge.candidates.map(candidate => candidate.command.name)).toEqual(['unique'])
    expect(bridge.tryOpen('/sessions', host)).toEqual({ kind: 'not-feature-route' })
    expect(bridge.tryOpen('/diff', host)).toEqual({ kind: 'not-feature-route' })
    expect(bridge.tryOpen('/official-route', host)).toEqual({ kind: 'not-feature-route' })
    expect(host.openRoute).not.toHaveBeenCalled()
  })

  it('opens only an exact exposed route command and returns its completion', async () => {
    let resolveOpen!: () => void
    const completion = new Promise<void>((resolve) => { resolveOpen = resolve })
    const host: FeatureRouteCommandHost = {
      openRoute: vi.fn(() => completion),
    }
    const bridge = createFeatureRouteCommandBridge(
      [projectedRoute('sessions'), projectedRoute('diff')],
      official(),
    )

    const dispatched = bridge.tryOpen('/sessions', host)

    expect(dispatched).toMatchObject({
      kind: 'opened',
      routeId: 'sessions',
      completion,
    })
    expect(Object.isFrozen(dispatched)).toBe(true)
    expect(host.openRoute).toHaveBeenCalledExactlyOnceWith('sessions')
    resolveOpen()
    if (dispatched.kind === 'opened') await expect(dispatched.completion).resolves.toBeUndefined()
  })

  it('distinguishes known route arguments from unrelated command input', () => {
    const host: FeatureRouteCommandHost = { openRoute: vi.fn(async () => {}) }
    const bridge = createFeatureRouteCommandBridge(
      [projectedRoute('sessions')],
      official(),
    )

    const invalid = bridge.tryOpen('/sessions extra', host)
    expect(invalid).toEqual({
      kind: 'invalid-input',
      routeId: 'sessions',
      command: bridge.candidates[0]?.command,
    })
    expect(Object.isFrozen(invalid)).toBe(true)
    expect(bridge.tryOpen('/sessions\t', host).kind).toBe('invalid-input')
    expect(bridge.tryOpen('/sessions\n', host).kind).toBe('invalid-input')
    expect(bridge.tryOpen('/sessions\r', host).kind).toBe('invalid-input')
    expect(bridge.tryOpen('/sessions-but-longer', host)).toEqual({ kind: 'not-feature-route' })
    expect(bridge.tryOpen('/sessions.content', host)).toEqual({ kind: 'not-feature-route' })
    expect(bridge.tryOpen('/unknown extra', host)).toEqual({ kind: 'not-feature-route' })
    expect(bridge.tryOpen('sessions', host)).toEqual({ kind: 'not-feature-route' })
    expect(host.openRoute).not.toHaveBeenCalled()
  })
})
