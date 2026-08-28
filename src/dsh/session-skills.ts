import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type {
  SessionSkillEntry,
  SessionSkillsPort,
  SessionSkillsSnapshot,
} from '../skill/port.ts'

interface DshSkillSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: {
    readonly modelInvocable: boolean
    readonly userInvocable: boolean
  }
  readonly source: string
  readonly provider: string
  readonly resourceBase?:
    | { readonly kind: 'directory'; readonly path: string }
    | { readonly kind: 'url'; readonly url: string }
    | { readonly kind: 'opaque'; readonly description: string }
}

interface DshSkillRegistry {
  snapshot(options: {
    readonly cwd?: string
    readonly signal?: AbortSignal
    readonly scope?: Agent
  }): Promise<{
    readonly skills: readonly DshSkillSummary[]
    readonly complete: boolean
  }>
}

interface AgentPresetSkillAddressor {
  serviceFor(agent: { readonly ctx: Context }, name: 'skills'): DshSkillRegistry | undefined
}

interface SkillHostLookup {
  get(name: 'skills'): DshSkillRegistry | undefined
}

interface SkillEventContext {
  on(name: 'skills/change', listener: () => void): () => boolean
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cloneResourceBase(
  value: DshSkillSummary['resourceBase'],
): SessionSkillEntry['resourceBase'] {
  if (value === undefined) return undefined
  switch (value.kind) {
    case 'directory': return Object.freeze({ kind: value.kind, path: value.path })
    case 'url': return Object.freeze({ kind: value.kind, url: value.url })
    case 'opaque': return Object.freeze({ kind: value.kind, description: value.description })
  }
}

function projectSkill(skill: DshSkillSummary): SessionSkillEntry {
  const resourceBase = cloneResourceBase(skill.resourceBase)
  return Object.freeze({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    modelInvocable: skill.invocation.modelInvocable,
    source: skill.source,
    provider: skill.provider,
    ...(resourceBase === undefined ? {} : { resourceBase }),
  })
}

function cloneSkill(skill: SessionSkillEntry): SessionSkillEntry {
  const resourceBase = cloneResourceBase(skill.resourceBase)
  return Object.freeze({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    modelInvocable: skill.modelInvocable,
    source: skill.source,
    provider: skill.provider,
    ...(resourceBase === undefined ? {} : { resourceBase }),
  })
}

function mergePartialCatalog(
  stable: readonly SessionSkillEntry[],
  partial: readonly SessionSkillEntry[],
): readonly SessionSkillEntry[] {
  const merged = new Map(stable.map(skill => [skill.name, skill]))
  for (const skill of partial) merged.set(skill.name, skill)
  return Object.freeze([...merged.values()].sort((left, right) => (
    left.name.localeCompare(right.name)
  )))
}

/** Exact-live-Agent adapter over the official scoped SkillRegistry snapshot contract. */
export class DshSessionSkills implements SessionSkillsPort {
  private readonly listeners = new Set<() => void>()
  private readonly stopChange: () => void
  private readonly stopPreset: () => void
  private catalog: readonly SessionSkillEntry[] = Object.freeze([])
  private hasCompleteCatalog = false
  private compositionGeneration = 0
  private loading = false
  private complete = false
  private generation = 0
  private error: string | undefined
  private disposed = false
  private lastRevision = ''

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {
    this.stopChange = (ctx as unknown as SkillEventContext).on('skills/change', () => {
      if (this.disposed) return
      this.complete = false
      this.publishIfChanged()
    })
    this.stopPreset = ctx.on('agent-preset/selected', (sessionId) => {
      if (sessionId !== this.agent.id || this.disposed) return
      this.compositionGeneration += 1
      this.clearCatalog(this.resolveRegistry())
      this.publishIfChanged()
    })
    this.lastRevision = this.revision()
  }

  skillsSnapshot(): SessionSkillsSnapshot {
    const available = !this.disposed && this.resolveRegistry() !== undefined
    const skills = available
      ? Object.freeze(this.catalog.map(cloneSkill))
      : Object.freeze([])
    return Object.freeze({
      available,
      loading: this.loading,
      complete: available ? this.complete : true,
      stale: available && !this.complete && skills.length > 0,
      generation: this.generation,
      skills,
      ...(this.error === undefined ? {} : { error: this.error }),
    })
  }

  async refreshSkills(signal?: AbortSignal): Promise<void> {
    this.assertOpen()
    signal?.throwIfAborted()
    this.loading = true
    this.error = undefined
    this.publishIfChanged()
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        this.assertLiveAgent()
        const compositionGeneration = this.compositionGeneration
        const registry = this.resolveRegistry()
        if (registry === undefined) {
          this.clearCatalog(undefined)
          return
        }
        const observed = await registry.snapshot({
          ...(this.agent.session.header.cwd === undefined
            ? {}
            : { cwd: this.agent.session.header.cwd }),
          ...(signal === undefined ? {} : { signal }),
          scope: this.agent,
        })
        signal?.throwIfAborted()
        this.assertLiveAgent()
        if (this.compositionGeneration !== compositionGeneration) continue
        const observedCatalog = Object.freeze(observed.skills
          .filter(skill => skill.invocation.userInvocable)
          .map(projectSkill))
        this.catalog = observed.complete || !this.hasCompleteCatalog
          ? observedCatalog
          : mergePartialCatalog(this.catalog, observedCatalog)
        if (observed.complete) {
          this.hasCompleteCatalog = true
          this.complete = true
        } else {
          this.complete = false
        }
        return
      }
      this.complete = false
    } catch (error: unknown) {
      this.complete = false
      this.error = messageOf(error)
      throw error
    } finally {
      this.loading = false
      this.publishIfChanged()
    }
  }

  onSkillsChanged(listener: () => void): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  disposeSkills(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopChange()
    this.stopPreset()
    this.listeners.clear()
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Session skills port is disposed')
  }

  private assertLiveAgent(): void {
    const agents = this.ctx.get('agents')
    if (agents === undefined) throw new Error('DSH Agent service is unavailable')
    if (agents.get(this.agent.id) !== this.agent) {
      throw new Error(`DSH Session "${this.agent.id}" is no longer the live Agent`)
    }
  }

  private resolveRegistry(): DshSkillRegistry | undefined {
    const presets = this.ctx.get('agentPresets')
    const addressor = presets as (AgentPresets & Partial<AgentPresetSkillAddressor>) | undefined
    const scoped = typeof addressor?.serviceFor === 'function'
      ? addressor.serviceFor(this.agent, 'skills')
      : undefined
    return scoped ?? (this.ctx as unknown as SkillHostLookup).get('skills')
  }

  private clearCatalog(registry: DshSkillRegistry | undefined): void {
    this.catalog = Object.freeze([])
    this.hasCompleteCatalog = false
    this.complete = registry === undefined
    this.error = undefined
  }

  private revision(): string {
    const snapshot = this.skillsSnapshot()
    return JSON.stringify({
      available: snapshot.available,
      loading: snapshot.loading,
      complete: snapshot.complete,
      stale: snapshot.stale,
      skills: snapshot.skills,
      error: snapshot.error,
    })
  }

  private publishIfChanged(): void {
    if (this.disposed) return
    const revision = this.revision()
    if (revision === this.lastRevision) return
    this.lastRevision = revision
    this.generation += 1
    for (const listener of [...this.listeners]) listener()
  }
}
