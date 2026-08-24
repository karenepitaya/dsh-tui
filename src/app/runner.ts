import { stripTerminalSequences } from '@earendil-works/pi-tui'
import {
  type DshTuiControllerOptions,
  type DshTuiControllerResult,
  type DshTuiControllerState,
  type DshTuiProductPort,
} from './controller.ts'
import type { TerminalDriver } from '../terminal/driver.ts'
import type { SessionCatalogPort } from '../session/catalog-port.ts'
import type { SessionActivationPort } from '../session/activation-port.ts'
import type { SessionInspectionPort } from '../session/inspection-port.ts'
import type {
  AgentPresetCatalogPort,
  AgentPresetSelectionPlan,
} from '../preset/catalog-port.ts'
import type {
  StartupPresetSelectionLease,
  StartupPresetSelector,
} from './startup-preset-selector.ts'
import type { ToolCardRendererRegistry } from '../presentation/tool-card-renderers.ts'

interface DshTuiCreateStartupRequest {
  readonly mode: 'create'
  readonly sessionId?: string
  readonly cwd?: string
  readonly agentPreset?: string
}

interface DshTuiResumeStartupRequest {
  readonly mode: 'resume'
  readonly sessionId: string
}

export type DshTuiStartupRequest =
  | DshTuiCreateStartupRequest
  | DshTuiResumeStartupRequest

export type DshTuiOpenRequest =
  | (DshTuiCreateStartupRequest & {
      readonly signal: AbortSignal
      readonly agentPresetPlan?: AgentPresetSelectionPlan
    })
  | (DshTuiResumeStartupRequest & {
      readonly signal: AbortSignal
      readonly agentPresetPlan?: never
    })

export interface DshTuiControllerPort {
  readonly state: DshTuiControllerState
  start(): Promise<void>
  requestExit(reason: 'user' | 'signal'): Promise<DshTuiControllerResult>
  wait(): Promise<DshTuiControllerResult>
}

export interface DshTuiProductRunnerOptions {
  readonly startup: DshTuiStartupRequest
  readonly catalog: SessionCatalogPort
  readonly activation: SessionActivationPort
  readonly inspection: SessionInspectionPort
  readonly presets: AgentPresetCatalogPort
  readonly open: (request: DshTuiOpenRequest) => Promise<DshTuiProductPort>
  readonly createTerminal: () => TerminalDriver
  readonly createController: (
    options: DshTuiControllerOptions,
  ) => DshTuiControllerPort
  readonly toolCards?: ToolCardRendererRegistry
  readonly selectStartupPreset: StartupPresetSelector
  /** Official AppExit is synchronous and only requests bounded host shutdown. */
  readonly appExit: (code: number) => void
  /** Test seam for a second-interrupt exit after Controller has restored the terminal. */
  readonly forceExit: (code: number) => void
  readonly reportError: (message: string) => void
  readonly disposeOwner: () => void | Promise<void>
}

function needsStartupPresetSelection(
  startup: DshTuiStartupRequest,
): startup is DshTuiCreateStartupRequest {
  return startup.mode === 'create' && startup.agentPreset === undefined
}

/** Collapse untrusted failures to one printable line before writing to a terminal. */
export function sanitizeDshTuiProductError(error: unknown): string {
  let source = ''
  try {
    source = error instanceof Error ? String(error.message) : String(error)
  } catch {
    return 'unknown error'
  }
  const sanitized = stripTerminalSequences(source)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return sanitized === '' ? 'unknown error' : sanitized
}

/**
 * Own the assembled product lifecycle. Cordis registers dispose() before
 * start(), and no lower layer requests host shutdown directly.
 */
export class DshTuiProductRunner {
  private readonly abort = new AbortController()
  private hostDisposing = false
  private exitIssued = false
  private session: DshTuiProductPort | undefined
  private terminal: TerminalDriver | undefined
  private controller: DshTuiControllerPort | undefined
  private startupPresetLease: StartupPresetSelectionLease | undefined
  private startupCancelled = false
  private startupFatal = false
  private startupError: unknown
  private task: Promise<void> | undefined
  private disposeTask: Promise<void> | undefined

  constructor(private readonly options: DshTuiProductRunnerOptions) {}

  start(): Promise<void> {
    if (this.task !== undefined) throw new Error('DSH-TUI product runner is already started')
    this.task = this.run()
    return this.task
  }

  dispose(): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.hostDisposing = true
    this.abort.abort()
    this.disposeTask = this.disposeProduct()
    return this.disposeTask
  }

  private async run(): Promise<void> {
    try {
      let openRequest: DshTuiOpenRequest
      let terminalStartMode: DshTuiControllerOptions['terminalStartMode']
      if (needsStartupPresetSelection(this.options.startup)) {
        this.terminal = this.options.createTerminal()
        if (this.hostDisposing) return

        const selection = await this.options.selectStartupPreset({
          catalog: this.options.presets,
          terminal: this.terminal,
          signal: this.abort.signal,
          requestCancel: () => { this.requestStartupCancellation() },
          reportFatal: error => { this.recordStartupFatal(error) },
        })
        if (this.hostDisposing) return
        if (selection.kind === 'selected') this.startupPresetLease = selection.lease
        if (this.startupFatal) throw this.startupError
        if (selection.kind === 'cancelled' || this.startupCancelled) {
          await this.completeStartupCancellation()
          return
        }
        const plan = selection.lease.plan
        openRequest = {
          ...this.options.startup,
          agentPreset: plan.id,
          agentPresetPlan: plan,
          signal: this.abort.signal,
        }
        terminalStartMode = 'adopt-running'
      } else {
        openRequest = {
          ...this.options.startup,
          signal: this.abort.signal,
        }
      }

      this.session = await this.options.open(openRequest)
      if (this.hostDisposing) return
      if (this.startupFatal) throw this.startupError
      if (this.startupCancelled) {
        await this.completeStartupCancellation()
        return
      }

      this.terminal ??= this.options.createTerminal()
      if (this.hostDisposing) return

      this.controller = this.options.createController({
        session: this.session,
        catalog: this.options.catalog,
        activation: this.options.activation,
        inspection: this.options.inspection,
        terminal: this.terminal,
        ...(terminalStartMode === undefined ? {} : { terminalStartMode }),
        application: {
          requestExit: () => {},
          forceExit: () => { this.options.forceExit(130) },
        },
        ...(this.options.toolCards === undefined
          ? {}
          : { toolCards: this.options.toolCards }),
      })
      if (this.hostDisposing) return

      await this.controller.start()
      this.releaseStartupPresetLease()
      if (this.hostDisposing) return
      const result = await this.controller.wait()
      if (this.hostDisposing) return
      this.complete(result)
    } catch (error: unknown) {
      if (this.startupFatal) await this.fail(this.startupError)
      else if (this.startupCancelled) await this.completeStartupCancellation()
      else await this.fail(error)
    }
  }

  private requestStartupCancellation(): void {
    if (this.hostDisposing || this.startupCancelled || this.startupFatal) return
    this.startupCancelled = true
    this.abort.abort('DSH-TUI startup preset selection was cancelled')
  }

  private recordStartupFatal(error: unknown): void {
    if (this.hostDisposing || this.startupCancelled || this.startupFatal) return
    this.startupFatal = true
    this.startupError = error
    this.abort.abort(error)
  }

  private async completeStartupCancellation(): Promise<void> {
    try {
      await this.stopOwnedResources()
    } catch (error: unknown) {
      await this.fail(error)
      return
    }
    if (this.hostDisposing) return
    try {
      this.requestHostExit(0)
    } catch (error: unknown) {
      this.report(error)
    }
  }

  private releaseStartupPresetLease(): void {
    const lease = this.startupPresetLease
    this.startupPresetLease = undefined
    lease?.release()
  }

  private complete(result: DshTuiControllerResult): void {
    if (result.ok) {
      this.requestHostExit(0)
      return
    }
    if (result.reason === 'forced') {
      this.requestHostExit(130)
      return
    }
    this.report(result.error ?? new Error('controller failed without an error'))
    this.requestHostExit(1)
  }

  private requestHostExit(code: number): void {
    if (this.exitIssued) return
    this.exitIssued = true
    this.options.appExit(code)
  }

  private report(error: unknown): void {
    try {
      this.options.reportError(`dsh-tui: ${sanitizeDshTuiProductError(error)}\n`)
    } catch {
      // Reporting is containment-only and must never reopen a failed lifecycle.
    }
  }

  private async fail(error: unknown): Promise<void> {
    let cleanupError: unknown
    try {
      await this.stopOwnedResources()
    } catch (caught: unknown) {
      cleanupError = caught
    }
    if (this.hostDisposing) return
    this.report(error)
    if (cleanupError !== undefined) this.report(cleanupError)
    if (this.exitIssued) return
    try {
      this.requestHostExit(1)
    } catch (exitError: unknown) {
      this.report(exitError)
    }
  }

  private async disposeProduct(): Promise<void> {
    try {
      try {
        await this.stopOwnedResources()
      } finally {
        try {
          await this.task
        } finally {
          await this.stopOwnedResources()
        }
      }
    } finally {
      await this.options.disposeOwner()
    }
  }

  private async stopOwnedResources(): Promise<void> {
    this.releaseStartupPresetLease()
    const controller = this.controller
    if (controller !== undefined) {
      if (controller.state === 'running') {
        await controller.requestExit('signal')
        return
      }
      if (controller.state === 'stopping' || controller.state === 'stopped') {
        await controller.wait()
        return
      }
      this.controller = undefined
    }

    const session = this.session
    const terminal = this.terminal
    this.session = undefined
    this.terminal = undefined
    const issues: { readonly resource: string; readonly error: unknown }[] = []
    if (session !== undefined) {
      try {
        await session.dispose()
      } catch (error: unknown) {
        issues.push({ resource: 'session', error })
      }
    }
    if (terminal !== undefined) {
      try {
        terminal.restore()
      } catch (error: unknown) {
        issues.push({ resource: 'terminal', error })
      }
    }
    if (issues.length !== 0) {
      const detail = issues
        .map(issue => `${issue.resource}: ${sanitizeDshTuiProductError(issue.error)}`)
        .join('; ')
      throw new AggregateError(
        issues.map(issue => issue.error),
        `product cleanup failed: ${detail}`,
      )
    }
  }
}
