import { createHash } from 'node:crypto'
import type { CoreSessionPort } from '../runtime/core-session-port.ts'
import { unpackDshEventDelivery } from '../runtime/delivery.ts'
import {
  applyToolPresentation,
  reduceUiEvent,
  selectSession,
} from '../transcript/reducer.ts'
import { createUiState, type ToolRow } from '../transcript/state.ts'
import type {
  DiffDocument,
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffWorkspacePort,
} from '../features/diff/port.ts'
import type { ToolFileDiff, ToolPresentationView } from '../presentation/types.ts'

type DiffReplayCore = Pick<CoreSessionPort, 'sessionId' | 'events'>
type DiffPresentation = Extract<ToolPresentationView, { card: 'diff' }>

interface SafeDiffOperation {
  readonly title?: string
  readonly diffs: readonly ToolFileDiff[]
}

interface DiffSnapshot {
  readonly digest: string
  readonly operations: readonly SafeDiffOperation[]
}

interface ActiveReplay {
  readonly controller: AbortController
  readonly settled: Promise<void>
  readonly settle: () => void
}

const INTERNAL_CAUGHT_UP = Symbol('dsh-tui.diff.caught-up')
const DIFF_CONTEXT_LINES = 3

/**
 * Session-scoped rc2 adapter backed only by one caught-up durable replay.
 * It intentionally owns no live watcher: closed Diff surfaces therefore have
 * no subscriber and cannot consume work from the Chat event pump.
 */
export class DshDiffWorkspace implements DiffWorkspacePort {
  readonly #readers = new Set<ActiveReplay>()
  #snapshot: DiffSnapshot | undefined
  #generation = 0
  #disposed = false
  #disposeTask: Promise<void> | undefined

  constructor(private readonly core: DiffReplayCore) {}

  async describeCurrent(
    context: Parameters<DiffWorkspacePort['describeCurrent']>[0],
  ): Promise<{ readonly digest: string } | null> {
    this.#assertActive()
    context.signal.throwIfAborted()
    const generation = ++this.#generation
    const operations = await this.#readDurableDiffs(context.signal)
    this.#assertActive()
    context.signal.throwIfAborted()

    if (operations.length === 0) {
      if (generation === this.#generation) this.#snapshot = undefined
      return null
    }

    const snapshot = Object.freeze({
      digest: digestOperations(operations),
      operations,
    })
    if (generation === this.#generation) this.#snapshot = snapshot
    return Object.freeze({ digest: snapshot.digest })
  }

  compute(
    context: Parameters<DiffWorkspacePort['compute']>[0],
  ): DiffDocument {
    this.#assertActive()
    context.signal.throwIfAborted()
    const snapshot = this.#snapshot
    if (snapshot === undefined) {
      throw new Error('DSH Diff has no described durable snapshot')
    }
    if (context.reference.digest !== snapshot.digest) {
      throw new Error(
        `DSH Diff reference "${safeInline(context.reference.digest, false)}" does not match the described durable snapshot`,
      )
    }

    const files = snapshot.operations.flatMap((operation, operationIndex) => (
      operation.diffs.map((diff, fileIndex) => createDiffFile(
        diff,
        operationIndex,
        fileIndex,
      ))
    ))
    return Object.freeze({
      digest: snapshot.digest,
      title: snapshot.operations.length === 1
        ? snapshot.operations[0]!.title ?? 'Session changes'
        : 'Session changes',
      files: Object.freeze(files),
    })
  }

  dispose(): Promise<void> {
    if (this.#disposeTask !== undefined) return this.#disposeTask
    this.#disposed = true
    this.#generation += 1
    this.#snapshot = undefined
    const readers = [...this.#readers]
    for (const reader of readers) reader.controller.abort('DSH Diff workspace disposed')
    this.#disposeTask = Promise.all(readers.map(reader => reader.settled)).then(() => {})
    return this.#disposeTask
  }

  async #readDurableDiffs(signal: AbortSignal): Promise<readonly SafeDiffOperation[]> {
    const done = Promise.withResolvers<void>()
    const reader: ActiveReplay = {
      controller: new AbortController(),
      settled: done.promise,
      settle: done.resolve,
    }
    this.#readers.add(reader)
    let caughtUp = false
    const forwardAbort = (): void => { reader.controller.abort(signal.reason) }
    signal.addEventListener('abort', forwardAbort, { once: true })
    let state = selectSession(createUiState(), this.core.sessionId)

    try {
      const stream = this.core.events({
        afterSeq: -1,
        signal: reader.controller.signal,
        onCaughtUp: () => {
          caughtUp = true
          reader.controller.abort(INTERNAL_CAUGHT_UP)
        },
      })
      try {
        for await (const item of stream) {
          const { event, toolPresentation } = unpackDshEventDelivery(item)
          if (event.sessionId !== this.core.sessionId) {
            throw new Error('DSH Diff replay crossed its bound session identity')
          }
          state = reduceUiEvent(state, event)
          state = applyToolPresentation(state, event, toolPresentation)
        }
      } catch (error: unknown) {
        if (!(caughtUp && reader.controller.signal.reason === INTERNAL_CAUGHT_UP)) throw error
      }

      if (this.#disposed) throw new Error('DSH Diff workspace is disposed')
      signal.throwIfAborted()
      if (!caughtUp) {
        throw new Error('DSH Diff event stream ended before the durable replay boundary')
      }
      const session = state.sessions[this.core.sessionId]!
      if (session.compatibilityError !== undefined) {
        throw new Error(
          `DSH Diff durable replay failed: ${session.compatibilityError.message}`,
        )
      }
      return Object.freeze(session.rows
        .filter((row): row is ToolRow => row.kind === 'tool')
        .map(operationFromToolRow)
        .filter((operation): operation is SafeDiffOperation => operation !== undefined))
    } finally {
      signal.removeEventListener('abort', forwardAbort)
      this.#readers.delete(reader)
      if (!reader.controller.signal.aborted) {
        reader.controller.abort('DSH Diff replay complete')
      }
      reader.settle()
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('DSH Diff workspace is disposed')
  }
}

function operationFromToolRow(row: ToolRow): SafeDiffOperation | undefined {
  const presentation = effectiveDiffPresentation(row)
  if (presentation === undefined || presentation.diffs.length === 0) return undefined
  const diffs = presentation.diffs.map(diff => Object.freeze({
    path: safeInline(diff.path, false),
    oldText: diff.oldText === null ? null : safeMultiline(diff.oldText),
    newText: safeMultiline(diff.newText),
  }))
  return Object.freeze({
    ...(presentation.title === undefined
      ? {}
      : { title: safeInline(presentation.title, true) }),
    diffs: Object.freeze(diffs),
  })
}

function effectiveDiffPresentation(row: ToolRow): DiffPresentation | undefined {
  if (row.resultPresentation?.card === 'diff') return row.resultPresentation
  if (row.callPresentation?.card === 'diff') return row.callPresentation
  return undefined
}

function digestOperations(operations: readonly SafeDiffOperation[]): string {
  const hash = createHash('sha256')
  // Event sequence and call ids are intentionally excluded: equal semantic
  // documents share a cache key even when replayed under another session.
  hash.update(JSON.stringify(operations))
  return `sha256:${hash.digest('hex')}`
}

function createDiffFile(
  diff: ToolFileDiff,
  operationIndex: number,
  fileIndex: number,
): DiffFile {
  const status = diff.oldText === null
    ? 'added'
    : diff.newText.length === 0
      ? 'deleted'
      : 'modified'
  const oldLines = diff.oldText === null ? [] : splitLines(diff.oldText)
  const newLines = splitLines(diff.newText)
  const hunk = createHunk(
    oldLines,
    newLines,
    `operation-${operationIndex}-${fileIndex}`,
    status,
  )
  return Object.freeze({
    path: diff.path,
    status,
    hunks: hunk === undefined ? Object.freeze([]) : Object.freeze([hunk]),
  })
}

function createHunk(
  before: readonly string[],
  after: readonly string[],
  id: string,
  status: DiffFile['status'],
): DiffHunk | undefined {
  if (before.length === 0 && after.length === 0) return undefined
  if (status === 'added') {
    return frozenHunk(id, hunkHeader(0, 0, 1, after.length), after.map((text, index) => ({
      kind: 'added' as const,
      newLine: index + 1,
      text,
    })))
  }
  if (status === 'deleted') {
    return frozenHunk(id, hunkHeader(1, before.length, 0, 0), before.map((text, index) => ({
      kind: 'removed' as const,
      oldLine: index + 1,
      text,
    })))
  }

  const prefix = commonPrefix(before, after)
  const suffix = commonSuffix(before, after, prefix)
  if (prefix === before.length && prefix === after.length) return undefined
  const contextBefore = Math.min(DIFF_CONTEXT_LINES, prefix)
  const contextAfter = Math.min(DIFF_CONTEXT_LINES, suffix)
  const oldChangeEnd = before.length - suffix
  const newChangeEnd = after.length - suffix
  const oldStartIndex = prefix - contextBefore
  const newStartIndex = prefix - contextBefore
  const lines: DiffLine[] = []

  for (let index = oldStartIndex; index < prefix; index += 1) {
    lines.push(Object.freeze({
      kind: 'context',
      oldLine: index + 1,
      newLine: index + 1,
      text: before[index]!,
    }))
  }
  for (let index = prefix; index < oldChangeEnd; index += 1) {
    lines.push(Object.freeze({ kind: 'removed', oldLine: index + 1, text: before[index]! }))
  }
  for (let index = prefix; index < newChangeEnd; index += 1) {
    lines.push(Object.freeze({ kind: 'added', newLine: index + 1, text: after[index]! }))
  }
  for (let offset = 0; offset < contextAfter; offset += 1) {
    const oldIndex = oldChangeEnd + offset
    const newIndex = newChangeEnd + offset
    lines.push(Object.freeze({
      kind: 'context',
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
      text: before[oldIndex]!,
    }))
  }

  const oldCount = contextBefore + (oldChangeEnd - prefix) + contextAfter
  const newCount = contextBefore + (newChangeEnd - prefix) + contextAfter
  return frozenHunk(
    id,
    hunkHeader(oldStartIndex + 1, oldCount, newStartIndex + 1, newCount),
    lines,
  )
}

function frozenHunk(
  id: string,
  header: string,
  lines: readonly DiffLine[],
): DiffHunk {
  return Object.freeze({ id, header, lines: Object.freeze([...lines]) })
}

function hunkHeader(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
}

function commonPrefix(before: readonly string[], after: readonly string[]): number {
  const limit = Math.min(before.length, after.length)
  let index = 0
  while (index < limit && before[index] === after[index]) index += 1
  return index
}

function commonSuffix(
  before: readonly string[],
  after: readonly string[],
  prefix: number,
): number {
  const limit = Math.min(before.length, after.length) - prefix
  let offset = 0
  while (
    offset < limit
    && before[before.length - offset - 1] === after[after.length - offset - 1]
  ) offset += 1
  return offset
}

function splitLines(value: string): readonly string[] {
  if (value.length === 0) return Object.freeze([])
  return Object.freeze(value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(line => safeInline(line, true)))
}

function safeMultiline(value: string): string {
  return splitLines(value).join('\n')
}

function safeInline(value: string, preserveTab: boolean): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!
    if (preserveTab && character === '\t') return character
    return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? '�'
      : character
  }).join('')
}
