import type {
  SessionSkillEntry,
  SessionSkillsSnapshot,
} from '../../skill/port.ts'

export interface SkillsCatalogProjection {
  readonly rows: readonly SessionSkillEntry[]
  readonly totalCount: number
}

function detachResourceBase(
  value: SessionSkillEntry['resourceBase'],
): SessionSkillEntry['resourceBase'] {
  return value === undefined ? undefined : Object.freeze({ ...value })
}

function detachSkill(entry: SessionSkillEntry): SessionSkillEntry {
  const resourceBase = detachResourceBase(entry.resourceBase)
  return Object.freeze({
    name: entry.name,
    description: entry.description,
    ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
    modelInvocable: entry.modelInvocable,
    source: entry.source,
    provider: entry.provider,
    ...(resourceBase === undefined ? {} : { resourceBase }),
  })
}

/** Detach adapter-owned arrays and objects before retaining them as Feature state. */
export function detachSkillsSnapshot(
  snapshot: SessionSkillsSnapshot,
): SessionSkillsSnapshot {
  return Object.freeze({
    available: snapshot.available,
    loading: snapshot.loading,
    complete: snapshot.complete,
    stale: snapshot.stale,
    generation: snapshot.generation,
    skills: Object.freeze(snapshot.skills.map(detachSkill)),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  })
}

function normalizedWords(value: string): readonly string[] {
  return value.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
}

function matches(entry: SessionSkillEntry, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const haystack = [
    entry.name,
    entry.description,
    entry.whenToUse,
    entry.source,
    entry.provider,
  ].filter((value): value is string => value !== undefined)
    .join(' ')
    .toLocaleLowerCase()
  return words.every(word => haystack.includes(word))
}

export function projectSkillsCatalog(
  snapshot: SessionSkillsSnapshot | undefined,
  query: string,
): SkillsCatalogProjection {
  if (snapshot === undefined) {
    return Object.freeze({ rows: Object.freeze([]), totalCount: 0 })
  }
  const words = normalizedWords(query)
  return Object.freeze({
    rows: Object.freeze(snapshot.skills.filter(entry => matches(entry, words))),
    totalCount: snapshot.skills.length,
  })
}

export function describeSkillResource(entry: SessionSkillEntry): string | undefined {
  switch (entry.resourceBase?.kind) {
    case undefined:
      return undefined
    case 'directory':
      return entry.resourceBase.path
    case 'url':
      return entry.resourceBase.url
    case 'opaque':
      return entry.resourceBase.description
    /* v8 ignore next 2 -- SessionSkillEntry resource kinds are exhausted above. */
    default:
      return assertNever(entry.resourceBase)
  }
}

/* v8 ignore next 3 -- exported discriminated unions are exhausted above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled Skills resource base: ${String(value)}`)
}
