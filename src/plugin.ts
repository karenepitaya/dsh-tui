import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  provideDshTuiFeatures,
  registerDshTuiCoreFeature,
  registerDshTuiExtensionFeature,
} from './adapters/cordis-feature-service.ts'
import { mountDshTuiDshRc2Adapter } from './adapters/dsh-rc2.ts'
import { legacyChatFeature } from './features/legacy-chat.ts'
import { sessionsFeature } from './features/sessions/factory.ts'
import { activityFeature } from './features/activity/factory.ts'
import { modelsFeature } from './features/models/factory.ts'
import { modesFeature } from './features/modes/factory.ts'
import { capabilitiesFeature } from './features/capabilities/factory.ts'
import { parseDshTuiStartup } from './dsh/startup.ts'
import {
  consumeProductTask,
  createDshTuiProductEnvironment,
  mountDshTuiProduct,
} from './product.ts'
import type {
  DshTuiProductEnvironmentOverrides,
} from './product.ts'
import type { DshTuiLegacyChatMount } from './composition/legacy-chat-plugin.ts'
import { DshTuiRootResources } from './composition/root-resources.ts'
import { mountDshTuiPreferencesAdapter } from './composition/preferences-plugin.ts'
import {
  claimDshTuiComposition,
  createDshTuiCompositionOwner,
  ROOT_COMPOSITION_OWNER_ID,
} from './composition/ownership.ts'
import {
  DSH_TUI_ANSI_COLORS,
  DSH_TUI_SEMANTIC_ROLES,
  DSH_TUI_THEME_PRESETS,
  type DshTuiThemeConfig,
} from './ui/theme.ts'
import { SEMANTIC_COLOR_ROLES } from './theme/semantic-colors.ts'

export interface Config {
  readonly autoStart?: boolean
  readonly theme?: DshTuiThemeConfig
}

const themeConfigSchema: z<DshTuiThemeConfig> = z.object({
  preset: z.union(DSH_TUI_THEME_PRESETS).default('auto'),
  palette: z.dict(
    z.union([
      ...DSH_TUI_ANSI_COLORS,
      z.string().pattern(/^#[\da-f]{6}$/iu),
    ]),
    z.union(SEMANTIC_COLOR_ROLES),
  ),
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
} from './runtime/service.ts'
export type {
  DshTuiAnsiColor,
  DshTuiThemeColors,
  DshTuiThemeConfig,
  DshTuiThemePreset,
} from './ui/theme.ts'

export {
  consumeProductTask,
  createDshTuiProductEnvironment,
}
export type {
  DshTuiProductEnvironment,
  DshTuiProductEnvironmentOverrides,
} from './product.ts'

/** Legacy root plugin metadata; split bundle rows use their subpath metadata. */
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

/**
 * Backward-compatible single-row composition.
 *
 * The shipped bundle uses independent lifecycle rows. This composer deliberately
 * refuses mixed ownership, then invokes the same row mount functions inside
 * one Cordis fiber. An explicit owner preserves consumer-before-provider
 * teardown independently from Cordis effect scheduling.
 */
export function apply(
  ctx: Context,
  config: Config = {},
  environmentOverrides?: DshTuiProductEnvironmentOverrides,
): void | PromiseLike<unknown> {
  const normalized = new Config(config)
  claimDshTuiComposition(
    ctx,
    'root',
    createDshTuiCompositionOwner(ROOT_COMPOSITION_OWNER_ID),
  )

  if (normalized.autoStart === true) {
    return ctx.inject(['cmdlineArgs', 'appExit'], (launcherCtx) => {
      const startup = parseDshTuiStartup(launcherCtx)
      if (startup === undefined) return
      mountRootComposition(
        launcherCtx,
        normalized,
        environmentOverrides,
        {
          startup,
          cmdlineArgs: launcherCtx.cmdlineArgs!,
          appExit: launcherCtx.appExit!,
        },
      )
    })
  }

  mountRootComposition(ctx, normalized, environmentOverrides)
}

interface RootLauncherMount {
  readonly startup: NonNullable<ReturnType<typeof parseDshTuiStartup>>
  readonly cmdlineArgs: NonNullable<Context['cmdlineArgs']>
  readonly appExit: NonNullable<Context['appExit']>
}

function mountRootComposition(
  ctx: Context,
  normalized: Config,
  environmentOverrides?: DshTuiProductEnvironmentOverrides,
  launcher?: RootLauncherMount,
): void {
  const environment = createDshTuiProductEnvironment(
    environmentOverrides ?? ctx.get('dshTuiProductEnvironment'),
  )
  const resources = new DshTuiRootResources()
  ctx.effect(
    () => () => resources.dispose(),
    'dsh-tui: compatibility root resources',
  )

  const featureOwner = provideDshTuiFeatures(ctx)
  resources.kernel = featureOwner
  const preferencesOwner = mountDshTuiPreferencesAdapter(
    ctx,
    featureOwner.service,
    {
      rowConfig: { theme: normalized.theme! },
    },
    'external',
  )
  resources.preferences = preferencesOwner
  resources.legacyChatFeature = registerDshTuiCoreFeature(
    ctx,
    featureOwner.service,
    legacyChatFeature,
    'external',
  )
  resources.workspaceFeatures.push(registerDshTuiExtensionFeature(
    ctx,
    featureOwner.service,
    sessionsFeature,
    'external',
  ))
  resources.workspaceFeatures.push(registerDshTuiExtensionFeature(
    ctx,
    featureOwner.service,
    activityFeature,
    'external',
  ))
  resources.workspaceFeatures.push(registerDshTuiExtensionFeature(
    ctx,
    featureOwner.service,
    modelsFeature,
    'external',
  ))
  resources.workspaceFeatures.push(registerDshTuiExtensionFeature(
    ctx,
    featureOwner.service,
    modesFeature,
    'external',
  ))
  resources.workspaceFeatures.push(registerDshTuiExtensionFeature(
    ctx,
    featureOwner.service,
    capabilitiesFeature,
    'external',
  ))
  const legacyChat: DshTuiLegacyChatMount = Object.freeze({
    featureId: 'legacy.chat',
  })
  ctx.provide('dshTuiLegacyChat', legacyChat)

  const runtimeOwner = mountDshTuiDshRc2Adapter(
    ctx,
    featureOwner.service,
    'external',
  )
  resources.dshRc2Adapter = runtimeOwner

  if (launcher === undefined) {
    consumeProductTask(
      featureOwner.service.start().then(() => {}),
      environment.reportError,
    )
    return
  }

  resources.product = mountDshTuiProduct(ctx, {
    startup: launcher.startup,
    lifecycle: 'external',
    theme: normalized.theme!,
  }, {
    features: featureOwner.service,
    legacyChat,
    runtime: runtimeOwner.service,
    cmdlineArgs: launcher.cmdlineArgs,
    appExit: launcher.appExit,
    preferences: preferencesOwner.service,
  }, environment)
}
