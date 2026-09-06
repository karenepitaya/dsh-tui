import type { Context } from '@deepseek-ai/cordis'
import {
  registerDshTuiApplicationCapability,
} from './cordis-feature-service.ts'
import { provideDshTuiRuntime } from '../dsh/runtime-service.ts'
import type { DshTuiRuntimeOwner } from '../runtime/service.ts'
import type { DshTuiFeatureService } from '../kernel/feature-service.ts'
import type { CapabilityRegistrationLease } from '../kernel/capability-registry.ts'
import { requireApplicationScopeHost } from '../lifecycle/application-scope-host.ts'
import type { DshTuiRuntimeService } from '../runtime/service.ts'
import {
  SESSIONS_WORKSPACE_CAPABILITY,
  type SessionsWorkspacePort,
} from '../features/sessions/port.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshTui: DshTuiRuntimeService
  }
}

/** DeepSeek Harness rc.2 anti-corruption adapter. */
export {
  provideDshTuiRuntime,
} from '../dsh/runtime-service.ts'
export type {
  DshTuiRuntimeOwner,
  DshTuiRuntimeService,
  OpenDshTuiSessionOptions,
} from '../dsh/runtime-service.ts'

export const name = 'dsh-tui-dsh-rc2'
export const inject = [
  'dshTuiFeatures',
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
export const provide = 'dshTui'

export type DshTuiDshRc2AdapterLifecycle = 'cordis' | 'external'

export interface DshTuiDshRc2AdapterMount extends DshTuiRuntimeOwner {
  readonly sessionsWorkspace: CapabilityRegistrationLease
}

/** Publish the rc.2 runtime adapter and bind its resources to this row fiber. */
export function apply(ctx: Context): void {
  mountDshTuiDshRc2Adapter(ctx, ctx.dshTuiFeatures)
}

/**
 * Compose the rc.2 runtime and its DSH-free Sessions capability behind one
 * serial owner. The external form is the compatibility Root integration seam.
 */
export function mountDshTuiDshRc2Adapter(
  ctx: Context,
  features: DshTuiFeatureService,
  lifecycle: DshTuiDshRc2AdapterLifecycle = 'cordis',
): DshTuiDshRc2AdapterMount {
  let runtimeOwner: DshTuiRuntimeOwner | undefined
  const sessionsWorkspace = registerDshTuiApplicationCapability(
    ctx,
    features,
    {
      token: SESSIONS_WORKSPACE_CAPABILITY,
      create: () => {
        const service = runtimeOwner?.service
        if (service === undefined) {
          throw new Error('DSH rc.2 runtime is unavailable')
        }
        const value: SessionsWorkspacePort = Object.freeze({
          catalog: service.catalog,
          inspection: service.inspection,
          activation: service.activation,
          fork: service.fork,
        })
        return Object.freeze({ value, release() {} })
      },
    },
    'external',
  )
  try {
    runtimeOwner = provideDshTuiRuntime(
      ctx,
      requireApplicationScopeHost(features),
    )
  } catch (error: unknown) {
    void sessionsWorkspace.release().catch(() => {})
    throw error
  }

  let disposeTask: Promise<void> | undefined
  const mount: DshTuiDshRc2AdapterMount = Object.freeze({
    service: runtimeOwner.service,
    sessionsWorkspace,
    dispose() {
      disposeTask ??= disposeAdapter()
      return disposeTask
    },
  })
  if (lifecycle !== 'external') {
    ctx.effect(
      () => () => mount.dispose(),
      'dsh-tui-dsh-rc2: adapter owner',
    )
  }
  return mount

  async function disposeAdapter(): Promise<void> {
    const errors: unknown[] = []
    try {
      await sessionsWorkspace.release()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await runtimeOwner!.dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'DSH rc.2 adapter disposal failed')
    }
  }
}
