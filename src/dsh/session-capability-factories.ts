import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DshInteractionPort } from '../interaction/port.ts'
import type { CapabilityLease } from '../kernel/capability.ts'
import type { DshRuntimeEventItem } from '../runtime/delivery.ts'
import type { CoreSessionPort } from '../runtime/core-session-port.ts'
import type {
  SessionCapabilityFactory,
  SessionCapabilityFactoryContext,
  SessionCapabilityFactoryRegistrationLease,
  SessionCapabilityFactoryRegistry,
} from '../runtime/session-capability.ts'
import type {
  CancelCause,
  Delivery,
  DshRuntimePort,
  RuntimeEventOptions,
  SubmitInput,
  SubmitOptions,
  SubmitResult,
} from '../runtime/port.ts'
import {
  DIFF_WORKSPACE_CAPABILITY,
  SESSION_AGENT_STATUS_CAPABILITY,
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
  type SessionAgentStatusPort,
} from '../runtime/session-capabilities.ts'
import { DshSessionMode } from './agent-mode.ts'
import { DshCommandSession } from './command-session.ts'
import { DshSessionContextMeter } from './context-meter.ts'
import { DshSessionDelegation } from './delegation-activity.ts'
import type { DshInteractionSession } from './interaction-hub.ts'
import { DshSessionJobs } from './jobs.ts'
import type { DshModelSelectionHub } from './model-selection.ts'
import { DshSessionPermissions } from './session-permissions.ts'
import { DshSessionSkills } from './session-skills.ts'
import { DshSessionTools } from './session-tools.ts'
import { DshSessionWorkbench } from './workbench.ts'
import { DshDiffWorkspace } from './diff-workspace.ts'

/** @deprecated DSH-side aliases retained while built-in adapters migrate. */
export const DSH_SESSION_COMMANDS = SESSION_COMMANDS_CAPABILITY
export const DSH_SESSION_AGENT_STATUS = SESSION_AGENT_STATUS_CAPABILITY
export const DSH_SESSION_MODELS = SESSION_MODELS_CAPABILITY
export const DSH_SESSION_CONTEXT = SESSION_CONTEXT_CAPABILITY
export const DSH_SESSION_WORKBENCH = SESSION_WORKBENCH_CAPABILITY
export const DSH_SESSION_JOBS = SESSION_JOBS_CAPABILITY
export const DSH_SESSION_MODES = SESSION_MODES_CAPABILITY
export const DSH_SESSION_SKILLS = SESSION_SKILLS_CAPABILITY
export const DSH_SESSION_DELEGATION = SESSION_DELEGATION_CAPABILITY
export const DSH_SESSION_TOOLS = SESSION_TOOLS_CAPABILITY
export const DSH_SESSION_PERMISSIONS = SESSION_PERMISSIONS_CAPABILITY
export const DSH_SESSION_DIFF_WORKSPACE = DIFF_WORKSPACE_CAPABILITY

/**
 * Adapter-private always-present session core. Capability factories recover
 * the exact unpublished Agent through module-private identity, so Agent never
 * leaks into the product CoreSessionPort contract.
 */
export class DshSessionCorePort implements CoreSessionPort {
  readonly sessionId: string
  private agent: Agent | undefined
  private runtime: DshRuntimePort | undefined
  private disposeTask: Promise<void> | undefined

  constructor(
    agent: Agent,
    private readonly interaction: DshInteractionSession,
  ) {
    this.sessionId = agent.session.id
    this.agent = agent
  }

  get ownsAgentLifecycle(): boolean {
    return this.runtime?.ownsAgentLifecycle ?? true
  }

  attachRuntime(runtime: DshRuntimePort): void {
    if (this.runtime !== undefined) throw new Error('DSH session core runtime is already attached')
    if (runtime.sessionId !== this.sessionId) {
      throw new Error('DSH session core runtime identity is inconsistent')
    }
    this.runtime = runtime
  }

  /** @internal Exact-Agent identity is available only inside the rc2 adapter. */
  requireAgent(): Agent {
    if (this.agent === undefined) {
      throw new Error('DSH session capability core is no longer active')
    }
    return this.agent
  }

  events(options?: RuntimeEventOptions): AsyncIterable<DshRuntimeEventItem> {
    return this.requireRuntime().events(options)
  }

  submit(
    input: SubmitInput,
    delivery: Delivery,
    options?: SubmitOptions,
  ): Promise<SubmitResult> {
    return options === undefined
      ? this.requireRuntime().submit(input, delivery)
      : this.requireRuntime().submit(input, delivery, options)
  }

  cancel(cause: CancelCause, options?: { readonly keepInbox?: boolean }): void {
    this.requireRuntime().cancel(cause, options)
  }

  whenIdle(): Promise<void> {
    return this.requireRuntime().whenIdle()
  }

  flush(): Promise<void> {
    return this.requireRuntime().flush()
  }

  interactions(options?: Parameters<DshInteractionPort['interactions']>[0]) {
    return this.interaction.interactions(options)
  }

  respond(response: Parameters<DshInteractionPort['respond']>[0]) {
    return this.interaction.respond(response)
  }

  disposeInteractions(): void {
    this.interaction.disposeInteractions()
  }

  clearSessionApprovals(): number {
    return this.interaction.clearSessionApprovals()
  }

  dispose(): Promise<void> {
    this.disposeTask ??= this.disposeOwned()
    return this.disposeTask
  }

  private async disposeOwned(): Promise<void> {
    this.agent = undefined
    const errors: unknown[] = []
    try {
      this.interaction.disposeInteractions()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await this.runtime?.dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'DSH session core disposal failed')
    }
  }

  private requireRuntime(): DshRuntimePort {
    if (this.runtime === undefined) throw new Error('DSH session core runtime is not attached')
    return this.runtime
  }
}

export interface DshSessionCapabilityFactories {
  readonly factories: readonly SessionCapabilityFactory<unknown, DshSessionCorePort>[]
  register(
    registry: SessionCapabilityFactoryRegistry<DshSessionCorePort>,
  ): DshSessionCapabilityFactoryRegistration
}

export interface DshSessionCapabilityFactoryRegistration {
  readonly active: boolean
  /** Settles after every optional-service injection has reached its initial state. */
  readonly ready: Promise<void>
  dispose(): Promise<void>
}

/** Build the single app-scoped rc2 provider set used by every owned session. */
export function createDshSessionCapabilityFactories(
  ctx: Context,
  modelHub: DshModelSelectionHub,
): DshSessionCapabilityFactories {
  const declared = createFactorySet(ctx, modelHub)
  return Object.freeze({
    factories: declared.all,
    register: (registry: SessionCapabilityFactoryRegistry<DshSessionCorePort>) => {
      let active = true
      let generation = 0
      const nextGeneration = (): number => ++generation
      const registerGroup = (
        ownerId: string,
        factories: readonly SessionCapabilityFactory<unknown, DshSessionCorePort>[],
      ) => registerFactoryGroup(registry, factories, ownerId, nextGeneration)

      // Delegation keeps projecting durable workflow events without Subagents,
      // while Permissions retains its stable unavailable/write semantics without
      // SessionProjections. Keep both factories live and hot-attach only their
      // optional upstream portions inside the adapters.
      const baseline = registerGroup('dsh.rc2.session-capabilities/core', [
        declared.commands,
        declared.models,
        declared.agentStatus,
        declared.modes,
        declared.skills,
        declared.delegation,
        declared.tools,
        declared.permissions,
        declared.diffWorkspace,
      ])
      const optional = [
        bindOptionalFactoryGroup({
          subscribe: activate => ctx.inject(['sessionProjections'], activate),
          createFactories: (serviceCtx) => {
            const factories = createFactorySet(serviceCtx, modelHub)
            return [factories.context, factories.workbench]
          },
          register: factories => registerGroup(
            'dsh.rc2.session-capabilities/session-projections',
            factories,
          ),
          ownerActive: () => active,
        }),
        bindOptionalFactoryGroup({
          subscribe: activate => ctx.inject(['jobs'], activate),
          createFactories: serviceCtx => [createFactorySet(serviceCtx, modelHub).jobs],
          register: factories => registerGroup(
            'dsh.rc2.session-capabilities/jobs',
            factories,
          ),
          ownerActive: () => active,
        }),
      ]
      const ready = Promise.all(optional.map(binding => binding.ready)).then(() => {})
      let disposeTask: Promise<void> | undefined
      return Object.freeze({
        get active() {
          return active
        },
        ready,
        dispose() {
          disposeTask ??= (async () => {
            active = false
            const errors: unknown[] = []
            for (const binding of [...optional].reverse()) {
              try {
                await binding.dispose()
              } catch (error: unknown) {
                errors.push(error)
              }
            }
            try {
              await baseline.dispose()
            } catch (error: unknown) {
              errors.push(error)
            }
            if (errors.length !== 0) {
              throw new AggregateError(
                errors,
                'DSH session capability factory registration disposal failed',
              )
            }
          })()
          return disposeTask
        },
      })
    },
  })
}

function createFactorySet(
  ctx: Context,
  modelHub: DshModelSelectionHub,
) {
  const commands = factory(DSH_SESSION_COMMANDS, core => {
    const value = new DshCommandSession(ctx, requireAgent(core))
    return owned(value, () => { value.disposeCommands() })
  })
  const models = factory(DSH_SESSION_MODELS, core => {
    const value = modelHub.attach(requireAgent(core))
    return owned(value, () => { value.disposeModels() })
  })
  const agentStatus = factory(DSH_SESSION_AGENT_STATUS, core => {
    const agent = requireAgent(core)
    let active = true
    const subscriptions = new Set<() => void>()
    const assertActive = (): void => {
      if (!active) throw new Error('DSH Agent status capability is no longer active')
    }
    const value: SessionAgentStatusPort = Object.freeze({
      snapshot: () => {
        assertActive()
        return Object.freeze({ status: agent.status })
      },
      onChanged: (listener: () => void) => {
        assertActive()
        let listening = true
        const stopCordis = ctx.on('agent/status', ({ agent: changed }) => {
          if (changed !== agent) return
          try {
            listener()
          } catch {
            // One surface observer cannot poison Cordis status delivery.
          }
        })
        const stop = (): void => {
          if (!listening) return
          listening = false
          subscriptions.delete(stop)
          stopCordis()
        }
        subscriptions.add(stop)
        return stop
      },
    })
    return owned(value, () => {
      active = false
      for (const stop of [...subscriptions]) stop()
    })
  })
  const context = factory(DSH_SESSION_CONTEXT, core => {
    const value = new DshSessionContextMeter(ctx, requireAgent(core).session)
    return owned(value, () => { value.disposeContext() })
  })
  const workbench = factory(DSH_SESSION_WORKBENCH, core => {
    const agent = requireAgent(core)
    const value = new DshSessionWorkbench(ctx, agent.session, agent)
    return owned(value, () => { value.disposeWorkbench() })
  })
  const jobs = factory(DSH_SESSION_JOBS, core => {
    const value = new DshSessionJobs(requireAgent(core))
    return owned(value, () => { value.disposeJobs() })
  })
  const modes = factory(DSH_SESSION_MODES, core => {
    const value = new DshSessionMode(ctx, requireAgent(core))
    return owned(value, () => { value.disposeModes() })
  })
  const skills = factory(DSH_SESSION_SKILLS, core => {
    const value = new DshSessionSkills(ctx, requireAgent(core))
    return owned(value, () => { value.disposeSkills() })
  })
  const delegation = factory(DSH_SESSION_DELEGATION, core => {
    const value = new DshSessionDelegation(ctx, requireAgent(core))
    return owned(value, () => { value.disposeDelegation() })
  })
  const tools = factory(DSH_SESSION_TOOLS, core => {
    const value = new DshSessionTools(ctx, requireAgent(core))
    return owned(value, () => { value.disposeTools() })
  })
  const permissions = factory(DSH_SESSION_PERMISSIONS, core => {
    const value = new DshSessionPermissions(ctx, requireAgent(core))
    return owned(value, () => { value.disposePermissions() })
  })
  const diffWorkspace = factory(DSH_SESSION_DIFF_WORKSPACE, core => {
    const value = new DshDiffWorkspace(core)
    return owned(value, () => value.dispose())
  })
  const all = Object.freeze([
    commands,
    models,
    agentStatus,
    context,
    workbench,
    jobs,
    modes,
    skills,
    delegation,
    tools,
    permissions,
    diffWorkspace,
  ])
  return Object.freeze({
    commands,
    models,
    agentStatus,
    context,
    workbench,
    jobs,
    modes,
    skills,
    delegation,
    tools,
    permissions,
    diffWorkspace,
    all,
  })
}

interface FactoryRegistrationGroup {
  dispose(): Promise<void>
}

interface OptionalFactoryFiber {
  readonly ready: Promise<void>
  dispose(): Promise<void>
}

interface CordisInjectionFiber extends PromiseLike<unknown> {
  dispose(): Promise<void>
}

interface BindOptionalFactoryGroupOptions {
  readonly subscribe: (
    activate: (ctx: Context) => void | (() => Promise<void>),
  ) => CordisInjectionFiber
  readonly createFactories: (
    ctx: Context,
  ) => readonly SessionCapabilityFactory<unknown, DshSessionCorePort>[]
  readonly register: (
    factories: readonly SessionCapabilityFactory<unknown, DshSessionCorePort>[],
  ) => FactoryRegistrationGroup
  readonly ownerActive: () => boolean
}

function bindOptionalFactoryGroup(
  options: BindOptionalFactoryGroupOptions,
): OptionalFactoryFiber {
  let current: FactoryRegistrationGroup | undefined
  const fiber = options.subscribe((serviceCtx) => {
    if (!options.ownerActive()) return
    const registration = current
      ?? options.register(options.createFactories(serviceCtx))
    current = registration
    return async () => {
      if (current === registration) current = undefined
      await registration.dispose()
    }
  })
  const ready = Promise.resolve(fiber).then(() => {})
  let disposeTask: Promise<void> | undefined
  return Object.freeze({
    ready,
    dispose() {
      disposeTask ??= (async () => {
        await fiber.dispose()
        const registration = current
        current = undefined
        await registration?.dispose()
      })()
      return disposeTask
    },
  })
}

function registerFactoryGroup(
  registry: SessionCapabilityFactoryRegistry<DshSessionCorePort>,
  factories: readonly SessionCapabilityFactory<unknown, DshSessionCorePort>[],
  ownerId: string,
  nextGeneration: () => number,
): FactoryRegistrationGroup {
  const registrations: SessionCapabilityFactoryRegistrationLease[] = []
  try {
    for (const entry of factories) {
      registrations.push(registry.register(entry, {
        ownerId,
        generation: nextGeneration(),
      }))
    }
  } catch (error: unknown) {
    void releaseFactoryRegistrations(registrations).catch(() => {})
    throw error
  }
  let disposeTask: Promise<void> | undefined
  return Object.freeze({
    dispose() {
      disposeTask ??= (async () => {
        await releaseFactoryRegistrations(registrations)
      })()
      return disposeTask
    },
  })
}

async function releaseFactoryRegistrations(
  registrations: readonly SessionCapabilityFactoryRegistrationLease[],
): Promise<void> {
  const errors: unknown[] = []
  for (const registration of [...registrations].reverse()) {
    try {
      await registration.release()
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  if (errors.length !== 0) {
    throw new AggregateError(errors, 'DSH session capability factory group disposal failed')
  }
}

function factory<TValue>(
  token: SessionCapabilityFactory<TValue, DshSessionCorePort>['token'],
  create: (core: DshSessionCorePort) => CapabilityLease<TValue>,
): SessionCapabilityFactory<TValue, DshSessionCorePort> {
  return Object.freeze({
    token,
    create: ({ core }: SessionCapabilityFactoryContext<DshSessionCorePort>) =>
      create(core),
  })
}

function requireAgent(core: DshSessionCorePort): Agent {
  return core.requireAgent()
}

function owned<TValue>(
  value: TValue,
  dispose: () => void | Promise<void>,
): CapabilityLease<TValue> {
  let active = true
  return Object.freeze({
    value,
    release: async () => {
      if (!active) return
      active = false
      await dispose()
    },
  })
}
