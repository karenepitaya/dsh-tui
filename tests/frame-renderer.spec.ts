import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import {
  createPromptEditorState,
  createUiState,
  reduceUiEvent,
  renderDshFrame,
  sessionInspectionMaxScrollOffset,
  selectSession,
  type InteractionSnapshot,
  type CommandRow,
  type UiState,
} from '../src/internal.ts'
import { durable, message } from './fixtures.ts'
import type { SessionPickerView } from '../src/session/picker.ts'
import type { StartupPresetPickerView } from '../src/preset/picker.ts'
import type { SessionModelSnapshot } from '../src/model/port.ts'
import type { ModelPickerView } from '../src/model/picker.ts'
import {
  renderStartupPresetFrame,
  type SessionInspectionPanel,
} from '../src/ui/frame.ts'

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
    durable(2, {
      type: 'assistant/chunk',
      data: {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'streaming' },
      },
    }),
    durable(3, {
      type: 'assistant/chunk',
      data: { turn: 2, step: 1, chunk: { type: 'unsupported', sourceType: 'usage' } },
    }),
    durable(4, {
      type: 'tool/call',
      data: { turn: 2, step: 1, callId: 'running', name: 'read', arguments: '{}' },
    }),
    durable(5, {
      type: 'tool/result',
      data: {
        turn: 2,
        step: 2,
        callId: 'orphan',
        message: message('tr1', 'user', 'done', 'tool'),
        surfaceOp: 'append',
      },
    }),
    durable(6, {
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
  it('renders the model picker and model summary without leaking control sequences', () => {
    const model: SessionModelSnapshot = {
      current: {
        provider: '小米\x1b[2J',
        model: 'mimo/超长\x1b]52;c;owned\x07',
        reasoningEffort: '深度',
      },
      defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
      routable: false,
      writable: false,
      loading: true,
      selecting: false,
      groups: [],
      failures: [{ provider: '小米', message: '目录\u0000失败' }],
      error: '刷新\x1b[31m失败',
    }
    const picker: ModelPickerView = {
      stage: 'models',
      groups: [{
        id: '小米\x1b[2J',
        name: '小米模型',
        models: [{
          provider: '小米\x1b[2J',
          providerName: '小米模型',
          id: 'mimo/超长\x1b]52;c;owned\x07',
          name: '米墨模型',
          efforts: [],
          retainedReasoningEffort: 'opaque/current',
          isCurrent: true,
          isDefault: false,
          catalogued: false,
          routable: false,
        }],
      }],
      selectedModel: { provider: '小米\x1b[2J', model: 'mimo/超长\x1b]52;c;owned\x07' },
      selectedModelIndex: 0,
      efforts: [],
      selectedEffortIndex: -1,
      current: model.current!,
      defaultSelection: model.defaultSelection!,
      routable: false,
      writable: false,
      loading: true,
      selecting: false,
      failures: model.failures,
      error: model.error!,
    }
    const frame = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: undefined,
      prompt: createPromptEditorState('hidden'),
      model,
      modelPicker: picker,
    }, { columns: 52, rows: 9 })

    const output = frame.lines.join('\n')
    expect(output).toContain('Models · [DSH-TUI/local] · read-only')
    expect(output).toContain('小米模型')
    expect(output).toContain('current')
    expect(output).toContain('unlisted')
    expect(output).toContain('unroutable')
    expect(output).toContain('目录�失败')
    expect(output).not.toContain('hidden')
    expect(output).not.toContain('\x1b')
    expect(frame.cursor).toBeUndefined()
    for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(52)
  })

  it('keeps model picker and model summary inside 1/2/3-line viewports', () => {
    const model: SessionModelSnapshot = {
      current: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
      routable: true,
      writable: true,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
    }
    const base = {
      ui: selectSession(createUiState(), 'session-a'),
      interaction: undefined,
      prompt: createPromptEditorState(),
      model,
    }
    const normal = renderDshFrame(base, { columns: 80, rows: 3 })
    expect(normal.lines[0]).toContain('deepseek/deepseek-reasoner · high')
    const picker: ModelPickerView = {
      stage: 'reasoning',
      groups: [],
      selectedModel: { provider: 'deepseek', model: 'deepseek-reasoner' },
      selectedModelIndex: 0,
      efforts: [{ kind: 'effort', id: 'high', name: 'High', isDefault: true }],
      selectedEffortIndex: 0,
      current: model.current!,
      routable: true,
      writable: true,
      loading: false,
      selecting: false,
      failures: [],
    }
    for (const rows of [1, 2, 3]) {
      const frame = renderDshFrame({ ...base, modelPicker: picker }, { columns: 12, rows })
      expect(frame.lines).toHaveLength(rows)
      expect(frame.cursor).toBeUndefined()
      for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(12)
    }
  })

  it('renders every model control status and empty-picker fallback', () => {
    const base = {
      ui: selectSession(createUiState(), 'session-a'),
      interaction: undefined,
      prompt: createPromptEditorState(),
    }
    const unmanaged: SessionModelSnapshot = {
      current: { provider: 'offline', model: 'legacy' },
      routable: false,
      writable: false,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
    }
    const summary = renderDshFrame({ ...base, model: unmanaged }, { columns: 80, rows: 3 })
    expect(summary.lines[0]).toContain(
      'offline/legacy · unroutable · managed by other Host',
    )

    const unmanagedBeforeFirstRequest = renderDshFrame({
      ...base,
      model: {
        routable: false,
        writable: false,
        loading: false,
        selecting: false,
        groups: [],
        failures: [],
      },
    }, { columns: 80, rows: 3 })
    expect(unmanagedBeforeFirstRequest.lines[0]).toContain('managed by other Host')

    const ownedBeforeFirstRequest = renderDshFrame({
      ...base,
      model: {
        routable: false,
        writable: true,
        loading: false,
        selecting: false,
        groups: [],
        failures: [],
      },
    }, { columns: 80, rows: 3 })
    expect(ownedBeforeFirstRequest.lines[0]).not.toContain('managed by other Host')

    const models: ModelPickerView = {
      stage: 'models',
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [
          {
            provider: 'provider',
            providerName: 'Provider',
            id: 'one',
            name: 'One',
            efforts: [],
            isCurrent: true,
            isDefault: true,
            catalogued: true,
            routable: true,
          },
          {
            provider: 'provider',
            providerName: 'Provider',
            id: 'two',
            name: 'Two',
            efforts: [],
            isCurrent: false,
            isDefault: false,
            catalogued: true,
            routable: true,
          },
        ],
      }],
      selectedModel: { provider: 'provider', model: 'one' },
      selectedModelIndex: 0,
      efforts: [],
      selectedEffortIndex: -1,
      current: { provider: 'provider', model: 'one' },
      routable: true,
      writable: true,
      loading: false,
      selecting: true,
      failures: [],
    }
    const modelFrame = renderDshFrame({ ...base, modelPicker: models }, {
      columns: 100,
      rows: 8,
    })
    const modelOutput = modelFrame.lines.join('\n')
    expect(modelOutput).toContain('Switching model')
    expect(modelOutput).toContain('› One')
    expect(modelOutput).toContain('  Two')

    const reasoning: ModelPickerView = {
      ...models,
      stage: 'reasoning',
      efforts: [
        { kind: 'provider-default', name: 'Provider default', isDefault: true },
        {
          kind: 'effort',
          id: 'verbose',
          name: 'Verbose',
          description: 'Adapter description',
          isDefault: false,
        },
      ],
      selectedEffortIndex: 0,
      writable: false,
      selecting: false,
    }
    const reasoningFrame = renderDshFrame({ ...base, modelPicker: reasoning }, {
      columns: 100,
      rows: 7,
    })
    const reasoningOutput = reasoningFrame.lines.join('\n')
    expect(reasoningOutput).toContain('› Provider default · default')
    expect(reasoningOutput).toContain('Verbose · id:verbose · Adapter description')
    expect(reasoningFrame.lines.at(-1)).toContain('Esc back')

    const emptyModels: ModelPickerView = {
      stage: 'models',
      groups: [],
      selectedModelIndex: -1,
      efforts: [],
      selectedEffortIndex: -1,
      routable: false,
      writable: true,
      loading: false,
      selecting: true,
      failures: [],
    }
    const emptyFrame = renderDshFrame({ ...base, modelPicker: emptyModels }, {
      columns: 80,
      rows: 5,
    })
    expect(emptyFrame.lines.join('\n')).toContain('No model catalog entries')
    const emptyTwo = renderDshFrame({ ...base, modelPicker: emptyModels }, {
      columns: 80,
      rows: 2,
    })
    expect(emptyTwo.lines[1]).toContain('Switching model')

    const emptyReasoning: ModelPickerView = {
      ...emptyModels,
      stage: 'reasoning',
      selecting: false,
    }
    expect(renderDshFrame({ ...base, modelPicker: emptyReasoning }, {
      columns: 80,
      rows: 4,
    }).lines.join('\n')).toContain('No reasoning options')

    const noSelected: ModelPickerView = {
      stage: 'models',
      groups: models.groups,
      selectedModelIndex: -1,
      efforts: [],
      selectedEffortIndex: -1,
      current: { provider: 'provider', model: 'one' },
      routable: true,
      writable: true,
      loading: false,
      selecting: false,
      failures: [],
    }
    const noSelectedBody = renderDshFrame({ ...base, modelPicker: noSelected }, {
      columns: 80,
      rows: 4,
    })
    expect(noSelectedBody.lines.join('\n')).toContain('Provider Provider')
    const noSelectedTwo = renderDshFrame({ ...base, modelPicker: noSelected }, {
      columns: 80,
      rows: 2,
    })
    expect(noSelectedTwo.lines[1]).toContain('Enter/Ctrl+S')
  })

  it('renders transcript, interactions, and prompt within terminal cell bounds', () => {
    const frame = renderDshFrame({
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState('0123456789中文输入'),
    }, { columns: 24, rows: 40 })

    const output = frame.lines.join('\n')
    expect(output).toContain('DSH-TUI')
    expect(output).toContain('You: 你好世界')
    expect(output).toContain('[image image/png 2x2]')
    expect(output.match(/\[unsupported:/g)).toHaveLength(2)
    expect(output).toContain('Assistant: answer')
    expect(output).not.toContain('think answer')
    expect(output).toContain('Assistant: streaming')
    expect(output).toContain('Tool read · running')
    expect(output).toContain('Tool orphan · done')
    expect(output).toContain('Tool failed · failed')
    expect(output).toContain('FAILED')
    expect(output).toContain('Plan: Choose one')
    expect(output).toContain('1. Yes')
    expect(output).toContain('Question: Why?')
    expect(output).toContain('Approval: pwsh · needs')
    expect(output).toContain('Approval: read')
    expect(frame.lines.at(-1)).toContain('Ctrl+C')
    expect(frame.cursor).toBeDefined()
    expect(frame.lines.length).toBeLessThanOrEqual(40)
    for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24)
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
    expect(three.cursor?.row).toBe(1)
    for (const line of three.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(1)
  })

  it('shows only the newest body lines when viewport height is exhausted', () => {
    const frame = renderDshFrame({
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState(),
    }, { columns: 80, rows: 4 })

    expect(frame.lines).toHaveLength(4)
    expect(frame.lines[1]).toContain('Approval: read')
    expect(frame.lines.join('\n')).not.toContain('You:')
    expect(frame.cursor).toEqual({ row: 2, column: 2 })
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

    const output = frame.lines.join('\n')
    expect(output).not.toContain('\x1b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    expect(output).toContain('beforered�after')
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
              options: [{ label: 'Yes', description: 'Proceed safely' }],
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
        editor: createPromptEditorState('because'),
        error: 'Try again\x1b[2J',
      },
    }, { columns: 80, rows: 16 })
    const questionOutput = questionFrame.lines.join('\n')
    expect(questionOutput).toContain('Answering question 2/2')
    expect(questionOutput).toContain('Read this first')
    expect(questionOutput).toContain('1. Yes — Proceed safely')
    expect(questionOutput).toContain('answer> because')
    expect(questionOutput).toContain('Error: Try again')
    expect(questionOutput).not.toContain('[2J')
    expect(questionOutput).toContain('Question 2/2')
    expect(questionOutput).not.toContain('normal draft')

    const approvalFrame = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: pending,
      prompt: normal,
      input: {
        kind: 'approval',
        interactionId: 'a-active',
        editor: createPromptEditorState('y'),
      },
    }, { columns: 80, rows: 12 })
    const approvalOutput = approvalFrame.lines.join('\n')
    expect(approvalOutput).toContain('Answering approval')
    expect(approvalOutput).toContain('allow? y')
    expect(approvalOutput).toContain('y/yes/1 allow')

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
    expect(staleQuestion.lines.at(-1)).toContain('Question 1/1')
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
    }, { columns: 80, rows: 12 })
    const output = frame.lines.join('\n')
    expect(output).toContain('Command running · running')
    expect(output).toContain('Command /goal · error · orphan done · failed')
    expect(output).toContain('Command /compact · success · duplicate run')
    expect(output).toContain('Command /feedback · error · duplicate done')
    expect(output).toContain('Command empty-diagnostic · success')
    expect(output).not.toContain('\x1b')
  })

  it('renders bounded command discovery, no-match, pending, and notice footers', () => {
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
              description: 'Compact',
              input: { hint: '<scope>' },
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
        selectedIndex: 1,
        totalCount: 4,
      },
      commandNotice: 'catalog refreshed\x1b[31m',
    }, { columns: 80, rows: 9 })
    const menuOutput = menu.lines.join('\n')
    expect(menuOutput).toContain('  /compact <scope> — Compact [DSH/official]')
    expect(menuOutput).toContain('› /sessions — Browse sessions [DSH-TUI/local]')
    expect(menuOutput).toContain('… 2 more')
    expect(menu.lines.at(-1)).toContain('Notice: catalog refreshed')
    expect(menu.lines.at(-1)).toContain('Up/Down select')
    expect(menuOutput).not.toContain('\x1b')

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
    expect(noMatch.lines.join('\n')).toContain('No commands match /zzz')

    const pending = renderDshFrame({
      ...base,
      prompt: createPromptEditorState(),
      commandPending: true,
    }, { columns: 50, rows: 3 })
    expect(pending.lines.at(-1)).toContain('Command running')
  })

  it('renders the session picker as an independent read-only modal with complete row provenance', () => {
    const picker: SessionPickerView = {
      durability: 'available',
      rows: [
        {
          sessionId: 'current',
          createdAt: 100,
          isSubagent: false,
          attached: true,
          durablePresence: 'observed',
          relation: 'current',
        },
        {
          sessionId: 'cold',
          createdAt: 200,
          cwd: 'D:\\work',
          isSubagent: false,
          creationAgentPreset: 'coding',
          attached: false,
          durablePresence: 'observed',
          relation: 'cold',
        },
        {
          sessionId: 'live-child',
          createdAt: 300,
          cwd: 'D:\\agents',
          parentSessionId: 'parent',
          isSubagent: true,
          creationAgentPreset: 'research',
          attached: true,
          durablePresence: 'not-observed',
          liveStatus: 'running',
          relation: 'other-live',
        },
      ],
      selectedIndex: 2,
      selectedSessionId: 'live-child',
      offset: 0,
      totalCount: 3,
    }
    const frame = renderDshFrame({
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState('hidden draft'),
      sessionPicker: {
        view: picker,
        loading: true,
        loaded: true,
        notice: 'Catalog refreshed',
      },
    }, { columns: 160, rows: 10 })
    const output = frame.lines.join('\n')

    expect(frame.lines[0]).toBe('Sessions · [DSH-TUI/local] · read-only')
    expect(output).toContain('Loading sessions')
    expect(output).toContain('current · current · live:attached · durable:observed · root')
    expect(output).toContain('cold · cold · live:none · durable:observed · root · cwd:D:\\work · preset:coding')
    expect(output).toContain('› live-child · other-live · live:running · durable:not-observed · subagent:parent · cwd:D:\\agents · preset:research')
    expect(output).toContain('Notice: Catalog refreshed')
    expect(frame.lines.at(-1)).toContain('Up/Down select')
    expect(frame.lines.at(-1)).toContain('Enter explain/read-only · R refresh · Esc close')
    expect(output).not.toContain('You:')
    expect(output).not.toContain('Approval:')
    expect(output).not.toContain('hidden draft')
    expect(frame.cursor).toBeUndefined()

    const liveSwitch = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      sessionPicker: {
        view: picker,
        loading: false,
        loaded: true,
        liveActivation: true,
      },
    }, { columns: 160, rows: 4 })
    expect(liveSwitch.lines[0]).toBe(
      'Sessions · [DSH-TUI/local] · browse/live-switch',
    )
    expect(liveSwitch.lines.at(-1)).toContain('Enter switch/explain')

    const inspectOnly = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      sessionPicker: {
        view: picker,
        loading: false,
        loaded: true,
        inspection: true,
      },
    }, { columns: 160, rows: 4 })
    expect(inspectOnly.lines[0]).toBe(
      'Sessions · [DSH-TUI/local] · browse/inspect',
    )
    expect(inspectOnly.lines.at(-1)).toContain('Enter inspect/explain')

    const switchAndInspect = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      sessionPicker: {
        view: picker,
        loading: false,
        loaded: true,
        liveActivation: true,
        inspection: true,
      },
    }, { columns: 160, rows: 4 })
    expect(switchAndInspect.lines[0]).toBe(
      'Sessions · [DSH-TUI/local] · browse/live-switch/inspect',
    )
    expect(switchAndInspect.lines.at(-1)).toContain('Enter switch/inspect')
  })

  it('renders picker failures and live-only durability without trusting catalog strings', () => {
    const frame = renderDshFrame({
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState('hidden'),
      sessionPicker: {
        view: {
          durability: 'unavailable',
          rows: [{
            sessionId: 'unsafe\x1b[2J\u0000id',
            createdAt: 100,
            cwd: 'D:\\unsafe\nline',
            isSubagent: true,
            creationAgentPreset: 'raw\x1b[31m',
            attached: true,
            durablePresence: 'unavailable',
            liveStatus: 'idle',
            relation: 'other-live',
          }],
          selectedIndex: 0,
          selectedSessionId: 'unsafe\x1b[2J\u0000id',
          offset: 0,
          totalCount: 1,
        },
        loading: false,
        loaded: false,
        error: 'catalog\x1b[31m failed\u0007',
        notice: 'live\nonly',
      },
    }, { columns: 120, rows: 8 })
    const output = frame.lines.join('\n')

    expect(output).toContain('Error: catalog failed�')
    expect(output).toContain('Live sessions only · durable storage unavailable')
    expect(output).toContain('Session catalog not loaded')
    expect(output).toContain('unsafe�id · other-live · live:idle · durable:unavailable · subagent:unknown-parent')
    expect(output).toContain('cwd:D:\\unsafe↵line · preset:raw')
    expect(output).toContain('Notice: live↵only')
    expect(output).not.toContain('\x1b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    expect(frame.cursor).toBeUndefined()
  })

  it('keeps the selected bounded picker row visible in a tiny viewport and handles empty catalogs', () => {
    const rows: SessionPickerView['rows'] = Array.from({ length: 8 }, (_, index) => ({
      sessionId: `session-${index}`,
      createdAt: index,
      isSubagent: false,
      attached: false,
      durablePresence: 'observed',
      relation: 'cold',
    }))
    const base = {
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState('hidden'),
    }
    const tiny = renderDshFrame({
      ...base,
      sessionPicker: {
        view: {
          durability: 'available' as const,
          rows,
          selectedIndex: 6,
          selectedSessionId: 'session-6',
          offset: 20,
          totalCount: 40,
        },
        loading: false,
        loaded: true,
        notice: 'must yield to selection',
      },
    }, { columns: 80, rows: 3 })
    expect(tiny.lines).toHaveLength(3)
    expect(tiny.lines[1]).toContain('› session-6')
    expect(tiny.lines.join('\n')).not.toContain('session-5')
    expect(tiny.cursor).toBeUndefined()

    const two = renderDshFrame({
      ...base,
      sessionPicker: {
        view: {
          durability: 'available',
          rows,
          selectedIndex: 6,
          selectedSessionId: 'session-6',
          offset: 20,
          totalCount: 40,
        },
        loading: false,
        loaded: true,
      },
    }, { columns: 80, rows: 2 })
    expect(two.lines[1]).toContain('› session-6')
    expect(two.cursor).toBeUndefined()

    const one = renderDshFrame({
      ...base,
      sessionPicker: {
        view: {
          durability: 'available',
          rows,
          selectedIndex: 6,
          selectedSessionId: 'session-6',
          offset: 20,
          totalCount: 40,
        },
        loading: false,
        loaded: true,
      },
    }, { columns: 10, rows: 1 })
    expect(one.lines).toHaveLength(1)
    expect(one.cursor).toBeUndefined()

    const empty = renderDshFrame({
      ...base,
      sessionPicker: {
        view: {
          durability: 'available',
          rows: [],
          selectedIndex: -1,
          offset: 0,
          totalCount: 0,
        },
        loading: false,
        loaded: true,
      },
    }, { columns: 50, rows: 3 })
    expect(empty.lines.join('\n')).toContain('No sessions found')
    expect(empty.cursor).toBeUndefined()

    const emptyTwo = renderDshFrame({
      ...base,
      sessionPicker: {
        view: {
          durability: 'available',
          rows: [],
          selectedIndex: -1,
          offset: 0,
          totalCount: 0,
        },
        loading: false,
        loaded: true,
      },
    }, { columns: 50, rows: 2 })
    expect(emptyTwo.lines[1]).toContain('No sessions found')
    expect(emptyTwo.cursor).toBeUndefined()
  })

  it('renders a ready inspection above picker, interaction, and prompt with explicit provenance', () => {
    const projected = populatedState()
    const session = projected.sessions['session-a']!
    const projection: UiState = {
      ...projected,
      sessions: {
        ...projected.sessions,
        'session-a': { ...session, omittedRowCount: 12 },
      },
    }
    const panel: SessionInspectionPanel = {
      kind: 'ready',
      sessionId: 'session-a',
      header: {
        sessionId: 'session-a',
        createdAt: 123,
        cwd: 'D:\\inspect\nworkspace',
        parentSessionId: 'parent\u001b[2J',
        seedLength: 9,
        isSubagent: true,
        delegationDepth: 2,
        creationAgentPreset: 'research\u0000preset',
      },
      projection,
      scrollOffset: 0,
      refreshing: true,
      observation: {
        kind: 'observed',
        relation: 'other-live',
        durablePresence: 'observed',
        liveStatus: 'running',
      },
      error: 'refresh\u001b[31m failed\u0007',
    }
    const frame = renderDshFrame({
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState('hidden prompt'),
      sessionPicker: {
        view: {
          durability: 'available',
          rows: [],
          selectedIndex: -1,
          offset: 0,
          totalCount: 0,
        },
        loading: false,
        loaded: true,
      },
      sessionInspection: panel,
    }, { columns: 180, rows: 16 })
    const output = frame.lines.join('\n')

    expect(frame.lines[0]).toBe(
      'Session inspection · immutable snapshot · refreshing · session-a',
    )
    expect(output).toContain('subagent:parent · created:123 · cwd:D:\\inspect↵workspace · preset:research�preset · seed:9 · depth:2')
    expect(output).toContain('Latest catalog observation: other-live · durable:observed · live:running')
    expect(output).toContain('Storage unchanged')
    expect(output).toContain('may include in-memory interruption closers')
    expect(output).toContain('12 earlier projected rows omitted')
    expect(output).toContain('Tool orphan · done')
    expect(output).toContain('Result: done')
    expect(output).toContain('Error: FAILED: ToolError')
    expect(output).toContain('Refreshing')
    expect(output).toContain('Error: refresh failed�')
    expect(frame.lines.at(-1)).toContain('Up/Down scroll · Esc back · Refreshing')
    expect(output).not.toContain('Sessions · [DSH-TUI/local]')
    expect(output).not.toContain('Approval:')
    expect(output).not.toContain('hidden prompt')
    expect(output).not.toContain('\u001b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    expect(frame.cursor).toBeUndefined()
  })

  it('renders inspection notices, cold-resume availability, and no-session phase fallback', () => {
    const common = {
      sessionId: 'cold-session',
      header: {
        sessionId: 'cold-session',
        createdAt: 123,
        isSubagent: false,
      },
      projection: createUiState(),
      scrollOffset: 0,
      refreshing: false,
      observation: { kind: 'missing' as const },
    }
    const noticePanel: SessionInspectionPanel = {
      kind: 'ready',
      ...common,
      notice: 'Activation blocked',
    }
    const base = {
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
    }
    const notice = renderDshFrame({ ...base, sessionInspection: noticePanel }, {
      columns: 100,
      rows: 6,
    })
    expect(notice.lines[0]).toContain('immutable snapshot · action blocked')
    expect(notice.lines.join('\n')).toContain('Notice: Activation blocked')
    expect(notice.lines.at(-1)).toContain('Notice: Activation blocked')

    const resumablePanel: SessionInspectionPanel = {
      kind: 'ready',
      ...common,
      canResumeCold: true,
    }
    const resumable = renderDshFrame({ ...base, sessionInspection: resumablePanel }, {
      columns: 100,
      rows: 3,
    })
    expect(resumable.lines.at(-1)).toContain('a resume')

    const noSession: UiState = { ...createUiState(), phase: 'ready' }
    const fallback = renderDshFrame({
      ui: noSession,
      interaction: undefined,
      prompt: createPromptEditorState(),
    }, { columns: 80, rows: 3 })
    expect(fallback.lines[0]).toContain('no-session · ready')
  })

  it('renders safe loading and error inspection states without leaking the active surface', () => {
    const base = {
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState('hidden prompt'),
    }
    const loading = renderDshFrame({
      ...base,
      sessionInspection: {
        kind: 'loading',
        sessionId: 'unsafe\u001b[2J\u0000id',
      },
    }, { columns: 100, rows: 4 })
    const loadingOutput = loading.lines.join('\n')
    expect(loadingOutput).toContain('Session inspection · loading · unsafe�id')
    expect(loadingOutput).toContain('logical read-only view · Storage unchanged')
    expect(loading.lines.at(-1)).toContain('Esc cancel')
    expect(loadingOutput).not.toContain('Approval:')
    expect(loadingOutput).not.toContain('hidden prompt')
    expect(loadingOutput).not.toContain('\u001b')
    expect(loading.cursor).toBeUndefined()

    const failed = renderDshFrame({
      ...base,
      sessionInspection: {
        kind: 'error',
        sessionId: 'unsafe\u001b[2J\u0000id',
        message: 'inspect\nfailed\u001b[31m\u0007',
      },
    }, { columns: 100, rows: 4 })
    const failedOutput = failed.lines.join('\n')
    expect(failedOutput).toContain('Session inspection · error · unsafe�id')
    expect(failedOutput).toContain('Inspect failed: inspect↵failed�')
    expect(failedOutput).toContain('Storage unchanged')
    expect(failed.lines.at(-1)).toContain('r retry · Esc back')
    expect(failedOutput).not.toContain('Approval:')
    expect(failedOutput).not.toContain('hidden prompt')
    expect(failedOutput).not.toContain('\u001b')
    expect(failed.cursor).toBeUndefined()
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
    expect(frame.lines[1]).toContain('early draft')
  })

  it('renders a sanitized cold-resume confirmation with explicit side effects and consent', () => {
    const base = {
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState('hidden prompt'),
      sessionInspection: {
        kind: 'confirm-resume' as const,
        sessionId: 'cold\u001b[2J\u0000target',
        header: {
          sessionId: 'cold\u001b[2J\u0000target',
          createdAt: 123,
          cwd: 'D:\\resume\nworkspace',
          isSubagent: false,
          creationAgentPreset: 'research\u0007preset',
        },
        observation: {
          kind: 'observed' as const,
          relation: 'cold' as const,
          durablePresence: 'observed' as const,
        },
      },
    }
    const frame = renderDshFrame(base, { columns: 180, rows: 10 })
    const output = frame.lines.join('\n')

    expect(frame.lines[0]).toBe(
      'Session inspection · resume confirmation · cold�target',
    )
    expect(output).toContain('Cold resume confirmation')
    expect(output).toContain('Exact target: cold�target')
    expect(output).toContain('Resume may repair or append durable storage.')
    expect(output).toContain('It may create and publish an Agent before this TUI switches views.')
    expect(output).toContain('No resume has started yet.')
    expect(output).toContain('Latest catalog observation: cold · durable:observed')
    expect(output).toContain('root · created:123 · cwd:D:\\resume↵workspace · preset:research�preset')
    expect(frame.lines.at(-1)).toBe('Enter resume · Esc back')
    expect(output).not.toContain('Approval:')
    expect(output).not.toContain('hidden prompt')
    expect(output).not.toContain('\u001b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    expect(frame.cursor).toBeUndefined()

    const compact = renderDshFrame(base, { columns: 80, rows: 2 })
    expect(compact.lines).toEqual([
      'Session inspection · resume confirmation · resize required · cold�target',
      'Resize to at least 60x7 · Esc back',
    ])
  })

  it('clamps inspection scrolling and remains bounded in one- and two-row viewports', () => {
    const projection = populatedState()
    const base = {
      ui: createUiState(),
      interaction: interactions(),
      prompt: createPromptEditorState('hidden'),
    }
    type ReadyInspectionPanel = Extract<SessionInspectionPanel, { kind: 'ready' }>
    const ready = (
      scrollOffset: number,
      observation: ReadyInspectionPanel['observation'],
    ): ReadyInspectionPanel => ({
      kind: 'ready',
      sessionId: 'session-a',
      header: {
        sessionId: 'session-a',
        createdAt: 1,
        isSubagent: false,
      },
      projection,
      scrollOffset,
      refreshing: false,
      observation,
    })

    const tail = renderDshFrame({
      ...base,
      sessionInspection: ready(0, {
        kind: 'observed',
        relation: 'cold',
        durablePresence: 'observed',
      }),
    }, { columns: 80, rows: 6 })
    expect(tail.lines.join('\n')).toContain('Error: FAILED: ToolError')
    expect(tail.lines.join('\n')).toContain('Latest catalog observation: cold · durable:observed')

    const retained = projection.sessions['session-a']!
    const provenance = renderDshFrame({
      ...base,
      sessionInspection: {
        ...ready(0, { kind: 'missing' }),
        projection: {
          ...projection,
          sessions: {
            ...projection.sessions,
            'session-a': { ...retained, omittedRowCount: 12 },
          },
        },
      },
    }, { columns: 100, rows: 6 })
    const provenanceOutput = provenance.lines.join('\n')
    expect(provenanceOutput).toContain('Storage unchanged')
    expect(provenanceOutput).toContain('in-memory interruption closers')
    expect(provenanceOutput).toContain('12 earlier projected rows omitted')
    expect(provenanceOutput).toContain('Error: FAILED: ToolError')

    const oldest = renderDshFrame({
      ...base,
      sessionInspection: ready(Number.MAX_SAFE_INTEGER, { kind: 'missing' }),
    }, { columns: 80, rows: 6 })
    expect(oldest.lines.join('\n')).toContain('Latest catalog observation: missing')
    expect(oldest.lines.join('\n')).toContain('You: 你好世界')

    const two = renderDshFrame({
      ...base,
      sessionInspection: ready(0, { kind: 'missing' }),
    }, { columns: 20, rows: 2 })
    expect(two.lines).toHaveLength(2)
    expect(two.lines[0]).toContain('Session inspection')
    expect(two.cursor).toBeUndefined()
    expect(sessionInspectionMaxScrollOffset(
      ready(0, { kind: 'missing' }),
      { columns: 20, rows: 2 },
    )).toBe(0)

    const longSessionId = '12345678-1234-1234-1234-123456789abc'
    const one = renderDshFrame({
      ...base,
      sessionInspection: {
        ...ready(0, { kind: 'missing' }),
        sessionId: longSessionId,
        header: {
          sessionId: longSessionId,
          createdAt: 1,
          isSubagent: false,
        },
        refreshing: true,
      },
    }, { columns: 80, rows: 1 })
    expect(one.lines).toHaveLength(1)
    expect(one.lines[0]).toContain('refreshing')
    expect(visibleWidth(one.lines[0]!)).toBeLessThanOrEqual(80)
    expect(one.cursor).toBeUndefined()

    const ultraNarrow = renderDshFrame({
      ...base,
      sessionInspection: ready(0, { kind: 'missing' }),
    }, { columns: 8, rows: 1 })
    expect(ultraNarrow.lines).toHaveLength(1)
    expect(visibleWidth(ultraNarrow.lines[0]!)).toBeLessThanOrEqual(8)

    const failedTwo = renderDshFrame({
      ...base,
      sessionInspection: {
        ...ready(0, { kind: 'missing' }),
        error: 'retry\u001b[31m later',
      },
    }, { columns: 80, rows: 2 })
    expect(failedTwo.lines[0]).toContain('refresh failed')
    expect(failedTwo.lines[1]).toContain('Refresh failed: retry later')
    expect(failedTwo.lines[1]).toContain('Up/Down scroll · r retry · Esc back')
    expect(failedTwo.lines[1]).toContain('r retry')
    expect(failedTwo.lines.join('\n')).not.toContain('\u001b')

    const emptyProjection = renderDshFrame({
      ...base,
      sessionInspection: {
        kind: 'ready',
        sessionId: 'missing-session',
        header: {
          sessionId: 'missing-session',
          createdAt: 2,
          isSubagent: true,
        },
        projection: createUiState(),
        scrollOffset: 0,
        refreshing: false,
        observation: { kind: 'missing' },
      },
    }, { columns: 80, rows: 8 })
    expect(emptyProjection.lines.join('\n')).toContain('subagent:unknown-parent')
    expect(emptyProjection.lines.join('\n')).toContain('Latest catalog observation: missing')
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
        kind: 'assistant-draft' as const,
        key: 'draft:3:1' as const,
        firstSeq: 3,
        turn: 3,
        step: 1,
        chunks: [{
          seq: 3,
          chunk: { type: 'reasoning-delta' as const, index: 0, text: 'still thinking' },
        }],
        omittedChunkCount: 4,
      },
      {
        kind: 'assistant-draft' as const,
        key: 'draft:4:1' as const,
        firstSeq: 4,
        turn: 4,
        step: 1,
        chunks: [],
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
        reasoning: 'private reasoning',
        reasoningSummary: 'THINKING · 7 tokens',
        interrupted: true,
      }),
      expect.objectContaining({
        kind: 'assistant',
        text: '',
      }),
      expect.objectContaining({
        kind: 'assistant-draft',
        reasoning: 'still thinking',
        reasoningSummary: 'THINKING · streaming',
        omittedChunkCount: 4,
      }),
      expect.objectContaining({
        kind: 'assistant-draft',
        key: 'assistant:4:1',
        revision: '4:0:0',
      }),
    ]))

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

describe('startup AgentPreset frame renderer', () => {
  it('renders complete preset provenance, selected details, and the user trust warning', () => {
    const view: StartupPresetPickerView = {
      rows: [
        {
          id: 'standard',
          trust: 'system',
          name: 'Standard',
          description: 'The shipped default composition.',
          isDefault: true,
        },
        {
          id: 'research',
          trust: 'user',
          name: 'Research',
          description: 'Uses local research tools.',
          isDefault: false,
        },
        {
          id: 'broken-local',
          trust: 'user',
          name: 'Broken local',
          broken: 'composition YAML is invalid',
          isDefault: false,
        },
      ],
      selectedIndex: 1,
      selectedPresetId: 'research',
      offset: 0,
      totalCount: 3,
      defaultId: 'standard',
      defaultMissing: false,
    }
    const frame = renderStartupPresetFrame({
      view,
      loading: false,
      loaded: true,
    }, { columns: 160, rows: 10 })
    const output = frame.lines.join('\n')

    expect(frame.lines[0]).toBe('Startup AgentPreset · [DSH-TUI/local]')
    expect(output).toContain('Standard · id:standard · system · default')
    expect(output).toContain('› Research · id:research · user')
    expect(output).toContain('Broken local · id:broken-local · user · broken:composition YAML is invalid')
    expect(output).toContain('Description: Uses local research tools.')
    expect(output).toContain('Warning: user composition has the same trust as shell access.')
    expect(frame.lines.at(-1)).toContain('R refresh · Enter select · Esc cancel')
    expect(frame.cursor).toBeUndefined()
  })

  it('shows loading, error, missing-default, and empty states without trusting roster text', () => {
    const emptyView: StartupPresetPickerView = {
      rows: [],
      selectedIndex: -1,
      offset: 0,
      totalCount: 0,
      defaultId: 'missing\x1b[2J\u0000\nname',
      defaultMissing: true,
    }
    const status = renderStartupPresetFrame({
      loading: true,
      loaded: false,
      error: 'scan\x1b[31m failed\u0007\nretry',
      notice: 'Starting\x1b[2J\u0000\nnow',
    }, { columns: 100, rows: 8 })
    const output = status.lines.join('\n')

    expect(output).toContain('Loading agent presets')
    expect(output).toContain('Error: scan failed�↵retry')
    expect(output).toContain('Notice: Starting�↵now')
    expect(output).toContain('Agent preset roster not loaded')
    expect(output).not.toContain('\x1b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)

    const empty = renderStartupPresetFrame({
      view: emptyView,
      loading: false,
      loaded: true,
    }, { columns: 50, rows: 4 })
    expect(empty.lines.join('\n')).toContain('No agent presets found')
    expect(empty.lines.join('\n')).toContain('Default preset missing: missing�↵name')
  })

  it('sanitizes hostile row metadata and keeps the selected bounded row visible', () => {
    const rows: StartupPresetPickerView['rows'] = Array.from(
      { length: 8 },
      (_, index) => ({
        id: `preset-${index}\x1b[31m\u0000`,
        trust: index === 6 ? 'user' as const : 'system' as const,
        name: `Name ${index}\nnext`,
        ...(index === 6
          ? { description: 'selected\x1b[2J\u0007 detail' }
          : {}),
        ...(index === 7 ? { broken: 'bad\x1b[31m\u0000 reason' } : {}),
        isDefault: index === 0,
      }),
    )
    const frame = renderStartupPresetFrame({
      view: {
        rows,
        selectedIndex: 6,
        selectedPresetId: 'preset-6\x1b[31m\u0000',
        offset: 12,
        totalCount: 20,
        defaultId: 'preset-0\x1b[31m\u0000',
        defaultMissing: false,
      },
      loading: false,
      loaded: true,
    }, { columns: 90, rows: 3 })
    const output = frame.lines.join('\n')

    expect(frame.lines).toHaveLength(3)
    expect(frame.lines[1]).toContain('› Name 6↵next · id:preset-6� · user')
    expect(output).not.toContain('preset-5')
    expect(output).not.toContain('\x1b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(90)
  })

  it('covers absent selection, broken details, status short-circuits, and tiny viewports', () => {
    const noSelection: StartupPresetPickerView = {
      rows: [{
        id: 'nameless',
        trust: 'system',
        isDefault: true,
      }],
      selectedIndex: -1,
      offset: 0,
      totalCount: 1,
      defaultId: 'nameless',
      defaultMissing: false,
    }
    const absent = renderStartupPresetFrame({
      view: noSelection,
      loading: false,
      loaded: true,
    }, { columns: 80, rows: 6 })
    expect(absent.lines.join('\n')).toContain('nameless · id:nameless · system · default')
    expect(absent.lines.join('\n')).not.toContain('› nameless')

    const outOfRange = renderStartupPresetFrame({
      view: { ...noSelection, selectedIndex: 4 },
      loading: false,
      loaded: true,
    }, { columns: 80, rows: 6 })
    expect(outOfRange.lines.join('\n')).not.toContain('› nameless')

    const broken = renderStartupPresetFrame({
      view: {
        rows: [{
          id: 'broken',
          trust: 'system',
          broken: 'cannot compose',
          isDefault: true,
        }],
        selectedIndex: 0,
        selectedPresetId: 'broken',
        offset: 0,
        totalCount: 1,
        defaultId: 'broken',
        defaultMissing: false,
      },
      loading: false,
      loaded: true,
    }, { columns: 80, rows: 6 })
    expect(broken.lines.join('\n')).toContain('Enter blocked: cannot compose')

    const one = renderStartupPresetFrame({
      loading: true,
      loaded: false,
    }, { columns: 8, rows: 1 })
    expect(one.lines).toHaveLength(1)
    expect(visibleWidth(one.lines[0]!)).toBeLessThanOrEqual(8)

    const selectedTwo = renderStartupPresetFrame({
      view: { ...noSelection, selectedIndex: 0, selectedPresetId: 'nameless' },
      loading: false,
      loaded: true,
    }, { columns: 80, rows: 2 })
    expect(selectedTwo.lines[1]).toContain('› nameless')

    const statusTwo = renderStartupPresetFrame({
      loading: true,
      loaded: false,
    }, { columns: 80, rows: 2 })
    expect(statusTwo.lines[1]).toContain('Loading agent presets')

    const footerTwo = renderStartupPresetFrame({
      view: noSelection,
      loading: false,
      loaded: true,
    }, { columns: 80, rows: 2 })
    expect(footerTwo.lines[1]).toContain('R refresh · Enter select · Esc cancel')

    const loadedWithoutView = renderStartupPresetFrame({
      loading: false,
      loaded: true,
    }, { columns: 80, rows: 4 })
    expect(loadedWithoutView.lines.join('\n')).toContain('Agent preset roster not loaded')

    const loadingWithEmptyView = renderStartupPresetFrame({
      view: {
        rows: [],
        selectedIndex: -1,
        offset: 0,
        totalCount: 0,
        defaultId: 'standard',
        defaultMissing: false,
      },
      loading: true,
      loaded: true,
    }, { columns: 80, rows: 4 })
    expect(loadingWithEmptyView.lines.join('\n')).toContain('Loading agent presets')
    expect(loadingWithEmptyView.lines.join('\n')).not.toContain('No agent presets found')

    const projection = populatedState()
    const ready: Extract<SessionInspectionPanel, { kind: 'ready' }> = {
      kind: 'ready',
      sessionId: 'session-a',
      header: {
        sessionId: 'session-a',
        createdAt: 1,
        isSubagent: false,
      },
      projection,
      scrollOffset: 0,
      refreshing: false,
      observation: { kind: 'missing' },
    }
    expect(sessionInspectionMaxScrollOffset(
      ready,
      { columns: 40, rows: 6 },
    )).toBeGreaterThanOrEqual(0)
  })
})
