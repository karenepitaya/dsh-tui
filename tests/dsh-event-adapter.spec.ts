import { describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { convertSessionEvent } from '../src/internal.ts'

function event(value: Record<string, unknown>): SessionEvent {
  return value as unknown as SessionEvent
}

describe('official DSH session event adapter', () => {
  it('normalizes every transcript-bearing core event without changing durable identity', () => {
    const user = createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    })
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'world' }],
      source: { provider: 'test-provider', model: 'test-model' },
    })
    const callId = CallId('call-1')
    const result = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    })

    const converted = [
      event({ type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } }),
      event({ type: 'turn/end', seq: 1, time: 11, data: { turn: 1, reason: { kind: 'completed' } } }),
      event({ type: 'step/start', seq: 2, time: 12, data: { turn: 1, step: 1 } }),
      event({ type: 'step/end', seq: 3, time: 13, data: { turn: 1, step: 1 } }),
      event({ type: 'user/message', seq: 4, time: 14, data: user, surfaceOp: 'append' }),
      event({
        type: 'assistant/chunk',
        seq: 5,
        time: 15,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'w' } },
      }),
      event({
        type: 'assistant/message',
        seq: 6,
        time: 16,
        data: {
          turn: 1,
          step: 1,
          message: assistant,
          usage: { inputTokens: 2, outputTokens: 1 },
          interrupted: true,
        },
        surfaceOp: 'append',
        sourceEventSeqs: [5],
      }),
      event({
        type: 'tool/call',
        seq: 7,
        time: 17,
        data: { turn: 1, step: 1, callId, name: 'read', arguments: '{}' },
      }),
      event({
        type: 'tool/result',
        seq: 8,
        time: 18,
        data: {
          turn: 1,
          step: 1,
          message: result,
          error: { name: 'ToolError', code: 'FAILED' },
          meta: { path: 'a.txt' },
        },
        surfaceOp: 'append',
      }),
      event({
        type: 'todo/write',
        seq: 9,
        time: 19,
        data: { todos: [{ content: 'ship M1', status: 'in_progress' }] },
        ignorable: true,
      }),
    ].map(item => convertSessionEvent('session-a', item))

    expect(converted.map(item => item.type)).toEqual([
      'turn/start',
      'turn/end',
      'step/start',
      'step/end',
      'user/message',
      'assistant/chunk',
      'assistant/message',
      'tool/call',
      'tool/result',
      'todo/write',
    ])
    expect(converted[4]).toMatchObject({
      plane: 'durable',
      sessionId: 'session-a',
      seq: 4,
      time: 14,
      data: { message: { id: user.id, role: 'user', sourceKind: 'user' }, surfaceOp: 'append' },
    })
    expect(converted[6]).toMatchObject({
      sourceEventSeqs: [5],
      data: {
        message: { id: assistant.id, role: 'assistant', sourceKind: 'model' },
        usage: { inputTokens: 2, outputTokens: 1 },
        interrupted: true,
      },
    })
    expect(converted[8]).toMatchObject({
      data: {
        callId: 'call-1',
        message: { id: result.id, role: 'user', sourceKind: 'tool' },
        error: { code: 'FAILED' },
        meta: { path: 'a.txt' },
      },
    })
    expect(converted[9]).toMatchObject({ ignorable: true })
  })

  it('keeps known and ignorable vocabulary cursor-safe and fails loud for unknown required events', () => {
    const known = convertSessionEvent('session-a', event({
      type: 'request/header',
      seq: 0,
      time: 10,
      data: { ignoredByThisProjection: true },
    }))
    const futureIgnorable = convertSessionEvent('session-a', event({
      type: 'future/telemetry',
      seq: 1,
      time: 11,
      data: { value: 1 },
      ignorable: true,
    }))
    const futureRequired = convertSessionEvent('session-a', event({
      type: 'future/required',
      seq: 2,
      time: 12,
      data: { value: 2 },
    }))

    expect(known).toMatchObject({
      type: 'session/observed',
      data: { sourceType: 'request/header', ignorable: false },
    })
    expect(futureIgnorable).toMatchObject({
      type: 'session/observed',
      data: { sourceType: 'future/telemetry', ignorable: true },
      ignorable: true,
    })
    expect(futureRequired).toMatchObject({
      type: 'session/unsupported',
      data: { sourceType: 'future/required' },
    })
  })

  it('keeps official command lifecycle fields first-class without reconstructing absent input', () => {
    const source = { kind: 'user' }
    const runWithArgs = convertSessionEvent('session-a', event({
      type: 'command/run',
      seq: 0,
      time: 10,
      data: {
        commandId: 'command-with-args',
        name: 'goal',
        args: ' ship M4',
        source,
      },
    }))
    const runWithoutArgs = convertSessionEvent('session-a', event({
      type: 'command/run',
      seq: 1,
      time: 11,
      data: {
        commandId: 'command-without-args',
        name: 'feedback',
        source,
      },
    }))
    const runWithEmptyArgs = convertSessionEvent('session-a', event({
      type: 'command/run',
      seq: 2,
      time: 12,
      data: {
        commandId: 'command-empty-args',
        name: 'plan',
        args: '',
        source,
      },
    }))
    const doneWithSource = convertSessionEvent('session-a', event({
      type: 'command/done',
      seq: 3,
      time: 13,
      data: {
        commandId: 'command-with-args',
        kind: 'success',
        text: 'Goal updated',
        sourceEventSeq: 0,
      },
    }))
    const doneWithoutText = convertSessionEvent('session-a', event({
      type: 'command/done',
      seq: 4,
      time: 14,
      data: {
        commandId: 'command-without-args',
        kind: 'success',
      },
    }))

    expect(runWithArgs).toMatchObject({
      type: 'command/run',
      data: {
        commandId: 'command-with-args',
        name: 'goal',
        args: ' ship M4',
        source,
      },
    })
    if (runWithArgs.type !== 'command/run') throw new Error('expected command/run')
    expect(runWithArgs.data.source).toBe(source)
    expect(runWithoutArgs).toMatchObject({
      type: 'command/run',
      data: {
        commandId: 'command-without-args',
        name: 'feedback',
        source,
      },
    })
    expect(runWithoutArgs.data).not.toHaveProperty('args')
    expect(runWithEmptyArgs.data).toHaveProperty('args', '')
    expect(doneWithSource).toMatchObject({
      type: 'command/done',
      data: {
        commandId: 'command-with-args',
        kind: 'success',
        text: 'Goal updated',
        sourceEventSeq: 0,
      },
    })
    expect(doneWithoutText.data).not.toHaveProperty('text')
    expect(doneWithoutText.data).not.toHaveProperty('sourceEventSeq')
  })

  it('turns malformed surface events into compatibility failures', () => {
    const user = createUserMessage({
      content: [{ type: 'text', text: 'missing surface op' }],
      source: { kind: 'user' },
    })
    const malformedUser = convertSessionEvent('session-a', event({
      type: 'user/message',
      seq: 0,
      time: 10,
      data: user,
    }))
    const malformedTool = convertSessionEvent('session-a', event({
      type: 'tool/result',
      seq: 1,
      time: 11,
      data: { turn: 1, step: 1, message: user },
      surfaceOp: 'append',
    }))

    expect(malformedUser).toMatchObject({
      type: 'session/unsupported',
      data: { sourceType: 'user/message:missing-surface-op' },
    })
    expect(malformedTool).toMatchObject({
      type: 'session/unsupported',
      data: { sourceType: 'tool/result:invalid-tool-message' },
    })
  })

  it('omits absent optional assistant and tool-result fields', () => {
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'plain' }],
      source: { provider: 'test-provider', model: 'test-model' },
    })
    const result = createToolResultMessage({
      callId: CallId('call-plain'),
      content: [{ type: 'text', text: 'plain' }],
      isError: false,
    })
    const assistantEvent = convertSessionEvent('session-a', event({
      type: 'assistant/message',
      seq: 0,
      time: 10,
      data: { turn: 1, step: 1, message: assistant },
      surfaceOp: 'append',
    }))
    const toolEvent = convertSessionEvent('session-a', event({
      type: 'tool/result',
      seq: 1,
      time: 11,
      data: { turn: 1, step: 1, message: result },
      surfaceOp: 'append',
    }))

    expect(assistantEvent.data).not.toHaveProperty('usage')
    expect(assistantEvent.data).not.toHaveProperty('interrupted')
    expect(toolEvent.data).not.toHaveProperty('error')
    expect(toolEvent.data).not.toHaveProperty('meta')
  })
})
