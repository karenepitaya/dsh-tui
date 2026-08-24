import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { DshToolPresentationProjector } from '../src/dsh/tool-presentation.ts'

function toolCall(
  callId: string,
  argumentsJson = '{"path":"a.ts"}',
  name = 'read',
): SessionEvent {
  return {
    type: 'tool/call',
    seq: 0,
    time: 1,
    data: {
      turn: 1,
      step: 1,
      callId,
      name,
      arguments: argumentsJson,
    },
  } as unknown as SessionEvent
}

function toolResult(
  callId: string,
  options: {
    readonly content?: readonly unknown[]
    readonly isError?: boolean
    readonly meta?: unknown
    readonly messageContent?: readonly unknown[]
  } = {},
): SessionEvent {
  return {
    type: 'tool/result',
    seq: 1,
    time: 2,
    data: {
      turn: 1,
      step: 1,
      message: {
        content: options.messageContent ?? [{
          type: 'tool-result',
          content: options.content ?? [{ type: 'text', text: 'done' }],
          isError: options.isError === true,
        }],
        source: { kind: 'tool', callId },
      },
      ...(options.meta === undefined ? {} : { meta: options.meta }),
    },
    surfaceOp: 'append',
  } as unknown as SessionEvent
}

function projectorFor(definition: object | undefined, maxPendingCalls = 256) {
  const ctx = new Context()
  const agent = { id: 'agent-a' } as unknown as Agent
  const get = vi.fn(() => definition)
  ctx.provide('tools', { get } as never)
  return {
    ctx,
    agent,
    get,
    projector: new DshToolPresentationProjector(ctx, agent, maxPendingCalls),
  }
}

describe('DshToolPresentationProjector', () => {
  it('uses the exact live Agent scope and pairs call arguments into result presentation', async () => {
    const presentCall = vi.fn(() => ({
      card: 'generic' as const,
      title: 'Read a.ts',
      kind: 'read' as const,
    }))
    const presentResult = vi.fn(() => ({
      card: 'read' as const,
      path: 'a.ts',
      offset: 1,
      lines: [{ number: 1, text: 'hello' }],
      totalLines: 1,
    }))
    const bench = projectorFor({ presentCall, presentResult })

    expect(bench.projector.project(toolCall('call-a'))).toEqual({
      for: 'call',
      view: {
        phase: 'call',
        card: 'generic',
        title: 'Read a.ts',
        kind: 'read',
      },
    })
    expect(bench.projector.project(toolResult('call-a', {
      meta: { path: 'a.ts' },
    }))).toEqual({
      for: 'result',
      view: {
        phase: 'result',
        card: 'read',
        path: 'a.ts',
        offset: 1,
        lines: [{ number: 1, text: 'hello' }],
        totalLines: 1,
      },
    })

    expect(bench.get).toHaveBeenNthCalledWith(1, 'read', bench.agent)
    expect(bench.get).toHaveBeenNthCalledWith(2, 'read', bench.agent)
    expect(presentCall).toHaveBeenCalledWith({ path: 'a.ts' })
    expect(presentResult).toHaveBeenCalledWith(
      { path: 'a.ts' },
      {
        content: [{ type: 'text', text: 'done' }],
        isError: false,
        meta: { path: 'a.ts' },
      },
    )
    await bench.ctx.fiber.dispose()
  })

  it('soft-falls to an explicit null annotation for missing pairing and invalid JSON', async () => {
    const presentResult = vi.fn(() => ({ card: 'generic' as const, title: 'Done' }))
    const bench = projectorFor({ presentResult })

    expect(bench.projector.project(toolCall('bad', '{'))).toEqual({
      for: 'call',
      view: null,
    })
    expect(bench.projector.project(toolResult('bad'))).toEqual({
      for: 'result',
      view: null,
    })
    expect(presentResult).not.toHaveBeenCalled()
    await bench.ctx.fiber.dispose()
  })

  it('contains absent, throwing, and malformed presenters without losing the event', async () => {
    const presentResult = vi.fn(() => ({ card: 'generic' as const, title: 'Recovered' }))
    const throwing = projectorFor({
      presentCall: () => { throw new Error('presenter failed') },
      presentResult,
    })
    expect(throwing.projector.project(toolCall('throw'))).toEqual({
      for: 'call',
      view: null,
    })
    expect(throwing.projector.project(toolResult('throw'))).toEqual({
      for: 'result',
      view: { phase: 'result', card: 'generic', title: 'Recovered' },
    })
    expect(presentResult).toHaveBeenCalledOnce()
    await throwing.ctx.fiber.dispose()

    const malformed = projectorFor({
      presentCall: () => ({ card: 'diff', title: 'bad', diffs: 'not-an-array' }),
    })
    expect(malformed.projector.project(toolCall('malformed'))).toEqual({
      for: 'call',
      view: null,
    })
    await malformed.ctx.fiber.dispose()

    const absent = projectorFor(undefined)
    expect(absent.projector.project(toolCall('absent'))).toEqual({
      for: 'call',
      view: null,
    })
    await absent.ctx.fiber.dispose()
  })

  it('rejects invalid bounds and contains malformed or throwing result presenters', async () => {
    const base = projectorFor(undefined)
    expect(() => new DshToolPresentationProjector(base.ctx, base.agent, 0)).toThrow(RangeError)
    expect(() => new DshToolPresentationProjector(base.ctx, base.agent, 1.5)).toThrow(RangeError)
    await base.ctx.fiber.dispose()

    const presentResult = vi.fn(() => ({ card: 'generic' as const, title: 'unused' }))
    const malformed = projectorFor({ presentResult })
    malformed.projector.project(toolCall('missing-block'))
    expect(malformed.projector.project(toolResult('missing-block', {
      messageContent: [],
    }))).toEqual({ for: 'result', view: null })
    malformed.projector.project(toolCall('invalid-block'))
    expect(malformed.projector.project(toolResult('invalid-block', {
      messageContent: [{ type: 'tool-result', content: 'not-an-array' }],
    }))).toEqual({ for: 'result', view: null })
    expect(presentResult).not.toHaveBeenCalled()
    await malformed.ctx.fiber.dispose()

    const throwing = projectorFor({
      presentResult: () => { throw new Error('result presenter failed') },
    })
    throwing.projector.project(toolCall('throw-result'))
    expect(throwing.projector.project(toolResult('throw-result'))).toEqual({
      for: 'result',
      view: null,
    })
    await throwing.ctx.fiber.dispose()
  })

  it('bounds pending call state and safely falls back when afterSeq skipped the call', async () => {
    const presentResult = vi.fn(() => ({ card: 'generic' as const, title: 'Done' }))
    const bench = projectorFor({ presentResult }, 2)
    bench.projector.project(toolCall('call-1'))
    bench.projector.project(toolCall('call-2'))
    bench.projector.project(toolCall('call-3'))

    expect(bench.projector.project(toolResult('call-1'))).toEqual({
      for: 'result',
      view: null,
    })
    expect(bench.projector.project(toolResult('call-3'))).toEqual({
      for: 'result',
      view: { phase: 'result', card: 'generic', title: 'Done' },
    })

    const reconnect = new DshToolPresentationProjector(bench.ctx, bench.agent)
    expect(reconnect.project(toolResult('call-2'))).toEqual({
      for: 'result',
      view: null,
    })
    await bench.ctx.fiber.dispose()
  })

  it('does not annotate non-tool durable events', async () => {
    const bench = projectorFor(undefined)
    const event = {
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
    } as unknown as SessionEvent
    expect(bench.projector.project(event)).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })
})
