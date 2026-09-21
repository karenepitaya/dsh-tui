import { describe, expect, it, vi } from 'vitest'
import {
  FeatureHostContractError,
  normalizeDshTuiFeatureContributions,
} from '../src/app/feature-contribution-contract.ts'
import {
  FeatureRegistry,
  type FeatureRegistrationProvenance,
  type RegisteredFeatureSnapshot,
} from '../src/kernel/feature-registry.ts'
import {
  FEATURE_API_VERSION,
  type FeatureContributionDeclarations,
  type FeatureContributions,
} from '../src/kernel/feature.ts'
import type { ResourceDefinition } from '../src/resource/resource-coordinator.ts'

function snapshot(
  id = 'product.feature',
  declarations: FeatureContributionDeclarations = {
    routes: ['chat', 'workspace'],
    commands: ['run'],
    keymaps: ['keys'],
    resources: ['data'],
    surfaces: [{ slot: 'shell.root', cardinality: 'multiple' }],
  },
): RegisteredFeatureSnapshot {
  const registry = new FeatureRegistry()
  const factory = {
    manifest: {
      id,
      apiVersion: FEATURE_API_VERSION,
      scope: 'application' as const,
      activation: 'eager' as const,
      required: true,
      requires: [],
    },
    declarations,
    create: () => ({ contributions: {}, dispose() {} }),
  }
  registry.register(factory, { authority: 'core' })
  return registry.snapshotOf(factory)!
}

const CORE: FeatureRegistrationProvenance = Object.freeze({
  authority: 'core',
  required: true,
})
const EXTENSION: FeatureRegistrationProvenance = Object.freeze({
  authority: 'extension',
  required: false,
})

function normalize(
  contributions: FeatureContributions,
  provenance = CORE,
  feature = snapshot(),
): FeatureContributions {
  return normalizeDshTuiFeatureContributions(feature, contributions, provenance)
}

describe('DSH-TUI feature contribution contract', () => {
  it('validates keymap context, declared commands, modifiers, and duplicate chords', () => {
    const context = { routeKind: 'workspace', featureId: 'product.feature', mode: 'normal' }
    const binding = { key: 'r', commandId: 'run' }
    for (const value of [
      null, true, {}, { context: null },
      { context: { ...context, routeKind: 'unknown' }, bindings: [binding] },
      { context: { ...context, featureId: 'other' }, bindings: [binding] },
      { context: { ...context, mode: 'other' }, bindings: [binding] },
      { context, bindings: null }, { context, bindings: [] },
      ...[null, true, { ...binding, key: '' }, { ...binding, commandId: '' },
        { ...binding, commandId: 'undeclared' }, { ...binding, ctrl: false },
        { ...binding, alt: false }, { ...binding, shift: false }]
        .map(candidate => ({ context, bindings: [candidate] })),
      { context, bindings: [binding, binding] },
    ]) {
      expect(() => normalize({ keymaps: [{ id: 'keys', value }] }))
        .toThrowError(expect.objectContaining({ code: 'invalid-keymap' }))
    }
    const modified = { ...binding, ctrl: true, alt: true, shift: true }
    for (const routeKind of ['chat', 'workspace']) {
      const value = { context: { ...context, routeKind, mode: 'insert' }, bindings: [binding, modified] }
      const result = normalize({ keymaps: [{ id: 'keys', value }] })
      expect(result.keymaps?.[0]?.value).toEqual(value)
    }
  })

  it('normalizes every product value while preserving opaque resource values', () => {
    const handle = vi.fn()
    const keymap = {
      context: { routeKind: 'workspace', featureId: 'product.feature', mode: 'normal' },
      bindings: [{ key: 'j', commandId: 'run' }],
    }
    const resource: ResourceDefinition<string> = {
      key: 'data',
      lifetime: 'surface',
      activation: 'on-visible',
      cachePolicy: 'last-good',
      load: () => 'value',
    }
    const result = normalize({
      routes: [
        { id: 'chat', value: { kind: 'chat', ignored: true } },
        {
          id: 'workspace',
          value: { kind: 'workspace', featureId: 'product.feature', pane: 'inspector' },
        },
      ],
      commands: [{ id: 'run', value: { handle } }],
      keymaps: [{ id: 'keys', value: keymap }],
      resources: [{ id: 'data', value: resource }],
      surfaces: [
        {
          id: 'main',
          slot: 'shell.root',
          value: { id: 'main', role: 'content', node: { id: 'node' } },
        },
        {
          id: 'side',
          slot: 'shell.root',
          value: {
            id: 'side',
            role: 'inspector',
            node: null,
            constraints: { minColumns: 20, preferredColumns: 40, priority: 1 },
          },
        },
      ],
    })

    expect(result.routes).toEqual([
      { id: 'chat', value: { kind: 'chat' } },
      {
        id: 'workspace',
        value: { kind: 'workspace', featureId: 'product.feature', pane: 'inspector' },
      },
    ])
    expect(result.commands?.[0]?.value).toEqual({ handle })
    expect(result.keymaps?.[0]?.value).toEqual(keymap)
    expect(Object.isFrozen(result.keymaps?.[0]?.value)).toBe(true)
    expect(result.resources?.[0]?.value).toBe(resource)
    expect(result.surfaces?.[1]?.value).toMatchObject({
      id: 'side',
      role: 'inspector',
      constraints: { minColumns: 20, preferredColumns: 40, priority: 1 },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.routes)).toBe(true)
    expect(Object.isFrozen(result.routes?.[0])).toBe(true)
    expect(Object.isFrozen(result.surfaces?.[1]?.value)).toBe(true)
    expect(Object.isFrozen((result.surfaces?.[1]?.value as { constraints: object }).constraints))
      .toBe(true)
  })

  it('validates ResourceDefinition semantics without executing its loader or watcher', () => {
    const load = vi.fn(() => 'value')
    const watch = vi.fn()
    const resource: ResourceDefinition<string> = {
      key: 'data',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'none',
      load,
      watch,
    }

    expect(normalize({ resources: [{ id: 'data', value: resource }] }).resources)
      .toEqual([{ id: 'data', value: resource }])
    expect(load).not.toHaveBeenCalled()
    expect(watch).not.toHaveBeenCalled()

    const eager: ResourceDefinition<string> = {
      key: 'data',
      lifetime: 'session',
      activation: 'eager',
      cachePolicy: 'last-good',
      load,
    }
    expect(normalize({ resources: [{ id: 'data', value: eager }] }).resources?.[0]?.value)
      .toBe(eager)
    expect(load).not.toHaveBeenCalled()
  })

  it.each([
    ['primitive', null],
    ['mismatched key', { key: 'other', lifetime: 'surface', activation: 'on-open', cachePolicy: 'none', load() {} }],
    ['invalid lifetime', { key: 'data', lifetime: 'request', activation: 'on-open', cachePolicy: 'none', load() {} }],
    ['invalid activation', { key: 'data', lifetime: 'surface', activation: 'sometimes', cachePolicy: 'none', load() {} }],
    ['invalid cache policy', { key: 'data', lifetime: 'surface', activation: 'on-open', cachePolicy: 'forever', load() {} }],
    ['missing loader', { key: 'data', lifetime: 'surface', activation: 'on-open', cachePolicy: 'none' }],
    ['invalid watcher', { key: 'data', lifetime: 'surface', activation: 'on-open', cachePolicy: 'none', load() {}, watch: true }],
    ['non-surface visible lifetime', { key: 'data', lifetime: 'session', activation: 'on-visible', cachePolicy: 'none', load() {} }],
  ] as const)('rejects %s resource definitions', (_label, value) => {
    expect(() => normalize({ resources: [{ id: 'data', value }] }))
      .toThrowError(expect.objectContaining({ code: 'invalid-resource' }))
  })

  it('preserves an empty contribution envelope without inventing collections', () => {
    expect(normalize({})).toEqual({})
  })

  it('rejects multiple runtime surfaces for one declared single slot', () => {
    const feature = snapshot('single.surface', {
      surfaces: [{ slot: 'workspace.primary', cardinality: 'single' }],
    })
    expect(() => normalize({
      surfaces: [
        {
          id: 'first',
          slot: 'workspace.primary',
          value: { id: 'first', role: 'content', node: {} },
        },
        {
          id: 'second',
          slot: 'workspace.primary',
          value: { id: 'second', role: 'content', node: {} },
        },
      ],
    }, CORE, feature)).toThrowError(expect.objectContaining({
      code: 'single-slot-overflow',
      featureId: 'single.surface',
    }))
  })

  it.each([
    ['primitive', null, 'invalid-route'],
    ['unknown kind', { kind: 'other' }, 'invalid-route'],
    ['invalid workspace owner', { kind: 'workspace', featureId: 'other', pane: 'content' }, 'route-owner-mismatch'],
    ['untrimmed feature id', { kind: 'workspace', featureId: ' bad ', pane: 'content' }, 'invalid-route'],
    ['invalid workspace pane', { kind: 'workspace', featureId: 'product.feature', pane: 'other' }, 'invalid-route'],
  ] as const)('rejects %s route values', (_label, value, code) => {
    expect(() => normalize({ routes: [{ id: 'workspace', value }] })).toThrowError(
      expect.objectContaining({ name: 'FeatureHostContractError', code }),
    )
  })

  it('keeps Chat ownership private to core composition', () => {
    expect(() => normalize(
      { routes: [{ id: 'chat', value: { kind: 'chat' } }] },
      EXTENSION,
    )).toThrowError(expect.objectContaining({ code: 'route-owner-mismatch' }))
  })

  it.each([null, {}, { handle: 'not-a-function' }])(
    'rejects invalid command handler %j',
    (value) => {
      expect(() => normalize({ commands: [{ id: 'run', value }] })).toThrowError(
        expect.objectContaining({ code: 'invalid-command' }),
      )
    },
  )

  it.each([
    ['primitive', null],
    ['missing id', { role: 'content', node: true }],
    ['mismatched id', { id: 'other', role: 'content', node: true }],
    ['invalid role', { id: 'main', role: 'unknown', node: true }],
    ['missing node', { id: 'main', role: 'content' }],
  ] as const)('rejects %s surface values', (_label, value) => {
    expect(() => normalize({
      surfaces: [{ id: 'main', slot: 'shell.root', value }],
    })).toThrowError(expect.objectContaining({ code: 'invalid-surface' }))
  })

  it('exposes stable contract error identity and details', () => {
    const error = new FeatureHostContractError(
      'missing-route',
      'feature',
      'route',
      'missing',
    )
    expect(error).toMatchObject({
      name: 'FeatureHostContractError',
      code: 'missing-route',
      featureId: 'feature',
      contributionId: 'route',
      message: 'missing',
    })
  })
})
