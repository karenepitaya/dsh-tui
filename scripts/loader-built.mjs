import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Commands from '@deepseek-ai/dsh-commands'
import SessionStore from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const tempRoot = resolve(tmpdir())
const tempDirectory = resolve(await mkdtemp(join(tempRoot, 'dsh-tui-loader-')))
const relativeTemp = relative(tempRoot, tempDirectory)
if (relativeTemp === '' || relativeTemp.startsWith(`..${sep}`) || isAbsolute(relativeTemp)) {
  throw new Error(`refusing unsafe Loader smoke directory: ${tempDirectory}`)
}

const ctx = new Context()
try {
  const entryUrl = pathToFileURL(resolve(projectRoot, 'lib/index.js')).href
  const built = await import(entryUrl)
  if ('default' in built) {
    throw new Error('function plugin must not export default')
  }
  if (built.name !== 'dsh-tui') {
    throw new Error('built DSH-TUI plugin has an unexpected name')
  }
  const configPath = join(tempDirectory, 'cordis.yml')
  await writeFile(configPath, [
    '- id: dsh-tui-built',
    `  name: '${entryUrl.replaceAll("'", "''")}'`,
    '',
  ].join('\n'), 'utf8')

  ctx.baseUrl = `${pathToFileURL(tempDirectory).href}/`
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModel, { provider: 'smoke', model: 'smoke' })
  ctx.provide('agentPresets', {})
  ctx.provide('tools', { schemas: () => [] })
  await ctx.plugin(Commands)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  if (ctx.loader.unwrapExports(built) !== built) {
    throw new Error('Loader changed the built DSH-TUI namespace')
  }
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  const service = ctx.get('dshTui')
  if (service === undefined) {
    throw new Error('built DSH-TUI plugin did not provide ctx.dshTui through Loader')
  }
  if (typeof service.catalog?.listSessions !== 'function') {
    throw new Error('built DSH-TUI plugin did not expose the root session catalog')
  }
  const catalog = await service.catalog.listSessions()
  if (catalog.durability !== 'unavailable' || catalog.sessions.length !== 0) {
    throw new Error('built DSH-TUI session catalog did not tolerate an absent persistence backend')
  }
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'dsh-tui-built')
  if (entry?.fiber === undefined) {
    throw new Error('built DSH-TUI Loader entry did not activate')
  }
  const actualInject = Object.keys(entry.fiber.inject).sort()
  const expectedInject = [
    'agentDefaultModel',
    'agentPresets',
    'agents',
    'approval',
    'commands',
    'sessions',
    'tools',
    'userQuestions',
  ]
  if (JSON.stringify(actualInject) !== JSON.stringify(expectedInject)) {
    throw new Error(`unexpected DSH-TUI injections: ${actualInject.join(', ')}`)
  }
} finally {
  try {
    await ctx.fiber.dispose()
    if (ctx.get('dshTui') !== undefined) {
      throw new Error('ctx.dshTui survived root disposal')
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}
