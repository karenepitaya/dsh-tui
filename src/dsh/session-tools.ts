import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type {
  SessionToolEntry,
  SessionToolGroup,
  SessionToolsPort,
  SessionToolsSnapshot,
} from '../tool/port.ts'

type OfficialToolSchema = ReturnType<ToolRuntime['schemas']>[number]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function groupOf(name: string): SessionToolGroup {
  if (name === 'run_code') return 'transport'
  return name.startsWith('mcp__') ? 'mcp' : 'core'
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function projectTool(schema: OfficialToolSchema): SessionToolEntry {
  const parameters = recordOf(schema.parameters)
  const properties = recordOf(parameters?.properties)
  const parameterNames = Object.freeze(Object.keys(properties ?? {}).sort())
  const required = Array.isArray(parameters?.required)
    ? parameters.required.filter((value): value is string => typeof value === 'string')
    : []
  const known = new Set(parameterNames)
  const requiredParameterNames = Object.freeze(
    [...new Set(required.filter(name => known.has(name)))].sort(),
  )
  return Object.freeze({
    name: schema.name,
    description: schema.description,
    group: groupOf(schema.name),
    parameterNames,
    requiredParameterNames,
  })
}

function cloneTool(tool: SessionToolEntry): SessionToolEntry {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    group: tool.group,
    parameterNames: Object.freeze([...tool.parameterNames]),
    requiredParameterNames: Object.freeze([...tool.requiredParameterNames]),
  })
}

const GROUP_RANK: Readonly<Record<SessionToolGroup, number>> = Object.freeze({
  core: 0,
  mcp: 1,
  transport: 2,
})

/** Exact-live-Agent adapter over ToolRuntime.schemas(agent); execution stays upstream-owned. */
export class DshSessionTools implements SessionToolsPort {
  private readonly listeners = new Set<() => void>()
  private readonly stopTools: () => void
  private readonly stopPreset: () => void
  private catalog: readonly SessionToolEntry[] = Object.freeze([])
  private available = false
  private stale = false
  private generation = 0
  private error: string | undefined
  private disposed = false
  private lastRevision = ''

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {
    this.stopTools = ctx.on('tools/change', () => {
      if (this.disposed) return
      this.observe()
    })
    this.stopPreset = ctx.on('agent-preset/selected', (sessionId) => {
      if (this.disposed || sessionId !== this.agent.id) return
      this.observe()
    })
    this.observe(false)
    this.lastRevision = this.revision()
  }

  toolsSnapshot(): SessionToolsSnapshot {
    if (this.disposed) {
      return Object.freeze({
        available: false,
        stale: false,
        generation: this.generation,
        tools: Object.freeze([]),
      })
    }
    return Object.freeze({
      available: this.available,
      stale: this.stale,
      generation: this.generation,
      tools: Object.freeze(this.catalog.map(cloneTool)),
      ...(this.error === undefined ? {} : { error: this.error }),
    })
  }

  onToolsChanged(listener: () => void): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  disposeTools(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopTools()
    this.stopPreset()
    this.listeners.clear()
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Session tools port is disposed')
  }

  private assertLiveAgent(): void {
    const agents = this.ctx.get('agents')
    if (agents === undefined) throw new Error('DSH Agent service is unavailable')
    if (agents.get(this.agent.id) !== this.agent) {
      throw new Error(`DSH Session "${this.agent.id}" is no longer the live Agent`)
    }
  }

  private observe(publish = true): void {
    const runtime = this.ctx.get('tools')
    if (runtime === undefined) {
      this.available = false
      this.stale = false
      this.catalog = Object.freeze([])
      this.error = undefined
    } else {
      this.available = true
      try {
        this.assertLiveAgent()
        this.catalog = Object.freeze(runtime.schemas(this.agent)
          .map(projectTool)
          .sort((left, right) => (
            GROUP_RANK[left.group] - GROUP_RANK[right.group]
            || left.name.localeCompare(right.name)
          )))
        this.stale = false
        this.error = undefined
      } catch (error: unknown) {
        this.stale = true
        this.error = messageOf(error)
      }
    }
    if (publish) this.publishIfChanged()
  }

  private revision(): string {
    return JSON.stringify({
      available: this.available,
      stale: this.stale,
      tools: this.catalog,
      error: this.error,
    })
  }

  private publishIfChanged(): void {
    const revision = this.revision()
    if (revision === this.lastRevision) return
    this.lastRevision = revision
    this.generation += 1
    for (const listener of [...this.listeners]) listener()
  }
}
