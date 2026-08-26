import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip
const scriptPath = fileURLToPath(
  new URL('../scripts/conpty-smoke.ps1', import.meta.url),
)

interface ExecFileFailure extends Error {
  readonly stderr?: Uint8Array
}

function decodeUtf8(bytes: Uint8Array, channel: string): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new Error(`${channel} was not valid UTF-8.`, { cause: error })
  }
  if (text.includes('\uFFFD')) {
    throw new Error(`${channel} contained the Unicode replacement character U+FFFD.`)
  }
  return text
}

function coloredTerminalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
    TERM: 'xterm-256color',
  }
  delete environment.NO_COLOR
  return environment
}

describeOnWindows('Windows ConPTY release gate', () => {
  it.each([
    ['controller-flow', 'graceful'],
    ['controller-force', 'forced'],
  ] as const)(
    'runs the %s product scenario through a real pseudoconsole',
    async (scenario, shutdown) => {
      const result = await execFileAsync(
        process.env.PWSH_EXE ?? 'pwsh',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          scriptPath,
          '-Scenario',
          scenario,
          '-NodeExecutable',
          process.execPath,
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          encoding: 'buffer',
          env: coloredTerminalEnvironment(),
          timeout: 20_000,
          windowsHide: true,
        },
      )
      const stdout = decodeUtf8(result.stdout, 'PowerShell stdout')
      const stderr = decodeUtf8(result.stderr, 'PowerShell stderr')

      expect(stderr).toBe('')
      expect(stdout).toContain('CONPTY_SMOKE_OK')
      expect(stdout).toContain(`scenario=${scenario}`)
      expect(stdout).toContain(`shutdown=${shutdown}`)
      expect(stdout).toContain('initial=80x24 resized=100x30')
      expect(stdout).toMatch(
        /pid=\d+ exit=0 process=gone pipe=closed handles=closed temp=confirmed/,
      )
    },
    25_000,
  )

  it('reports Unicode failures as UTF-8 even from a CP936 PowerShell host', async () => {
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
    const command = [
      '[System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)',
      '[System.Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936)',
      `& ${quote(scriptPath)} -EncodingFailureProbe`,
    ].join('; ')

    let failure: ExecFileFailure | undefined
    try {
      await execFileAsync(
        process.env.PWSH_EXE ?? 'pwsh',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          encoding: 'buffer',
          env: coloredTerminalEnvironment(),
          timeout: 5_000,
          windowsHide: true,
        },
      )
    } catch (error: unknown) {
      failure = error as ExecFileFailure
    }

    expect(failure).toBeDefined()
    const stderr = decodeUtf8(failure?.stderr ?? new Uint8Array(), 'PowerShell stderr')
    expect(stderr).toContain('ConPTY UTF-8 diagnostic probe: 真实错误')
    expect(stderr).not.toContain('\uFFFD')
  })
})
