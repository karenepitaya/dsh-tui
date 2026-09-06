import type { SemanticColorRole } from '../theme/semantic-colors.ts'
import type { DshTuiAnsiColor, DshTuiSemanticRole } from './theme.ts'

/** Styling metadata only; frame text never carries terminal controls. */
export interface UiFrameLineStyle {
  readonly tone: DshTuiSemanticRole
  readonly background?: DshTuiAnsiColor
  readonly backgroundRole?: SemanticColorRole
  readonly bold?: boolean
  readonly dim?: boolean
  readonly inverse?: boolean
  readonly fill?: boolean
}

/** Columns, not UTF-16 offsets. Later spans paint over earlier spans. */
export interface UiFrameStyleSpan {
  readonly column: number
  readonly width: number
  readonly style: UiFrameLineStyle
}
