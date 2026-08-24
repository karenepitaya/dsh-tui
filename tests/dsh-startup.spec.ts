import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  internals as cmdlineInternals,
  provideCmdline,
} from '@deepseek-ai/dsh-cmdline'
import { parseDshTuiStartup } from '../src/dsh/startup.ts'

const originalStdout = cmdlineInternals.stdout
const originalStderr = cmdlineInternals.stderr

afterEach(() => {
  cmdlineInternals.stdout = originalStdout
  cmdlineInternals.stderr = originalStderr
})

function startupHarness(args: readonly string[]): {
  readonly ctx: Context
  readonly exits: number[]
  readonly stdout: string[]
  readonly stderr: string[]
} {
  const ctx = new Context()
  const exits: number[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  cmdlineInternals.stdout = { write: chunk => { stdout.push(chunk) } }
  cmdlineInternals.stderr = { write: chunk => { stderr.push(chunk) } }
  provideCmdline(ctx, {
    args: [...args],
    exit: code => { exits.push(code) },
  })
  return { ctx, exits, stdout, stderr }
}

describe('DSH-TUI startup grammar', () => {
  it('maps the create flags through the official command-line parser', () => {
    const harness = startupHarness([
      '--session-id',
      'created-session',
      '--cwd',
      'D:\\Projects\\DSH-Project',
      '--agent-preset',
      'code',
    ])

    expect(parseDshTuiStartup(harness.ctx)).toEqual({
      mode: 'create',
      sessionId: 'created-session',
      cwd: 'D:\\Projects\\DSH-Project',
      agentPreset: 'code',
    })
    expect(harness.exits).toEqual([])
  })

  it('maps --resume to one resume request', () => {
    const harness = startupHarness(['--resume', 'existing-session'])

    expect(parseDshTuiStartup(harness.ctx)).toEqual({
      mode: 'resume',
      sessionId: 'existing-session',
    })
    expect(harness.exits).toEqual([])
  })

  it('uses create mode when no selector is supplied', () => {
    const harness = startupHarness([])

    expect(parseDshTuiStartup(harness.ctx)).toEqual({ mode: 'create' })
  })

  it.each([
    {
      args: ['--resume', 'one', '--session-id', 'two'],
      message: '--resume cannot be combined with --session-id',
    },
    {
      args: ['--resume', 'one', '--cwd', 'D:\\work'],
      message: '--resume cannot be combined with --cwd',
    },
    {
      args: ['--resume', 'one', '--agent-preset', 'minimal'],
      message: '--resume cannot be combined with --agent-preset',
    },
    {
      args: ['--session-id', '   '],
      message: '--session-id must not be blank',
    },
    {
      args: ['--resume', '   '],
      message: '--resume must not be blank',
    },
    {
      args: ['--cwd', '   '],
      message: '--cwd must not be blank',
    },
    {
      args: ['--agent-preset', '   '],
      message: '--agent-preset must not be blank',
    },
  ])('fails closed for invalid arguments: $message', ({ args, message }) => {
    const harness = startupHarness(args)

    expect(parseDshTuiStartup(harness.ctx)).toBeUndefined()
    expect(harness.exits).toEqual([1])
    expect(harness.stderr.join('')).toContain(message)
  })

  it('returns no startup request after official help handling exits cleanly', () => {
    const harness = startupHarness(['--help'])

    expect(parseDshTuiStartup(harness.ctx)).toBeUndefined()
    expect(harness.exits).toEqual([0])
    expect(harness.stdout.join('')).toContain('--resume <session-id>')
    expect(harness.stdout.join('')).toContain('--agent-preset <preset-id>')
  })

  it('fails loud when the launcher omitted the official command-line services', () => {
    expect(() => parseDshTuiStartup(new Context())).toThrow(
      'launcher must provide ctx.cmdlineArgs and ctx.appExit',
    )
  })
})
