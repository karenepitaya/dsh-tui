import type {
  DshCommandDescriptor,
  DshCommandExecution,
  DshCommandPort,
  DshParsedCommand,
} from '../command/port.ts'
import type {
  DshInteractionPort,
  InteractionEventOptions,
  InteractionReceipt,
  InteractionResponse,
  InteractionSnapshot,
} from '../interaction/port.ts'
import type {
  CancelCause,
  Delivery,
  DshRuntimePort,
  RuntimeEventOptions,
  SubmitInput,
  SubmitResult,
} from './port.ts'
import type { SessionId } from './events.ts'
import type { DshRuntimeEventItem } from './delivery.ts'

/** One live DSH session composed from durable, interaction, and command seams. */
export class DshTuiSessionPort implements DshRuntimePort, DshInteractionPort, DshCommandPort {
  readonly sessionId: SessionId
  private disposePromise: Promise<void> | undefined

  constructor(
    private readonly runtime: DshRuntimePort,
    private readonly interaction: DshInteractionPort,
    private readonly commands: DshCommandPort,
  ) {
    this.sessionId = runtime.sessionId
  }

  events(options?: RuntimeEventOptions): AsyncIterable<DshRuntimeEventItem> {
    return this.runtime.events(options)
  }

  submit(input: SubmitInput, delivery: Delivery): Promise<SubmitResult> {
    return this.runtime.submit(input, delivery)
  }

  cancel(cause: CancelCause, options?: { readonly keepInbox?: boolean }): void {
    this.runtime.cancel(cause, options)
  }

  whenIdle(): Promise<void> {
    return this.runtime.whenIdle()
  }

  flush(): Promise<void> {
    return this.runtime.flush()
  }

  interactions(options?: InteractionEventOptions): AsyncIterable<InteractionSnapshot> {
    return this.interaction.interactions(options)
  }

  respond(response: InteractionResponse): InteractionReceipt {
    return this.interaction.respond(response)
  }

  disposeInteractions(): void {
    this.interaction.disposeInteractions()
  }

  listCommands(): readonly DshCommandDescriptor[] {
    return this.commands.listCommands()
  }

  parseCommand(line: string): DshParsedCommand | undefined {
    return this.commands.parseCommand(line)
  }

  executeCommand(
    line: string,
    signal: AbortSignal,
  ): Promise<DshCommandExecution | undefined> {
    return this.commands.executeCommand(line, signal)
  }

  onCommandsChanged(listener: () => void): () => void {
    return this.commands.onCommandsChanged(listener)
  }

  disposeCommands(): void {
    this.commands.disposeCommands()
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOwned()
    return this.disposePromise
  }

  private async disposeOwned(): Promise<void> {
    const errors: unknown[] = []
    try {
      this.commands.disposeCommands()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      this.interaction.disposeInteractions()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await this.runtime.dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
    if (errors.length !== 0) {
      throw new AggregateError(errors, 'DSH-TUI session disposal failed')
    }
  }
}
