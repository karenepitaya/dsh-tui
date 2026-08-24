export type ShutdownPhase =
  | 'stop-input'
  | 'settle-interactions'
  | 'cancel-agent'
  | 'wait-agent-idle'
  | 'flush-session'
  | 'dispose-runtime'
  | 'restore-terminal'
  | 'request-app-exit'
  | 'force-exit'

export interface ShutdownIssue {
  readonly phase: ShutdownPhase
  readonly error: unknown
}

export interface ShutdownResult {
  readonly mode: 'graceful' | 'forced'
  readonly issues: readonly ShutdownIssue[]
}

export interface ShutdownHooks {
  stopAcceptingInput(): void | Promise<void>
  settleInteractions(): void
  cancelAgent(): void | Promise<void>
  whenAgentIdle(): void | Promise<void>
  flushSession(): void | Promise<void>
  disposeRuntime(): void | Promise<void>
  restoreTerminal(): void | Promise<void>
  requestAppExit(): void | Promise<void>
  forceExit(): void | Promise<void>
}

type CoordinatorState = 'running' | 'stopping' | 'stopped'

/**
 * First interrupt starts the ordered graceful path; a second explicit
 * interrupt races it with terminal restoration and the caller-owned forced
 * exit hook. Ordinary callers use graceful(), which is idempotent.
 */
export class ShutdownCoordinator {
  private state: CoordinatorState = 'running'
  private readonly issues: ShutdownIssue[] = []
  private gracefulPromise: Promise<ShutdownResult> | undefined
  private forcePromise: Promise<ShutdownResult> | undefined
  private restorePromise: Promise<void> | undefined
  private interactionsSettled = false
  private forced = false
  private readonly forcedSignal: Promise<void>
  private resolveForced!: () => void

  constructor(private readonly hooks: ShutdownHooks) {
    this.forcedSignal = new Promise<void>((resolve) => {
      this.resolveForced = resolve
    })
  }

  get currentState(): CoordinatorState {
    return this.state
  }

  graceful(): Promise<ShutdownResult> {
    if (this.gracefulPromise !== undefined) return this.gracefulPromise
    if (this.forcePromise !== undefined) return this.forcePromise
    this.state = 'stopping'
    this.gracefulPromise = this.runGraceful()
    return this.gracefulPromise
  }

  interrupt(): Promise<ShutdownResult> {
    if (this.state === 'running') return this.graceful()
    if (this.state === 'stopping' && !this.forced) void this.force()
    return (this.gracefulPromise ?? this.forcePromise)!
  }

  force(): Promise<ShutdownResult> {
    if (this.forcePromise !== undefined) return this.forcePromise
    this.state = 'stopping'
    this.forced = true
    this.resolveForced()
    this.forcePromise = this.runForce()
    return this.forcePromise
  }

  private async runGraceful(): Promise<ShutdownResult> {
    const phases: readonly [ShutdownPhase, () => void | Promise<void>][] = [
      ['stop-input', () => this.hooks.stopAcceptingInput()],
      ['settle-interactions', () => this.settleInteractions()],
      ['cancel-agent', () => this.hooks.cancelAgent()],
      ['wait-agent-idle', () => this.hooks.whenAgentIdle()],
      ['flush-session', () => this.hooks.flushSession()],
      ['dispose-runtime', () => this.hooks.disposeRuntime()],
      ['restore-terminal', () => this.restoreTerminal()],
      ['request-app-exit', () => this.hooks.requestAppExit()],
    ]
    for (const [phase, action] of phases) {
      const completed = await this.runGracefulPhase(phase, action)
      if (!completed) {
        const forcedResult = await this.force()
        return forcedResult
      }
    }
    this.state = 'stopped'
    return { mode: 'graceful', issues: [...this.issues] }
  }

  private async runGracefulPhase(
    phase: ShutdownPhase,
    action: () => void | Promise<void>,
  ): Promise<boolean> {
    const operation = Promise.resolve()
      .then(action)
      .then(
        () => true,
        (error: unknown) => {
          this.issues.push({ phase, error })
          return true
        },
      )
    return await Promise.race([
      operation,
      this.forcedSignal.then(() => false),
    ])
  }

  private async runForce(): Promise<ShutdownResult> {
    await this.capture('settle-interactions', () => this.settleInteractions())
    await this.capture('restore-terminal', () => this.restoreTerminal())
    await this.capture('force-exit', () => this.hooks.forceExit())
    this.state = 'stopped'
    return { mode: 'forced', issues: [...this.issues] }
  }

  private restoreTerminal(): Promise<void> {
    this.restorePromise ??= Promise.resolve().then(() => this.hooks.restoreTerminal())
    return this.restorePromise
  }

  private settleInteractions(): void {
    if (this.interactionsSettled) return
    this.interactionsSettled = true
    this.hooks.settleInteractions()
  }

  private async capture(
    phase: ShutdownPhase,
    action: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await action()
    } catch (error: unknown) {
      this.issues.push({ phase, error })
    }
  }
}
