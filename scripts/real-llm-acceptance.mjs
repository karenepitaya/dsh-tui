#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { EXPECTED_GUIDANCE_SHA256 } from './official-dsh-profile-audit.mjs'

const runFile = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))
const harness = resolve(project, '../deepseek-harness')
const cli = join(harness, 'apps/cli/lib/bin.js')
const localRequire = createRequire(join(harness, 'packages/credentials/credentials-local/package.json'))
const YAML = localRequire('yaml')
const profileName = 'real-llm-acceptance'
const reference = 'XIAOMI_TOKEN_PLAN_CN_API_KEY'
const provider = 'xiaomi-token-plan-cn'
const model = 'mimo-v2.5-pro'
const rootArg = process.argv.find(argument => argument.startsWith('--root='))?.slice(7)
const artifacts = join(project, '.artifacts')
await mkdir(artifacts, { recursive: true })
const root = rootArg === undefined ? await mkdtemp(join(artifacts, 'real-llm-')) : resolve(rootArg)
assert.ok(root.startsWith(artifacts + '\\') || root.startsWith(artifacts + '/'), 'Acceptance root must be inside .artifacts')
const home = join(root, 'dsh-home')
const workspace = join(root, 'workspace')
const profile = join(home, 'profiles', profileName)
const reportPath = join(root, 'summary.json')
const shutdownOnly = process.argv.includes('--shutdown-only')
const userHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const credentialPath = join(userHome, '.credentials.yaml')
const settingsPath = join(userHome, 'settings.yaml')
const settingsBefore = await readFile(settingsPath)
const credentialsBefore = await readFile(credentialPath)
const settings = YAML.parse(settingsBefore.toString('utf8'))
assert.deepEqual(settings['agent-default-model'], { provider, model }, 'Real model selection changed; re-audit the selected route')
const configured = settings['llm-pi-ai'].providers[provider]
assert.equal(configured.apiKeyEnv, reference)
assert.deepEqual(Object.keys(configured).sort(), ['apiKeyEnv', 'models'], 'Provider configuration changed; re-audit safe projection')
const selected = configured.models.find(entry => entry.id === model)
assert.ok(selected)
const { parseCredentialsDocument } = await import(pathToFileURL(localRequire.resolve('@deepseek-ai/dsh-credentials-local')).href)
const selectedSecret = parseCredentialsDocument(credentialsBefore.toString('utf8'), credentialPath).refs.get(reference)
assert.ok(selectedSecret, 'Selected credential is absent')
const verificationFixture = "import assert from 'node:assert/strict'\nimport { add } from './calc.mjs'\nassert.equal(add(2, 4), 6)\nassert.equal(add(-3, 1), -2)\nconsole.log('DSH_REAL_VERIFY_OK')\n"
const callAuditPath = join(root, 'model-calls.jsonl')

for (const path of [profile, join(profile, 'node_modules'), join(workspace, '.git')]) await mkdir(path, { recursive: true })
// Stage built files without source node_modules so Harness peers resolve through
// the official launcher's single profiles/node_modules fallback.
for (const [name, target, build] of [['dsh-tui', project, 'lib'], ['pi-tui-orbs', resolve(project, '../pi-tui-orbs'), 'dist']]) {
  const destination = join(profile, 'node_modules', name)
  if (existsSync(destination) && (await lstat(destination)).isSymbolicLink()) {
    assert.equal(await realpath(destination), await realpath(target))
    await unlink(destination)
  }
  await mkdir(destination, { recursive: true })
  await cp(join(target, build), join(destination, build), { recursive: true })
  await cp(join(target, 'package.json'), join(destination, 'package.json'))
  if (name === 'dsh-tui') await cp(join(target, 'cordis.patch.yml'), join(destination, 'cordis.patch.yml'))
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@deepseek-ai/') || dependency === 'pi-tui-orbs') continue
    const linked = join(profile, 'node_modules', dependency)
    if (!existsSync(linked)) {
      await mkdir(dirname(linked), { recursive: true })
      await symlink(await realpath(join(target, 'node_modules', dependency)), linked, 'junction')
    }
  }
}
await writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-tui-real-llm-acceptance', private: true, type: 'module',
  dependencies: { 'dsh-tui': `file:${project.replaceAll('\\', '/')}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-tui'] } },
}, null, 2))
await writeFile(join(profile, 'cordis.patch.yml'), YAML.stringify([
  { id: 'dsh-tui', config: { autoStart: true } },
  { id: 'agent-default-model', config: { provider, model } },
  { id: 'llm-pi-ai', config: { providers: { [provider]: { apiKeyEnv: reference, models: [selected], timeoutMs: 120000, streamIdleTimeoutMs: 120000, retryPolicy: { mode: 'normal', maxRetries: 0 } } } } },
  { id: 'credentials', disabled: true },
  { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none', packChunks: false } },
  { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: workspace } },
  { insert: [
    { id: 'acceptance-readonly-credentials', name: pathToFileURL(join(project, 'scripts/real-llm-readonly-credentials.mjs')).href, config: { path: credentialPath, reference } },
    { id: 'acceptance-call-audit', name: pathToFileURL(join(project, 'scripts/real-llm-call-audit.mjs')).href, config: { path: callAuditPath, workspace, verificationSha256: createHash('sha256').update(verificationFixture).digest('hex') } },
    { id: 'dsh-tui-real-profile-audit', name: pathToFileURL(join(project, 'scripts/official-dsh-profile-audit.mjs')).href },
  ] },
]))
if (rootArg === undefined) {
  await writeFile(join(workspace, 'AGENTS.md'), 'Use Chinese. Work only inside this fixture directory. Do not read environment variables, credentials, user files, or parent directories. Preserve unrelated files. Run node calc.test.mjs after changing calc.mjs. Report failed tools honestly. Do not retry a rejected approval.\n')
  await writeFile(join(workspace, 'README.md'), '# Acceptance fixture\nThis project exports add(a,b) in calc.mjs. calc.test.mjs checks addition. Fixture marker: DSH_REAL_SCAN_2026.\n')
  await writeFile(join(workspace, 'calc.mjs'), 'export function add(a, b) { return a - b }\n')
  await writeFile(join(workspace, 'calc.test.mjs'), verificationFixture)
  await writeFile(join(workspace, 'unrelated.txt'), 'PRESERVE_ME\n')
}
const env = Object.fromEntries(Object.entries({
  ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write',
  DSH_TOOLS_MODE: 'native', DSH_TUI_E2E_PROFILE_AUDIT_PATH: join(root, 'profile-audit.json'),
  TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1',
}).filter(([key, value]) => value !== undefined && !/(API_KEY|TOKEN|SECRET|PASSWORD|DSH_TUI_E2E_PRELOAD|DSH_TUI_E2E_WRITES_PATH)/iu.test(key)))
const dump = await runFile(process.execPath, [cli, '--profile', profileName, '--dump-config'], { cwd: workspace, env, windowsHide: true, timeout: 60000 })
assert.ok(dump.stdout.includes('real-llm-readonly-credentials.mjs'), 'Isolated profile omitted read-only authentication')
assert.ok(dump.stdout.includes(home.replaceAll('\\', '\\\\')) || dump.stdout.includes(home), 'Isolated profile dump omitted storage root')
const report = { root, workspace, provider, model, credentialReference: reference, credentialTransport: 'readonly-official-parser-in-memory', source: 'real-provider', kind: shutdownOnly ? 'shutdown-only' : 'five-behavior-cases', stages: [] }
async function saveReport() {
  const serialized = JSON.stringify(report, null, 2)
  assert.ok(!serialized.includes(selectedSecret), 'Credential unexpectedly appeared in acceptance evidence')
  await writeFile(reportPath, serialized)
}
await saveReport()
if (process.argv.includes('--prepare-only')) {
  console.log(JSON.stringify({ prepared: true, root, provider, model, credentialConfigured: true, isolatedProfile: true }))
  process.exit(0)
}

const ptyRequire = createRequire(join(harness, 'packages/subprocess/subprocess-local/package.json'))
const { Terminal } = createRequire(join(project, 'package.json'))('@xterm/headless')
const nodePty = ptyRequire('node-pty')
const terminal = new Terminal({ cols: 120, rows: 36, allowProposedApi: true })
const pty = nodePty.spawn(process.execPath, [cli, '--profile', profileName, '--cwd', workspace], { name: 'xterm-256color', cols: 120, rows: 36, cwd: workspace, env })
let exited = false
let exitCode
let outputBytes = 0
let raw = ''
async function stabilizeWindowsPtyExit(exit) {
  if (process.platform !== 'win32' || exit.exitCode !== undefined) return exit
  // The pinned ConPTY adapter can close stdout before its native exit callback.
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
    if (pty._agent?.exitCode !== undefined) return { ...exit, exitCode: pty._agent.exitCode }
  }
  return exit
}
const exitPromise = new Promise(resolveExit => pty.onExit(exit => {
  exited = true
  void stabilizeWindowsPtyExit(exit).then(settled => {
    exitCode = settled.exitCode
    resolveExit(settled)
  })
}))
pty.onData(data => {
  outputBytes += Buffer.byteLength(data)
  raw = (raw + data).slice(-500000)
  terminal.write(data)
})
const screen = () => Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n')
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
async function waitUntil(predicate, label, limit = 180000) {
  const deadline = Date.now() + limit
  while (Date.now() < deadline) {
    if (await predicate()) return
    if (exited) throw new Error(`Process exited before ${label}; code=${exitCode}`)
    await sleep(150)
  }
  throw new Error(`Timed out: ${label}`)
}
async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}
async function events() {
  const paths = (await files(join(home, 'sessions'))).filter(path => path.endsWith('.jsonl'))
  const result = []
  for (const path of paths) {
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue
      try { const row = JSON.parse(line); if (row.type !== 'session') result.push(row) } catch (error) {
        if (index !== lines.length - 1) throw error
      }
    }
  }
  return result
}
function contentText(value) {
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n')
  if (value === null || typeof value !== 'object') return ''
  if (value.type === 'text' && typeof value.text === 'string') return value.text
  return contentText(value.content ?? value.message?.content)
}
async function callAudit() {
  const text = await readFile(callAuditPath, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function submit(id, prompt, approval = false) {
  const before = await events()
  const beforeCalls = (await callAudit()).filter(event => event.event === 'start').length
  const endCount = before.filter(event => event.type === 'turn/end').length
  const start = Date.now()
  pty.write(prompt)
  await waitUntil(() => screen().includes(prompt.slice(0, 16)), `${id} prompt echo`, 15000)
  pty.write('\r')
  if (approval) {
    await waitUntil(() => screen().includes('─ Permission request') && screen().includes('Tool / call: write / ') && screen().includes('› 2 Reject'), 'real write approval defaults to Reject')
    report.rejectionScreen = { defaultReject: true, exactTool: 'write', requestedWorkspaceWrite: screen().includes('workspace-write (this call only)') }
    pty.write('\r')
  }
  await waitUntil(async () => (await events()).filter(event => event.type === 'turn/end').length > endCount && /DSH-TUI · .+ · idle/u.test(screen()), `${id} completed turn`, 600000)
  const after = await events()
  const fresh = after.slice(before.length)
  const final = fresh.filter(event => event.type === 'assistant/message').map(event => contentText(event.data)).filter(Boolean).join('\n')
  const toolResults = fresh.filter(event => event.type === 'tool/result')
  const stage = {
    id, elapsedMs: Date.now() - start, reason: fresh.findLast(event => event.type === 'turn/end')?.data?.reason,
    toolCalls: fresh.filter(event => event.type === 'tool/call').map(event => ({ name: event.data.name, callId: event.data.callId, arguments: JSON.parse(event.data.arguments) })),
    toolResults: toolResults.map(event => ({ callId: event.data.message.source.callId, error: event.data.message.content.some(part => part.isError === true), text: contentText(event.data).slice(0, 2000) })),
    final, screen: screen(), timeSnapshots: fresh.filter(event => event.type === 'user/message' && event.data.source?.plugin === 'time-context').length,
    modelCalls: (await callAudit()).filter(event => event.event === 'start').length - beforeCalls,
    approvalsAsked: fresh.filter(event => event.type === 'approval/asked').map(event => ({ id: event.data.id })),
    approvalsDecided: fresh.filter(event => event.type === 'approval/decided').map(event => ({ id: event.data.id, outcome: event.data.outcome })),
  }
  report.stages.push(stage)
  await saveReport()
  assert.equal(stage.reason?.kind, 'completed', `${id} did not complete normally`)
  assert.ok(final.length > 0, `${id} omitted its final answer`)
  console.log(JSON.stringify({ stage: id, completed: true, tools: stage.toolCalls.map(call => call.name), errors: stage.toolResults.filter(result => result.error).length, elapsedMs: stage.elapsedMs }))
  return stage
}

try {
  await waitUntil(() => /DSH-TUI · .+ · idle/u.test(screen()), 'initial real-model idle', 60000)
  await waitUntil(() => existsSync(join(root, 'profile-audit.json')), 'profile audit publication', 60000)
  const audit = JSON.parse(await readFile(join(root, 'profile-audit.json'), 'utf8'))
  report.guidance = audit.freshAgent?.systemPrompt ?? audit.fresh?.systemPrompt
  assert.equal(report.guidance?.guidanceTextSha256, EXPECTED_GUIDANCE_SHA256, 'Current guidance was not installed')
  console.log(JSON.stringify({ started: true, root, provider, model, guidance: 'verified' }))
  if (!shutdownOnly) {
  report.expectedLocalDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const qa = await submit('question-time', '请用中文简短回答：2+2等于多少？当前进程的本地日期（YYYY-MM-DD）和时区是什么？依据本轮运行时提供的时间上下文；如果不知道用户时区请明确说明。无需调用工具。')
  assert.match(qa.final.replaceAll('*', ''), /2\s*\+\s*2\s*(?:=|＝|等于|是)\s*4/u, 'Basic arithmetic answer was incorrect')
  assert.ok(qa.final.includes(report.expectedLocalDate) && /Asia\/Shanghai|\+08:00|UTC\+8/u.test(qa.final), 'Answer did not reflect local runtime date/timezone')
  assert.equal(qa.toolCalls.length, 0)
  const scan = await submit('project-scan', '只扫描当前隔离项目：直接用 read 工具读取 AGENTS.md、README.md、calc.mjs 和 calc.test.mjs（可在同一回复并行调用四次，无需先 glob），说明这个项目做什么、可能的缺陷及应执行的验证命令。此轮不要修改任何文件。不要读取父目录、环境变量或凭据。')
  assert.ok(scan.toolCalls.length > 0 && scan.final.includes('calc.mjs') && scan.final.includes('calc.test.mjs'), 'Project scan lacked concrete file evidence')
  for (const name of ['AGENTS.md', 'README.md', 'calc.mjs', 'calc.test.mjs']) {
    assert.ok(scan.toolCalls.some(call => call.name === 'read'
      && resolve(workspace, call.arguments.file_path) === join(workspace, name)
      && scan.toolResults.some(result => result.callId === call.callId && !result.error)), `Project scan did not actually read ${name}`)
  }
  assert.equal(await readFile(join(workspace, 'calc.mjs'), 'utf8'), 'export function add(a, b) { return a - b }\n')
  const change = await submit('modify-verify', '现在修复 calc.mjs 的 add，使它正确相加：保留原函数声明，仅将 a - b 改成 a + b，不添加其他代码或注释；保留 calc.test.mjs 和 unrelated.txt 原样。遵循已读取的项目说明，用 edit 或 write 仅修改 calc.mjs，然后用 pwsh 真正执行命令 node calc.test.mjs 验证，最后如实报告实际结果。')
  assert.ok(change.toolResults.some(result => !result.error && result.text.includes('DSH_REAL_VERIFY_OK')), 'Model did not actually run successful validation')
  const verification = await runFile(process.execPath, ['calc.test.mjs'], { cwd: workspace, env, windowsHide: true, timeout: 15000 })
  assert.ok(verification.stdout.includes('DSH_REAL_VERIFY_OK'))
  assert.equal(await readFile(join(workspace, 'unrelated.txt'), 'utf8'), 'PRESERVE_ME\n')
  const failure = await submit('tool-failure', '验证工具失败处理：仅使用 read 工具读取当前项目内肯定不存在的 definitely-missing-acceptance.txt。收到失败后停止，不创建文件、不重试、不换工具，然后明确说明读取失败，不能声称读取或验证成功。')
  assert.equal(failure.toolCalls.length, 1)
  assert.equal(failure.toolCalls[0].name, 'read')
  assert.equal(resolve(workspace, failure.toolCalls[0].arguments.file_path), join(workspace, 'definitely-missing-acceptance.txt'))
  assert.equal(failure.toolResults.length, 1)
  assert.equal(failure.toolResults[0].error, true)
  assert.ok(/失败|不存在|找不到/u.test(failure.final))
  pty.write('/permission')
  await waitUntil(() => screen().includes('> /permission'), 'permission command echo', 15000)
  pty.write('\r')
  await waitUntil(() => screen().includes('Permission Presets · Workspace') && screen().includes('Current  workspace-write'), 'local permission workspace')
  pty.write('\x1b[A')
  await waitUntil(() => screen().includes('Target  read-only'), 'read-only candidate')
  pty.write('\r')
  await waitUntil(() => screen().includes('Permission preset switched: read-only'), 'read-only policy applied')
  const rejection = await submit('approval-rejected', '验证审批拒绝：只尝试一次 write 工具，在当前项目创建 denied.txt，内容为 REJECT_ME，并显式请求 sandbox_permissions="workspace-write"，说明这是隔离验收写入。等待我的审批；如果我拒绝，立即停止，不重试、不换工具、不改权限，然后明确告诉我未写入。', true)
  assert.equal(rejection.toolCalls.length, 1)
  assert.equal(rejection.toolCalls[0].name, 'write')
  assert.equal(resolve(workspace, rejection.toolCalls[0].arguments.file_path), join(workspace, 'denied.txt'))
  assert.equal(rejection.toolCalls[0].arguments.sandbox_permissions, 'workspace-write')
  assert.equal(rejection.toolResults[0]?.error, true)
  assert.ok(/reject|approval/iu.test(rejection.toolResults[0].text))
  assert.ok(/拒绝|未写入|没有.*写入/u.test(rejection.final))
  assert.equal(rejection.approvalsAsked.length, 1, 'Write never reached the real approval service')
  assert.deepEqual(rejection.approvalsDecided, [{ id: rejection.approvalsAsked[0].id, outcome: 'rejected' }])
  assert.equal(existsSync(join(workspace, 'denied.txt')), false)
  const durable = await events()
  assert.deepEqual(durable.map(event => event.seq), durable.map((_event, index) => index), 'Session sequence is not contiguous')
  report.timeSnapshots = durable.filter(event => event.type === 'user/message' && event.data.source?.plugin === 'time-context').length
  assert.ok(report.timeSnapshots >= 5)
  }
  report.passed = true
} catch (error) {
  report.passed = false
  report.failure = error instanceof Error ? error.message : String(error)
  report.failureScreen = screen()
  report.startupOutput = report.stages.length === 0 ? raw.slice(-10000) : undefined
  process.exitCode = 1
} finally {
  if (!exited) {
    pty.write('\x03')
    await Promise.race([exitPromise, sleep(5000)])
    if (!exited) pty.kill()
    await Promise.race([exitPromise, sleep(5000)])
  }
  await Promise.race([exitPromise, sleep(1500)])
  await new Promise(resolveWrite => terminal.write('', resolveWrite))
  report.exitCode = exitCode ?? pty._agent?.exitCode
  report.terminalRestored = terminal.buffer.active.type === 'normal'
  pty.kill()
  report.outputBytes = outputBytes
  report.settingsUnchanged = settingsBefore.equals(await readFile(settingsPath))
  report.credentialsUnchanged = credentialsBefore.equals(await readFile(credentialPath))
  if (report.passed && (report.exitCode !== 0 || !report.terminalRestored || !report.settingsUnchanged || !report.credentialsUnchanged)) {
    report.passed = false
    report.failure = 'Terminal exit or user configuration preservation failed'
    process.exitCode = 1
  }
  const modelAudit = await callAudit()
  report.modelCalls = modelAudit.filter(event => event.event === 'start').length
  report.completedModelCalls = modelAudit.filter(event => event.event === 'end' && event.completed).length
  report.fixtureGuardDenials = modelAudit.filter(event => event.event === 'scope-denied').length
  await saveReport()
  const artifactFiles = await files(root)
  for (const path of artifactFiles) assert.ok(!(await readFile(path)).includes(Buffer.from(selectedSecret)), 'Credential appeared in acceptance artifacts')
  report.secretScan = { filesScanned: artifactFiles.length, selectedCredentialAbsent: true }
  await saveReport()
  await writeFile(join(root, 'safety-summary.json'), JSON.stringify({
    scannedAt: new Date().toISOString(), ...report.secretScan,
    realSettingsUnchangedDuringRun: report.settingsUnchanged, realCredentialsUnchangedDuringRun: report.credentialsUnchanged,
    modelCalls: report.modelCalls, completedModelCalls: report.completedModelCalls, fixtureGuardDenials: report.fixtureGuardDenials,
  }, null, 2))
  assert.ok(report.settingsUnchanged && report.credentialsUnchanged, 'Real user configuration changed')
  console.log(JSON.stringify({ passed: report.passed, kind: report.kind, reportPath, exitCode: report.exitCode, terminalRestored: report.terminalRestored, stages: report.stages.length, modelCalls: report.modelCalls, settingsUnchanged: report.settingsUnchanged, credentialsUnchanged: report.credentialsUnchanged, failure: report.failure }))
  terminal.dispose()
}
