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
import { durable, message, runtime } from './fixtures.ts'
import type { SessionPickerView } from '../src/session/picker.ts'
import type { SessionModelSnapshot } from '../src/model/port.ts'
import type { ModelPickerView } from '../src/model/picker.ts'
import type { ModePickerView } from '../src/mode/picker.ts'
import type { PermissionPickerView } from '../src/permission/picker.ts'
import type { SkillPickerView } from '../src/skill/picker.ts'
import type { ProviderConnectView } from '../src/provider/connect-controller.ts'
import type { ProviderConnectionEntry } from '../src/provider/port.ts'
import type { SessionContextSnapshot } from '../src/context/port.ts'
import {
  applyAttemptPanelAction,
  createAttemptPanelState,
  openAttemptPanel,
  selectAttemptPanel,
  type AttemptPanelView,
  type LlmAttemptChain,
  type LlmAttemptPhase,
} from '../src/llm/attempts.ts'
import {
  applyRoutePanelAction,
  createRoutePanelState,
  openRoutePanel,
  selectRoutePanel,
  type RoutePanelView,
} from '../src/llm/routes.ts'
import {
  contextOccupancy,
  formatTokenCount,
  renderContextFrame,
  renderProviderConnectFrame,
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
    expect(one.lines[0]).toContain('Mode')
    expect(one.overlay).toBeUndefined()
    expect(one.cursor).toBeUndefined()

    const two = renderDshFrame(base, { columns: 80, rows: 2 })
    expect(two.lines[1]).toContain('Esc back')

    const narrow = renderDshFrame(base, { columns: 1, rows: 2 })
    expect(narrow.lines).toHaveLength(2)
    for (const line of narrow.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(1)

    const three = renderDshFrame(base, { columns: 80, rows: 3 })
    expect(three.lines).toHaveLength(3)
    expect(three.lines.at(-1)).toContain('New session required')

    const full = renderDshFrame(base, { columns: 80, rows: 14 })
    const output = full.lines.join('\n')
    expect(output).toContain('Mode')
    expect(output).toContain('Current')
    expect(output).toContain('standard')
    expect(output).toContain('Turn started · locked')
    expect(output).toContain('Available compositions')
    expect(output).toContain('Refreshing mode catalog')
    expect(output).toContain('Applying mode composition')
    expect(output).toContain('Mode locked after the first turn')
    expect(output).toContain('Agent modes are unavailable')
    expect(output).toContain('Error: catalog failed')
    expect(output).toContain('Notice: switch blocked')
    expect(output).toContain('! broken-mode')
    expect(output).toContain('user · unavailable')
    expect(output).toContain('Complete coding Agent')
    expect(output).toContain('Inspector / Standard')
    expect(full.lineStyles?.[0]).toMatchObject({
      tone: 'accent', backgroundRole: 'panelBackground', fill: true,
    })
    expect(output).not.toContain('╭─')
    expect(output).not.toContain('├─')
    expect(full.lineStyles).toContainEqual(expect.objectContaining({
      backgroundRole: 'selectionBackground',
      fill: true,
    }))
    expect(full.styleSpans?.every(spans => spans[0]?.style.backgroundRole === 'panelBackground')).toBe(true)
    expect(output).not.toContain('\u001b')

    const { error: omittedModeError, ...healthyModePicker } = modePicker
    expect(omittedModeError).toBe('catalog\u001b[2J failed')
    const manyModes: ModePickerView = {
      ...healthyModePicker,
      rows: Array.from({ length: 8 }, (_, index) => ({
        id: `mode-${index}`,
        trust: index % 2 === 0 ? 'system' as const : 'user' as const,
        name: `Mode ${index}`,
        isCurrent: index === 0,
        isDefault: index === 0,
      })),
      selectedIndex: 7,
      selectedModeId: 'mode-7',
      totalCount: 8,
      current: 'mode-0',
      available: true,
      loading: false,
      selecting: false,
      locked: false,
    }
    const scrolled = renderDshFrame({ ...base, modePicker: manyModes }, {
      columns: 80,
      rows: 8,
    })
    expect(scrolled.lines.join('\n')).toContain('› ○ Mode 7')
    const { selectedModeId: omittedSelection, ...unfocusedModes } = manyModes
    expect(omittedSelection).toBe('mode-7')
    const unfocused = renderDshFrame({
      ...base,
      modePicker: { ...unfocusedModes, selectedIndex: -1 },
    }, { columns: 80, rows: 8 })
    expect(unfocused.lines.join('\n')).toContain('◆ Mode 0')

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
    expect(emptyTwo.lines[1]).toContain('Esc back')
    const emptyFull = renderDshFrame(emptyBase, {
      columns: 40,
      rows: 8,
    })
    expect(emptyFull.lines.join('\n')).toContain('No Agent modes found')
    expect(emptyFull.lines.at(-1)).toContain('Enter apply')

    const unnamed = renderDshFrame({
      ...emptyBase,
      modePicker: {
        ...empty,
        rows: [{
          id: 'custom-mode',
          trust: 'user',
          description: 'Workspace composition',
          isCurrent: false,
          isDefault: false,
        }],
        selectedIndex: 0,
        selectedModeId: 'custom-mode',
        totalCount: 1,
      },
    }, { columns: 80, rows: 14 })
    expect(unnamed.lines.join('\n')).toContain('Inspector / custom-mode')
  })

  it('shows skill usage first and exposes origins only in explicit details', () => {
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
    expect(frame.overlay).toBeUndefined()
    expect(frame.lines).toHaveLength(24)
    expect(output).toContain('Skills')
    expect(output).toContain('Search ›')
    expect(output).toContain('Capabilities')
    expect(output).toContain('3/3')
    expect(output).toContain('› /review')
    expect(output).toContain('Selected  /review')
    expect(output).toContain('Review source changes safely')
    expect(output).toContain('When  When a patch needs inspection')
    expect(output).toContain('Invoke  user ✓ · model ✓')
    expect(output).not.toContain('Source')
    expect(output).not.toContain('Base  ')
    const details = { focus: 'details' as const, detailOffset: 0 }
    const detailed = renderDshFrame({ ...base, skillPicker: { ...picker, navigation: details } }, { columns: 140, rows: 24 }).lines.join('\n')
    expect(detailed).toContain('Source  workspace · filesystem')
    expect(detailed).toContain('Base  D:\\repo\\.agents\\skills\\review')
    expect(output).not.toContain('╭─ SKILLS')
    expect(output).not.toContain('├─ AVAILABLE')
    expect(frame.styleSpans?.every(spans => spans[0]?.style.backgroundRole === 'panelBackground')).toBe(true)
    expect(frame.lineStyles).toContainEqual(expect.objectContaining({
      backgroundRole: 'selectionBackground',
      fill: true,
    }))
    expect(frame.cursor).toBeUndefined()
    const searching = renderDshFrame({ ...base, skillPicker: { ...picker, navigation: { focus: 'search', detailOffset: 0 } } }, { columns: 140, rows: 24 })
    expect(searching.cursor).toEqual(expect.objectContaining({ row: 1 }))
    expect(searching.styleSpans?.flat().some(span => span.style.backgroundRole === 'inactiveSelectionBackground')).toBe(true)

    const remote = renderDshFrame({
      ...base,
      skillPicker: { ...picker, selectedIndex: 1, selectedName: 'research', navigation: details },
    }, { columns: 100, rows: 18 }).lines.join('\n')
    expect(remote).toContain('Invoke  user ✓ · model —')
    expect(remote).toContain('Base  https://skills.example/research')
    expect(remote).not.toContain('When  ')

    const opaque = renderDshFrame({
      ...base,
      skillPicker: { ...picker, selectedIndex: 2, selectedName: 'opaque', navigation: details },
    }, { columns: 100, rows: 18 }).lines.join('\n')
    expect(opaque).toContain('Base  embedded bundle')

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
      navigation: details,
    }
    expect(renderDshFrame({ ...base, skillPicker: noResource }, {
      columns: 100,
      rows: 16,
    }).lines.join('\n')).not.toContain('Base  ')

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
    expect(output).toContain('Skills')
    expect(output).toContain('0/0 · Refreshing')
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
      expect(compact.cursor).toBeUndefined()
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
    let panelState = openAttemptPanel(createAttemptPanelState(), attempts)
    const selectedLatest = selectAttemptPanel(panelState, attempts)
    if (selectedLatest === undefined) throw new Error('missing attempt panel')

    const base = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('draft stays put'),
    }, { columns: 140, rows: 36 })
    const overlay = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('draft stays put'),
      attemptPanel: selectedLatest,
    }, { columns: 140, rows: 36 })
    const output = overlay.lines.join('\n')

    expect(base.conversation).toBeDefined()
    expect(base.overlay).toBeUndefined()
    expect(overlay.conversation).toBeUndefined()
    expect(overlay.viewport).toEqual(base.viewport)
    expect(overlay.overlay).toBeUndefined()
    expect(overlay.lines).toHaveLength(36)
    expect(output).toContain('Request recovery')
    expect(output).toContain('×01 ─ ◆02')
    expect(output).toContain('rerouted-provider')
    expect(output).toContain('AUTH')
    expect(output).toContain('Request id  request-b1')
    expect(output).toContain('WAIT 750ms')
    expect(output).toContain('↑↓ provider chain · ←→ failed request')
    expect(output).not.toContain('draft stays put')
    expect(overlay.styleSpans?.every(spans => spans[0]?.style.backgroundRole === 'panelBackground')).toBe(true)
    for (const line of overlay.lines) expect(visibleWidth(line)).toBe(140)

    panelState = applyAttemptPanelAction(panelState, attempts, { type: 'move-down' }).state
    const selectedOlder = selectAttemptPanel(panelState, attempts)
    if (selectedOlder === undefined) throw new Error('missing older attempt panel')
    expect(selectedOlder?.selected?.retryId).toBe('retry-a')
    expect(selectedOlder?.selectedAttempt?.failure.requestId).toBe('request-a2')
    const olderOutput = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('draft stays put'),
      attemptPanel: selectedOlder,
    }, { columns: 140, rows: 36 }).lines.join('\n')
    expect(olderOutput).toContain('×01 ─ ×02 ─ ↗03')
    expect(olderOutput).toContain('Request id  request-a2')
    panelState = applyAttemptPanelAction(
      panelState,
      attempts,
      { type: 'move-previous-attempt' },
    ).state
    const selectedFirstFailure = selectAttemptPanel(panelState, attempts)
    if (selectedFirstFailure === undefined) throw new Error('missing first failure panel')
    expect(selectedFirstFailure?.selectedAttempt?.failure.requestId).toBe('request-a1')
    expect(renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('draft stays put'),
      attemptPanel: selectedFirstFailure,
    }, { columns: 140, rows: 36 }).lines.join('\n')).toContain('Request id  request-a1')
    expect(applyAttemptPanelAction(panelState, attempts, { type: 'escape' }).state.open).toBe(false)
  })

  it('renders every request-recovery terminal state, empty history, and short overlay height', () => {
    const ui = selectSession(createUiState(), 'session-a')
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
      const selectedAttempt = attempts.at(-1)
      const view: AttemptPanelView = {
        rows: [selected],
        selectedIndex: 0,
        selected,
        selectedAttemptIndex: attempts.length - 1,
        ...(selectedAttempt === undefined ? {} : { selectedAttempt }),
        omittedChainCount: 0,
      }
      return renderDshFrame({
        ui,
        interaction: undefined,
        prompt: createPromptEditorState(),
        attemptPanel: view,
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

    const empty: AttemptPanelView = {
      rows: [],
      selectedIndex: -1,
      selectedAttemptIndex: -1,
      omittedChainCount: 0,
    }
    const emptyOutput = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      attemptPanel: empty,
    }, { columns: 80, rows: 8 }).lines.join('\n')
    expect(emptyOutput).toContain('No retry history')
    expect(emptyOutput).toContain('0 active')

    for (const rows of [1, 2, 3]) {
      const short = renderDshFrame({
        ui,
        interaction: undefined,
        prompt: createPromptEditorState(),
        attemptPanel: empty,
      }, { columns: 80, rows })
      expect(short.lines).toHaveLength(rows)
      expect(short.lines[0]).toContain('Request recovery')
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
    let panelState = openRoutePanel(createRoutePanelState(), routes)
    const selected = selectRoutePanel(panelState, routes)
    if (selected === undefined) throw new Error('missing route panel')

    const base = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('draft stays put'),
    }, { columns: 150, rows: 38 })
    const overlay = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('draft stays put'),
      routePanel: selected,
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

    const omittedOutput = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      routePanel: { ...selected, omittedEpochCount: 3 },
    }, { columns: 150, rows: 38 }).lines.join('\n')
    expect(omittedOutput).toContain('…3 ─ ◆04 ─ ◉05')

    panelState = applyRoutePanelAction(panelState, routes, { type: 'move-down' }).state
    const older = selectRoutePanel(panelState, routes)
    if (older === undefined) throw new Error('missing older route panel')
    expect(older?.selected?.config.model).toBe('deepseek-v4-flash')
    const olderOutput = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      routePanel: older,
    }, { columns: 150, rows: 38 }).lines.join('\n')
    expect(olderOutput).toContain('State  HISTORY')
    expect(olderOutput).toContain('Effort  — · adapter default')
  })

  it('renders empty route history and every compact route-panel height', () => {
    const ui = selectSession(createUiState(), 'session-a')
    const empty: RoutePanelView = {
      rows: [],
      selectedIndex: -1,
      omittedEpochCount: 0,
    }
    const output = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      routePanel: empty,
    }, { columns: 80, rows: 8 }).lines.join('\n')
    expect(output).toContain('No route epochs recorded')
    expect(output).toContain('0 epochs')

    for (const rows of [1, 2, 3]) {
      const short = renderDshFrame({
        ui,
        interaction: undefined,
        prompt: createPromptEditorState(),
        routePanel: empty,
      }, { columns: 80, rows })
      expect(short.lines).toHaveLength(rows)
      expect(short.lines[0]).toContain('Model route')
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
    const opened = openRoutePanel(createRoutePanelState(), routes)
    const changedPanel = selectRoutePanel(
      applyRoutePanelAction(opened, routes, { type: 'move-down' }).state,
      routes,
    )
    const routePanel = selectRoutePanel(
      applyRoutePanelAction(
        applyRoutePanelAction(opened, routes, { type: 'move-down' }).state,
        routes,
        { type: 'move-down' },
      ).state,
      routes,
    )
    if (routePanel === undefined) throw new Error('missing resumed route panel')

    const output = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      routePanel,
    }, { columns: 120, rows: 30 }).lines.join('\n')
    expect(output).toContain('↻01')
    expect(output).toContain('◇02')
    expect(output).toContain('RESUME')
    expect(output).toContain('deepseek-official/resumed-model')

    if (changedPanel === undefined) throw new Error('missing changed route panel')
    const changedOutput = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      routePanel: changedPanel,
    }, { columns: 120, rows: 30 }).lines.join('\n')
    expect(changedOutput).toContain('› ◇02  CHANGE')
    expect(changedOutput).toContain('State  HISTORY')
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
    expect(output).toContain('Models')
    expect(output).toContain('READ-ONLY CATALOG · 小米模型')
    expect(output).toContain('小米模型')
    expect(output).toContain('current')
    expect(output).toContain('unlisted')
    expect(output).toContain('unroutable')
    expect(output).toContain('目录�失败')
    expect(output).not.toContain('hidden')
    expect(output).not.toContain('\x1b')
    expect(frame.cursor).toBeUndefined()
    expect(frame.overlay).toBeUndefined()
    expect(frame.lineStyles).toContainEqual(expect.objectContaining({
      backgroundRole: 'selectionBackground',
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
    expect(emptyTwo.lines[1]).toContain('Esc back')
    expect(emptyFrame.lines.join('\n')).toContain('Switching model')

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
    expect(noSelectedTwo.lines[1]).toContain('Esc back')

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
    expect(retainedOutput).toContain('Selected model')
    expect(retainedOutput).toContain('State  current · unroutable · retained route')
    expect(retainedOutput).toContain('Reasoning  provider default')
    expect(retainedOutput).not.toContain('│')
    for (const style of retainedRoute.lineStyles ?? []) {
      expect(style).toMatchObject({ fill: true })
      expect(['panelBackground', 'selectionBackground']).toContain(style?.backgroundRole)
    }
    expect(retainedRoute.lineStyles).toContainEqual(expect.objectContaining({
      tone: 'primary', bold: true, backgroundRole: 'panelBackground', fill: true,
    }))
    expect(retainedRoute.lineStyles).toContainEqual(expect.objectContaining({
      tone: 'muted', backgroundRole: 'panelBackground', fill: true,
    }))

    const defaultRoute = renderDetailedModel('provider-a', 'route-b').lines.join('\n')
    expect(defaultRoute).toContain('State  default · routable')
    expect(defaultRoute).toContain('Reasoning  1 option')

    const pluralEfforts = renderDetailedModel('provider-b', 'route-c').lines.join('\n')
    expect(pluralEfforts).toContain('State  routable')
    expect(pluralEfforts).toContain('Reasoning  2 options')

    const retainedEffort = renderDetailedModel('provider-b', 'route-d').lines.join('\n')
    expect(retainedEffort).toContain('Reasoning  opaque/high')

    const unroutableCatalog = renderDshFrame({
      ...base,
      modelPicker: { ...detailedModels, routable: false, loading: true },
    }, { columns: 160, rows: 16 })
    expect(unroutableCatalog.lines.join('\n')).toContain('Current Provider is unroutable')

    const missingDetail = renderDshFrame({
      ...base,
      modelPicker: {
        ...detailedModels,
        selectedModel: { provider: 'provider-a', model: 'missing' },
      },
    }, { columns: 160, rows: 24 })
    expect(missingDetail.lines.join('\n')).not.toContain('Selected model')

    const { selectedModel: omittedSelectedModel, ...noDetailPicker } = detailedModels
    expect(omittedSelectedModel).toEqual({ provider: 'provider-a', model: 'route-a' })
    const noDetail = renderDshFrame({
      ...base,
      modelPicker: noDetailPicker,
    }, { columns: 160, rows: 24 })
    expect(noDetail.lines.join('\n')).not.toContain('Selected model')
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
    expect(wideOutput).toContain('Models · Reasoning effort')
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

  it('renders the session picker as an independent read-only Workspace with complete row provenance', () => {
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
    }, { columns: 160, rows: 18 })
    const output = frame.lines.join('\n')

    expect(frame.lines[0]).toContain('Sessions')
    expect(frame.lines[0]).not.toContain('SESSIONS · DSH runtime')
    expect(frame.overlay).toBeUndefined()
    expect(output).toContain('Session list')
    expect(output).toContain('3/3 · Durable')
    expect(output).toContain('Loading sessions')
    expect(output).toContain('current')
    expect(output).toContain('cold')
    expect(output).toContain('› live-child')
    expect(output).toContain('running')
    expect(output).toContain('Owner')
    expect(output).toContain('Child of parent')
    expect(output).toContain('Workspace')
    expect(output).toContain('D:\\agents')
    expect(output).toContain('Preset')
    expect(output).toContain('research')
    expect(output).toContain('Notice: Catalog refreshed')
    expect(frame.lines.at(-1)).toContain('Enter open · R refresh')
    expect(frame.lines.at(-1)).toContain('Tab details')
    expect(frame.lines.at(-1)).toContain('Esc back')
    expect(frame.styleSpans?.every(spans => spans[0]?.style.backgroundRole === 'panelBackground')).toBe(true)
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
    expect(liveSwitch.lines[0]).toContain('Sessions')
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
    expect(inspectOnly.lines[0]).toContain('Sessions')
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
    expect(switchAndInspect.lines[0]).toContain('Sessions')
    expect(switchAndInspect.lines.at(-1)).toContain('Enter switch/inspect')

    const emptyFour = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      sessionPicker: {
        view: {
          durability: picker.durability,
          rows: [],
          selectedIndex: 0,
          offset: 0,
          totalCount: 0,
        },
        loading: false,
        loaded: true,
      },
    }, { columns: 160, rows: 4 })
    expect(emptyFour.lines.join('\n')).toContain('No sessions found')
    expect(emptyFour.lineStyles?.[2]).toMatchObject({ tone: 'primary' })

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
    expect(attachedDetail.lines.join('\n')).toContain('State')
    expect(attachedDetail.lines.join('\n')).toContain('current · attached')
    expect(attachedDetail.lines.join('\n')).toContain('Storage')
    expect(attachedDetail.lines.join('\n')).toContain('observed')

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
    expect(coldDetail.lines.join('\n')).toContain('State')
    expect(coldDetail.lines.join('\n')).toContain('cold · offline')
    expect(coldDetail.lines.join('\n')).toContain('Storage')
    expect(coldDetail.lines.join('\n')).toContain('observed')

    const compactCurrent = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      sessionPicker: {
        view: { ...picker, selectedIndex: 0, selectedSessionId: 'current', navigation: { focus: 'details', detailOffset: 0 } },
        loading: false,
        loaded: true,
      },
    }, { columns: 60, rows: 12 })
    expect(compactCurrent.lines.join('\n')).toContain('Identity  current')
    expect(compactCurrent.lines.join('\n')).toContain('current · attached')
    expect(compactCurrent.lines.join('\n')).toContain('Workspace')
    expect(compactCurrent.lines.join('\n')).toContain('Not recorded')

    const compactCurrentSummary = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      sessionPicker: {
        view: { ...picker, selectedIndex: 0, selectedSessionId: 'current', navigation: { focus: 'details', detailOffset: 0 } },
        loading: false,
        loaded: true,
      },
    }, { columns: 60, rows: 8 })
    expect(compactCurrentSummary.lines.join('\n')).toContain('State')
    expect(compactCurrentSummary.lines.join('\n')).toContain('current · attached')

    const compactCold = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      sessionPicker: {
        view: { ...picker, selectedIndex: 1, selectedSessionId: 'cold', navigation: { focus: 'details', detailOffset: 0 } },
        loading: false,
        loaded: true,
      },
    }, { columns: 60, rows: 12 })
    expect(compactCold.lines.join('\n')).toContain('Preset')
    expect(compactCold.lines.join('\n')).toContain('coding')
    expect(compactCold.lines.join('\n')).toContain('Workspace')
    expect(compactCold.lines.join('\n')).toContain('D:\\work')

    const unspecifiedLive = renderDshFrame({
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      sessionPicker: {
        view: {
          durability: 'available',
          rows: [{
            sessionId: 'unclassified-child',
            createdAt: 400,
            isSubagent: true,
            attached: false,
            durablePresence: 'not-observed',
            relation: 'other-live',
          }],
          selectedIndex: 0,
          selectedSessionId: 'unclassified-child',
          offset: 0,
          totalCount: 1,
        },
        loading: false,
        loaded: true,
        error: 'catalog unavailable',
      },
    }, { columns: 120, rows: 12 })
    expect(unspecifiedLive.lines.join('\n')).toContain('› unclassified-child')
    expect(unspecifiedLive.lines.join('\n')).toContain('live')
    expect(unspecifiedLive.lines.join('\n')).toContain('Owner')
    expect(unspecifiedLive.lines.join('\n')).toContain('Child of unknown')
    expect(unspecifiedLive.lines.join('\n')).toContain('Error: catalog unavailable')
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
    }, { columns: 120, rows: 20 })
    const output = frame.lines.join('\n')

    expect(output).toContain('Error: catalog failed�')
    expect(output).toContain('Live sessions only · durable storage unavailable')
    expect(output).toContain('› unsafe�id')
    expect(output).toContain('other-live · idle')
    expect(output).toContain('Child of unknown')
    expect(output).toContain('D:\\unsafe↵line')
    expect(output).toContain('raw')
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
    expect(two.lines[1]).toContain('Esc back')
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
    expect(emptyTwo.lines[1]).toContain('Esc back')
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

    expect(frame.lines[0]).toContain('Session inspection')
    expect(frame.lines[0]).not.toContain('SESSION INSPECTION · DSH/durable')
    expect(output).toContain('Session  session-a')
    expect(output).toContain('immutable snapshot · refreshing')
    expect(frame.overlay).toBeUndefined()
    expect(output).toContain('Snapshot safety')
    expect(output).toContain('Transcript')
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
    expect(frame.lines.at(-1)).toContain('j/k ↑↓ PgUp/PgDn · Refreshing')
    expect(frame.lines.at(-1)).toContain('Esc back')
    expect(output).not.toContain('Sessions · [DSH-TUI/local]')
    expect(output).not.toContain('Approval:')
    expect(output).not.toContain('hidden prompt')
    expect(output).not.toContain('\u001b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    expect(frame.cursor).toBeUndefined()
    expect(frame.styleSpans?.every(spans => spans[0]?.style.backgroundRole === 'panelBackground')).toBe(true)
  })

  it('renders Session Fork as a dedicated fixed confirmation surface', () => {
    const source: SessionPickerView['rows'][number] = {
      sessionId: 'source-session',
      createdAt: 100,
      cwd: 'D:\\work',
      isSubagent: false,
      creationAgentPreset: 'code',
      attached: true,
      durablePresence: 'observed',
      liveStatus: 'idle',
      relation: 'current',
    }
    const base = {
      ui: populatedState(),
      interaction: undefined,
      prompt: createPromptEditorState('hidden draft'),
    }
    const confirmation = renderDshFrame({
      ...base,
      sessionFork: { kind: 'confirm', source },
    }, { columns: 160, rows: 24 })
    const output = confirmation.lines.join('\n')

    expect(confirmation.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })
    expect(confirmation.lines[0]).toContain('▌ Fork session')
    expect(confirmation.lines[0]).not.toContain('FORK SESSION · DSH official')
    expect(output).toContain('Source')
    expect(output).toContain('Child contract')
    expect(output).toContain('source-session')
    expect(output).toContain('Last completed turn')
    expect(output).toContain('No source activation or mutation')
    expect(output).toContain('CREATE CHILD')
    expect(confirmation.lines.at(-1)).toContain('Enter create')
    expect(confirmation.lines.at(-1)).toContain('Esc back')
    expect(confirmation.lineStyles?.every(style => style?.background === 'black')).toBe(true)
    expect(output).not.toContain('hidden draft')

    const running = renderDshFrame({
      ...base,
      sessionFork: { kind: 'running', source },
    }, { columns: 160, rows: 24 })
    expect(running.lines.join('\n')).toContain('Creating child session')
    expect(running.lines.join('\n')).toContain('CREATING CHILD')
    expect(running.lines.at(-1)).toContain('Creating child')
    expect(running.lines.at(-1)).toContain('Esc cancel')

    const compact = renderDshFrame({
      ...base,
      sessionFork: { kind: 'confirm', source },
    }, { columns: 50, rows: 6 })
    expect(compact.lines.join('\n')).toContain('Inherits working directory')
    expect(compact.lines.at(-1)).toContain('Enter create')

    const compactRunning = renderDshFrame({
      ...base,
      sessionFork: { kind: 'running', source },
    }, { columns: 60, rows: 7 })
    expect(compactRunning.lines.join('\n')).toContain('Creating child session')
    expect(compactRunning.lines.at(-1)).toContain('Creating child')

    const oneRow = renderDshFrame({
      ...base,
      sessionFork: { kind: 'confirm', source },
    }, { columns: 40, rows: 1 })
    expect(oneRow.lines).toHaveLength(1)
    expect(oneRow.lines[0]).toContain('▌ Fork session')

    const twoRowRunning = renderDshFrame({
      ...base,
      sessionFork: { kind: 'running', source },
    }, { columns: 60, rows: 2 })
    expect(twoRowRunning.lines).toHaveLength(2)
    expect(twoRowRunning.lines[1]).toContain('Creating child')

    const twoRowConfirm = renderDshFrame({
      ...base,
      sessionFork: { kind: 'confirm', source },
    }, { columns: 60, rows: 2 })
    expect(twoRowConfirm.lines[1]).toContain('Enter create')

    const threeRowConfirm = renderDshFrame({
      ...base,
      sessionFork: { kind: 'confirm', source },
    }, { columns: 60, rows: 3 })
    expect(threeRowConfirm.lines).toHaveLength(3)
    expect(threeRowConfirm.lines[1]).toContain('CREATE CHILD')
    expect(threeRowConfirm.lines[2]).toContain('Enter create')

    const delegatedSource: SessionPickerView['rows'][number] = {
      sessionId: source.sessionId,
      createdAt: source.createdAt,
      durablePresence: source.durablePresence,
      attached: false,
      isSubagent: true,
      relation: 'cold',
    }
    const delegated = renderDshFrame({
      ...base,
      sessionFork: { kind: 'confirm', source: delegatedSource },
    }, { columns: 100, rows: 12 })
    expect(delegated.lines.join('\n')).toContain('cold · offline')
    expect(delegated.lines.join('\n')).toContain('Child of unknown')
    expect(delegated.lines.join('\n')).toContain('Resolved from history')

    const delegatedKnownParent = renderDshFrame({
      ...base,
      sessionFork: {
        kind: 'confirm',
        source: { ...delegatedSource, parentSessionId: 'parent-session', attached: true },
      },
    }, { columns: 100, rows: 12 })
    expect(delegatedKnownParent.lines.join('\n')).toContain('cold · attached')
    expect(delegatedKnownParent.lines.join('\n')).toContain('Child of parent-session')
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
    expect(resumable.lines.at(-1)).toContain('A resume')

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
    expect(loadingOutput).toContain('Session inspection')
    expect(loadingOutput).toContain('Inspecting unsafe�id… · logical read-only · Storage unchanged')
    expect(loading.lines.at(-1)).toContain('Esc back')
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
    expect(failedOutput).toContain('Session inspection')
    expect(failedOutput).toContain('Inspect failed: inspect↵failed�')
    expect(failedOutput).toContain('Storage unchanged')
    expect(failed.lines.at(-1)).toContain('R retry')
    expect(failed.lines.at(-1)).toContain('Esc back')
    expect(failedOutput).not.toContain('Approval:')
    expect(failedOutput).not.toContain('hidden prompt')
    expect(failedOutput).not.toContain('\u001b')
    expect(failed.cursor).toBeUndefined()

    const ready = renderDshFrame({
      ...base,
      sessionInspection: {
        kind: 'ready',
        sessionId: 'session-a',
        header: {
          sessionId: 'session-a',
          createdAt: 1,
          isSubagent: false,
        },
        projection: createUiState(),
        scrollOffset: 0,
        refreshing: false,
        observation: { kind: 'missing' },
      },
    }, { columns: 100, rows: 4 })
    expect(ready.lines.join('\n')).toContain('Latest catalog observation: missing')
    expect(ready.lineStyles?.[2]).toMatchObject({ tone: 'primary' })
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

    expect(frame.lines[0]).toContain('▌ Resume cold session')
    expect(frame.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })
    expect(output).toContain('Exact target')
    expect(output).toContain('cold�target')
    expect(output).toContain('Runtime effects')
    expect(output).toContain('Resume may repair or append durable storage.')
    expect(output).toContain('It may create and publish an Agent before this TUI switches views.')
    expect(output).toContain('No resume has started yet.')
    expect(output).toContain('RESUME SESSION')
    expect(output).toContain('Latest catalog observation: cold · durable:observed')
    expect(output).toContain('root · created:123 · cwd:D:\\resume↵workspace · preset:research�preset')
    expect(frame.lines.at(-1)).toContain('Enter resume')
    expect(frame.lines.at(-1)).toContain('Esc back')
    expect(output).not.toContain('Approval:')
    expect(output).not.toContain('hidden prompt')
    expect(output).not.toContain('\u001b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    expect(frame.cursor).toBeUndefined()

    const oneRow = renderDshFrame(base, { columns: 80, rows: 1 })
    expect(oneRow.lines).toHaveLength(1)
    expect(oneRow.lines[0]).toContain('▌ Resume cold session')

    const compact = renderDshFrame(base, { columns: 80, rows: 2 })
    expect(compact.lines[0]).toContain('▌ Resume cold session')
    expect(compact.lines[1]).toContain('Resize to at least 60x7')

    const compactFits = renderDshFrame({
      ...base,
      sessionInspection: {
        ...base.sessionInspection,
        observation: { kind: 'missing' as const },
      },
    }, { columns: 80, rows: 7 })
    expect(compactFits.lines.join('\n')).toContain('Exact target')
    expect(compactFits.lines.join('\n')).toContain('Missing')
    expect(compactFits.lines.join('\n')).toContain('RESUME SESSION')
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
    expect(oldest.lines.join('\n')).toContain('Logical read-only snapshot · Storage unchanged')

    const two = renderDshFrame({
      ...base,
      sessionInspection: ready(0, { kind: 'missing' }),
    }, { columns: 20, rows: 2 })
    expect(two.lines).toHaveLength(2)
    expect(two.lines[0]).toContain('Session')
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
    expect(errorThree.lineStyles?.[1]).toMatchObject({ tone: 'error', bold: true })

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
    expect(one.lines[0]).toContain('Session inspection')
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
    expect(failedTwo.lines[0]).toContain('Session inspection')
    expect(failedTwo.lines[1]).not.toContain('Refresh failed')
    expect(failedTwo.lines[1]).toContain('Esc back')
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

  it('makes wrapped inspection metadata reachable alongside the whole transcript at every directory width', () => {
    const panel: Extract<SessionInspectionPanel, { kind: 'ready' }> = {
      kind: 'ready', sessionId: 'session-a',
      header: { sessionId: 'session-a', createdAt: 1, isSubagent: false,
        cwd: 'D:/' + 'directory/'.repeat(80) + ' CWD-END',
        creationAgentPreset: 'preset-'.repeat(80) + ' PRESET-END' },
      projection: populatedState(), scrollOffset: 0, refreshing: false, observation: { kind: 'missing' },
    }
    for (const columns of [80, 100, 140, 200]) {
      for (const rows of [4, 6, 12]) {
        const viewport = { columns, rows }
        const seen: string[] = []
        for (let scrollOffset = 0; scrollOffset <= sessionInspectionMaxScrollOffset(panel, viewport); scrollOffset += 1) {
          const frame = renderDshFrame({ ui: createUiState(), interaction: undefined, prompt: createPromptEditorState(),
            sessionInspection: { ...panel, scrollOffset } }, viewport)
          seen.push(...frame.lines)
          expect(frame.lines.at(-1)).toContain('Esc back')
          expect(frame.lines.length).toBeLessThanOrEqual(rows)
        }
        const text = seen.join('\n')
        expect(text).toContain('CWD-END')
        expect(text).toContain('PRESET-END')
        expect(text).toContain('You: 你好世界')
        expect(text).toContain('Error: FAILED: ToolError')
      }
    }
    const empty = { ...panel, projection: createUiState(), header: { sessionId: 'session-a', createdAt: 1, isSubagent: false } }
    const roomy = { columns: 100, rows: 24 }
    expect(sessionInspectionMaxScrollOffset(empty, roomy)).toBe(0)
    const frame = renderDshFrame({ ui: createUiState(), interaction: undefined, prompt: createPromptEditorState(),
      sessionInspection: empty }, roomy)
    expect(frame.lines.join('\n')).toContain('No transcript rows')
    expect(frame.lines.join('\n')).toContain('Storage unchanged')
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
    const frame = renderContextFrame(
      CONTEXT_SNAPSHOT,
      'session\x1b[2J\nunsafe',
      { columns: 140, rows: 9 },
    )
    const text = frame.lines.join('\n')

    expect(frame.lines).toHaveLength(9)
    expect(text).toContain('Context / Pressure')
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
    const scrolled = renderContextFrame(CONTEXT_SNAPSHOT, 'session-a', { columns: 140, rows: 9 }, undefined, 100)
    expect(scrolled.lines.join('\n')).toContain('Compact No maintenance recorded')
    expect(scrolled.lines.join('\n')).toContain('Official projection · seq 42')
    expect(frame.lines.at(-1)).toContain('/compact maintain context')
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
      100,
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
      100,
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
      100,
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
      'HEALTHY · 25%',
    )
    expect(providerSample.lines.join('\n')).toContain('Latest request')

    const partial = renderContextFrame({
      available: true,
      pressure: { pressureTokens: 32_000 },
    }, 'partial', { columns: 90, rows: 8 })
    expect(partial.lines.join('\n')).toContain(
      'Waiting for route capacity and provider usage',
    )
    expect(partial.lines.join('\n')).toContain('Latest request')
    expect(renderContextFrame({ available: true, pressure: { pressureTokens: 32_000 } },
      'partial', { columns: 90, rows: 8 }, undefined, 100).lines.join('\n'))
      .toContain('Official projection · seq unknown')

    const noPressure = renderContextFrame({
      available: true,
      breakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
    }, 'no-pressure', { columns: 90, rows: 5 })
    expect(noPressure.lines.join('\n')).toContain(
      'Waiting for route capacity and provider usage',
    )
    expect(noPressure.lines.join('\n')).toContain('No sample')

    const unavailable = renderContextFrame(
      { available: false },
      'none',
      { columns: 80, rows: 6 },
    )
    expect(unavailable.lines.join('\n')).toContain('Token meter offline')
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
    expect(absent.lines[0]).toContain('Context')
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
      contextPanel: true,
    }, { columns: 100, rows: 10 })
    expect(panel.lines[0]).toContain('Context')
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
    expect(text).toContain('› Connected')
    expect(text).toContain('● connected')
    expect(text).toContain('Active')
    expect(text).toContain('◆ active')
    expect(text).toContain('Authorized')
    expect(text).toContain('◐ authorized')
    expect(text).toContain('dormant')
    expect(text).toContain('○ dormant')
    expect(text).toContain('Inspector / Selected provider')
    expect(text).toContain('Providers / Connections')
    expect(text).toContain('Directory')
    expect(text).toContain('Route  connected')
    expect(text).toContain('State  ● connected')
    expect(text).toContain('Credential  oauth')
    expect(text).toContain('Methods  1')
    expect(frame.lineStyles).toContainEqual(expect.objectContaining({
      inverse: true,
      fill: true,
    }))
    expect(text).not.toContain('│')
    for (const style of frame.lineStyles ?? []) {
      expect(style).toMatchObject({ background: 'black', fill: true })
    }
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
    expect(one.lines[0]).toContain('Provider')

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
    expect(select.lines.at(-1)).toContain('↑↓ move')
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
    expect(frame.lines[0]).toContain('Connections')
    expect(frame.overlay).toBeUndefined()
    expect(frame.lines.join('\n')).not.toContain('hidden composer')
  })
})
