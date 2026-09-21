import { stripTerminalSequences } from '@earendil-works/pi-tui'
import {
  type DshTuiControllerOptions,
  type DshTuiControllerResult,
  type DshTuiControllerState,
} from './controller.ts'
import type { TerminalDriver } from '../terminal/driver.ts'
import type { SessionCatalogPort } from '../session/catalog-port.ts'
import type {
  ActivatedSessionLease,
  SessionActivationPort,
} from '../session/activation-port.ts'
import type { SessionInspectionPort } from '../session/inspection-port.ts'
import type { SessionForkPort } from '../session/fork-port.ts'
import type { AgentPresetSelectionPlan } from '../preset/catalog-port.ts'
import type { ToolCardRendererRegistry } from '../presentation/tool-card-renderers.ts'
import type { DshTuiModelSelection } from '../model/port.ts'
import type { ProviderConnectionPort } from '../provider/port.ts'
import type { SettingsCatalogPort } from '../settings/port.ts'
import type { PluginInventoryPort } from '../plugin-inventory/port.ts'
import type { DshTuiFeatureHostPort } from './feature-host.ts'
import type { FeatureSessionRuntimePort } from './feature-session-runtime.ts'
import type { SessionNavigationHost } from './session-navigation-host.ts'
import type { WebHostPort, WebHostSummary } from './web-host.ts'
import type { PreferenceSource } from '../preferences/application.ts'

interface DshTuiCreateStartupRequest {
  readonly mode: 'create'
  readonly sessionId?: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly selection?: DshTuiModelSelection
}

interface DshTuiResumeStartupRequest {
  readonly mode: 'resume'
  readonly sessionId: string
  readonly selection?: DshTuiModelSelection
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
  readonly fork: SessionForkPort
  readonly providers?: ProviderConnectionPort
  readonly settings?: SettingsCatalogPort
  readonly pluginInventory?: PluginInventoryPort
  readonly features?: DshTuiFeatureHostPort
  /** App-owned transaction boundary for current Session Feature resources and surfaces. */
  readonly featureSession?: FeatureSessionRuntimePort
  readonly sessionNavigation?: SessionNavigationHost
  readonly preferences?: PreferenceSource
  readonly open: (request: DshTuiOpenRequest) => Promise<ActivatedSessionLease>
  readonly createTerminal: () => TerminalDriver
  readonly createController: (
    options: DshTuiControllerOptions,
  ) => DshTuiControllerPort
  readonly toolCards?: ToolCardRendererRegistry
  /** Web-host phase for the Controller's `/web`; product composition wires the Node host. */
  readonly webHost?: WebHostPort
  /** Official AppExit is synchronous and only requests bounded host shutdown. */
  readonly appExit: (code: number) => void
  /** Test seam for a second-interrupt exit after Controller has restored the terminal. */
  readonly forceExit: (code: number) => void
  readonly reportError: (message: string) => void
  readonly disposeOwner: () => void | Promise<void>
}

const DEFAULT_AGENT_PRESET = 'standard'

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
  private initialLease: ActivatedSessionLease | undefined
  private terminal: TerminalDriver | undefined
  private controller: DshTuiControllerPort | undefined
  private startupCancelled = false
  private fatalFailureRequested = false
  private fatalFailureTask: Promise<void> | undefined
  private task: Promise<void> | undefined
  private disposeTask: Promise<void> | undefined

  constructor(private readonly options: DshTuiProductRunnerOptions) {}

  start(): Promise<void> {
    if (this.hostDisposing) return this.disposeTask!
    if (this.task !== undefined) throw new Error('DSH-TUI product runner is already started')
    this.task = this.run()
    return this.task
  }

  /** Request one contained fatal shutdown from startup or a live required owner. */
  requestFatalFailure(error: unknown): Promise<void> {
    if (this.fatalFailureTask !== undefined) return this.fatalFailureTask
    this.fatalFailureRequested = true
    const failure = this.fail(error)
    this.fatalFailureTask = failure
    if (this.task === undefined) this.task = failure
    return failure
  }

  dispose(): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.hostDisposing = true
    if (this.webHostActive) this.options.webHost!.interrupt()
    this.abort.abort()
    this.disposeTask = Promise.resolve().then(() => this.disposeProduct())
    return this.disposeTask
  }

  /** Host signal entrypoint; repeated delivery uses Controller's existing forced-shutdown path. */
  requestSignalExit(): void {
    if (this.hostDisposing) return
    if (this.webHostActive) {
      this.options.webHost!.interrupt()
      return
    }
    this.abort.abort('DSH-TUI host termination signal')
    const controller = this.controller
    if (controller === undefined || controller.state === 'idle') {
      this.requestStartupCancellation()
      this.restoreTerminalNow()
      return
    }
    void controller.requestExit('signal').catch(error => { this.report(error) })
    this.restoreTerminalNow()
  }

  /** Best-effort synchronous recovery for SIGHUP and process 'exit'. */
  restoreTerminalNow(): void {
    const terminal = this.terminal
    if (terminal === undefined || terminal.state === 'restored') return
    try {
      terminal.stopAcceptingInput()
    } catch (error: unknown) {
      this.report(error)
    }
    try {
      terminal.restore()
    } catch (error: unknown) {
      this.report(error)
    }
  }

  private async run(): Promise<void> {
    try {
      const startup = this.options.startup
      const openRequest: DshTuiOpenRequest = startup.mode === 'create'
        ? {
            ...startup,
            agentPreset: startup.agentPreset ?? DEFAULT_AGENT_PRESET,
            signal: this.abort.signal,
          }
        : { ...startup, signal: this.abort.signal }

      const initialLease = await this.options.open(openRequest)
      this.initialLease = initialLease
      if (this.hostDisposing) return
      if (this.startupCancelled) {
        await this.completeStartupCancellation()
        return
      }

      this.terminal ??= this.options.createTerminal()
      if (this.hostDisposing) return

      const controllerOptions: DshTuiControllerOptions = {
        session: initialLease.port,
        sessionRelease: initialLease.release,
        catalog: this.options.catalog,
        activation: this.options.activation,
        inspection: this.options.inspection,
        fork: this.options.fork,
        ...(this.options.providers === undefined ? {} : { providers: this.options.providers }),
        ...(this.options.settings === undefined ? {} : { settings: this.options.settings }),
        ...(this.options.pluginInventory === undefined
          ? {}
          : { pluginInventory: this.options.pluginInventory }),
        ...(this.options.features === undefined ? {} : { features: this.options.features }),
        ...(this.options.featureSession === undefined
          ? {}
          : { featureSession: this.options.featureSession }),
        ...(this.options.sessionNavigation === undefined ? {} : { sessionNavigation: this.options.sessionNavigation }),
        ...(this.options.preferences === undefined ? {} : { preferences: this.options.preferences }),
        terminal: this.terminal,
        application: {
          requestExit: () => {},
          forceExit: () => { this.options.forceExit(130) },
        },
        ...(this.options.webHost === undefined
          ? {}
          : { webHost: this.options.webHost }),
        ...(this.options.toolCards === undefined
          ? {}
          : { toolCards: this.options.toolCards }),
      }
      this.controller = this.options.createController(controllerOptions)
      if (this.hostDisposing) return

      await this.controller.start()
      if (this.hostDisposing) return
      const result = await this.controller.wait()
      if (this.hostDisposing) return
      this.complete(result)
    } catch (error: unknown) {
      if (this.startupCancelled) await this.completeStartupCancellation()
      else await this.fail(error)
    }
  }

  private requestStartupCancellation(): void {
    if (this.hostDisposing || this.startupCancelled) return
    this.startupCancelled = true
    this.abort.abort('DSH-TUI startup was cancelled')
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

  private complete(result: DshTuiControllerResult): void {
    if (this.fatalFailureRequested) return
    if (result.ok) {
      if (result.reason === 'web-handoff'
        && result.webHostSummary !== undefined
        && this.options.webHost !== undefined) {
        void this.enterWebHost(result.webHostSummary)
        return
      }
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

  private webHostActive = false

  private async enterWebHost(summary: WebHostSummary): Promise<void> {
    this.webHostActive = true
    const startup = this.options.startup
    const cwd = summary.cwd ?? ('cwd' in startup ? startup.cwd : undefined)
    const merged: WebHostSummary = cwd === undefined ? summary : { ...summary, cwd }
    try {
      const code = await this.options.webHost!.runWebHost(merged)
      if (this.hostDisposing) return
      this.requestHostExit(code)
    } catch (error: unknown) {
      if (this.hostDisposing) return
      this.report(error)
      this.requestHostExit(1)
    }
  }

  private requestHostExit(code: number): void {
    if (this.exitIssued) return
    this.exitIssued = true
    this.options.appExit(code)
    // The host owns bounded shutdown (the official CLI force-exits after a 5s
    // grace). A host teardown that completes but leaks event-loop handles
    // leaves the process alive after a fatal failure — backstop it.
    const backstop = setTimeout(() => { this.options.forceExit(code) }, 6_000)
    backstop.unref()
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

    const initialLease = this.initialLease
    const terminal = this.terminal
    this.initialLease = undefined
    this.terminal = undefined
    const issues: { readonly resource: string; readonly error: unknown }[] = []
    if (initialLease !== undefined) {
      try {
        await initialLease.release()
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
