import { expect, it } from 'vitest'
import { applySettingsPageInput, createSettingsPageState, selectSettingsPage, stageSettingsMutation, projectSettingsDrafts, settleSettingsPageSave } from '../src/settings/page-machine.ts'
import { settingsWorkspaceModel, renderSettingsPageFrame } from '../src/ui/settings-page-frame.ts'
import type { SettingsCatalogSnapshot } from '../src/settings/port.ts'

const snapshot: SettingsCatalogSnapshot = { available: true, writable: true, documentBacked: true, generation: 1,
  namespaces: [{ namespace: 'dsh-tui', revision: 1, applies: 'live', secrets: [], value: { density: 'compact' },
    schema: { type: 'object', dict: { density: { type: 'union', list: [{ type: 'const', value: 'compact' }, { type: 'const', value: 'comfortable' }] } } } }] }

it('keeps discard in settings and exposes only the actions appropriate to the draft', () => {
  const initial = createSettingsPageState()
  const viewport = { columns: 120, rows: 30 }
  expect(settingsWorkspaceModel(selectSettingsPage(initial, snapshot), viewport).actions?.map(a => a.label)).toEqual(['重置设置'])
  const draft = applySettingsPageInput(initial, snapshot, { type: 'move-right' }).state
  expect(settingsWorkspaceModel(selectSettingsPage(draft, snapshot), viewport).actions?.map(a => a.label)).toEqual(['保存', '取消'])
  expect(applySettingsPageInput({ ...draft, focus: 'actions', actionIndex: 0 }, snapshot, { type: 'submit' }).outcome?.kind).toBe('save')
  const discarded = applySettingsPageInput({ ...draft, confirmation: 'discard', confirmIndex: 1 }, snapshot, { type: 'submit' })
  expect(discarded.outcome).toBeUndefined()
  expect(discarded.state.drafts).toEqual({})
  expect(renderSettingsPageFrame(selectSettingsPage(initial, snapshot), viewport).lines.join('\n')).not.toMatch(/搜索设置|调整当前分类|保存更改/)
})


it('stages provider edits, previews them without changing the document and keeps failed writes retryable', () => {
  const catalog: SettingsCatalogSnapshot = { ...snapshot, namespaces: [{ namespace: 'agent-default-model', revision: 9, applies: 'live', secrets: [],
    schema: { type: 'object', dict: { provider: { type: 'string' }, model: { type: 'string' }, reasoningEffort: { type: 'string' } } },
    value: { provider: 'test', model: 'first', reasoningEffort: 'low' }, user: { reasoningEffort: 'low' } }] }
  const request = { namespace: 'agent-default-model', path: [], expectedRevision: 9, operation: 'batch' as const,
    changes: [{ operation: 'set' as const, path: ['model'], value: 'second' }, { operation: 'unset' as const, path: ['reasoningEffort'] }] }
  const state = stageSettingsMutation({ ...createSettingsPageState(), section: 'models' }, catalog, request)!
  expect(projectSettingsDrafts(state, catalog).namespaces[0]?.value).toEqual({ provider: 'test', model: 'second' })
  expect(catalog.namespaces[0]?.value).toEqual({ provider: 'test', model: 'first', reasoningEffort: 'low' })
  const saving = applySettingsPageInput(state, catalog, { type: 'save-default' })
  expect(saving.outcome).toMatchObject({ kind: 'save', requests: [request] })
  expect(applySettingsPageInput(saving.state, catalog, { type: 'save-default' }).outcome).toBeUndefined()
  const failed = settleSettingsPageSave(saving.state, catalog, [{ namespace: 'agent-default-model', error: 'disk full' }])
  expect(failed.drafts).toEqual(state.drafts)
  expect(failed.section).toBe('models')
  const cancelled = applySettingsPageInput({ ...failed, confirmation: 'discard', confirmIndex: 1 }, catalog, { type: 'submit' })
  expect(cancelled.outcome).toBeUndefined()
  expect(projectSettingsDrafts(cancelled.state, catalog)).toBe(catalog)
})


it('preserves the original revision, rejects unsupported edits and projects nested defaults safely', () => {
  expect(projectSettingsDrafts(undefined, snapshot)).toBe(snapshot)
  const catalog: SettingsCatalogSnapshot = { ...snapshot, namespaces: [...snapshot.namespaces, {
    namespace: 'nested', revision: 2, applies: 'live', secrets: [],
    schema: { type: 'object', dict: { config: { type: 'object', dict: { name: { type: 'string' } } }, secret: { type: 'string', meta: { role: 'secret' } }, list: { type: 'array' } } },
    value: { config: { name: 'before' }, list: ['readonly'] }, base: { config: { name: 'inherited' } }, user: { config: { name: 'before' } },
  }] }
  const request = { namespace: 'nested', path: ['config', 'name'], expectedRevision: 2, operation: 'set' as const, value: 'after' }
  const first = stageSettingsMutation(createSettingsPageState(), catalog, request)!
  const second = stageSettingsMutation(first, catalog, { ...request, expectedRevision: 3, value: 'third' })!
  expect(Object.values(second.drafts)[0]?.expectedRevision).toBe(2)
  expect(projectSettingsDrafts(second, catalog).namespaces[1]?.value).toMatchObject({ config: { name: 'third' } })
  const reset = stageSettingsMutation(second, catalog, { ...request, operation: 'unset' })!
  expect(projectSettingsDrafts(reset, catalog).namespaces[1]?.value).toMatchObject({ config: { name: 'inherited' } })
  for (const path of [['unknown'], ['secret'], ['list']]) expect(stageSettingsMutation(first, catalog, { ...request, path })).toBeUndefined()
})


it('keeps clean reset focus stationary and reconstructs removed draft parents',()=>{
 const initial={...createSettingsPageState(),focus:'actions' as const}
 expect(applySettingsPageInput(initial,snapshot,{type:'move-right'}).state.actionIndex).toBe(0)
 const catalog:SettingsCatalogSnapshot={...snapshot,namespaces:[{...snapshot.namespaces[0]!,value:{group:{name:'old'}},schema:{type:'object',dict:{group:{type:'object',dict:{name:{type:'string'}}}}}}]}
 const state=stageSettingsMutation(initial,catalog,{namespace:'dsh-tui',path:['group','name'],expectedRevision:1,operation:'set',value:'new'})!
 for(const value of [{},{group:42}]) expect(projectSettingsDrafts(state,{...catalog,namespaces:[{...catalog.namespaces[0]!,value}]}).namespaces[0]?.value).toEqual({group:{name:'new'}})
})
