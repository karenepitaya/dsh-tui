import { DEFAULT_DSH_TUI_PREFERENCES, type DshTuiPreferencesV1 } from './contracts.ts'
import type { DshTuiPreferencesApplicationPort } from './port.ts'
import type { DshTuiThemeConfig } from '../theme/contracts.ts'

export interface PreferenceSource {
  snapshot(): DshTuiPreferencesV1
  onChanged(listener: (preferences: DshTuiPreferencesV1) => void): () => void
}

interface PreferenceRefreshRun {
  readonly task: Promise<void>
  readonly superseded: Promise<void>
  supersede(): void
}

/** App-owned preference observation. Data refresh is independent of view/layout. */
export class PreferenceApplication implements PreferenceSource {
  private current: DshTuiPreferencesV1
  private readonly listeners = new Set<(preferences: DshTuiPreferencesV1) => void>()
  private stop: (() => void) | undefined
  private task: Promise<void> | undefined
  private latestRefresh: PreferenceRefreshRun | undefined
  private epoch = 0
  private disposed = false

  constructor(
    private readonly port?: Pick<DshTuiPreferencesApplicationPort, 'read' | 'onChanged'>,
    theme?: DshTuiThemeConfig,
    private readonly reportError: (error: unknown) => void = () => {},
  ) {
    this.current = Object.freeze({
      ...DEFAULT_DSH_TUI_PREFERENCES,
      theme: theme ?? DEFAULT_DSH_TUI_PREFERENCES.theme,
    })
  }

  snapshot(): DshTuiPreferencesV1 { return this.current }

  start(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.task !== undefined) return this.task
    this.stop = this.port?.onChanged(() => { void this.refresh() })
    void this.refresh()
    this.task = this.waitForStableRefresh()
    return this.task
  }

  onChanged(listener: (preferences: DshTuiPreferencesV1) => void): () => void {
    if (this.disposed) throw new Error('Preference application is disposed')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.epoch++
    this.latestRefresh?.supersede()
    this.stop?.()
    this.listeners.clear()
  }

  private refresh(): Promise<void> {
    if (this.disposed || this.port === undefined) return Promise.resolve()
    const epoch = ++this.epoch
    this.latestRefresh?.supersede()
    let supersede!: () => void
    const superseded = new Promise<void>((resolve) => { supersede = resolve })
    const task = this.read(this.port, epoch)
    this.latestRefresh = { task, superseded, supersede }
    return task
  }

  private async waitForStableRefresh(): Promise<void> {
    while (!this.disposed) {
      const refresh = this.latestRefresh
      if (refresh === undefined) return
      await Promise.race([refresh.task, refresh.superseded])
      if (this.disposed) return
      if (this.latestRefresh !== refresh) continue
      return
    }
  }

  private async read(
    port: Pick<DshTuiPreferencesApplicationPort, 'read'>,
    epoch: number,
  ): Promise<void> {
    try {
      const next = await port.read()
      if (this.disposed || epoch !== this.epoch) return
      if (JSON.stringify(next.preferences) === JSON.stringify(this.current)) return
      this.current = next.preferences
      for (const listener of this.listeners) listener(this.current)
    } catch (error: unknown) {
      if (!this.disposed && epoch === this.epoch) this.reportError(error)
    }
  }
}
