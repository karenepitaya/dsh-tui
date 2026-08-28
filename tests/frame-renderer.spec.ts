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
import type { ModePickerView } from '../src/mode/picker.ts'
import type { SkillPickerView } from '../src/skill/picker.ts'
import type { ProviderConnectView } from '../src/provider/connect-controller.ts'
import type { ProviderConnectionEntry } from '../src/provider/port.ts'
import type { SessionContextSnapshot } from '../src/context/port.ts'
import {
  contextOccupancy,
  formatTokenCount,
  renderContextFrame,
  renderProviderConnectFrame,
  renderStartupPresetFrame,
  type SessionInspectionPanel,
} from '../src/ui/frame.ts'

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

function providerEntry(
  id: string,
  overrides: Partial<ProviderConnectionEntry> = {},
): ProviderConnectionEntry {
  return {
    id,
    name: id,
    active: false,
    configured: false,
    connected: false,
    credential: { kind: 'missing', configured: false, writable: true },
    methods: [{ id: 'api-key', label: 'API key' }],
    canDisconnect: false,
    ...overrides,
  }
}

function providerConnectView(
  overrides: Partial<ProviderConnectView> = {},
): ProviderConnectView {
  return {
    stage: 'providers',
    providers: [],
    selectedProviderIndex: -1,
    selectedMethodIndex: -1,
    editor: createPromptEditorState(),
    selectedOptionIndex: -1,
    notices: [],
    loading: false,
    busy: false,
    ...overrides,
  }
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
  it('renders Agent modes as a bounded first-party selector with visible lock and errors', () => {
    const modePicker: ModePickerView = {
      rows: [
        {
          id: 'standard',
          trust: 'system',
          name: 'Standard',
          description: 'Complete coding Agent',
          isCurrent: true,
          isDefault: true,
        },
        {
          id: 'broken-mode',
          trust: 'user',
          broken: 'invalid composition',
          isCurrent: false,
          isDefault: false,
        },
      ],
      selectedIndex: 0,
      selectedModeId: 'standard',
      offset: 0,
      totalCount: 2,
      current: 'standard',
      defaultId: 'standard',
      available: false,
      loading: true,
      selecting: true,
      locked: true,
      error: 'catalog\u001b[2J failed',
    }
    const base = {
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState('hidden'),
      modePicker,
      modeNotice: 'switch blocked\u0007',
    }

    const one = renderDshFrame(base, { columns: 80, rows: 1 })
    expect(one.lines[0]).toContain('AGENT MODE')
    expect(one.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })
    expect(one.cursor).toBeUndefined()

    const two = renderDshFrame(base, { columns: 80, rows: 2 })
    expect(two.lines[1]).toContain('Current  standard')

    const narrow = renderDshFrame(base, { columns: 1, rows: 2 })
    expect(narrow.lines).toHaveLength(2)
    for (const line of narrow.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(1)

    const three = renderDshFrame(base, { columns: 80, rows: 3 })
    expect(three.lines).toHaveLength(3)
    expect(three.lines.at(-1)).toContain('Start a new session to switch')

    const full = renderDshFrame(base, { columns: 80, rows: 14 })
    const output = full.lines.join('\n')
    expect(output).toContain('╭─ AGENT MODE')
    expect(output).toContain('Current  standard')
    expect(output).toContain('├─ LOCKED')
    expect(output).toContain('Refreshing mode catalog')
    expect(output).toContain('Applying mode composition')
    expect(output).toContain('Mode locked after the first turn')
    expect(output).toContain('Agent modes are unavailable')
    expect(output).toContain('Error: catalog failed')
    expect(output).toContain('Notice: switch blocked')
    expect(output).toContain('broken-mode  unavailable')
    expect(output).toContain('Complete coding Agent')
    expect(full.lineStyles).toContainEqual(expect.objectContaining({
      inverse: true,
      fill: true,
    }))
    expect(output).not.toContain('\u001b')

    const empty: ModePickerView = {
      rows: [],
      selectedIndex: -1,
      offset: 0,
      totalCount: 0,
      available: true,
      loading: false,
      selecting: false,
      locked: false,
    }
    const emptyBase = {
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState('hidden'),
      modePicker: empty,
    }
    const emptyTwo = renderDshFrame(emptyBase, {
      columns: 40,
      rows: 2,
    })
    expect(emptyTwo.lines[1]).toContain('Current  none')
    const emptyFull = renderDshFrame(emptyBase, {
      columns: 40,
      rows: 8,
    })
    expect(emptyFull.lines.join('\n')).toContain('No Agent modes found')
    expect(emptyFull.lines.at(-1)).toContain('Enter apply')
  })

  it('renders Skills as a fixed searchable directory with invocation and provenance hierarchy', () => {
    const picker: SkillPickerView = {
      query: createPromptEditorState(),
      rows: [
        {
          name: 'review',
          description: 'Review source changes safely',
          whenToUse: 'When a patch needs inspection',
          modelInvocable: true,
          source: 'workspace',
          provider: 'filesystem',
          resourceBase: { kind: 'directory', path: 'D:\\repo\\.agents\\skills\\review' },
        },
        {
          name: 'research',
          description: 'Find primary evidence',
          modelInvocable: false,
          source: 'user',
          provider: 'remote',
          resourceBase: { kind: 'url', url: 'https://skills.example/research' },
        },
        {
          name: 'opaque',
          description: 'Use a bundled resource',
          modelInvocable: true,
          source: 'system',
          provider: 'bundle',
          resourceBase: { kind: 'opaque', description: 'embedded bundle' },
        },
      ],
      selectedIndex: 0,
      selectedName: 'review',
      totalCount: 3,
      available: true,
      loading: false,
      complete: true,
      stale: false,
    }
    const base = {
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState('hidden'),
      skillPicker: picker,
    }

    const frame = renderDshFrame(base, { columns: 140, rows: 24 })
    const output = frame.lines.join('\n')
    expect(frame.overlay).toMatchObject({ kind: 'directory', anchor: 'center' })
    expect(frame.lines).toHaveLength(20)
    expect(output).toContain('╭─ SKILLS · 3')
    expect(output).toContain('├─ AVAILABLE')
    expect(output).toContain('› /review  Review source changes safely')
    expect(output).toContain('About  Review source changes safely')
    expect(output).toContain('When   When a patch needs inspection')
    expect(output).toContain('Call   USER ✓   MODEL ✓')
    expect(output).toContain('From   workspace · filesystem')
    expect(output).toContain('Base   D:\\repo\\.agents\\skills\\review')
    expect(output).not.toContain('Up/Down')
    expect(frame.lineStyles).toContainEqual(expect.objectContaining({
      inverse: true,
      fill: true,
    }))
    expect(frame.cursor).toEqual(expect.objectContaining({ row: 1 }))

    const remote = renderDshFrame({
      ...base,
      skillPicker: { ...picker, selectedIndex: 1, selectedName: 'research' },
    }, { columns: 100, rows: 18 }).lines.join('\n')
    expect(remote).toContain('Call   USER ✓   MODEL —')
    expect(remote).toContain('Base   https://skills.example/research')
    expect(remote).not.toContain('When   ')

    const opaque = renderDshFrame({
      ...base,
      skillPicker: { ...picker, selectedIndex: 2, selectedName: 'opaque' },
    }, { columns: 100, rows: 18 }).lines.join('\n')
    expect(opaque).toContain('Base   embedded bundle')

    const noResource: SkillPickerView = {
      ...picker,
      rows: [{
        name: 'plain',
        description: 'No resource base',
        modelInvocable: true,
        source: 'workspace',
        provider: 'memory',
      }],
      selectedIndex: 0,
      selectedName: 'plain',
      totalCount: 1,
    }
    expect(renderDshFrame({ ...base, skillPicker: noResource }, {
      columns: 100,
      rows: 16,
    }).lines.join('\n')).not.toContain('Base   ')

    const manyRows = Array.from({ length: 15 }, (_, index) => ({
      name: `skill-${index}`,
      description: `Skill ${index}`,
      modelInvocable: true,
      source: 'workspace',
      provider: 'filesystem',
    }))
    const scrolled: SkillPickerView = {
      ...picker,
      rows: manyRows,
      selectedIndex: 12,
      selectedName: 'skill-12',
      totalCount: manyRows.length,
    }
    const scrolledOutput = renderDshFrame({ ...base, skillPicker: scrolled }, {
      columns: 90,
      rows: 14,
    }).lines.join('\n')
    expect(scrolledOutput).toContain('/skill-12')
    expect(scrolledOutput).not.toContain('/skill-0 ')

    const unselected: SkillPickerView = {
      ...picker,
      rows: manyRows,
      selectedIndex: -1,
      totalCount: manyRows.length,
    }
    const unselectedOutput = renderDshFrame({ ...base, skillPicker: unselected }, {
      columns: 90,
      rows: 14,
    }).lines.join('\n')
    expect(unselectedOutput).toContain('/skill-0')
    expect(unselectedOutput).not.toContain('› /skill-')
  })

  it('keeps Skills loading, stale, unavailable, empty, and compact states legible', () => {
    const unavailable: SkillPickerView = {
      query: createPromptEditorState('bad\u001b[2J'),
      rows: [],
      selectedIndex: -1,
      totalCount: 0,
      available: false,
      loading: true,
      complete: false,
      stale: false,
      error: 'catalog\u0007 failed',
    }
    const base = {
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState('hidden'),
      skillPicker: unavailable,
    }
    const full = renderDshFrame(base, { columns: 80, rows: 16 })
    const output = full.lines.join('\n')
    expect(output).toContain('SKILLS · 0')
    expect(output).toContain('MATCHES · 0')
    expect(output).toContain('Error  catalog')
    expect(output).toContain('failed')
    expect(output).toContain('Refreshing catalog…')
    expect(output).toContain('Catalog discovery is incomplete')
    expect(output).toContain('Skills are unavailable in this Agent composition')
    expect(output).not.toContain('\u001b')
    expect(output).not.toContain('\u0007')

    const stale = renderDshFrame({
      ...base,
      skillPicker: {
        query: createPromptEditorState('missing'),
        rows: [],
        selectedIndex: -1,
        totalCount: 0,
        available: true,
        loading: false,
        complete: false,
        stale: true,
      },
    }, { columns: 80, rows: 12 }).lines.join('\n')
    expect(stale).toContain('Catalog changed · showing the last complete view')
    expect(stale).toContain('No matching skills')

    const empty = renderDshFrame({
      ...base,
      skillPicker: {
        query: createPromptEditorState(),
        rows: [],
        selectedIndex: -1,
        totalCount: 0,
        available: true,
        loading: false,
        complete: true,
        stale: false,
      },
    }, { columns: 80, rows: 10 }).lines.join('\n')
    expect(empty).toContain('No user-invocable skills')

    for (const rows of [1, 2, 3, 4]) {
      const compact = renderDshFrame(base, { columns: 40, rows })
      expect(compact.lines).toHaveLength(rows)
      for (const line of compact.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
      if (rows >= 2) expect(compact.cursor?.row).toBe(1)
    }
    const narrow = renderDshFrame(base, { columns: 1, rows: 2 })
    for (const line of narrow.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(1)
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
    expect(output).toContain('MODELS · DSH runtime')
    expect(output).toContain('READ-ONLY CATALOG · 小米模型')
    expect(output).toContain('小米模型')
    expect(output).toContain('current')
    expect(output).toContain('unlisted')
    expect(output).toContain('unroutable')
    expect(output).toContain('目录�失败')
    expect(output).not.toContain('hidden')
    expect(output).not.toContain('\x1b')
    expect(frame.cursor).toBeUndefined()
    expect(frame.overlay).toMatchObject({ kind: 'directory', anchor: 'center' })
    expect(frame.lineStyles).toContainEqual(expect.objectContaining({
      inverse: true,
      fill: true,
    }))
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
    const normal = renderDshFrame(base, { columns: 80, rows: 5 })
    expect(normal.lines.join('\n')).toContain('deepseek/deepseek-reasoner/high')
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
    const summary = renderDshFrame({ ...base, model: unmanaged }, { columns: 80, rows: 5 })
    expect(summary.lines.join('\n')).toContain(
      'offline/legacy/default · unroutable · managed by other Host',
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
    }, { columns: 80, rows: 5 })
    expect(unmanagedBeforeFirstRequest.lines.join('\n')).toContain('managed by other Host')

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
    }, { columns: 80, rows: 5 })
    expect(ownedBeforeFirstRequest.lines.join('\n')).not.toContain('managed by other Host')

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
    expect(noSelectedBody.lines.join('\n')).toContain('MODEL CATALOG · Provider')
    expect(noSelectedBody.lines.join('\n')).toContain('One  current · default')
    const noSelectedTwo = renderDshFrame({ ...base, modelPicker: noSelected }, {
      columns: 80,
      rows: 2,
    })
    expect(noSelectedTwo.lines[1]).toContain('Current  provider/one')

    const effort = (id: string) => ({
      id,
      name: id.toUpperCase(),
      isDefault: false,
    })
    const detailedModels: ModelPickerView = {
      stage: 'models',
      groups: [
        {
          id: 'provider-a',
          name: 'Provider A',
          models: [
            {
              provider: 'provider-a', providerName: 'Provider A', id: 'route-a', name: 'Route A',
              efforts: [], isCurrent: true, isDefault: false, catalogued: false, routable: false,
            },
            {
              provider: 'provider-a', providerName: 'Provider A', id: 'route-b', name: 'Route B',
              efforts: [effort('high')], isCurrent: false, isDefault: true,
              catalogued: true, routable: true,
            },
          ],
        },
        {
          id: 'provider-b',
          name: 'Provider B',
          models: [
            {
              provider: 'provider-b', providerName: 'Provider B', id: 'route-c', name: 'Route C',
              efforts: [effort('low'), effort('high')], isCurrent: false, isDefault: false,
              catalogued: true, routable: true,
            },
            {
              provider: 'provider-b', providerName: 'Provider B', id: 'route-d', name: 'Route D',
              efforts: [], retainedReasoningEffort: 'opaque/high', isCurrent: false,
              isDefault: false, catalogued: true, routable: true,
            },
          ],
        },
        {
          id: 'provider-c',
          name: 'Provider C',
          models: [{
            provider: 'provider-c', providerName: 'Provider C', id: 'route-e', name: 'Route E',
            efforts: [], isCurrent: false, isDefault: false, catalogued: true, routable: true,
          }],
        },
      ],
      selectedModel: { provider: 'provider-a', model: 'route-a' },
      selectedModelIndex: 0,
      efforts: [],
      selectedEffortIndex: -1,
      current: { provider: 'provider-a', model: 'route-a' },
      defaultSelection: { provider: 'provider-a', model: 'route-b' },
      routable: true,
      writable: true,
      loading: false,
      selecting: false,
      failures: [],
    }
    const renderDetailedModel = (provider: string, model: string) => renderDshFrame({
      ...base,
      modelPicker: {
        ...detailedModels,
        selectedModel: { provider, model },
      },
    }, { columns: 160, rows: 24 })

    const retainedRoute = renderDetailedModel('provider-a', 'route-a')
    const retainedOutput = retainedRoute.lines.join('\n')
    expect(retainedOutput).toContain('Provider A · 2 models')
    expect(retainedOutput).toContain('Provider B · 2 models')
    expect(retainedOutput).toContain('Provider C · 1 model')
    expect(retainedOutput).toContain('SELECTED MODEL')
    expect(retainedOutput).toContain('State  current · unroutable · retained route')
    expect(retainedOutput).toContain('Reasoning  provider default')
    expect(retainedRoute.lineStyles).toContainEqual(expect.objectContaining({
      tone: 'interaction', bold: true, background: 'black', fill: true,
    }))
    expect(retainedRoute.lineStyles).toContainEqual(expect.objectContaining({
      tone: 'muted', background: 'black', fill: true,
    }))

    const defaultRoute = renderDetailedModel('provider-a', 'route-b').lines.join('\n')
    expect(defaultRoute).toContain('State  default · routable')
    expect(defaultRoute).toContain('Reasoning  1 option')

    const pluralEfforts = renderDetailedModel('provider-b', 'route-c').lines.join('\n')
    expect(pluralEfforts).toContain('State  routable')
    expect(pluralEfforts).toContain('Reasoning  2 options')

    const retainedEffort = renderDetailedModel('provider-b', 'route-d').lines.join('\n')
    expect(retainedEffort).toContain('Reasoning  opaque/high')

    const missingDetail = renderDshFrame({
      ...base,
      modelPicker: {
        ...detailedModels,
        selectedModel: { provider: 'provider-a', model: 'missing' },
      },
    }, { columns: 160, rows: 24 })
    expect(missingDetail.lines.join('\n')).not.toContain('SELECTED MODEL')

    const { selectedModel: omittedSelectedModel, ...noDetailPicker } = detailedModels
    expect(omittedSelectedModel).toEqual({ provider: 'provider-a', model: 'route-a' })
    const noDetail = renderDshFrame({
      ...base,
      modelPicker: noDetailPicker,
    }, { columns: 160, rows: 24 })
    expect(noDetail.lines.join('\n')).not.toContain('SELECTED MODEL')
  })

  it('keeps the model directory structured across narrow and wide modal layouts', () => {
    const groups: ModelPickerView['groups'] = Array.from({ length: 20 }, (_, index) => ({
      id: `provider-${index}`,
      name: `Provider ${index}`,
      models: [{
        provider: `provider-${index}`,
        providerName: `Provider ${index}`,
        id: `model-${index}`,
        name: `Model ${index}`,
        efforts: [],
        isCurrent: index === 19,
        isDefault: false,
        catalogued: true,
        routable: true,
      }],
    }))
    const base = {
      ui: selectSession(createUiState(), 'session-a'),
      interaction: undefined,
      prompt: createPromptEditorState(),
    }
    const selected: ModelPickerView = {
      stage: 'reasoning',
      groups,
      selectedModel: { provider: 'provider-19', model: 'model-19' },
      selectedModelIndex: 19,
      efforts: [{ kind: 'provider-default', name: 'Provider default', isDefault: true }],
      selectedEffortIndex: 0,
      current: { provider: 'provider-19', model: 'model-19' },
      routable: true,
      writable: true,
      loading: false,
      selecting: false,
      failures: [],
    }
    const wide = renderDshFrame({ ...base, modelPicker: selected }, {
      columns: 140,
      rows: 20,
    })
    const wideOutput = wide.lines.join('\n')
    expect(wideOutput).toContain('REASONING EFFORT')
    expect(wideOutput).toContain('Provider decides effort')
    expect(wideOutput).toContain('Default option')
    expect(wideOutput).toContain('provider-19')

    const { selectedModel: omittedSelection, ...withoutSelection } = selected
    expect(omittedSelection).toEqual({ provider: 'provider-19', model: 'model-19' })
    const noSelection = renderDshFrame({
      ...base,
      modelPicker: {
        ...withoutSelection,
        selectedModelIndex: -1,
        efforts: [],
        selectedEffortIndex: -1,
        writable: false,
        loading: true,
        error: 'catalog unavailable',
        failures: [{ provider: 'provider-0', message: 'offline' }],
      },
    }, { columns: 140, rows: 20 })
    const noSelectionOutput = noSelection.lines.join('\n')
    expect(noSelectionOutput).toContain('No model selected')
    expect(noSelectionOutput).toContain('No reasoning option')
    expect(noSelectionOutput).toContain('catalog unavailable')
    expect(noSelectionOutput).toContain('managed by another Host')

    const narrow: ModelPickerView = {
      ...selected,
      stage: 'models',
      groups: groups.slice(18).map((group, index) => index === 0
        ? {
            ...group,
            models: [
              ...group.models,
              {
                ...group.models[0]!,
                id: 'model-extra',
                name: 'Model extra',
                isCurrent: false,
              },
            ],
          }
        : group),
      efforts: [],
      selectedEffortIndex: -1,
    }
    const narrowOutput = renderDshFrame({ ...base, modelPicker: narrow }, {
      columns: 60,
      rows: 24,
    }).lines.join('\n')
    expect(narrowOutput).toContain('Provider 18 · 2 models')
    expect(narrowOutput).toContain('SELECTED MODEL')
    expect(narrowOutput).toContain('Route  provider-19/model-19')
  })

  it('keeps the retained conversation separate from a fixed interaction overlay', () => {
    const conversation = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState('0123456789中文输入'),
    }, { columns: 24, rows: 40 })
    const conversationOutput = conversation.lines.join('\n')
    expect(conversationOutput).toContain('DSH-TUI')
    expect(conversationOutput).toContain('You: 你好世界')
    expect(conversationOutput).toContain('[image image/png')
    expect(conversationOutput).toContain('2x2]')
    expect(conversationOutput.match(/\[unsupported:/g)).toHaveLength(2)
    expect(conversationOutput).toContain('Assistant: answer')
    expect(conversationOutput).not.toContain('think answer')
    expect(conversationOutput).toContain('Assistant: streaming')
    expect(conversationOutput).toContain('TOOL  read  ● RUNNING')
    expect(conversationOutput).toContain('TOOL  orphan  ✓ DONE')
    expect(conversationOutput).toContain('TOOL  failed')
    expect(conversationOutput).toContain('FAILED')
    expect(conversation.cursor).toBeDefined()

    const approval = renderDshFrame({
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState('hidden draft'),
    }, { columns: 80, rows: 20 })
    const approvalOutput = approval.lines.join('\n')
    expect(approvalOutput).toContain('PERMISSION REQUIRED')
    expect(approvalOutput).toContain('ONE-TIME ACCESS')
    expect(approvalOutput).toContain('read')
    expect(approvalOutput).toContain('No additional reason supplied')
    expect(approvalOutput).toContain('REJECT')
    expect(approvalOutput).toContain('ALLOW ONCE')
    expect(approvalOutput).not.toContain('You:')
    expect(approvalOutput).not.toContain('hidden draft')
    expect(approval.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })
    expect(approval.cursor).toBeUndefined()
    expect(approval.lineStyles).toHaveLength(approval.lines.length)
    expect(approval.lineStyles?.every(style => style?.background === 'black')).toBe(true)
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

  it('shows only the newest body lines when viewport height is exhausted', () => {
    const frame = renderDshFrame({
      ui: populatedState(),
      interaction: interactions(),
      prompt: createPromptEditorState(),
    }, { columns: 80, rows: 4 })

    expect(frame.lines).toHaveLength(4)
    expect(frame.lines[0]).toContain('PERMISSION REQUIRED')
    expect(frame.lines[1]).toContain('read')
    expect(frame.lines[2]).toContain('REJECT')
    expect(frame.lines[2]).toContain('ALLOW ONCE')
    expect(frame.lines.join('\n')).not.toContain('You:')
    expect(frame.lines[3]).toContain('Enter confirm')
    expect(frame.cursor).toBeUndefined()
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
    expect(questionOutput).toContain('STEP 2 OF 2')
    expect(questionOutput).toContain('Why?')
    expect(questionOutput).toContain('> because')
    expect(questionOutput).toContain('Try again')
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
      },
    }, { columns: 80, rows: 12 })
    const approvalOutput = approvalFrame.lines.join('\n')
    expect(approvalOutput).toContain('PERMISSION REQUIRED')
    expect(approvalOutput).toContain('ALLOW ONCE')
    expect(approvalOutput).not.toContain('decision>')
    const allowLine = approvalFrame.lines.findIndex(line => line.includes('ALLOW ONCE'))
    expect(allowLine).toBeGreaterThanOrEqual(0)
    expect(approvalFrame.lineStyles?.[allowLine]).toMatchObject({ inverse: true, tone: 'success' })
    expect(approvalFrame.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })

    const rejectedApproval = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: pending,
      prompt: normal,
      input: {
        kind: 'approval',
        interactionId: 'a-active',
        editor: createPromptEditorState('n'),
        error: 'Decision rejected by runtime',
      },
    }, { columns: 100, rows: 28 })
    const rejectedOutput = rejectedApproval.lines.join('\n')
    expect(rejectedOutput).toContain('Decision rejected by runtime')
    const rejectLine = rejectedApproval.lines.findIndex(line => line.includes('REJECT'))
    expect(rejectedApproval.lineStyles?.[rejectLine]).toMatchObject({ inverse: true, tone: 'error' })

    const tinyAllow = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: pending,
      prompt: normal,
      input: {
        kind: 'approval',
        interactionId: 'a-active',
        editor: createPromptEditorState('y'),
      },
    }, { columns: 80, rows: 4 })
    expect(tinyAllow.lines[2]).toContain('ALLOW ONCE')
    expect(tinyAllow.lineStyles?.[2]).toMatchObject({ tone: 'success' })

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
    expect(menuOutput).toContain('  /compact')
    expect(menuOutput).toContain('Compact')
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
    expect(menu.lines.at(-1)).toContain('> /')
    expect(menu.lineStyles?.[1]).toMatchObject({ inverse: true, fill: true })

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
    expect(oneLine.lines[0]).toContain('> /')
    expect(oneLine.cursor?.row).toBe(0)

    const twoLines = renderDshFrame({ ...base, commandMenu: compactMenu }, {
      columns: 80,
      rows: 2,
    })
    expect(twoLines.lines).toHaveLength(2)
    expect(twoLines.cursor?.row).toBe(1)
    expect(twoLines.lines[0]).toMatch(/^─+$/u)

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
      interaction: undefined,
      prompt: createPromptEditorState('hidden draft'),
      sessionPicker: {
        view: picker,
        loading: true,
        loaded: true,
        notice: 'Catalog refreshed',
      },
    }, { columns: 160, rows: 10 })
    const output = frame.lines.join('\n')

    expect(frame.lines[0]).toContain('SESSIONS · DSH/local')
    expect(frame.overlay).toMatchObject({ kind: 'directory', anchor: 'center' })
    expect(output).toContain('read-only  ·  3 sessions  ·  durable catalog')
    expect(output).toContain('Loading sessions')
    expect(output).toContain('current · current · attached')
    expect(output).toContain('cold · cold · none')
    expect(output).toContain('› live-child · other-live · running')
    expect(output).toContain('subagent:parent · cwd:D:\\agents · preset:research')
    expect(output).toContain('Notice: Catalog refreshed')
    expect(frame.lines.at(-1)).toContain('Up/Down select')
    expect(frame.lines.at(-1)).toContain('Enter explain/read-only  R refresh  Esc close')
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
    expect(liveSwitch.lines[0]).toContain('SESSIONS · DSH/local')
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
    expect(inspectOnly.lines[0]).toContain('SESSIONS · DSH/local')
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
    expect(switchAndInspect.lines[0]).toContain('SESSIONS · DSH/local')
    expect(switchAndInspect.lines.at(-1)).toContain('Enter switch/inspect')

    const attachedDetail = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      sessionPicker: {
        view: { ...picker, selectedIndex: 0, selectedSessionId: 'current' },
        loading: false,
        loaded: true,
      },
    }, { columns: 160, rows: 24 })
    expect(attachedDetail.lines.join('\n')).toContain(
      'State  current · live attached · durable observed',
    )

    const coldDetail = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      sessionPicker: {
        view: { ...picker, selectedIndex: 1, selectedSessionId: 'cold' },
        loading: false,
        loaded: true,
      },
    }, { columns: 160, rows: 24 })
    expect(coldDetail.lines.join('\n')).toContain(
      'State  cold · live none · durable observed',
    )
  })

  it('renders picker failures and live-only durability without trusting catalog strings', () => {
    const frame = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
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
    expect(output).toContain('› unsafe�id · other-live · idle')
    expect(output).toContain('subagent:unknown-parent')
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
      interaction: undefined,
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
      interaction: undefined,
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
    }, { columns: 180, rows: 24 })
    const output = frame.lines.join('\n')

    expect(frame.lines[0]).toContain('SESSION INSPECTION · DSH/durable')
    expect(output).toContain('Session  session-a  ·  immutable snapshot · refreshing')
    expect(frame.overlay).toMatchObject({ kind: 'directory', anchor: 'center' })
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
    expect(frame.lines.at(-1)).toContain('Up/Down scroll  Esc back  Refreshing')
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
    expect(notice.lines.join('\n')).toContain('immutable snapshot · action blocked')
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
      interaction: undefined,
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
    expect(loadingOutput).toContain('SESSION INSPECTION · DSH/durable')
    expect(loadingOutput).toContain('Inspecting unsafe�id… · logical read-only · Storage unchanged')
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
    expect(failedOutput).toContain('SESSION INSPECTION · DSH/durable')
    expect(failedOutput).toContain('Inspect failed: inspect↵failed�')
    expect(failedOutput).toContain('Storage unchanged')
    expect(failed.lines.at(-1)).toContain('r retry  Esc back')
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
    expect(frame.lines.at(-1)).toContain('early draft')
  })

  it('renders a sanitized cold-resume confirmation with explicit side effects and consent', () => {
    const base = {
      ui: populatedState(),
      interaction: undefined,
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
    const frame = renderDshFrame(base, { columns: 180, rows: 14 })
    const output = frame.lines.join('\n')

    expect(frame.lines[0]).toContain('SESSION INSPECTION · DSH/durable')
    expect(output).toContain('Session  cold�target  ·  resume confirmation')
    expect(output).toContain('Cold resume confirmation')
    expect(output).toContain('Exact target: cold�target')
    expect(output).toContain('Resume may repair or append durable storage.')
    expect(output).toContain('It may create and publish an Agent before this TUI switches views.')
    expect(output).toContain('No resume has started yet.')
    expect(output).toContain('Latest catalog observation: cold · durable:observed')
    expect(output).toContain('root · created:123 · cwd:D:\\resume↵workspace · preset:research�preset')
    expect(frame.lines.at(-1)).toContain('Enter resume  Esc back')
    expect(output).not.toContain('Approval:')
    expect(output).not.toContain('hidden prompt')
    expect(output).not.toContain('\u001b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    expect(frame.cursor).toBeUndefined()

    const compact = renderDshFrame(base, { columns: 80, rows: 2 })
    expect(compact.lines[0]).toContain('SESSION INSPECTION · resume confirmation · resize required')
    expect(compact.lines[1]).toContain('Resize to at least 60x7  Esc back')
  })

  it('clamps inspection scrolling and remains bounded in one- and two-row viewports', () => {
    const projection = populatedState()
    const base = {
      ui: createUiState(),
      interaction: undefined,
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
    }, { columns: 100, rows: 10 })
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
    expect(two.lines[0]).toContain('SESSION')
    expect(two.cursor).toBeUndefined()
    expect(sessionInspectionMaxScrollOffset(
      ready(0, { kind: 'missing' }),
      { columns: 20, rows: 2 },
    )).toBe(0)
    expect(sessionInspectionMaxScrollOffset(
      ready(0, { kind: 'missing' }),
      { columns: 80, rows: 4 },
    )).toBeGreaterThanOrEqual(0)

    const errorThree = renderDshFrame({
      ...base,
      sessionInspection: {
        kind: 'error',
        sessionId: 'session-a',
        message: 'inspection failed',
      },
    }, { columns: 80, rows: 3 })
    expect(errorThree.lines).toHaveLength(3)
    expect(errorThree.lineStyles?.[1]).toEqual({ tone: 'error', bold: true })

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
    expect(failedTwo.lines[1]).toContain('Up/Down scroll  r retry  Esc back')
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
    const frame = renderContextFrame(
      CONTEXT_SNAPSHOT,
      'session\x1b[2J\nunsafe',
      { columns: 140, rows: 9 },
    )
    const text = frame.lines.join('\n')

    expect(frame.lines).toHaveLength(9)
    expect(text).toContain('CONTEXT WINDOW')
    expect(text).toContain('SESSION  session↵unsafe  ·  NEXT REQUEST')
    expect(text).toContain('2%  ·  ~3K / 128K  ·  HEALTHY')
    expect(text).toContain('REQUEST')
    expect(text).toContain('PROVIDER')
    expect(text).toContain('Sys 120 · Tool 22K · Msg 477K')
    expect(text).toContain('In 36K · Out 800 · Cache 4K')
    expect(text).toContain('Compact No maintenance recorded')
    expect(text).toContain('Official projection · seq 42')
    expect(frame.lines.at(-1)).toContain('/compact run maintenance')
    expect(frame.lineStyles?.every(style => style?.background === 'black')).toBe(true)
    expect(text).not.toContain('\x1b')

    const detailed = renderContextFrame(
      CONTEXT_SNAPSHOT,
      'session-a',
      { columns: 140, rows: 20 },
      {
        compactionId: 'compact-rich',
        phase: 'running',
        startSeq: 50,
        shadowedItemCount: 9,
        shadowedTokenCount: 12_000,
      },
    )
    const detailedText = detailed.lines.join('\n')
    expect(detailedText).toContain('REQUEST COMPOSITION')
    expect(detailedText).toContain('PROVIDER USAGE')
    expect(detailedText).toContain('System      120')
    expect(detailedText).toContain('Tools       22K')
    expect(detailedText).toContain('Messages    477K')
    expect(detailedText).toContain('Input       36K')
    expect(detailedText).toContain('Output      800')
    expect(detailedText).toContain('Cache read  4K')
    expect(detailedText).toContain('COMPACTION')
    expect(detailedText).toContain('SOURCE OF TRUTH')
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

    const pressured = renderContextFrame({
      ...CONTEXT_SNAPSHOT,
      pressure: {
        ...CONTEXT_SNAPSHOT.pressure,
        projectedTokens: 110_000,
      },
    }, 'session-a', { columns: 100, rows: 14 })
    expect(pressured.lineStyles).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: 'warning' }),
    ]))

    const critical = renderContextFrame({
      ...CONTEXT_SNAPSHOT,
      pressure: {
        ...CONTEXT_SNAPSHOT.pressure,
        projectedTokens: 127_000,
      },
    }, 'session-a', { columns: 100, rows: 14 })
    expect(critical.lines.join('\n')).toContain('CRITICAL')
    expect(critical.lineStyles).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: 'error' }),
    ]))
  })

  it('renders running and completed compaction accounting in the context panel', () => {
    const runningWithoutCount = renderContextFrame(
      CONTEXT_SNAPSHOT,
      'running',
      { columns: 120, rows: 10 },
      {
        compactionId: 'compaction-running',
        phase: 'running',
        startSeq: 43,
      },
    )
    expect(runningWithoutCount.lines.join('\n')).toContain('Compact Running')

    const runningWithoutTokens = renderContextFrame(
      CONTEXT_SNAPSHOT,
      'running-partial',
      { columns: 120, rows: 10 },
      {
        compactionId: 'compaction-running-partial',
        phase: 'running',
        startSeq: 44,
        shadowedItemCount: 3,
      },
    )
    expect(runningWithoutTokens.lines.join('\n')).toContain('Compact Running')
    expect(runningWithoutTokens.lines.join('\n')).not.toContain('3 items')

    const completed = renderContextFrame(
      CONTEXT_SNAPSHOT,
      'completed',
      { columns: 120, rows: 10 },
      {
        compactionId: 'compaction-completed',
        phase: 'completed',
        startSeq: 40,
        summarySeq: 41,
        endSeq: 42,
        shadowedItemCount: 8,
        shadowedTokenCount: 12_400,
      },
    )
    expect(completed.lines.join('\n')).toContain(
      'Compact Last: completed · 8 items · ~12K',
    )
  })

  it('renders partial, unavailable, and tiny context states without synthesizing pressure', () => {
    const providerSample = renderContextFrame({
      available: true,
      pressure: { pressureTokens: 32_000, contextWindow: 128_000 },
    }, 'sample', { columns: 90, rows: 5 })
    expect(providerSample.lines.join('\n')).toContain(
      '25%  ·  ~32K / 128K  ·  HEALTHY',
    )
    expect(providerSample.lines.join('\n')).toContain('LATEST REQUEST')

    const partial = renderContextFrame({
      available: true,
      pressure: { pressureTokens: 32_000 },
    }, 'partial', { columns: 90, rows: 8 })
    expect(partial.lines.join('\n')).toContain(
      'Waiting for route capacity and provider usage',
    )
    expect(partial.lines.join('\n')).toContain('LATEST REQUEST')
    expect(partial.lines.join('\n')).toContain('Official projection · seq unknown')

    const noPressure = renderContextFrame({
      available: true,
      breakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
    }, 'no-pressure', { columns: 90, rows: 5 })
    expect(noPressure.lines.join('\n')).toContain(
      'Waiting for route capacity and provider usage',
    )
    expect(noPressure.lines.join('\n')).toContain('NO SAMPLE')

    const unavailable = renderContextFrame(
      { available: false },
      'none',
      { columns: 80, rows: 6 },
    )
    expect(unavailable.lines.join('\n')).toContain('TOKEN METER OFFLINE')
    expect(unavailable.lines.join('\n')).toContain('Official projections are not composed')
    expect(unavailable.lines.join('\n')).toContain('Local estimates remain disabled')

    const one = renderContextFrame(CONTEXT_SNAPSHOT, 'tiny', { columns: 12, rows: 1 })
    const two = renderContextFrame(CONTEXT_SNAPSHOT, 'tiny', { columns: 20, rows: 2 })
    const three = renderContextFrame(CONTEXT_SNAPSHOT, 'tiny', { columns: 40, rows: 3 })
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
      contextPanel: true,
    }, { columns: 80, rows: 5 })
    expect(absent.lines[0]).toContain('CONTEXT WINDOW')
    expect(absent.lines.join('\n')).toContain('SESSION  no-session')
    expect(absent.lines.join('\n')).toContain('TOKEN METER OFFLINE')
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
      contextPanel: true,
    }, { columns: 100, rows: 10 })
    expect(panel.lines[0]).toContain('CONTEXT WINDOW')
    expect(panel.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })
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

describe('Provider connection frame', () => {
  it('renders every Provider status and all secret-free progress metadata', () => {
    const providers = [
      providerEntry('connected', {
        name: 'Connected', active: true, configured: true, connected: true,
        credential: { kind: 'oauth', configured: true, writable: true },
      }),
      providerEntry('active', {
        name: 'Active', active: true, configured: true,
        credential: { kind: 'reference', configured: false, writable: true },
      }),
      providerEntry('authorized', {
        name: 'Authorized', configured: true,
        credential: {
          kind: 'api-key', configured: true, writable: true, source: 'managed-file',
        },
        methods: [
          { id: 'oauth', label: 'Sign in' },
          { id: 'api-key', label: 'API key' },
        ],
      }),
      providerEntry('dormant'),
    ]
    const frame = renderProviderConnectFrame(providerConnectView({
      providers,
      selectedProviderIndex: 0,
      loading: true,
      error: 'directory warning',
      notice: 'connection settled',
      notices: [
        {
          message: 'Open the official page',
          url: 'https://auth.example/sign-in',
          code: 'ABCD-EFGH',
        },
        { message: 'Waiting' },
      ],
    }), { columns: 160, rows: 20 })
    const text = frame.lines.join('\n')

    expect(text).toContain('Refreshing official Provider directory')
    expect(text).toContain('Error: directory warning')
    expect(text).toContain('Notice: connection settled')
    expect(text).toContain('Open: https://auth.example/sign-in')
    expect(text).toContain('Code: ABCD-EFGH')
    expect(text).toContain('› Connected  ● connected')
    expect(text).toContain('Active  ◆ active')
    expect(text).toContain('Authorized  ◐ authorized')
    expect(text).toContain('dormant  ○ dormant')
    expect(text).toContain('SELECTED PROVIDER')
    expect(text).toContain('Route  connected')
    expect(text).toContain('State  ● connected')
    expect(text).toContain('Credential  oauth')
    expect(text).toContain('Methods  1')
    expect(frame.lineStyles).toContainEqual(expect.objectContaining({
      inverse: true,
      fill: true,
    }))
    expect(text).toContain('Enter connect/reconnect')

    const details = providers.map((_, selectedProviderIndex) => (
      renderProviderConnectFrame(providerConnectView({
        providers,
        selectedProviderIndex,
      }), { columns: 140, rows: 14 }).lines.join('\n')
    ))
    expect(details[1]).toContain('State  ◆ active')
    expect(details[1]).toContain('Credential  reference')
    expect(details[2]).toContain('State  ◐ authorized')
    expect(details[2]).toContain('Credential  api-key:managed-file')
    expect(details[2]).toContain('Methods  2')
    expect(details[3]).toContain('State  ○ dormant')
    expect(details[3]).toContain('Credential  missing')
  })

  it('renders empty and tiny Provider directory layouts', () => {
    const view = providerConnectView()
    const one = renderProviderConnectFrame(view, { columns: 20, rows: 1 })
    expect(one.lines).toHaveLength(1)
    expect(one.lines[0]).toContain('PROVIDERS')

    const two = renderProviderConnectFrame(view, { columns: 80, rows: 2 })
    expect(two.lines).toHaveLength(2)
    expect(two.lines[1]).toContain('R refresh')

    const padded = renderProviderConnectFrame(view, { columns: 80, rows: 6 })
    expect(padded.lines).toHaveLength(6)
    expect(padded.lines.join('\n')).toContain('No Providers available')
  })

  it('keeps the selected Provider, method, and account visible in bounded terminals', () => {
    const providers = Array.from({ length: 12 }, (_, index) => providerEntry(`provider-${index}`))
    for (const selectedProviderIndex of [0, 6, 11]) {
      const frame = renderProviderConnectFrame(providerConnectView({
        providers,
        selectedProviderIndex,
      }), { columns: 80, rows: 6 })
      expect(frame.lines.join('\n')).toContain(`› provider-${selectedProviderIndex}`)
    }

    const methodProvider = providerEntry('many-methods', {
      methods: Array.from({ length: 10 }, (_, index) => ({
        id: `method-${index}`, label: `Method ${index}`,
      })),
    })
    const methods = renderProviderConnectFrame(providerConnectView({
      stage: 'methods',
      providers: [methodProvider],
      selectedProviderIndex: 0,
      selectedMethodIndex: 8,
    }), { columns: 80, rows: 5 })
    expect(methods.lines.join('\n')).toContain('› Method 8 · id:method-8')

    const accounts = renderProviderConnectFrame(providerConnectView({
      stage: 'prompt',
      prompt: {
        kind: 'select', message: 'Account',
        options: Array.from({ length: 10 }, (_, index) => ({
          id: `account-${index}`, label: `Account ${index}`,
        })),
      },
      selectedOptionIndex: 8,
    }), { columns: 80, rows: 5 })
    expect(accounts.lines.join('\n')).toContain('› Account 8')

    const latest = renderProviderConnectFrame(providerConnectView({
      stage: 'working',
      notices: Array.from({ length: 8 }, (_, index) => ({ message: `step-${index}` })),
    }), { columns: 80, rows: 4 })
    expect(latest.lines.join('\n')).toContain('step-7')
    expect(latest.lines.join('\n')).not.toContain('step-0')
  })

  it('renders connection methods with and without a retained Provider', () => {
    const provider = providerEntry('anthropic', {
      name: 'Anthropic',
      methods: [
        { id: 'oauth', label: 'Sign in' },
        { id: 'api-key', label: 'API key' },
      ],
    })
    const selected = renderProviderConnectFrame(providerConnectView({
      stage: 'methods',
      providers: [provider],
      selectedProviderIndex: 0,
      selectedMethodIndex: 1,
    }), { columns: 120, rows: 7 })
    expect(selected.lines.join('\n')).toContain('Connect Anthropic (anthropic)')
    expect(selected.lines.join('\n')).toContain('› API key · id:api-key')
    expect(selected.lines.join('\n')).toContain('Enter start official flow')

    const status = renderProviderConnectFrame(providerConnectView({
      stage: 'methods',
      providers: [provider],
      selectedProviderIndex: 0,
      selectedMethodIndex: 0,
      error: 'method catalog failed',
      notice: 'retry available',
      notices: [{
        message: 'Use official authorization',
        url: 'https://auth.example/method',
        code: 'METHOD-CODE',
      }],
    }), { columns: 120, rows: 12 })
    expect(status.lines.join('\n')).toContain('Error: method catalog failed')
    expect(status.lines.join('\n')).toContain('Open: https://auth.example/method')
    expect(status.lines.join('\n')).toContain('Code: METHOD-CODE')
    expect(status.lineStyles).toContainEqual(expect.objectContaining({
      tone: 'error', background: 'black', fill: true,
    }))
    expect(status.lineStyles).toContainEqual(expect.objectContaining({
      tone: 'success', background: 'black', fill: true,
    }))

    const missing = renderProviderConnectFrame(providerConnectView({
      stage: 'methods',
    }), { columns: 80, rows: 4 })
    expect(missing.lines.join('\n')).toContain('No Provider is selected')
  })

  it('renders local disconnect confirmation and working states', () => {
    const provider = providerEntry('openai', { name: 'OpenAI' })
    const confirm = renderProviderConnectFrame(providerConnectView({
      stage: 'confirm-disconnect',
      providers: [provider],
      selectedProviderIndex: 0,
    }), { columns: 140, rows: 6 })
    expect(confirm.lines.join('\n')).toContain('Disconnect OpenAI (openai) locally?')
    expect(confirm.lines.join('\n')).toContain('connection-only profile')
    expect(confirm.lines.join('\n')).toContain('Enter disconnect locally')

    const missingConfirm = renderProviderConnectFrame(providerConnectView({
      stage: 'confirm-disconnect',
    }), { columns: 80, rows: 4 })
    expect(missingConfirm.lines.join('\n')).toContain('No Provider is selected')

    const working = renderProviderConnectFrame(providerConnectView({
      stage: 'working',
      providers: [provider],
      selectedProviderIndex: 0,
      busy: true,
    }), { columns: 80, rows: 4 })
    expect(working.lines.join('\n')).toContain('Connecting OpenAI')
    expect(working.lines.join('\n')).toContain('Official Provider flow running')

    const unknown = renderProviderConnectFrame(providerConnectView({
      stage: 'working',
    }), { columns: 80, rows: 4 })
    expect(unknown.lines.join('\n')).toContain('Provider operation in progress')
  })

  it('renders text, secret, waiting, and select prompts without exposing a key', () => {
    const text = renderProviderConnectFrame(providerConnectView({
      stage: 'prompt',
      prompt: { kind: 'text', message: 'Paste browser code', placeholder: 'code' },
      editor: createPromptEditorState('browser-code'),
    }), { columns: 80, rows: 5 })
    expect(text.lines.join('\n')).toContain('Paste browser code')
    expect(text.lines.join('\n')).toContain('answer › browser-code')
    expect(text.cursor).toEqual(expect.objectContaining({ row: 3 }))

    const secret = renderProviderConnectFrame(providerConnectView({
      stage: 'prompt',
      prompt: { kind: 'secret', message: 'API key' },
      editor: createPromptEditorState('top-secret'),
    }), { columns: 80, rows: 3 })
    expect(secret.lines.join('\n')).toContain('secret › ••••••••••')
    expect(secret.lines.join('\n')).not.toContain('top-secret')

    const waiting = renderProviderConnectFrame(providerConnectView({
      stage: 'prompt',
    }), { columns: 80, rows: 4 })
    expect(waiting.lines.join('\n')).toContain('Waiting for the official Provider flow')
    expect(waiting.lines.at(-1)).toContain('Enter answer')

    const select = renderProviderConnectFrame(providerConnectView({
      stage: 'prompt',
      prompt: {
        kind: 'select',
        message: 'Choose account',
        options: [
          { id: 'one', label: 'One', description: 'Primary' },
          { id: 'two', label: 'Two' },
        ],
      },
      selectedOptionIndex: 1,
    }), { columns: 80, rows: 6 })
    expect(select.lines.join('\n')).toContain('One — Primary')
    expect(select.lines.join('\n')).toContain('› Two')
    expect(select.lines.at(-1)).toContain('Up/Down select')
    expect(select.cursor).toBeUndefined()
  })

  it('gives the app-global Provider surface precedence in the main frame', () => {
    const providerConnect = providerConnectView({
      providers: [providerEntry('deepseek-official')],
      selectedProviderIndex: 0,
    })
    const frame = renderDshFrame({
      ui: createUiState(),
      interaction: undefined,
      prompt: createPromptEditorState('hidden composer'),
      providerConnect,
    }, { columns: 80, rows: 5 })
    expect(frame.lines[0]).toContain('PROVIDERS · DSH/official')
    expect(frame.overlay).toMatchObject({ kind: 'directory', anchor: 'center' })
    expect(frame.lines.join('\n')).not.toContain('hidden composer')
  })
})
