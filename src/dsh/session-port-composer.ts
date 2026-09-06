import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createUnavailableSessionJobsPort,
} from '../activity/port.ts'
import {
  createUnavailableSessionDelegationPort,
} from '../activity/delegation-port.ts'
import {
  createUnavailableDshCommandPort,
} from '../command/port.ts'
import {
  createUnavailableSessionContextPort,
} from '../context/port.ts'
import type { CapabilityToken } from '../kernel/capability.ts'
import {
  runtimeSessionScope,
  type ApplicationScopeHost,
  type RuntimeSessionScopeCarrier,
} from '../lifecycle/application-scope-host.ts'
import type { ResourceScope } from '../lifecycle/scope-manager.ts'
import {
  createUnavailableSessionModePort,
} from '../mode/port.ts'
import {
  createUnavailableSessionModelPort,
} from '../model/port.ts'
import {
  createUnavailableSessionPermissionPort,
} from '../permission/port.ts'
import {
  createUnavailableSessionSkillsPort,
} from '../skill/port.ts'
import { createUnavailableSessionToolsPort } from '../tool/port.ts'
import type { DshRuntimePort } from '../runtime/port.ts'
import type {
  RuntimeSessionCapabilityCarrier,
  RuntimeSessionCapabilityResolver,
  RuntimeSessionLease,
} from '../runtime/runtime-session.ts'
import { runtimeSessionCapabilities } from '../runtime/runtime-session.ts'
import {
  SESSION_COMMANDS_CAPABILITY,
  SESSION_CONTEXT_CAPABILITY,
  SESSION_DELEGATION_CAPABILITY,
  SESSION_JOBS_CAPABILITY,
  SESSION_MODELS_CAPABILITY,
  SESSION_MODES_CAPABILITY,
  SESSION_PERMISSIONS_CAPABILITY,
  SESSION_SKILLS_CAPABILITY,
  SESSION_TOOLS_CAPABILITY,
  SESSION_WORKBENCH_CAPABILITY,
} from '../runtime/session-capabilities.ts'
import type {
  SessionCapabilityFactoryRegistry,
  SessionCapabilityLease,
} from '../runtime/session-capability.ts'
import { DshTuiSessionPort } from '../runtime/tui-session-port.ts'
import {
  createUnavailableSessionWorkbenchPort,
} from '../workbench/port.ts'
import {
  DshSessionCorePort,
} from './session-capability-factories.ts'
import type {
  DshInteractionHub,
  DshInteractionSession,
} from './interaction-hub.ts'

/** Adapter-private pre-publication state transferred into one session facade. */
export interface PreparedDshSessionPort {
  readonly core: DshSessionCorePort
  readonly capabilities: SessionCapabilityLease<DshSessionCorePort>
}

/**
 * Compose exact-Agent adapters under the one Kernel-owned runtime session scope.
 * Optional capability construction stays behind RuntimeSessionLease.acquire().
 * The legacy aggregate facade is projected only through asLegacyPort().
 */
export class DshSessionPortComposer {
  readonly #activeSessions = new Set<SessionCapabilityLease<DshSessionCorePort>>()

  constructor(
    private readonly interactionHub: DshInteractionHub,
    private readonly scopes: ApplicationScopeHost,
    private readonly registry: SessionCapabilityFactoryRegistry<DshSessionCorePort>,
  ) {}

  createSessionScope(label: string): ResourceScope {
    return this.scopes.createRuntimeSessionScope(label)
  }

  async prepare(
    agent: Agent,
    scope: ResourceScope,
  ): Promise<PreparedDshSessionPort> {
    let interaction: DshInteractionSession | undefined
    let capabilities: SessionCapabilityLease<DshSessionCorePort> | undefined
    try {
      interaction = this.interactionHub.attach({
        sessionId: agent.session.id,
        agent,
        session: agent.session,
      })
      const core = new DshSessionCorePort(agent, interaction)
      capabilities = this.registry.bind(core, scope)
      this.#activeSessions.add(capabilities)
      scope.defer(() => { this.#activeSessions.delete(capabilities!) })

      return Object.freeze({
        core,
        capabilities,
      })
    } catch (error: unknown) {
      const failures: unknown[] = [error]
      if (capabilities !== undefined) {
        try {
          await capabilities.release('DSH unpublished capability setup failed')
        } catch (cleanupError: unknown) {
          failures.push(cleanupError)
        }
      } else {
        try {
          interaction?.disposeInteractions()
        } catch (cleanupError: unknown) {
          failures.push(cleanupError)
        }
        try {
          await scope.dispose('DSH unpublished capability setup failed')
        } catch (cleanupError: unknown) {
          failures.push(cleanupError)
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'DSH unpublished capability setup failed')
      }
      throw error
    }
  }

  /** Transfer a prepared scope to its runtime without constructing optionals. */
  async completeSession(
    prepared: PreparedDshSessionPort,
    runtime: DshRuntimePort,
  ): Promise<RuntimeSessionLease> {
    let runtimeOwnedByCore = false
    try {
      prepared.core.attachRuntime(runtime)
      runtimeOwnedByCore = true
      return new DshRuntimeSessionLease(prepared, runtime)
    } catch (error: unknown) {
      const failures: unknown[] = [error]
      try {
        await prepared.capabilities.release('DSH session composition failed')
      } catch (cleanupError: unknown) {
        failures.push(cleanupError)
      }
      if (!runtimeOwnedByCore) {
        try {
          await runtime.dispose()
        } catch (cleanupError: unknown) {
          failures.push(cleanupError)
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'DSH session composition and rollback failed')
      }
      throw error
    }
  }

  /** Explicit compatibility projection for activation paths not migrated yet. */
  async complete(
    prepared: PreparedDshSessionPort,
    runtime: DshRuntimePort,
  ): Promise<DshTuiSessionPort> {
    const session = await this.completeSession(prepared, runtime)
    try {
      return await session.asLegacyPort()
    } catch (error: unknown) {
      try {
        await session.release('DSH legacy session projection failed')
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          'DSH legacy session projection and rollback failed',
        )
      }
      throw error
    }
  }

  release(
    prepared: PreparedDshSessionPort,
    reason: unknown,
  ): Promise<void> {
    return prepared.capabilities.release(reason)
  }

  async disposeSessions(): Promise<void> {
    const errors: unknown[] = []
    for (const session of [...this.#activeSessions].reverse()) {
      try {
        await session.release('DSH-TUI runtime adapter disposed')
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'DSH session composition disposal failed')
    }
  }
}

class DshRuntimeSessionLease implements RuntimeSessionLease, RuntimeSessionScopeCarrier, RuntimeSessionCapabilityCarrier {
  readonly core: DshSessionCorePort
  readonly capabilities: RuntimeSessionCapabilityResolver
  readonly #binding: SessionCapabilityLease<DshSessionCorePort>
  readonly #runtime: DshRuntimePort
  #legacyTask: Promise<DshTuiSessionPort> | undefined
  #releaseTask: Promise<void> | undefined

  constructor(
    prepared: PreparedDshSessionPort,
    runtime: DshRuntimePort,
  ) {
    this.core = prepared.core
    this.#binding = prepared.capabilities
    this.#runtime = runtime
    this.capabilities = Object.freeze({
      acquire: <TValue>(token: CapabilityToken<TValue>) => this.#binding.acquire(token),
    })
  }

  get [runtimeSessionScope](): ResourceScope {
    return this.#binding.scope
  }

  get [runtimeSessionCapabilities](): RuntimeSessionCapabilityResolver {
    return this.capabilities
  }

  asLegacyPort(): Promise<DshTuiSessionPort> {
    this.#legacyTask ??= this.#createLegacyPort()
    return this.#legacyTask
  }

  release(reason: unknown = 'DSH runtime session released'): Promise<void> {
    this.#releaseTask ??= this.#binding.release(reason)
    return this.#releaseTask
  }

  async #createLegacyPort(): Promise<DshTuiSessionPort> {
    const commands = await optionalCapability(
      this.#binding,
      SESSION_COMMANDS_CAPABILITY,
      createUnavailableDshCommandPort,
    )
    const models = await optionalCapability(
      this.#binding,
      SESSION_MODELS_CAPABILITY,
      createUnavailableSessionModelPort,
    )
    const context = await optionalCapability(
      this.#binding,
      SESSION_CONTEXT_CAPABILITY,
      createUnavailableSessionContextPort,
    )
    const workbench = await optionalCapability(
      this.#binding,
      SESSION_WORKBENCH_CAPABILITY,
      createUnavailableSessionWorkbenchPort,
    )
    const jobs = await optionalCapability(
      this.#binding,
      SESSION_JOBS_CAPABILITY,
      createUnavailableSessionJobsPort,
    )
    const modes = await optionalCapability(
      this.#binding,
      SESSION_MODES_CAPABILITY,
      createUnavailableSessionModePort,
    )
    const skills = await optionalCapability(
      this.#binding,
      SESSION_SKILLS_CAPABILITY,
      createUnavailableSessionSkillsPort,
    )
    const delegation = await optionalCapability(
      this.#binding,
      SESSION_DELEGATION_CAPABILITY,
      createUnavailableSessionDelegationPort,
    )
    const tools = await optionalCapability(
      this.#binding,
      SESSION_TOOLS_CAPABILITY,
      createUnavailableSessionToolsPort,
    )
    const permissions = await optionalCapability(
      this.#binding,
      SESSION_PERMISSIONS_CAPABILITY,
      createUnavailableSessionPermissionPort,
    )
    return new DshTuiSessionPort(
      this.#runtime,
      this.core,
      commands,
      models,
      context,
      workbench,
      jobs,
      modes,
      delegation,
      skills,
      tools,
      permissions,
      {
        scope: this.#binding.scope,
        capabilities: this.capabilities,
        release: reason => this.release(reason),
      },
    )
  }
}

async function optionalCapability<TValue>(
  capabilities: SessionCapabilityLease<DshSessionCorePort>,
  token: CapabilityToken<TValue>,
  unavailable: () => TValue,
): Promise<TValue> {
  try {
    return (await capabilities.acquire(token)).value
  } catch {
    return unavailable()
  }
}
