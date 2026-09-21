/**
 * Web host phase: after `/web` tears down the terminal UI, this module turns
 * the same process into the web server host. It prints the session summary,
 * boots `dsh --profile web` in the foreground of the SAME console (no new
 * window, no detached orphan), prints the ready panel once the URL is known,
 * opens the default browser, and forwards host interrupts as grace-then-kill.
 *
 * @module dsh-tui/app/web-host
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Facts about the session the TUI just left, printed before the web panel. */
export interface WebHostSummary {
  readonly sessionId: string
  readonly cwd?: string
  readonly model?: string
  readonly startedAt?: number
}

/** The web-host phase owned by the product runner. */
export interface WebHostPort {
  /**
   * Occupy the console as the web host until the web child exits.
   * @param summary - the session the TUI just left.
   * @returns the process exit code the runner should exit with.
   */
  runWebHost(summary: WebHostSummary): Promise<number>
  /** Forward one host Ctrl+C: the first arms a force-kill timer, the second kills. */
  interrupt(): void
}

/** Minimal child-process shape the web host needs. */
export interface WebHostChildProcess {
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  once(event: 'exit', listener: (code: number | null) => void): unknown
  kill(signal?: string): void
}

/** Injectable seams for the Node web host; production uses the defaults. */
export interface NodeWebHostDeps {
  readonly argv?: readonly string[]
  readonly execPath?: string
  readonly exists?: (path: string) => boolean
  readonly spawn?: (command: string, args: readonly string[]) => WebHostChildProcess
  readonly openUrl?: (url: string) => void
  readonly write?: (text: string) => void
  readonly appendLog?: (text: string) => void
  readonly logPath?: string
  readonly env?: { readonly DSH_HOME?: string | undefined }
  readonly homeDir?: string
  readonly forceKillAfterMs?: number
  readonly schedule?: (callback: () => void, ms: number) => () => void
}

const CLI_BIN_REASON =
  'Cannot locate the dsh CLI entrypoint; start the web UI manually with `dsh --profile web`'

const DEFAULT_FORCE_KILL_AFTER_MS = 5_000

/**
 * Extract the served URL from one complete launcher output line.
 * @param line - one line of web-profile stdout.
 * @returns the URL, or undefined for any other line.
 */
export function parseWebUrl(line: string): string | undefined {
  const match = /^dsh web: (https?:\/\/\S+)$/.exec(line.trimEnd())
  return match?.[1]
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Format an epoch timestamp as local `YYYY-MM-DD HH:mm`. */
export function formatWebHostTime(epoch: number): string {
  const time = new Date(epoch)
  return `${time.getFullYear()}-${pad2(time.getMonth() + 1)}-${pad2(time.getDate())} ${pad2(time.getHours())}:${pad2(time.getMinutes())}`
}

/**
 * Render the goodbye panel: the session the TUI just left, before web boot.
 * @param summary - session facts; absent optional fields are omitted.
 * @returns the panel text, ending with a newline.
 */
export function renderWebHostSummaryPanel(summary: WebHostSummary): string {
  const lines = [
    '',
    'Bye!',
    '',
    `  Session:    ${summary.sessionId}`,
    ...(summary.cwd === undefined ? [] : [`  Directory:  ${summary.cwd}`]),
    ...(summary.model === undefined ? [] : [`  Model:      ${summary.model}`]),
    ...(summary.startedAt === undefined ? [] : [`  Started:    ${formatWebHostTime(summary.startedAt)}`]),
    '',
    'Starting the web UI…',
    '',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Render the ready panel once the web URL is known.
 * @param url - the parsed served URL (token included).
 * @param logPath - where the child's full output is being written.
 * @returns the panel text, ending with a newline.
 */
export function renderWebHostReadyPanel(url: string, logPath: string): string {
  return [
    'DSH web is ready — the local web UI is available from this machine.',
    '',
    `  Local:      ${url}`,
    `  Stop:       Ctrl+C`,
    `  Logs:       ${logPath}`,
    '',
    '',
  ].join('\n')
}

/**
 * Render the failure panel when web exits before serving a URL.
 * @param logPath - where the child's full output was written.
 * @param code - the child's exit code.
 * @returns the panel text, ending with a newline.
 */
export function renderWebHostFailurePanel(logPath: string, code: number): string {
  return [
    `DSH web failed to start (exit code ${code}).`,
    `  See the full log: ${logPath}`,
    '',
    '',
  ].join('\n')
}

/**
 * Resolve the web-host log file path.
 * @param env - environment slice; DSH_HOME wins when set.
 * @param homeDir - user home for the fallback `~/.dsh` root.
 * @returns the log file path.
 */
export function resolveWebHostLogPath(
  env: { readonly DSH_HOME?: string | undefined },
  homeDir: string,
): string {
  const root = env.DSH_HOME === undefined || env.DSH_HOME === ''
    ? join(homeDir, '.dsh')
    : env.DSH_HOME
  return join(root, 'logs', 'dsh-tui-web.log')
}

/**
 * Spawn a fire-and-forget child with no console side effects.
 * @param command - executable.
 * @param args - arguments.
 */
export function spawnDetachedQuiet(command: string, args: readonly string[]): void {
  spawn(command, [...args], { detached: true, stdio: 'ignore' }).unref()
}

/**
 * Create the default browser opener for a platform. On Windows,
 * `rundll32 url.dll,FileProtocolHandler` is the supported default-browser
 * entry — `explorer.exe <url>` mis-parses query-bearing URLs and opens a
 * folder window instead.
 * @param platform - target platform; defaults to the running one.
 * @param spawnQuiet - fire-and-forget spawn; defaults to {@link spawnDetachedQuiet}.
 * @returns an opener that never blocks the caller.
 */
export function createBrowserOpener(
  platform: NodeJS.Platform = process.platform,
  spawnQuiet: (command: string, args: readonly string[]) => void = spawnDetachedQuiet,
): (url: string) => void {
  const opener = platform === 'win32'
    ? { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler'] }
    : platform === 'darwin'
      ? { command: 'open', args: [] as readonly string[] }
      : { command: 'xdg-open', args: [] as readonly string[] }
  return url => { spawnQuiet(opener.command, [...opener.args, url]) }
}

function defaultSchedule(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms)
  timer.unref()
  return () => { clearTimeout(timer) }
}

/**
 * Create the production web host: foreground web child on the same console,
 * output teed to the log file, browser opened at the parsed URL.
 * @param deps - optional seams for tests; defaults bind the live process.
 * @returns the web-host port consumed by the product runner.
 */
export function createNodeWebHost(deps: NodeWebHostDeps = {}): WebHostPort {
  const exists = deps.exists ?? existsSync
  const logPath = deps.logPath ?? resolveWebHostLogPath(deps.env ?? process.env, deps.homeDir ?? homedir())
  const write = deps.write ?? ((text: string) => { process.stdout.write(text) })
  const appendLog = deps.appendLog ?? ((text: string) => {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, text)
  })
  const schedule = deps.schedule ?? defaultSchedule
  const forceKillAfterMs = deps.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS
  const openUrl = deps.openUrl ?? createBrowserOpener()

  let child: WebHostChildProcess | undefined
  let interrupted = false
  let cancelForceKill: (() => void) | undefined

  return {
    async runWebHost(summary) {
      if (child !== undefined) throw new Error('DSH-TUI web host is already running')
      const cliBin = (deps.argv ?? process.argv)[1]
      if (cliBin === undefined || !exists(cliBin)) {
        write(`${CLI_BIN_REASON}\n`)
        return Promise.resolve(1)
      }
      write(renderWebHostSummaryPanel(summary))
      const spawnChild = deps.spawn ?? ((command: string, args: readonly string[]) => spawn(
        command,
        [...args],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ) as WebHostChildProcess)
      child = spawnChild(deps.execPath ?? process.execPath, [
        cliBin,
        '--profile', 'web',
        '--port', '0',
        '--no-open',
      ])

      return new Promise<number>((resolve) => {
        let urlServed = false
        let pending = ''
        const onData = (chunk: unknown): void => {
          const text = String(chunk)
          appendLog(text)
          if (urlServed) return
          pending += text
          const lines = pending.split(/\r?\n/u)
          pending = lines.pop()!
          for (const line of lines) {
            const url = parseWebUrl(line)
            if (url === undefined) continue
            urlServed = true
            write(renderWebHostReadyPanel(url, logPath))
            openUrl(url)
          }
        }
        child!.stdout?.on('data', onData)
        child!.stderr?.on('data', onData)
        child!.once('exit', (code) => {
          cancelForceKill?.()
          if (code !== 0 && code !== null && !urlServed) {
            write(renderWebHostFailurePanel(logPath, code))
          }
          resolve(code ?? (interrupted ? 130 : 1))
        })
      })
    },
    interrupt() {
      if (child === undefined) return
      if (interrupted) {
        cancelForceKill?.()
        child.kill()
        return
      }
      interrupted = true
      cancelForceKill = schedule(() => { child?.kill() }, forceKillAfterMs)
    },
  }
}
