import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import {
  CUSTOM_PERMISSION_VALUE,
  type PermissionPolicy,
  type SessionPermissionOption,
  type SessionPermissionPort,
  type SessionPermissionSelectOptions,
  type SessionPermissionSnapshot,
} from '../permission/port.ts'
import { permissionWidens } from '../permission/policy.ts'
import { currentPermission, presetPermission } from './permission-facts.ts'

interface OfficialPermissionOption {
  readonly value: string
  readonly name: string
  readonly description?: string
}

interface OfficialPermissionSelect {
  readonly options: readonly OfficialPermissionOption[]
  readonly currentValue: string
}

/** Public rc.2 projection declaration without importing the implementation package. */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    readonly permissions: OfficialPermissionSelect
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cloneOption(option: SessionPermissionOption): SessionPermissionOption {
  return Object.freeze({
    value: option.value,
    name: option.name,
    ...(option.description === undefined ? {} : { description: option.description }),
    selectable: option.selectable,
    ...(option.permission === undefined ? {} : { permission: option.permission }),
  })
}

function projectOption(option: OfficialPermissionOption, permission: PermissionPolicy | undefined): SessionPermissionOption {
  return Object.freeze({
    value: option.value,
    name: option.name,
    ...(option.description === undefined ? {} : { description: option.description }),
    selectable: option.value !== CUSTOM_PERMISSION_VALUE,
    ...(permission === undefined ? {} : { permission }),
  })
}

/**
 * Exact-live-Agent anti-corruption adapter.
 * Reads the official `permissions` projection and writes only through the
 * official `/permission` command so approval policy updates retain Agent scope.
 */
export class DshSessionPermissions implements SessionPermissionPort {
  private registry: SessionProjectionRegistry | undefined
  private readonly listeners = new Set<() => void>()
  private stopProjection: (() => void) | undefined
  private readonly stopRegistryBinding: () => void
  private readonly stopCommands: () => void
  private readonly stopPreset: () => void
  private available = false
  private writable = false
  private stale = false
  private selecting = false
  private generation = 0
  private currentValue: string | undefined
  private currentPolicy: PermissionPolicy | undefined
  private options: readonly SessionPermissionOption[] = Object.freeze([])
  private error: string | undefined
  private disposed = false
  private lastRevision = ''

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {
    this.stopCommands = ctx.on('commands/change', () => { this.observe() })
    this.stopPreset = ctx.on('agent-preset/selected', (sessionId) => {
      if (sessionId !== this.agent.id) return
      this.observe()
    })

    const activeRegistry = ctx.get('sessionProjections')
    if (activeRegistry !== undefined) this.attach(activeRegistry, false)
    const projectionFiber = ctx.inject(['sessionProjections'], projectionCtx => {
      return this.attach(projectionCtx.sessionProjections)
    })
    this.stopRegistryBinding = () => {
      void projectionFiber.dispose().catch(error => ctx.logger.error(error))
    }

    this.observe(false)
    this.lastRevision = this.revision()
  }

  permissionSnapshot(): SessionPermissionSnapshot {
    if (this.disposed) {
      return Object.freeze({
        available: false,
        writable: false,
        stale: false,
        generation: this.generation,
        selecting: false,
        options: Object.freeze([]),
      })
    }
    return Object.freeze({
      available: this.available,
      writable: this.writable,
      stale: this.stale,
      generation: this.generation,
      selecting: this.selecting,
      ...(this.currentValue === undefined ? {} : { currentValue: this.currentValue }),
      ...(this.currentPolicy === undefined ? {} : { currentPermission: this.currentPolicy }),
      options: Object.freeze(this.options.map(cloneOption)),
      ...(this.error === undefined ? {} : { error: this.error }),
    })
  }

  async selectPermission(
    value: string,
    options: SessionPermissionSelectOptions = {},
  ): Promise<void> {
    this.assertOpen()
    if (!this.available) {
      throw new Error('Permission presets are unavailable in this Session composition')
    }
    if (this.stale) {
      throw new Error('Permission projection is stale; wait for the live Session view')
    }
    if (!this.writable) {
      throw new Error('Official permission write command is unavailable')
    }
    if (this.selecting) throw new Error('A permission switch is already running')
    if (value === CUSTOM_PERMISSION_VALUE) {
      throw new Error(`Permission preset "${value}" is current-only and cannot be selected`)
    }
    const selected = this.options.find(option => option.value === value)
    if (selected === undefined) {
      throw new Error(`Permission preset "${value}" is not advertised by this Session`)
    }
    if (value === this.currentValue) {
      throw new Error(`This Session already uses permission preset "${value}"`)
    }
    const current = this.currentPolicy
    const target = selected.permission
    if (current === undefined || target === undefined || this.currentValue === undefined) {
      throw new Error('Permission policy metadata is unavailable; cannot select this preset')
    }
    const confirmation = options.confirmation
    if (permissionWidens(current, target) && confirmation === undefined) {
      throw new Error('Wider permissions require explicit confirmation before switching')
    }
    if (confirmation !== undefined && (
      confirmation.fromValue !== this.currentValue
      || confirmation.toValue !== value
      || confirmation.generation !== this.generation
    )) throw new Error('Permission confirmation is stale; review the current preset again')

    const signal = options.signal ?? new AbortController().signal
    signal.throwIfAborted()
    this.selecting = true
    this.error = undefined
    this.publishIfChanged()
    try {
      const commands = this.commandRuntime()
      this.assertLiveAgent()
      if (
        JSON.stringify(currentPermission(this.ctx, this.agent)) !== JSON.stringify(current)
        || JSON.stringify(presetPermission(this.ctx, this.agent, value)) !== JSON.stringify(target)
      ) throw new Error('Permission policy changed; review the current preset again')
      if (!this.hasPermissionCommand(commands)) {
        throw new Error('Official permission write command is unavailable')
      }
      const execution = await commands.execute(
        this.agent,
        `/permission ${value}`,
        [],
        signal,
      )
      if (execution === undefined) {
        throw new Error('Official /permission command was not admitted')
      }
      if (execution.result.kind === 'error') {
        throw new Error(execution.result.text)
      }
      this.selecting = false
      this.observe()
    } catch (error: unknown) {
      this.selecting = false
      this.error = messageOf(error)
      this.publishIfChanged()
      throw error
    }
  }

  onPermissionsChanged(listener: () => void): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  disposePermissions(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopProjection?.()
    this.stopRegistryBinding()
    this.stopCommands()
    this.stopPreset()
    this.listeners.clear()
  }

  private attach(registry: SessionProjectionRegistry, publish = true): () => void {
    if (this.registry === registry) return this.stopProjection as () => void
    this.stopProjection?.()
    this.registry = registry
    let active = true
    const stopChanged = registry.onChanged((session, key) => {
      if (
        session !== this.agent.session
        || key !== 'permissions'
      ) return
      this.observe()
    })
    const release = () => {
      if (!active) return
      active = false
      stopChanged()
      this.stopProjection = undefined
      this.registry = undefined
      if (!this.disposed) this.observe()
    }
    this.stopProjection = release
    this.observe(publish)
    return release
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Session permission port is disposed')
  }

  private assertLiveAgent(): void {
    const agents = this.ctx.get('agents')
    if (agents === undefined) throw new Error('DSH Agent service is unavailable')
    if (agents.get(this.agent.id) !== this.agent) {
      throw new Error(`DSH Session "${this.agent.id}" is no longer the live Agent`)
    }
  }

  private commandRuntime(): CommandRuntime {
    const commands = this.ctx.get('commands')
    if (commands === undefined) throw new Error('DSH command service is unavailable')
    return commands
  }

  private hasPermissionCommand(commands: CommandRuntime): boolean {
    return commands.list(this.agent).some(command => command.name === 'permission')
  }

  private observe(publish = true): void {
    const registry = this.registry
    const commands = this.ctx.get('commands')
    try {
      this.assertLiveAgent()
      this.writable = commands !== undefined && this.hasPermissionCommand(commands)
      if (registry === undefined) {
        this.available = false
        this.stale = false
        this.currentValue = undefined
        this.currentPolicy = undefined
        this.options = Object.freeze([])
        this.error = undefined
      } else {
        const value = registry.snapshot(this.agent.session).values.permissions
        if (value === undefined) {
          this.available = false
          this.stale = false
          this.currentValue = undefined
          this.currentPolicy = undefined
          this.options = Object.freeze([])
          this.error = undefined
        } else {
          this.available = true
          this.stale = false
          this.currentValue = value.currentValue
          this.currentPolicy = currentPermission(this.ctx, this.agent)
          this.options = Object.freeze(value.options.map(option => projectOption(
            option,
            option.value === CUSTOM_PERMISSION_VALUE
              ? undefined
              : presetPermission(this.ctx, this.agent, option.value),
          )))
          this.error = undefined
        }
      }
    } catch (error: unknown) {
      this.stale = this.available
      this.error = messageOf(error)
    }
    if (publish) this.publishIfChanged()
  }

  private revision(): string {
    return JSON.stringify({
      available: this.available,
      writable: this.writable,
      stale: this.stale,
      selecting: this.selecting,
      currentValue: this.currentValue,
      currentPermission: this.currentPolicy,
      options: this.options,
      error: this.error,
    })
  }

  private publishIfChanged(): void {
    const revision = this.revision()
    if (revision === this.lastRevision) return
    this.lastRevision = revision
    this.generation += 1
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A view observer cannot veto the official projection drive.
      }
    }
  }
}
