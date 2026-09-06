import type { SessionCatalogEntry } from './catalog-port.ts'

export function matchesSessionCatalogQuery(row: SessionCatalogEntry, query: string): boolean {
  const normalized = query.trim().normalize('NFKC').toLowerCase()
  if (normalized.length === 0) return true
  return [row.sessionId, row.cwd, row.parentSessionId, row.creationAgentPreset, row.liveStatus]
    .filter((value): value is string => value !== undefined)
    .join('\n').normalize('NFKC').toLowerCase().includes(normalized)
}
