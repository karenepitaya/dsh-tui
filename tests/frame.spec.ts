import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { cordisBrandLines } from '../src/ui/brand.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import {
  buildWorkbenchDashboard,
  buildStatusLine,
  cacheHitPercent,
  renderDshFrame,
} from '../src/ui/frame.ts'
import {
  createUiState,
  type SessionCompactionState,
  type TranscriptRow,
  type UiState,
} from '../src/transcript/state.ts'
import { selectSession } from '../src/transcript/reducer.ts'
import type { InteractionSnapshot } from '../src/interaction/port.ts'
import type { UiMessage } from '../src/runtime/events.ts'
import { ToolCardRendererRegistry } from '../src/presentation/tool-card-renderers.ts'
import { installBuiltinToolCardRenderers } from '../src/presentation/builtin-tool-card-renderers.ts'
import type { SessionWorkbenchSnapshot } from '../src/workbench/port.ts'
import type { GoalActionSurfaceView } from '../src/workbench/goal-actions.ts'
import type { SessionJobsSnapshot } from '../src/activity/port.ts'
import type { JobsActivityView } from '../src/activity/jobs-activity.ts'
import type { ToolBrowserView } from '../src/tool/browser.ts'
import type { ActivityCenterView } from '../src/activity/center.ts'

function message(
  id: string,
  role: UiMessage['role'],
  text: string,
  sourceKind = role === 'user' ? 'user' : 'model',
): UiMessage {
  return {
    id,
    role,
    sourceKind,
    content: text === '' ? [] : [{ type: 'text', text }],
  }
}

function visualState(): UiState {
  const selected = selectSession(createUiState(), 'session-a')
  const session = selected.sessions['session-a']!
  const rows: readonly TranscriptRow[] = [
    {
      kind: 'user',
      key: 'event:0',
      seq: 0,
      message: message('user-0', 'user', 'inspect the workspace'),
    },
    {
      kind: 'assistant',
      key: 'event:1',
      seq: 1,
      turn: 1,
      step: 1,
      message: message('assistant-1', 'assistant', 'I will read the project first.'),
      interrupted: false,
    },
    {
      kind: 'tool',
      key: 'tool:1:1:read-1',
      turn: 1,
      step: 1,
      callId: 'read-1',
      name: 'read',
      arguments: '{"path":"README.md"}\u001b[2J',
      resultSeq: 2,
      result: message('tool-2', 'user', 'opened\u0000', 'tool'),
    },
    {
      kind: 'command',
      key: 'command:compact-1',
      commandId: 'compact-1',
      name: 'compact',
      status: 'success',
      text: 'context compacted',
    },
  ]
  return {
    ...selected,
    sessions: {
      ...selected.sessions,
      'session-a': { ...session, rows },
    },
  }
}

function approval(): InteractionSnapshot {
  return {
    type: 'interaction/snapshot',
    sessionId: 'session-a',
    pending: [{
      id: 'approval-1',
      kind: 'approval',
      sessionId: 'session-a',
      approvalId: 'approval-1',
      callId: 'read-1',
      toolName: 'read',
      reason: 'workspace access',
    }],
  }
}

describe('DSH-TUI visual frame', () => {
  it('projects Goal, Plan, and Todo as one responsive Workbench Dashboard', () => {
    const workbench: SessionWorkbenchSnapshot = {
      available: true,
      asOfSeq: 12,
      goal: {
        id: 'goal-1',
        revision: 2,
        objective: 'Ship the first-party workbench\u001b[2J',
        phase: 'blocked',
        blockedReason: { code: 'review', message: 'Waiting for review\u0007' },
        maxGoalRounds: 8,
        roundsStarted: 3,
        createdAt: 10,
        updatedAt: 20,
      },
      plan: { active: true, pending: false },
      todos: [
        { content: 'Adapt official projections', status: 'completed' },
        { content: 'Render the mission rail', status: 'in_progress' },
        { content: 'Run official acceptance', status: 'pending' },
      ],
    }

    const wide = buildWorkbenchDashboard(workbench, 100, 24)!
    const wideText = wide.lines.map(line => line.text).join('\n')
    expect(wide.label).toBe('WORKBENCH DASHBOARD')
    expect(wideText).toContain('GOAL BLOCKED · round 3/8 · PLAN ON · TODO 1/3')
    expect(wideText).toContain('Ship the first-party workbench')
    expect(wideText).toContain('Waiting for review�')
    expect(wideText).toContain('✓ Adapt official projections')
    expect(wideText).toContain('● Render the mission rail')
    expect(wideText).toContain('○ Run official acceptance')
    expect(wideText).not.toContain('\u001b')

    const medium = buildWorkbenchDashboard(workbench, 60, 12)!
    expect(medium.lines).toHaveLength(2)
    expect(medium.lines[0]?.text).toContain('GOAL blocked · PLAN on · 1/3 done')
    expect(medium.lines[1]?.text).toContain('Render the mission rail')

    const narrow = buildWorkbenchDashboard(workbench, 24, 8)!
    expect(narrow.lines).toHaveLength(1)
    expect(narrow.lines[0]?.text).toContain('goal blocked')
    expect(visibleWidth(narrow.lines[0]?.text ?? '')).toBeLessThanOrEqual(24)
    expect(visibleWidth(buildWorkbenchDashboard(workbench, 8, 8)?.lines[0]?.text ?? ''))
      .toBeLessThanOrEqual(8)

    expect(buildWorkbenchDashboard({ available: false }, 80, 24)).toBeUndefined()
    const empty = buildWorkbenchDashboard({
      available: true,
      goal: null,
      plan: { active: false, pending: false },
      todos: null,
    }, 80, 24)
    expect(empty?.label).toBe('QUICK START')
    expect(empty?.lines[0]?.text).toContain('/mode  Agent mode')
    expect(empty?.lines[0]?.text).toContain('/goal  Start a goal')
    expect(empty?.lines[0]?.text).toContain('/help  Commands')
    expect(buildWorkbenchDashboard({
      available: true,
      goal: { ...workbench.goal!, phase: 'complete' },
      plan: { active: true, pending: true },
      todos: [],
    }, 80, 24)?.lines[0]).toMatchObject({ tone: 'success' })
    const { blockedReason, ...unblockedGoal } = workbench.goal!
    expect(blockedReason).toBeDefined()
    expect(buildWorkbenchDashboard({
      available: true,
      goal: { ...unblockedGoal, phase: 'paused' },
      plan: { active: false, pending: true },
      todos: [
        { content: 'one', status: 'pending' },
        { content: 'two', status: 'pending' },
        { content: 'three', status: 'pending' },
        { content: 'four', status: 'pending' },
        { content: 'five', status: 'pending' },
      ],
    }, 80, 24)?.lines.at(-1)?.text).toContain('2 more tasks')

    const activeGoal = { ...unblockedGoal, phase: 'active' as const }
    expect(buildWorkbenchDashboard({
      available: true,
      goal: activeGoal,
      todos: [],
    }, 39, 8)?.lines[0]?.text).toContain('plan unavailable')
    expect(buildWorkbenchDashboard({
      available: true,
      goal: activeGoal,
      plan: { active: false, pending: false },
      todos: [],
    }, 39, 8)?.lines[0]?.text).toContain('plan off')
    expect(buildWorkbenchDashboard({
      available: true,
      goal: null,
      plan: { active: true, pending: false },
      todos: [],
    }, 24, 8)?.lines[0]?.text).toContain('goal none · plan on')

    const mediumGoal = buildWorkbenchDashboard({
      available: true,
      goal: activeGoal,
      plan: { active: false, pending: false },
      todos: [],
    }, 60, 12)!
    expect(mediumGoal.lines[1]?.text).toContain('Ship the first-party workbench')
    expect(mediumGoal.lines[1]?.tone).toBe('accent')
    expect(buildWorkbenchDashboard({
      available: true,
      goal: null,
      plan: { active: true, pending: false },
      todos: [],
    }, 60, 12)?.lines[1]?.text).toBe('No active work')

    const wideWithoutGoal = buildWorkbenchDashboard({
      available: true,
      goal: null,
      plan: { active: true, pending: false },
      todos: [],
    }, 80, 24)!
    expect(wideWithoutGoal.lines[0]?.text).toContain('GOAL NONE · PLAN ON')
    expect(wideWithoutGoal.lines.some(line => line.text.includes('PLAN ON'))).toBe(true)
    const wideWithoutPlan = buildWorkbenchDashboard({
      available: true,
      goal: activeGoal,
      todos: [],
    }, 80, 24)!
    expect(wideWithoutPlan.lines.some(line => line.text.includes('PLAN'))).toBe(false)
    expect(buildWorkbenchDashboard({
      available: true,
      goal: activeGoal,
      plan: { active: false, pending: false },
      todos: [],
    }, 80, 24)?.lines.find(line => line.text.includes('PLAN'))?.text).toContain('PLAN OFF')
    expect(buildWorkbenchDashboard({
      available: true,
      goal: activeGoal,
      plan: { active: true, pending: false },
      todos: Array.from({ length: 6 }, (_, index) => ({
        content: `task-${index + 1}`,
        status: 'pending' as const,
      })),
    }, 80, 24)?.lines.at(-1)?.text).toContain('3 more tasks')
    expect(buildWorkbenchDashboard({
      available: true,
      goal: activeGoal,
      plan: { active: true, pending: false },
      todos: Array.from({ length: 4 }, (_, index) => ({
        content: `single-omission-${index + 1}`,
        status: 'pending' as const,
      })),
    }, 80, 24)?.lines.at(-1)?.text).toContain('1 more task')
  })

  it('renders provider accounting and compaction pressure as one responsive statusline', () => {
    const context = {
      available: true,
      pressure: {
        projectedTokens: 32_000,
        pressureTokens: 31_000,
        contextWindow: 128_000,
      },
      usage: {
        uncachedInputTokens: 250,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 250,
        outputTokens: 25,
      },
    } as const
    const model = {
      current: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      },
      routable: true,
      writable: true,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
    } as const
    const compaction: SessionCompactionState = {
      compactionId: 'compact-1',
      sourceCommandId: 'command-1',
      phase: 'running',
      startSeq: 10,
      summarySeq: 11,
      shadowedItemCount: 8,
      shadowedTokenCount: 12_400,
    }

    const wide = buildStatusLine(model, context, compaction, 140)
    expect(wide?.tone).toBe('accent')
    expect(wide?.text).toContain('COMPACT 8/~12K …')
    expect(wide?.text).toContain('MODEL deepseek-official/deepseek-v4-pro/high')
    expect(wide?.text).toContain('CTX [━━······] ~32K/128K 25%')
    expect(wide?.text).toContain('CACHE 67%')
    expect(wide?.text).toContain('TOK ↑1.5K ↓25')
    expect(wide?.segments).toHaveLength(5)
    expect(visibleWidth(wide?.text ?? '')).toBeLessThanOrEqual(140)

    const narrow = buildStatusLine(model, context, compaction, 48)
    expect(narrow?.text).toContain('COMPACT')
    expect(narrow?.text).toContain('CTX')
    expect(narrow?.text).not.toContain('TOK')
    expect(visibleWidth(narrow?.text ?? '')).toBeLessThanOrEqual(48)

    const singleColumn = buildStatusLine(model, context, compaction, 1)
    expect(visibleWidth(singleColumn?.text ?? '')).toBeLessThanOrEqual(1)

    const pressured = buildStatusLine(model, {
      ...context,
      pressure: { projectedTokens: 121_600, contextWindow: 128_000 },
    }, undefined, 100)
    expect(pressured?.tone).toBe('error')

    const warning = buildStatusLine(model, {
      ...context,
      pressure: { projectedTokens: 108_800, contextWindow: 128_000 },
    }, undefined, 100)
    expect(warning?.tone).toBe('warning')

    const starting = buildStatusLine(model, context, {
      compactionId: 'compact-starting',
      phase: 'running',
      startSeq: 12,
    }, 100)
    expect(starting?.text).toContain('COMPACT …')

    expect(buildStatusLine(undefined, undefined, undefined, 100)).toBeUndefined()
    expect(buildStatusLine(undefined, {
      available: true,
      usage: {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
    }, undefined, 100)).toBeUndefined()
    expect(buildStatusLine(undefined, {
      available: true,
      usage: {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 4,
      },
    }, undefined, 100)?.text).toBe('◆ TOK ↑0 ↓4')
  })

  it('computes cache hit from all disjoint billed-input buckets without rounding a miss to 100%', () => {
    expect(cacheHitPercent({
      uncachedInputTokens: 400,
      cacheReadTokens: 500,
      cacheWriteTokens: 100,
      outputTokens: 10,
    })).toBe('50')
    expect(cacheHitPercent({
      uncachedInputTokens: 1,
      cacheReadTokens: 9_999,
      cacheWriteTokens: 0,
      outputTokens: 10,
    })).toBe('99.99')
    expect(cacheHitPercent({
      uncachedInputTokens: 4,
      cacheReadTokens: 9_996,
      cacheWriteTokens: 0,
      outputTokens: 10,
    })).toBe('99.96')
    expect(cacheHitPercent({
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    })).toBeUndefined()
    expect(cacheHitPercent({
      uncachedInputTokens: 0,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      outputTokens: 10,
    })).toBe('100')
  })

  it('places the live statusline below the boxed message composer', () => {
    const frame = renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState('next'),
      context: {
        available: true,
        pressure: { projectedTokens: 1_000, contextWindow: 10_000 },
      },
    }, { columns: 100, rows: 24 })
    const composer = frame.lines.findIndex(line => line.includes('╭─ PROMPT'))
    const statusline = frame.lines.findIndex(line => line.includes('CTX ['))
    expect(composer).toBeGreaterThan(0)
    expect(statusline).toBeGreaterThan(composer)
  })

  it('renders a structured Tool presentation through the effect-owned registry', () => {
    const base = visualState()
    const current = base.sessions['session-a']!
    const ui: UiState = {
      ...base,
      sessions: {
        ...base.sessions,
        'session-a': {
          ...current,
          rows: current.rows.map(row => row.kind === 'tool'
            ? {
                ...row,
                resultPresentation: {
                  phase: 'result' as const,
                  card: 'read' as const,
                  title: 'README.md',
                  path: 'README.md',
                  offset: 1,
                  lines: [{ number: 1, text: '# DSH-TUI' }],
                  totalLines: 12,
                  lang: 'md',
                },
              }
            : row),
        },
      },
    }
    const toolCards = new ToolCardRendererRegistry()
    installBuiltinToolCardRenderers({
      effect(setup) { return setup() },
    }, toolCards)

    const output = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards,
    }, { columns: 80, rows: 24 }).lines.join('\n')

    expect(output).toContain('TOOL  Read · README.md  ✓ DONE')
    expect(output).toContain('Lines: 1-1 of 12 · md')
    expect(output).toContain('1 │ # DSH-TUI')
    expect(output).not.toContain('Arguments: {"path":"README.md"}')
    const toolNode = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards,
    }, { columns: 80, rows: 24 }).conversation?.nodes.find(node => node.kind === 'tool')
    expect(toolNode).toMatchObject({
      kind: 'tool',
      styledLines: expect.arrayContaining([
        expect.objectContaining({
          segments: expect.arrayContaining([
            expect.objectContaining({ text: '# DSH-TUI', tone: 'accent' }),
          ]),
        }),
      ]),
    })

    const customCards = new ToolCardRendererRegistry()
    customCards.register({ phase: 'result', card: 'read' }, () => [
      'Custom read title',
      'Custom body',
    ])
    const customNode = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards: customCards,
    }, { columns: 80, rows: 24 }).conversation?.nodes.find(node => node.kind === 'tool')
    expect(customNode).toMatchObject({ kind: 'tool', label: 'TOOL  Custom read title' })
  })

  it('collapses repeated tool-only steps and suppresses empty intermediary assistant rows', () => {
    const selected = selectSession(createUiState(), 'session-a')
    const session = selected.sessions['session-a']!
    const rows: readonly TranscriptRow[] = [
      {
        kind: 'assistant', key: 'event:1', seq: 1, turn: 2, step: 1,
        message: message('empty-1', 'assistant', ''), interrupted: false,
      },
      {
        kind: 'tool', key: 'tool:2:1:read-1', turn: 2, step: 1,
        callId: 'read-1', name: 'Read', resultSeq: 2,
        result: message('result-1', 'user', 'one', 'tool'),
      },
      {
        kind: 'assistant', key: 'event:3', seq: 3, turn: 2, step: 2,
        message: message('empty-2', 'assistant', ''), interrupted: false,
      },
      {
        kind: 'tool', key: 'tool:2:2:read-2', turn: 2, step: 2,
        callId: 'read-2', name: 'Read', resultSeq: 4,
        result: message('result-2', 'user', 'two', 'tool'),
      },
    ]
    const ui: UiState = {
      ...selected,
      sessions: {
        ...selected.sessions,
        'session-a': { ...session, rows },
      },
    }

    const compact = renderDshFrame({
      ui, interaction: undefined, prompt: createPromptEditorState(),
    }, { columns: 100, rows: 24 }).conversation!
    expect(compact.nodes).toHaveLength(1)
    expect(compact.nodes[0]).toMatchObject({
      kind: 'tool', label: 'TOOL RUN · 2 CALLS · TURN 2', status: 'done',
    })
    expect((compact.nodes[0] as { lines: readonly string[] }).lines.at(-1))
      .toContain('Ctrl+O')

    const expanded = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolDetailsExpanded: true,
    }, { columns: 100, rows: 24 }).conversation!
    expect(expanded.nodes.filter(node => node.kind === 'tool')).toHaveLength(2)
    expect(expanded.nodes.some(node => node.kind === 'assistant')).toBe(false)

    const toolRows = (count: number, first: 'failed' | 'running'): readonly TranscriptRow[] => (
      Array.from({ length: count }, (_, index): TranscriptRow => ({
        kind: 'tool',
        key: `tool:3:${index + 1}:call-${index + 1}`,
        turn: 3,
        step: index + 1,
        callId: `call-${index + 1}`,
        name: `tool-${index + 1}`,
        ...(index === 0 && first === 'failed'
          ? { error: { name: 'ToolError', code: 'FAILED' } }
          : index === 0 && first === 'running'
            ? {}
            : {
                resultSeq: index + 10,
                result: message(`result-${index}`, 'user', 'done', 'tool'),
              }),
      }))
    )
    const grouped = (rows: readonly TranscriptRow[]) => renderDshFrame({
      ui: {
        ...selected,
        sessions: {
          ...selected.sessions,
          'session-a': { ...session, rows },
        },
      },
      interaction: undefined,
      prompt: createPromptEditorState(),
    }, { columns: 100, rows: 30 }).conversation!.nodes[0]

    const failedRun = grouped(toolRows(8, 'failed'))
    expect(failedRun).toMatchObject({ status: 'failed' })
    expect((failedRun as { lines: readonly string[] }).lines).toContain('… 1 more calls')
    expect((failedRun as { lines: readonly string[] }).lines.some(line => line.startsWith('× ')))
      .toBe(true)
    const runningRun = grouped(toolRows(2, 'running'))
    expect(runningRun).toMatchObject({ status: 'running' })

    const registry = new ToolCardRendererRegistry()
    installBuiltinToolCardRenderers({ effect(setup) { return setup() } }, registry)
    const structuredRows = toolRows(2, 'running').map((row, index): TranscriptRow => (
      row.kind === 'tool' && index === 0
        ? {
            ...row,
            callPresentation: {
              phase: 'call',
              card: 'terminal',
              title: 'List directory',
              cwd: 'D:/repo',
            },
          }
        : row
    ))
    const structuredRun = renderDshFrame({
      ui: {
        ...selected,
        sessions: {
          ...selected.sessions,
          'session-a': { ...session, rows: structuredRows },
        },
      },
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards: registry,
    }, { columns: 100, rows: 24 }).conversation!.nodes[0]
    expect((structuredRun as { lines: readonly string[] }).lines.join('\n'))
      .toContain('Cwd: D:/repo')
  })

  it('falls back from a call title for an empty Tool result', () => {
    const base = visualState()
    const current = base.sessions['session-a']!
    const ui: UiState = {
      ...base,
      sessions: {
        ...base.sessions,
        'session-a': {
          ...current,
          rows: current.rows.map(row => row.kind === 'tool'
            ? {
                ...row,
                result: message('empty-tool-result', 'user', '', 'tool'),
                callPresentation: {
                  phase: 'call' as const,
                  card: 'generic' as const,
                  title: 'Read pending',
                },
              }
            : row),
        },
      },
    }
    const toolCards = new ToolCardRendererRegistry()
    installBuiltinToolCardRenderers({
      effect(setup) { return setup() },
    }, toolCards)

    const output = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards,
    }, { columns: 80, rows: 24 }).lines.join('\n')

    expect(output).toContain('TOOL  Result · Read pending  ✓ DONE')
    expect(output).toContain('Result: [empty]')
  })

  it('keeps malformed empty questions and command discovery inside bounded layout', () => {
    const emptyQuestion: InteractionSnapshot = {
      type: 'interaction/snapshot',
      sessionId: 'session-a',
      pending: [{
        id: 'empty-question',
        kind: 'question',
        sessionId: 'session-a',
        questions: [],
      }],
    }
    const questionFrame = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: emptyQuestion,
      prompt: createPromptEditorState('/missing'),
      commandMenu: {
        query: 'missing',
        candidates: [],
        selectedIndex: -1,
        totalCount: 0,
      },
    }, { columns: 80, rows: 12 })
    expect(questionFrame.lines.join('\n')).toContain('No question payload')
    expect(questionFrame.lines.join('\n')).not.toContain('No matches for /missing')
    expect(questionFrame.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })

    const menuFrame = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: undefined,
      prompt: createPromptEditorState('/missing'),
      commandMenu: {
        query: 'missing',
        candidates: [],
        selectedIndex: -1,
        totalCount: 0,
      },
    }, { columns: 80, rows: 12 })
    expect(menuFrame.lines.join('\n')).not.toContain('COMMANDS')
    expect(menuFrame.lines.join('\n')).toContain('No matches for /missing')
    expect(menuFrame.lines.at(-1)).toContain('> /missing')
    expect(menuFrame.overlay).toMatchObject({ kind: 'palette', anchor: 'bottom-center' })

    const scrollingMenu = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: undefined,
      prompt: createPromptEditorState('/'),
      commandMenu: {
        query: '',
        candidates: Array.from({ length: 10 }, (_, index) => ({
          origin: index % 2 === 0 ? 'official' as const : 'local' as const,
          command: {
            name: `command-${index + 1}`,
            description: `Command ${index + 1}`,
          },
        })),
        selectedIndex: 0,
        totalCount: 10,
        windowStart: 0,
      },
    }, { columns: 100, rows: 20 })
    const scrollingText = scrollingMenu.lines.join('\n')
    expect(scrollingText).toContain('› /command-1')
    expect(scrollingText).toContain('/command-8')
    expect(scrollingText).not.toContain('Commands 1-8 of 10')
    expect(scrollingText).not.toContain('more')
    expect(scrollingText).not.toContain('[DSH/official]')
    expect(scrollingText).not.toContain('[DSH-TUI/local]')
    expect(scrollingText).not.toContain('COMMAND PALETTE')
    expect(scrollingText).not.toContain('╭─ CMD')

    const emptyWindow = renderDshFrame({
      ui: selectSession(createUiState(), 'session-a'),
      interaction: undefined,
      prompt: createPromptEditorState('/'),
      commandMenu: {
        query: '',
        candidates: [{
          origin: 'local',
          command: { name: 'mode', description: 'Switch mode' },
        }],
        selectedIndex: 0,
        totalCount: 1,
        windowStart: 9,
      },
    }, { columns: 80, rows: 12 })
    expect(emptyWindow.conversation).toBeUndefined()
    expect(emptyWindow.overlay).toMatchObject({ kind: 'palette' })
    expect(emptyWindow.lines.join('\n')).not.toContain('/mode')

    const selected = selectSession(createUiState(), 'session-a')
    const session = selected.sessions['session-a']!
    const ui: UiState = {
      ...selected,
      sessions: {
        ...selected.sessions,
        'session-a': {
          ...session,
          rows: [{
            kind: 'user',
            key: 'event:0',
            seq: 0,
            message: message('user-short', 'user', 'hello'),
          }],
        },
      },
    }
    const focusedQuestion: InteractionSnapshot = {
      type: 'interaction/snapshot',
      sessionId: 'session-a',
      pending: [{
        id: 'focused-question',
        kind: 'question',
        sessionId: 'session-a',
        questions: [{
          id: 'choice',
          header: 'Plan',
          question: 'Choose',
          options: [{ label: 'Yes' }],
        }],
      }],
    }
    const compactFocus = renderDshFrame({
      ui,
      interaction: focusedQuestion,
      prompt: createPromptEditorState(),
      input: {
        kind: 'question',
        interactionId: 'focused-question',
        questionIndex: 0,
        answerCount: 0,
        editor: createPromptEditorState(),
      },
    }, { columns: 80, rows: 7 })
    expect(compactFocus.lines.join('\n')).toContain('▌ Answer')
    expect(compactFocus.lines.join('\n')).toContain('Progress')
    expect(compactFocus.lines.join('\n')).toContain('○ Yes')
    expect(compactFocus.lines.join('\n')).toContain('✎ Other answer')
    expect(compactFocus.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })

    const oversizedFocus: InteractionSnapshot = {
      ...focusedQuestion,
      pending: [{
        ...focusedQuestion.pending[0]!,
        kind: 'question',
        questions: [{
          id: 'many-choices',
          header: 'Mode',
          question: 'Choose one',
          options: Array.from({ length: 20 }, (_, index) => ({
            label: 'Option ' + String(index + 1),
          })),
        }],
      }],
    }
    const fittedTimeline = renderDshFrame({
      ui,
      interaction: oversizedFocus,
      prompt: createPromptEditorState(),
      input: {
        kind: 'question',
        interactionId: 'focused-question',
        questionIndex: 0,
        answerCount: 0,
        editor: createPromptEditorState(),
      },
    }, { columns: 80, rows: 12 })
    expect(fittedTimeline.lines.join('\n')).not.toContain('╭─ YOU')
    expect(fittedTimeline.lines.join('\n')).toContain('more options')
    expect(fittedTimeline.lines.join('\n')).toContain('›')
  })

  it('renders plan review as a dedicated decision dock with a bounded plan preview', () => {
    const interaction: InteractionSnapshot = {
      type: 'interaction/snapshot',
      sessionId: 'session-a',
      pending: [{
        id: 'review-frame',
        kind: 'question',
        sessionId: 'session-a',
        questions: [{
          id: 'plan-review',
          question: 'Approve this plan?',
          detail: '# Plan\n\n- inspect\n- implement\n- verify\n- report',
          options: [
            { label: 'Approve' },
            { label: 'Keep planning' },
          ],
          intent: { kind: 'plan-review', approve: 'Approve' },
        }],
      }],
    }
    const frame = renderDshFrame({
      ui: visualState(),
      interaction,
      prompt: createPromptEditorState('preserved'),
      input: {
        kind: 'plan-review',
        interactionId: 'review-frame',
        selectedIndex: 1,
        actionCount: 3,
        editor: createPromptEditorState('Keep planning'),
      },
    }, { columns: 100, rows: 24 })
    const output = frame.lines.join('\n')

    expect(output).toContain('▌ Plan review')
    expect(output).toContain('READY FOR DECISION')
    expect(output).toContain('Plan')
    expect(output).toContain('│  # Plan')
    expect(output).toContain('Decision')
    expect(output).toContain('Discuss')
    expect(output).toContain('›  Keep planning')
    expect(output).toContain('Approve')
    expect(output).toContain('2 more plan lines in the tool card')
    expect(output).not.toContain('Decision:')
    expect(output).not.toContain('╭─')
    const selectedLine = frame.lines.findIndex(line => line.includes('›  Keep planning'))
    expect(selectedLine).toBeGreaterThanOrEqual(0)
    expect(frame.lineStyles?.[selectedLine]).toMatchObject({ inverse: true })
    expect(frame.lineStyles?.every(style => style?.background === 'black')).toBe(true)
    expect(frame.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })
    expect(output).not.toContain('preserved')
    expect(output).not.toContain('Plan review: Left/Right choose')

    const withDetail = (detail: string): InteractionSnapshot => ({
      ...interaction,
      pending: interaction.pending.map(item => item.kind === 'question'
        ? {
            ...item,
            questions: item.questions.map(question => ({ ...question, detail })),
          }
        : item),
    })
    const renderDetail = (detail: string): string => renderDshFrame({
      ui: visualState(),
      interaction: withDetail(detail),
      prompt: createPromptEditorState(),
      input: {
        kind: 'plan-review',
        interactionId: 'review-frame',
        selectedIndex: 2,
        actionCount: 3,
        editor: createPromptEditorState('Approve'),
      },
    }, { columns: 100, rows: 24 }).lines.join('\n')
    expect(renderDetail('# One-line plan')).not.toContain('more plan line')
    expect(renderDetail('# Plan\n- inspect\n- implement\n- verify')).toContain(
      '1 more plan line in the tool card',
    )

    for (const rows of [1, 2, 3, 4, 5]) {
      const tiny = renderDshFrame({
        ui: visualState(),
        interaction,
        prompt: createPromptEditorState(),
        input: {
          kind: 'plan-review',
          interactionId: 'review-frame',
          selectedIndex: 2,
          actionCount: 3,
          editor: createPromptEditorState('Approve'),
        },
      }, { columns: 80, rows })
      expect(tiny.lines).toHaveLength(rows)
      expect(tiny.lines[0]).toContain('Plan review')
    }
    const invalidCompactDecision = renderDshFrame({
      ui: visualState(),
      interaction,
      prompt: createPromptEditorState(),
      input: {
        kind: 'plan-review',
        interactionId: 'review-frame',
        selectedIndex: 99,
        actionCount: 3,
        editor: createPromptEditorState(),
      },
    }, { columns: 80, rows: 4 })
    expect(invalidCompactDecision.lines.join('\n')).toContain('No decision available')
    const rejectedReview = renderDshFrame({
      ui: visualState(),
      interaction,
      prompt: createPromptEditorState(),
      input: {
        kind: 'plan-review',
        interactionId: 'review-frame',
        selectedIndex: 2,
        actionCount: 3,
        editor: createPromptEditorState('Approve'),
        error: 'review response rejected',
      },
    }, { columns: 100, rows: 24 })
    expect(rejectedReview.lines.join('\n')).toContain('Error: review response rejected')

    const queued = renderDshFrame({
      ui: visualState(),
      interaction: {
        ...interaction,
        pending: [
          interaction.pending[0]!,
          {
            id: 'approval-after-review',
            kind: 'approval',
            sessionId: 'session-a',
            approvalId: 'approval-after-review',
            callId: 'call-after-review',
            toolName: 'read',
          },
        ],
      },
      prompt: createPromptEditorState(),
      input: {
        kind: 'approval',
        interactionId: 'approval-after-review',
        editor: createPromptEditorState(),
      },
    }, { columns: 100, rows: 30 }).lines.join('\n')
    expect(queued).toContain('▌ Permission request')
    expect(queued).toContain('2/2')
    expect(queued).not.toContain('Approve this plan?')
  })

  it('renders menu, edit, and clear stages of the official Goal action dock', () => {
    const goal = {
      id: 'goal-actions-frame',
      revision: 4,
      objective: 'Ship first-party Goal actions',
      phase: 'paused' as const,
      maxGoalRounds: 8,
      roundsStarted: 3,
      createdAt: 10,
      updatedAt: 20,
    }
    const actions = [
      {
        kind: 'resume' as const,
        label: 'Resume goal',
        description: 'Arm automatic continuation from the current revision.',
      },
      {
        kind: 'edit' as const,
        label: 'Edit objective',
        description: 'Replace the objective through the official Goal service.',
      },
      {
        kind: 'clear' as const,
        label: 'Clear goal',
        description: 'Write the official tombstone while retaining session history.',
      },
    ]
    const surface = (
      stage: GoalActionSurfaceView['stage'],
      editorText: string,
    ): GoalActionSurfaceView => ({
      stage,
      goal,
      actions,
      selectedIndex: 1,
      editor: createPromptEditorState(editorText),
      error: 'goal-stale: refresh revision',
    })
    const view = (goalActions: GoalActionSurfaceView) => renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState('preserved'),
      workbench: { available: true, goal },
      goalActions,
    }, { columns: 100, rows: 24 })

    const menu = view(surface('menu', 'Edit objective'))
    expect(menu.lines.join('\n')).toContain('GOAL ACTIONS')
    expect(menu.lines.join('\n')).toContain('Goal paused · revision 4 · [DSH/official]')
    expect(menu.lines.join('\n')).toContain('› Edit objective')
    expect(menu.lines.find(line => line.includes('goal> Edit objective'))).toBeDefined()
    expect(menu.lines.join('\n')).not.toContain('Goal actions: Up/Down select')
    expect(menu.lines.join('\n')).toContain('WORKBENCH DASHBOARD')
    expect(menu.lines.join('\n')).toContain('GOAL PAUSED')

    const edit = view(surface('edit', 'New objective'))
    expect(edit.lines.join('\n')).toContain('Current: Ship first-party Goal actions')
    expect(edit.lines.join('\n')).toContain('Type the replacement objective below.')
    expect(edit.lines.join('\n')).not.toContain('Edit goal: type replacement')

    const clear = view(surface('confirm-clear', 'Confirm clear'))
    expect(clear.lines.join('\n')).toContain('This writes the official tombstone')
    expect(clear.lines.join('\n')).not.toContain('Clear goal: Enter confirm')
  })

  it('renders official Jobs as Activity cards and a distinct responsive control dock', () => {
    const jobs: SessionJobsSnapshot = {
      available: true,
      generation: 7,
      jobs: [
        {
          id: 'bash-1', kind: 'bash', label: 'watch tests', status: 'running',
          startedAt: 10, reported: false,
        },
        {
          id: 'subagent-1', kind: 'subagent', label: 'review adapter', status: 'stopping',
          startedAt: 20, reported: true,
        },
        {
          id: 'bash-2', kind: 'bash', label: 'build', status: 'completed',
          detail: 'exit code: 0', startedAt: 30, finishedAt: 40, reported: false,
        },
        {
          id: 'bash-3', kind: 'bash', label: 'cancelled task', status: 'killed',
          startedAt: 50, finishedAt: 60, reported: true,
        },
        {
          id: 'subagent-2', kind: 'subagent', label: 'failed review', status: 'failed',
          detail: 'max-tokens', startedAt: 70, finishedAt: 80, reported: false,
        },
      ],
    }
    const base = {
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState('draft remains'),
    }
    const cards = renderDshFrame({ ...base, jobs }, { columns: 100, rows: 30 })
    const cardText = cards.lines.join('\n')
    expect(cards.lines[0]).toContain('JOBS 2')
    expect(cardText).toContain('2 earlier background jobs')
    expect(cardText).toContain('ACTIVITY · bash-2')
    expect(cardText).toContain('exit code: 0')
    expect(cardText).toContain('ACTIVITY · bash-3')
    expect(cardText).toContain('ACTIVITY · subagent-2')
    expect(cards.conversation?.nodes.flatMap(node => (
      node.kind === 'activity' ? [node.status] : []
    )))
      .toEqual(['done', 'killed', 'failed'])

    const liveCards = renderDshFrame({ ...base, jobs: { ...jobs, jobs: jobs.jobs.slice(0, 2) } }, {
      columns: 100,
      rows: 24,
    })
    expect(liveCards.conversation?.nodes.flatMap(node => (
      node.kind === 'activity' ? [node.status] : []
    )))
      .toEqual(['running', 'stopping'])

    const rows = [...jobs.jobs].reverse().map((job, index) => ({
      ...job,
      selected: index === 0,
    }))
    const activity: JobsActivityView = {
      rows,
      selectedIndex: 0,
      confirmKill: true,
      error: 'job-reference-stale',
      notice: 'registry refreshed',
    }
    const dock = renderDshFrame({ ...base, jobs, jobsActivity: activity }, {
      columns: 100,
      rows: 30,
    })
    const dockText = dock.lines.join('\n')
    expect(dockText).toContain('ACTIVITY · JOBS')
    expect(dockText).toContain('[DSH/official] · 5 jobs · 2 live')
    expect(dockText).toContain('Stop subagent-2? Enter confirm')
    expect(dockText).toContain('Error: job-reference-stale')
    expect(dockText).toContain('Notice: registry refreshed')
    expect(dockText).not.toContain('Activity: Enter confirm stop')
    expect(dock.overlay).toMatchObject({
      kind: 'compact',
      anchor: 'center',
    })
    expect(dock.conversation).toBeUndefined()

    const tinyDock = renderDshFrame({ ...base, jobs, jobsActivity: activity }, {
      columns: 1,
      rows: 5,
    })
    expect(tinyDock.lines).toHaveLength(5)
    for (const line of tinyDock.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(1)

    const tailActivity: JobsActivityView = {
      rows: rows.map((row, index) => ({ ...row, selected: index === 4 })),
      selectedIndex: 4,
      confirmKill: false,
    }
    const tailDock = renderDshFrame({ ...base, jobs, jobsActivity: tailActivity }, {
      columns: 100,
      rows: 30,
    })
    expect(tailDock.lines.join('\n')).toContain('● bash-1 · running')

    const emptyActivity: JobsActivityView = {
      rows: [],
      selectedIndex: -1,
      confirmKill: false,
    }
    const empty = renderDshFrame({
      ...base,
      jobs: { available: true, generation: 8, jobs: [] },
      jobsActivity: emptyActivity,
    }, { columns: 60, rows: 14 })
    expect(empty.lines.join('\n')).toContain('No background jobs for this Session')
    expect(empty.lines.join('\n')).toContain('K stop')
  })

  it('renders Activity as a fixed operation spine with an authority passport', () => {
    const statuses = [
      'running', 'completed', 'failed', 'diagnostic', 'stopping', 'cancelled',
      'killed', 'interrupted', 'idle', 'ready', 'inactive', 'unknown',
    ] as const
    const activityCenter: ActivityCenterView = {
      tab: 'subagents',
      tabs: [
        { id: 'jobs', label: 'Jobs', count: 0, live: 0, selected: false },
        { id: 'subagents', label: 'Subagents', count: statuses.length, live: 1, selected: true },
        { id: 'workflows', label: 'Workflows', count: 0, live: 0, selected: false },
      ],
      rows: statuses.map((status, index) => ({
        key: `row-${index}`,
        title: `Agent ${status}`,
        meta: `id-${index} · continuable`,
        status,
        statusTone: (status === 'unknown' ? 'inactive' : status) as never,
        depth: index,
        selected: index === 0,
        stoppable: index === 0,
        detail: ['Parent root', 'detail'],
      })),
      selectedIndex: 0,
      confirmStop: true,
      loading: true,
      subagentsAvailable: false,
      error: 'catalog failed',
      notice: 'cached tree retained',
    }
    const view = {
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState('preserved'),
      activityCenter,
    }
    const frame = renderDshFrame(view, { columns: 140, rows: 40 })
    const output = frame.lines.join('\n')
    expect(frame.overlay).toMatchObject({
      kind: 'directory', anchor: 'center', width: 118, maxHeight: 32,
    })
    expect(output).toContain('▌ Activity')
    expect(output).toContain('SUBAGENTS 12 · 1 LIVE')
    expect(output).toContain('Operations')
    expect(output).toContain('Selected operation')
    expect(output).toContain('Authority  SubagentRuntime')
    expect(output).toContain('Control  Interrupt available')
    expect(output).toContain('Refreshing Subagent catalog')
    expect(output).toContain('Subagent service is not mounted')
    expect(output).toContain('Error: catalog failed')
    expect(output).toContain('Notice: cached tree retained')
    expect(output).toContain('Stop Agent running?')
    expect(output).not.toContain('DETAIL')
    for (const status of statuses) expect(output).toContain(`Agent ${status}`)
    expect(frame.lineStyles?.every(style => style?.background === 'black' && style.fill === true))
      .toBe(true)
    expect(frame.lineStyles).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: 'success' }),
      expect.objectContaining({ tone: 'error' }),
      expect.objectContaining({ tone: 'warning' }),
      expect.objectContaining({ tone: 'primary' }),
      expect.objectContaining({ tone: 'muted', dim: true }),
    ]))

    for (const rows of [1, 2, 3, 4]) {
      const tiny = renderDshFrame(view, { columns: 40, rows })
      expect(tiny.lines).toHaveLength(rows)
      expect(tiny.overlay?.kind).toBe('directory')
    }

    const emptyBase = { ...activityCenter, rows: [], selectedIndex: -1, confirmStop: false }
    const emptySubagents = renderDshFrame({
      ...view,
      activityCenter: { ...emptyBase, tab: 'subagents' },
    }, { columns: 80, rows: 20 }).lines.join('\n')
    const emptyWorkflows = renderDshFrame({
      ...view,
      activityCenter: { ...emptyBase, tab: 'workflows' },
    }, { columns: 80, rows: 20 }).lines.join('\n')
    expect(emptySubagents).toContain('No durable Subagent descendants.')
    expect(emptyWorkflows).toContain('No top-level Workflow runs in this Session.')

    const workflow = renderDshFrame({
      ...view,
      activityCenter: {
        ...emptyBase,
        tab: 'workflows' as const,
        rows: [{
          key: 'workflow:1',
          title: 'Release train',
          meta: 'workflow-1 · 3 agents',
          status: 'running',
          statusTone: 'running',
          depth: 0,
          selected: true,
          stoppable: false,
          detail: ['Build · 1/2 complete · 1 running'],
        }],
        selectedIndex: 0,
      },
    }, { columns: 100, rows: 24 }).lines.join('\n')
    expect(workflow).toContain('Authority  Session events')
    expect(workflow).toContain('Control  Read-only from parent Session')
  })

  it('bounds legacy Activity rows and remains valid in a one-row terminal', () => {
    const rows: JobsActivityView['rows'] = Array.from({ length: 30 }, (_, index) => ({
      id: `job-${index}`,
      kind: 'bash',
      label: `Job ${index}`,
      status: 'running',
      startedAt: index,
      reported: false,
      selected: index === 15,
    }))
    const jobsActivity: JobsActivityView = {
      rows,
      selectedIndex: 15,
      confirmKill: false,
    }
    const base = {
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      jobsActivity,
    }
    expect(renderDshFrame(base, { columns: 80, rows: 20 }).lines.join('\n'))
      .toContain('other jobs')
    const one = renderDshFrame(base, { columns: 80, rows: 1 })
    expect(one.lines).toHaveLength(1)
    expect(one.lines.join('\n')).not.toContain('Enter confirm')

    const short = renderDshFrame({
      ...base,
      jobsActivity: { ...jobsActivity, rows: rows.slice(0, 1), selectedIndex: 0 },
    }, { columns: 80, rows: 20 })
    expect(short.lines.join('\n')).not.toContain('other jobs')
  })

  it('keeps bounded timeline cards in the retained frame and interaction focus in a modal', () => {
    const conversation = renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState('next step'),
    }, { columns: 80, rows: 34 })
    const frame = renderDshFrame({
      ui: visualState(),
      interaction: approval(),
      prompt: createPromptEditorState('next step'),
      input: {
        kind: 'approval',
        interactionId: 'approval-1',
        editor: createPromptEditorState('y'),
      },
    }, { columns: 80, rows: 34 })

    const output = conversation.lines.join('\n')
    const you = conversation.lines.findIndex(line => line.includes('╭─ YOU'))
    const dsh = conversation.lines.findIndex(line => line.includes('╭─ DSH'))
    const tool = conversation.lines.findIndex(line => line.includes('╭─ TOOL'))
    const command = conversation.lines.findIndex(line => line.includes('╭─ CMD'))
    const focus = frame.lines.findIndex(line => line.includes('▌ Permission request'))

    expect(conversation.lines[0]).toContain('DSH-TUI')
    expect(conversation.lines[0]).toContain('session-a')
    expect(you).toBeGreaterThan(0)
    expect(dsh).toBeGreaterThan(you)
    expect(tool).toBeGreaterThan(dsh)
    expect(command).toBeGreaterThan(tool)
    expect(focus).toBe(0)
    expect(output).toContain('TOOL  read  ✓ DONE')
    expect(output).toContain('Arguments: {"path":"README.md"}')
    expect(output).toContain('Result: opened')
    expect(frame.lines.join('\n')).toContain('ALLOW ONCE')
    expect(frame.lines.join('\n')).not.toContain('next step')
    expect(frame.overlay).toMatchObject({ kind: 'compact', anchor: 'center' })
    expect(`${output}\n${frame.lines.join('\n')}`).not.toContain('\u001b')
    expect(`${output}\n${frame.lines.join('\n')}`).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    for (const line of conversation.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
    for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)

    const narrow = renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
    }, { columns: 24, rows: 40 }).lines.join('\n')
    expect(narrow).toContain('╭─ YOU')
    expect(narrow).toContain('╭─ DSH')
    expect(narrow).toContain('╭─ TOOL')
    expect(narrow).toContain('╭─ CMD')
  })

  it('renders the Agent tool catalog as a fixed two-pane capability lens', () => {
    const rows: ToolBrowserView['rows'] = [
      {
        name: 'read_file',
        description: 'Read a file from disk',
        group: 'core',
        parameterNames: ['path'],
        requiredParameterNames: ['path'],
      },
      {
        name: 'mcp__github__create_issue',
        description: 'Create an issue without claiming MCP connection state',
        group: 'mcp',
        parameterNames: ['owner', 'title'],
        requiredParameterNames: ['owner'],
      },
      {
        name: 'run_code',
        description: 'Code-mode transport',
        group: 'transport',
        parameterNames: [],
        requiredParameterNames: [],
      },
    ]
    const base: ToolBrowserView = {
      query: createPromptEditorState(),
      rows,
      selectedIndex: 0,
      selected: rows[0]!,
      groups: [
        { id: 'core', label: 'Core', count: 1 },
        { id: 'mcp', label: 'MCP', count: 1 },
        { id: 'transport', label: 'Code transport', count: 1 },
      ],
      totalCount: 3,
      available: true,
      stale: false,
      generation: 1,
    }
    const view = (toolBrowser: ToolBrowserView, columns = 140, height = 40) => renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolBrowser,
    }, { columns, rows: height })

    const core = view(base)
    const mcp = view({ ...base, selectedIndex: 1, selected: rows[1]! })
    const transport = view({ ...base, selectedIndex: 2, selected: rows[2]! })
    expect(core.overlay).toMatchObject({ kind: 'directory', anchor: 'center' })
    expect(core.lines).toHaveLength(core.overlay!.maxHeight)
    expect(core.lines.join('\n')).toContain('▌ Tools')
    expect(core.lines.join('\n')).toContain('Search ›')
    expect(core.lines.join('\n')).toContain('Capabilities')
    expect(core.lines.join('\n')).toContain('3/3 · exact Agent · gen 1')
    expect(core.lines.join('\n')).toContain('› read_file')
    expect(core.lines.join('\n')).toContain('Selected  read_file')
    expect(core.lines.join('\n')).toContain('Inputs  1 required · 1 total')
    expect(core.lines.join('\n')).toContain('Params  path*')
    expect(core.lines.join('\n')).not.toContain('TOOLS · AGENT CAPABILITIES')
    expect(core.lines.join('\n')).not.toContain('GROUPS')
    expect(core.lineStyles?.every(style => style?.background === 'black')).toBe(true)
    expect(core.cursor).toMatchObject({ row: 1 })
    expect(mcp.lines.join('\n')).toContain('Kind  MCP')
    expect(transport.lines.join('\n')).toContain('Kind  Code transport')
    expect(transport.lines.join('\n')).toContain('Params  none')
    expect(core.lineStyles).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: 'accent', inverse: true }),
      expect.objectContaining({ tone: 'interaction' }),
      expect.objectContaining({ tone: 'muted' }),
    ]))

    const failed = view({
      ...base,
      stale: true,
      error: 'registry failed',
    })
    const coldFailure = view({
      ...base,
      stale: false,
      error: 'first observation failed',
    })
    const noMatchesView: ToolBrowserView = {
      query: createPromptEditorState('missing'),
      rows: [],
      selectedIndex: -1,
      groups: base.groups.map(group => ({ ...group, count: 0 })),
      totalCount: base.totalCount,
      available: true,
      stale: false,
      generation: base.generation,
    }
    const noMatches = view(noMatchesView)
    const unavailable = view({
      ...noMatchesView,
      available: false,
    })
    expect(failed.lines.join('\n')).toContain('Showing last good catalog')
    expect(failed.lineStyles).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: 'warning' }),
      expect.objectContaining({ tone: 'error' }),
    ]))
    expect(coldFailure.lines.join('\n')).toContain('first observation failed')
    expect(noMatches.lines.join('\n')).toContain('No matching capabilities')
    expect(unavailable.lines.join('\n')).toContain('Capability registry unavailable')

    for (const height of [1, 2, 3, 4]) {
      const tiny = view(base, 40, height)
      expect(tiny.lines).toHaveLength(height)
      expect(tiny.overlay?.kind).toBe('directory')
      expect(tiny.cursor === undefined).toBe(height < 3)
      for (const line of tiny.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    }
  })

  it('keeps the interaction modal bounded in one-, two-, and three-row terminals', () => {
    const view = {
      ui: visualState(),
      interaction: approval(),
      prompt: createPromptEditorState('draft'),
    }

    const one = renderDshFrame(view, { columns: 1, rows: 1 })
    const two = renderDshFrame(view, { columns: 4, rows: 2 })
    const three = renderDshFrame(view, { columns: 32, rows: 3 })

    expect(one.lines).toHaveLength(1)
    expect(one.cursor).toBeUndefined()
    expect(two.lines).toHaveLength(2)
    expect(two.cursor).toBeUndefined()
    expect(three.lines).toHaveLength(3)
    expect(three.lines[0]).toContain('▌ Permission request')
    expect(three.lines[1]).toContain('REJECT')
    expect(three.lines[1]).toContain('ALLOW ONCE')
    expect(three.lines.join('\n')).not.toContain('draft')
    expect(three.lines.join('\n')).not.toContain('Ctrl+C')
    expect(three.cursor).toBeUndefined()
    for (const frame of [one, two, three]) {
      for (const line of frame.lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(frame.viewport.columns)
      }
    }

    for (const columns of [1, 2, 4, 8, 10, 12, 13, 24, 39, 40, 64, 80]) {
      for (const rows of [1, 2, 3, 4, 7, 8, 14]) {
        const frame = renderDshFrame(view, { columns, rows })
        expect(frame.lines.length).toBeGreaterThan(0)
        expect(frame.lines.length).toBeLessThanOrEqual(rows)
        for (const line of frame.lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
        }
      }
    }
  })

  it('turns an empty session into a guided Cordis workbench home', () => {
    const emptyWorkbench: SessionWorkbenchSnapshot = {
      available: true,
      goal: null,
      plan: { active: false, pending: false },
      todos: null,
    }
    const view = {
      ui: selectSession(createUiState(), 'empty-session'),
      interaction: undefined,
      prompt: createPromptEditorState(),
      workbench: emptyWorkbench,
    }
    const full = renderDshFrame(view, { columns: 80, rows: 18 })
    const medium = renderDshFrame(view, { columns: 50, rows: 10 })
    const narrow = renderDshFrame(view, { columns: 39, rows: 18 })
    const short = renderDshFrame(view, { columns: 80, rows: 7 })
    const tiny = renderDshFrame(view, { columns: 20, rows: 10 })
    const activeWorkbench: SessionWorkbenchSnapshot = {
      available: true,
      goal: {
        id: 'active-home',
        revision: 1,
        objective: 'Advance the active workbench',
        phase: 'active',
        maxGoalRounds: 8,
        roundsStarted: 1,
        createdAt: 10,
        updatedAt: 20,
      },
      plan: { active: true, pending: false },
      todos: [{ content: 'Send the first prompt', status: 'in_progress' }],
    }
    const active = renderDshFrame({
      ...view,
      workbench: activeWorkbench,
    }, { columns: 80, rows: 18 })
    const activeMedium = renderDshFrame({ ...view, workbench: activeWorkbench }, {
      columns: 39,
      rows: 18,
    })
    const activeTiny = renderDshFrame({ ...view, workbench: activeWorkbench }, {
      columns: 20,
      rows: 10,
    })

    expect(full.lines.join('\n')).toContain('CORDIS')
    expect(full.lines.join('\n')).toContain('QUICK START')
    expect(full.lines.join('\n')).toContain('/mode  Agent mode')
    expect(full.lines.join('\n')).not.toContain('Harness workbench ready')
    expect(full.lines.join('\n')).not.toContain('<__')
    expect(medium.lines.join('\n')).toContain('CORDIS')
    expect(medium.lines.join('\n')).not.toContain('<__')
    expect(narrow.lines.join('\n')).toContain('/mode')
    expect(short.lines.join('\n')).toContain('/mode')
    expect(tiny.lines.join('\n')).not.toContain('/goal')
    expect(active.lines.join('\n')).toContain('WORKBENCH DASHBOARD')
    expect(active.lines.join('\n')).toContain('Timeline ready')
    expect(active.lines.join('\n')).not.toContain('Harness workbench ready')
    expect(activeMedium.lines.join('\n')).toContain('Timeline ready · send a prompt')
    expect(activeTiny.lines.join('\n')).toContain('Ready')
    expect(cordisBrandLines({ columns: 80, rows: 18 }).join('\n')).toContain('<__')
    for (const frame of [full, medium, narrow, short, tiny, active, activeMedium, activeTiny]) {
      expect(frame.lines).toHaveLength(frame.viewport.rows)
      for (const line of frame.lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(frame.viewport.columns)
      }
    }
  })
})
