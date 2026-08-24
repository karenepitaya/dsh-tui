#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DISABLED_AGENT_PLANE } from './official-dsh-profile-audit.mjs'

const TEMPORARY_PREFIX = 'dsh-tui-official-e2e-'
const PROFILE_NAME = 'tui'
const MOCK_API_KEY = 'dsh-tui-e2e-key'
const COMMAND_PREFIX = '/go'
const COMMAND_NAME = 'goal'
const COMMAND_ARGS = ' '
const CATALOG_PREFIX = '/se'
const CATALOG_COMMAND = 'sessions'
const PROMPT = 'DSH_TUI_E2E_INPUT_真实'
const MINIMAL_SEED_PROMPT = 'DSH_TUI_E2E_MINIMAL_SEED_真实'
const RESUME_PROMPT = 'DSH_TUI_E2E_RESUME_续接'
const RESPONSE = 'DSH_TUI_E2E_OK'
const HISTORICAL_MODEL = 'deepseek-v4-flash'
const DRIFTED_DEFAULT_MODEL = 'deepseek-v4-pro'
const MISSING_SESSION_ID = 'dsh-tui-e2e-missing'
const INITIAL_COLUMNS = 80
const INITIAL_ROWS = 24
const RESIZED_COLUMNS = 100
const RESIZED_ROWS = 30
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const STANDARD_TOOLS = Object.freeze([
  'ask_user_question',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'get_goal',
  'glob',
  'grep',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'pwsh',
  'ralph',
  'read',
  'read_image',
  'send_message',
  'skill',
  'subagent',
  'subagent_fork',
  'todo_write',
  'update_goal',
  'web_search',
  'workflow',
  'write',
])
const CORDIS_TOOLS = Object.freeze([
  ...STANDARD_TOOLS,
  'cordis_define',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
].sort())
const TERMINAL_RECOVERY_SEQUENCE =
  '\x1b[?2026l\x1b[0m\x1b[?2004l\x1b[?7h\x1b[?1049l\x1b[?25h'

async function installProductWriteCapture() {
  const pluginPath = process.env.DSH_TUI_E2E_PLUGIN_PATH
  const driverPath = process.env.DSH_TUI_E2E_DRIVER_PATH
  const capturePath = process.env.DSH_TUI_E2E_WRITES_PATH
  if (pluginPath === undefined || driverPath === undefined || capturePath === undefined) {
    throw new Error('official DSH E2E preload is missing its product write-capture paths')
  }
  const [{ productInternals }, { PiTerminalDriver }] = await Promise.all([
    import(pathToFileURL(pluginPath).href),
    import(pathToFileURL(driverPath).href),
  ])
  const output = {
    get isTTY() { return process.stdout.isTTY },
    get columns() { return process.stdout.columns },
    get rows() { return process.stdout.rows },
    write(data) {
      appendFileSync(capturePath, data, { encoding: 'utf8' })
      return process.stdout.write(data)
    },
    on(event, listener) {
      process.stdout.on(event, listener)
      return output
    },
    removeListener(event, listener) {
      process.stdout.removeListener(event, listener)
      return output
    },
  }
  productInternals.createTerminal = () => new PiTerminalDriver({
    output,
    logDirectory: dirname(capturePath),
  })
}

function parseArguments(argv) {
  const defaults = {
    harnessRoot: resolve(fileURLToPath(new URL('../../deepseek-harness/', import.meta.url))),
    dshTuiRoot: resolve(fileURLToPath(new URL('../', import.meta.url))),
    timeoutMilliseconds: 90_000,
  }
  const result = { ...defaults }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const value = argv[index + 1]
    if (option === '--harness-root' && value !== undefined) {
      result.harnessRoot = resolve(value)
      index += 1
      continue
    }
    if (option === '--dsh-tui-root' && value !== undefined) {
      result.dshTuiRoot = resolve(value)
      index += 1
      continue
    }
    if (option === '--timeout-ms' && value !== undefined) {
      result.timeoutMilliseconds = Number(value)
      index += 1
      continue
    }
    throw new Error(`official DSH E2E: unknown or incomplete argument ${JSON.stringify(option)}`)
  }
  if (!Number.isInteger(result.timeoutMilliseconds)
    || result.timeoutMilliseconds < 1_000
    || result.timeoutMilliseconds > 300_000) {
    throw new Error('official DSH E2E: --timeout-ms must be an integer from 1000 through 300000')
  }
  return result
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function outputExcerpt(value, limit = 8_000) {
  return value.length <= limit ? value : value.slice(-limit)
}

function withDeadline(promise, milliseconds, label) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${milliseconds} ms`))
    }, milliseconds)
  })
  return Promise.race([promise, deadline]).finally(() => { clearTimeout(timer) })
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

async function taskkillTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
    return
  }
  const killer = spawnChild(
    'taskkill.exe',
    ['/PID', String(pid), '/T', '/F'],
    { windowsHide: true, stdio: 'ignore' },
  )
  await withDeadline(new Promise((resolveExit, rejectExit) => {
    killer.once('error', rejectExit)
    killer.once('exit', () => { resolveExit() })
  }), 10_000, `taskkill tree ${pid}`)
}

async function runCommand(executable, args, options, label, timeoutMilliseconds) {
  const child = spawnChild(executable, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const append = (current, chunk) => {
    const next = current + chunk.toString('utf8')
    if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
      throw new Error(`${label} exceeded the ${MAX_CAPTURE_BYTES}-byte output bound`)
    }
    return next
  }
  let captureError
  child.stdout.on('data', (chunk) => {
    try {
      stdout = append(stdout, chunk)
    } catch (error) {
      captureError ??= error
      void taskkillTree(child.pid)
    }
  })
  child.stderr.on('data', (chunk) => {
    try {
      stderr = append(stderr, chunk)
    } catch (error) {
      captureError ??= error
      void taskkillTree(child.pid)
    }
  })
  const exitPromise = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => { resolveExit({ code, signal }) })
  })
  let exit
  try {
    exit = await withDeadline(exitPromise, timeoutMilliseconds, label)
  } catch (error) {
    await taskkillTree(child.pid)
    await withDeadline(exitPromise, 10_000, `${label} termination`).catch(() => {})
    throw error
  }
  if (captureError !== undefined) throw captureError
  if (exit.code !== 0) {
    throw new Error(
      `${label} failed with code ${String(exit.code)} signal ${String(exit.signal)}\n`
      + `stdout:\n${outputExcerpt(stdout)}\nstderr:\n${outputExcerpt(stderr)}`,
    )
  }
  assert.equal(processExists(child.pid), false, `${label} process ${child.pid} remained active`)
  return { stdout, stderr, pid: child.pid }
}

class JsonlProcessMonitor {
  constructor(child, label) {
    this.child = child
    this.label = label
    this.records = []
    this.stderr = ''
    this.fragment = ''
    this.parseError = undefined
    this.exited = false
    this.closed = false
    this.exitRecord = undefined
    this.events = new EventEmitter()
    this.exitPromise = new Promise((resolveExit) => {
      child.once('exit', (code, signal) => {
        this.exited = true
        this.exitRecord = { code, signal }
        this.events.emit('exit', this.exitRecord)
        resolveExit(this.exitRecord)
      })
    })
    this.closePromise = new Promise((resolveClose) => {
      child.once('close', (code, signal) => {
        this.closed = true
        resolveClose({ code, signal })
      })
    })
    child.once('error', (error) => {
      this.parseError ??= error
      this.events.emit('failure', error)
    })
    child.stdout.on('data', chunk => { this.consume(chunk.toString('utf8')) })
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8')
      if (Buffer.byteLength(this.stderr, 'utf8') > MAX_CAPTURE_BYTES) {
        this.parseError ??= new Error(`${label} stderr exceeded the output bound`)
        this.events.emit('failure', this.parseError)
      }
    })
  }

  consume(text) {
    this.fragment += text
    if (Buffer.byteLength(this.fragment, 'utf8') > MAX_CAPTURE_BYTES) {
      this.parseError ??= new Error(`${this.label} stdout line exceeded the output bound`)
      this.events.emit('failure', this.parseError)
      return
    }
    for (;;) {
      const newline = this.fragment.indexOf('\n')
      if (newline < 0) return
      const line = this.fragment.slice(0, newline).replace(/\r$/u, '')
      this.fragment = this.fragment.slice(newline + 1)
      if (line === '') continue
      try {
        const record = JSON.parse(line)
        this.records.push(record)
        this.events.emit('record', record)
      } catch (error) {
        this.parseError ??= new Error(
          `${this.label} emitted non-JSONL stdout ${JSON.stringify(outputExcerpt(line, 500))}`,
          { cause: error },
        )
        this.events.emit('failure', this.parseError)
      }
    }
  }

  waitFor(predicate, description, timeoutMilliseconds) {
    const found = this.records.find(predicate)
    if (found !== undefined) return Promise.resolve(found)
    if (this.parseError !== undefined) return Promise.reject(this.parseError)
    if (this.exited) {
      return Promise.reject(new Error(
        `${this.label} exited before ${description}: ${JSON.stringify(this.exitRecord)}\n`
        + `stderr:\n${outputExcerpt(this.stderr)}`,
      ))
    }
    return withDeadline(new Promise((resolveRecord, rejectRecord) => {
      const cleanup = () => {
        this.events.off('record', onRecord)
        this.events.off('failure', onFailure)
        this.events.off('exit', onExit)
      }
      const onRecord = (record) => {
        if (!predicate(record)) return
        cleanup()
        resolveRecord(record)
      }
      const onFailure = (error) => {
        cleanup()
        rejectRecord(error)
      }
      const onExit = (exit) => {
        cleanup()
        rejectRecord(new Error(
          `${this.label} exited before ${description}: ${JSON.stringify(exit)}\n`
          + `stderr:\n${outputExcerpt(this.stderr)}`,
        ))
      }
      this.events.on('record', onRecord)
      this.events.on('failure', onFailure)
      this.events.on('exit', onExit)
    }), timeoutMilliseconds, `${this.label} ${description}`)
  }
}

function assertSafeTemporaryRoot(path) {
  const absolute = resolve(path)
  const operatingSystemTemp = resolve(tmpdir())
  assert.equal(
    dirname(absolute).toLocaleLowerCase('en-US'),
    operatingSystemTemp.toLocaleLowerCase('en-US'),
    `refusing to clean a directory outside the OS temp root: ${absolute}`,
  )
  assert.ok(
    basename(absolute).startsWith(TEMPORARY_PREFIX),
    `refusing to clean a directory without the fixed prefix: ${absolute}`,
  )
  return absolute
}

async function listFiles(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function sessionLogPaths(dshHome) {
  const sessionsRoot = join(dshHome, 'sessions')
  if (!existsSync(sessionsRoot)) return { raw: [], compressed: [] }
  const files = await listFiles(sessionsRoot)
  return {
    raw: files.filter(path => path.endsWith('session.jsonl')),
    compressed: files.filter(path => path.endsWith('.jsonl.zstd')),
  }
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

async function assertTerminalLifecycle(productWritesPath, state) {
  const productWrites = await readFile(productWritesPath)
  const expectedRecovery = Buffer.from(TERMINAL_RECOVERY_SEQUENCE)
  assert.ok(
    productWrites.subarray(-expectedRecovery.length).equals(expectedRecovery),
    `product terminal writes did not end with the exact recovery contract; tail=${productWrites.subarray(-200).toString('hex')}`,
  )
  const text = productWrites.toString('utf8')
  assert.equal(
    countOccurrences(text, '\x1b[?1049h'),
    1,
    'preset picker and main controller restarted the alternate-screen terminal',
  )
  assert.equal(
    countOccurrences(text, '\x1b[?1049l'),
    2,
    'terminal must leave once through pi-tui and once through unconditional recovery',
  )
  assert.deepEqual(
    state.bufferTransitions,
    ['alternate', 'normal'],
    'headless xterm did not observe exactly one logical alternate-screen lifecycle',
  )
  assert.equal(state.terminal.buffer.active, state.terminal.buffer.normal)
  assert.equal(state.terminal.modes.bracketedPasteMode, false)
}

async function assertTerminalWasNeverAllocated(productWritesPath, state) {
  assert.equal(
    (await readFile(productWritesPath)).length,
    0,
    'failed cold resume wrote through a product TerminalDriver',
  )
  assert.deepEqual(
    state.bufferTransitions,
    [],
    'failed cold resume entered an alternate-screen lifecycle',
  )
  assert.equal(state.terminal.buffer.active, state.terminal.buffer.normal)
  assert.equal(state.terminal.modes.bracketedPasteMode, false)
}

function screenLines(terminal) {
  const buffer = terminal.buffer.active
  return Array.from({ length: terminal.rows }, (_, row) => (
    buffer.getLine(row)?.translateToString(true) ?? ''
  ))
}

function screenText(terminal) {
  return screenLines(terminal).join('\n')
}

function waitForScreen(state, predicate, description, timeoutMilliseconds) {
  const inspect = () => {
    const lines = screenLines(state.terminal)
    return predicate(lines, lines.join('\n')) ? lines : undefined
  }
  const immediate = inspect()
  if (immediate !== undefined) return Promise.resolve(immediate)
  if (state.callbackError !== undefined) return Promise.reject(state.callbackError)
  if (state.exited) {
    return Promise.reject(new Error(
      `DSH-TUI exited before ${description}: ${JSON.stringify(state.exitRecord)}\n`
      + `screen:\n${outputExcerpt(screenText(state.terminal))}`,
    ))
  }
  return withDeadline(new Promise((resolveLines, rejectLines) => {
    const cleanup = () => {
      state.events.off('screen', onScreen)
      state.events.off('failure', onFailure)
      state.events.off('exit', onExit)
    }
    const onScreen = () => {
      const lines = inspect()
      if (lines === undefined) return
      cleanup()
      resolveLines(lines)
    }
    const onFailure = (error) => {
      cleanup()
      rejectLines(error)
    }
    const onExit = (exit) => {
      cleanup()
      rejectLines(new Error(
        `DSH-TUI exited before ${description}: ${JSON.stringify(exit)}\n`
        + `screen:\n${outputExcerpt(screenText(state.terminal))}`,
      ))
    }
    state.events.on('screen', onScreen)
    state.events.on('failure', onFailure)
    state.events.on('exit', onExit)
  }), timeoutMilliseconds, `DSH-TUI ${description}`).catch((error) => {
    throw new Error(
      `DSH-TUI failed while waiting for ${description}: ${errorMessage(error)}\n`
      + `screen:\n${outputExcerpt(screenText(state.terminal))}`,
      { cause: error },
    )
  })
}

function startPty(
  nodePty,
  Terminal,
  preloadPath,
  cliBin,
  workspace,
  env,
  appArgs = ['--cwd', workspace],
) {
  const terminal = new Terminal({
    cols: INITIAL_COLUMNS,
    rows: INITIAL_ROWS,
    allowProposedApi: true,
  })
  const bufferTransitions = []
  const bufferSubscription = terminal.buffer.onBufferChange((buffer) => {
    bufferTransitions.push(buffer.type)
  })
  const pty = nodePty.spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(preloadPath).href,
      cliBin,
      '--profile',
      PROFILE_NAME,
      ...appArgs,
    ],
    {
      name: 'xterm-256color',
      cols: INITIAL_COLUMNS,
      rows: INITIAL_ROWS,
      cwd: workspace,
      env,
    },
  )
  const state = {
    pty,
    terminal,
    events: new EventEmitter(),
    rawTail: '',
    rawBytes: 0,
    pendingTerminalWrites: 0,
    callbackError: undefined,
    exited: false,
    exitRecord: undefined,
    ptyReleased: false,
    bufferTransitions,
    bufferSubscription,
  }
  state.exitPromise = new Promise((resolveExit) => {
    state.exitSubscription = pty.onExit((exit) => {
      state.exited = true
      state.exitRecord = exit
      state.events.emit('exit', exit)
      resolveExit(exit)
    })
  })
  state.dataSubscription = pty.onData((data) => {
    state.rawBytes += Buffer.byteLength(data, 'utf8')
    state.rawTail = (state.rawTail + data).slice(-MAX_CAPTURE_BYTES)
    if (state.rawBytes > MAX_CAPTURE_BYTES && state.callbackError === undefined) {
      state.callbackError = new Error(`DSH-TUI terminal output exceeded ${MAX_CAPTURE_BYTES} bytes`)
      state.events.emit('failure', state.callbackError)
      pty.kill()
      return
    }
    try {
      state.pendingTerminalWrites += 1
      terminal.write(data, () => {
        state.pendingTerminalWrites -= 1
        state.events.emit('screen')
        if (state.pendingTerminalWrites === 0) state.events.emit('parser-drain')
      })
    } catch (error) {
      state.callbackError ??= error
      state.events.emit('failure', error)
      pty.kill()
    }
  })
  return state
}

function waitForTerminalParser(state, timeoutMilliseconds) {
  if (state.pendingTerminalWrites === 0) return Promise.resolve()
  return withDeadline(new Promise((resolveDrain) => {
    const onDrain = () => {
      state.events.off('parser-drain', onDrain)
      resolveDrain()
    }
    state.events.on('parser-drain', onDrain)
  }), timeoutMilliseconds, 'headless xterm parser drain')
}

async function stopPty(state) {
  if (state === undefined) return
  if (!state.exited) {
    state.pty.kill()
    state.ptyReleased = true
    try {
      await withDeadline(state.exitPromise, 5_000, 'DSH-TUI ConPTY termination')
    } catch {
      await taskkillTree(state.pty.pid)
      await withDeadline(state.exitPromise, 10_000, 'DSH-TUI ConPTY forced termination')
    }
  }
  if (!state.ptyReleased) {
    // node-pty emits exit after draining ConPTY output, but its Windows path
    // closes the pseudoconsole handle only when the owner calls kill().
    state.pty.kill()
    state.ptyReleased = true
  }
  assert.equal(processExists(state.pty.pid), false, `DSH-TUI process ${state.pty.pid} remained active`)
  state.dataSubscription.dispose()
  state.exitSubscription.dispose()
  state.bufferSubscription.dispose()
  state.terminal.dispose()
}

async function stopChild(child, monitor, label) {
  if (child === undefined || monitor === undefined) return
  if (!monitor.exited) {
    child.kill('SIGTERM')
    try {
      await withDeadline(monitor.exitPromise, 5_000, `${label} termination`)
    } catch {
      await taskkillTree(child.pid)
      await withDeadline(monitor.exitPromise, 10_000, `${label} forced termination`)
    }
  }
  if (!monitor.closed) {
    await withDeadline(monitor.closePromise, 10_000, `${label} stdio close`)
  }
  assert.equal(processExists(child.pid), false, `${label} process ${child.pid} remained active`)
}

function assertMockReady(record) {
  assert.equal(record.type, 'ready')
  const endpoint = new URL(record.baseURL)
  assert.equal(endpoint.protocol, 'http:')
  assert.equal(endpoint.hostname, '127.0.0.1')
  assert.match(endpoint.port, /^\d+$/u)
  assert.equal(endpoint.pathname, '/v1')
  return endpoint.toString().replace(/\/$/u, '')
}

function yamlString(value) {
  return JSON.stringify(value)
}

function renderProfilePatch({
  defaultModel,
  dshHome,
  mockBaseURL,
  profileAuditPluginPath,
}) {
  return [
    '# Isolated official DSH-TUI E2E overrides.',
    '- id: dsh-tui',
    '  config:',
    '    autoStart: true',
    '',
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    '    model: ' + defaultModel,
    '',
    '- id: llm-deepseek',
    '  config:',
    '    apiKeyEnv: DEEPSEEK_API_KEY',
    '    baseURL: ' + yamlString(mockBaseURL),
    '    thinking: disabled',
    '    reasoningEffort: off',
    '',
    '- id: session-persistence-jsonl',
    '  config:',
    '    root: ' + yamlString(join(dshHome, 'sessions')),
    '    compression: none',
    '    packChunks: false',
    '',
    '- insert:',
    '    - id: dsh-tui-e2e-profile-audit',
    '      name: ' + yamlString(pathToFileURL(profileAuditPluginPath).href),
    '',
  ].join('\n')
}

async function waitForJsonFile(path, timeoutMilliseconds, label) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`${label} was unreadable: ${errorMessage(error)}`, { cause: error })
      }
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  throw new Error(`${label} exceeded ${timeoutMilliseconds} ms`)
}

function assertBootedProfileAudit(audit, {
  harnessRoot,
  dshHome,
  workspace,
  sessionId,
  agentPresetId = 'standard',
  currentDefaultModel = HISTORICAL_MODEL,
  agentModel = HISTORICAL_MODEL,
  headerDelegationDepth,
}) {
  assert.equal(audit?.version, 2, 'profile audit emitted an unsupported evidence version')
  if (audit?.ok !== true) {
    throw new Error(`profile audit failed: ${JSON.stringify(audit?.error ?? audit)}`)
  }

  assert.deepEqual(
    audit.agentPlane,
    DISABLED_AGENT_PLANE.map(id => ({ id, present: true, disabled: true, active: false })),
    'a globally disabled agent-plane row was missing, enabled, or active after boot',
  )
  assert.deepEqual(audit.globalTools, [], 'the booted profile leaked model tools globally')
  assert.deepEqual(audit.currentDefaultModel, {
    provider: 'deepseek-official',
    model: currentDefaultModel,
  })
  assert.deepEqual(audit.loaderBuiltins, { include: true, group: true })
  assert.match(
    audit.auditGeneration,
    /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    'profile audit did not publish from a unique effect-owned generation',
  )

  const shippedRoot = resolve(harnessRoot, 'apps', 'cli', 'config', 'agent-presets')
  const requiredHostRows = {
    'code-runtime': {
      name: '@deepseek-ai/dsh-code-runtime-worker-thread',
      config: null,
    },
    'cordis-host-runner': {
      name: '@deepseek-ai/dsh-cordis-host-runner',
      config: null,
    },
    'agent-presets': {
      name: '@deepseek-ai/dsh-agent-presets',
      config: {
        default: 'standard',
        roots: [{ path: shippedRoot, trust: 'system' }],
      },
    },
    'dsh-tui': {
      name: 'dsh-tui',
      config: { autoStart: true },
    },
  }
  assert.ok(Array.isArray(audit.loaderEntries), 'profile audit omitted Loader entries')
  for (const [localId, expected] of Object.entries(requiredHostRows)) {
    const matches = audit.loaderEntries.filter(
      entry => entry.localId === localId && entry.hostComposition === true,
    )
    assert.equal(matches.length, 1, `expected one active Loader row for ${localId}`)
    const row = matches[0]
    assert.equal(row.id, `include:${localId}`, `Loader row ${localId} had the wrong qualified id`)
    assert.equal(row.ownerEntryId, 'include', `Loader row ${localId} escaped the bootstrap owner tree`)
    assert.equal(row.name, expected.name, `Loader row ${localId} resolved the wrong provider`)
    assert.equal(row.disabled, false, `Loader row ${localId} was effectively disabled`)
    assert.equal(row.state, 'active', `Loader row ${localId} did not settle active`)
    assert.equal(row.active, true, `Loader row ${localId} had no active fiber`)
    assert.deepEqual(row.missingServices, [], `Loader row ${localId} missed services`)
    if (localId === 'agent-presets') {
      assert.deepEqual(Object.keys(row.config).sort(), ['default', 'roots'])
      assert.equal(row.config.default, expected.config.default)
      assert.deepEqual(
        row.config.roots.map(root => ({ ...root, path: resolve(root.path) })),
        expected.config.roots,
      )
    } else {
      assert.deepEqual(row.config, expected.config, `Loader row ${localId} had unexpected config`)
    }
  }
  const auditRows = audit.loaderEntries.filter(
    entry => entry.localId === 'dsh-tui-e2e-profile-audit' && entry.hostComposition === true,
  )
  assert.equal(auditRows.length, 1, 'expected one Host-owned profile audit row')
  assert.equal(auditRows[0].ownerEntryId, 'include')
  assert.equal(auditRows[0].state, 'active')
  assert.equal(auditRows[0].active, true)
  assert.deepEqual(auditRows[0].missingServices, [])

  const userRoot = resolve(dshHome, '.agent-presets')
  assert.equal(audit.defaultId, 'standard')
  assert.deepEqual(audit.roots, [
    { path: shippedRoot, trust: 'system' },
    { path: userRoot, trust: 'user' },
  ])
  const presetIds = ['code', 'cordis', 'minimal', 'standard']
  const roster = [...audit.roster].sort((left, right) => left.id.localeCompare(right.id))
  assert.deepEqual(
    roster,
    presetIds.map(id => ({
      id,
      trust: 'system',
      path: resolve(shippedRoot, id, 'agent.cordis.yml'),
      broken: null,
    })),
    'the booted preset roster did not match the four shipped system presets',
  )
  assert.deepEqual(audit.resolvedDefault, {
    id: 'standard',
    trust: 'system',
    path: resolve(shippedRoot, 'standard', 'agent.cordis.yml'),
    broken: null,
  })

  assert.deepEqual(Object.keys(audit.catalogs).sort(), presetIds)
  for (const id of presetIds) {
    assert.ok(Array.isArray(audit.catalogs[id]), `preset ${id} did not expose a tool catalog`)
    assert.deepEqual(audit.catalogs[id], [...audit.catalogs[id]].sort())
  }
  assert.deepEqual(audit.catalogs.minimal, ['pwsh', 'str_replace_editor'])
  assert.deepEqual(
    audit.catalogs.standard,
    STANDARD_TOOLS,
    'standard preset catalog drifted outside the exact rc.2 set',
  )
  assert.deepEqual(
    audit.catalogs.code,
    [...audit.catalogs.standard, 'run_code'].sort(),
    'code preset did not add exactly its run_code presentation transport',
  )
  assert.deepEqual(
    audit.catalogs.cordis,
    CORDIS_TOOLS,
    'cordis preset catalog drifted outside the exact rc.2 set',
  )

  assert.equal(audit.hostServices.codeRuntimeRun, true)
  assert.equal(audit.hostServices.cordisInspectList, true)
  assert.equal(audit.hostServices.cordisRunnerInventory, true)
  assert.deepEqual(audit.hostServices.codeRuntime, {
    language: 'typescript',
    isolation: 'worker-thread',
    result: { value: { ready: true }, logs: [], error: null },
  })
  assert.ok(Array.isArray(audit.hostServices.dynamicCordisRunner.inventory))
  assert.ok(Array.isArray(audit.hostServices.cordisInspect.providers))

  assert.equal(audit.fresh.sessionId, sessionId)
  assert.equal(audit.fresh.registered, true)
  assert.equal(typeof audit.fresh.agentId, 'string')
  assert.ok(audit.fresh.agentId.length > 0)
  assert.equal(audit.fresh.header.id, sessionId)
  assert.equal(resolve(audit.fresh.header.cwd), resolve(workspace))
  assert.equal(audit.fresh.header.delegationDepth, headerDelegationDepth)
  assert.equal(
    Object.hasOwn(audit.fresh.header, 'delegationDepth'),
    headerDelegationDepth !== undefined,
  )
  assert.deepEqual(audit.fresh.options, {
    provider: 'deepseek-official',
    model: agentModel,
    maxTokens: null,
  })
  assert.equal(audit.fresh.header.agentPreset, agentPresetId)
  assert.equal(audit.fresh.composedPreset, agentPresetId)
  assert.deepEqual(audit.fresh.scopedTools, audit.catalogs[agentPresetId])
  assert.deepEqual(audit.catalogOrder, {
    freshSessionId: sessionId,
    standingPresetIds: ['standard', 'code', 'minimal', 'cordis'],
  })
  return audit
}

async function loadSessionLog(dshHome, expectedSessionId) {
  const logs = await sessionLogPaths(dshHome)
  assert.equal(logs.compressed.length, 0, 'profile unexpectedly wrote compressed JSONL')
  const matches = []
  for (const path of logs.raw) {
    const text = await readFile(path, 'utf8')
    const lines = text.split(/\r?\n/u).filter(line => line !== '')
    const rows = lines.map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(
          `session JSONL ${path} line ${index + 1} was invalid`,
          { cause: error },
        )
      }
    })
    if (rows[0]?.id === expectedSessionId) matches.push({ path, rows })
  }
  assert.equal(
    matches.length,
    1,
    `expected one raw session log for ${expectedSessionId}, found ${matches.length}`,
  )
  return matches[0]
}

async function assertSessionLog(
  dshHome,
  workspace,
  expectedSessionId,
  expectedAgentPreset = 'standard',
) {
  const { path, rows } = await loadSessionLog(dshHome, expectedSessionId)
  const [header, ...events] = rows
  assert.ok(events.length > 0, 'session JSONL contained no events')
  assert.equal(header.type, 'session')
  assert.equal(header.id, expectedSessionId)
  assert.equal(resolve(header.cwd), resolve(workspace))
  assert.equal(header.delegationDepth, 0)
  assert.equal(Object.hasOwn(header, 'delegationDepth'), true)
  assert.equal(header.agentPreset, expectedAgentPreset)
  assert.ok(events.length >= 4, 'session JSONL did not contain a complete turn')
  assert.deepEqual(
    events.map(event => event.seq),
    Array.from({ length: events.length }, (_, seq) => seq),
    'session JSONL sequence numbers were not contiguous from zero',
  )
  assert.equal(
    events.filter(event => event.type === 'agent-preset/selected').length,
    0,
    'creation-time preset selection must not append agent-preset/selected',
  )

  const commandRuns = events.filter(event => event.type === 'command/run')
  const commandDones = events.filter(event => event.type === 'command/done')
  assert.equal(commandRuns.length, 1, 'session JSONL did not contain exactly one command/run')
  assert.equal(commandDones.length, 1, 'session JSONL did not contain exactly one command/done')
  const commandRun = commandRuns[0]
  const commandDone = commandDones[0]
  assert.equal(commandRun.data?.name, COMMAND_NAME)
  assert.equal(commandRun.data?.args, COMMAND_ARGS, 'Tab completion did not preserve one separator space')
  assert.equal(commandRun.data?.source?.kind, 'user')
  assert.equal(commandDone.data?.commandId, commandRun.data?.commandId)
  assert.equal(commandDone.data?.kind, 'success')
  assert.match(commandDone.data?.text ?? '', /No goal is currently set/u)
  assert.equal(commandDone.seq, commandRun.seq + 1, 'goal show command lifecycle was not adjacent')
  if (commandDone.data?.sourceEventSeq !== undefined) {
    assert.ok(Number.isSafeInteger(commandDone.data.sourceEventSeq))
    assert.ok(commandDone.data.sourceEventSeq >= 0 && commandDone.data.sourceEventSeq < commandDone.seq)
  }

  const users = events.filter(event => event.type === 'user/message')
  const directUsers = users.filter(event => event.data?.source?.kind === 'user')
  assert.equal(
    directUsers.length,
    1,
    `slash command unexpectedly created a direct user/message: ${JSON.stringify(directUsers.map(event => event.data))}`,
  )
  const user = directUsers[0]
  const assistant = events.find(event => event.type === 'assistant/message')
  const firstTurnStart = events.find(event => event.type === 'turn/start')
  const turnEnd = events.findLast(event => event.type === 'turn/end')
  assert.ok(user, 'session JSONL omitted user/message')
  assert.ok(assistant, 'session JSONL omitted assistant/message')
  assert.ok(firstTurnStart, 'session JSONL omitted turn/start')
  assert.ok(turnEnd, 'session JSONL omitted turn/end')
  assert.ok(JSON.stringify(user.data).includes(PROMPT), 'persisted user/message omitted the ConPTY prompt')
  assert.ok(
    users.every(event => !JSON.stringify(event.data).includes(`/${COMMAND_NAME}`)),
    'slash command leaked into a model-visible user/message',
  )
  assert.ok(
    commandRuns.every(event => event.data?.name !== CATALOG_COMMAND),
    'local session catalog unexpectedly emitted command/run',
  )
  assert.ok(
    users.every(event => !JSON.stringify(event.data).includes(`/${CATALOG_COMMAND}`)),
    'local session catalog leaked into a model-visible user/message',
  )
  assert.ok(JSON.stringify(assistant.data).includes(RESPONSE), 'persisted assistant/message omitted the mock reply')
  assert.equal(turnEnd.data?.reason?.kind, 'completed')
  assert.ok(commandDone.seq < firstTurnStart.seq, 'slash command was wrapped in or reordered behind a model turn')
  assert.ok(user.seq < assistant.seq && assistant.seq < turnEnd.seq, 'durable turn events were reordered')
  return { path, eventCount: events.length, commandId: commandRun.data.commandId }
}

async function assertMinimalSessionLog(dshHome, workspace, expectedSessionId) {
  const { path, rows } = await loadSessionLog(dshHome, expectedSessionId)
  const [header, ...events] = rows
  assert.equal(header.type, 'session')
  assert.equal(header.id, expectedSessionId)
  assert.equal(resolve(header.cwd), resolve(workspace))
  assert.equal(header.delegationDepth, 0)
  assert.equal(header.agentPreset, 'minimal')
  assert.deepEqual(
    events.map(event => event.seq),
    Array.from({ length: events.length }, (_, seq) => seq),
    'minimal session sequence numbers were not contiguous from zero',
  )
  const commandRuns = events.filter(event => event.type === 'command/run')
  const commandDones = events.filter(event => event.type === 'command/done')
  assert.equal(commandRuns.length, 1)
  assert.equal(commandDones.length, 1)
  assert.equal(commandRuns[0]?.data?.name, COMMAND_NAME)
  assert.equal(commandRuns[0]?.data?.args, COMMAND_ARGS)
  assert.equal(commandRuns[0]?.data?.source?.kind, 'user')
  assert.equal(commandDones[0]?.data?.commandId, commandRuns[0]?.data?.commandId)
  assert.equal(commandDones[0]?.data?.kind, 'success')
  assert.equal(commandDones[0]?.seq, commandRuns[0]?.seq + 1)
  const users = events.filter(
    event => event.type === 'user/message' && event.data?.source?.kind === 'user',
  )
  const assistants = events.filter(event => event.type === 'assistant/message')
  const turnStarts = events.filter(event => event.type === 'turn/start')
  const turnEnds = events.filter(event => event.type === 'turn/end')
  const requestHeaders = events.filter(event => event.type === 'request/header')
  assert.equal(users.length, 1)
  assert.equal(assistants.length, 1)
  assert.equal(turnStarts.length, 1)
  assert.equal(turnEnds.length, 1)
  assert.equal(requestHeaders.length, 1)
  assert.ok(JSON.stringify(users[0]?.data).includes(MINIMAL_SEED_PROMPT))
  assert.ok(JSON.stringify(assistants[0]?.data).includes(RESPONSE))
  assert.equal(turnEnds[0]?.data?.reason?.kind, 'completed')
  assert.equal(requestHeaders[0]?.data?.reason, 'initial')
  assert.equal(requestHeaders[0]?.data?.header?.config?.provider, 'deepseek-official')
  assert.equal(requestHeaders[0]?.data?.header?.config?.model, HISTORICAL_MODEL)
  assert.equal(
    events.filter(event => event.type === 'agent-preset/selected').length,
    0,
    'minimal creation-time selection must not append agent-preset/selected',
  )
  return { path, eventCount: events.length, rows }
}

async function assertResumedMinimalSessionLog(
  dshHome,
  workspace,
  expectedSessionId,
  seed,
) {
  const { path, rows } = await loadSessionLog(dshHome, expectedSessionId)
  const bytes = await readFile(path)
  assert.equal(path, seed.path, 'cold resume moved the durable Session artifact')
  assert.ok(bytes.length > seed.bytes.length, 'cold resume did not append durable events')
  assert.ok(
    bytes.subarray(0, seed.bytes.length).equals(seed.bytes),
    'cold resume rewrote the durable JSONL prefix',
  )
  assert.deepEqual(
    rows.slice(0, seed.rows.length),
    seed.rows,
    'cold resume changed parsed seed rows',
  )

  const [header, ...events] = rows
  const seedEventCount = seed.rows.length - 1
  const suffix = events.slice(seedEventCount)
  assert.equal(header.id, expectedSessionId)
  assert.equal(resolve(header.cwd), resolve(workspace))
  assert.equal(header.agentPreset, 'minimal')
  assert.ok(suffix.length > 0, 'cold resume appended no suffix')
  assert.equal(suffix[0]?.type, 'session/end-seed')
  assert.deepEqual(
    suffix.map(event => event.seq),
    Array.from(
      { length: suffix.length },
      (_, index) => seedEventCount + index,
    ),
    'cold resume suffix sequence numbers were not contiguous',
  )

  const seedHeader = seed.rows
    .slice(1)
    .findLast(event => event.type === 'request/header')
  const resumeHeaders = suffix.filter(
    event => event.type === 'request/header' && event.data?.reason === 'resume',
  )
  assert.ok(seedHeader, 'minimal seed omitted its request/header')
  assert.equal(resumeHeaders.length, 1)
  const resumeHeader = resumeHeaders[0]
  assert.deepEqual(
    resumeHeader.data.header.config,
    seedHeader.data.header.config,
    'cold resume used the current default model instead of the persisted route',
  )
  assert.deepEqual(
    resumeHeader.data.header.adapterDefaults ?? null,
    seedHeader.data.header.adapterDefaults ?? null,
    'cold resume changed persisted adapter-default provenance',
  )
  assert.equal(resumeHeader.data.header.config.provider, 'deepseek-official')
  assert.equal(resumeHeader.data.header.config.model, HISTORICAL_MODEL)

  const users = suffix.filter(
    event => event.type === 'user/message' && event.data?.source?.kind === 'user',
  )
  const assistants = suffix.filter(event => event.type === 'assistant/message')
  const turnEnds = suffix.filter(event => event.type === 'turn/end')
  assert.equal(users.length, 1)
  assert.equal(assistants.length, 1)
  assert.equal(turnEnds.length, 1)
  assert.ok(JSON.stringify(users[0]?.data).includes(RESUME_PROMPT))
  assert.ok(JSON.stringify(assistants[0]?.data).includes(RESPONSE))
  assert.equal(turnEnds[0]?.data?.reason?.kind, 'completed')
  assert.equal(
    suffix.filter(event => event.type === 'agent-preset/selected').length,
    0,
    'cold resume changed the durable preset selection',
  )
  return { path, eventCount: events.length, suffixEvents: suffix.length, bytes }
}

async function execute(options) {
  assert.equal(process.platform, 'win32', 'official DSH E2E requires Windows ConPTY')
  const cliBin = join(options.harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  const mockBin = join(
    options.harnessRoot,
    'packages',
    'test-support',
    'llm-mock-server',
    'src',
    'bin.ts',
  )
  const dshTuiLib = join(options.dshTuiRoot, 'lib', 'index.js')
  const profileAuditPluginPath = join(
    options.dshTuiRoot,
    'scripts',
    'official-dsh-profile-audit.mjs',
  )
  assert.ok(existsSync(cliBin), `missing built Harness CLI: ${cliBin}`)
  assert.ok(existsSync(mockBin), `missing repo-local mock server source: ${mockBin}`)
  assert.ok(existsSync(dshTuiLib), `missing built DSH-TUI: ${dshTuiLib}`)
  assert.ok(existsSync(profileAuditPluginPath), `missing profile audit plugin: ${profileAuditPluginPath}`)

  const requireXterm = createRequire(join(options.dshTuiRoot, 'package.json'))
  const requirePty = createRequire(join(
    options.harnessRoot,
    'packages',
    'subprocess',
    'subprocess-local',
    'package.json',
  ))
  const { Terminal } = requireXterm('@xterm/headless')
  const nodePty = requirePty('node-pty')

  const temporaryRoot = assertSafeTemporaryRoot(
    await mkdtemp(join(resolve(tmpdir()), TEMPORARY_PREFIX)),
  )
  const dshHome = join(temporaryRoot, 'dsh-home')
  const agentsHome = join(temporaryRoot, 'agents-home')
  const workspace = join(temporaryRoot, 'workspace')
  const productWritesPath = join(temporaryRoot, 'product-writes.bin')
  const minimalProductWritesPath = join(temporaryRoot, 'minimal-product-writes.bin')
  const resumeProductWritesPath = join(temporaryRoot, 'resume-product-writes.bin')
  const missingProductWritesPath = join(temporaryRoot, 'missing-product-writes.bin')
  const standardProfileAuditPath = join(temporaryRoot, 'profile-audit-standard.json')
  const minimalProfileAuditPath = join(temporaryRoot, 'profile-audit-minimal.json')
  const resumeProfileAuditPath = join(temporaryRoot, 'profile-audit-resume.json')
  const missingProfileAuditPath = join(temporaryRoot, 'profile-audit-missing.json')
  await mkdir(dshHome, { recursive: true })
  await mkdir(agentsHome, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(productWritesPath, '')
  await writeFile(minimalProductWritesPath, '')
  await writeFile(resumeProductWritesPath, '')
  await writeFile(missingProductWritesPath, '')

  const isolatedEnvironment = Object.fromEntries(
    Object.entries({
      ...process.env,
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: agentsHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'read-only',
      DSH_TOOLS_MODE: 'native',
      DEEPSEEK_API_KEY: MOCK_API_KEY,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      NO_COLOR: '1',
    }).filter(([, value]) => value !== undefined),
  )
  isolatedEnvironment.DSH_TUI_E2E_PROFILE_AUDIT_PATH = standardProfileAuditPath

  let mockChild
  let mockMonitor
  let ptyState
  let evidence
  let primaryError
  const cleanupErrors = []
  try {
    const fileSpec = `file:${options.dshTuiRoot.replaceAll('\\', '/')}`
    await runCommand(
      process.execPath,
      [cliBin, 'plugin', '--profile', PROFILE_NAME, 'add', '--prefer-offline', fileSpec],
      { cwd: options.dshTuiRoot, env: isolatedEnvironment },
      'official dsh plugin add',
      options.timeoutMilliseconds,
    )
    const profileDir = join(dshHome, 'profiles', PROFILE_NAME)
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(
      manifest.dsh?.profile?.bundles,
      ['@deepseek-ai/dsh-base', 'dsh-tui'],
      'official plugin reconciliation produced an unexpected bundle stack',
    )
    assert.match(manifest.dependencies?.['dsh-tui'] ?? '', /^file:/u)

    mockChild = spawnChild(
      process.execPath,
      [
        '--import',
        'tsx',
        mockBin,
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--api-key',
        MOCK_API_KEY,
        '--sequence',
        'success',
        '--repeat-last',
        '--success-text',
        RESPONSE,
        '--chunk-size',
        '4',
      ],
      {
        cwd: options.harnessRoot,
        env: isolatedEnvironment,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    mockMonitor = new JsonlProcessMonitor(mockChild, 'repo-local mock LLM')
    const ready = await mockMonitor.waitFor(
      record => record?.type === 'ready',
      'ready record',
      options.timeoutMilliseconds,
    )
    const mockBaseURL = assertMockReady(ready)
    isolatedEnvironment.DEEPSEEK_BASE_URL = mockBaseURL

    const profilePatchPath = join(profileDir, 'cordis.patch.yml')
    const profilePatchOptions = {
      dshHome,
      mockBaseURL,
      profileAuditPluginPath,
    }
    const profilePatch = renderProfilePatch({
      ...profilePatchOptions,
      defaultModel: HISTORICAL_MODEL,
    })
    await writeFile(profilePatchPath, profilePatch, 'utf8')

    const dump = await runCommand(
      process.execPath,
      [cliBin, '--profile', PROFILE_NAME, '--dump-config'],
      { cwd: workspace, env: isolatedEnvironment },
      'official dsh profile dump',
      options.timeoutMilliseconds,
    )
    assert.ok(dump.stdout.includes('id: dsh-tui') && dump.stdout.includes('autoStart: true'))
    assert.ok(
      dump.stdout.includes('id: agent-default-model')
      && dump.stdout.includes('model: ' + HISTORICAL_MODEL),
    )
    assert.ok(dump.stdout.includes('id: llm-deepseek') && dump.stdout.includes(mockBaseURL))
    assert.ok(dump.stdout.includes('id: session-persistence-jsonl') && dump.stdout.includes('compression: none'))
    assert.ok(dump.stdout.includes('id: dsh-tui-e2e-profile-audit'))

    const installedPluginPath = join(profileDir, 'node_modules', 'dsh-tui', 'lib', 'plugin.js')
    const installedDriverPath = join(profileDir, 'node_modules', 'dsh-tui', 'lib', 'terminal', 'driver.js')
    assert.ok(existsSync(installedPluginPath), `installed profile omitted ${installedPluginPath}`)
    assert.ok(existsSync(installedDriverPath), `installed profile omitted ${installedDriverPath}`)
    isolatedEnvironment.DSH_TUI_E2E_PRELOAD = 'capture-product-writes'
    isolatedEnvironment.DSH_TUI_E2E_PLUGIN_PATH = installedPluginPath
    isolatedEnvironment.DSH_TUI_E2E_DRIVER_PATH = installedDriverPath
    isolatedEnvironment.DSH_TUI_E2E_WRITES_PATH = productWritesPath
    ptyState = startPty(
      nodePty,
      Terminal,
      fileURLToPath(import.meta.url),
      cliBin,
      workspace,
      isolatedEnvironment,
    )
    await waitForScreen(
      ptyState,
      (lines, text) => text.includes('Startup AgentPreset · [DSH-TUI/local]')
        && lines.some(line => line.includes('› ') && line.includes('id:standard'))
        && text.includes('Enter select'),
      'pre-publication standard preset picker',
      options.timeoutMilliseconds,
    )
    const beforeStandardSelection = await sessionLogPaths(dshHome)
    assert.equal(beforeStandardSelection.raw.length, 0, 'picker created a Session before selection')
    assert.equal(beforeStandardSelection.compressed.length, 0)
    ptyState.pty.write('\r')
    const initialLines = await waitForScreen(
      ptyState,
      (_lines, text) => /DSH-TUI · [^\n·]+ · idle/u.test(text),
      'initial idle frame',
      options.timeoutMilliseconds,
    )
    const initialText = initialLines.join('\n')
    const sessionMatch = /DSH-TUI · ([^\n·]+) · idle/u.exec(initialText)
    assert.ok(sessionMatch, 'could not extract the DSH-TUI session id')
    const sessionId = sessionMatch[1].trim()
    const profileAudit = assertBootedProfileAudit(
      await waitForJsonFile(
        standardProfileAuditPath,
        options.timeoutMilliseconds,
        'booted profile audit',
      ),
      { harnessRoot: options.harnessRoot, dshHome, workspace, sessionId },
    )

    ptyState.terminal.resize(RESIZED_COLUMNS, RESIZED_ROWS)
    ptyState.pty.resize(RESIZED_COLUMNS, RESIZED_ROWS)
    await waitForScreen(
      ptyState,
      lines => lines.length === RESIZED_ROWS
        && lines[0]?.includes(`DSH-TUI · ${sessionId} · idle`)
        && lines[RESIZED_ROWS - 1]?.includes('Ctrl+C cancel'),
      '100x30 resize frame',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write(COMMAND_PREFIX)
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`> ${COMMAND_PREFIX}`)
        && text.includes(`/${COMMAND_NAME} [<objective>|clear|edit <objective>|pause|resume]`)
        && text.includes('Up/Down select'),
      'official slash-command discovery menu',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`> /${COMMAND_NAME}`)
        && text.includes('Ctrl+C cancel')
        && !text.includes('Up/Down select'),
      'Tab command completion',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`Command /${COMMAND_NAME} · success`)
        && text.includes(`DSH-TUI · ${sessionId} · idle`),
      'durable slash-command settlement',
      options.timeoutMilliseconds,
    )
    const commandModelRequests = mockMonitor.records.filter(record => record?.type === 'request').length
    assert.equal(commandModelRequests, 0, 'slash command unexpectedly reached the mock LLM')

    ptyState.pty.write(CATALOG_PREFIX)
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`> ${CATALOG_PREFIX}`)
        && text.includes(`/${CATALOG_COMMAND}`)
        && text.includes('[DSH-TUI/local]')
        && text.includes('Up/Down select'),
      'local session-catalog discovery menu',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`> /${CATALOG_COMMAND}`)
        && text.includes('[DSH-TUI/local]')
        && text.includes('Up/Down select'),
      'local session-catalog Tab completion',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Sessions · [DSH-TUI/local] · browse/live-switch')
        && text.includes(sessionId)
        && text.includes('current')
        && text.includes('R refresh'),
      'live-switch local session picker',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`Already viewing session ${sessionId}`)
        && text.includes('Sessions · [DSH-TUI/local] · browse/live-switch'),
      'current-session live-switch no-op',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && !text.includes('Sessions · [DSH-TUI/local] · browse/live-switch'),
      'local session picker dismissal',
      options.timeoutMilliseconds,
    )
    const catalogModelRequests = mockMonitor.records.filter(record => record?.type === 'request').length
    assert.equal(catalogModelRequests, 0, 'local session catalog unexpectedly reached the mock LLM')

    ptyState.pty.write(PROMPT)
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`> ${PROMPT}`),
      'real prompt editor echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`You: ${PROMPT}`)
        && text.includes(`Assistant: ${RESPONSE}`)
        && text.includes(`DSH-TUI · ${sessionId} · idle`),
      'durable assistant reply and return to idle',
      options.timeoutMilliseconds,
    )

    const request = await mockMonitor.waitFor(
      record => record?.type === 'request'
        && record.path === '/v1/chat/completions'
        && record.behavior === 'success',
      'DeepSeek request record',
      options.timeoutMilliseconds,
    )
    const result = await mockMonitor.waitFor(
      record => record?.type === 'result'
        && record.attempt === request.attempt
        && record.behavior === 'success'
        && record.outcome === 'completed',
      'DeepSeek result record',
      options.timeoutMilliseconds,
    )
    assert.ok(result.chunksSent > 0)

    ptyState.pty.write('\x03')
    const ptyExit = await withDeadline(
      ptyState.exitPromise,
      options.timeoutMilliseconds,
      'DSH-TUI clean Ctrl+C exit',
    )
    assert.equal(ptyExit.exitCode, 0)
    assert.equal(ptyExit.signal, undefined)
    assert.equal(ptyState.callbackError, undefined)
    await waitForTerminalParser(ptyState, options.timeoutMilliseconds)
    await assertTerminalLifecycle(productWritesPath, ptyState)
    assert.equal(processExists(ptyState.pty.pid), false)
    const standardPtyPid = ptyState.pty.pid
    await stopPty(ptyState)
    ptyState = undefined

    const afterStandardLogs = await sessionLogPaths(dshHome)
    assert.equal(afterStandardLogs.raw.length, 1, 'standard lane did not materialize one Session')
    assert.equal(afterStandardLogs.compressed.length, 0)

    isolatedEnvironment.DSH_TUI_E2E_PROFILE_AUDIT_PATH = minimalProfileAuditPath
    isolatedEnvironment.DSH_TUI_E2E_WRITES_PATH = minimalProductWritesPath
    const minimalRequestBaseline = mockMonitor.records
      .filter(record => record?.type === 'request').length
    ptyState = startPty(
      nodePty,
      Terminal,
      fileURLToPath(import.meta.url),
      cliBin,
      workspace,
      isolatedEnvironment,
    )
    await waitForScreen(
      ptyState,
      (lines, text) => text.includes('Startup AgentPreset · [DSH-TUI/local]')
        && lines.some(line => line.includes('› ') && line.includes('id:standard'))
        && text.includes('Enter select'),
      'minimal lane preset picker',
      options.timeoutMilliseconds,
    )
    const beforeMinimalSelection = await sessionLogPaths(dshHome)
    assert.equal(
      beforeMinimalSelection.raw.length,
      1,
      'minimal picker created a second Session before selection',
    )
    assert.equal(beforeMinimalSelection.compressed.length, 0)

    ptyState.pty.write('\x1b[B')
    await waitForScreen(
      ptyState,
      lines => lines.some(line => line.includes('› ') && line.includes('id:code')),
      'code preset intermediate selection',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b[B')
    await waitForScreen(
      ptyState,
      lines => lines.some(line => line.includes('› ') && line.includes('id:minimal')),
      'minimal preset selection',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    const minimalIdleLines = await waitForScreen(
      ptyState,
      (_lines, text) => /DSH-TUI · [^\n·]+ · idle/u.test(text),
      'minimal idle frame',
      options.timeoutMilliseconds,
    )
    const minimalMatch = /DSH-TUI · ([^\n·]+) · idle/u.exec(minimalIdleLines.join('\n'))
    assert.ok(minimalMatch, 'could not extract the minimal DSH-TUI session id')
    const minimalSessionId = minimalMatch[1].trim()
    assert.notEqual(minimalSessionId, sessionId)
    const minimalProfileAudit = assertBootedProfileAudit(
      await waitForJsonFile(
        minimalProfileAuditPath,
        options.timeoutMilliseconds,
        'minimal profile audit',
      ),
      {
        harnessRoot: options.harnessRoot,
        dshHome,
        workspace,
        sessionId: minimalSessionId,
        agentPresetId: 'minimal',
      },
    )

    ptyState.pty.write(COMMAND_PREFIX)
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`> ${COMMAND_PREFIX}`)
        && text.includes(`/${COMMAND_NAME} [<objective>|clear|edit <objective>|pause|resume]`),
      'minimal local goal discovery',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`> /${COMMAND_NAME}`)
        && !text.includes('Up/Down select'),
      'minimal local goal completion',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`Command /${COMMAND_NAME} · success`),
      'minimal durable local goal settlement',
      options.timeoutMilliseconds,
    )
    const minimalCommandModelRequests = mockMonitor.records
      .filter(record => record?.type === 'request').length - minimalRequestBaseline
    assert.equal(minimalCommandModelRequests, 0, 'minimal local goal reached the mock LLM')

    ptyState.pty.write(MINIMAL_SEED_PROMPT)
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('> ' + MINIMAL_SEED_PROMPT),
      'minimal seed prompt editor echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('You: ' + MINIMAL_SEED_PROMPT)
        && text.includes('Assistant: ' + RESPONSE)
        && text.includes('DSH-TUI · ' + minimalSessionId + ' · idle'),
      'minimal durable seed reply',
      options.timeoutMilliseconds,
    )
    const minimalSeedRequest = await mockMonitor.waitFor(
      record => record?.type === 'request'
        && record.attempt === minimalRequestBaseline + 1
        && record.path === '/v1/chat/completions'
        && record.behavior === 'success',
      'minimal seed DeepSeek request record',
      options.timeoutMilliseconds,
    )
    const minimalSeedResult = await mockMonitor.waitFor(
      record => record?.type === 'result'
        && record.attempt === minimalSeedRequest.attempt
        && record.behavior === 'success'
        && record.outcome === 'completed',
      'minimal seed DeepSeek result record',
      options.timeoutMilliseconds,
    )
    assert.ok(minimalSeedResult.chunksSent > 0)

    ptyState.pty.write('\x03')
    const minimalExit = await withDeadline(
      ptyState.exitPromise,
      options.timeoutMilliseconds,
      'minimal DSH-TUI clean Ctrl+C exit',
    )
    assert.equal(minimalExit.exitCode, 0)
    assert.equal(minimalExit.signal, undefined)
    assert.equal(ptyState.callbackError, undefined)
    await waitForTerminalParser(ptyState, options.timeoutMilliseconds)
    await assertTerminalLifecycle(minimalProductWritesPath, ptyState)
    assert.equal(processExists(ptyState.pty.pid), false)
    const minimalPtyPid = ptyState.pty.pid
    await stopPty(ptyState)
    ptyState = undefined

    const afterMinimalLogs = await sessionLogPaths(dshHome)
    assert.equal(afterMinimalLogs.raw.length, 2, 'minimal lane did not materialize a second Session')
    assert.equal(afterMinimalLogs.compressed.length, 0)
    const minimalSeedSession = await assertMinimalSessionLog(
      dshHome,
      workspace,
      minimalSessionId,
    )
    const minimalSeed = {
      path: minimalSeedSession.path,
      rows: minimalSeedSession.rows,
      bytes: await readFile(minimalSeedSession.path),
    }

    await writeFile(
      profilePatchPath,
      renderProfilePatch({
        ...profilePatchOptions,
        defaultModel: DRIFTED_DEFAULT_MODEL,
      }),
      'utf8',
    )
    const resumeDump = await runCommand(
      process.execPath,
      [cliBin, '--profile', PROFILE_NAME, '--dump-config'],
      { cwd: workspace, env: isolatedEnvironment },
      'official dsh resume profile dump',
      options.timeoutMilliseconds,
    )
    assert.ok(
      resumeDump.stdout.includes('id: agent-default-model')
      && resumeDump.stdout.includes('model: ' + DRIFTED_DEFAULT_MODEL),
      'resume profile did not expose the drifted current default model',
    )

    isolatedEnvironment.DSH_TUI_E2E_PROFILE_AUDIT_PATH = resumeProfileAuditPath
    isolatedEnvironment.DSH_TUI_E2E_WRITES_PATH = resumeProductWritesPath
    const resumeRequestBaseline = mockMonitor.records
      .filter(record => record?.type === 'request').length
    ptyState = startPty(
      nodePty,
      Terminal,
      fileURLToPath(import.meta.url),
      cliBin,
      workspace,
      isolatedEnvironment,
      ['--resume', minimalSessionId],
    )
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('DSH-TUI · ' + minimalSessionId + ' · idle')
        && text.includes('You: ' + MINIMAL_SEED_PROMPT)
        && text.includes('Assistant: ' + RESPONSE)
        && !text.includes('Startup AgentPreset · [DSH-TUI/local]'),
      'cold-resumed minimal transcript',
      options.timeoutMilliseconds,
    )
    const resumeProfileAudit = assertBootedProfileAudit(
      await waitForJsonFile(
        resumeProfileAuditPath,
        options.timeoutMilliseconds,
        'resume profile audit',
      ),
      {
        harnessRoot: options.harnessRoot,
        dshHome,
        workspace,
        sessionId: minimalSessionId,
        agentPresetId: 'minimal',
        currentDefaultModel: DRIFTED_DEFAULT_MODEL,
        agentModel: HISTORICAL_MODEL,
        headerDelegationDepth: 0,
      },
    )

    ptyState.pty.write(RESUME_PROMPT)
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('> ' + RESUME_PROMPT),
      'cold-resume followup editor echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('You: ' + RESUME_PROMPT)
        && text.includes('Assistant: ' + RESPONSE)
        && text.includes('DSH-TUI · ' + minimalSessionId + ' · idle'),
      'cold-resume durable followup reply',
      options.timeoutMilliseconds,
    )
    const resumeRequest = await mockMonitor.waitFor(
      record => record?.type === 'request'
        && record.attempt === resumeRequestBaseline + 1
        && record.path === '/v1/chat/completions'
        && record.behavior === 'success',
      'cold-resume DeepSeek request record',
      options.timeoutMilliseconds,
    )
    const resumeResult = await mockMonitor.waitFor(
      record => record?.type === 'result'
        && record.attempt === resumeRequest.attempt
        && record.behavior === 'success'
        && record.outcome === 'completed',
      'cold-resume DeepSeek result record',
      options.timeoutMilliseconds,
    )
    assert.ok(resumeResult.chunksSent > 0)
    const resumeModelRequests = mockMonitor.records
      .filter(record => record?.type === 'request').length - resumeRequestBaseline
    assert.equal(resumeModelRequests, 1)

    ptyState.pty.write('\x03')
    const resumeExit = await withDeadline(
      ptyState.exitPromise,
      options.timeoutMilliseconds,
      'cold-resumed DSH-TUI clean Ctrl+C exit',
    )
    assert.equal(resumeExit.exitCode, 0)
    assert.equal(resumeExit.signal, undefined)
    assert.equal(ptyState.callbackError, undefined)
    await waitForTerminalParser(ptyState, options.timeoutMilliseconds)
    await assertTerminalLifecycle(resumeProductWritesPath, ptyState)
    const resumeProductWrites = (await readFile(resumeProductWritesPath)).toString('utf8')
    assert.equal(
      resumeProductWrites.includes('Startup AgentPreset · [DSH-TUI/local]'),
      false,
      'startup --resume rendered the fresh preset picker',
    )
    assert.equal(processExists(ptyState.pty.pid), false)
    const resumePtyPid = ptyState.pty.pid
    await stopPty(ptyState)
    ptyState = undefined

    const resumedMinimalSession = await assertResumedMinimalSessionLog(
      dshHome,
      workspace,
      minimalSessionId,
      minimalSeed,
    )
    const afterResumeLogs = await sessionLogPaths(dshHome)
    assert.deepEqual(
      [...afterResumeLogs.raw].sort(),
      [...afterMinimalLogs.raw].sort(),
      'cold resume created a new raw Session artifact',
    )
    assert.equal(afterResumeLogs.compressed.length, 0)
    const stableSessionArtifacts = await Promise.all(
      [...afterResumeLogs.raw].sort().map(async path => ({
        path,
        bytes: await readFile(path),
      })),
    )

    isolatedEnvironment.DSH_TUI_E2E_PROFILE_AUDIT_PATH = missingProfileAuditPath
    isolatedEnvironment.DSH_TUI_E2E_WRITES_PATH = missingProductWritesPath
    const missingRequestBaseline = mockMonitor.records
      .filter(record => record?.type === 'request').length
    ptyState = startPty(
      nodePty,
      Terminal,
      fileURLToPath(import.meta.url),
      cliBin,
      workspace,
      isolatedEnvironment,
      ['--resume', MISSING_SESSION_ID],
    )
    const missingExit = await withDeadline(
      ptyState.exitPromise,
      options.timeoutMilliseconds,
      'missing cold resume exit',
    )
    assert.equal(missingExit.exitCode, 1)
    assert.equal(missingExit.signal, undefined)
    assert.equal(ptyState.callbackError, undefined)
    await waitForTerminalParser(ptyState, options.timeoutMilliseconds)
    await assertTerminalWasNeverAllocated(missingProductWritesPath, ptyState)
    const expectedMissingError =
      'dsh-tui: session "' + MISSING_SESSION_ID + '" not found'
    assert.equal(
      countOccurrences(ptyState.rawTail, expectedMissingError),
      1,
      'missing cold resume did not report exactly one sanitized product error',
    )
    assert.equal(
      mockMonitor.records.filter(record => record?.type === 'request').length,
      missingRequestBaseline,
      'missing cold resume reached the mock LLM',
    )
    assert.equal(processExists(ptyState.pty.pid), false)
    const missingPtyPid = ptyState.pty.pid
    await stopPty(ptyState)
    ptyState = undefined
    assert.equal(
      existsSync(missingProfileAuditPath),
      false,
      'missing cold resume published root Agent profile evidence',
    )
    const afterMissingLogs = await sessionLogPaths(dshHome)
    assert.deepEqual([...afterMissingLogs.raw].sort(), stableSessionArtifacts.map(row => row.path))
    assert.equal(afterMissingLogs.compressed.length, 0)
    for (const artifact of stableSessionArtifacts) {
      assert.ok(
        (await readFile(artifact.path)).equals(artifact.bytes),
        'missing cold resume changed a durable Session artifact',
      )
    }

    await stopChild(mockChild, mockMonitor, 'repo-local mock LLM')
    const requests = mockMonitor.records.filter(record => record?.type === 'request')
    const results = mockMonitor.records.filter(record => record?.type === 'result')
    assert.ok(requests.length > 0, 'mock emitted no request records')
    assert.equal(results.length, requests.length, 'mock request/result counts did not settle equally')
    for (const requestRecord of requests) {
      assert.equal(requestRecord.path, '/v1/chat/completions')
      assert.equal(requestRecord.behavior, 'success')
      const matchingResults = results.filter(resultRecord => resultRecord.attempt === requestRecord.attempt)
      assert.equal(matchingResults.length, 1, `mock attempt ${requestRecord.attempt} did not have exactly one result`)
      assert.equal(matchingResults[0].outcome, 'completed')
    }
    mockChild = undefined

    const session = await assertSessionLog(dshHome, workspace, sessionId, 'standard')
    evidence = {
      pid: standardPtyPid,
      minimalPid: minimalPtyPid,
      resumePid: resumePtyPid,
      missingPid: missingPtyPid,
      sessionId,
      minimalSessionId,
      sessionEvents: session.eventCount,
      minimalSessionEvents: minimalSeedSession.eventCount,
      resumedSessionEvents: resumedMinimalSession.eventCount,
      resumeSuffixEvents: resumedMinimalSession.suffixEvents,
      mockAttempts: requests.length,
      commandModelRequests,
      minimalCommandModelRequests,
      resumeModelRequests,
      catalogModelRequests,
      profileAudit,
      minimalProfileAudit,
      resumeProfileAudit,
    }
  } catch (error) {
    primaryError = error
  } finally {
    try {
      await stopPty(ptyState)
    } catch (error) {
      cleanupErrors.push(new Error(`ConPTY cleanup failed: ${errorMessage(error)}`, { cause: error }))
    }
    try {
      await stopChild(mockChild, mockMonitor, 'repo-local mock LLM')
    } catch (error) {
      cleanupErrors.push(new Error(`mock cleanup failed: ${errorMessage(error)}`, { cause: error }))
    }
    try {
      const safeRoot = assertSafeTemporaryRoot(temporaryRoot)
      await rm(safeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      assert.equal(existsSync(safeRoot), false, `temporary root remained after cleanup: ${safeRoot}`)
    } catch (error) {
      cleanupErrors.push(new Error(`temporary cleanup failed: ${errorMessage(error)}`, { cause: error }))
    }
  }

  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], 'official DSH E2E and cleanup both failed')
  }
  if (primaryError !== undefined) throw primaryError
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'official DSH E2E cleanup failed')
  assert.ok(evidence, 'official DSH E2E completed without evidence')
  return evidence
}

if (process.env.DSH_TUI_E2E_PRELOAD === 'capture-product-writes') {
  await installProductWriteCapture()
} else {
  try {
    const evidence = await execute(parseArguments(process.argv.slice(2)))
    process.stdout.write(
      `OFFICIAL_DSH_E2E_OK profile=${PROFILE_NAME} initial=${INITIAL_COLUMNS}x${INITIAL_ROWS} `
      + `resized=${RESIZED_COLUMNS}x${RESIZED_ROWS} mock=request+result session=contiguous `
      + `command=${COMMAND_NAME} command_events=paired command_model_requests=${evidence.commandModelRequests} `
      + `catalog=live-switch-current-noop catalog_events=none catalog_model_requests=${evidence.catalogModelRequests} `
      + 'booted_profile=verified global_tools=empty fresh_preset=standard '
      + 'preset_picker=standard-enter+minimal-down2-enter preselection_artifacts=0 '
      + 'fresh_presets=standard,minimal preset_selected_events=none alt_screen=once-per-process '
      + 'host_rows=exact catalogs=cold-after-fresh-exact audit_generation=owned '
      + 'cold_resume=historical-model+preset current_default=drifted '
      + 'resume_model=deepseek-v4-flash resume_preset=minimal '
      + 'current_model=deepseek-v4-pro current_preset=standard '
      + 'resume_transcript=replayed jsonl_prefix=preserved resume_suffix=contiguous '
      + 'resume_header=reason-resume missing_resume=fail-closed '
      + `session_events=${evidence.sessionEvents} minimal_session_events=${evidence.minimalSessionEvents} `
      + `resumed_session_events=${evidence.resumedSessionEvents} `
      + `resume_suffix_events=${evidence.resumeSuffixEvents} `
      + `minimal_command=${COMMAND_NAME} minimal_command_events=paired `
      + `minimal_command_model_requests=${evidence.minimalCommandModelRequests} `
      + `resume_model_requests=${evidence.resumeModelRequests} `
      + `mock_attempts=${evidence.mockAttempts} exit=0 recovery=exact `
      + `pid=${evidence.pid} process=gone temp=confirmed `
      + `minimal_exit=0 minimal_recovery=exact `
      + `minimal_pid=${evidence.minimalPid} minimal_process=gone `
      + `resume_exit=0 resume_recovery=exact `
      + `resume_pid=${evidence.resumePid} resume_process=gone `
      + 'missing_exit=1 missing_terminal=never-allocated '
      + 'missing_model_requests=0 missing_session_writes=0 '
      + `missing_pid=${evidence.missingPid} missing_process=gone\n`,
    )
  } catch (error) {
    process.stderr.write(`OFFICIAL_DSH_E2E_FAIL ${error?.stack ?? errorMessage(error)}\n`)
    process.exitCode = 1
  }
}
