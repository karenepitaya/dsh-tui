import { describe, expect, it } from 'vitest'
import {
  createCapabilitiesFeatureState,
  createCapabilitiesNavigatorNode,
  createMcpFeatureState,
  createSkillsFeatureState,
  createToolsFeatureState,
  transitionMcpFeature,
  transitionSkillsFeature,
  transitionToolsFeature,
  type CapabilitiesFeatureState,
} from '../src/features/capabilities/index.ts'
import { createModelsContentNode, createModelsFeatureState, transitionModelsFeature } from '../src/features/models/index.ts'
import { createModesContentNode, createModesFeatureState, transitionModesFeature } from '../src/features/modes/index.ts'
import { createSessionsFeatureModel, createSessionsNavigatorNode, projectSessionDetails } from '../src/features/sessions/index.ts'
import { createDiffContentNode, createDiffInspectorNode, createDiffFeatureState, transitionDiffFeature, projectDiffDocument } from '../src/features/diff/index.ts'
import type { FeatureSurfaceUiNode } from '../src/presentation/feature-surface.ts'

const source = <T>(state: T) => ({ snapshot: () => state, onChanged: () => () => {} })
const context = { bounds: { x: 0, y: 0, width: 120, height: 20 }, focus: true, mode: 'normal', resources: [] }
const tools = { available: true, stale: false, generation: 1, tools: [{
  name: 'mcp__files__read', group: 'mcp' as const, description: 'Read a file', parameterNames: ['path'], requiredParameterNames: ['path'],
}] }

function capabilities(tab: CapabilitiesFeatureState['tab'], state: CapabilitiesFeatureState[CapabilitiesFeatureState['tab']]) {
  const base = createCapabilitiesFeatureState()
  if (tab === 'skills') return source<CapabilitiesFeatureState>({ ...base, tab, skills: state as CapabilitiesFeatureState['skills'] })
  if (tab === 'tools') return source<CapabilitiesFeatureState>({ ...base, tab, tools: state as CapabilitiesFeatureState['tools'] })
  return source<CapabilitiesFeatureState>({ ...base, tab, mcp: state as CapabilitiesFeatureState['mcp'] })
}

function examples(): readonly (readonly [string, FeatureSurfaceUiNode])[] {
  const sessions = createSessionsFeatureModel()
  const request = { scopeEpoch: 1, requestId: 1 }
  sessions.dispatch({ type: 'catalog.load-started', request })
  sessions.dispatch({ type: 'catalog.loaded', request, snapshot: { durability: 'available', sessions: [{
    sessionId: 'stable-session-id', title: 'Repair the test suite', createdAt: 0, cwd: 'D:/work/project',
    isSubagent: false, attached: false, durablePresence: 'observed',
  }] } })
  const sessionState = source(sessions.snapshot())
  sessions.dispose()
  const emptyDiff = source(transitionDiffFeature(createDiffFeatureState(), { type: 'load-empty' }).state)
  const readyDiff = source(transitionDiffFeature(createDiffFeatureState(), { type: 'load-succeeded', projection: projectDiffDocument({
    digest: 'fixture', files: [{ path: 'changed.ts', status: 'added', hunks: [{ id: 'new', header: '@@ new @@', lines: [{ kind: 'added', newLine: 1, text: 'new value' }] }] }],
  }) }).state)
  return [
    ['MCP', createCapabilitiesNavigatorNode(capabilities('mcp', transitionMcpFeature(createMcpFeatureState(), { type: 'snapshot.changed', snapshot: tools }).state))],
    ['TOOLS', createCapabilitiesNavigatorNode(capabilities('tools', transitionToolsFeature(createToolsFeatureState(), { type: 'snapshot.changed', snapshot: tools }).state))],
    ['SKILLS', createCapabilitiesNavigatorNode(capabilities('skills', transitionSkillsFeature(createSkillsFeatureState(), { type: 'snapshot.changed', snapshot: {
      available: true, complete: true, loading: false, stale: false, generation: 1,
      skills: [{ name: 'review', description: 'Review a change', source: 'workspace', provider: 'files', modelInvocable: true }],
    } }).state))],
    ['MODELS', createModelsContentNode(source(transitionModelsFeature(createModelsFeatureState(), { type: 'snapshot.changed', snapshot: {
      routable: true, writable: true, loading: false, selecting: false, failures: [], groups: [{
        id: 'provider', name: 'Provider', models: [{ provider: 'provider', providerName: 'Provider', id: 'model', name: 'Model choice', efforts: [] }],
      }],
    } }).state))],
    ['MODES', createModesContentNode(source(transitionModesFeature(createModesFeatureState(), { type: 'snapshot.changed', snapshot: {
      available: true, loading: false, selecting: false, locked: false, presets: [{
        id: 'coding', name: 'Coding', description: 'Help with code', trust: 'system', sourcePath: '/fixture', isDefault: true,
      }],
    } }).state))],
    ['SESSIONS', createSessionsNavigatorNode(sessionState)],
    ['DIFF empty', createDiffContentNode('diff.document', emptyDiff)],
    ['DIFF empty details', createDiffInspectorNode('diff.document', emptyDiff)],
    ['DIFF changed', createDiffContentNode('diff.document', readyDiff)],
    ['DIFF changed details', createDiffInspectorNode('diff.document', readyDiff)],
  ]
}

function sessionDetails() {
  const sessions = createSessionsFeatureModel()
  const request = { scopeEpoch: 1, requestId: 1 }
  sessions.dispatch({ type: 'catalog.load-started', request })
  sessions.dispatch({ type: 'catalog.loaded', request, snapshot: { durability: 'available', sessions: [{
    sessionId: 'stable-session-id', title: 'Repair the test suite', createdAt: 0, cwd: 'D:/work/project',
    isSubagent: false, attached: false, durablePresence: 'observed',
  }] } })
  const details = projectSessionDetails(sessions.snapshot())
  sessions.dispose()
  return details
}

describe('workspace bodies complement the shared page title', () => {
  it('keeps the last-known session title visible while the catalog resource refreshes', () => {
    const navigator = examples().find(([page]) => page === 'SESSIONS')![1]
    const rows = navigator.project({ ...context, resources: [{ id: 'sessions.catalog', phase: 'refreshing' }] }).rows
    expect(rows[0]?.text).toBe('1/1 matching · refreshing')
    expect(rows.some(row => row.selected && row.text.includes('Repair the test suite'))).toBe(true)
  })

  it('projects session facts once into the details modal content', () => {
    const details = sessionDetails()
    expect(details?.title).toBe('Repair the test suite')
    expect(details?.fields.map(field => field.id)).toEqual(['id', 'path', 'status', 'created', 'storage'])
    expect(details?.fields.find(field => field.id === 'id')?.value).toBe('stable-session-id')
    expect(details?.fields.find(field => field.id === 'path')?.value).toBe('D:/work/project')
  })

  it.each(examples())('%s keeps useful content without repeating its page name or normal ready status', (page, node) => {
    const rows = node.project(context).rows
    const body = rows.map(row => row.text).join('\n')
    expect(rows.length).toBeGreaterThan(0)
    expect(body).not.toMatch(/^(?:SESSIONS?|MODELS|MODES|MCP|TOOLS|SKILLS|DIFF(?: INSPECTOR)?)\s{2}/m)
    expect(body).not.toMatch(/\bready\b/i)
    if (page === 'SESSIONS') expect(rows[0]?.text).toBe('1/1 matching')
  })
})
