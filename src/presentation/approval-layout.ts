/** The renderer and input gate must agree on whether evidence can be inspected. */
export function approvalLayoutBudget(viewport: { readonly columns: number; readonly rows: number }): {
  readonly dockRows: number
  readonly compactOnly: boolean
  readonly canInspect: boolean
} {
  const rows = Math.max(1, Math.floor(viewport.rows))
  const compactOnly = rows < 13
  const dockRows = Math.min(12, compactOnly ? rows : rows - 9)
  return { dockRows, compactOnly, canInspect: viewport.columns >= 40 && dockRows >= 4 }
}
