import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  createBrowserOpener,
  createNodeWebHost,
  parseWebUrl,
  renderWebHostFailurePanel,
  renderWebHostReadyPanel,
  renderWebHostSummaryPanel,
  resolveWebHostLogPath,
  spawnDetachedQuiet,
  type WebHostChildProcess,
  type WebHostSummary,
} from '../src/app/web-host.ts'

const SUMMARY: WebHostSummary = {
  sessionId: 'session-abc-123',
  cwd: 'D:\\work\\dsh-tui',
  model: 'deepseek/deepseek-chat',
  startedAt: new Date(2026, 8, 20, 15, 4, 5).getTime(),
}

class FakeChild extends EventEmitter implements WebHostChildProcess {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly kills: (string | undefined)[] = []
  kill(signal?: string): void {
    this.kills.push(signal)
  }
}

function createHarness(options: {
  readonly argv?: readonly string[]
  readonly exists?: (path: string) => boolean
  readonly child?: FakeChild
  readonly children?: FakeChild[]
  readonly openUrl?: (url: string) => void
  readonly logPath?: string
  readonly forceKillAfterMs?: number
} = {}) {
  const writes: string[] = []
  const logs: string[] = []
  const opened: string[] = []
  const spawns: { command: string, args: readonly string[] }[] = []
  const children = options.children ?? [options.child ?? new FakeChild()]
  const timers: { cb: () => void, ms: number, cancelled: boolean }[] = []
  const host = createNodeWebHost({
    argv: options.argv ?? ['node', '/dsh/bin.js'],
    execPath: '/node',
    exists: options.exists ?? (() => true),
    spawn: (command, args) => {
      spawns.push({ command, args })
      return children[spawns.length - 1]!
    },
    openUrl: options.openUrl ?? (url => { opened.push(url) }),
    write: text => { writes.push(text) },
    appendLog: text => { logs.push(text) },
    logPath: options.logPath ?? '/logs/dsh-tui-web.log',
    forceKillAfterMs: options.forceKillAfterMs ?? 5000,
    schedule: (cb, ms) => {
      const timer = { cb, ms, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  return { host, writes, logs, opened, spawns, children, timers }
}

describe('parseWebUrl', () => {
  it('parses the launcher URL line', () => {
    expect(parseWebUrl('dsh web: http://127.0.0.1:54190/?token=abc'))
      .toBe('http://127.0.0.1:54190/?token=abc')
  })

  it('ignores other lines', () => {
    expect(parseWebUrl('some other output')).toBeUndefined()
    expect(parseWebUrl('dsh web:')).toBeUndefined()
    expect(parseWebUrl('  dsh webx: http://x')).toBeUndefined()
  })
})

describe('panels', () => {
  it('renders the session summary with all fields', () => {
    const panel = renderWebHostSummaryPanel(SUMMARY)
    expect(panel).toContain('Bye!')
    expect(panel).toContain('session-abc-123')
    expect(panel).toContain('D:\\work\\dsh-tui')
    expect(panel).toContain('deepseek/deepseek-chat')
    expect(panel).toContain('2026-09-20 15:04')
    expect(panel).toContain('Starting the web UI')
  })

  it('omits absent optional summary fields', () => {
    const panel = renderWebHostSummaryPanel({ sessionId: 's-1' })
    expect(panel).toContain('s-1')
    expect(panel).not.toContain('Directory')
    expect(panel).not.toContain('Model')
    expect(panel).not.toContain('Started')
  })

  it('renders the ready panel with URL, stop hint, and log path', () => {
    const panel = renderWebHostReadyPanel('http://127.0.0.1:1/?token=t', '/logs/web.log')
    expect(panel).toContain('DSH web is ready')
    expect(panel).toContain('http://127.0.0.1:1/?token=t')
    expect(panel).toContain('Ctrl+C')
    expect(panel).toContain('/logs/web.log')
  })

  it('renders the failure panel with exit code and log path', () => {
    const panel = renderWebHostFailurePanel('/logs/web.log', 3)
    expect(panel).toContain('failed')
    expect(panel).toContain('3')
    expect(panel).toContain('/logs/web.log')
  })
})

describe('resolveWebHostLogPath', () => {
  it('prefers DSH_HOME when set', () => {
    expect(resolveWebHostLogPath({ DSH_HOME: join('/', 'dsh') }, join('/', 'home')))
      .toBe(join('/', 'dsh', 'logs', 'dsh-tui-web.log'))
  })

  it('falls back to the user home .dsh directory', () => {
    expect(resolveWebHostLogPath({}, join('/', 'home'))).toBe(join('/', 'home', '.dsh', 'logs', 'dsh-tui-web.log'))
    expect(resolveWebHostLogPath({ DSH_HOME: '' }, join('/', 'home')))
      .toBe(join('/', 'home', '.dsh', 'logs', 'dsh-tui-web.log'))
  })
})

describe('createBrowserOpener', () => {
  it('opens the default browser through rundll32 on Windows', () => {
    const calls: { command: string, args: readonly string[] }[] = []
    createBrowserOpener('win32', (command, args) => { calls.push({ command, args }) })('http://x/?token=t')
    expect(calls).toEqual([{
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'http://x/?token=t'],
    }])
  })

  it.each([
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
  ] as const)('opens %s with the platform opener', (platform, opener) => {
    const calls: string[] = []
    createBrowserOpener(platform, command => { calls.push(command) })('http://x')
    expect(calls).toEqual([opener])
  })

  it('defaults the platform to the current one', () => {
    const calls: string[] = []
    createBrowserOpener(undefined, command => { calls.push(command) })('http://x')
    expect(calls).toHaveLength(1)
  })

  it('spawns detached and quiet in production', () => {
    expect(() => spawnDetachedQuiet(process.execPath, ['-e', ''])).not.toThrow()
  })
})

describe('runWebHost', () => {
  it('prints the summary, spawns the web profile, prints the ready panel, and opens the browser', async () => {
    const child = new FakeChild()
    const harness = createHarness({ child })
    const run = harness.host.runWebHost(SUMMARY)
    child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:5001/?token=t1\n'))
    child.emit('exit', 0)
    await expect(run).resolves.toBe(0)

    expect(harness.spawns).toEqual([{
      command: '/node',
      args: ['/dsh/bin.js', '--profile', 'web', '--port', '0', '--no-open'],
    }])
    const output = harness.writes.join('')
    expect(output).toContain('Bye!')
    expect(output).toContain('DSH web is ready')
    expect(output).toContain('http://127.0.0.1:5001/?token=t1')
    expect(harness.opened).toEqual(['http://127.0.0.1:5001/?token=t1'])
    expect(harness.logs.join('')).toContain('dsh web: http://127.0.0.1:5001/?token=t1')
  })

  it('parses the URL across split chunks and only opens once', async () => {
    const child = new FakeChild()
    const harness = createHarness({ child })
    const run = harness.host.runWebHost(SUMMARY)
    child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.'))
    child.stdout.emit('data', Buffer.from('1:5001/?token=t1\n'))
    child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:5001/?token=t1\n'))
    child.emit('exit', 0)
    await expect(run).resolves.toBe(0)
    expect(harness.opened).toEqual(['http://127.0.0.1:5001/?token=t1'])
  })

  it('tees stderr to the log without printing it', async () => {
    const child = new FakeChild()
    const harness = createHarness({ child })
    const run = harness.host.runWebHost(SUMMARY)
    child.stderr.emit('data', Buffer.from('warning line\n'))
    child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:5001/?token=t1\n'))
    child.emit('exit', 0)
    await expect(run).resolves.toBe(0)
    expect(harness.logs.join('')).toContain('warning line')
    expect(harness.writes.join('')).not.toContain('warning line')
  })

  it('prints the failure panel when the child exits nonzero before the URL', async () => {
    const child = new FakeChild()
    const harness = createHarness({ child, logPath: '/logs/web.log' })
    const run = harness.host.runWebHost(SUMMARY)
    child.stderr.emit('data', Buffer.from('boom\n'))
    child.emit('exit', 1)
    await expect(run).resolves.toBe(1)
    const output = harness.writes.join('')
    expect(output).toContain('failed')
    expect(output).toContain('/logs/web.log')
    expect(harness.opened).toEqual([])
  })

  it('does not print the failure panel when the URL was already served', async () => {
    const child = new FakeChild()
    const harness = createHarness({ child })
    const run = harness.host.runWebHost(SUMMARY)
    child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:5001/?token=t1\n'))
    child.emit('exit', 1)
    await expect(run).resolves.toBe(1)
    expect(harness.writes.join('')).not.toContain('failed')
  })

  it('refuses when the CLI entrypoint cannot be resolved', async () => {
    const harness = createHarness({ exists: () => false })
    await expect(harness.host.runWebHost(SUMMARY)).resolves.toBe(1)
    expect(harness.writes.join('')).toContain('dsh --profile web')
    expect(harness.spawns).toEqual([])
  })

  it('maps a signal kill after interrupt to exit 130', async () => {
    const child = new FakeChild()
    const harness = createHarness({ child })
    const run = harness.host.runWebHost(SUMMARY)
    harness.host.interrupt()
    expect(harness.timers).toHaveLength(1)
    child.emit('exit', null)
    await expect(run).resolves.toBe(130)
  })

  it('force-kills the child when the grace timer fires', async () => {
    const child = new FakeChild()
    const harness = createHarness({ child })
    const run = harness.host.runWebHost(SUMMARY)
    harness.host.interrupt()
    expect(child.kills).toEqual([])
    harness.timers[0]!.cb()
    expect(child.kills).toEqual([undefined])
    child.emit('exit', null)
    await expect(run).resolves.toBe(130)
    expect(harness.timers[0]!.cancelled).toBe(true)
  })

  it('kills immediately on a second interrupt', async () => {
    const child = new FakeChild()
    const harness = createHarness({ child })
    const run = harness.host.runWebHost(SUMMARY)
    harness.host.interrupt()
    harness.host.interrupt()
    expect(child.kills).toEqual([undefined])
    expect(harness.timers[0]!.cancelled).toBe(true)
    child.emit('exit', null)
    await expect(run).resolves.toBe(130)
  })

  it('ignores interrupts before the child exists', () => {
    const harness = createHarness()
    expect(() => harness.host.interrupt()).not.toThrow()
  })

  it('refuses a second run', async () => {
    const child = new FakeChild()
    const harness = createHarness({ child, children: [child, new FakeChild()] })
    const run = harness.host.runWebHost(SUMMARY)
    await expect(harness.host.runWebHost(SUMMARY)).rejects.toThrow('already running')
    child.emit('exit', 0)
    await expect(run).resolves.toBe(0)
  })

  it('tolerates a child without stdio streams', async () => {
    const child = new FakeChild()
    ;(child as { stdout: unknown }).stdout = null
    ;(child as { stderr: unknown }).stderr = null
    const harness = createHarness({ child })
    const run = harness.host.runWebHost(SUMMARY)
    child.emit('exit', null)
    await expect(run).resolves.toBe(1)
    expect(harness.writes.join('')).not.toContain('failed')
  })

  it('resolves the default argv, execPath, opener, and environment eagerly', async () => {
    const child = new FakeChild()
    const writes: string[] = []
    const spawns: { command: string, args: readonly string[] }[] = []
    const host = createNodeWebHost({
      exists: () => true,
      spawn: (command, args) => {
        spawns.push({ command, args })
        return child
      },
      write: text => { writes.push(text) },
      appendLog: () => {},
      schedule: () => () => {},
    })
    const run = host.runWebHost({ sessionId: 's-1' })
    child.emit('exit', 0)
    await expect(run).resolves.toBe(0)
    expect(spawns[0]?.command).toBe(process.execPath)
    expect(spawns[0]?.args[0]).toBe(process.argv[1])
  })

  it('uses the default force-kill grace when none is given', async () => {
    const child = new FakeChild()
    const timers: { cb: () => void, ms: number }[] = []
    const host = createNodeWebHost({
      argv: ['node', '/dsh/bin.js'],
      execPath: '/node',
      exists: () => true,
      spawn: () => child,
      openUrl: () => {},
      write: () => {},
      appendLog: () => {},
      schedule: (cb, ms) => {
        timers.push({ cb, ms })
        return () => {}
      },
    })
    const run = host.runWebHost(SUMMARY)
    host.interrupt()
    expect(timers[0]?.ms).toBe(5000)
    child.emit('exit', null)
    await expect(run).resolves.toBe(130)
  })
})

describe('production defaults', () => {
  it('runs the real spawn/open/write/log pipeline against a stub CLI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-web-host-'))
    try {
      const logPath = join(dir, 'web.log')
      const stub = join(dir, 'stub-cli.js')
      await writeFile(stub, [
        'console.log("dsh web: http://127.0.0.1:59999/?token=stub")',
        'setTimeout(() => process.exit(0), 50)',
        '',
      ].join('\n'))
      const opened: string[] = []
      const host = createNodeWebHost({
        argv: ['node', stub],
        openUrl: url => { opened.push(url) },
        logPath,
        env: {},
        homeDir: dir,
      })
      const code = await host.runWebHost({ sessionId: 's-1' })
      expect(code).toBe(0)
      expect(opened).toEqual(['http://127.0.0.1:59999/?token=stub'])
      expect(await readFile(logPath, 'utf8')).toContain('dsh web: http://127.0.0.1:59999/?token=stub')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uses the real force-kill timer against a hanging stub CLI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tui-web-host-'))
    try {
      const stub = join(dir, 'stub-cli.js')
      await writeFile(stub, 'setTimeout(() => {}, 60000)\n')
      const host = createNodeWebHost({
        argv: ['node', stub],
        openUrl: () => {},
        env: {},
        homeDir: dir,
        forceKillAfterMs: 25,
      })
      const run = host.runWebHost({ sessionId: 's-1' })
      host.interrupt()
      await expect(run).resolves.toBe(130)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves the default log path under an injected environment', () => {
    expect(existsSync(resolveWebHostLogPath({ DSH_HOME: join('/', 'nope') }, join('/', 'home')))).toBe(false)
  })
})
