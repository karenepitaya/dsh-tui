import { describe, expect, it } from 'vitest'
import { FormWorkspace } from 'pi-tui-orbs'
import type { FeatureSurfaceRuntimeSnapshot } from '../src/app/feature-surface-runtime.ts'
import type { SessionCatalogSnapshot } from '../src/session/catalog-port.ts'
import {
  createSessionsFeatureState,
  projectSessionsCatalog,
  transitionSessionsFeature,
  type SessionsFeatureState,
} from '../src/features/sessions/index.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'
import {
  renderSessionsFrame,
  sessionsFormModel,
  sessionsStateSource,
} from '../src/ui/sessions-frame.ts'

function catalog(ids: readonly string[], overrides: Partial<SessionCatalogSnapshot> = {}): SessionCatalogSnapshot {
  return {
    durability: 'available',
    sessions: ids.map((sessionId, index) => ({
      sessionId,
      title: `Title ${sessionId}`,
      createdAt: 1_700_000_000_000 + index * 60_000,
      cwd: `D:/work/${sessionId}`,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed' as const,
    })),
    ...overrides,
  }
}

const request = { scopeEpoch: 1, requestId: 1 }

function loaded(ids: readonly string[], partial: Partial<SessionsFeatureState> = {}): SessionsFeatureState {
  let state = transitionSessionsFeature(createSessionsFeatureState(), {
    type: 'catalog.load-started', request,
  }).state
  state = transitionSessionsFeature(state, {
    type: 'catalog.loaded', request, snapshot: catalog(ids),
  }).state
  return { ...state, ...partial }
}

const viewport = { columns: 120, rows: 30 }
const modelOf = (state: SessionsFeatureState, options: Parameters<typeof sessionsFormModel>[2] = {}) => (
  sessionsFormModel(state, viewport, options)
)
const text = (state: SessionsFeatureState, options: Parameters<typeof sessionsFormModel>[2] = {}) => (
  new FormWorkspace(modelOf(state, options)).render(120).join('\n')
)

describe('sessions FormWorkspace model', () => {
  it('projects a single-category page with a bounded searchable session list', () => {
    const state = loaded(['alpha', 'beta'])
    const current = modelOf(state)
    expect(current.categories).toEqual([{ id: 'sessions', label: 'Sessions 2' }])
    expect(current.activeCategoryId).toBe('sessions')
    expect(current.focus).toBe('content')
    expect(current.actions).toEqual([])
    expect(current.groups).toEqual([])
    expect(current.help).toBe('↑↓ select · Enter details · a resume · f fork · / search · r refresh · q back')
    expect(current.strings).toBeUndefined()
    expect(current.body?.kind).toBe('list')
    expect(current.body?.items.map(item => [item.label, item.badge])).toEqual([
      ['Title alpha', 'saved'],
      ['Title beta', 'saved'],
    ])
    expect(current.body?.items[0]?.description).toBe('D:/work/alpha')
    expect(current.body?.items[0]?.value).toBeTruthy()

    const rendered = text(state)
    expect(rendered).toContain('Sessions')
    expect(rendered).toContain('› Title alpha')
    expect(rendered).toContain('q back')
    for (const line of rendered.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(120)
  })

  it('bounds a 120-session catalog to the content height and keeps the selection visible', () => {
    const ids = Array.from({ length: 120 }, (_, index) => `session-${index}`)
    let state = loaded(ids)
    state = transitionSessionsFeature(state, {
      type: 'selection.move', direction: 'down', amount: 119,
    }).state
    expect(projectSessionsCatalog(state).selectedSessionId).toBe('session-119')
    const lines = new FormWorkspace(modelOf(state, {})).render(80)
    const rows = lines.filter(line => line.includes('Title session-'))
    expect(rows.length).toBeLessThanOrEqual(24)
    expect(rows.some(line => line.includes('› Title session-119'))).toBe(true)
    expect(rows.some(line => line.includes('Title session-0 '))).toBe(false)
  })

  it('carries the search query, focus and filtered counts', () => {
    const state = transitionSessionsFeature(loaded(['alpha', 'beta']), {
      type: 'query.changed', query: 'alp',
    }).state
    const current = modelOf(state, { searching: true })
    expect(current.focus).toBe('search')
    expect(current.search).toEqual({ text: 'alp', cursor: 3 })
    expect(current.body?.items.map(item => item.label)).toEqual(['Title alpha'])
    expect(current.message).toBe('1/2 matching')
    const workspace = new FormWorkspace(current)
    workspace.render(120)
    expect(workspace.getCursor()).toBeDefined()
  })

  it('keeps honest empty and failed catalog states', () => {
    const empty = loaded([])
    expect(modelOf(empty).body?.emptyMessage).toBe('No sessions yet')
    const filtered = transitionSessionsFeature(loaded(['alpha']), {
      type: 'query.changed', query: 'zzz',
    }).state
    expect(modelOf(filtered).body?.emptyMessage).toBe('No sessions match this query')
    let failed = transitionSessionsFeature(loaded(['alpha']), {
      type: 'catalog.load-started', request: { scopeEpoch: 1, requestId: 2 },
    }).state
    failed = transitionSessionsFeature(failed, {
      type: 'catalog.failed', request: { scopeEpoch: 1, requestId: 2 }, message: 'offline',
    }).state
    expect(modelOf(failed).message).toBe('Refresh failed · offline')
    expect(modelOf(failed).messageTone).toBe('error')
  })

  it('projects resume and fork as cancel-first confirmation modals', () => {
    const resume = transitionSessionsFeature(loaded(['alpha', 'cold']), {
      type: 'fork.requested',
    })
    expect(resume.state.operation).toMatchObject({ phase: 'confirm-fork', sessionId: 'alpha' })
    const current = modelOf(resume.state)
    expect(current.modal).toMatchObject({
      kind: 'confirmation',
      title: 'Fork session alpha?',
      actions: [{ id: 'cancel' }, { id: 'confirm', label: 'Fork' }],
      selectedIndex: 1,
    })
    const rendered = text(resume.state)
    expect(rendered).toContain('Fork session alpha?')
    expect(rendered).toContain('Enter confirm · Esc / q cancel')

    const running = transitionSessionsFeature(resume.state, {
      type: 'confirmation.accepted', requestId: 9,
    })
    expect(running.state.operation).toMatchObject({ phase: 'running', action: 'fork' })
    expect(modelOf(running.state).message).toBe('Forking alpha… · Esc cancels the request')
    const failed = transitionSessionsFeature(running.state, {
      type: 'navigation.failed', requestId: 9, message: 'denied',
    })
    expect(modelOf(failed.state).message).toBe('fork failed · denied')
    expect(modelOf(failed.state).messageTone).toBe('error')
  })

  it('opens a read-only details modal from catalog facts and the inspection projection', () => {
    let state = loaded(['cold'])
    state = transitionSessionsFeature(state, { type: 'selection.activated', requestId: 2 }).state
    expect(state.details).toEqual({ fieldIndex: 0 })
    const loading = modelOf(state)
    expect(loading.modal).toMatchObject({ kind: 'form', title: 'Title cold' })
    expect(loading.modal).toMatchObject({ message: 'Replaying durable session events…' })
    const rendered = text(state)
    expect(rendered).toContain('ID')
    expect(rendered).toContain('cold')
    expect(rendered).toContain('D:/work/cold')
    expect(rendered).not.toContain('✎')
    state = transitionSessionsFeature(state, { type: 'details.move', direction: 'down' }).state
    expect(modelOf(state).modal).toMatchObject({ selectedFieldId: 'path' })
    state = transitionSessionsFeature(state, { type: 'details.closed' }).state
    expect(state.details).toBeUndefined()
    expect(state.inspection.phase).toBe('idle')
    expect(modelOf(state).modal).toBeUndefined()
  })

  it('switches chrome strings with uiLanguage', () => {
    const state = loaded(['alpha'])
    expect(text(state, { uiLanguage: 'zh' })).toContain('q / Esc 返回')
    expect(modelOf(state, { uiLanguage: 'zh' }).strings).toBeDefined()
    expect(text(state, { uiLanguage: 'en' })).toContain('q / Esc back')
  })
})

describe('sessions frame seam', () => {
  const snapshotWith = (node: unknown, mode: 'normal' | 'insert' = 'normal'): FeatureSurfaceRuntimeSnapshot => ({
    host: {
      navigation: { mode, route: { kind: 'workspace', featureId: 'sessions', pane: 'navigator' } },
      slots: { contributions: [{
        slotId: 'workspace.navigator', featureId: 'sessions', authority: 'core', contributionId: 'sessions.navigator',
        value: { id: 'sessions.navigator', role: 'navigator', node },
      }] },
    },
    layout: { placements: [] },
    surfaces: [],
  }) as unknown as FeatureSurfaceRuntimeSnapshot

  it('reads the Feature state source from the navigator-region node', () => {
    const state = loaded(['alpha'])
    const source = { snapshot: () => state, onChanged: () => () => {} }
    expect(sessionsStateSource(snapshotWith({ kind: 'sessions.navigator', state: source }))).toBe(source)
    expect(sessionsStateSource(snapshotWith({ kind: 'other', state: source }))).toBeUndefined()
    expect(sessionsStateSource(snapshotWith(undefined))).toBeUndefined()
  })

  it('renders the dual path: retained model plus neutral fallback lines', () => {
    const state = loaded(['alpha'])
    const source = { snapshot: () => state, onChanged: () => () => {} }
    const snapshot = snapshotWith({ kind: 'sessions.navigator', state: source })
    const deferred = renderSessionsFrame(snapshot, viewport, { deferLayout: true })!
    expect(deferred.lines).toEqual([])
    expect(deferred.formWorkspace?.body?.kind).toBe('list')
    const rendered = renderSessionsFrame(snapshot, viewport, { uiLanguage: 'en' })!
    expect(rendered.title).toBe('Sessions')
    expect(rendered.lines.join('\n')).toContain('› Title alpha')
    expect(rendered.formWorkspace).toBeDefined()
  })

  it('focuses the search box while the host is in insert mode', () => {
    const state = transitionSessionsFeature(loaded(['alpha']), {
      type: 'query.changed', query: 'al',
    }).state
    const source = { snapshot: () => state, onChanged: () => () => {} }
    const rendered = renderSessionsFrame(snapshotWith({ kind: 'sessions.navigator', state: source }, 'insert'), viewport)!
    expect(rendered.formWorkspace?.focus).toBe('search')
    expect(rendered.cursor).toBeDefined()
  })
})
