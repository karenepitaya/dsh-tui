import type { MaybePromise } from '../../kernel/capability.ts'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import {
  prepareAgentBootstrap,
  type AgentBootstrapContributor,
  type PreparedAgentBootstrap,
  type PreparedAgentBootstrapContribution,
} from '../../runtime/agent-bootstrap.ts'
import type { ResourceScope } from '../../lifecycle/scope-manager.ts'

export interface DshRc2SetupCommit {
  commit(): void
}

export interface DshRc2PresetSource {
  readonly id: string
  readonly trust?: unknown
  readonly path?: unknown
}

export type DshRc2BootstrapDisposer = () => MaybePromise<void>

export interface DshRc2AgentBootstrapPlan<TContext> {
  beforePrepare?(context: TContext, agent: Agent): MaybePromise<void>
  installModel(context: TContext, agent: Agent): MaybePromise<DshRc2BootstrapDisposer | void>
  mountPreset(context: TContext, agent: Agent): MaybePromise<DshRc2BootstrapDisposer | void>
  installGuidance?(context: TContext, agent: Agent): MaybePromise<DshRc2BootstrapDisposer | void>
  setupDownstream?(context: TContext, agent: Agent): MaybePromise<DshRc2SetupCommit | void>
  afterPrepare?(context: TContext, agent: Agent): MaybePromise<void>
  beforeCommit?(context: TContext, agent: Agent): void
  afterCommit?(context: TContext, agent: Agent): void
}

export interface DshRc2OwnedHandle<TAgent = unknown> {
  readonly agent: TAgent
  dispose(): Promise<void>
}

export interface DshRc2AgentBootstrapAttempt<TContext> {
  setup(context: TContext, agent: Agent): Promise<DshRc2SetupCommit>
  ownHandle<TAgent, THandle extends DshRc2OwnedHandle<TAgent>>(
    handle: THandle,
    releaseScope?: DshRc2BootstrapDisposer,
  ): THandle
  rollback(): Promise<void>
}

/** Preserve the primary failure while reporting a failed transaction rollback. */
export async function rollbackDshRc2AgentBootstrap(
  primary: unknown,
  attempt: Pick<DshRc2AgentBootstrapAttempt<unknown>, 'rollback'>,
  message: string,
): Promise<never> {
  try {
    await attempt.rollback()
  } catch (rollbackError: unknown) {
    throw new AggregateError([primary, rollbackError], message)
  }
  throw primary
}

/** Identity comparison used by the pinned rc2 preset contract. */
export function dshRc2PresetSourceKey(preset: DshRc2PresetSource): string {
  return JSON.stringify([preset.id, preset.trust, preset.path])
}

/** Exact rc2 model-selection installation, including its scoped disposer. */
export function installDshRc2ModelSelection(
  agentCtx: Context,
  selection: ModelSelection,
): () => void {
  return installModelSelection(agentCtx, { current: selection, assembled: undefined })
}

/**
 * Bridge the rc2 AgentSetup publication commit to the product bootstrap
 * transaction. One instance owns exactly one create/resume attempt.
 */
export function createDshRc2AgentBootstrapAttempt<TContext>(
  scope: ResourceScope,
  plan: DshRc2AgentBootstrapPlan<TContext>,
): DshRc2AgentBootstrapAttempt<TContext> {
  return new DshRc2AgentBootstrapAttemptImpl(scope, plan)
}

class DshRc2AgentBootstrapAttemptImpl<TContext>
implements DshRc2AgentBootstrapAttempt<TContext> {
  private prepared: PreparedAgentBootstrap | undefined
  private setupStarted = false
  private committed = false
  private owned = false
  private rollbackTask: Promise<void> | undefined

  constructor(
    private readonly scope: ResourceScope,
    private readonly plan: DshRc2AgentBootstrapPlan<TContext>,
  ) {}

  async setup(context: TContext, agent: Agent): Promise<DshRc2SetupCommit> {
    if (this.setupStarted) throw new Error('DSH rc2 Agent bootstrap setup already ran')
    this.setupStarted = true
    try {
      this.prepared = await prepareAgentBootstrap(
        this.scope,
        context,
        contributorsFor(this.plan, agent),
      )
    } catch (error: unknown) {
      await this.rollbackAfter(error)
    }
    const prepared = this.prepared
    /* v8 ignore next 3 -- prepare either returns a transaction or throws. */
    if (prepared === undefined) throw new Error('DSH rc2 Agent bootstrap was not prepared')
    return Object.freeze({
      commit: () => {
        prepared.commit()
        this.committed = true
      },
    })
  }

  ownHandle<TAgent, THandle extends DshRc2OwnedHandle<TAgent>>(
    handle: THandle,
    releaseScope?: DshRc2BootstrapDisposer,
  ): THandle {
    if (!this.committed) {
      throw new Error('DSH rc2 Agent factory returned before bootstrap commit')
    }
    if (this.owned) throw new Error('DSH rc2 Agent bootstrap already owns a handle')
    this.owned = true
    let disposeTask: Promise<void> | undefined
    return Object.freeze({
      ...handle,
      dispose: () => {
        disposeTask ??= this.disposeHandle(handle, releaseScope)
        return disposeTask
      },
    }) as THandle
  }

  rollback(): Promise<void> {
    this.rollbackTask ??= this.runRollback()
    return this.rollbackTask
  }

  private async disposeHandle(
    handle: DshRc2OwnedHandle,
    releaseScope?: DshRc2BootstrapDisposer,
  ): Promise<void> {
    const errors: unknown[] = []
    try {
      await handle.dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await this.rollback()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await releaseScope?.()
    } catch (error: unknown) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'DSH rc2 Agent handle and bootstrap disposal failed',
      )
    }
  }

  private async runRollback(): Promise<void> {
    let preparedFailure: unknown
    let preparedRollbackFailed = false
    if (this.prepared !== undefined) {
      try {
        await this.prepared.rollback()
      } catch (error: unknown) {
        preparedFailure = error
        preparedRollbackFailed = true
      }
    }
    if (preparedRollbackFailed) throw preparedFailure
  }

  private async rollbackAfter(primary: unknown): Promise<never> {
    // prepareAgentBootstrap already releases partial records before rejecting.
    // The runtime session owner, not this transaction, owns the supplied scope.
    await this.rollback()
    throw primary
  }
}

function contributorsFor<TContext>(
  plan: DshRc2AgentBootstrapPlan<TContext>,
  agent: Agent,
): readonly AgentBootstrapContributor<TContext>[] {
  return Object.freeze([
    contributor<TContext>('rc2.prepare-guard', async (context) => {
      await plan.beforePrepare?.(context, agent)
      return emptyContribution()
    }),
    contributor<TContext>('rc2.model-selection', async (context) => (
      disposableContribution(await plan.installModel(context, agent))
    )),
    contributor<TContext>('rc2.preset', async (context) => (
      disposableContribution(await plan.mountPreset(context, agent))
    )),
    contributor<TContext>('rc2.agent-guidance', async (context) => (
      disposableContribution(await plan.installGuidance?.(context, agent))
    )),
    contributor<TContext>('rc2.commit-guard-before', async (context) => ({
      commit: () => plan.beforeCommit?.(context, agent),
      dispose() {},
    })),
    contributor<TContext>('rc2.downstream-setup', async (context) => {
      const downstream = await plan.setupDownstream?.(context, agent)
      return {
        commit: () => downstream?.commit(),
        dispose() {},
      }
    }),
    contributor<TContext>('rc2.commit-guard-after', async (context) => {
      await plan.afterPrepare?.(context, agent)
      return {
        commit: () => plan.afterCommit?.(context, agent),
        dispose() {},
      }
    }),
  ])
}

function contributor<TContext>(
  id: string,
  prepare: (context: TContext) => Promise<PreparedAgentBootstrapContribution>,
): AgentBootstrapContributor<TContext> {
  return Object.freeze({ id, active: true, prepare })
}

function disposableContribution(
  dispose: DshRc2BootstrapDisposer | void,
): PreparedAgentBootstrapContribution {
  if (dispose !== undefined && typeof dispose !== 'function') {
    throw new TypeError('DSH rc2 bootstrap setup returned an invalid disposer')
  }
  return { dispose: dispose ?? (() => {}) }
}

function emptyContribution(): PreparedAgentBootstrapContribution {
  return { dispose() {} }
}
