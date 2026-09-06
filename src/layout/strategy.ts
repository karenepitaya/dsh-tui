import type { NavigationRoute, WorkspacePane } from '../navigation/state.ts'
import type { DshTuiLayoutMode } from '../preferences/contracts.ts'

export type LayoutRole =
  | 'timeline'
  | 'navigator'
  | 'content'
  | 'inspector'
  | 'composer'
  | 'status'
  | 'overlay'

export interface LayoutRegion<TNode = unknown> {
  readonly id: string
  readonly role: LayoutRole
  readonly node: TNode
  /** Detached presentation fact; resolveLayout never reads the node itself. */
  readonly hasContent?: boolean
  readonly constraints?: {
    readonly minColumns?: number
    readonly preferredColumns?: number
    readonly priority?: number
  }
}

export interface LayoutViewport {
  readonly columns: number
  readonly rows: number
}

export type LayoutBreakpoint = 'narrow' | 'standard' | 'wide'
export type LayoutMode = 'full-screen' | 'single' | 'split'

export interface LayoutBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LayoutPlacement<TNode = unknown> {
  readonly region: LayoutRegion<TNode>
  readonly area: LayoutRole
  /** Compatibility alias for bounds.width. */
  readonly columns: number
  readonly bounds: LayoutBounds
}

export interface LayoutPlan<TNode = unknown> {
  readonly viewport: LayoutViewport
  readonly breakpoint: LayoutBreakpoint
  readonly mode: LayoutMode
  readonly placements: readonly LayoutPlacement<TNode>[]
  readonly hiddenRegionIds: readonly string[]
}

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function breakpoint(columns: number): LayoutBreakpoint {
  if (columns < 100) return 'narrow'
  if (columns < 140) return 'standard'
  return 'wide'
}

function priority<TNode>(region: LayoutRegion<TNode>): number {
  const value = region.constraints?.priority
  return value !== undefined && Number.isFinite(value) ? value : 0
}

function regionsForRole<TNode>(
  regions: readonly LayoutRegion<TNode>[],
  role: LayoutRole,
): readonly LayoutRegion<TNode>[] {
  return regions
    .map((region, index) => ({ region, index }))
    .filter(item => item.region.role === role)
    .sort((left, right) => (
      priority(right.region) - priority(left.region)
      || left.index - right.index
    ))
    .map(item => item.region)
}

function primaryRole<TNode>(
  route: Exclude<NavigationRoute, { kind: 'chat' }>,
  regions: readonly LayoutRegion<TNode>[],
): WorkspacePane {
  if (regions.some(region => region.role === route.pane)) return route.pane
  const fallbacks: readonly WorkspacePane[] = route.kind === 'diff'
    ? ['content', 'inspector']
    : ['content', 'navigator', 'inspector']
  return fallbacks.find(role => regions.some(region => region.role === role)) ?? route.pane
}

function visibleRoles<TNode>(
  route: NavigationRoute,
  size: LayoutBreakpoint,
  regions: readonly LayoutRegion<TNode>[],
): readonly LayoutRole[] {
  if (route.kind === 'chat') {
    return size === 'narrow'
      ? ['timeline', 'composer', 'overlay']
      : ['timeline', 'composer', 'status', 'overlay']
  }
  const primary = primaryRole(route, regions)
  if (size === 'narrow') return [primary, 'overlay']
  if (route.kind === 'diff') {
    return size === 'wide'
      ? ['content', 'inspector', 'composer', 'status', 'overlay']
      : [primary, 'composer', 'status', 'overlay']
  }
  const hasNavigator = regions.some(region => region.role === 'navigator')
  const showInspector = primary === 'inspector' || regions.some(region => (
    region.role === 'inspector' && region.hasContent !== false
  ))
  const roles: LayoutRole[] = hasNavigator ? ['navigator', 'content'] : ['content']
  if (showInspector && (size === 'wide' || !hasNavigator)) roles.push('inspector')
  if (primary === 'inspector' && !roles.includes(primary)) roles[roles.length - 1] = primary
  return [...roles, 'composer', 'status', 'overlay']
}

function layoutMode(route: NavigationRoute, size: LayoutBreakpoint): LayoutMode {
  if (route.kind === 'chat') return 'single'
  if (size === 'narrow') return 'full-screen'
  return size === 'wide' || route.kind === 'workspace' ? 'split' : 'single'
}

type MainLayoutRole = Exclude<LayoutRole, 'composer' | 'status' | 'overlay'>

interface MainRoleGeometry {
  readonly role: MainLayoutRole
  readonly x: number
  readonly width: number
}

interface MainRoleDemand {
  readonly role: MainLayoutRole
  readonly order: number
  readonly priority: number
  readonly minimum: number
  readonly preferred: number
}

function isMainRole(role: LayoutRole): role is MainLayoutRole {
  return role !== 'composer' && role !== 'status' && role !== 'overlay'
}

function normalizedColumns(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}

function uniqueMainRoles<TNode>(
  regions: readonly LayoutRegion<TNode>[],
): readonly MainLayoutRole[] {
  const roles: MainLayoutRole[] = []
  for (const region of regions) {
    if (isMainRole(region.role) && !roles.includes(region.role)) {
      roles.push(region.role)
    }
  }
  return roles
}

function allocateMainGeometry<TNode>(
  viewportColumns: number,
  mode: LayoutMode,
  visible: readonly LayoutRegion<TNode>[],
): readonly MainRoleGeometry[] {
  const roles = uniqueMainRoles(visible)
  if (roles.length === 0) return []
  if (mode !== 'split') {
    return roles.map(role => ({ role, x: 0, width: viewportColumns }))
  }

  const gutter = roles.length > 1 ? 1 : 0
  const availableColumns = viewportColumns - gutter * (roles.length - 1)
  const share = Math.max(1, Math.floor(availableColumns / roles.length))
  const demands: readonly MainRoleDemand[] = roles.map((role, order) => {
    const region = regionsForRole(visible, role)[0]!
    const minimum = normalizedColumns(region.constraints?.minColumns, 1)
    const preferred = Math.max(
      minimum,
      normalizedColumns(region.constraints?.preferredColumns, share),
    )
    return { role, order, priority: priority(region), minimum, preferred }
  })
  const ranked = [...demands].sort((left, right) => (
    right.priority - left.priority || left.order - right.order
  ))
  const widths = new Map<MainLayoutRole, number>(
    roles.map(role => [role, 1] as const),
  )
  let remaining = availableColumns - roles.length

  // Every semantic role first gets one renderable column. Higher-priority
  // roles then satisfy minimum and preferred widths before lower priorities;
  // the highest priority role owns any surplus after all preferences fit.
  const fill = (target: 'minimum' | 'preferred') => {
    for (const demand of ranked) {
      if (remaining === 0) return
      const width = widths.get(demand.role)!
      const granted = Math.min(remaining, Math.max(0, demand[target] - width))
      widths.set(demand.role, width + granted)
      remaining -= granted
    }
  }
  fill('minimum')
  fill('preferred')
  if (remaining > 0) {
    const expandable = ranked[0]!
    widths.set(expandable.role, widths.get(expandable.role)! + remaining)
  }

  let x = 0
  return roles.map((role) => {
    const width = widths.get(role)!
    const geometry = { role, x, width }
    x += width + gutter
    return geometry
  })
}

function fitVerticalChrome<TNode>(
  requested: readonly LayoutRegion<TNode>[],
  rows: number,
): readonly LayoutRegion<TNode>[] {
  const hasMain = requested.some(region => isMainRole(region.role))
  let remaining = rows - (hasMain ? 1 : 0)
  const showComposer = requested.some(region => region.role === 'composer')
    && remaining > 0
  if (showComposer) remaining -= 1
  const showStatus = requested.some(region => region.role === 'status')
    && remaining > 0
  return requested.filter((region) => {
    if (region.role === 'composer') return showComposer
    if (region.role === 'status') return showStatus
    return true
  })
}

function placementBounds<TNode>(
  viewport: LayoutViewport,
  workspace: boolean,
  visible: readonly LayoutRegion<TNode>[],
  mainGeometry: readonly MainRoleGeometry[],
  region: LayoutRegion<TNode>,
): LayoutBounds {
  if (region.role === 'overlay') {
    return { x: 0, y: 0, width: viewport.columns, height: viewport.rows }
  }
  const hasMain = mainGeometry.length !== 0
  const headerHeight = workspace && viewport.rows >= 3 ? 1 : 0
  const footerHeight = workspace && viewport.rows >= 2 ? 1 : 0
  const composerHeight = visible.some(item => item.role === 'composer') ? 1 : 0
  const statusHeight = visible.some(item => item.role === 'status') ? 1 : 0
  const mainHeight = hasMain
    ? viewport.rows - composerHeight - statusHeight - headerHeight - footerHeight
    : 0
  if (region.role === 'composer') {
    return { x: 0, y: headerHeight + mainHeight, width: viewport.columns, height: 1 }
  }
  if (region.role === 'status') {
    return {
      x: 0,
      y: headerHeight + mainHeight + composerHeight,
      width: viewport.columns,
      height: 1,
    }
  }
  const geometry = mainGeometry.find(item => item.role === region.role)!
  return {
    x: geometry.x,
    y: headerHeight,
    width: geometry.width,
    height: mainHeight,
  }
}

/**
 * Resolve only geometry and visibility. Region nodes are opaque values: this
 * function must never construct a Feature, start a loader, or invoke a node.
 */
export function resolveLayout<TNode>(
  viewport: LayoutViewport,
  route: NavigationRoute,
  regions: readonly LayoutRegion<TNode>[],
  preference: DshTuiLayoutMode = 'auto',
): LayoutPlan<TNode> {
  const seen = new Set<string>()
  for (const region of regions) {
    if (seen.has(region.id)) throw new Error(`Duplicate layout region id: ${region.id}`)
    seen.add(region.id)
  }

  const normalizedViewport = Object.freeze({
    columns: dimension(viewport.columns),
    rows: dimension(viewport.rows),
  })
  const size = breakpoint(normalizedViewport.columns)
  const single = preference === 'single' && size !== 'narrow' && route.kind !== 'chat'
  const mode = single ? 'single' : layoutMode(route, size)
  const roles: readonly LayoutRole[] = single
    ? [primaryRole(route, regions), 'composer', 'status', 'overlay']
    : visibleRoles(route, size, regions)
  const requested = roles.flatMap(role => regionsForRole(regions, role))
  const workspace = route.kind !== 'chat'
  const chrome = workspace ? Math.min(2, normalizedViewport.rows - 1) : 0
  const visible = fitVerticalChrome(requested, normalizedViewport.rows - chrome)
  const mainGeometry = allocateMainGeometry(
    normalizedViewport.columns,
    mode,
    visible,
  )
  const placements = Object.freeze(visible.map((region) => {
    const bounds = Object.freeze(placementBounds(
      normalizedViewport,
      workspace,
      visible,
      mainGeometry,
      region,
    ))
    return Object.freeze({
      region,
      area: region.role,
      columns: bounds.width,
      bounds,
    })
  }))
  const visibleIds = new Set(visible.map(region => region.id))
  const hiddenRegionIds = Object.freeze(
    regions.filter(region => !visibleIds.has(region.id)).map(region => region.id),
  )
  return Object.freeze({
    viewport: normalizedViewport,
    breakpoint: size,
    mode,
    placements,
    hiddenRegionIds,
  })
}
