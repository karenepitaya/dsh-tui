export type SecondarySurfaceKind =
  | 'palette'
  | 'compact'
  | 'picker'
  | 'catalog'
  | 'directory'
  | 'library'
  | 'attempts'
  | 'routes'

export interface SecondaryOverlayLayout {
  readonly kind: SecondarySurfaceKind
  readonly anchor: 'center' | 'bottom-center'
  readonly width: number
  readonly maxHeight: number
  readonly margin: number | {
    readonly top?: number
    readonly right?: number
    readonly bottom?: number
    readonly left?: number
  }
}

export interface SecondarySurfaceGeometry {
  readonly viewport: {
    readonly columns: number
    readonly rows: number
  }
  readonly overlay: SecondaryOverlayLayout
}

interface SecondarySurfaceSpec {
  readonly maxColumns: number
  readonly maxRows: number
  readonly anchor: SecondaryOverlayLayout['anchor']
}

const SURFACE_SPECS: Readonly<Record<SecondarySurfaceKind, SecondarySurfaceSpec>> = {
  palette: { maxColumns: 88, maxRows: 10, anchor: 'bottom-center' },
  compact: { maxColumns: 78, maxRows: 20, anchor: 'center' },
  picker: { maxColumns: 92, maxRows: 22, anchor: 'center' },
  catalog: { maxColumns: 112, maxRows: 28, anchor: 'center' },
  directory: { maxColumns: 118, maxRows: 32, anchor: 'center' },
  library: { maxColumns: 122, maxRows: 32, anchor: 'center' },
  attempts: { maxColumns: 110, maxRows: 28, anchor: 'center' },
  routes: { maxColumns: 114, maxRows: 28, anchor: 'center' },
}

function surfaceDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

/**
 * Allocate a fixed secondary surface inside the terminal. Its dimensions depend
 * only on the terminal and surface kind, never on changing list content.
 */
export function secondarySurfaceGeometry(
  terminal: Readonly<{ columns: number; rows: number }>,
  kind: SecondarySurfaceKind,
): SecondarySurfaceGeometry {
  const columns = surfaceDimension(terminal.columns)
  const rows = surfaceDimension(terminal.rows)
  const spec = SURFACE_SPECS[kind]
  const horizontalMargin = columns >= 64 ? 4 : columns >= 32 ? 2 : 0
  const verticalMargin = rows >= 18 ? 4 : rows >= 14 ? 2 : 0
  const width = Math.min(spec.maxColumns, Math.max(1, columns - horizontalMargin))
  const height = Math.min(spec.maxRows, Math.max(1, rows - verticalMargin))
  const margin = kind === 'palette'
    ? {
        top: verticalMargin >= 4 ? 1 : 0,
        right: Math.floor(horizontalMargin / 2),
        bottom: verticalMargin >= 4 ? 2 : verticalMargin >= 2 ? 1 : 0,
        left: Math.floor(horizontalMargin / 2),
      }
    : Math.floor(Math.min(horizontalMargin, verticalMargin) / 2)
  return Object.freeze({
    viewport: Object.freeze({ columns: width, rows: height }),
    overlay: Object.freeze({
      kind,
      anchor: spec.anchor,
      width,
      maxHeight: height,
      margin,
    }),
  })
}
