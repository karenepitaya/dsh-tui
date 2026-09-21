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
  createSessionsFeatureModel,
  createSessionsNavigatorNode,
  projectSessionDetails,
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

  it('lets Sessions nodes project compact navigator and details semantics', () => {
    const model = createSessionsFeatureModel()
    const source = Object.freeze({
      snapshot: () => model.snapshot(),
      onChanged: (listener: Parameters<typeof model.onChanged>[0]) => model.onChanged(listener),
    })
    const navigator = createSessionsNavigatorNode(source)
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
            title: '检查 Windows 路径',
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
    expect(navigation.rows.some(row => row.selected && row.text.includes('检查 Windows 路径'))).toBe(true)
    expect(navigation.rows.some(row => row.tone === 'success')).toBe(true)
    expect(navigation.cursor).toBeDefined()

    const details = projectSessionDetails(model.snapshot())
    expect(details?.title).toBe('检查 Windows 路径')
    expect(details?.fields.find(field => field.id === 'path')?.value).toBe('D:\\研发\\代理项目')

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
    const inspected = projectSessionDetails(model.snapshot())
    expect(inspected?.fields.find(field => field.id === 'path')?.value).toBe('D:\\研发\\代理项目')
    expect(inspected?.fields.find(field => field.id === 'transcript')?.value).toContain('1 row')
    expect(inspected?.fields.find(field => field.id === 'work')?.value).toContain('1 todo')
    expect(inspected?.fields.find(field => field.id === 'lastActivity')?.value).toContain('正在检查路径')

    expectBoundedPlainText(navigator.project(context(12, 4)), 12, 4)
    model.dispose()
  })
})
