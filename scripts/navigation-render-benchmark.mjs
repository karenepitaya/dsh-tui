#!/usr/bin/env node

// CPU-only fixture: this does not measure ConPTY or the application scheduler.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const root = resolve(argument('--source-root', project))
const output = resolve(argument('--output', join(project, '.artifacts/navigation-render-current.json')))
const samples = Number(argument('--samples', '80'))
const deferLayout = args.includes('--defer-layout')
assert.ok(Number.isInteger(samples) && samples >= 20 && samples <= 1000, 'samples must be 20..1000')
const orbsSource = pathToFileURL(join(root, 'packages/pi-tui-orbs/src/')).href
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'pi-tui-orbs') return nextResolve(orbsSource + 'settings-workspace.ts', context)
  if (context.parentURL?.startsWith(orbsSource) && specifier.startsWith('./') && specifier.endsWith('.js')) {
    return nextResolve(specifier.slice(0, -3) + '.ts', context)
  }
  return nextResolve(specifier, context)
} })
const sources = ['src/settings/providers-controller.ts', 'src/ui/settings-providers-frame.ts',
  'src/ui/settings-page-frame.ts', 'src/app/controller.ts', 'src/terminal/driver.ts',
  'packages/pi-tui-orbs/src/settings-workspace.ts', 'packages/pi-tui-orbs/src/settings-workspace-model.ts',
  'packages/pi-tui-orbs/src/lab-controls.ts']
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path,
  createHash('sha256').update(await readFile(join(root, path))).digest('hex')])) )
const before = await hashes()
const load = path => import(pathToFileURL(join(root, path)).href)
const { SettingsWorkspace } = await import('pi-tui-orbs')
const { SettingsProvidersController } = await load('src/settings/providers-controller.ts')
const { renderSettingsProvidersFrame } = await load('src/ui/settings-providers-frame.ts')
const { renderSettingsPageFrame } = await load('src/ui/settings-page-frame.ts')
const { createSettingsWorkspaceTheme } = await load('src/ui/settings-workspace-theme.ts')
const { createDshTuiTheme } = await load('src/ui/theme.ts')
const { createPromptEditorState } = await load('src/ui/prompt-editor.ts')
const { stripTerminalSequences, visibleWidth } = await load('src/terminal/text-layout.ts')
const noop = () => undefined
const providers = Array.from({ length: 64 }, (_, index) => ({ id: `fixture-${index}`, name: `服务 ${String(index).padStart(2, '0')}`,
  active: true, configured: true, connected: true, credential: { kind: 'api-key', configured: true, writable: true },
  methods: [{ id: 'api-key', label: 'API key' }], canDisconnect: true,
  models: Array.from({ length: 6 }, (_, model) => ({ id: `model-${model}`, name: `测试模型 ${model}` })),
  configuration: { namespace: 'llm-pi-ai', path: ['providers', `fixture-${index}`], revision: 1, writable: true,
    displayName: `服务 ${String(index).padStart(2, '0')}`, baseURL: 'https://fixture.invalid/v1' } }))
const snapshot = { available: true, writable: true, documentBacked: true, generation: 1, namespaces: [{
  namespace: 'agent-default-model', schema: {}, value: { provider: 'fixture-0', model: 'model-0' },
  revision: 1, applies: 'live', secrets: [],
}] }
const fields = Array.from({ length: 40 }, (_, index) => ({ id: `field-${index}`, namespace: 'dsh-tui', path: [`field-${index}`],
  section: 'general', group: `分组 ${Math.floor(index / 5)}`, label: `设置项 ${index}`, description: '内存测试数据。',
  control: 'boolean', value: index % 2 === 0, overridden: false, applies: 'live' }))
const page = { section: 'models', focus: 'form', fields: [], selection: 0, actionIndex: 0, query: createPromptEditorState(),
  dirtyIds: [], dirtyCount: 0, confirmIndex: 0, pending: false, writable: true, available: true, documentBacked: true, navigationKeys: 'both' }
const theme = createSettingsWorkspaceTheme(createDshTuiTheme({ preset: 'auto' }, {
  colorSupported: true, noColor: false, dumbTerminal: false, colorLevel: 'truecolor',
}))
let rendered = 0
const originalRender = SettingsWorkspace.prototype.render
SettingsWorkspace.prototype.render = function (...parameters) { rendered++; return originalRender.apply(this, parameters) }
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
const summary = values => ({ p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: Math.max(...values) })
const cases = []
for (const scene of ['settings-form', 'provider-home', 'provider-directory', 'provider-manage', 'default-model']) {
  for (const keys of scene === 'settings-form' ? ['view-selection'] : ['arrows', 'jk']) {
    for (const [columns, rows] of [[80, 24], [160, 40], [40, 12]]) {
      let invalidations = 0, effects = 0
      const rejectEffect = async () => { effects++; throw new Error('Navigation must not call a model, authorize or save') }
      const controller = new SettingsProvidersController({ list: async () => ({ writable: true, providers }),
        onChanged: () => noop, connect: rejectEffect, disconnect: rejectEffect, test: rejectEffect },
      { settingsSnapshot: () => snapshot, onSettingsChanged: () => noop, mutateSettings: rejectEffect }, () => { invalidations++ })
      controller.open(); await controller.waitForIdle()
      if (scene === 'provider-directory') { controller.openAdd(); controller.handleInput({ type: 'complete' }) }
      if (scene === 'provider-manage') { controller.handleInput({ type: 'move-down' }); controller.handleInput({ type: 'submit' }) }
      if (scene === 'default-model') controller.handleInput({ type: 'submit' })
      const count = scene === 'settings-form' ? fields.length : controller.view().dialog?.rows.length ?? providers.length + 1
      let selection = 0, direction = 1
      const projection = [], paint = [], total = []
      let measuredRenders = 0, measuredInvalidations = 0, checkedSelections = 0
      for (let index = -12; index < samples; index++) {
        if (selection === count - 1) direction = -1
        else if (selection === 0) direction = 1
        selection += direction
        const priorRenders = rendered, priorInvalidations = invalidations, started = performance.now()
        if (scene !== 'settings-form') controller.handleInput(keys === 'arrows' ? { type: direction === 1 ? 'move-down' : 'move-up' }
          : { type: 'insert', text: direction === 1 ? 'j' : 'k' })
        const view = controller.view()
        if (scene !== 'settings-form') assert.equal(view.dialog?.selection ?? view.selection, selection, `${scene}/${keys} lost a navigation input`)
        const frame = scene === 'settings-form' ? renderSettingsPageFrame({ ...page, section: 'general', fields, selection }, { columns, rows }, { deferLayout })
          : renderSettingsProvidersFrame(view, page, { columns, rows }, { deferLayout })
        const projected = performance.now()
        const lines = new SettingsWorkspace(frame.settingsWorkspace, theme).render(columns)
        const finished = performance.now()
        assert.equal(lines.length, rows)
        assert.ok(lines.every(line => visibleWidth(line) <= columns))
        const selectedLabel = scene === 'settings-form' ? fields[selection].label
          : view.dialog ? view.dialog.rows[selection].label : selection === 0 ? '新会话默认模型' : view.providers[selection - 1].name
        // Credential and test control labels are projected by the management form.
        const label = scene === 'provider-manage' && view.dialog.rows[selection].id === 'credentials' ? 'API 密钥' : selectedLabel
        assert.ok(lines.map(stripTerminalSequences).join('\n').includes(label), `${scene}: selected item is absent from visible output`)
        if (index >= 0) {
          projection.push(projected - started); paint.push(finished - projected); total.push(finished - started)
          measuredRenders += rendered - priorRenders; measuredInvalidations += invalidations - priorInvalidations; checkedSelections++
        }
      }
      assert.equal(effects, 0)
      const record = { scene, keys, columns, rows, samples, checkedSelections, sideEffects: effects,
        invalidations: measuredInvalidations, workspaceRenders: measuredRenders,
        inputAndProjection: summary(projection), themedPaint: summary(paint), combined: summary(total) }
      cases.push(record); console.log(JSON.stringify(record))
      controller.close(); await controller.waitForIdle()
    }
  }
}
assert.deepEqual(await hashes(), before, 'source changed while the benchmark was running')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), runtime: process.version, sourceRoot: root, deferLayout,
  method: 'Public provider controller navigation -> frame projection -> themed SettingsWorkspace render; 12 warmup inputs per case.',
  limitations: ['CPU microbenchmark only: excludes application routing, scheduler, terminal driver, ConPTY, xterm parsing and monitor presentation.',
    'Settings form changes its view selection directly; only provider scenes dispatch public handleInput actions.',
    'Wall-clock percentiles are diagnostic evidence, not a portable latency gate.'], sourceHashes: before, cases }, null, 2) + '\n')
console.log(`NAVIGATION_RENDER_EVIDENCE=${output}`)
