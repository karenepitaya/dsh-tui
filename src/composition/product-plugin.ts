import type { Context } from '@deepseek-ai/cordis'
import { Command, CommanderError } from 'commander'
import {
  DshTuiController,
  type DshTuiControllerOptions,
} from '../app/controller.ts'
import { DshTuiFeatureHost } from '../app/feature-host.ts'
import { FeatureSessionRuntime } from '../app/feature-session-runtime.ts'
import { FeatureSurfaceRuntime } from '../app/feature-surface-runtime.ts'
import { SessionNavigationHost } from '../app/session-navigation-host.ts'
import { SESSION_NAVIGATION_CAPABILITY } from '../session/navigation-port.ts'
import {
  DshTuiProductRunner,
  sanitizeDshTuiProductError,
  type DshTuiControllerPort,
  type DshTuiOpenRequest,
  type DshTuiStartupRequest,
} from '../app/runner.ts'
import type { DshTuiFeatureService } from '../kernel/feature-service.ts'
import {
  installProcessTerminationHandlers,
  type ProcessTerminationEventSource,
} from '../lifecycle/process-termination.ts'
import { installBuiltinToolCardRenderers } from '../presentation/builtin-tool-card-renderers.ts'
import { ToolCardRendererRegistry } from '../presentation/tool-card-renderers.ts'
import type { DshTuiRuntimeService } from '../runtime/service.ts'
import type { DshTuiSessionLease } from '../session/binding.ts'
import {
  PiTerminalDriver,
  type TerminalDriver,
} from '../terminal/driver.ts'
import {
  createDshTuiTheme,
  type DshTuiTheme,
  type DshTuiThemeConfig,
} from '../ui/theme.ts'
import type { DshTuiLegacyChatMount } from './legacy-chat-plugin.ts'
import { PreferenceApplication } from '../preferences/application.ts'
import type { DshTuiPreferencesApplicationPort } from '../preferences/port.ts'

export interface ProductCmdlineArgs {
  get(): readonly string[]
}

/** Explicit bridge for a root composer whose same-fiber provides are not yet visible. */
export interface DshTuiProductMountDependencies {
  readonly features: DshTuiFeatureService
  readonly legacyChat: DshTuiLegacyChatMount
  readonly runtime: DshTuiRuntimeService
  readonly cmdlineArgs: ProductCmdlineArgs
  readonly appExit: (code: number) => void
  readonly preferences?: DshTuiPreferencesApplicationPort
}

export interface DshTuiProductMountOptions {
  /** A parent composer may parse once and hand the immutable launch request down. */
  readonly startup?: DshTuiStartupRequest
  /** Temporary adapter seam until the runtime contract owns launch resolution. */
  readonly resolveStartup?: (
    ctx: Context,
  ) => DshTuiStartupRequest | undefined
  readonly theme?: DshTuiThemeConfig
  /** Compatibility composers may own one explicit reverse-order dispose chain. */
  readonly lifecycle?: 'cordis' | 'external'
}

export interface DshTuiProductMount {
  readonly runner: DshTuiProductRunner
  /** Settles when the product run finishes or a startup failure is contained. */
  readonly completion: Promise<void>
  dispose(): Promise<void>
}

export interface DshTuiProductTerminalOptions {
  readonly theme: DshTuiTheme
}

/** Process-bound capabilities copied into one immutable Product mount boundary. */
export interface DshTuiProductEnvironment {
  readonly createTerminal: (
    options: DshTuiProductTerminalOptions,
  ) => TerminalDriver
  readonly createController: (
    options: DshTuiControllerOptions,
  ) => DshTuiControllerPort
  readonly process: ProcessTerminationEventSource
  readonly forceExit: (code: number) => void
  readonly reportError: (message: string) => void
}

export type DshTuiProductEnvironmentOverrides =
  Partial<DshTuiProductEnvironment>

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshTuiProduct: DshTuiProductMount
    /** Optional embedding/test seam; copied into one immutable mount environment. */
    dshTuiProductEnvironment: DshTuiProductEnvironmentOverrides
  }
}

export const name = 'dsh-tui-product'
export const inject = [
  'dshTuiFeatures',
  'dshTuiLegacyChat',
  'dshTui',
  'dshTuiPreferences',
  'cmdlineArgs',
  'appExit',
]
export const provide = 'dshTuiProduct'

/** Create a fresh environment; no Product mount shares mutable module state. */
export function createDshTuiProductEnvironment(
  overrides: DshTuiProductEnvironmentOverrides = {},
): DshTuiProductEnvironment {
  return Object.freeze({
    createTerminal: overrides.createTerminal
      ?? (options => new PiTerminalDriver({ theme: options.theme })),
    createController: overrides.createController
      ?? (options => new DshTuiController(options)),
    process: overrides.process ?? process,
    forceExit: overrides.forceExit ?? (code => { process.exit(code) }),
    reportError: overrides.reportError
      ?? (message => { process.stderr.write(message) }),
  })
}

/** Consume only invariant-breaking task rejection at the product boundary. */
export function consumeProductTask(
  task: Promise<void>,
  reportError: DshTuiProductEnvironment['reportError'],
): void {
  void task.catch((error: unknown) => {
    try {
      reportError(
        `dsh-tui: unexpected product task rejection: ${sanitizeDshTuiProductError(error)}\n`,
      )
    } catch {
      // A broken stderr seam must not create another unhandled rejection.
    }
  })
}

/** Cordis row entrypoint. Product resources are allocated only after all injections exist. */
export function apply(
  ctx: Context,
  options: DshTuiProductMountOptions = {},
  environment?: DshTuiProductEnvironmentOverrides,
): void {
  mountDshTuiProduct(
    ctx,
    options,
    undefined,
    environment ?? ctx.get('dshTuiProductEnvironment'),
  )
}

/**
 * Assemble the sole terminal-owning product layer. The runtime and Feature
 * kernel remain independently owned Cordis services.
 */
export function mountDshTuiProduct(
  ctx: Context,
  options: DshTuiProductMountOptions = {},
  suppliedDependencies?: DshTuiProductMountDependencies,
  suppliedEnvironment?: DshTuiProductEnvironmentOverrides,
): DshTuiProductMount | undefined {
  if (ctx.get('dshTuiProduct') !== undefined) {
    throw new Error('dsh-tui-product is already mounted in this Cordis scope')
  }
  const dependencies = requireProductDependencies(ctx, suppliedDependencies)
  const startup = options.startup
    ?? options.resolveStartup?.(ctx)
    ?? (options.resolveStartup === undefined
      ? parseDshTuiProductStartup(
          dependencies.cmdlineArgs.get(),
          dependencies.appExit,
        )
      : undefined)
  if (startup === undefined) return undefined

  const environment = createDshTuiProductEnvironment(suppliedEnvironment)
  const preferences = new PreferenceApplication(
    dependencies.preferences,
    options.theme,
    error => environment.reportError(`dsh-tui preferences: ${sanitizeDshTuiProductError(error)}\n`),
  )
  const featureHost = new DshTuiFeatureHost(dependencies.features, {
    navigationKeys: () => preferences.snapshot().navigationKeys,
  })
  const featureSession = new FeatureSessionRuntime(
    dependencies.features,
    new FeatureSurfaceRuntime(featureHost, undefined, () => preferences.snapshot().layoutMode),
  )
  let productTerminal: TerminalDriver | undefined
  let appliedTheme = JSON.stringify(preferences.snapshot().theme)
  let appliedLayout = preferences.snapshot().layoutMode
  const stopPreferences = preferences.onChanged(value => {
    const theme = JSON.stringify(value.theme)
    const themeChanged = theme !== appliedTheme
    const layoutChanged = value.layoutMode !== appliedLayout
    appliedTheme = theme
    appliedLayout = value.layoutMode
    if (themeChanged) productTerminal?.updateTheme?.(createDshTuiTheme(value.theme))
    if (themeChanged || layoutChanged) {
      consumeProductTask(featureSession.themeChanged(), environment.reportError)
    }
  })
  const sessionNavigation = new SessionNavigationHost()
  const navigationRegistration = dependencies.features.registerCapability({
    token: SESSION_NAVIGATION_CAPABILITY,
    create: () => ({ value: sessionNavigation, release: () => {} }),
  })
  const toolCards = new ToolCardRendererRegistry()
  installBuiltinToolCardRenderers(ctx, toolCards)
  const runner = new DshTuiProductRunner({
    startup,
    catalog: dependencies.runtime.catalog,
    activation: dependencies.runtime.activation,
    inspection: dependencies.runtime.inspection,
    fork: dependencies.runtime.fork,
    providers: dependencies.runtime.providers,
    settings: dependencies.runtime.settings,
    pluginInventory: dependencies.runtime.pluginInventory,
    features: featureHost,
    featureSession,
    sessionNavigation,
    preferences,
    open: request => openProductSession(dependencies.runtime, request),
    createTerminal: () => {
      productTerminal = environment.createTerminal({ theme: createDshTuiTheme(preferences.snapshot().theme) })
      return productTerminal
    },
    createController: controllerOptions => (
      environment.createController(controllerOptions)
    ),
    toolCards,
    appExit: dependencies.appExit,
    forceExit: code => { environment.forceExit(code) },
    reportError: message => { environment.reportError(message) },
    disposeOwner: () => {},
  })

  let active = true
  const stopFeatureUnload = dependencies.features.onActiveFeatureUnloaded(
    event => active ? featureHost.handleActiveFeatureUnloaded(event) : undefined,
  )
  const stopFeatureFailure = dependencies.features.onRequiredFeatureFailure(
    (event) => {
      if (!active) return
      const task = runner.requestFatalFailure(event.error)
      consumeProductTask(task, environment.reportError)
      return task
    },
  )
  const stopProcessHandlers = installProcessTerminationHandlers(
    environment.process,
    runner,
  )

  let completion: Promise<void> = Promise.resolve()
  let disposeTask: Promise<void> | undefined
  const mount: DshTuiProductMount = {
    runner,
    get completion() {
      return completion
    },
    dispose() {
      disposeTask ??= disposeProduct()
      return disposeTask
    },
  }

  ctx.provide('dshTuiProduct', mount)
  if (options.lifecycle !== 'external') {
    ctx.effect(() => () => mount.dispose(), 'dsh-tui: product owner')
  }
  completion = dependencies.features.start().then(
    async () => {
      if (!active) return
      await preferences.start()
      if (active) await runner.start()
    },
    error => active ? runner.requestFatalFailure(error) : undefined,
  )
  consumeProductTask(completion, environment.reportError)
  return mount

  async function disposeProduct(): Promise<void> {
    active = false
    const issues: unknown[] = []
    for (const stop of [
      stopPreferences,
      () => preferences.dispose(),
      stopProcessHandlers,
      stopFeatureFailure,
      stopFeatureUnload,
    ]) {
      try {
        await stop()
      } catch (error: unknown) {
        issues.push(error)
      }
    }
    try {
      await runner.dispose()
    } catch (error: unknown) {
      issues.push(error)
    }
    try {
      await featureSession.dispose()
    } catch (error: unknown) {
      issues.push(error)
    }
    try {
      featureHost.dispose()
    } catch (error: unknown) {
      issues.push(error)
    }
    try {
      await navigationRegistration.release()
    } catch (error: unknown) {
      issues.push(error)
    }
    if (issues.length !== 0) {
      throw new AggregateError(issues, 'dsh-tui product disposal failed')
    }
  }
}

async function openProductSession(
  runtime: DshTuiRuntimeService,
  request: DshTuiOpenRequest,
) {
  if (request.mode === 'resume') {
    const activated = await runtime.activation.activateSession({
      intent: 'resume-cold',
      sessionId: request.sessionId,
      signal: request.signal,
      ...(request.selection === undefined
        ? {}
        : { selection: request.selection }),
    })
    return bindProductSession(
      () => Promise.resolve(activated.port),
      () => activated.release(),
    )
  }
  const session = await runtime.openSession(request)
  return bindProductSession(
    () => session.asLegacyPort(),
    () => session.release('DSH-TUI Product session released'),
  )
}

async function bindProductSession(
  projectLegacyPort: () => Promise<DshTuiSessionLease>,
  releaseSession: () => Promise<void>,
) {
  try {
    const port = await projectLegacyPort()
    let releaseTask: Promise<void> | undefined
    return Object.freeze({
      port,
      release() {
        releaseTask ??= releaseSession()
        return releaseTask
      },
    })
  } catch (error: unknown) {
    try {
      await releaseSession()
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'DSH-TUI Product session binding cleanup failed',
      )
    }
    throw error
  }
}

function requireProductDependencies(
  ctx: Context,
  supplied?: DshTuiProductMountDependencies,
): DshTuiProductMountDependencies {
  const features = supplied?.features ?? ctx.get('dshTuiFeatures')
  const legacyChat = supplied?.legacyChat ?? ctx.get('dshTuiLegacyChat')
  const runtime = supplied?.runtime ?? ctx.get('dshTui')
  const cmdlineArgs = supplied?.cmdlineArgs ?? ctx.get('cmdlineArgs')
  const appExit = supplied?.appExit ?? ctx.get('appExit')
  const preferences = supplied?.preferences ?? ctx.get('dshTuiPreferences')
  for (const [key, value] of [
    ['dshTuiFeatures', features],
    ['dshTuiLegacyChat', legacyChat],
    ['dshTui', runtime],
    ['cmdlineArgs', cmdlineArgs],
    ['appExit', appExit],
  ] as const) {
    if (value === undefined) {
      throw new Error(`dsh-tui-product requires service "${key}"`)
    }
  }
  return {
    features: features!,
    legacyChat: legacyChat!,
    runtime: runtime!,
    cmdlineArgs: cmdlineArgs!,
    appExit: appExit!,
    ...(preferences === undefined ? {} : { preferences }),
  }
}

interface ProductCommandOptions {
  readonly sessionId?: string
  readonly cwd?: string
  readonly resume?: string
  readonly agentPreset?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** DSH-free parser for the launch arguments injected into the Product row. */
export function parseDshTuiProductStartup(
  args: readonly string[],
  appExit: (code: number) => void,
): DshTuiStartupRequest | undefined {
  const program = new Command()
    .name('dsh-tui')
    .description('Interactive terminal UI for DeepSeek Harness')
    .option('--session-id <session-id>', 'create a session with this id')
    .option('--cwd <path>', 'working directory for a new session')
    .option('--agent-preset <preset-id>', 'compose a new session from this Agent preset')
    .option('--resume <session-id>', 'resume an existing session')
    .option('--provider <route>', 'override the DSH model provider route')
    .option('--model <model-id>', 'override the opaque DSH model id')
    .option('--reasoning-effort <effort-id>', 'override the adapter-owned reasoning effort')
    .exitOverride()

  let startup: DshTuiStartupRequest | undefined
  program.action(() => {
    const options = program.opts<ProductCommandOptions>()
    const sessionId = nonBlank(program, '--session-id', options.sessionId)
    const cwd = nonBlank(program, '--cwd', options.cwd)
    const resume = nonBlank(program, '--resume', options.resume)
    const agentPreset = nonBlank(program, '--agent-preset', options.agentPreset)
    const provider = nonBlank(program, '--provider', options.provider)
    const model = nonBlank(program, '--model', options.model)
    const reasoningEffort = nonBlank(
      program,
      '--reasoning-effort',
      options.reasoningEffort,
    )
    if ((provider === undefined) !== (model === undefined)) {
      program.error('--provider and --model must be provided together')
    }
    if (reasoningEffort !== undefined && provider === undefined) {
      program.error('--reasoning-effort requires --provider and --model')
    }
    if (resume !== undefined && sessionId !== undefined) {
      program.error('--resume cannot be combined with --session-id')
    }
    if (resume !== undefined && cwd !== undefined) {
      program.error('--resume cannot be combined with --cwd')
    }
    if (resume !== undefined && agentPreset !== undefined) {
      program.error('--resume cannot be combined with --agent-preset')
    }
    const selection = provider === undefined || model === undefined
      ? undefined
      : {
          provider,
          model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        }
    startup = resume === undefined
      ? {
          mode: 'create',
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(cwd === undefined ? {} : { cwd }),
          agentPreset: agentPreset ?? 'standard',
          ...(selection === undefined ? {} : { selection }),
        }
      : {
          mode: 'resume',
          sessionId: resume,
          ...(selection === undefined ? {} : { selection }),
        }
  })

  try {
    program.parse(args, { from: 'user' })
  } catch (error: unknown) {
    if (!(error instanceof CommanderError)) throw error
    appExit(error.exitCode)
  }
  return startup
}

function nonBlank(
  program: Command,
  flag:
    | '--session-id'
    | '--cwd'
    | '--resume'
    | '--agent-preset'
    | '--provider'
    | '--model'
    | '--reasoning-effort',
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (normalized === '') program.error(`${flag} must not be blank`)
  return normalized
}
