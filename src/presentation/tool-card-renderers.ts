import {
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
} from '../terminal/text-layout.ts'
import {
  isToolPresentationView,
  type ToolPresentationPhase,
  type ToolPresentationView,
} from './types.ts'

export type ToolCallPresentationCard = 'generic' | 'terminal' | 'diff'
export type ToolResultPresentationCard =
  | 'generic'
  | 'terminal'
  | 'diff'
  | 'search'
  | 'read'
  | 'web'

export type ToolCardRendererKey =
  | { readonly phase: 'call'; readonly card: ToolCallPresentationCard }
  | { readonly phase: 'result'; readonly card: ToolResultPresentationCard }

export type ToolCardStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface ToolCardRenderRequest {
  readonly phase: ToolPresentationPhase
  readonly toolName: string
  readonly status: ToolCardStatus
  readonly width: number
  readonly arguments?: unknown
  readonly result?: unknown
  readonly error?: unknown
  /** Untrusted until {@link isToolPresentationView} accepts it. */
  readonly presentation?: unknown
}

export interface ToolCardRendererContext extends ToolCardRenderRequest {
  readonly presentation: ToolPresentationView
}

export type ToolCardRenderer = (
  context: ToolCardRendererContext,
) => readonly string[] | undefined

export type ToolCardRendererDisposer = () => void

/** Structural Cordis seam; this package-internal module has no Cordis import. */
export interface ToolCardRendererEffectOwner {
  effect(
    setup: () => ToolCardRendererDisposer,
    label?: string,
  ): unknown
}

const MAX_BODY_LINES = 8
const MAX_DIFF_BODY_LINES = 24
const BODY_HEAD_LINES = 4
const BODY_TAIL_LINES = 3
const MAX_COLLECTION_ITEMS = 32
const MAX_SERIALIZATION_DEPTH = 6
const MAX_STRING_CODE_UNITS = 64 * 1024
const REDACTED = '[REDACTED]'

const SENSITIVE_KEYS: readonly string[] = Object.freeze([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
  'credential',
  'credentials',
  'privatekey',
  'clientsecret',
  'accesskey',
  'secretkey',
])

function rendererKey(key: ToolCardRendererKey): string {
  return `${key.phase}:${key.card}`
}

function normalizedWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1
}

function sanitizeText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b[@-_]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '  ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
}

function boundedString(value: string): string {
  if (value.length <= MAX_STRING_CODE_UNITS) return value
  const retained = Math.floor(MAX_STRING_CODE_UNITS / 2)
  const hidden = value.length - retained * 2
  return `${value.slice(0, retained)}\n… ${hidden} code units hidden …\n${value.slice(-retained)}`
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '')
  return SENSITIVE_KEYS.includes(normalized)
}

function normalizeSerializable(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return boundedString(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'undefined') return '[undefined]'
  if (typeof value === 'symbol') return String(value)
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (depth >= MAX_SERIALIZATION_DEPTH) return '[Max depth]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    const retained = Math.min(value.length, MAX_COLLECTION_ITEMS)
    const result: unknown[] = []
    for (let index = 0; index < retained; index += 1) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        result.push(descriptor !== undefined && 'value' in descriptor
          ? normalizeSerializable(descriptor.value, seen, depth + 1)
          : '[Accessor or missing item]')
      } catch {
        result.push('[Unreadable item]')
      }
    }
    if (value.length > retained) result.push(`… ${value.length - retained} more items`)
    seen.delete(value)
    return result
  }

  let keys: readonly string[]
  try {
    keys = Object.keys(value).slice(0, MAX_COLLECTION_ITEMS)
  } catch {
    seen.delete(value)
    return '[Unserializable object]'
  }
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    if (sensitiveKey(key)) {
      result[key] = REDACTED
      continue
    }
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      result[key] = descriptor !== undefined && 'value' in descriptor
        ? normalizeSerializable(descriptor.value, seen, depth + 1)
        : '[Accessor]'
    } catch {
      result[key] = '[Unreadable property]'
    }
  }
  try {
    const total = Object.keys(value).length
    if (total > keys.length) result['…'] = `${total - keys.length} more properties`
  } catch {
    // The retained properties are still safe to display.
  }
  seen.delete(value)
  return result
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return value
  }
}

function safeSerialize(value: unknown): string {
  const normalized = normalizeSerializable(parseJsonValue(value), new WeakSet(), 0)
  if (typeof normalized === 'string') return normalized
  // normalizeSerializable has already removed cycles, BigInt, functions,
  // symbols, accessors, and hostile objects; the remaining value is JSON-safe.
  return JSON.stringify(normalized, undefined, 2) as string
}

function safeSerializeCompact(value: unknown): string {
  const normalized = normalizeSerializable(parseJsonValue(value), new WeakSet(), 0)
  if (typeof normalized === 'string') return normalized
  return JSON.stringify(normalized) as string
}

function sectionLines(label: string, value: unknown): string[] {
  const lines = safeSerialize(value).split('\n')
  // String#split always returns at least one element.
  return [`${label}: ${lines[0]!}`, ...lines.slice(1)]
}

function compactSectionLine(label: string, value: unknown): string {
  return `${label}: ${safeSerializeCompact(value)}`
}

function fittedCompactSectionLine(label: string, value: unknown, width: number): string {
  return fitWidth(
    sanitizeText(compactSectionLine(label, value)).replaceAll('\n', '↵'),
    normalizedWidth(width),
  )
}

function limitLines(
  lines: readonly string[],
  maximum: number,
  width: number,
): readonly string[] {
  if (lines.length <= maximum) return lines
  const retained = maximum - 1
  const head = Math.ceil(retained / 2)
  const tail = Math.floor(retained / 2)
  const hidden = lines.length - head - tail
  return [
    ...lines.slice(0, head),
    fitWidth(`…${hidden} lines hidden`, width),
    ...lines.slice(-tail),
  ]
}

function resultFallbackBody(request: ToolCardRenderRequest): readonly string[] {
  const width = normalizedWidth(request.width)
  const hasArguments = request.arguments !== undefined
  const hasError = request.error !== undefined
  const reserved = Number(hasArguments) + Number(hasError)
  const result = sectionLines('Result', request.result ?? '(none)')
    .flatMap(line => wrapLine(line, width))
  return [
    ...(hasArguments
      ? [fittedCompactSectionLine('Arguments', request.arguments, width)]
      : []),
    ...limitLines(result, MAX_BODY_LINES - reserved, width),
    ...(hasError
      ? [fittedCompactSectionLine('Error', request.error, width)]
      : []),
  ]
}

function genericFallback(request: ToolCardRenderRequest): readonly string[] {
  const body: string[] = []
  if (request.phase === 'call') {
    body.push(...sectionLines('Arguments', request.arguments ?? '(none)'))
  } else {
    body.push(...resultFallbackBody(request))
  }
  return [
    `Tool ${request.toolName || 'unknown'} · ${request.status}`,
    ...body,
  ]
}

function fitWidth(value: string, width: number): string {
  return stripTerminalSequences(truncateToWidth(stripTerminalSequences(value), width, ''))
}

function wrapLine(value: string, width: number): readonly string[] {
  const sanitized = sanitizeText(value)
  const paragraphs = sanitized.split('\n')
  return paragraphs.flatMap(paragraph => {
    if (paragraph === '') return ['']
    const wrapped = wrapTextWithAnsi(paragraph, width)
    return wrapped.map(line => (
      fitWidth(line, width)
    ))
  })
}

function limitedBody(
  body: readonly string[],
  width: number,
  maximum = MAX_BODY_LINES,
): readonly string[] {
  if (body.length <= maximum) return body
  const head = Math.max(BODY_HEAD_LINES, Math.ceil((maximum - 1) / 2))
  const tail = Math.max(BODY_TAIL_LINES, maximum - 1 - head)
  const hidden = body.length - head - tail
  return [
    ...body.slice(0, head),
    fitWidth(`…${hidden} lines hidden`, width),
    ...body.slice(-tail),
  ]
}

function safeLines(
  candidate: unknown,
  widthValue: number,
  maximumBodyLines = MAX_BODY_LINES,
): readonly string[] | undefined {
  if (!Array.isArray(candidate) || !candidate.every(line => typeof line === 'string')) {
    return undefined
  }
  const width = normalizedWidth(widthValue)
  const expanded = candidate.flatMap(line => wrapLine(line, width))
  if (expanded.length === 0 || expanded.every(line => line.trim() === '')) return undefined
  const header = fitWidth(expanded[0]!, width)
  return [header, ...limitedBody(expanded.slice(1), width, maximumBodyLines)]
}

/**
 * Package-internal rich-renderer registry. It owns no Cordis or Harness state;
 * callers choose who owns each returned disposer.
 */
export class ToolCardRendererRegistry {
  private readonly renderers = new Map<string, ToolCardRenderer>()
  private revision = 0

  get generation(): number {
    return this.revision
  }

  register(
    key: ToolCardRendererKey,
    renderer: ToolCardRenderer,
  ): ToolCardRendererDisposer {
    const id = rendererKey(key)
    if (this.renderers.has(id)) {
      throw new Error(`tool card renderer already registered for ${id}`)
    }
    this.renderers.set(id, renderer)
    this.revision += 1
    let active = true
    return () => {
      if (!active) return
      active = false
      this.renderers.delete(id)
      this.revision += 1
    }
  }

  /**
   * Never lets a renderer failure, malformed view, unsafe text, or oversized
   * output escape the presentation boundary. It always returns a generic card.
   */
  renderSafe(request: ToolCardRenderRequest): readonly string[] {
    const presentation = request.presentation
    if (isToolPresentationView(presentation) && presentation.phase === request.phase) {
      const renderer = this.renderers.get(rendererKey(presentation))
      if (renderer !== undefined) {
        try {
          const specialized = safeLines(
            renderer({ ...request, presentation }),
            request.width,
            presentation.card === 'diff' ? MAX_DIFF_BODY_LINES : MAX_BODY_LINES,
          )
          if (specialized !== undefined) return specialized
        } catch {
          // A rich renderer is an enhancement; the known generic path remains available.
        }
      }
    }
    // genericFallback always supplies a non-empty header, so safeLines cannot
    // abdicate here; the assertion records that invariant without dead code.
    return safeLines(genericFallback(request), request.width)!
  }
}

/** Let a later Cordis plugin own a registration without coupling this module to Cordis. */
export function installToolCardRenderer(
  owner: ToolCardRendererEffectOwner,
  registry: ToolCardRendererRegistry,
  key: ToolCardRendererKey,
  renderer: ToolCardRenderer,
): unknown {
  return owner.effect(
    () => registry.register(key, renderer),
    `dsh-tui:tool-card-renderer:${rendererKey(key)}`,
  )
}
