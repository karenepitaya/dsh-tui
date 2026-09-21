import type { FeatureSurfaceRuntimeSnapshot } from '../app/feature-surface-runtime.ts'
import type { LayoutBounds, LayoutPlacement } from '../layout/strategy.ts'
import {
  safeFeatureSurfaceText,
  type FeatureSurfaceCursor,
  type FeatureSurfaceProjectContext,
  type FeatureSurfaceResourceSnapshot,
  type FeatureSurfaceRow,
  type FeatureSurfaceTone,
} from '../presentation/feature-surface.ts'
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from '../terminal/text-layout.ts'
import type {
  TerminalViewport,
  UiCursor,
  UiFrame,
  UiFrameLineStyle,
  UiFrameStyleSpan,
} from './frame.ts'
import type { DshTuiSemanticRole } from './theme.ts'

interface ProjectedPlacement {
  readonly title?: string
  readonly actionHint?: string
  readonly rows: readonly FeatureSurfaceRow[]
  readonly cursor?: FeatureSurfaceCursor
}

interface BoundedPlacement {
  readonly placement: LayoutPlacement
  readonly bounds: LayoutBounds
  readonly featureId: string | undefined
  readonly focused: boolean
  readonly order: number
}

interface LineStyleCandidate {
  readonly style: UiFrameLineStyle
  readonly focused: boolean
  readonly overlay: boolean
  readonly semantic: boolean
}

interface CursorCandidate {
  readonly cursor: UiCursor
  readonly focused: boolean
  readonly overlay: boolean
}

const FEATURE_TONES: Readonly<Record<FeatureSurfaceTone, DshTuiSemanticRole>> = Object.freeze({
  default: 'primary',
  muted: 'muted',
  accent: 'accent',
  info: 'telemetry',
  success: 'success',
  warning: 'warning',
  danger: 'error',
  added: 'success',
  removed: 'error',
})

const VALID_TONES: readonly FeatureSurfaceTone[] = Object.freeze([
  'default',
  'muted',
  'accent',
  'info',
  'success',
  'warning',
  'danger',
  'added',
  'removed',
])

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function boundedViewport(viewport: TerminalViewport): TerminalViewport {
  return Object.freeze({
    columns: dimension(viewport.columns),
    rows: dimension(viewport.rows),
  })
}

function intersection(
  bounds: LayoutBounds,
  viewport: TerminalViewport,
): LayoutBounds | undefined {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    return undefined
  }
  const x = Math.max(0, Math.floor(bounds.x))
  const y = Math.max(0, Math.floor(bounds.y))
  if (x >= viewport.columns || y >= viewport.rows) return undefined
  const width = Math.min(
    viewport.columns - x,
    Math.max(0, Math.floor(bounds.width)),
  )
  const height = Math.min(
    viewport.rows - y,
    Math.max(0, Math.floor(bounds.height)),
  )
  if (width === 0 || height === 0) return undefined
  return Object.freeze({ x, y, width, height })
}

function featureIdFor(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  placement: LayoutPlacement,
): string | undefined {
  const exact = snapshot.host.slots.contributions.find(candidate => (
    candidate.value === placement.region
  ))
  if (exact !== undefined) return exact.featureId
  return snapshot.host.slots.contributions.find(candidate => (
    candidate.value.id === placement.region.id
  ))?.featureId
}

function routeFeatureId(snapshot: FeatureSurfaceRuntimeSnapshot): string | undefined {
  const route = snapshot.host.navigation.route
  if (route.kind !== 'chat') return route.featureId
  return snapshot.host.routes.find(candidate => candidate.route.kind === 'chat')?.featureId
}

function isFocused(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  placement: LayoutPlacement,
  featureId: string | undefined,
  order: number,
): boolean {
  const navigation = snapshot.host.navigation
  switch (navigation.focus.kind) {
    case 'composer':
      return placement.area === 'composer'
    case 'feature': {
      if (featureId !== routeFeatureId(snapshot)) return false
      return navigation.route.kind === 'chat'
        ? placement.area === 'timeline'
        : placement.area === navigation.route.pane
    }
    case 'overlay': {
      const focus = navigation.focus
      if (placement.area !== 'overlay' || featureId !== focus.featureId) return false
      const laterOwnedOverlay = snapshot.layout.placements.slice(order + 1).some(candidate => (
        candidate.area === 'overlay'
        && featureIdFor(snapshot, candidate) === focus.featureId
      ))
      return !laterOwnedOverlay
    }
  }
}

function resourcesFor(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  featureId: string | undefined,
): readonly FeatureSurfaceResourceSnapshot[] {
  if (featureId === undefined) return Object.freeze([])
  const surface = snapshot.surfaces.find(candidate => candidate.featureId === featureId)
  if (surface === undefined) return Object.freeze([])
  return Object.freeze(surface.resources.map((resource) => {
    const state = resource.state
    return Object.freeze({
      id: resource.id,
      phase: state.phase,
      ...(Object.hasOwn(state, 'value') ? { value: state.value } : {}),
      ...(Object.hasOwn(state, 'lastGood') ? { lastGood: state.lastGood } : {}),
      ...(Object.hasOwn(state, 'error') ? { error: state.error } : {}),
    })
  }))
}

function projectContext(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  bounded: BoundedPlacement,
): FeatureSurfaceProjectContext {
  return Object.freeze({
    bounds: bounded.bounds,
    focus: bounded.focused,
    mode: snapshot.host.navigation.mode,
    resources: resourcesFor(snapshot, bounded.featureId),
  })
}

function record(value: unknown): Readonly<Record<PropertyKey, unknown>> | undefined {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? value as Readonly<Record<PropertyKey, unknown>>
    : undefined
}

function validTone(value: unknown): value is FeatureSurfaceTone {
  return typeof value === 'string'
    && (VALID_TONES as readonly string[]).includes(value)
}

function requireRow(value: unknown, width: number): FeatureSurfaceRow {
  const candidate = record(value)
  if (candidate === undefined
    || typeof candidate.text !== 'string'
    || !validTone(candidate.tone)
    || typeof candidate.bold !== 'boolean'
    || typeof candidate.dim !== 'boolean'
    || typeof candidate.selected !== 'boolean') {
    throw new Error('invalid row projection')
  }
  return Object.freeze({
    text: truncateToWidth(safeFeatureSurfaceText(candidate.text), width, ''),
    tone: candidate.tone,
    bold: candidate.bold,
    dim: candidate.dim,
    selected: candidate.selected,
  })
}

function requireCursor(
  value: unknown,
  rows: readonly FeatureSurfaceRow[],
  width: number,
): FeatureSurfaceCursor | undefined {
  if (value === undefined) return undefined
  const candidate = record(value)
  if (candidate === undefined
    || typeof candidate.row !== 'number'
    || !Number.isFinite(candidate.row)
    || typeof candidate.column !== 'number'
    || !Number.isFinite(candidate.column)) {
    throw new Error('invalid cursor projection')
  }
  const row = Math.floor(candidate.row)
  const column = Math.floor(candidate.column)
  if (row < 0 || row >= rows.length || column < 0 || column > width) {
    throw new Error('cursor projection is outside the surface')
  }
  return Object.freeze({ row, column })
}

function requireProjection(value: unknown, bounds: LayoutBounds): ProjectedPlacement {
  const candidate = record(value)
  if (candidate === undefined || !Array.isArray(candidate.rows)) {
    throw new Error('invalid surface projection')
  }
  const rows = Object.freeze(candidate.rows
    .slice(0, bounds.height)
    .map(value => requireRow(value, bounds.width)))
  const cursor = requireCursor(candidate.cursor, rows, bounds.width)
  return Object.freeze({
    rows,
    ...(typeof candidate.title === 'string' ? { title: safeFeatureSurfaceText(candidate.title) } : {}),
    ...(typeof candidate.actionHint === 'string' ? { actionHint: safeFeatureSurfaceText(candidate.actionHint) } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  })
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unknown projection failure'
  }
}

function errorProjection(
  placement: LayoutPlacement,
  bounds: LayoutBounds,
  error: unknown,
): ProjectedPlacement {
  return Object.freeze({
    rows: Object.freeze([Object.freeze({
      text: truncateToWidth(
        safeFeatureSurfaceText(`SURFACE ERROR · ${placement.region.id} · ${errorMessage(error)}`),
        bounds.width,
        '',
      ),
      tone: 'danger' as const,
      bold: true,
      dim: false,
      selected: false,
    })]),
  })
}

function project(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  bounded: BoundedPlacement,
): ProjectedPlacement | undefined {
  const surfaceNode = record(bounded.placement.region.node)
  if (surfaceNode === undefined) {
    return errorProjection(
      bounded.placement,
      bounded.bounds,
      new Error('node is not an object'),
    )
  }
  let projectValue: unknown
  try {
    projectValue = surfaceNode.project
  } catch (error: unknown) {
    return errorProjection(bounded.placement, bounded.bounds, error)
  }
  if (projectValue === undefined) return undefined
  if (typeof projectValue !== 'function') {
    return errorProjection(
      bounded.placement,
      bounded.bounds,
      new Error('project is not a function'),
    )
  }
  try {
    const value = Reflect.apply(projectValue, bounded.placement.region.node, [
      projectContext(snapshot, bounded),
    ])
    return requireProjection(value, bounded.bounds)
  } catch (error: unknown) {
    return errorProjection(bounded.placement, bounded.bounds, error)
  }
}

function paddedSegment(text: string, width: number): string {
  const fitted = truncateToWidth(safeFeatureSurfaceText(text), width, '')
  return fitted + ' '.repeat(Math.max(0, width - visibleWidth(fitted)))
}

function writeSegment(
  source: string,
  text: string,
  bounds: LayoutBounds,
  columns: number,
): string {
  const left = sliceByColumn(source, 0, bounds.x, true)
  const rightStart = bounds.x + bounds.width
  const right = sliceByColumn(source, rightStart, columns - rightStart, true)
  return truncateToWidth(left + paddedSegment(text, bounds.width) + right, columns, '', true)
}

function styleFor(row: FeatureSurfaceRow, focused: boolean, workspace: boolean): UiFrameLineStyle {
  return Object.freeze({
    tone: row.selected && !focused ? 'primary' : FEATURE_TONES[row.tone],
    ...((row.selected ? focused : row.bold) ? { bold: true as const } : {}),
    ...(row.dim ? { dim: true as const } : {}),
    ...(workspace ? { backgroundRole: 'panelBackground' as const, fill: true as const } : {}),
    ...(row.tone === 'added' ? { backgroundRole: 'diffAddBackground' as const } : {}),
    ...(row.tone === 'removed' ? { backgroundRole: 'diffDeleteBackground' as const } : {}),
    ...(row.selected ? {
      backgroundRole: focused ? 'selectionBackground' as const : 'inactiveSelectionBackground' as const,
      fill: true as const,
    } : {}),
  })
}

function styleScore(candidate: LineStyleCandidate): number {
  return (candidate.overlay ? 1_000 : 0)
    + (candidate.focused ? 100 : 0)
    + (candidate.style.backgroundRole === 'selectionBackground' ? 20 : 0)
    + (candidate.semantic ? 10 : 0)
}

function preferStyle(
  current: LineStyleCandidate | undefined,
  candidate: LineStyleCandidate,
): LineStyleCandidate {
  if (current === undefined) return candidate
  const difference = styleScore(candidate) - styleScore(current)
  return difference >= 0
    ? candidate
    : current
}

function cursorScore(candidate: CursorCandidate): number {
  return (candidate.overlay ? 1_000 : 0) + (candidate.focused ? 100 : 0)
}

function preferCursor(
  current: CursorCandidate | undefined,
  candidate: CursorCandidate,
): CursorCandidate {
  if (current === undefined) return candidate
  const difference = cursorScore(candidate) - cursorScore(current)
  return difference >= 0
    ? candidate
    : current
}

function containsCursor(bounds: LayoutBounds, cursor: UiCursor): boolean {
  return cursor.row >= bounds.y
    && cursor.row < bounds.y + bounds.height
    && cursor.column >= bounds.x
    && cursor.column < bounds.x + bounds.width
}

/**
 * Compose renderer-neutral Feature projections into the retained terminal frame.
 * Nodes stay polymorphic and every final line remains plain control-free text.
 */
export function renderFeatureSurfaceFrame(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  viewport: TerminalViewport,
  title = 'DSH-TUI',
): UiFrame {
  const normalizedViewport = boundedViewport(viewport)
  const route = snapshot.host.navigation.route
  const workspace = route.kind !== 'chat'
  const panelStyle: UiFrameLineStyle = Object.freeze({ tone: 'primary', backgroundRole: 'panelBackground', fill: true })
  const lines = Array.from(
    { length: normalizedViewport.rows },
    () => ' '.repeat(normalizedViewport.columns),
  )
  const styles: (LineStyleCandidate | undefined)[] = Array.from(
    { length: normalizedViewport.rows },
    () => undefined,
  )
  let cursor: CursorCandidate | undefined
  const styleSpans: UiFrameStyleSpan[][] = Array.from({ length: normalizedViewport.rows }, () => [])

  let writeWorkspaceChrome: ((row: number, text: string, tone: DshTuiSemanticRole) => void) | undefined
  if (workspace) {
    for (let row = 0; row < normalizedViewport.rows; row += 1) {
      styles[row] = { style: panelStyle, focused: false, overlay: false, semantic: false }
      styleSpans[row]!.push({ column: 0, width: normalizedViewport.columns, style: panelStyle })
    }
    const writeChrome = (row: number, text: string, tone: DshTuiSemanticRole) => {
      lines[row] = paddedSegment(text, normalizedViewport.columns)
      const style = Object.freeze({ ...panelStyle, tone, bold: true })
      styles[row] = { style, focused: true, overlay: false, semantic: true }
      styleSpans[row]!.push({ column: 0, width: normalizedViewport.columns, style })
    }
    writeWorkspaceChrome = writeChrome
    if (normalizedViewport.rows >= 3) {
      writeChrome(0, ' ' + route.featureId.toUpperCase(), 'accent')
    }
    if (normalizedViewport.rows >= 2) {
      const search = snapshot.host.commands.some(command => command.featureId === route.featureId && command.id === 'edit.insert')
      writeChrome(normalizedViewport.rows - 1,
        ` Esc back · ↑↓ move · Tab details`
        + (search ? ' · / search' : ''), 'muted')
    }
  }

  snapshot.layout.placements.forEach((placement, order) => {
    const bounds = intersection(placement.bounds, normalizedViewport)
    if (bounds === undefined) return
    const featureId = featureIdFor(snapshot, placement)
    const bounded: BoundedPlacement = Object.freeze({
      placement,
      bounds,
      featureId,
      focused: isFocused(snapshot, placement, featureId, order),
      order,
    })
    const projection = project(snapshot, bounded)
    if (projection === undefined) return
    if (bounded.focused && projection.title !== undefined && normalizedViewport.rows >= 3) {
      writeWorkspaceChrome?.(0, ' ' + projection.title.toUpperCase(), 'accent')
    }
    if (bounded.focused && projection.actionHint !== undefined && normalizedViewport.rows >= 2) {
      writeWorkspaceChrome?.(normalizedViewport.rows - 1, ' Esc back · ' + projection.actionHint, 'muted')
    }

    if (cursor !== undefined && containsCursor(bounds, cursor.cursor)) cursor = undefined
    projection.rows.forEach((row, localRow) => {
      const frameRow = bounds.y + localRow
      lines[frameRow] = writeSegment(
        lines[frameRow]!,
        row.text,
        bounds,
        normalizedViewport.columns,
      )
      styles[frameRow] = preferStyle(styles[frameRow], {
        style: styleFor(row, bounded.focused, workspace),
        focused: bounded.focused,
        overlay: placement.area === 'overlay',
        semantic: row.tone !== 'default' || row.bold || row.dim || row.selected,
      })
      styleSpans[frameRow]!.push(Object.freeze({
        column: bounds.x, width: bounds.width, style: styleFor(row, bounded.focused, workspace),
      }))
    })

    if (projection.cursor !== undefined) {
      cursor = preferCursor(cursor, {
        cursor: Object.freeze({
          row: bounds.y + projection.cursor.row,
          column: Math.min(
            normalizedViewport.columns - 1,
            bounds.x + projection.cursor.column,
          ),
        }),
        focused: bounded.focused,
        overlay: placement.area === 'overlay',
      })
    }
  })

  const lineStyles = styles.map(candidate => candidate?.style)
  const hasStyles = lineStyles.some(style => style !== undefined)
  return Object.freeze({
    title: safeFeatureSurfaceText(title),
    viewport: normalizedViewport,
    lines: Object.freeze(lines),
    ...(hasStyles ? { lineStyles: Object.freeze(lineStyles) } : {}),
    ...(hasStyles ? { styleSpans: Object.freeze(styleSpans.map(spans => Object.freeze(spans))) } : {}),
    ...(cursor === undefined ? {} : { cursor: cursor.cursor }),
  })
}
