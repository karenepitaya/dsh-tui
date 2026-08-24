import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('official DeepSeek Harness profile release gate', () => {
  it('runs DSH-TUI through the repo-local mock provider and a real ConPTY', async () => {
    const projectRoot = fileURLToPath(new URL('..', import.meta.url))
    const scriptPath = fileURLToPath(
      new URL('../scripts/official-dsh-e2e.ps1', import.meta.url),
    )

    const { stdout } = await execFileAsync(
      process.env.PWSH_EXE ?? 'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        scriptPath,
        '-TimeoutMilliseconds',
        '90000',
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 540_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    )

    expect(stdout).toContain('OFFICIAL_DSH_E2E_OK')
    expect(stdout).toContain('profile=tui')
    expect(stdout).toContain('initial=80x24 resized=100x30')
    expect(stdout).toContain('mock=request+result')
    expect(stdout).toContain('session=contiguous')
    expect(stdout).toContain('command=goal')
    expect(stdout).toContain('command_events=paired')
    expect(stdout).toContain('command_model_requests=0')
    expect(stdout).toContain('catalog=live-switch-current-noop')
    expect(stdout).toContain('catalog_events=none')
    expect(stdout).toContain('catalog_model_requests=0')
    expect(stdout).toContain('booted_profile=verified')
    expect(stdout).toContain('global_tools=empty')
    expect(stdout).toContain('fresh_preset=standard')
    expect(stdout).toContain('preset_picker=standard-enter+minimal-down2-enter')
    expect(stdout).toContain('preselection_artifacts=0')
    expect(stdout).toContain('fresh_presets=standard,minimal')
    expect(stdout).toContain('preset_selected_events=none')
    expect(stdout).toContain('alt_screen=once-per-process')
    expect(stdout).toMatch(/minimal_session_events=\d+/)
    expect(stdout).toContain('minimal_command=goal')
    expect(stdout).toContain('minimal_command_events=paired')
    expect(stdout).toContain('minimal_command_model_requests=0')
    expect(stdout).toContain('host_rows=exact')
    expect(stdout).toContain('catalogs=cold-after-fresh-exact')
    expect(stdout).toContain('audit_generation=owned')
    expect(stdout).toContain('cold_resume=historical-model+preset')
    expect(stdout).toContain('current_default=drifted')
    expect(stdout).toContain('resume_model=deepseek-v4-flash')
    expect(stdout).toContain('resume_preset=minimal')
    expect(stdout).toContain('current_model=deepseek-v4-pro')
    expect(stdout).toContain('current_preset=standard')
    expect(stdout).toContain('resume_transcript=replayed')
    expect(stdout).toContain('jsonl_prefix=preserved')
    expect(stdout).toContain('resume_suffix=contiguous')
    expect(stdout).toContain('resume_header=reason-resume')
    expect(stdout).toContain('resume_model_requests=1')
    expect(stdout).toMatch(/resumed_session_events=\d+/)
    expect(stdout).toMatch(/resume_suffix_events=\d+/)
    expect(stdout).toContain('exit=0 recovery=exact')
    expect(stdout).toMatch(/pid=\d+ process=gone temp=confirmed/)
    expect(stdout).toContain('minimal_exit=0 minimal_recovery=exact')
    expect(stdout).toMatch(/minimal_pid=\d+ minimal_process=gone/)
    expect(stdout).toContain('resume_exit=0 resume_recovery=exact')
    expect(stdout).toMatch(/resume_pid=\d+ resume_process=gone/)
    expect(stdout).toContain('missing_resume=fail-closed')
    expect(stdout).toContain('missing_exit=1 missing_terminal=never-allocated')
    expect(stdout).toContain('missing_model_requests=0')
    expect(stdout).toContain('missing_session_writes=0')
    expect(stdout).toMatch(/missing_pid=\d+ missing_process=gone/)
  }, 550_000)
})
