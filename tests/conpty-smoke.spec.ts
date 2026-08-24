import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('Windows ConPTY release gate', () => {
  it.each([
    ['controller-flow', 'graceful'],
    ['controller-force', 'forced'],
  ] as const)(
    'runs the %s product scenario through a real pseudoconsole',
    async (scenario, shutdown) => {
      const scriptPath = fileURLToPath(
        new URL('../scripts/conpty-smoke.ps1', import.meta.url),
      )

      const { stdout, stderr } = await execFileAsync(
        process.env.PWSH_EXE ?? 'pwsh',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          scriptPath,
          '-Scenario',
          scenario,
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          encoding: 'utf8',
          timeout: 20_000,
          windowsHide: true,
        },
      )

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
})
