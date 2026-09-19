import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalRequestId,
} from '@deepseek-ai/dsh-user-approval'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { LatestValueQueue } from '../interaction/latest-value-queue.ts'
import { approvalEvidenceError } from '../interaction/port.ts'
import { collectApprovalEvidence } from './approval-evidence.ts'
import { snapshotSessionEvents } from './session-events.ts'
import type {
  DshInteractionPort,
  InteractionEventOptions,
  InteractionReceipt,
  InteractionResponse,
  InteractionSnapshot,
  PendingApprovalInteraction,
  PendingInteraction,
  PendingQuestionInteraction,
  UiQuestion,
  UiQuestionAnswer,
} from '../interaction/port.ts'
import type { SessionId } from '../runtime/events.ts'

export interface DshInteractionOwner {
  readonly sessionId: SessionId
  readonly agent: Agent
  readonly session: Session
}

interface PendingBase {
  readonly public: PendingInteraction
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

interface PendingQuestion extends PendingBase {
  readonly kind: 'question'
  readonly public: PendingQuestionInteraction
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (error: UserQuestionError) => void
}

interface PendingApproval extends PendingBase {
  readonly kind: 'approval'
  readonly public: PendingApprovalInteraction
  readonly approvalId: ApprovalRequestId
  readonly resolve: (outcome: ApprovalOutcome) => void
}

type PendingEntry = PendingQuestion | PendingApproval

const accepted = { accepted: true } as const
const notPending = { accepted: false, reason: 'not-pending' } as const

function invalid(message: string): InteractionReceipt {
  return { accepted: false, reason: 'invalid-response', message }
}

/** Permission to repeat this tool at this cwd, never a grant to another policy or owner. */
function approvalScope(item: PendingApprovalInteraction): string {
  return JSON.stringify([item.toolName, item.evidence!.cwd,
    item.evidence!.currentPermission, item.evidence!.requestedPermission])
}

function copyQuestions(questions: readonly AskUserQuestionItem[]): UiQuestion[] {
  return questions.map(question => ({
    id: question.id,
    question: question.question,
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined
      ? {}
      : {
          options: question.options.map(option => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        }),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    ...(question.intent === undefined
      ? {}
      : { intent: { kind: question.intent.kind, approve: question.intent.approve } }),
  }))
}

function copyAnswer(answer: UiQuestionAnswer): AskUserQuestionAnswer {
  return {
    answers: answer.answers.map(item => ({
      id: item.id,
      selected: [...item.selected],
      ...(item.custom === undefined ? {} : { custom: item.custom }),
    })),
  }
}

function validateAnswer(
  questions: readonly UiQuestion[],
  answer: UiQuestionAnswer,
): string | undefined {
  if (answer.answers.length !== questions.length) {
    return 'answer count must match question count'
  }
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!
    const item = answer.answers[index]!
    if (item.id !== question.id) return 'answer ids must match question order'
    if (new Set(item.selected).size !== item.selected.length) {
      return `question "${question.id}" contains duplicate selections`
    }
    if (item.custom !== undefined && item.custom.trim() === '') {
      return `question "${question.id}" contains blank custom text`
    }
    if (question.multiSelect !== true && item.selected.length > 1) {
      return `question "${question.id}" is single-select`
    }
    if (
      question.multiSelect !== true
      && item.selected.length > 0
      && item.custom !== undefined
    ) {
      return `question "${question.id}" cannot combine a selection with custom text`
    }
    const offered = new Set((question.options ?? []).map(option => option.label))
    if (item.selected.some(label => !offered.has(label))) {
      return `question "${question.id}" selected an unknown option`
    }
  }
  return undefined
}

/**
 * Context-level exact-owner router. One root user-questions waterfall listener
 * serves every short-lived TUI-owned session reservation, while each session
 * keeps an isolated pending queue and at most one snapshot consumer.
 */
export class DshInteractionHub {
  private readonly sessions = new Set<DshInteractionSession>()
  private readonly sessionsByAgent = new WeakMap<Agent, DshInteractionSession>()
  private readonly sessionsBySession = new WeakMap<Session, DshInteractionSession>()
  private readonly stopApproval: () => void
  private readonly stopQuestions: () => void
  private readonly stopSessionEvents: () => void
  private disposed = false

  constructor(private readonly ctx: Context) {
    this.stopApproval = ctx.on('approval/request', (request, next) => {
      if (request.signal?.aborted === true) {
        return Promise.resolve<ApprovalOutcome>('cancelled')
      }
      const owner = this.sessionsByAgent.get(request.agent)
      if (owner === undefined) return next()
      const pending = owner.openApproval(request)
      return pending ?? next()
    })
    this.stopQuestions = ctx.on('user-questions/request', (request, next) => {
      if (this.sessions.size === 0) return next()
      return this.askQuestion(request)
    })
    this.stopSessionEvents = ctx.on('session/event', (session, event) => {
      if (event.type === 'approval/policy' || String(event.type) === 'sandbox/mode') {
        this.sessionsBySession.get(session)?.clearSessionApprovals()
      }
      if (event.type !== 'approval/decided') return
      this.sessionsBySession.get(session)?.observeApprovalDecided(event.data.id)
    })
  }

  attach(owner: DshInteractionOwner): DshInteractionSession {
    if (this.disposed) throw new Error('DSH interaction hub is disposed')
    if (
      owner.sessionId !== owner.session.id
      || owner.agent.id !== owner.sessionId
      || owner.agent.session !== owner.session
    ) {
      throw new Error('DSH interaction owner identity is inconsistent')
    }
    if (
      this.sessionsByAgent.has(owner.agent)
      || this.sessionsBySession.has(owner.session)
    ) {
      throw new Error(`DSH interaction owner "${owner.sessionId}" is already attached`)
    }
    const session = new DshInteractionSession(this, owner)
    this.sessions.add(session)
    this.sessionsByAgent.set(owner.agent, session)
    this.sessionsBySession.set(owner.session, session)
    return session
  }

  isLiveOwner(owner: DshInteractionOwner): boolean {
    return this.ctx.get('agents')?.get(owner.agent.id) === owner.agent
      && owner.agent.session === owner.session
  }

  approvalEvidence(owner: DshInteractionOwner, callId: string, toolName: string) {
    return collectApprovalEvidence(this.ctx, owner.agent, callId, toolName)
  }

  detach(session: DshInteractionSession): void {
    if (!this.sessions.delete(session)) return
    this.sessionsByAgent.delete(session.agent)
    this.sessionsBySession.delete(session.session)
    session.closeFromHub()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopApproval()
    this.stopQuestions()
    this.stopSessionEvents()
    const sessions = [...this.sessions]
    this.sessions.clear()
    for (const session of sessions) {
      this.sessionsByAgent.delete(session.agent)
      this.sessionsBySession.delete(session.session)
      session.closeFromHub()
    }
  }

  private askQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    if (agent === undefined) {
      return Promise.reject(new UserQuestionError(
        'DSH-TUI user interaction requires an agent-owned session',
        'ASK_MISSING_AGENT',
      ))
    }
    const owner = this.sessionsByAgent.get(agent)
    if (owner === undefined) {
      return Promise.reject(new UserQuestionError(
        'DSH-TUI does not own the calling agent',
        'ASK_UNOWNED_AGENT',
      ))
    }
    return owner.openQuestion(request)
  }
}

export class DshInteractionSession implements DshInteractionPort {
  readonly sessionId: SessionId

  private readonly pending = new Map<string, PendingEntry>()
  private readonly claimedApprovals = new Set<ApprovalRequestId>()
  private readonly sessionApprovals = new Set<string>()
  private consumer: LatestValueQueue<InteractionSnapshot> | undefined
  private disposed = false

  constructor(
    private readonly hub: DshInteractionHub,
    private readonly owner: DshInteractionOwner,
  ) {
    this.sessionId = owner.sessionId
  }

  get agent(): Agent {
    return this.owner.agent
  }

  get session(): Session {
    return this.owner.session
  }

  observeApprovalDecided(id: ApprovalRequestId): void {
    this.claimedApprovals.delete(id)
  }

  async *interactions(options: InteractionEventOptions = {}): AsyncIterable<InteractionSnapshot> {
    if (this.disposed || options.signal?.aborted === true) return
    if (this.consumer !== undefined) {
      throw new Error('DSH-TUI session already has an active consumer')
    }

    const queue = new LatestValueQueue<InteractionSnapshot>()
    this.consumer = queue

    const signal = options.signal
    const onAbort = () => { this.loseConsumer(queue) }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) onAbort()

    try {
      if (this.consumer !== queue) return
      yield this.snapshot()
      while (true) {
        const next = await queue.next()
        if (next.done) return
        yield next.value
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.loseConsumer(queue)
    }
  }

  respond(response: InteractionResponse): InteractionReceipt {
    const entry = this.pending.get(response.id)
    if (entry === undefined) return notPending
    if (response.kind === 'question') {
      if (entry.kind !== 'question') return invalid('interaction kind does not match')
      if (response.outcome.kind === 'cancelled') {
        this.take(entry)
        entry.reject(new UserQuestionError(
          'ask_user_question was cancelled by the user',
          'ASK_CANCELLED',
        ))
        return accepted
      }
      const error = validateAnswer(entry.public.questions, response.outcome.answer)
      if (error !== undefined) return invalid(error)
      const answer = copyAnswer(response.outcome.answer)
      this.take(entry)
      entry.resolve(answer)
      return accepted
    }
    if (entry.kind !== 'approval') return invalid('interaction kind does not match')
    if (response.outcome !== 'rejected') {
      const evidenceError = approvalEvidenceError(entry.public)
      if (evidenceError !== undefined) return invalid(evidenceError)
      if (!this.hub.isLiveOwner(this.owner)) return invalid('Approval owner is no longer the live Agent')
      if (snapshotSessionEvents(this.session).some(event => event.type === 'approval/decided' && event.data.id === entry.approvalId)) {
        return invalid('Approval has already been decided')
      }
      const current = this.hub.approvalEvidence(this.owner, entry.public.callId, entry.public.toolName)
      if (JSON.stringify(current) !== JSON.stringify(entry.public.evidence)) {
        return invalid('Approval evidence changed; reject this request and request a fresh approval')
      }
      if (response.outcome === 'allowed-session') this.sessionApprovals.add(approvalScope(entry.public))
    }
    this.take(entry)
    entry.resolve(response.outcome === 'allowed-session' ? 'allowed-once' : response.outcome)
    return accepted
  }

  clearSessionApprovals(): number {
    const count = this.sessionApprovals.size
    this.sessionApprovals.clear()
    if (count > 0) this.publish()
    return count
  }

  disposeInteractions(): void {
    this.hub.detach(this)
  }

  openQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const questions = copyQuestions(request.questions)
    const id = `question:${randomUUID()}`
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      let entry!: PendingQuestion
      const onAbort = (): void => {
        /* v8 ignore next -- every winning claim removes this once-listener. */
        if (this.pending.get(id) !== entry) return
        this.take(entry)
        reject(new UserQuestionError(
          'ask_user_question was aborted before the user answered',
          'ASK_ABORTED',
        ))
      }
      entry = {
        kind: 'question',
        public: { id, kind: 'question', sessionId: this.sessionId, questions },
        resolve,
        reject,
        ...(request.signal === undefined
          ? {}
          : { signal: request.signal, onAbort }),
      }
      this.pending.set(id, entry)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (request.signal?.aborted === true) onAbort()
      else this.publish()
    })
  }

  openApproval(request: ApprovalRequest): Promise<ApprovalOutcome> | undefined {
    if (this.disposed || !this.hub.isLiveOwner(this.owner) || request.agent !== this.agent) return undefined
    const callId = request.callId
    if (callId === undefined) return undefined
    const approvalId = this.findApprovalId(
      snapshotSessionEvents(request.agent.session),
      String(callId),
      request.toolName,
    )
    if (approvalId === undefined) return undefined
    if (request.signal?.aborted === true) {
      return Promise.resolve<ApprovalOutcome>('cancelled')
    }

    const id = `approval:${String(approvalId)}`
    this.claimedApprovals.add(approvalId)
    const publicRequest: PendingApprovalInteraction = Object.freeze({
      id, kind: 'approval', sessionId: this.sessionId, approvalId: String(approvalId),
      toolName: request.toolName, callId: String(callId), allowSession: true,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      evidence: this.hub.approvalEvidence(this.owner, String(callId), request.toolName),
    })
    if (this.consumer !== undefined && approvalEvidenceError(publicRequest) === undefined
      && this.sessionApprovals.has(approvalScope(publicRequest))) {
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      let entry!: PendingApproval
      const onAbort = (): void => {
        /* v8 ignore next -- every winning claim removes this once-listener. */
        if (this.pending.get(id) !== entry) return
        this.take(entry)
        resolve('cancelled')
      }
      entry = {
        kind: 'approval',
        public: publicRequest,
        approvalId,
        resolve,
        ...(request.signal === undefined
          ? {}
          : { signal: request.signal, onAbort }),
      }
      this.pending.set(id, entry)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (request.signal?.aborted === true) onAbort()
      else this.publish()
    })
  }

  closeFromHub(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelPending()
    this.claimedApprovals.clear()
    this.sessionApprovals.clear()
    const queue = this.consumer
    this.consumer = undefined
    queue?.close()
  }

  private loseConsumer(queue: LatestValueQueue<InteractionSnapshot>): void {
    if (this.consumer !== queue) return
    this.consumer = undefined
    this.sessionApprovals.clear()
    this.cancelPending()
    queue.close()
  }

  private cancelPending(): void {
    if (this.pending.size === 0) return
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.signal !== undefined && entry.onAbort !== undefined) {
        entry.signal.removeEventListener('abort', entry.onAbort)
      }
    }
    this.publish()
    for (const entry of entries) {
      if (entry.kind === 'question') {
        entry.reject(new UserQuestionError(
          'DSH-TUI user-questions provider was disposed',
          'ASK_ABORTED',
        ))
      } else {
        entry.resolve('cancelled')
      }
    }
  }

  private take(entry: PendingEntry): void {
    this.pending.delete(entry.public.id)
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    this.publish()
  }

  private publish(): void {
    this.consumer?.push(this.snapshot())
  }

  private snapshot(): InteractionSnapshot {
    return {
      type: 'interaction/snapshot',
      sessionId: this.sessionId,
      pending: [...this.pending.values()].map(entry => entry.public),
      rememberedApprovalCount: this.sessionApprovals.size,
    }
  }

  private findApprovalId(
    events: readonly SessionEvent[],
    callId: string,
    toolName: string,
  ): ApprovalRequestId | undefined {
    const decided = new Set<ApprovalRequestId>()
    let candidate: ApprovalRequestId | undefined
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (event.type === 'approval/decided') {
        decided.add(event.data.id)
        continue
      }
      if (event.type !== 'approval/asked') continue
      if (decided.has(event.data.id) || this.claimedApprovals.has(event.data.id)) continue
      if (event.data.callId === undefined || String(event.data.callId) !== callId) continue
      if (event.data.toolName !== toolName) continue
      if (candidate !== undefined) return undefined
      candidate = event.data.id
    }
    return candidate
  }
}
