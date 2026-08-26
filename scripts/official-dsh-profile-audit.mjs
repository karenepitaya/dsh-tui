import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Exact rc.2 agent-plane rows that the profile must keep disabled globally. */
export const DISABLED_AGENT_PLANE = Object.freeze([
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-str-replace-editor',
  'skill-filesystem',
  'tool-skill',
  'tool-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
  'agent-instructions',
  'tool-todo',
  'tool-web',
])

const SHIPPED_PRESET_IDS = Object.freeze(['standard', 'code', 'minimal', 'cordis'])
const GENERATION_REGISTRY_KEY = Symbol.for('dsh-tui.official-profile-audit.generations')
const FIBER_STATE_LABELS = Object.freeze({
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
})

export const name = 'dsh-tui-official-profile-audit'
export const inject = [
  'agentDefaultModel',
  'agentPresets',
  'agents',
  'codeRuntime',
  'cordisInspect',
  'dynamicCordisRunner',
  'dshTui',
  'loader',
  'tools',
]

function toolNames(ctx, scope) {
  return ctx.tools.schemas(scope).map(tool => tool.name).sort()
}

function presetEvidence(preset) {
  return {
    id: preset.id,
    trust: preset.trust,
    path: resolve(preset.path),
    broken: preset.broken ?? null,
  }
}

function errorEvidence(phase, error) {
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  return {
    phase,
    name,
    message,
    ...(stack === undefined ? {} : { stack }),
  }
}

function loaderEntryEvidence(entry, hostTree) {
  const fiber = entry.fiber
  const state = fiber === undefined
    ? entry.disabled ? 'disabled' : 'missing'
    : FIBER_STATE_LABELS[fiber.state] ?? `unknown:${String(fiber.state)}`
  const missingServices = fiber?.state === 0
    ? Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined).sort()
    : []
  return {
    id: entry.id,
    localId: entry.options.id,
    name: entry.options.name,
    config: structuredClone(entry.options.config ?? null),
    disabled: entry.disabled,
    state,
    active: fiber?.state === 2,
    missingServices,
    hostComposition: entry.parent.tree === hostTree,
    ownerEntryId: entry.parent.tree.ctx.fiber.entry?.options.id ?? null,
  }
}

function hostCompositionTree(ctx) {
  // app-boot pins this bootstrap entry to `include`; its subtree is the final
  // profile after every bundle and user patch. Loader.entries() is recursive,
  // so local ids alone are insufficient once preset subtrees are mounted.
  const bootstrap = ctx.loader.resolve('include')
  const hostTree = bootstrap.subtree
  if (hostTree === undefined) {
    throw new Error('official DSH profile audit found no subtree on the bootstrap include')
  }
  return hostTree
}

function directHostEntry(hostTree, localId) {
  const entry = hostTree.store[localId]
  if (entry === undefined) return undefined
  if (entry.options.id !== localId || entry.parent.tree !== hostTree) {
    throw new Error(`official DSH profile audit rejected a non-host Loader row for ${localId}`)
  }
  return entry
}

async function settleLoaderAcrossPostBootTurns(ctx) {
  // `runProfile()` adds the watch-only timer/HMR fallback after the initial
  // app-boot await resolves. Yielding twice lets both sequential creates land;
  // each following await then proves the expanded host tree is quiescent.
  await ctx.loader.await()
  await new Promise(resolveImmediate => setImmediate(resolveImmediate))
  await ctx.loader.await()
  await new Promise(resolveImmediate => setImmediate(resolveImmediate))
  await ctx.loader.await()
}

async function collectHostEvidence(ctx, freshReady, isCurrent) {
  // The audit must not turn a fresh launch into a warm preset launch. Capture
  // the first root Agent, including its already-composed standard catalog,
  // before asking AgentPresets to materialize any standing reader scopes.
  const fresh = await freshReady
  if (fresh === undefined || !isCurrent()) return undefined

  await settleLoaderAcrossPostBootTurns(ctx)
  if (!isCurrent()) return undefined

  const roster = await ctx.agentPresets.list()
  const resolvedDefault = await ctx.agentPresets.resolve()
  const catalogs = {}
  for (const id of SHIPPED_PRESET_IDS) {
    if (!isCurrent()) return undefined
    const scope = await ctx.agentPresets.standingKeyFor(id)
    catalogs[id] = toolNames(ctx, scope)
  }
  if (!isCurrent()) return undefined

  const codeRuntimeResult = await ctx.codeRuntime.run({
    program: 'const ready: boolean = true; return { ready }',
    bindings: [],
  })
  if (codeRuntimeResult.error !== undefined
    || codeRuntimeResult.logs.length !== 0
    || codeRuntimeResult.value?.ready !== true) {
    throw new Error(`official DSH profile audit code-runtime smoke failed: ${JSON.stringify(codeRuntimeResult)}`)
  }
  const cordisRunnerInventory = ctx.dynamicCordisRunner.inventory()
  const cordisInspectProviders = ctx.cordisInspect.list()
  const providerSnapshot = await ctx.dshTui.providers.list()
  if (!Array.isArray(cordisRunnerInventory) || !Array.isArray(cordisInspectProviders)) {
    throw new Error('official DSH profile audit received a non-array Cordis inventory')
  }

  await ctx.loader.await()
  const entries = [...ctx.loader.entries()]
  const hostTree = hostCompositionTree(ctx)
  const agentPlane = DISABLED_AGENT_PLANE.map((id) => {
    const entry = directHostEntry(hostTree, id)
    return {
      id,
      present: entry !== undefined,
      disabled: entry?.disabled === true,
      active: entry?.fiber?.state === 2,
    }
  })
  const loaderEntries = entries
    .map(entry => loaderEntryEvidence(entry, hostTree))
    .sort((left, right) => left.id.localeCompare(right.id))

  return {
    fresh,
    host: {
      agentPlane,
      globalTools: toolNames(ctx),
      currentDefaultModel: structuredClone(
        ctx.agentDefaultModel.currentSelection(),
      ),
      defaultId: ctx.agentPresets.defaultId,
      resolvedDefault: presetEvidence(resolvedDefault),
      roots: ctx.agentPresets.roots.map(root => ({
        path: resolve(root.path),
        trust: root.trust,
      })),
      roster: roster.map(presetEvidence),
      catalogs,
      catalogOrder: {
        freshSessionId: fresh.sessionId,
        standingPresetIds: [...SHIPPED_PRESET_IDS],
      },
      loaderBuiltins: {
        include: ctx.loader.builtins.include !== undefined,
        group: ctx.loader.builtins.group !== undefined,
      },
      loaderEntries,
      hostServices: {
        // Preserve the original shape while adding the exercised service facts.
        codeRuntimeRun: typeof ctx.codeRuntime.run === 'function',
        cordisInspectList: typeof ctx.cordisInspect.list === 'function',
        cordisRunnerInventory: typeof ctx.dynamicCordisRunner.inventory === 'function',
        codeRuntime: {
          language: ctx.codeRuntime.language,
          isolation: ctx.codeRuntime.isolation,
          result: {
            value: codeRuntimeResult.value ?? null,
            logs: [...codeRuntimeResult.logs],
            error: codeRuntimeResult.error ?? null,
          },
        },
        dynamicCordisRunner: {
          inventory: structuredClone(cordisRunnerInventory),
        },
        cordisInspect: {
          providers: structuredClone(cordisInspectProviders),
        },
        dshTuiProviders: {
          writable: providerSnapshot.writable,
          providers: providerSnapshot.providers.map(provider => ({
            id: provider.id,
            name: provider.name,
            active: provider.active,
            configured: provider.configured,
            connected: provider.connected,
            credential: {
              kind: provider.credential.kind,
              configured: provider.credential.configured,
              writable: provider.credential.writable,
            },
            methods: provider.methods.map(method => ({ id: method.id, label: method.label })),
            canDisconnect: provider.canDisconnect,
          })),
        },
      },
    },
  }
}

function collectFreshAgentEvidence(ctx, agent) {
  return {
    agentId: String(agent.id),
    sessionId: String(agent.session.id),
    registered: ctx.agents.get(agent.id) === agent,
    header: structuredClone(agent.session.header),
    options: {
      provider: agent.options.provider,
      model: agent.options.model,
      maxTokens: agent.options.maxTokens ?? null,
    },
    composedPreset: ctx.agentPresets.composedPreset(agent.ctx) ?? null,
    scopedTools: toolNames(ctx, agent),
  }
}

function generationRegistry() {
  const existing = globalThis[GENERATION_REGISTRY_KEY]
  if (existing instanceof Map) return existing
  const registry = new Map()
  Object.defineProperty(globalThis, GENERATION_REGISTRY_KEY, {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  })
  return registry
}

function publicationStateFor(evidencePath) {
  const registry = generationRegistry()
  let state = registry.get(evidencePath)
  if (state !== undefined) return state
  state = {
    current: undefined,
    requested: undefined,
    tail: Promise.resolve(),
  }
  registry.set(evidencePath, state)
  return state
}

function serializePublication(state, operation) {
  const result = state.tail.then(operation, operation)
  state.tail = result.catch(() => {})
  return result
}

async function removeEvidenceOwnedBy(evidencePath, nonce) {
  try {
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    if (evidence?.auditGeneration === nonce) {
      await rm(evidencePath, { force: true })
    }
  } catch (error) {
    // An absent path is already clean. Never delete an unreadable path because
    // it may belong to a newer generation that is publishing concurrently.
    if (error?.code !== 'ENOENT') return
  }
}

export function ownPublicationGeneration(ctx, evidencePath, cancelFreshWait, testHooks = {}) {
  const state = publicationStateFor(evidencePath)
  const ready = Promise.withResolvers()
  // Production observes setup failure through the owning Loader fiber. Keep
  // the test-facing readiness promise handled even when no test awaits it.
  void ready.promise.catch(() => {})
  const generation = {
    nonce: `${String(process.pid)}-${randomUUID()}`,
    disposed: false,
    failureImmediate: undefined,
    installed: false,
    publicationTask: undefined,
    ready: ready.promise,
  }
  generation.stagingPath = `${evidencePath}.${generation.nonce}.tmp`
  generation.isCurrent = () => generation.installed
    && !generation.disposed
    && state.requested === generation
    && state.current === generation
  // Invalidate the previous generation's guards immediately, even while this
  // generation waits for the serialized filesystem installation.
  state.requested = generation

  ctx.effect(async () => {
    // A cache-busted HMR import still shares this process-wide Symbol registry,
    // and every fixed-path mutation is serialized on the shared per-path tail.
    // Removing the old fixed evidence before marking this generation installed
    // prevents the parent poller from accepting a prior generation after this
    // setup has completed.
    try {
      await serializePublication(state, async () => {
        await testHooks.beforeInstall?.()
        await rm(evidencePath, { force: true })
        state.current = generation
        generation.installed = true
      })
      ready.resolve()
    } catch (error) {
      generation.disposed = true
      if (state.requested === generation) state.requested = state.current
      ready.reject(error)
      throw error
    }
    return async () => {
      generation.disposed = true
      if (generation.failureImmediate !== undefined) {
        clearImmediate(generation.failureImmediate)
        generation.failureImmediate = undefined
      }
      cancelFreshWait()
      await generation.publicationTask?.catch(() => {})
      await serializePublication(state, async () => {
        await rm(generation.stagingPath, { force: true })
        await removeEvidenceOwnedBy(evidencePath, generation.nonce)
        if (state.current === generation) state.current = undefined
        if (state.requested === generation) state.requested = undefined
      })
    }
  }, 'dsh-tui official profile audit generation')

  return generation
}

export async function writeEvidenceAtomically(evidencePath, evidence, generation) {
  const payload = { ...evidence, auditGeneration: generation.nonce }
  const state = publicationStateFor(evidencePath)
  await serializePublication(state, async () => {
    if (!generation.isCurrent()) return
    await writeFile(
      generation.stagingPath,
      JSON.stringify(payload),
      { encoding: 'utf8', flag: 'wx' },
    )
    if (!generation.isCurrent()) {
      await rm(generation.stagingPath, { force: true })
      return
    }
    await rename(generation.stagingPath, evidencePath)
    if (!generation.isCurrent()) {
      await removeEvidenceOwnedBy(evidencePath, generation.nonce)
    }
  })
}

export async function apply(ctx, testHooks = {}) {
  const evidencePath = process.env.DSH_TUI_E2E_PROFILE_AUDIT_PATH
  if (evidencePath === undefined || evidencePath.trim() === '') {
    throw new Error('official DSH profile audit is missing its evidence path')
  }

  const freshReady = Promise.withResolvers()
  const generation = ownPublicationGeneration(
    ctx,
    evidencePath,
    () => { freshReady.resolve(undefined) },
    testHooks,
  )
  let publicationStarted = false
  let freshCaptured = false

  // Await only the fixed-path generation install. This makes an install
  // failure reject the Loader-owned plugin apply and guarantees the listener
  // exists before any Agent can pass the Loader barrier. The fresh Agent itself
  // remains detached below, so there is no Loader -> Agent -> Loader cycle.
  await generation.ready
  if (!generation.isCurrent()) return

  const publish = (evidence) => {
    if (publicationStarted || !generation.isCurrent()) return
    publicationStarted = true
    const publicationTask = writeEvidenceAtomically(evidencePath, evidence, generation)
    generation.publicationTask = publicationTask
    void publicationTask.catch((error) => {
      if (!generation.isCurrent()) return
      // The evidence path itself is broken, so a second write cannot report it.
      // Surface the failure through the process-wide fail-loud boundary instead.
      generation.failureImmediate = setImmediate(() => {
        generation.failureImmediate = undefined
        if (generation.isCurrent()) throw error
      })
    })
  }
  const publishFailure = (phase, error) => {
    publish({
      version: 2,
      ok: false,
      error: errorEvidence(phase, error),
    })
  }
  // Register before any await. DSH-TUI itself awaits the same Loader before it
  // creates its root Agent, so this observes the first fresh publication even
  // though the audit row follows the product row in the composed tree.
  ctx.on('agent/created', ({ agent }) => {
    if (!generation.isCurrent()) return
    const header = agent.session.header
    const isRoot = header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
    if (freshCaptured || !isRoot) return
    freshCaptured = true
    try {
      freshReady.resolve(collectFreshAgentEvidence(ctx, agent))
    } catch (error) {
      freshReady.resolve(undefined)
      publishFailure('fresh-agent', error)
    }
  })

  // Deliberately do not await or return this Promise from apply(): waiting for
  // a fresh Agent here would make that Agent wait on the Loader waiting on us.
  void collectHostEvidence(ctx, freshReady.promise, generation.isCurrent).then((evidence) => {
    if (evidence === undefined) return
    publish({
      version: 2,
      ok: true,
      ...evidence.host,
      fresh: evidence.fresh,
    })
  }).catch((error) => {
    publishFailure('host-audit', error)
  })
}
