import { describe, expect, it } from 'vitest'
import { FormWorkspace } from 'pi-tui-orbs'
import type { FeatureSurfaceRuntimeSnapshot } from '../src/app/feature-surface-runtime.ts'
import type { SessionJob } from '../src/activity/port.ts'
import type { SessionDelegationSnapshot } from '../src/activity/delegation-port.ts'
import {
  createActivityFeatureModel,
  projectActivityDetails,
  type ActivityFeatureState,
} from '../src/features/activity/index.ts'
import { visibleWidth } from '../src/terminal/text-layout.ts'
import {
  activityFormModel,
  activityStateSource,
  renderActivityFrame,
} from '../src/ui/activity-frame.ts'

function job(id: string, overrides: Partial<SessionJob> = {}): SessionJob {
  return {
    id,
    kind: 'bash',
    label: `Run ${id}`,
    status: 'running',
    startedAt: 42,
    reported: false,
    ...overrides,
  }
}

function openModel(jobs: readonly SessionJob[] = [job('a')], delegation: Partial<SessionDelegationSnapshot> = {}) {
  const model = createActivityFeatureModel()
  model.dispatch({ type: 'jobs.changed', snapshot: { available: true, generation: 3, jobs } })
  model.dispatch({
    type: 'delegation.changed',
    snapshot: {
      available: true, generation: 5, loading: false, subagentsAvailable: true,
      subagents: [], workflows: [], ...delegation,
    },
  })
  model.dispatch({ type: 'surface.opened' })
  return model
}

const viewport = { columns: 120, rows: 30 }
const modelOf = (state: ActivityFeatureState, options: Parameters<typeof activityFormModel>[2] = {}) => (
  activityFormModel(state, viewport, options)
)
const text = (state: ActivityFeatureState, options: Parameters<typeof activityFormModel>[2] = {}) => (
  new FormWorkspace(modelOf(state, options)).render(120).join('\n')
)

describe('activity FormWorkspace model', () => {
  it('projects categories with counts and live badges, a list body and one footer hint', () => {
    const model = openModel([job('a'), job('b', { status: 'killed' })])
    const current = modelOf(model.snapshot())
    expect(current.categories).toEqual([
      { id: 'jobs', label: 'Jobs 2 · 1 live' },
      { id: 'subagents', label: 'Subagents 0' },
      { id: 'workflows', label: 'Workflows 0' },
    ])
    expect(current.activeCategoryId).toBe('jobs')
    expect(current.focus).toBe('content')
    expect(current.searchHidden).toBe(true)
    expect(current.actions).toEqual([])
    expect(current.groups).toEqual([])
    expect(current.help).toBe('[/] tabs · ↑↓ select · Enter details · K stop · r refresh · q back')
    expect(current.strings).toBeUndefined()
    expect(current.body).toMatchObject({ kind: 'list', selectedIndex: 0 })
    expect(current.body?.items.map(item => [item.label, item.value])).toEqual([
      ['■ Run b', 'killed'],
      ['● Run a', 'running'],
    ])
    expect(current.body?.items[0]?.badge).toBeUndefined()
    expect(current.body?.items[1]?.badge).toBe('live')

    const rendered = text(model.snapshot())
    expect(rendered).toContain('Activity')
    expect(rendered).toContain('q back')
    for (const line of rendered.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(120)
    model.dispose()
  })

  it('keeps per-tab empty messages in the list body', () => {
    const model = openModel([])
    expect(modelOf(model.snapshot()).body?.emptyMessage).toBe('No background Jobs in this Session.')
    model.dispatch({ type: 'center.action', action: { type: 'tab-next' } })
    expect(modelOf(model.snapshot()).body?.emptyMessage).toBe('No durable Subagent descendants.')
    model.dispatch({ type: 'center.action', action: { type: 'tab-next' } })
    expect(modelOf(model.snapshot()).body?.emptyMessage).toBe('No top-level Workflow runs in this Session.')
    expect(text(model.snapshot())).toContain('No top-level Workflow runs in this Session.')
    model.dispose()
  })

  it('surfaces feed errors, failures and notices as one status line', () => {
    const model = openModel()
    model.dispatch({ type: 'stop.rejected', message: 'denied' })
    expect(modelOf(model.snapshot()).message).toBe('Error: denied')
    expect(modelOf(model.snapshot()).messageTone).toBe('error')
    model.dispatch({ type: 'stop.resolved', message: 'Stop requested for a' })
    expect(modelOf(model.snapshot()).message).toBe('Notice: Stop requested for a')
    model.dispatch({ type: 'feed.failed', message: 'read failed' })
    expect(modelOf(model.snapshot()).message).toBe('Feed error: read failed')
    model.dispose()
  })

  it('projects the stop confirmation as a cancel-first modal', () => {
    const model = openModel()
    model.dispatch({ type: 'center.action', action: { type: 'request-stop' } })
    const current = modelOf(model.snapshot())
    expect(current.modal).toMatchObject({
      kind: 'confirmation',
      title: 'Stop Run a?',
      actions: [{ id: 'cancel' }, { id: 'confirm' }],
      selectedIndex: 1,
    })
    const rendered = text(model.snapshot())
    expect(rendered).toContain('Stop Run a?')
    expect(rendered).toContain('Enter confirm · Esc / q cancel')
    model.dispatch({ type: 'center.action', action: { type: 'escape' } })
    expect(modelOf(model.snapshot()).modal).toBeUndefined()
    model.dispose()
  })

  it('opens a read-only details modal and moves through its fields', () => {
    const model = openModel([job('a', { detail: 'exit 1', ownerSession: 'owner-1' })])
    model.dispatch({ type: 'details.open' })
    const current = modelOf(model.snapshot())
    expect(current.modal).toMatchObject({ kind: 'form', title: 'Run a', selectedFieldId: 'state' })
    const rendered = text(model.snapshot())
    expect(rendered).toContain('State')
    expect(rendered).toContain('running')
    expect(rendered).toContain('Authority')
    expect(rendered).toContain('JobRegistry')
    expect(rendered).toContain('exit 1')
    expect(rendered).not.toContain('✎')
    model.dispatch({ type: 'details.move', direction: 'down', amount: 5 })
    expect(modelOf(model.snapshot()).modal).toMatchObject({ selectedFieldId: 'trace' })
    model.dispatch({ type: 'details.close' })
    expect(modelOf(model.snapshot()).modal).toBeUndefined()
    expect(projectActivityDetails(model.snapshot())?.title).toBe('Run a')
    model.dispose()
  })

  it('switches chrome strings with uiLanguage', () => {
    const model = openModel()
    expect(text(model.snapshot(), { uiLanguage: 'zh' })).toContain('q / Esc 返回')
    expect(modelOf(model.snapshot(), { uiLanguage: 'zh' }).strings).toBeDefined()
    expect(text(model.snapshot(), { uiLanguage: 'en' })).toContain('q / Esc back')
    model.dispose()
  })
})

describe('activity frame seam', () => {
  const snapshotWith = (node: unknown): FeatureSurfaceRuntimeSnapshot => ({
    host: {
      navigation: { mode: 'normal', route: { kind: 'workspace', featureId: 'activity', pane: 'navigator' } },
      slots: { contributions: [{
        slotId: 'workspace.navigator', featureId: 'activity', authority: 'core', contributionId: 'activity.navigator',
        value: { id: 'activity.navigator', role: 'navigator', node },
      }] },
    },
    layout: { placements: [] },
    surfaces: [],
  }) as unknown as FeatureSurfaceRuntimeSnapshot

  it('reads the Feature state source from the navigator-region node', () => {
    const model = openModel()
    const source = { snapshot: () => model.snapshot(), onChanged: () => () => {} }
    expect(activityStateSource(snapshotWith({ kind: 'activity.navigator', state: source }))).toBe(source)
    expect(activityStateSource(snapshotWith({ kind: 'other', state: source }))).toBeUndefined()
    expect(activityStateSource(snapshotWith(undefined))).toBeUndefined()
    model.dispose()
  })

  it('renders the dual path: retained model plus neutral fallback lines', () => {
    const model = openModel()
    const source = { snapshot: () => model.snapshot(), onChanged: () => () => {} }
    const snapshot = snapshotWith({ kind: 'activity.navigator', state: source })
    const deferred = renderActivityFrame(snapshot, viewport, { deferLayout: true })!
    expect(deferred.lines).toEqual([])
    expect(deferred.formWorkspace?.body?.kind).toBe('list')
    const rendered = renderActivityFrame(snapshot, viewport, { uiLanguage: 'en' })!
    expect(rendered.title).toBe('Activity')
    expect(rendered.lines.join('\n')).toContain('● Run a')
    expect(rendered.formWorkspace).toBeDefined()
    model.dispose()
  })
})
