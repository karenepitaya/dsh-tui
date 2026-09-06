import { describe, expect, it } from 'vitest'
import {
  FeatureContributionContractError,
  normalizeFeatureContributions,
} from '../src/kernel/feature-contribution-normalizer.ts'
import {
  FEATURE_API_VERSION,
  type FeatureContributionDeclarations,
  type FeatureFactory,
} from '../src/kernel/feature.ts'
import {
  FeatureRegistry,
  type RegisteredFeatureSnapshot,
} from '../src/kernel/feature-registry.ts'

function registeredSnapshot(
  declarations: FeatureContributionDeclarations,
): RegisteredFeatureSnapshot {
  const factory: FeatureFactory = {
    manifest: {
      id: 'contract.feature',
      apiVersion: FEATURE_API_VERSION,
      scope: 'application',
      activation: 'eager',
      required: false,
      requires: [],
    },
    declarations,
    create: () => ({ contributions: {}, dispose() {} }),
  }
  const registry = new FeatureRegistry()
  registry.register(factory)
  return registry.snapshotOf(factory)!
}

function expectCode(
  snapshot: RegisteredFeatureSnapshot,
  input: unknown,
  code: FeatureContributionContractError['code'],
): void {
  expect(() => normalizeFeatureContributions(snapshot, input)).toThrowError(
    expect.objectContaining<Partial<FeatureContributionContractError>>({ code }),
  )
}

describe('normalizeFeatureContributions', () => {
  it('copies and freezes declared runtime topology while preserving opaque values', () => {
    const snapshot = registeredSnapshot({
      routes: ['route.main', 'route.optional'],
      commands: ['command.open'],
      keymaps: ['keymap.normal'],
      resources: ['resource.catalog'],
      surfaces: [{ slot: 'workspace.main', cardinality: 'single' }],
    })
    const routeValue = { kind: 'chat' }
    const commandValue = () => {}
    const keymapValue = { key: 'j' }
    const resourceValue = Promise.resolve('catalog')
    const surfaceValue = { render: true }
    const input = {
      routes: [{ id: 'route.main', value: routeValue, ignored: true }],
      commands: [{ id: 'command.open', value: commandValue }],
      keymaps: [{ id: 'keymap.normal', value: keymapValue }],
      resources: [{ id: 'resource.catalog', value: resourceValue }],
      surfaces: [{ id: 'surface.main', slot: 'workspace.main', value: surfaceValue }],
    }

    const result = normalizeFeatureContributions(snapshot, input)

    expect(result).toEqual({
      routes: [{ id: 'route.main', value: routeValue }],
      commands: [{ id: 'command.open', value: commandValue }],
      keymaps: [{ id: 'keymap.normal', value: keymapValue }],
      resources: [{ id: 'resource.catalog', value: resourceValue }],
      surfaces: [{ id: 'surface.main', slot: 'workspace.main', value: surfaceValue }],
    })
    expect(result).not.toBe(input)
    expect(result.routes?.[0]?.value).toBe(routeValue)
    expect(result.commands?.[0]?.value).toBe(commandValue)
    expect(Object.isFrozen(result)).toBe(true)
    for (const collection of Object.values(result)) {
      expect(Object.isFrozen(collection)).toBe(true)
      expect(Object.isFrozen(collection[0])).toBe(true)
    }
    expect(Object.isFrozen(routeValue)).toBe(false)
  })

  it('allows declarations to be a strict superset and preserves omitted collections', () => {
    const snapshot = registeredSnapshot({
      routes: ['route.main', 'route.optional'],
    })

    expect(normalizeFeatureContributions(snapshot, {
      routes: [{ id: 'route.main', value: true }],
    })).toEqual({ routes: [{ id: 'route.main', value: true }] })
    expect(normalizeFeatureContributions(snapshot, {})).toEqual({})
  })

  it('rejects malformed envelopes, collections, entries, and ids', () => {
    const snapshot = registeredSnapshot({ routes: ['route.main'] })
    const cases: readonly [unknown, FeatureContributionContractError['code']][] = [
      [null, 'invalid-envelope'],
      [[], 'invalid-envelope'],
      [{ mystery: [] }, 'unknown-contribution-kind'],
      [{ routes: {} }, 'invalid-collection'],
      [{ routes: [null] }, 'invalid-contribution'],
      [{ routes: [{ id: 'route.main' }] }, 'invalid-contribution'],
      [{ routes: [{ id: 1, value: true }] }, 'invalid-id'],
      [{ routes: [{ id: '', value: true }] }, 'invalid-id'],
      [{ routes: [{ id: ' route.main ', value: true }] }, 'invalid-id'],
      [{ routes: [{ id: 'route.undeclared', value: true }] }, 'undeclared-contribution'],
      [{
        routes: [
          { id: 'route.main', value: true },
          { id: 'route.main', value: false },
        ],
      }, 'duplicate-contribution'],
    ]

    for (const [input, code] of cases) expectCode(snapshot, input, code)
  })

  it('rejects malformed, undeclared, and duplicate runtime surfaces', () => {
    const snapshot = registeredSnapshot({
      surfaces: [
        { slot: 'workspace.main', cardinality: 'single' },
        { slot: 'workspace.secondary', cardinality: 'multiple' },
      ],
    })
    const cases: readonly [unknown, FeatureContributionContractError['code']][] = [
      [{ surfaces: [{ id: 'surface', slot: 1, value: true }] }, 'invalid-slot'],
      [{ surfaces: [{ id: 'surface', slot: '', value: true }] }, 'invalid-slot'],
      [{ surfaces: [{ id: 'surface', slot: ' workspace.main ', value: true }] }, 'invalid-slot'],
      [{ surfaces: [{ id: 'surface', slot: 'workspace.rogue', value: true }] }, 'undeclared-slot'],
      [{
        surfaces: [
          { id: 'surface', slot: 'workspace.main', value: true },
          { id: 'surface', slot: 'workspace.secondary', value: false },
        ],
      }, 'duplicate-contribution'],
    ]

    for (const [input, code] of cases) expectCode(snapshot, input, code)

    expect(normalizeFeatureContributions(snapshot, {
      surfaces: [
        { id: 'surface.first', slot: 'workspace.secondary', value: true },
        { id: 'surface.second', slot: 'workspace.secondary', value: false },
      ],
    })).toMatchObject({
      surfaces: [
        { id: 'surface.first', slot: 'workspace.secondary', value: true },
        { id: 'surface.second', slot: 'workspace.secondary', value: false },
      ],
    })
  })
})
