/** Renderer-neutral geometry allocated to one Feature-owned surface. */
export interface FeatureSurfaceBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type FeatureSurfaceResourcePhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'refreshing'
  | 'failed'

/** Detached resource facts supplied by the surface host at projection time. */
export interface FeatureSurfaceResourceSnapshot<T = unknown> {
  readonly id: string
  readonly phase: FeatureSurfaceResourcePhase
  readonly value?: T
  readonly lastGood?: T
  readonly error?: unknown
}

/** Inputs a node may use without knowing the terminal renderer or application shell. */
export interface FeatureSurfaceProjectContext {
  readonly bounds: FeatureSurfaceBounds
  readonly focus: boolean
  readonly mode: string
  readonly resources: readonly FeatureSurfaceResourceSnapshot[]
}

export type FeatureSurfaceTone =
  | 'default'
  | 'muted'
  | 'accent'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'added'
  | 'removed'

/** One already-bounded plain-text row plus semantic styling hints. */
export interface FeatureSurfaceRow {
  readonly text: string
  readonly tone: FeatureSurfaceTone
  readonly bold: boolean
  readonly dim: boolean
  readonly selected: boolean
}

export interface FeatureSurfaceCursor {
  readonly row: number
  /** Terminal-cell column, not a UTF-16 string offset. */
  readonly column: number
}

export interface FeatureSurfaceProjection {
  /** User-facing title for this focused surface, independent of its owner or route identifier. */
  readonly title?: string
  /** Available actions for this focused surface; rendered by the shared workspace footer. */
  readonly actionHint?: string
  readonly rows: readonly FeatureSurfaceRow[]
  readonly cursor?: FeatureSurfaceCursor
}

export type FeatureSurfaceInvalidationListener = () => void

/**
 * Common Feature UiNode contract. `kind` remains diagnostic only: a renderer
 * invokes this polymorphic surface and never switches on Feature-owned kinds.
 */
export interface FeatureSurfaceUiNode {
  readonly kind: string
  project(context: FeatureSurfaceProjectContext): FeatureSurfaceProjection
  onChanged(listener: FeatureSurfaceInvalidationListener): () => void
  /** Optional read-only visibility fact for automatically opening a detail pane. */
  hasContent?(): boolean
  /** Local detail scrolling in terminal rows; does not change list selection. */
  scroll?(delta: number): boolean
}

export interface FeatureSurfaceRowInput {
  readonly text: string
  readonly tone?: FeatureSurfaceTone
  readonly bold?: boolean
  readonly dim?: boolean
  readonly selected?: boolean
}

function finiteDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function skipCsi(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
  }
  return source.length
}

function skipControlString(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (code === 0x07 || code === 0x9c) return index + 1
    if (code === 0x1b && source.charCodeAt(index + 1) === 0x5c) return index + 2
  }
  return source.length
}

/** Strip terminal sequences and flatten row-breaking controls into safe text. */
function sanitizeText(source: string, preserveNewlines: boolean): string {
  let result = ''
  let index = 0
  while (index < source.length) {
    const code = source.charCodeAt(index)
    if (code === 0x1b) {
      const introducer = source.charCodeAt(index + 1)
      if (introducer === 0x5b) {
        index = skipCsi(source, index + 2)
      } else if (
        introducer === 0x5d
        || introducer === 0x50
        || introducer === 0x58
        || introducer === 0x5e
        || introducer === 0x5f
      ) {
        index = skipControlString(source, index + 2)
      } else {
        index = Math.min(source.length, index + 2)
      }
      continue
    }
    if (code === 0x9b) {
      index = skipCsi(source, index + 1)
      continue
    }
    if (code === 0x9d || code === 0x90 || code === 0x98
      || code === 0x9e || code === 0x9f) {
      index = skipControlString(source, index + 1)
      continue
    }

    const point = source.codePointAt(index)!
    const character = String.fromCodePoint(point)
    index += character.length
    if (point === 0x09) {
      result += '  '
    } else if (point === 0x0a && preserveNewlines) {
      result += '\n'
    } else if (point === 0x0a || point === 0x0d) {
      result += ' '
    } else if (point < 0x20 || (point >= 0x7f && point <= 0x9f)) {
      result += '�'
    } else {
      result += character
    }
  }
  return result
}

export function safeFeatureSurfaceText(source: string): string {
  return sanitizeText(source, false)
}

function isZeroWidth(character: string, point: number): boolean {
  return point === 0x200b
    || point === 0x200c
    || point === 0x200d
    || (point >= 0xfe00 && point <= 0xfe0f)
    || (point >= 0xe0100 && point <= 0xe01ef)
    || /\p{Mark}/u.test(character)
}

function isWide(point: number): boolean {
  return point >= 0x1100 && (
    point <= 0x115f
    || point === 0x2329
    || point === 0x232a
    || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
    || (point >= 0xac00 && point <= 0xd7a3)
    || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe19)
    || (point >= 0xfe30 && point <= 0xfe6f)
    || (point >= 0xff00 && point <= 0xff60)
    || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x1f300 && point <= 0x1faff)
    || (point >= 0x20000 && point <= 0x3fffd)
  )
}

function characterWidth(character: string): number {
  const point = character.codePointAt(0)!
  if (isZeroWidth(character, point)) return 0
  return isWide(point) ? 2 : 1
}

/** Measure safe text in terminal cells with CJK and combining-mark awareness. */
export function featureSurfaceTextWidth(source: string): number {
  return Array.from(safeFeatureSurfaceText(source))
    .reduce((width, character) => width + characterWidth(character), 0)
}

function fitText(source: string, requestedWidth: number): string {
  const safe = safeFeatureSurfaceText(source)
  const width = finiteDimension(requestedWidth)
  if (width === 0) return ''
  if (featureSurfaceTextWidth(safe) <= width) return safe
  const suffix = '…'
  const available = Math.max(0, width - characterWidth(suffix))
  let result = ''
  let used = 0
  for (const character of Array.from(safe)) {
    const next = characterWidth(character)
    if (used + next > available) break
    result += character
    used += next
  }
  return result + suffix
}

/** Drop a horizontal terminal-cell prefix without splitting UTF-16 code points. */
export function sliceFeatureSurfaceText(source: string, requestedOffset: number): string {
  const safe = safeFeatureSurfaceText(source)
  let remaining = finiteDimension(requestedOffset)
  if (remaining === 0) return safe
  let index = 0
  for (const character of Array.from(safe)) {
    const width = characterWidth(character)
    if (width > 0 && remaining < width) {
      remaining = 0
      index += character.length
      break
    }
    index += character.length
    remaining = Math.max(0, remaining - width)
    if (remaining === 0) break
  }
  return safe.slice(index)
}

/** Pure selection-following list window, shared by every catalog surface. */
export function featureListViewport<T>(
  rows: readonly T[],
  selectedIndex: number,
  requestedCapacity: number,
): readonly T[] {
  const capacity = finiteDimension(requestedCapacity)
  const selected = Math.min(Math.max(0, rows.length - 1), finiteDimension(selectedIndex))
  const start = Math.max(0, Math.min(rows.length - capacity, selected - Math.floor(capacity / 2)))
  return Object.freeze(rows.slice(start, start + capacity))
}

export interface FeatureDetailViewport {
  readonly rows: readonly FeatureSurfaceRowInput[]
  readonly offset: number
  readonly totalRows: number
  readonly maxOffset: number
}

/** Pure wrapping and scrolling: no resource access, terminal state, or Feature mutation. */
export function featureDetailViewport(
  rows: readonly FeatureSurfaceRowInput[],
  requestedWidth: number,
  requestedHeight: number,
  requestedOffset: number,
): FeatureDetailViewport {
  const width = finiteDimension(requestedWidth)
  const height = finiteDimension(requestedHeight)
  const wrapped: FeatureSurfaceRowInput[] = []
  if (width > 0) for (const row of rows) {
    for (const line of sanitizeText(row.text, true).split('\n')) {
      let text = ''
      let used = 0
      for (const character of line) {
        const cells = characterWidth(character)
        if (used + cells > width && text.length > 0) {
          wrapped.push(Object.freeze({ ...row, text }))
          text = ''
          used = 0
        }
        // A double-cell glyph cannot fit a one-column terminal.
        text += cells > width ? '�' : character
        used += Math.min(cells, width)
      }
      wrapped.push(Object.freeze({ ...row, text }))
    }
  }
  const maxOffset = Math.max(0, wrapped.length - height)
  const offset = Math.min(maxOffset, finiteDimension(requestedOffset))
  return Object.freeze({
    rows: Object.freeze(wrapped.slice(offset, offset + height)),
    offset, totalRows: wrapped.length, maxOffset,
  })
}

/** Presentation-local viewport state; the supplied source remains read-only. */
export function createFeatureDetailSurface(source: {
  rows(context: FeatureSurfaceProjectContext): readonly FeatureSurfaceRowInput[]
  key(): unknown
  hasContent(): boolean
  onChanged(listener: FeatureSurfaceInvalidationListener): () => void
}): Required<Pick<FeatureSurfaceUiNode, 'project' | 'scroll' | 'hasContent' | 'onChanged'>> {
  let selectionKey = source.key()
  let offset = 0
  let maxOffset = 0
  const listeners = new Set<FeatureSurfaceInvalidationListener>()
  return Object.freeze({
    hasContent: () => source.hasContent(),
    project(context: FeatureSurfaceProjectContext) {
      const nextKey = source.key()
      if (nextKey !== selectionKey) {
        selectionKey = nextKey
        offset = 0
      }
      const viewport = featureDetailViewport(
        source.rows(context), context.bounds.width, context.bounds.height, offset,
      )
      offset = viewport.offset
      maxOffset = viewport.maxOffset
      return createFeatureSurfaceProjection(context, viewport.rows)
    },
    scroll(delta: number) {
      const next = Math.max(0, Math.min(maxOffset, offset + (Number.isFinite(delta) ? Math.trunc(delta) : 0)))
      if (next === offset) return false
      offset = next
      for (const listener of listeners) listener()
      return true
    },
    onChanged(listener: FeatureSurfaceInvalidationListener) {
      listeners.add(listener)
      const stop = source.onChanged(listener)
      return () => { listeners.delete(listener); stop() }
    },
  })
}

/**
 * Final safety boundary shared by Feature nodes. It strips terminal controls,
 * truncates by cell width, applies the allocated height, and freezes output.
 */
export function createFeatureSurfaceProjection(
  context: FeatureSurfaceProjectContext,
  inputRows: readonly FeatureSurfaceRowInput[],
  cursor?: FeatureSurfaceCursor,
): FeatureSurfaceProjection {
  const width = finiteDimension(context.bounds.width)
  const height = finiteDimension(context.bounds.height)
  const rows = Object.freeze(inputRows.slice(0, height).map(row => Object.freeze({
    text: fitText(row.text, width),
    tone: row.tone ?? 'default',
    bold: row.bold === true,
    dim: row.dim === true,
    selected: row.selected === true,
  } satisfies FeatureSurfaceRow)))
  let visibleCursor: FeatureSurfaceCursor | undefined
  if (cursor !== undefined
    && Number.isFinite(cursor.row)
    && Number.isFinite(cursor.column)) {
    const cursorRow = Math.floor(cursor.row)
    if (cursorRow >= 0 && cursorRow < rows.length) {
      visibleCursor = Object.freeze({
        row: cursorRow,
        column: Math.min(
          width,
          featureSurfaceTextWidth(rows[cursorRow]!.text),
          Math.max(0, Math.floor(cursor.column)),
        ),
      })
    }
  }
  return Object.freeze({
    rows,
    ...(visibleCursor === undefined ? {} : { cursor: visibleCursor }),
  })
}
