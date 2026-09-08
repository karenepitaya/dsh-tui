import { describe, expect, it } from 'vitest'
import { createMcpContentNode, createMcpFeatureState, transitionMcpFeature } from '../src/features/mcp/index.ts'
import { createToolsContentNode, createToolsFeatureState, transitionToolsFeature } from '../src/features/tools/index.ts'
import { createSkillsNavigatorNode, createSkillsFeatureState, transitionSkillsFeature } from '../src/features/skills/index.ts'
import { createModelsContentNode, createModelsFeatureState, transitionModelsFeature } from '../src/features/models/index.ts'
import { createModesContentNode, createModesFeatureState, transitionModesFeature } from '../src/features/modes/index.ts'
import { createSettingsContentNode, createSettingsFeatureState } from '../src/features/settings/index.ts'
import { createSessionsFeatureModel, createSessionsNavigatorNode, createSessionsContentNode } from '../src/features/sessions/index.ts'
import { createDiffContentNode, createDiffInspectorNode, createDiffFeatureState, transitionDiffFeature, projectDiffDocument } from '../src/features/diff/index.ts'
import { DEFAULT_DSH_TUI_PREFERENCES } from '../src/preferences/contracts.ts'
import type { FeatureSurfaceUiNode } from '../src/presentation/feature-surface.ts'

const source = <T>(state: T) => ({ snapshot: () => state, onChanged: () => () => {} })
const context = { bounds: { x: 0, y: 0, width: 120, height: 20 }, focus: true, mode: 'normal', resources: [] }
const tools = { available: true, stale: false, generation: 1, tools: [{
  name: 'mcp__files__read', group: 'mcp' as const, description: 'Read a file', parameterNames: ['path'], requiredParameterNames: ['path'],
}] }

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
    ['MCP', createMcpContentNode(source(transitionMcpFeature(createMcpFeatureState(), { type: 'snapshot.changed', snapshot: tools }).state))],
    ['TOOLS', createToolsContentNode(source(transitionToolsFeature(createToolsFeatureState(), { type: 'snapshot.changed', snapshot: tools }).state))],
    ['SKILLS', createSkillsNavigatorNode(source(transitionSkillsFeature(createSkillsFeatureState(), { type: 'snapshot.changed', snapshot: {
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
    ['PREFERENCES', createSettingsContentNode(source({ ...createSettingsFeatureState(), phase: 'ready' as const, snapshot: {
      status: { available: true, writable: true, documentBacked: true }, revision: 1, preferences: DEFAULT_DSH_TUI_PREFERENCES,
    } }))],
    ['SESSIONS', createSessionsNavigatorNode(sessionState)],
    ['SESSION', createSessionsContentNode(sessionState)],
    ['DIFF empty', createDiffContentNode('diff.document', emptyDiff)],
    ['DIFF empty details', createDiffInspectorNode('diff.document', emptyDiff)],
    ['DIFF changed', createDiffContentNode('diff.document', readyDiff)],
    ['DIFF changed details', createDiffInspectorNode('diff.document', readyDiff)],
  ]
}

describe('workspace bodies complement the shared page title', () => {
  it('keeps the last-known session title visible while the catalog resource refreshes', () => {
    const navigator = examples().find(([page]) => page === 'SESSIONS')![1]
    const rows = navigator.project({ ...context, resources: [{ id: 'sessions.catalog', phase: 'refreshing' }] }).rows
    expect(rows[0]?.text).toBe('1/1 matching · refreshing')
    expect(rows.some(row => row.selected && row.text.includes('Repair the test suite'))).toBe(true)
  })

  it.each(examples())('%s keeps useful content without repeating its page name or normal ready status', (page, node) => {
    const rows = node.project(context).rows
    const body = rows.map(row => row.text).join('\n')
    expect(rows.length).toBeGreaterThan(0)
    expect(body).not.toMatch(/^(?:SESSIONS?|MODELS|MODES|MCP|TOOLS|SKILLS|PREFERENCES|DIFF(?: INSPECTOR)?)\s{2}/m)
    expect(body).not.toMatch(/\bready\b/i)
    if (page === 'MCP') {
      expect(rows[0]?.text).toBe('1 tool available in this session')
      expect(body).not.toContain('servers')
    }
    if (page === 'SESSIONS') expect(rows[0]?.text).toBe('1/1 matching')
    if (page === 'SESSION') {
      expect(rows[0]?.text).toBe('› Repair the test suite')
      expect(body.match(/Repair the test suite/g)).toHaveLength(1)
      expect(body).toContain('ID  stable-session-id')
      expect(body).toContain('D:/work/project')
    }
  })
})
