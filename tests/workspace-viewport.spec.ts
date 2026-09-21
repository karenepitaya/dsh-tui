import { describe, expect, it, vi } from 'vitest'
import { resolveLayout, type LayoutRegion } from '../src/layout/strategy.ts'
import {
  createFeatureDetailSurface,
  featureDetailViewport,
  featureListViewport,
  featureSurfaceTextWidth,
  type FeatureSurfaceProjectContext,
} from '../src/presentation/feature-surface.ts'
import {
  createCapabilitiesFeatureModel,
  createCapabilitiesNavigatorNode,
} from '../src/features/capabilities/index.ts'
import { createSessionsFeatureModel, createSessionsNavigatorNode } from '../src/features/sessions/index.ts'

const context = (width: number, height: number): FeatureSurfaceProjectContext => ({
  bounds: { x: 0, y: 0, width, height }, focus: true, mode: 'normal', resources: [],
})

describe('Workspace viewport contract', () => {
  it('forwards detail state invalidations and releases listeners for each catalog type', () => {
    const capabilities = (tab: 'skills' | 'tools' | 'mcp') => {
      const model = createCapabilitiesFeatureModel()
      model.dispatch({ type: 'tab.set', tab })
      return model
    }
    const tools = capabilities('tools')
    const mcp = capabilities('mcp')
    const skills = capabilities('skills')
    const sessions = createSessionsFeatureModel()
    const request = { scopeEpoch: 1, requestId: 1 }
    const fixtures = [
      { node: createCapabilitiesNavigatorNode(tools), notify: () => tools.dispatch({ type: 'tools', event: { type: 'load.started', request } }), dispose: () => tools.dispose() },
      { node: createCapabilitiesNavigatorNode(mcp), notify: () => mcp.dispatch({ type: 'mcp', event: { type: 'load.started', request } }), dispose: () => mcp.dispose() },
      { node: createCapabilitiesNavigatorNode(skills), notify: () => skills.dispatch({ type: 'skills', event: { type: 'load.started', request } }), dispose: () => skills.dispose() },
      { node: createSessionsNavigatorNode(sessions), notify: () => sessions.dispatch({ type: 'catalog.load-started', request }), dispose: () => sessions.dispose() },
    ]
    for (const fixture of fixtures) {
      expect(fixture.node.hasContent?.() ?? false).toBe(false)
      const changed = vi.fn()
      const stop = fixture.node.onChanged(changed)
      fixture.notify()
      expect(changed).toHaveBeenCalledOnce()
      stop()
      fixture.notify()
      expect(changed).toHaveBeenCalledOnce()
      fixture.dispose()
    }
  })
  it.each([0, 1, 20, 200])('keeps selection visible for %i items without mutating input', (count) => {
    const rows = Object.freeze(Array.from({ length: count }, (_, index) => index))
    for (const selected of [0, Math.floor(count / 2), count - 1]) {
      const visible = featureListViewport(rows, selected, 6)
      expect(visible.length).toBe(Math.min(count, 6))
      if (count > 0) expect(visible).toContain(Math.max(0, selected))
      expect(Object.isFrozen(visible)).toBe(true)
    }
    expect(featureListViewport(rows, 0, 0)).toEqual([])
    expect(featureListViewport(rows, Number.NaN, Number.NaN)).toEqual([])
  })

  it('wraps safe CJK, emoji, multiline detail and clamps its independent viewport', () => {
    const rows = [{ text: '标题\n你好🙂 abcdefghijkl\n\u001b[31m末尾\u001b[0m', tone: 'default' as const }]
    const first = featureDetailViewport(rows, 8, 2, 0)
    expect(first.totalRows).toBeGreaterThan(2)
    expect(first.rows[0]?.text).toBe('标题')
    const last = featureDetailViewport(rows, 8, 2, 999)
    expect(last.offset).toBe(last.totalRows - 2)
    expect(last.rows.at(-1)?.text).toBe('末尾')
    for (const row of [...first.rows, ...last.rows]) {
      expect(featureSurfaceTextWidth(row.text)).toBeLessThanOrEqual(8)
      expect(row.text).not.toContain('…')
      expect(row.text).not.toContain('\u001b')
    }
    expect(featureDetailViewport(rows, 0, 0, -10).rows).toEqual([])
    expect(featureDetailViewport([{ text: '中🙂' }], 1, 4, 0).rows.map(row => row.text)).toEqual(['�', '�'])
  })

  it('keeps detail scrolling local, resets only when selection changes, and never loads on resize', () => {
    let key = 'first'
    const sourceChanged = new Set<() => void>()
    const read = vi.fn(() => Array.from({ length: 30 }, (_, index) => ({ text: `detail ${index}` })))
    const surface = createFeatureDetailSurface({
      rows: read, key: () => key, hasContent: () => true,
      onChanged: listener => { sourceChanged.add(listener); return () => { sourceChanged.delete(listener) } },
    })
    const changed = vi.fn()
    const stop = surface.onChanged(changed)
    expect(surface.hasContent()).toBe(true)
    surface.project(context(30, 5))
    expect(surface.scroll(8)).toBe(true)
    expect(changed).toHaveBeenCalledOnce()
    expect(surface.project(context(30, 5)).rows[0]?.text).toBe('detail 8')
    for (let index = 0; index < 100; index += 1) surface.project(context(30 + index % 10, 5))
    expect(surface.project(context(30, 5)).rows[0]?.text).toBe('detail 8')
    for (const listener of sourceChanged) listener()
    expect(changed).toHaveBeenCalledTimes(2)
    key = 'second'
    expect(surface.project(context(30, 5)).rows[0]?.text).toBe('detail 0')
    expect(surface.scroll(-100)).toBe(false)
    expect(surface.scroll(Number.NaN)).toBe(false)
    stop()
    expect(sourceChanged.size).toBe(0)
  })

  it('shows one, two, then at most three useful regions with gutters and opaque nodes', () => {
    const node = new Proxy({}, { get: () => { throw new Error('layout must not inspect nodes') } })
    const regions: readonly LayoutRegion[] = [
      { id: 'nav', role: 'navigator', node },
      { id: 'body', role: 'content', node },
      { id: 'detail', role: 'inspector', node, hasContent: false },
    ]
    const route = { kind: 'workspace', featureId: 'test', pane: 'content' } as const
    const narrow = resolveLayout({ columns: 99, rows: 20 }, route, regions)
    expect(narrow.placements.map(item => item.region.id)).toEqual(['body'])
    for (const width of [100, 139, 140, 180]) {
      const plan = resolveLayout({ columns: width, rows: 20 }, route, regions)
      expect(plan.placements.map(item => item.region.id)).toEqual(['nav', 'body'])
      expect(plan.placements[0]!.bounds.x + plan.placements[0]!.bounds.width)
        .toBeLessThan(plan.placements[1]!.bounds.x)
    }
    const wide = resolveLayout({ columns: 140, rows: 20 }, route, regions.map(region => ({ ...region, hasContent: true })))
    expect(wide.placements).toHaveLength(3)
    expect(resolveLayout({ columns: 180, rows: 20 }, route, regions, 'single').placements).toHaveLength(1)
    const inspector = resolveLayout({ columns: 120, rows: 20 }, { ...route, pane: 'inspector' }, regions)
    expect(inspector.placements.map(item => item.region.id)).toEqual(['nav', 'detail'])
  })
})
