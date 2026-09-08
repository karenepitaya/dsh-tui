import {
  CURSOR_MARKER,
  Markdown,
  ScrollView,
  VStack,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
} from '@earendil-works/pi-tui'
import type {
  AgentRequestRuntime,
  AgentRequestStatus,
} from 'pi-tui-orbs/agent-request'
import type { AgentRequestStatusView } from '../presentation/agent-request.ts'
import type { DshTuiDensity } from '../preferences/contracts.ts'
import type { DshTuiTheme, DshTuiSemanticRole } from './theme.ts'

const PROMPT_ZONE = '\x1b]133;A\x07'
const SNAPSHOT_LIMIT = 32
const MAX_LINK_LENGTH = 2048
const MAX_MESSAGE_CONTENT_WIDTH = 112

type ConversationMotionRuntime = Pick<
  AgentRequestRuntime,
  'createAgentRequestStatus' | 'destroy'
>

export interface ConversationMarkdownNode {
  readonly kind: 'user' | 'assistant' | 'assistant-draft'
  readonly key: string
  /** Semantic viewport target; may point at the Verbose detail represented by this compact node. */
  readonly anchorKey?: string
  readonly revision: string
  readonly text: string
  /** Safe, compact execution status rendered as part of the Assistant block. */
  readonly activitySummary?: string
  /** Safe metadata only. Raw model reasoning is not a conversation-surface input. */
  readonly reasoningSummary?: string
  readonly interrupted?: boolean
}

export interface ConversationCardNode {
  readonly kind: 'tool' | 'command' | 'interaction' | 'activity'
  readonly key: string
  readonly revision: string
  readonly label: string
  readonly status?: 'running' | 'stopping' | 'done' | 'killed' | 'failed' | 'cancelled' | 'warning'
  readonly lines: readonly string[]
  readonly styledLines?: readonly ConversationStyledLine[]
}

export interface ConversationStyledSegment {
  readonly text: string
  readonly tone: DshTuiSemanticRole
  readonly bold?: boolean
}

export interface ConversationStyledLine {
  readonly segments: readonly ConversationStyledSegment[]
}

export interface ConversationNoticeNode {
  readonly kind: 'notice' | 'empty'
  readonly key: string
  readonly revision: string
  readonly lines: readonly string[]
}

export type ConversationNode =
  | ConversationMarkdownNode
  | ConversationCardNode
  | ConversationNoticeNode

export interface ConversationDock {
  /** Inline approval surface; no card frame or centered overlay. */
  readonly inline?: boolean
  readonly label: string
  readonly role: Extract<ConversationCardNode['kind'], 'command' | 'interaction' | 'activity'>
  readonly lines: readonly string[]
  readonly styledLines?: readonly ConversationStyledLine[]
  readonly status?: ConversationCardNode['status']
}

export interface ConversationDashboardLine {
  readonly text: string
  readonly tone: Extract<
    DshTuiSemanticRole,
    'primary' | 'accent' | 'muted' | 'success' | 'warning' | 'error'
  >
}

/** Persistent Goal → Plan → Todo hierarchy above the conversation timeline. */
export interface ConversationDashboard {
  readonly label: string
  readonly lines: readonly ConversationDashboardLine[]
}

export interface ConversationStatusSegment {
  readonly text: string
  readonly tone: Extract<
    DshTuiSemanticRole,
    'assistant' | 'telemetry' | 'muted' | 'success' | 'warning' | 'error'
  >
}

export interface ConversationStatusLine {
  readonly text: string
  readonly tone: Extract<DshTuiSemanticRole, 'muted' | 'accent' | 'warning' | 'error'>
  readonly segments?: readonly ConversationStatusSegment[]
}

export interface ConversationAttachment {
  readonly name: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
}

function attachmentBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1_024))} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

export function conversationAttachmentRail(
  attachments: readonly ConversationAttachment[],
): string {
  if (attachments.length === 0) return ''
  return `◆ IMAGES ${attachments.length}  ` + attachments.map((attachment, index) => (
    `[${index + 1}] ${sanitizeLine(attachment.name)} · ${attachmentBytes(attachment.bytes)}`
  )).join('   ')
}

export interface ConversationSurface {
  readonly density?: DshTuiDensity
  readonly reducedMotion?: boolean
  readonly sessionId: string
  readonly bindingEpoch: number
  readonly header: string
  readonly nodes: readonly ConversationNode[]
  readonly dock?: ConversationDock
  readonly dashboard?: ConversationDashboard
  readonly statusline?: ConversationStatusLine
  readonly attachments?: readonly ConversationAttachment[]
  readonly composer: string
  readonly composerColumn: number
  readonly composerPrefix: string
  readonly composerLabel?: string
  readonly composerBoxed?: boolean
  readonly composerMaxRows?: number
  readonly composerDisabled?: boolean
  readonly footer: string
  readonly reasoningExpanded: boolean
  readonly agentRequest?: AgentRequestStatusView
  /** Monotonic controller request used to follow an accepted local prompt. */
  readonly followRequest?: number
}

export interface ConversationAnchor {
  readonly nodeKey: string
  readonly intraVisualLine: number
  readonly ordinal: number
}

interface RenderedRange {
  readonly key: string
  readonly start: number
  readonly end: number
}

interface ViewportSnapshot {
  readonly followingEnd: boolean
  readonly anchor?: ConversationAnchor
  readonly unseen: boolean
  readonly followRequest: number
}

function sanitizeControlText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b[_^P][\s\S]*?\u001b\\/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '  ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '�')
}

function safeLinkTarget(target: string): boolean {
  if (target.length === 0 || target.length > MAX_LINK_LENGTH) return false
  try {
    const url = new URL(target)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}

function filterTrustedOsc8(line: string): string {
  return line.replace(
    /\u001b\]8;([^;\u0007\u001b]*);([^\u0007\u001b]*)(\u0007|\u001b\\)/gu,
    (whole, parameters: string, target: string) => (
      parameters === '' && (target === '' || safeLinkTarget(target)) ? whole : ''
    ),
  )
}

function markdownDestination(raw: string): string | undefined {
  const normalized = raw.trim()
  const match = /^(?:<([^>]+)>|([^\s]+))(?:\s+["'][^\r\n]*["'])?$/u.exec(normalized)
  const target = match?.[1] ?? match?.[2]
  return target !== undefined && safeLinkTarget(target) ? target : undefined
}

/** Remove terminal controls before parsing and prevent unsafe Markdown URLs from becoming OSC 8. */
export function sanitizeMarkdownSource(source: string): string {
  const clean = sanitizeControlText(source)
  const definitions = clean.replace(
    /^(\s*\[[^\]\r\n]+\]:\s*)(\S+)([^\r\n]*)$/gmu,
    (whole, _prefix: string, target: string) => (
      safeLinkTarget(target.replace(/^<|>$/gu, '')) ? whole : ''
    ),
  )
  const inline = definitions.replace(
    /(!?)\[([^\]\r\n]*)\]\(([^\r\n)]*)\)/gu,
    (whole, image: string, label: string, rawTarget: string) => {
      const target = markdownDestination(rawTarget)
      if (target !== undefined) return whole
      const visibleTarget = rawTarget.trim()
      return image === '!'
        ? `[image: ${label || 'attachment'}]`
        : `${label}${visibleTarget === '' ? '' : ` (${visibleTarget})`}`
    },
  )
  return inline.replace(/<([a-z][a-z0-9+.-]*:[^>\s]+)>/giu, (whole, target: string) => (
    safeLinkTarget(target) ? whole : target
  ))
}

function sanitizeLine(line: string): string {
  return sanitizeControlText(line).replaceAll('\n', ' ')
}

function trustedFit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), '')
}

function markdownTheme(theme: DshTuiTheme): MarkdownTheme {
  return {
    heading: text => theme.bold(theme.paint('accent', text)),
    link: text => theme.underline(theme.paint('accent', text)),
    linkUrl: text => theme.paint('muted', text),
    code: text => theme.paint('code', text),
    codeBlock: text => theme.paint('primary', text),
    codeBlockBorder: text => theme.paint('border', text),
    quote: text => theme.paint('muted', text),
    quoteBorder: text => theme.paint('border', text),
    hr: text => theme.paint('border', text),
    listBullet: text => theme.paint('accent', text),
    bold: text => theme.bold(text),
    italic: text => theme.italic(text),
    strikethrough: text => text,
    underline: text => theme.underline(text),
  }
}

function roleForNode(node: ConversationMarkdownNode): DshTuiSemanticRole {
  return node.kind === 'user' ? 'user' : 'assistant'
}

function compactMarkdownLines(lines: readonly string[]): readonly string[] {
  const compact: string[] = []
  let previousBlank = false
  let inCodeBlock = false
  for (const line of lines) {
    const plain = stripTerminalSequences(line)
    if (plain.startsWith('```')) inCodeBlock = !inCodeBlock
    const blank = plain.trim() === ''
    if (!inCodeBlock && blank && (previousBlank || compact.length === 0)) continue
    compact.push(line)
    previousBlank = blank
  }
  while (compact.length > 0
    && stripTerminalSequences(compact.at(-1)!).trim() === '') compact.pop()
  return compact
}

class MarkdownConversationComponent implements Component {
  private readonly body: Markdown
  private node: ConversationMarkdownNode

  constructor(
    node: ConversationMarkdownNode,
    private readonly theme: DshTuiTheme,
  ) {
    this.node = node
    const sharedTheme = markdownTheme(theme)
    this.body = new Markdown('', 0, 0, sharedTheme, {
      color: text => theme.paint(roleForNode(this.node), text),
    })
    this.updateBodyMarkdown()
  }

  setNode(node: ConversationMarkdownNode): void {
    const bodyChanged = node.kind !== this.node.kind
      || node.text !== this.node.text
      || node.activitySummary !== this.node.activitySummary
    this.node = node
    if (bodyChanged) this.updateBodyMarkdown()
  }

  invalidate(): void {
    this.body.invalidate()
  }

  render(widthValue: number): string[] {
    const width = Math.max(1, Math.floor(widthValue))
    const showMessageMarker = width >= 3
    const contentWidth = Math.min(
      MAX_MESSAGE_CONTENT_WIDTH,
      Math.max(1, width - (showMessageMarker ? 2 : 0)),
    )
    const metadata: string[] = []
    const activitySummary = this.node.activitySummary ?? ''
    if (activitySummary !== '') {
      metadata.push(truncateToWidth(
        this.theme.paint('activity', sanitizeLine(activitySummary)),
        contentWidth,
        '…',
      ))
    }
    if (this.node.reasoningSummary !== undefined) {
      const summary = sanitizeLine(this.node.reasoningSummary)
      metadata.push(...wrapTextWithAnsi(
        this.theme.paint('reasoning', summary),
        contentWidth,
      ))
    }
    const body: readonly string[] = (
      this.node.text !== ''
      || (this.node.kind === 'assistant' && activitySummary === '')
    )
      ? compactMarkdownLines(this.body.render(contentWidth).map(filterTrustedOsc8))
      : []
    if (this.node.kind === 'user') {
      const source = body.length === 0 ? [''] : body
      const lines = source.map((line, index) => {
        const prefix = showMessageMarker ? (index === 0 ? '› ' : '  ') : ''
        const visible = prefix + trustedFit(line, Math.max(1, width - visibleWidth(prefix)))
        const padding = ' '.repeat(Math.max(0, width - visibleWidth(visible)))
        return this.theme.paintBackground(
          'userBarBackground',
          this.theme.paint('user', visible + padding),
        )
      })
      lines[0] = PROMPT_ZONE + lines[0]
      return lines
    }

    const content: string[] = metadata.map(line => (
      (showMessageMarker ? '  ' : '') + trustedFit(line, contentWidth)
    ))
    content.push(...body.map((line, index) => {
      if (stripTerminalSequences(line).trim() === '') return ''
      const prefix = showMessageMarker ? (index === 0 ? '● ' : '  ') : ''
      return prefix + trustedFit(line, contentWidth)
    }))
    if (
      content.length === 0
      && this.node.kind === 'assistant-draft'
    ) content.push('')
    if (this.node.interrupted === true) content.push(
      (showMessageMarker ? '  ' : '') + this.theme.paint('warning', '[interrupted]'),
    )
    return content.map(line => trustedFit(line, width))
  }

  anchorRanges(start: number, end: number, _widthValue: number): readonly RenderedRange[] {
    const anchorKey = this.node.anchorKey
    if (anchorKey === undefined || (this.node.activitySummary ?? '') === '') {
      return [{ key: this.node.key, start, end }]
    }
    const traceEnd = Math.min(end, start + 1)
    return [
      { key: anchorKey, start, end: traceEnd },
      ...(traceEnd < end
        ? [{ key: this.node.key, start: traceEnd, end }]
        : []),
    ]
  }

  private updateBodyMarkdown(): void {
    const body = this.node.text === ''
      && this.node.kind === 'assistant'
      && (this.node.activitySummary ?? '') === ''
      ? '[No final answer]'
      : this.node.text
    this.body.setText(sanitizeMarkdownSource(body))
  }

  dispose(): void {}
}

function cardRole(kind: ConversationCardNode['kind']): DshTuiSemanticRole {
  if (kind === 'tool') return 'tool'
  if (kind === 'command') return 'command'
  if (kind === 'interaction') return 'interaction'
  return 'activity'
}

function cardStatusLabel(status: ConversationCardNode['status']): string | undefined {
  switch (status) {
    case 'running': return '● RUNNING'
    case 'stopping': return '◌ STOPPING'
    case 'done': return '✓ DONE'
    case 'killed': return '■ KILLED'
    case 'cancelled': return '■ CANCELLED'
    case 'failed': return '× FAILED'
    case 'warning': return '! ACTION'
    case undefined: return undefined
  }
}

function renderCard(
  label: string,
  role: DshTuiSemanticRole,
  lines: readonly string[],
  widthValue: number,
  theme: DshTuiTheme,
  status?: ConversationCardNode['status'],
  styledLines?: readonly ConversationStyledLine[],
): string[] {
  const width = Math.max(1, Math.floor(widthValue))
  const statusLabel = cardStatusLabel(status)
  const labelBudget = Math.max(
    1,
    width - visibleWidth(statusLabel === undefined ? '╭─  ─╮' : `╭─   ${statusLabel} ─╮`),
  )
  const safeLabel = trustedFit(sanitizeLine(label), labelBudget)
  if (width < 12) return [
    trustedFit(theme.bold(theme.paint(
      status === 'failed'
        ? 'error'
        : status === 'warning' || status === 'stopping' ? 'warning' : role,
      statusLabel === undefined ? safeLabel : `${safeLabel} ${statusLabel}`,
    )), width),
    ...lines.map((line, index) => {
      const styled = styledLines?.[index]
      if (styled === undefined) return trustedFit(sanitizeLine(line), width)
      return trustedFit(styled.segments.map(segment => {
        const painted = theme.paint(segment.tone, sanitizeLine(segment.text))
        return segment.bold === true ? theme.bold(painted) : painted
      }).join(''), width)
    }),
  ]
  const inner = Math.max(1, width - 4)
  const statusRole: DshTuiSemanticRole = status === 'failed'
    ? 'error'
    : status === 'warning' || status === 'stopping'
      ? 'warning'
      : status === 'done'
        ? 'success'
        : role
  const start = `╭─ ${safeLabel} `
  const end = statusLabel === undefined ? '─╮' : ` ${statusLabel} ─╮`
  const fill = '─'.repeat(Math.max(0, width - visibleWidth(start) - visibleWidth(end)))
  const top = theme.bold(theme.paint(role, start))
    + theme.paint('border', fill)
    + (statusLabel === undefined
      ? theme.paint(role, end)
      : ' ' + theme.paint(statusRole, statusLabel) + theme.paint(role, ' ─╮'))
  const bottom = theme.paint(role, '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯')
  const bodyLines = lines.length === 0 ? [''] : lines
  const body = bodyLines.map((line, index) => {
    const styled = styledLines?.[index]
    const content = styled === undefined
      ? trustedFit(sanitizeLine(line), inner)
      : trustedFit(styled.segments.map(segment => {
          const painted = theme.paint(segment.tone, sanitizeLine(segment.text))
          return segment.bold === true ? theme.bold(painted) : painted
        }).join(''), inner)
    const padding = ' '.repeat(Math.max(0, inner - visibleWidth(content)))
    return theme.paint(role, '│ ') + theme.paint('primary', content) + padding + theme.paint(role, ' │')
  })
  return [top, ...body, bottom]
}

export class ConversationDocumentComponent implements Component {
  private density: DshTuiDensity = 'compact'
  private nodes: readonly ConversationNode[] = []
  private readonly markdownNodes = new Map<string, MarkdownConversationComponent>()
  private ranges: readonly RenderedRange[] = []
  private revision = ''
  private cache: { readonly width: number; readonly lines: string[] } | undefined

  constructor(
    private readonly theme: DshTuiTheme,
  ) {}

  setDensity(density: DshTuiDensity): void {
    if (density === this.density) return
    this.density = density
    this.cache = undefined
  }

  setNodes(nodes: readonly ConversationNode[], _reasoningExpanded: boolean): void {
    const revision = nodes
      .map(node => {
        if (node.kind !== 'user' && node.kind !== 'assistant' && node.kind !== 'assistant-draft') {
          return `${node.key}:${node.revision}`
        }
        return [
          node.key,
          node.anchorKey ?? '',
          node.revision,
          node.activitySummary ?? '',
          node.reasoningSummary ?? '',
        ].join(':')
      })
      .join('|')
    if (revision !== this.revision) this.cache = undefined
    this.nodes = nodes
    this.revision = revision
    const retained = new Set(nodes.map(node => node.key))
    for (const key of this.markdownNodes.keys()) {
      if (!retained.has(key)) {
        this.markdownNodes.get(key)?.dispose()
        this.markdownNodes.delete(key)
      }
    }
  }

  invalidate(): void {
    this.cache = undefined
    for (const component of this.markdownNodes.values()) component.invalidate()
  }

  render(widthValue: number): string[] {
    const width = Math.max(1, Math.floor(widthValue))
    if (this.cache?.width === width) return this.cache.lines
    const lines: string[] = []
    const ranges: RenderedRange[] = []
    for (const [index, node] of this.nodes.entries()) {
      const previous = this.nodes[index - 1]
      // ConversationNode does not carry a durable turn id. A user row is the
      // stable boundary available at this layer; everything after it remains
      // visually dense until the next user row starts a new turn.
      if (previous !== undefined && node.kind === 'user' && previous.kind !== 'empty') {
        lines.push('')
        if (this.density === 'comfortable') lines.push('')
      }
      const start = lines.length
      let rendered: readonly string[]
      let markdownComponent: MarkdownConversationComponent | undefined
      if (node.kind === 'user' || node.kind === 'assistant' || node.kind === 'assistant-draft') {
        let component = this.markdownNodes.get(node.key)
        if (component === undefined) {
          component = new MarkdownConversationComponent(node, this.theme)
          this.markdownNodes.set(node.key, component)
        }
        component.setNode(node)
        markdownComponent = component
        rendered = component.render(width)
      } else if (
        node.kind === 'tool'
        || node.kind === 'command'
        || node.kind === 'interaction'
        || node.kind === 'activity'
      ) {
        rendered = renderCard(
          node.label,
          cardRole(node.kind),
          node.lines,
          width,
          this.theme,
          node.status,
          node.styledLines,
        )
      } else if ('lines' in node) {
        rendered = node.lines.map(line => trustedFit(sanitizeLine(line), width))
      } else {
        rendered = []
      }
      lines.push(...rendered)
      ranges.push(...(markdownComponent === undefined
        ? [{ key: node.key, start, end: lines.length }]
        : markdownComponent.anchorRanges(start, lines.length, width)))
    }
    this.ranges = ranges
    this.cache = { width, lines }
    return lines
  }

  anchorAt(scrollTop: number): ConversationAnchor | undefined {
    if (this.ranges.length === 0) return undefined
    const row = Math.max(0, Math.floor(scrollTop))
    let ordinal = this.ranges.findIndex(range => row < range.end)
    if (ordinal < 0) ordinal = this.ranges.length - 1
    const range = this.ranges[ordinal]!
    return {
      nodeKey: range.key,
      intraVisualLine: Math.max(0, row - range.start),
      ordinal,
    }
  }

  scrollTopFor(anchor: ConversationAnchor): number {
    const exact = this.ranges.find(range => range.key === anchor.nodeKey)
    const range = exact ?? this.ranges[Math.min(anchor.ordinal, this.ranges.length - 1)]
    if (range === undefined) return 0
    return range.start + Math.min(
      anchor.intraVisualLine,
      Math.max(0, range.end - range.start - 1),
    )
  }

  clear(): void {
    this.nodes = []
    this.ranges = []
    this.revision = ''
    this.cache = undefined
    for (const component of this.markdownNodes.values()) component.dispose()
    this.markdownNodes.clear()
  }
}

class FixedLineComponent implements Component {
  private text = ''

  constructor(
    private readonly theme: DshTuiTheme,
    private readonly role: DshTuiSemanticRole,
    private readonly bold = false,
  ) {}

  setText(text: string): void {
    this.text = sanitizeLine(text)
  }

  invalidate(): void {}

  render(width: number): string[] {
    let text = this.theme.paint(this.role, this.text)
    if (this.bold) text = this.theme.bold(text)
    return [trustedFit(text, width)]
  }
}

const AGENT_REQUEST_FALLBACK_LABELS: Readonly<Record<
  AgentRequestStatusView['phase'],
  string
>> = Object.freeze({
  submitted: 'Submitted',
  waiting: 'Waiting',
  reasoning: 'Thinking',
  tool: 'Working',
  responding: 'Responding',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
})

class AgentRequestActivityComponent implements Component {
  private reducedMotion = false
  private status: AgentRequestStatus | undefined
  private view: AgentRequestStatusView | undefined
  private sessionKey: string | undefined
  private visible = false

  constructor(
    private readonly theme: DshTuiTheme,
    private readonly motion?: ConversationMotionRuntime,
  ) {}

  setReducedMotion(reduced: boolean): void {
    if (reduced === this.reducedMotion) return
    this.reducedMotion = reduced
    if (reduced) this.release()
    else this.ensureStatus()
  }

  setStatus(sessionKey: string, view: AgentRequestStatusView | undefined): void {
    if (sessionKey !== this.sessionKey) {
      this.release()
      this.sessionKey = sessionKey
    }
    this.view = view === undefined
      ? undefined
      : {
          phase: view.phase,
          description: sanitizeLine(view.description),
        }
    if (this.view === undefined) {
      this.release()
      return
    }
    if (this.status === undefined) this.ensureStatus()
    else this.status.update(this.view)
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    if (!visible) {
      this.release()
      return
    }
    this.ensureStatus()
  }

  invalidate(): void {
    this.status?.invalidate()
  }

  render(width: number): string[] {
    if (this.view === undefined) return []
    this.ensureStatus()
    const normalizedWidth = Math.max(1, Math.floor(width))
    const prefix = normalizedWidth >= 12 ? '  ' : ''
    const contentWidth = Math.min(
      MAX_MESSAGE_CONTENT_WIDTH,
      Math.max(1, normalizedWidth - visibleWidth(prefix)),
    )
    const role: DshTuiSemanticRole = this.view.phase === 'failed'
      ? 'error'
      : this.view.phase === 'succeeded'
        ? 'success'
        : this.view.phase === 'cancelled' ? 'muted' : 'activity'
    const rendered = this.status?.render(contentWidth)[0]
      ?? `✦ ${AGENT_REQUEST_FALLBACK_LABELS[this.view.phase]}  ${this.view.description}`
    const content = trustedFit(this.theme.paint(role, rendered), contentWidth)
    return [prefix + content]
  }

  dispose(): void {
    this.release()
    this.view = undefined
    this.sessionKey = undefined
    this.visible = false
  }

  private ensureStatus(): void {
    if (this.reducedMotion || !this.visible || this.view === undefined || this.status !== undefined) return
    this.status = this.motion?.createAgentRequestStatus(this.view)
  }

  private release(): void {
    const status = this.status
    this.status = undefined
    if (status === undefined) return
    if (this.motion?.destroy(status) !== true) status.dispose()
  }
}

class ConversationTimelineComponent implements Component {
  private visible = false

  constructor(
    readonly document: ConversationDocumentComponent,
    private readonly activity: AgentRequestActivityComponent,
  ) {}

  setReducedMotion(reduced: boolean): void {
    this.activity.setReducedMotion(reduced)
  }

  setAgentRequestStatus(
    sessionKey: string,
    view: AgentRequestStatusView | undefined,
  ): void {
    this.activity.setStatus(sessionKey, view)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.activity.setVisible(visible)
  }

  invalidate(): void {
    // Motion ticks only invalidate the live tail. Document revisions and width
    // changes own the retained transcript cache independently.
    this.activity.invalidate()
  }

  render(width: number): string[] {
    const history = this.document.render(width)
    if (!this.visible) return history
    const tail = this.activity.render(width)
    return tail.length === 0 ? history : [...history, ...tail]
  }

  dispose(): void {
    this.setVisible(false)
    this.activity.dispose()
  }
}

const composerSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function composerContentLines(
  textValue: string,
  cursorValue: number,
  prefixValue: string,
  widthValue: number,
): string[] {
  const width = Math.max(1, Math.floor(widthValue))
  const text = sanitizeControlText(textValue)
  const safePrefix = sanitizeLine(prefixValue)
  const prefix = visibleWidth(safePrefix) < width ? safePrefix : ''
  const indent = ' '.repeat(visibleWidth(prefix))
  const contentWidth = Math.max(1, width - visibleWidth(prefix))
  const graphemes = Array.from(composerSegmenter.segment(text), part => part.segment)
  const cursor = Math.min(Math.max(0, Math.floor(cursorValue)), graphemes.length)
  graphemes.splice(cursor, 0, CURSOR_MARKER)
  const logicalLines = graphemes.join('').split('\n')
  const rendered: string[] = []
  for (const [lineIndex, logicalLine] of logicalLines.entries()) {
    const visualLines = wrapTextWithAnsi(logicalLine, contentWidth)
    for (const [visualIndex, line] of visualLines.entries()) {
      const linePrefix = lineIndex === 0 && visualIndex === 0 ? prefix : indent
      rendered.push(trustedFit(linePrefix + line, width))
    }
  }
  return rendered
}

function cursorWindow(lines: readonly string[], limit: number): readonly string[] {
  if (lines.length <= limit) return lines
  const cursorRow = lines.findIndex(line => line.includes(CURSOR_MARKER))
  const start = Math.min(
    Math.max(0, cursorRow - limit + 1),
    Math.max(0, lines.length - limit),
  )
  return lines.slice(start, start + limit)
}

function composerSurfaceLines(
  text: string,
  cursor: number,
  prefix: string,
  labelValue: string,
  boxed: boolean,
  widthValue: number,
  theme?: DshTuiTheme,
  maxRowsValue = 6,
  attachments: readonly ConversationAttachment[] = [],
): readonly string[] {
  const width = Math.max(1, Math.floor(widthValue))
  const maxRows = Math.max(1, Math.floor(maxRowsValue))
  if (!boxed || width < 12 || maxRows < 3) {
    return cursorWindow(composerContentLines(text, cursor, prefix, width), maxRows).map(line => {
      const padded = line + ' '.repeat(Math.max(0, width - visibleWidth(line)))
      return theme === undefined ? padded : theme.paintBackground('inputBackground',
        theme.paint('primary', padded))
    })
  }
  const inner = Math.max(1, width - 4)
  const attachment = attachments.length > 0 && maxRows >= 4
    ? [trustedFit(conversationAttachmentRail(attachments), inner)]
    : []
  const content = cursorWindow(
    composerContentLines(text, cursor, prefix, inner),
    Math.max(1, maxRows - 2 - attachment.length),
  )
  const label = trustedFit(sanitizeLine(labelValue), Math.max(1, width - 6))
  const top = label === ''
    ? '╭' + '─'.repeat(Math.max(0, width - 2)) + '╮'
    : (() => {
        const prefix = `╭─ ${label} `
        return prefix + '─'.repeat(Math.max(0, width - visibleWidth(prefix) - 1)) + '╮'
      })()
  const bottom = '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯'
  const body = [...attachment, ...content].map(line => {
    const visible = trustedFit(line, inner)
    const padding = ' '.repeat(Math.max(0, inner - visibleWidth(visible)))
    if (theme === undefined) return `│ ${visible}${padding} │`
    return theme.paint('composer', '│ ')
      + theme.paint('primary', visible)
      + padding
      + theme.paint('composer', ' │')
  })
  if (theme === undefined) return [top, ...body, bottom]
  return [
    theme.paint('border', top),
    ...body,
    theme.paint('border', bottom),
  ].map(line => theme.paintBackground('inputBackground', line))
}

export interface ConversationComposerLayout {
  readonly lines: readonly string[]
  readonly cursor: { readonly row: number; readonly column: number }
}

export function layoutConversationComposer(
  text: string,
  cursor: number,
  prefix: string,
  label: string,
  boxed: boolean,
  width: number,
  maxRows = 6,
  attachments: readonly ConversationAttachment[] = [],
): ConversationComposerLayout {
  let position: ConversationComposerLayout['cursor'] | undefined
  const lines = composerSurfaceLines(text, cursor, prefix, label, boxed, width, undefined, maxRows, attachments)
    .map((line, row) => {
    const marker = line.indexOf(CURSOR_MARKER)
    if (marker < 0) return line
    position = { row, column: visibleWidth(line.slice(0, marker)) }
    return line.slice(0, marker) + line.slice(marker + CURSOR_MARKER.length)
    })
  return { lines, cursor: position! }
}

class ComposerComponent implements Component {
  private text = ''
  private cursor = 0
  private prefix = '> '
  private label = ''
  private boxed = false
  private maxRows = 6
  private disabled = false
  private attachments: readonly ConversationAttachment[] = []

  constructor(
    private readonly theme: DshTuiTheme,
    private readonly onInput: (data: string) => void,
  ) {}

  setValue(
    text: string,
    cursor: number,
    prefix: string,
    label: string,
    boxed: boolean,
    attachments: readonly ConversationAttachment[],
    maxRows: number,
    disabled: boolean,
  ): void {
    this.text = sanitizeControlText(text)
    this.cursor = Math.max(0, Math.floor(cursor))
    this.prefix = sanitizeLine(prefix)
    this.label = sanitizeLine(label)
    this.boxed = boxed
    this.attachments = attachments
    this.maxRows = maxRows
    this.disabled = disabled
  }

  invalidate(): void {}

  handleInput(data: string): void {
    this.onInput(data)
  }

  render(widthValue: number): string[] {
    return [...composerSurfaceLines(
      this.text,
      this.cursor,
      this.prefix,
      this.label,
      this.boxed,
      widthValue,
      this.theme,
      this.maxRows,
      this.attachments,
    )].map(line => this.disabled ? line.replaceAll(CURSOR_MARKER, '') : line)
  }
}

class DockComponent implements Component {
  private dock: ConversationDock | undefined

  constructor(private readonly theme: DshTuiTheme, private readonly onInput: (data: string) => void) {}

  get ownsInput(): boolean { return this.dock?.role === 'interaction' }

  handleInput(data: string): void { this.onInput(data) }

  setDock(dock: ConversationDock | undefined): void {
    this.dock = dock
  }

  get hasContent(): boolean {
    return this.dock !== undefined
  }

  invalidate(): void {}

  render(width: number): string[] {
    const dock = this.dock
    if (dock === undefined) return []
    if (dock.role === 'command' || dock.inline === true) {
      const lines = dock.lines.map((line, index) => {
        const styled = dock.styledLines?.[index]
        if (styled === undefined) {
          return trustedFit(this.theme.paint('primary', sanitizeLine(line)), width)
        }
        return trustedFit(styled.segments.map(segment => {
          const painted = this.theme.paint(segment.tone, sanitizeLine(segment.text))
          return segment.bold === true ? this.theme.bold(painted) : painted
        }).join(''), width)
      })
      return dock.inline === true
        ? lines.map(line => this.theme.paintBackground('panelBackground',
            line + ' '.repeat(Math.max(0, width - visibleWidth(line)))))
        : lines
    }
    return renderCard(
      dock.label,
      cardRole(dock.role),
      dock.lines,
      width,
      this.theme,
      dock.status,
      dock.styledLines,
    )
  }
}

class StatusLineComponent implements Component {
  private statusline: ConversationStatusLine | undefined

  constructor(private readonly theme: DshTuiTheme) {}

  setStatusLine(statusline: ConversationStatusLine | undefined): void {
    this.statusline = statusline === undefined
      ? undefined
      : {
          text: sanitizeLine(statusline.text),
          tone: statusline.tone,
          ...(statusline.segments === undefined
            ? {}
            : {
                segments: statusline.segments.map(segment => ({
                  text: sanitizeLine(segment.text),
                  tone: segment.tone,
                })),
              }),
        }
  }

  get hasContent(): boolean {
    return this.statusline !== undefined && this.statusline.text !== ''
  }

  invalidate(): void {}

  render(width: number): string[] {
    const statusline = this.statusline
    if (statusline === undefined) return []
    if (statusline.segments === undefined || statusline.segments.length === 0) {
      return [trustedFit(this.theme.paint(statusline.tone, statusline.text), width)]
    }
    const rail = this.theme.bold(this.theme.paint('telemetry', '◆ '))
      + statusline.segments.map(segment => this.theme.paint(segment.tone, segment.text))
        .join(this.theme.paint('border', ' │ '))
    return [trustedFit(rail, width)]
  }
}


function dashboardSurfaceLines(
  dashboard: ConversationDashboard,
  widthValue: number,
  theme?: DshTuiTheme,
): readonly string[] {
  const width = Math.max(1, Math.floor(widthValue))
  const label = trustedFit(
    sanitizeLine(dashboard.label),
    width < 12 ? width : Math.max(1, width - 6),
  )
  const lines = dashboard.lines.map(line => ({
    text: sanitizeLine(line.text),
    tone: line.tone,
  }))
  if (width < 12) {
    return [
      theme === undefined
        ? trustedFit(label, width)
        : trustedFit(theme.bold(theme.paint('dashboard', label)), width),
      ...lines.map(line => trustedFit(
        theme === undefined ? line.text : theme.paint(line.tone, line.text),
        width,
      )),
    ]
  }
  const inner = Math.max(1, width - 4)
  const topPrefix = `╭─ ${label} `
  const top = topPrefix + '─'.repeat(Math.max(0, width - visibleWidth(topPrefix) - 1)) + '╮'
  const bottom = '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯'
  const body = (lines.length === 0 ? [{ text: '', tone: 'muted' as const }] : lines)
    .map(line => {
      const text = trustedFit(line.text, inner)
      const padding = ' '.repeat(Math.max(0, inner - visibleWidth(text)))
      if (theme === undefined) return `│ ${text}${padding} │`
      return theme.paint('dashboard', '│ ')
        + theme.paint(line.tone, text)
        + padding
        + theme.paint('dashboard', ' │')
    })
  if (theme === undefined) return [top, ...body, bottom]
  return [
    theme.bold(theme.paint('dashboard', top)),
    ...body,
    theme.paint('dashboard', bottom),
  ]
}

export function layoutConversationDashboard(
  dashboard: ConversationDashboard,
  width: number,
): readonly string[] {
  return dashboardSurfaceLines(dashboard, width)
}

class DashboardComponent implements Component {
  private dashboard: ConversationDashboard | undefined

  constructor(private readonly theme: DshTuiTheme) {}

  setDashboard(dashboard: ConversationDashboard | undefined): void {
    this.dashboard = dashboard === undefined
      ? undefined
      : {
          label: sanitizeLine(dashboard.label),
          lines: dashboard.lines.map(line => ({
            text: sanitizeLine(line.text),
            tone: line.tone,
          })),
        }
  }

  get hasContent(): boolean {
    return this.dashboard !== undefined
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.dashboard === undefined
      ? []
      : [...dashboardSurfaceLines(this.dashboard, width, this.theme)]
  }
}

function surfaceRevision(surface: ConversationSurface): string {
  return surface.nodes.map(node => `${node.key}:${node.revision}`).join('|')
}

export class ConversationRoot {
  readonly document: ConversationDocumentComponent
  readonly scroll: ScrollView
  readonly component: VStack
  get focusTarget(): Component { return this.dock.ownsInput ? this.dock : this.composer }
  private readonly header: FixedLineComponent
  private readonly composer: ComposerComponent
  private readonly footer: Component
  private readonly dock: DockComponent
  private readonly dashboard: DashboardComponent
  private readonly statusline: StatusLineComponent
  private readonly timeline: ConversationTimelineComponent
  private activeSessionId: string | undefined
  private activeEpoch: number | undefined
  private lastTailKey: string | undefined
  private revision = ''
  private baseFooter = ''
  private unseen = false
  private activeFollowRequest = 0
  private pendingRestore: ViewportSnapshot | undefined
  private readonly snapshots = new Map<string, ViewportSnapshot>()

  constructor(
    theme: DshTuiTheme,
    onInput: (data: string) => void,
    motion?: ConversationMotionRuntime,
  ) {
    this.document = new ConversationDocumentComponent(theme)
    this.timeline = new ConversationTimelineComponent(
      this.document,
      new AgentRequestActivityComponent(theme, motion),
    )
    this.scroll = new ScrollView(this.timeline, {
      follow: 'end',
      primary: true,
      overscroll: 'chain',
      scrollbar: 'auto',
      scrollbarStyle: text => theme.paint('muted', text),
    })
    this.header = new FixedLineComponent(theme, 'accent', true)
    this.composer = new ComposerComponent(theme, onInput)
    this.dock = new DockComponent(theme, onInput)
    this.dashboard = new DashboardComponent(theme)
    this.statusline = new StatusLineComponent(theme)
    this.footer = {
      invalidate: () => {},
      render: width => {
        if (this.scroll.isFollowingEnd) this.unseen = false
        const message = [
          this.unseen ? 'New output' : undefined,
          this.baseFooter === '' ? undefined : this.baseFooter,
        ].filter((item): item is string => item !== undefined).join(' · ')
        return message === ''
          ? []
          : [trustedFit(theme.paint('muted', message), width)]
      },
    }
    this.component = new VStack([
      { component: this.header, basis: 1, shrink: 0, visible: viewport => viewport.height >= 1 },
      { component: this.dashboard, basis: 'auto', shrink: 1, minSize: 0, maxSize: 9,
        visible: viewport => viewport.height >= 7 && this.dashboard.hasContent },
      { component: this.scroll, basis: 1, grow: 1, shrink: 1, minSize: 0,
        visible: viewport => {
          const visible = viewport.height >= 4
          this.timeline.setVisible(visible)
          return visible
        } },
      { component: this.footer, basis: 1, shrink: 1, minSize: 0,
        visible: viewport => viewport.height >= 3 && (this.baseFooter !== '' || this.unseen) },
      { component: { invalidate: () => {}, render: () => [''] }, basis: 1, shrink: 0,
        visible: viewport => viewport.height >= 6 },
      { component: this.dock, basis: 'auto', shrink: 0, minSize: 0, maxSize: 12,
        visible: viewport => viewport.height >= 5 && this.dock.hasContent },
      { component: this.composer, basis: 'auto', shrink: 0, minSize: 1,
        visible: viewport => viewport.height >= 2 },
      { component: this.statusline, basis: 1, shrink: 0,
        visible: viewport => viewport.height >= 5 && this.statusline.hasContent },
    ])
  }

  setSurface(surface: ConversationSurface): void {
    if (
      this.activeSessionId === surface.sessionId
      && this.activeEpoch !== undefined
      && surface.bindingEpoch < this.activeEpoch
    ) return
    const followRequest = Math.max(0, Math.floor(surface.followRequest ?? 0))
    const nextRevision = surfaceRevision(surface)
    const switching = this.activeSessionId !== undefined && (
      this.activeSessionId !== surface.sessionId || this.activeEpoch !== surface.bindingEpoch
    )
    const previousSnapshot = this.currentSnapshot()
    if (switching && this.activeSessionId !== undefined) {
      this.remember(this.activeSessionId, previousSnapshot)
    }
    if (switching || this.activeSessionId === undefined) {
      const remembered = this.snapshots.get(surface.sessionId)
      this.pendingRestore = remembered ?? {
        followingEnd: true,
        unseen: false,
        followRequest,
      }
      this.unseen = this.pendingRestore.unseen
      if (remembered !== undefined && followRequest > remembered.followRequest) {
        this.pendingRestore = { followingEnd: true, unseen: false, followRequest }
        this.unseen = false
      }
    } else if (this.pendingRestore === undefined) {
      if (nextRevision !== this.revision && !previousSnapshot.followingEnd) this.unseen = true
      this.pendingRestore = { ...previousSnapshot, unseen: this.unseen }
      if (followRequest > this.activeFollowRequest) {
        this.pendingRestore = { followingEnd: true, unseen: false, followRequest }
        this.unseen = false
      }
    }
    const nextTail = surface.nodes.at(-1)
    if (!switching && nextTail?.kind === 'user' && nextTail.key !== this.lastTailKey) {
      this.pendingRestore = { followingEnd: true, unseen: false, followRequest }
      this.unseen = false
    }
    this.activeSessionId = surface.sessionId
    this.activeEpoch = surface.bindingEpoch
    this.activeFollowRequest = followRequest
    this.lastTailKey = nextTail?.key
    this.revision = nextRevision
    this.header.setText(surface.header)
    this.document.setDensity(surface.density ?? 'compact')
    this.document.setNodes(surface.nodes, surface.reasoningExpanded)
    this.timeline.setReducedMotion(surface.reducedMotion === true)
    this.timeline.setAgentRequestStatus(
      `${surface.sessionId}:${surface.bindingEpoch}`,
      surface.agentRequest,
    )
    this.dashboard.setDashboard(surface.dashboard)
    this.dock.setDock(surface.dock)
    this.statusline.setStatusLine(surface.statusline)
    this.composer.setValue(
      surface.composer,
      surface.composerColumn,
      surface.composerPrefix,
      surface.composerLabel ?? '',
      surface.composerBoxed === true,
      surface.attachments ?? [],
      surface.composerMaxRows ?? 6,
      surface.composerDisabled === true,
    )
    this.baseFooter = sanitizeLine(surface.footer)
  }

  captureBeforeResize(): void {
    if (this.activeSessionId === undefined || this.pendingRestore !== undefined) return
    this.pendingRestore = this.currentSnapshot()
  }

  deactivate(): void {
    if (this.activeSessionId !== undefined) this.remember(this.activeSessionId, this.currentSnapshot())
    this.timeline.setVisible(false)
  }

  restoreAfterLayout(): boolean {
    const snapshot = this.pendingRestore
    if (snapshot === undefined) return false
    this.pendingRestore = undefined
    const before = this.scroll.scrollTop
    this.unseen = snapshot.unseen
    if (snapshot.followingEnd) {
      this.scroll.scrollToEnd()
    } else if (snapshot.anchor !== undefined) {
      this.scroll.scrollTo(this.document.scrollTopFor(snapshot.anchor), { disableFollow: true })
    }
    return before !== this.scroll.scrollTop
  }

  dispose(): void {
    this.scroll.setScrollbar('hidden')
    this.document.clear()
    this.timeline.dispose()
    this.snapshots.clear()
    this.pendingRestore = undefined
    this.activeSessionId = undefined
    this.activeEpoch = undefined
    this.activeFollowRequest = 0
    this.lastTailKey = undefined
  }

  private currentSnapshot(): ViewportSnapshot {
    const followingEnd = this.scroll.isFollowingEnd
    const anchor = followingEnd ? undefined : this.document.anchorAt(this.scroll.scrollTop)
    return {
      followingEnd,
      ...(anchor === undefined ? {} : { anchor }),
      unseen: this.unseen,
      followRequest: this.activeFollowRequest,
    }
  }

  private remember(sessionId: string, snapshot: ViewportSnapshot): void {
    this.snapshots.delete(sessionId)
    this.snapshots.set(sessionId, snapshot)
    while (this.snapshots.size > SNAPSHOT_LIMIT) {
      const oldest = this.snapshots.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.snapshots.delete(oldest)
    }
  }
}
