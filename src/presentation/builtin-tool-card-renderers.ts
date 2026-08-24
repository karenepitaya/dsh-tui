import {
  installToolCardRenderer,
  type ToolCardRendererContext,
  type ToolCardRendererEffectOwner,
  type ToolCardRendererRegistry,
} from './tool-card-renderers.ts'
import type {
  ToolDiffCallPresentation,
  ToolDiffResultPresentation,
  ToolFileDiff,
  ToolFileLocation,
  ToolGenericCallPresentation,
  ToolGenericResultPresentation,
  ToolReadResultPresentation,
  ToolSearchMatchesResultPresentation,
  ToolSearchPathsResultPresentation,
  ToolTerminalCallPresentation,
  ToolTerminalResultPresentation,
  ToolWebFetchResultPresentation,
  ToolWebSearchResultPresentation,
} from './types.ts'

type UnknownRecord = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function displayTitle(title: string | undefined, fallback: string): string {
  return title === undefined || title.trim() === '' ? fallback : title
}

function cardTitle(
  kind: string,
  title: string,
  context: ToolCardRendererContext,
): string {
  return `${kind} · ${title} · ${context.status}`
}

function errorLines(context: ToolCardRendererContext): readonly string[] {
  return context.error === undefined ? [] : [`Error: ${String(context.error)}`]
}

function locationLabel(location: ToolFileLocation): string {
  return location.line === undefined
    ? location.path
    : `${location.path}:${location.line}`
}

function locationLines(locations: readonly ToolFileLocation[] | undefined): readonly string[] {
  if (locations === undefined || locations.length === 0) return []
  return [`At: ${locations.map(locationLabel).join(', ')}`]
}

function lineCount(text: string): number {
  if (text === '') return 0
  return text.replace(/\r\n?/gu, '\n').split('\n').length
}

function diffLine(diff: ToolFileDiff): string {
  const added = lineCount(diff.newText)
  if (diff.oldText === null) return `Create ${diff.path} · +${added} lines`
  const removed = lineCount(diff.oldText)
  if (diff.newText === '') return `Delete ${diff.path} · -${removed} lines`
  return `Update ${diff.path} · -${removed} +${added} lines`
}

function valueShape(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array (${value.length} items)`
  switch (typeof value) {
    case 'string':
      return `string (${value.length} characters)`
    case 'object':
      return 'object'
    default:
      return typeof value
  }
}

function contentSummary(block: unknown): string | undefined {
  if (typeof block === 'string') return block
  if (!isRecord(block)) {
    if (block === null || block === undefined) return undefined
    return String(block)
  }
  const type = typeof block.type === 'string' ? block.type : undefined
  if (type === 'text' && typeof block.text === 'string') return block.text
  if (type !== undefined) return `[${type}]`
  return '[structured content]'
}

function contentLines(content: readonly unknown[] | undefined): readonly string[] {
  if (content === undefined) return []
  const summaries = content
    .map(contentSummary)
    .filter((line): line is string => line !== undefined)
  return [`Content blocks: ${content.length}`, ...summaries]
}

function renderGenericCall(context: ToolCardRendererContext): readonly string[] {
  const presentation = context.presentation as ToolGenericCallPresentation
  return [
    cardTitle('Call', displayTitle(presentation.title, context.toolName), context),
    ...(presentation.kind === undefined ? [] : [`Kind: ${presentation.kind}`]),
    ...(presentation.rawInput === undefined
      ? []
      : [`Input: ${valueShape(presentation.rawInput)}`]),
    ...contentLines(presentation.content),
    ...locationLines(presentation.locations),
  ]
}

function renderTerminalCall(context: ToolCardRendererContext): readonly string[] {
  const presentation = context.presentation as ToolTerminalCallPresentation
  return [
    cardTitle('Terminal', displayTitle(presentation.title, context.toolName), context),
    ...(presentation.description === undefined ? [] : [presentation.description]),
    ...(presentation.cwd === undefined ? [] : [`Cwd: ${presentation.cwd}`]),
  ]
}

function renderDiffCall(context: ToolCardRendererContext): readonly string[] {
  const presentation = context.presentation as ToolDiffCallPresentation
  return [
    cardTitle('Diff', displayTitle(presentation.title, context.toolName), context),
    ...presentation.diffs.map(diffLine),
    ...locationLines(presentation.locations),
  ]
}

function renderGenericResult(context: ToolCardRendererContext): readonly string[] {
  const presentation = context.presentation as ToolGenericResultPresentation
  return [
    cardTitle('Result', displayTitle(presentation.title, context.toolName), context),
    ...(presentation.content === undefined
      ? context.result === undefined ? [] : [`Result: ${String(context.result)}`]
      : contentLines(presentation.content)),
    ...errorLines(context),
  ]
}

function renderTerminalResult(context: ToolCardRendererContext): readonly string[] {
  const presentation = context.presentation as ToolTerminalResultPresentation
  return [
    cardTitle('Terminal', displayTitle(presentation.title, context.toolName), context),
    ...(presentation.exitCode === undefined ? [] : [`Exit: ${presentation.exitCode}`]),
    ...(presentation.signal === undefined ? [] : [`Signal: ${presentation.signal}`]),
    ...(presentation.output === undefined
      ? context.result === undefined ? [] : ['Output:', String(context.result)]
      : ['Output:', presentation.output]),
    ...errorLines(context),
  ]
}

function renderDiffResult(context: ToolCardRendererContext): readonly string[] {
  const presentation = context.presentation as ToolDiffResultPresentation
  return [
    cardTitle('Diff', displayTitle(presentation.title, context.toolName), context),
    ...presentation.diffs.map(diffLine),
    ...errorLines(context),
  ]
}

function resultCount(label: string, total: number, truncated: boolean): string {
  return `${label}: ${total}${truncated ? ' (truncated)' : ''}`
}

function renderSearchResult(context: ToolCardRendererContext): readonly string[] {
  const presentation = context.presentation as
    | ToolSearchMatchesResultPresentation
    | ToolSearchPathsResultPresentation
  const header = cardTitle(
    'Search',
    displayTitle(presentation.title, context.toolName),
    context,
  )
  if (presentation.shape === 'paths') {
    return [
      header,
      resultCount('Paths', presentation.total, presentation.truncated),
      ...presentation.paths,
      ...errorLines(context),
    ]
  }
  return [
    header,
    resultCount('Matches', presentation.total, presentation.truncated),
    ...presentation.files.flatMap(file => [
      file.path,
      ...file.matches.map(match => `${match.lineNumber}: ${match.line}`),
    ]),
    ...errorLines(context),
  ]
}

function renderReadResult(context: ToolCardRendererContext): readonly string[] {
  const presentation = context.presentation as ToolReadResultPresentation
  const first = presentation.lines[0]?.number ?? presentation.offset
  const last = presentation.lines.at(-1)?.number ?? presentation.offset
  return [
    cardTitle('Read', displayTitle(presentation.title, presentation.path), context),
    `File: ${presentation.path}`,
    `Lines: ${first}-${last} of ${presentation.totalLines}`
      + (presentation.lang === undefined ? '' : ` · ${presentation.lang}`),
    ...presentation.lines.map(line => `${line.number} │ ${line.text}`),
    ...(presentation.lines.length === 0 ? ['(no lines returned)'] : []),
    ...errorLines(context),
  ]
}

function renderWebResult(context: ToolCardRendererContext): readonly string[] {
  const presentation = context.presentation as
    | ToolWebFetchResultPresentation
    | ToolWebSearchResultPresentation
  if (presentation.kind === 'fetch') {
    return [
      cardTitle('Web fetch', displayTitle(presentation.title, context.toolName), context),
      `Status: ${presentation.statusCode}`,
      `URL: ${presentation.url}`,
      `Body: ${presentation.truncated ? 'truncated' : 'complete'}`,
      ...errorLines(context),
    ]
  }
  return [
    cardTitle('Web search', displayTitle(presentation.title, context.toolName), context),
    `Sources: ${presentation.sources.length}${presentation.truncated ? ' (truncated)' : ''}`,
    ...(presentation.answer === undefined ? [] : [`Answer: ${presentation.answer}`]),
    ...presentation.sources.flatMap((source, index) => [
      `[${index + 1}] ${displayTitle(source.title, source.url)}`,
      ...(source.title === undefined ? [] : [source.url]),
      ...(source.publishedAt === undefined ? [] : [`Published: ${source.publishedAt}`]),
      ...(source.snippet === undefined ? [] : [source.snippet]),
    ]),
    ...errorLines(context),
  ]
}

/** Install one independently effect-owned renderer for every current phase/card pair. */
export function installBuiltinToolCardRenderers(
  owner: ToolCardRendererEffectOwner,
  registry: ToolCardRendererRegistry,
): void {
  installToolCardRenderer(owner, registry, { phase: 'call', card: 'generic' }, renderGenericCall)
  installToolCardRenderer(owner, registry, { phase: 'call', card: 'terminal' }, renderTerminalCall)
  installToolCardRenderer(owner, registry, { phase: 'call', card: 'diff' }, renderDiffCall)
  installToolCardRenderer(owner, registry, { phase: 'result', card: 'generic' }, renderGenericResult)
  installToolCardRenderer(owner, registry, { phase: 'result', card: 'terminal' }, renderTerminalResult)
  installToolCardRenderer(owner, registry, { phase: 'result', card: 'diff' }, renderDiffResult)
  installToolCardRenderer(owner, registry, { phase: 'result', card: 'search' }, renderSearchResult)
  installToolCardRenderer(owner, registry, { phase: 'result', card: 'read' }, renderReadResult)
  installToolCardRenderer(owner, registry, { phase: 'result', card: 'web' }, renderWebResult)
}
