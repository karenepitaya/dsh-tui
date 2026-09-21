import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const direct = await import('../lib/index.js')
const self = await import('dsh-tui')
const experimental = await import('dsh-tui/experimental')
const kernel = await import('dsh-tui/kernel')
const cordisAdapter = await import('dsh-tui/adapters/cordis')
const dshRc2Adapter = await import('dsh-tui/adapters/dsh-rc2')
const preferencesAdapter = await import('dsh-tui/adapters/preferences')
const legacyChat = await import('dsh-tui/features/legacy-chat')
const sessions = await import('dsh-tui/features/sessions')
const activity = await import('dsh-tui/features/activity')
const diff = await import('dsh-tui/features/diff')
const models = await import('dsh-tui/features/models')
const modes = await import('dsh-tui/features/modes')
const capabilities = await import('dsh-tui/features/capabilities')
const product = await import('dsh-tui/product')

const expectedKeys = ['Config', 'apply', 'inject', 'name']
for (const [label, module] of [['direct', direct], ['self', self]]) {
  assertExactExports(label, module, expectedKeys)
  assertMetadata(label, module, {
    name: 'dsh-tui',
    inject: [
      'agentDefaultModel',
      'agentPresets',
      'agents',
      'approval',
      'commands',
      'llm',
      'sessions',
      'tools',
      'userQuestions',
    ],
  })
}

for (const key of [
  'FEATURE_API_VERSION',
  'createCapabilityToken',
  'createNavigationState',
  'createSlotRegistry',
]) {
  if (!(key in experimental)) {
    throw new Error(`experimental DSH-TUI entrypoint omitted ${key}`)
  }
}
if ('default' in experimental) {
  throw new Error('experimental DSH-TUI entrypoint must not export default')
}

for (const key of ['FEATURE_API_VERSION', 'FeatureRegistry']) {
  if (!(key in kernel)) throw new Error(`kernel entrypoint omitted ${key}`)
}
if ('default' in kernel) throw new Error('kernel entrypoint must not export default')

for (const row of [
  {
    label: 'Cordis kernel row',
    module: cordisAdapter,
    exports: [
      'CordisDshTuiFeatureService',
      'apply',
      'inject',
      'name',
      'provide',
      'provideDshTuiFeatures',
    ],
    name: 'dsh-tui-kernel',
    inject: [],
    provide: 'dshTuiFeatures',
  },
  {
    label: 'legacy Chat row',
    module: legacyChat,
    exports: ['apply', 'inject', 'legacyChatFeature', 'name', 'provide'],
    name: 'dsh-tui-legacy-chat',
    inject: ['dshTuiFeatures'],
    provide: 'dshTuiLegacyChat',
  },
  {
    label: 'DSH rc.2 adapter row',
    module: dshRc2Adapter,
    exports: [
      'apply',
      'inject',
      'mountDshTuiDshRc2Adapter',
      'name',
      'provide',
      'provideDshTuiRuntime',
    ],
    name: 'dsh-tui-dsh-rc2',
    inject: [
      'dshTuiFeatures',
      'agentDefaultModel',
      'agentPresets',
      'agents',
      'approval',
      'commands',
      'llm',
      'sessions',
      'tools',
      'userQuestions',
    ],
    provide: 'dshTui',
  },
  {
    label: 'Preferences adapter row',
    module: preferencesAdapter,
    exports: [
      'DSH_TUI_PREFERENCES_CAPABILITY',
      'DSH_TUI_PREFERENCES_SCHEMA',
      'apply',
      'inject',
      'mountDshTuiPreferencesAdapter',
      'name',
      'provide',
      'provideDshTuiPreferencesSettings',
    ],
    name: 'dsh-tui-preferences',
    inject: ['dshTuiFeatures'],
    provide: 'dshTuiPreferences',
  },
  {
    label: 'Product row',
    module: product,
    exports: [
      'DshTuiProductRunner',
      'apply',
      'consumeProductTask',
      'createDshTuiProductEnvironment',
      'inject',
      'mountDshTuiProduct',
      'name',
      'provide',
      'sanitizeDshTuiProductError',
    ],
    name: 'dsh-tui-product',
    inject: [
      'dshTuiFeatures',
      'dshTuiLegacyChat',
      'dshTui',
      'dshTuiPreferences',
      'cmdlineArgs',
      'appExit',
    ],
    provide: 'dshTuiProduct',
  },
]) {
  assertExactExports(row.label, row.module, row.exports)
  assertMetadata(row.label, row.module, row)
}

for (const row of [
  {
    label: 'Sessions row',
    module: sessions,
    exports: ['apply', 'inject', 'name', 'sessionsFeature'],
    name: 'dsh-tui-sessions',
    inject: ['dshTuiFeatures'],
  },
  {
    label: 'Activity row',
    module: activity,
    exports: ['activityFeature', 'apply', 'inject', 'name'],
    name: 'dsh-tui-activity',
    inject: ['dshTuiFeatures'],
  },
  {
    label: 'Diff row',
    module: diff,
    exports: ['apply', 'diffFeature', 'inject', 'name'],
    name: 'dsh-tui-diff',
    inject: ['dshTuiFeatures'],
  },
  {
    label: 'Models row',
    module: models,
    exports: ['apply', 'inject', 'modelsFeature', 'name'],
    name: 'dsh-tui-models',
    inject: ['dshTuiFeatures'],
  },
  {
    label: 'Modes row',
    module: modes,
    exports: ['apply', 'inject', 'modesFeature', 'name'],
    name: 'dsh-tui-modes',
    inject: ['dshTuiFeatures'],
  },
  {
    label: 'Capabilities row',
    module: capabilities,
    exports: ['apply', 'inject', 'name', 'capabilitiesFeature'],
    name: 'dsh-tui-capabilities',
    inject: ['dshTuiFeatures'],
  },
]) {
  assertHasExports(row.label, row.module, row.exports)
  assertMetadata(row.label, row.module, row)
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const compilerOptions = {
  allowImportingTsExtensions: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2024,
  types: ['node'],
}

assertDeclarationConsumer('root', `
import { Context } from '@deepseek-ai/cordis'
import {
  apply,
  name,
  type OpenDshTuiSessionOptions,
} from 'dsh-tui'

declare const ctx: Context
declare const request: OpenDshTuiSessionOptions
apply(ctx, { autoStart: false })
void [name, request]
`)

assertDeclarationConsumer('experimental', `
import { Context } from '@deepseek-ai/cordis'
import type {
  DshTuiFeatureService,
  FeatureFactory,
} from 'dsh-tui/experimental'

declare const ctx: Context
declare const feature: FeatureFactory
const service: DshTuiFeatureService = ctx.dshTuiFeatures
service.registerFeature(feature)
ctx.get('dshTuiFeatures')
ctx.effect(() => () => {})
`)

assertDeclarationConsumer('explicit-subpaths', `
import type { FeatureFactory } from 'dsh-tui/kernel'
import type { DshTuiFeatureOwner } from 'dsh-tui/adapters/cordis'
import type { DshTuiRuntimeOwner } from 'dsh-tui/adapters/dsh-rc2'
import type {
  DshTuiPreferencesAdapterMount,
  DshTuiPreferencesApplicationPort,
} from 'dsh-tui/adapters/preferences'
import { legacyChatFeature } from 'dsh-tui/features/legacy-chat'
import {
  sessionsFeature,
  type SessionsWorkspacePort,
} from 'dsh-tui/features/sessions'
import {
  activityFeature,
  type ActivityFeatureInstance,
} from 'dsh-tui/features/activity'
import {
  diffFeature,
  type DiffWorkspacePort,
} from 'dsh-tui/features/diff'
import {
  modelsFeature,
  type ModelsFeatureInstance,
} from 'dsh-tui/features/models'
import {
  modesFeature,
  type ModesFeatureInstance,
} from 'dsh-tui/features/modes'
import {
  capabilitiesFeature,
  type CapabilitiesFeatureInstance,
} from 'dsh-tui/features/capabilities'
import type { DshTuiProductRunnerOptions } from 'dsh-tui/product'
import { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
const feature: FeatureFactory = legacyChatFeature
declare const featureOwner: DshTuiFeatureOwner
declare const runtimeOwner: DshTuiRuntimeOwner
declare const preferencesOwner: DshTuiPreferencesAdapterMount
declare const preferencesPort: DshTuiPreferencesApplicationPort
declare const productOptions: DshTuiProductRunnerOptions
declare const sessionsPort: SessionsWorkspacePort
declare const activityInstance: ActivityFeatureInstance
declare const diffPort: DiffWorkspacePort
declare const modelsInstance: ModelsFeatureInstance
declare const modesInstance: ModesFeatureInstance
declare const capabilitiesInstance: CapabilitiesFeatureInstance
ctx.dshTuiFeatures.start()
ctx.dshTui.catalog.listSessions()
ctx.dshTuiLegacyChat.featureId
ctx.dshTuiProduct.dispose()
void [
  feature,
  sessionsFeature,
  activityFeature,
  diffFeature,
  modelsFeature,
  modesFeature,
  capabilitiesFeature,
  featureOwner,
  runtimeOwner,
  preferencesOwner,
  preferencesPort,
  productOptions,
  sessionsPort,
  activityInstance,
  diffPort,
  modelsInstance,
  modesInstance,
  capabilitiesInstance,
]
`)

for (const [label, declaration] of [
  ['root compatibility composer', 'lib/index.d.ts'],
  ['experimental', 'lib/experimental.d.ts'],
  ['kernel', 'lib/kernel-entry.d.ts'],
  ['Cordis adapter', 'lib/adapters/cordis.d.ts'],
  ['DSH rc.2 adapter', 'lib/adapters/dsh-rc2.d.ts'],
  ['Preferences adapter', 'lib/adapters/preferences.d.ts'],
  ['legacy Chat feature', 'lib/features/legacy-chat-entry.d.ts'],
  ['Sessions feature', 'lib/features/sessions-entry.d.ts'],
  ['Activity feature', 'lib/features/activity-entry.d.ts'],
  ['Diff feature', 'lib/features/diff-entry.d.ts'],
  ['Models feature', 'lib/features/models-entry.d.ts'],
  ['Modes feature', 'lib/features/modes-entry.d.ts'],
  ['Capabilities feature', 'lib/features/capabilities-entry.d.ts'],
  ['product', 'lib/product.d.ts'],
]) {
  assertDeclarationGraphHasNoDshImports(label, join(packageRoot, declaration))
}

function assertExactExports(label, module, expected) {
  const keys = Object.keys(module).sort()
  const expectedKeys = [...expected].sort()
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${label} built DSH-TUI exports ${keys.join(', ')}, expected ${expectedKeys.join(', ')}`,
    )
  }
  if ('default' in module) {
    throw new Error(`${label} function plugin must not export default`)
  }
}

function assertHasExports(label, module, expected) {
  for (const key of expected) {
    if (!(key in module)) {
      throw new Error(`${label} built DSH-TUI entrypoint omitted ${key}`)
    }
  }
  if ('default' in module) {
    throw new Error(`${label} function plugin must not export default`)
  }
}

function assertMetadata(label, module, expected) {
  if (module.name !== expected.name) {
    throw new Error(`${label} name is ${String(module.name)}, expected ${expected.name}`)
  }
  if (JSON.stringify(module.inject) !== JSON.stringify(expected.inject)) {
    throw new Error(
      `${label} inject is ${JSON.stringify(module.inject)}, expected ${JSON.stringify(expected.inject)}`,
    )
  }
  if ('provide' in expected && module.provide !== expected.provide) {
    throw new Error(
      `${label} provide is ${String(module.provide)}, expected ${expected.provide}`,
    )
  }
}

function assertDeclarationConsumer(label, consumerSource) {
  const consumerPath = join(packageRoot, `__${label}-consumer__.ts`)
  const normalizePath = path => path.replaceAll('\\', '/').toLowerCase()
  const normalizedConsumerPath = normalizePath(consumerPath)
  const host = ts.createCompilerHost(compilerOptions)
  const getSourceFile = host.getSourceFile.bind(host)
  host.fileExists = (path) => normalizePath(path) === normalizedConsumerPath
    || ts.sys.fileExists(path)
  host.readFile = (path) => normalizePath(path) === normalizedConsumerPath
    ? consumerSource
    : ts.sys.readFile(path)
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => (
    normalizePath(path) === normalizedConsumerPath
      ? ts.createSourceFile(path, consumerSource, languageVersion, true)
      : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
  )
  const program = ts.createProgram([consumerPath], compilerOptions, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length === 0) return
  throw new Error(
    `${label} DSH-TUI declaration consumer failed:\n`
    + ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: path => path,
        getCurrentDirectory: () => packageRoot,
        getNewLine: () => '\n',
      }),
  )
}

function assertDeclarationGraphHasNoDshImports(label, entryPath) {
  const queue = [entryPath]
  const visited = new Set()
  const offenders = []
  while (queue.length > 0) {
    const declarationPath = resolve(queue.pop())
    if (visited.has(declarationPath)) continue
    visited.add(declarationPath)
    const source = readFileSync(declarationPath, 'utf8')
    const dshImports = [...source.matchAll(
      /(?:from\s+|import\s*\()\s*['"](@deepseek-ai\/dsh-[^'"]+)['"]/gu,
    )].map(match => match[1])
    if (dshImports.length > 0) {
      offenders.push(
        `${relative(packageRoot, declarationPath)}: ${dshImports.join(', ')}`,
      )
    }
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/gu,
    )) {
      const resolved = resolveDeclaration(dirname(declarationPath), match[1])
      if (resolved !== undefined) queue.push(resolved)
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `${label} public declaration graph references official DSH packages:\n`
      + offenders.sort().join('\n'),
    )
  }
}

function resolveDeclaration(parent, specifier) {
  const target = resolve(parent, specifier)
  const candidates = specifier.endsWith('.js')
    ? [`${target.slice(0, -3)}.d.ts`]
    : [`${target}.d.ts`, join(target, 'index.d.ts')]
  return candidates.find(candidate => existsSync(candidate))
}
