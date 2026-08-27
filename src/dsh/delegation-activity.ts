import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentDescendantListEntry,
  SubagentRuntime,
} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import type {
  SessionDelegationAction,
  SessionDelegationActionReceipt,
  SessionDelegationPort,
  SessionDelegationSnapshot,
  SessionSubagent,
} from '../activity/delegation-port.ts'
import {
  foldWorkflowActivity,
  projectWorkflowActivity,
  reduceWorkflowActivity,
  type WorkflowActivityState,
} from '../activity/workflow-activity.ts'

type CatalogEntry = {
  readonly kind: 'child'
  readonly id: string
  readonly parentId: string
  readonly depth: number
  readonly activity: 'running' | 'inactive'
  readonly hasChildren: boolean
  readonly mode: 'one-shot' | 'continuable'
  readonly label?: string
} | {
  readonly kind: 'diagnostic'
  readonly id: string
  readonly parentId: string
  readonly depth: number
  readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
}

function cloneCatalogEntry(entry: SubagentDescendantListEntry): CatalogEntry {
  if (entry.kind === 'diagnostic') {
    return {
      kind: 'diagnostic',
      id: String(entry.id),
      parentId: String(entry.parentId),
      depth: entry.depth,
      reason: entry.reason,
    }
  }
  return {
    kind: 'child',
    id: String(entry.id),
    parentId: String(entry.parentId),
    depth: entry.depth,
    activity: entry.activity,
    hasChildren: entry.hasChildren,
    mode: entry.mode,
    ...(entry.label === undefined ? {} : { label: entry.label }),
  }
}

function errorCode(error: unknown, fallback: string): string {
  const record = typeof error === 'object' && error !== null
    ? error as { readonly code?: unknown }
    : undefined
  return typeof record?.code === 'string' ? record.code : fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Exact-Agent anti-corruption layer for rc.2 Subagent control and durable
 * top-level Workflow records. Global workflow engine events never enter here.
 */
export class DshSessionDelegation implements SessionDelegationPort {
  private service: SubagentRuntime | undefined
  private serviceRelease: (() => void) | undefined
  private readonly listeners = new Set<() => void>()
  private readonly stopEvents: readonly (() => unknown)[]
  private readonly stopServiceBinding: () => void
  private catalog: readonly CatalogEntry[] = []
  private workflow: WorkflowActivityState
  private refreshAbort: AbortController | undefined
  private refreshRequest = 0
  private refreshQueued = false
  private generation = 1
  private loading = false
  private error: string | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {
    this.workflow = foldWorkflowActivity(agent.session.events)
    this.stopEvents = [
      agent.ctx.on('session/event', (session, event) => {
        this.handleSessionEvent(session, event)
      }),
      agent.ctx.on('subagent/start', () => { this.queueRefresh() }),
      agent.ctx.on('subagent/end', () => { this.queueRefresh() }),
      ctx.on('agent/created', ({ agent: changed }) => {
        if (this.relatedAgent(changed)) this.queueRefresh()
      }, { global: true }),
      ctx.on('agent/disposed', ({ agent: changed }) => {
        if (this.relatedAgent(changed)) this.queueRefresh()
      }, { global: true }),
      ctx.on('agent/status', ({ agent: changed }) => {
        if (this.catalog.some(entry => entry.id === String(changed.id))) this.notify()
      }, { global: true }),
    ]

    const active = ctx.get('subagents')
    if (active !== undefined) this.attach(active)
    const serviceFiber = ctx.inject(['subagents'], (serviceCtx) => {
      /* v8 ignore next -- disposing the injection removes this callback before any later service resolution */
      if (this.disposed) return
      return this.attach(serviceCtx.subagents)
    })
    /* v8 ignore next 3 -- Cordis owns this fiber; its disposer has no user-controlled failure path */
    this.stopServiceBinding = () => {
      void serviceFiber.dispose().catch(error => ctx.logger.error(error))
    }
  }

  private attach(service: SubagentRuntime): () => void {
    if (this.service === service) return this.serviceRelease!
    this.serviceRelease?.()
    this.service = service
    this.catalog = []
    this.error = undefined
    this.generation += 1
    let active = true
    const release = () => {
      if (!active) return
      active = false
      /* v8 ignore next -- attach always releases the prior owner before replacing this.service */
      if (this.service !== service) return
      this.refreshAbort?.abort('DSH Subagent service detached')
      this.service = undefined
      this.serviceRelease = undefined
      this.catalog = []
      this.loading = false
      this.error = undefined
      this.generation += 1
      if (!this.disposed) this.notify()
    }
    this.serviceRelease = release
    this.notify()
    this.queueRefresh()
    return release
  }

  private relatedAgent(candidate: Agent): boolean {
    if (candidate === this.agent) return false
    const id = String(candidate.id)
    if (this.catalog.some(entry => entry.id === id)) return true
    const parent = candidate.session.header.parentSession
    if (parent === undefined) return false
    const parentId = String(parent)
    return parentId === String(this.agent.id)
      || this.catalog.some(entry => entry.id === parentId)
  }

  private handleSessionEvent(session: Session, event: SessionEvent): void {
    if (this.disposed || session !== this.agent.session) return
    const next = reduceWorkflowActivity(this.workflow, event)
    if (next === this.workflow) return
    this.workflow = next
    this.generation += 1
    this.notify()
  }

  private queueRefresh(): void {
    if (this.disposed || this.service === undefined || this.refreshQueued) return
    this.refreshQueued = true
    void Promise.resolve().then(async () => {
      this.refreshQueued = false
      if (this.disposed || this.service === undefined) return
      try {
        await this.refreshDelegation()
      } catch {
        // The snapshot carries the contained diagnostic for UI observers.
      }
    })
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A view observer cannot veto official lifecycle observation.
      }
    }
  }

  private projectSubagent(entry: CatalogEntry): SessionSubagent {
    if (entry.kind === 'diagnostic') {
      return {
        id: entry.id,
        parentId: entry.parentId,
        depth: entry.depth,
        mode: 'diagnostic',
        status: 'diagnostic',
        hasChildren: false,
        interruptible: false,
        diagnosticReason: entry.reason,
      }
    }
    const live = this.ctx.get('agents')?.get(entry.id as SessionId)
    const status = live !== undefined
      ? live.status
      : entry.mode === 'continuable'
        ? 'ready'
        : entry.activity === 'running' ? 'running' : 'inactive'
    return {
      id: entry.id,
      parentId: entry.parentId,
      depth: entry.depth,
      mode: entry.mode,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      status,
      hasChildren: entry.hasChildren,
      interruptible: entry.mode === 'continuable' && live?.status === 'running',
    }
  }

  delegationSnapshot(): SessionDelegationSnapshot {
    if (this.disposed) {
      return {
        available: false,
        generation: this.generation,
        loading: false,
        subagentsAvailable: false,
        subagents: [],
        workflows: [],
      }
    }
    return {
      available: true,
      generation: this.generation,
      loading: this.loading,
      subagentsAvailable: this.service !== undefined,
      subagents: this.catalog.map(entry => this.projectSubagent(entry)),
      workflows: projectWorkflowActivity(this.workflow),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  async refreshDelegation(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return
    const service = this.service
    if (service === undefined) return
    signal?.throwIfAborted()
    this.refreshAbort?.abort('Superseded by a newer Subagent catalog refresh')
    const request = ++this.refreshRequest
    const abort = new AbortController()
    this.refreshAbort = abort
    const onAbort = (): void => { abort.abort(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    this.loading = true
    this.error = undefined
    this.generation += 1
    this.notify()
    try {
      const entries = await service.listDescendants(this.agent.id, abort.signal)
      signal?.throwIfAborted()
      if (
        this.disposed
        || this.service !== service
        || this.refreshRequest !== request
      ) return
      this.catalog = entries.map(cloneCatalogEntry)
      this.error = undefined
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        signal?.throwIfAborted()
        return
      }
      /* v8 ignore next 5 -- every stale request transition aborts the local signal and exits above */
      if (
        this.disposed
        || this.service !== service
        || this.refreshRequest !== request
      ) return
      this.error = `${errorCode(error, 'subagent-list-failed')}: ${errorMessage(error)}`
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (this.refreshRequest === request) {
        this.loading = false
        this.refreshAbort = undefined
        if (!this.disposed) this.notify()
      }
    }
  }

  onDelegationChanged(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  runDelegationAction(action: SessionDelegationAction): SessionDelegationActionReceipt {
    if (this.disposed) {
      return {
        accepted: false,
        code: 'delegation-closed',
        message: 'The Session delegation adapter is closed.',
      }
    }
    const service = this.service
    if (service === undefined) {
      return {
        accepted: false,
        code: 'subagent-capability-unavailable',
        message: 'This Agent composition does not provide the official Subagent service.',
      }
    }
    if (action.ref.generation !== this.generation) {
      return {
        accepted: false,
        code: 'subagent-reference-stale',
        message: 'Subagent activity changed; select the child again.',
      }
    }
    const entry = this.catalog.find(candidate => (
      candidate.id === action.ref.id
      && candidate.parentId === action.ref.parentId
    ))
    if (entry === undefined) {
      return {
        accepted: false,
        code: 'subagent-reference-stale',
        message: 'That child is no longer in this Session tree.',
      }
    }
    if (entry.kind !== 'child' || entry.mode !== 'continuable') {
      return {
        accepted: false,
        code: 'subagent-not-interruptible',
        message: 'Only a live continuable Subagent turn can be interrupted.',
      }
    }
    const live = this.ctx.get('agents')?.get(entry.id as SessionId)
    if (live?.status !== 'running') {
      return { accepted: true, outcome: 'already-idle' }
    }
    try {
      service.interrupt(entry.id as SessionId, { kind: 'ancestor', agent: this.agent })
      return { accepted: true, outcome: 'requested' }
    } catch (error: unknown) {
      return {
        accepted: false,
        code: errorCode(error, 'subagent-action-failed'),
        message: errorMessage(error),
      }
    }
  }

  disposeDelegation(): void {
    if (this.disposed) return
    this.disposed = true
    this.refreshAbort?.abort('DSH-TUI delegation adapter disposed')
    this.serviceRelease?.()
    for (const stop of this.stopEvents) stop()
    this.stopServiceBinding()
    this.listeners.clear()
  }
}
