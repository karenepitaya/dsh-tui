import { describe, expect, it } from 'vitest'
import { FormWorkspace } from 'pi-tui-orbs'
import type { FeatureSurfaceRuntimeSnapshot } from '../src/app/feature-surface-runtime.ts'
import type { SessionModeSnapshot } from '../src/mode/port.ts'
import {
  createModesFeatureState,
  transitionModesFeature,
  type ModesFeatureState,
} from '../src/features/modes/index.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'
import {
  modesFormModel,
  modesStateSource,
  renderModesFrame,
} from '../src/ui/modes-frame.ts'

function snapshot(overrides: Partial<SessionModeSnapshot> = {}): SessionModeSnapshot {
  return {
    available: true,
    loading: false,
    selecting: false,
    locked: false,
    current: 'standard',
    presets: [
      { id: 'standard', name: '标准模式', description: '默认平衡模式', trust: 'system', sourcePath: '/fixture/standard.yaml', isDefault: true },
      { id: 'minimal', name: '极简模式', trust: 'system', sourcePath: '/fixture/minimal.yaml', isDefault: false },
    ],
    ...overrides,
  } as SessionModeSnapshot
}

function loaded(overrides: Partial<SessionModeSnapshot> = {}): ModesFeatureState {
  const request = { scopeEpoch: 1, requestId: 1 }
  let state = transitionModesFeature(createModesFeatureState(), {
    type: 'load.started', request,
  }).state
  state = transitionModesFeature(state, {
    type: 'load.succeeded', request, snapshot: snapshot(overrides),
  }).state
  return state
}

const viewport = { columns: 120, rows: 30 }
const modelOf = (state: ModesFeatureState, options: Parameters<typeof modesFormModel>[2] = {}) => (
  modesFormModel(state, viewport, options)
)
const text = (state: ModesFeatureState, options: Parameters<typeof modesFormModel>[2] = {}) => (
  new FormWorkspace(modelOf(state, options)).render(120).join('\n')
)

describe('modes FormWorkspace model', () => {
  it('projects a single-category bounded list with current/default badges and a status line', () => {
    const current = modelOf(loaded())
    expect(current.categories).toEqual([{ id: 'modes', label: 'Modes 2' }])
    expect(current.activeCategoryId).toBe('modes')
    expect(current.focus).toBe('content')
    expect(current.actions).toEqual([])
    expect(current.groups).toEqual([])
    expect(current.searchHidden).toBe(true)
    expect(current.help).toBe('↑↓ select · Enter choose · r refresh · q back')
    expect(current.body?.kind).toBe('list')
    expect(current.body?.items.map(item => [item.label, item.value, item.badge])).toEqual([
      ['标准模式', 'system', 'current/default'],
      ['极简模式', 'system', undefined],
    ])
    expect(current.body?.items[0]?.description).toBe('默认平衡模式')
    expect(current.body?.items[0]?.tone).toBe('success')
    expect(current.message).toBe('Current standard')

    const rendered = text(loaded())
    expect(rendered).toContain('Modes')
    expect(rendered).toContain('标准模式')
    expect(rendered).toContain('q back')
    for (const line of rendered.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(120)
  })

  it('keeps locked, unavailable, selecting and failed states in one status line', () => {
    expect(modelOf(loaded({ locked: true })).message)
      .toBe('Session started · mode locked · /new to choose another · Current standard')
    expect(modelOf(loaded({ locked: true, current: undefined })).message)
      .toBe('Session started · mode locked · /new to choose another')
    expect(modelOf(loaded({ available: false })).message)
      .toBe('Unavailable · DSH AgentPresets is not active')
    const selecting = transitionModesFeature(loaded(), {
      type: 'selection.started', requestId: 3, modeId: 'minimal',
    }).state
    expect(modelOf(selecting).message).toBe('Changing mode…')
    const failed = transitionModesFeature(loaded(), {
      type: 'selection.blocked', message: 'preset rejected',
    }).state
    expect(modelOf(failed).message).toBe('Last operation failed · preset rejected')
    expect(modelOf(failed).messageTone).toBe('error')
  })

  it('keeps honest empty and loading states', () => {
    const empty = modelOf(loaded({ presets: [], current: undefined }))
    expect(empty.body?.items).toEqual([])
    expect(empty.body?.emptyMessage).toBe('No Agent modes available · R retry; check preset settings')
    const loading = modelOf(transitionModesFeature(createModesFeatureState(), {
      type: 'load.started', request: { scopeEpoch: 1, requestId: 1 },
    }).state)
    expect(loading.body?.emptyMessage).toBe('Loading Agent presets…')
  })

  it('switches chrome strings with uiLanguage', () => {
    expect(text(loaded(), { uiLanguage: 'zh' })).toContain('q / Esc 返回')
    expect(modelOf(loaded(), { uiLanguage: 'zh' }).strings).toBeDefined()
    expect(text(loaded(), { uiLanguage: 'en' })).toContain('q / Esc back')
  })
})

describe('modes frame seam', () => {
  const snapshotWith = (node: unknown): FeatureSurfaceRuntimeSnapshot => ({
    host: {
      navigation: { mode: 'normal', route: { kind: 'workspace', featureId: 'modes', pane: 'content' } },
      slots: { contributions: [{
        slotId: 'workspace.content', featureId: 'modes', authority: 'core', contributionId: 'modes.content',
        value: { id: 'modes.content', role: 'content', node },
      }] },
    },
    layout: { placements: [] },
    surfaces: [],
  }) as unknown as FeatureSurfaceRuntimeSnapshot

  it('reads the Feature state source from the content-region node', () => {
    const state = loaded()
    const source = { snapshot: () => state, onChanged: () => () => {} }
    expect(modesStateSource(snapshotWith({ kind: 'modes.content', state: source }))).toBe(source)
    expect(modesStateSource(snapshotWith({ kind: 'other', state: source }))).toBeUndefined()
    expect(modesStateSource(snapshotWith(undefined))).toBeUndefined()
  })

  it('renders the dual path: retained model plus neutral fallback lines', () => {
    const state = loaded()
    const source = { snapshot: () => state, onChanged: () => () => {} }
    const snapshot = snapshotWith({ kind: 'modes.content', state: source })
    const deferred = renderModesFrame(snapshot, viewport, { deferLayout: true })!
    expect(deferred.lines).toEqual([])
    expect(deferred.formWorkspace?.body?.kind).toBe('list')
    const rendered = renderModesFrame(snapshot, viewport, { uiLanguage: 'en' })!
    expect(rendered.title).toBe('Modes')
    expect(rendered.lines.join('\n')).toContain('标准模式')
    expect(rendered.formWorkspace).toBeDefined()
  })
})
