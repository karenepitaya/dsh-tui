import type { ToolPresentationView } from '../presentation/types.ts'
import type {
  ConversationStyledLine,
  ConversationStyledSegment,
} from './conversation.ts'

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'def', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
  'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'interface', 'let',
  'new', 'null', 'of', 'package', 'private', 'protected', 'public', 'readonly',
  'return', 'static', 'super', 'switch', 'throw', 'true', 'try', 'type', 'undefined',
  'var', 'void', 'while', 'with', 'yield',
])

function appendSegment(
  segments: ConversationStyledSegment[],
  segment: ConversationStyledSegment,
): void {
  const previous = segments.at(-1)
  if (previous?.tone === segment.tone && previous.bold === segment.bold) {
    segments[segments.length - 1] = { ...previous, text: previous.text + segment.text }
    return
  }
  segments.push(segment)
}

function commentPrefix(lang: string | undefined, text: string, index: number): number {
  if (text.startsWith('//', index) || text.startsWith('/*', index)) return 2
  const hashComment = lang === undefined
    || /^(py|python|sh|shell|bash|zsh|fish|ps1|powershell|yaml|yml|toml)$/iu.test(lang)
  return hashComment && text[index] === '#' ? 1 : 0
}

function syntaxSegments(text: string, lang: string | undefined): ConversationStyledSegment[] {
  if (/^(md|markdown)$/iu.test(lang ?? '') && /^\s{0,3}#{1,6}\s/u.test(text)) {
    return [{ text, tone: 'accent', bold: true }]
  }
  const segments: ConversationStyledSegment[] = []
  let index = 0
  while (index < text.length) {
    const commentLength = commentPrefix(lang, text, index)
    if (commentLength > 0) {
      appendSegment(segments, { text: text.slice(index), tone: 'muted' })
      break
    }
    const char = text[index]!
    if (char === "'" || char === '"' || char === '`') {
      let end = index + 1
      while (end < text.length) {
        if (text[end] === '\\') {
          end += 2
          continue
        }
        const closing = text[end] === char
        end += 1
        if (closing) break
      }
      appendSegment(segments, { text: text.slice(index, end), tone: 'success' })
      index = end
      continue
    }
    if (/[A-Za-z_$]/u.test(char)) {
      let end = index + 1
      while (end < text.length && /[A-Za-z0-9_$-]/u.test(text[end]!)) end += 1
      const word = text.slice(index, end)
      appendSegment(segments, KEYWORDS.has(word)
        ? { text: word, tone: 'accent', bold: true }
        : { text: word, tone: 'code' })
      index = end
      continue
    }
    if (/\d/u.test(char)) {
      let end = index + 1
      while (end < text.length && /[\d._xA-Fa-f]/u.test(text[end]!)) end += 1
      appendSegment(segments, { text: text.slice(index, end), tone: 'warning' })
      index = end
      continue
    }
    appendSegment(segments, { text: char, tone: 'code' })
    index += 1
  }
  return segments.length === 0 ? [{ text: '', tone: 'code' }] : segments
}

function readLineStyle(line: string, lang: string | undefined): ConversationStyledLine {
  const match = /^(\s*\d+\s*│\s?)(.*)$/u.exec(line)
  if (match !== null) {
    return {
      segments: [
        { text: match[1]!, tone: 'muted' },
        ...syntaxSegments(match[2]!, lang),
      ],
    }
  }
  if (line.startsWith('File:')) {
    return { segments: [{ text: line, tone: 'accent', bold: true }] }
  }
  if (line.startsWith('Lines:') || line.includes('lines hidden')) {
    return { segments: [{ text: line, tone: 'muted' }] }
  }
  return { segments: [{ text: line, tone: 'primary' }] }
}

function diffLineStyle(line: string): ConversationStyledLine {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return { segments: [{ text: line, tone: 'muted', bold: true }] }
  }
  if (line.startsWith('@@')) {
    return { segments: [{ text: line, tone: 'accent', bold: true }] }
  }
  if (line.startsWith('+')) return { segments: [{ text: line, tone: 'success' }] }
  if (line.startsWith('-')) return { segments: [{ text: line, tone: 'error' }] }
  if (/^(Create|Update|Delete)\s/u.test(line)) {
    return { segments: [{ text: line, tone: 'telemetry', bold: true }] }
  }
  if (line.includes('lines hidden')) return { segments: [{ text: line, tone: 'muted' }] }
  return { segments: [{ text: line, tone: 'code' }] }
}

/** Add trusted semantic color to official renderer-neutral Tool presentations. */
export function styleToolCardLines(
  presentation: ToolPresentationView | undefined,
  lines: readonly string[],
): readonly ConversationStyledLine[] | undefined {
  if (presentation?.card === 'read' && presentation.phase === 'result') {
    return lines.map(line => readLineStyle(line, presentation.lang))
  }
  if (presentation?.card === 'diff') return lines.map(diffLineStyle)
  return undefined
}
