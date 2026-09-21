import { describe, expect, it } from 'vitest'
import { FormWorkspace } from 'pi-tui-orbs'
import type { FeatureSurfaceRuntimeSnapshot } from '../src/app/feature-surface-runtime.ts'
import type { SessionModelSnapshot } from '../src/model/port.ts'
import {
  createModelsFeatureState,
  transitionModelsFeature,
  type ModelsFeatureState,
} from '../src/features/models/index.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'
import {
  modelsFormModel,
  modelsStateSource,
  renderModelsFrame,
} from '../src/ui/models-frame.ts'

function snapshot(overrides: Partial<SessionModelSnapshot> = {}): SessionModelSnapshot {
  return {
    routable: true,
    writable: true,
    loading: false,
    selecting: false,
    current: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' },
    failures: [],
    groups: [{
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { provider: 'deepseek', providerName: 'DeepSeek', id: 'deepseek-chat', name: 'DeepSeek Chat', efforts: ['low', 'high'] },
        { provider: 'deepseek', providerName: 'DeepSeek', id: 'deepseek-pro', name: 'DeepSeek Pro', efforts: [] },
      ],
    }],
    ...overrides,
  } as SessionModelSnapshot
}

function loaded(overrides: Partial<SessionModelSnapshot> = {}): ModelsFeatureState {
  const request = { scopeEpoch: 1, requestId: 1 }
  let state = transitionModelsFeature(createModelsFeatureState(), {
    type: 'load.started', request,
  }).state
  state = transitionModelsFeature(state, {
    type: 'load.succeeded', request, snapshot: snapshot(overrides),
  }).state
  return state
}

const viewport = { columns: 120, rows: 30 }
const modelOf = (state: ModelsFeatureState, options: Parameters<typeof modelsFormModel>[2] = {}) => (
  modelsFormModel(state, viewport, options)
)
const text = (state: ModelsFeatureState, options: Parameters<typeof modelsFormModel>[2] = {}) => (
  new FormWorkspace(modelOf(state, options)).render(120).join('\n')
)

describe('models FormWorkspace model', () => {
  it('projects a single-category bounded list with current/default badges and a status line', () => {
    const current = modelOf(loaded())
    expect(current.categories).toEqual([{ id: 'models', label: 'Models 2' }])
    expect(current.activeCategoryId).toBe('models')
    expect(current.focus).toBe('content')
    expect(current.actions).toEqual([])
    expect(current.groups).toEqual([])
    expect(current.searchHidden).toBe(true)
    expect(current.help).toBe('↑↓ select · ←→ reasoning · Enter apply · Ctrl+S default · r refresh · q back')
    expect(current.strings).toBeUndefined()
    expect(current.body?.kind).toBe('list')
    expect(current.body?.items.map(item => [item.label, item.value, item.badge])).toEqual([
      ['DeepSeek Chat', 'DeepSeek', 'current/retained'],
      ['DeepSeek Pro', 'DeepSeek', undefined],
    ])
    expect(current.message).toBe('Current deepseek / deepseek-chat · low')

    const rendered = text(loaded())
    expect(rendered).toContain('Models')
    expect(rendered).toContain('DeepSeek Chat')
    expect(rendered).toContain('q back')
    for (const line of rendered.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(120)
  })

  it('carries reasoning meta, provider failures and busy/read-only states in one status line', () => {
    const withEffort = modelOf(loaded())
    expect(withEffort.body?.items[0]?.description).toBe('Reasoning low')
    expect(withEffort.body?.items[1]?.description).toBeUndefined()

    const failed = transitionModelsFeature(loaded(), { type: 'selection.blocked', message: 'denied' }).state
    expect(modelOf(failed).message).toBe('Last operation failed · denied')
    expect(modelOf(failed).messageTone).toBe('error')

    const readOnly = modelOf(loaded({ writable: false }))
    expect(readOnly.message).toBe('Read-only · this Agent is owned by another Host')
    const busy = modelOf(loaded(), {})
    expect(busy.message).toContain('Current deepseek / deepseek-chat')
    const selecting = transitionModelsFeature(loaded(), {
      type: 'selection.started', requestId: 9,
      selection: { provider: 'deepseek', model: 'deepseek-pro' },
    }).state
    expect(modelOf(selecting).message).toBe('Applying model…')
    const failures = modelOf(loaded({ failures: [{ provider: 'openai', message: 'offline' }] }))
    expect(failures.message).toBe('openai · offline')
  })

  it('keeps honest empty and loading states', () => {
    const idle = modelOf(createModelsFeatureState())
    expect(idle.body?.items).toEqual([])
    expect(idle.body?.emptyMessage).toBe('No models available · R retry; check provider settings')
    const loading = modelOf(transitionModelsFeature(createModelsFeatureState(), {
      type: 'load.started', request: { scopeEpoch: 1, requestId: 1 },
    }).state)
    expect(loading.body?.emptyMessage).toBe('Loading provider model catalogs…')
  })

  it('switches chrome strings with uiLanguage', () => {
    expect(text(loaded(), { uiLanguage: 'zh' })).toContain('q / Esc 返回')
    expect(modelOf(loaded(), { uiLanguage: 'zh' }).strings).toBeDefined()
    expect(text(loaded(), { uiLanguage: 'en' })).toContain('q / Esc back')
  })
})

describe('models frame seam', () => {
  const snapshotWith = (node: unknown): FeatureSurfaceRuntimeSnapshot => ({
    host: {
      navigation: { mode: 'normal', route: { kind: 'workspace', featureId: 'models', pane: 'content' } },
      slots: { contributions: [{
        slotId: 'workspace.content', featureId: 'models', authority: 'core', contributionId: 'models.content',
        value: { id: 'models.content', role: 'content', node },
      }] },
    },
    layout: { placements: [] },
    surfaces: [],
  }) as unknown as FeatureSurfaceRuntimeSnapshot

  it('reads the Feature state source from the content-region node', () => {
    const state = loaded()
    const source = { snapshot: () => state, onChanged: () => () => {} }
    expect(modelsStateSource(snapshotWith({ kind: 'models.content', state: source }))).toBe(source)
    expect(modelsStateSource(snapshotWith({ kind: 'other', state: source }))).toBeUndefined()
    expect(modelsStateSource(snapshotWith(undefined))).toBeUndefined()
  })

  it('renders the dual path: retained model plus neutral fallback lines', () => {
    const state = loaded()
    const source = { snapshot: () => state, onChanged: () => () => {} }
    const snapshot = snapshotWith({ kind: 'models.content', state: source })
    const deferred = renderModelsFrame(snapshot, viewport, { deferLayout: true })!
    expect(deferred.lines).toEqual([])
    expect(deferred.formWorkspace?.body?.kind).toBe('list')
    const rendered = renderModelsFrame(snapshot, viewport, { uiLanguage: 'en' })!
    expect(rendered.title).toBe('Models')
    expect(rendered.lines.join('\n')).toContain('DeepSeek Chat')
    expect(rendered.formWorkspace).toBeDefined()
  })
})
