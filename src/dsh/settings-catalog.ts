import type { Context } from '@deepseek-ai/cordis'
import {
  type SettingsDescriptor,
  type SettingsPathOp,
  type SettingsProvider,
} from '@deepseek-ai/dsh-settings'
import type {
  SettingsCatalogPort,
  SettingsCatalogSnapshot,
  SettingsMutationRequest,
  SettingsNamespaceSnapshot,
} from '../settings/port.ts'

function errorMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error)
    return message.trim() === '' ? 'Settings descriptor failed' : message
  } catch {
    return 'Settings descriptor failed'
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

function cloneDescriptor(descriptor: SettingsDescriptor): SettingsNamespaceSnapshot {
  const detached = structuredClone({
    namespace: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    revision: descriptor.revision,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map(secret => ({
      path: [...secret.path],
      set: secret.set,
    })),
  }) as SettingsNamespaceSnapshot
  return deepFreeze(detached)
}

/** Host-global anti-corruption layer over the official redacted SettingsProvider. */
export class DshSettingsCatalog implements SettingsCatalogPort {
  private provider: SettingsProvider | undefined
  private readonly listeners = new Set<() => void>()
  private stopProvider: (() => void) | undefined
  private readonly stopServiceBinding: () => Promise<void>
  private generation = 0
  private disposed = false
  private lastGood: readonly SettingsNamespaceSnapshot[] = []

  constructor(private readonly ctx: Context) {
    const active = ctx.get('settings')
    if (active !== undefined) this.attach(active, ctx)
    const serviceFiber = ctx.inject(['settings'], (serviceCtx) => {
      /* v8 ignore next -- the injection callback cannot outlive its owner fiber */
      if (this.disposed) return
      return this.attach(serviceCtx.settings, serviceCtx)
    })
    this.stopServiceBinding = async () => {
      await serviceFiber.dispose()
    }
  }

  private attach(provider: SettingsProvider, eventContext: Context): () => void {
    if (this.provider === provider) return this.stopProvider!
    this.stopProvider?.()
    this.provider = provider
    this.generation += 1
    let active = true
    const stopDocument = eventContext.on('settings/document-updated', () => {
      if (!active || this.disposed || this.provider !== provider) return
      this.generation += 1
      this.notify()
    })
    const release = () => {
      if (!active) return
      active = false
      stopDocument()
      /* v8 ignore next -- attach releases the previous owner before publishing a replacement */
      if (this.provider !== provider) return
      this.provider = undefined
      this.stopProvider = undefined
      this.lastGood = []
      this.generation += 1
      if (!this.disposed) this.notify()
    }
    this.stopProvider = release
    this.notify()
    return release
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A TUI observer cannot veto a committed official settings document.
      }
    }
  }

  settingsSnapshot(): SettingsCatalogSnapshot {
    const provider = this.provider
    if (this.disposed || provider === undefined) {
      return deepFreeze({
        available: false,
        writable: false,
        documentBacked: false,
        generation: this.generation,
        namespaces: [],
      })
    }
    try {
      const namespaces = provider
        .describe({ redactSecrets: true })
        .map(cloneDescriptor)
      this.lastGood = Object.freeze(namespaces)
      return deepFreeze({
        available: true,
        writable: provider.writable,
        documentBacked: provider.documentPath !== undefined,
        generation: this.generation,
        namespaces: this.lastGood,
      })
    } catch (error: unknown) {
      return deepFreeze({
        available: this.lastGood.length > 0,
        writable: provider.writable,
        documentBacked: provider.documentPath !== undefined,
        generation: this.generation,
        namespaces: this.lastGood,
        ...(this.lastGood.length === 0 ? {} : { stale: true }),
        error: errorMessage(error),
      })
    }
  }

  onSettingsChanged(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  async mutateSettings(request: SettingsMutationRequest): Promise<void> {
    const provider = this.provider
    if (this.disposed || provider === undefined) {
      throw new Error('Settings service is unavailable')
    }
    const changes = request.operation === 'batch' ? request.changes : [request]
    const ops: SettingsPathOp[] = changes.map(change => change.operation === 'set'
      ? { op: 'set', path: [...change.path], value: change.value }
      : { op: 'unset', path: [...change.path] })
    await provider.mutate(
      request.namespace,
      ops,
      request.expectedRevision,
    )
  }

  async disposeSettings(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopProvider?.()
    this.listeners.clear()
    try {
      await this.stopServiceBinding()
    } catch (error: unknown) {
      this.ctx.logger.error(error)
    }
  }
}
