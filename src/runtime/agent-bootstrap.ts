import type { MaybePromise } from '../kernel/capability.ts'
import type { ResourceScope } from '../lifecycle/scope-manager.ts'

/** One prepared bootstrap effect owned by the unpublished Agent session. */
export interface PreparedAgentBootstrapContribution {
  commit?(): void
  dispose(): MaybePromise<void>
}

/** A dynamically owned setup contribution. `active` must remain true through commit. */
export interface AgentBootstrapContributor<TContext> {
  readonly id: string
  readonly active: boolean
  prepare(context: TContext): MaybePromise<PreparedAgentBootstrapContribution>
}

export interface PreparedAgentBootstrap {
  /** Synchronous, ordered, and single-shot to match the Agent publication boundary. */
  commit(): void
  /** Releases every prepared contribution once in reverse order. */
  rollback(): Promise<void>
}

interface PreparedRecord<TContext> {
  readonly contributor: AgentBootstrapContributor<TContext>
  readonly contribution: PreparedAgentBootstrapContribution
  readonly release: () => Promise<void>
}

type BootstrapState =
  | 'prepared'
  | 'committing'
  | 'committed'
  | 'failed'
  | 'rolling-back'
  | 'rolled-back'

class PreparedAgentBootstrapImpl<TContext> implements PreparedAgentBootstrap {
  private state: BootstrapState = 'prepared'
  private commitFailure: unknown
  private hasCommitFailure = false
  private rollbackTask: Promise<void> | undefined

  constructor(
    private readonly scope: ResourceScope,
    private readonly records: readonly PreparedRecord<TContext>[],
  ) {}

  commit(): void {
    if (this.state === 'committed') {
      throw new Error('Agent bootstrap is already committed')
    }
    if (this.state === 'failed') {
      throw new Error('Agent bootstrap commit cannot be retried', {
        cause: this.commitFailure,
      })
    }
    if (this.state === 'rolling-back' || this.state === 'rolled-back') {
      throw new Error('Agent bootstrap is rolled back')
    }
    if (this.state === 'committing') {
      throw new Error('Agent bootstrap commit is already in progress')
    }

    this.state = 'committing'
    try {
      assertActiveSessionScope(this.scope)
      for (const record of this.records) assertContributorActive(record.contributor)
      for (const record of this.records) {
        assertContributorActive(record.contributor)
        const result: unknown = record.contribution.commit?.()
        if (isThenable(result)) {
          throw new Error(
            `Agent bootstrap contributor "${record.contributor.id}" returned an asynchronous commit`,
          )
        }
      }
      this.state = 'committed'
    } catch (error: unknown) {
      this.state = 'failed'
      this.commitFailure = error
      this.hasCommitFailure = true
      throw error
    }
  }

  rollback(): Promise<void> {
    this.rollbackTask ??= this.runRollback()
    return this.rollbackTask
  }

  private async runRollback(): Promise<void> {
    this.state = 'rolling-back'
    const errors: unknown[] = []
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      try {
        await this.records[index]!.release()
      } catch (error: unknown) {
        errors.push(error)
      }
    }
    this.state = 'rolled-back'
    if (errors.length === 0) return
    if (this.hasCommitFailure) {
      throw new AggregateError(
        [this.commitFailure, ...errors],
        'Agent bootstrap commit failed and rollback failed',
      )
    }
    throw new AggregateError(errors, 'Agent bootstrap rollback failed')
  }
}

/** Prepare contributors serially and transfer each successful result to the session scope. */
export async function prepareAgentBootstrap<TContext>(
  scope: ResourceScope,
  context: TContext,
  contributors: readonly AgentBootstrapContributor<TContext>[],
): Promise<PreparedAgentBootstrap> {
  assertActiveSessionScope(scope)
  const snapshot = [...contributors]
  validateContributors(snapshot)
  const records: PreparedRecord<TContext>[] = []

  for (const contributor of snapshot) {
    let contribution: unknown
    try {
      assertContributorActive(contributor)
      contribution = await contributor.prepare(context)
    } catch (error: unknown) {
      await failPreparation(records, error)
    }
    try {
      assertPreparedContribution(contributor, contribution)
      assertActiveSessionScope(scope)
      assertContributorActive(contributor)
      const release = scope.defer(async () => { await contribution.dispose() })
      records.push({ contributor, contribution, release })
    } catch (error: unknown) {
      await failPreparation(records, error, contribution)
    }
  }

  return new PreparedAgentBootstrapImpl(scope, records)
}

function validateContributors<TContext>(
  contributors: readonly AgentBootstrapContributor<TContext>[],
): void {
  const ids = new Set<string>()
  for (const contributor of contributors) {
    if (contributor === null
      || typeof contributor !== 'object'
      || typeof contributor.prepare !== 'function'
      || typeof contributor.id !== 'string'
      || contributor.id === ''
      || contributor.id.trim() !== contributor.id) {
      throw new TypeError('Agent bootstrap contributor must have a non-empty trimmed id and prepare function')
    }
    if (ids.has(contributor.id)) {
      throw new Error(`Agent bootstrap contributor "${contributor.id}" is duplicated`)
    }
    ids.add(contributor.id)
  }
}

function assertPreparedContribution(
  contributor: AgentBootstrapContributor<unknown>,
  contribution: unknown,
): asserts contribution is PreparedAgentBootstrapContribution {
  if (contribution === null
    || typeof contribution !== 'object'
    || typeof (contribution as Partial<PreparedAgentBootstrapContribution>).dispose !== 'function'
    || ('commit' in contribution
      && typeof (contribution as Partial<PreparedAgentBootstrapContribution>).commit !== 'function')) {
    throw new TypeError(
      `Agent bootstrap contributor "${contributor.id}" returned an invalid contribution`,
    )
  }
}

function assertActiveSessionScope(scope: ResourceScope): void {
  if (scope.kind !== 'session' || scope.disposed || scope.signal.aborted) {
    throw new Error('Agent bootstrap requires an active session scope')
  }
}

function assertContributorActive(contributor: AgentBootstrapContributor<unknown>): void {
  if (contributor.active !== true) {
    throw new Error(`Agent bootstrap contributor "${contributor.id}" is inactive`)
  }
}

async function failPreparation<TContext>(
  records: readonly PreparedRecord<TContext>[],
  primary: unknown,
  unowned?: unknown,
): Promise<never> {
  const errors: unknown[] = []
  if (unowned !== null
    && typeof unowned === 'object'
    && typeof (unowned as Partial<PreparedAgentBootstrapContribution>).dispose === 'function') {
    try {
      await (unowned as PreparedAgentBootstrapContribution).dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    try {
      await records[index]!.release()
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  if (errors.length !== 0) {
    throw new AggregateError(
      [primary, ...errors],
      'Agent bootstrap preparation failed and rollback failed',
    )
  }
  throw primary
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as PromiseLike<unknown>).then === 'function'
}
