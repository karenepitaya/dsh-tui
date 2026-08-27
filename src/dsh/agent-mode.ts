import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type { AgentPresetCatalogEntry } from '../preset/catalog-port.ts'
import type {
  SessionModePort,
  SessionModeSelectOptions,
  SessionModeSnapshot,
} from '../mode/port.ts'
import { DshAgentPresetCatalog } from './agent-preset-catalog.ts'

const switchChains = new WeakMap<Agent, Promise<void>>()

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cloneEntry(entry: AgentPresetCatalogEntry): AgentPresetCatalogEntry {
  return Object.freeze({
    id: entry.id,
    trust: entry.trust,
    sourcePath: entry.sourcePath,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.broken === undefined ? {} : { broken: entry.broken }),
    isDefault: entry.isDefault,
  })
}

function sessionStarted(agent: Agent): boolean {
  return agent.session.events.some(event => event.type === 'turn/start')
}

function enqueueSwitch(
  agent: Agent,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = switchChains.get(agent) ?? Promise.resolve()
  const run = previous.then(operation)
  const settled = run.then(() => undefined, () => undefined)
  switchChains.set(agent, settled)
  void settled.then(() => {
    if (switchChains.get(agent) === settled) switchChains.delete(agent)
  })
  return run
}

/** Exact-Agent adapter for DSH's blank-session AgentPresets.recompose contract. */
export class DshSessionMode implements SessionModePort {
  private readonly presets: AgentPresets | undefined
  private readonly catalog: DshAgentPresetCatalog | undefined
  private readonly listeners = new Set<() => void>()
  private readonly stopSelected: () => void
  private roster: readonly AgentPresetCatalogEntry[] = Object.freeze([])
  private defaultId: string | undefined
  private committedCurrent: string | undefined
  private loading = false
  private pendingSelections = 0
  private error: string | undefined
  private disposed = false
  private lastRevision = ''

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {
    const presets = ctx.get('agentPresets')
    this.presets = presets
    this.defaultId = presets?.defaultId
    this.catalog = presets === undefined ? undefined : new DshAgentPresetCatalog(ctx)
    this.stopSelected = presets === undefined
      ? () => {}
      : ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
          if (sessionId !== this.agent.id || this.disposed) return
          this.committedCurrent = agentPreset
          this.publishIfChanged()
        })
    this.lastRevision = this.revision()
  }

  modeSnapshot(): SessionModeSnapshot {
    const presets = Object.freeze(this.roster.map(cloneEntry))
    const current = this.committedCurrent ?? this.presets?.composedPreset(this.agent.ctx)
    return Object.freeze({
      available: !this.disposed && this.presets !== undefined,
      ...(current === undefined ? {} : { current }),
      ...(this.defaultId === undefined ? {} : { defaultId: this.defaultId }),
      loading: this.loading,
      selecting: this.pendingSelections > 0,
      locked: sessionStarted(this.agent),
      presets,
      ...(this.error === undefined ? {} : { error: this.error }),
    })
  }

  async refreshModes(signal?: AbortSignal): Promise<void> {
    this.assertOpen()
    const catalog = this.requireCatalog()
    signal?.throwIfAborted()
    this.loading = true
    this.error = undefined
    this.publishIfChanged()
    try {
      const snapshot = await catalog.listPresets(
        signal === undefined ? undefined : { signal },
      )
      this.roster = snapshot.presets
      this.defaultId = snapshot.defaultId
    } catch (error: unknown) {
      this.error = messageOf(error)
      throw error
    } finally {
      this.loading = false
      this.publishIfChanged()
    }
  }

  selectMode(modeId: string, options?: SessionModeSelectOptions): Promise<void> {
    this.assertOpen()
    const presets = this.requirePresets()
    options?.signal?.throwIfAborted()
    this.pendingSelections += 1
    this.error = undefined
    this.publishIfChanged()
    return enqueueSwitch(this.agent, async () => {
      this.assertOpen()
      options?.signal?.throwIfAborted()
      const agents = this.ctx.get('agents')
      if (agents === undefined) throw new Error('DSH Agent service is unavailable')
      if (agents.get(this.agent.id) !== this.agent) {
        throw new Error(`DSH Session "${this.agent.id}" is no longer the live Agent`)
      }
      if (sessionStarted(this.agent)) {
        throw new Error(
          `DSH Session "${this.agent.id}" has already started; its Agent mode is fixed`,
        )
      }
      const preset = await presets.recompose(this.agent.ctx, modeId)
      // Abort is deliberately not observed after recompose: once model-visible
      // composition changes, the durable event must commit unconditionally.
      this.agent.session.append('agent-preset/selected', { agentPreset: preset.id })
      this.committedCurrent = preset.id
      this.publishIfChanged()
    }).catch((error: unknown) => {
      this.error = messageOf(error)
      throw error
    }).finally(() => {
      this.pendingSelections -= 1
      this.publishIfChanged()
    })
  }

  onModesChanged(listener: () => void): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  disposeModes(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopSelected()
    this.listeners.clear()
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Agent mode port is disposed')
  }

  private requirePresets(): AgentPresets {
    if (this.presets === undefined) {
      throw new Error('DSH AgentPresets service is unavailable')
    }
    return this.presets
  }

  private requireCatalog(): DshAgentPresetCatalog {
    if (this.catalog === undefined) {
      throw new Error('DSH AgentPresets service is unavailable')
    }
    return this.catalog
  }

  private revision(): string {
    const snapshot = this.modeSnapshot()
    return JSON.stringify({
      available: snapshot.available,
      current: snapshot.current,
      defaultId: snapshot.defaultId,
      loading: snapshot.loading,
      selecting: snapshot.selecting,
      locked: snapshot.locked,
      presets: snapshot.presets,
      error: snapshot.error,
    })
  }

  private publishIfChanged(): void {
    if (this.disposed) return
    const revision = this.revision()
    if (revision === this.lastRevision) return
    this.lastRevision = revision
    for (const listener of [...this.listeners]) listener()
  }
}
