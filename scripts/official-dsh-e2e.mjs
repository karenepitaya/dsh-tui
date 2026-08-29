#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
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
import { verifyInstalledPackage } from './verify-installed-package.mjs'

const TEMPORARY_PREFIX = 'dsh-tui-official-e2e-'
const PROFILE_NAME = 'tui'
const MOCK_API_KEY = 'dsh-tui-e2e-key'
const COMMAND_PREFIX = '/go'
const COMMAND_NAME = 'goal'
const COMMAND_ARGS = ' '
const CATALOG_PREFIX = '/se'
const CATALOG_COMMAND = 'sessions'
const CONNECT_PREFIX = '/con'
const CONNECT_COMMAND = 'connect'
const CONTEXT_COMMAND = 'context'
const COMPACT_PREFIX = '/comp'
const COMPACT_COMMAND = 'compact'
const MODEL_PREFIX = '/mo'
const MODEL_COMMAND = 'model'
const MODE_COMMAND = 'mode'
const PERMISSION_COMMAND = 'permission'
const ROUTE_COMMAND = 'route'
const MCP_COMMAND = 'mcp'
const SETTINGS_COMMAND = 'settings'
const OPENAI_MODEL = 'dsh-tui-openai-e2e'
const PROMPT_PREFIX = 'DSH_TUI_E2E_INPUT_真实'
const PROMPT_SUFFIX = 'DSH_TUI_E2E_COMPACTION_SEED_END'
const PROMPT = `${PROMPT_PREFIX} ${'compactable-context '.repeat(180)}${PROMPT_SUFFIX}`
const MINIMAL_SEED_PROMPT = 'DSH_TUI_E2E_MINIMAL_SEED_真实'
const RESUME_PROMPT = 'DSH_TUI_E2E_RESUME_续接'
const RESPONSE = 'DSH_TUI_E2E_OK'
const TOOLCHAIN_PROMPT = 'DSH_TUI_STANDARD_TOOLCHAIN_RUN'
const TOOLCHAIN_RESPONSE = 'DSH_TUI_STANDARD_TOOLCHAIN_OK'
const TOOLCHAIN_GOAL = 'Ship the official first-party workbench'
const TOOLCHAIN_PLAN = '# Ship the first-party workbench\n\n- verify Goal actions\n- approve Plan Review'
const TOOLCHAIN_BACKGROUND_COMMAND = 'Start-Sleep -Seconds 300'
const TOOLCHAIN_SEED = 'DSH_TUI_TOOLCHAIN_SEED'
const TOOLCHAIN_RESULT = 'DSH_TUI_TOOLCHAIN_AFTER'
const TOOLCHAIN_SKILL = 'toolchain-check'
const TOOLCHAIN_SKILL_BODY = 'DSH_TUI_TOOLCHAIN_SKILL_OK'
const TOOLCHAIN_USER_PROMPT = `/${TOOLCHAIN_SKILL} ${TOOLCHAIN_PROMPT}`
const TOOLCHAIN_SOURCE_URL = 'https://toolchain.invalid/dsh-tui'
const HISTORICAL_MODEL = 'deepseek-v4-flash'
const PICKED_MODEL = 'deepseek-v4-pro'
const CLI_OVERRIDE_MODEL = 'deepseek-v4-flash-vision-exp'
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
const STANDARD_TOOLCHAIN_STEPS = Object.freeze([
  {
    name: 'pwsh',
    arguments: {
      command: "Write-Output 'DSH_TUI_TOOLCHAIN_PWSH_OK'",
      description: 'Print standard toolchain marker',
    },
  },
  {
    name: 'pwsh',
    arguments: {
      command: "Set-Content -LiteralPath 'rejected.txt' -Value 'must-not-exist'",
      description: 'Attempt rejected fixture write',
      sandbox_permissions: 'workspace-write',
      justification: 'Allow the isolated acceptance fixture to attempt one workspace write.',
    },
  },
  { name: 'read', arguments: { file_path: 'seed.txt' } },
  {
    name: 'write',
    arguments: {
      file_path: 'toolchain.txt',
      content: 'DSH_TUI_TOOLCHAIN_BEFORE\n',
      sandbox_permissions: 'workspace-write',
      justification: 'Allow the isolated acceptance fixture to create its workspace file.',
    },
  },
  {
    name: 'edit',
    arguments: {
      file_path: 'toolchain.txt',
      old_string: 'BEFORE',
      new_string: 'AFTER',
      sandbox_permissions: 'workspace-write',
      justification: 'Allow the isolated acceptance fixture to update its workspace file.',
    },
  },
  { name: 'glob', arguments: { pattern: '**/*.txt' } },
  { name: 'grep', arguments: { pattern: TOOLCHAIN_RESULT, path: 'toolchain.txt' } },
  { name: 'skill', arguments: { name: TOOLCHAIN_SKILL } },
  {
    name: 'todo_write',
    arguments: {
      todos: [
        { content: 'Exercise official tools', status: 'completed' },
        { content: 'Verify TUI interactions', status: 'in_progress' },
      ],
    },
  },
  {
    name: 'ask_user_question',
    arguments: {
      questions: [{
        id: 'toolchain-choice',
        header: 'Toolchain',
        question: 'Choose the accepted fixture option.',
        options: [
          { label: 'Alpha', description: 'First fixture option.' },
          { label: 'Beta', description: 'Expected fixture option.' },
        ],
      }],
    },
  },
  {
    name: 'ask_user_question',
    arguments: {
      questions: [{
        id: 'toolchain-cancel',
        header: 'Cancel',
        question: 'Cancel this fixture question.',
      }],
    },
  },
  {
    name: 'web_search',
    arguments: { queries: ['DSH TUI standard toolchain fixture'] },
  },
  {
    name: 'create_goal',
    arguments: { objective: TOOLCHAIN_GOAL, max_goal_rounds: 8 },
  },
  {
    name: 'update_goal',
    arguments: { goal_id: '<from-create-goal>', revision: 0, action: 'resume' },
  },
  { name: 'exit_plan_mode', arguments: { plan: TOOLCHAIN_PLAN } },
  {
    name: 'pwsh',
    arguments: {
      command: TOOLCHAIN_BACKGROUND_COMMAND,
      description: 'Hold official background job open',
      run_in_background: true,
    },
  },
])
const TERMINAL_RECOVERY_SEQUENCE =
  '\x1b[?2026l\x1b[0m\x1b[?2004l'
  + '\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l'
  + '\x1b[?7h\x1b[?1049l\x1b[?25h'

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

function errorReport(error, path = 'error') {
  const summary = error instanceof Error
    ? error.stack ?? error.message
    : String(error)
  if (!(error instanceof AggregateError)) return `${path}: ${summary}`
  return [
    `${path}: ${summary}`,
    ...[...error.errors].map((nested, index) => errorReport(nested, `${path}.${index + 1}`)),
  ].join('\n')
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

async function readJsonRequest(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_CAPTURE_BYTES) {
      throw new Error(`standard toolchain mock request exceeded ${MAX_CAPTURE_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeSse(response, payload) {
  response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

function completeToolCall(response, step, index) {
  const callId = `dsh-tui-toolchain-${String(index + 1).padStart(2, '0')}`
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  writeSse(response, {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: callId,
          type: 'function',
          function: { name: step.name, arguments: JSON.stringify(step.arguments) },
        }],
      },
      finish_reason: null,
    }],
  })
  writeSse(response, {
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 7, completion_tokens: 2 },
  })
  writeSse(response, '[DONE]')
  response.end()
  return callId
}

function completeToolchainText(response, text = TOOLCHAIN_RESPONSE) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  writeSse(response, {
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })
  writeSse(response, {
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 4 },
  })
  writeSse(response, '[DONE]')
  response.end()
}

function collectStringLeaves(value, output = []) {
  if (typeof value === 'string') {
    output.push(value)
    return output
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, output)
    return output
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringLeaves(item, output)
  }
  return output
}

function resolveToolchainStep(step, body) {
  if (step.name !== 'update_goal') return step
  const text = collectStringLeaves(body?.messages).join('\n')
  const match = /"goal"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"\s*,\s*"revision"\s*:\s*(\d+)/u.exec(text)
  assert.ok(match, 'standard toolchain update_goal could not recover the created Goal ref')
  return {
    name: step.name,
    arguments: {
      goal_id: match[1],
      // The first-party TUI pauses revision 1 while this request is held.
      revision: Number(match[2]) + 1,
      action: 'resume',
    },
  }
}

async function startStandardToolchainMock(timeoutMilliseconds) {
  const chatRequests = []
  const retryRequests = []
  const titleRequests = []
  const searchRequests = []
  const failures = []
  const callIds = []
  const resolvedSteps = []
  let pausedGoalReleased = false
  let resolvePausedGoal
  const pausedGoalGate = new Promise(resolve => { resolvePausedGoal = resolve })
  const releasePausedGoal = () => {
    if (pausedGoalReleased) return
    pausedGoalReleased = true
    resolvePausedGoal()
  }
  let finalResponseReleased = false
  let resolveFinalResponse
  const finalResponseGate = new Promise(resolve => { resolveFinalResponse = resolve })
  const releaseFinalResponse = () => {
    if (finalResponseReleased) return
    finalResponseReleased = true
    resolveFinalResponse()
  }
  let retryResponseReleased = false
  let resolveRetryResponse
  const retryResponseGate = new Promise(resolve => { resolveRetryResponse = resolve })
  const releaseRetryResponse = () => {
    if (retryResponseReleased) return
    retryResponseReleased = true
    resolveRetryResponse()
  }
  let resolveTitleRequest
  const titleRequest = new Promise(resolveRequest => { resolveTitleRequest = resolveRequest })
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST', 'standard toolchain mock received a non-POST request')
      const body = await readJsonRequest(request)
      if (request.url === '/v1/chat/completions') {
        assert.equal(
          request.headers.authorization,
          `Bearer ${MOCK_API_KEY}`,
          'standard toolchain chat request used the wrong credential',
        )
        assert.equal(body?.stream, true, 'standard toolchain chat request was not streaming')
        const tools = Array.isArray(body?.tools) ? body.tools : []
        if (tools.length === 0) {
          assert.ok(
            JSON.stringify(body).includes('Create a concise title for an AI coding-assistant session'),
            'a tool-less standard toolchain request was not the official session-title request',
          )
          titleRequests.push(body)
          resolveTitleRequest(body)
          completeToolchainText(response, 'Standard toolchain acceptance')
          return
        }
        const toolNames = tools.map(tool => tool?.function?.name).sort()
        assert.deepEqual(
          toolNames,
          STANDARD_TOOLS,
          'standard toolchain request did not carry the exact scoped rc.2 catalog',
        )
        if (chatRequests.length === 0 && retryRequests.length === 0) {
          retryRequests.push(body)
          response.writeHead(503, {
            'content-type': 'application/json',
            'x-request-id': 'toolchain-retry-1',
          })
          response.end(JSON.stringify({ error: { message: 'temporary provider failure' } }))
          return
        }
        const index = chatRequests.length
        assert.ok(
          index <= STANDARD_TOOLCHAIN_STEPS.length,
          'standard toolchain mock received a request after its final response',
        )
        if (index > 0) {
          assert.ok(
            JSON.stringify(body?.messages ?? []).includes(callIds[index - 1]),
            `standard toolchain request ${index + 1} omitted the previous Tool Result`,
          )
        }
        chatRequests.push(body)
        if (index === 0) {
          const messages = JSON.stringify(body?.messages ?? [])
          assert.ok(
            messages.includes(TOOLCHAIN_USER_PROMPT),
            'standard toolchain first request omitted the literal user Skill invocation',
          )
          assert.ok(
            messages.includes(`<skill_content name=\\"${TOOLCHAIN_SKILL}\\">`),
            'standard toolchain first request omitted the official pre-step Skill injection',
          )
          assert.ok(
            messages.includes(TOOLCHAIN_SKILL_BODY),
            'standard toolchain first request omitted the injected Skill instructions',
          )
          await withDeadline(
            retryResponseGate,
            timeoutMilliseconds,
            'standard toolchain visible retry-started request',
          )
        }
        if (index === STANDARD_TOOLCHAIN_STEPS.length) {
          await withDeadline(
            finalResponseGate,
            timeoutMilliseconds,
            'standard toolchain final TUI-paused Goal acknowledgement',
          )
          completeToolchainText(response)
          return
        }
        const step = resolveToolchainStep(STANDARD_TOOLCHAIN_STEPS[index], body)
        resolvedSteps.push(step)
        if (step.name === 'update_goal') {
          await withDeadline(
            pausedGoalGate,
            timeoutMilliseconds,
            'standard toolchain visible paused Goal acknowledgement',
          )
        }
        callIds.push(completeToolCall(response, step, index))
        return
      }

      if (request.url === '/anthropic/v1/messages') {
        assert.equal(
          request.headers['x-api-key'],
          MOCK_API_KEY,
          'standard toolchain search request used the wrong credential',
        )
        assert.ok(
          JSON.stringify(body).includes('DSH TUI standard toolchain fixture'),
          'standard toolchain search request omitted its query',
        )
        searchRequests.push(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          content: [
            {
              type: 'text',
              text: 'Toolchain fixture result.',
              citations: [{
                type: 'web_search_result_location',
                url: TOOLCHAIN_SOURCE_URL,
                cited_text: 'DSH-TUI standard toolchain source snippet.',
              }],
            },
            {
              type: 'web_search_tool_result',
              content: [{
                type: 'web_search_result',
                url: TOOLCHAIN_SOURCE_URL,
                title: 'DSH-TUI Toolchain Fixture',
                page_age: '2026-08-27',
              }],
            },
          ],
        }))
        return
      }

      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `unexpected path ${request.url}` } }))
    })().catch((error) => {
      failures.push(error)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      if (!response.writableEnded) {
        response.end(JSON.stringify({ error: { message: errorMessage(error) } }))
      }
    })
  })

  await withDeadline(new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  }), timeoutMilliseconds, 'standard toolchain mock listen')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  let closed = false
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    searchBaseURL: `http://127.0.0.1:${address.port}/anthropic/v1`,
    chatRequests,
    titleRequests,
    titleRequest,
    searchRequests,
    retryRequests,
    failures,
    callIds,
    resolvedSteps,
    releasePausedGoal,
    releaseFinalResponse,
    releaseRetryResponse,
    async close() {
      if (closed) return
      closed = true
      releasePausedGoal()
      releaseFinalResponse()
      releaseRetryResponse()
      server.closeAllConnections()
      await new Promise((resolveClose, rejectClose) => {
        server.close(error => { if (error) rejectClose(error); else resolveClose() })
      })
    },
  }
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
    'the main controller restarted the alternate-screen terminal',
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

function selectedScreenLine(lines) {
  return lines.find(line => line.includes('› '))
}

function commandSearchLineVisible(lines, query) {
  return lines.some(line => line.includes(`> ${query}`))
}

async function openPermissionControl(
  state,
  currentValue,
  timeoutMilliseconds,
) {
  state.pty.write(`/${PERMISSION_COMMAND}`)
  await waitForScreen(
    state,
    lines => commandSearchLineVisible(lines, `/${PERMISSION_COMMAND}`),
    'official permission command echo',
    timeoutMilliseconds,
  )
  state.pty.write('\r')
  return await waitForScreen(
    state,
    (_lines, text) => text.includes('▌ Session permissions')
      && text.includes(`Current  ${currentValue}`)
      && text.includes('read-only')
      && text.includes('workspace-write')
      && text.includes('danger-full-access'),
    `official permission control at ${currentValue}`,
    timeoutMilliseconds,
  )
}

async function applyPermissionPresetThroughControl(
  state,
  { currentValue, targetValue, direction, steps },
  timeoutMilliseconds,
) {
  await openPermissionControl(state, currentValue, timeoutMilliseconds)
  for (let step = 0; step < steps; step += 1) {
    const previousSelection = selectedScreenLine(screenLines(state.terminal))
    state.pty.write(direction === 'up' ? '\x1b[A' : '\x1b[B')
    await waitForScreen(
      state,
      lines => selectedScreenLine(lines) !== previousSelection,
      `official permission ${targetValue} navigation step ${step + 1}`,
      timeoutMilliseconds,
    )
  }
  await waitForScreen(
    state,
    (lines, text) => selectedScreenLine(lines) !== undefined
      && text.includes(`Candidate  ${targetValue}`),
    `official permission ${targetValue} candidate`,
    timeoutMilliseconds,
  )
  state.pty.write('\r')
  await waitForScreen(
    state,
    (_lines, text) => !text.includes('▌ Session permissions')
      && text.includes(`Permission preset switched: ${targetValue}`),
    `official permission ${targetValue} settlement`,
    timeoutMilliseconds,
  )
}

async function stabilizeWindowsPtyExit(pty, exit) {
  if (process.platform !== 'win32' || exit.exitCode !== undefined) return exit
  // node-pty 1.2.0-beta.15 can close the ConPTY output socket before its
  // native process-exit callback stores WindowsPtyAgent._exitCode. Preserve the
  // strict zero-exit gate, but give that pinned callback ordering one bounded
  // chance to settle instead of treating the transient empty event as final.
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    await new Promise(resolveDelay => { setTimeout(resolveDelay, 10) })
    const exitCode = pty?._agent?.exitCode
    if (exitCode !== undefined) return { ...exit, exitCode }
  }
  return exit
}

async function moveSelectionTo(state, needle, description, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds
  for (let step = 0; step < 128; step += 1) {
    const currentLines = screenLines(state.terminal)
    const currentSelection = selectedScreenLine(currentLines)
    if (currentSelection?.includes(needle) === true) return currentLines

    state.pty.write('\x1b[B')
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await waitForScreen(
      state,
      lines => {
        const nextSelection = selectedScreenLine(lines)
        return nextSelection !== undefined && nextSelection !== currentSelection
      },
      `${description} navigation step ${step + 1}`,
      Math.min(remaining, 5_000),
    )
  }
  throw new Error(
    `DSH-TUI could not select ${description} (${needle})\n`
    + `screen:\n${outputExcerpt(screenText(state.terminal))}`,
  )
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
    let delivered = false
    state.exitSubscription = pty.onExit((exit) => {
      if (delivered) return
      delivered = true
      void stabilizeWindowsPtyExit(pty, exit).then((stableExit) => {
        state.exited = true
        state.exitRecord = stableExit
        state.events.emit('exit', stableExit)
        resolveExit(stableExit)
      })
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
    '    retryPolicy:',
    '      mode: normal',
    '      maxRetries: 1',
    '      backoff:',
    '        initialDelayMs: 750',
    '        maxDelayMs: 750',
    '        jitterRatio: 0',
    '',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      openai:',
    '        api: openai-completions',
    '        baseURL: ' + yamlString(mockBaseURL),
    '        models:',
    '          - id: ' + OPENAI_MODEL,
    '            name: DSH-TUI OpenAI E2E',
    '            contextWindow: 32768',
    '            maxTokens: 4096',
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

async function waitForCondition(predicate, timeoutMilliseconds, label) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
  }
  throw new Error(`${label} exceeded ${timeoutMilliseconds} ms`)
}

function assertBootedProfileAudit(audit, {
  harnessRoot,
  dshHome,
  workspace,
  sessionId,
  agentPresetId = 'standard',
  creationAgentPresetId = agentPresetId,
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
    authorization: {
      name: '@deepseek-ai/dsh-authorization',
      config: null,
    },
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
  const providerSnapshot = audit.hostServices.dshTuiProviders
  assert.equal(providerSnapshot.writable, true)
  assert.ok(Array.isArray(providerSnapshot.providers))
  const providerIds = providerSnapshot.providers.map(provider => provider.id)
  assert.equal(new Set(providerIds).size, providerIds.length, 'Provider directory contained duplicate ids')
  assert.ok(providerIds.includes('deepseek-official'), 'Provider directory omitted DeepSeek')
  assert.ok(providerIds.includes('openai'), 'Provider directory omitted OpenAI')
  assert.ok(providerIds.length > 2, 'Provider directory did not expose the installed official catalog')
  assert.ok(
    providerSnapshot.providers.every(provider => provider.methods.length > 0),
    'a dynamically listed Provider exposed no connection method',
  )

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
  assert.equal(audit.fresh.header.agentPreset, creationAgentPresetId)
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
  expectedModel = HISTORICAL_MODEL,
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
  assert.equal(commandRuns.length, 4, 'session JSONL did not contain goal, compact, and permission command/run events')
  assert.equal(commandDones.length, 4, 'session JSONL did not contain goal, compact, and permission command/done events')
  const commandRun = commandRuns.find(event => event.data?.name === COMMAND_NAME)
  const compactRun = commandRuns.find(event => event.data?.name === COMPACT_COMMAND)
  const permissionRuns = commandRuns.filter(event => event.data?.name === PERMISSION_COMMAND)
  assert.ok(commandRun, 'session JSONL omitted goal command/run')
  assert.ok(compactRun, 'session JSONL omitted compact command/run')
  assert.deepEqual(
    permissionRuns.map(event => event.data?.args),
    [' danger-full-access', ' read-only'],
    'permission control did not execute the exact official preset switches',
  )
  const commandDone = commandDones.find(event => event.data?.commandId === commandRun.data?.commandId)
  const compactDone = commandDones.find(event => event.data?.commandId === compactRun.data?.commandId)
  const permissionDones = permissionRuns.map(run => (
    commandDones.find(event => event.data?.commandId === run.data?.commandId)
  ))
  assert.ok(commandDone, 'session JSONL omitted goal command/done')
  assert.ok(compactDone, 'session JSONL omitted compact command/done')
  assert.equal(permissionDones.every(Boolean), true, 'permission control omitted a paired command/done')
  assert.deepEqual(
    permissionDones.map(event => event?.data?.kind),
    ['success', 'success'],
    'permission control did not settle both official commands successfully',
  )
  assert.deepEqual(
    events.filter(event => event.type === 'permission/preset')
      .map(event => event.data?.preset)
      .slice(-2),
    ['danger-full-access', 'read-only'],
    'permission control did not persist the selected and restored preset intent',
  )
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

  assert.equal(compactRun.data?.args ?? '', '')
  assert.equal(compactRun.data?.source?.kind, 'user')
  assert.equal(compactDone.data?.kind, 'success')
  assert.match(compactDone.data?.text ?? '', /Compacted \d+ history items \(~\d+ tokens\)\./u)
  const compactionStarts = events.filter(event => event.type === 'compaction/start')
  const compactionSummaries = events.filter(event => event.type === 'compaction/summary')
  const compactionEnds = events.filter(event => event.type === 'compaction/end')
  assert.equal(compactionStarts.length, 1, 'manual compact omitted its unique compaction/start')
  assert.equal(compactionSummaries.length, 1, 'manual compact omitted its unique compaction/summary')
  assert.equal(compactionEnds.length, 1, 'manual compact omitted its unique compaction/end')
  const compactionStart = compactionStarts[0]
  const compactionSummary = compactionSummaries[0]
  const compactionEnd = compactionEnds[0]
  assert.equal(compactionStart.data?.turn, null)
  assert.equal(compactionStart.data?.sourceCommandId, compactRun.data?.commandId)
  assert.equal(compactionSummary.data?.compactionId, compactionStart.data?.compactionId)
  assert.equal(compactionSummary.data?.sourceCommandId, compactRun.data?.commandId)
  assert.ok((compactionSummary.data?.shadowedSeqs?.length ?? 0) > 0)
  assert.ok((compactionSummary.data?.shadowedTokenCount ?? 0) > 0)
  assert.equal(compactionSummary.data?.provider, 'deepseek-official')
  assert.equal(compactionSummary.data?.model, expectedModel)
  assert.equal(compactionEnd.data?.compactionId, compactionStart.data?.compactionId)
  assert.equal(compactionEnd.data?.turn, null)
  assert.equal(compactionEnd.data?.error, undefined)
  assert.equal(compactDone.data?.sourceEventSeq, compactionSummary.seq)

  const users = events.filter(event => event.type === 'user/message')
  const requestHeaders = events.filter(event => event.type === 'request/header')
  const directUsers = users.filter(event => event.data?.source?.kind === 'user')
  assert.equal(
    directUsers.length,
    1,
    `slash command unexpectedly created a direct user/message: ${JSON.stringify(directUsers.map(event => event.data))}`,
  )
  const user = directUsers[0]
  const checkpoint = users.find(event => (
    event.data?.source?.kind === 'plugin'
    && event.data?.source?.plugin === 'compact'
    && event.data?.source?.compactionId === compactionStart.data?.compactionId
  ))
  const assistant = events.find(event => event.type === 'assistant/message')
  const firstTurnStart = events.find(event => event.type === 'turn/start')
  const turnEnd = events.findLast(event => event.type === 'turn/end')
  assert.ok(user, 'session JSONL omitted user/message')
  assert.ok(checkpoint, 'session JSONL omitted the compaction replacement checkpoint')
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
  assert.equal(requestHeaders.length, 1, 'session JSONL did not contain exactly one request/header')
  assert.equal(requestHeaders[0]?.data?.header?.config?.provider, 'deepseek-official')
  assert.equal(requestHeaders[0]?.data?.header?.config?.model, expectedModel)
  assert.equal(turnEnd.data?.reason?.kind, 'completed')
  assert.ok(commandDone.seq < firstTurnStart.seq, 'slash command was wrapped in or reordered behind a model turn')
  assert.ok(user.seq < assistant.seq && assistant.seq < turnEnd.seq, 'durable turn events were reordered')
  assert.deepEqual(checkpoint.surfaceOp, {
    op: 'replace',
    start: compactionSummary.data?.shadowedRange?.start,
    end: compactionSummary.data?.shadowedRange?.end,
  })
  assert.ok(
    compactRun.seq < compactionStart.seq
      && compactionStart.seq < compactionSummary.seq
      && compactionSummary.seq < checkpoint.seq
      && checkpoint.seq < compactionEnd.seq
      && compactionEnd.seq < compactDone.seq,
    'manual compaction durable transaction was reordered',
  )
  return { path, eventCount: events.length, commandId: commandRun.data.commandId }
}

async function assertStandardToolchainSessionLog(
  dshHome,
  workspace,
  expectedSessionId,
  expectedSteps = STANDARD_TOOLCHAIN_STEPS,
) {
  const { path, rows } = await loadSessionLog(dshHome, expectedSessionId)
  const [header, ...events] = rows
  assert.equal(header.type, 'session')
  assert.equal(header.id, expectedSessionId)
  assert.equal(resolve(header.cwd), resolve(workspace))
  assert.equal(header.agentPreset, 'standard')
  assert.deepEqual(
    events.map(event => event.seq),
    Array.from({ length: events.length }, (_, seq) => seq),
    'standard toolchain Session sequence numbers were not contiguous',
  )

  const directUsers = events.filter(
    event => event.type === 'user/message' && event.data?.source?.kind === 'user',
  )
  const turnStarts = events.filter(event => event.type === 'turn/start')
  const turnEnds = events.filter(event => event.type === 'turn/end')
  const toolCalls = events.filter(event => event.type === 'tool/call')
  const toolResults = events.filter(event => event.type === 'tool/result')
  const retries = events.filter(event => event.type === 'llm/retry')
  const retryStarts = events.filter(event => event.type === 'llm/retry-started')
  assert.equal(directUsers.length, 1)
  assert.equal(turnStarts.length, 1)
  assert.equal(turnEnds.length, 1)
  assert.ok(JSON.stringify(directUsers[0]?.data).includes(TOOLCHAIN_USER_PROMPT))
  assert.equal(turnEnds[0]?.data?.reason?.kind, 'completed')
  assert.equal(toolCalls.length, expectedSteps.length)
  assert.equal(toolResults.length, expectedSteps.length)
  assert.equal(retries.length, 1, 'standard toolchain did not persist exactly one retry schedule')
  assert.equal(retryStarts.length, 1, 'standard toolchain did not persist exactly one retry start')
  const retry = retries[0]
  const retryStarted = retryStarts[0]
  assert.equal(retry?.data?.provider, 'deepseek-official')
  assert.equal(retry?.data?.mode, 'normal')
  assert.equal(retry?.data?.maxRetries, 1)
  assert.equal(retry?.data?.retry, 1)
  assert.equal(retry?.data?.delayMs, 750)
  assert.equal(retry?.data?.failure?.message, 'temporary provider failure')
  assert.equal(retry?.data?.failure?.code, 'SERVER')
  assert.equal(retry?.data?.failure?.status, 503)
  assert.equal(retry?.data?.failure?.requestId, 'toolchain-retry-1')
  assert.ok(typeof retry?.data?.policyKey === 'string' && retry.data.policyKey.length > 0)
  assert.deepEqual(retryStarted?.data, {
    retryId: retry?.data?.retryId,
    turn: retry?.data?.turn,
    step: retry?.data?.step,
    retry: retry?.data?.retry,
  })
  assert.ok(
    directUsers[0].seq < retry.seq
      && retry.seq < retryStarted.seq
      && retryStarted.seq < toolCalls[0].seq,
    'standard toolchain request recovery events were reordered',
  )
  assert.deepEqual(
    toolCalls.map(event => event.data?.name),
    expectedSteps.map(step => step.name),
    'standard toolchain durable calls did not retain model order',
  )
  assert.deepEqual(
    toolCalls.map(event => JSON.parse(event.data?.arguments ?? 'null')),
    expectedSteps.map(step => step.arguments),
    'standard toolchain durable call arguments drifted from the scripted request',
  )
  assert.deepEqual(
    toolResults.map(event => event.data?.message?.source?.callId),
    toolCalls.map(event => event.data?.callId),
    'standard toolchain durable Tool Results did not pair with calls in order',
  )

  const resultText = index => JSON.stringify(toolResults[index]?.data ?? null)
  const resultJson = index => {
    for (const candidate of collectStringLeaves(toolResults[index]?.data)) {
      try {
        const parsed = JSON.parse(candidate)
        if (parsed !== null && typeof parsed === 'object' && 'goal' in parsed) return parsed
      } catch {
        // Non-JSON display strings are not the goal tool's canonical value.
      }
    }
    assert.fail(`standard toolchain result ${index} omitted its canonical Goal JSON`)
  }
  assert.ok(resultText(0).includes('DSH_TUI_TOOLCHAIN_PWSH_OK'))
  assert.equal(toolResults[0]?.data?.message?.content?.[0]?.isError, false)
  assert.equal(toolResults[1]?.data?.message?.content?.[0]?.isError, true)
  assert.ok(/reject|approval/iu.test(resultText(1)))
  assert.ok(resultText(2).includes(TOOLCHAIN_SEED))
  assert.ok(resultText(3).includes('toolchain.txt'))
  assert.ok(resultText(4).includes('toolchain.txt'))
  assert.ok(resultText(5).includes('toolchain.txt'))
  assert.ok(resultText(6).includes(TOOLCHAIN_RESULT))
  assert.ok(resultText(7).includes(TOOLCHAIN_SKILL_BODY))
  assert.ok(resultText(8).includes('0 pending, 1 in progress, 1 completed'))
  assert.equal(toolResults[8]?.data?.message?.content?.[0]?.isError, false)
  assert.ok(resultText(9).includes('Beta'))
  assert.equal(toolResults[9]?.data?.message?.content?.[0]?.isError, false)
  assert.equal(toolResults[10]?.data?.message?.content?.[0]?.isError, true)
  assert.ok(/cancel/iu.test(resultText(10)))
  assert.ok(resultText(11).includes(TOOLCHAIN_SOURCE_URL))
  assert.equal(toolResults[11]?.data?.message?.content?.[0]?.isError, false)
  assert.ok(resultText(12).includes(TOOLCHAIN_GOAL))
  assert.equal(resultJson(12).goal?.phase, 'active')
  assert.equal(resultJson(13).goal?.phase, 'active')
  assert.equal(toolResults[13]?.data?.message?.content?.[0]?.isError, false)
  assert.ok(resultText(14).includes('Plan approved'))
  assert.equal(toolResults[14]?.data?.message?.content?.[0]?.isError, false)
  assert.ok(resultText(15).includes('started background job pwsh-1'))
  assert.equal(toolResults[15]?.data?.message?.content?.[0]?.isError, false)

  const approvalAsked = events.filter(event => event.type === 'approval/asked')
  const approvalDecided = events.filter(event => event.type === 'approval/decided')
  assert.deepEqual(approvalAsked.map(event => event.data?.toolName), ['pwsh', 'write', 'edit'])
  assert.deepEqual(
    approvalAsked.map(event => event.data?.callId),
    [toolCalls[1]?.data?.callId, toolCalls[3]?.data?.callId, toolCalls[4]?.data?.callId],
  )
  assert.deepEqual(
    approvalDecided.map(event => event.data?.outcome),
    ['rejected', 'allowed-once', 'allowed-once'],
  )
  assert.deepEqual(
    approvalDecided.map(event => event.data?.id),
    approvalAsked.map(event => event.data?.id),
    'standard toolchain approval audit pairs were not aligned',
  )

  const todos = events.filter(event => event.type === 'todo/write')
  assert.equal(todos.length, 1)
  assert.deepEqual(todos[0]?.data?.todos, STANDARD_TOOLCHAIN_STEPS[8].arguments.todos)
  const webRequests = events.filter(event => event.type === 'web/deepseek-search-llm-request')
  assert.equal(webRequests.length, 1)
  assert.ok(JSON.stringify(webRequests[0]?.data).includes('DSH TUI standard toolchain fixture'))
  const goalChanges = events.filter(event => event.type === 'goal/change')
  assert.deepEqual(
    goalChanges.map(event => event.data?.operation),
    ['create', 'pause', 'resume', 'pause'],
  )
  assert.deepEqual(
    goalChanges.map(event => event.data?.goal?.phase),
    ['active', 'paused', 'active', 'paused'],
  )
  assert.ok(goalChanges.every(event => event.data?.goal?.objective === TOOLCHAIN_GOAL))
  const planModes = events.filter(event => event.type === 'plan/mode')
  assert.deepEqual(planModes.map(event => event.data?.active), [true, false])
  const finalAssistant = events
    .filter(event => event.type === 'assistant/message')
    .findLast(event => JSON.stringify(event.data).includes(TOOLCHAIN_RESPONSE))
  assert.ok(finalAssistant, 'standard toolchain Session omitted its final assistant response')
  assert.equal(
    events.filter(event => event.type === 'agent-preset/selected').length,
    0,
    'standard toolchain creation-time selection appended agent-preset/selected',
  )
  return { path, eventCount: events.length }
}

async function assertMinimalSessionLog(
  dshHome,
  workspace,
  expectedSessionId,
  expectedModel = HISTORICAL_MODEL,
) {
  const { path, rows } = await loadSessionLog(dshHome, expectedSessionId)
  const [header, ...events] = rows
  assert.equal(header.type, 'session')
  assert.equal(header.id, expectedSessionId)
  assert.equal(resolve(header.cwd), resolve(workspace))
  assert.equal(header.delegationDepth, 0)
  assert.equal(header.agentPreset, 'standard')
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
  assert.equal(requestHeaders[0]?.data?.header?.config?.model, expectedModel)
  const selectedModes = events.filter(event => event.type === 'agent-preset/selected')
  assert.equal(selectedModes.length, 1, 'the /mode switch must append one durable selection')
  assert.equal(selectedModes[0]?.data?.agentPreset, 'minimal')
  assert.ok(
    selectedModes[0].seq < turnStarts[0].seq,
    'the blank-session /mode selection must precede the first model turn',
  )
  return { path, eventCount: events.length, rows }
}

async function assertResumedMinimalSessionLog(
  dshHome,
  workspace,
  expectedSessionId,
  seed,
  expectedSeedModel,
  expectedResumeModel,
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
  assert.equal(header.agentPreset, 'standard')
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
  assert.equal(seedHeader.data.header.config.provider, 'deepseek-official')
  assert.equal(seedHeader.data.header.config.model, expectedSeedModel)
  assert.equal(resumeHeaders.length, 1)
  const resumeHeader = resumeHeaders[0]
  assert.equal(resumeHeader.data.header.config.provider, 'deepseek-official')
  assert.equal(resumeHeader.data.header.config.model, expectedResumeModel)
  assert.equal(resumeHeader.data.header.config.reasoningEffort, 'off')
  assert.notEqual(
    resumeHeader.data.header.config.model,
    seedHeader.data.header.config.model,
    'explicit cold-resume override did not replace the historical route',
  )

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
  const selectedModes = events.filter(event => event.type === 'agent-preset/selected')
  assert.equal(selectedModes.length, 1)
  assert.equal(selectedModes[0]?.data?.agentPreset, 'minimal')
  return { path, eventCount: events.length, suffixEvents: suffix.length, bytes }
}

async function runStandardToolchainLane({
  options,
  nodePty,
  Terminal,
  cliBin,
  dshHome,
  workspace,
  profilePatchPath,
  profilePatchOptions,
  isolatedEnvironment,
  productWritesPath,
  profileAuditPath,
}) {
  const skillDirectory = join(workspace, '.agents', 'skills', TOOLCHAIN_SKILL)
  await mkdir(join(workspace, '.git'), { recursive: true })
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(workspace, 'seed.txt'), `${TOOLCHAIN_SEED}\n`, 'utf8')
  await writeFile(
    join(skillDirectory, 'SKILL.md'),
    `---\nname: ${TOOLCHAIN_SKILL}\ndescription: Standard toolchain acceptance fixture.\n---\n\n${TOOLCHAIN_SKILL_BODY}\n`,
    'utf8',
  )

  const mock = await startStandardToolchainMock(options.timeoutMilliseconds)
  const previousChatBaseURL = isolatedEnvironment.DEEPSEEK_BASE_URL
  const previousSearchBaseURL = isolatedEnvironment.DEEPSEEK_SEARCH_BASE_URL
  let ptyState
  let evidence
  let primaryError
  const cleanupErrors = []
  try {
    isolatedEnvironment.DEEPSEEK_BASE_URL = mock.baseURL
    isolatedEnvironment.DEEPSEEK_SEARCH_BASE_URL = mock.searchBaseURL
    isolatedEnvironment.DSH_TUI_E2E_PROFILE_AUDIT_PATH = profileAuditPath
    isolatedEnvironment.DSH_TUI_E2E_WRITES_PATH = productWritesPath
    await writeFile(
      profilePatchPath,
      renderProfilePatch({
        ...profilePatchOptions,
        mockBaseURL: mock.baseURL,
        defaultModel: HISTORICAL_MODEL,
      }),
      'utf8',
    )

    ptyState = startPty(
      nodePty,
      Terminal,
      fileURLToPath(import.meta.url),
      cliBin,
      workspace,
      isolatedEnvironment,
    )
    const idleLines = await waitForScreen(
      ptyState,
      (_lines, text) => /DSH-TUI · [^\n·]+ · idle/u.test(text)
        && !text.includes('Startup AgentPreset'),
      'standard toolchain initial idle frame',
      options.timeoutMilliseconds,
    )
    const sessionMatch = /DSH-TUI · ([^\n·]+) · idle/u.exec(idleLines.join('\n'))
    assert.ok(sessionMatch, 'could not extract the standard toolchain Session id')
    const sessionId = sessionMatch[1].trim()
    const profileAudit = assertBootedProfileAudit(
      await waitForJsonFile(
        profileAuditPath,
        options.timeoutMilliseconds,
        'standard toolchain profile audit',
      ),
      { harnessRoot: options.harnessRoot, dshHome, workspace, sessionId },
    )

    ptyState.terminal.resize(RESIZED_COLUMNS, RESIZED_ROWS)
    ptyState.pty.resize(RESIZED_COLUMNS, RESIZED_ROWS)
    await waitForScreen(
      ptyState,
      lines => lines.length === RESIZED_ROWS
        && lines[0]?.includes(`DSH-TUI · ${sessionId} · idle`),
      'standard toolchain resized frame',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write(`/${SETTINGS_COMMAND}`)
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${SETTINGS_COMMAND}`),
      'standard toolchain Settings command echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Runtime library')
        && /▰ SETTINGS [1-9]\d*/u.test(text)
        && text.includes('Layer stack')
        && text.includes('WRITE · USER FILE')
        && text.includes('EFFECTIVE'),
      'standard toolchain official Settings layer projection',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, 0, 'local Settings browsing unexpectedly invoked the model')
    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Runtime library')
        && /▰ PLUGINS [1-9]\d*/u.test(text)
        && text.includes('Lifecycle rail')
        && text.includes('CONFIGURED')
        && text.includes('Authority  Loader snapshot · read only'),
      'standard toolchain Loader lifecycle projection',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, 0, 'local Loader browsing unexpectedly invoked the model')
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => !text.includes('▌ Runtime library')
        && text.includes(`DSH-TUI · ${sessionId} · idle`),
      'standard toolchain Runtime Library close',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write(`/${MCP_COMMAND}`)
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${MCP_COMMAND}`),
      'standard toolchain MCP command echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ MCP capabilities')
        && text.includes('0/0 tools · 0 namespaces · exact Agent')
        && text.includes('No MCP capabilities mounted on this Agent')
        && text.includes('Health') === false,
      'standard toolchain empty exact-Agent MCP projection',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, 0, 'local MCP browsing unexpectedly invoked the model')
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => !text.includes('▌ MCP capabilities')
        && text.includes(`DSH-TUI · ${sessionId} · idle`),
      'standard toolchain MCP directory close',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write('/tools')
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, '/tools'),
      'standard toolchain Tools command echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Tools')
        && text.includes(`${STANDARD_TOOLS.length}/${STANDARD_TOOLS.length} · exact Agent`)
        && text.includes('Capabilities')
        && text.includes('Selected'),
      'standard toolchain exact-Agent capability directory',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, 0, 'local Tools browsing unexpectedly invoked the model')
    ptyState.pty.write('pwsh')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`1/${STANDARD_TOOLS.length} · exact Agent`)
        && text.includes('pwsh')
        && text.includes('Kind  Core'),
      'standard toolchain Tool filtering',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => !text.includes('▌ Tools')
        && text.includes(`DSH-TUI · ${sessionId} · idle`),
      'standard toolchain Tools directory close',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write('/plan')
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, '/plan'),
      'standard toolchain Plan command echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('> /plan')
        && !text.includes('Up/Down select'),
      'standard toolchain Plan command completion',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('CMD  /plan')
        && text.includes('Status: success')
        && text.includes('PLAN ON'),
      'standard toolchain active Plan workbench projection',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write('/skills')
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, '/skills'),
      'standard toolchain Skills command echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Skills')
        && text.includes('1/1 · exact Agent')
        && text.includes(`/${TOOLCHAIN_SKILL}`)
        && text.includes('Invoke  user ✓ · model ✓')
        && text.includes('Source  project-agents · filesystem')
        && !text.includes('Up/Down'),
      'standard toolchain scoped Skills directory',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, 0, 'local Skills browsing unexpectedly invoked the model')
    ptyState.pty.write('toolchain')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('1/1 · exact Agent')
        && text.includes(`/${TOOLCHAIN_SKILL}`),
      'standard toolchain Skill filtering',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`> /${TOOLCHAIN_SKILL} `)
        && !text.includes('▌ Skills'),
      'standard toolchain Skill token insertion',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write(TOOLCHAIN_PROMPT)
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`> ${TOOLCHAIN_USER_PROMPT}`),
      'standard toolchain Skill prompt echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('RETRY 2/2')
        && text.includes('deepseek-official')
        && text.includes('WAIT 750ms')
        && text.includes('SERVER'),
      'standard toolchain provider retry backoff rail',
      options.timeoutMilliseconds,
    )
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('ATTEMPT 2/2')
        && text.includes('LIVE'),
      'standard toolchain provider retry live-attempt rail',
      options.timeoutMilliseconds,
    )
    await waitForCondition(
      () => mock.chatRequests.length === 1,
      options.timeoutMilliseconds,
      'standard toolchain held second request',
    )
    const retryModelRequestBaseline = mock.chatRequests.length
    assert.equal(retryModelRequestBaseline, 1, 'retry-started did not reach the held second request')
    assert.equal(mock.retryRequests.length, 1, 'standard toolchain did not issue exactly one failed request')
    ptyState.pty.write('/attempts')
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, '/attempts'),
      'standard toolchain Attempts command echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Request attempts')
        && text.includes('×01 ─ ◉02')
        && text.includes('State  REQUESTING')
        && text.includes('Provider  deepseek-official')
        && text.includes('Failure  SERVER · HTTP 503')
        && text.includes('Message  temporary provider failure'),
      'standard toolchain fixed request-attempt diagnostic overlay',
      options.timeoutMilliseconds,
    )
    assert.equal(
      mock.chatRequests.length,
      retryModelRequestBaseline,
      'local /attempts unexpectedly invoked the model',
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => !text.includes('▌ Request attempts')
        && text.includes('ATTEMPT 2/2')
        && text.includes('LIVE'),
      'standard toolchain request-attempt overlay close',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write(`/${ROUTE_COMMAND}`)
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${ROUTE_COMMAND}`),
      'standard toolchain Route command echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Model route')
        && text.includes('◉01')
        && text.includes('State  CURRENT')
        && text.includes('Provider  deepseek-official')
        && text.includes(`Model  ${HISTORICAL_MODEL}`)
        && text.includes('Header  INITIAL')
        && text.includes('Authority  Official request/header + request/context'),
      'standard toolchain fixed request-route overlay',
      options.timeoutMilliseconds,
    )
    assert.equal(
      mock.chatRequests.length,
      retryModelRequestBaseline,
      'local /route unexpectedly invoked the model',
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => !text.includes('▌ Model route')
        && text.includes('ATTEMPT 2/2')
        && text.includes('LIVE'),
      'standard toolchain request-route overlay close',
      options.timeoutMilliseconds,
    )
    mock.releaseRetryResponse()

    await waitForScreen(
      ptyState,
      (lines, text) => text.includes('▌ Permission request')
        && text.includes('One-time access')
        && lines.some(line => line.includes('Tool') && line.includes('pwsh'))
        && text.includes('REJECT')
        && text.includes('ALLOW ONCE')
        && text.includes('Enter confirm'),
      'standard toolchain rejected approval prompt',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('n\r')

    await waitForScreen(
      ptyState,
      (lines, text) => text.includes('▌ Permission request')
        && text.includes('One-time access')
        && lines.some(line => line.includes('Tool') && line.includes('write'))
        && text.includes('REJECT')
        && text.includes('ALLOW ONCE')
        && text.includes('Enter confirm'),
      'standard toolchain allowed write approval prompt',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('y\r')

    await waitForScreen(
      ptyState,
      (lines, text) => text.includes('▌ Permission request')
        && text.includes('One-time access')
        && lines.some(line => line.includes('Tool') && line.includes('edit'))
        && text.includes('REJECT')
        && text.includes('ALLOW ONCE')
        && text.includes('Enter confirm'),
      'standard toolchain allowed edit approval prompt',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('y\r')

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Answer')
        && text.includes('Toolchain')
        && text.includes('Choose the accepted fixture option.')
        && text.includes('○ Beta')
        && text.includes('Enter choose'),
      'standard toolchain answered question prompt',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b[B\r')

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Answer')
        && text.includes('Cancel')
        && text.includes('Cancel this fixture question.')
        && text.includes('free response')
        && text.includes('Ctrl+S skip'),
      'standard toolchain cancelled question prompt',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('GOAL ACTIVE')
        && text.includes('PLAN ON · TODO 1/2')
        && text.includes('● Verify TUI interactions'),
      'standard toolchain active Goal workbench projection',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write('\x07')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('GOAL ACTIONS')
        && text.includes('Goal active · revision 1 · [DSH/official]')
        && text.includes('goal> Pause goal'),
      'standard toolchain first-party Goal action dock',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('GOAL PAUSED')
        && text.includes('Notice: Goal paused')
        && text.includes('PLAN ON · TODO 1/2'),
      'standard toolchain TUI-paused Goal projection',
      options.timeoutMilliseconds,
    )
    mock.releasePausedGoal()

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Plan review')
        && text.includes('Approve this plan and leave plan mode?')
        && text.includes('# Ship the first-party workbench')
        && text.includes('›  Approve'),
      'standard toolchain first-party Plan Review dock',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('GOAL ACTIVE')
        && text.includes('PLAN OFF'),
      'standard toolchain resumed Goal after approved Plan Review',
      options.timeoutMilliseconds,
    )

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('JOBS 1')
        && text.includes('ACTIVITY · pwsh-1')
        && text.includes(TOOLCHAIN_BACKGROUND_COMMAND),
      'standard toolchain live official background Job card',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x02')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Activity')
        && text.includes('▰ JOBS 1 · 1 LIVE')
        && text.includes('Operations')
        && text.includes(TOOLCHAIN_BACKGROUND_COMMAND)
        && text.includes('RUNNING')
        && text.includes('Identity  pwsh-1 · pwsh')
        && text.includes('Authority  JobRegistry')
        && text.includes('Control  Stop available'),
      'standard toolchain fixed first-party Activity Center',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('k')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`Stop ${TOOLCHAIN_BACKGROUND_COMMAND}?`)
        && text.includes('Enter confirm · Esc back')
        && !text.includes('Activity: Enter confirm stop'),
      'standard toolchain background Job stop confirmation',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(TOOLCHAIN_BACKGROUND_COMMAND)
        && text.includes('KILLED')
        && text.includes('▰ JOBS 1')
        && text.includes('Notice: Stop requested for pwsh-1'),
      'standard toolchain killed official background Job projection',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x02')

    ptyState.pty.write('\x07')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('GOAL ACTIONS')
        && text.includes('Goal active · revision 3 · [DSH/official]')
        && text.includes('goal> Pause goal'),
      'standard toolchain final Goal action dock',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('GOAL PAUSED')
        && text.includes('PLAN OFF'),
      'standard toolchain final TUI-paused Goal projection',
      options.timeoutMilliseconds,
    )
    mock.releaseFinalResponse()

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH  │ ${TOOLCHAIN_RESPONSE}`)
        && text.includes(`DSH-TUI · ${sessionId} · idle`)
        && text.includes('GOAL PAUSED')
        && text.includes('PLAN OFF'),
      'standard toolchain final response',
      options.timeoutMilliseconds,
    )
    await withDeadline(
      mock.titleRequest,
      options.timeoutMilliseconds,
      'standard toolchain official session title request',
    )
    assert.deepEqual(mock.failures, [], 'standard toolchain mock recorded request failures')
    assert.equal(mock.chatRequests.length, STANDARD_TOOLCHAIN_STEPS.length + 1)
    assert.equal(mock.retryRequests.length, 1)
    assert.equal(mock.titleRequests.length, 1)
    assert.equal(mock.searchRequests.length, 1)
    assert.equal(mock.callIds.length, STANDARD_TOOLCHAIN_STEPS.length)

    const workbenchWrites = (await readFile(productWritesPath)).toString('utf8')
    const activeGoalAt = workbenchWrites.indexOf('GOAL ACTIVE')
    const goalActionsAt = workbenchWrites.indexOf('GOAL ACTIONS')
    const pausedGoalAt = workbenchWrites.indexOf('GOAL PAUSED')
    const planReviewAt = workbenchWrites.indexOf('▌ Plan review')
    const resumedGoalAt = workbenchWrites.indexOf('GOAL ACTIVE', pausedGoalAt + 1)
    const finalGoalActionsAt = workbenchWrites.indexOf('GOAL ACTIONS', goalActionsAt + 1)
    const finalPausedGoalAt = workbenchWrites.indexOf('GOAL PAUSED', pausedGoalAt + 1)
    const liveActivityAt = workbenchWrites.indexOf('ACTIVITY · pwsh-1')
    const activityCenterAt = workbenchWrites.indexOf('▌ Activity')
    const activityKillConfirmAt = workbenchWrites.indexOf(`Stop ${TOOLCHAIN_BACKGROUND_COMMAND}?`)
    const killedActivityAt = workbenchWrites.indexOf('KILLED', activityKillConfirmAt)
    const activePlanAt = workbenchWrites.indexOf('PLAN ON')
    const liveTodoAt = workbenchWrites.indexOf('● Verify TUI interactions')
    const inactivePlanAt = workbenchWrites.indexOf('PLAN OFF')
    assert.ok(activeGoalAt >= 0, 'terminal writes omitted the active Goal projection')
    assert.ok(goalActionsAt > activeGoalAt, 'Goal action dock did not follow its active projection')
    assert.ok(pausedGoalAt > goalActionsAt, 'paused Goal did not follow the Goal action dock')
    assert.ok(planReviewAt > pausedGoalAt, 'Plan Review did not follow the paused Goal projection')
    assert.ok(resumedGoalAt > pausedGoalAt, 'resumed Goal did not follow its paused projection')
    assert.ok(finalGoalActionsAt > planReviewAt, 'final Goal action dock did not follow Plan Review')
    assert.ok(finalPausedGoalAt > finalGoalActionsAt, 'final paused Goal did not follow its action dock')
    assert.ok(liveActivityAt > planReviewAt, 'live Activity card did not follow Plan Review')
    assert.ok(activityCenterAt > liveActivityAt, 'fixed Activity Center did not follow its live card')
    assert.ok(activityKillConfirmAt > activityCenterAt, 'Job stop confirmation did not follow Activity Center')
    assert.ok(killedActivityAt > activityKillConfirmAt, 'killed Job did not follow its stop confirmation')
    assert.ok(activePlanAt >= 0, 'terminal writes omitted the active Plan projection')
    assert.ok(liveTodoAt > activePlanAt, 'live Todo did not follow the active Plan projection')
    assert.ok(activeGoalAt > liveTodoAt, 'active Goal did not follow the live Todo projection')
    assert.ok(inactivePlanAt > planReviewAt, 'inactive Plan did not follow the approved Plan Review')

    ptyState.pty.write('\x03')
    const exit = await withDeadline(
      ptyState.exitPromise,
      options.timeoutMilliseconds,
      'standard toolchain DSH-TUI clean Ctrl+C exit',
    )
    assert.equal(
      ptyState.callbackError,
      undefined,
      `standard toolchain terminal callback failed after ${ptyState.rawBytes} raw bytes`,
    )
    assert.equal(exit.exitCode, 0, `standard toolchain exit drifted: ${JSON.stringify(exit)}`)
    assert.equal(exit.signal, undefined, `standard toolchain exit carried a signal: ${JSON.stringify(exit)}`)
    await waitForTerminalParser(ptyState, options.timeoutMilliseconds)
    await assertTerminalLifecycle(productWritesPath, ptyState)
    assert.equal(processExists(ptyState.pty.pid), false)
    const pid = ptyState.pty.pid
    await stopPty(ptyState)
    ptyState = undefined

    assert.equal(existsSync(join(workspace, 'rejected.txt')), false)
    assert.equal(await readFile(join(workspace, 'toolchain.txt'), 'utf8'), `${TOOLCHAIN_RESULT}\n`)
    const productWrites = (await readFile(productWritesPath)).toString('utf8')
    assert.equal(
      productWrites.includes(MOCK_API_KEY),
      false,
      'standard toolchain leaked its Provider key into product terminal writes',
    )
    for (const marker of [
      TOOLCHAIN_PROMPT,
      '▌ Runtime library',
      'Layer stack',
      'WRITE · USER FILE',
      'Lifecycle rail',
      'Authority  Loader snapshot · read only',
      '▌ MCP capabilities',
      '0/0 tools · 0 namespaces · exact Agent',
      'No MCP capabilities mounted on this Agent',
      '▌ Tools',
      `${STANDARD_TOOLS.length}/${STANDARD_TOOLS.length} · exact Agent`,
      '▌ Skills',
      `/${TOOLCHAIN_SKILL}`,
      'Invoke  user ✓ · model ✓',
      'RETRY 2/2 · deepseek-official · WAIT 750ms · SERVER',
      'ATTEMPT 2/2 · deepseek-official · LIVE',
      '▌ Request attempts',
      '×01 ─ ◉02',
      'Failure  SERVER · HTTP 503',
      '▌ Permission request',
      'One-time access',
      'ALLOW ONCE',
      '▌ Answer',
      'Choose the accepted fixture option.',
      'Cancel this fixture question.',
      'GOAL ACTIONS',
      '▌ Plan review',
      '›  Approve',
      'ACTIVITY · pwsh-1',
      '▌ Activity',
      '▰ JOBS 1 · 1 LIVE',
      'Authority  JobRegistry',
      `Stop ${TOOLCHAIN_BACKGROUND_COMMAND}?`,
      'KILLED',
      TOOLCHAIN_RESPONSE,
    ]) {
      assert.ok(productWrites.includes(marker), `standard toolchain terminal writes omitted ${marker}`)
    }
    assert.ok(
      !productWrites.includes('[unsupported:tool-result]'),
      'standard toolchain rendered an official Tool Result as unsupported content',
    )
    const session = await assertStandardToolchainSessionLog(
      dshHome,
      workspace,
      sessionId,
      mock.resolvedSteps,
    )
    evidence = {
      pid,
      sessionId,
      sessionEvents: session.eventCount,
      modelRequests: mock.chatRequests.length,
      retryRequests: mock.retryRequests.length,
      titleRequests: mock.titleRequests.length,
      searchRequests: mock.searchRequests.length,
      toolCalls: mock.callIds.length,
      profileAudit,
    }
  } catch (error) {
    primaryError = error
  } finally {
    try {
      await stopPty(ptyState)
    } catch (error) {
      cleanupErrors.push(new Error(`toolchain ConPTY cleanup failed: ${errorMessage(error)}`, { cause: error }))
    }
    try {
      await mock.close()
    } catch (error) {
      cleanupErrors.push(new Error(`toolchain mock cleanup failed: ${errorMessage(error)}`, { cause: error }))
    }
    try {
      if (previousChatBaseURL === undefined) delete isolatedEnvironment.DEEPSEEK_BASE_URL
      else isolatedEnvironment.DEEPSEEK_BASE_URL = previousChatBaseURL
      if (previousSearchBaseURL === undefined) delete isolatedEnvironment.DEEPSEEK_SEARCH_BASE_URL
      else isolatedEnvironment.DEEPSEEK_SEARCH_BASE_URL = previousSearchBaseURL
      await writeFile(
        profilePatchPath,
        renderProfilePatch({
          ...profilePatchOptions,
          defaultModel: HISTORICAL_MODEL,
        }),
        'utf8',
      )
    } catch (error) {
      cleanupErrors.push(new Error(`toolchain profile restore failed: ${errorMessage(error)}`, { cause: error }))
    }
  }

  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], 'standard toolchain lane and cleanup both failed')
  }
  if (primaryError !== undefined) throw primaryError
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'standard toolchain lane cleanup failed')
  assert.ok(evidence, 'standard toolchain lane completed without evidence')
  return evidence
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
  const toolchainProductWritesPath = join(temporaryRoot, 'toolchain-product-writes.bin')
  const minimalProductWritesPath = join(temporaryRoot, 'minimal-product-writes.bin')
  const resumeProductWritesPath = join(temporaryRoot, 'resume-product-writes.bin')
  const missingProductWritesPath = join(temporaryRoot, 'missing-product-writes.bin')
  const standardProfileAuditPath = join(temporaryRoot, 'profile-audit-standard.json')
  const toolchainProfileAuditPath = join(temporaryRoot, 'profile-audit-toolchain.json')
  const minimalProfileAuditPath = join(temporaryRoot, 'profile-audit-minimal.json')
  const resumeProfileAuditPath = join(temporaryRoot, 'profile-audit-resume.json')
  const missingProfileAuditPath = join(temporaryRoot, 'profile-audit-missing.json')
  await mkdir(dshHome, { recursive: true })
  await mkdir(agentsHome, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(productWritesPath, '')
  await writeFile(toolchainProductWritesPath, '')
  await writeFile(minimalProductWritesPath, '')
  await writeFile(resumeProductWritesPath, '')
  await writeFile(missingProductWritesPath, '')

  const executableSearchPath = [
    dirname(process.execPath),
    process.env.PATH ?? process.env.Path ?? '',
  ].filter(value => value !== '').join(';')
  const isolatedEnvironment = Object.fromEntries(
    Object.entries({
      ...process.env,
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: agentsHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'read-only',
      DSH_TOOLS_MODE: 'native',
      DEEPSEEK_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      PATH: executableSearchPath,
      Path: executableSearchPath,
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
        'success,slow_success,success,success',
        '--repeat-last',
        '--success-text',
        RESPONSE,
        '--chunk-size',
        '1',
        '--chunk-delay-ms',
        '150',
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
    assert.ok(dump.stdout.includes('id: llm-pi-ai') && dump.stdout.includes(OPENAI_MODEL))
    assert.ok(dump.stdout.includes('id: session-persistence-jsonl') && dump.stdout.includes('compression: none'))
    assert.ok(dump.stdout.includes('id: dsh-tui-e2e-profile-audit'))

    const installedPluginPath = join(profileDir, 'node_modules', 'dsh-tui', 'lib', 'plugin.js')
    const installedDriverPath = join(profileDir, 'node_modules', 'dsh-tui', 'lib', 'terminal', 'driver.js')
    assert.ok(existsSync(installedPluginPath), `installed profile omitted ${installedPluginPath}`)
    assert.ok(existsSync(installedDriverPath), `installed profile omitted ${installedDriverPath}`)
    await verifyInstalledPackage(
      options.dshTuiRoot,
      join(profileDir, 'node_modules', 'dsh-tui'),
    )
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
    const initialLines = await waitForScreen(
      ptyState,
      (_lines, text) => /DSH-TUI · [^\n·]+ · idle/u.test(text)
        && !text.includes('Startup AgentPreset'),
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
      (lines, text) => lines.length === RESIZED_ROWS
        && lines[0]?.includes(`DSH-TUI · ${sessionId} · idle`)
        && lines[RESIZED_ROWS - 1]?.includes('MODEL ')
        && !text.includes('Ctrl+C cancel'),
      '100x30 resize frame',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write(CONNECT_PREFIX)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, CONNECT_PREFIX)
        && text.includes(`/${CONNECT_COMMAND}`)
        && text.includes('Manage providers')
        && !text.includes('COMMANDS')
        && !text.includes('[DSH-TUI/local]')
        && !text.includes('Up/Down select'),
      'local Provider connection discovery menu',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${CONNECT_COMMAND}`),
      'local Provider connection Tab completion',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => text.includes('Providers / Connections')
        && text.includes('Directory')
        && lines.some(line => line.includes('› DeepSeek'))
        && text.includes('Route  deepseek-official')
        && text.includes('Enter connect/reconnect'),
      'dynamic official Provider directory',
      options.timeoutMilliseconds,
    )
    await moveSelectionTo(
      ptyState,
      'DeepSeek',
      'DeepSeek Provider',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Providers / Connections')
        && text.includes('CONNECTION METHOD')
        && text.includes('Connect DeepSeek (deepseek-official)'),
      'DeepSeek connection methods',
      options.timeoutMilliseconds,
    )
    await moveSelectionTo(
      ptyState,
      'id:api-key',
      'DeepSeek API-key method',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Providers / Connections')
        && text.includes('PROVIDER AUTHORIZATION')
        && text.includes('Enter API key for DeepSeek')
        && text.includes('secret ›'),
      'DeepSeek secret prompt',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write(MOCK_API_KEY)
    const maskedDeepSeekLines = await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('secret › ' + '•'.repeat(Array.from(MOCK_API_KEY).length)),
      'masked DeepSeek API key',
      options.timeoutMilliseconds,
    )
    assert.equal(maskedDeepSeekLines.join('\n').includes(MOCK_API_KEY), false)
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => lines.some(line => {
        const normalized = line.toLowerCase()
        return normalized.includes('› ')
          && normalized.includes('deepseek')
          && normalized.includes('connected')
      }) && lines.some(line => (
        line.toLowerCase().replace(/\s+/gu, ' ').includes('credential reference')
      )),
      'connected DeepSeek Provider row',
      options.timeoutMilliseconds,
    )

    await moveSelectionTo(
      ptyState,
      '› openai  ',
      'OpenAI Provider',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Providers / Connections')
        && text.includes('CONNECTION METHOD')
        && text.includes('(openai)')
        && text.includes('id:api-key'),
      'OpenAI connection methods',
      options.timeoutMilliseconds,
    )
    await moveSelectionTo(
      ptyState,
      'id:api-key',
      'OpenAI API-key method',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Providers / Connections')
        && text.includes('PROVIDER AUTHORIZATION')
        && text.includes('secret ›'),
      'official OpenAI secret prompt',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write(MOCK_API_KEY)
    const maskedOpenAiLines = await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('secret › ' + '•'.repeat(Array.from(MOCK_API_KEY).length)),
      'masked OpenAI API key',
      options.timeoutMilliseconds,
    )
    assert.equal(maskedOpenAiLines.join('\n').includes(MOCK_API_KEY), false)
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => lines.some(line => {
        const normalized = line.toLowerCase()
        return normalized.includes('› ')
          && normalized.includes('openai')
          && normalized.includes('connected')
      }) && lines.some(line => (
        line.toLowerCase().replace(/\s+/gu, ' ').includes('credential api-key')
      )),
      'connected OpenAI Provider row',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && !text.includes('Providers / Connections'),
      'Provider directory dismissal',
      options.timeoutMilliseconds,
    )
    const providerConnectModelRequests = mockMonitor.records
      .filter(record => record?.type === 'request').length
    assert.equal(providerConnectModelRequests, 0, 'Provider connections unexpectedly invoked a model')

    ptyState.pty.write(COMMAND_PREFIX)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, COMMAND_PREFIX)
        && text.includes(`/${COMMAND_NAME}`)
        && text.includes('Manage goal')
        && !text.includes('[DSH/official]')
        && !text.includes('Up/Down select'),
      'official slash-command discovery menu',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`> /${COMMAND_NAME}`)
        && !text.includes('Ctrl+C cancel'),
      'Tab command completion',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`CMD  /${COMMAND_NAME}`)
        && text.includes('Status: success')
        && text.includes(`DSH-TUI · ${sessionId} · idle`),
      'durable slash-command settlement',
      options.timeoutMilliseconds,
    )
    const commandModelRequests = mockMonitor.records.filter(record => record?.type === 'request').length
    assert.equal(commandModelRequests, 0, 'slash command unexpectedly reached the mock LLM')

    ptyState.pty.write(CATALOG_PREFIX)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, CATALOG_PREFIX)
        && text.includes(`/${CATALOG_COMMAND}`)
        && text.includes('Browse sessions')
        && !text.includes('[DSH-TUI/local]')
        && !text.includes('Up/Down select'),
      'local session-catalog discovery menu',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${CATALOG_COMMAND}`),
      'local session-catalog Tab completion',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Sessions')
        && text.includes('Session list')
        && text.includes('Durable')
        && text.includes(sessionId)
        && text.includes('current')
        && text.includes('F fork'),
      'official session picker',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`Already viewing session ${sessionId}`)
        && text.includes('▌ Sessions'),
      'current-session live-switch no-op',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && !text.includes('▌ Sessions'),
      'local session picker dismissal',
      options.timeoutMilliseconds,
    )
    const catalogModelRequests = mockMonitor.records.filter(record => record?.type === 'request').length
    assert.equal(catalogModelRequests, 0, 'local session catalog unexpectedly reached the mock LLM')

    ptyState.pty.write(MODEL_PREFIX)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, MODEL_PREFIX)
        && text.includes(`/${MODEL_COMMAND}`)
        && text.includes('Switch model')
        && !text.includes('[DSH-TUI/local]')
        && !text.includes('Up/Down select'),
      'local model discovery menu',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${MODEL_COMMAND}`),
      'local model Tab completion',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => text.includes('Models / Route selection')
        && text.includes('Catalog')
        && lines.some(line => line.includes('› ') && line.includes('DeepSeek-V4-Flash'))
        && text.includes('Ctrl+S'),
      'cached-first DSH model picker',
      options.timeoutMilliseconds,
    )
    await moveSelectionTo(
      ptyState,
      'DSH-TUI OpenAI E2E',
      'newly connected OpenAI model',
      options.timeoutMilliseconds,
    )
    assert.equal(
      mockMonitor.records.filter(record => record?.type === 'request').length,
      0,
      'live OpenAI model discovery unexpectedly invoked a model',
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && !text.includes('Models / Route selection'),
      'OpenAI model visibility check dismissal',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write(MODEL_PREFIX)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, MODEL_PREFIX)
        && text.includes(`/${MODEL_COMMAND}`)
        && text.includes('Switch model'),
      'reopened local model discovery menu',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${MODEL_COMMAND}`),
      'reopened local model Tab completion',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => text.includes('Models / Route selection')
        && text.includes('Catalog')
        && lines.some(line => line.includes('› ') && line.includes('DeepSeek-V4-Flash')),
      'reopened DSH model picker',
      options.timeoutMilliseconds,
    )
    await moveSelectionTo(
      ptyState,
      'DeepSeek-V4-Pro',
      'DSH model selection',
      options.timeoutMilliseconds,
    )
    await waitForScreen(
      ptyState,
      lines => lines.some(line => line.includes('› ') && line.includes('DeepSeek-V4-Pro')),
      'DSH model selection',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => text.includes('Models / Reasoning effort')
        && text.includes('Reasoning options')
        && lines.some(line => line.includes('Route  deepseek-official'))
        && lines.some(line => line.includes('› Off')
          && line.includes('id:off')
          && line.includes('default'))
        && text.includes('Ctrl+S switch+default'),
      'adapter-owned reasoning picker',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && text.includes(`deepseek-official/${PICKED_MODEL} · off`)
        && text.includes(`Model switched: deepseek-official/${PICKED_MODEL} · off`),
      'validated Session-only model switch',
      options.timeoutMilliseconds,
    )
    const modelPickerModelRequests = mockMonitor.records
      .filter(record => record?.type === 'request').length
    assert.equal(modelPickerModelRequests, 0, 'local model selection unexpectedly reached the mock LLM')

    ptyState.pty.write(PROMPT)
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(PROMPT_SUFFIX),
      'real prompt editor echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(PROMPT_SUFFIX)
        && text.includes(`DSH  │ ${RESPONSE}`)
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

    const contextRequestBaseline = mockMonitor.records
      .filter(record => record?.type === 'request').length
    const beforeCompactionLines = await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.includes(`DSH-TUI · ${sessionId} · idle`)
        && text.includes(`deepseek-official/${PICKED_MODEL}/off`)
        && text.includes('CTX [')
        && text.includes('CACHE 0%')
        && text.includes('TOK ↑3'),
      'live official statusline projection',
      options.timeoutMilliseconds,
    )
    const beforeCompactionStatus = beforeCompactionLines.find(line => line.includes('CTX '))
    assert.ok(beforeCompactionStatus, 'statusline omitted context before compaction')
    ptyState.pty.write(`/${CONTEXT_COMMAND}`)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, `/${CONTEXT_COMMAND}`)
        && text.includes(`/${CONTEXT_COMMAND}`)
        && text.includes('Inspect context')
        && !text.includes('[DSH-TUI/local]'),
      'local context projection discovery',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Context / Pressure')
        && text.includes(`Session  ${sessionId}`)
        && text.includes('Next request')
        && text.includes('Request envelope')
        && text.includes('Provider usage')
        && text.includes('Provider    3')
        && text.includes('Input       3')
        && text.includes('Cache read  0')
        && text.includes('Hit rate    0%')
        && text.includes('Official projection · seq')
        && text.includes('/compact')
        && text.includes('maintain context'),
      'official token-meter context panel',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && text.includes('CTX [')
        && !text.includes('Context / Pressure'),
      'context panel dismissal',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write(COMPACT_PREFIX)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, COMPACT_PREFIX)
        && text.includes(`/${COMPACT_COMMAND}`)
        && text.includes('Compact context')
        && !text.includes('[DSH/official]'),
      'official Harness compaction command discovery',
      options.timeoutMilliseconds,
    )
    const contextInspectionModelRequests = mockMonitor.records
      .filter(record => record?.type === 'request').length - contextRequestBaseline
    assert.equal(contextInspectionModelRequests, 0, 'context inspection or compact discovery invoked a model')

    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, `/${COMPACT_COMMAND}`)
        && text.includes('Compact context'),
      'official compaction Tab completion',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    const afterCompactionLines = await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('CMD  /compact')
        && text.includes('Status: success')
        && text.includes('Compacted ')
        && text.includes('history items')
        && text.includes(`DSH-TUI · ${sessionId} · idle`)
        && text.includes('CTX ')
        && !text.includes('COMPACT …'),
      'official compaction settlement and statusline refresh',
      options.timeoutMilliseconds,
    )
    const compactionWrites = (await readFile(productWritesPath)).toString('utf8')
    const runningStatusIndex = compactionWrites.indexOf('COMPACT …')
    const runningCommandIndex = compactionWrites.indexOf('Status: running')
    const completedCommandIndex = compactionWrites.indexOf('Status: success', runningStatusIndex)
    assert.ok(runningStatusIndex >= 0, 'terminal writes omitted the running compaction statusline')
    assert.ok(runningCommandIndex >= 0, 'terminal writes omitted the running /compact command card')
    assert.ok(completedCommandIndex > runningStatusIndex, 'completed command preceded the running statusline')
    assert.ok(completedCommandIndex > runningCommandIndex, 'completed command preceded its running card')
    const afterCompactionStatus = afterCompactionLines.find(line => line.includes('CTX '))
    assert.ok(afterCompactionStatus, 'statusline omitted context after compaction')
    assert.notEqual(
      afterCompactionStatus,
      beforeCompactionStatus,
      'statusline did not react to the official compaction replacement',
    )

    ptyState.pty.write(`/${CONTEXT_COMMAND}`)
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Context / Pressure')
        && text.includes(`Session  ${sessionId}`)
        && text.includes('Last: completed')
        && text.includes('items · ~'),
      'post-compaction official context panel',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && text.includes('CTX [')
        && !text.includes('Context / Pressure'),
      'post-compaction context panel dismissal',
      options.timeoutMilliseconds,
    )
    const compactionModelRequests = mockMonitor.records
      .filter(record => record?.type === 'request').length - contextRequestBaseline
    assert.equal(compactionModelRequests, 1, 'manual compaction did not make exactly one summary request')

    const permissionRequestBaseline = mockMonitor.records
      .filter(record => record?.type === 'request').length
    await applyPermissionPresetThroughControl(
      ptyState,
      {
        currentValue: 'read-only',
        targetValue: 'danger-full-access',
        direction: 'down',
        steps: 2,
      },
      options.timeoutMilliseconds,
    )
    await applyPermissionPresetThroughControl(
      ptyState,
      {
        currentValue: 'danger-full-access',
        targetValue: 'read-only',
        direction: 'up',
        steps: 2,
      },
      options.timeoutMilliseconds,
    )
    await openPermissionControl(
      ptyState,
      'read-only',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => !text.includes('▌ Session permissions')
        && text.includes(`DSH-TUI · ${sessionId} · idle`),
      'official permission control close',
      options.timeoutMilliseconds,
    )
    const permissionModelRequests = mockMonitor.records
      .filter(record => record?.type === 'request').length - permissionRequestBaseline
    assert.equal(permissionModelRequests, 0, 'local permission control unexpectedly invoked the model')

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
    assert.equal(
      (await readFile(productWritesPath)).includes(MOCK_API_KEY),
      false,
      'masked Provider key leaked into product terminal writes',
    )
    assert.equal(processExists(ptyState.pty.pid), false)
    const standardPtyPid = ptyState.pty.pid
    await stopPty(ptyState)
    ptyState = undefined

    const afterStandardLogs = await sessionLogPaths(dshHome)
    assert.equal(afterStandardLogs.raw.length, 1, 'standard lane did not materialize one Session')
    assert.equal(afterStandardLogs.compressed.length, 0)
    const credentialsPath = join(dshHome, '.credentials.yaml')
    const credentialsDocument = await readFile(credentialsPath, 'utf8')
    assert.ok(credentialsDocument.includes('DEEPSEEK_API_KEY'))
    assert.ok(credentialsDocument.includes('llm-pi-ai/openai'))
    assert.equal(
      countOccurrences(credentialsDocument, MOCK_API_KEY),
      2,
      'official credential store did not hold exactly the two accepted Provider connections',
    )
    const leakedCredentialFiles = []
    for (const path of await listFiles(dshHome)) {
      if (resolve(path) === resolve(credentialsPath)) continue
      if (path.split(/[\\/]/u).includes('node_modules')) continue
      if ((await readFile(path)).includes(MOCK_API_KEY)) leakedCredentialFiles.push(path)
    }
    assert.deepEqual(
      leakedCredentialFiles,
      [],
      'Provider key escaped the official credential store',
    )

    const toolchain = await runStandardToolchainLane({
      options,
      nodePty,
      Terminal,
      cliBin,
      dshHome,
      workspace,
      profilePatchPath,
      profilePatchOptions,
      isolatedEnvironment,
      productWritesPath: toolchainProductWritesPath,
      profileAuditPath: toolchainProfileAuditPath,
    })
    const afterToolchainLogs = await sessionLogPaths(dshHome)
    assert.equal(
      afterToolchainLogs.raw.length,
      2,
      'standard toolchain lane did not materialize one additional Session',
    )
    assert.equal(afterToolchainLogs.compressed.length, 0)

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
      [
        '--cwd',
        workspace,
        '--provider',
        'deepseek-official',
        '--model',
        CLI_OVERRIDE_MODEL,
        '--reasoning-effort',
        'off',
      ],
    )
    const minimalIdleLines = await waitForScreen(
      ptyState,
      (_lines, text) => /DSH-TUI · [^\n·]+ · idle/u.test(text)
        && !text.includes('Startup AgentPreset'),
      'default-Standard idle frame for the mode-switch lane',
      options.timeoutMilliseconds,
    )
    const minimalMatch = /DSH-TUI · ([^\n·]+) · idle/u.exec(minimalIdleLines.join('\n'))
    assert.ok(minimalMatch, 'could not extract the minimal DSH-TUI session id')
    const minimalSessionId = minimalMatch[1].trim()
    assert.notEqual(minimalSessionId, sessionId)
    const beforeModeSelection = await sessionLogPaths(dshHome)
    assert.equal(
      beforeModeSelection.raw.length,
      2,
      'blank default-Standard startup eagerly materialized an empty Session artifact',
    )
    assert.equal(beforeModeSelection.compressed.length, 0)
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
        agentPresetId: 'standard',
        agentModel: CLI_OVERRIDE_MODEL,
      },
    )

    ptyState.pty.write('/comp')
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, '/comp')
        && text.includes('/compact')
        && text.includes('Compact context')
        && !text.includes('older conversation history')
        && !text.includes('[DSH/official]')
        && !text.includes('Up/Down select'),
      'default-Standard concise scoped command discovery',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x03')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${minimalSessionId} · idle`)
        && !text.includes('> /comp'),
      'default-Standard command probe clear',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write(`/${MODE_COMMAND}`)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, `/${MODE_COMMAND}`)
        && text.includes('Switch Agent mode')
        && !text.includes('[DSH-TUI/local]')
        && !text.includes('Up/Down select'),
      'local Agent-mode command discovery',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => text.includes('Mode / Agent composition')
        && text.includes('Current  standard')
        && text.includes('Blank session · switchable')
        && text.includes('Available compositions')
        && lines.some(line => line.includes('◆ 标准模式') && line.includes('current'))
        && text.includes('PTC 模式')
        && text.includes('极简模式'),
      'live DSH Agent-mode roster',
      options.timeoutMilliseconds,
    )
    await moveSelectionTo(
      ptyState,
      '极简模式',
      'minimal Agent mode',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${minimalSessionId} · idle`)
        && !text.includes('Mode / Agent composition'),
      'same-Session DSH Agent-mode picker dismissal',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write(`/${MODE_COMMAND}`)
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${MODE_COMMAND}`),
      'recomposed Agent-mode command echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => text.includes('Mode / Agent composition')
        && text.includes('Current  minimal')
        && lines.some(line => line.includes('◆ 极简模式') && line.includes('current')),
      'same-Session DSH Agent-mode recompose',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${minimalSessionId} · idle`)
        && !text.includes('Mode / Agent composition'),
      'recomposed Agent-mode picker dismissal',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('/comp')
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, '/comp')
        && text.includes('No matches for /comp')
        && !text.includes('/compact'),
      'recomposed exact-Session command catalog',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x03')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${minimalSessionId} · idle`)
        && !text.includes('> /comp'),
      'recomposed command probe clear',
      options.timeoutMilliseconds,
    )
    assert.equal(
      mockMonitor.records.filter(record => record?.type === 'request').length,
      minimalRequestBaseline,
      'the local /mode flow unexpectedly reached the mock LLM',
    )
    const afterModeSelection = await sessionLogPaths(dshHome)
    assert.equal(
      afterModeSelection.raw.length,
      3,
      'the durable /mode selection did not materialize exactly one Session artifact',
    )
    assert.equal(afterModeSelection.compressed.length, 0)

    ptyState.pty.write(COMMAND_PREFIX)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, COMMAND_PREFIX)
        && text.includes(`/${COMMAND_NAME}`)
        && text.includes('Manage goal'),
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
      (_lines, text) => text.includes(`CMD  /${COMMAND_NAME}`)
        && text.includes('Status: success'),
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
      (_lines, text) => text.includes('YOU  │ ' + MINIMAL_SEED_PROMPT)
        && text.includes('DSH  │ ' + RESPONSE)
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

    const lockedModeRequestBaseline = mockMonitor.records
      .filter(record => record?.type === 'request').length
    ptyState.pty.write(`/${MODE_COMMAND}`)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, `/${MODE_COMMAND}`)
        && text.includes('Switch Agent mode'),
      'started-session Agent-mode command discovery',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Mode / Agent composition')
        && text.includes('Current  minimal')
        && text.includes('Turn started · locked')
        && text.includes('Mode locked after the first turn')
        && text.includes('New session required'),
      'started-session Agent-mode lock',
      options.timeoutMilliseconds,
    )
    assert.equal(
      mockMonitor.records.filter(record => record?.type === 'request').length,
      lockedModeRequestBaseline,
      'the locked /mode flow unexpectedly reached the mock LLM',
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${minimalSessionId} · idle`)
        && !text.includes('Mode / Agent composition'),
      'locked Agent-mode picker dismissal',
      options.timeoutMilliseconds,
    )

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
    assert.equal(afterMinimalLogs.raw.length, 3, 'minimal lane did not materialize one additional Session')
    assert.equal(afterMinimalLogs.compressed.length, 0)
    const minimalSeedSession = await assertMinimalSessionLog(
      dshHome,
      workspace,
      minimalSessionId,
      CLI_OVERRIDE_MODEL,
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
      [
        '--resume',
        minimalSessionId,
        '--provider',
        'deepseek-official',
        '--model',
        HISTORICAL_MODEL,
        '--reasoning-effort',
        'off',
      ],
    )
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('DSH-TUI · ' + minimalSessionId + ' · idle')
        && text.includes('YOU  │ ' + MINIMAL_SEED_PROMPT)
        && text.includes('DSH  │ ' + RESPONSE)
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
        creationAgentPresetId: 'standard',
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
      (_lines, text) => text.includes('YOU  │ ' + RESUME_PROMPT)
        && text.includes('DSH  │ ' + RESPONSE)
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
      CLI_OVERRIDE_MODEL,
      HISTORICAL_MODEL,
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
    for (const [requestIndex, requestRecord] of requests.entries()) {
      assert.equal(requestRecord.path, '/v1/chat/completions')
      assert.equal(requestRecord.behavior, requestIndex === 1 ? 'slow_success' : 'success')
      const matchingResults = results.filter(resultRecord => resultRecord.attempt === requestRecord.attempt)
      assert.equal(matchingResults.length, 1, `mock attempt ${requestRecord.attempt} did not have exactly one result`)
      assert.equal(matchingResults[0].outcome, requestIndex === 1 ? 'client_closed' : 'completed')
      assert.ok(matchingResults[0].chunksSent > 0, `mock attempt ${requestRecord.attempt} emitted no chunks`)
    }
    mockChild = undefined

    const session = await assertSessionLog(
      dshHome,
      workspace,
      sessionId,
      'standard',
      PICKED_MODEL,
    )
    evidence = {
      pid: standardPtyPid,
      toolchainPid: toolchain.pid,
      minimalPid: minimalPtyPid,
      resumePid: resumePtyPid,
      missingPid: missingPtyPid,
      sessionId,
      minimalSessionId,
      toolchainSessionId: toolchain.sessionId,
      sessionEvents: session.eventCount,
      toolchainSessionEvents: toolchain.sessionEvents,
      minimalSessionEvents: minimalSeedSession.eventCount,
      resumedSessionEvents: resumedMinimalSession.eventCount,
      resumeSuffixEvents: resumedMinimalSession.suffixEvents,
      mockAttempts: requests.length,
      toolchainModelRequests: toolchain.modelRequests,
      toolchainRetryRequests: toolchain.retryRequests,
      toolchainTitleRequests: toolchain.titleRequests,
      toolchainSearchRequests: toolchain.searchRequests,
      toolchainToolCalls: toolchain.toolCalls,
      providerDirectoryCount: profileAudit.hostServices.dshTuiProviders.providers.length,
      providerConnectModelRequests,
      commandModelRequests,
      modelPickerModelRequests,
      minimalCommandModelRequests,
      resumeModelRequests,
      catalogModelRequests,
      contextInspectionModelRequests,
      compactionModelRequests,
      permissionModelRequests,
      profileAudit,
      toolchainProfileAudit: toolchain.profileAudit,
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
      + `providers=dynamic-${evidence.providerDirectoryCount} connect=deepseek-official+openai `
      + `provider_credentials=isolated provider_models=live provider_model_requests=${evidence.providerConnectModelRequests} `
      + `command=${COMMAND_NAME} command_events=paired command_model_requests=${evidence.commandModelRequests} `
      + `catalog=live-switch-current-noop catalog_events=none catalog_model_requests=${evidence.catalogModelRequests} `
      + `statusline=model+effort+context+cache+tokens context=official-token-meter `
      + `context_model_requests=${evidence.contextInspectionModelRequests} `
      + `compact=official-execution+durable-transaction+live-status `
      + `compaction_model_requests=${evidence.compactionModelRequests} `
      + `permission=official-projection+command-switch+restored-read-only permission_model_requests=${evidence.permissionModelRequests} `
      + `model_picker=default-to-${PICKED_MODEL}+off model_picker_requests=${evidence.modelPickerModelRequests} `
      + 'booted_profile=verified global_tools=empty fresh_preset=standard '
      + 'startup_mode=standard-direct mode_switch=standard-to-minimal-same-session+locked-after-first-turn '
      + 'mode_catalog=standard-compact-to-minimal-no-compact '
      + 'skills=user-picker+literal-token+official-pre-step-injection+model-tool '
      + 'fresh_presets=standard mode_selected_events=minimal-once alt_screen=once-per-process '
      + 'host_rows=exact catalogs=cold-after-fresh-exact audit_generation=owned '
      + `tool_directory=exact-agent-${STANDARD_TOOLS.length}+read-only+model-requests-0 `
      + 'runtime_library=settings-redacted-cas+loader-read-only+model-requests-0 '
      + 'mcp_directory=exact-agent-empty+health-not-inferred+model-requests-0 '
      + `standard_toolchain=catalog-${STANDARD_TOOLS.length}+calls-${evidence.toolchainToolCalls}`
      + '+approval-allow-reject+question-answer-cancel+goal-action-pause-resume-pause+plan-review-approve+job-run-kill '
      + 'workbench=goal-active-paused-active-paused+plan-on-review-off+todo-live+activity-live-killed '
      + `toolchain_model_requests=${evidence.toolchainModelRequests} `
      + `toolchain_retry_requests=${evidence.toolchainRetryRequests} `
      + 'request_recovery=official-retry+statusline+fixed-attempt-overlay '
      + 'request_route=official-header-context+fixed-route-overlay '
      + `toolchain_title_requests=${evidence.toolchainTitleRequests} `
      + `toolchain_search_requests=${evidence.toolchainSearchRequests} `
      + `toolchain_session_events=${evidence.toolchainSessionEvents} `
      + `fresh_cli_model=${CLI_OVERRIDE_MODEL}+off `
      + 'cold_resume=explicit-over-history+default current_default=drifted '
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
      + `toolchain_exit=0 toolchain_recovery=exact `
      + `toolchain_pid=${evidence.toolchainPid} toolchain_process=gone `
      + `minimal_exit=0 minimal_recovery=exact `
      + `minimal_pid=${evidence.minimalPid} minimal_process=gone `
      + `resume_exit=0 resume_recovery=exact `
      + `resume_pid=${evidence.resumePid} resume_process=gone `
      + 'missing_exit=1 missing_terminal=never-allocated '
      + 'missing_model_requests=0 missing_session_writes=0 '
      + `missing_pid=${evidence.missingPid} missing_process=gone\n`,
    )
  } catch (error) {
    process.stderr.write(`OFFICIAL_DSH_E2E_FAIL ${errorReport(error)}\n`)
    process.exitCode = 1
  }
}
