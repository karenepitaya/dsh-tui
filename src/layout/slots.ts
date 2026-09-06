export type SlotCardinality = 'single' | 'list'
export type SlotProtection = 'public' | 'protected'
export type ContributionAuthority = 'core' | 'extension'

export interface SlotDefinition {
  readonly id: string
  readonly cardinality: SlotCardinality
  readonly protection: SlotProtection
}

export interface SlotContribution<T = unknown> {
  readonly slotId: string
  readonly featureId: string
  readonly authority: ContributionAuthority
  readonly contributionId?: string
  readonly value: T
}

export interface SlotRegistry<T = unknown> {
  readonly definitions: readonly SlotDefinition[]
  readonly contributions: readonly SlotContribution<T>[]
}

export const DSH_TUI_SLOT_DEFINITIONS: readonly SlotDefinition[] = Object.freeze([
  Object.freeze({ id: 'shell.root', cardinality: 'single', protection: 'protected' }),
  Object.freeze({ id: 'shell.composer', cardinality: 'single', protection: 'protected' }),
  Object.freeze({ id: 'shell.interaction', cardinality: 'single', protection: 'protected' }),
  Object.freeze({ id: 'workspace.navigator', cardinality: 'list', protection: 'public' }),
  Object.freeze({ id: 'workspace.content', cardinality: 'list', protection: 'public' }),
  Object.freeze({ id: 'workspace.inspector', cardinality: 'list', protection: 'public' }),
  Object.freeze({ id: 'shell.status', cardinality: 'list', protection: 'public' }),
  Object.freeze({ id: 'shell.overlay', cardinality: 'list', protection: 'public' }),
])

function freezeDefinition(definition: SlotDefinition): SlotDefinition {
  return Object.freeze({ ...definition })
}

function freezeContribution<T>(contribution: SlotContribution<T>): SlotContribution<T> {
  return Object.freeze({ ...contribution })
}

function freezeRegistry<T>(
  definitions: readonly SlotDefinition[],
  contributions: readonly SlotContribution<T>[],
): SlotRegistry<T> {
  return Object.freeze({
    definitions: Object.freeze([...definitions]),
    contributions: Object.freeze([...contributions]),
  })
}

function definitionFor<T>(registry: SlotRegistry<T>, slotId: string): SlotDefinition {
  const definition = registry.definitions.find(slot => slot.id === slotId)
  if (definition === undefined) throw new Error(`Unknown slot: ${slotId}`)
  return definition
}

export function createDshTuiSlotDefinitions(
  additional: readonly SlotDefinition[] = [],
): readonly SlotDefinition[] {
  let registry = createSlotRegistry()
  for (const definition of additional) {
    // Older hosts may repeat a now-built-in declaration. Treat only an exact
    // semantic match as idempotent; cardinality or protection cannot drift.
    const existing = registry.definitions.find(slot => slot.id === definition.id)
    if (existing?.cardinality === definition.cardinality
      && existing.protection === definition.protection) continue
    registry = registerSlot(registry, definition)
  }
  return registry.definitions
}

export function createSlotRegistry<T = unknown>(
  definitions: readonly SlotDefinition[] = DSH_TUI_SLOT_DEFINITIONS,
): SlotRegistry<T> {
  let registry = freezeRegistry<T>([], [])
  for (const definition of definitions) registry = registerSlot(registry, definition)
  return registry
}

export function registerSlot<T>(
  registry: SlotRegistry<T>,
  definition: SlotDefinition,
): SlotRegistry<T> {
  requireSlotDefinition(definition)
  if (registry.definitions.some(slot => slot.id === definition.id)) {
    throw new Error(`Duplicate slot id: ${definition.id}`)
  }
  return freezeRegistry(
    [...registry.definitions, freezeDefinition(definition)],
    registry.contributions,
  )
}

function requireSlotDefinition(definition: SlotDefinition): void {
  if (definition === null
    || typeof definition !== 'object'
    || typeof definition.id !== 'string'
    || definition.id.length === 0
    || definition.id.trim() !== definition.id
    || (definition.cardinality !== 'single' && definition.cardinality !== 'list')
    || (definition.protection !== 'public' && definition.protection !== 'protected')) {
    throw new Error('Invalid slot definition')
  }
}

function contributionKey<T>(contribution: SlotContribution<T>): string {
  return `${contribution.slotId}/${contribution.featureId}/${contribution.contributionId ?? 'default'}`
}

export function contributeToSlot<T>(
  registry: SlotRegistry<T>,
  contribution: SlotContribution<T>,
): SlotRegistry<T> {
  const definition = definitionFor(registry, contribution.slotId)
  if (definition.protection === 'protected' && contribution.authority !== 'core') {
    throw new Error(`Protected slot rejects extension contribution: ${contribution.slotId}`)
  }
  const existing = registry.contributions.filter(item => item.slotId === contribution.slotId)
  if (definition.cardinality === 'single' && existing.length > 0) {
    throw new Error(`Single slot already has a contribution: ${contribution.slotId}`)
  }
  const key = contributionKey(contribution)
  if (existing.some(item => contributionKey(item) === key)) {
    throw new Error(`Duplicate slot contribution: ${key}`)
  }
  return freezeRegistry(
    registry.definitions,
    [...registry.contributions, freezeContribution(contribution)],
  )
}

export function resolveSlot<T>(registry: SlotRegistry<T>, slotId: string): readonly T[] {
  definitionFor(registry, slotId)
  return Object.freeze(
    registry.contributions
      .filter(contribution => contribution.slotId === slotId)
      .map(contribution => contribution.value),
  )
}

export function removeFeatureContributions<T>(
  registry: SlotRegistry<T>,
  featureId: string,
): SlotRegistry<T> {
  const contributions = registry.contributions.filter(item => item.featureId !== featureId)
  return contributions.length === registry.contributions.length
    ? registry
    : freezeRegistry(registry.definitions, contributions)
}
