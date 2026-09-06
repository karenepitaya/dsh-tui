import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- the standalone E2E script intentionally has no public declaration file
import { assertSuccessfulMockResult, commandSearchLineVisible, composerPromptLines, moveSelectionTo, startPty, waitForScreen, workspaceViewportReady } from '../scripts/official-dsh-e2e.mjs'

const execFileAsync = promisify(execFile)
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

function terminalFixture() {
  const output = new EventEmitter()
  const writes: string[] = []
  const pty = {
    write: (data: string) => { writes.push(data); output.emit('input', data) },
    onData: (listener: (data: string) => void) => {
      output.on('data', listener)
      return { dispose: () => { output.off('data', listener) } }
    },
    onExit: () => ({ dispose: () => {} }),
  }
  const state = startPty({ spawn: () => pty }, Terminal, '/fixture/preload.mjs', '/fixture/cli.mjs', '/fixture', {})
  const deliver = async (data: string) => {
    const drained = new Promise<void>(resolve => { state.events.once('parser-drain', resolve) })
    output.emit('data', data)
    await drained
    // Drain the waiting predicate's Promise continuation, without advancing time.
    await Promise.resolve()
  }
  const frame = (selection: string) => deliver(`\x1b[?2026h\x1b[H\x1b[2J${selection}\x1b[?2026l`)
  const nextInput = () => new Promise<string>(resolve => { output.once('input', resolve) })
  return { state, writes, deliver, frame, nextInput, dispose: () => state.terminal.dispose() }
}

describe('official E2E screen synchronization', () => {
  it('requires complete successful SSE output rather than an incidental client close', () => {
    expect(() => assertSuccessfulMockResult({ attempt: 2, outcome: 'completed', chunksSent: 4 }, '答🙂')).not.toThrow()
    for (const outcome of ['client_closed', 'reset', 'stalled', 'server_error']) {
      expect(() => assertSuccessfulMockResult({ attempt: 2, outcome, chunksSent: 4 }, '答🙂')).toThrow()
    }
    for (const chunksSent of [0, 1, 2, 3, 5]) {
      expect(() => assertSuccessfulMockResult({ attempt: 2, outcome: 'completed', chunksSent }, '答🙂')).toThrow()
    }
  })

  it('does not accept a matching partial VT frame before its split end marker', async () => {
    const fixture = terminalFixture()
    try {
      await fixture.frame('old frame')
      let settled = false
      const waiting = waitForScreen(fixture.state, (_lines: string[], text: string) => text.includes('target'), 'split frame', 1_000)
        .then(() => { settled = true })
      await fixture.deliver('\x1b[?2026h\x1b[Htarget\x1b[K')
      expect(settled).toBe(false)
      await fixture.deliver('\x1b[?2026')
      expect(settled).toBe(false)
      await fixture.deliver('l')
      await waiting
      expect(settled).toBe(true)
    } finally { fixture.dispose() }
  })

  it('does not count a resized description of the same selected mode as another Down', async () => {
    const fixture = terminalFixture()
    try {
      await fixture.frame('› 标准模式 [standard] · short')
      const firstDown = fixture.nextInput()
      const moving = moveSelectionTo(fixture.state, '极简模式', 'minimal mode', 1_000)
      await firstDown
      await fixture.frame('› 标准模式 [standard] · a longer description after resize')
      expect(fixture.writes).toEqual(['\x1b[B'])
      const secondDown = fixture.nextInput()
      await fixture.frame('› 标准模式 [standard]\r\n› PTC 模式 [code]')
      expect(fixture.writes).toEqual(['\x1b[B'])
      await fixture.frame('› PTC 模式 [code] · code tools')
      await secondDown
      expect(fixture.writes).toEqual(['\x1b[B', '\x1b[B'])
      await fixture.frame('› 极简模式 [minimal] · minimal tools')
      await moving
      expect(fixture.writes).toEqual(['\x1b[B', '\x1b[B'])
    } finally { fixture.dispose() }
  })

  it('requires body geometry to reach the new viewport after the outer frame has resized', async () => {
    const fixture = terminalFixture()
    try {
      fixture.state.terminal.resize(100, 6)
      const frame = (body: string) => fixture.frame(`MODES${' '.repeat(95)}\r\n${body}\x1b[6;1HEsc back${' '.repeat(92)}`)
      const baseline = fixture.state.completedFrames
      await frame(`模式${' '.repeat(76)}`)
      expect(workspaceViewportReady(fixture.state, 'MODES', 100, 6, baseline)).toBe(false)
      await frame(`模式${' '.repeat(96)}`)
      expect(workspaceViewportReady(fixture.state, 'MODES', 100, 6, baseline)).toBe(true)
      expect(workspaceViewportReady(fixture.state, 'MODES', 100, 6, fixture.state.completedFrames)).toBe(false)
      await fixture.deliver('\x1b[?2026h\x1b[3;1Hordinary detail\x1b[K\x1b[?2026l')
      expect(workspaceViewportReady(fixture.state, 'MODES', 100, 6, baseline)).toBe(true)
      await fixture.deliver(`\x1b[?2026h\x1b[3;1H\x1b[1mbold detail${' '.repeat(69)}\x1b[0m\x1b[K\x1b[?2026l`)
      expect(workspaceViewportReady(fixture.state, 'MODES', 100, 6, baseline)).toBe(false)
    } finally { fixture.dispose() }
  })

  it('ignores a background command suggestion when a modal has one selected connection method', async () => {
    const fixture = terminalFixture()
    try {
      await fixture.frame('     › Enter API key · id:api-key\r\n\r\n› /connect')
      await moveSelectionTo(fixture.state, 'id:api-key', 'API-key method', 100)
      expect(fixture.writes).toEqual([])
    } finally { fixture.dispose() }
  })
})

describe('official E2E Composer inspection', () => {
  it('reads exact input from the bottom prompt box instead of matching history', () => {
    const lines = [
      '╭──────────────────────╮',
      '│ > /old               │',
      '╰──────────────────────╯',
      '╭──────────────────────╮',
      '│ > /toolchain-check   │',
      '╰──────────────────────╯',
      'MODEL fixture',
    ]
    expect(composerPromptLines(lines)).toEqual(['> /toolchain-check'])
    expect(commandSearchLineVisible(lines, '/toolchain-check')).toBe(true)
    expect(commandSearchLineVisible(lines, '/toolchain')).toBe(false)
    expect(commandSearchLineVisible(lines, '/old')).toBe(false)
  })

  it('recognizes a blank boxed prompt and rejects incomplete or non-bottom boxes', () => {
    expect(commandSearchLineVisible(['╭──────╮', '│ >    │', '╰──────╯', 'MODEL fixture'], '')).toBe(true)
    expect(composerPromptLines(['│ > /old │', '╰────────╯', 'MODEL fixture'])).toEqual([])
    expect(composerPromptLines(['╭──────╮', '│ >    │', '╰──────╯', '', 'MODEL fixture'])).toEqual([])
  })
})

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
        '-NodeExecutable',
        process.execPath,
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
    expect(stdout).toContain('workspace_resize=80x24+100x30+140x30+200x30+80x6')
    expect(stdout).toContain('workspace_pages=16 workspace_model_requests=0')
    expect(stdout).toContain('workspace_screens=')
    expect(stdout).toContain('approval_inspection=80x6-controls+80x3-fail-closed+argument-tail+default-reject+draft-preserved')
    expect(stdout).toContain('ctrl_o=draft+cursor+visible-response+model-requests-0')
    expect(stdout).toContain('mock=request+result')
    expect(stdout).toContain('session=contiguous')
    expect(stdout).toMatch(/providers=dynamic-\d+/)
    expect(stdout).toContain('connect=deepseek-official+openai')
    expect(stdout).toContain('provider_credentials=isolated')
    expect(stdout).toContain('provider_models=live')
    expect(stdout).toContain('provider_model_requests=0')
    expect(stdout).toContain('command=goal')
    expect(stdout).toContain('command_events=paired')
    expect(stdout).toContain('command_model_requests=0')
    expect(stdout).toContain('catalog=live-switch-current-noop')
    expect(stdout).toContain('catalog_events=none')
    expect(stdout).toContain('catalog_model_requests=0')
    expect(stdout).toContain('context=official-token-meter')
    expect(stdout).toContain('statusline=model+effort+context+cache+tokens')
    expect(stdout).toContain('compact=official-execution+durable-transaction+live-status')
    expect(stdout).toContain('context_model_requests=0')
    expect(stdout).toContain('compaction_model_requests=1')
    expect(stdout).toContain('permission=official-projection+command-switch+restored-read-only')
    expect(stdout).toContain('permission_model_requests=0')
    expect(stdout).toContain('model_picker=session-to-deepseek-v4-pro+off')
    expect(stdout).toContain('model_picker_requests=0')
    expect(stdout).toContain('booted_profile=verified')
    expect(stdout).toContain('global_tools=empty')
    expect(stdout).toContain('fresh_preset=standard')
    expect(stdout).toContain('startup_mode=standard-direct')
    expect(stdout).toContain('mode_switch=standard-to-minimal-same-session')
    expect(stdout).toContain('mode_catalog=standard-compact-to-minimal-no-compact')
    expect(stdout).toContain('skills=user-picker+literal-token+official-pre-step-injection+model-tool')
    expect(stdout).toContain('fresh_presets=standard')
    expect(stdout).toContain('mode_selected_events=minimal-once')
    expect(stdout).toContain('alt_screen=once-per-process')
    expect(stdout).toMatch(/minimal_session_events=\d+/)
    expect(stdout).toContain('minimal_command=goal')
    expect(stdout).toContain('minimal_command_events=paired')
    expect(stdout).toContain('minimal_command_model_requests=0')
    expect(stdout).toContain('host_rows=exact')
    expect(stdout).toContain('catalogs=cold-after-fresh-exact')
    expect(stdout).toContain('audit_generation=owned')
    expect(stdout).toContain('guidance=standard-exact-scoped-section')
    expect(stdout).toContain('complete_prompt=resumed-minimal-persona-only')
    expect(stdout).toContain('time_context=profile+fresh-resume-snapshots')
    expect(stdout).toContain('image_admission=official-memory-png+malformed-rejected')
    expect(stdout).toContain('tool_directory=exact-agent-25+read-only+model-requests-0')
    expect(stdout).toContain('runtime_library=settings-redacted-browse+loader-read-only+model-requests-0')
    expect(stdout).toContain('preferences=feature-document+jk-navigation+model-requests-0')
    expect(stdout).toContain('standard_toolchain=catalog-25+calls-16+approval-allow-reject+question-answer-cancel+goal-action-pause-resume-pause+plan-review-approve+job-run-kill')
    expect(stdout).toContain('workbench=goal-active-paused-active-paused+plan-on-review-off+todo-live+activity-live-killed')
    expect(stdout).toContain('toolchain_model_requests=17')
    expect(stdout).toContain('toolchain_retry_requests=1')
    expect(stdout).toContain('request_recovery=official-retry+statusline+attempt-workspace')
    expect(stdout).toContain('request_route=official-header-context+route-workspace')
    expect(stdout).toContain('toolchain_title_requests=1')
    expect(stdout).toContain('toolchain_search_requests=1')
    expect(stdout).toMatch(/toolchain_session_events=\d+/)
    expect(stdout).toContain('fresh_cli_model=deepseek-v4-flash-vision-exp+off')
    expect(stdout).toContain('cold_resume=explicit-over-history+default')
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
    expect(stdout).toContain('toolchain_exit=0 toolchain_recovery=exact')
    expect(stdout).toMatch(/toolchain_pid=\d+ toolchain_process=gone/)
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
