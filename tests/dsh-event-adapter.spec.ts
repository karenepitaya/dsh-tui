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
  it.each([undefined, 'true'])('does not invent a boolean outcome from isError=%s', isError => {
    const converted = convertSessionEvent('session-a', event({
      type: 'tool/result', seq: 0, time: 10, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: 'legacy-result', role: 'user', source: { kind: 'tool', callId: 'legacy' },
          content: [{ type: 'tool-result', content: [], isError }],
        },
      },
    }))
    expect(converted.type).toBe('tool/result')
    expect(converted.data).not.toHaveProperty('isError')
  })

  it.each([true, false])('preserves the explicit tool-result isError=%s flag', isError => {
    const result = createToolResultMessage({
      callId: CallId('explicit-outcome'),
      content: [{ type: 'text', text: 'Error is a documented word' }],
      isError,
    })
    const raw = event({
      type: 'tool/result', seq: 0, time: 10, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: result },
    })
    const converted = convertSessionEvent('session-a', raw)
    expect(converted).toMatchObject({
      type: 'tool/result',
      data: {
        isError,
        message: { content: [{ type: 'text', text: 'Error is a documented word' }] },
      },
    })
    expect(converted.data).not.toHaveProperty('error')
    expect(convertSessionEvent('session-a', JSON.parse(JSON.stringify(raw)) as SessionEvent))
      .toEqual(converted)
  })

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
        message: {
          id: result.id,
          role: 'user',
          sourceKind: 'tool',
          content: [{ type: 'text', text: 'done' }],
        },
        error: { code: 'FAILED' },
        meta: { path: 'a.txt' },
      },
    })
    expect(converted[9]).toMatchObject({ ignorable: true })
  })

  it('projects message blocks into product-owned content without leaking unknown text', () => {
    const converted = convertSessionEvent('session-a', event({
      type: 'assistant/message',
      seq: 0,
      time: 10,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-structured',
          role: 'assistant',
          source: { kind: 'model' },
          content: [
            { type: 'reasoning', text: 'private chain' },
            { type: 'text', text: 'visible answer' },
            {
              type: 'image',
              attachment: {
                attachmentId: 'attachment-1',
                mediaType: 'image/png',
                bytes: 16,
                width: 2,
                height: 2,
                name: 'diagram.png',
                originalDimensions: { width: 4, height: 4 },
              },
            },
            { type: 'tool-call', id: 'call-2', name: 'read', arguments: '{"path":"a"}' },
            { type: 'future-private-block', text: 'must never become visible text' },
            { text: 'also must never become visible text' },
          ],
        },
      },
      surfaceOp: 'append',
    }))

    expect(converted).toMatchObject({
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'private chain' },
            { type: 'text', text: 'visible answer' },
            {
              type: 'image',
              attachment: {
                attachmentId: 'attachment-1',
                mediaType: 'image/png',
                bytes: 16,
                width: 2,
                height: 2,
                name: 'diagram.png',
                originalDimensions: { width: 4, height: 4 },
              },
            },
            { type: 'tool-call', id: 'call-2', name: 'read', arguments: '{"path":"a"}' },
            { type: 'unsupported', sourceType: 'future-private-block' },
            { type: 'unsupported', sourceType: 'unknown' },
          ],
        },
      },
    })
    expect(JSON.stringify(converted)).not.toContain('must never become visible text')
  })

  it('fails closed for malformed recognized blocks and keeps valid minimal images', () => {
    const converted = convertSessionEvent('session-a', event({
      type: 'user/message',
      seq: 0,
      time: 10,
      data: {
        id: 'user-malformed-content',
        role: 'user',
        source: { kind: 'user' },
        content: [
          7,
          { type: 'text', text: 7 },
          { type: 'reasoning', text: null },
          { type: 'image', attachment: null },
          {
            type: 'image',
            attachment: {
              attachmentId: 'attachment-minimal',
              mediaType: 'image/webp',
              bytes: 0,
              width: 1,
              height: 1,
              originalDimensions: { width: 0, height: 1 },
            },
          },
          { type: 'tool-call', id: 7, name: 'read', arguments: '{}' },
        ],
      },
      surfaceOp: 'append',
    }))

    if (converted.type !== 'user/message') throw new Error('expected user/message')
    expect(converted.data.message.content).toEqual([
      { type: 'unsupported', sourceType: 'unknown' },
      { type: 'unsupported', sourceType: 'text' },
      { type: 'unsupported', sourceType: 'reasoning' },
      { type: 'unsupported', sourceType: 'image' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'attachment-minimal',
          mediaType: 'image/webp',
          bytes: 0,
          width: 1,
          height: 1,
        },
      },
      { type: 'unsupported', sourceType: 'tool-call' },
    ])
  })

  it('keeps only text and reasoning deltas renderable while preserving every durable seq', () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'private' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'private' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
      { type: 'future-delta', text: 'must not leak' },
      7,
    ].map((chunk, seq) => convertSessionEvent('session-a', event({
      type: 'assistant/chunk',
      seq,
      time: 10 + seq,
      data: { turn: 1, step: 1, chunk },
    })))

    expect(chunks.map(chunk => chunk.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(chunks.map(chunk => chunk.type)).toEqual(Array(10).fill('assistant/chunk'))
    expect(chunks.map(chunk => chunk.type === 'assistant/chunk'
      ? chunk.data.chunk
      : undefined)).toEqual([
      { type: 'unsupported', sourceType: 'block-start' },
      { type: 'reasoning-delta', index: 0, text: 'private' },
      { type: 'unsupported', sourceType: 'block-end' },
      { type: 'unsupported', sourceType: 'block-start' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'unsupported', sourceType: 'block-end' },
      { type: 'unsupported', sourceType: 'usage' },
      { type: 'unsupported', sourceType: 'finish' },
      { type: 'unsupported', sourceType: 'future-delta' },
      { type: 'unsupported', sourceType: 'unknown' },
    ])
    expect(JSON.stringify(chunks)).not.toContain('must not leak')
  })

  it('projects request route epochs without retaining prompt, tools, or arbitrary header payloads', () => {
    const header = convertSessionEvent('session-a', event({
      type: 'request/header',
      seq: 0,
      time: 10,
      data: {
        reason: 'initial',
        header: {
          config: {
            provider: 'deepseek-official',
            model: 'deepseek-v4-flash',
            reasoningEffort: 'high',
            temperature: 0.2,
            maxTokens: 8_192,
            stop: ['END'],
            privateOption: 'must not cross the adapter',
          },
          adapterDefaults: { reasoningEffort: true, maxTokens: true, privateDefault: true },
          system: 'private system prompt',
          tools: [{ name: 'private_tool', description: 'private schema' }],
        },
        privateState: 'must not cross the adapter',
      },
    }))
    const context = convertSessionEvent('session-a', event({
      type: 'request/context',
      seq: 1,
      time: 11,
      data: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        contextWindow: 1_000_000,
        privateRegistration: 'must not cross the adapter',
      },
    }))

    expect(header).toMatchObject({
      type: 'request/header',
      data: {
        reason: 'initial',
        config: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoningEffort: 'high',
          temperature: 0.2,
          maxTokens: 8_192,
          stop: ['END'],
        },
        adapterDefaults: { reasoningEffort: true, maxTokens: true },
      },
    })
    expect(context).toMatchObject({
      type: 'request/context',
      data: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        contextWindow: 1_000_000,
      },
    })
    const serialized = JSON.stringify([header, context])
    expect(serialized).not.toContain('private system prompt')
    expect(serialized).not.toContain('private_tool')
    expect(serialized).not.toContain('must not cross the adapter')
  })

  it('keeps optional request route fields sparse and independently adapter-owned', () => {
    const convertHeader = (adapterDefaults: Record<string, unknown>) => convertSessionEvent(
      'session-a',
      event({
        type: 'request/header',
        seq: 0,
        time: 10,
        data: {
          reason: 'change',
          header: {
            config: { provider: 'provider', model: 'model' },
            adapterDefaults,
          },
        },
      }),
    )

    expect(convertHeader({})).toMatchObject({
      type: 'request/header',
      data: { reason: 'change', config: { provider: 'provider', model: 'model' } },
    })
    expect(convertHeader({})).not.toHaveProperty('data.adapterDefaults')
    expect(convertHeader({ reasoningEffort: true })).toHaveProperty(
      'data.adapterDefaults',
      { reasoningEffort: true },
    )
    expect(convertHeader({ maxTokens: true })).toHaveProperty(
      'data.adapterDefaults',
      { maxTokens: true },
    )

    expect(convertSessionEvent('session-a', event({
      type: 'request/context',
      seq: 1,
      time: 11,
      data: { provider: 'provider', model: 'model' },
    }))).toMatchObject({
      type: 'request/context',
      data: { provider: 'provider', model: 'model' },
    })
  })

  it('fails closed for malformed request route records', () => {
    for (const [type, data] of [
      ['request/header', { reason: 'fallback', header: { config: { provider: 'p', model: 'm' } } }],
      ['request/header', { reason: 'change', header: { config: { provider: '', model: 'm' } } }],
      ['request/header', { reason: 'change', header: { config: { provider: 'p', model: 'm', stop: [1] } } }],
      ['request/header', { reason: 'change', header: { config: { provider: 'p', model: 'm' }, adapterDefaults: { maxTokens: false } } }],
      ['request/context', { provider: 'p', model: '', contextWindow: 1_000 }],
      ['request/context', { provider: 'p', model: 'm', contextWindow: 0 }],
    ] as const) {
      expect(convertSessionEvent('session-a', event({ type, seq: 0, time: 10, data })))
        .toMatchObject({
          type: 'session/unsupported',
          data: { sourceType: `${type}:malformed-data` },
        })
    }
  })

  it('keeps known and ignorable vocabulary cursor-safe and fails loud for unknown required events', () => {
    const known = convertSessionEvent('session-a', event({
      type: 'session/end-seed',
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
      data: { sourceType: 'session/end-seed', ignorable: false },
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

  it('normalizes the official provider retry lifecycle without retaining arbitrary payloads', () => {
    const scheduled = convertSessionEvent('session-a', event({
      type: 'llm/retry',
      seq: 7,
      time: 70,
      data: {
        retryId: 'retry-chain-a',
        turn: 2,
        step: 3,
        provider: 'deepseek-official',
        mode: 'normal',
        policyKey: '["normal",5]',
        retry: 2,
        maxRetries: 5,
        delayMs: 1_250,
        failure: {
          message: 'provider busy',
          code: 'RATE_LIMIT',
          status: 429,
          providerRetryAfterMs: 1_250,
          requestId: 'request-7',
          privateWireBody: 'must not cross the adapter',
        },
        privateExecutorState: 'must not cross the adapter',
      },
    }))
    const started = convertSessionEvent('session-a', event({
      type: 'llm/retry-started',
      seq: 8,
      time: 1_320,
      data: {
        retryId: 'retry-chain-a',
        turn: 2,
        step: 3,
        retry: 2,
        privateExecutorState: 'must not cross the adapter',
      },
    }))
    const always = convertSessionEvent('session-a', event({
      type: 'llm/retry',
      seq: 9,
      time: 1_330,
      data: {
        retryId: 'retry-chain-b',
        turn: 2,
        step: 3,
        provider: 'fallback-route',
        mode: 'always',
        policyKey: '["always"]',
        retry: 1,
        delayMs: 500,
        failure: { message: 'bad key', code: 'AUTH' },
      },
    }))

    expect(scheduled).toEqual({
      plane: 'durable',
      sessionId: 'session-a',
      seq: 7,
      time: 70,
      type: 'llm/retry',
      data: {
        retryId: 'retry-chain-a',
        turn: 2,
        step: 3,
        provider: 'deepseek-official',
        mode: 'normal',
        policyKey: '["normal",5]',
        retry: 2,
        maxRetries: 5,
        delayMs: 1_250,
        failure: {
          message: 'provider busy',
          code: 'RATE_LIMIT',
          status: 429,
          providerRetryAfterMs: 1_250,
          requestId: 'request-7',
        },
      },
    })
    expect(started).toEqual({
      plane: 'durable',
      sessionId: 'session-a',
      seq: 8,
      time: 1_320,
      type: 'llm/retry-started',
      data: { retryId: 'retry-chain-a', turn: 2, step: 3, retry: 2 },
    })
    expect(always).toMatchObject({
      type: 'llm/retry',
      data: { mode: 'always', retry: 1 },
    })
    expect(always.data).not.toHaveProperty('maxRetries')
    expect(JSON.stringify([scheduled, started])).not.toContain('private')
  })

  it.each([
    ['llm/retry', { retryId: '', turn: 1, step: 1 }],
    ['llm/retry', {
      retryId: 'retry-malformed',
      turn: 1,
      step: 1,
      provider: 'mock',
      mode: 'normal',
      policyKey: 'policy',
      retry: 1,
      maxRetries: 5,
      delayMs: 500,
      failure: { message: '', code: 'SERVER' },
    }],
    ['llm/retry', {
      retryId: 'retry-over-budget',
      turn: 1,
      step: 1,
      provider: 'mock',
      mode: 'normal',
      policyKey: 'policy',
      retry: 2,
      maxRetries: 1,
      delayMs: 500,
      failure: { message: 'server failed', code: 'SERVER' },
    }],
    ['llm/retry', {
      retryId: 'retry-unknown-mode',
      turn: 1,
      step: 1,
      provider: 'mock',
      mode: 'future-mode',
      policyKey: 'policy',
      retry: 1,
      delayMs: 500,
      failure: { message: 'server failed', code: 'SERVER' },
    }],
    ['llm/retry-started', {
      retryId: 'retry-malformed',
      turn: 1,
      step: 1,
      retry: 0,
    }],
  ])('fails loud for malformed official %s data', (type, data) => {
    const converted = convertSessionEvent('session-a', event({
      type,
      seq: 0,
      time: 10,
      data,
    }))

    expect(converted).toEqual({
      plane: 'durable',
      sessionId: 'session-a',
      seq: 0,
      time: 10,
      type: 'session/unsupported',
      data: { sourceType: `${type}:malformed-data` },
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

  it('projects the official compaction transaction without retaining summary content', () => {
    const start = convertSessionEvent('session-a', event({
      type: 'compaction/start',
      seq: 0,
      time: 10,
      data: {
        compactionId: 'compaction-1',
        sourceCommandId: 'command-1',
        turn: null,
      },
    }))
    const summary = convertSessionEvent('session-a', event({
      type: 'compaction/summary',
      seq: 1,
      time: 11,
      data: {
        compactionId: 'compaction-1',
        sourceCommandId: 'command-1',
        summary: [{ type: 'text', text: 'private durable summary' }],
        rawOutput: [{ type: 'text', text: 'private raw output' }],
        llmStreamCall: true,
        shadowedRange: { start: 2, end: 8 },
        shadowedSeqs: [2, 3, 5, 8],
        shadowedTokenCount: 12_400,
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        maxTokens: 8_192,
      },
    }))
    const end = convertSessionEvent('session-a', event({
      type: 'compaction/end',
      seq: 2,
      time: 12,
      data: {
        compactionId: 'compaction-1',
        sourceCommandId: 'command-1',
        turn: null,
      },
    }))
    const prune = convertSessionEvent('session-a', event({
      type: 'compaction/prune',
      seq: 3,
      time: 13,
      data: {
        shadowedRange: { start: 4, end: 4 },
        shadowedSeqs: [4],
        shadowedTokenCount: 900,
      },
    }))

    expect(start).toMatchObject({
      type: 'compaction/start',
      data: {
        compactionId: 'compaction-1',
        sourceCommandId: 'command-1',
        turn: null,
      },
    })
    expect(summary).toMatchObject({
      type: 'compaction/summary',
      data: {
        compactionId: 'compaction-1',
        sourceCommandId: 'command-1',
        shadowedRange: { start: 2, end: 8 },
        shadowedSeqs: [2, 3, 5, 8],
        shadowedTokenCount: 12_400,
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
      },
    })
    expect(JSON.stringify(summary)).not.toContain('private durable summary')
    expect(JSON.stringify(summary)).not.toContain('private raw output')
    expect(end).toMatchObject({
      type: 'compaction/end',
      data: { compactionId: 'compaction-1', turn: null },
    })
    expect(prune).toMatchObject({
      type: 'session/observed',
      data: { sourceType: 'compaction/prune', ignorable: false },
    })
  })

  it('fails closed for malformed compaction lifecycle data', () => {
    const malformed = convertSessionEvent('session-a', event({
      type: 'compaction/summary',
      seq: 0,
      time: 10,
      data: {
        compactionId: '',
        shadowedRange: { start: 2, end: 8 },
        shadowedSeqs: [2, 'bad'],
        shadowedTokenCount: -1,
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
      },
    }))

    expect(malformed).toMatchObject({
      type: 'session/unsupported',
      data: { sourceType: 'compaction/summary:malformed-data' },
    })
  })

  it('covers optional and malformed compaction transaction metadata', () => {
    const startWithoutCommand = convertSessionEvent('session-a', event({
      type: 'compaction/start',
      seq: 0,
      time: 10,
      data: { compactionId: 'compaction-optional', turn: 2 },
    }))
    const failedEnd = convertSessionEvent('session-a', event({
      type: 'compaction/end',
      seq: 1,
      time: 11,
      data: { compactionId: 'compaction-optional', turn: null, error: 'summary failed' },
    }))
    expect(startWithoutCommand).toMatchObject({
      type: 'compaction/start',
      data: { compactionId: 'compaction-optional', turn: 2 },
    })
    expect(startWithoutCommand.data).not.toHaveProperty('sourceCommandId')
    expect(failedEnd).toMatchObject({
      type: 'compaction/end',
      data: { compactionId: 'compaction-optional', turn: null, error: 'summary failed' },
    })

    const malformedLifecycle = [
      event({ type: 'compaction/start', seq: 2, time: 12, data: null }),
      event({
        type: 'compaction/start',
        seq: 3,
        time: 13,
        data: { compactionId: 'compaction-bad-command', sourceCommandId: '', turn: null },
      }),
      event({
        type: 'compaction/start',
        seq: 4,
        time: 14,
        data: { compactionId: 'compaction-bad-turn', turn: 'not-a-turn' },
      }),
      event({
        type: 'compaction/start',
        seq: 5,
        time: 15,
        data: { compactionId: 'compaction-negative-turn', turn: -1 },
      }),
      event({
        type: 'compaction/end',
        seq: 6,
        time: 16,
        data: { compactionId: 'compaction-bad-error', turn: null, error: 42 },
      }),
      event({
        type: 'compaction/summary',
        seq: 7,
        time: 17,
        data: {
          compactionId: 'compaction-bad-summary-command',
          sourceCommandId: '',
          shadowedRange: { start: 0, end: 1 },
          shadowedSeqs: [0, 1],
          shadowedTokenCount: 10,
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
        },
      }),
    ].map(item => convertSessionEvent('session-a', item))
    expect(malformedLifecycle).toHaveLength(6)
    for (const converted of malformedLifecycle) {
      expect(converted.type).toBe('session/unsupported')
      if (converted.type !== 'session/unsupported') throw new Error('expected unsupported compaction event')
      expect(converted.data.sourceType).toMatch(/^compaction\/(?:start|summary|end):malformed-data$/u)
    }
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

  it('keeps a malformed official tool-result envelope visibly unsupported', () => {
    const converted = convertSessionEvent('session-a', event({
      type: 'tool/result',
      seq: 0,
      time: 10,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'malformed-result',
          role: 'user',
          source: { kind: 'tool', callId: 'call-malformed' },
          content: [{ type: 'tool-result', content: 'not-an-array' }],
        },
      },
      surfaceOp: 'append',
    }))

    expect(converted).toMatchObject({
      type: 'tool/result',
      data: {
        message: {
          content: [{ type: 'unsupported', sourceType: 'tool-result' }],
        },
      },
    })
  })
})
