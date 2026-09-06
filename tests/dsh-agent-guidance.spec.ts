import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import * as TimeContext from '@deepseek-ai/dsh-time-context'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { DSH_AGENT_GUIDANCE, installDshAgentGuidance } from '../src/dsh/agent-guidance.ts'
import { createDshRc2AgentBootstrapAttempt } from '../src/compat/dsh-rc2/agent-bootstrap.ts'
import { ScopeManager } from '../src/lifecycle/scope-manager.ts'

const contexts: Context[] = []
const managers: ScopeManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function host(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, { persona: 'Selected persona.' })
  return ctx
}

function scopedAgent(ctx: Context, id: string) {
  const agent = { id: SessionId(id), session: Session.create(SessionId(id)) } as Agent
  const scope = createScope(ctx, agent)
  Object.assign(agent, { ctx: scope.ctx.extend({ agent }) })
  return { agent, dispose: scope.dispose }
}

describe('DSH Agent guidance official system-prompt contract', () => {
  it('keeps guidance and per-step time independent across two hosts, complete prompts, and unload', async () => {
    vi.stubEnv('TZ', 'UTC')
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-06T23:59:59Z'))
    const first = await host()
    const second = await host()
    const firstClock = await first.plugin(TimeContext, { refreshIntervalMs: 0 })
    const secondClock = await second.plugin(TimeContext, { refreshIntervalMs: 0 })
    const firstOwner = scopedAgent(first, 'same-local-id')
    const secondOwner = scopedAgent(second, 'same-local-id')
    firstOwner.agent.ctx.get('systemPrompt')!.section({ name: 'project:first', order: 25, text: 'First project instructions.' })
    installDshAgentGuidance(firstOwner.agent.ctx)
    installDshAgentGuidance(secondOwner.agent.ctx)
    const assemble = (ctx: Context, agent: Agent) => ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(renderPrompt(await assemble(first, firstOwner.agent))).toContain('First project instructions.')
    expect(renderPrompt(await assemble(second, secondOwner.agent))).not.toContain('First project instructions.')
    const step = (ctx: Context, agent: Agent) => agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    const firstStep = await step(first, firstOwner.agent)
    const secondStep = await step(second, secondOwner.agent)
    for (const decision of [firstStep, secondStep]) {
      expect(decision).toMatchObject({ kind: 'enter', messages: [{ source: { kind: 'plugin', plugin: 'time-context', form: 'snapshot' } }] })
      expect(JSON.stringify(decision)).toContain('2026-09-06T23:59:59+00:00[UTC]')
    }
    firstOwner.agent.ctx.get('systemPrompt')!.section({ name: 'user:complete', order: 0,
      text: 'Only the complete prompt.', complete: true })
    expect(renderPrompt(await assemble(first, firstOwner.agent))).toBe('Only the complete prompt.')
    expect((await assemble(second, secondOwner.agent)).sections)
      .toContainEqual(expect.objectContaining({ name: DSH_AGENT_GUIDANCE.name }))
    await firstClock.dispose()
    await firstOwner.dispose()
    await expect(step(first, firstOwner.agent)).resolves.toEqual({ kind: 'enter', messages: [] })
    expect((await assemble(first, firstOwner.agent)).sections)
      .not.toContainEqual(expect.objectContaining({ name: DSH_AGENT_GUIDANCE.name }))
    now.mockReturnValue(Date.parse('2026-09-07T00:00:01Z'))
    expect(JSON.stringify(await step(second, secondOwner.agent))).toContain('2026-09-07T00:00:01+00:00[UTC]')
    expect((await assemble(second, secondOwner.agent)).sections)
      .toContainEqual(expect.objectContaining({ name: DSH_AGENT_GUIDANCE.name }))
    await secondClock.dispose()
    await secondOwner.dispose()
    await expect(step(second, secondOwner.agent)).resolves.toEqual({ kind: 'enter', messages: [] })
  })

  it('is a concise additive order-50 section with explicit behavior and evidence boundaries', () => {
    expect(DSH_AGENT_GUIDANCE).toMatchObject({ name: 'dsh-tui:agent-guidance', order: 50 })
    expect(DSH_AGENT_GUIDANCE.complete).toBeUndefined()
    expect(Object.isFrozen(DSH_AGENT_GUIDANCE)).toBe(true)
    for (const text of [
      "user's language", 'concise by default', 'AGENTS.md', 'toolchain and lockfiles',
      'dirty changes', 'brief progress', 'not raw internal reasoning',
      'proposed plan', 'attempted action', 'verified result', 'unfinished work',
      'was not run', 'sandbox and approval', 'do not bypass', 'current time',
      'process time zone', "user's time zone",
    ]) expect(DSH_AGENT_GUIDANCE.text.toString().toLowerCase()).toContain(text.toLowerCase())
  })

  it('prepares before publication, isolates exact Agent scopes, and removes only owned guidance', async () => {
    const ctx = await host()
    const first = scopedAgent(ctx, 'guidance-first')
    const second = scopedAgent(ctx, 'guidance-second')
    const manager = new ScopeManager()
    managers.push(manager)
    const attempt = createDshRc2AgentBootstrapAttempt(manager.createSession(first.agent.id), {
      installModel: () => undefined,
      mountPreset: () => undefined,
      installGuidance: installDshAgentGuidance,
    })
    const prepared = await attempt.setup(first.agent.ctx)
    const firstAssembly = await ctx.systemPrompt.assemble(assembleContextFor(first.agent))
    expect(firstAssembly.sections.map(section => section.name)).toEqual([
      'harness:identity', 'deployment:persona', 'dsh-tui:agent-guidance',
    ])
    expect(renderPrompt(firstAssembly)).toContain('Selected persona.')
    expect((await ctx.systemPrompt.assemble()).sections).not.toContainEqual(
      expect.objectContaining({ name: DSH_AGENT_GUIDANCE.name }),
    )
    expect((await ctx.systemPrompt.assemble(assembleContextFor(second.agent))).sections)
      .not.toContainEqual(expect.objectContaining({ name: DSH_AGENT_GUIDANCE.name }))
    const disposeSecond = installDshAgentGuidance(second.agent.ctx)!
    prepared.commit()
    await attempt.ownHandle(first).dispose()
    expect((await ctx.systemPrompt.assemble(assembleContextFor(first.agent))).sections)
      .not.toContainEqual(expect.objectContaining({ name: DSH_AGENT_GUIDANCE.name }))
    expect((await ctx.systemPrompt.assemble(assembleContextFor(second.agent))).sections)
      .toContainEqual(expect.objectContaining({ name: DSH_AGENT_GUIDANCE.name }))
    disposeSecond()
    disposeSecond()
    // A fresh resume scope may register the same name without a global duplicate.
    const resumed = scopedAgent(ctx, first.agent.id)
    installDshAgentGuidance(resumed.agent.ctx)
    expect((await ctx.systemPrompt.assemble(assembleContextFor(resumed.agent))).sections)
      .toContainEqual(expect.objectContaining({ name: DSH_AGENT_GUIDANCE.name }))
    await resumed.dispose()
    expect((await ctx.systemPrompt.assemble(assembleContextFor(resumed.agent))).sections)
      .not.toContainEqual(expect.objectContaining({ name: DSH_AGENT_GUIDANCE.name }))
  })

  it('respects an official complete prompt and keeps no registration after setup fails', async () => {
    const ctx = await host()
    const owner = scopedAgent(ctx, 'guidance-complete')
    owner.agent.ctx.get('systemPrompt')!.section({
      name: 'user:complete', order: 0, text: 'User owns the complete prompt.', complete: true,
    })
    const manager = new ScopeManager()
    managers.push(manager)
    const attempt = createDshRc2AgentBootstrapAttempt(manager.createSession(owner.agent.id), {
      installModel: () => undefined,
      mountPreset: () => undefined,
      installGuidance: installDshAgentGuidance,
      setupDownstream: async () => {
        expect(renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(owner.agent))))
          .toBe('User owns the complete prompt.')
        throw new Error('setup failed')
      },
    })
    await expect(attempt.setup(owner.agent.ctx)).rejects.toThrow('setup failed')
    // If rollback leaked guidance, this exact-name registration would throw.
    expect(() => installDshAgentGuidance(owner.agent.ctx)).not.toThrow()
    expect(renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(owner.agent))))
      .toBe('User owns the complete prompt.')
  })

  it('cannot turn a host, untagged Agent, or another scoped context into global guidance', async () => {
    const bare = new Context()
    contexts.push(bare)
    expect(installDshAgentGuidance(bare)).toBeUndefined()
    const ctx = await host()
    expect(() => installDshAgentGuidance(ctx)).toThrow('exact Agent scope')
    const first = scopedAgent(ctx, 'first')
    const second = scopedAgent(ctx, 'second')
    expect(() => installDshAgentGuidance(ctx.extend({ agent: first.agent })))
      .toThrow('exact Agent scope')
    expect(() => installDshAgentGuidance(first.agent.ctx.extend({ agent: second.agent })))
      .toThrow('exact Agent scope')
    expect((await ctx.systemPrompt.assemble()).sections).toHaveLength(2)
  })
})
