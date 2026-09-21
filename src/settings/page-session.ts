import type { TerminalInputAction } from '../terminal/input.ts'
import type { TerminalViewport } from '../ui/frame.ts'
import type { ProviderConnectionPort } from '../provider/port.ts'
import type { PluginInventorySnapshot } from '../plugin-inventory/port.ts'
import type {
  SettingsCatalogPort,
  SettingsCatalogSnapshot,
  SettingsMutationRequest,
} from './port.ts'
import type { SettingsPageView, SettingsSaveResult } from './page-contracts.ts'
import {
  applySettingsPageInput,
  createSettingsPageState,
  projectSettingsDrafts,
  settleSettingsPageSave,
  stageSettingsMutation,
} from './page-machine.ts'
import {
  SettingsProvidersController,
  type SettingsProvidersView,
} from './providers-controller.ts'
import {
  applyRuntimeLibraryAction,
  createRuntimeLibraryState,
  openRuntimeLibrary,
  reconcileRuntimeLibrary,
  selectRuntimeLibrary,
  settleRuntimeLibraryMutation,
  type RuntimeLibraryAction,
  type RuntimeLibraryState,
  type RuntimeLibraryView,
} from '../runtime-library/surface.ts'
import { runtimeLibraryDetailViewport } from '../ui/workspace-runtime.ts'
import { settingsPermissionConfirmationFits } from '../ui/settings-page-frame.ts'
import { settingsProviderConfirmationFits } from '../ui/settings-providers-frame.ts'

/** Minimal contract every app-global page overlay session exposes to the controller. */
export interface PageSession {
  readonly isOpen: boolean
  readonly pendingCount: number
  open(): void
  handleInput(action: TerminalInputAction): void
  dismiss(): void
  quiesce(): void
  waitForIdle(): Promise<void>
}

export interface SettingsPageSessionOptions {
  readonly settings: SettingsCatalogPort | undefined
  readonly providers: ProviderConnectionPort | undefined
  /** Merged catalog snapshot (controller merges mode presets into the raw port snapshot). */
  readonly settingsSnapshot: () => SettingsCatalogSnapshot
  readonly pluginInventorySnapshot: () => PluginInventorySnapshot
  readonly navigationKeys: () => 'arrows' | 'vim' | 'both'
  readonly uiLanguage: () => 'en' | 'zh'
  readonly viewport: () => TerminalViewport
  /** Already gated on the controller phase; safe to call from async completions. */
  readonly invalidate: () => void
}

export interface SettingsPageFrame {
  readonly page: SettingsPageView
  readonly providers: SettingsProvidersView | undefined
}

function safeMessageOf(error: unknown, fallback: string): string {
  try {
    const message = error instanceof Error ? error.message : String(error)
    return message.trim() === '' ? fallback : message
  } catch {
    return fallback
  }
}

function mutationMessageOf(error: unknown): string {
  return safeMessageOf(error, 'unknown command error')
}

/** Owns the app-global settings/runtime-library overlay without depending on a Session. */
export class SettingsPageSession implements PageSession {
  private state: RuntimeLibraryState = createRuntimeLibraryState()
  private mutationTask: Promise<void> | undefined
  readonly providers: SettingsProvidersController | undefined

  constructor(private readonly options: SettingsPageSessionOptions) {
    this.providers = options.providers === undefined
      ? undefined
      : new SettingsProvidersController(options.providers, options.settings === undefined ? undefined : {
          settingsSnapshot: () => projectSettingsDrafts(this.state.page, options.settings!.settingsSnapshot()),
          mutateSettings: options.settings.mutateSettings.bind(options.settings),
          onSettingsChanged: listener => options.settings!.onSettingsChanged(listener),
        }, options.invalidate, request => {
          const page = this.state.page!
          const staged = stageSettingsMutation(page, this.state.settings, request)
          if (!staged) return false
          this.state = { ...this.state, page: staged }
          return true
        })
  }

  get isOpen(): boolean {
    return this.state.open
  }

  get pendingCount(): 0 | 1 {
    return this.mutationTask === undefined ? 0 : 1
  }

  /** Current immutable runtime-library state (test seam and frame fallback prop source). */
  get snapshot(): RuntimeLibraryState {
    return this.state
  }

  open(): void {
    this.providers?.close()
    this.state = openRuntimeLibrary(
      this.state,
      this.options.settingsSnapshot(),
      this.options.pluginInventorySnapshot(),
    )
    this.state = { ...this.state, page: createSettingsPageState() }
    this.options.invalidate()
  }

  /** Open the library directly on the providers management page (the typed /connect alias target). */
  openAtProviders(): void {
    this.open()
    const page = this.state.page
    if (page !== undefined) this.state = { ...this.state, page: { ...page, section: 'models' } }
    this.providers?.open()
    this.options.invalidate()
  }

  dismiss(): void {
    this.providers?.close()
    this.state = {
      ...createRuntimeLibraryState(),
      settings: this.state.settings,
      plugins: this.state.plugins,
    }
    this.options.invalidate()
  }

  /** Reconcile with the latest catalog/inventory after the settings port reports a change. */
  reconcile(): void {
    this.state = reconcileRuntimeLibrary(
      this.state,
      this.options.settingsSnapshot(),
      this.options.pluginInventorySnapshot(),
    )
    if (this.state.open) this.options.invalidate()
  }

  view(): RuntimeLibraryView | undefined {
    return selectRuntimeLibrary(this.state)
  }

  /** Page-view pieces for the early-return frame path: navigation keys applied, providers modal view when eligible. */
  viewForFrame(page: SettingsPageView): SettingsPageFrame {
    const keyed = { ...page, navigationKeys: this.options.navigationKeys(), uiLanguage: this.options.uiLanguage() }
    return {
      page: keyed,
      providers: keyed.section === 'models' && keyed.confirmation === undefined
        ? this.providers?.view()
        : undefined,
    }
  }

  quiesce(): void {
    this.providers?.quiesce()
  }

  async waitForIdle(): Promise<void> {
    await this.providers?.waitForIdle()
    await this.mutationTask
  }

  handleInput(action: TerminalInputAction): void {
    if (this.state.page !== undefined) {
      const page = this.state.page
      if (page.pending) return
      if (page.section === 'models' && page.confirmation === undefined && this.providers?.isModalOpen) {
        const providerView = this.providers.view()!
        const dialog = providerView.dialog!
        if (dialog.kind === 'manage' && !providerView.busy) {
          if (action.type === 'insert' && action.paste !== true && action.text === 'q') {
            this.state = { ...this.state, page: { ...page, focus: 'form' } }
            this.providers.handleInput(action)
            this.options.invalidate()
            return
          }

          if (action.type === 'complete') {
            this.state = { ...this.state, page: { ...page, focus: page.focus === 'actions' || Object.keys(page.drafts).length === 0 ? 'form' : 'actions' } }
            this.options.invalidate()
            return
          }
          if (action.type === 'save-default' || page.focus === 'actions') {
            if (action.type === 'escape') {
              this.state = { ...this.state, page: { ...page, focus: 'form' } }
            } else {
              const transition = applySettingsPageInput(page, this.state.settings, action)
              this.state = { ...this.state, page: transition.state }
              if (transition.outcome?.kind === 'save') this.beginSettingsPageSave(transition.outcome.requests)
            }
            this.options.invalidate()
            return
          }
        }
        if (action.type === 'submit' && dialog.rows[dialog.selection]?.id !== 'cancel'
          && !settingsProviderConfirmationFits(providerView, this.options.viewport())) {
          this.options.invalidate()
          return
        }
        this.providers.handleInput(action, this.options.navigationKeys())
        this.options.invalidate()
        return
      }
      if (page.confirmation === 'permission' && page.confirmIndex === 1 && action.type === 'submit'
        && !settingsPermissionConfirmationFits(this.options.viewport())) {
        this.state = { ...this.state, page: { ...page, error: 'Enlarge the terminal to read the permission notice before confirming.' } }
        this.options.invalidate()
        return
      }
      if (page.editor === undefined && page.focus !== 'search' && page.confirmation === undefined) {
        const preference = this.options.navigationKeys()
        if (action.type === 'insert' && action.paste !== true && /^[jk]{2,}$/.test(action.text)) {
          if (preference !== 'arrows') for (const text of action.text) this.handleInput({ type: 'insert', text })
          return
        }
        const keys = { h: 'move-left', j: 'move-down', k: 'move-up', l: 'move-right' } as const
        if (action.type === 'insert' && action.paste !== true && Object.hasOwn(keys, action.text)) {
          if (preference === 'arrows') return
          action = { type: keys[action.text as keyof typeof keys] }
        } else if (preference === 'vim' && ['move-left', 'move-right', 'move-up', 'move-down'].includes(action.type)) return
      }
      if (action.type === 'toggle-transcript-details') {
        if (Object.keys(page.drafts).length > 0 || page.editor !== undefined || page.picker !== undefined || page.confirmation !== undefined) {
          this.state = { ...this.state, page: { ...page, notice: '请先保存或取消更改，再打开高级配置。' } }
        } else {
          this.providers?.close()
          const { page: _page, ...advanced } = this.state
          this.state = advanced
        }
      } else {
        if (page.section === 'models' && this.providers !== undefined && page.confirmation === undefined) {
          if (action.type === 'complete') {
            const focuses = ['tabs', 'form', 'actions'] as const
            const index = focuses.indexOf(page.focus as typeof focuses[number])
            this.state = { ...this.state, page: { ...page,
              focus: focuses[(index + (action.reverse === true ? 2 : 1)) % 3]! } }
            this.options.invalidate()
            return
          }
          if (action.type === 'insert' && action.paste !== true && action.text === 'n') {
            this.providers.openAdd()
            this.options.invalidate()
            return
          }
          const parentAction = action.type === 'escape' || action.type === 'save-default'
            || action.type === 'insert' && action.paste !== true && ['[', ']', 'q'].includes(action.text)
          if (page.focus === 'form' && !parentAction) {
            this.providers.handleInput(action)
            this.options.invalidate()
            return
          }
        }
        const transition = applySettingsPageInput(page, this.state.settings, action)
        if (transition.state.drafts !== page.drafts) this.providers?.invalidateSettings()
        this.state = { ...this.state, page: transition.state }
        if (transition.outcome?.kind === 'close') this.dismiss()
        if (transition.outcome?.kind === 'save') this.beginSettingsPageSave(transition.outcome.requests)
        if (this.state.open && transition.state.section === 'models') this.providers?.open()
        else this.providers?.close()
      }
      this.options.invalidate()
      return
    }
    const view = selectRuntimeLibrary(this.state)!
    const inserting = view.focus === 'editor' || view.searchFocused === true
    let libraryAction: RuntimeLibraryAction | undefined
    const scroll = (delta: number): RuntimeLibraryAction => {
      const detail = runtimeLibraryDetailViewport(view, this.options.viewport())
      const offset = Math.max(0, Math.min(detail.maxOffset, detail.offset + delta))
      return { type: 'scroll', delta: offset - (this.state.detailScrollOffset ?? 0) }
    }
    switch (action.type) {
      case 'move-up':
      case 'move-down':
        libraryAction = view.tab === 'plugins' && view.focus === 'detail'
          ? scroll(action.type === 'move-up' ? -1 : 1) : action
        break
      case 'page-up':
      case 'page-down':
        if (!inserting) libraryAction = scroll((action.type === 'page-up' ? -1 : 1) * Math.max(1, this.options.viewport().rows - 5))
        break
      case 'complete':
        libraryAction = { type: action.reverse ? 'focus-previous' : 'focus-next' }
        break
      case 'move-left':
      case 'move-right':
        libraryAction = inserting
          ? { type: 'edit', action }
          : action.type === 'move-left'
            ? view.focus === 'catalog' ? undefined : { type: 'focus-previous' }
            : view.focus === 'detail' ? undefined : { type: 'focus-next' }
        break
      case 'insert':
        if (inserting) libraryAction = { type: 'edit', action }
        else if (action.paste !== true) {
          if (action.text === '/' || action.text === 'i') libraryAction = { type: 'search' }
          if (action.text === 'j' || action.text === 'k') libraryAction = view.tab === 'plugins' && view.focus === 'detail'
            ? scroll(action.text === 'j' ? 1 : -1)
            : { type: action.text === 'j' ? 'move-down' : 'move-up' }
          if (action.text === 'h' && view.focus !== 'catalog') libraryAction = { type: 'focus-previous' }
          if (action.text === 'l' && view.focus !== 'detail') libraryAction = { type: 'focus-next' }
          if (action.text === '[' || action.text === ']') libraryAction = { type: 'switch-tab' }
        }
        break
      case 'backspace':
      case 'delete':
      case 'move-home':
      case 'move-end':
        if (inserting) libraryAction = { type: 'edit', action }
        break
      case 'submit':
        libraryAction = { type: 'enter' }
        break
      case 'save-default':
        libraryAction = { type: 'inherit' }
        break
      case 'escape':
      case 'interrupt':
        libraryAction = { type: 'escape' }
        break
      case 'newline':
      case 'toggle-reasoning':
      case 'toggle-transcript-details':
      case 'toggle-goal-actions':
      case 'toggle-activity':
      case 'ignored':
        break
    }
    if (libraryAction === undefined) return
    const transition = applyRuntimeLibraryAction(this.state, libraryAction)
    this.state = transition.state
    switch (transition.outcome?.kind) {
      case 'mutate':
        this.beginSettingsMutation(transition.outcome.request)
        break
      case 'refresh-plugins':
        this.state = {
          ...reconcileRuntimeLibrary(
            this.state,
            this.options.settingsSnapshot(),
            this.options.pluginInventorySnapshot(),
          ),
          notice: 'Refreshed Loader snapshot',
          error: undefined,
        }
        break
      case 'cancelled':
      case undefined:
        break
    }
    this.options.invalidate()
  }

  beginSettingsMutation(request: SettingsMutationRequest): void {
    const port = this.options.settings
    if (port === undefined) {
      this.state = settleRuntimeLibraryMutation(
        this.state,
        this.options.settingsSnapshot(),
        this.options.pluginInventorySnapshot(),
        'Settings service is unavailable',
      )
      return
    }
    let task!: Promise<void>
    task = Promise.resolve()
      .then(() => port.mutateSettings(request))
      .then(
        () => { this.finishSettingsMutation(task, undefined) },
        (error: unknown) => { this.finishSettingsMutation(task, mutationMessageOf(error)) },
      )
    this.mutationTask = task
  }

  beginSettingsPageSave(requests: readonly SettingsMutationRequest[]): void {
    let task!: Promise<void>
    task = Promise.resolve().then(async () => {
      const results: SettingsSaveResult[] = []
      for (const request of requests) {
        try {
          if (this.options.settings === undefined) throw new Error('unavailable')
          await this.options.settings.mutateSettings(request)
          results.push({ namespace: request.namespace })
        } catch (error: unknown) {
          const conflict = /revision|conflict|stale/iu.test(mutationMessageOf(error))
          results.push({ namespace: request.namespace, error: conflict
            ? '配置已在其他地方更改。请取消草稿后重新编辑。'
            : '无法保存设置。请检查配置服务及文件写入权限后重试。' })
        }
      }
      this.mutationTask = undefined
      this.state = reconcileRuntimeLibrary(this.state, this.options.settingsSnapshot(), this.options.pluginInventorySnapshot())
      if (this.state.page !== undefined) this.state = {
        ...this.state,
        page: settleSettingsPageSave(this.state.page, this.state.settings, results),
      }
      this.providers?.invalidateSettings()
      this.options.invalidate()
    })
    this.mutationTask = task
  }

  finishSettingsMutation(task: Promise<void>, error: string | undefined): void {
    if (this.mutationTask !== task) return
    this.mutationTask = undefined
    this.state = settleRuntimeLibraryMutation(
      this.state,
      this.options.settingsSnapshot(),
      this.options.pluginInventorySnapshot(),
      error,
    )
    this.options.invalidate()
  }
}
