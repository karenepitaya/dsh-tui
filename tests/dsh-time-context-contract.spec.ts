import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as TimeContext from '@deepseek-ai/dsh-time-context'
import { convertSessionEvent } from '../src/dsh/session-event-adapter.ts'
import { replayUiEvents } from '../src/transcript/reducer.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function bench(session = Session.create(SessionId('clock-contract')), config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  const plugin = ctx.plugin(TimeContext, config)
  await plugin
  const agent = { id: session.id, session, ctx } as Agent
  const events = agentEvents(ctx, agent)
  return {
    ctx, session, plugin,
    step: (turn: number, step: number, messages: UserMessage[] = [], options: {
      signal?: AbortSignal
      decision?: PreStepDecision
    } = {}) => events.waterfall('agent/pre-step', {
      messages, turn, step, signal: options.signal ?? new AbortController().signal,
    }, async () => options.decision ?? { kind: 'enter', messages }),
  }
}

function snapshot(decision: PreStepDecision): UserMessage {
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') throw new Error('expected eligible step')
  const message = decision.messages.at(-1)!
  expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'time-context', form: 'snapshot' })
  return message
}

function textOf(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

describe('published official rc.2 time-context contract', () => {
  it('pins the registry tarball that was integrity-checked, not a same-version workspace link', async () => {
    const require = createRequire(import.meta.url)
    const manifest = require('@deepseek-ai/dsh-time-context/package.json')
    expect(manifest.version).toBe('0.1.1-rc.2')
    const lock = await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
    // npm registry rc.2 tarball, downloaded and SHA512-verified for this integration.
    expect(lock).toContain('sha512-4Q1sCr06SfJ7jkhrvfdg8ZSFp5Ohtl4E9nH19nUbIjcGK8F5yA2h68HPEglztDo54vxI5HZSblLIjdGKZkY+FQ==')
    const code = await readFile(require.resolve('@deepseek-ai/dsh-time-context'))
    // Exact lib/index.js from that verified tarball, independent of the local checkout.
    expect(createHash('sha256').update(code).digest('hex'))
      .toBe('b89daa446c540d684bb96c5dde073689ebee22ffed4a952edc9cdbe529cbaefc')
    expect(TimeContext.inject).toEqual(['agents'])
  })

  it.each([{}, { refreshIntervalMs: 0 }])('samples first and subsequent eligible steps across midnight with process defaults: %j', async config => {
    vi.stubEnv('TZ', 'UTC')
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-05T23:59:59Z'))
    const clock = await bench(undefined, config)
    const user = createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } })
    const first = await clock.step(1, 1, [user])
    const reading = snapshot(first)
    expect(first).toMatchObject({ messages: [user, reading] })
    expect(textOf(reading)).toContain('2026-09-05T23:59:59+00:00[UTC]')
    expect(textOf(reading)).toContain('Browser time zone for this request: unavailable.')
    expect(textOf(reading)).toContain('model-visible message: unavailable')
    expect(reading.source).not.toHaveProperty('rpcId')
    expect(reading.source).not.toHaveProperty('clientTimeZone')
    clock.session.append('turn/start', { turn: 1 })
    clock.session.append('user/message', user, { surfaceOp: 'append' })
    clock.session.append('user/message', reading, { surfaceOp: 'append' })
    now.mockReturnValue(Date.parse('2026-09-06T00:00:01Z'))
    const second = snapshot(await clock.step(1, 2))
    expect(textOf(second)).toContain('2026-09-06T00:00:01+00:00[UTC]')
    expect(textOf(second)).toContain('step context: 2s')
    clock.session.append('user/message', second, { surfaceOp: 'append' })
    const state = replayUiEvents(clock.session.id, clock.session.events.map(event => convertSessionEvent(clock.session.id, event)))
    expect(state.sessions[clock.session.id]!.rows).toHaveLength(1)
    expect(state.sessions[clock.session.id]!.rows[0]).toMatchObject({ kind: 'user' })
  })

  it('refreshes a restored session on its first request and removes the plugin on unload', async () => {
    vi.stubEnv('TZ', 'Asia/Shanghai')
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-05T15:59:59Z'))
    const original = await bench(undefined, { refreshIntervalMs: 0 })
    original.session.append('user/message', snapshot(await original.step(1, 1)), { surfaceOp: 'append' })
    const restored = Session.create(original.session.id, original.session.events, original.session.header)
    await original.plugin.dispose()
    now.mockReturnValue(Date.parse('2026-09-06T16:00:01Z'))
    const resumed = await bench(restored, { refreshIntervalMs: 0 })
    const reading = snapshot(await resumed.step(2, 1))
    expect(textOf(reading)).toContain('2026-09-07T00:00:01+08:00[Asia/Shanghai]')
    expect(textOf(reading)).toContain('model-visible message: 1d 2s')
    await resumed.plugin.dispose()
    await expect(resumed.step(2, 2)).resolves.toEqual({ kind: 'enter', messages: [] })
  })

  it('does not inject on rejected or cancelled steps, including cancellation during downstream preparation', async () => {
    const clock = await bench()
    const rejected: PreStepDecision = { kind: 'reject' }
    await expect(clock.step(1, 1, [], { decision: rejected })).resolves.toBe(rejected)
    const abort = new AbortController()
    clock.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      abort.abort()
      return decision
    })
    await expect(clock.step(1, 1, [], { signal: abort.signal }))
      .resolves.toEqual({ kind: 'enter', messages: [] })
    expect(clock.session.events).toHaveLength(0)
  })
})
