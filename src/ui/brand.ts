export interface CordisBrandViewport {
  readonly columns: number
  readonly rows: number
}

const FULL_CORDIS_WHALE = [
  '                   __',
  '          ________/  \\__',
  '     ____/  o           \\____',
  '  __/      C O R D I S       \\__',
  '<__                              )',
  '   \\____________________________/',
  '        \\__              __/',
  '           \\____________/',
] as const

const CORDIS_WORDMARK = [
  '/----------------------\\',
  '|        CORDIS        |',
  '\\------- DSH-TUI ------/',
] as const

function centered(line: string, columns: number): string {
  const padding = Math.max(0, Math.floor((columns - line.length) / 2))
  return ' '.repeat(padding) + line
}

/**
 * Returns a monochrome, ASCII-only empty-session mark. Small terminals receive
 * no mark so the input surface never competes with decoration.
 */
export function cordisBrandLines(viewport: CordisBrandViewport): readonly string[] {
  if (viewport.columns < 40 || viewport.rows < 8) return []
  const art = viewport.columns >= 64 && viewport.rows >= 14
    ? FULL_CORDIS_WHALE
    : CORDIS_WORDMARK
  return art.map(line => centered(line, viewport.columns))
}
