import type {
  AgentPresetCatalogPort,
  AgentPresetCatalogSnapshot,
  AgentPresetSelectionPlan,
} from '../preset/catalog-port.ts'
import {
  applyStartupPresetPickerAction,
  createStartupPresetPickerState,
  openStartupPresetPicker,
  reconcileStartupPresetPicker,
  selectStartupPresetPicker,
  type StartupPresetPickerAction,
  type StartupPresetPickerOutcome,
  type StartupPresetPickerState,
} from '../preset/picker.ts'
import type {
  TerminalDriver,
  TerminalDriverCallbacks,
} from '../terminal/driver.ts'
import type { TerminalInputAction } from '../terminal/input.ts'
import {
  renderStartupPresetFrame,
  type StartupPresetPanel,
  type TerminalViewport,
} from '../ui/frame.ts'

export interface StartupPresetSelectorOptions {
  readonly catalog: AgentPresetCatalogPort
  readonly terminal: TerminalDriver
  readonly signal: AbortSignal
  readonly requestCancel: () => void
  readonly reportFatal: (error: unknown) => void
}

export interface StartupPresetSelectionLease {
  readonly plan: AgentPresetSelectionPlan
  release(): void
}

export type StartupPresetSelectionResult =
  | { readonly kind: 'selected'; readonly lease: StartupPresetSelectionLease }
  | { readonly kind: 'cancelled' }

export type StartupPresetSelector = (
  options: StartupPresetSelectorOptions,
) => Promise<StartupPresetSelectionResult>

type SelectorPhase =
  | 'idle'
  | 'selecting'
  | 'settling-selected'
  | 'settling-cancelled'
  | 'selected'
  | 'cancelled'
  | 'failed'
  | 'released'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const EMPTY_PRESET_CATALOG: AgentPresetCatalogSnapshot = Object.freeze({
  defaultId: '',
  presets: Object.freeze([]),
})

const CANCELLED_RESULT: StartupPresetSelectionResult = Object.freeze({
  kind: 'cancelled',
})

function errorMessage(error: unknown): string {
  try {
    const text = error instanceof Error ? error.message : String(error)
    return text.replace(/[\r\n]+/gu, ' ').trim() || 'Agent preset refresh failed'
  } catch {
    return 'Agent preset refresh failed'
  }
}

function blockedNotice(outcome: Extract<
  StartupPresetPickerOutcome,
  { readonly kind: 'blocked' }
>): string {
  switch (outcome.reason) {
    case 'broken':
      return 'Preset "' + outcome.presetId + '" is unavailable: ' + outcome.message
    case 'selection-missing':
      return 'Preset "' + outcome.presetId
        + '" is no longer available; refresh or select another preset'
    case 'no-selection':
      return 'No agent preset is available to select'
  }
}

class StartupPresetSelectionController {
  private phase: SelectorPhase = 'idle'
  private picker: StartupPresetPickerState = createStartupPresetPickerState()
  private snapshot = EMPTY_PRESET_CATALOG
  private viewport: TerminalViewport
  private loading = false
  private loaded = false
  private error: string | undefined
  private notice: string | undefined
  private refreshEpoch = 0
  private refreshAbort: AbortController | undefined
  private readonly rosterTasks = new Set<Promise<void>>()
  private readonly completion = deferred<StartupPresetSelectionResult>()

  private readonly callbacks: TerminalDriverCallbacks = {
    onInput: action => this.guardCallback(() => this.handleInput(action)),
    onResize: viewport => this.guardCallback(() => this.handleResize(viewport)),
  }

  private readonly handleAbort = (): void => {
    if (this.phase === 'selecting' || this.phase === 'settling-selected') {
      this.beginCancellation(false)
    }
  }

  constructor(private readonly options: StartupPresetSelectorOptions) {
    this.viewport = options.terminal.viewport
  }

  start(): Promise<StartupPresetSelectionResult> {
    if (this.options.signal.aborted) {
      this.phase = 'cancelled'
      this.completion.resolve(CANCELLED_RESULT)
      return this.completion.promise
    }

    this.phase = 'selecting'
    this.options.signal.addEventListener('abort', this.handleAbort)
    try {
      this.options.terminal.start(this.callbacks)
      if (this.phase !== 'selecting') return this.completion.promise
      this.loading = true
      this.render()
      if (this.phase === 'selecting') this.beginRefresh(false)
    } catch (error: unknown) {
      this.beginFailure(error)
    }
    return this.completion.promise
  }

  private handleInput(action: TerminalInputAction): void {
    if (this.phase === 'selected') {
      if (action.type === 'escape' || action.type === 'interrupt') {
        this.options.requestCancel()
      }
      return
    }
    if (this.phase === 'settling-selected') {
      if (action.type === 'escape' || action.type === 'interrupt') {
        this.beginCancellation(true)
      }
      return
    }
    if (this.phase !== 'selecting') return
    if (action.type === 'escape' || action.type === 'interrupt') {
      this.beginCancellation(true)
      return
    }
    if (action.type === 'insert' && action.text.toLowerCase() === 'r') {
      if (this.loaded) {
        const transition = applyStartupPresetPickerAction(
          this.picker,
          this.snapshot,
          { type: 'refresh' },
        )
        this.picker = transition.state
      }
      this.beginRefresh(true)
      return
    }

    const pickerAction: StartupPresetPickerAction | undefined =
      action.type === 'move-up' || action.type === 'move-down'
        ? { type: action.type }
        : action.type === 'submit'
          ? { type: 'enter' }
          : undefined
    if (pickerAction === undefined) return
    if (!this.loaded) {
      if (pickerAction.type === 'enter') {
        this.notice = 'Agent preset roster is not loaded'
        this.render()
      }
      return
    }

    const transition = applyStartupPresetPickerAction(
      this.picker,
      this.snapshot,
      pickerAction,
    )
    this.picker = transition.state
    const outcome = transition.outcome
    if (outcome === undefined) {
      this.notice = undefined
      this.render()
      return
    }
    this.applyDecision(outcome as Extract<
      StartupPresetPickerOutcome,
      { readonly kind: 'selected' | 'blocked' }
    >)
  }

  private applyDecision(outcome: Extract<
    StartupPresetPickerOutcome,
    { readonly kind: 'selected' | 'blocked' }
  >): void {
    switch (outcome.kind) {
      case 'selected':
        this.beginSelection(outcome.plan)
        return
      case 'blocked':
        this.notice = blockedNotice(outcome)
        this.render()
    }
  }

  private handleResize(viewport: TerminalViewport): void {
    if (
      this.phase !== 'selecting'
      && this.phase !== 'settling-selected'
      && this.phase !== 'selected'
    ) return
    this.viewport = viewport
    this.render()
  }

  private beginRefresh(renderLoading: boolean): void {
    this.refreshAbort?.abort()
    const epoch = ++this.refreshEpoch
    const abort = new AbortController()
    this.refreshAbort = abort
    this.loading = true
    this.error = undefined
    this.notice = undefined
    if (renderLoading) this.render()
    if (this.phase !== 'selecting') return

    const tracked = deferred<void>()
    this.rosterTasks.add(tracked.promise)
    void this.loadRoster(epoch, abort).then(
      () => tracked.resolve(),
      (error: unknown) => {
        this.beginFailure(error)
        tracked.resolve()
      },
    )
    void tracked.promise.then(() => { this.rosterTasks.delete(tracked.promise) })
  }

  private async loadRoster(epoch: number, abort: AbortController): Promise<void> {
    let next: AgentPresetCatalogSnapshot
    try {
      next = await this.options.catalog.listPresets({ signal: abort.signal })
    } catch (error: unknown) {
      if (!this.isCurrentRefresh(epoch, abort)) return
      this.refreshAbort = undefined
      this.loading = false
      this.error = errorMessage(error)
      this.render()
      return
    }
    if (!this.isCurrentRefresh(epoch, abort)) return
    this.refreshAbort = undefined
    this.picker = this.loaded
      ? reconcileStartupPresetPicker(this.picker, next)
      : openStartupPresetPicker(this.picker, next)
    this.snapshot = next
    this.loading = false
    this.loaded = true
    this.error = undefined
    this.notice = undefined
    this.render()
  }

  private isCurrentRefresh(epoch: number, abort: AbortController): boolean {
    return this.phase === 'selecting'
      && this.refreshEpoch === epoch
      && this.refreshAbort === abort
      && !abort.signal.aborted
  }

  private beginSelection(plan: AgentPresetSelectionPlan): void {
    this.phase = 'settling-selected'
    this.loading = false
    this.error = undefined
    this.notice = 'Starting preset "' + plan.id + '"…'
    this.render()
    this.stopRosterRefresh()
    void this.finishSelection(plan)
  }

  private async finishSelection(plan: AgentPresetSelectionPlan): Promise<void> {
    await this.joinRosterTasks()
    if (this.phase !== 'settling-selected') return
    this.phase = 'selected'
    let released = false
    const lease: StartupPresetSelectionLease = Object.freeze({
      plan,
      release: () => {
        if (released) return
        released = true
        this.phase = 'released'
        this.stopListeningForAbort()
      },
    })
    this.completion.resolve(Object.freeze({ kind: 'selected', lease }))
  }

  private beginCancellation(notifyOwner: boolean): void {
    this.phase = 'settling-cancelled'
    this.stopRosterRefresh()
    if (notifyOwner) {
      try {
        this.options.requestCancel()
      } catch (error: unknown) {
        this.beginFailure(error)
        return
      }
    }
    void this.finishCancellation()
  }

  private async finishCancellation(): Promise<void> {
    await this.joinRosterTasks()
    if (this.phase !== 'settling-cancelled') return
    this.phase = 'cancelled'
    this.stopListeningForAbort()
    this.completion.resolve(CANCELLED_RESULT)
  }

  private beginFailure(error: unknown): void {
    if (this.phase === 'selected') {
      this.reportFatal(error)
      return
    }
    this.phase = 'failed'
    this.stopRosterRefresh()
    void this.finishFailure(error)
  }

  private async finishFailure(error: unknown): Promise<void> {
    await this.joinRosterTasks()
    this.stopListeningForAbort()
    this.completion.reject(error)
  }

  private stopRosterRefresh(): void {
    this.refreshEpoch += 1
    this.refreshAbort?.abort()
    this.refreshAbort = undefined
    this.loading = false
  }

  private async joinRosterTasks(): Promise<void> {
    while (this.rosterTasks.size !== 0) {
      await Promise.allSettled([...this.rosterTasks])
    }
  }

  private stopListeningForAbort(): void {
    this.options.signal.removeEventListener('abort', this.handleAbort)
  }

  private currentPanel(): StartupPresetPanel {
    const view = this.loaded
      ? selectStartupPresetPicker(this.picker, this.snapshot)
      : undefined
    return {
      ...(view === undefined ? {} : { view }),
      loading: this.loading,
      loaded: this.loaded,
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
    }
  }

  private render(): void {
    this.options.terminal.render(renderStartupPresetFrame(
      this.currentPanel(),
      this.viewport,
    ))
  }

  private guardCallback(operation: () => void): void {
    try {
      operation()
    } catch (error: unknown) {
      this.beginFailure(error)
    }
  }

  private reportFatal(error: unknown): void {
    try {
      this.options.reportFatal(error)
    } catch {
      // Fatal reporting is containment-only after the selected result was returned.
    }
  }
}

export function selectStartupPreset(
  options: StartupPresetSelectorOptions,
): Promise<StartupPresetSelectionResult> {
  return new StartupPresetSelectionController(options).start()
}
