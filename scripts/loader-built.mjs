import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Commands from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const tempRoot = resolve(tmpdir())
const tempDirectory = resolve(await mkdtemp(join(tempRoot, 'dsh-tui-loader-')))
const relativeTemp = relative(tempRoot, tempDirectory)
if (relativeTemp === '' || relativeTemp.startsWith(`..${sep}`) || isAbsolute(relativeTemp)) {
  throw new Error(`refusing unsafe Loader smoke directory: ${tempDirectory}`)
}

const built = await import(pathToFileURL(resolve(projectRoot, 'lib/index.js')).href)
const kernelRow = await import('dsh-tui/adapters/cordis')
const adapterRow = await import('dsh-tui/adapters/dsh-rc2')
const preferencesRow = await import('dsh-tui/adapters/preferences')
const legacyRow = await import('dsh-tui/features/legacy-chat')
const sessionsRow = await import('dsh-tui/features/sessions')
const diffRow = await import('dsh-tui/features/diff')
const modelsRow = await import('dsh-tui/features/models')
const modesRow = await import('dsh-tui/features/modes')
const skillsRow = await import('dsh-tui/features/skills')
const toolsRow = await import('dsh-tui/features/tools')
const mcpRow = await import('dsh-tui/features/mcp')
const settingsRow = await import('dsh-tui/features/settings')
const productRow = await import('dsh-tui/product')
const originalRunnerStart = productRow.DshTuiProductRunner.prototype.start

try {
  assertBuiltEntrypoints()
  await verifySplitRows()
  await verifyRootCompatibility()
} finally {
  productRow.DshTuiProductRunner.prototype.start = originalRunnerStart
  await rm(tempDirectory, { recursive: true, force: true })
}

function assertBuiltEntrypoints() {
  if ('default' in built) throw new Error('function plugin must not export default')
  if (built.name !== 'dsh-tui') {
    throw new Error('built DSH-TUI plugin has an unexpected name')
  }
  for (const [label, module, expectedExport] of [
    ['Cordis kernel row', kernelRow, 'provideDshTuiFeatures'],
    ['DSH rc.2 adapter row', adapterRow, 'provideDshTuiRuntime'],
    ['legacy Chat row', legacyRow, 'legacyChatFeature'],
    ['Sessions row', sessionsRow, 'sessionsFeature'],
    ['Diff row', diffRow, 'diffFeature'],
    ['Models row', modelsRow, 'modelsFeature'],
    ['Modes row', modesRow, 'modesFeature'],
    ['Skills row', skillsRow, 'skillsFeature'],
    ['Tools row', toolsRow, 'toolsFeature'],
    ['MCP row', mcpRow, 'mcpFeature'],
    ['Settings row', settingsRow, 'settingsFeature'],
    ['Preferences adapter row', preferencesRow, 'provideDshTuiPreferencesSettings'],
    ['Product row', productRow, 'DshTuiProductRunner'],
  ]) {
    if (!(expectedExport in module)) {
      throw new Error(`${label} built entrypoint omitted ${expectedExport}`)
    }
    if ('default' in module) {
      throw new Error(`${label} built entrypoint must not export default`)
    }
  }
}

async function verifySplitRows() {
  const ctx = new Context()
  const exits = []

  try {
    await installHostRequirements(ctx)
    ctx.provide('cmdlineArgs', { get: () => [] })
    ctx.provide('appExit', code => { exits.push(code) })
    await installLoader(ctx)
    const evidence = installSafeProductRun(ctx, 'split rows')

    const splitPath = join(tempDirectory, 'split-rows.json')
    await writeFile(splitPath, JSON.stringify([
      // Consumers deliberately precede their providers. The Loader must use
      // the inject DAG rather than source order, while the source order keeps
      // Product first for safe forward disposal.
      {
        id: 'split-product',
        name: pathToFileURL(resolve(projectRoot, 'lib/product.js')).href,
      },
      {
        id: 'split-settings',
        name: pathToFileURL(resolve(projectRoot, 'lib/features/settings-entry.js')).href,
      },
      {
        id: 'split-mcp',
        name: pathToFileURL(resolve(projectRoot, 'lib/features/mcp-entry.js')).href,
      },
      {
        id: 'split-tools',
        name: pathToFileURL(resolve(projectRoot, 'lib/features/tools-entry.js')).href,
      },
      {
        id: 'split-skills',
        name: pathToFileURL(resolve(projectRoot, 'lib/features/skills-entry.js')).href,
      },
      {
        id: 'split-modes',
        name: pathToFileURL(resolve(projectRoot, 'lib/features/modes-entry.js')).href,
      },
      {
        id: 'split-models',
        name: pathToFileURL(resolve(projectRoot, 'lib/features/models-entry.js')).href,
      },
      {
        id: 'split-diff',
        name: pathToFileURL(resolve(projectRoot, 'lib/features/diff-entry.js')).href,
      },
      {
        id: 'split-sessions',
        name: pathToFileURL(resolve(projectRoot, 'lib/features/sessions-entry.js')).href,
      },
      {
        id: 'split-adapter',
        name: pathToFileURL(resolve(projectRoot, 'lib/adapters/dsh-rc2.js')).href,
      },
      {
        id: 'split-legacy',
        name: pathToFileURL(resolve(projectRoot, 'lib/features/legacy-chat-entry.js')).href,
      },
      {
        id: 'split-preferences',
        name: pathToFileURL(resolve(projectRoot, 'lib/adapters/preferences.js')).href,
      },
      {
        id: 'split-kernel',
        name: pathToFileURL(resolve(projectRoot, 'lib/adapters/cordis.js')).href,
      },
    ], null, 2), 'utf8')

    const loadTask = ctx.loader.create({
      id: 'split-built',
      name: 'cordis:include',
      config: { path: pathToFileURL(splitPath).href },
    })
    if (evidence.terminalAllocations !== 0 || evidence.controllerAllocations !== 0) {
      throw new Error('Product allocated terminal resources before its split-row dependencies')
    }
    await loadTask
    await ctx.loader.await()

    const product = requireService(ctx, 'dshTuiProduct')
    requireService(ctx, 'dshTuiPreferences')
    await product.completion
    assertCompletedProduct(ctx, evidence, 'split rows')
    if (JSON.stringify(exits) !== JSON.stringify([0])) {
      throw new Error(`split Product exits were ${JSON.stringify(exits)}, expected [0]`)
    }
    const features = requireService(ctx, 'dshTuiFeatures')
    assertBuiltInFeaturesRegistered(features, 'split rows')

    const rows = loaderRows(ctx, [
      'split-product',
      'split-settings',
      'split-mcp',
      'split-tools',
      'split-skills',
      'split-modes',
      'split-models',
      'split-diff',
      'split-sessions',
      'split-adapter',
      'split-legacy',
      'split-preferences',
      'split-kernel',
    ])
    assertRowInject(rows.get('split-product'), productRow.inject)
    assertRowInject(rows.get('split-settings'), settingsRow.inject)
    assertRowInject(rows.get('split-mcp'), mcpRow.inject)
    assertRowInject(rows.get('split-tools'), toolsRow.inject)
    assertRowInject(rows.get('split-skills'), skillsRow.inject)
    assertRowInject(rows.get('split-modes'), modesRow.inject)
    assertRowInject(rows.get('split-models'), modelsRow.inject)
    assertRowInject(rows.get('split-diff'), diffRow.inject)
    assertRowInject(rows.get('split-sessions'), sessionsRow.inject)
    assertRowInject(rows.get('split-adapter'), adapterRow.inject)
    assertRowInject(rows.get('split-legacy'), legacyRow.inject)
    assertRowInject(rows.get('split-preferences'), preferencesRow.inject)
    assertRowInject(rows.get('split-kernel'), kernelRow.inject)
  } finally {
    await ctx.fiber.dispose()
    assertServicesRevoked(ctx, 'split rows')
    productRow.DshTuiProductRunner.prototype.start = originalRunnerStart
  }
}

async function verifyRootCompatibility() {
  const ctx = new Context()
  const exits = []
  try {
    await installHostRequirements(ctx)
    ctx.provide('cmdlineArgs', { get: () => [] })
    ctx.provide('appExit', code => { exits.push(code) })
    await installLoader(ctx)
    const evidence = installSafeProductRun(ctx, 'root compatibility composer')
    if (ctx.loader.unwrapExports(built) !== built) {
      throw new Error('Loader changed the built DSH-TUI namespace')
    }

    const rootPath = join(tempDirectory, 'root-compatibility.json')
    await writeFile(rootPath, JSON.stringify([{
      id: 'root-compatibility',
      name: pathToFileURL(resolve(projectRoot, 'lib/index.js')).href,
      config: { autoStart: true },
    }], null, 2), 'utf8')
    await ctx.loader.create({
      id: 'root-built',
      name: 'cordis:include',
      config: { path: pathToFileURL(rootPath).href },
    })
    await ctx.loader.await()

    const runtime = requireService(ctx, 'dshTui')
    const features = requireService(ctx, 'dshTuiFeatures')
    requireService(ctx, 'dshTuiLegacyChat')
    requireService(ctx, 'dshTuiPreferences')
    const product = requireService(ctx, 'dshTuiProduct')
    await product.completion
    assertCompletedProduct(ctx, evidence, 'root compatibility composer')
    if (JSON.stringify(exits) !== JSON.stringify([0])) {
      throw new Error(`root compatibility exits were ${JSON.stringify(exits)}, expected [0]`)
    }
    if (typeof runtime.catalog?.listSessions !== 'function') {
      throw new Error('root compatibility composer omitted its session catalog')
    }
    assertBuiltInFeaturesRegistered(features, 'root compatibility composer')
    const catalog = await runtime.catalog.listSessions()
    if (catalog.durability !== 'unavailable' || catalog.sessions.length !== 0) {
      throw new Error('root session catalog did not tolerate an absent persistence backend')
    }

    const rows = loaderRows(ctx, ['root-compatibility'])
    assertRowInject(rows.get('root-compatibility'), [
      'agentDefaultModel',
      'agentPresets',
      'agents',
      'approval',
      'commands',
      'llm',
      'sessions',
      'tools',
      'userQuestions',
    ])
  } finally {
    await ctx.fiber.dispose()
    assertServicesRevoked(ctx, 'root compatibility composer')
  }
}

async function installHostRequirements(ctx) {
  ctx.baseUrl = `${pathToFileURL(tempDirectory).href}/`
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentDefaultModel, { provider: 'smoke', model: 'smoke' })
  ctx.provide('agentPresets', {})
  ctx.provide('tools', { schemas: () => [] })
  await ctx.plugin(Commands)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(UserQuestionService)
}

async function installLoader(ctx) {
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
}

function installSafeProductRun(ctx, label) {
  const evidence = {
    terminalAllocations: 0,
    controllerAllocations: 0,
    sessionReleases: 0,
    earlyTerminalAllocation: false,
  }
  const terminal = {
    state: 'idle',
    viewport: { columns: 100, rows: 30 },
    start() {},
    handoff() {},
    render() {},
    stopAcceptingInput() {},
    restore() { this.state = 'restored' },
  }
  const createTerminal = () => {
    evidence.terminalAllocations += 1
    if (!hasProductDependencies(ctx)) evidence.earlyTerminalAllocation = true
    terminal.state = 'idle'
    return terminal
  }
  const createController = (options) => {
    evidence.controllerAllocations += 1
    let state = 'idle'
    let completion
    const settle = async () => {
      if (completion !== undefined) return await completion
      completion = (async () => {
        state = 'stopped'
        await options.sessionRelease?.()
        terminal.restore()
        return {
          ok: true,
          reason: 'user',
          shutdown: { mode: 'graceful', issues: [] },
        }
      })()
      return await completion
    }
    return {
      get state() { return state },
      async start() { state = 'running' },
      requestExit: settle,
      wait: settle,
    }
  }
  ctx.provide('dshTuiProductEnvironment', productRow.createDshTuiProductEnvironment({
    createTerminal,
    createController,
  }))
  productRow.DshTuiProductRunner.prototype.start = function () {
    assertProductDependencies(ctx, label)
    const runtime = ctx.get('dshTui')
    const port = {
      sessionId: 'built-loader-session',
      dispose: async () => {},
    }
    runtime.openSession = async () => ({
      core: { sessionId: port.sessionId },
      capabilities: {
        acquire: async () => { throw new Error('loader smoke did not request a capability') },
      },
      asLegacyPort: async () => port,
      release: async () => { evidence.sessionReleases += 1 },
    })
    runtime.open = async () => port
    return originalRunnerStart.call(this)
  }
  return evidence
}

function assertCompletedProduct(ctx, evidence, label) {
  assertProductDependencies(ctx, label)
  if (evidence.earlyTerminalAllocation) {
    throw new Error(`${label} allocated a terminal before every Product dependency was visible`)
  }
  if (evidence.terminalAllocations !== 1 || evidence.controllerAllocations !== 1) {
    throw new Error(
      `${label} allocations were terminal=${evidence.terminalAllocations}, controller=${evidence.controllerAllocations}`,
    )
  }
  if (evidence.sessionReleases !== 1) {
    throw new Error(`${label} released its fake session ${evidence.sessionReleases} times`)
  }
}

function hasProductDependencies(ctx) {
  return ctx.get('dshTuiFeatures') !== undefined
    && ctx.get('dshTuiLegacyChat') !== undefined
    && ctx.get('dshTui') !== undefined
    && ctx.get('dshTuiPreferences') !== undefined
    && ctx.get('cmdlineArgs') !== undefined
    && ctx.get('appExit') !== undefined
}

function assertProductDependencies(ctx, label) {
  if (!hasProductDependencies(ctx)) {
    throw new Error(`${label} started Product before its inject DAG was satisfied`)
  }
}

function loaderRows(ctx, ids) {
  const entries = [...ctx.loader.entries()]
  const rows = new Map()
  for (const id of ids) {
    const entry = entries.find(candidate => candidate.options.id === id)
    if (entry?.fiber === undefined) {
      throw new Error(`built Loader row ${id} did not activate`)
    }
    rows.set(id, entry)
  }
  return rows
}

function assertRowInject(entry, expected) {
  const actual = Object.keys(entry.fiber.inject).sort()
  const normalizedExpected = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(
      `${entry.options.id} inject is ${actual.join(', ')}, expected ${normalizedExpected.join(', ')}`,
    )
  }
}

function assertBuiltInFeaturesRegistered(features, label) {
  for (const featureId of [
    'sessions', 'diff', 'models', 'modes', 'skills', 'tools', 'mcp', 'settings',
  ]) {
    if (features.status(featureId) === undefined) {
      throw new Error(`${label} omitted the built-in ${featureId} Feature`)
    }
  }
}

function requireService(ctx, name) {
  const service = ctx.get(name)
  if (service === undefined) throw new Error(`built Loader smoke omitted ctx.${name}`)
  return service
}

function assertServicesRevoked(ctx, label) {
  const survivors = [
    'dshTuiProduct',
    'dshTui',
    'dshTuiLegacyChat',
    'dshTuiPreferences',
    'dshTuiFeatures',
    'dshTuiProductEnvironment',
  ].filter(name => ctx.get(name) !== undefined)
  if (survivors.length !== 0) {
    throw new Error(`${label} disposal retained services: ${survivors.join(', ')}`)
  }
}
