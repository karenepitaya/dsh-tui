import { describe, expect, it, vi } from 'vitest'
import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui'
import type {
  ActiveFeatureSurfaceSnapshot,
  FeatureSurfaceRuntimeSnapshot,
} from '../src/app/feature-surface-runtime.ts'
import {
  contributeToSlot,
  createSlotRegistry,
  type ContributionAuthority,
  type SlotContribution,
} from '../src/layout/slots.ts'
import {
  resolveLayout,
  type LayoutRegion,
  type LayoutPlacement,
  type LayoutRole,
  type LayoutViewport,
} from '../src/layout/strategy.ts'
import {
  createNavigationState,
  transitionNavigation,
  type NavigationRoute,
} from '../src/navigation/state.ts'
import type {
  FeatureSurfaceProjectContext,
  FeatureSurfaceProjection,
  FeatureSurfaceUiNode,
} from '../src/presentation/feature-surface.ts'
import type { ResourceDefinition } from '../src/resource/resource-coordinator.ts'
import {
  createSessionsContentNode,
  createSessionsFeatureModel,
  createSessionsInspectorNode,
  createSessionsNavigatorNode,
} from '../src/features/sessions/index.ts'
import {
  createDiffContentNode,
  createDiffFeatureState,
  createDiffInspectorNode,
} from '../src/features/diff/index.ts'
import { renderFeatureSurfaceFrame } from '../src/ui/feature-surface-frame.ts'
import { renderDshFrame } from '../src/ui/frame.ts'
import { selectSession } from '../src/transcript/reducer.ts'
import { createUiState } from '../src/transcript/state.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import { createDshTuiTheme } from '../src/ui/theme.ts'
import { paintFrameLine } from '../src/terminal/frame-styling.ts'

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

interface TestRegion {
  readonly featureId: string
  readonly region: LayoutRegion
}

function slotFor(role: LayoutRole): string {
  switch (role) {
    case 'timeline': return 'shell.root'
    case 'navigator': return 'workspace.navigator'
    case 'content': return 'workspace.content'
    case 'inspector': return 'workspace.inspector'
    case 'composer': return 'shell.composer'
    case 'status': return 'shell.status'
    case 'overlay': return 'shell.overlay'
  }
}

function authorityFor(role: LayoutRole): ContributionAuthority {
  return role === 'timeline' || role === 'composer' ? 'core' : 'extension'
}

function runtimeSnapshot(
  route: NavigationRoute,
  viewport: LayoutViewport,
  entries: readonly TestRegion[],
  surfaces: readonly ActiveFeatureSurfaceSnapshot[] = [],
): FeatureSurfaceRuntimeSnapshot {
  let slots = createSlotRegistry<LayoutRegion>()
  for (const entry of entries) {
    const contribution: SlotContribution<LayoutRegion> = {
      slotId: slotFor(entry.region.role),
      featureId: entry.featureId,
      authority: authorityFor(entry.region.role),
      contributionId: entry.region.id,
      value: entry.region,
    }
    slots = contributeToSlot(slots, contribution)
  }
  const navigation = route.kind === 'chat'
    ? createNavigationState()
    : transitionNavigation(createNavigationState(), { type: 'navigate', route }).state
  const routeFeatureId = route.kind === 'chat'
    ? entries.find(entry => entry.region.role === 'timeline')?.featureId ?? 'chat'
    : route.featureId
  const host = Object.freeze({
    navigation,
    routes: Object.freeze([{ id: 'active', featureId: routeFeatureId, route }]),
    commands: Object.freeze([]),
    resources: Object.freeze([]),
    slots,
    regions: Object.freeze(entries.map(entry => entry.region)),
    issues: Object.freeze([]),
  })
  return Object.freeze({
    host,
    layout: resolveLayout(viewport, route, entries.map(entry => entry.region)),
    surfaces: Object.freeze([...surfaces]),
  })
}

function node(
  project: (context: FeatureSurfaceProjectContext) => FeatureSurfaceProjection,
): FeatureSurfaceUiNode {
  return Object.freeze({
    kind: 'test.surface',
    project,
    onChanged: () => () => {},
  })
}

function region(
  id: string,
  role: LayoutRole,
  surfaceNode: unknown,
): LayoutRegion {
  return Object.freeze({ id, role, node: surfaceNode })
}

function row(
  text: string,
  tone: FeatureSurfaceProjection['rows'][number]['tone'] = 'default',
  selected = false,
): FeatureSurfaceProjection['rows'][number] {
  return Object.freeze({ text, tone, bold: false, dim: false, selected })
}

function withPlacements(
  snapshot: FeatureSurfaceRuntimeSnapshot,
  placements: readonly LayoutPlacement[],
): FeatureSurfaceRuntimeSnapshot {
  return Object.freeze({
    ...snapshot,
    layout: Object.freeze({
      ...snapshot.layout,
      placements: Object.freeze([...placements]),
    }),
  })
}

function placement(
  surfaceRegion: LayoutRegion,
  bounds: LayoutPlacement['bounds'],
): LayoutPlacement {
  return Object.freeze({
    region: surfaceRegion,
    area: surfaceRegion.role,
    columns: bounds.width,
    bounds: Object.freeze(bounds),
  })
}

describe('Feature Surface UiFrame compositor', () => {
  it('uses the focused surface title without treating every Insert mode as a search', () => {
    const titled = node(context => ({
      rows: [row('BODY')],
      title: context.focus ? '\u001b[31mPreferences\u001b[0m' : 'Background title',
    }))
    const viewport = { columns: 120, rows: 6 }
    const entries = [
      { featureId: 'settings', region: region('nav', 'navigator', titled) },
      { featureId: 'settings', region: region('body', 'content', titled) },
    ]
    const base = runtimeSnapshot({ kind: 'workspace', featureId: 'settings', pane: 'content' }, viewport, entries)
    for (const mode of ['normal', 'insert'] as const) {
      const snapshot = { ...base, host: { ...base.host, navigation: transitionNavigation(base.host.navigation, { type: 'set-mode', mode }).state } }
      const frame = renderFeatureSurfaceFrame(snapshot, viewport)
      expect(frame.lines[0]?.trim()).toBe('PREFERENCES')
      expect(frame.lines[0]).not.toMatch(CONTROL_CHARACTERS)
      expect(frame.lines[0]).not.toContain('Searching')
    }
    const shortViewport = { columns: 120, rows: 2 }
    const short = renderFeatureSurfaceFrame(runtimeSnapshot(base.host.navigation.route, shortViewport, entries), shortViewport)
    expect(short.lines[0]).toContain('BODY')
    expect(short.lines[0]).not.toContain('PREFERENCES')
    const chat = renderFeatureSurfaceFrame(runtimeSnapshot({ kind: 'chat' }, viewport,
      [{ featureId: 'chat', region: region('chat', 'timeline', titled) }]), viewport)
    expect(chat.lines[0]).toContain('BODY')
    expect(chat.lines[0]).not.toContain('PREFERENCES')
  })

  it('keeps the feature fallback title for missing or non-text projection titles', () => {
    const viewport = { columns: 80, rows: 5 }
    for (const title of [undefined, 42]) {
      const projected = node((() => ({ rows: [row('BODY')], title })) as never)
      const base = runtimeSnapshot({ kind: 'workspace', featureId: 'example', pane: 'content' }, viewport,
        [{ featureId: 'example', region: region('body', 'content', projected) }])
      const snapshot = { ...base, host: { ...base.host, navigation: transitionNavigation(base.host.navigation, { type: 'set-mode', mode: 'insert' }).state } }
      expect(renderFeatureSurfaceFrame(snapshot, viewport).lines[0]?.trim()).toBe('EXAMPLE')
    }
  })

  it('advertises search only when the active feature exposes an edit command', () => {
    const viewport = { columns: 80, rows: 5 }
    const base = runtimeSnapshot({ kind: 'workspace', featureId: 'example', pane: 'content' }, viewport, [])
    for (const [featureId, id, searchable] of [
      ['foreign', 'edit.insert', false],
      ['example', 'navigation.activate', false],
      ['example', 'edit.insert', true],
    ] as const) {
      const snapshot = { ...base, host: { ...base.host, commands: [{ featureId, id, handler: { handle: vi.fn() } }] } }
      const footer = renderFeatureSurfaceFrame(snapshot, viewport).lines.at(-1)!
      expect(footer.includes('/ search')).toBe(searchable)
    }
  })

  it('fills Workspace gutters and empty rows, distinguishes inactive selection, and leaves Chat transparent', () => {
    const selected = node(context => ({ rows: [row('› selected', 'accent', true)], actionHint: context.focus ? 'Enter open · r refresh' : 'inactive actions' }))
    const entries = [
      { featureId: 'workspace', region: region('nav', 'navigator', selected) },
      { featureId: 'workspace', region: region('body', 'content', selected) },
    ]
    const snapshot = runtimeSnapshot({ kind: 'workspace', featureId: 'workspace', pane: 'content' }, { columns: 120, rows: 6 }, entries)
    const frame = renderFeatureSurfaceFrame(snapshot, { columns: 120, rows: 6 })
    expect(frame.lines[0]?.trim()).toBe('WORKSPACE')
    expect(frame.lines.at(-1)).toContain('Enter open · r refresh')
    expect(frame.lines.at(-1)).not.toContain('inactive actions')
    expect(frame.lines.at(-1)).toContain('Esc back')
    expect(frame.lines.at(-1)).not.toContain('search')
    expect(frame.styleSpans?.every(spans => spans[0]?.style.backgroundRole === 'panelBackground')).toBe(true)
    expect(frame.styleSpans?.[1]?.[1]?.style).toMatchObject({ backgroundRole: 'inactiveSelectionBackground', tone: 'primary' })
    expect(frame.styleSpans?.[1]?.[1]?.style.bold).toBeUndefined()
    expect(frame.styleSpans?.[1]?.[2]?.style).toMatchObject({ backgroundRole: 'selectionBackground', bold: true })
    for (const level of ['truecolor', 'ansi256', 'ansi16', 'mono'] as const) {
      const theme = createDshTuiTheme({}, { colorSupported: level !== 'mono', colorLevel: level, noColor: level === 'mono', dumbTerminal: false })
      const painted = paintFrameLine(frame.lines[1]!, 120, theme, undefined, frame.styleSpans?.[1])
      expect(painted).toContain('› selected')
      if (level === 'mono') {
        expect(painted).not.toMatch(/\u001b\[(?:38|48);/u)
        expect(painted).toContain('\u001b[1m')
      }
    }
    const chat = renderFeatureSurfaceFrame(runtimeSnapshot({ kind: 'chat' }, { columns: 120, rows: 6 }, []), { columns: 120, rows: 6 })
    expect(chat.styleSpans).toBeUndefined()
  })
  it('routes secondary projections through the product frame while Chat keeps its retained timeline', () => {
    const viewport = { columns: 80, rows: 15 }
    const secondary = runtimeSnapshot({ kind: 'workspace', featureId: 'test', pane: 'content' }, viewport, [])
    for (const ui of [createUiState(), selectSession(createUiState(), 'session-a')]) {
      const frame = renderDshFrame({ ui, interaction: undefined, prompt: createPromptEditorState(), featureSurface: secondary }, viewport)
      expect(frame.title).toBe(`DSH-TUI · ${ui.activeSessionId ?? 'no-session'}`)
      expect(frame.conversation).toBeUndefined()
    }
    const chat = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'), interaction: undefined,
      prompt: createPromptEditorState(),
      featureSurface: runtimeSnapshot({ kind: 'chat' }, viewport, []),
    }, viewport)
    expect(chat.conversation).toBeDefined()
  })
  it('projects opaque nodes into exact wide-pane bounds with focused resources and cursor', () => {
    const contexts: FeatureSurfaceProjectContext[] = []
    const navigator = node((context) => {
      contexts.push(context)
      return { rows: [row('NAV 导航', 'accent', true)], cursor: { row: 0, column: 1 } }
    })
    let kindReads = 0
    const content = Object.freeze({
      get kind() {
        kindReads += 1
        throw new Error('kind is diagnostic only')
      },
      project(context: FeatureSurfaceProjectContext) {
        contexts.push(context)
        return {
          rows: [
            row('C:\\项目\\src\\入口.ts', 'added'),
            row('\u001b[31m删除内容\u001b[0m', 'removed'),
          ],
          cursor: { row: 0, column: 3 },
        }
      },
      onChanged: () => () => {},
    }) as unknown as FeatureSurfaceUiNode
    const inspector = node((context) => {
      contexts.push(context)
      return { rows: [row('INSPECT', 'muted')] }
    })
    const entries = [
      { featureId: 'workspace', region: region('workspace.navigator', 'navigator', navigator) },
      { featureId: 'workspace', region: region('workspace.content', 'content', content) },
      { featureId: 'workspace', region: region('workspace.inspector', 'inspector', inspector) },
    ] as const
    const resourceDefinition: ResourceDefinition<unknown> = {
      key: 'workspace.catalog',
      lifetime: 'surface',
      activation: 'on-open',
      cachePolicy: 'last-good',
      load: () => undefined,
    }
    const snapshot = runtimeSnapshot(
      { kind: 'workspace', featureId: 'workspace', pane: 'content' },
      { columns: 160, rows: 4 },
      entries,
      [{
        featureId: 'workspace',
        open: true,
        visible: true,
        scopeEpoch: 7,
        resources: [{
          id: 'workspace.catalog',
          definition: resourceDefinition,
          state: {
            phase: 'ready',
            requestId: 2,
            scopeEpoch: 7,
            value: { cwd: 'D:\\研发' },
            lastGood: { cwd: 'D:\\研发' },
          },
        }],
      }],
    )

    const frame = renderFeatureSurfaceFrame(
      snapshot,
      { columns: 160, rows: 4 },
      '\u001b]0;bad\u0007DSH\nWorkspace',
    )
    const [navPlacement, contentPlacement, inspectorPlacement] = snapshot.layout.placements

    expect(kindReads).toBe(0)
    expect(contexts.map(context => context.bounds)).toEqual(
      snapshot.layout.placements.map(placement => placement.bounds),
    )
    expect(contexts.map(context => context.focus)).toEqual([false, true, false])
    expect(contexts[1]?.mode).toBe('normal')
    expect(contexts[1]?.resources).toEqual([{
      id: 'workspace.catalog',
      phase: 'ready',
      value: { cwd: 'D:\\研发' },
      lastGood: { cwd: 'D:\\研发' },
    }])
    expect(sliceByColumn(frame.lines[1]!, navPlacement!.bounds.x, 12, true)).toContain('NAV 导航')
    expect(sliceByColumn(frame.lines[1]!, contentPlacement!.bounds.x, 24, true))
      .toContain('C:\\项目\\src\\入口.ts')
    expect(sliceByColumn(frame.lines[1]!, inspectorPlacement!.bounds.x, 12, true))
      .toContain('INSPECT')
    expect(frame.cursor).toEqual({
      row: contentPlacement!.bounds.y,
      column: contentPlacement!.bounds.x + 3,
    })
    expect(frame.lineStyles?.[1]).toMatchObject({ tone: 'success' })
    expect(frame.lineStyles?.[2]).toMatchObject({ tone: 'error' })
    expect(frame.styleSpans?.[1]).toEqual([
      expect.objectContaining({ column: 0, width: 160, style: expect.objectContaining({ backgroundRole: 'panelBackground' }) }),
      expect.objectContaining({ column: navPlacement!.bounds.x, width: navPlacement!.bounds.width }),
      expect.objectContaining({ column: contentPlacement!.bounds.x, width: contentPlacement!.bounds.width, style: expect.objectContaining({ tone: 'success' }) }),
      expect.objectContaining({ column: inspectorPlacement!.bounds.x, width: inspectorPlacement!.bounds.width, style: expect.objectContaining({ tone: 'muted' }) }),
    ])
    expect(frame.title).toBe('DSH Workspace')
    expect(frame.lines).toHaveLength(4)
    for (const line of frame.lines) {
      expect(line).not.toMatch(CONTROL_CHARACTERS)
      expect(visibleWidth(line)).toBe(160)
    }
  })

  it('maps every semantic tone and selected state on a narrow single-page surface', () => {
    const tones = [
      'default',
      'muted',
      'accent',
      'info',
      'success',
      'warning',
      'danger',
      'added',
      'removed',
    ] as const
    const surface = node(() => ({
      rows: tones.map((tone, index) => row(
        index === 0 ? 'D:\\项目\\会话' : tone,
        tone,
        index === 2,
      )),
      cursor: { row: 0, column: 6 },
    }))
    const snapshot = runtimeSnapshot(
      { kind: 'workspace', featureId: 'workspace', pane: 'content' },
      { columns: 80, rows: 11 },
      [{ featureId: 'workspace', region: region('workspace.content', 'content', surface) }],
    )

    const frame = renderFeatureSurfaceFrame(snapshot, { columns: 80, rows: 11 }, 'Workspace')

    expect(frame.lineStyles?.slice(1, -1).map(style => style?.tone)).toEqual([
      'primary',
      'muted',
      'accent',
      'telemetry',
      'success',
      'warning',
      'error',
      'success',
      'error',
    ])
    expect(frame.lineStyles?.[3]).toMatchObject({ backgroundRole: 'selectionBackground', fill: true })
    expect(frame.cursor).toEqual({ row: 1, column: 6 })
    expect(frame.lines[1]).toContain('D:\\项目\\会话')
  })

  it.each([
    { columns: 80, breakpoint: 'narrow' as const },
    { columns: 120, breakpoint: 'standard' as const },
  ])('renders the active region and only shows its sibling when width permits at $breakpoint', ({ columns, breakpoint }) => {
    const contentProject = vi.fn(() => ({ rows: [row('CONTENT')] }))
    const inspectorProject = vi.fn(() => ({ rows: [row('INSPECTOR')] }))
    const entries = [
      { featureId: 'workspace', region: region('workspace.content', 'content', node(contentProject)) },
      { featureId: 'workspace', region: region('workspace.inspector', 'inspector', node(inspectorProject)) },
    ] as const
    const snapshot = runtimeSnapshot(
      { kind: 'workspace', featureId: 'workspace', pane: 'inspector' },
      { columns, rows: 5 },
      entries,
    )

    const frame = renderFeatureSurfaceFrame(snapshot, { columns, rows: 5 }, 'Workspace')

    expect(snapshot.layout.breakpoint).toBe(breakpoint)
    expect(contentProject).toHaveBeenCalledTimes(breakpoint === 'narrow' ? 0 : 1)
    expect(inspectorProject).toHaveBeenCalledOnce()
    expect(frame.lines.join('\n')).toContain('INSPECTOR')
    if (breakpoint === 'narrow') expect(frame.lines.join('\n')).not.toContain('CONTENT')
    else expect(frame.lines.join('\n')).toContain('CONTENT')
    expect(frame.lines.every(line => visibleWidth(line) === columns)).toBe(true)
  })

  it('contains throwing and invalid nodes while ignoring nodes without project()', () => {
    const healthy = node(() => ({ rows: [row('NAV STILL READY', 'success')] }))
    const throwing = node(() => { throw new Error('\u001b[31mbroken\u001b[0m\nloader') })
    const invalid = Object.freeze({ kind: 'invalid', project: 42, onChanged: () => () => {} })
    const legacy = Object.freeze({ kind: 'legacy.status' })
    const entries = [
      { featureId: 'workspace', region: region('workspace.navigator', 'navigator', healthy) },
      { featureId: 'workspace', region: region('workspace.content', 'content', throwing) },
      { featureId: 'workspace', region: region('workspace.inspector', 'inspector', invalid) },
      { featureId: 'legacy', region: region('legacy.status', 'status', legacy) },
    ] as const
    const snapshot = runtimeSnapshot(
      { kind: 'workspace', featureId: 'workspace', pane: 'content' },
      { columns: 160, rows: 4 },
      entries,
    )

    const frame = renderFeatureSurfaceFrame(snapshot, { columns: 160, rows: 4 }, 'Workspace')
    const [navigator, content, inspector] = snapshot.layout.placements

    expect(sliceByColumn(frame.lines[1]!, navigator!.bounds.x, navigator!.bounds.width, true))
      .toContain('NAV STILL READY')
    expect(sliceByColumn(frame.lines[1]!, content!.bounds.x, content!.bounds.width, true))
      .toContain('SURFACE ERROR')
    expect(sliceByColumn(frame.lines[1]!, inspector!.bounds.x, inspector!.bounds.width, true))
      .toContain('SURFACE ERROR')
    expect(frame.lines.at(-1)).toContain('Esc back')
    expect(frame.lines.join('')).not.toMatch(CONTROL_CHARACTERS)
    expect(frame.lineStyles?.[1]).toMatchObject({ tone: 'error', bold: true })
  })

  it('keeps Sessions and Diff nodes structural at the compositor boundary', () => {
    const sessionsModel = createSessionsFeatureModel()
    const sessionsSource = Object.freeze({
      snapshot: () => sessionsModel.snapshot(),
      onChanged: (listener: Parameters<typeof sessionsModel.onChanged>[0]) => (
        sessionsModel.onChanged(listener)
      ),
    })
    const sessions = runtimeSnapshot(
      { kind: 'workspace', featureId: 'sessions', pane: 'content' },
      { columns: 160, rows: 8 },
      [
        {
          featureId: 'sessions',
          region: region('sessions.navigator', 'navigator', createSessionsNavigatorNode(sessionsSource)),
        },
        {
          featureId: 'sessions',
          region: region('sessions.content', 'content', createSessionsContentNode(sessionsSource)),
        },
        {
          featureId: 'sessions',
          region: region('sessions.inspector', 'inspector', createSessionsInspectorNode(sessionsSource)),
        },
      ],
    )
    const sessionsFrame = renderFeatureSurfaceFrame(
      sessions,
      { columns: 160, rows: 8 },
      'Sessions',
    )
    expect(sessionsFrame.lines.join('\n')).toContain('SESSIONS')
    expect(sessionsFrame.lines.join('\n')).toContain('0/0 matching')
    expect(sessionsFrame.lines.join('\n')).toContain('Select a session to inspect')
    expect(sessionsFrame.lines.join('\n')).toContain('Press Enter on a session to inspect it')
    expect(sessionsFrame.lines.join('\n')).not.toContain('SURFACE ERROR')

    const diffState = createDiffFeatureState()
    const diffSource = Object.freeze({
      snapshot: () => diffState,
      onChanged: () => () => {},
    })
    const diff = runtimeSnapshot(
      { kind: 'diff', featureId: 'diff', pane: 'content' },
      { columns: 160, rows: 8 },
      [
        {
          featureId: 'diff',
          region: region('diff.content', 'content', createDiffContentNode('diff.content', diffSource)),
        },
        {
          featureId: 'diff',
          region: region('diff.inspector', 'inspector', createDiffInspectorNode('diff.content', diffSource)),
        },
      ],
    )
    const diffFrame = renderFeatureSurfaceFrame(diff, { columns: 160, rows: 8 }, 'Diff')
    expect(diffFrame.lines.join('\n')).toContain('DIFF')
    expect(diffFrame.lines.join('\n')).toContain('No diff selected')
    expect(diffFrame.lines.join('\n')).not.toContain('SURFACE ERROR')
    sessionsModel.dispose()
  })

  it('resolves chat composer, feature, and top overlay focus without reading node kinds', () => {
    const insertContexts: FeatureSurfaceProjectContext[] = []
    const timeline = node((context) => {
      insertContexts.push(context)
      return { rows: [row('TIMELINE')], cursor: { row: 0, column: 1 } }
    })
    const composer = node((context) => {
      insertContexts.push(context)
      return { rows: [row('COMPOSER')], cursor: { row: 0, column: 2 } }
    })
    const chat = runtimeSnapshot(
      { kind: 'chat' },
      { columns: 120, rows: 2 },
      [
        { featureId: 'legacy.chat', region: region('chat.timeline', 'timeline', timeline) },
        { featureId: 'legacy.chat', region: region('chat.composer', 'composer', composer) },
      ],
    )
    const insert = renderFeatureSurfaceFrame(chat, { columns: 120, rows: 2 })
    expect(insertContexts.map(context => context.focus)).toEqual([false, true])
    expect(insert.cursor).toEqual({ row: 1, column: 2 })

    insertContexts.length = 0
    const normalNavigation = transitionNavigation(chat.host.navigation, {
      type: 'set-mode',
      mode: 'normal',
    }).state
    const normal = Object.freeze({
      ...chat,
      host: Object.freeze({ ...chat.host, navigation: normalNavigation }),
    })
    const normalFrame = renderFeatureSurfaceFrame(normal, { columns: 120, rows: 2 })
    expect(insertContexts.map(context => context.focus)).toEqual([true, false])
    expect(normalFrame.cursor).toEqual({ row: 0, column: 1 })

    const overlayContexts: FeatureSurfaceProjectContext[] = []
    const overlayNode = (label: string) => node((context) => {
      overlayContexts.push(context)
      return { rows: [row(label)], cursor: { row: 0, column: 0 } }
    })
    const overlayBase = runtimeSnapshot(
      { kind: 'chat' },
      { columns: 120, rows: 2 },
      [
        { featureId: 'legacy.chat', region: region('overlay.timeline', 'timeline', timeline) },
        { featureId: 'other', region: region('other.overlay', 'overlay', overlayNode('OTHER')) },
        { featureId: 'question', region: region('question.first', 'overlay', overlayNode('FIRST')) },
        { featureId: 'question', region: region('question.second', 'overlay', overlayNode('SECOND')) },
      ],
      [{
        featureId: 'question',
        open: true,
        visible: true,
        scopeEpoch: 1,
        resources: [{
          id: 'question.answer',
          definition: {
            key: 'question.answer',
            lifetime: 'surface',
            activation: 'on-open',
            cachePolicy: 'last-good',
            load: () => undefined,
          },
          state: {
            phase: 'failed',
            requestId: 1,
            scopeEpoch: 1,
            error: 'unavailable',
          },
        }],
      }],
    )
    const overlayNavigation = transitionNavigation(overlayBase.host.navigation, {
      type: 'push-overlay',
      overlay: { id: 'question', kind: 'custom', featureId: 'question' },
    }).state
    const overlaySnapshot = Object.freeze({
      ...overlayBase,
      host: Object.freeze({ ...overlayBase.host, navigation: overlayNavigation }),
    })
    const overlay = renderFeatureSurfaceFrame(
      overlaySnapshot,
      { columns: 120, rows: 2 },
      'Overlay',
    )
    expect(overlayContexts.map(context => context.focus)).toEqual([false, false, true])
    expect(overlayContexts[2]?.resources).toEqual([{
      id: 'question.answer',
      phase: 'failed',
      error: 'unavailable',
    }])
    expect(overlay.lines[0]).toContain('SECOND')
    expect(overlay.lines[0]).not.toContain('TIMELINE')
    expect(overlay.cursor).toEqual({ row: 0, column: 0 })
  })

  it('normalizes the canvas and skips non-renderable placement bounds', () => {
    const project = vi.fn(() => ({ rows: [row('SHOULD NOT RENDER')] }))
    const surfaceRegion = region('workspace.content', 'content', node(project))
    const base = runtimeSnapshot(
      { kind: 'workspace', featureId: 'workspace', pane: 'content' },
      { columns: 80, rows: 5 },
      [{ featureId: 'workspace', region: surfaceRegion }],
    )
    const invalid = withPlacements(base, [
      placement(surfaceRegion, { x: Number.NaN, y: 0, width: 1, height: 1 }),
      placement(surfaceRegion, { x: 1, y: 0, width: 1, height: 1 }),
      placement(surfaceRegion, { x: 0, y: 0, width: 0, height: 1 }),
    ])

    const frame = renderFeatureSurfaceFrame(
      invalid,
      { columns: Number.NaN, rows: Number.NEGATIVE_INFINITY },
    )

    expect(frame).toMatchObject({
      title: 'DSH-TUI',
      viewport: { columns: 1, rows: 1 },
      lines: [' '],
    })
    expect(project).not.toHaveBeenCalled()
  })

  it('falls back to stable region identity and gives unowned callable nodes empty resources', () => {
    const contexts: FeatureSurfaceProjectContext[] = []
    const callable = Object.assign(function callableNode() {}, {
      project(context: FeatureSurfaceProjectContext) {
        contexts.push(context)
        return { rows: [row('CALLABLE')] }
      },
    })
    const owned = region('workspace.content', 'content', node(() => ({ rows: [row('ORIGINAL')] })))
    const base = runtimeSnapshot(
      { kind: 'workspace', featureId: 'workspace', pane: 'content' },
      { columns: 80, rows: 3 },
      [{ featureId: 'workspace', region: owned }],
    )
    const cloned = region('workspace.content', 'content', callable)
    const unowned = region('unknown.inspector', 'inspector', callable)
    const snapshot = withPlacements(base, [
      placement(cloned, { x: 0, y: 0, width: 40, height: 3 }),
      placement(unowned, { x: 40, y: 0, width: 40, height: 3 }),
    ])

    const frame = renderFeatureSurfaceFrame(snapshot, { columns: 80, rows: 3 }, 'Callable')

    expect(contexts.map(context => context.focus)).toEqual([true, false])
    expect(contexts.map(context => context.resources)).toEqual([[], []])
    expect(frame.lines[0]).toContain('CALLABLE')
  })

  it('turns every malformed projection boundary into a safe error row', () => {
    const valid = row('valid')
    const malformed: readonly (() => unknown)[] = [
      () => null,
      () => ({}),
      () => ({ rows: [null] }),
      () => ({ rows: [{ ...valid, text: 1 }] }),
      () => ({ rows: [{ ...valid, tone: 1 }] }),
      () => ({ rows: [{ ...valid, tone: 'unknown' }] }),
      () => ({ rows: [{ ...valid, bold: 1 }] }),
      () => ({ rows: [{ ...valid, dim: 1 }] }),
      () => ({ rows: [{ ...valid, selected: 1 }] }),
      () => ({ rows: [valid], cursor: null }),
      () => ({ rows: [valid], cursor: { row: '0', column: 0 } }),
      () => ({ rows: [valid], cursor: { row: Number.NaN, column: 0 } }),
      () => ({ rows: [valid], cursor: { row: 0, column: '0' } }),
      () => ({ rows: [valid], cursor: { row: 0, column: Number.NaN } }),
      () => ({ rows: [valid], cursor: { row: -1, column: 0 } }),
      () => ({ rows: [valid], cursor: { row: 1, column: 0 } }),
      () => ({ rows: [valid], cursor: { row: 0, column: -1 } }),
      () => ({ rows: [valid], cursor: { row: 0, column: 81 } }),
    ]
    for (const project of malformed) {
      const snapshot = runtimeSnapshot(
        { kind: 'workspace', featureId: 'workspace', pane: 'content' },
        { columns: 80, rows: 2 },
        [{ featureId: 'workspace', region: region('malformed', 'content', node(project as never)) }],
      )
      const frame = renderFeatureSurfaceFrame(snapshot, { columns: 80, rows: 2 }, 'Malformed')
      expect(frame.lines[0]).toContain('SURFACE ERROR')
    }

    const accessor = Object.freeze(Object.defineProperty({}, 'project', {
      get() { throw 'getter failed' },
    }))
    const coercionFailure = {
      project() {
        throw Object.freeze({
          [Symbol.toPrimitive]() { throw new Error('cannot stringify') },
        })
      },
    }
    for (const invalidNode of [accessor, coercionFailure]) {
      const snapshot = runtimeSnapshot(
        { kind: 'workspace', featureId: 'workspace', pane: 'content' },
        { columns: 80, rows: 2 },
        [{ featureId: 'workspace', region: region('throwing', 'content', invalidNode) }],
      )
      const frame = renderFeatureSurfaceFrame(snapshot, { columns: 80, rows: 2 }, 'Throwing')
      expect(frame.lines[0]).toContain('SURFACE ERROR')
    }

    const primitive = runtimeSnapshot(
      { kind: 'workspace', featureId: 'workspace', pane: 'content' },
      { columns: 80, rows: 2 },
      [{ featureId: 'workspace', region: region('primitive', 'content', 7) }],
    )
    const primitiveFrame = renderFeatureSurfaceFrame(primitive, { columns: 80, rows: 2 })
    expect(primitiveFrame.lines[0]).toContain('SURFACE ERROR')
    expect(primitiveFrame.lineStyles?.[0]).toMatchObject({ tone: 'error' })
  })

  it('preserves bold/dim semantics and clamps a right-edge cursor', () => {
    const styled = node(() => ({
      rows: [
        { ...row('bold'), bold: true },
        { ...row('dim'), dim: true },
        { ...row('selected'), selected: true },
      ],
      cursor: { row: 0, column: 80 },
    }))
    const snapshot = runtimeSnapshot(
      { kind: 'workspace', featureId: 'workspace', pane: 'content' },
      { columns: 80, rows: 5 },
      [{ featureId: 'workspace', region: region('styled', 'content', styled) }],
    )

    const frame = renderFeatureSurfaceFrame(snapshot, { columns: 80, rows: 5 }, 'Styled')

    expect(frame.lineStyles?.[1]).toMatchObject({ tone: 'primary', bold: true })
    expect(frame.lineStyles?.[2]).toMatchObject({ tone: 'primary', dim: true })
    expect(frame.lineStyles?.[3]).toMatchObject({ tone: 'primary', backgroundRole: 'selectionBackground', fill: true })
    expect(frame.cursor).toEqual({ row: 1, column: 79 })

    const overlayNode = node(() => ({
      rows: [row('OVERLAY')],
      cursor: { row: 0, column: 0 },
    }))
    const split = withPlacements(snapshot, [
      placement(region('split.content', 'content', node(() => ({
        rows: [row('CONTENT')],
        cursor: { row: 0, column: 0 },
      }))), {
        x: 0, y: 0, width: 40, height: 3,
      }),
      placement(region('split.overlay', 'overlay', overlayNode), {
        x: 40, y: 0, width: 40, height: 3,
      }),
    ])
    expect(renderFeatureSurfaceFrame(split, { columns: 80, rows: 3 }).cursor)
      .toEqual({ row: 0, column: 40 })
  })
})
