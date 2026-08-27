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
    expect(buildWorkbenchDashboard({
      available: true,
      goal: null,
      plan: { active: false, pending: false },
      todos: null,
    }, 80, 24)?.lines[0]?.text).toContain('GOAL none')
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
    const menuFrame = renderDshFrame({
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
    expect(menuFrame.lines.join('\n')).toContain('╭─ FOCUS')
    expect(menuFrame.lines.join('\n')).toContain('No commands match /missing')

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
    expect(compactFocus.lines.join('\n')).toContain('╭─ YOU')
    expect(compactFocus.lines.join('\n')).toContain('FOCUS ·')
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

    expect(output).toContain('PLAN REVIEW')
    expect(output).toContain('Decision: Approve this plan?')
    expect(output).toContain('[Discuss]')
    expect(output).toContain('› [Keep planning]')
    expect(output).toContain('[Approve]')
    expect(output).toContain('2 more plan lines in the tool card')
    expect(frame.lines.find(line => line.includes('review> Keep planning'))).toBeDefined()
    expect(frame.lines.at(-1)).toContain('Plan review: Left/Right choose')

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
    expect(queued).toContain('QUEUED PLAN REVIEW')
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
    expect(menu.lines.at(-1)).toContain('Goal actions: Up/Down select')
    expect(menu.lines.join('\n')).toContain('WORKBENCH DASHBOARD')
    expect(menu.lines.join('\n')).toContain('GOAL PAUSED')

    const edit = view(surface('edit', 'New objective'))
    expect(edit.lines.join('\n')).toContain('Current: Ship first-party Goal actions')
    expect(edit.lines.join('\n')).toContain('Type the replacement objective below.')
    expect(edit.lines.at(-1)).toContain('Edit goal: type replacement')

    const clear = view(surface('confirm-clear', 'Confirm clear'))
    expect(clear.lines.join('\n')).toContain('This writes the official tombstone')
    expect(clear.lines.at(-1)).toContain('Clear goal: Enter confirm')
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
    expect(dockText).toContain('BACKGROUND ACTIVITY')
    expect(dockText).toContain('[DSH/official] · 5 jobs · 2 live')
    expect(dockText).toContain('Stop subagent-2? Enter confirm')
    expect(dockText).toContain('Error: job-reference-stale')
    expect(dockText).toContain('Notice: registry refreshed')
    expect(dock.lines.at(-1)).toContain('Activity: Enter confirm stop')
    expect(dock.conversation).toMatchObject({
      dock: { role: 'activity' },
      composerLabel: 'PROMPT · ACTIVITY OPEN',
    })

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
    expect(empty.lines.at(-1)).toContain('K stop')
  })

  it('orders header, bounded timeline cards, focused interaction, composer, and footer', () => {
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

    const output = frame.lines.join('\n')
    const you = frame.lines.findIndex(line => line.includes('╭─ YOU'))
    const dsh = frame.lines.findIndex(line => line.includes('╭─ DSH'))
    const tool = frame.lines.findIndex(line => line.includes('╭─ TOOL'))
    const command = frame.lines.findIndex(line => line.includes('╭─ CMD'))
    const focus = frame.lines.findIndex(line => line.includes('╭─ FOCUS'))

    expect(frame.lines[0]).toContain('DSH-TUI')
    expect(frame.lines[0]).toContain('session-a')
    expect(you).toBeGreaterThan(0)
    expect(dsh).toBeGreaterThan(you)
    expect(tool).toBeGreaterThan(dsh)
    expect(command).toBeGreaterThan(tool)
    expect(focus).toBeGreaterThan(command)
    expect(output).toContain('TOOL  read  ✓ DONE')
    expect(output).toContain('Arguments: {"path":"README.md"}')
    expect(output).toContain('Result: opened')
    expect(frame.lines.find(line => line.includes('allow? y'))).toBeDefined()
    expect(frame.lines.at(-1)).toContain('Approval:')
    expect(frame.cursor).toEqual({ row: 31, column: 10 })
    expect(output).not.toContain('\u001b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
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

  it('keeps header, composer, and footer stable in one-, two-, and three-row terminals', () => {
    const view = {
      ui: visualState(),
      interaction: approval(),
      prompt: createPromptEditorState('draft'),
    }

    const one = renderDshFrame(view, { columns: 1, rows: 1 })
    const two = renderDshFrame(view, { columns: 4, rows: 2 })
    const three = renderDshFrame(view, { columns: 24, rows: 3 })

    expect(one.lines).toHaveLength(1)
    expect(one.cursor).toBeUndefined()
    expect(two.lines).toHaveLength(2)
    expect(two.cursor?.row).toBe(1)
    expect(three.lines).toHaveLength(3)
    expect(three.lines[0]).toContain('DSH-TUI')
    expect(three.lines[1]).toContain('> draft')
    expect(three.lines[2]).toContain('Ctrl+C')
    expect(three.cursor?.row).toBe(1)
    for (const frame of [one, two, three]) {
      for (const line of frame.lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(frame.viewport.columns)
      }
    }

    for (const columns of [1, 2, 4, 8, 10, 12, 13, 24, 39, 40, 64, 80]) {
      for (const rows of [1, 2, 3, 4, 7, 8, 14]) {
        const frame = renderDshFrame(view, { columns, rows })
        expect(frame.lines).toHaveLength(rows)
        for (const line of frame.lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
        }
      }
    }
  })

  it('turns an empty session into a guided Cordis workbench home', () => {
    const view = {
      ui: selectSession(createUiState(), 'empty-session'),
      interaction: undefined,
      prompt: createPromptEditorState(),
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
    expect(full.lines.join('\n')).toContain('Harness workbench ready')
    expect(full.lines.join('\n')).toContain('/goal <objective>')
    expect(full.lines.join('\n')).not.toContain('<__')
    expect(medium.lines.join('\n')).toContain('CORDIS')
    expect(medium.lines.join('\n')).not.toContain('<__')
    expect(narrow.lines.join('\n')).toContain('/goal')
    expect(short.lines.join('\n')).toContain('/goal')
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
