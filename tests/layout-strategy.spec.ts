import { describe, expect, it } from 'vitest'
import {
  resolveLayout,
  type LayoutBounds,
  type LayoutRegion,
} from '../src/layout/strategy.ts'

function regions(onNodeRead: () => void = () => {}): readonly LayoutRegion<() => void>[] {
  return [
    { id: 'chat.timeline', role: 'timeline', node: onNodeRead },
    { id: 'workspace.navigator', role: 'navigator', node: onNodeRead },
    {
      id: 'feature.content',
      role: 'content',
      node: onNodeRead,
      constraints: { minColumns: 40, preferredColumns: 80, priority: 10 },
    },
    { id: 'feature.inspector', role: 'inspector', node: onNodeRead },
    { id: 'shell.composer', role: 'composer', node: onNodeRead },
    { id: 'shell.status', role: 'status', node: onNodeRead },
    { id: 'shell.overlay', role: 'overlay', node: onNodeRead },
  ]
}

function visibleIds(plan: ReturnType<typeof resolveLayout>): readonly string[] {
  return plan.placements.map(placement => placement.region.id)
}

function boundsFor(
  plan: ReturnType<typeof resolveLayout>,
  regionId: string,
): LayoutBounds {
  const placement = plan.placements.find(item => item.region.id === regionId)
  if (placement === undefined) throw new Error(`Missing placement: ${regionId}`)
  return placement.bounds
}

function expectContained(plan: ReturnType<typeof resolveLayout>): void {
  for (const placement of plan.placements) {
    const { x, y, width, height } = placement.bounds
    expect(Number.isInteger(x)).toBe(true)
    expect(Number.isInteger(y)).toBe(true)
    expect(Number.isInteger(width)).toBe(true)
    expect(Number.isInteger(height)).toBe(true)
    expect(x).toBeGreaterThanOrEqual(0)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(width).toBeGreaterThanOrEqual(1)
    expect(height).toBeGreaterThanOrEqual(1)
    expect(x + width).toBeLessThanOrEqual(plan.viewport.columns)
    expect(y + height).toBeLessThanOrEqual(plan.viewport.rows)
    expect(placement.columns).toBe(width)
  }
}

describe('layout strategy', () => {
  it('honors single-page preference without overriding narrow-screen safety', () => {
    const route = { kind: 'workspace', featureId: 'sessions', pane: 'content' } as const
    const single = resolveLayout({ columns: 160, rows: 30 }, route, regions(), 'single')
    expect(single.breakpoint).toBe('wide')
    expect(single.mode).toBe('single')
    expect(visibleIds(single)).not.toContain('workspace.navigator')
    expect(resolveLayout({ columns: 80, rows: 30 }, route, regions(), 'split').mode).toBe('full-screen')
    expect(resolveLayout({ columns: 160, rows: 30 }, route, regions(), 'split').mode).toBe('split')
  })
  it('uses a full-screen secondary surface below 100 columns', () => {
    const plan = resolveLayout(
      { columns: 99, rows: 30 },
      { kind: 'diff', featureId: 'diff', pane: 'content' },
      regions(),
    )
    expect(plan.breakpoint).toBe('narrow')
    expect(plan.mode).toBe('full-screen')
    expect(visibleIds(plan)).toEqual(['feature.content', 'shell.overlay'])
    expect(plan.hiddenRegionIds).toEqual([
      'chat.timeline',
      'workspace.navigator',
      'feature.inspector',
      'shell.composer',
      'shell.status',
    ])
    expect(boundsFor(plan, 'feature.content')).toEqual({
      x: 0,
      y: 1,
      width: 99,
      height: 28,
    })
    expect(boundsFor(plan, 'shell.overlay')).toEqual({
      x: 0,
      y: 0,
      width: 99,
      height: 30,
    })
    expectContained(plan)
  })

  it('uses two Workspace regions from 100 through 139 columns and keeps Diff focused', () => {
    const diff = resolveLayout(
      { columns: 100, rows: 30 },
      { kind: 'diff', featureId: 'diff', pane: 'inspector' },
      regions(),
    )
    expect(diff.breakpoint).toBe('standard')
    expect(diff.mode).toBe('single')
    expect(visibleIds(diff)).toEqual([
      'feature.inspector',
      'shell.composer',
      'shell.status',
      'shell.overlay',
    ])
    expect(boundsFor(diff, 'feature.inspector')).toEqual({
      x: 0,
      y: 1,
      width: 100,
      height: 26,
    })
    expect(boundsFor(diff, 'shell.composer')).toEqual({
      x: 0,
      y: 27,
      width: 100,
      height: 1,
    })
    expect(boundsFor(diff, 'shell.status')).toEqual({
      x: 0,
      y: 28,
      width: 100,
      height: 1,
    })
    expect(boundsFor(diff, 'shell.overlay')).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 30,
    })
    expectContained(diff)

    const workspace = resolveLayout(
      { columns: 139, rows: 40 },
      { kind: 'workspace', featureId: 'sessions', pane: 'navigator' },
      regions(),
    )
    expect(workspace.breakpoint).toBe('standard')
    expect(visibleIds(workspace)).toEqual([
      'workspace.navigator',
      'feature.content',
      'shell.composer',
      'shell.status',
      'shell.overlay',
    ])
  })

  it('allows split Diff and Workspace layouts at 140 columns', () => {
    const diff = resolveLayout(
      { columns: 140, rows: 40 },
      { kind: 'diff', featureId: 'diff', pane: 'content' },
      regions(),
    )
    expect(diff.breakpoint).toBe('wide')
    expect(diff.mode).toBe('split')
    expect(visibleIds(diff)).toEqual([
      'feature.content',
      'feature.inspector',
      'shell.composer',
      'shell.status',
      'shell.overlay',
    ])

    const workspace = resolveLayout(
      { columns: 180, rows: 50 },
      { kind: 'workspace', featureId: 'sessions', pane: 'content' },
      regions(),
    )
    expect(workspace.mode).toBe('split')
    expect(visibleIds(workspace)).toEqual([
      'workspace.navigator',
      'feature.content',
      'feature.inspector',
      'shell.composer',
      'shell.status',
      'shell.overlay',
    ])
    expect(workspace.placements.every(placement => placement.columns >= 1)).toBe(true)
    expect(boundsFor(diff, 'feature.content')).toEqual({
      x: 0,
      y: 1,
      width: 80,
      height: 36,
    })
    expect(boundsFor(diff, 'feature.inspector')).toEqual({
      x: 81,
      y: 1,
      width: 59,
      height: 36,
    })
    expect(boundsFor(workspace, 'workspace.navigator')).toEqual({
      x: 0,
      y: 1,
      width: 59,
      height: 46,
    })
    expect(boundsFor(workspace, 'feature.content')).toEqual({
      x: 60,
      y: 1,
      width: 80,
      height: 46,
    })
    expect(boundsFor(workspace, 'feature.inspector')).toEqual({
      x: 141,
      y: 1,
      width: 39,
      height: 46,
    })
    expectContained(diff)
    expectContained(workspace)
  })

  it('keeps Chat dense and hides non-essential status on narrow terminals', () => {
    const narrow = resolveLayout(
      { columns: 80, rows: 24 },
      { kind: 'chat' },
      regions(),
    )
    expect(narrow.mode).toBe('single')
    expect(visibleIds(narrow)).toEqual([
      'chat.timeline',
      'shell.composer',
      'shell.overlay',
    ])

    const wide = resolveLayout(
      { columns: 160, rows: 42 },
      { kind: 'chat' },
      regions(),
    )
    expect(wide.mode).toBe('single')
    expect(visibleIds(wide)).toEqual([
      'chat.timeline',
      'shell.composer',
      'shell.status',
      'shell.overlay',
    ])
  })

  it('falls back to available single-page content and honors region priority', () => {
    const candidates: readonly LayoutRegion<string>[] = [
      { id: 'nav-low', role: 'navigator', node: 'low', constraints: { priority: 1 } },
      { id: 'nav-high', role: 'navigator', node: 'high', constraints: { priority: 5 } },
      { id: 'content', role: 'content', node: 'content' },
    ]
    const navigator = resolveLayout(
      { columns: 120, rows: 30 },
      { kind: 'workspace', featureId: 'sessions', pane: 'navigator' },
      candidates,
    )
    expect(visibleIds(navigator)).toEqual(['nav-high', 'nav-low', 'content'])
    expect(boundsFor(navigator, 'nav-high')).toEqual(boundsFor(navigator, 'nav-low'))

    const fallback = resolveLayout(
      { columns: 120, rows: 30 },
      { kind: 'diff', featureId: 'diff', pane: 'inspector' },
      candidates,
    )
    expect(visibleIds(fallback)).toEqual(['content'])

    const workspaceFallback = resolveLayout(
      { columns: 120, rows: 30 },
      { kind: 'workspace', featureId: 'sessions', pane: 'inspector' },
      candidates,
    )
    expect(visibleIds(workspaceFallback)).toEqual(['nav-high', 'nav-low', 'content'])

    const emptyFallback = resolveLayout(
      { columns: 120, rows: 30 },
      { kind: 'workspace', featureId: 'sessions', pane: 'inspector' },
      [],
    )
    expect(visibleIds(emptyFallback)).toEqual([])

    const defaultPriorities = resolveLayout(
      { columns: 120, rows: 30 },
      { kind: 'workspace', featureId: 'sessions', pane: 'navigator' },
      [
        { id: 'implicit-zero', role: 'navigator', node: 'implicit' },
        {
          id: 'explicit-constraints-zero',
          role: 'navigator',
          node: 'explicit',
          constraints: { minColumns: 1 },
        },
      ],
    )
    expect(visibleIds(defaultPriorities)).toEqual([
      'implicit-zero',
      'explicit-constraints-zero',
    ])
  })

  it('honors priorities when minimum widths cannot all fit', () => {
    const plan = resolveLayout(
      { columns: 140, rows: 20 },
      { kind: 'workspace', featureId: 'sessions', pane: 'content' },
      [
        {
          id: 'navigator',
          role: 'navigator',
          node: 'navigator',
          constraints: { minColumns: 70, preferredColumns: 90, priority: 1 },
        },
        {
          id: 'content',
          role: 'content',
          node: 'content',
          constraints: { minColumns: 100, preferredColumns: 110, priority: 10 },
        },
        {
          id: 'inspector',
          role: 'inspector',
          node: 'inspector',
          constraints: { minColumns: 50, preferredColumns: 60, priority: 5 },
        },
      ],
    )

    expect(boundsFor(plan, 'navigator').width).toBe(1)
    expect(boundsFor(plan, 'content').width).toBe(100)
    expect(boundsFor(plan, 'inspector').width).toBe(37)
    expect(plan.placements.reduce((sum, item) => sum + item.bounds.width, 0)).toBe(138)
    expectContained(plan)

    const surplus = resolveLayout(
      { columns: 140, rows: 20 },
      { kind: 'workspace', featureId: 'sessions', pane: 'content' },
      [
        {
          id: 'surplus.navigator',
          role: 'navigator',
          node: 'navigator',
          constraints: { minColumns: 10, preferredColumns: 20, priority: 1 },
        },
        {
          id: 'surplus.content',
          role: 'content',
          node: 'content',
          constraints: { minColumns: 20, preferredColumns: 40, priority: 10 },
        },
        {
          id: 'surplus.inspector',
          role: 'inspector',
          node: 'inspector',
          constraints: { minColumns: 10, preferredColumns: 20, priority: 5 },
        },
      ],
    )
    expect(boundsFor(surplus, 'surplus.navigator').width).toBe(20)
    expect(boundsFor(surplus, 'surplus.content').width).toBe(98)
    expect(boundsFor(surplus, 'surplus.inspector').width).toBe(20)
    expectContained(surplus)
  })

  it('suppresses lower-priority chrome when terminal height cannot contain it', () => {
    const oneRow = resolveLayout(
      { columns: 120, rows: 1 },
      { kind: 'chat' },
      regions(),
    )
    expect(visibleIds(oneRow)).toEqual(['chat.timeline', 'shell.overlay'])
    expect(oneRow.hiddenRegionIds).toContain('shell.composer')
    expect(oneRow.hiddenRegionIds).toContain('shell.status')
    expectContained(oneRow)

    const twoRows = resolveLayout(
      { columns: 120, rows: 2 },
      { kind: 'chat' },
      regions(),
    )
    expect(visibleIds(twoRows)).toEqual([
      'chat.timeline',
      'shell.composer',
      'shell.overlay',
    ])
    expect(boundsFor(twoRows, 'chat.timeline').height).toBe(1)
    expect(boundsFor(twoRows, 'shell.composer').y).toBe(1)
    expectContained(twoRows)

    const chromeOnly = resolveLayout(
      { columns: 120, rows: 2 },
      { kind: 'chat' },
      [
        { id: 'chrome.composer', role: 'composer', node: 'composer' },
        { id: 'chrome.status', role: 'status', node: 'status' },
      ],
    )
    expect(boundsFor(chromeOnly, 'chrome.composer').y).toBe(0)
    expect(boundsFor(chromeOnly, 'chrome.status').y).toBe(1)
    expectContained(chromeOnly)
  })

  it('normalizes invalid viewports, rejects duplicate region ids, and never calls nodes', () => {
    let reads = 0
    const plan = resolveLayout(
      { columns: Number.NaN, rows: Number.NEGATIVE_INFINITY },
      { kind: 'chat' },
      regions(() => { reads += 1 }),
    )
    expect(plan.viewport).toEqual({ columns: 1, rows: 1 })
    expect(reads).toBe(0)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.viewport)).toBe(true)
    expect(Object.isFrozen(plan.placements)).toBe(true)
    expect(plan.placements.every(placement => Object.isFrozen(placement.bounds))).toBe(true)
    expect(Object.isFrozen(plan.hiddenRegionIds)).toBe(true)

    expect(() => resolveLayout(
      { columns: 120, rows: 30 },
      { kind: 'chat' },
      [
        { id: 'duplicate', role: 'timeline', node: 'first' },
        { id: 'duplicate', role: 'composer', node: 'second' },
      ],
    )).toThrow('Duplicate layout region id: duplicate')

    const finiteMinimum = resolveLayout(
      { columns: -10, rows: 0 },
      { kind: 'chat' },
      [{
        id: 'timeline',
        role: 'timeline',
        node: 'timeline',
        constraints: { minColumns: -5 },
      }],
    )
    expect(finiteMinimum.viewport).toEqual({ columns: 1, rows: 1 })

    let nodeReads = 0
    const opaqueNode = {
      id: 'opaque',
      role: 'timeline' as const,
      get node() {
        nodeReads += 1
        return 'must-not-read'
      },
      constraints: {
        minColumns: Number.NaN,
        preferredColumns: Number.POSITIVE_INFINITY,
        priority: Number.NaN,
      },
    }
    const opaque = resolveLayout(
      { columns: 120, rows: 10 },
      { kind: 'chat' },
      [opaqueNode],
    )
    expect(nodeReads).toBe(0)
    expectContained(opaque)
  })
})
