import {
  createFeatureSurfaceProjection,
  createFeatureDetailSurface,
  sliceFeatureSurfaceText,
  type FeatureSurfaceInvalidationListener,
  type FeatureSurfaceProjectContext,
  type FeatureSurfaceRowInput,
  type FeatureSurfaceTone,
  type FeatureSurfaceUiNode,
} from '../../presentation/feature-surface.ts'
import type { DiffFeatureState } from './machine.ts'
import type {
  DiffProjectedFile,
  DiffProjectedHunk,
  DiffProjectedLine,
  DiffProjection,
  DiffProjectionTruncation,
} from './projectors.ts'
import type { DiffFileStatus, DiffLineKind } from './port.ts'

export interface DiffStateSource {
  snapshot(): DiffFeatureState
  onChanged(listener: (state: DiffFeatureState) => void): () => void
}

export interface DiffContentNode extends FeatureSurfaceUiNode {
  readonly kind: 'diff.content'
  readonly resourceId: string
  readonly state: DiffStateSource
}

export interface DiffInspectorNode extends FeatureSurfaceUiNode {
  readonly kind: 'diff.inspector'
  readonly resourceId: string
  readonly state: DiffStateSource
}

export type DiffUiNode = DiffContentNode | DiffInspectorNode

function onChanged(
  state: DiffStateSource,
  listener: FeatureSurfaceInvalidationListener,
): () => void {
  return state.onChanged(() => { listener() })
}

function phaseOf(
  context: FeatureSurfaceProjectContext,
  resourceId: string,
  state: DiffFeatureState,
): string {
  return context.resources.find(resource => resource.id === resourceId)?.phase ?? state.phase
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function statusCode(status: DiffFileStatus): string {
  switch (status) {
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'modified': return 'M'
    case 'renamed': return 'R'
  }
}

function statusTone(status: DiffFileStatus): FeatureSurfaceTone {
  if (status === 'added') return 'added'
  if (status === 'deleted') return 'removed'
  if (status === 'renamed') return 'info'
  return 'accent'
}

function lineTone(kind: DiffLineKind): FeatureSurfaceTone {
  if (kind === 'added') return 'added'
  if (kind === 'removed') return 'removed'
  return 'muted'
}

function linePrefix(kind: DiffLineKind): string {
  if (kind === 'added') return '+'
  if (kind === 'removed') return '-'
  return ' '
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lineNumberWidth(projection: DiffProjection): number {
  let maximum = 1
  for (const file of projection.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        maximum = Math.max(maximum, line.oldLine ?? 0, line.newLine ?? 0)
      }
    }
  }
  return String(maximum).length
}

function fileLineStats(file: DiffProjectedFile): { readonly added: number; readonly removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added') added += 1
      if (line.kind === 'removed') removed += 1
    }
  }
  return { added, removed }
}

function hunkLineStats(hunk: DiffProjectedHunk): { readonly added: number; readonly removed: number } {
  let added = 0
  let removed = 0
  for (const line of hunk.lines) {
    if (line.kind === 'added') added += 1
    if (line.kind === 'removed') removed += 1
  }
  return { added, removed }
}

interface DiffBodyProjection {
  readonly rows: readonly FeatureSurfaceRowInput[]
  readonly selectedIndex: number
}

function diffBody(state: DiffFeatureState, projection: DiffProjection): DiffBodyProjection {
  const rows: FeatureSurfaceRowInput[] = []
  let selectedIndex = -1
  const numberWidth = lineNumberWidth(projection)
  for (const [fileIndex, file] of projection.files.entries()) {
    const selectedFile = fileIndex === state.selection.fileIndex
    const displayPath = file.previousPath === undefined
      ? file.path
      : `${file.previousPath} → ${file.path}`
    rows.push({
      text: `${statusCode(file.status)}  ${displayPath}`,
      tone: statusTone(file.status),
      bold: selectedFile,
    })
    for (const [hunkIndex, hunk] of file.hunks.entries()) {
      const selectedHunk = selectedFile && hunkIndex === state.selection.hunkIndex
      const collapsed = state.collapsedHunkIds.includes(hunk.id)
      const hunkRowIndex = rows.length
      rows.push({
        text: `${collapsed ? '▸' : '▾'} ${hunk.header || hunk.id}`
          + (collapsed ? ` · ${countLabel(hunk.totalLines, 'line')} folded` : ''),
        tone: 'info',
        bold: selectedHunk,
        selected: collapsed && selectedHunk,
      })
      if (collapsed && selectedHunk) selectedIndex = hunkRowIndex
      if (!collapsed) {
        if (hunk.lines.length === 0 && selectedHunk) selectedIndex = hunkRowIndex
        for (const [lineIndex, line] of hunk.lines.entries()) {
          const selected = selectedHunk && lineIndex === state.selection.lineIndex
          const oldLine = line.oldLine === undefined ? '' : String(line.oldLine)
          const newLine = line.newLine === undefined ? '' : String(line.newLine)
          const shifted = sliceFeatureSurfaceText(
            line.text,
            state.selection.horizontalOffset,
          )
          const rowIndex = rows.length
          rows.push({
            text: `${oldLine.padStart(numberWidth)} ${newLine.padStart(numberWidth)} ${linePrefix(line.kind)} ${shifted}`,
            tone: lineTone(line.kind),
            bold: selected,
            selected,
          })
          if (selected) selectedIndex = rowIndex
        }
        if (hunk.hiddenLines > 0) {
          rows.push({
            text: `  … ${countLabel(hunk.hiddenLines, 'hidden line')}`,
            tone: 'warning',
            dim: true,
          })
        }
      }
    }
    if (file.hiddenHunks > 0) {
      rows.push({
        text: `… ${countLabel(file.hiddenHunks, 'hidden hunk')} in ${file.path}`,
        tone: 'warning',
        dim: true,
      })
    }
  }
  return { rows, selectedIndex }
}

function truncationRow(truncation: DiffProjectionTruncation): FeatureSurfaceRowInput | undefined {
  if (!truncation.truncated) return undefined
  const parts: string[] = []
  if (truncation.hiddenFiles > 0) parts.push(countLabel(truncation.hiddenFiles, 'hidden file'))
  if (truncation.hiddenHunks > 0) parts.push(countLabel(truncation.hiddenHunks, 'hidden hunk'))
  if (truncation.hiddenLines > 0) parts.push(countLabel(truncation.hiddenLines, 'hidden line'))
  if (truncation.shortenedTexts > 0) parts.push(countLabel(truncation.shortenedTexts, 'shortened row'))
  return { text: `TRUNCATED  ${parts.join(' · ')}`, tone: 'warning', dim: true }
}

function windowRows(
  header: FeatureSurfaceRowInput,
  body: DiffBodyProjection,
  footers: readonly FeatureSurfaceRowInput[],
  requestedHeight: number,
): readonly FeatureSurfaceRowInput[] {
  const height = Number.isFinite(requestedHeight)
    ? Math.max(0, Math.floor(requestedHeight))
    : 0
  if (height === 0) return []
  if (height === 1) return [header]
  const keptFooters = footers.slice(0, Math.max(0, height - 2))
  const capacity = Math.max(0, height - 1 - keptFooters.length)
  if (body.rows.length <= capacity) return [header, ...body.rows, ...keptFooters]
  const anchor = body.selectedIndex < 0 ? 0 : body.selectedIndex
  const start = Math.max(0, Math.min(
    body.rows.length - capacity,
    anchor - Math.floor(capacity / 2),
  ))
  return [header, ...body.rows.slice(start, start + capacity), ...keptFooters]
}

function diffContentRows(
  context: FeatureSurfaceProjectContext,
  resourceId: string,
  state: DiffFeatureState,
): readonly FeatureSurfaceRowInput[] {
  const phase = phaseOf(context, resourceId, state)
  const projection = state.projection
  if (projection === null) {
    const text = state.phase === 'failed'
      ? `Diff failed · ${errorMessage(state.error)}`
      : state.phase === 'empty'
        ? 'Working tree has no changes'
        : state.phase === 'loading'
          ? 'Computing diff…'
          : 'Open Diff to inspect changes'
    return [
      { text: `DIFF  ${phase}`, tone: state.phase === 'failed' ? 'danger' : 'accent', bold: true },
      { text, tone: state.phase === 'failed' ? 'danger' : 'muted', dim: state.phase !== 'failed' },
    ]
  }

  const header: FeatureSurfaceRowInput = {
    text: `${projection.title ?? 'DIFF'}  ${countLabel(projection.stats.files, 'file')}`
      + ` · +${projection.stats.added} -${projection.stats.removed}`
      + (phase === 'ready' ? '' : ` · ${phase}`),
    tone: state.phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }
  const footers: FeatureSurfaceRowInput[] = []
  const truncated = truncationRow(projection.truncation)
  if (truncated !== undefined) footers.push(truncated)
  if (state.phase === 'loading') {
    footers.push({ text: 'Refreshing diff…', tone: 'warning', dim: true })
  } else if (state.phase === 'failed') {
    footers.push({ text: `Refresh failed · ${errorMessage(state.error)}`, tone: 'danger' })
  }
  return windowRows(header, diffBody(state, projection), footers, context.bounds.height)
}

function selectedLine(
  projection: DiffProjection,
  state: DiffFeatureState,
): {
  readonly file: DiffProjectedFile
  readonly hunk: DiffProjectedHunk
  readonly line?: DiffProjectedLine
} | undefined {
  const file = projection.files[state.selection.fileIndex]
  const hunk = file?.hunks[state.selection.hunkIndex]
  if (file === undefined || hunk === undefined) return undefined
  const line = hunk.lines[state.selection.lineIndex]
  return { file, hunk, ...(line === undefined ? {} : { line }) }
}

function lineLocation(line: DiffProjectedLine): string {
  const oldLine = line.oldLine === undefined ? '—' : String(line.oldLine)
  const newLine = line.newLine === undefined ? '—' : String(line.newLine)
  return `${oldLine} → ${newLine}`
}

function diffInspectorRows(
  context: FeatureSurfaceProjectContext,
  resourceId: string,
  state: DiffFeatureState,
): readonly FeatureSurfaceRowInput[] {
  const phase = phaseOf(context, resourceId, state)
  const rows: FeatureSurfaceRowInput[] = [{
    text: `DIFF INSPECTOR  ${phase}`,
    tone: state.phase === 'failed' ? 'danger' : 'accent',
    bold: true,
  }]
  const projection = state.projection
  if (projection === null) {
    rows.push({
      text: state.phase === 'failed'
        ? `Load failed · ${errorMessage(state.error)}`
        : state.phase === 'empty'
          ? 'No changed files'
          : state.phase === 'loading'
            ? 'Waiting for diff details…'
            : 'No diff selected',
      tone: state.phase === 'failed' ? 'danger' : 'muted',
      dim: state.phase !== 'failed',
    })
    return rows
  }
  const selected = selectedLine(projection, state)
  if (selected === undefined) {
    rows.push({ text: 'No hunk selected', tone: 'muted', dim: true })
  } else {
    const fileStats = fileLineStats(selected.file)
    const hunkStats = hunkLineStats(selected.hunk)
    const collapsed = state.collapsedHunkIds.includes(selected.hunk.id)
    rows.push({
      text: `${statusCode(selected.file.status)}  ${selected.file.path}`,
      tone: statusTone(selected.file.status),
      bold: true,
      selected: true,
    })
    if (selected.file.previousPath !== undefined) {
      rows.push({ text: `From  ${selected.file.previousPath}`, tone: 'muted', dim: true })
    }
    rows.push({
      text: `Hunk  ${state.selection.hunkIndex + 1}/${selected.file.hunks.length}`
        + ` · ${collapsed ? 'folded' : 'expanded'} · +${hunkStats.added} -${hunkStats.removed}`,
      tone: 'info',
    })
    rows.push({ text: selected.hunk.header || selected.hunk.id, tone: 'muted' })
    if (selected.line !== undefined) {
      rows.push({
        text: `Line  ${lineLocation(selected.line)} · ${selected.line.kind}`,
        tone: lineTone(selected.line.kind),
      })
      rows.push({
        text: `${linePrefix(selected.line.kind)} ${sliceFeatureSurfaceText(
          selected.line.text,
          state.selection.horizontalOffset,
        )}`,
        tone: lineTone(selected.line.kind),
        bold: true,
      })
    }
    rows.push({
      text: `File  ${countLabel(selected.file.totalHunks, 'hunk')} · +${fileStats.added} -${fileStats.removed}`,
      tone: 'muted',
    })
  }
  rows.push({
    text: `Total  ${countLabel(projection.stats.files, 'file')} · ${countLabel(projection.stats.hunks, 'hunk')} · +${projection.stats.added} -${projection.stats.removed}`,
    tone: 'muted',
  })
  const truncated = truncationRow(projection.truncation)
  if (truncated !== undefined) rows.push(truncated)
  if (state.phase === 'failed') {
    rows.push({ text: `Refresh failed · ${errorMessage(state.error)}`, tone: 'danger' })
  }
  return rows
}

export function createDiffContentNode(
  resourceId: string,
  state: DiffStateSource,
): DiffContentNode {
  return Object.freeze({
    kind: 'diff.content',
    resourceId,
    state,
    project: (context: FeatureSurfaceProjectContext) => createFeatureSurfaceProjection(
      context,
      diffContentRows(context, resourceId, state.snapshot()),
    ),
    onChanged: (listener: FeatureSurfaceInvalidationListener) => onChanged(state, listener),
  })
}

export function createDiffInspectorNode(
  resourceId: string,
  state: DiffStateSource,
): DiffInspectorNode {
  return Object.freeze({
    kind: 'diff.inspector',
    resourceId,
    state,
    ...createFeatureDetailSurface({
      rows: context => diffInspectorRows(context, resourceId, state.snapshot()),
      key: () => {
        const selection = state.snapshot().selection
        return `${selection.fileIndex}:${selection.hunkIndex}:${selection.lineIndex}`
      },
      hasContent: () => state.snapshot().phase !== 'idle' && state.snapshot().phase !== 'empty',
      onChanged: listener => onChanged(state, listener),
    }),
  })
}
