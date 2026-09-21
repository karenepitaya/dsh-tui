import type { Context } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import {
  parseCommand as parseOfficialCommand,
  type CommandDescriptor,
  type CommandExecution,
  type CommandInputDescriptor,
  type CommandResult,
  type CommandRuntime,
} from '@deepseek-ai/dsh-commands'
import type {
  DshCommandDescriptor,
  DshCommandExecution,
  DshCommandInputDescriptor,
  DshCommandPort,
  DshCommandResult,
  DshParsedCommand,
} from '../command/port.ts'
import type { PromptImageInput } from '../attachment/port.ts'

function copyInput(input: CommandInputDescriptor): DshCommandInputDescriptor {
  return Object.freeze({
    hint: input.hint,
    ...(input.attachments === undefined ? {} : { images: input.attachments }),
  })
}

function copyDescriptor(descriptor: CommandDescriptor): DshCommandDescriptor {
  return Object.freeze({
    name: descriptor.name,
    description: descriptor.description,
    ...(descriptor.input === undefined ? {} : { input: copyInput(descriptor.input) }),
  })
}

function copyResult(result: CommandResult): DshCommandResult {
  if (result.kind === 'error') {
    return Object.freeze({ kind: 'error', text: result.text })
  }
  return Object.freeze({
    kind: 'success',
    ...(result.text === undefined ? {} : { text: result.text }),
    ...(result.sourceEventSeq === undefined
      ? {}
      : { sourceEventSeq: result.sourceEventSeq }),
  })
}

function copyExecution(execution: CommandExecution): DshCommandExecution {
  return Object.freeze({
    commandId: String(execution.commandId),
    result: copyResult(execution.result),
  })
}

/** Official per-Agent command adapter. No Harness types cross this boundary. */
export class DshCommandSession implements DshCommandPort {
  private readonly commands: CommandRuntime
  private readonly subscriptions = new Set<() => void>()
  private closed = false

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {
    const commands = ctx.get('commands')
    if (commands === undefined) throw new Error('DSH command service is unavailable')
    this.commands = commands
  }

  listCommands(): readonly DshCommandDescriptor[] {
    this.ensureAvailable()
    return Object.freeze(this.commands.list(this.agent).map(copyDescriptor))
  }

  parseCommand(line: string): DshParsedCommand | undefined {
    const parsed = parseOfficialCommand(line)
    return parsed === undefined
      ? undefined
      : Object.freeze({ name: parsed.name, rawInput: parsed.rawInput })
  }

  async executeCommand(
    line: string,
    signal: AbortSignal,
    images: readonly PromptImageInput[] = [],
  ): Promise<DshCommandExecution | undefined> {
    this.ensureAvailable()
    const encoded = images.map((image): EncodedImageAttachment & { readonly type: 'image' } => ({
      type: 'image',
      mediaType: image.mediaType,
      data: Buffer.from(image.data).toString('base64'),
      name: image.name,
    }))
    const execution = await this.commands.execute(this.agent, line, encoded, signal)
    return execution === undefined ? undefined : copyExecution(execution)
  }

  onCommandsChanged(listener: () => void): () => void {
    this.ensureAvailable()
    const stopCommands = this.ctx.on('commands/change', () => { listener() })
    const stopPreset = this.ctx.on('agent-preset/selected', (sessionId) => {
      if (sessionId === this.agent.id) listener()
    })
    let active = true
    const dispose = (): void => {
      if (!active) return
      active = false
      this.subscriptions.delete(dispose)
      stopCommands()
      stopPreset()
    }
    this.subscriptions.add(dispose)
    return dispose
  }

  disposeCommands(): void {
    if (this.closed) return
    this.closed = true
    for (const dispose of [...this.subscriptions]) dispose()
    this.subscriptions.clear()
  }

  private ensureAvailable(): void {
    if (this.closed) throw new Error('DSH command port is closed')
  }
}
