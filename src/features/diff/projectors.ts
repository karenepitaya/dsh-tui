import type {
  DiffDocument,
  DiffFileStatus,
  DiffLineKind,
} from './port.ts'

export interface DiffProjectionLimits {
  readonly maxFiles: number
  readonly maxHunksPerFile: number
  readonly maxLinesPerHunk: number
  readonly maxTextCodePoints: number
}

export interface DiffProjectedLine {
  readonly kind: DiffLineKind
  readonly oldLine?: number
  readonly newLine?: number
  readonly text: string
}

export interface DiffProjectedHunk {
  readonly id: string
  readonly header: string
  readonly lines: readonly DiffProjectedLine[]
  readonly totalLines: number
  readonly hiddenLines: number
}

export interface DiffProjectedFile {
  readonly id: string
  readonly path: string
  readonly previousPath?: string
  readonly status: DiffFileStatus
  readonly hunks: readonly DiffProjectedHunk[]
  readonly totalHunks: number
  readonly hiddenHunks: number
}

export interface DiffProjectionStats {
  readonly files: number
  readonly hunks: number
  readonly lines: number
  readonly added: number
  readonly removed: number
}

export interface DiffProjectionTruncation {
  readonly truncated: boolean
  readonly hiddenFiles: number
  readonly hiddenHunks: number
  readonly hiddenLines: number
  readonly shortenedTexts: number
}

/** Immutable semantic details. Styling and ANSI belong to a later renderer. */
export interface DiffProjection {
  readonly kind: 'diff-projection'
  readonly digest: string
  readonly title?: string
  readonly files: readonly DiffProjectedFile[]
  readonly stats: DiffProjectionStats
  readonly truncation: DiffProjectionTruncation
}

export type DiffProjector = (
  document: DiffDocument,
  limits?: Partial<DiffProjectionLimits>,
) => DiffProjection

export const DEFAULT_DIFF_PROJECTION_LIMITS: DiffProjectionLimits = Object.freeze({
  maxFiles: 200,
  maxHunksPerFile: 200,
  maxLinesPerHunk: 2_000,
  maxTextCodePoints: 4_096,
})

interface MutableStats {
  files: number
  hunks: number
  lines: number
  added: number
  removed: number
}

interface MutableTruncation {
  hiddenFiles: number
  hiddenHunks: number
  hiddenLines: number
  shortenedTexts: number
}

export function projectDiffDocument(
  document: DiffDocument,
  overrides: Partial<DiffProjectionLimits> = {},
): DiffProjection {
  const digest = requireIdentity(document.digest, 'Diff digest')
  const limits = resolveLimits(overrides)
  const stats = summarize(document)
  const truncation: MutableTruncation = {
    hiddenFiles: Math.max(0, document.files.length - limits.maxFiles),
    hiddenHunks: 0,
    hiddenLines: 0,
    shortenedTexts: 0,
  }

  const files = document.files.slice(0, limits.maxFiles).map((file, fileIndex) => {
    const path = safeText(
      file.path,
      DEFAULT_DIFF_PROJECTION_LIMITS.maxTextCodePoints,
      truncation,
    )
    if (path.length === 0) throw new Error('Diff file path must not be empty')
    truncation.hiddenHunks += Math.max(0, file.hunks.length - limits.maxHunksPerFile)
    truncation.hiddenLines += file.hunks
      .slice(limits.maxHunksPerFile)
      .reduce((total, hunk) => total + hunk.lines.length, 0)
    const hunks = file.hunks.slice(0, limits.maxHunksPerFile).map((hunk) => {
      truncation.hiddenLines += Math.max(0, hunk.lines.length - limits.maxLinesPerHunk)
      const id = requireIdentity(hunk.id, 'Diff hunk id')
      const lines = hunk.lines.slice(0, limits.maxLinesPerHunk).map(line => Object.freeze({
        kind: line.kind,
        ...(line.oldLine === undefined ? {} : { oldLine: lineNumber(line.oldLine) }),
        ...(line.newLine === undefined ? {} : { newLine: lineNumber(line.newLine) }),
        text: safeText(line.text, limits.maxTextCodePoints, truncation),
      }))
      return Object.freeze({
        id,
        header: safeText(hunk.header, limits.maxTextCodePoints, truncation),
        lines: Object.freeze(lines),
        totalLines: hunk.lines.length,
        hiddenLines: Math.max(0, hunk.lines.length - lines.length),
      })
    })
    return Object.freeze({
      id: `${fileIndex}:${path}`,
      path,
      ...(file.previousPath === undefined
        ? {}
        : {
            previousPath: safeText(
              file.previousPath,
              DEFAULT_DIFF_PROJECTION_LIMITS.maxTextCodePoints,
              truncation,
            ),
          }),
      status: file.status,
      hunks: Object.freeze(hunks),
      totalHunks: file.hunks.length,
      hiddenHunks: Math.max(0, file.hunks.length - hunks.length),
    })
  })

  const hiddenProjectedHunkLines = document.files
    .slice(limits.maxFiles)
    .reduce((total, file) => total + file.hunks.reduce(
      (fileTotal, hunk) => fileTotal + hunk.lines.length,
      0,
    ), 0)
  truncation.hiddenLines += hiddenProjectedHunkLines
  truncation.hiddenHunks += document.files
    .slice(limits.maxFiles)
    .reduce((total, file) => total + file.hunks.length, 0)
  const title = document.title === undefined
    ? undefined
    : safeText(document.title, limits.maxTextCodePoints, truncation)
  const frozenTruncation = Object.freeze({
    truncated: truncation.hiddenFiles > 0
      || truncation.hiddenHunks > 0
      || truncation.hiddenLines > 0
      || truncation.shortenedTexts > 0,
    ...truncation,
  })
  return Object.freeze({
    kind: 'diff-projection',
    digest,
    ...(title === undefined
      ? {}
      : { title }),
    files: Object.freeze(files),
    stats: Object.freeze(stats),
    truncation: frozenTruncation,
  })
}

function summarize(document: DiffDocument): MutableStats {
  const stats: MutableStats = {
    files: document.files.length,
    hunks: 0,
    lines: 0,
    added: 0,
    removed: 0,
  }
  for (const file of document.files) {
    stats.hunks += file.hunks.length
    for (const hunk of file.hunks) {
      stats.lines += hunk.lines.length
      for (const line of hunk.lines) {
        if (line.kind === 'added') stats.added += 1
        if (line.kind === 'removed') stats.removed += 1
      }
    }
  }
  return stats
}

function resolveLimits(overrides: Partial<DiffProjectionLimits>): DiffProjectionLimits {
  return Object.freeze({
    maxFiles: positiveLimit(overrides.maxFiles, DEFAULT_DIFF_PROJECTION_LIMITS.maxFiles),
    maxHunksPerFile: positiveLimit(
      overrides.maxHunksPerFile,
      DEFAULT_DIFF_PROJECTION_LIMITS.maxHunksPerFile,
    ),
    maxLinesPerHunk: positiveLimit(
      overrides.maxLinesPerHunk,
      DEFAULT_DIFF_PROJECTION_LIMITS.maxLinesPerHunk,
    ),
    maxTextCodePoints: positiveLimit(
      overrides.maxTextCodePoints,
      DEFAULT_DIFF_PROJECTION_LIMITS.maxTextCodePoints,
    ),
  })
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 1) throw new Error('Diff projection limits must be positive')
  return Math.floor(value)
}

function requireIdentity(value: string, label: string): string {
  if (value.length === 0 || value.trim() !== value) throw new Error(`${label} must be a trimmed string`)
  return value
}

function lineNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Diff line number must be positive')
  return value
}

/** Remove terminal controls and truncate by Unicode code point, never UTF-16 unit. */
function safeText(
  value: string,
  maxCodePoints: number,
  truncation: MutableTruncation,
): string {
  const safe = Array.from(value, character => terminalSafeCharacter(character)).join('')
  const codePoints = Array.from(safe)
  if (codePoints.length <= maxCodePoints) return safe
  truncation.shortenedTexts += 1
  return `${codePoints.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`
}

function terminalSafeCharacter(character: string): string {
  const value = character.codePointAt(0)!
  if (character === '\t') return character
  return value < 0x20 || (value >= 0x7f && value <= 0x9f) ? '�' : character
}
