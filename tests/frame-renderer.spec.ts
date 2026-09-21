import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import {
  createPromptEditorState,
  createUiState,
  reduceUiEvent,
  renderDshFrame,
  selectSession,
  type InteractionSnapshot,
  type CommandRow,
  type UiState,
} from '../src/internal.ts'
import { durable, message, runtime } from './fixtures.ts'
import type { PermissionPickerView } from '../src/permission/picker.ts'
import type { SessionContextSnapshot } from '../src/context/port.ts'
import type {
  LlmAttemptChain,
  LlmAttemptPhase,
} from '../src/llm/attempts.ts'
import type { SessionLlmAttemptState } from '../src/llm/attempts.ts'
import type { SessionRequestRouteState } from '../src/llm/routes.ts'
import {
  contextOccupancy,
  formatTokenCount,
} from '../src/ui/frame.ts'
import { renderStatusFrame } from '../src/ui/workspace-status.ts'

const CONTEXT_SNAPSHOT: SessionContextSnapshot = {
  available: true,
  asOfSeq: 42,
  pressure: {
    pressureTokens: 32_000,
    projectedTokens: 3_000,
    contextWindow: 128_000,
  },
  breakdown: {
    systemTokens: 120,
    toolsTokens: 21_500,
    messageTokens: 477_000,
  },
  usage: {
    uncachedInputTokens: 32_000,
    outputTokens: 800,
    cacheReadTokens: 4_000,
    cacheWriteTokens: 200,
  },
}
function populatedState(): UiState {
  let state = selectSession(createUiState(), 'session-a')
  const events = [
    durable(0, {
      type: 'user/message',
      data: {
        message: {
          ...message('u1', 'user', ''),
          content: [
            { type: 'text', text: '你好世界' },
            {
              type: 'image',
              attachment: {
                attachmentId: 'attachment-1',
                mediaType: 'image/png',
                bytes: 16,
                width: 2,
                height: 2,
              },
            },
            { type: 'unsupported', sourceType: 'plugin-block' },
            { type: 'unsupported', sourceType: 'unknown' },
          ],
        },
        surfaceOp: 'append',
      },
    }),
    durable(1, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          ...message('a1', 'assistant', ''),
          content: [
            { type: 'reasoning', text: 'think' },
            { type: 'text', text: 'answer' },
          ],
        },
        surfaceOp: 'append',
      },
    }),
    runtime(1, {
      type: 'assistant/chunk',
      data: {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'streaming' },
      },
    }),
    runtime(2, {
      type: 'assistant/chunk',
      data: { turn: 2, step: 1, chunk: { type: 'unsupported', sourceType: 'usage' } },
    }),
    durable(2, {
      type: 'tool/call',
      data: { turn: 2, step: 1, callId: 'running', name: 'read', arguments: '{}' },
    }),
    durable(3, {
      type: 'tool/result',
      data: {
        turn: 2,
        step: 2,
        callId: 'orphan',
        message: message('tr1', 'user', 'done', 'tool'),
        surfaceOp: 'append',
      },
    }),
    durable(4, {
      type: 'tool/result',
      data: {
        turn: 2,
        step: 3,
        callId: 'failed',
        message: message('tr2', 'user', 'bad', 'tool'),
        surfaceOp: 'append',
        error: { name: 'ToolError', code: 'FAILED' },
      },
    }),
  ]
  for (const event of events) state = reduceUiEvent(state, event)
  return state
}

function interactions(): InteractionSnapshot {
  return {
    type: 'interaction/snapshot',
    sessionId: 'session-a',
    pending: [
      {
        id: 'q1',
        kind: 'question',
        sessionId: 'session-a',
        questions: [
          {
            id: 'choice',
            header: 'Plan',
            question: 'Choose one',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
          { id: 'detail', question: 'Why?' },
        ],
      },
      {
        id: 'a1',
        kind: 'approval',
        sessionId: 'session-a',
        approvalId: 'approval-1',
        callId: 'call-1',
        toolName: 'pwsh',
        reason: 'needs access',
      },
      {
        id: 'a2',
        kind: 'approval',
        sessionId: 'session-a',
        approvalId: 'approval-2',
        callId: 'call-2',
        toolName: 'read',
      },
    ],
  }
}

describe('pure frame renderer', () => {
  it('renders permission policy as a compact current-to-candidate control', () => {
    const permissionPicker: PermissionPickerView = {
      rows: [
        {
          value: 'workspace-write',
          name: 'Workspace write',
          description: 'Write inside the workspace and ask before wider access.',
          selectable: true,
          isCurrent: true,
        },
        {
          value: 'danger-full-access',
          name: 'Full access',
          description: 'Full file access without approval prompts.',
          selectable: true,
          isCurrent: false,
        },
        {
          value: 'custom',
          name: 'Custom',
          description: 'Current settings do not match a preset.',
          selectable: false,
          isCurrent: false,
        },
      ],
      selectedIndex: 1,
      selectedValue: 'danger-full-access',
      offset: 0,
      totalCount: 3,
      currentValue: 'workspace-write',
      available: true,
      writable: false,
      stale: true,
      generation: 4,
      selecting: true,
      error: 'projection\u001b[2J failed',
    }
    const base = {
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState('hidden'),
      permissionPicker,
      commandNotice: 'switch blocked\u0007',
    }

    const one = renderDshFrame(base, { columns: 80, rows: 1 })
    expect(one.lines[0]).toContain('Permission Presets')
    expect(one.lines[0]).not.toContain('PERMISSIONS · SESSION POLICY')
    expect(one.overlay).toBeUndefined()
    expect(one.cursor).toBeUndefined()

    const two = renderDshFrame(base, { columns: 80, rows: 2 })
    expect(two.lines[1]).toContain('Esc back')
    const three = renderDshFrame(base, { columns: 80, rows: 3 })
    expect(three.lines.at(-1)).toContain('Esc back')

    const full = renderDshFrame(base, { columns: 120, rows: 24 })
    const output = full.lines.join('\n')
    expect(output).toContain('Policies')
    expect(output).toContain('Selection')
    expect(output).not.toContain('├─')
    expect(output).toContain('Applying the official /permission command')
    expect(output).toContain('projection failed')
    expect(output).toContain('Full access')
    expect(output).toContain('Policy metadata unavailable · inspection only')
    expect(output).toContain('danger-full-access')
    expect(output).toContain('Full file access without approval prompts')
    expect(output).toContain('Custom')
    expect(output).toContain('current only')
    expect(output).not.toContain('\u001b')
    expect(full.lineStyles).toContainEqual(expect.objectContaining({
      backgroundRole: 'selectionBackground',
      fill: true,
    }))
    expect(full.styleSpans?.every(spans => spans[0]?.style.backgroundRole === 'panelBackground')).toBe(true)

    const applying = renderDshFrame({
      ...base,
      permissionPicker: {
        ...permissionPicker,
        stale: false,
        writable: true,
      },
    }, { columns: 80, rows: 8 })
    expect(applying.lines.join('\n')).toContain('Applying')

    const scrolled = renderDshFrame({
      ...base,
      permissionPicker: {
        ...permissionPicker,
        rows: Array.from({ length: 6 }, (_, index) => ({
          value: `preset-${index}`,
          name: `Preset ${index}`,
          selectable: index !== 5,
          isCurrent: index === 0,
        })),
        selectedIndex: 5,
        selectedValue: 'preset-5',
        totalCount: 6,
        currentValue: 'preset-0',
        writable: true,
        stale: false,
        selecting: false,
      },
    }, { columns: 80, rows: 8 })
    expect(scrolled.lines.join('\n')).toContain('Preset 5')
    expect(scrolled.lines.join('\n')).toContain('current only')

    const empty = renderDshFrame({
      ui: base.ui,
      interaction: base.interaction,
      prompt: base.prompt,
      permissionPicker: {
        ...permissionPicker,
        rows: [],
        selectedIndex: -1,
        selectedValue: undefined,
        currentValue: undefined,
        available: false,
        writable: false,
        stale: false,
        selecting: false,
        error: undefined,
      } as unknown as PermissionPickerView,
    }, { columns: 32, rows: 8 })
    expect(empty.lines.join('\n')).toContain('No permission profiles')
    expect(empty.lines.join('\n')).toContain('Unavailable')
    for (const line of empty.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(32)
  })

  it('surfaces a durable provider failure instead of ending with a silent user prompt', () => {
    let ui = selectSession(createUiState(), 'session-a')
    for (const event of [
      durable(0, { type: 'turn/start', data: { turn: 1 } }),
      durable(1, {
        type: 'user/message',
        data: {
          message: message('u1', 'user', 'hello'),
          surfaceOp: 'append',
        },
      }),
      durable(2, {
        type: 'turn/end',
        data: {
          turn: 1,
          reason: {
            kind: 'error',
            error: { code: 'PROVIDER_ERROR', message: 'provider unavailable' },
          },
        },
      }),
    ]) ui = reduceUiEvent(ui, event)

    const frame = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
    }, { columns: 80, rows: 12 })
    const conversation = frame.conversation
    expect(conversation).toBeDefined()
    expect(conversation?.nodes).toContainEqual(expect.objectContaining({
      kind: 'notice',
      key: 'turn-end:1',
      lines: ['REQUEST FAILED · PROVIDER_ERROR: provider unavailable'],
    }))
  })

  it('renders retry history as a full solid request-recovery Workspace without rebuilding conversation', () => {
    let ui = selectSession(createUiState(), 'session-a')
    for (const event of [
      durable(0, { type: 'turn/start', data: { turn: 1 } }),
      durable(1, { type: 'step/start', data: { turn: 1, step: 1 } }),
      durable(2, {
        type: 'llm/retry',
        data: {
          retryId: 'retry-a',
          turn: 1,
          step: 1,
          provider: 'deepseek-official',
          mode: 'normal',
          policyKey: 'normal',
          retry: 1,
          maxRetries: 5,
          delayMs: 500,
          failure: {
            message: 'provider busy', code: 'RATE_LIMIT', status: 429, requestId: 'request-a1',
          },
        },
      }),
      durable(3, {
        type: 'llm/retry-started',
        data: { retryId: 'retry-a', turn: 1, step: 1, retry: 1 },
      }),
      durable(4, {
        type: 'llm/retry',
        data: {
          retryId: 'retry-a',
          turn: 1,
          step: 1,
          provider: 'deepseek-official',
          mode: 'normal',
          policyKey: 'normal',
          retry: 2,
          maxRetries: 5,
          delayMs: 1_000,
          failure: {
            message: 'provider still busy', code: 'RATE_LIMIT', status: 429, requestId: 'request-a2',
          },
        },
      }),
      durable(5, {
        type: 'llm/retry-started',
        data: { retryId: 'retry-a', turn: 1, step: 1, retry: 2 },
      }),
      durable(6, {
        type: 'llm/retry',
        data: {
          retryId: 'retry-b',
          turn: 1,
          step: 1,
          provider: 'rerouted-provider',
          mode: 'always',
          policyKey: 'always',
          retry: 1,
          delayMs: 750,
          failure: { message: 'credential rejected', code: 'AUTH', requestId: 'request-b1' },
        },
      }),
    ]) ui = reduceUiEvent(ui, event)
    const attempts = ui.sessions['session-a']?.llmAttempts
    if (attempts === undefined) throw new Error('missing attempt projection')

    const base = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('draft stays put'),
    }, { columns: 140, rows: 36 })
    const overlay = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('draft stays put'),
      statusPanel: true,
    }, { columns: 140, rows: 36 })
    const output = overlay.lines.join('\n')

    expect(base.conversation).toBeDefined()
    expect(base.overlay).toBeUndefined()
    expect(overlay.conversation).toBeUndefined()
    expect(overlay.viewport).toEqual(base.viewport)
    expect(overlay.overlay).toBeUndefined()
    expect(overlay.lines).toHaveLength(36)
    expect(output).toContain('Status')
    expect(output).toContain('Request recovery')
    expect(output).toContain('×01 ─ ◆02')
    expect(output).toContain('rerouted-provider')
    expect(output).toContain('AUTH')
    expect(output).toContain('Request id  request-b1')
    expect(output).toContain('WAIT 750ms')
    expect(output).toContain('↑↓/j/k scroll')
    expect(output).not.toContain('draft stays put')
    expect(overlay.styleSpans?.every(spans => spans[0]?.style.backgroundRole === 'panelBackground')).toBe(true)
    for (const line of overlay.lines) expect(visibleWidth(line)).toBe(140)
  })

  it('renders every request-recovery terminal state, empty history, and short overlay height', () => {
    const baseUi = selectSession(createUiState(), 'session-a')
    const uiWithAttempts = (llmAttempts: SessionLlmAttemptState): UiState => ({
      ...baseUi,
      sessions: {
        ...baseUi.sessions,
        'session-a': { ...baseUi.sessions['session-a']!, llmAttempts },
      },
    })
    const phases: readonly LlmAttemptPhase[] = [
      'backoff',
      'requesting',
      'recovered',
      'failed',
      'cancelled',
      'rerouted',
      'reconfigured',
    ]
    const rendered = phases.map((phase, index) => {
      const attempts = phase === 'recovered'
        ? []
        : [{
            retry: 1,
            scheduledSeq: index + 1,
            scheduledAt: 1_000 + index,
            delayMs: index === 0 ? 1_500 : 500,
            failure: {
              message: `${phase} failure`,
              code: 'SERVER',
              status: 503,
              providerRetryAfterMs: 1_500,
              requestId: `request-${phase}`,
            },
          }]
      const selected: LlmAttemptChain = {
        retryId: `retry-${phase}`,
        turn: index + 1,
        step: 1,
        phase,
        provider: `provider-${phase}`,
        mode: phase === 'rerouted' ? 'always' : 'normal',
        policyKey: `${phase}-policy`,
        ...(phase === 'rerouted' || phase === 'recovered' ? {} : { maxRetries: 1 }),
        ...(phase === 'reconfigured' ? { omittedAttemptCount: 2 } : {}),
        attempts,
      }
      return renderDshFrame({
        ui: uiWithAttempts({ chains: [selected] }),
        interaction: undefined,
        prompt: createPromptEditorState(),
        statusPanel: true,
      }, { columns: 100, rows: 20 }).lines.join('\n')
    }).join('\n')

    for (const label of [
      'BACKOFF', 'REQUESTING', 'RECOVERED', 'FAILED', 'CANCELLED', 'REROUTED', 'POLICY CHANGED',
    ]) {
      expect(rendered).toContain(`State  ${label}`)
    }
    for (const symbol of ['◆', '◉', '✓', '×', '○', '↗', '↻']) expect(rendered).toContain(symbol)
    expect(rendered).toContain('WAIT 1.5s')
    expect(rendered).toContain('Provider delay  1.5s')
    expect(rendered).toContain('Request id  request-backoff')
    expect(rendered).toContain('Policy  always · unbounded retries')
    expect(rendered).toContain('Failed request  1 / 1 · retry 01 · +2 older')
    expect(rendered).toContain('Failure  —')
    expect(rendered).toContain('Message  —')

    const emptyOutput = renderDshFrame({
      ui: baseUi,
      interaction: undefined,
      prompt: createPromptEditorState(),
      statusPanel: true,
    }, { columns: 80, rows: 12 }).lines.join('\n')
    expect(emptyOutput).toContain('No provider recovery has been scheduled.')

    for (const rows of [1, 2, 3]) {
      const short = renderDshFrame({
        ui: baseUi,
        interaction: undefined,
        prompt: createPromptEditorState(),
        statusPanel: true,
      }, { columns: 80, rows })
      expect(short.lines).toHaveLength(rows)
      expect(short.lines[0]).toContain('Status')
    }
  })

  it('renders official route epochs as a full solid route Workspace without reflowing conversation', () => {
    let ui = selectSession(createUiState(), 'session-a')
    for (const event of [
      durable(0, {
        type: 'request/header',
        data: {
          reason: 'initial',
          config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          adapterDefaults: { reasoningEffort: true },
        },
      }),
      durable(1, {
        type: 'request/context',
        data: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          contextWindow: 1_000_000,
        },
      }),
      durable(2, {
        type: 'request/header',
        data: {
          reason: 'change',
          config: {
            provider: 'openai',
            model: 'gpt-route',
            reasoningEffort: 'high',
            temperature: 0.2,
            maxTokens: 8_192,
            stop: ['END'],
          },
          adapterDefaults: { maxTokens: true },
        },
      }),
      durable(3, {
        type: 'request/context',
        data: { provider: 'openai', model: 'gpt-route', contextWindow: 256_000 },
      }),
    ]) ui = reduceUiEvent(ui, event)
    const routes = ui.sessions['session-a']?.requestRoutes
    if (routes === undefined) throw new Error('missing route projection')

    const base = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('draft stays put'),
    }, { columns: 150, rows: 38 })
    const overlay = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('draft stays put'),
      statusPanel: true,
    }, { columns: 150, rows: 38 })
    const output = overlay.lines.join('\n')

    expect(base.conversation).toBeDefined()
    expect(overlay.conversation).toBeUndefined()
    expect(overlay.viewport).toEqual(base.viewport)
    expect(overlay.overlay).toBeUndefined()
    expect(overlay.lines).toHaveLength(38)
    expect(output).toContain('Model route')
    expect(output).toContain('◆01 ─ ◉02')
    expect(output).toContain('openai/gpt-route')
    expect(output).toContain('State  CURRENT')
    expect(output).toContain('Effort  high · caller')
    expect(output).toContain('Max output  8.2K · adapter default')
    expect(output).toContain('Context window  256K')
    expect(output).toContain('Official request/header + request/context')
    expect(output).not.toContain('draft stays put')
    expect(overlay.styleSpans?.every(spans => spans[0]?.style.backgroundRole === 'panelBackground')).toBe(true)
    for (const line of overlay.lines) expect(visibleWidth(line)).toBe(150)

    const omittedUi: UiState = {
      ...ui,
      sessions: {
        ...ui.sessions,
        'session-a': {
          ...ui.sessions['session-a']!,
          requestRoutes: { ...routes, omittedEpochCount: 3 },
        },
      },
    }
    const omittedOutput = renderDshFrame({
      ui: omittedUi,
      interaction: undefined,
      prompt: createPromptEditorState(),
      statusPanel: true,
    }, { columns: 150, rows: 38 }).lines.join('\n')
    expect(omittedOutput).toContain('…3 ─ ◆04 ─ ◉05')
  })

  it('renders empty route history and every compact status-page height', () => {
    const ui = selectSession(createUiState(), 'session-a')
    const output = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      statusPanel: true,
    }, { columns: 80, rows: 12 }).lines.join('\n')
    expect(output).toContain('Send a prompt to materialize the official route.')
    expect(output).toContain('Token meter offline')

    for (const rows of [1, 2, 3]) {
      const short = renderDshFrame({
        ui,
        interaction: undefined,
        prompt: createPromptEditorState(),
        statusPanel: true,
      }, { columns: 80, rows })
      expect(short.lines).toHaveLength(rows)
      expect(short.lines[0]).toContain('Status')
    }
  })

  it('renders resumed request epochs with their distinct route semantics', () => {
    let ui = selectSession(createUiState(), 'session-a')
    ui = reduceUiEvent(ui, durable(0, {
      type: 'request/header',
      data: {
        reason: 'resume',
        config: { provider: 'deepseek-official', model: 'resumed-model' },
      },
    }))
    ui = reduceUiEvent(ui, durable(1, {
      type: 'request/header',
      data: {
        reason: 'change',
        config: { provider: 'deepseek-official', model: 'changed-model' },
      },
    }))
    ui = reduceUiEvent(ui, durable(2, {
      type: 'request/header',
      data: {
        reason: 'change',
        config: { provider: 'deepseek-official', model: 'current-model' },
      },
    }))
    const routes = ui.sessions['session-a']?.requestRoutes
    if (routes === undefined) throw new Error('missing resumed route projection')

    const output = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      statusPanel: true,
    }, { columns: 120, rows: 30 }).lines.join('\n')
    expect(output).toContain('↻01')
    expect(output).toContain('◇02')
    expect(output).toContain('deepseek-official/current-model')
    expect(output).toContain('State  CURRENT')

    const resumedOnly: SessionRequestRouteState = { epochs: [routes.epochs[0]!] }
    const resumedOutput = renderStatusFrame({
      sessionId: 'session-a',
      context: { available: false },
      routes: resumedOnly,
    }, { columns: 120, rows: 30 }).lines.join('\n')
    expect(resumedOutput).toContain('◉01')
    expect(resumedOutput).toContain('Header  RESUME')
    expect(resumedOutput).toContain('deepseek-official/resumed-model')
  })

  it.each([
    [{ kind: 'completed' }, undefined],
    [{ kind: 'error', error: 'opaque failure' },
      'REQUEST FAILED · UNKNOWN: the provider request failed without a diagnostic'],
    [{ kind: 'blocked' }, 'REQUEST BLOCKED · no response was produced'],
    [{ kind: 'max-tokens' }, 'RESPONSE STOPPED · model token limit reached'],
    [{ kind: 'interrupted' }, 'REQUEST INTERRUPTED'],
    [{ kind: 'aborted', reason: { kind: 'host-shutdown' } },
      'REQUEST CANCELLED · host-shutdown'],
    [{ kind: 'aborted', reason: null }, 'REQUEST CANCELLED · unknown cause'],
    [{ kind: 'future-ending' }, 'REQUEST ENDED · future-ending'],
    [null, 'REQUEST ENDED · unknown'],
  ] as const)('renders every durable turn ending reason: %j', (reason, expected) => {
    let ui = selectSession(createUiState(), 'session-a')
    ui = reduceUiEvent(ui, durable(0, { type: 'turn/start', data: { turn: 1 } }))
    ui = reduceUiEvent(ui, durable(1, { type: 'turn/end', data: { turn: 1, reason } }))

    const frame = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
    }, { columns: 80, rows: 12 })
    const lines = frame.conversation?.nodes
      .filter(node => node.key === 'turn-end:1')
      .flatMap(node => node.kind === 'notice' ? node.lines : []) ?? []
    expect(lines[0]).toBe(expected)
  })

  it('keeps retained conversation and draft around an inline fail-closed approval', () => {
    const conversation = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState('0123456789中文输入'),
    }, { columns: 24, rows: 40 })
    const conversationOutput = conversation.lines.join('\n')
    expect(conversationOutput).toContain('DSH-TUI')
    expect(conversationOutput).toContain('你好世界')
    expect(conversationOutput).toContain('[image image/png')
    expect(conversationOutput).toContain('2x2]')
    expect(conversationOutput.match(/\[unsupported:/g)).toHaveLength(2)
    expect(conversationOutput).toContain('answer')
    expect(conversationOutput).not.toContain('think answer')
    expect(conversationOutput).not.toContain('streaming')
    expect(conversationOutput).toContain('■ 1 of 3 execution')
    expect(conversationOutput).toContain('…')
    expect(conversation.conversation?.nodes).toContainEqual(expect.objectContaining({
      activitySummary: '■ 1 of 3 execution steps unfinished · 1 failed · Ctrl+O for details',
    }))
    expect(conversationOutput).not.toContain('TOOLS ·')
    expect(conversation.cursor).toBeDefined()

    const approval = renderDshFrame({
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState('hidden draft'),
    }, { columns: 80, rows: 20 })
    const approvalOutput = approval.lines.join('\n')
    expect(approvalOutput).toContain('Incomplete evidence · Allow disabled')
    expect(approvalOutput).toContain('Input: unavailable')
    expect(approvalOutput).toContain('Working folder: unavailable')
    expect(approvalOutput).toContain('Access: Access unknown')
    expect(approvalOutput).toContain('› 2 Reject')
    expect(approvalOutput).toContain('1 Allow once [disabled]')
    expect(approvalOutput).toContain('hidden draft')
    expect(approvalOutput).toContain('answer')
    expect(approval.overlay).toBeUndefined()
    expect(approval.conversation?.dock).toMatchObject({ inline: true, label: 'Permission request', status: 'warning' })
    expect(approval.lineStyles).toHaveLength(approval.lines.length)
    expect(approval.lineStyles?.slice(-3).every(style => style?.backgroundRole === 'inputBackground')).toBe(true)
    for (const line of conversation.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24)
    for (const line of approval.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
  })

  it('keeps the header and editor usable in tiny viewports', () => {
    const view = {
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState('abcdef'),
    }
    const one = renderDshFrame(view, { columns: 1, rows: 1 })
    expect(one.lines).toHaveLength(1)
    expect(one.cursor).toBeUndefined()
    expect(visibleWidth(one.lines[0]!)).toBeLessThanOrEqual(1)

    const two = renderDshFrame(view, { columns: 4, rows: 2 })
    expect(two.lines).toHaveLength(2)
    expect(two.cursor).toEqual({ row: 1, column: 3 })
    expect(two.lines[1]).not.toContain('a')

    const three = renderDshFrame(view, { columns: 0, rows: 3 })
    expect(three.lines).toHaveLength(3)
    expect(three.cursor?.row).toBe(2)
    for (const line of three.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(1)
  })

  it('keeps tiny approval non-grantable with an explicit Escape path', () => {
    const frame = renderDshFrame({
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState(),
    }, { columns: 80, rows: 4 })

    expect(frame.lines).toHaveLength(4)
    expect(frame.lines[0]).toContain('Incomplete evidence · Allow disabled')
    expect(frame.lines.join('\n')).toContain('Esc reject')
    expect(frame.lines.join('\n')).toContain('Allow once [disabled]')
    expect(frame.cursor).toBeUndefined()
    expect(frame.conversation).toBeUndefined()
  })

  it('never emits terminal control sequences from untrusted session or model text', () => {
    const sessionId = 'session\x1b[2J\x1b]52;c;owned\x07'
    let ui = selectSession(createUiState(), sessionId)
    ui = reduceUiEvent(ui, durable(0, {
      type: 'user/message',
      data: {
        message: message('unsafe', 'user', 'before\x1b[31mred\x1b[0m\u0000after'),
        surfaceOp: 'append',
      },
    }, sessionId))
    const conversation = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('draft\x1b[6n'),
    }, { columns: 80, rows: 8 })
    const frame = renderDshFrame({
      ui,
      interaction: {
        type: 'interaction/snapshot',
        sessionId,
        pending: [{
          id: 'unsafe-question',
          kind: 'question',
          sessionId,
          questions: [{ id: 'q', header: '\x1b[2JPlan', question: 'safe\x07question' }],
        }],
      },
      prompt: createPromptEditorState('draft\x1b[6n'),
    }, { columns: 80, rows: 8 })

    const output = `${conversation.lines.join('\n')}\n${frame.lines.join('\n')}`
    expect(output).not.toContain('\x1b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    expect(output).toContain('beforered�after')
    expect(output).toContain('safe�question')
    for (const line of conversation.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
    for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
  })

  it('renders question and approval input modes without overwriting the normal draft', () => {
    const pending: InteractionSnapshot = {
      type: 'interaction/snapshot',
      sessionId: 'session-a',
      pending: [
        {
          id: 'q-active',
          kind: 'question',
          sessionId: 'session-a',
          questions: [
            {
              id: 'choice',
              header: 'Plan',
              question: 'Choose',
              detail: 'Read this first',
              options: [
                { label: 'Yes', description: 'Proceed safely' },
                { label: 'No' },
              ],
            },
            { id: 'why', question: 'Why?' },
          ],
        },
        {
          id: 'a-active',
          kind: 'approval',
          sessionId: 'session-a',
          approvalId: 'approval-active',
          callId: 'call-active',
          toolName: 'pwsh',
          evidence: {
            source: 'tool/call', arguments: '{"command":"Get-ChildItem"}', cwd: 'D:/workspace',
            currentPermission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' },
            requestedPermission: { kind: 'tool-call' }, missing: [],
          },
        },
      ],
    }
    const normal = createPromptEditorState('normal draft')
    const questionFrame = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: pending,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'q-active',
        questionIndex: 1,
        answerCount: 1,
        questionCount: 2,
        optionIndex: 0,
        selected: [],
        skipped: false,
        multiSelect: false,
        steps: ['answered', 'pending'],
        editor: createPromptEditorState('because'),
        error: 'Try again\x1b[2J',
      },
    }, { columns: 80, rows: 16 })
    const questionOutput = questionFrame.lines.join('\n')
    expect(questionOutput).toContain('▌ Answer')
    expect(questionOutput).toContain('Progress')
    expect(questionOutput).toContain('● 1')
    expect(questionOutput).toContain('◆ 2')
    expect(questionOutput).toContain('free response')
    expect(questionOutput).toContain('Why?')
    expect(questionOutput).toContain('✎')
    expect(questionOutput).toContain('because')
    expect(questionOutput).toContain('Try again')
    expect(questionOutput).not.toContain('STEP')
    expect(questionOutput).not.toContain('╭─')
    expect(questionOutput).not.toContain('Read this first')
    expect(questionOutput).not.toContain('Proceed safely')
    expect(questionOutput).not.toContain('[2J')
    expect(questionOutput).not.toContain('normal draft')

    const approvalFrame = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: pending,
      prompt: normal,
      input: {
        kind: 'approval',
        interactionId: 'a-active',
        editor: createPromptEditorState('y'),
        selectedIndex: 0,
      },
    }, { columns: 80, rows: 24 })
    const approvalOutput = approvalFrame.lines.join('\n')
    expect(approvalOutput).toContain('· 2/2')
    expect(approvalOutput).toContain('Allow pwsh?')
    expect(approvalOutput).not.toContain('call-active')
    expect(approvalOutput).toContain('normal draft')
    expect(normal.text).toBe('normal draft')
    expect(approvalOutput).toContain('› 1 Allow once')
    expect(approvalOutput).not.toContain('decision>')
    const allowLine = approvalFrame.lines.findIndex(line => line.includes('Allow once'))
    expect(allowLine).toBeGreaterThanOrEqual(0)
    expect(approvalFrame.conversation?.dock?.styledLines?.at(-2)?.segments[0]).toMatchObject({ text: '› 1 Allow once', tone: 'accent', bold: true })
    expect(approvalFrame.overlay).toBeUndefined()

    const rejectedApproval = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: pending,
      prompt: normal,
      input: {
        kind: 'approval',
        interactionId: 'a-active',
        editor: createPromptEditorState('n'),
        selectedIndex: 1,
        error: 'Decision rejected by runtime',
      },
    }, { columns: 100, rows: 28 })
    const rejectedOutput = rejectedApproval.lines.join('\n')
    expect(rejectedOutput).toContain('Decision rejected by runtime')
    expect(rejectedOutput).toContain('› 2 Reject')
    expect(rejectedOutput).toContain('Get-ChildItem')
    expect(rejectedOutput).toContain('Write within the workspace; session policy unchanged')
    expect(rejectedApproval.conversation?.dock?.styledLines?.at(-2)?.segments.at(-1)).toMatchObject({ text: '› 2 Reject', tone: 'error', bold: true })

    const tinyAllow = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: pending,
      prompt: normal,
      input: {
        kind: 'approval',
        interactionId: 'a-active',
        editor: createPromptEditorState('y'),
        selectedIndex: 0,
      },
    }, { columns: 80, rows: 3 })
    expect(tinyAllow.lines.join('\n')).toContain('Terminal too small')
    expect(tinyAllow.lines.join('\n')).toContain('Esc reject')
    expect(tinyAllow.lines.join('\n')).not.toContain('Allow once')

    const fullQuestion = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: pending,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'q-active',
        questionIndex: 0,
        answerCount: 0,
        editor: createPromptEditorState(),
      },
    }, { columns: 100, rows: 30 })
    expect(fullQuestion.lines.join('\n')).toContain('Read this first')
    expect(fullQuestion.lines.join('\n')).toContain('Proceed safely')
    expect(fullQuestion.lineStyles?.every(style => style?.background === 'black')).toBe(true)

    const richQuestions: InteractionSnapshot = {
      type: 'interaction/snapshot',
      sessionId: 'session-a',
      pending: [{
        id: 'q-rich',
        kind: 'question',
        sessionId: 'session-a',
        questions: [
          {
            id: 'colors',
            header: 'Palette',
            question: 'Choose colors',
            multiSelect: true,
            options: [
              { label: 'Yes', description: 'Proceed safely' },
              { label: 'No' },
            ],
          },
          { id: 'why', question: 'Why?' },
          { id: 'finish', question: 'Finish?', options: [{ label: 'Done' }] },
        ],
      }],
    }
    const richQuestion = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: richQuestions,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'q-rich',
        questionIndex: 0,
        answerCount: 1,
        questionCount: 3,
        optionIndex: 0,
        selected: ['Yes'],
        skipped: false,
        multiSelect: true,
        steps: ['answered', 'skipped', 'pending'],
        editor: createPromptEditorState('context'),
      },
    }, { columns: 100, rows: 24 })
    const richOutput = richQuestion.lines.join('\n')
    expect(richOutput).toContain('◆ 1')
    expect(richOutput).toContain('– 2')
    expect(richOutput).toContain('○ 3')
    expect(richOutput).toContain('1 skipped')
    expect(richOutput).toContain('multiple choice')
    expect(richOutput).toContain('☑ Yes')
    expect(richOutput).toContain('☐ No')
    expect(richOutput).toContain('Proceed safely')
    expect(richOutput).toContain('✎ context')

    const singleSelected = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: {
        ...richQuestions,
        pending: richQuestions.pending.map(item => item.kind === 'question'
          ? {
              ...item,
              questions: item.questions.map((candidate, index) => (
                index === 0 ? { ...candidate, multiSelect: false } : candidate
              )),
            }
          : item),
      },
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'q-rich',
        questionIndex: 0,
        answerCount: 1,
        questionCount: 3,
        optionIndex: 0,
        selected: ['Yes'],
        skipped: false,
        multiSelect: false,
        steps: ['answered', 'pending', 'pending'],
        editor: createPromptEditorState(),
      },
    }, { columns: 100, rows: 24 })
    expect(singleSelected.lines.join('\n')).toContain('◉ Yes')

    const skippedQuestion = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: richQuestions,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'q-rich',
        questionIndex: 1,
        answerCount: 2,
        questionCount: 3,
        optionIndex: 0,
        selected: [],
        skipped: true,
        multiSelect: false,
        steps: ['answered', 'skipped', 'pending'],
        editor: createPromptEditorState(),
      },
    }, { columns: 80, rows: 16 })
    expect(skippedQuestion.lines.join('\n')).toContain('✎ Skipped')
    expect(skippedQuestion.cursor).toBeUndefined()

    const fallbackProgress = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: richQuestions,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'q-rich',
        questionIndex: 1,
        answerCount: 1,
        questionCount: 3,
        optionIndex: 0,
        selected: [],
        skipped: false,
        multiSelect: false,
        editor: createPromptEditorState(),
      },
    }, { columns: 80, rows: 12 })
    expect(fallbackProgress.lines.join('\n')).toContain('● 1')
    expect(fallbackProgress.lines.join('\n')).toContain('○ 3')

    const zeroCapacityOptions = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: richQuestions,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'q-rich',
        questionIndex: 0,
        answerCount: 0,
        questionCount: 3,
        optionIndex: 0,
        selected: [],
        skipped: false,
        multiSelect: true,
        steps: ['pending', 'pending', 'pending'],
        editor: createPromptEditorState(),
        error: 'choose or skip',
      },
    }, { columns: 80, rows: 7 })
    expect(zeroCapacityOptions.lines.join('\n')).toContain('✎ Other answer')
    expect(zeroCapacityOptions.lines.join('\n')).toContain('choose or skip')

    const hiddenCustom = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: richQuestions,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'q-rich',
        questionIndex: 1,
        answerCount: 1,
        questionCount: 3,
        optionIndex: 0,
        selected: [],
        skipped: false,
        multiSelect: false,
        steps: ['answered', 'pending', 'pending'],
        editor: createPromptEditorState('hidden by compact error'),
        error: 'answer rejected',
      },
    }, { columns: 80, rows: 6 })
    expect(hiddenCustom.lines.join('\n')).toContain('answer rejected')
    expect(hiddenCustom.cursor).toBeUndefined()

    const oneRowQuestion = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: pending,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'q-active',
        questionIndex: 0,
        answerCount: 0,
        editor: createPromptEditorState(),
      },
    }, { columns: 40, rows: 1 })
    expect(oneRowQuestion.lines).toHaveLength(1)
    expect(oneRowQuestion.cursor).toBeUndefined()

    const twoRowQuestion = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: pending,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'q-active',
        questionIndex: 0,
        answerCount: 0,
        editor: createPromptEditorState(),
      },
    }, { columns: 40, rows: 2 })
    expect(twoRowQuestion.cursor).toBeUndefined()

    const threeRowQuestion = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: pending,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'q-active',
        questionIndex: 0,
        answerCount: 0,
        editor: createPromptEditorState(),
      },
    }, { columns: 40, rows: 3 })
    expect(threeRowQuestion.lines.join('\n')).toContain('○ Yes')

    const compactEmptyQuestion: InteractionSnapshot = {
      type: 'interaction/snapshot',
      sessionId: 'session-a',
      pending: [{
        id: 'empty-question',
        kind: 'question',
        sessionId: 'session-a',
        questions: [],
      }],
    }
    const emptyQuestionFrame = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: compactEmptyQuestion,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'empty-question',
        questionIndex: 0,
        answerCount: 0,
        editor: createPromptEditorState(),
      },
    }, { columns: 60, rows: 5 })
    expect(emptyQuestionFrame.lines.join('\n')).toContain('No question payload')

    const staleQuestion = renderDshFrame({
      ui: createUiState(),
      interaction: undefined,
      prompt: normal,
      input: {
        kind: 'question',
        interactionId: 'already-gone',
        questionIndex: 0,
        answerCount: 0,
        editor: createPromptEditorState(),
      },
    }, { columns: 40, rows: 3 })
    expect(staleQuestion.lines.join('\n')).not.toContain('Question 1/1:')
    expect(staleQuestion.lines.at(-1)).toContain('answer>')

    const staleApproval = renderDshFrame({
      ui: createUiState(),
      interaction: undefined,
      prompt: normal,
      input: {
        kind: 'approval',
        interactionId: 'already-gone',
        editor: createPromptEditorState('n'),
        selectedIndex: 1,
        error: 'stale approval',
      },
    }, { columns: 60, rows: 12 })
    expect(staleApproval.lines.join('\n')).toContain('PERMISSION DECISION')
    expect(staleApproval.lines.join('\n')).toContain('decision> n')
    expect(staleApproval.lines.join('\n')).toContain('Error: stale approval')

    const staleReview = renderDshFrame({
      ui: createUiState(),
      interaction: undefined,
      prompt: normal,
      input: {
        kind: 'plan-review',
        interactionId: 'already-gone',
        selectedIndex: 0,
        actionCount: 1,
        editor: createPromptEditorState('Approve'),
      },
    }, { columns: 60, rows: 12 })
    expect(staleReview.lines.join('\n')).toContain('PLAN REVIEW RESPONSE')
    expect(staleReview.lines.join('\n')).toContain('review> Approve')
  })

  it('renders durable command lifecycle rows and finite protocol diagnostics', () => {
    const selected = selectSession(createUiState(), 'session-a')
    const session = selected.sessions['session-a']!
    const rows: readonly CommandRow[] = [
      {
        kind: 'command',
        key: 'command:running',
        commandId: 'running',
        status: 'running',
      },
      {
        kind: 'command',
        key: 'command:orphan',
        commandId: 'orphan',
        name: 'goal',
        status: 'error',
        text: 'failed\x1b[2J',
        protocolDiagnostics: { doneWithoutRun: true },
      },
      {
        kind: 'command',
        key: 'command:duplicate-run',
        commandId: 'duplicate-run',
        name: 'compact',
        status: 'success',
        protocolDiagnostics: { duplicateRun: true },
      },
      {
        kind: 'command',
        key: 'command:duplicate-done',
        commandId: 'duplicate-done',
        name: 'feedback',
        status: 'error',
        protocolDiagnostics: { duplicateDone: true },
      },
      {
        kind: 'command',
        key: 'command:empty-diagnostic',
        commandId: 'empty-diagnostic',
        status: 'success',
        protocolDiagnostics: {},
      },
    ]
    const ui: UiState = {
      ...selected,
      sessions: {
        ...selected.sessions,
        'session-a': { ...session, rows },
      },
    }
    const frame = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
    }, { columns: 80, rows: 30 })
    const output = frame.lines.join('\n')
    expect(output).toContain('CMD  running')
    expect(output).toContain('Status: running')
    expect(output).toContain('CMD  /goal')
    expect(output).toContain('Status: error · orphan done')
    expect(output).toContain('failed')
    expect(output).toContain('CMD  /compact')
    expect(output).toContain('Status: success · duplicate run')
    expect(output).toContain('CMD  /feedback')
    expect(output).toContain('Status: error · duplicate done')
    expect(output).toContain('CMD  empty-diagnostic')
    expect(output).not.toContain('\x1b')
  })

  it('renders a bounded command list with no title, provenance, or shortcut chrome', () => {
    const base = {
      ui: selectSession(createUiState(), 'session-a'),
      interaction: undefined,
      prompt: createPromptEditorState('/'),
    }
    const menu = renderDshFrame({
      ...base,
      commandMenu: {
        query: '',
        candidates: [
          {
            origin: 'official',
            command: {
              name: 'compact',
              description: 'Compact older conversation history through the official Harness runtime',
              input: { hint: '<scope>' },
            },
          },
          {
            origin: 'official',
            command: {
              name: 'goal',
              description: 'Set or view the goal for a long-running task and all of its lifecycle actions',
            },
          },
          {
            origin: 'local',
            command: {
              name: 'sessions',
              description: 'Browse sessions\x1b[2J',
            },
          },
        ],
        selectedIndex: 2,
        totalCount: 4,
      },
      commandNotice: 'catalog refreshed\x1b[31m',
    }, { columns: 80, rows: 9 })
    const menuOutput = menu.lines.join('\n')
    expect(menuOutput).toContain('  /compact')
    expect(menuOutput).toContain('Compact context')
    expect(menuOutput).toContain('/goal')
    expect(menuOutput).toContain('Manage goal')
    expect(menuOutput).not.toContain('older conversation history')
    expect(menuOutput).not.toContain('long-running task')
    expect(menuOutput).not.toContain('<scope>')
    expect(menuOutput).toContain('› /sessions')
    expect(menuOutput).toContain('Browse sessions')
    expect(menuOutput).not.toContain('[DSH/official]')
    expect(menuOutput).not.toContain('[DSH-TUI/local]')
    expect(menuOutput).not.toContain('more')
    expect(menuOutput).toContain('catalog refreshed')
    expect(menuOutput).not.toContain('Up/Down select')
    expect(menuOutput).not.toContain('Enter use')
    expect(menuOutput).not.toContain('Tab complete')
    expect(menuOutput).not.toContain('COMMANDS')
    expect(menuOutput).not.toContain('COMMAND PALETTE')
    expect(menuOutput).not.toContain('\x1b')
    expect(menu.conversation?.composer).toBe('/')
    expect(menu.overlay).toBeUndefined()
    expect(menu.conversation?.dock?.styledLines?.[2]?.segments[0]).toMatchObject({
      tone: 'accent',
      bold: true,
    })
    expect(menu.lineStyles?.slice(-3).every(style => style?.backgroundRole === 'inputBackground')).toBe(true)
    expect(menu.lineStyles?.slice(0, -3).every(style => style === undefined)).toBe(true)

    const compactMenu = {
      query: '',
      candidates: [],
      selectedIndex: -1,
      totalCount: 0,
    }
    const oneLine = renderDshFrame({ ...base, commandMenu: compactMenu }, {
      columns: 80,
      rows: 1,
    })
    expect(oneLine.lines).toHaveLength(1)
    expect(oneLine.lines[0]).toContain('DSH-TUI')
    expect(oneLine.conversation?.composer).toBe('/')
    expect(oneLine.cursor).toBeUndefined()

    const twoLines = renderDshFrame({ ...base, commandMenu: compactMenu }, {
      columns: 80,
      rows: 2,
    })
    expect(twoLines.lines).toHaveLength(2)
    expect(twoLines.cursor?.row).toBe(1)
    expect(twoLines.lines[0]).toContain('DSH-TUI')

    const narrow = renderDshFrame({ ...base, commandMenu: compactMenu }, {
      columns: 1,
      rows: 2,
    })
    expect(narrow.lines).toHaveLength(2)
    for (const line of narrow.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(1)

    const exact = renderDshFrame({
      ...base,
      commandMenu: {
        query: 'c',
        candidates: [{
          origin: 'official',
          command: { name: 'compact', description: 'Compact' },
        }],
        selectedIndex: 0,
        totalCount: 1,
      },
    }, { columns: 80, rows: 5 })
    expect(exact.lines.join('\n')).not.toContain('more')

    const noMatch = renderDshFrame({
      ...base,
      commandMenu: { query: 'zzz', candidates: [], selectedIndex: -1, totalCount: 0 },
    }, { columns: 50, rows: 5 })
    expect(noMatch.lines.join('\n')).toContain('No matches for /zzz')

    const pending = renderDshFrame({
      ...base,
      prompt: createPromptEditorState(),
      commandPending: true,
    }, { columns: 50, rows: 3 })
    expect(pending.lines.join('\n')).toContain('Command running')
    expect(pending.lines.join('\n')).not.toContain('Ctrl+C cancel')
  })

  it('keeps the initial binding visibly booting until hydration commits', () => {
    const selected = selectSession(createUiState(), 'session-a')
    const frame = renderDshFrame({
      ui: { ...selected, phase: 'booting' },
      interaction: undefined,
      prompt: createPromptEditorState('early draft'),
    }, { columns: 80, rows: 3 })

    expect(frame.lines[0]).toContain('session-a · booting')
    expect(frame.lines[0]).not.toContain('session-a · idle')
    expect(frame.lines.at(-1)).toContain('early draft')
  })

  it('projects durable transcript semantics into the conversation surface at every tiny height', () => {
    const selected = selectSession(createUiState(), 'session-a')
    const session = selected.sessions['session-a']!
    const rows = [
      {
        kind: 'user' as const,
        key: 'event:0' as const,
        seq: 0,
        message: message('empty-user', 'user', ''),
      },
      {
        kind: 'assistant' as const,
        key: 'event:1' as const,
        seq: 1,
        turn: 1,
        step: 1,
        message: {
          ...message('reasoning-only', 'assistant', ''),
          content: [{ type: 'reasoning' as const, text: 'private reasoning' }],
        },
        usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 7 },
        interrupted: true,
      },
      {
        kind: 'assistant' as const,
        key: 'event:2' as const,
        seq: 2,
        turn: 2,
        step: 1,
        message: message('empty-assistant', 'assistant', ''),
        interrupted: false,
      },
      {
        kind: 'assistant' as const,
        key: 'event:20' as const,
        seq: 20,
        turn: 20,
        step: 1,
        message: message('reasoning-metadata-only', 'assistant', 'answer without trace'),
        usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 11 },
        interrupted: false,
      },
      {
        kind: 'assistant-draft' as const,
        key: 'draft:3:1' as const,
        firstSeq: 3,
        lastSeq: 3,
        turn: 3,
        step: 1,
        text: '',
        reasoning: 'still thinking',
        chunkCount: 5,
      },
      {
        kind: 'assistant-draft' as const,
        key: 'draft:4:1' as const,
        firstSeq: 4,
        lastSeq: 4,
        turn: 4,
        step: 1,
        text: '',
        reasoning: '',
        chunkCount: 0,
      },
    ]
    const ui: UiState = {
      ...selected,
      phase: 'ready',
      sessions: {
        ...selected.sessions,
        'session-a': {
          ...session,
          omittedRowCount: 9,
          rows,
        },
      },
    }
    const view = {
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('中文 draft'),
      bindingEpoch: 17,
      reasoningExpanded: true,
    }

    const normal = renderDshFrame(view, { columns: 56, rows: 8 })
    expect(normal.conversation?.bindingEpoch).toBe(17)
    expect(normal.conversation?.reasoningExpanded).toBe(true)
    expect(normal.conversation?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'notice',
        key: 'projection-omission',
        lines: ['… 9 earlier projected rows omitted'],
      }),
      expect.objectContaining({ kind: 'user', text: '[Empty user message]' }),
      expect.objectContaining({
        kind: 'assistant',
        text: 'answer without trace',
        reasoningSummary: 'THOUGHT · 11 TOKENS · TEXT UNAVAILABLE',
      }),
    ]))
    expect(JSON.stringify(normal.conversation?.nodes)).not.toContain('private reasoning')
    expect(JSON.stringify(normal.conversation?.nodes)).not.toContain('still thinking')
    for (const node of normal.conversation?.nodes ?? []) {
      if (node.kind === 'assistant' || node.kind === 'assistant-draft') {
        expect(node).not.toHaveProperty('reasoning')
      }
    }

    for (const rowsCount of [1, 2, 3]) {
      const tiny = renderDshFrame(view, { columns: 16, rows: rowsCount })
      expect(tiny.lines).toHaveLength(rowsCount)
      expect(tiny.conversation?.nodes[0]).toMatchObject({
        kind: 'notice',
        revision: '9',
      })
      for (const line of tiny.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(16)
    }
  })
})

describe('official context-meter frame', () => {
  it('uses projected pressure, clamps occupancy, and formats token counts', () => {
    expect(contextOccupancy(CONTEXT_SNAPSHOT)).toEqual({
      percent: 2,
      usedTokens: 3_000,
      contextWindow: 128_000,
    })
    expect(contextOccupancy({
      available: true,
      pressure: { pressureTokens: 32_000, contextWindow: 128_000 },
    })).toEqual({ percent: 25, usedTokens: 32_000, contextWindow: 128_000 })
    expect(contextOccupancy({
      available: true,
      pressure: { pressureTokens: 300_000, contextWindow: 128_000 },
    })?.percent).toBe(100)
    expect(contextOccupancy({ available: true, pressure: { pressureTokens: 1 } })).toBeUndefined()
    expect(contextOccupancy({ available: true, pressure: { contextWindow: 1 } })).toBeUndefined()
    expect(contextOccupancy(undefined)).toBeUndefined()

    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1_200)).toBe('1.2K')
    expect(formatTokenCount(12_400)).toBe('12K')
    expect(formatTokenCount(1_200_000)).toBe('1.2M')
    expect(formatTokenCount(1_200_000_000)).toBe('1.2B')
  })

  it('renders occupancy, heuristic composition, cumulative usage, and provenance', () => {
    const frame = renderStatusFrame(
      { sessionId: 'session\x1b[2J\nunsafe', context: CONTEXT_SNAPSHOT },
      { columns: 140, rows: 16 },
    )
    const text = frame.lines.join('\n')

    expect(frame.lines).toHaveLength(16)
    expect(text).toContain('Status / Diagnostics')
    expect(text).toContain('Session  session↵unsafe  ·  Next request')
    expect(text).toContain('HEALTHY · 2%')
    expect(text).toContain('~3K / 128K')
    expect(text).toContain('Request envelope')
    expect(text).toContain('Provider usage')
    expect(frame.lineStyles).toContainEqual(expect.objectContaining({
      tone: 'success', inverse: true, fill: true,
    }))
    expect(text).toContain('System      120')
    expect(text).toContain('Tools       22K')
    expect(text).toContain('Messages    477K')
    expect(text).toContain('Input       36K')
    expect(text).toContain('Output      800')
    expect(text).toContain('Cache read  4K')
    const scrolled = renderStatusFrame(
      { sessionId: 'session-a', context: CONTEXT_SNAPSHOT },
      { columns: 140, rows: 9 },
      100,
    )
    expect(scrolled.lines.join('\n')).toContain('Compact No maintenance recorded')
    expect(scrolled.lines.join('\n')).toContain('Official projection · seq 42')
    expect(frame.lines.at(-1)).toContain('/compact maintain context')
    expect(frame.lineStyles?.every(style => style?.background === 'black')).toBe(true)
    expect(text).not.toContain('\x1b')

    const detailed = renderStatusFrame(
      {
        sessionId: 'session-a',
        context: CONTEXT_SNAPSHOT,
        compaction: {
          compactionId: 'compact-rich',
          phase: 'running',
          startSeq: 50,
          shadowedItemCount: 9,
          shadowedTokenCount: 12_000,
        },
      },
      { columns: 140, rows: 20 },
    )
    const detailedText = detailed.lines.join('\n')
    expect(detailedText).toContain('Request envelope')
    expect(detailedText).toContain('Provider usage')
    expect(detailedText).toContain('System      120')
    expect(detailedText).toContain('Tools       22K')
    expect(detailedText).toContain('Messages    477K')
    expect(detailedText).toContain('Input       36K')
    expect(detailedText).toContain('Output      800')
    expect(detailedText).toContain('Cache read  4K')
    expect(detailedText).toContain('Compaction')
    expect(detailedText).toContain('Source of truth')
    expect(detailedText).toContain('Running · 9 items · ~12K')
    expect(detailedText).toContain('Official projection · seq 42')
    expect(detailed.lineStyles).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: 'accent', bold: true, background: 'black' }),
      expect.objectContaining({ tone: 'success', background: 'black' }),
      expect.objectContaining({ tone: 'warning', background: 'black' }),
      expect.objectContaining({ tone: 'telemetry', background: 'black' }),
      expect.objectContaining({ tone: 'muted', background: 'black' }),
      expect.objectContaining({ tone: 'primary', background: 'black' }),
    ]))

    const pressured = renderStatusFrame(
      {
        sessionId: 'session-a',
        context: {
          ...CONTEXT_SNAPSHOT,
          pressure: {
            ...CONTEXT_SNAPSHOT.pressure,
            projectedTokens: 110_000,
          },
        },
      },
      { columns: 100, rows: 14 },
    )
    expect(pressured.lineStyles).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: 'warning' }),
    ]))

    const critical = renderStatusFrame(
      {
        sessionId: 'session-a',
        context: {
          ...CONTEXT_SNAPSHOT,
          pressure: {
            ...CONTEXT_SNAPSHOT.pressure,
            projectedTokens: 127_000,
          },
        },
      },
      { columns: 100, rows: 14 },
    )
    expect(critical.lines.join('\n')).toContain('CRITICAL')
    expect(critical.lineStyles).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: 'error' }),
    ]))
  })

  it('renders running and completed compaction accounting in the context section', () => {
    const runningWithoutCount = renderStatusFrame(
      {
        sessionId: 'running',
        context: CONTEXT_SNAPSHOT,
        compaction: {
          compactionId: 'compaction-running',
          phase: 'running',
          startSeq: 43,
        },
      },
      { columns: 120, rows: 10 },
      100,
    )
    expect(runningWithoutCount.lines.join('\n')).toContain('Compact Running')

    const runningWithoutTokens = renderStatusFrame(
      {
        sessionId: 'running-partial',
        context: CONTEXT_SNAPSHOT,
        compaction: {
          compactionId: 'compaction-running-partial',
          phase: 'running',
          startSeq: 44,
          shadowedItemCount: 3,
        },
      },
      { columns: 120, rows: 10 },
      100,
    )
    expect(runningWithoutTokens.lines.join('\n')).toContain('Compact Running')
    expect(runningWithoutTokens.lines.join('\n')).not.toContain('3 items')

    const completed = renderStatusFrame(
      {
        sessionId: 'completed',
        context: CONTEXT_SNAPSHOT,
        compaction: {
          compactionId: 'compaction-completed',
          phase: 'completed',
          startSeq: 40,
          summarySeq: 41,
          endSeq: 42,
          shadowedItemCount: 8,
          shadowedTokenCount: 12_400,
        },
      },
      { columns: 120, rows: 10 },
      100,
    )
    expect(completed.lines.join('\n')).toContain(
      'Compact Last: completed · 8 items · ~12K',
    )
  })

  it('renders partial, unavailable, and tiny context states without synthesizing pressure', () => {
    const providerSample = renderStatusFrame(
      {
        sessionId: 'sample',
        context: {
          available: true,
          pressure: { pressureTokens: 32_000, contextWindow: 128_000 },
        },
      },
      { columns: 90, rows: 5 },
    )
    expect(providerSample.lines.join('\n')).toContain(
      'HEALTHY · 25%',
    )
    expect(providerSample.lines.join('\n')).toContain('Latest request')

    const partial = renderStatusFrame(
      {
        sessionId: 'partial',
        context: {
          available: true,
          pressure: { pressureTokens: 32_000 },
        },
      },
      { columns: 90, rows: 8 },
    )
    expect(partial.lines.join('\n')).toContain(
      'Waiting for route capacity and provider usage',
    )
    expect(partial.lines.join('\n')).toContain('Latest request')
    expect(renderStatusFrame(
      {
        sessionId: 'partial',
        context: { available: true, pressure: { pressureTokens: 32_000 } },
      },
      { columns: 90, rows: 8 },
      100,
    ).lines.join('\n'))
      .toContain('Official projection · seq unknown')

    const noPressure = renderStatusFrame(
      {
        sessionId: 'no-pressure',
        context: {
          available: true,
          breakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
        },
      },
      { columns: 90, rows: 5 },
    )
    expect(noPressure.lines.join('\n')).toContain(
      'Waiting for route capacity and provider usage',
    )
    expect(noPressure.lines.join('\n')).toContain('No sample')

    const unavailable = renderStatusFrame(
      { sessionId: 'none', context: { available: false } },
      { columns: 80, rows: 8 },
    )
    expect(unavailable.lines.join('\n')).toContain('Token meter offline')
    expect(unavailable.lines.join('\n')).toContain('Official projections are not composed')
    expect(unavailable.lines.join('\n')).toContain('Local estimates remain disabled')

    const one = renderStatusFrame(
      { sessionId: 'tiny', context: CONTEXT_SNAPSHOT },
      { columns: 12, rows: 1 },
    )
    const two = renderStatusFrame(
      { sessionId: 'tiny', context: CONTEXT_SNAPSHOT },
      { columns: 20, rows: 2 },
    )
    const three = renderStatusFrame(
      { sessionId: 'tiny', context: CONTEXT_SNAPSHOT },
      { columns: 40, rows: 3 },
    )
    expect(one.lines).toHaveLength(1)
    expect(two.lines).toHaveLength(2)
    expect(three.lines).toHaveLength(3)
    expect(three.lines.at(-1)).toContain('/compact')
    for (const line of one.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(12)
    for (const line of two.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20)

    const absent = renderDshFrame({
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      statusPanel: true,
    }, { columns: 80, rows: 8 })
    expect(absent.lines[0]).toContain('Status')
    expect(absent.lines.join('\n')).toContain('Session  no-session')
    expect(absent.lines.join('\n')).toContain('Token meter offline')
  })

  it('shows live occupancy in the conversation statusline and gives the panel its own frame', () => {
    const ui = selectSession(createUiState(), 'session-a')
    const conversation = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      context: CONTEXT_SNAPSHOT,
    }, { columns: 100, rows: 10 })
    expect(conversation.lines.join('\n')).toContain('CTX [········] ~3K/128K 2%')

    const panel = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('hidden'),
      context: CONTEXT_SNAPSHOT,
      statusPanel: true,
    }, { columns: 100, rows: 10 })
    expect(panel.lines[0]).toContain('Status')
    expect(panel.overlay).toBeUndefined()
    expect(panel.lines.join('\n')).not.toContain('hidden')
  })

  it('keeps context pressure visible at the real release-gate width', () => {
    const ui = selectSession(
      createUiState(),
      'session-12ce3bc3-c96a-45b3-b39e-004d72578570',
    )
    const frame = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      context: CONTEXT_SNAPSHOT,
      model: {
        current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        routable: true,
        writable: true,
        loading: false,
        selecting: false,
        groups: [],
        failures: [],
      },
    }, { columns: 100, rows: 24 })

    expect(frame.lines.join('\n')).toContain('~3K/128K 2%')
    for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100)
  })
})