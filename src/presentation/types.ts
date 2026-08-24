/** Product-owned mirror of the current renderer-neutral DSH tool-card vocabulary. */
export type ToolPresentationPhase = 'call' | 'result'

export type ToolCallKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'fetch'
  | 'other'

export interface ToolFileLocation {
  readonly path: string
  readonly line?: number
}

export interface ToolFileDiff {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

export interface ToolGenericCallPresentation {
  readonly phase: 'call'
  readonly card: 'generic'
  readonly title: string
  readonly kind?: ToolCallKind
  readonly rawInput?: unknown
  readonly content?: readonly unknown[]
  readonly locations?: readonly ToolFileLocation[]
}

export interface ToolTerminalCallPresentation {
  readonly phase: 'call'
  readonly card: 'terminal'
  readonly title: string
  readonly description?: string
  readonly cwd?: string
}

export interface ToolDiffCallPresentation {
  readonly phase: 'call'
  readonly card: 'diff'
  readonly title: string
  readonly diffs: readonly ToolFileDiff[]
  readonly locations?: readonly ToolFileLocation[]
}

export interface ToolGenericResultPresentation {
  readonly phase: 'result'
  readonly card: 'generic'
  readonly title?: string
  readonly content?: readonly unknown[]
}

export interface ToolTerminalResultPresentation {
  readonly phase: 'result'
  readonly card: 'terminal'
  readonly title?: string
  readonly output?: string
  readonly exitCode?: number
  readonly signal?: string
}

export interface ToolDiffResultPresentation {
  readonly phase: 'result'
  readonly card: 'diff'
  readonly title?: string
  readonly diffs: readonly ToolFileDiff[]
}

export interface ToolSearchLineMatch {
  readonly lineNumber: number
  readonly line: string
}

export interface ToolSearchFileMatches {
  readonly path: string
  readonly matches: readonly ToolSearchLineMatch[]
}

export interface ToolSearchMatchesResultPresentation {
  readonly phase: 'result'
  readonly card: 'search'
  readonly shape: 'matches'
  readonly title?: string
  readonly files: readonly ToolSearchFileMatches[]
  readonly truncated: boolean
  readonly total: number
}

export interface ToolSearchPathsResultPresentation {
  readonly phase: 'result'
  readonly card: 'search'
  readonly shape: 'paths'
  readonly title?: string
  readonly paths: readonly string[]
  readonly truncated: boolean
  readonly total: number
}

export interface ToolReadFileLine {
  readonly number: number
  readonly text: string
}

export interface ToolReadResultPresentation {
  readonly phase: 'result'
  readonly card: 'read'
  readonly title?: string
  readonly path: string
  readonly offset: number
  readonly lines: readonly ToolReadFileLine[]
  readonly totalLines: number
  readonly lang?: string
  readonly content?: readonly unknown[]
}

export interface ToolWebSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

export interface ToolWebSearchResultPresentation {
  readonly phase: 'result'
  readonly card: 'web'
  readonly kind: 'search'
  readonly title?: string
  readonly sources: readonly ToolWebSource[]
  readonly answer?: string
  readonly truncated: boolean
}

export interface ToolWebFetchResultPresentation {
  readonly phase: 'result'
  readonly card: 'web'
  readonly kind: 'fetch'
  readonly title?: string
  readonly url: string
  readonly statusCode: number
  readonly truncated: boolean
}

export type ToolPresentationView =
  | ToolGenericCallPresentation
  | ToolTerminalCallPresentation
  | ToolDiffCallPresentation
  | ToolGenericResultPresentation
  | ToolTerminalResultPresentation
  | ToolDiffResultPresentation
  | ToolSearchMatchesResultPresentation
  | ToolSearchPathsResultPresentation
  | ToolReadResultPresentation
  | ToolWebSearchResultPresentation
  | ToolWebFetchResultPresentation

type UnknownRecord = Readonly<Record<string, unknown>>

const TOOL_CALL_KINDS: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'fetch',
  'other',
])

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function isFileLocation(value: unknown): value is ToolFileLocation {
  return isRecord(value)
    && typeof value.path === 'string'
    && (value.line === undefined || isPositiveInteger(value.line))
}

function isFileLocations(value: unknown): value is readonly ToolFileLocation[] {
  return Array.isArray(value) && value.every(isFileLocation)
}

function isFileDiff(value: unknown): value is ToolFileDiff {
  return isRecord(value)
    && typeof value.path === 'string'
    && (value.oldText === null || typeof value.oldText === 'string')
    && typeof value.newText === 'string'
}

function isFileDiffs(value: unknown): value is readonly ToolFileDiff[] {
  return Array.isArray(value) && value.every(isFileDiff)
}

function isSearchLineMatch(value: unknown): value is ToolSearchLineMatch {
  return isRecord(value)
    && isPositiveInteger(value.lineNumber)
    && typeof value.line === 'string'
}

function isSearchFileMatches(value: unknown): value is ToolSearchFileMatches {
  return isRecord(value)
    && typeof value.path === 'string'
    && Array.isArray(value.matches)
    && value.matches.every(isSearchLineMatch)
}

function isReadFileLine(value: unknown): value is ToolReadFileLine {
  return isRecord(value)
    && isPositiveInteger(value.number)
    && typeof value.text === 'string'
}

function isWebSource(value: unknown): value is ToolWebSource {
  return isRecord(value)
    && typeof value.url === 'string'
    && isOptionalString(value.title)
    && isOptionalString(value.snippet)
    && isOptionalString(value.publishedAt)
}

function isCallPresentation(value: UnknownRecord): boolean {
  switch (value.card) {
    case 'generic':
      return typeof value.title === 'string'
        && (value.kind === undefined || (
          typeof value.kind === 'string' && TOOL_CALL_KINDS.has(value.kind)
        ))
        && (value.content === undefined || isUnknownArray(value.content))
        && (value.locations === undefined || isFileLocations(value.locations))
    case 'terminal':
      return typeof value.title === 'string'
        && isOptionalString(value.description)
        && isOptionalString(value.cwd)
    case 'diff':
      return typeof value.title === 'string'
        && isFileDiffs(value.diffs)
        && (value.locations === undefined || isFileLocations(value.locations))
    default:
      return false
  }
}

function isSearchResult(value: UnknownRecord): boolean {
  if (!isOptionalString(value.title)
    || typeof value.truncated !== 'boolean'
    || !isNonNegativeInteger(value.total)) return false
  if (value.shape === 'paths') return isStringArray(value.paths)
  return value.shape === 'matches'
    && Array.isArray(value.files)
    && value.files.every(isSearchFileMatches)
}

function isReadResult(value: UnknownRecord): boolean {
  return isOptionalString(value.title)
    && typeof value.path === 'string'
    && isPositiveInteger(value.offset)
    && Array.isArray(value.lines)
    && value.lines.every(isReadFileLine)
    && isNonNegativeInteger(value.totalLines)
    && isOptionalString(value.lang)
    && (value.content === undefined || isUnknownArray(value.content))
}

function isWebResult(value: UnknownRecord): boolean {
  if (!isOptionalString(value.title) || typeof value.truncated !== 'boolean') return false
  if (value.kind === 'fetch') {
    return typeof value.url === 'string' && isNonNegativeInteger(value.statusCode)
  }
  return value.kind === 'search'
    && Array.isArray(value.sources)
    && value.sources.every(isWebSource)
    && isOptionalString(value.answer)
}

function isResultPresentation(value: UnknownRecord): boolean {
  switch (value.card) {
    case 'generic':
      return isOptionalString(value.title)
        && (value.content === undefined || isUnknownArray(value.content))
    case 'terminal':
      return isOptionalString(value.title)
        && isOptionalString(value.output)
        && (value.exitCode === undefined || isNonNegativeInteger(value.exitCode))
        && isOptionalString(value.signal)
        && !(value.exitCode !== undefined && value.signal !== undefined)
    case 'diff':
      return isOptionalString(value.title) && isFileDiffs(value.diffs)
    case 'search':
      return isSearchResult(value)
    case 'read':
      return isReadResult(value)
    case 'web':
      return isWebResult(value)
    default:
      return false
  }
}

/** Runtime boundary for values projected by an independently versioned Harness adapter. */
export function isToolPresentationView(value: unknown): value is ToolPresentationView {
  if (!isRecord(value)) return false
  if (value.phase === 'call') return isCallPresentation(value)
  if (value.phase === 'result') return isResultPresentation(value)
  return false
}
