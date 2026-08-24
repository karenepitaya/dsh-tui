import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ApprovalRequestId,
  type ApprovalOutcome,
  type ApprovalRequest,
} from '@deepseek-ai/dsh-user-approval'
import UserQuestionService, {
  type AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions'
import {
  DshInteractionHub,
  type DshInteractionSession,
} from '../src/dsh/interaction-hub.ts'
import type {
  DshInteractionPort,
  InteractionSnapshot,
  UiQuestionAnswer,
} from '../src/interaction/port.ts'

interface Bench {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly liveAgents: Agent[]
  readonly hub: DshInteractionHub
  readonly port: DshInteractionSession
}

const benches: Bench[] = []

afterEach(async () => {
  for (const bench of benches.splice(0)) {
    bench.hub.dispose()
    await bench.ctx.fiber.dispose()
  }
})

async function createBench(id = 'session-interaction'): Promise<Bench> {
  const ctx = new Context()
  const session = Session.create(SessionId(id))
  const liveAgents: Agent[] = []
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    ctx,
  } as unknown as Agent
  liveAgents.push(agent)
  ctx.provide('agents', {
    get: (candidate: SessionId) => liveAgents.find(item => item.id === candidate),
    roots: () => [...liveAgents],
  } as never)
  await ctx.plugin(UserQuestionService)
  const hub = new DshInteractionHub(ctx)
  const port = hub.attach({
    sessionId: session.id,
    agent,
    session,
  })
  const bench = { ctx, session, agent, liveAgents, hub, port }
  benches.push(bench)
  return bench
}

async function start(
  port: DshInteractionPort,
  signal?: AbortSignal,
): Promise<AsyncIterator<InteractionSnapshot>> {
  const iterator = port.interactions(signal === undefined ? {} : { signal })[Symbol.asyncIterator]()
  await expect(iterator.next()).resolves.toMatchObject({
    done: false,
    value: { type: 'interaction/snapshot', pending: [] },
  })
  return iterator
}

async function nextSnapshot(
  iterator: AsyncIterator<InteractionSnapshot>,
): Promise<InteractionSnapshot> {
  const next = await iterator.next()
  if (next.done) throw new Error('expected an interaction snapshot')
  return next.value
}

const confirmQuestion: AskUserQuestionItem = {
  id: 'confirm',
  question: 'Proceed?',
  options: [
    { label: 'Yes', description: 'Continue' },
    { label: 'No' },
  ],
}

const yes: UiQuestionAnswer = {
  answers: [{ id: 'confirm', selected: ['Yes'] }],
}

function flippingSignal(abortOnRead: number): AbortSignal {
  let reads = 0
  return {
    get aborted() {
      reads += 1
      return reads >= abortOnRead
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as AbortSignal
}

describe('DshInteractionHub questions', () => {
  it('reserves the provider before a renderer consumes snapshots and validates before claim', async () => {
    const bench = await createBench()
    const earlyAnswer = bench.ctx.userQuestions.ask({
      agent: bench.agent,
      questions: [confirmQuestion],
    })

    const iterator = bench.port.interactions()[Symbol.asyncIterator]()
    const earlySnapshot = await nextSnapshot(iterator)
    const early = earlySnapshot.pending[0]
    if (early?.kind !== 'question') throw new Error('expected reserved question')
    expect(bench.port.respond({
      id: early.id,
      kind: 'question',
      outcome: { kind: 'answered', answer: yes },
    })).toEqual({ accepted: true })
    await expect(earlyAnswer).resolves.toEqual(yes)
    await expect(iterator.next()).resolves.toMatchObject({ value: { pending: [] } })

    const pendingAnswer = bench.ctx.userQuestions.ask({
      agent: bench.agent,
      questions: [confirmQuestion],
    })
    const requested = await nextSnapshot(iterator)
    const interaction = requested.pending[0]
    expect(interaction).toMatchObject({
      kind: 'question',
      sessionId: bench.session.id,
      questions: [confirmQuestion],
    })
    if (interaction?.kind !== 'question') throw new Error('expected question')

    const invalidAnswers: UiQuestionAnswer[] = [
      { answers: [] },
      { answers: [{ id: 'other', selected: ['Yes'] }] },
      { answers: [{ id: 'confirm', selected: ['Yes', 'Yes'] }] },
      { answers: [{ id: 'confirm', selected: [], custom: '  ' }] },
      { answers: [{ id: 'confirm', selected: ['Yes', 'No'] }] },
      { answers: [{ id: 'confirm', selected: ['Yes'], custom: 'custom' }] },
      { answers: [{ id: 'confirm', selected: ['Unknown'] }] },
    ]
    for (const answer of invalidAnswers) {
      expect(bench.port.respond({
        id: interaction.id,
        kind: 'question',
        outcome: { kind: 'answered', answer },
      })).toMatchObject({ accepted: false, reason: 'invalid-response' })
    }

    expect(bench.port.respond({
      id: interaction.id,
      kind: 'question',
      outcome: { kind: 'answered', answer: yes },
    })).toEqual({ accepted: true })
    await expect(pendingAnswer).resolves.toEqual(yes)
    await expect(iterator.next()).resolves.toMatchObject({
      value: { pending: [] },
    })
    expect(bench.port.respond({
      id: interaction.id,
      kind: 'question',
      outcome: { kind: 'answered', answer: yes },
    })).toEqual({ accepted: false, reason: 'not-pending' })

    const richQuestions: AskUserQuestionItem[] = [
      {
        id: 'plan',
        question: 'Review the plan?',
        detail: '# Plan',
        header: 'Plan',
        options: [{ label: 'Ship' }, { label: 'Revise' }],
        multiSelect: true,
        intent: { kind: 'plan-review', approve: 'Ship' },
      },
      {
        id: 'notes',
        question: 'Any notes?',
      },
    ]
    const richPending = bench.ctx.userQuestions.ask({
      agent: bench.agent,
      questions: richQuestions,
    })
    const richSnapshot = await nextSnapshot(iterator)
    const rich = richSnapshot.pending[0]
    if (rich?.kind !== 'question') throw new Error('expected rich question')
    expect(bench.port.respond({
      id: rich.id,
      kind: 'approval',
      outcome: 'rejected',
    })).toMatchObject({ accepted: false, reason: 'invalid-response' })
    const richAnswer: UiQuestionAnswer = {
      answers: [
        { id: 'plan', selected: ['Ship', 'Revise'], custom: 'context' },
        { id: 'notes', selected: [], custom: 'looks good' },
      ],
    }
    expect(bench.port.respond({
      id: rich.id,
      kind: 'question',
      outcome: { kind: 'answered', answer: richAnswer },
    })).toEqual({ accepted: true })
    await expect(richPending).resolves.toEqual(richAnswer)

    await iterator.return?.()
    bench.port.disposeInteractions()
    await expect(bench.ctx.userQuestions.ask({
      agent: bench.agent,
      questions: [confirmQuestion],
    })).rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('uses request UUIDs, conflates slow snapshots, and cancels explicitly', async () => {
    const bench = await createBench()
    const iterator = await start(bench.port)
    const first = bench.ctx.userQuestions.ask({
      agent: bench.agent,
      questions: [confirmQuestion],
    })
    const second = bench.ctx.userQuestions.ask({
      agent: bench.agent,
      questions: [{ ...confirmQuestion, id: 'confirm' }],
    })

    const both = await nextSnapshot(iterator)
    expect(both.pending).toHaveLength(2)
    const [firstRequest, secondRequest] = both.pending
    expect(firstRequest?.id).not.toBe(secondRequest?.id)
    if (firstRequest?.kind !== 'question' || secondRequest?.kind !== 'question') {
      throw new Error('expected concurrent questions')
    }

    expect(bench.port.respond({
      id: firstRequest.id,
      kind: 'question',
      outcome: { kind: 'answered', answer: yes },
    })).toEqual({ accepted: true })
    expect(bench.port.respond({
      id: secondRequest.id,
      kind: 'question',
      outcome: { kind: 'cancelled' },
    })).toEqual({ accepted: true })

    await expect(first).resolves.toEqual(yes)
    await expect(second).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    const latest = await nextSnapshot(iterator)
    expect(latest.pending).toEqual([])
    await iterator.return?.()
  })

  it('lets abort or consumer loss reject pending work and makes late answers harmless', async () => {
    const bench = await createBench()
    const controller = new AbortController()
    const iterator = await start(bench.port, controller.signal)
    const ask = bench.ctx.userQuestions.ask({
      agent: bench.agent,
      questions: [confirmQuestion],
      signal: controller.signal,
    })
    const requested = await nextSnapshot(iterator)
    const question = requested.pending[0]
    if (question?.kind !== 'question') throw new Error('expected question')

    controller.abort()
    await expect(ask).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(bench.port.respond({
      id: question.id,
      kind: 'question',
      outcome: { kind: 'answered', answer: yes },
    })).toEqual({ accepted: false, reason: 'not-pending' })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })

    const queued = bench.ctx.userQuestions.ask({
      agent: bench.agent,
      questions: [confirmQuestion],
    })

    const nextIterator = bench.port.interactions()[Symbol.asyncIterator]()
    const queuedSnapshot = await nextSnapshot(nextIterator)
    const queuedQuestion = queuedSnapshot.pending[0]
    if (queuedQuestion?.kind !== 'question') throw new Error('expected queued question')
    expect(bench.port.respond({
      id: queuedQuestion.id,
      kind: 'question',
      outcome: { kind: 'cancelled' },
    })).toEqual({ accepted: true })
    await expect(queued).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await nextSnapshot(nextIterator)
    const lost = bench.ctx.userQuestions.ask({
      agent: bench.agent,
      questions: [confirmQuestion],
    })
    await nextSnapshot(nextIterator)
    await nextIterator.return?.()
    await expect(lost).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('fails fast for missing or unowned agents and rejects a second consumer', async () => {
    const bench = await createBench()
    const iterator = await start(bench.port)
    await expect(bench.ctx.userQuestions.ask({
      questions: [confirmQuestion],
    })).rejects.toMatchObject({ code: 'ASK_MISSING_AGENT' })

    const foreignSession = Session.create(SessionId('foreign'))
    const foreign = {
      id: foreignSession.id,
      session: foreignSession,
      status: 'idle',
      ctx: bench.ctx,
    } as unknown as Agent
    bench.liveAgents.push(foreign)
    await expect(bench.ctx.userQuestions.ask({
      agent: foreign,
      questions: [confirmQuestion],
    })).rejects.toMatchObject({ code: 'ASK_UNOWNED_AGENT' })

    const duplicate = bench.port.interactions()[Symbol.asyncIterator]()
    await expect(duplicate.next()).rejects.toThrow('already has an active consumer')
    await iterator.return?.()
  })

  it('covers registration-race aborts without publishing ghost questions', async () => {
    const bench = await createBench()
    const racedIterator = bench.port.interactions({
      signal: flippingSignal(2),
    })[Symbol.asyncIterator]()
    await expect(racedIterator.next()).resolves.toMatchObject({ done: true })

    const iterator = await start(bench.port)
    await expect(bench.ctx.userQuestions.ask({
      agent: bench.agent,
      questions: [confirmQuestion],
      signal: flippingSignal(2),
    })).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await iterator.return?.()
  })

  it('guards hub and session lifecycle transitions', async () => {
    const bench = await createBench()
    const iterator = await start(bench.port)
    const otherSession = Session.create(SessionId('other-session'))
    const otherAgent = {
      id: otherSession.id,
      session: otherSession,
      status: 'idle',
      ctx: bench.ctx,
    } as unknown as Agent
    bench.liveAgents.push(otherAgent)
    const other = bench.hub.attach({
      sessionId: otherSession.id,
      agent: otherAgent,
      session: otherSession,
    })
    expect(() => bench.hub.attach({
      sessionId: otherSession.id,
      agent: otherAgent,
      session: otherSession,
    })).toThrow('already attached')

    const competing = await start(other)
    const otherQuestion = bench.ctx.userQuestions.ask({
      agent: otherAgent,
      questions: [confirmQuestion],
    })
    const otherSnapshot = await nextSnapshot(competing)
    expect(otherSnapshot.pending).toHaveLength(1)
    expect(bench.port.respond({
      id: otherSnapshot.pending[0]!.id,
      kind: 'question',
      outcome: { kind: 'answered', answer: yes },
    })).toEqual({ accepted: false, reason: 'not-pending' })
    expect(other.respond({
      id: otherSnapshot.pending[0]!.id,
      kind: 'question',
      outcome: { kind: 'answered', answer: yes },
    })).toEqual({ accepted: true })
    await expect(otherQuestion).resolves.toEqual(yes)

    await iterator.return?.()
    await competing.return?.()
    bench.port.disposeInteractions()
    const stillRouted = bench.ctx.userQuestions.ask({
      agent: otherAgent,
      questions: [confirmQuestion],
    })
    other.disposeInteractions()
    await expect(stillRouted).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    bench.hub.dispose()
    bench.hub.dispose()
    const lateSession = Session.create(SessionId('late'))
    const lateAgent = {
      id: lateSession.id,
      session: lateSession,
      status: 'idle',
      ctx: bench.ctx,
    } as unknown as Agent
    expect(() => bench.hub.attach({
      sessionId: lateSession.id,
      agent: lateAgent,
      session: lateSession,
    })).toThrow('disposed')
    other.closeFromHub()
  })

  it('rejects inconsistent identities and rolls back provider registration failure', async () => {
    const bench = await createBench()
    bench.port.disposeInteractions()
    const session = Session.create(SessionId('candidate'))
    const otherSession = Session.create(SessionId('other-candidate'))
    const agent = {
      id: session.id,
      session,
      status: 'idle',
      ctx: bench.ctx,
    } as unknown as Agent
    const wrongIdAgent = {
      id: otherSession.id,
      session,
      status: 'idle',
      ctx: bench.ctx,
    } as unknown as Agent
    const wrongSessionAgent = {
      id: session.id,
      session: otherSession,
      status: 'idle',
      ctx: bench.ctx,
    } as unknown as Agent

    expect(() => bench.hub.attach({
      sessionId: otherSession.id,
      agent,
      session,
    })).toThrow('identity is inconsistent')
    expect(() => bench.hub.attach({
      sessionId: session.id,
      agent: wrongIdAgent,
      session,
    })).toThrow('identity is inconsistent')
    expect(() => bench.hub.attach({
      sessionId: session.id,
      agent: wrongSessionAgent,
      session,
    })).toThrow('identity is inconsistent')

    const registration = vi.spyOn(bench.ctx.userQuestions, 'registerProvider')
      .mockImplementationOnce(() => { throw new Error('provider registration failed') })
    expect(() => bench.hub.attach({
      sessionId: session.id,
      agent,
      session,
    })).toThrow('provider registration failed')
    registration.mockRestore()

    const recovered = bench.hub.attach({
      sessionId: session.id,
      agent,
      session,
    })
    recovered.disposeInteractions()
  })
})

function approval(
  bench: Bench,
  callId: string | undefined,
  signal?: AbortSignal,
  toolName = 'pwsh',
  reason?: string,
): Promise<ApprovalOutcome> {
  const request: ApprovalRequest = {
    agent: bench.agent,
    toolName,
    ...(callId === undefined ? {} : { callId: CallId(callId) }),
    ...(signal === undefined ? {} : { signal }),
    ...(reason === undefined ? {} : { reason }),
  }
  return bench.ctx.waterfall(
    'approval/request',
    request,
    () => Promise.resolve<ApprovalOutcome>('unavailable'),
  )
}

describe('DshInteractionHub approvals', () => {
  it('correlates parallel callIds, ignores decided ids, and never claims callId-less asks', async () => {
    const bench = await createBench()
    const foreignSession = Session.create(SessionId('foreign-approval-owner'))
    const foreignAgent = {
      id: foreignSession.id,
      session: foreignSession,
      status: 'idle',
      ctx: bench.ctx,
    } as unknown as Agent
    await expect(bench.ctx.waterfall(
      'approval/request',
      { agent: foreignAgent, toolName: 'pwsh' },
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )).resolves.toBe('unavailable')
    bench.session.append('approval/asked', {
      id: ApprovalRequestId('inactive'),
      toolName: 'pwsh',
      callId: CallId('inactive-call'),
    })
    const reserved = approval(bench, 'inactive-call')
    const iterator = bench.port.interactions()[Symbol.asyncIterator]()
    const reservedSnapshot = await nextSnapshot(iterator)
    const reservedApproval = reservedSnapshot.pending[0]
    if (reservedApproval?.kind !== 'approval') throw new Error('expected reserved approval')
    expect(bench.port.respond({
      id: reservedApproval.id,
      kind: 'approval',
      outcome: 'rejected',
    })).toEqual({ accepted: true })
    await expect(reserved).resolves.toBe('rejected')
    await nextSnapshot(iterator)
    const turn = bench.session.append('turn/start', { turn: 1 })
    bench.ctx.emit('session/event', bench.session, turn)
    const foreign = Session.create(SessionId('foreign-approval'))
    const foreignDecision = foreign.append('approval/decided', {
      id: ApprovalRequestId('foreign-id'),
      outcome: 'rejected',
    })
    bench.ctx.emit('session/event', foreign, foreignDecision)
    bench.session.append('approval/asked', {
      id: ApprovalRequestId('approval-a'),
      toolName: 'pwsh',
      callId: CallId('call-a'),
    })
    bench.session.append('approval/asked', {
      id: ApprovalRequestId('approval-b'),
      toolName: 'pwsh',
      callId: CallId('call-b'),
    })
    const first = approval(bench, 'call-a', undefined, 'pwsh', 'required')
    const second = approval(bench, 'call-b')
    const both = await nextSnapshot(iterator)
    expect(both.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'approval',
        approvalId: 'approval-a',
        callId: 'call-a',
        reason: 'required',
      }),
      expect.objectContaining({ kind: 'approval', approvalId: 'approval-b', callId: 'call-b' }),
    ]))

    const approvalA = both.pending.find(
      item => item.kind === 'approval' && item.approvalId === 'approval-a',
    )
    const approvalB = both.pending.find(
      item => item.kind === 'approval' && item.approvalId === 'approval-b',
    )
    if (approvalA?.kind !== 'approval' || approvalB?.kind !== 'approval') {
      throw new Error('expected approvals')
    }
    expect(bench.port.respond({
      id: approvalA.id,
      kind: 'question',
      outcome: { kind: 'cancelled' },
    })).toMatchObject({ accepted: false, reason: 'invalid-response' })
    expect(bench.port.respond({
      id: approvalA.id,
      kind: 'approval',
      outcome: 'allowed-once',
    })).toEqual({ accepted: true })
    expect(bench.port.respond({
      id: approvalB.id,
      kind: 'approval',
      outcome: 'rejected',
    })).toEqual({ accepted: true })
    await expect(first).resolves.toBe('allowed-once')
    await expect(second).resolves.toBe('rejected')

    await expect(approval(bench, 'call-a')).resolves.toBe('unavailable')
    const decidedA = bench.session.append('approval/decided', {
      id: ApprovalRequestId('approval-a'),
      outcome: 'allowed-once',
    })
    bench.ctx.emit('session/event', bench.session, decidedA)
    bench.session.append('approval/asked', {
      id: ApprovalRequestId('approval-a2'),
      toolName: 'pwsh',
      callId: CallId('call-a'),
    })
    const again = approval(bench, 'call-a')
    const againSnapshot = await nextSnapshot(iterator)
    const approvalA2 = againSnapshot.pending.find(
      item => item.kind === 'approval' && item.approvalId === 'approval-a2',
    )
    if (approvalA2?.kind !== 'approval') throw new Error('expected second approval')
    bench.port.respond({ id: approvalA2.id, kind: 'approval', outcome: 'rejected' })
    await expect(again).resolves.toBe('rejected')

    bench.session.append('approval/asked', {
      id: ApprovalRequestId('stale'),
      toolName: 'pwsh',
      callId: CallId('call-c'),
    })
    bench.session.append('approval/decided', {
      id: ApprovalRequestId('stale'),
      outcome: 'rejected',
    })
    await expect(approval(bench, 'call-c')).resolves.toBe('unavailable')
    bench.session.append('approval/asked', {
      id: ApprovalRequestId('live'),
      toolName: 'pwsh',
      callId: CallId('call-c'),
    })
    const live = approval(bench, 'call-c')
    const liveSnapshot = await nextSnapshot(iterator)
    const liveApproval = liveSnapshot.pending.find(
      item => item.kind === 'approval' && item.approvalId === 'live',
    )
    if (liveApproval?.kind !== 'approval') throw new Error('expected live approval')
    bench.port.respond({ id: liveApproval.id, kind: 'approval', outcome: 'rejected' })
    await expect(live).resolves.toBe('rejected')

    bench.session.append('approval/asked', {
      id: ApprovalRequestId('call-less'),
      toolName: 'alpha',
    })
    await expect(approval(bench, undefined, undefined, 'alpha')).resolves.toBe('unavailable')
    await expect(approval(bench, 'missing')).resolves.toBe('unavailable')
    bench.session.append('approval/asked', {
      id: ApprovalRequestId('duplicate-1'),
      toolName: 'pwsh',
      callId: CallId('duplicate-call'),
    })
    bench.session.append('approval/asked', {
      id: ApprovalRequestId('duplicate-2'),
      toolName: 'pwsh',
      callId: CallId('duplicate-call'),
    })
    await expect(approval(bench, 'duplicate-call')).resolves.toBe('unavailable')
    await expect(approval(bench, 'duplicate-call', undefined, 'bash')).resolves.toBe('unavailable')
    await iterator.return?.()
  })

  it('settles signal abort, consumer loss, and pre-abort as cancelled', async () => {
    const bench = await createBench()
    const iterator = await start(bench.port)
    const controller = new AbortController()
    bench.session.append('approval/asked', {
      id: ApprovalRequestId('abort-me'),
      toolName: 'pwsh',
      callId: CallId('abort-call'),
    })
    const pending = approval(bench, 'abort-call', controller.signal)
    const requested = await nextSnapshot(iterator)
    const item = requested.pending.find(
      candidate => candidate.kind === 'approval' && candidate.approvalId === 'abort-me',
    )
    if (item?.kind !== 'approval') throw new Error('expected approval')
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(bench.port.respond({
      id: item.id,
      kind: 'approval',
      outcome: 'allowed-once',
    })).toEqual({ accepted: false, reason: 'not-pending' })

    const preAborted = new AbortController()
    preAborted.abort()
    await expect(approval(bench, 'unused', preAborted.signal)).resolves.toBe('cancelled')

    bench.session.append('approval/asked', {
      id: ApprovalRequestId('race-before-pending'),
      toolName: 'pwsh',
      callId: CallId('race-before-call'),
    })
    await expect(approval(
      bench,
      'race-before-call',
      flippingSignal(2),
    )).resolves.toBe('cancelled')

    bench.session.append('approval/asked', {
      id: ApprovalRequestId('race-after-listener'),
      toolName: 'pwsh',
      callId: CallId('race-after-call'),
    })
    await expect(approval(
      bench,
      'race-after-call',
      flippingSignal(3),
    )).resolves.toBe('cancelled')

    bench.session.append('approval/asked', {
      id: ApprovalRequestId('lost'),
      toolName: 'pwsh',
      callId: CallId('lost-call'),
    })
    const lost = approval(bench, 'lost-call')
    await nextSnapshot(iterator)
    await iterator.return?.()
    await expect(lost).resolves.toBe('cancelled')
  })

  it('drains both interaction kinds synchronously on explicit disposal', async () => {
    const bench = await createBench()
    const iterator = await start(bench.port)
    const question = bench.ctx.userQuestions.ask({
      agent: bench.agent,
      questions: [confirmQuestion],
    })
    bench.session.append('approval/asked', {
      id: ApprovalRequestId('dispose-approval'),
      toolName: 'pwsh',
      callId: CallId('dispose-call'),
    })
    const permission = approval(bench, 'dispose-call')
    await nextSnapshot(iterator)

    bench.port.disposeInteractions()
    await expect(question).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await expect(permission).resolves.toBe('cancelled')
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { pending: [] },
    })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    const closed = bench.port.interactions()[Symbol.asyncIterator]()
    await expect(closed.next()).resolves.toMatchObject({ done: true })
    bench.port.disposeInteractions()
  })
})
