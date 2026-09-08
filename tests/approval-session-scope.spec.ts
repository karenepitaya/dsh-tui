import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { DshInteractionHub, type DshInteractionSession } from '../src/dsh/interaction-hub.ts'
import {
  createInteractionEditorState,
  prepareInteractionSubmit,
  reconcileInteractionEditor,
  reduceInteractionEditor,
} from '../src/interaction/editor.ts'
import type { InteractionSnapshot, PendingApprovalInteraction } from '../src/interaction/port.ts'
import type { PermissionPolicy } from '../src/permission/port.ts'

interface Owner {
  session: Session
  agent: Agent
  port: DshInteractionSession
  iterator: AsyncIterator<InteractionSnapshot>
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(ApprovalService)
  const agents = new Map<SessionId, Agent>()
  const modes = new Map<SessionId, PermissionPolicy['sandboxMode']>()
  ctx.provide('agents', { get: (id: SessionId) => agents.get(id) } as never)
  ctx.provide('sandboxPolicy' as never, {
    resolve: ({ session }: { session: Session }) => ({ mode: modes.get(session.id) ?? 'workspace-write' }),
  } as never)
  const hub = new DshInteractionHub(ctx)
  cleanup.push(async () => { hub.dispose(); await ctx.fiber.dispose() })

  async function attach(session: Session, signal?: AbortSignal): Promise<Owner> {
    const agent = { id: session.id, session, ctx, status: 'idle', inject: vi.fn() } as unknown as Agent
    agents.set(session.id, agent)
    const port = hub.attach({ sessionId: session.id, session, agent })
    const iterator = port.interactions(signal === undefined ? {} : { signal })[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ pending: [], rememberedApprovalCount: 0 })
    return { session, agent, port, iterator }
  }

  async function owner(id = 'scope-a', signal?: AbortSignal) {
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: 'D:\\approval-fixture' } })
    session.append('turn/start', { turn: 1 })
    return attach(session, signal)
  }

  function request(target: Owner, id: string, fields: Record<string, unknown> = {}, toolName = 'pwsh') {
    target.session.append('tool/call', {
      turn: 1, step: 1, callId: CallId(id), name: toolName,
      arguments: JSON.stringify({ command: 'Write-Output fixture', ...fields }),
    })
    return ctx.approval.request({ agent: target.agent, toolName, callId: CallId(id) })
  }

  return { ctx, agents, modes, owner, attach, request }
}

async function nextApproval(owner: Owner, pending: Promise<ApprovalOutcome>): Promise<PendingApprovalInteraction> {
  let decided = false
  void pending.then(() => { decided = true })
  // A wrongly reused grant settles in microtasks; detect it before awaiting a
  // snapshot that the automatic path intentionally never publishes.
  for (let count = 0; count < 8; count += 1) await Promise.resolve()
  expect(decided, 'a different or revoked scope must still ask').toBe(false)
  while (true) {
    const next = await owner.iterator.next()
    if (next.done) throw new Error('approval consumer unexpectedly ended')
    const item = next.value.pending[0]
    if (item?.kind === 'approval') return item
  }
}

async function remember(owner: Owner, pending: Promise<ApprovalOutcome>) {
  const item = await nextApproval(owner, pending)
  const snapshot: InteractionSnapshot = { type: 'interaction/snapshot', sessionId: owner.session.id, pending: [item] }
  const editor = reduceInteractionEditor(
    reconcileInteractionEditor(createInteractionEditorState(), snapshot), { type: 'insert', text: '3' },
  )
  const command = prepareInteractionSubmit(editor, snapshot)
  expect(command.response).toMatchObject({ kind: 'approval', outcome: 'allowed-session' })
  expect(owner.port.respond(command.response!)).toEqual({ accepted: true })
  await expect(pending).resolves.toBe('allowed-once')
  expect((await owner.iterator.next()).value).toMatchObject({ pending: [], rememberedApprovalCount: 1 })
}

async function reject(owner: Owner, pending: Promise<ApprovalOutcome>) {
  const item = await nextApproval(owner, pending)
  expect(owner.port.respond({ id: item.id, kind: 'approval', outcome: 'rejected' })).toEqual({ accepted: true })
  await expect(pending).resolves.toBe('rejected')
  await owner.iterator.next()
}

describe('independent audit of live Session approval scopes', () => {
  it('keeps each automatic decision in the official service-minted audit pair', async () => {
    const bench = await fixture()
    const owner = await bench.owner()
    await remember(owner, bench.request(owner, 'first'))
    for (const id of ['second', 'third']) await expect(bench.request(owner, id)).resolves.toBe('allowed-once')
    const asked = owner.session.events.filter(event => event.type === 'approval/asked')
    const decided = owner.session.events.filter(event => event.type === 'approval/decided')
    expect(asked.map(event => event.data.callId)).toEqual(['first', 'second', 'third'])
    expect(new Set(asked.map(event => event.data.id)).size).toBe(3)
    expect(decided.map(event => event.data)).toEqual(asked.map(event => ({ id: event.data.id, outcome: 'allowed-once' })))
    expect(owner.session.events.some(event => event.type === 'approval/policy' || String(event.type) === 'sandbox/mode')).toBe(false)
  })

  it('does not share a remembered scope across Sessions or replacement Agent objects', async () => {
    const bench = await fixture()
    const first = await bench.owner()
    const second = await bench.owner('scope-b')
    await remember(first, bench.request(first, 'first'))
    await reject(second, bench.request(second, 'second-session'))
    const foreign = { ...first.agent } as Agent
    first.session.append('tool/call', { turn: 1, step: 1, callId: CallId('foreign'), name: 'pwsh', arguments: '{}' })
    await expect(bench.ctx.approval.request({ agent: foreign, toolName: 'pwsh', callId: CallId('foreign') })).resolves.toBe('unavailable')
    bench.agents.set(first.session.id, foreign)
    await expect(bench.request(first, 'stale-owner')).resolves.toBe('unavailable')
    first.port.disposeInteractions()
    const replacement = await bench.attach(first.session)
    await reject(replacement, bench.request(replacement, 'replacement'))
    expect(replacement.port.clearSessionApprovals()).toBe(0)
  })

  it.each([
    ['another tool', {}, 'bash'],
    ['another cwd', { workdir: 'D:\\another-fixture' }, 'pwsh'],
    ['sandbox escalation', { sandbox_permissions: 'danger-full-access' }, 'pwsh'],
  ] as const)('does not widen ordinary tool approval to %s', async (_label, fields, toolName) => {
    const bench = await fixture()
    const owner = await bench.owner()
    await remember(owner, bench.request(owner, 'remembered'))
    await reject(owner, bench.request(owner, 'different', fields, toolName))
    await expect(bench.request(owner, 'original-scope')).resolves.toBe('allowed-once')
  })

  it('keeps escalation target and current permission in the remembered scope', async () => {
    const bench = await fixture()
    const owner = await bench.owner()
    const escalation = { sandbox_permissions: 'danger-full-access' }
    await remember(owner, bench.request(owner, 'remembered', escalation))
    await reject(owner, bench.request(owner, 'ordinary'))
    await reject(owner, bench.request(owner, 'different-target', { sandbox_permissions: 'workspace-write' }))
    // A scoped service reconfiguration without a durable policy event must
    // still miss the old scope because effective permission is part of it.
    bench.modes.set(owner.session.id, 'read-only')
    await reject(owner, bench.request(owner, 'different-current', escalation))
  })

  it.each(['approval-policy', 'sandbox-mode', 'clear', 'disconnect'] as const)('revokes on %s and cannot silently restore the old grant', async (change) => {
    const bench = await fixture()
    const abort = new AbortController()
    const owner = await bench.owner('revocation', abort.signal)
    await remember(owner, bench.request(owner, 'remembered'))
    if (change === 'approval-policy') {
      bench.ctx.approval.setPolicy(owner.agent, 'never')
      await expect(bench.request(owner, 'under-never')).resolves.toBe('rejected')
      bench.ctx.approval.setPolicy(owner.agent, 'ask')
    } else if (change === 'sandbox-mode') {
      // SandboxPolicy's durable public event is intentionally not a TUI type dependency.
      const append = owner.session.append.bind(owner.session) as (type: string, data: unknown) => unknown
      bench.modes.set(owner.session.id, 'read-only')
      append('sandbox/mode', { mode: 'read-only' })
      bench.modes.set(owner.session.id, 'workspace-write')
      append('sandbox/mode', { mode: 'workspace-write' })
    } else if (change === 'clear') {
      expect(owner.port.clearSessionApprovals()).toBe(1)
      expect(owner.port.clearSessionApprovals()).toBe(0)
    } else {
      abort.abort()
      await owner.iterator.return?.()
      owner.iterator = owner.port.interactions()[Symbol.asyncIterator]()
      expect((await owner.iterator.next()).value).toMatchObject({ pending: [], rememberedApprovalCount: 0 })
    }
    await reject(owner, bench.request(owner, 'must-ask-again'))
    expect(owner.port.clearSessionApprovals()).toBe(0)
  })

  it.each(['missing', 'ambiguous', 'invalid-json', 'changed'] as const)('cannot remember %s execution evidence', async (failure) => {
    const bench = await fixture()
    const owner = await bench.owner()
    if (failure !== 'missing') owner.session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('invalid'), name: 'pwsh', arguments: failure === 'invalid-json' ? '{' : '{}',
    })
    if (failure === 'ambiguous') owner.session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('invalid'), name: 'pwsh', arguments: '{}',
    })
    const pending = bench.ctx.approval.request({ agent: owner.agent, toolName: 'pwsh', callId: CallId('invalid') })
    const item = await nextApproval(owner, pending)
    if (failure === 'changed') bench.modes.set(owner.session.id, 'read-only')
    expect(owner.port.respond({ id: item.id, kind: 'approval', outcome: 'allowed-session' })).toMatchObject({ accepted: false, reason: 'invalid-response' })
    expect(owner.port.clearSessionApprovals()).toBe(0)
    expect(owner.port.respond({ id: item.id, kind: 'approval', outcome: 'rejected' })).toEqual({ accepted: true })
    await expect(pending).resolves.toBe('rejected')
    await owner.iterator.next()
    await reject(owner, bench.request(owner, 'fresh-call'))
  })

  it('never reuses an existing grant when the next call lacks valid evidence', async () => {
    const bench = await fixture()
    const owner = await bench.owner()
    await remember(owner, bench.request(owner, 'remembered'))
    const pending = bench.ctx.approval.request({ agent: owner.agent, toolName: 'pwsh', callId: CallId('missing') })
    await reject(owner, pending)
    expect(owner.session.events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome)).toEqual(['allowed-once', 'rejected'])
  })
})
