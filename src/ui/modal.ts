import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { DshTuiAnsiColor, DshTuiSemanticRole } from './theme.ts'

export interface SecondaryModalLineStyle {
  readonly tone: DshTuiSemanticRole
  readonly background: DshTuiAnsiColor
  readonly bold?: boolean
  readonly dim?: boolean
  readonly inverse?: boolean
  readonly fill: true
}

export interface SecondaryModalRow {
  readonly text: string
  readonly style: SecondaryModalLineStyle
}

export interface SecondaryModalStyleOptions {
  readonly bold?: boolean
  readonly dim?: boolean
  readonly selected?: boolean
}

const MODAL_BACKGROUND: DshTuiAnsiColor = 'black'

function safeInline(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/gu, '↵')
    .replace(/\n/gu, '↵')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '�')
}

function fit(text: string, columns: number): string {
  return stripTerminalSequences(truncateToWidth(
    safeInline(text),
    Math.max(1, columns),
    '',
  ))
}

function padded(text: string, columns: number): string {
  const fitted = fit(text, columns)
  return fitted + ' '.repeat(Math.max(0, columns - visibleWidth(fitted)))
}

export function secondaryModalStyle(
  tone: DshTuiSemanticRole,
  options: SecondaryModalStyleOptions = {},
): SecondaryModalLineStyle {
  return {
    tone,
    background: MODAL_BACKGROUND,
    fill: true,
    ...(options.bold === true ? { bold: true } : {}),
    ...(options.dim === true ? { dim: true } : {}),
    ...(options.selected === true ? { inverse: true } : {}),
  }
}

export function secondaryModalRule(
  label: string,
  columns: number,
  edge: 'top' | 'middle' | 'bottom',
  endLabel?: string,
): string {
  if (columns <= 2) return fit(label, columns)
  const left = edge === 'top' ? '╭' : edge === 'bottom' ? '╰' : '├'
  const right = edge === 'top' ? '╮' : edge === 'bottom' ? '╯' : '┤'
  const start = safeInline(label).trim()
  const end = endLabel === undefined ? '' : safeInline(endLabel).trim()
  const prefix = start === '' ? '' : `─ ${start} `
  const suffix = end === '' ? '' : ` ${end} ─`
  const fillWidth = Math.max(0, columns - 2 - visibleWidth(prefix) - visibleWidth(suffix))
  return fit(`${left}${prefix}${'─'.repeat(fillWidth)}${suffix}${right}`, columns)
}

export function secondaryModalContent(content: string, columns: number): string {
  if (columns <= 2) return fit(content, columns)
  return `│${padded(content, columns - 2)}│`
}

/** A borderless solid row for focused pickers. The line style paints the mask. */
export function secondaryModalFill(content: string, columns: number): string {
  return padded(content, columns)
}

/** Align two small pieces of information without introducing another box. */
export function secondaryModalPair(
  leftContent: string,
  rightContent: string,
  columns: number,
  gap = 2,
): string {
  const left = safeInline(leftContent)
  const right = safeInline(rightContent)
  const boundedGap = Math.max(1, Math.floor(gap))
  const rightWidth = Math.min(visibleWidth(right), Math.max(0, columns - boundedGap - 1))
  const fittedRight = fit(right, rightWidth)
  const leftWidth = Math.max(1, columns - visibleWidth(fittedRight) - boundedGap)
  const fittedLeft = fit(left, leftWidth)
  return padded(
    fittedLeft
      + ' '.repeat(Math.max(boundedGap, columns - visibleWidth(fittedLeft) - visibleWidth(fittedRight)))
      + fittedRight,
    columns,
  )
}

export function secondaryModalHeader(
  title: string,
  columns: number,
  endLabel = 'esc',
): string {
  return secondaryModalPair(`▌ ${safeInline(title).trim()}`, safeInline(endLabel).trim(), columns)
}

export function secondaryModalSection(
  label: string,
  columns: number,
  endLabel?: string,
): string {
  return secondaryModalPair(
    `  ${safeInline(label).trim()}`,
    endLabel === undefined ? '' : safeInline(endLabel).trim(),
    columns,
  )
}

export function secondaryModalSplit(
  leftContent: string,
  rightContent: string,
  columns: number,
  leftColumns: number,
): string {
  if (columns <= 4) return fit(leftContent, columns)
  const boundedLeft = Math.max(1, Math.min(columns - 4, Math.floor(leftColumns)))
  const rightColumns = columns - boundedLeft - 3
  return `│${padded(leftContent, boundedLeft)}│${padded(rightContent, rightColumns)}│`
}

export function secondaryModalTriple(
  firstContent: string,
  secondContent: string,
  thirdContent: string,
  columns: number,
  firstColumns: number,
  secondColumns: number,
): string {
  if (columns <= 5) return fit(firstContent, columns)
  const boundedFirst = Math.max(1, Math.min(columns - 6, Math.floor(firstColumns)))
  const remainingAfterFirst = columns - boundedFirst - 4
  const boundedSecond = Math.max(1, Math.min(remainingAfterFirst - 1, Math.floor(secondColumns)))
  const thirdColumns = columns - boundedFirst - boundedSecond - 4
  return `│${padded(firstContent, boundedFirst)}│${padded(secondContent, boundedSecond)}│${padded(thirdContent, thirdColumns)}│`
}

export function secondaryModalRow(
  text: string,
  tone: DshTuiSemanticRole,
  options: SecondaryModalStyleOptions = {},
): SecondaryModalRow {
  return Object.freeze({
    text,
    style: secondaryModalStyle(tone, options),
  })
}
