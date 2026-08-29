import type { Context } from '@deepseek-ai/cordis'
import type { Entry, Loader } from '@deepseek-ai/cordis-plugin-loader'
import type {
  PluginFiberPhase,
  PluginInventoryPort,
  PluginInventorySnapshot,
} from '../plugin-inventory/port.ts'

function errorMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error)
    return message.trim() === '' ? 'Loader inventory failed' : message
  } catch {
    return 'Loader inventory failed'
  }
}

function phaseOf(entry: Entry): PluginFiberPhase {
  switch (entry.fiber?.state as number | undefined) {
    case 0: return 'pending'
    case 1: return 'loading'
    case 2: return 'active'
    case 3: return 'failed'
    case 5: return 'unloading'
    case 4:
    case undefined:
    default: return null
  }
}

/** Same-process projection of the official Host Plugin Inventory read contract. */
export class DshPluginInventory implements PluginInventoryPort {
  private loader: Loader | undefined
  private stopLoader: (() => void) | undefined
  private readonly stopServiceBinding: () => Promise<void>
  private disposed = false

  constructor(private readonly ctx: Context) {
    const active = ctx.get('loader')
    if (active !== undefined) this.attach(active)
    const serviceFiber = ctx.inject(['loader'], (serviceCtx) => {
      /* v8 ignore next -- the injection callback cannot outlive its owner fiber */
      if (this.disposed) return
      return this.attach(serviceCtx.loader)
    })
    this.stopServiceBinding = async () => {
      await serviceFiber.dispose()
    }
  }

  private attach(loader: Loader): () => void {
    if (this.loader === loader) return this.stopLoader!
    this.stopLoader?.()
    this.loader = loader
    let active = true
    const release = () => {
      if (!active) return
      active = false
      /* v8 ignore next -- attach releases the previous owner before publishing a replacement */
      if (this.loader !== loader) return
      this.loader = undefined
      this.stopLoader = undefined
    }
    this.stopLoader = release
    return release
  }

  pluginInventorySnapshot(): PluginInventorySnapshot {
    const loader = this.loader
    if (this.disposed || loader === undefined) {
      return Object.freeze({ available: false, entries: Object.freeze([]) })
    }
    try {
      const entries = [...loader.entries()]
        .filter(entry => !entry.options.group)
        .map(entry => Object.freeze({
          entryId: String(entry.id),
          moduleName: String(entry.options.name),
          enabled: !entry.disabled,
          fiberPhase: phaseOf(entry),
        }))
      return Object.freeze({ available: true, entries: Object.freeze(entries) })
    } catch (error: unknown) {
      return Object.freeze({
        available: false,
        entries: Object.freeze([]),
        error: errorMessage(error),
      })
    }
  }

  async disposePluginInventory(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopLoader?.()
    try {
      await this.stopServiceBinding()
    } catch (error: unknown) {
      this.ctx.logger.error(error)
    }
  }
}
