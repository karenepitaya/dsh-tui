import type { ResourceScope, ScopeDisposer } from './scope-manager.ts'

export interface EffectExecutionContext {
  readonly scope: ResourceScope
  readonly signal: AbortSignal
}

export interface EffectOutput<Value> {
  readonly value: Value
  readonly cleanup?: ScopeDisposer
}

export interface ScopedEffect<Value> {
  readonly execute: (
    context: EffectExecutionContext,
  ) => EffectOutput<Value> | Promise<EffectOutput<Value>>
}

export type EffectRunResult<Value> =
  | { readonly status: 'committed'; readonly value: Value }
  | { readonly status: 'discarded' }

export class InactiveEffectScopeError extends Error {
  constructor(scope: ResourceScope) {
    super(`cannot run an effect in inactive ${scope.kind} scope`)
    this.name = 'InactiveEffectScopeError'
  }
}

function isScopeActive(scope: ResourceScope): boolean {
  return !scope.disposed && !scope.signal.aborted
}

/** Executes one effect only while its owning scope remains active. */
export class EffectRunner {
  async run<Value>(
    scope: ResourceScope,
    effect: ScopedEffect<Value>,
    commit: (value: Value) => void = () => {},
  ): Promise<EffectRunResult<Value>> {
    if (!isScopeActive(scope)) throw new InactiveEffectScopeError(scope)

    const output = await effect.execute({ scope, signal: scope.signal })
    if (!isScopeActive(scope)) {
      await output.cleanup?.()
      return { status: 'discarded' }
    }

    if (output.cleanup !== undefined) scope.defer(output.cleanup)
    commit(output.value)
    return { status: 'committed', value: output.value }
  }
}
