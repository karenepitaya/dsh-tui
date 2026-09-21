#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DISABLED_AGENT_PLANE, EXPECTED_GUIDANCE_SHA256 } from './official-dsh-profile-audit.mjs'
import {
  verifyInstalledOrbsPackage,
  verifyInstalledPackage,
} from './verify-installed-package.mjs'

const TEMPORARY_PREFIX = 'dsh-tui-official-e2e-'
const PROFILE_NAME = 'tui'
const MOCK_API_KEY = 'dsh-tui-e2e-key'
const COMMAND_PREFIX = '/go'
const COMMAND_NAME = 'goal'
const COMMAND_ARGS = ' '
const CATALOG_PREFIX = '/se'
const CATALOG_COMMAND = 'sessions'
const CONNECT_COMMAND = 'connect'
const STATUS_COMMAND = 'status'
const COMPACT_PREFIX = '/comp'
const COMPACT_COMMAND = 'compact'
const MODEL_PREFIX = '/mo'
const MODEL_COMMAND = 'models'
const MODE_COMMAND = 'modes'
const PERMISSION_COMMAND = 'permission'
const MCP_COMMAND = 'mcp'
const SETTINGS_COMMAND = 'settings'
const WORKSPACE_RESIZE_SIZES = [[80, 24], [100, 30], [140, 30], [200, 30], [80, 6]]
const WORKSPACE_RESIZE_PAGES = [
  'sessions', 'models', 'status', 'permission', 'modes',
  'settings-form', 'runtime-settings', 'runtime-plugins', 'diff', 'capabilities',
  'activity',
]
const workspaceResizeEvidence = []
const interactionEvidence = []
const navigationEvidence = []
const OPENAI_MODEL = 'dsh-tui-openai-e2e'
const PROVIDER_TEST_PROMPT = 'Reply with OK.'
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
const APPROVAL_ARGUMENT_TAIL = 'DSH_APPROVAL_ARGUMENT_TAIL'
const APPROVAL_DRAFT = 'DSH_TUI_PENDING_APPROVAL_DRAFT'
const DETAILS_DRAFT = 'DSH_TUI_CTRL_O_DRAFT'
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
  'present',
  'pwsh',
  'ralph',
  'read',
  'read_image',
  'send_message',
  'skill',
  'subagent_fork',
  'todo_write',
  'update_goal',
  'web_fetch',
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
// A live Session's tool directory adds the per-session delegation tool on top
// of the standing preset catalog.
const SESSION_STANDARD_TOOLS = Object.freeze([...STANDARD_TOOLS, 'subagent'].sort())
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
      description: `Attempt rejected fixture write. ${'Inspect the exact argument before deciding. '.repeat(40)}${APPROVAL_ARGUMENT_TAIL}`,
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
  const capturePath = process.env.DSH_TUI_E2E_WRITES_PATH
  if (capturePath === undefined) {
    throw new Error('official DSH E2E preload is missing its product write-capture path')
  }
  const write = process.stdout.write.bind(process.stdout)
  let alternateScreen = false
  let stdoutBytes = 0
  process.stdout.write = function captureProductWrite(data, ...args) {
    appendFileSync(capturePath, data)
    stdoutBytes += Buffer.byteLength(data)
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    if (text.includes('\x1b[?1049h')) alternateScreen = true
    if (text.includes('\x1b[?1049l')) alternateScreen = false
    return write(data, ...args)
  }
  const writeError = process.stderr.write.bind(process.stderr)
  process.stderr.write = function captureProductError(data, ...args) {
    appendFileSync(`${capturePath}.stderr.jsonl`, `${JSON.stringify({
      at: new Date().toISOString(),
      alternateScreen,
      stdoutBytes,
      data: Buffer.from(data).toString('base64'),
    })}\n`)
    return writeError(data, ...args)
  }
  process.on('warning', (warning) => {
    appendFileSync(`${capturePath}.warnings.jsonl`, `${JSON.stringify({
      at: new Date().toISOString(),
      alternateScreen,
      stdoutBytes,
      name: warning.name,
      code: warning.code,
      message: warning.message,
      stack: warning.stack,
    })}\n`)
  })
  const originalFetch = globalThis.fetch
  let requestIndex = 0
  globalThis.fetch = function captureMockRequest(input, options) {
    if (typeof input !== 'string' && !(input instanceof URL)) return originalFetch.call(this, input, options)
    const url = new URL(String(input))
    if (url.hostname === '127.0.0.1' && url.pathname.endsWith('/chat/completions')
      && typeof options?.body === 'string') {
      const body = JSON.parse(options.body)
      const lastMessage = JSON.stringify(body.messages?.at(-1)) ?? ''
      const purpose = JSON.stringify(body).includes('Create a concise title for an AI coding-assistant session')
        ? 'session-title'
        : lastMessage.includes('You are now acting as a compaction engine') ? 'compaction' : 'agent'
      const index = ++requestIndex
      const record = event => appendFileSync(`${capturePath}.requests.jsonl`, `${JSON.stringify({
        at: Date.now(), index, event, purpose, model: body.model,
      })}\n`)
      record('request')
      options.signal?.addEventListener('abort', () => record('abort'), { once: true })
    }
    return originalFetch.call(this, input, options)
  }
}

function parseArguments(argv) {
  const defaults = {
    harnessRoot: resolve(fileURLToPath(new URL('../../deepseek-harness/', import.meta.url))),
    orbsRoot: resolve(fileURLToPath(new URL('../packages/pi-tui-orbs/', import.meta.url))),
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
    if (option === '--orbs-root' && value !== undefined) {
      result.orbsRoot = resolve(value)
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

function resolveToolchainStep(step, _body) {
  return step
}

export function isProviderTestRequest(body) {
  if (!Array.isArray(body?.messages) || body.messages.length !== 1) return false
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 0)) return false
  const message = body.messages[0]
  if (message?.role !== 'user') return false
  const content = message.content
  return content === PROVIDER_TEST_PROMPT
    || (Array.isArray(content) && content.length === 1
      && content[0]?.type === 'text' && content[0]?.text === PROVIDER_TEST_PROMPT)
}

export async function startStandardToolchainMock(timeoutMilliseconds) {
  let modelRequestCount = 0
  const chatRequests = []
  const retryRequests = []
  const titleRequests = []
  const providerTestRequests = []
  const providerTestResults = []
  const providerTestPlans = []
  const prepareProviderTest = outcome => {
    assert.ok(outcome === 'success' || outcome === 'failure', 'unsupported isolated provider test outcome')
    let started, release, finish
    const request = new Promise(resolve => { started = resolve })
    const released = new Promise(resolve => { release = resolve })
    const closed = new Promise(resolve => { finish = resolve })
    providerTestPlans.push({ outcome, started, released, release, finish })
    return { request, release, closed }
  }
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
  // 0.1.5 enforces a durable Goal pause by abandoning the in-flight request;
  // the released gate then rolls the ladder back so the driver's next round
  // re-serves the same step.
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
      if (request.url === '/v1/chat/completions') modelRequestCount += 1
      assert.equal(request.method, 'POST', 'standard toolchain mock received a non-POST request')
      const body = await readJsonRequest(request)
      if (request.url === '/v1/chat/completions') {
        assert.equal(
          request.headers.authorization,
          `Bearer ${MOCK_API_KEY}`,
          'standard toolchain chat request used the wrong credential',
        )
        assert.equal(body?.stream, true, 'standard toolchain chat request was not streaming')
        if (isProviderTestRequest(body)) {
          assert.equal(body.model, OPENAI_MODEL, 'provider test did not use the isolated fixture model')
          const outputLimit = body.max_tokens ?? body.max_completion_tokens
          assert.ok(outputLimit > 0 && outputLimit <= 128, 'provider test did not bound its output')
          providerTestRequests.push(body)
          const testIndex = providerTestRequests.length - 1
          const planned = providerTestPlans.shift()
          if (planned) {
            let cancelled = false
            response.once('close', () => {
              if (!response.writableEnded) { cancelled = true; planned.release() }
            })
            planned.started(body)
            await planned.released
            if (cancelled || response.destroyed) {
              providerTestResults.push({ index: testIndex, outcome: 'cancelled' })
              planned.finish()
              return
            }
            response.once('close', planned.finish)
          }
          if (planned?.outcome === 'failure') {
            providerTestResults.push({ index: testIndex, outcome: 'failure' })
            response.writeHead(401, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: { message: 'isolated provider test rejected' } }))
            return
          }
          providerTestResults.push({ index: testIndex, outcome: 'success' })
          completeToolchainText(response, 'OK')
          return
        }
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
          SESSION_STANDARD_TOOLS,
          'standard toolchain request did not carry the exact scoped 0.1.5-rc.2 catalog',
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
          // 0.1.5: the lane's durable Goal pause aborts this held request at
          // execution time; roll the ladder back instead of answering it.
          chatRequests.pop()
          return
        }
        const step = resolveToolchainStep(STANDARD_TOOLCHAIN_STEPS[index], body)
        if (step.name === 'exit_plan_mode' && !pausedGoalReleased) {
          await withDeadline(
            pausedGoalGate,
            timeoutMilliseconds,
            'standard toolchain user-managed Goal pause/resume acknowledgement',
          )
          // The pause above aborted this held request; the resumed Goal's
          // driver round re-requests and re-serves this same step.
          chatRequests.pop()
          return
        }
        resolvedSteps.push(step)
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
    providerTestRequests,
    providerTestResults,
    prepareProviderTest,
    get modelRequestCount() { return modelRequestCount },
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
    // 0.1.5 stores one immutable log per format generation: session.v3.jsonl.
    raw: files.filter(path => /(^|[\\/])session(\.v\d+)?\.jsonl$/u.test(path)),
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

function terminalCellFingerprint(terminal) {
  return Array.from({ length: terminal.rows }, (_, row) => {
    const line = terminal.buffer.active.getLine(row)
    return Array.from({ length: terminal.cols }, (_, column) => {
      const cell = line?.getCell(column)
      return cell === undefined ? [] : [cell.getChars(), cell.getWidth(),
        cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(),
        cell.isBold(), cell.isInverse()]
    })
  })
}

export function waitForScreen(state, predicate, description, timeoutMilliseconds, settleMilliseconds = 0) {
  const inspect = () => {
    if (state.pendingTerminalWrites !== 0 || state.synchronizedUpdate) return undefined
    const lines = screenLines(state.terminal)
    return predicate(lines, lines.join('\n')) ? lines : undefined
  }
  const immediate = inspect()
  if (immediate !== undefined && settleMilliseconds === 0) return Promise.resolve(immediate)
  if (state.callbackError !== undefined) return Promise.reject(state.callbackError)
  if (state.exited) {
    return Promise.reject(new Error(
      `DSH-TUI exited before ${description}: ${JSON.stringify(state.exitRecord)}\n`
      + `screen:\n${outputExcerpt(screenText(state.terminal))}`,
    ))
  }
  let cleanup = () => {}
  return withDeadline(new Promise((resolveLines, rejectLines) => {
    let settleTimer
    cleanup = () => {
      clearTimeout(settleTimer)
      state.events.off('screen', onScreen)
      state.events.off('failure', onFailure)
      state.events.off('exit', onExit)
    }
    const onScreen = () => {
      clearTimeout(settleTimer)
      const lines = inspect()
      if (lines === undefined) return
      if (settleMilliseconds === 0) {
        cleanup()
        resolveLines(lines)
        return
      }
      const bytes = state.rawBytes
      const fingerprint = JSON.stringify(terminalCellFingerprint(state.terminal))
      settleTimer = setTimeout(() => {
        const settled = inspect()
        if (settled !== undefined && state.rawBytes === bytes
          && JSON.stringify(terminalCellFingerprint(state.terminal)) === fingerprint) {
          cleanup()
          resolveLines(settled)
        } else onScreen()
      }, settleMilliseconds)
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
    onScreen()
  }), timeoutMilliseconds, `DSH-TUI ${description}`).finally(() => cleanup()).catch((error) => {
    throw new Error(
      `DSH-TUI failed while waiting for ${description}: ${errorMessage(error)}\n`
      + `terminal: ${JSON.stringify({ synchronizedUpdate: state.synchronizedUpdate,
        completedFrames: state.completedFrames, pendingWrites: state.pendingTerminalWrites,
        paintedWidths: workspacePaintedWidths(state.terminal) })}\n`
      + `screen:\n${outputExcerpt(screenText(state.terminal))}`,
      { cause: error },
    )
  })
}

/** Diagnostic latency; a burst has one visible endpoint, not one painted frame per key. */
export async function measureNavigationSequence(state, steps, name, timeoutMilliseconds) {
  const frameStart = state.completedFrames
  const samples = []
  let inputEvents = 0
  for (const step of steps) {
    const frameBaseline = state.completedFrames
    const started = performance.now()
    state.pty.write(step.input)
    await waitForScreen(state, (lines, text) => state.completedFrames > frameBaseline && step.matches(lines, text),
      `${name}: ${step.expected}`, timeoutMilliseconds)
    samples.push(performance.now() - started)
    inputEvents += step.inputEvents ?? 1
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return { name, columns: state.terminal.cols, rows: state.terminal.rows, inputEvents,
    verifiedTransitions: samples.length, completedFrames: state.completedFrames - frameStart,
    selections: steps.map(step => step.expected),
    latencyMs: { samples, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] },
    method: 'PTY write to expected complete frame parsed by xterm; no added settle delay.',
    limitation: 'Includes ConPTY and xterm parsing; excludes physical display. Bursts verify final selection, not every intermediate paint.' }
}

function selectedScreenLine(lines) {
  // FormWorkspace pages can show two selections at once: the wide sidebar's
  // active category (left columns) and the content list row. The content
  // selection always sits further right; ties resolve to the lower row.
  // A selected slash-command shelf suggestion ('› /…') is not a directory
  // selection, same as before.
  let best
  for (const line of lines) {
    for (const match of line.matchAll(/(^|\s|│)› (?!\/)/gu)) {
      const column = match.index + match[1].length
      if (best === undefined || column >= best.column) best = { column, text: line.slice(column) }
    }
  }
  return best?.text
}

function selectedScreenIdentity(lines) {
  const selected = selectedScreenLine(lines)
  if (selected === undefined) return undefined
  const ids = [...selected.matchAll(/\[([a-z0-9][a-z0-9._:-]*)\]/giu)].map(match => match[1])
  if (ids.length > 0) return ids.join('/')
  const method = /\bid:\s*([^\s│]+)/u.exec(selected)
  if (method !== null) return method[1]
  return selected.replace(/^\s*(?:│\s*)?› /u, '').split(/\s{2,}| · /u)[0].trim()
}

export function workspacePaintedWidths(terminal) {
  return Array.from({ length: terminal.rows }, (_, row) => {
    const line = terminal.buffer.active.getLine(row)
    for (let column = terminal.cols - 1; column >= 0; column -= 1) {
      const cell = line?.getCell(column)
      if (cell?.getChars()) return column + cell.getWidth()
    }
    return 0
  })
}

export function workspaceViewportReady(state, header, columns, rows, frameBaseline) {
  if (state.pendingTerminalWrites !== 0 || state.synchronizedUpdate
    || state.completedFrames <= frameBaseline || state.terminal.cols !== columns
    || state.terminal.rows !== rows) return false
  const lines = screenLines(state.terminal)
  const widths = workspacePaintedWidths(state.terminal)
  const anchors = workspaceGeometryAnchors(state.terminal, widths)
  return lines[0]?.trim() === header
    && lines.at(-1)?.trimStart().startsWith('Esc back')
    && anchors.every(row => widths[row] === columns)
}

function workspaceGeometryAnchors(terminal, widths = workspacePaintedWidths(terminal)) {
  const anchors = new Set([0, 1, terminal.rows - 1])
  const lines = screenLines(terminal)
  // ConPTY preserves bold padding, but can replace ordinary trailing spaces
  // with EL. Therefore use full-row bold content as additional geometry anchors
  // and inspect ordinary rows through the whole-image settlement fingerprint.
  for (let row = 2; row < terminal.rows - 1; row += 1) {
    const line = terminal.buffer.active.getLine(row)
    if (widths[row] > 0 && Array.from({ length: widths[row] }, (_, column) =>
      line?.getCell(column)?.isBold()).every(Boolean)) anchors.add(row)
  }
  return [...anchors]
}

function settingsFieldRow(lines, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return lines.findIndex(line => new RegExp(`│\\s*${escaped}(?:\\s|·)`, 'u').test(line)
    || (new RegExp(`^\\s*${escaped}(?:\\s|·)`, 'u').test(line) && line.includes('▾')))
}

function settingsFieldValue(lines, label, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`\\s${escaped}\\s+▾(?:\\s|│|$)`, 'u').test(lines[settingsFieldRow(lines, label)] ?? '')
}

export function settingsPickerSelected(lines, label, option) {
  const text = lines.join('\n')
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const selected = lines.filter(line => /^\s*(?:│\s*)?[›→]\s/u.test(line))
  return text.includes(label) && /(?:↑↓(?:\/jk)?|j\/k)\s+选择/u.test(text) && text.includes('Esc / q 取消')
    && selected.length === 1 && new RegExp(`[›→]\\s+${escaped}(?:\\s|│|$)`, 'u').test(selected[0])
}

function settingsDialogContent(line) {
  const first = line.indexOf('│')
  const last = line.lastIndexOf('│')
  return first >= 0 && last > first ? line.slice(first + 1, last).trimEnd() : undefined
}

function settingsDialogGroup(line) {
  const content = settingsDialogContent(line)
  return content && /^ \S/u.test(content) && !/^ [›→]/u.test(content) ? content.trim() : undefined
}

export function settingsProviderDialogSelected(lines, title, label, group) {
  const selected = lines.filter(line => /(?:^|│)\s*[›→]\s/u.test(line))
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const selectedIndex = lines.indexOf(selected[0])
  const selectedGroup = lines.slice(0, selectedIndex).map(settingsDialogGroup).filter(Boolean).at(-1)
  return lines.some(line => line.includes('│') && line.includes(title))
    && selected.length === 1 && selected[0].includes('│')
    && new RegExp(`[›→]\\s+${escaped}(?:\\s|│|$)`, 'u').test(selected[0])
    && (group === undefined || selectedGroup === group)
}

export function assertSettingsModelGroup(lines, group, label) {
  const headings = lines.map(settingsDialogGroup)
  const start = headings.indexOf(group)
  assert.ok(start >= 0, `model picker omitted provider group ${group}`)
  assert.equal(headings.filter(item => item === group).length, 1, `provider group ${group} is duplicated`)
  let end = headings.findIndex((item, index) => index > start && item !== undefined)
  if (end < 0) end = lines.length
  const rows = lines.slice(start + 1, end).map(settingsDialogContent).filter(item => item !== undefined)
  const matches = rows.filter(row => row.includes(label))
  assert.equal(matches.length, 1, `model ${label} must occur on one row inside ${group}`)
  assert.equal(matches[0].split(label).length - 1, 1, `model ${label} is repeated on its row`)
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  assert.match(matches[0].trim(), new RegExp(`^(?:[›→]\\s+)?${escaped}(?:\\s|$)`, 'u'),
    `model ${label} repeats its provider name instead of using its group`)
}

export function assertSettingsDialogChrome(lines, title) {
  assert.ok(lines.some(line => settingsDialogContent(line)?.trim() === title), `dialog title ${title} missing`)
  const top = lines.findIndex(line => line.includes('┌'))
  const bottom = lines.findIndex((line, index) => index > top && line.includes('└'))
  assert.ok(top >= 0 && bottom > top, 'provider dialog border is incomplete')
  const footer = lines.slice(bottom + 1).map((line, index) => ({ line, row: bottom + 1 + index })).filter(item => item.line.trim())
  assert.ok(footer.length > 0 && footer.at(-1).row === lines.length - 1, 'provider shortcuts must reach the screen bottom')
  assert.ok(footer.every((item, index) => !item.line.includes('│') && item.row === lines.length - footer.length + index),
    'provider shortcuts must be consecutive footer rows outside the dialog')
  const hint = footer.map(item => item.line).join(' ')
  assert.ok(hint.includes('Enter') && hint.includes('Esc'), 'provider shortcut footer is incomplete')
  const normalizedFooter = footer.map(item => item.line.trim().replace(/\s+/gu, ' '))
  const actions = normalizedFooter.join(' ').match(/(?:↑↓(?:\/jk)?|j\/k|Enter|Esc(?: \/ q)?) (?:选择|确认|打开|返回|取消)/gu) ?? []
  assert.ok(actions.every(action => normalizedFooter.some(line => line.includes(action))), 'provider shortcut action was split across footer lines')
  const panel = lines.slice(top, bottom + 1)
  assert.ok(panel.length <= Math.min(24, lines.length - footer.length), 'provider dialog exceeds its height limit')
  assert.ok(!panel.some(line => /(?:Enter|Esc|↑↓)/u.test(line)), 'provider shortcut hint is still inside the dialog')
  assert.ok(!panel.some(line => /搜索并选择 DSH 提供的服务。|仅影响新建会话。|仅用于本次连接测试。/u.test(line)),
    'provider dialog retained a redundant subtitle')
  return { panelTop: top, panelBottom: bottom, panelHeight: panel.length, footerRows: footer.map(item => item.row) }
}

function settingsTextCells(terminal, row, text) {
  const start = screenLines(terminal)[row].indexOf(text)
  const end = start + text.length
  const cells = []
  let offset = 0
  const line = terminal.buffer.active.getLine(row)
  for (let column = 0; column < terminal.cols; column += 1) {
    const cell = line.getCell(column)
    const chars = cell.getChars()
    if (chars && offset < end && offset + chars.length > start) cells.push(cell)
    offset += chars.length || (cell.getWidth() > 0 ? 1 : 0)
  }
  return cells
}

export function settingsProviderBadgeStyle(terminal, label, badge) {
  const lines = screenLines(terminal)
  const row = lines.findIndex(line => settingsDialogContent(line)?.includes(label) && line.includes(badge))
  assert.ok(row >= 0, `provider ${label} omitted its ${badge} status badge`)
  const cells = settingsTextCells(terminal, row, badge)
  assert.ok(cells.length > 0, 'provider badge has no visible cells')
  assert.ok(cells.every(cell => !cell.isFgDefault() && !cell.isUnderline() && !cell.isInverse()),
    'provider badge lacks its own color or inherited cursor styling')
  const styles = cells.map(cell => [cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(), Boolean(cell.isBold())])
  assert.ok(styles.every(style => JSON.stringify(style) === JSON.stringify(styles[0])), 'provider badge color is inconsistent')
  return styles[0]
}

export function assertSettingsManageForm(lines) {
  const groups = ['连接配置', '连接测试', '更多操作'].map(label => lines.findIndex(line => settingsDialogContent(line)?.includes(label)))
  assert.ok(groups.every(row => row >= 0) && groups[0] < groups[1] && groups[1] < groups[2], 'provider management form omitted or reordered its three sections')
  for (const label of ['显示名称', '服务地址']) {
    const row = lines.find(line => settingsDialogContent(line)?.includes(label))
    assert.ok(row?.includes('✎'), `provider ${label} is not rendered as an editable field`)
  }
  assert.ok(lines.some(line => line.includes('测试模型') && line.includes('▾')), 'test model is not rendered as a select control')
  assert.ok(!/\[\s*测试连接\s*\]/u.test(lines.join('\n')), 'provider buttons must use color blocks')
  const buttons = lines.join('\n').match(/测试连接/gu) ?? []
  assert.equal(buttons.length, 1, 'provider management must have exactly one explicit test button')
  return { groups }
}

export function assertSettingsTestFeedback(terminal, { state, title }, color = true) {
  const lines = screenLines(terminal)
  const buttonRow = lines.findIndex(line => settingsDialogContent(line)?.trim().replace(/^›\s*/u, '') === '测试连接')
  const feedbackRow = lines.findIndex(line => settingsDialogContent(line)?.includes(title))
  assert.ok(buttonRow >= 0 && feedbackRow > buttonRow && feedbackRow <= buttonRow + 2,
    'test feedback must remain next to the button in the management form')
  const titles = ['正在测试连接…', '连接成功', '服务已响应，输出受限', '连接测试失败', '测试已取消']
  assert.deepEqual(titles.filter(value => lines.some(line => line.includes(value))), [title], 'test feedback retained a stale or ambiguous state')
  if (state === 'cancelled') assert.equal(title, '测试已取消', 'cancellation must identify the connection test')
  const cells = settingsTextCells(terminal, feedbackRow, title)
  assert.ok(cells.length > 0, 'test feedback title has no cells')
  if (color && (state === 'success' || state === 'error')) {
    assert.ok(cells.every(cell => {
      if (!cell.isFgRGB() || cell.isUnderline() || cell.isInverse()) return false
      const rgb = cell.getFgColor(), red = rgb >> 16 & 255, green = rgb >> 8 & 255, blue = rgb & 255
      return state === 'success' ? green > red && green > blue : red > green && red > blue
    }), state === 'success' ? 'test success title is not green' : 'test failure title is not red')
  }
  return { state, title, buttonRow, feedbackRow, foregrounds: [...new Set(cells.map(cell => cell.getFgColor()))] }
}

async function settingsSessionFiles(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  const paths = (await listFiles(root)).sort()
  return await Promise.all(paths.map(async path => ({
    path,
    sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
  })))
}

export function settingsViewportReady(state, columns, rows, frameBaseline) {
  if (state.pendingTerminalWrites !== 0 || state.synchronizedUpdate
    || state.completedFrames <= frameBaseline || state.terminal.cols !== columns
    || state.terminal.rows !== rows) return false
  const lines = screenLines(state.terminal)
  const fieldRow = settingsFieldRow(lines, '主题')
  if (fieldRow < 0) return false
  const line = state.terminal.buffer.active.getLine(fieldRow)
  const compact = rows < 10
  const wide = columns >= 100 && !compact
  const contentWidth = wide ? columns - 23 : columns
  const fieldWidth = compact ? columns : contentWidth - 6
  const controlWidth = Math.min(Math.max(14, Math.ceil(fieldWidth * 0.39)), Math.max(14, fieldWidth - 13))
  const controlColumn = (compact ? 0 : wide ? 26 : 3) + fieldWidth - controlWidth
  const panelColumn = wide ? 24 : 1
  const panelEnd = wide ? contentWidth + 21 : columns - 2
  const panelTop = state.terminal.buffer.active.getLine(fieldRow - 1)
  // Borders and the right-hand control are visible geometry even when ConPTY
  // converts ordinary background padding to EL. Never accept just a new header.
  return Boolean(line?.getCell(controlColumn + 2)?.getChars() === '自'
    && line?.getCell(controlColumn + controlWidth - 2)?.getChars() === '▾'
    && settingsFieldValue(lines, '主题', '自动') && lines[0]?.startsWith('DSH 设置')
    && lines[0]?.includes('q / Esc back') && lines.at(-1)?.includes('Ctrl+S')
    && (compact ? fieldRow === 2 : lines[1]?.trimEnd() === '─'.repeat(columns)
      && panelTop?.getCell(panelColumn)?.getChars() === '┌'
      && panelTop?.getCell(panelEnd)?.getChars() === '┐'
      && line?.getCell(panelEnd)?.getChars() === '│'
      && [wide ? '› 通用' : '▸通用', '模型', '插件', 'Agent 预设'].every(label => lines.some(text => text.includes(label)))))
}

async function assertSettingsResizeMatrix(state, modelRequests, timeoutMilliseconds) {
  const requestBaseline = modelRequests()
  const resize = async (columns, rows) => {
    const frameBaseline = state.completedFrames
    state.terminal.resize(columns, rows)
    state.pty.resize(columns, rows)
    const lines = await waitForScreen(state,
      () => settingsViewportReady(state, columns, rows, frameBaseline),
      `Settings form resized to ${columns}x${rows}`, timeoutMilliseconds, 75)
    assert.equal(modelRequests(), requestBaseline, 'Settings form resize invoked the model')
    return lines
  }
  for (const [columns, rows] of WORKSPACE_RESIZE_SIZES) {
    const lines = await resize(columns, rows)
    workspaceResizeEvidence.push({ page: 'settings-form', columns, rows, modelRequestDelta: 0,
      completedFrames: state.completedFrames, paintedWidths: workspacePaintedWidths(state.terminal),
      geometryAnchors: lines.flatMap((text, row) => row === settingsFieldRow(lines, '主题') || text.includes('┌') || text.trimEnd() === '─'.repeat(columns) ? [row] : []),
      bodyLayout: rows < 10 ? 'compact-field+right-control' : columns >= 100 ? 'sidebar+field-panel+right-control' : 'categories+field-panel+right-control', stableMilliseconds: 75, lines })
  }
  await resize(RESIZED_COLUMNS, RESIZED_ROWS)
}

async function assertSettingsForm(state, { dshHome, harnessRoot, sessionId, modelRequests, timeoutMilliseconds }) {
  const baseline = modelRequests()
  const settingsPath = join(dshHome, 'settings.yaml')
  const { parse } = createRequire(join(harnessRoot, 'packages', 'settings', 'settings-file', 'package.json'))('yaml')
  const documentText = async () => {
    try { return await readFile(settingsPath, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') return ''
      throw error
    }
  }
  const themeValue = async () => parse(await documentText())?.['dsh-tui']?.theme?.preset
  const themeIs = (lines, value) => settingsFieldValue(lines, '主题', value)
  const waitTheme = value => waitForScreen(state, lines => themeIs(lines, value),
    `Settings theme ${value}`, timeoutMilliseconds, 75)
  const search = async (_query, label) => {
    for (let step = 0; step < 160; step++) {
      const lines = screenLines(state.terminal)
      const row = settingsFieldRow(lines, label)
      if (row >= 0) {
        const line = state.terminal.buffer.active.getLine(row)
        if (Array.from({ length: state.terminal.cols }, (_, column) => line?.getCell(column)?.isUnderline()).some(Boolean)) return
      }
      const before = state.completedFrames
      state.pty.write('\x1b[B')
      await waitForScreen(state, () => state.completedFrames > before, 'Settings field navigation', timeoutMilliseconds, 75)
    }
    throw new Error('Settings field focus unavailable: ' + label)
  }
  const open = async () => {
    state.pty.write('/settings')
    await waitForScreen(state, lines => commandSearchLineVisible(lines, '/settings'), 'Settings reopen command', timeoutMilliseconds)
    state.pty.write('\r')
    await waitForScreen(state, (lines, text) => lines[0]?.startsWith('DSH 设置') && text.includes('重置设置'),
      'Settings form reopened', timeoutMilliseconds)
  }
  const waitPicker = option => waitForScreen(state, lines => settingsPickerSelected(lines, '主题', option),
    `Settings theme picker selected ${option}`, timeoutMilliseconds, 75)
  const initial = await waitForScreen(state, (lines, text) => lines[0]?.startsWith('DSH 设置')
    && ['› 通用', '模型', '插件', 'Agent 预设', '重置设置'].every(label => text.includes(label))
    && !text.includes('Namespace  ') && !text.includes('Revision  '),
  'Settings task-oriented form', timeoutMilliseconds, 75)
  await search('主题', '主题')
  await waitTheme('自动')
  await assertSettingsResizeMatrix(state, modelRequests, timeoutMilliseconds)
  const initialDocument = await documentText()
  state.pty.write('q')
  const quit = await waitForScreen(state, (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`),
    'Settings q closes a clean form', timeoutMilliseconds)
  assert.ok(await documentText() === initialDocument, 'quitting clean Settings changed the user document')
  await open()
  const searchInput = initial
  await search('主题', '主题')
  state.pty.write('\r')
  const picker = await waitPicker('自动')
  navigationEvidence.push(await measureNavigationSequence(state, Array.from({ length: 6 }, () => [
    { input: '\x1b[B', expected: 'Cordis', matches: lines => settingsPickerSelected(lines, '主题', 'Cordis') },
    { input: 'j', expected: '单色', matches: lines => settingsPickerSelected(lines, '主题', '单色') },
    { input: '\x1b[A', expected: 'Cordis', matches: lines => settingsPickerSelected(lines, '主题', 'Cordis') },
    { input: 'k', expected: '自动', matches: lines => settingsPickerSelected(lines, '主题', '自动') },
  ]).flat(), 'settings-theme-picker-arrows-jk', timeoutMilliseconds))
  state.pty.write('\x1b[B')
  await waitPicker('Cordis')
  state.pty.write('\x1b[B')
  await waitPicker('单色')
  assert.ok(await documentText() === initialDocument, 'moving in the Settings picker changed the user document')
  state.pty.write('\r')
  await waitTheme('单色')
  state.pty.write('\x13')
  const saved = await waitForScreen(state, (lines, text) => themeIs(lines, '单色') && text.includes('设置已保存'),
    'Settings mono persisted', timeoutMilliseconds, 75)
  await waitForCondition(async () => await themeValue() === 'mono', timeoutMilliseconds, 'official settings document mono value')
  const monoDocument = await documentText()
  state.pty.write('\r')
  await waitPicker('单色')
  state.pty.write('\x1b[A')
  await waitPicker('Cordis')
  state.pty.write('\x1b[A')
  await waitPicker('自动')
  state.pty.write('q')
  const pickerCanceled = await waitForScreen(state, (lines, text) => themeIs(lines, '单色')
    && !/(?:↑↓(?:\/jk)?|j\/k)\s+选择/u.test(text), 'Settings q cancels the picker without changing its saved value', timeoutMilliseconds, 75)
  assert.ok(await documentText() === monoDocument, 'canceling a Settings picker changed the user document')
  state.pty.write('\r')
  await waitPicker('单色')
  state.pty.write('\x1b[A')
  await waitPicker('Cordis')
  state.pty.write('\x1b')
  await waitTheme('单色')
  state.pty.write('\x1b[D')
  await waitTheme('Cordis')
  state.pty.write('\x1b[D')
  await waitTheme('自动')
  state.pty.write('q')
  const discard = await waitForScreen(state, (_lines, text) => text.includes('放弃未保存的更改？') && text.includes('放弃更改'),
    'Settings q protects an unsaved departure', timeoutMilliseconds, 75)
  state.pty.write('q')
  await waitForScreen(state, (lines, text) => themeIs(lines, '自动') && text.includes('1 项更改未保存')
    && !text.includes('放弃未保存的更改？'), 'Settings q cancels discard without losing the draft', timeoutMilliseconds, 75)
  state.pty.write('q')
  await waitForScreen(state, (_lines, text) => text.includes('放弃未保存的更改？'),
    'Settings dirty q asks again before discard', timeoutMilliseconds)
  state.pty.write('\x1b[C\r')
  await waitForScreen(state, (_lines, text) => text.includes('已放弃更改'), 'Settings discard remains visible', timeoutMilliseconds)
  state.pty.write('q')
  await waitForScreen(state, (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`),
    'Settings discarded draft returns to Chat', timeoutMilliseconds)
  assert.ok(await documentText() === monoDocument, 'discarding a Settings draft changed the user document')
  await open()
  await search('主题', '主题')
  await waitTheme('单色')
  state.pty.write('\x1b[D')
  await waitTheme('Cordis')
  state.pty.write('\x1b[D')
  await waitTheme('自动')
  state.pty.write('\x13')
  const restored = await waitForScreen(state, (lines, text) => themeIs(lines, '自动') && text.includes('设置已保存'),
    'Settings original theme restored', timeoutMilliseconds, 75)
  await waitForCondition(async () => await themeValue() === 'auto', timeoutMilliseconds, 'official settings document auto restoration')
  const restoredDocument = await documentText()

  state.pty.write(']')
  const models = await waitForScreen(state, (_lines, text) => text.includes('› 模型与服务') && text.includes('DeepSeek'),
    'Settings model provider category', timeoutMilliseconds, 75)
  assert.ok(!/supportsStore|supportsDeveloperRole|\bcompat\b/u.test(models.join('\n')),
    'Settings models home exposed protocol compatibility fields')
  state.pty.write(']')
  await waitForScreen(state, (_lines, text) => text.includes('› 插件'), 'Settings plugin category', timeoutMilliseconds)
  await search('命令超时', '命令超时（毫秒）')
  state.pty.write('\r')
  await waitForScreen(state, (_lines, text) => text.includes('编辑：命令超时（毫秒）'),
    'Settings typed numeric editor', timeoutMilliseconds)
  state.pty.write('\x7f'.repeat(40) + 'not-a-number')
  await waitForScreen(state, (_lines, text) => text.includes('not-a-number'), 'Settings invalid numeric input', timeoutMilliseconds)
  state.pty.write('q')
  const editorInput = await waitForScreen(state, (_lines, text) => text.includes('编辑：命令超时（毫秒）')
    && text.includes('not-a-numberq'), 'Settings q stays in the field editor', timeoutMilliseconds, 75)
  state.pty.write('\r')
  const invalid = await waitForScreen(state, (_lines, text) => text.includes('请输入有限数字。')
    && text.includes('not-a-numberq'), 'Settings numeric validation preserves editor', timeoutMilliseconds, 75)
  assert.ok(await documentText() === restoredDocument, 'invalid numeric Settings input changed the document')
  state.pty.write('\x1b')
  await waitForScreen(state, (_lines, text) => !text.includes('编辑：') && text.includes('命令超时（毫秒）'),
    'Settings invalid edit cancelled', timeoutMilliseconds)
  state.pty.write(']')
  const presets = await waitForScreen(state, (_lines, text) => text.includes('› Agent 预设') && text.includes('默认 Agent 预设'),
    'Settings default Agent preset category', timeoutMilliseconds, 75)
  state.pty.write(']')
  await waitForScreen(state, (_lines, text) => text.includes('› 通用') && text.includes('重置设置'),
    'Settings four-category cycle completed', timeoutMilliseconds)
  await search('默认权限', '默认权限')
  for (const value of ['workspace-write', 'danger-full-access']) {
    state.pty.write('\x1b[C')
    await waitForScreen(state, lines => settingsFieldValue(lines, '默认权限', value),
      `Settings new-session permission ${value} staged`, timeoutMilliseconds, 75)
  }
  state.pty.write('\x13')
  const permission = await waitForScreen(state, (_lines, text) => text.includes('新会话可访问工作目录外的文件并运行命令。')
    && text.includes('确认保存') && text.includes('取消'), 'Settings explicit full-access warning', timeoutMilliseconds, 75)
  assert.ok(await documentText() === restoredDocument, 'a Settings permission preview wrote without confirmation')
  state.pty.write('\x1b')
  await waitForScreen(state, (_lines, text) => text.includes('1 项更改未保存') && !text.includes('确认保存'),
    'Settings permission cancellation retains draft', timeoutMilliseconds)
  state.pty.write('\x1b')
  await waitForScreen(state, (_lines, text) => text.includes('放弃未保存的更改？'), 'Settings permission draft discard confirmation', timeoutMilliseconds)
  state.pty.write('\x1b[C\r')
  await waitForScreen(state, (_lines, text) => text.includes('已放弃更改'), 'Settings permission discarded in place', timeoutMilliseconds, 75)
  state.pty.write('q')
  await waitForScreen(state, (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`),
    'Settings uncommitted permission discarded', timeoutMilliseconds)
  await open()
  assert.equal(modelRequests(), baseline, 'Settings form interactions invoked the model')
  assert.ok(await documentText() === restoredDocument, 'Settings read-only category browsing changed the document')
  interactionEvidence.push({ case: 'settings-form-save-cancel-validation', initial, quit, searchInput, editorInput, picker, pickerCanceled, saved, discard, restored, models, invalid, presets, permission,
    document: { namespace: 'dsh-tui', path: ['theme', 'preset'], saved: 'mono', restored: 'auto', cancelUnchanged: true, invalidUnchanged: true, permissionUnchanged: true }, modelRequestDelta: 0 })
}

async function assertSettingsProviderDialog(state, { dshHome, providers, modelRequests, testRequests, testResults, prepareTest, timeoutMilliseconds }) {
  const baseline = modelRequests()
  assert.equal(baseline, 0, 'Settings browsing invoked the model before the explicit provider test')
  const testBaseline = testRequests().length
  const sessionsBefore = await settingsSessionFiles(dshHome)
  const documentBefore = await readFile(join(dshHome, 'settings.yaml'), 'utf8')
  state.pty.write(']')
  const home = await waitForScreen(state, (_lines, text) => text.includes('新会话默认模型')
    && text.includes('添加提供商') && text.includes('openai'), 'Settings provider home', timeoutMilliseconds, 75)
  assert.ok(!/supportsStore|supportsDeveloperRole|\bcompat\b/u.test(home.join('\n')),
    'Settings models home exposed protocol compatibility fields')
  assert.equal(modelRequests(), baseline, 'opening Settings models invoked the model')

  state.pty.write('\r')
  let defaults = await waitForScreen(state, lines => lines.some(line => settingsDialogContent(line)?.trim() === '新会话默认模型'),
    'Settings grouped default model picker', timeoutMilliseconds, 75)
  assertSettingsDialogChrome(defaults, '新会话默认模型')
  const openai = providers.find(provider => provider.id === 'openai')
  assert.ok(openai, 'official directory omitted the exact OpenAI fixture provider')
  defaults = await moveSelectionTo(state, 'DSH-TUI OpenAI E2E', 'Settings default model reaches OpenAI fixture group', timeoutMilliseconds)
  assertSettingsModelGroup(defaults, openai.name, 'DSH-TUI OpenAI E2E')
  assert.ok(settingsProviderDialogSelected(defaults, '新会话默认模型', 'DSH-TUI OpenAI E2E', openai.name),
    'default model picker confused the model name with another provider group')
  assert.equal(defaults.join('\n').includes(OPENAI_MODEL), false, 'default model picker repeated a redundant model ID')
  state.pty.write('\x1b')
  await waitForScreen(state, (lines, text) => lines[0]?.startsWith('DSH 设置') && text.includes('添加提供商'),
    'Settings default model picker cancelled without writing', timeoutMilliseconds, 75)

  state.pty.write('n')
  const directoryTop = await waitForScreen(state, lines => lines.some(line => settingsDialogContent(line)?.trim() === '添加提供商'),
    'Settings bounded provider directory', timeoutMilliseconds, 75)
  const directoryGeometry = assertSettingsDialogChrome(directoryTop, '添加提供商')
  assert.ok(providers.length >= 38, 'long-list acceptance requires at least 38 official providers')
  const visibleProviders = lines => providers.filter(provider => lines.some(line => {
    const content = settingsDialogContent(line)?.trim().replace(/^[›→]\s*/u, '')
    return content?.startsWith(provider.name + ' ') || content === provider.name
  }))
  assert.ok(visibleProviders(directoryTop).length <= 18 && visibleProviders(directoryTop).length < providers.length,
    'provider directory expanded every provider instead of a bounded list')
  const directoryFocusBaseline = state.completedFrames
  state.pty.write('\t')
  await waitForScreen(state, lines => state.completedFrames > directoryFocusBaseline
    && settingsProviderDialogSelected(lines, '添加提供商', providers[0].name), 'provider directory list focus', timeoutMilliseconds)
  state.pty.write('\x1b[B'.repeat(3))
  await waitForScreen(state, lines => settingsProviderDialogSelected(lines, '添加提供商', providers[3].name),
    'provider navigation benchmark start', timeoutMilliseconds)
  const directoryStep = (input, index, inputEvents) => ({ input, inputEvents, expected: providers[index].id,
    matches: lines => settingsProviderDialogSelected(lines, '添加提供商', providers[index].name) })
  navigationEvidence.push(await measureNavigationSequence(state, Array.from({ length: 6 }, () => [
    directoryStep('\x1b[B'.repeat(3), 6, 3), directoryStep('kk', 4, 2),
    directoryStep('\x1b[B', 5, 1), directoryStep('\x1b[A'.repeat(2), 3, 2),
  ]).flat(), 'provider-directory-arrows-jk-bursts', timeoutMilliseconds))
  state.pty.write('\x1b[A'.repeat(3))
  await waitForScreen(state, lines => settingsProviderDialogSelected(lines, '添加提供商', providers[0].name),
    'provider navigation benchmark restored selection', timeoutMilliseconds)
  let directoryBottom = directoryTop
  for (let index = 0; index < providers.length; index += 1) {
    directoryBottom = await moveSelection(state, '\x1b[B', `Settings provider directory scroll ${index + 1}/${providers.length}`, timeoutMilliseconds)
    assertSettingsDialogChrome(directoryBottom, '添加提供商')
    assert.ok(visibleProviders(directoryBottom).length <= 18, 'provider scroll exceeded its list height budget')
  }
  assert.ok(settingsProviderDialogSelected(directoryBottom, '添加提供商', '自定义兼容服务'), 'provider list tail is not selectable')
  assert.ok(visibleProviders(directoryBottom).some(provider => provider.id === providers.at(-1).id), 'provider list lost its final official entry')
  state.pty.write('\r')
  const custom = await waitForScreen(state, (_lines, text) => text.includes('自定义兼容服务') && text.includes('添加并配置凭据'),
    'Settings provider list tail opens custom service', timeoutMilliseconds, 75)
  assert.ok(custom[0]?.includes('自定义兼容服务') && !/\[\s*添加并配置凭据\s*\]/u.test(custom.join('\n')), 'custom provider must use the shared settings form')
  assert.ok(custom.join('\n').includes('OpenAI 兼容服务'), 'custom service exposes a raw API identifier')
  assert.ok(!custom.join('\n').includes('重置设置'), 'custom creation exposed an unrelated reset action')
  state.pty.write('\x1b')
  await waitForScreen(state, lines => lines[0]?.startsWith('DSH 设置'), 'Settings unmodified custom service cancelled', timeoutMilliseconds, 75)

  state.pty.write('n')
  await waitForScreen(state, lines => lines.some(line => line.includes('│') && line.includes('添加提供商')),
    'Settings add-provider directory', timeoutMilliseconds, 75)
  state.pty.write('openai')
  let directory = await waitForScreen(state, lines => selectedScreenLine(lines)?.includes('openai') === true,
    'Settings filtered provider directory', timeoutMilliseconds, 75)
  for (let step = 0; !settingsProviderDialogSelected(directory, '添加提供商', 'openai') && step < 16; step += 1) {
    directory = await moveSelection(state, '\x1b[B', 'Settings exact OpenAI fixture provider', timeoutMilliseconds)
  }
  assert.ok(settingsProviderDialogSelected(directory, '添加提供商', 'openai'), 'provider directory did not select the exact local fixture route')
  assertSettingsDialogChrome(directory, '添加提供商')
  const selectedBadge = settingsProviderBadgeStyle(state.terminal, openai.name, '已配置')
  const unfocusedDirectory = await moveSelection(state, '\x1b[B', 'Settings configured status outside the cursor row', timeoutMilliseconds)
  assert.ok(!settingsProviderDialogSelected(unfocusedDirectory, '添加提供商', openai.name), 'configured badge check did not move the cursor')
  const unfocusedBadge = settingsProviderBadgeStyle(state.terminal, openai.name, '已配置')
  assert.deepEqual(unfocusedBadge, selectedBadge, 'configured provider badge changed with the cursor')
  directory = await moveSelection(state, '\x1b[A', 'Settings restore exact OpenAI fixture provider', timeoutMilliseconds)
  assert.ok(settingsProviderDialogSelected(directory, '添加提供商', openai.name))
  assert.equal(modelRequests(), baseline, 'opening or filtering the provider directory invoked the model')
  state.pty.write('\r')
  const manage = await waitForScreen(state, (lines, text) => text.includes('openai') && text.includes('测试连接')
    && lines.some(line => line.includes('API 密钥') && line.includes('已配置')), 'Settings provider configuration dialog', timeoutMilliseconds, 75)
  assertSettingsManageForm(manage)
  assert.ok(manage[0]?.includes(' · 管理'), 'management must have its own page title')
  assert.ok(!/DSH 设置|Agent 预设|重置设置/u.test(manage.join('\n')), 'management retained parent settings chrome')
  const selectedFormLine = lines => lines.find((line, row) => settingsDialogContent(line)?.includes('›') || Array.from({ length: state.terminal.cols }, (_, col) => state.terminal.buffer.active.getLine(row)?.getCell(col)?.isUnderline()).some(Boolean))
  state.pty.write('\x1b[B')
  await waitForScreen(state, lines => selectedFormLine(lines)?.includes('显示名称') === true,
    'provider form navigation benchmark start', timeoutMilliseconds)
  const managementStep = (input, expected, inputEvents) => ({ input, expected, inputEvents,
    matches: lines => selectedFormLine(lines)?.includes(expected) === true })
  navigationEvidence.push(await measureNavigationSequence(state, Array.from({ length: 6 }, () => [
    managementStep('\x1b[B'.repeat(3), '测试连接', 3), managementStep('k', '测试模型', 1),
    managementStep('j', '测试连接', 1), managementStep('\x1b[A'.repeat(3), '显示名称', 3),
  ]).flat(), 'provider-manage-arrows-jk-bursts', timeoutMilliseconds))
  state.pty.write('\x1b[A')
  await waitForScreen(state, lines => lines.some(line => line.includes('│') && line.includes('API 密钥') && line.includes('›')),
    'provider form navigation benchmark restored selection', timeoutMilliseconds)
  state.pty.write('m')
  const models = await waitForScreen(state, lines => settingsProviderDialogSelected(lines, '选择测试模型', 'DSH-TUI OpenAI E2E'),
    'Settings isolated fixture model selector', timeoutMilliseconds, 75)
  assertSettingsDialogChrome(models, '选择测试模型')
  assert.equal(countOccurrences(models.join('\n'), 'DSH-TUI OpenAI E2E'), 1, 'provider model selector repeated the fixture model name')
  assert.equal(models.join('\n').includes(OPENAI_MODEL), false, 'provider model selector repeated a redundant model ID')
  state.pty.write('\r')
  await waitForScreen(state, (_lines, text) => text.includes('测试连接') && text.includes('DSH-TUI OpenAI E2E'),
    'Settings selected test model', timeoutMilliseconds, 75)
  assert.equal(modelRequests(), baseline, 'provider configuration or model selection invoked the model')
  assert.equal(testRequests().length, testBaseline, 'provider test started without an explicit action')

  const testStates = []
  for (const [index, scenario] of [
    { outcome: 'success', state: 'success', title: '连接成功' },
    { outcome: 'failure', state: 'error', title: '连接测试失败' },
    { outcome: 'success', state: 'cancelled', title: '测试已取消' },
  ].entries()) {
    const planned = prepareTest(scenario.outcome)
    state.pty.write('t')
    const running = await waitForScreen(state, (_lines, text) => text.includes('正在测试连接…') && text.includes('测试连接'),
      `Settings provider test ${index + 1} runs inside management`, timeoutMilliseconds)
    assertSettingsTestFeedback(state.terminal, { state: 'running', title: '正在测试连接…' })
    const request = await withDeadline(planned.request, timeoutMilliseconds, `provider test ${index + 1} request`)
    assert.ok(isProviderTestRequest(request), 'provider test sent history or an unexpected prompt')
    assert.equal(request.model, OPENAI_MODEL, 'name-only model picker lost the exact fixture model identity')
    assert.equal(testRequests().length, testBaseline + index + 1, 'one explicit test did not make exactly one test request')
    assert.equal(modelRequests(), baseline + index + 1, 'provider test triggered another model request')
    if (scenario.state === 'cancelled') state.pty.write('\x1b')
    else planned.release()
    const result = await waitForScreen(state, (_lines, text) => text.includes(scenario.title) && text.includes('测试连接'),
      `Settings explicit provider test ${scenario.state}`, timeoutMilliseconds, 75)
    const feedback = assertSettingsTestFeedback(state.terminal, scenario)
    await withDeadline(planned.closed, timeoutMilliseconds, `provider test ${index + 1} response closed`)
    if (scenario.state === 'cancelled') {
      planned.release()
      await waitForScreen(state, (_lines, text) => text.includes('测试已取消') && !text.includes('连接成功'),
        'cancelled provider test cannot publish a late success', timeoutMilliseconds, 75)
    }
    assert.equal(testRequests().length, testBaseline + index + 1, 'provider result or cancellation invoked another request')
    assert.equal(modelRequests(), baseline + index + 1, 'provider result triggered another model request')
    assert.deepEqual(await settingsSessionFiles(dshHome), sessionsBefore, 'provider test created or modified a persisted Session file')
    assert.equal(await readFile(join(dshHome, 'settings.yaml'), 'utf8'), documentBefore, 'provider model testing modified saved settings')
    testStates.push({ state: scenario.state, running, result, feedback, requestDelta: 1 })
  }
  assert.deepEqual(testResults().slice(testBaseline).map(result => result.outcome), ['success', 'failure', 'cancelled'])

  state.pty.write('q')
  const returned = await waitForScreen(state, (lines, text) => lines[0]?.startsWith('DSH 设置')
    && text.includes('新会话默认模型') && !text.includes('测试连接'), 'Settings provider q returns to models home', timeoutMilliseconds, 75)
  state.pty.write('[')
  await waitForScreen(state, (_lines, text) => text.includes('› 通用') && text.includes('重置设置'),
    'Settings provider acceptance restores general settings', timeoutMilliseconds, 75)
  assert.equal(modelRequests(), baseline + 3, 'leaving the provider dialog invoked another model request')
  interactionEvidence.push({ case: 'settings-provider-dialog-explicit-test', home, defaults, directoryTop, directoryBottom, custom,
    directory, unfocusedDirectory, manage, models, testStates, returned, directoryGeometry, directoryCount: providers.length,
    selectedBadge, unfocusedBadge, groupedModelNames: true, separateBottomShortcuts: true, boundedListTailSelectable: true,
    fixture: { provider: 'openai', model: OPENAI_MODEL }, browseModelRequestDelta: 0, testModelRequestDelta: 3,
    prompt: PROVIDER_TEST_PROMPT, sessionFilesUnchanged: true, settingsDocumentUnchanged: true })
}

function formWorkspacePageReady(state, columns, rows, frameBaseline, caption, labels) {
  if (state.pendingTerminalWrites !== 0 || state.synchronizedUpdate
    || state.completedFrames <= frameBaseline || state.terminal.cols !== columns
    || state.terminal.rows !== rows) return false
  const lines = screenLines(state.terminal)
  const compact = rows < 10
  // Like the Settings form gate, anchor real geometry through the full-width
  // header border instead of painted widths: ConPTY may erase trailing padding.
  return lines[0]?.trim().startsWith(caption)
    && lines[0]?.includes('q / Esc back')
    && lines.at(-1)?.includes('q back')
    && (compact || lines[1]?.trimEnd() === '─'.repeat(columns))
    && (compact || labels.every(label => lines.some(text => text.includes(label))))
    && (!compact || lines.slice(1, -1).some(text => text.trim() !== ''))
}

export function capabilitiesViewportReady(state, header, columns, rows, frameBaseline) {
  return formWorkspacePageReady(state, columns, rows, frameBaseline, 'Capabilities', ['Skills', 'Tools', 'MCP'])
}

export function activityViewportReady(state, header, columns, rows, frameBaseline) {
  return formWorkspacePageReady(state, columns, rows, frameBaseline, 'Activity', ['Jobs', 'Subagents', 'Workflows'])
}

export function sessionsViewportReady(state, header, columns, rows, frameBaseline) {
  return formWorkspacePageReady(state, columns, rows, frameBaseline, 'Sessions', ['Sessions'])
}

export function modelsViewportReady(state, header, columns, rows, frameBaseline) {
  return formWorkspacePageReady(state, columns, rows, frameBaseline, 'Models', ['Models'])
}

export function modesViewportReady(state, header, columns, rows, frameBaseline) {
  return formWorkspacePageReady(state, columns, rows, frameBaseline, 'Modes', ['Modes'])
}

async function assertWorkspaceResizeMatrix(state, page, modelRequests, timeoutMilliseconds, ready = workspaceViewportReady) {
  const header = screenLines(state.terminal)[0].trim()
  const requestBaseline = modelRequests()
  const resize = async (columns, rows) => {
    const frameBaseline = state.completedFrames
    state.terminal.resize(columns, rows)
    state.pty.resize(columns, rows)
    const lines = await waitForScreen(
      state,
      (_lines, text) => ready(state, header, columns, rows, frameBaseline),
      `${page} Workspace resized to ${columns}x${rows}`,
      timeoutMilliseconds,
      // ConPTY can paint text after forwarding DEC 2026 end, and the Feature
      // layout reconciles asynchronously. Require correct geometry first, then
      // an unchanged cell image and byte count; any output restarts this window.
      75,
    )
    assert.equal(modelRequests(), requestBaseline, `${page} resize unexpectedly invoked the model`)
    return lines
  }
  // Modes starts in a separate 80x24 process; enter the same baseline before
  // requiring a real resize write for every matrix entry, including 80x24.
  if (state.terminal.cols !== RESIZED_COLUMNS || state.terminal.rows !== RESIZED_ROWS) {
    await resize(RESIZED_COLUMNS, RESIZED_ROWS)
  }
  for (const [columns, rows] of WORKSPACE_RESIZE_SIZES) {
    const lines = await resize(columns, rows)
    workspaceResizeEvidence.push({ page, columns, rows, modelRequestDelta: modelRequests() - requestBaseline,
      completedFrames: state.completedFrames, paintedWidths: workspacePaintedWidths(state.terminal),
      geometryAnchors: workspaceGeometryAnchors(state.terminal), stableMilliseconds: 75, lines })
  }
  await resize(RESIZED_COLUMNS, RESIZED_ROWS)
}

export function composerPromptLines(lines) {
  // The prompt box is directly above the statusline. Earlier transcript cards
  // can contain identical text and borders, so never search them for input echo.
  const bottom = lines.length - 2
  if (!/^╰─+╯\s*$/u.test(lines[bottom] ?? '')) return []
  let top = bottom - 1
  while (top >= 0 && /^│ .* │\s*$/u.test(lines[top])) top -= 1
  if (!/^╭─+╮\s*$/u.test(lines[top] ?? '')) return []
  return lines.slice(top + 1, bottom).map(line => line.trimEnd().slice(2, -2).trimEnd())
}

export function commandSearchLineVisible(lines, query) {
  return composerPromptLines(lines).includes(query === '' ? '>' : `> ${query}`)
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
    (lines, text) => lines[0]?.trim() === 'Permission Presets'
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
  { currentValue, targetValue, direction, steps, requiresConfirmation },
  timeoutMilliseconds,
) {
  await openPermissionControl(state, currentValue, timeoutMilliseconds)
  for (let step = 0; step < steps; step += 1) {
    await moveSelection(
      state,
      direction === 'up' ? '\x1b[A' : '\x1b[B',
      `official permission ${targetValue} navigation step ${step + 1}`,
      timeoutMilliseconds,
    )
  }
  await waitForScreen(
    state,
    (lines, text) => selectedScreenLine(lines) !== undefined
      && text.includes(`Target  ${targetValue}`),
    `official permission ${targetValue} candidate`,
    timeoutMilliseconds,
  )
  state.pty.write('\r')
  if (requiresConfirmation) {
    await waitForScreen(
      state,
      (_lines, text) => text.includes('▌ Session permissions')
        && text.includes(`Current  ${currentValue}`)
        && text.includes(`Target  ${targetValue}`)
        && text.includes('Confirm permission change · Default: Cancel')
        && text.includes('› Cancel · keep current permissions')
        && !text.includes(`Permission preset switched: ${targetValue}`),
      `official permission ${targetValue} defaults to Cancel`,
      timeoutMilliseconds,
    )
    state.pty.write('\x1b[C')
    await waitForScreen(
      state,
      (_lines, text) => text.includes('› Confirm change · apply official preset')
        && text.includes('Enter Confirm'),
      `official permission ${targetValue} explicit confirmation selection`,
      timeoutMilliseconds,
    )
    state.pty.write('\r')
  }
  await waitForScreen(
    state,
    (lines, text) => lines[0]?.trim() !== 'Permission Presets'
      && !text.includes('▌ Session permissions')
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

/**
 * Await the ConPTY exit record, recovering a process that demonstrably exited
 * at the OS level while node-pty's Windows agent dropped the exit event — a
 * fast failing boot writes nothing to the ConPTY output socket, which is the
 * exact shape that loses the event. The recovered record carries no exit code;
 * callers assert the product error evidence instead.
 */
async function waitForPtyExit(state, timeoutMilliseconds, label) {
  const deadline = Date.now() + timeoutMilliseconds
  while (true) {
    if (state.exited) return state.exitRecord
    if (!processExists(state.pty.pid)) {
      const delivered = await Promise.race([
        state.exitPromise.then(() => true),
        new Promise(resolve => { setTimeout(resolve, 1_000) }).then(() => false),
      ])
      if (delivered || state.exited) return state.exitRecord
      state.exited = true
      state.exitRecord = { exitCode: undefined, signal: undefined, recovered: true }
      return state.exitRecord
    }
    if (Date.now() >= deadline) throw new Error(`${label} exceeded ${timeoutMilliseconds} ms`)
    await new Promise(resolve => { setTimeout(resolve, 50) })
  }
}

async function moveSelection(state, key, description, timeoutMilliseconds) {
  const lines = await waitForScreen(state, rows => selectedScreenIdentity(rows) !== undefined,
    `${description} current selection`, timeoutMilliseconds)
  const previous = selectedScreenIdentity(lines)
  state.pty.write(key)
  return await waitForScreen(state, rows => {
    const next = selectedScreenIdentity(rows)
    return next !== undefined && next !== previous
  }, description, timeoutMilliseconds)
}

export async function moveSelectionTo(state, needle, description, timeoutMilliseconds, direction = 'down') {
  const deadline = Date.now() + timeoutMilliseconds
  for (let step = 0; step < 128; step += 1) {
    // FormWorkspace pages can show two selected rows at once (sidebar category +
    // content item, sometimes on one line), so match the needle row directly.
    const currentLines = await waitForScreen(state, lines => lines.some(line => line.includes('›')),
      `${description} current selection`, Math.max(1, deadline - Date.now()))
    if (currentLines.filter(line => line.includes('›') && line.includes(needle)).length === 1) return currentLines
    const currentSelection = selectedScreenLine(currentLines)
    if (currentSelection?.includes(needle) === true) return currentLines

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await moveSelection(
      state,
      direction === 'up' ? '\x1b[A' : '\x1b[B',
      `${description} navigation step ${step + 1}`,
      Math.min(remaining, 5_000),
    )
  }
  throw new Error(
    `DSH-TUI could not select ${description} (${needle})\n`
    + `screen:\n${outputExcerpt(screenText(state.terminal))}`,
  )
}

export function startPty(
  nodePty,
  Terminal,
  preloadPath,
  cliBin,
  workspace,
  env,
  appArgs = ['--cwd', workspace],
  { trueColor = false } = {},
) {
  const ptyEnvironment = { ...env }
  if (trueColor) {
    // NO_COLOR is presence-based, so an empty value would still disable color.
    delete ptyEnvironment.NO_COLOR
    ptyEnvironment.FORCE_COLOR = '3'
    ptyEnvironment.COLORTERM = 'truecolor'
  }
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
      env: ptyEnvironment,
    },
  )
  const state = {
    pty,
    terminal,
    events: new EventEmitter(),
    rawTail: '',
    rawBytes: 0,
    pendingTerminalWrites: 0,
    synchronizedUpdate: false,
    completedFrames: 0,
    callbackError: undefined,
    exited: false,
    exitRecord: undefined,
    ptyReleased: false,
    bufferTransitions,
    bufferSubscription,
  }
  state.frameSubscriptions = ['h', 'l'].map(final => terminal.parser.registerCsiHandler(
    { prefix: '?', final },
    (parameters) => {
      if (parameters.includes(2026)) {
        if (final === 'h') state.synchronizedUpdate = true
        else {
          if (state.synchronizedUpdate) state.completedFrames += 1
          state.synchronizedUpdate = false
        }
      }
      return false
    },
  ))
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
  for (const subscription of state.frameSubscriptions) subscription.dispose()
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

export function assertSuccessfulMockResult(record, response = RESPONSE) {
  assert.equal(record.outcome, 'completed', `mock attempt ${record.attempt} did not complete its success stream`)
  assert.equal(record.chunksSent, Array.from(response).length + 2,
    `mock attempt ${record.attempt} did not send every text chunk, terminal chunk, and [DONE]`)
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
    '    thinking: enabled',
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
    if (await predicate()) return
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

  const shippedRoot = resolve(
    dshHome, 'profiles', PROFILE_NAME, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets',
  )
  const requiredHostRows = {
    'time-context': {
      name: '@deepseek-ai/dsh-time-context',
      config: { refreshIntervalMs: 0 },
    },
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
      config: { default: 'standard' },
    },
    'dsh-tui': {
      name: 'dsh-tui/product',
      config: { autoStart: true },
    },
    'dsh-tui-capabilities': {
      name: 'dsh-tui/features/capabilities',
      config: null,
    },
    'dsh-tui-modes': {
      name: 'dsh-tui/features/modes',
      config: null,
    },
    'dsh-tui-models': {
      name: 'dsh-tui/features/models',
      config: null,
    },
    'dsh-tui-diff': {
      name: 'dsh-tui/features/diff',
      config: null,
    },
    'dsh-tui-sessions': {
      name: 'dsh-tui/features/sessions',
      config: null,
    },
    'dsh-tui-activity': {
      name: 'dsh-tui/features/activity',
      config: null,
    },
    'dsh-tui-dsh-rc2': {
      name: 'dsh-tui/adapters/dsh-rc2',
      config: null,
    },
    'dsh-tui-legacy-chat': {
      name: 'dsh-tui/features/legacy-chat',
      config: null,
    },
    'dsh-tui-preferences': {
      name: 'dsh-tui/adapters/preferences',
      config: null,
    },
    'dsh-tui-kernel': {
      name: 'dsh-tui/adapters/cordis',
      config: null,
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
    assert.deepEqual(row.config, expected.config, `Loader row ${localId} had unexpected config`)
  }
  const expectedDshTuiRows = Object.entries(requiredHostRows)
    .filter(([, expected]) => expected.name === 'dsh-tui/product'
      || expected.name.startsWith('dsh-tui/'))
    .map(([localId, expected]) => ({ localId, name: expected.name }))
    .sort((left, right) => left.localId.localeCompare(right.localId))
  const observedDshTuiRows = audit.loaderEntries
    .filter(entry => entry.hostComposition === true
      && (entry.name === 'dsh-tui' || entry.name.startsWith('dsh-tui/')))
    .map(entry => ({ localId: entry.localId, name: entry.name }))
    .sort((left, right) => left.localId.localeCompare(right.localId))
  assert.deepEqual(
    observedDshTuiRows,
    expectedDshTuiRows,
    'the booted profile did not expose exactly the split DSH-TUI provider rows',
  )
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
  const presetIds = ['cordis', 'minimal', 'ptc', 'standard']
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
  assert.deepEqual(audit.catalogs.minimal, ['pwsh'])
  assert.deepEqual(
    audit.catalogs.standard,
    STANDARD_TOOLS,
    'standard preset catalog drifted outside the exact 0.1.5-rc.2 set',
  )
  assert.deepEqual(
    audit.catalogs.ptc,
    [...audit.catalogs.standard.filter(tool => tool !== 'workflow'), 'run_code'].sort(),
    'ptc preset did not swap exactly the workflow tool for its run_code transport',
  )
  assert.deepEqual(
    audit.catalogs.cordis,
    CORDIS_TOOLS,
    'cordis preset catalog drifted outside the exact 0.1.5-rc.2 set',
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
  if (agentPresetId === 'minimal') {
    assert.deepEqual(audit.fresh.systemPrompt, {
      sectionNames: ['deployment:persona-prefix'],
      guidanceTextSha256: null,
    }, 'the official complete minimal persona admitted supplemental system-prompt sections')
  } else {
    assert.ok(audit.fresh.systemPrompt.sectionNames.includes('harness:identity'), 'fresh Agent lost official identity')
    assert.ok(audit.fresh.systemPrompt.sectionNames.includes('deployment:persona-prefix'), 'fresh Agent lost its selected persona')
    assert.ok(audit.fresh.systemPrompt.sectionNames.includes('dsh-tui:agent-guidance'), 'fresh Agent is missing scoped TUI guidance')
    assert.equal(audit.fresh.systemPrompt.guidanceTextSha256, EXPECTED_GUIDANCE_SHA256, 'built Agent guidance differs from the verified product contract')
  }
  assert.deepEqual(audit.hostServices.attachments, { pngAccepted: true, malformedRejected: true })
  assert.deepEqual(audit.catalogOrder, {
    freshSessionId: sessionId,
    standingPresetIds: ['standard', 'ptc', 'minimal', 'cordis'],
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

function assertTimeContextSnapshots(events, label) {
  const snapshots = events.filter(event => event.type === 'user/message'
    && event.data?.source?.kind === 'plugin' && event.data.source.plugin === 'time-context')
  assert.ok(snapshots.length > 0, `${label} omitted official request-time snapshots`)
  for (const snapshot of snapshots) {
    assert.equal(snapshot.data.source.form, 'snapshot')
    const text = snapshot.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\[/u)
    assert.ok(text.includes('Browser time zone for this request: unavailable.'), `${label} fabricated a browser time zone`)
  }
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
  assertTimeContextSnapshots(events, 'fresh Session')
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
    startSeq: compactionSummary.data?.shadowedRange?.start,
    endSeq: compactionSummary.data?.shadowedRange?.end,
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
  // 0.1.5: both turns end by a durable Goal pause aborting their held
  // in-flight request; a pause-aborted turn commits no turn/end marker.
  assert.equal(turnStarts.length, 2)
  assert.equal(turnEnds.length, 0)
  assert.ok(JSON.stringify(directUsers[0]?.data).includes(TOOLCHAIN_USER_PROMPT))
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
  assert.ok(resultText(13).includes('Plan approved'))
  assert.equal(toolResults[13]?.data?.message?.content?.[0]?.isError, false)
  assert.ok(resultText(14).includes('started background job pwsh-1'))
  assert.equal(toolResults[14]?.data?.message?.content?.[0]?.isError, false)

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
  // The durable pause aborted the held final request at execution time
  // (0.1.5), so no assistant message carries the scripted final response.
  const finalAssistant = events
    .filter(event => event.type === 'assistant/message')
    .findLast(event => JSON.stringify(event.data).includes(TOOLCHAIN_RESPONSE))
  assert.equal(finalAssistant, undefined, 'the aborted final request still published its response')
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
  assertTimeContextSnapshots(suffix, 'cold-resumed Session')
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
      undefined,
      { trueColor: true },
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
    await assertSettingsForm(ptyState, { dshHome, harnessRoot: options.harnessRoot, sessionId,
      modelRequests: () => mock.chatRequests.length, timeoutMilliseconds: options.timeoutMilliseconds })
    await assertSettingsProviderDialog(ptyState, { dshHome, providers: profileAudit.hostServices.dshTuiProviders.providers,
      modelRequests: () => mock.modelRequestCount,
      testResults: () => mock.providerTestResults, prepareTest: mock.prepareProviderTest,
      testRequests: () => mock.providerTestRequests, timeoutMilliseconds: options.timeoutMilliseconds })
    ptyState.pty.write('\x0f')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim() === 'Settings'
        && /▰ SETTINGS [1-9]\d*/u.test(text)
        && text.includes('Effective values')
        && text.includes('Saved for your user')
        && text.includes('Enter or Tab to choose a setting'),
      'standard toolchain explicit advanced Settings layer projection',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, 0, 'local Settings browsing unexpectedly invoked the model')
    await assertWorkspaceResizeMatrix(ptyState, 'runtime-settings', () => mock.chatRequests.length, options.timeoutMilliseconds)
    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim() === 'Settings'
        && /▰ SETTINGS [1-9]\d*/u.test(text)
        && text.includes('Enter edit')
        && text.includes('Namespace  ')
        && text.includes('Revision  '),
      'standard toolchain Settings detail focus',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write(']')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim() === 'Plugins'
        && /▰ PLUGINS [1-9]\d*/u.test(text)
        && text.includes('Selected plugin')
        && text.includes('Read-only · Enter refresh')
        && !text.includes('Module  ')
        && !text.includes('Entry   '),
      'standard toolchain Loader lifecycle projection',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, 0, 'local Loader browsing unexpectedly invoked the model')
    await assertWorkspaceResizeMatrix(ptyState, 'runtime-plugins', () => mock.chatRequests.length, options.timeoutMilliseconds)
    ptyState.pty.write('\t')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim() === 'Plugins'
        && text.includes('Module  ')
        && text.includes('Entry   ')
        && text.includes('Read-only plugin inventory'),
      'standard toolchain explicit Loader identity details',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => !text.includes('Read-only plugin inventory')
        && text.includes(`DSH-TUI · ${sessionId} · idle`),
      'standard toolchain Runtime Library close',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write('/diff')
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, '/diff'),
      'standard toolchain Diff command echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim() === 'DIFF'
        && text.includes('Working tree has no changes'),
      'standard toolchain empty Diff Feature',
      options.timeoutMilliseconds,
    )
    await assertWorkspaceResizeMatrix(ptyState, 'diff', () => mock.chatRequests.length, options.timeoutMilliseconds)
    ptyState.pty.write('i')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => !/^ DIFF\s*$/mu.test(text)
        && text.includes(`DSH-TUI · ${sessionId} · idle`),
      'standard toolchain Diff single-Escape return after unsupported Insert',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, 0, 'local Diff browsing unexpectedly invoked the model')

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
      lines => lines[0]?.trim().startsWith('Capabilities') === true,
      'standard toolchain Capabilities route opened by the /mcp alias',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('[')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('MCP 0')
        && text.includes('No MCP servers configured — manage providers in /settings')
        && text.includes('tools available in this session') === false
        && text.includes('Health') === false,
      'standard toolchain empty exact-Agent MCP projection',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, 0, 'local MCP browsing unexpectedly invoked the model')
    await assertWorkspaceResizeMatrix(ptyState, 'capabilities', () => mock.chatRequests.length, options.timeoutMilliseconds, capabilitiesViewportReady)
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && text.includes('No MCP servers configured') === false,
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
      lines => lines[0]?.trim().startsWith('Capabilities') === true,
      'standard toolchain Capabilities route opened by the /tools alias',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('[')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`Tools ${SESSION_STANDARD_TOOLS.length}`)
        && text.includes('pwsh')
        && text.includes('r refresh · q back')
        && !text.includes('Parameters'),
      'standard toolchain exact-Agent capability directory',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, 0, 'local Tools browsing unexpectedly invoked the model')
    ptyState.pty.write('i')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
    ptyState.pty.write('pwsh')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('› pwsh')
        && !text.includes('› read'),
      'standard toolchain Tool filtering',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      lines => lines[0]?.trim().startsWith('Capabilities') === true && lines.join('\n').includes('› pwsh'),
      'tool search applied',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('pwsh')
        && text.includes('Description')
        && text.includes('Enter / Esc / q close'),
      'standard toolchain Tool details modal',
      options.timeoutMilliseconds,
    )
    // The official pwsh description wraps beyond the modal viewport; page the
    // read-only fields with the actual modal scroll controls before asserting
    // the schema summary.
    ptyState.pty.write('\x1b[6~')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Required')
        && text.includes('command')
        && text.includes('Parameters'),
      'standard toolchain Tool details schema fields',
      options.timeoutMilliseconds,
    )
    interactionEvidence.push({ case: 'tool-explicit-schema-details', screens: [screenLines(ptyState.terminal)] })
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('› pwsh')
        && !text.includes('Parameters')
        && text.includes('r refresh · q back'),
      'standard toolchain Tool details modal close',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && text.includes('q back') === false,
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
      (lines, text) => commandSearchLineVisible(lines, '/plan')
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
      lines => lines[0]?.trim().startsWith('Capabilities') === true,
      'standard toolchain Capabilities route opened by the /skills alias',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('[')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Skills 1')
        && text.includes(`› ${TOOLCHAIN_SKILL}`)
        && text.includes('Standard toolchain acceptance fixture.'),
      'standard toolchain scoped Skills directory',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, 0, 'local Skills browsing unexpectedly invoked the model')
    ptyState.pty.write('i')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
    ptyState.pty.write('toolchain')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('toolchain')
        && text.includes(`› ${TOOLCHAIN_SKILL}`)
        && text.includes('Standard toolchain acceptance fixture.'),
      'standard toolchain Skill filtering',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => text.includes(`› ${TOOLCHAIN_SKILL}`)
        && lines[0]?.trim().startsWith('Capabilities')
        && text.includes('Enter details'),
      'standard toolchain Skill search applied in Normal mode',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(TOOLCHAIN_SKILL)
        && text.includes('Standard toolchain acceptance')
        && text.includes('Source')
        && text.includes('project-agents')
        && text.includes('Provider')
        && text.includes('filesystem')
        && text.includes(`Use /${TOOLCHAIN_SKILL} in Chat`)
        && text.includes('The agent can also choose this skill'),
      'standard toolchain Skill detail modal',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`› ${TOOLCHAIN_SKILL}`)
        && text.includes('Enter details')
        && text.includes('The agent can also choose this skill') === false,
      'standard toolchain Skill detail modal close',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && text.includes('q back') === false,
      'standard toolchain Skills directory close',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write(`/${TOOLCHAIN_SKILL} `)
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${TOOLCHAIN_SKILL}`),
      'standard toolchain literal Skill token entry',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write(TOOLCHAIN_PROMPT)
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, TOOLCHAIN_USER_PROMPT),
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
    ptyState.pty.write(`/${STATUS_COMMAND}`)
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${STATUS_COMMAND}`),
      'standard toolchain Status command echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim() === 'Status'
        && text.includes('Request recovery')
        && text.includes('×01 ─ ◉02')
        && text.includes('State  REQUESTING')
        && text.includes('Provider  deepseek-official')
        && text.includes('Failure  SERVER · HTTP 503')
        && text.includes('Message  temporary provider failure'),
      'standard toolchain request-recovery Status section',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b[6~')
    ptyState.pty.write('\x1b[6~')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Model route')
        && text.includes('◉01')
        && text.includes('State  CURRENT')
        && text.includes('Provider  deepseek-official')
        && text.includes(`Model  ${HISTORICAL_MODEL}`)
        && text.includes('Header  INITIAL')
        && text.includes('Authority  Official request/header + request/context'),
      'standard toolchain request-route Status section',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b[5~')
    ptyState.pty.write('\x1b[5~')
    await assertWorkspaceResizeMatrix(ptyState, 'status', () => mock.chatRequests.length, options.timeoutMilliseconds)
    assert.equal(
      mock.chatRequests.length,
      retryModelRequestBaseline,
      'local /status unexpectedly invoked the model',
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim() !== 'Status'
        && text.includes('ATTEMPT 2/2')
        && text.includes('LIVE'),
      'standard toolchain Status close',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write(APPROVAL_DRAFT)
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, APPROVAL_DRAFT),
      'unsubmitted draft before held request approval',
      options.timeoutMilliseconds,
    )
    mock.releaseRetryResponse()

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('─ Allow pwsh? · Write within the workspace')
        && text.includes('Request: Attempt rejected fixture write.')
        && text.includes("Command: Set-Content -LiteralPath 'rejected.txt' -Value 'must-not-exist'")
        && text.includes('› 2 Reject')
        && text.includes('1 Allow once')
        && text.includes('3 Allow for session')
        && text.includes('Ctrl+O details'),
      'standard toolchain rejected approval prompt',
      options.timeoutMilliseconds,
    )
    const approvalRequestBaseline = mock.chatRequests.length
    let approvalBeforeTiny
    await waitForCondition(async () => {
      approvalBeforeTiny = (await loadSessionLog(dshHome, sessionId)).rows
      return approvalBeforeTiny.some(event => event.type === 'approval/asked'
        && event.data?.toolName === 'pwsh' && typeof event.data?.id === 'string')
    }, options.timeoutMilliseconds, 'pending approval batched durable publication')
    const decisionsBeforeTiny = approvalBeforeTiny.filter(event => event.type === 'approval/decided')
    const pendingApprovalId = approvalBeforeTiny.findLast(event => event.type === 'approval/asked')?.data?.id
    assert.ok(pendingApprovalId, 'pending approval omitted its durable id')
    ptyState.terminal.resize(80, 6)
    ptyState.pty.resize(80, 6)
    const tinyApprovalLines = await waitForScreen(
      ptyState,
      (lines, text) => lines.length === 6
        && text.includes('─ Allow pwsh?')
        && text.includes('1 Allow once')
        && text.includes('› 2 Reject')
        && text.includes('3 Allow for session')
        && /↑↓ 1-3\/\d+/u.test(text),
      'approval 80x6 complete compact controls',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b[B')
    const tinyScrolledLines = await waitForScreen(
      ptyState,
      (_lines, text) => /↑↓ 2-4\/\d+/u.test(text)
        && text.includes('1 Allow once') && text.includes('› 2 Reject'),
      'approval 80x6 scroll preserves default Reject and both controls',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b[A')
    await waitForScreen(ptyState, (_lines, text) => /↑↓ 1-3\/\d+/u.test(text), 'approval 80x6 evidence scroll returns to start', options.timeoutMilliseconds)
    ptyState.terminal.resize(80, 3)
    ptyState.pty.resize(80, 3)
    const uninspectableApprovalLines = await waitForScreen(
      ptyState,
      (lines, text) => lines.length === 3
        && text.includes('Terminal too small')
        && text.includes('Esc reject')
        && !text.includes('Allow once'),
      'approval 80x3 inspection guard',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('1\r')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    ptyState.terminal.resize(RESIZED_COLUMNS, RESIZED_ROWS)
    ptyState.pty.resize(RESIZED_COLUMNS, RESIZED_ROWS)
    const restoredApprovalLines = await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('─ Allow pwsh?')
        && text.includes('Response error: Terminal too small to inspect approval evidence')
        && text.includes('› 2 Reject'),
      'approval guard error and default Reject after normal-size restore',
      options.timeoutMilliseconds,
    )
    assert.equal(mock.chatRequests.length, approvalRequestBaseline, 'tiny approval allow reached the model')
    const approvalAfterTiny = (await loadSessionLog(dshHome, sessionId)).rows
    assert.deepEqual(
      approvalAfterTiny.filter(event => event.type === 'approval/decided'),
      decisionsBeforeTiny,
      'tiny approval emitted a durable decision',
    )
    assert.equal(approvalAfterTiny.findLast(event => event.type === 'approval/asked')?.data?.id, pendingApprovalId)
    interactionEvidence.push({ case: 'approval-80x6-controls-and-80x3-fail-closed', tinyApprovalLines, tinyScrolledLines, uninspectableApprovalLines, restoredApprovalLines, modelRequestDelta: 0, durableDecisionDelta: 0 })
    // Clear the guard notice with an explicit Reject selection. Numeric choice
    // input must never leave a hidden draft that changes a later Enter.
    ptyState.pty.write('2')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('› 2 Reject') && !text.includes('Response error:'),
      'approval guard notice cleared with Reject',
      options.timeoutMilliseconds,
    )
    assert.equal(screenText(ptyState.terminal).replace(/\s/gu, '').includes(APPROVAL_ARGUMENT_TAIL), false,
      'long argument fixture unexpectedly fit in the first approval evidence window')
    ptyState.pty.write('\x0f')
    await waitForScreen(ptyState, (_lines, text) => text.includes('Ctrl+O less')
      && /↑↓ 1-\d+\/\d+/u.test(text), 'approval expanded details start', options.timeoutMilliseconds)
    const expandedApprovalScreens = []
    for (let step = 0; step < 100; step += 1) {
      const lines = screenLines(ptyState.terminal)
      expandedApprovalScreens.push(lines)
      const text = lines.join('\n')
      const extent = /↑↓ (\d+)-(\d+)\/(\d+)/u.exec(text)
      if (text.includes('Approval / session:') && extent !== null && extent[2] === extent[3]) break
      const range = /↑↓ (\d+-\d+\/\d+)/u.exec(text)?.[1]
      ptyState.pty.write('\x1b[6~')
      await waitForScreen(ptyState, (_lines, next) => /↑↓ (\d+-\d+\/\d+)/u.exec(next)?.[1] !== range
        && next.includes('› 2 Reject') && next.includes('Ctrl+O less'),
      `approval raw detail page ${step + 1}`, options.timeoutMilliseconds)
    }
    const expandedApprovalText = expandedApprovalScreens.flat().join('\n')
    assert.ok(expandedApprovalText.replace(/\s/gu, '').includes(APPROVAL_ARGUMENT_TAIL),
      'expanded approval evidence did not reach the exact argument tail')
    for (const marker of ['Tool / call: pwsh / ', 'Current permission: read-only /', 'Arguments: ', 'Evidence source:', 'Approval / session:']) {
      assert.ok(expandedApprovalText.includes(marker), `expanded approval omitted ${marker}`)
    }
    interactionEvidence.push({ case: 'approval-explicit-raw-details', screens: expandedApprovalScreens })
    interactionEvidence.push({ case: 'approval-long-argument-tail', lines: expandedApprovalScreens.find(lines =>
      lines.join('').replace(/\s/gu, '').includes(APPROVAL_ARGUMENT_TAIL)) })
    ptyState.pty.write('\x0f')
    await waitForScreen(ptyState, (_lines, text) => text.includes('Ctrl+O details')
      && /↑↓ 1-\d+\/\d+/u.test(text), 'approval raw details collapsed', options.timeoutMilliseconds)
    ptyState.pty.write('3')
    const scopeLines = await waitForScreen(ptyState, (_lines, text) => text.includes('› 3 Allow for session')
      && text.includes('For this session: All pwsh calls from this working folder')
      && text.replace(/\s+/gu, ' ').includes('Revoke in /permission; cleared on disconnect.'),
    'approval explicit session scope and revocation', options.timeoutMilliseconds)
    ptyState.pty.write('2')
    await waitForScreen(ptyState, (_lines, text) => text.includes('› 2 Reject')
      && !text.includes('For this session:'), 'approval numeric choice replaces scope without a hidden token', options.timeoutMilliseconds)
    assert.equal(mock.chatRequests.length, approvalRequestBaseline, 'approval detail or scope browsing invoked the model')
    assert.deepEqual((await loadSessionLog(dshHome, sessionId)).rows.filter(event => event.type === 'approval/decided'),
      decisionsBeforeTiny, 'approval scope browsing emitted a durable decision')
    interactionEvidence.push({ case: 'approval-session-scope-preview-then-reject', lines: scopeLines, modelRequestDelta: 0, durableDecisionDelta: 0 })
    ptyState.pty.write('\r')

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('─ Allow write? · Write within the workspace')
        && text.includes('Input:')
        && text.includes('"file_path":"toolchain.txt"')
        && text.includes('"content":"DSH_TUI_TOOLCHAIN_BEFORE\\n"')
        && text.includes('› 2 Reject')
        && text.includes('1 Allow once')
        && text.includes('Ctrl+O details'),
      'standard toolchain allowed write approval prompt',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b[D')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('─ Allow write?') && text.includes('› 1 Allow once'),
      'standard toolchain explicit write approval selection',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('─ Allow edit? · Write within the workspace')
        && text.includes('Input:')
        && text.includes('"file_path":"toolchain.txt"')
        && text.includes('"old_string":"BEFORE"')
        && text.includes('"new_string":"AFTER"')
        && text.includes('› 2 Reject')
        && text.includes('1 Allow once')
        && text.includes('Ctrl+O details'),
      'standard toolchain allowed edit approval prompt',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b[D')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('─ Allow edit?') && text.includes('› 1 Allow once'),
      'standard toolchain explicit edit approval selection',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')

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
    const restoredDraftLines = await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, APPROVAL_DRAFT),
      'unsubmitted draft preserved across approvals and questions',
      options.timeoutMilliseconds,
    )
    interactionEvidence.push({ case: 'approval-draft-preserved', lines: restoredDraftLines })
    ptyState.pty.write('\x7f'.repeat(APPROVAL_DRAFT.length))
    await waitForScreen(ptyState, lines => commandSearchLineVisible(lines, ''), 'approval draft discarded without submission', options.timeoutMilliseconds)

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

    // 0.1.5 enforces a durable Goal pause at execution time: the held
    // in-flight request is aborted. The mock rolls its ladder back so the
    // resumed Goal's driver round re-serves the same step.
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Request stopped'),
      'standard toolchain durable Goal pause aborted the in-flight request',
      options.timeoutMilliseconds,
    )
    mock.releasePausedGoal()
    await waitForCondition(
      () => mock.chatRequests.length === mock.resolvedSteps.length,
      options.timeoutMilliseconds,
      'standard toolchain mock rolled back the aborted held step',
    )

    // The model cannot resume a durable-paused Goal (GOAL_TOOL_RESUME_PAUSED);
    // the user-facing dock owns that transition.
    ptyState.pty.write('\x07')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('GOAL ACTIONS')
        && text.includes('Goal paused · revision 2 · [DSH/official]')
        && text.includes('goal> Resume goal'),
      'standard toolchain first-party Goal resume dock',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('GOAL ACTIVE')
        && text.includes('Notice: Goal resumed'),
      'standard toolchain user-resumed Goal projection',
      options.timeoutMilliseconds,
    )

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('▌ Plan review')
        && text.includes('Approve this plan and leave plan mode?')
        && text.includes('# Ship the first-party workbench')
        && text.includes('› Approve'),
      'standard toolchain first-party Plan Review dock'
        + ` · mock state: chat=${mock.chatRequests.length} steps=${JSON.stringify(mock.resolvedSteps?.map(step => step?.name) ?? [])}`
        + (mock.failures.length === 0 ? '' : ` · mock failures: ${JSON.stringify(mock.failures.map(errorMessage))}`),
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
      (lines, text) => lines[0]?.trim().startsWith('Activity') === true
        && text.includes('Jobs 1 · 1 live')
        && text.includes(TOOLCHAIN_BACKGROUND_COMMAND)
        && text.includes('●'),
      'standard toolchain first-party Activity Center Workspace',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('State')
        && text.includes('running')
        && text.includes('Identity')
        && text.includes('pwsh-1 · pwsh')
        && text.includes('Authority')
        && text.includes('JobRegistry')
        && text.includes('Control')
        && text.includes('Stop available'),
      'standard toolchain Activity detail modal',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('q back')
        && !text.includes('JobRegistry'),
      'standard toolchain Activity detail modal close',
      options.timeoutMilliseconds,
    )
    await waitForCondition(
      () => mock.chatRequests.length === STANDARD_TOOLCHAIN_STEPS.length + 1,
      options.timeoutMilliseconds,
      'standard toolchain final request held before Activity resize',
    )
    await assertWorkspaceResizeMatrix(ptyState, 'activity', () => mock.chatRequests.length, options.timeoutMilliseconds, activityViewportReady)
    ptyState.terminal.resize(140, 30)
    ptyState.pty.resize(140, 30)
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim().startsWith('Activity') === true
        && text.includes('Jobs 1 · 1 live')
        && text.includes(TOOLCHAIN_BACKGROUND_COMMAND),
      'standard toolchain Activity wide restore before the stop flow',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('K')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`Stop ${TOOLCHAIN_BACKGROUND_COMMAND}?`)
        && text.includes('Enter confirm · Esc / q cancel')
        && text.includes('Cancel')
        && !text.includes('Activity: Enter confirm stop'),
      'standard toolchain background Job stop confirmation',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(TOOLCHAIN_BACKGROUND_COMMAND)
        && text.includes('■')
        && text.includes('killed')
        && text.includes('Jobs 1')
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
        && text.includes('Notice: Goal paused')
        && text.includes('PLAN OFF'),
      'standard toolchain final TUI-paused Goal projection',
      options.timeoutMilliseconds,
    )
    // The durable pause aborts the held final response request (0.1.5
    // execution-time enforcement); releasing the gate lets the mock roll the
    // unanswerable request back instead of answering or recording a failure.
    mock.releaseFinalResponse()
    await waitForCondition(
      () => mock.chatRequests.length === mock.resolvedSteps.length,
      options.timeoutMilliseconds,
      'standard toolchain mock rolled back the aborted final request',
    )

    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && text.includes('GOAL PAUSED')
        && text.includes('PLAN OFF'),
      'standard toolchain final durable-paused idle',
      options.timeoutMilliseconds,
    )
    const detailRequestBaseline = mock.chatRequests.length
    ptyState.pty.write(DETAILS_DRAFT)
    await waitForScreen(ptyState, lines => commandSearchLineVisible(lines, DETAILS_DRAFT), 'Ctrl+O draft fixture', options.timeoutMilliseconds)
    const draftCursor = { x: ptyState.terminal.buffer.active.cursorX, y: ptyState.terminal.buffer.active.cursorY }
    assert.equal(draftCursor.y, ptyState.terminal.rows - 3, 'draft cursor was not in the Composer')
    for (const mode of ['verbose', 'compact']) {
      const bytesBeforeToggle = ptyState.rawBytes
      ptyState.pty.write('\x0f')
      const lines = await waitForScreen(
        ptyState,
        (nextLines, text) => ptyState.rawBytes > bytesBeforeToggle
          && commandSearchLineVisible(nextLines, DETAILS_DRAFT)
          && text.includes('Ship the official first-party workbench'),
        `Ctrl+O ${mode} preserves draft and visible workbench`,
        options.timeoutMilliseconds,
      )
      assert.deepEqual({ x: ptyState.terminal.buffer.active.cursorX, y: ptyState.terminal.buffer.active.cursorY }, draftCursor)
      assert.equal(mock.chatRequests.length, detailRequestBaseline, 'Ctrl+O invoked the model')
      interactionEvidence.push({ case: `ctrl-o-${mode}`, lines, cursor: draftCursor, modelRequestDelta: 0 })
    }
    ptyState.pty.write('\x7f'.repeat(DETAILS_DRAFT.length))
    await waitForScreen(ptyState, lines => commandSearchLineVisible(lines, ''), 'Ctrl+O draft discarded without submission', options.timeoutMilliseconds)
    await withDeadline(
      mock.titleRequest,
      options.timeoutMilliseconds,
      'standard toolchain official session title request',
    )
    assert.deepEqual(mock.failures, [], 'standard toolchain mock recorded request failures')
    assert.equal(mock.chatRequests.length, STANDARD_TOOLCHAIN_STEPS.length)
    assert.equal(mock.retryRequests.length, 1)
    assert.equal(mock.titleRequests.length, 1)
    assert.equal(mock.providerTestRequests.length, 3)
    assert.equal(mock.searchRequests.length, 1)
    assert.equal(mock.callIds.length, STANDARD_TOOLCHAIN_STEPS.length)

    await waitForCondition(async () => (await loadSessionLog(dshHome, sessionId)).rows.some(event =>
      event.type === 'session/title' && event.data?.title === 'Standard toolchain acceptance'),
    options.timeoutMilliseconds, 'official generated title durable publication')
    ptyState.pty.write('/sessions')
    await waitForScreen(ptyState, lines => commandSearchLineVisible(lines, '/sessions'),
      'recorded-title catalog command', options.timeoutMilliseconds)
    ptyState.pty.write('\r')
    await waitForScreen(ptyState, (_lines, text) => text.includes('› Standard toolchain acceptance'),
      'official recorded title in the current Session list', options.timeoutMilliseconds)
    ptyState.pty.write('/')
    await waitForScreen(ptyState, () => ptyState.terminal.buffer.active.cursorY === 2,
      'recorded-title search cursor', options.timeoutMilliseconds)
    ptyState.pty.write('toolchain acceptance')
    const titleCatalogLines = await waitForScreen(ptyState, (_lines, text) => /1\/\d+ matching/u.test(text)
      && text.includes('toolchain acceptance') && text.includes('› Standard toolchain acceptance'),
    'Sessions title search result', options.timeoutMilliseconds, 75)
    const titleSearchSubmitFrame = ptyState.completedFrames
    ptyState.pty.write('\r')
    await waitForScreen(ptyState, (_lines, text) => ptyState.completedFrames > titleSearchSubmitFrame
      && text.includes('toolchain acceptance'), 'recorded-title search applied', options.timeoutMilliseconds)
    ptyState.pty.write('\r')
    await waitForScreen(ptyState, (lines, text) => commandSearchLineVisible(lines, '')
      && text.includes(`DSH-TUI · ${sessionId} · idle`), 'recorded-title current Session return', options.timeoutMilliseconds)
    assert.equal(mock.chatRequests.length, STANDARD_TOOLCHAIN_STEPS.length, 'recorded-title catalog browsing invoked the model')
    assert.equal(mock.titleRequests.length, 1, 'recorded-title catalog browsing generated another title')
    interactionEvidence.push({ case: 'sessions-recorded-title-search-current-return', lines: titleCatalogLines, modelRequestDelta: 0 })

    const workbenchWrites = (await readFile(productWritesPath)).toString('utf8')
    const activeGoalAt = workbenchWrites.indexOf('GOAL ACTIVE')
    const goalActionsAt = workbenchWrites.indexOf('GOAL ACTIONS')
    const pausedGoalAt = workbenchWrites.indexOf('GOAL PAUSED')
    const planReviewAt = workbenchWrites.indexOf('▌ Plan review')
    const resumedGoalAt = workbenchWrites.indexOf('GOAL ACTIVE', pausedGoalAt + 1)
    const resumeGoalActionsAt = workbenchWrites.indexOf('GOAL ACTIONS', pausedGoalAt + 1)
    const finalGoalActionsAt = workbenchWrites.indexOf('GOAL ACTIONS', resumedGoalAt)
    const finalPausedGoalAt = workbenchWrites.indexOf('GOAL PAUSED', finalGoalActionsAt)
    const liveActivityAt = workbenchWrites.indexOf('ACTIVITY · pwsh-1')
    const activityCenterAt = workbenchWrites.indexOf('Jobs 1 · 1 live')
    const activityKillConfirmAt = workbenchWrites.indexOf(`Stop ${TOOLCHAIN_BACKGROUND_COMMAND}?`)
    const killedActivityAt = workbenchWrites.indexOf('Notice: Stop requested for pwsh-1', activityKillConfirmAt)
    const activePlanAt = workbenchWrites.indexOf('PLAN ON')
    const liveTodoAt = workbenchWrites.indexOf('● Verify TUI interactions')
    const inactivePlanAt = workbenchWrites.indexOf('PLAN OFF')
    assert.ok(activeGoalAt >= 0, 'terminal writes omitted the active Goal projection')
    assert.ok(goalActionsAt > activeGoalAt, 'Goal action dock did not follow its active projection')
    assert.ok(pausedGoalAt > goalActionsAt, 'paused Goal did not follow the Goal action dock')
    assert.ok(planReviewAt > pausedGoalAt, 'Plan Review did not follow the paused Goal projection')
    assert.ok(resumedGoalAt > pausedGoalAt, 'resumed Goal did not follow its paused projection')
    assert.ok(resumeGoalActionsAt > pausedGoalAt && resumeGoalActionsAt < resumedGoalAt,
      'the user-owned Goal resume dock did not sit between pause and resume')
    assert.ok(planReviewAt > resumedGoalAt, 'Plan Review did not follow the user-resumed Goal')
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

    const preExitScreen = screenText(ptyState.terminal)
    ptyState.pty.write('\x03')
    let exit
    try {
      exit = await withDeadline(
        ptyState.exitPromise,
        options.timeoutMilliseconds,
        'standard toolchain DSH-TUI clean Ctrl+C exit',
      )
    } catch (error) {
      throw new Error(
        `${errorMessage(error)}\nscreen before Ctrl+C:\n${outputExcerpt(preExitScreen)}`
        + `\nscreen after Ctrl+C:\n${outputExcerpt(screenText(ptyState.terminal))}`,
        { cause: error },
      )
    }
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
      'Effective values',
      'Saved for your user',
      'Namespace  ',
      'Revision  ',
      'Selected plugin',
      'Read-only plugin inventory',
      'Module  ',
      'Entry   ',
      'No MCP servers configured — manage providers in /settings',
      `Tools ${SESSION_STANDARD_TOOLS.length}`,
      'Skills 1',
      '› pwsh',
      'Parameters',
      'Required',
      `Use /${TOOLCHAIN_SKILL} in Chat`,
      'The agent can also choose this skill',
      `> /${TOOLCHAIN_SKILL}`,
      'RETRY 2/2 · deepseek-official · WAIT 750ms · SERVER',
      'ATTEMPT 2/2 · deepseek-official · LIVE',
      ' Request recovery ',
      '×01 ─ ◉02',
      'Failure  SERVER · HTTP 503',
      '─ Allow pwsh? · Write within the workspace',
      'Access: Write within the workspace for this call; session policy unchanged',
      'Tool / call: pwsh / ',
      'Evidence source:',
      '› 3 Allow for session',
      '› 1 Allow once',
      '› 2 Reject',
      '▌ Answer',
      'Choose the accepted fixture option.',
      'Cancel this fixture question.',
      'GOAL ACTIONS',
      '▌ Plan review',
      '› Approve',
      'ACTIVITY · pwsh-1',
      'Jobs 1 · 1 live',
      'JobRegistry',
      'Stop available',
      `Stop ${TOOLCHAIN_BACKGROUND_COMMAND}?`,
      'killed',
      'Request stopped',
    ]) {
      assert.ok(productWrites.includes(marker), `standard toolchain terminal writes omitted ${marker}`)
    }
    assert.ok(
      !productWrites.includes('[unsupported:tool-result]'),
      'standard toolchain rendered an official Tool Result as unsupported content',
    )
    // Persistence is write-behind; wait until the final pause is durable
    // before reading the log for exact assertions.
    await waitForCondition(async () => {
      const log = await loadSessionLog(dshHome, sessionId)
      return log.rows.filter(event => event.type === 'goal/change').length === 4
    }, options.timeoutMilliseconds, 'standard toolchain Session log Goal settlement')
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
      providerTestRequests: mock.providerTestRequests.length,
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
  const orbsLib = join(options.orbsRoot, 'dist', 'index.js')
  const profileAuditPluginPath = join(
    options.dshTuiRoot,
    'scripts',
    'official-dsh-profile-audit.mjs',
  )
  assert.ok(existsSync(cliBin), `missing built Harness CLI: ${cliBin}`)
  assert.ok(existsSync(mockBin), `missing repo-local mock server source: ${mockBin}`)
  assert.ok(existsSync(dshTuiLib), `missing built DSH-TUI: ${dshTuiLib}`)
  assert.ok(existsSync(orbsLib), `missing built pi-tui-orbs: ${orbsLib}`)
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
    const orbsFileSpec = `file:${options.orbsRoot.replaceAll('\\', '/')}`
    await runCommand(
      process.execPath,
      [
        cliBin,
        'plugin',
        '--profile',
        PROFILE_NAME,
        'add',
        '--prefer-offline',
        orbsFileSpec,
        fileSpec,
      ],
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
    assert.match(manifest.dependencies?.['pi-tui-orbs'] ?? '', /^file:/u)

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
    await verifyInstalledOrbsPackage(
      options.orbsRoot,
      join(profileDir, 'node_modules', 'pi-tui-orbs'),
    )
    isolatedEnvironment.DSH_TUI_E2E_PRELOAD = 'capture-product-writes'
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

    ptyState.pty.write(`/${CONNECT_COMMAND}`)
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${CONNECT_COMMAND}`),
      'typed /connect alias echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('DSH 设置') && text.includes('模型与服务'),
      'typed /connect opens the Settings providers management page',
      options.timeoutMilliseconds,
    )

    const connectProvider = async (name, filter) => {
      ptyState.pty.write('n')
      await waitForScreen(
        ptyState,
        (_lines, text) => text.includes('添加提供商'),
        `Settings add-provider directory for ${name}`,
        options.timeoutMilliseconds,
      )
      ptyState.pty.write(filter)
      let directory = await waitForScreen(
        ptyState,
        lines => selectedScreenLine(lines)?.toLowerCase().includes(filter) === true,
        `Settings filtered ${name} provider`,
        options.timeoutMilliseconds,
      )
      for (let step = 0; !settingsProviderDialogSelected(directory, '添加提供商', name) && step < 16; step += 1) {
        directory = await moveSelection(ptyState, '\x1b[B', `Settings exact ${name} provider ${step + 1}`, options.timeoutMilliseconds)
      }
      assert.ok(
        settingsProviderDialogSelected(directory, '添加提供商', name),
        `provider directory did not select the exact ${name} route`,
      )
      ptyState.pty.write('\r')
      await waitForScreen(
        ptyState,
        (_lines, text) => text.includes(`${name} · 管理`) && text.includes('测试连接')
          && !text.includes('Esc 取消测试'),
        `Settings ${name} management form`,
        options.timeoutMilliseconds,
      )
      ptyState.pty.write('c')
      const credentials = await waitForScreen(
        ptyState,
        (_lines, text) => text.includes('配置凭据'),
        `Settings ${name} credentials`,
        options.timeoutMilliseconds,
      )
      if (credentials.join('\n').includes('选择服务提供的认证方式')) {
        for (let step = 0; step < 8; step += 1) {
          if (/›\s*[^\n│]*API/iu.test(selectedScreenLine(screenLines(ptyState.terminal)) ?? '')) break
          await moveSelection(ptyState, '\x1b[B', `Settings ${name} API-key method ${step + 1}`, options.timeoutMilliseconds)
        }
        ptyState.pty.write('\r')
      }
      await waitForScreen(
        ptyState,
        (_lines, text) => text.includes('Enter 确认') && text.includes('Esc 取消') && !text.includes('测试连接'),
        `Settings ${name} authorization editor`,
        options.timeoutMilliseconds,
      )
      ptyState.pty.write(MOCK_API_KEY)
      const maskedLines = await waitForScreen(
        ptyState,
        (_lines, text) => text.includes('•'.repeat(Array.from(MOCK_API_KEY).length)),
        `masked ${name} API key`,
        options.timeoutMilliseconds,
      )
      assert.equal(maskedLines.join('\n').includes(MOCK_API_KEY), false)
      ptyState.pty.write('\r')
      await waitForScreen(
        ptyState,
        (_lines, text) => text.includes('凭据已配置') && text.includes(name)
          && !text.includes('Esc 取消测试'),
        `connected ${name} Provider`,
        options.timeoutMilliseconds,
        75,
      )
      ptyState.pty.write('q')
      await waitForScreen(
        ptyState,
        (_lines, text) => text.includes('新会话默认模型') && text.includes('添加提供商'),
        `Settings providers home after ${name}`,
        options.timeoutMilliseconds,
        75,
      )
    }
    await connectProvider('DeepSeek', 'deepseek')
    await connectProvider('openai', 'openai')
    ptyState.pty.write('q')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && !text.includes('DSH 设置'),
      'Settings providers page dismissal',
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
      (lines, text) => commandSearchLineVisible(lines, `/${COMMAND_NAME}`)
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
      (lines, text) => lines[0]?.trim().startsWith('Sessions') === true
        && text.includes('Sessions 1')
        && text.includes('› Untitled session')
        && text.includes('idle · current')
        && text.includes(basename(workspace))
        && text.includes('q back')
        && !/\b(?:ID|Storage|Preset) {2}|\d{4}-\d{2}-\d{2}T/u.test(text),
      'Sessions Feature current-session catalog',
      options.timeoutMilliseconds,
    )
    await assertWorkspaceResizeMatrix(ptyState, 'sessions', () => mockMonitor.records.filter(record => record?.type === 'request').length, options.timeoutMilliseconds, sessionsViewportReady)
    const sessionQuery = sessionId.slice(-8)
    ptyState.pty.write('/')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Sessions 1')
        && ptyState.terminal.buffer.active.cursorY === 2,
      'Sessions Feature slash enters search',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write(sessionQuery)
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('1/1 matching')
        && text.includes(sessionQuery)
        && ptyState.terminal.buffer.active.cursorY === 2,
      'Sessions Feature scoped catalog filtering',
      options.timeoutMilliseconds,
    )
    const searchSubmitFrame = ptyState.completedFrames
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => ptyState.completedFrames > searchSubmitFrame
        && text.includes('1/1 matching')
        && text.includes(sessionQuery),
      'Sessions Feature search submit stays in the directory',
      options.timeoutMilliseconds,
    )
    // A narrow viewport keeps the list readable without a sidebar.
    ptyState.terminal.resize(60, 20)
    ptyState.pty.resize(60, 20)
    await waitForScreen(ptyState, (_lines, text) => text.includes('1/1 matching')
      && text.includes('idle · current'), 'Sessions narrow catalog', options.timeoutMilliseconds, 75)
    ptyState.terminal.resize(RESIZED_COLUMNS, RESIZED_ROWS)
    ptyState.pty.resize(RESIZED_COLUMNS, RESIZED_ROWS)
    await waitForScreen(ptyState, (_lines, text) => text.includes('1/1 matching')
      && text.includes('idle · current')
      && !/\b(?:ID|Storage|Preset) {2}|\d{4}-\d{2}-\d{2}T/u.test(text), 'Sessions catalog restored', options.timeoutMilliseconds, 75)
    ptyState.pty.write('i')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(sessionQuery)
        && ptyState.terminal.buffer.active.cursorY === 2,
      'Sessions Feature insert mode before one-Escape close',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x7f'.repeat(sessionQuery.length))
    await waitForScreen(
      ptyState,
      (_lines, text) => !text.includes('1/1 matching'),
      'Sessions Feature query cleared',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && !text.includes('q back'),
      'Sessions Feature single Escape closes Insert mode',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write(`/${CATALOG_COMMAND}`)
    await waitForScreen(
      ptyState,
      lines => commandSearchLineVisible(lines, `/${CATALOG_COMMAND}`),
      'Sessions Feature reopen command echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('Sessions 1')
        && text.includes('› Untitled session'),
      'Sessions Feature reopen before current-session no-op',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && !text.includes('q back'),
      'current-session Feature route no-op',
      options.timeoutMilliseconds,
    )
    const catalogModelRequests = mockMonitor.records.filter(record => record?.type === 'request').length
    assert.equal(catalogModelRequests, 0, 'local session catalog unexpectedly reached the mock LLM')

    ptyState.pty.write(MODEL_PREFIX)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, MODEL_PREFIX)
        && text.includes(`/${MODEL_COMMAND}`)
        && text.includes('Open models')
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
      (lines, text) => lines[0]?.trim().startsWith('Models') === true && text.includes('Models 5')
        && text.includes('Enter apply · Ctrl+S default')
        && text.includes(`Current deepseek-official / ${HISTORICAL_MODEL} · provider default`)
        && lines.some(line => line.includes('› ') && line.includes('DeepSeek-V4-Flash'))
        && text.includes('DSH-TUI OpenAI E2E'),
      'cached-first Models Feature catalog',
      options.timeoutMilliseconds,
    )
    await assertWorkspaceResizeMatrix(ptyState, 'models', () => mockMonitor.records.filter(record => record?.type === 'request').length, options.timeoutMilliseconds, modelsViewportReady)
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
        && !text.includes('q back'),
      'OpenAI model visibility check dismissal',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write(MODEL_PREFIX)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, MODEL_PREFIX)
        && text.includes(`/${MODEL_COMMAND}`)
        && text.includes('Open models'),
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
      (lines, text) => lines[0]?.trim().startsWith('Models') === true && text.includes('Models 5')
        && text.includes(`Current deepseek-official / ${HISTORICAL_MODEL}`)
        && lines.some(line => line.includes('› ') && line.includes('DSH-TUI OpenAI E2E')),
      'reopened Models Feature retained selection',
      options.timeoutMilliseconds,
    )
    // Select a model by its identity; efforts are independent of list movement.
    await moveSelectionTo(ptyState, 'DeepSeek-V4-Pro', 'Pro model row', options.timeoutMilliseconds, 'up')
    const selectedReasoning = (lines) => {
      const row = lines.findIndex(line => line.includes('› ') && line.includes('DeepSeek-V4-Pro'))
      return row < 0 ? undefined : lines[row + 1]
    }
    await waitForScreen(
      ptyState,
      (lines, text) => lines.some(line => line.includes('› ') && line.includes('DeepSeek-V4-Pro'))
        && selectedReasoning(lines)?.includes('Reasoning Off'),
      'DSH model selection',
      options.timeoutMilliseconds,
    )
    for (const modelName of ['DeepSeek-V41-Flash', 'DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash-Vision-Exp', 'DSH-TUI OpenAI E2E']) {
      const rowPattern = new RegExp(`${modelName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\w-])`, 'u')
      assert.equal(screenLines(ptyState.terminal).filter(line => rowPattern.test(line)).length, 1,
        `model catalog did not have exactly one row for ${modelName}`)
    }
    ptyState.pty.write('\x1b[C')
    await waitForScreen(ptyState, (lines, text) => selectedReasoning(lines)?.includes('Reasoning Low')
      && text.includes(`Current deepseek-official / ${HISTORICAL_MODEL}`), 'reasoning changes without applying the model', options.timeoutMilliseconds)
    ptyState.pty.write('\x1b[D')
    await waitForScreen(ptyState, (lines, text) => selectedReasoning(lines)?.includes('Reasoning Off')
      && text.includes(`Current deepseek-official / ${HISTORICAL_MODEL}`), 'reasoning choice restored before apply', options.timeoutMilliseconds)
    assert.equal(mockMonitor.records.filter(record => record?.type === 'request').length, 0, 'reasoning browsing invoked a model')
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim().startsWith('Models') === true && text.includes('Models 5')
        && text.includes(`Current deepseek-official / ${PICKED_MODEL} · off`)
        && lines.some(line => line.includes('› ')
          && line.includes('DeepSeek-V4-Pro')),
      'Models Feature Session-only selection settlement',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${sessionId} · idle`)
        && text.includes(`MODEL deepseek-official/${PICKED_MODEL}/off`)
        && !text.includes('q back'),
      'validated Session-only model switch',
      options.timeoutMilliseconds,
    )
    const modelPickerModelRequests = mockMonitor.records
      .filter(record => record?.type === 'request').length
    assert.equal(modelPickerModelRequests, 0, 'local model selection unexpectedly reached the mock LLM')

    ptyState.pty.write(PROMPT)
    await waitForScreen(
      ptyState,
      lines => composerPromptLines(lines).some(line => line.includes(PROMPT_SUFFIX)),
      'real prompt editor echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(PROMPT_SUFFIX)
        && text.includes(`● ${RESPONSE}`)
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
    assertSuccessfulMockResult(result)
    // Session-title generation can run alongside the main reply. Let every
    // request already issued at this boundary finish before browsing or closing
    // its Session, instead of relying on UI speed to cancel an auxiliary stream.
    for (const issued of mockMonitor.records.filter(record => record.type === 'request')) {
      assertSuccessfulMockResult(await mockMonitor.waitFor(
        record => record.type === 'result' && record.attempt === issued.attempt,
        `initial successful request ${issued.attempt} settlement`,
        options.timeoutMilliseconds,
      ))
    }

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
    ptyState.pty.write(`/${STATUS_COMMAND}`)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, `/${STATUS_COMMAND}`)
        && text.includes(`/${STATUS_COMMAND}`)
        && text.includes('Inspect context, request recovery, and model routing')
        && !text.includes('[DSH-TUI/local]'),
      'local Status projection discovery',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim() === 'Status'
        && text.includes('Context')
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
      'official token-meter Status section',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.includes('DSH-TUI ·')
        && text.includes('CTX [')
        && !text.includes('Request recovery'),
      'Status panel dismissal',
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

    ptyState.pty.write('/context')
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim() === 'Status'
        && text.includes(`Session  ${sessionId}`)
        && text.includes('Last: completed')
        && text.includes('items · ~'),
      'post-compaction Status panel through the /context alias',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.includes('DSH-TUI ·')
        && text.includes('CTX [')
        && !text.includes('Request recovery'),
      'post-compaction Status panel dismissal',
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
        requiresConfirmation: true,
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
        requiresConfirmation: true,
      },
      options.timeoutMilliseconds,
    )
    await openPermissionControl(
      ptyState,
      'read-only',
      options.timeoutMilliseconds,
    )
    await assertWorkspaceResizeMatrix(ptyState, 'permission', () => mockMonitor.records.filter(record => record?.type === 'request').length, options.timeoutMilliseconds)
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim() !== 'Permission Presets'
        && text.includes(`DSH-TUI · ${sessionId} · idle`),
      'official permission control close',
      options.timeoutMilliseconds,
    )
    const permissionModelRequests = mockMonitor.records
      .filter(record => record?.type === 'request').length - permissionRequestBaseline
    assert.equal(permissionModelRequests, 0, 'local permission control unexpectedly invoked the model')

    const mainPreExitScreen = screenText(ptyState.terminal)
    ptyState.pty.write('\x03')
    let ptyExit
    try {
      ptyExit = await withDeadline(
        ptyState.exitPromise,
        options.timeoutMilliseconds,
        'DSH-TUI clean Ctrl+C exit',
      )
    } catch (error) {
      throw new Error(
        `${errorMessage(error)}\nscreen before Ctrl+C:\n${outputExcerpt(mainPreExitScreen)}`
        + `\nscreen after Ctrl+C:\n${outputExcerpt(screenText(ptyState.terminal))}`,
        { cause: error },
      )
    }
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
      (lines, text) => commandSearchLineVisible(lines, '')
        && !text.includes('> /comp')
        && !text.includes('/compact')
        && !text.includes('Compact context'),
      'default-Standard command probe clear',
      options.timeoutMilliseconds,
    )

    ptyState.pty.write(`/${MODE_COMMAND}`)
    await waitForScreen(
      ptyState,
      (lines, text) => commandSearchLineVisible(lines, `/${MODE_COMMAND}`)
        && text.includes('Open modes')
        && !text.includes('[DSH-TUI/local]')
        && !text.includes('Up/Down select'),
      'local Agent-mode command discovery',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim().startsWith('Modes') === true && text.includes('Modes 4')
        && text.includes('Current standard')
        && lines.some(line => line.includes('› 标准模式') && line.includes('current'))
        && text.includes('PTC 模式')
        && text.includes('极简模式')
        && text.includes('创造模式'),
      'live Modes Feature roster',
      options.timeoutMilliseconds,
    )
    await assertWorkspaceResizeMatrix(ptyState, 'modes', () => mockMonitor.records.filter(record => record?.type === 'request').length, options.timeoutMilliseconds, modesViewportReady)
    await moveSelectionTo(
      ptyState,
      '极简模式',
      'minimal Agent mode',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim().startsWith('Modes') === true && text.includes('Modes 4')
        && text.includes('Current minimal')
        && lines.some(line => line.includes('› 极简模式')),
      'same-Session Modes Feature selection settlement',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${minimalSessionId} · idle`)
        && !text.includes('q back'),
      'same-Session Modes Feature dismissal',
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
      (lines, text) => lines[0]?.trim().startsWith('Modes') === true && text.includes('Modes 4')
        && text.includes('Current minimal')
        && lines.some(line => line.includes('› 极简模式') && line.includes('current')),
      'same-Session Modes Feature recompose',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${minimalSessionId} · idle`)
        && !text.includes('q back'),
      'recomposed Modes Feature dismissal',
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
      (lines, text) => commandSearchLineVisible(lines, '')
        && !text.includes('> /comp')
        && !text.includes('No matches for /comp')
        && !text.includes('/compact'),
      'recomposed command probe clear',
      options.timeoutMilliseconds,
    )
    assert.equal(
      mockMonitor.records.filter(record => record?.type === 'request').length,
      minimalRequestBaseline,
      'the local /modes flow unexpectedly reached the mock LLM',
    )
    const afterModeSelection = await sessionLogPaths(dshHome)
    assert.equal(
      afterModeSelection.raw.length,
      3,
      'the durable /modes selection did not materialize exactly one Session artifact',
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
      (lines, text) => commandSearchLineVisible(lines, `/${COMMAND_NAME}`)
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
      lines => commandSearchLineVisible(lines, MINIMAL_SEED_PROMPT),
      'minimal seed prompt editor echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('› ' + MINIMAL_SEED_PROMPT)
        && text.includes('● ' + RESPONSE)
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
        && text.includes('Open modes'),
      'started-session Agent-mode command discovery',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (lines, text) => lines[0]?.trim().startsWith('Modes') === true && text.includes('Modes 4')
        && text.includes('Current minimal')
        && text.includes('Session started · mode locked · /new to choose another'),
      'started-session Modes Feature lock',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(
        'Last operation failed · This Session has already started',
      ),
      'started-session Modes Feature selection gate',
      options.timeoutMilliseconds,
    )
    assert.equal(
      mockMonitor.records.filter(record => record?.type === 'request').length,
      lockedModeRequestBaseline,
      'the locked /modes flow unexpectedly reached the mock LLM',
    )
    ptyState.pty.write('\x1b')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes(`DSH-TUI · ${minimalSessionId} · idle`)
        && !text.includes('q back'),
      'locked Modes Feature dismissal',
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
        && text.includes('› ' + MINIMAL_SEED_PROMPT)
        && text.includes('● ' + RESPONSE)
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
      lines => commandSearchLineVisible(lines, RESUME_PROMPT),
      'cold-resume followup editor echo',
      options.timeoutMilliseconds,
    )
    ptyState.pty.write('\r')
    await waitForScreen(
      ptyState,
      (_lines, text) => text.includes('› ' + RESUME_PROMPT)
        && text.includes('● ' + RESPONSE)
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
    const missingExit = await waitForPtyExit(
      ptyState,
      options.timeoutMilliseconds,
      'missing cold resume exit',
    )
    if (missingExit.recovered === true) {
      interactionEvidence.push({ case: 'missing-resume-pty-exit-recovered-via-process-gone', modelRequestDelta: 0 })
    } else {
      assert.equal(missingExit.exitCode, 1)
      assert.equal(missingExit.signal, undefined)
    }
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
      assertSuccessfulMockResult(matchingResults[0])
    }
    mockChild = undefined

    const session = await assertSessionLog(
      dshHome,
      workspace,
      sessionId,
      'standard',
      PICKED_MODEL,
    )
    assert.deepEqual(
      [...new Set(workspaceResizeEvidence.map(entry => entry.page))].sort(),
      [...WORKSPACE_RESIZE_PAGES].sort(),
      'ConPTY Workspace resize evidence omitted a regular directory',
    )
    for (const page of WORKSPACE_RESIZE_PAGES) {
      assert.deepEqual(
        workspaceResizeEvidence.filter(entry => entry.page === page).map(({ columns, rows }) => [columns, rows]),
        WORKSPACE_RESIZE_SIZES,
        `${page} did not complete the exact ConPTY viewport matrix`,
      )
    }
    const resizePayload = JSON.stringify(workspaceResizeEvidence, null, 2)
    assert.equal(resizePayload.includes(MOCK_API_KEY), false, 'Provider key escaped into Workspace resize evidence')
    const artifactsRoot = join(options.dshTuiRoot, '.artifacts')
    await mkdir(artifactsRoot, { recursive: true })
    const resizeEvidencePath = await mkdtemp(join(artifactsRoot, 'official-e2e-workspaces-'))
    await writeFile(join(resizeEvidencePath, 'screens.json'), `${resizePayload}\n`)
    await writeFile(join(resizeEvidencePath, 'interactions.json'), `${JSON.stringify(interactionEvidence, null, 2)}\n`)
    assert.deepEqual(navigationEvidence.map(item => item.name), [
      'settings-theme-picker-arrows-jk', 'provider-directory-arrows-jk-bursts', 'provider-manage-arrows-jk-bursts',
    ], 'navigation acceptance did not exercise every required surface')
    assert.deepEqual(navigationEvidence.map(item => [item.inputEvents, item.verifiedTransitions]), [[24, 24], [48, 24], [48, 24]])
    await writeFile(join(resizeEvidencePath, 'navigation-latency.json'), `${JSON.stringify(navigationEvidence, null, 2)}\n`)
    const clientRequests = []
    for (const path of [productWritesPath, toolchainProductWritesPath, minimalProductWritesPath, resumeProductWritesPath]) {
      if (!existsSync(`${path}.requests.jsonl`)) continue
      clientRequests.push({ lane: basename(path),
        records: (await readFile(`${path}.requests.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) })
    }
    await writeFile(join(resizeEvidencePath, 'request-lifecycle.json'), `${JSON.stringify({
      clientRequests, serverRecords: mockMonitor.records,
      modeSelections: minimalSeedSession.rows.filter(row => row.type === 'agent-preset/selected'),
    }, null, 2)}\n`)
    evidence = {
      resizeEvidencePath,
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
      providerTestRequests: toolchain.providerTestRequests,
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
    if (primaryError !== undefined) {
      try {
        const diagnosticsRoot = join(options.dshTuiRoot, '.artifacts')
        await mkdir(diagnosticsRoot, { recursive: true })
        const diagnosticsPath = await mkdtemp(join(diagnosticsRoot, 'official-e2e-failure-'))
        await writeFile(join(diagnosticsPath, 'workspace-screens.json'), `${JSON.stringify(workspaceResizeEvidence, null, 2)}\n`)
        await writeFile(join(diagnosticsPath, 'interactions.json'), `${JSON.stringify(interactionEvidence, null, 2)}\n`)
        await writeFile(join(diagnosticsPath, 'navigation-latency.json'), `${JSON.stringify(navigationEvidence, null, 2)}\n`)
        await writeFile(join(diagnosticsPath, 'mock-records.json'), `${JSON.stringify(mockMonitor?.records ?? [], null, 2)}\n`)
        const modeSelections = []
        for (const path of (await sessionLogPaths(dshHome)).raw) {
          const rows = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
          modeSelections.push({ sessionDirectory: basename(dirname(path)),
            events: rows.filter(row => row.type === 'agent-preset/selected') })
          await writeFile(
            join(diagnosticsPath, `session-log-${basename(dirname(path))}-${basename(path)}`),
            `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
          )
        }
        await writeFile(join(diagnosticsPath, 'mode-selections.json'), `${JSON.stringify(modeSelections, null, 2)}\n`)
        for (const path of [productWritesPath, toolchainProductWritesPath, minimalProductWritesPath, resumeProductWritesPath, missingProductWritesPath]) {
          for (const suffix of ['', '.stderr.jsonl', '.warnings.jsonl', '.requests.jsonl']) {
            if (!existsSync(`${path}${suffix}`)) continue
            await writeFile(join(diagnosticsPath, `${basename(path)}${suffix}`), await readFile(`${path}${suffix}`))
          }
        }
        process.stderr.write(`OFFICIAL_DSH_E2E_DIAGNOSTICS ${diagnosticsPath}\n`)
      } catch (error) {
        cleanupErrors.push(new Error(`diagnostic capture failed: ${errorMessage(error)}`, { cause: error }))
      }
    }
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
      if (process.env.DSH_TUI_E2E_KEEP_WORKSPACE === '1') {
        process.stderr.write(`OFFICIAL_DSH_E2E_KEPT_WORKSPACE ${safeRoot}\n`)
      } else {
        await rm(safeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        assert.equal(existsSync(safeRoot), false, `temporary root remained after cleanup: ${safeRoot}`)
      }
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
} else if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gateStarted = performance.now()
  try {
    const evidence = await execute(parseArguments(process.argv.slice(2)))
    process.stdout.write(
      `OFFICIAL_DSH_E2E_OK profile=${PROFILE_NAME} initial=${INITIAL_COLUMNS}x${INITIAL_ROWS} elapsed_ms=${Math.round(performance.now() - gateStarted)} `
      + `resized=${RESIZED_COLUMNS}x${RESIZED_ROWS} mock=request+result session=contiguous `
      + `workspace_resize=80x24+100x30+140x30+200x30+80x6 workspace_pages=${WORKSPACE_RESIZE_PAGES.length} workspace_model_requests=0 `
      + `workspace_screens=${JSON.stringify(evidence.resizeEvidencePath)} `
      + 'approval_inspection=80x6-controls+80x3-fail-closed+argument-tail+default-reject+draft-preserved approval_details=explicit+scope-preview-3-to-2 ctrl_o=draft+cursor+visible-response+model-requests-0 '
      + `providers=dynamic-${evidence.providerDirectoryCount} connect=deepseek-official+openai `
      + `provider_credentials=isolated provider_models=live provider_model_requests=${evidence.providerConnectModelRequests} `
      + `command=${COMMAND_NAME} command_events=paired command_model_requests=${evidence.commandModelRequests} `
      + `catalog=live-switch-current-noop catalog_events=none catalog_model_requests=${evidence.catalogModelRequests} catalog_title=official-snapshot+search+requests-0 `
      + `statusline=model+effort+context+cache+tokens status=official-token-meter+request-recovery+model-route `
      + `context_model_requests=${evidence.contextInspectionModelRequests} `
      + `compact=official-execution+durable-transaction+live-status `
      + `compaction_model_requests=${evidence.compactionModelRequests} `
      + `permission=official-projection+command-switch+restored-read-only permission_model_requests=${evidence.permissionModelRequests} `
      + `model_picker=session-to-${PICKED_MODEL}+off model_picker_requests=${evidence.modelPickerModelRequests} `
      + 'booted_profile=verified global_tools=empty fresh_preset=standard '
      + 'startup_mode=standard-direct mode_switch=standard-to-minimal-same-session+locked-after-first-turn '
      + 'mode_catalog=standard-compact-to-minimal-no-compact '
      + 'skills=user-picker+literal-token+official-pre-step-injection+model-tool '
      + 'fresh_presets=standard mode_selected_events=minimal-once alt_screen=once-per-process '
      + 'host_rows=exact catalogs=cold-after-fresh-exact audit_generation=owned '
      + 'guidance=standard-exact-scoped-section complete_prompt=resumed-minimal-persona-only time_context=profile+fresh-resume-snapshots image_admission=official-memory-png+malformed-rejected '
      + `tool_directory=exact-agent-${SESSION_STANDARD_TOOLS.length}+read-only+model-requests-0 `
      + 'capabilities=alias-opened+categories+skills-detail-modal+tools-schema-modal+mcp-empty '
      + 'runtime_library=settings-redacted-browse+loader-read-only+model-requests-0 '
      + 'settings_form=four-categories+typed-validation+save-cancel+requests-0 '
      + 'settings_document=mono-saved+cancel-preserved+auto-restored '
      + 'settings_interaction=q-clean-dirty+picker-confirm-cancel+q-in-search-editor '
      + 'settings_permission=full-access-warning+cancel-no-write '
      + `settings_providers=home+directory+configure+select-model+explicit-test+q-return provider_browse_requests=0 provider_test_requests=${evidence.providerTestRequests} provider_test_session_writes=0 `
      + `settings_provider_polish=grouped-models+unique-name+badge-independent+bottom-shortcuts+bounded-directory-tail `
      + `settings_provider_manage=form-three-sections+field-controls+running+success-green+failure-red+cancelled `
      + 'navigation=arrows+jk+bursts inputs=120 verified_transitions=72 navigation_latency=diagnostic-p50-p95 '
      + 'mcp_directory=exact-agent-empty+health-not-inferred+model-requests-0 '
      + `standard_toolchain=catalog-${STANDARD_TOOLS.length}+calls-${evidence.toolchainToolCalls}`
      + '+approval-allow-reject+question-answer-cancel+goal-action-pause-resume-pause+plan-review-approve+job-run-kill '
      + 'workbench=goal-active-paused-active-paused+plan-on-review-off+todo-live+activity-live-killed '
      + `toolchain_model_requests=${evidence.toolchainModelRequests} `
      + `toolchain_retry_requests=${evidence.toolchainRetryRequests} `
      + 'request_recovery=official-retry+statusline+status-workspace '
      + 'request_route=official-header-context+status-workspace '
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
