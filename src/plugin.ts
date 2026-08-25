import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  provideDshTuiRuntime,
  type DshTuiRuntimeService,
} from './dsh/runtime-service.ts'
import { parseDshTuiStartup } from './dsh/startup.ts'
import {
  DshTuiController,
  type DshTuiControllerOptions,
} from './app/controller.ts'
import {
  DshTuiProductRunner,
  sanitizeDshTuiProductError,
  type DshTuiControllerPort,
} from './app/runner.ts'
import {
  selectStartupPreset,
  type StartupPresetSelector,
} from './app/startup-preset-selector.ts'
import {
  PiTerminalDriver,
  type TerminalDriver,
} from './terminal/driver.ts'
import { ToolCardRendererRegistry } from './presentation/tool-card-renderers.ts'
import { installBuiltinToolCardRenderers } from './presentation/builtin-tool-card-renderers.ts'
import {
  DSH_TUI_ANSI_COLORS,
  DSH_TUI_SEMANTIC_ROLES,
  DSH_TUI_THEME_PRESETS,
  createDshTuiTheme,
  type DshTuiTheme,
  type DshTuiThemeConfig,
} from './ui/theme.ts'

export interface Config {
  readonly autoStart?: boolean
  readonly theme?: DshTuiThemeConfig
}

const themeConfigSchema: z<DshTuiThemeConfig> = z.object({
  preset: z.union(DSH_TUI_THEME_PRESETS).default('auto'),
  colors: z.dict(
    z.union(DSH_TUI_ANSI_COLORS),
    z.union(DSH_TUI_SEMANTIC_ROLES),
  ),
}) as z<DshTuiThemeConfig>

export const Config: z<Config> = z.object({
  autoStart: z.boolean().default(false),
  theme: themeConfigSchema,
})

export type {
  DshTuiRuntimeService,
  OpenDshTuiSessionOptions,
} from './dsh/runtime-service.ts'
export type {
  DshTuiAnsiColor,
  DshTuiThemeColors,
  DshTuiThemeConfig,
  DshTuiThemePreset,
} from './ui/theme.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshTui: DshTuiRuntimeService
  }
}

export const name = 'dsh-tui'
export const inject = [
  'agentDefaultModel',
  'agentPresets',
  'agents',
  'approval',
  'commands',
  'llm',
  'sessions',
  'tools',
  'userQuestions',
]

interface ProductInternals {
  createTerminal(options: ProductTerminalOptions): TerminalDriver
  createController(options: DshTuiControllerOptions): DshTuiControllerPort
  selectStartupPreset: StartupPresetSelector
  forceExit(code: number): void
  reportError(message: string): void
}

interface ProductTerminalOptions {
  readonly theme: DshTuiTheme
}

/** Mutable process seams used by product-level lifecycle tests. */
export const productInternals: ProductInternals = {
  createTerminal: options => new PiTerminalDriver({ theme: options.theme }),
  createController: options => new DshTuiController(options),
  selectStartupPreset,
  forceExit: code => { process.exit(code) },
  reportError: message => { process.stderr.write(message) },
}

/** Consume only an invariant-breaking task rejection; ordinary failures resolve. */
export function consumeProductTask(task: Promise<void>): void {
  void task.catch((error: unknown) => {
    try {
      productInternals.reportError(
        `dsh-tui: unexpected product task rejection: ${sanitizeDshTuiProductError(error)}\n`,
      )
    } catch {
      // A broken stderr seam must not create another unhandled rejection.
    }
  })
}

/** Install the owner service and optionally assemble the interactive product. */
export function apply(ctx: Context, config: Config = {}): void {
  const normalized = new Config(config)
  const autoStart = normalized.autoStart

  if (autoStart !== true) {
    const owner = provideDshTuiRuntime(ctx)
    ctx.effect(() => () => owner.dispose(), 'dsh-tui: runtime owner')
    return
  }

  const appExit = requireAutoStartHost(ctx)
  const startup = parseDshTuiStartup(ctx)
  if (startup === undefined) return
  const theme = createDshTuiTheme(normalized.theme)
  const toolCards = new ToolCardRendererRegistry()
  installBuiltinToolCardRenderers(ctx, toolCards)
  const owner = provideDshTuiRuntime(ctx)
  const { service } = owner
  const runner = new DshTuiProductRunner({
    startup,
    catalog: service.catalog,
    activation: service.activation,
    inspection: service.inspection,
    presets: service.presets,
    open: async (options) => {
      if (options.mode === 'resume') {
        return await service.activation.activateSession({
          intent: 'resume-cold',
          sessionId: options.sessionId,
          signal: options.signal,
          ...(options.selection === undefined
            ? {}
            : { selection: options.selection }),
        })
      }
      const port = await service.open(options)
      return {
        port,
        release: () => port.dispose(),
      }
    },
    createTerminal: () => productInternals.createTerminal({ theme }),
    createController: options => productInternals.createController(options),
    toolCards,
    selectStartupPreset: options => productInternals.selectStartupPreset(options),
    appExit,
    forceExit: code => { productInternals.forceExit(code) },
    reportError: message => { productInternals.reportError(message) },
    disposeOwner: () => owner.dispose(),
  })
  ctx.effect(() => () => runner.dispose(), 'dsh-tui: product runner')
  consumeProductTask(runner.start())
}

function requireAutoStartHost(ctx: Context): (code: number) => void {
  const cmdlineArgs = ctx.get('cmdlineArgs')
  const appExit = ctx.get('appExit')
  if (cmdlineArgs === undefined || appExit === undefined) {
    throw new Error(
      'dsh-tui: the launcher must provide ctx.cmdlineArgs and ctx.appExit before autoStart',
    )
  }
  return appExit
}
