/** Product-owned metadata for one command's optional free-form input. */
export interface DshCommandInputDescriptor {
  readonly hint: string
  readonly images?: boolean
}

/** Handler-free command metadata exposed to the TUI. */
export interface DshCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: DshCommandInputDescriptor
}

/** Settled command outcome rendered by the product surface. */
export type DshCommandResult =
  | {
      readonly kind: 'success'
      readonly text?: string
      readonly sourceEventSeq?: number
    }
  | {
      readonly kind: 'error'
      readonly text: string
    }

/** One settled command invocation and its durable lifecycle pairing id. */
export interface DshCommandExecution {
  readonly commandId: string
  readonly result: DshCommandResult
}

/** Syntactically valid slash command split without normalizing raw input. */
export interface DshParsedCommand {
  readonly name: string
  readonly rawInput: string
}

/** Command discovery and execution seam owned by one live product session. */
export interface DshCommandPort {
  listCommands(): readonly DshCommandDescriptor[]
  parseCommand(line: string): DshParsedCommand | undefined
  executeCommand(
    line: string,
    signal: AbortSignal,
  ): Promise<DshCommandExecution | undefined>
  onCommandsChanged(listener: () => void): () => void
  disposeCommands(): void
}
