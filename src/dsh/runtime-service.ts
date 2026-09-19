import type { Context } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import {
  createStandaloneApplicationScopeHost,
  type ApplicationScopeHost,
} from '../lifecycle/application-scope-host.ts'
import { SessionCapabilityFactoryRegistry } from '../runtime/session-capability.ts'
import type { RuntimeSessionLease } from '../runtime/runtime-session.ts'
import { DshTuiSessionPort } from '../runtime/tui-session-port.ts'
import type {
  DshTuiRuntimeOwner,
  DshTuiRuntimeService,
  OpenDshTuiSessionOptions,
} from '../runtime/service.ts'
import { DshAgentPresetCatalog } from './agent-preset-catalog.ts'
import { DshColdResumeCoordinator } from './cold-resume-coordinator.ts'
import { DshSessionActivation } from './cold-session-activation.ts'
import { DshInteractionHub } from './interaction-hub.ts'
import {
  openDshRuntimePort,
  type DshAgentRuntimePort,
  type OpenDshRuntimeOptions,
} from './runtime-port.ts'
import { DshSessionCatalog } from './session-catalog.ts'
import { DshSessionInspection } from './session-inspection.ts'
import { DshSessionFork } from './session-fork.ts'
import { DshProviderConnection } from './provider-connection.ts'
import { DshSettingsCatalog } from './settings-catalog.ts'
import { DshPluginInventory } from './plugin-inventory.ts'
import {
  DshModelSelectionHub,
  officialModelSelection,
} from './model-selection.ts'
import {
  createDshSessionCapabilityFactories,
  DshSessionCorePort,
} from './session-capability-factories.ts'
import {
  DshSessionPortComposer,
  type PreparedDshSessionPort,
} from './session-port-composer.ts'

export type {
  DshTuiRuntimeOwner,
  DshTuiRuntimeService,
  OpenDshTuiSessionOptions,
} from '../runtime/service.ts'

type OpenDshTuiForkSessionOptions = Extract<
  OpenDshRuntimeOptions,
  { readonly mode: 'fork' }
>

type OpenDshTuiInternalSessionOptions =
  | (OpenDshTuiSessionOptions & { readonly setup?: AgentSetup })
  | OpenDshTuiForkSessionOptions

/** Provide the Host-facing TUI service and retain its non-Cordis runtime owners. */
export function provideDshTuiRuntime(
  ctx: Context,
  applicationScopes?: ApplicationScopeHost,
): DshTuiRuntimeOwner {
  // The optional owner exists only for direct adapter tests/backward-compatible
  // embedding. Shipped Cordis composition always injects the Kernel host.
  const ownedScopes = applicationScopes === undefined
    ? createStandaloneApplicationScopeHost('dsh-tui-standalone-runtime')
    : undefined
  const scopes: ApplicationScopeHost = applicationScopes ?? ownedScopes!
  const catalog = new DshSessionCatalog(ctx)
  const interactionHub = new DshInteractionHub(ctx)
  const modelHub = new DshModelSelectionHub(ctx)
  const capabilityRegistry = new SessionCapabilityFactoryRegistry<DshSessionCorePort>(
    scopes.appScope,
  )
  const capabilityFactories = createDshSessionCapabilityFactories(ctx, modelHub)
  const capabilityFactoryRegistration = capabilityFactories.register(capabilityRegistry)
  const sessionComposer = new DshSessionPortComposer(
    interactionHub,
    scopes,
    capabilityRegistry,
  )
  const coordinator = new DshColdResumeCoordinator(ctx, modelHub, scopes)
  const openSession = async (options: OpenDshTuiInternalSessionOptions) => {
    await capabilityFactoryRegistration.ready
    return await openDshRuntimeSession(ctx, modelHub, sessionComposer, options)
  }
  const openLegacy = async (options: OpenDshTuiInternalSessionOptions) => {
    await capabilityFactoryRegistration.ready
    return await openLegacyDshTuiSession(ctx, modelHub, sessionComposer, options)
  }
  const activation = new DshSessionActivation(
    ctx,
    coordinator,
    sessionComposer,
    modelHub,
  )
  const inspection = new DshSessionInspection(ctx)
  const fork = new DshSessionFork(
    ctx,
    options => openLegacy(options),
  )
  const presets = new DshAgentPresetCatalog(ctx)
  const providers = new DshProviderConnection(ctx)
  const settings = new DshSettingsCatalog(ctx)
  const pluginInventory = new DshPluginInventory(ctx)
  const service: DshTuiRuntimeService = {
    catalog,
    activation,
    inspection,
    fork,
    presets,
    providers,
    settings,
    pluginInventory,
    openSession: options => openSession(options),
    openLegacy: options => openLegacy(options),
    open: options => openLegacy(options),
  }
  ctx.provide('dshTui', service)
  return {
    service,
    async dispose() {
      const errors: unknown[] = []
      try {
        await sessionComposer.disposeSessions()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await coordinator.dispose()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await capabilityFactoryRegistration.dispose()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await capabilityRegistry.dispose()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        interactionHub.dispose()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await modelHub.dispose()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await settings.disposeSettings()
      } catch (error: unknown) {
        errors.push(error)
      }
      try {
        await pluginInventory.disposePluginInventory()
      } catch (error: unknown) {
        errors.push(error)
      }
      if (ownedScopes !== undefined) {
        try {
          await ownedScopes.dispose('DSH-TUI standalone runtime owner disposed')
        } catch (error: unknown) {
          errors.push(error)
        }
      }
      if (errors.length !== 0) {
        throw new AggregateError(errors, 'DSH-TUI runtime owner disposal failed')
      }
    },
  }
}

/** Compose DSH's unpublished Agent setup with the TUI interaction adapters. */
async function openDshRuntimeSession(
  ctx: Context,
  modelHub: DshModelSelectionHub,
  sessionComposer: DshSessionPortComposer,
  options: OpenDshTuiInternalSessionOptions,
): Promise<RuntimeSessionLease> {
  let prepared: PreparedDshSessionPort | undefined
  let runtime: DshAgentRuntimePort | undefined
  let completionStarted = false
  const sessionScope = sessionComposer.createSessionScope(
    `dsh:${options.sessionId ?? 'generated'}`,
  )
  const upstreamSetup = options.setup
  const { selection, ...runtimeOptions } = options
  const setup: AgentSetup = async (agentCtx, agent) => {
    // openDshRuntimePort installs through modelHub before invoking this setup;
    // the Agent factory hands over the exact unpublished Agent being composed.
    if (agent === undefined) {
      throw new Error('DSH Agent setup did not expose its unpublished Agent')
    }
    prepared = await sessionComposer.prepare(agent, sessionScope)
    return await upstreamSetup?.(agentCtx, agent)
  }

  try {
    runtime = await openDshRuntimePort(ctx, {
      ...runtimeOptions,
      ...(selection === undefined
        ? {}
        : { selection: officialModelSelection(selection) }),
      setup,
    }, modelHub, sessionScope)
    if (prepared === undefined) {
      throw new Error('DSH interaction setup did not run')
    }
    completionStarted = true
    return await sessionComposer.completeSession(prepared, runtime)
  } catch (error: unknown) {
    if (completionStarted) throw error
    const failures: unknown[] = [error]
    if (prepared !== undefined) {
      try {
        await sessionComposer.release(prepared, 'DSH session open failed')
      } catch (cleanupError: unknown) {
        failures.push(cleanupError)
      }
    } else {
      try {
        await sessionScope.dispose('DSH session open failed')
      } catch (cleanupError: unknown) {
        failures.push(cleanupError)
      }
    }
    try {
      await runtime?.dispose()
    } catch (cleanupError: unknown) {
      failures.push(cleanupError)
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'DSH session open and rollback failed')
    }
    throw error
  }
}

async function openLegacyDshTuiSession(
  ctx: Context,
  modelHub: DshModelSelectionHub,
  sessionComposer: DshSessionPortComposer,
  options: OpenDshTuiInternalSessionOptions,
): Promise<DshTuiSessionPort> {
  const session = await openDshRuntimeSession(ctx, modelHub, sessionComposer, options)
  try {
    return await session.asLegacyPort()
  } catch (error: unknown) {
    try {
      await session.release('DSH legacy session open failed')
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'DSH legacy session open and rollback failed',
      )
    }
    throw error
  }
}
