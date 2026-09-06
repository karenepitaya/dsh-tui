import { sliceByColumn, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { UiFrameLineStyle, UiFrameStyleSpan } from '../ui/frame-style.ts'
import type { DshTuiTheme } from '../ui/theme.ts'

function paint(text: string, style: UiFrameLineStyle | undefined, theme: DshTuiTheme): string {
  if (style === undefined) return text
  let value = theme.paint(style.tone, text)
  if (style.backgroundRole !== undefined) value = theme.paintBackground(style.backgroundRole, value)
  else if (style.background !== undefined) value = theme.background(style.background, value)
  if (style.bold === true) value = theme.bold(value)
  if (style.inverse === true) value = theme.inverse(value)
  return style.dim === true ? theme.dim(value) : value
}

/** Paint bounded regions independently, so selection cannot bleed into an adjacent pane. */
export function paintFrameLine(
  source: string,
  width: number,
  theme: DshTuiTheme,
  base?: UiFrameLineStyle,
  spans: readonly UiFrameStyleSpan[] = [],
  dimAll = false,
): string {
  const plain = truncateToWidth(source, width, '')
  const padded = base?.fill === true || spans.length > 0
    ? plain + ' '.repeat(Math.max(0, width - visibleWidth(plain)))
    : plain
  if (spans.length === 0) {
    const value = paint(padded, base, theme)
    return dimAll && base?.dim !== true ? theme.dim(value) : value
  }
  const bounded = spans.map(span => ({
    start: Math.max(0, Math.min(width, Math.floor(span.column))),
    end: Math.max(0, Math.min(width, Math.floor(span.column + span.width))),
    style: span.style,
  })).filter(span => span.end > span.start)
  const boundaries = [...new Set([0, width, ...bounded.flatMap(span => [span.start, span.end])])]
    .sort((left, right) => left - right)
  const segments = boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]!
    const style = bounded.findLast(span => start >= span.start && end <= span.end)?.style ?? base
    return paint(sliceByColumn(padded, start, end - start, true), style, theme)
  }).join('')
  return dimAll ? theme.dim(segments) : segments
}
