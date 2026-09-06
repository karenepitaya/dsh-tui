import { describe, expect, it, vi } from 'vitest'
import {
  createFeatureSurfaceProjection,
  featureSurfaceTextWidth,
  safeFeatureSurfaceText,
  sliceFeatureSurfaceText,
  type FeatureSurfaceProjectContext,
} from '../src/presentation/feature-surface.ts'
import {
  createSessionUiState,
  createUiState,
} from '../src/transcript/state.ts'
import {
  createSessionsContentNode,
  createSessionsFeatureModel,
  createSessionsInspectorNode,
  createSessionsNavigatorNode,
} from '../src/features/sessions/index.ts'
import {
  createDiffContentNode,
  createDiffInspectorNode,
  createDiffFeatureState,
  projectDiffDocument,
  transitionDiffFeature,
  type DiffFeatureState,
  type DiffStateSource,
} from '../src/features/diff/index.ts'

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

function context(
  width: number,
  height: number,
  overrides: Partial<FeatureSurfaceProjectContext> = {},
): FeatureSurfaceProjectContext {
  return Object.freeze({
    bounds: Object.freeze({ x: 0, y: 0, width, height }),
    focus: true,
    mode: 'normal',
    resources: Object.freeze([]),
    ...overrides,
  })
}

function expectBoundedPlainText(
  projection: ReturnType<typeof createFeatureSurfaceProjection>,
  width: number,
  height: number,
): void {
  expect(projection.rows.length).toBeLessThanOrEqual(height)
  for (const row of projection.rows) {
    expect(row.text).not.toMatch(CONTROL_CHARACTERS)
    expect(featureSurfaceTextWidth(row.text)).toBeLessThanOrEqual(width)
  }
}

function fixedDiffSource(state: DiffFeatureState): DiffStateSource {
  return Object.freeze({
    snapshot: () => state,
    onChanged: () => () => {},
  })
}

function selectDiff(
  state: DiffFeatureState,
  selection: Partial<DiffFeatureState['selection']>,
): DiffFeatureState {
  return Object.freeze({
    ...state,
    selection: Object.freeze({ ...state.selection, ...selection }),
  }) as DiffFeatureState
}

describe('Feature Surface presentation contract', () => {
  it('bounds terminal-safe plain rows while preserving semantic styling and cursor', () => {
    const projection = createFeatureSurfaceProjection(context(8, 2), [
      {
        text: '\u001b[31m中间\u001b[0m\nWindows',
        tone: 'accent',
        bold: true,
        selected: true,
      },
      { text: 'D:\\项目\\入口.ts', tone: 'muted', dim: true },
      { text: 'hidden' },
    ], { row: 0, column: 99 })

    expectBoundedPlainText(projection, 8, 2)
    expect(projection.rows[0]).toMatchObject({
      text: '中间 Wi…',
      tone: 'accent',
      bold: true,
      dim: false,
      selected: true,
    })
    expect(projection.cursor).toEqual({ row: 0, column: 8 })
    expect(Object.isFrozen(projection)).toBe(true)
    expect(Object.isFrozen(projection.rows)).toBe(true)
    expect(Object.isFrozen(projection.rows[0])).toBe(true)
  })

  it('sanitizes every terminal control family and handles extreme cell geometry', () => {
    expect(safeFeatureSurfaceText(
      '\u001b]title\u0007A'
      + '\u001bPdata\u001b\\B'
      + '\u001bXdata\u009cC'
      + '\u001b^data\u0007D'
      + '\u001b_data\u0007E',
    )).toBe('ABCDE')
    expect(safeFeatureSurfaceText(
      '\u009ddata\u0007A'
      + '\u0090data\u0007B'
      + '\u0098data\u0007C'
      + '\u009edata\u0007D'
      + '\u009fdata\u0007E',
    )).toBe('ABCDE')
    expect(safeFeatureSurfaceText('\u009b31mred')).toBe('red')
    expect(safeFeatureSurfaceText('\u001b[')).toBe('')
    expect(safeFeatureSurfaceText('\u001b]unterminated')).toBe('')
    expect(safeFeatureSurfaceText('\u001b7kept')).toBe('kept')
    expect(safeFeatureSurfaceText('\t\n\r\u0001\u007f')).toBe('    ��')

    expect(featureSurfaceTextWidth(
      'a\u200b\u200c\u200d\ufe0f\u{e0100}\u0301',
    )).toBe(1)
    expect(featureSurfaceTextWidth('\u{1fb00}\u{40000}')).toBe(2)

    expect(sliceFeatureSurfaceText('中a', 1)).toBe('a')
    expect(sliceFeatureSurfaceText('ab', 1)).toBe('b')
    expect(sliceFeatureSurfaceText('\u0301a', 1)).toBe('')
    expect(sliceFeatureSurfaceText('ab', 99)).toBe('')
    expect(sliceFeatureSurfaceText('ab', Number.POSITIVE_INFINITY)).toBe('ab')

    expect(createFeatureSurfaceProjection(context(Number.NaN, 1), [
      { text: 'hidden by zero width' },
    ]).rows[0]?.text).toBe('')
    expect(createFeatureSurfaceProjection(context(8, Number.NaN), [
      { text: 'hidden by zero height' },
    ]).rows).toEqual([])
    expect(createFeatureSurfaceProjection(context(8, 1), [
      { text: 'visible' },
    ], { row: 4, column: 0 }).cursor).toBeUndefined()
    expect(createFeatureSurfaceProjection(context(8, 1), [
      { text: 'visible' },
    ], { row: Number.NaN, column: 0 }).cursor).toBeUndefined()
    expect(createFeatureSurfaceProjection(context(8, 1), [
      { text: 'visible' },
    ], { row: 0, column: Number.NaN }).cursor).toBeUndefined()
    expect(createFeatureSurfaceProjection(context(8, 1), [
      { text: 'visible' },
    ], { row: 0, column: -4 }).cursor).toEqual({ row: 0, column: 0 })
  })

  it('lets Sessions nodes project compact navigator, content, and inspection semantics', () => {
    const model = createSessionsFeatureModel()
    const source = Object.freeze({
      snapshot: () => model.snapshot(),
      onChanged: (listener: Parameters<typeof model.onChanged>[0]) => model.onChanged(listener),
    })
    const navigator = createSessionsNavigatorNode(source)
    const content = createSessionsContentNode(source)
    const inspector = createSessionsInspectorNode(source)
    const request = { scopeEpoch: 1, requestId: 1 }
    model.dispatch({ type: 'catalog.load-started', request })
    model.dispatch({
      type: 'catalog.loaded',
      request,
      snapshot: {
        durability: 'available',
        sessions: [
          {
            sessionId: '当前会话',
            createdAt: 42,
            cwd: 'D:\\研发\\代理项目',
            isSubagent: false,
            attached: true,
            durablePresence: 'observed',
            liveStatus: 'running',
          },
          {
            sessionId: '另一个',
            createdAt: 21,
            cwd: 'D:\\work\\另一个',
            isSubagent: true,
            parentSessionId: '当前会话',
            attached: false,
            durablePresence: 'observed',
          },
        ],
      },
    })
    model.dispatch({ type: 'query.changed', query: '研发' })

    const changed = vi.fn()
    const stop = navigator.onChanged(changed)
    model.dispatch({ type: 'query.changed', query: '' })
    expect(changed).toHaveBeenCalledOnce()
    stop()
    model.dispatch({ type: 'selection.move', direction: 'down' })
    expect(changed).toHaveBeenCalledOnce()

    model.dispatch({ type: 'query.changed', query: '研发' })
    const navigation = navigator.project(context(48, 8, { mode: 'insert' }))
    expect(navigation.rows.map(row => row.text).join('\n')).toContain('研发')
    expect(navigation.rows.some(row => row.selected && row.text.includes('当前会话'))).toBe(true)
    expect(navigation.rows.some(row => row.tone === 'success')).toBe(true)
    expect(navigation.cursor).toBeDefined()

    const detail = content.project(context(64, 10))
    expect(detail.rows.map(row => row.text).join('\n')).toContain('D:\\研发\\代理项目')
    expect(detail.rows.some(row => row.selected)).toBe(true)

    model.dispatch({ type: 'selection.activated' })
    const inspectionRequest = { scopeEpoch: 1, requestId: 2 }
    model.dispatch({
      type: 'inspection.load-started',
      sessionId: '当前会话',
      request: inspectionRequest,
    })
    const session = {
      ...createSessionUiState('当前会话'),
      agentStatus: 'running' as const,
      journal: Object.freeze([{ seq: 0 }] as never[]),
      rows: Object.freeze([{
        kind: 'assistant-draft',
        key: 'draft:1:1',
        firstSeq: 0,
        lastSeq: 0,
        turn: 1,
        step: 1,
        text: '正在检查路径',
        reasoning: '',
        chunkCount: 1,
      }] as const),
      todos: Object.freeze([{ id: 'todo', content: '检查', status: 'pending' }] as never[]),
    }
    model.dispatch({
      type: 'inspection.loaded',
      sessionId: '当前会话',
      request: inspectionRequest,
      projection: {
        sessionId: '当前会话',
        header: {
          sessionId: '当前会话',
          createdAt: 42,
          cwd: 'D:\\研发\\代理项目',
          isSubagent: false,
        },
        transcript: {
          ...createUiState(),
          phase: 'ready',
          activeSessionId: '当前会话',
          sessions: { 当前会话: session },
        },
      },
    })
    const inspected = inspector.project(context(52, 12))
    const inspectedText = inspected.rows.map(row => row.text).join('\n')
    expect(inspectedText).toContain('D:\\研发\\代理项目')
    expect(inspectedText).toContain('1 row')
    expect(inspectedText).toContain('1 todo')

    expectBoundedPlainText(navigator.project(context(12, 4)), 12, 4)
    expectBoundedPlainText(content.project(context(12, 4)), 12, 4)
    expectBoundedPlainText(inspector.project(context(12, 4)), 12, 4)
    model.dispose()
  })

  it('lets Diff nodes project file, hunk, line, collapse, stats, and inspector semantics', () => {
    const projection = projectDiffDocument({
      digest: 'sha256:surface',
      title: '工作树',
      files: [{
        path: 'C:\\项目\\src\\入口.ts',
        previousPath: 'C:\\项目\\src\\旧入口.ts',
        status: 'renamed',
        hunks: [{
          id: 'main',
          header: '@@ -1,2 +1,2 @@',
          lines: [
            { kind: 'removed', oldLine: 1, text: '旧值' },
            { kind: 'added', newLine: 1, text: '新值' },
            { kind: 'context', oldLine: 2, newLine: 2, text: 'const safe = true' },
          ],
        }],
      }],
    }, { maxLinesPerHunk: 2 })
    let current = transitionDiffFeature(createDiffFeatureState(), {
      type: 'load-succeeded', projection,
    }).state
    const listeners = new Set<(state: DiffFeatureState) => void>()
    const source: DiffStateSource = {
      snapshot: () => current,
      onChanged: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const publish = (state: DiffFeatureState): void => {
      current = state
      for (const listener of listeners) listener(state)
    }
    const content = createDiffContentNode('diff.document', source)
    const inspector = createDiffInspectorNode('diff.document', source)

    const changed = vi.fn()
    const stop = content.onChanged(changed)
    publish(transitionDiffFeature(current, { type: 'move', direction: 'down' }).state)
    expect(changed).toHaveBeenCalledOnce()
    stop()

    const inspectorChanged = vi.fn()
    const stopInspector = inspector.onChanged(inspectorChanged)
    publish(current)
    expect(inspectorChanged).toHaveBeenCalledOnce()
    stopInspector()

    const rendered = content.project(context(72, 12))
    const text = rendered.rows.map(row => row.text).join('\n')
    expect(text).toContain('C:\\项目\\src\\入口.ts')
    expect(text).toContain('@@ -1,2 +1,2 @@')
    expect(rendered.rows.some(row => row.tone === 'added' && row.text.includes('+'))).toBe(true)
    expect(rendered.rows.some(row => row.tone === 'removed' && row.text.includes('-'))).toBe(true)
    expect(rendered.rows.some(row => row.selected)).toBe(true)
    expect(text).toContain('hidden line')

    const inspected = inspector.project(context(48, 10))
    expect(inspected.rows.map(row => row.text).join('\n')).toContain('C:\\项目\\src\\入口.ts')
    expect(inspected.rows.map(row => row.text).join('\n')).toContain('+1 -1')

    publish(transitionDiffFeature(current, { type: 'toggle-collapse' }).state)
    const folded = content.project(context(72, 12))
    expect(folded.rows.some(row => row.text.includes('folded'))).toBe(true)

    expectBoundedPlainText(content.project(context(14, 5)), 14, 5)
    expectBoundedPlainText(inspector.project(context(14, 5)), 14, 5)
  })

  it('projects every Diff lifecycle, file status, empty selection, and window boundary', () => {
    const projection = projectDiffDocument({
      digest: 'sha256:all-diff-states',
      files: [
        {
          path: 'added.ts',
          status: 'added',
          hunks: [{ id: 'empty', header: '', lines: [] }],
        },
        {
          path: 'deleted.ts',
          status: 'deleted',
          hunks: [{
            id: 'deleted',
            header: '@@ deleted @@',
            lines: [{ kind: 'removed', oldLine: 1, text: 'gone' }],
          }],
        },
        {
          path: 'modified.ts',
          status: 'modified',
          hunks: [{
            id: 'modified',
            header: '@@ modified @@',
            lines: [{ kind: 'context', oldLine: 20, newLine: 20, text: 'same' }],
          }],
        },
        {
          path: 'renamed.ts',
          previousPath: 'before.ts',
          status: 'renamed',
          hunks: [{
            id: 'renamed',
            header: '@@ renamed @@',
            lines: [{ kind: 'added', newLine: 2, text: 'now' }],
          }],
        },
      ],
    })
    const ready = transitionDiffFeature(createDiffFeatureState(), {
      type: 'load-succeeded',
      projection,
    }).state
    const content = createDiffContentNode('diff.document', fixedDiffSource(ready))
    const inspector = createDiffInspectorNode('diff.document', fixedDiffSource(ready))
    const resourceContext = context(80, 40, {
      resources: Object.freeze([{
        id: 'diff.document',
        phase: 'refreshing',
      }]),
    })
    const contentText = content.project(resourceContext).rows.map(row => row.text).join('\n')
    expect(contentText).toContain('DIFF  4 files')
    expect(contentText).toContain('A  added.ts')
    expect(contentText).toContain('D  deleted.ts')
    expect(contentText).toContain('M  modified.ts')
    expect(contentText).toContain('R  before.ts → renamed.ts')
    expect(contentText).toContain('empty')
    expect(contentText).toContain(' same')
    expect(contentText).toContain('refreshing')
    expect(content.project(context(80, 0)).rows).toEqual([])
    expect(content.project(context(80, 1)).rows).toHaveLength(1)
    expect(content.project(context(80, Number.NaN)).rows).toEqual([])

    const firstInspector = inspector.project(context(80, 20))
    expect(firstInspector.rows.map(row => row.text).join('\n')).toContain('empty')
    expect(firstInspector.rows.some(row => row.text.startsWith('Line'))).toBe(false)

    const removed = selectDiff(ready, { fileIndex: 1, hunkIndex: 0, lineIndex: 0 })
    const removedText = createDiffInspectorNode(
      'diff.document',
      fixedDiffSource(removed),
    ).project(context(80, 20)).rows.map(row => row.text).join('\n')
    expect(removedText).toContain('Line  1 → — · removed')

    const contextLine = selectDiff(ready, { fileIndex: 2, hunkIndex: 0, lineIndex: 0 })
    expect(createDiffInspectorNode(
      'diff.document',
      fixedDiffSource(contextLine),
    ).project(context(80, 20)).rows.map(row => row.text).join('\n'))
      .toContain('Line  20 → 20 · context')

    const invalidFile = selectDiff(ready, { fileIndex: 99 })
    expect(createDiffInspectorNode(
      'diff.document',
      fixedDiffSource(invalidFile),
    ).project(context(80, 20)).rows.map(row => row.text).join('\n'))
      .toContain('No hunk selected')
    const invalidHunk = selectDiff(ready, { fileIndex: 0, hunkIndex: 99 })
    expect(createDiffInspectorNode(
      'diff.document',
      fixedDiffSource(invalidHunk),
    ).project(context(80, 20)).rows.map(row => row.text).join('\n'))
      .toContain('No hunk selected')

    expect(content.project(context(80, 3)).rows).toHaveLength(3)
    const unselectedContent = createDiffContentNode(
      'diff.document',
      fixedDiffSource(invalidFile),
    ).project(context(80, 3))
    expect(unselectedContent.rows).toHaveLength(3)

    const filesOnlyTruncation = Object.freeze({
      ...projection,
      truncation: Object.freeze({
        truncated: true,
        hiddenFiles: 1,
        hiddenHunks: 0,
        hiddenLines: 0,
        shortenedTexts: 0,
      }),
    })
    const filesOnlyState = transitionDiffFeature(createDiffFeatureState(), {
      type: 'load-succeeded',
      projection: filesOnlyTruncation,
    }).state
    expect(createDiffContentNode(
      'diff.document',
      fixedDiffSource(filesOnlyState),
    ).project(context(80, 40)).rows.map(row => row.text).join('\n'))
      .toContain('1 hidden file')
  })

  it('projects Diff idle, empty, loading, failed, last-good, and truncation states', () => {
    const render = (state: DiffFeatureState) => {
      const source = fixedDiffSource(state)
      expect(createDiffInspectorNode('diff.document', source).hasContent?.())
        .toBe(state.phase !== 'idle' && state.phase !== 'empty')
      return {
        content: createDiffContentNode('diff.document', source)
          .project(context(100, 30)).rows.map(row => row.text).join('\n'),
        inspector: createDiffInspectorNode('diff.document', source)
          .project(context(100, 30)).rows.map(row => row.text).join('\n'),
      }
    }

    const idle = createDiffFeatureState()
    expect(render(idle)).toMatchObject({
      content: expect.stringContaining('Open Diff to inspect changes'),
      inspector: expect.stringContaining('No diff selected'),
    })
    const empty = transitionDiffFeature(idle, { type: 'load-empty' }).state
    expect(render(empty)).toMatchObject({
      content: expect.stringContaining('Working tree has no changes'),
      inspector: expect.stringContaining('No changed files'),
    })
    const loading = transitionDiffFeature(idle, { type: 'load-started' }).state
    expect(render(loading)).toMatchObject({
      content: expect.stringContaining('Computing diff…'),
      inspector: expect.stringContaining('Waiting for diff details…'),
    })
    const failedError = transitionDiffFeature(idle, {
      type: 'load-failed',
      error: new Error('disk unavailable'),
    }).state
    expect(render(failedError)).toMatchObject({
      content: expect.stringContaining('Diff failed · disk unavailable'),
      inspector: expect.stringContaining('Load failed · disk unavailable'),
    })
    const failedString = transitionDiffFeature(idle, {
      type: 'load-failed',
      error: 'offline',
    }).state
    expect(render(failedString).content).toContain('Diff failed · offline')

    const projection = projectDiffDocument({
      digest: 'sha256:last-good',
      files: [{
        path: 'long-path.ts',
        status: 'modified',
        hunks: [
          {
            id: 'visible',
            header: '@@ visible @@',
            lines: [
              { kind: 'context', oldLine: 1, newLine: 1, text: 'long-value' },
              { kind: 'added', newLine: 2, text: 'extra' },
            ],
          },
          {
            id: 'hidden',
            header: '@@ hidden @@',
            lines: [{ kind: 'removed', oldLine: 3, text: 'old' }],
          },
        ],
      }, {
        path: 'hidden-file.ts',
        status: 'added',
        hunks: [{
          id: 'hidden-file-hunk',
          header: '@@ hidden file @@',
          lines: [{ kind: 'added', newLine: 1, text: 'new' }],
        }],
      }],
    }, {
      maxFiles: 1,
      maxHunksPerFile: 1,
      maxLinesPerHunk: 1,
      maxTextCodePoints: 5,
    })
    const ready = transitionDiffFeature(idle, { type: 'load-succeeded', projection }).state
    const truncated = render(ready)
    expect(truncated.content).toContain('hidden hunk')
    expect(truncated.content).toContain('TRUNCATED')
    expect(truncated.content).toContain('hidden file')
    expect(truncated.content).toContain('hidden line')
    expect(truncated.content).toContain('shortened row')
    expect(truncated.inspector).toContain('TRUNCATED')

    const refreshing = transitionDiffFeature(ready, { type: 'load-started' }).state
    expect(render(refreshing).content).toContain('Refreshing diff…')
    const failedLastGood = transitionDiffFeature(ready, {
      type: 'load-failed',
      error: 'refresh offline',
    }).state
    const failed = render(failedLastGood)
    expect(failed.content).toContain('Refresh failed · refresh offline')
    expect(failed.inspector).toContain('Refresh failed · refresh offline')
  })
})
