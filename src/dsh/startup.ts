import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'
import { Command } from 'commander'
import type { DshTuiStartupRequest } from '../app/runner.ts'

interface DshTuiCommandOptions {
  readonly sessionId?: string
  readonly cwd?: string
  readonly resume?: string
  readonly agentPreset?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

function nonBlank(
  program: Command,
  flag:
    | '--session-id'
    | '--cwd'
    | '--resume'
    | '--agent-preset'
    | '--provider'
    | '--model'
    | '--reasoning-effort',
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (normalized === '') program.error(`${flag} must not be blank`)
  return normalized
}

/** Parse only DSH-TUI's product flags through the launcher's official adapter. */
export function parseDshTuiStartup(ctx: Context): DshTuiStartupRequest | undefined {
  const program = new Command()
    .name('dsh-tui')
    .description('Interactive terminal UI for DeepSeek Harness')
    .option('--session-id <session-id>', 'create a session with this id')
    .option('--cwd <path>', 'working directory for a new session')
    .option('--agent-preset <preset-id>', 'compose a new session from this Agent preset')
    .option('--resume <session-id>', 'resume an existing session')
    .option('--provider <route>', 'override the DSH model provider route')
    .option('--model <model-id>', 'override the opaque DSH model id')
    .option('--reasoning-effort <effort-id>', 'override the adapter-owned reasoning effort')

  let startup: DshTuiStartupRequest | undefined
  program.action(() => {
    const options = program.opts<DshTuiCommandOptions>()
    const sessionId = nonBlank(program, '--session-id', options.sessionId)
    const cwd = nonBlank(program, '--cwd', options.cwd)
    const resume = nonBlank(program, '--resume', options.resume)
    const agentPreset = nonBlank(program, '--agent-preset', options.agentPreset)
    const provider = nonBlank(program, '--provider', options.provider)
    const model = nonBlank(program, '--model', options.model)
    const reasoningEffort = nonBlank(
      program,
      '--reasoning-effort',
      options.reasoningEffort,
    )
    if ((provider === undefined) !== (model === undefined)) {
      program.error('--provider and --model must be provided together')
    }
    if (reasoningEffort !== undefined && provider === undefined) {
      program.error('--reasoning-effort requires --provider and --model')
    }
    if (resume !== undefined && sessionId !== undefined) {
      program.error('--resume cannot be combined with --session-id')
    }
    if (resume !== undefined && cwd !== undefined) {
      program.error('--resume cannot be combined with --cwd')
    }
    if (resume !== undefined && agentPreset !== undefined) {
      program.error('--resume cannot be combined with --agent-preset')
    }
    const selection = provider === undefined || model === undefined
      ? undefined
      : {
          provider,
          model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        }
    startup = resume === undefined
      ? {
          mode: 'create',
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(cwd === undefined ? {} : { cwd }),
          agentPreset: agentPreset ?? 'standard',
          ...(selection === undefined ? {} : { selection }),
        }
      : {
          mode: 'resume',
          sessionId: resume,
          ...(selection === undefined ? {} : { selection }),
        }
  })

  parseCmdline(ctx, program)
  return startup
}
