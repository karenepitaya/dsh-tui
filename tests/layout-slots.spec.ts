import { describe, expect, it } from 'vitest'
import {
  contributeToSlot,
  createDshTuiSlotDefinitions,
  createSlotRegistry,
  DSH_TUI_SLOT_DEFINITIONS,
  registerSlot,
  removeFeatureContributions,
  resolveSlot,
} from '../src/layout/slots.ts'

describe('layout slot registry', () => {
  it('publishes the complete protected shell and public surface catalog', () => {
    expect(DSH_TUI_SLOT_DEFINITIONS).toEqual([
      { id: 'shell.root', cardinality: 'single', protection: 'protected' },
      { id: 'shell.composer', cardinality: 'single', protection: 'protected' },
      { id: 'shell.interaction', cardinality: 'single', protection: 'protected' },
      { id: 'workspace.navigator', cardinality: 'list', protection: 'public' },
      { id: 'workspace.content', cardinality: 'list', protection: 'public' },
      { id: 'workspace.inspector', cardinality: 'list', protection: 'public' },
      { id: 'shell.status', cardinality: 'list', protection: 'public' },
      { id: 'shell.overlay', cardinality: 'list', protection: 'public' },
    ])

    for (const slot of DSH_TUI_SLOT_DEFINITIONS) {
      expect(Object.isFrozen(slot)).toBe(true)
    }
  })

  it('allows multiple Features in every public semantic surface slot', () => {
    for (const slotId of [
      'workspace.navigator',
      'workspace.content',
      'workspace.inspector',
      'shell.status',
      'shell.overlay',
    ]) {
      let registry = createSlotRegistry<string>()
      registry = contributeToSlot(registry, {
        slotId,
        featureId: 'sessions',
        authority: 'extension',
        value: `${slotId}:sessions`,
      })
      registry = contributeToSlot(registry, {
        slotId,
        featureId: 'diff',
        authority: 'extension',
        value: `${slotId}:diff`,
      })
      expect(resolveSlot(registry, slotId)).toEqual([
        `${slotId}:sessions`,
        `${slotId}:diff`,
      ])
    }
  })

  it('accepts an identical built-in declaration but rejects a conflicting override', () => {
    expect(createDshTuiSlotDefinitions([{
      id: 'workspace.content',
      cardinality: 'list',
      protection: 'public',
    }])).toEqual(DSH_TUI_SLOT_DEFINITIONS)
    expect(() => createDshTuiSlotDefinitions([{
      id: 'workspace.content',
      cardinality: 'single',
      protection: 'public',
    }])).toThrow('Duplicate slot id: workspace.content')
  })

  it('protects root, composer, and safety interaction slots from extensions', () => {
    const registry = createSlotRegistry()
    for (const slotId of ['shell.root', 'shell.composer', 'shell.interaction']) {
      expect(() => contributeToSlot(registry, {
        slotId,
        featureId: 'third-party',
        authority: 'extension',
        value: slotId,
      })).toThrow(`Protected slot rejects extension contribution: ${slotId}`)
    }

    const withRoot = contributeToSlot(registry, {
      slotId: 'shell.root',
      featureId: 'product',
      authority: 'core',
      value: 'app-shell',
    })
    expect(resolveSlot(withRoot, 'shell.root')).toEqual(['app-shell'])
  })

  it('fails immediately when a single slot gets a second contribution', () => {
    let registry = registerSlot(createSlotRegistry(), {
      id: 'feature.primary',
      cardinality: 'single',
      protection: 'public',
    })
    registry = contributeToSlot(registry, {
      slotId: 'feature.primary',
      featureId: 'sessions',
      authority: 'extension',
      value: 'sessions-surface',
    })
    expect(() => contributeToSlot(registry, {
      slotId: 'feature.primary',
      featureId: 'diff',
      authority: 'extension',
      value: 'diff-surface',
    })).toThrow('Single slot already has a contribution: feature.primary')
  })

  it('keeps list contributions ordered and removes one feature without mutation', () => {
    let registry = registerSlot(createSlotRegistry(), {
      id: 'workspace.tools',
      cardinality: 'list',
      protection: 'public',
    })
    registry = contributeToSlot(registry, {
      slotId: 'workspace.tools',
      featureId: 'sessions',
      authority: 'extension',
      value: { id: 'sessions' },
    })
    registry = contributeToSlot(registry, {
      slotId: 'workspace.tools',
      featureId: 'diff',
      authority: 'extension',
      value: { id: 'diff' },
    })
    expect(resolveSlot(registry, 'workspace.tools')).toEqual([
      { id: 'sessions' },
      { id: 'diff' },
    ])

    const removed = removeFeatureContributions(registry, 'sessions')
    expect(resolveSlot(removed, 'workspace.tools')).toEqual([{ id: 'diff' }])
    expect(resolveSlot(registry, 'workspace.tools')).toHaveLength(2)
    expect(removeFeatureContributions(removed, 'missing')).toBe(removed)
  })

  it('rejects duplicate definitions, unknown slots, and duplicate list contributions', () => {
    const registry = createSlotRegistry()
    expect(() => registerSlot(registry, {
      id: 'shell.root',
      cardinality: 'single',
      protection: 'protected',
    })).toThrow('Duplicate slot id: shell.root')
    expect(() => contributeToSlot(registry, {
      slotId: 'missing',
      featureId: 'feature',
      authority: 'core',
      value: 'value',
    })).toThrow('Unknown slot: missing')
    expect(() => resolveSlot(registry, 'missing')).toThrow('Unknown slot: missing')

    let list = registerSlot(registry, {
      id: 'public.list',
      cardinality: 'list',
      protection: 'public',
    })
    const contribution = {
      slotId: 'public.list',
      featureId: 'feature',
      authority: 'extension' as const,
      contributionId: 'main',
      value: 'value',
    }
    list = contributeToSlot(list, contribution)
    expect(() => contributeToSlot(list, contribution))
      .toThrow('Duplicate slot contribution: public.list/feature/main')
  })

  it.each([
    null,
    { id: 1, cardinality: 'single', protection: 'public' },
    { id: '', cardinality: 'single', protection: 'public' },
    { id: ' padded ', cardinality: 'single', protection: 'public' },
    { id: 'slot', cardinality: 'many', protection: 'public' },
    { id: 'slot', cardinality: 'single', protection: 'private' },
  ])('rejects malformed slot definition %j', (definition) => {
    expect(() => registerSlot(
      createSlotRegistry(),
      definition as Parameters<typeof registerSlot>[1],
    )).toThrow('Invalid slot definition')
  })

  it('returns frozen registry snapshots', () => {
    const registry = createSlotRegistry()
    expect(Object.isFrozen(registry)).toBe(true)
    expect(Object.isFrozen(registry.definitions)).toBe(true)
    expect(Object.isFrozen(registry.contributions)).toBe(true)
    expect(registry.definitions.map(slot => slot.id)).toEqual([
      'shell.root',
      'shell.composer',
      'shell.interaction',
      'workspace.navigator',
      'workspace.content',
      'workspace.inspector',
      'shell.status',
      'shell.overlay',
    ])
  })
})
