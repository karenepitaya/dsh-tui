import { describe, expect, it } from 'vitest'
import { secondarySurfaceGeometry } from '../src/ui/secondary-surface.ts'

describe('secondary surface geometry', () => {
  it('caps each surface kind without deriving geometry from its content', () => {
    expect(secondarySurfaceGeometry({ columns: 200, rows: 60 }, 'palette')).toEqual({
      viewport: { columns: 88, rows: 13 },
      overlay: {
        kind: 'palette',
        anchor: 'bottom-center',
        width: 88,
        maxHeight: 13,
        margin: { top: 1, right: 2, bottom: 2, left: 2 },
      },
    })
    expect(secondarySurfaceGeometry({ columns: 200, rows: 60 }, 'compact')).toEqual({
      viewport: { columns: 78, rows: 20 },
      overlay: {
        kind: 'compact',
        anchor: 'center',
        width: 78,
        maxHeight: 20,
        margin: 2,
      },
    })
    expect(secondarySurfaceGeometry({ columns: 200, rows: 60 }, 'directory')).toEqual({
      viewport: { columns: 118, rows: 32 },
      overlay: {
        kind: 'directory',
        anchor: 'center',
        width: 118,
        maxHeight: 32,
        margin: 2,
      },
    })
  })

  it('uses stable medium and small-terminal margins', () => {
    expect(secondarySurfaceGeometry({ columns: 50, rows: 12 }, 'palette')).toEqual({
      viewport: { columns: 48, rows: 12 },
      overlay: {
        kind: 'palette',
        anchor: 'bottom-center',
        width: 48,
        maxHeight: 12,
        margin: { top: 0, right: 1, bottom: 0, left: 1 },
      },
    })
    expect(secondarySurfaceGeometry({ columns: 30, rows: 8 }, 'compact')).toEqual({
      viewport: { columns: 30, rows: 8 },
      overlay: {
        kind: 'compact',
        anchor: 'center',
        width: 30,
        maxHeight: 8,
        margin: 0,
      },
    })
    expect(secondarySurfaceGeometry({ columns: 80, rows: 14 }, 'palette').overlay.margin)
      .toEqual({ top: 0, right: 2, bottom: 1, left: 2 })
  })

  it('normalizes invalid dimensions and freezes the contract', () => {
    const geometry = secondarySurfaceGeometry(
      { columns: Number.NaN, rows: Number.POSITIVE_INFINITY },
      'directory',
    )
    expect(geometry).toEqual({
      viewport: { columns: 1, rows: 1 },
      overlay: {
        kind: 'directory',
        anchor: 'center',
        width: 1,
        maxHeight: 1,
        margin: 0,
      },
    })
    expect(Object.isFrozen(geometry)).toBe(true)
    expect(Object.isFrozen(geometry.viewport)).toBe(true)
    expect(Object.isFrozen(geometry.overlay)).toBe(true)
  })
})
