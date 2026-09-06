import type { TerminalInputAction } from '../terminal/input.ts'
import { legacyListInput, navigateLegacyDirectory, type LegacyDirectoryNavigation } from '../navigation/legacy-directory.ts'
import type { TerminalViewport } from '../ui/frame.ts'
import { connectionWorkspaceDetails, workspaceDirectoryDetailViewport } from '../ui/workspace-directory-details.ts'
import {
  createPromptEditorState,
  reducePromptEditor,
  type PromptEditorAction,
  type PromptEditorState,
} from '../ui/prompt-editor.ts'
import {
  ProviderAuthorizationDeclinedError,
  type ProviderAuthorizationNotice,
  type ProviderAuthorizationPrompt,
  type ProviderConnectionEntry,
  type ProviderConnectionPort,
  type ProviderConnectionSnapshot,
} from './port.ts'

export type ProviderConnectStage =
  | 'providers'
  | 'methods'
  | 'working'
  | 'prompt'
  | 'confirm-disconnect'

export interface ProviderConnectView {
  readonly navigation?: LegacyDirectoryNavigation
  readonly stage: ProviderConnectStage
  readonly providers: readonly ProviderConnectionEntry[]
  readonly selectedProviderIndex: number
  readonly selectedMethodIndex: number
  readonly prompt?: ProviderAuthorizationPrompt
  readonly editor: PromptEditorState
  readonly selectedOptionIndex: number
  readonly notices: readonly ProviderAuthorizationNotice[]
  readonly loading: boolean
  readonly busy: boolean
  readonly error?: string
  readonly notice?: string
}

interface PendingPrompt {
  readonly prompt: ProviderAuthorizationPrompt
  readonly resolve: (answer: string) => void
  readonly reject: (error: unknown) => void
  readonly stopWatching: () => void
}

const EMPTY_SNAPSHOT: ProviderConnectionSnapshot = Object.freeze({
  providers: Object.freeze([]),
  writable: false,
})

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clamped(index: number, count: number): number {
  if (count === 0) return -1
  return Math.min(count - 1, Math.max(0, index))
}

const PROMPT_EDITOR_ACTIONS: readonly TerminalInputAction['type'][] = Object.freeze([
  'insert',
  'backspace',
  'delete',
  'move-left',
  'move-right',
  'move-home',
  'move-end',
])

function editorAction(action: TerminalInputAction): PromptEditorAction | undefined {
  return PROMPT_EDITOR_ACTIONS.includes(action.type)
    ? action as PromptEditorAction
    : undefined
}

/** Owns the app-global `/connect` surface without depending on a Session. */
export class ProviderConnectController {
  private navigation: LegacyDirectoryNavigation = { focus: 'list', detailOffset: 0 }
  private openState = false
  private stage: ProviderConnectStage = 'providers'
  private snapshot: ProviderConnectionSnapshot = EMPTY_SNAPSHOT
  private providerIndex = -1
  private methodIndex = -1
  private optionIndex = -1
  private editor = createPromptEditorState()
  private notices: ProviderAuthorizationNotice[] = []
  private loading = false
  private busy = false
  private error: string | undefined
  private directoryError: string | undefined
  private notice: string | undefined
  private stopChanges: (() => void) | undefined
  private refreshAbort: AbortController | undefined
  private refreshTask: Promise<void> | undefined
  private refreshQueued = false
  private operationAbort: AbortController | undefined
  private operationTask: Promise<void> | undefined
  private pendingPrompt: PendingPrompt | undefined

  constructor(
    private readonly port: ProviderConnectionPort,
    private readonly invalidate: () => void,
    private readonly viewport: () => TerminalViewport = () => ({ columns: 80, rows: 24 }),
  ) {}

  get isOpen(): boolean {
    return this.openState
  }

  get pendingCount(): number {
    return Number(this.refreshTask !== undefined) + Number(this.operationTask !== undefined)
  }

  view(): ProviderConnectView | undefined {
    if (!this.openState) return undefined
    return {
      stage: this.stage,
      ...(this.stage === 'providers' ? { navigation: this.navigation } : {}),
      providers: this.snapshot.providers,
      selectedProviderIndex: this.providerIndex,
      selectedMethodIndex: this.methodIndex,
      ...(this.pendingPrompt === undefined ? {} : { prompt: this.pendingPrompt.prompt }),
      editor: this.editor,
      selectedOptionIndex: this.optionIndex,
      notices: this.notices,
      loading: this.loading,
      busy: this.busy,
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
    }
  }

  open(): void {
    if (this.openState) return
    this.openState = true
    this.stage = 'providers'
    this.navigation = { focus: 'list', detailOffset: 0 }
    this.error = undefined
    this.directoryError = undefined
    this.notice = undefined
    this.notices = []
    this.stopChanges = this.port.onChanged(() => { this.refresh() })
    this.refresh()
    this.invalidate()
  }

  close(reason = 'provider connection surface closed'): void {
    if (!this.openState) return
    this.openState = false
    this.stopChanges?.()
    this.stopChanges = undefined
    this.refreshQueued = false
    this.refreshAbort?.abort(reason)
    this.operationAbort?.abort(reason)
    this.rejectPrompt(new ProviderAuthorizationDeclinedError(reason))
    this.invalidate()
  }

  quiesce(): void {
    this.close('DSH-TUI is shutting down')
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([
      this.refreshTask ?? Promise.resolve(),
      this.operationTask ?? Promise.resolve(),
    ])
  }

  handleInput(action: TerminalInputAction): void {
    if (!this.openState) return
    if (this.stage === 'prompt') {
      this.handlePromptInput(action)
      return
    }
    if (this.stage === 'working') {
      if (action.type === 'escape' || action.type === 'interrupt') this.cancelOperation()
      return
    }
    if (action.type === 'escape' || action.type === 'interrupt') {
      if (this.stage === 'providers') this.close()
      else this.backToProviders()
      return
    }
    if (this.stage === 'confirm-disconnect') {
      if (action.type === 'submit') this.beginDisconnect()
      return
    }
    action = legacyListInput(action)
    if (this.stage === 'providers' && !(action.type === 'insert' && action.paste !== true && ['r', 'R', 'd', 'D'].includes(action.text))) {
      const viewport = this.viewport()
      const maximum = workspaceDirectoryDetailViewport(connectionWorkspaceDetails(this.view()!), viewport).maxOffset
      const navigation = navigateLegacyDirectory({ navigation: this.navigation }, action, { searchEnabled: false, maxDetailOffset: maximum, pageSize: Math.max(1, viewport.rows - 2) })
      this.navigation = navigation.navigation
      if (navigation.action === undefined) {
        this.invalidate()
        return
      }
      action = navigation.action
    }
    if (action.type === 'move-up' || action.type === 'move-down') {
      const delta = action.type === 'move-up' ? -1 : 1
      if (this.stage === 'providers') {
        this.providerIndex = clamped(this.providerIndex + delta, this.snapshot.providers.length)
      } else {
        this.methodIndex = clamped(this.methodIndex + delta, this.selectedProvider()?.methods.length ?? 0)
      }
      this.error = undefined
      this.invalidate()
      return
    }
    if (this.stage === 'providers' && action.type === 'insert') {
      const key = action.text.toLowerCase()
      if (key === 'r') this.refresh()
      else this.requestDisconnect()
      return
    }
    if (action.type !== 'submit') return
    if (this.stage === 'providers') this.openMethods()
    else this.beginConnect()
  }

  private selectedProvider(): ProviderConnectionEntry | undefined {
    return this.snapshot.providers[this.providerIndex]
  }

  private backToProviders(): void {
    this.stage = 'providers'
    this.navigation = { focus: 'list', detailOffset: 0 }
    this.methodIndex = -1
    this.error = undefined
    this.invalidate()
  }

  private openMethods(): void {
    const provider = this.selectedProvider()
    if (provider === undefined) {
      this.error = 'No Provider is available'
      this.invalidate()
      return
    }
    if (provider.methods.length === 0) {
      this.error = `${provider.name} exposes no connection method`
      this.invalidate()
      return
    }
    this.stage = 'methods'
    this.methodIndex = 0
    this.error = undefined
    this.notice = undefined
    this.invalidate()
  }

  private requestDisconnect(): void {
    const provider = this.selectedProvider()
    if (provider === undefined || !provider.canDisconnect) {
      this.error = provider === undefined
        ? 'No Provider is available'
        : `${provider.name} has no removable local connection`
      this.invalidate()
      return
    }
    this.stage = 'confirm-disconnect'
    this.error = undefined
    this.invalidate()
  }

  private beginConnect(): void {
    const provider = this.selectedProvider()
    const method = provider?.methods[this.methodIndex]
    if (provider === undefined || method === undefined || this.operationTask !== undefined) return
    const abort = new AbortController()
    this.operationAbort = abort
    this.stage = 'working'
    this.busy = true
    this.error = undefined
    this.notice = undefined
    this.notices = []
    let task!: Promise<void>
    task = Promise.resolve()
      .then(() => this.port.connect(provider.id, method.id, {
        notify: value => { this.receiveNotice(task, value) },
        prompt: value => this.receivePrompt(task, value),
      }, { signal: abort.signal }))
      .then((outcome) => {
        if (!this.isCurrentOperation(task)) return
        this.notice = outcome.status === 'connected'
          ? `${provider.name} connected`
          : `${provider.name} connection cancelled`
      })
      .catch((error: unknown) => {
        if (!this.isCurrentOperation(task) || abort.signal.aborted) return
        this.error = `Connection failed: ${messageOf(error)}`
      })
      .finally(() => { this.finishOperation(task) })
    this.operationTask = task
    this.invalidate()
  }

  private beginDisconnect(): void {
    const provider = this.selectedProvider()
    if (provider === undefined || this.operationTask !== undefined) return
    const abort = new AbortController()
    this.operationAbort = abort
    this.stage = 'working'
    this.busy = true
    this.error = undefined
    this.notice = undefined
    this.notices = []
    let task!: Promise<void>
    task = Promise.resolve()
      .then(() => this.port.disconnect(provider.id, { signal: abort.signal }))
      .then(() => {
        if (this.isCurrentOperation(task)) this.notice = `${provider.name} disconnected locally`
      })
      .catch((error: unknown) => {
        if (!this.isCurrentOperation(task) || abort.signal.aborted) return
        this.error = `Disconnect failed: ${messageOf(error)}`
      })
      .finally(() => { this.finishOperation(task) })
    this.operationTask = task
    this.invalidate()
  }

  private isCurrentOperation(task: Promise<void>): boolean {
    return this.openState && this.operationTask === task
  }

  private finishOperation(task: Promise<void>): void {
    /* v8 ignore next -- only the Promise stored as operationTask installs this finalizer */
    if (this.operationTask !== task) return
    this.operationTask = undefined
    this.operationAbort = undefined
    this.busy = false
    this.rejectPrompt(new ProviderAuthorizationDeclinedError('provider operation finished'))
    if (!this.openState) return
    this.stage = 'providers'
    this.methodIndex = -1
    this.refresh()
    this.invalidate()
  }

  private cancelOperation(): void {
    const abort = this.operationAbort
    if (abort === undefined || abort.signal.aborted) return
    this.notice = 'Cancelling Provider connection'
    this.rejectPrompt(new ProviderAuthorizationDeclinedError())
    abort.abort('DSH-TUI Provider connection cancelled by user')
    this.invalidate()
  }

  private receiveNotice(task: Promise<void>, notice: ProviderAuthorizationNotice): void {
    if (!this.isCurrentOperation(task)) return
    this.notices = [...this.notices.slice(-7), notice]
    this.invalidate()
  }

  private receivePrompt(
    task: Promise<void>,
    prompt: ProviderAuthorizationPrompt,
  ): Promise<string> {
    if (!this.isCurrentOperation(task)) {
      return Promise.reject(new ProviderAuthorizationDeclinedError('provider surface is no longer active'))
    }
    this.rejectPrompt(new ProviderAuthorizationDeclinedError('provider replaced its previous prompt'))
    return new Promise<string>((resolve, reject) => {
      const withdrawn = (): void => {
        /* v8 ignore next -- replacing a prompt removes this exact abort listener synchronously */
        if (this.pendingPrompt?.prompt !== prompt) return
        this.pendingPrompt = undefined
        this.stage = 'working'
        this.invalidate()
        reject(new Error('provider authorization prompt was withdrawn'))
      }
      prompt.signal?.addEventListener('abort', withdrawn, { once: true })
      this.pendingPrompt = {
        prompt,
        resolve,
        reject,
        stopWatching: () => { prompt.signal?.removeEventListener('abort', withdrawn) },
      }
      this.stage = 'prompt'
      this.editor = createPromptEditorState()
      this.optionIndex = prompt.kind === 'select' ? clamped(0, prompt.options.length) : -1
      this.error = undefined
      this.invalidate()
    })
  }

  private handlePromptInput(action: TerminalInputAction): void {
    const pending = this.pendingPrompt
    /* v8 ignore next -- stage "prompt" is entered and left with pendingPrompt atomically */
    if (pending === undefined) return
    if (action.type === 'escape' || action.type === 'interrupt') {
      this.stage = 'working'
      this.rejectPrompt(new ProviderAuthorizationDeclinedError())
      this.invalidate()
      return
    }
    if (pending.prompt.kind === 'select') {
      if (action.type === 'move-up' || action.type === 'move-down') {
        const delta = action.type === 'move-up' ? -1 : 1
        this.optionIndex = clamped(this.optionIndex + delta, pending.prompt.options.length)
        this.error = undefined
        this.invalidate()
      } else if (action.type === 'submit') {
        const answer = pending.prompt.options[this.optionIndex]?.id
        if (answer === undefined) {
          this.error = 'No authorization option is available'
          this.invalidate()
        } else {
          this.resolvePrompt(answer)
        }
      }
      return
    }
    if (action.type === 'submit') {
      const answer = this.editor.text.trim()
      if (answer === '') {
        this.error = 'Answer cannot be blank'
        this.invalidate()
      } else {
        this.resolvePrompt(answer)
      }
      return
    }
    const reduced = editorAction(action)
    if (reduced === undefined) return
    this.editor = reducePromptEditor(this.editor, reduced)
    this.error = undefined
    this.invalidate()
  }

  private resolvePrompt(answer: string): void {
    const pending = this.pendingPrompt
    /* v8 ignore next -- resolvePrompt is called only from a rendered pending prompt */
    if (pending === undefined) return
    this.pendingPrompt = undefined
    pending.stopWatching()
    this.stage = 'working'
    this.editor = createPromptEditorState()
    this.optionIndex = -1
    pending.resolve(answer)
    this.invalidate()
  }

  private rejectPrompt(error: unknown): void {
    const pending = this.pendingPrompt
    if (pending === undefined) return
    this.pendingPrompt = undefined
    pending.stopWatching()
    this.editor = createPromptEditorState()
    this.optionIndex = -1
    pending.reject(error)
  }

  private refresh(): void {
    if (!this.openState) return
    if (this.refreshTask !== undefined) {
      this.refreshQueued = true
      return
    }
    const selectedId = this.selectedProvider()?.id
    const abort = new AbortController()
    this.refreshAbort = abort
    this.loading = true
    let task!: Promise<void>
    task = Promise.resolve()
      .then(() => this.port.list({ signal: abort.signal }))
      .then((snapshot) => {
        if (!this.isCurrentRefresh(task, abort)) return
        this.snapshot = snapshot
        const retained = selectedId === undefined
          ? -1
          : snapshot.providers.findIndex(provider => provider.id === selectedId)
        this.providerIndex = retained >= 0
          ? retained
          : clamped(this.providerIndex < 0 ? 0 : this.providerIndex, snapshot.providers.length)
        if (this.error === this.directoryError) this.error = undefined
        this.directoryError = undefined
      })
      .catch((error: unknown) => {
        if (!this.isCurrentRefresh(task, abort)) return
        const detail = `Provider directory unavailable: ${messageOf(error)}`
        this.directoryError = detail
        this.error = detail
      })
      .finally(() => {
        /* v8 ignore next -- refreshes serialize; a queued refresh starts only after this finalizer */
        if (this.refreshTask !== task) return
        this.refreshTask = undefined
        this.refreshAbort = undefined
        this.loading = false
        const restart = this.openState && this.refreshQueued
        this.refreshQueued = false
        if (restart) this.refresh()
        this.invalidate()
      })
    this.refreshTask = task
  }

  private isCurrentRefresh(task: Promise<void>, abort: AbortController): boolean {
    return this.openState
      && this.refreshTask === task
      && this.refreshAbort === abort
      && !abort.signal.aborted
  }
}
