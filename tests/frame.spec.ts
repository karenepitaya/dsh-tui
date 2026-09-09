import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { cordisBrandLines } from '../src/ui/brand.ts'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import {
  conversationAttachmentRail,
  type ConversationMarkdownNode,
} from '../src/ui/conversation.ts'
import {
  buildWorkbenchDashboard,
  buildStatusLine,
  cacheHitPercent,
  DshTuiFrameProjectionCache,
  renderDshFrame,
} from '../src/ui/frame.ts'
import {
  createUiState,
  type SessionCompactionState,
  type TranscriptRow,
  type UiState,
} from '../src/transcript/state.ts'
import { reduceUiEvent, selectSession } from '../src/transcript/reducer.ts'
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
import type { SessionLlmAttemptState } from '../src/llm/attempts.ts'
import { durable } from './fixtures.ts'
import { DEFAULT_DSH_TUI_PREFERENCES } from '../src/preferences/contracts.ts'
import type { SettingsPageView } from '../src/settings/page-contracts.ts'

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
  it.each([undefined, 'arrows', 'vim'] as const)('keeps a complete Settings fallback for direct frame consumers with %s navigation preferences', navigationKeys => {
    const page: SettingsPageView = { section: 'general', focus: 'form', navigationKeys: 'arrows',
      fields: [{ id: 'motion', namespace: 'dsh-tui', path: ['reducedMotion'], section: 'general', group: '交互',
        label: '减少动画', description: '关闭界面中的动画效果。', control: 'boolean', value: true, overridden: false, applies: 'live' }],
      selection: 0, actionIndex: 0, query: createPromptEditorState(), dirtyIds: ['motion'], dirtyCount: 1,
      confirmIndex: 0, pending: false, writable: true, available: true, documentBacked: true }
    const frame = renderDshFrame({ ui: visualState(), interaction: undefined, prompt: createPromptEditorState(),
      ...(navigationKeys === undefined ? {} : { preferences: { ...DEFAULT_DSH_TUI_PREFERENCES, navigationKeys } }),
      runtimeLibrary: { page, tab: 'settings', focus: 'catalog', query: createPromptEditorState(), searchFocused: false,
        detailScrollOffset: undefined, pending: false,
        settings: { available: true, writable: true, documentBacked: true, generation: 1, stale: false, rows: [], totalCount: 0 },
        plugins: { available: false, rows: [], totalCount: 0, activeCount: 0, failedCount: 0 } },
    }, { columns: 100.9, rows: 28.9 })
    expect(frame.title).toBe('设置')
    expect(frame.viewport).toEqual({ columns: 100, rows: 28 })
    expect(frame.settingsWorkspace).toMatchObject({ title: '外观与交互', focus: 'content', selectedFieldId: 'motion', dirtyCount: 1 })
    const navigation = navigationKeys === 'arrows' ? '↑↓ 移动' : navigationKeys === 'vim' ? 'j/k 移动' : '↑↓/jk 移动'
    expect(frame.settingsWorkspace?.help).toContain(navigation)
    const output = frame.lines.join('\n')
    for (const expected of ['减少动画', '开启', '关闭界面中的动画效果。', '未保存', '保存', navigation]) expect(output).toContain(expected)
    expect(frame.lines).toHaveLength(28)
    expect(frame.lines.every(line => visibleWidth(line) <= 100)).toBe(true)
    expect(output).not.toContain('inspect the workspace')
    expect(output).not.toContain('\x1b')
  })

  it('bounds prefix-free transcript output in one- and two-column terminals', () => {
    const selected = visualState()
    const current = selected.sessions['session-a']!
    const ui: UiState = { ...selected, sessions: { ...selected.sessions, 'session-a': {
      ...current,
      rows: [...current.rows, {
        kind: 'assistant', key: 'event:9', seq: 9, turn: 1, step: 2,
        message: { ...message('answer', 'assistant', 'ok'), content: [
          { type: 'reasoning', text: 'raw reasoning must remain hidden' },
          { type: 'text', text: 'ok' },
        ] }, interrupted: true,
      }],
    } } }
    for (const columns of [1, 2]) {
      for (const transcriptViewMode of ['compact', 'verbose'] as const) {
        const frame = renderDshFrame({
          ui, transcriptViewMode, reasoningExpanded: true,
          interaction: undefined, prompt: createPromptEditorState(),
        }, { columns, rows: 120 })
        for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
        expect(frame.lines.join('')).not.toContain('raw reasoning')
      }
    }
  })
  it('hands the live request tail to the first visible response character', () => {
    let ui = selectSession(createUiState(), 'session-a')
    const apply = (seq: number, event: Parameters<typeof durable>[1]) => {
      ui = reduceUiEvent(ui, durable(seq, event))
    }
    apply(0, { type: 'turn/start', data: { turn: 1 } })
    apply(1, { type: 'step/start', data: { turn: 1, step: 1 } })
    const surface = () => renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState('next draft'),
      agentRequest: { phase: 'responding', description: 'Writing response', turn: 1 },
    }, { columns: 80, rows: 20 }).conversation!
    expect(surface().agentRequest).toBeDefined()
    apply(2, {
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '好' } },
    })
    expect(surface().agentRequest).toBeUndefined()
    expect(surface().nodes).toContainEqual(expect.objectContaining({
      kind: 'assistant-draft', text: '好',
    }))
    expect(surface().composer).toBe('next draft')
    apply(3, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'read', name: 'Read', arguments: '{}' },
    })
    // Once a draft is known to precede tool execution it becomes process detail.
    expect(surface().nodes.some(node => 'text' in node && node.text === '好')).toBe(false)
    expect(surface().agentRequest).toBeDefined()
  })

  it('defers the duplicate flat transcript until a retained driver requests it', () => {
    const deferred = renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
    }, { columns: 80, rows: 18 }, { deferFlatFallback: true })

    expect(deferred.conversation?.nodes.some(node => (
      node.kind === 'user' && node.text === 'inspect the workspace'
    ))).toBe(true)
    expect(deferred.lines.join('\n')).not.toContain('inspect the workspace')
    expect(deferred.flatFallback).toBeTypeOf('function')

    const flat = deferred.flatFallback!()
    expect(flat.flatFallback).toBeUndefined()
    expect(flat.lines.join('\n')).toContain('inspect the workspace')
  })

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
    expect(empty).toBeUndefined()
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

  it('temporarily gives an active provider recovery path priority in the fixed status row', () => {
    const backoff: SessionLlmAttemptState = {
      activeRetryId: 'retry-a',
      chains: [{
        retryId: 'retry-a',
        turn: 3,
        step: 1,
        phase: 'backoff',
        provider: 'deepseek-official',
        mode: 'normal',
        policyKey: 'normal',
        maxRetries: 5,
        attempts: [{
          retry: 1,
          scheduledSeq: 12,
          scheduledAt: 1_000,
          delayMs: 750,
          failure: { message: 'provider busy', code: 'RATE_LIMIT', status: 429 },
        }],
      }],
    }
    const model = {
      current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      routable: true,
      writable: true,
      loading: false,
      selecting: false,
      groups: [],
      failures: [],
    } as const
    const context = {
      available: true,
      pressure: { projectedTokens: 32_000, contextWindow: 128_000 },
    } as const

    const waiting = buildStatusLine(model, context, undefined, 120, backoff)
    expect(waiting?.tone).toBe('warning')
    expect(waiting?.text).toContain('RETRY 2/6')
    expect(waiting?.text).toContain('deepseek-official')
    expect(waiting?.text).toContain('WAIT 750ms')
    expect(waiting?.text).toContain('RATE_LIMIT')
    expect(waiting?.segments?.[0]?.tone).toBe('warning')
    expect(buildStatusLine(model, context, undefined, 0, backoff)?.text).toBe('◆')

    const requesting: SessionLlmAttemptState = {
      ...backoff,
      chains: [{
        ...backoff.chains[0]!,
        phase: 'requesting',
        attempts: [{ ...backoff.chains[0]!.attempts[0]!, startedSeq: 13, startedAt: 1_750 }],
      }],
    }
    const active = buildStatusLine(model, context, undefined, 42, requesting)
    expect(active?.tone).toBe('accent')
    expect(active?.text).toContain('ATTEMPT 2/6')
    expect(active?.text).toContain('LIVE')
    expect(visibleWidth(active?.text ?? '')).toBeLessThanOrEqual(42)

    const unbounded: SessionLlmAttemptState = {
      activeRetryId: 'retry-always',
      chains: [{
        ...backoff.chains[0]!,
        retryId: 'retry-always',
        mode: 'always',
        attempts: [{ ...backoff.chains[0]!.attempts[0]!, delayMs: 1_500 }],
      }],
    }
    expect(buildStatusLine(model, context, undefined, 120, unbounded)?.text)
      .toContain('RETRY 2/∞ · deepseek-official · WAIT 1.5s')

    const { maxRetries: _omittedBudget, ...withoutBudget } = backoff.chains[0]!
    const missingBudget: SessionLlmAttemptState = {
      activeRetryId: 'retry-defensive',
      chains: [{
        ...withoutBudget,
        retryId: 'retry-defensive',
        attempts: [{ ...backoff.chains[0]!.attempts[0]!, delayMs: 12_000 }],
      }],
    }
    expect(buildStatusLine(model, context, undefined, 120, missingBudget)?.text)
      .toContain('RETRY 2/1 · deepseek-official · WAIT 12s')

    expect(buildStatusLine(model, context, undefined, 120, {
      activeRetryId: 'retry-empty',
      chains: [{ ...backoff.chains[0]!, retryId: 'retry-empty', attempts: [] }],
    })?.text).not.toContain('RETRY')

    expect(buildStatusLine(model, context, undefined, 120, {
      chains: [{ ...backoff.chains[0]!, phase: 'recovered', finalSeq: 14 }],
    })?.text).not.toContain('RETRY')
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

  it('keeps an ordinary one-line prompt in the consistent composer above the live statusline', () => {
    const frame = renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState('next'),
      context: {
        available: true,
        pressure: { projectedTokens: 1_000, contextWindow: 10_000 },
      },
    }, { columns: 100, rows: 24 })
    const statusline = frame.lines.findIndex(line => line.includes('CTX ['))
    expect(frame.conversation).toMatchObject({ composerLabel: '', composerBoxed: true })
    expect(frame.lines.join('\n')).not.toContain('PROMPT')
    expect(frame.cursor?.row).toBeGreaterThan(0)
    expect(statusline).toBeGreaterThan(frame.cursor!.row)
  })

  it('places the staged-image rail above the composer without moving the statusline', () => {
    const attachments = [{
      name: 'panel\u001b[2J.png',
      mediaType: 'image/png' as const,
      bytes: 4,
    }, {
      name: 'diagram.jpg',
      mediaType: 'image/jpeg' as const,
      bytes: 2_048,
    }, {
      name: 'large.webp',
      mediaType: 'image/webp' as const,
      bytes: 2_097_152,
    }]
    expect(conversationAttachmentRail([])).toBe('')
    expect(conversationAttachmentRail(attachments)).toBe(
      '◆ IMAGES 3  [1] panel.png · 4 B   [2] diagram.jpg · 2 KB   [3] large.webp · 2.0 MB',
    )
    const frame = renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState('next'),
      attachments,
      context: {
        available: true,
        pressure: { projectedTokens: 1_000, contextWindow: 10_000 },
      },
    }, { columns: 120, rows: 24 })
    const rail = frame.lines.findIndex(line => line.includes('IMAGES 3'))
    const statusline = frame.lines.findIndex(line => line.includes('CTX ['))
    expect(frame.conversation).toMatchObject({ composerLabel: '', composerBoxed: true })
    expect(frame.lines.join('\n')).not.toContain('PROMPT')
    expect(rail).toBeGreaterThan(0)
    expect(rail).toBeLessThan(frame.cursor!.row)
    expect(statusline).toBeGreaterThan(frame.cursor!.row)
    expect(frame.lines.join('\n')).not.toContain('\u001b[2J')

    const short = renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
      attachments,
    }, { columns: 80, rows: 5 })
    expect(short.lines).toHaveLength(5)
    expect(short.lines.join('\n')).not.toContain('IMAGES 3')
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

    expect(output).toContain('✓ Completed 1 execution step · Ctrl+O for details')
    expect(output).not.toContain('README.md  1–1 / 12 lines')
    expect(output).not.toContain('Lines: 1-1 of 12 · md')
    expect(output).not.toContain('1 │ # DSH-TUI')
    expect(output).not.toContain('Arguments: {"path":"README.md"}')
    const toolNode = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards,
      transcriptViewMode: 'verbose',
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
    const projectionCache = new DshTuiFrameProjectionCache()
    let customRenderCount = 0
    customCards.register({ phase: 'result', card: 'read' }, () => {
      customRenderCount += 1
      return ['Custom read title', 'Custom body']
    })
    renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards: customCards,
      projectionCache,
    }, { columns: 80, rows: 24 })
    expect(customRenderCount).toBe(0)
    const customNode = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards: customCards,
      projectionCache,
      transcriptViewMode: 'verbose',
    }, { columns: 80, rows: 24 }).conversation?.nodes.find(node => node.kind === 'tool')
    expect(customRenderCount).toBeGreaterThan(0)
    expect(customNode).toMatchObject({ kind: 'tool', label: 'TOOL  Custom read title' })
    const cachedRenderCount = customRenderCount
    renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards: customCards,
      projectionCache,
      transcriptViewMode: 'verbose',
    }, { columns: 80, rows: 24 })
    expect(customRenderCount).toBe(cachedRenderCount)
  })

  it('preserves verbose in-flight Tool states and interrupted assistant output', () => {
    const selected = selectSession(createUiState(), 'session-a')
    const session = selected.sessions['session-a']!
    const rows: readonly TranscriptRow[] = [
      {
        kind: 'tool',
        key: 'tool:1:1:pending',
        turn: 1,
        step: 1,
        callId: 'pending',
        name: 'Read',
        callSeq: 1,
        callPresentation: {
          phase: 'call',
          card: 'generic',
          title: 'Inspect pending file',
        },
      },
      {
        kind: 'tool',
        key: 'tool:1:2:failed',
        turn: 1,
        step: 2,
        callId: 'failed',
        name: 'Write',
        callSeq: 2,
        error: { name: 'WriteError', code: 'WRITE_FAILED' },
        callPresentation: {
          phase: 'call',
          card: 'generic',
          title: 'Write generated file',
        },
      },
      {
        kind: 'assistant-draft',
        key: 'draft:1:3',
        firstSeq: 3,
        lastSeq: 4,
        turn: 1,
        step: 3,
        text: 'Streaming answer',
        reasoning: '',
        chunkCount: 2,
      },
      {
        kind: 'assistant',
        key: 'event:5',
        seq: 5,
        turn: 1,
        step: 4,
        message: message('interrupted', 'assistant', ''),
        interrupted: true,
      },
    ]
    const ui: UiState = {
      ...selected,
      sessions: {
        ...selected.sessions,
        'session-a': { ...session, rows },
      },
    }
    const toolCards = new ToolCardRendererRegistry()
    installBuiltinToolCardRenderers({ effect(setup) { return setup() } }, toolCards)
    const frame = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      transcriptViewMode: 'verbose',
      toolCards,
    }, { columns: 80, rows: 30 })
    const tools = frame.conversation!.nodes.filter(node => node.kind === 'tool')
    const draft = frame.conversation!.nodes.find(node => (
      node.kind === 'assistant-draft' && node.text === 'Streaming answer'
    ))
    const interrupted = frame.conversation!.nodes.find(node => (
      node.kind === 'assistant-draft' && node.interrupted === true
    ))

    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'tool:1:1:pending',
        status: 'running',
        label: expect.stringContaining('Inspect pending file'),
        revision: '1:0:running:0',
      }),
      expect.objectContaining({
        key: 'tool:1:2:failed',
        status: 'failed',
        label: expect.stringContaining('Write generated file'),
        revision: '2:0:failed:0',
      }),
    ]))
    expect(draft?.revision).toMatch(/^4:/u)
    expect(interrupted).toMatchObject({ interrupted: true, text: '' })
    expect(frame.lines.join('\n')).toContain('[interrupted]')

    const narrow = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      transcriptViewMode: 'verbose',
      toolCards,
    }, { columns: 8, rows: 30 })
    expect(narrow.lines).not.toContain('DSH')
    expect(narrow.lines.join('').replace(/[●\s]/gu, '')).toContain('Streaminganswer')
    for (const line of narrow.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(8)
  })

  it('bounds transcript projections with an LRU cache per retained row array', () => {
    const selected = selectSession(createUiState(), 'session-a')
    const session = selected.sessions['session-a']!
    const rows: readonly TranscriptRow[] = [{
      kind: 'tool',
      key: 'tool:1:1:cached',
      turn: 1,
      step: 1,
      callId: 'cached',
      name: 'Read',
      callSeq: 1,
      resultSeq: 2,
      result: message('cached-result', 'user', 'done', 'tool'),
      resultPresentation: {
        phase: 'result',
        card: 'generic',
        title: 'Cached result',
      },
    }]
    const ui: UiState = {
      ...selected,
      sessions: {
        ...selected.sessions,
        'session-a': { ...session, rows },
      },
    }
    const registry = new ToolCardRendererRegistry()
    let renderCount = 0
    registry.register({ phase: 'result', card: 'generic' }, () => {
      renderCount += 1
      return ['Tool Cached result · done', 'cached body']
    })
    const view = {
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      transcriptViewMode: 'verbose' as const,
      toolCards: registry,
      projectionCache: new DshTuiFrameProjectionCache(),
    }

    for (let columns = 80; columns < 89; columns += 1) {
      renderDshFrame(view, { columns, rows: 20 })
    }
    expect(renderCount).toBe(9)

    renderDshFrame(view, { columns: 80, rows: 20 })
    expect(renderCount).toBe(10)

    const deferred = renderDshFrame(
      view,
      { columns: 90, rows: 20 },
      { deferFlatFallback: true },
    )
    expect(deferred.conversation?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', key: 'tool:1:1:cached' }),
    ]))
    expect(renderCount).toBe(11)
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
        result: message('result-1', 'user', 'PRIVATE_RESULT_SENTINEL_A', 'tool'),
      },
      {
        kind: 'assistant', key: 'event:3', seq: 3, turn: 2, step: 2,
        message: message('empty-2', 'assistant', ''), interrupted: false,
      },
      {
        kind: 'tool', key: 'tool:2:2:read-2', turn: 2, step: 2,
        callId: 'read-2', name: 'Read', resultSeq: 4,
        result: message('result-2', 'user', 'PRIVATE_RESULT_SENTINEL_B', 'tool'),
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
      kind: 'assistant-draft',
      activitySummary: '✓ Completed 2 execution steps · Ctrl+O for details',
      text: '',
    })
    expect(JSON.stringify(compact.nodes)).not.toContain('PRIVATE_RESULT_SENTINEL_A')
    expect(JSON.stringify(compact.nodes)).not.toContain('PRIVATE_RESULT_SENTINEL_B')

    const expanded = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      transcriptViewMode: 'verbose',
    }, { columns: 100, rows: 24 }).conversation!
    expect(expanded.nodes.filter(node => node.kind === 'tool')).toHaveLength(2)
    expect(expanded.nodes.some(node => node.kind === 'assistant')).toBe(false)
    expect(expanded.nodes.some(node => node.key === compact.nodes[0]?.key)).toBe(true)

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
    expect(failedRun).toMatchObject({
      kind: 'assistant-draft',
      activitySummary: '× 1 of 8 execution steps failed · Ctrl+O for details',
    })
    const runningRun = grouped(toolRows(2, 'running'))
    expect(runningRun).toMatchObject({
      kind: 'assistant-draft',
      activitySummary: '■ 1 of 2 execution steps unfinished · Ctrl+O for details',
    })

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
    expect(structuredRun).toMatchObject({
      kind: 'assistant-draft',
      activitySummary: '■ 1 of 2 execution steps unfinished · Ctrl+O for details',
    })
    expect(JSON.stringify(structuredRun)).not.toContain('List directory')
    expect(JSON.stringify(structuredRun)).not.toContain('Cwd: D:/repo')
  })

  it('projects one cheap execution summary per turn and expands the full session', () => {
    const selected = selectSession(createUiState(), 'session-a')
    const session = selected.sessions['session-a']!
    const assistant = (
      id: string,
      content: UiMessage['content'],
      turn: number,
      step: number,
      seq: number,
    ): TranscriptRow => ({
      kind: 'assistant',
      key: `event:${seq}`,
      seq,
      turn,
      step,
      message: { id, role: 'assistant', sourceKind: 'model', content },
      interrupted: false,
    })
    const tool = (turn: number, step: number, seq: number): TranscriptRow => ({
      kind: 'tool',
      key: `tool:${turn}:${step}:tool-${seq}`,
      turn,
      step,
      callId: `tool-${seq}`,
      name: 'Read',
      arguments: `{"secret":"argument-${seq}"}`,
      resultSeq: seq,
      result: message(`result-${seq}`, 'user', `raw-result-${seq}`, 'tool'),
      resultPresentation: {
        phase: 'result',
        card: 'generic',
        title: `Detailed tool ${seq}`,
      },
    })
    const rows: readonly TranscriptRow[] = [
      {
        kind: 'user', key: 'event:0', seq: 0,
        message: message('user-0', 'user', 'first request'),
      },
      assistant('process-1', [
        { type: 'reasoning', text: 'private-reasoning-one' },
        { type: 'text', text: 'I will inspect the first file.' },
        { type: 'tool-call', id: 'tool-2', name: 'Read', arguments: '{"path":"one"}' },
      ], 1, 1, 1),
      tool(1, 1, 2),
      assistant('reasoning-only', [
        { type: 'reasoning', text: 'private-reasoning-two' },
      ], 1, 2, 3),
      assistant('process-2', [
        { type: 'text', text: 'I will inspect another file.' },
        { type: 'tool-call', id: 'tool-5', name: 'Read', arguments: '{"path":"two"}' },
      ], 1, 3, 4),
      tool(1, 3, 5),
      assistant('final-1', [{ type: 'text', text: 'First final answer.' }], 1, 4, 6),
      {
        kind: 'user', key: 'event:7', seq: 7,
        message: message('user-7', 'user', 'second request'),
      },
      assistant('process-3', [
        { type: 'text', text: 'I will inspect the last file.' },
        { type: 'tool-call', id: 'tool-9', name: 'Read', arguments: '{"path":"three"}' },
      ], 2, 1, 8),
      tool(2, 1, 9),
      assistant('final-2', [{ type: 'text', text: 'Second final answer.' }], 2, 2, 10),
    ]
    const ui: UiState = {
      ...selected,
      sessions: {
        ...selected.sessions,
        'session-a': { ...session, rows },
      },
    }
    const registry = new ToolCardRendererRegistry()
    let detailedRenderCount = 0
    registry.register({ phase: 'result', card: 'generic' }, context => {
      detailedRenderCount += 1
      return [context.presentation.title ?? 'Tool result', 'Rendered private detail']
    })

    const compact = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards: registry,
      reasoningExpanded: true,
    }, { columns: 100, rows: 40 }).conversation!
    expect(detailedRenderCount).toBe(0)
    expect(compact.nodes.filter(node => node.kind === 'tool')).toHaveLength(0)
    expect(compact.nodes.filter(node => (
      (node.kind === 'assistant' || node.kind === 'assistant-draft')
      && node.activitySummary?.includes('execution step') === true
    )).map(node => node.kind === 'assistant' || node.kind === 'assistant-draft'
      ? node.activitySummary
      : '')).toEqual([
      '✓ Completed 2 execution steps · Ctrl+O for details',
      '✓ Completed 1 execution step · Ctrl+O for details',
    ])
    const compactJson = JSON.stringify(compact.nodes)
    expect(compactJson).toContain('First final answer.')
    expect(compactJson).toContain('Second final answer.')
    expect(compactJson).not.toContain('I will inspect')
    expect(compactJson).not.toContain('private-reasoning')
    expect(compactJson).not.toContain('argument-')
    expect(compactJson).not.toContain('raw-result-')
    expect(compact.nodes.some(node => (
      (node.kind === 'assistant' || node.kind === 'assistant-draft')
      && node.reasoningSummary === 'THOUGHT · AVAILABLE'
      && !('reasoning' in node)
    ))).toBe(true)

    const verbose = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards: registry,
      transcriptViewMode: 'verbose',
    }, { columns: 100, rows: 60 }).conversation!
    expect(detailedRenderCount).toBe(3)
    expect(verbose.nodes.filter(node => node.kind === 'tool')).toHaveLength(3)
    const verboseJson = JSON.stringify(verbose.nodes)
    expect(verboseJson).toContain('I will inspect the first file.')
    expect(verboseJson).toContain('I will inspect the last file.')
    expect(verboseJson).toContain('Rendered private detail')
    expect(verboseJson).not.toContain('private-reasoning-one')
    expect(verboseJson).not.toContain('private-reasoning-two')
    expect(verbose.nodes.filter(node => (
      (node.kind === 'assistant' || node.kind === 'assistant-draft')
      && node.reasoningSummary === 'THOUGHT · AVAILABLE'
    )).length).toBeGreaterThanOrEqual(2)
  })

  it('keeps official Tool presentation details out of compact execution summaries', () => {
    const selected = selectSession(createUiState(), 'session-a')
    const session = selected.sessions['session-a']!
    const result = (id: string) => message(id, 'user', 'ok', 'tool')
    const rows: readonly TranscriptRow[] = [
      {
        kind: 'tool', key: 'tool:4:1:read-1', turn: 4, step: 1,
        callId: 'read-1', name: 'Read', resultSeq: 2, result: result('read-result'),
        resultPresentation: {
          phase: 'result', card: 'read', title: 'Controller',
          path: 'D:/Projects/DSH-Project/dsh-tui/src/app/controller.ts',
          offset: 1,
          lines: [{ number: 1, text: 'import type { Context } from "@deepseek-ai/cordis"' }],
          totalLines: 431,
          lang: 'ts',
        },
      },
      {
        kind: 'tool', key: 'tool:4:2:shell-1', turn: 4, step: 2,
        callId: 'shell-1', name: 'Shell', resultSeq: 3, result: result('shell-result'),
        resultPresentation: {
          phase: 'result', card: 'terminal', title: 'pnpm test', output: '85 passed', exitCode: 0,
        },
      },
      {
        kind: 'tool', key: 'tool:4:3:edit-1', turn: 4, step: 3,
        callId: 'edit-1', name: 'Edit', resultSeq: 4, result: result('edit-result'),
        resultPresentation: {
          phase: 'result', card: 'diff', title: 'Applied patch',
          diffs: [{ path: 'src/app/controller.ts', oldText: 'old', newText: 'new' }],
        },
      },
      {
        kind: 'tool', key: 'tool:4:4:search-1', turn: 4, step: 4,
        callId: 'search-1', name: 'Search', resultSeq: 5, result: result('search-result'),
        resultPresentation: {
          phase: 'result', card: 'search', shape: 'matches', title: 'Controller references',
          files: [{ path: 'src/app/controller.ts', matches: [{ lineNumber: 1, line: 'Context' }] }],
          truncated: false,
          total: 3,
        },
      },
    ]
    const registry = new ToolCardRendererRegistry()
    installBuiltinToolCardRenderers({ effect(setup) { return setup() } }, registry)
    const renderRows = (candidateRows: readonly TranscriptRow[]) => renderDshFrame({
      ui: {
        ...selected,
        sessions: {
          ...selected.sessions,
          'session-a': { ...session, rows: candidateRows },
        },
      },
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards: registry,
    }, { columns: 100, rows: 60 }).conversation!.nodes
    const node = renderRows(rows)[0]

    expect(node).toMatchObject({
      kind: 'assistant-draft',
      activitySummary: '✓ Completed 4 execution steps · Ctrl+O for details',
    })
    expect(JSON.stringify(node)).not.toContain('controller.ts')
    expect(JSON.stringify(node)).not.toContain('pnpm test')

    const matrixRows: readonly TranscriptRow[] = [
      {
        kind: 'tool', key: 'tool:5:1:generic-read', turn: 5, step: 1,
        callId: 'generic-read', name: 'Read',
        callPresentation: {
          phase: 'call', card: 'generic', title: 'Inspect files', kind: 'read',
          locations: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }],
        },
      },
      {
        kind: 'tool', key: 'tool:5:2:generic-other', turn: 5, step: 2,
        callId: 'generic-other', name: 'customTool',
        callPresentation: {
          phase: 'call', card: 'generic', title: 'Custom action', kind: 'other',
        },
      },
      {
        kind: 'tool', key: 'tool:5:3:generic-blank', turn: 5, step: 3,
        callId: 'generic-blank',
        callPresentation: { phase: 'call', card: 'generic', title: '' },
      },
      {
        kind: 'tool', key: 'tool:5:4:terminal-call', turn: 5, step: 4,
        callId: 'terminal-call', name: 'Shell',
        callPresentation: { phase: 'call', card: 'terminal', title: 'Shell', cwd: 'D:/repo' },
      },
      {
        kind: 'tool', key: 'tool:5:5:terminal-signal', turn: 5, step: 5,
        callId: 'terminal-signal', name: 'Shell', resultSeq: 10, result: result('signal-result'),
        resultPresentation: {
          phase: 'result', card: 'terminal', title: 'watch', output: '', signal: 'SIGTERM',
        },
      },
      {
        kind: 'tool', key: 'tool:5:6:search-paths', turn: 5, step: 6,
        callId: 'search-paths', name: 'Search', resultSeq: 11, result: result('paths-result'),
        resultPresentation: {
          phase: 'result', card: 'search', shape: 'paths', title: 'Search',
          paths: ['a.ts', 'b.ts'], truncated: false, total: 2,
        },
      },
      {
        kind: 'tool', key: 'tool:5:7:web-fetch', turn: 5, step: 7,
        callId: 'web-fetch', name: 'Fetch', resultSeq: 12, result: result('fetch-result'),
        resultPresentation: {
          phase: 'result', card: 'web', kind: 'fetch',
          url: 'https://example.test/docs', statusCode: 200, truncated: false,
        },
      },
      {
        kind: 'tool', key: 'tool:6:1:web-search', turn: 6, step: 1,
        callId: 'web-search', name: 'Web', resultSeq: 20, result: result('web-result'),
        resultPresentation: {
          phase: 'result', card: 'web', kind: 'search', sources: [
            { url: 'https://a.test' }, { url: 'https://b.test' },
          ], truncated: false,
        },
      },
      {
        kind: 'tool', key: 'tool:6:2:diff-many', turn: 6, step: 2,
        callId: 'diff-many', name: 'Edit', resultSeq: 21, result: result('diff-many-result'),
        resultPresentation: {
          phase: 'result', card: 'diff', diffs: [
            { path: 'a.ts', oldText: 'a', newText: 'A' },
            { path: 'b.ts', oldText: 'b', newText: 'B' },
            { path: 'c.ts', oldText: 'c', newText: 'C' },
          ],
        },
      },
      {
        kind: 'tool', key: 'tool:6:3:diff-empty', turn: 6, step: 3,
        callId: 'diff-empty', name: 'Edit', resultSeq: 22, result: result('diff-empty-result'),
        resultPresentation: { phase: 'result', card: 'diff', diffs: [] },
      },
      {
        kind: 'tool', key: 'tool:6:4:read-empty', turn: 6, step: 4,
        callId: 'read-empty', name: 'Read', resultSeq: 23, result: result('read-empty-result'),
        resultPresentation: {
          phase: 'result', card: 'read', path: 'short.ts', offset: 9,
          lines: [], totalLines: 0,
        },
      },
      {
        kind: 'tool', key: 'tool:6:5:generic-result', turn: 6, step: 5,
        callId: 'generic-result', name: 'Write', resultSeq: 24, result: result('generic-result'),
        resultPresentation: { phase: 'result', card: 'generic' },
      },
      {
        kind: 'tool', key: 'tool:6:6:generic-title', turn: 6, step: 6,
        callId: 'generic-title', name: 'customTool', resultSeq: 25, result: result('title-result'),
        resultPresentation: { phase: 'result', card: 'generic', title: 'Custom result' },
      },
      {
        kind: 'tool', key: 'tool:6:7:punctuation-name', turn: 6, step: 7,
        callId: 'punctuation-name', name: '---', resultSeq: 26, result: result('punctuation-result'),
        resultPresentation: { phase: 'result', card: 'generic' },
      },
    ]
    const matrix = renderRows(matrixRows)
    expect(matrix).toMatchObject([
      {
        kind: 'assistant-draft',
        activitySummary: '■ 4 of 7 execution steps unfinished · Ctrl+O for details',
      },
      {
        kind: 'assistant-draft',
        activitySummary: '✓ Completed 7 execution steps · Ctrl+O for details',
      },
    ])
    expect(JSON.stringify(matrix)).not.toContain('Custom action')
    expect(JSON.stringify(matrix)).not.toContain('https://example.test/docs')
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

    const compact = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards,
    }, { columns: 80, rows: 24 }).lines.join('\n')

    expect(compact).toContain('✓ Completed 1 execution step · Ctrl+O for details')
    expect(compact).not.toContain('Read pending')
    expect(compact).not.toContain('Result: [empty]')

    const expanded = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      toolCards,
      transcriptViewMode: 'verbose',
    }, { columns: 80, rows: 24 }).lines.join('\n')
    expect(expanded).toContain('TOOL  Result · Read pending  ✓ DONE')
    expect(expanded).toContain('Result: [empty]')
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
    expect(menuFrame.conversation?.composer).toBe('/missing')
    expect(menuFrame.conversation?.dock).toMatchObject({ role: 'command' })
    expect(menuFrame.overlay).toBeUndefined()

    const boundedFocus = renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState('/m'),
      commandMenu: {
        query: 'm',
        candidates: [{
          origin: 'local',
          command: { name: 'mode', description: 'Switch mode' },
        }],
        selectedIndex: 0,
        totalCount: 1,
        windowStart: 0,
      },
    }, { columns: 80, rows: 7 })
    expect(boundedFocus.lines).toHaveLength(7)
    expect(boundedFocus.lines.join('\n')).toContain('› /mode')
    expect(boundedFocus.lines.join('\n')).toContain('Switch Agent mode')

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
    expect(emptyWindow.conversation?.dock).toMatchObject({ role: 'command', lines: [] })
    expect(emptyWindow.overlay).toBeUndefined()
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
    expect(output).toContain('› Keep planning')
    expect(output).toContain('Approve')
    expect(output).toContain('2 more plan lines in the tool card')
    expect(output).not.toContain('Decision:')
    expect(output).not.toContain('╭─')
    const selectedLine = frame.lines.findIndex(line => line.includes('› Keep planning'))
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
    expect(queued).toContain('Incomplete evidence · Allow disabled')
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

    const deferred = renderDshFrame(
      { ...base, jobs },
      { columns: 100, rows: 30 },
      { deferFlatFallback: true },
    )
    expect(deferred.lines.join('\n')).not.toContain('earlier background jobs')
    expect(deferred.lines.join('\n')).not.toContain('ACTIVITY · bash-2')
    expect(deferred.conversation?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'activity-omission' }),
      expect.objectContaining({ key: 'activity:bash-2:30' }),
    ]))
    const deferredFlat = deferred.flatFallback!()
    expect(deferredFlat.lines.join('\n')).toContain('earlier background jobs')
    expect(deferredFlat.lines.join('\n')).toContain('ACTIVITY · bash-2')

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

  it('keeps ordinary dialogue unboxed and approval inline above the preserved draft', () => {
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
    const you = conversation.lines.findIndex(line => line.includes('› inspect the workspace'))
    const dsh = conversation.lines.findIndex(line => (
      line.includes('Completed 1 execution step')
    ))
    const command = conversation.lines.findIndex(line => line.includes('╭─ CMD'))
    const focus = frame.lines.findIndex(line => line.includes('Incomplete evidence · Allow disabled'))

    expect(conversation.lines[0]).toContain('DSH-TUI')
    expect(conversation.lines[0]).toContain('session-a')
    expect(you).toBeGreaterThan(0)
    expect(dsh).toBeGreaterThan(you)
    expect(command).toBeGreaterThan(dsh)
    expect(focus).toBeGreaterThan(0)
    expect(output).not.toContain('╭─ YOU')
    expect(output).not.toContain('╭─ DSH')
    expect(output).not.toMatch(/^(?:YOU|DSH)\s/mu)
    expect(output).toContain('✓ Completed 1 execution step · Ctrl+O for details')
    expect(output).not.toContain('I will read the project first.')
    expect(output).not.toContain('Arguments: {"path":"README.md"}')
    expect(output).not.toContain('Result: opened')
    expect(frame.lines.join('\n')).toContain('1 Allow once [disabled]')
    expect(frame.lines.join('\n')).toContain('2 Reject')
    expect(frame.lines.join('\n')).toContain('next step')
    expect(frame.overlay).toBeUndefined()
    expect(frame.cursor).toBeUndefined()
    expect(`${output}\n${frame.lines.join('\n')}`).not.toContain('\u001b')
    expect(`${output}\n${frame.lines.join('\n')}`).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    for (const line of conversation.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
    for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)

    const narrow = renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
    }, { columns: 24, rows: 40 }).lines.join('\n')
    expect(narrow).toContain('› inspect the workspace')
    expect(narrow).toContain('  ✓ Completed 1')
    expect(narrow).toContain('CMD  /compact')
    expect(narrow).not.toContain('╭─ YOU')
    expect(narrow).not.toContain('╭─ DSH')
    expect(narrow).not.toContain('╭─ TOOL')
  })

  it('keeps flat turn spacing and clips the newest long answer instead of showing older blocks', () => {
    const selected = selectSession(createUiState(), 'session-a')
    const session = selected.sessions['session-a']!
    const roundRows: readonly TranscriptRow[] = [
      { kind: 'user', key: 'event:0', seq: 0, message: message('user-0', 'user', 'first') },
      {
        kind: 'assistant', key: 'event:1', seq: 1, turn: 1, step: 1,
        message: message('assistant-1', 'assistant', 'first answer'), interrupted: false,
      },
      { kind: 'user', key: 'event:2', seq: 2, message: message('user-2', 'user', 'second') },
      {
        kind: 'assistant', key: 'event:3', seq: 3, turn: 2, step: 1,
        message: message('assistant-3', 'assistant', 'second answer'), interrupted: false,
      },
    ]
    const uiFor = (rows: readonly TranscriptRow[]): UiState => ({
      ...selected,
      sessions: {
        ...selected.sessions,
        'session-a': { ...session, rows },
      },
    })
    const spaced = renderDshFrame({
      ui: uiFor(roundRows),
      interaction: undefined,
      prompt: createPromptEditorState(),
    }, { columns: 80, rows: 20 }).lines
    const firstAnswer = spaced.findIndex(line => line.includes('first answer'))
    const secondPrompt = spaced.findIndex(line => line.includes('› second'))
    expect(firstAnswer).toBeGreaterThan(-1)
    expect(secondPrompt).toBeGreaterThan(firstAnswer)
    expect(spaced.slice(firstAnswer + 1, secondPrompt)).toEqual([''])

    const comfortable = renderDshFrame({
      ui: uiFor(roundRows), interaction: undefined, prompt: createPromptEditorState(),
      preferences: { ...DEFAULT_DSH_TUI_PREFERENCES, density: 'comfortable' },
    }, { columns: 80, rows: 20 }).lines
    const comfortableAnswer = comfortable.findIndex(line => line.includes('first answer'))
    const comfortablePrompt = comfortable.findIndex(line => line.includes('› second'))
    expect(comfortable.slice(comfortableAnswer + 1, comfortablePrompt)).toEqual(['', ''])

    const longRows: readonly TranscriptRow[] = [
      roundRows[0]!,
      {
        kind: 'assistant', key: 'event:4', seq: 4, turn: 1, step: 1,
        message: message(
          'assistant-4',
          'assistant',
          '长回答 ' + '中文内容'.repeat(180) + ' END_MARKER',
        ),
        interrupted: false,
      },
    ]
    const clipped = renderDshFrame({
      ui: uiFor(longRows),
      interaction: undefined,
      prompt: createPromptEditorState(),
    }, { columns: 80, rows: 8 }).lines.join('\n')
    expect(clipped).toContain('END_MARKER')
    expect(clipped).not.toContain('› first')
  })

  it('renders the Agent tool catalog as a responsive workspace with explicit focus', () => {
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
    const details = { focus: 'details' as const, detailOffset: 0 }
    const mcp = view({ ...base, selectedIndex: 1, selected: rows[1]!, navigation: details })
    const transport = view({ ...base, selectedIndex: 2, selected: rows[2]!, navigation: details })
    expect(core.overlay).toBeUndefined()
    expect(core.lines).toHaveLength(40)
    expect(core.lines.join('\n')).toContain('Tools')
    expect(core.lines.join('\n')).toContain('Search ›')
    expect(core.lines.join('\n')).toContain('Capabilities')
    expect(core.lines.join('\n')).toContain('3/3')
    expect(core.lines.join('\n')).not.toContain('generation')
    expect(core.lines.join('\n')).toContain('› read_file')
    expect(core.lines.join('\n')).toContain('Selected  read_file')
    expect(core.lines.join('\n')).toContain('Ask in Chat')
    expect(core.lines.join('\n')).not.toContain('Params')
    const coreDetails = view({ ...base, navigation: details }).lines.join('\n')
    expect(coreDetails).toContain('Inputs  1 required · 1 total')
    expect(coreDetails).toContain('Params  path*')
    expect(core.lines.join('\n')).not.toContain('TOOLS · AGENT CAPABILITIES')
    expect(core.lines.join('\n')).not.toContain('GROUPS')
    expect(core.lineStyles?.every(style => style?.backgroundRole !== undefined)).toBe(true)
    expect(core.cursor).toBeUndefined()
    expect(view({ ...base, navigation: { focus: 'search', detailOffset: 0 } }).cursor).toMatchObject({ row: 1 })
    expect(mcp.lines.join('\n')).toContain('Kind  MCP')
    expect(transport.lines.join('\n')).toContain('Kind  Code transport')
    expect(transport.lines.join('\n')).toContain('Params  none')
    expect(core.lineStyles).toEqual(expect.arrayContaining([
      expect.objectContaining({ backgroundRole: 'selectionBackground' }),
      expect.objectContaining({ tone: 'accent' }),
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
    expect(failed.styleSpans?.flatMap(spans => spans.map(span => span.style))).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: 'warning' }),
      expect.objectContaining({ tone: 'error' }),
    ]))
    expect(coldFailure.lines.join('\n')).toContain('first observation failed')
    expect(noMatches.lines.join('\n')).toContain('No matching tools')
    expect(unavailable.lines.join('\n')).toContain('Capability registry unavailable')

    for (const height of [1, 2, 3, 4]) {
      const tiny = view(base, 40, height)
      expect(tiny.lines).toHaveLength(height)
      expect(tiny.overlay).toBeUndefined()
      expect(tiny.cursor).toBeUndefined()
      for (const line of tiny.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    }
  })

  it('keeps approval fail-closed in one-, two-, and three-row terminals', () => {
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
    expect(three.lines[0]).toContain('Terminal too small for approval')
    expect(three.lines[1]).toContain('Esc reject')
    expect(three.lines.join('\n')).not.toContain('Allow once')
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

  it('keeps empty Chat quiet while retaining real workbench guidance', () => {
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
    const oneRow = renderDshFrame(view, { columns: 20, rows: 1 })
    const twoRows = renderDshFrame(view, { columns: 20, rows: 2 })
    const deferred = renderDshFrame(
      view,
      { columns: 80, rows: 18 },
      { deferFlatFallback: true },
    )
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

    expect(full.lines.join('\n')).not.toContain('CORDIS')
    expect(full.lines.join('\n')).not.toContain('QUICK START')
    expect(full.lines.join('\n')).not.toContain('Harness workbench ready')
    expect(full.lines.join('\n')).not.toContain('<__')
    expect(medium.lines.join('\n')).not.toContain('CORDIS')
    expect(medium.lines.join('\n')).not.toContain('<__')
    expect(narrow.lines.join('\n')).not.toContain('QUICK START')
    expect(short.lines.join('\n')).not.toContain('QUICK START')
    expect(tiny.lines.join('\n')).not.toContain('QUICK START')
    expect(oneRow.lines).toHaveLength(1)
    expect(twoRows.lines).toHaveLength(2)
    expect(deferred.lines.join('\n')).not.toContain('CORDIS')
    expect(deferred.conversation?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'empty', key: 'cordis-workbench-home' }),
    ]))
    expect(deferred.flatFallback!().lines.join('\n')).not.toContain('CORDIS')
    expect(active.lines.join('\n')).toContain('WORKBENCH DASHBOARD')
    expect(active.lines.join('\n')).toContain('Timeline ready')
    expect(active.lines.join('\n')).not.toContain('Harness workbench ready')
    expect(activeMedium.lines.join('\n')).toContain('Timeline ready · send a prompt')
    expect(activeTiny.lines.join('\n')).toContain('Ready')
    expect(cordisBrandLines({ columns: 80, rows: 18 }).join('\n')).toContain('<__')
    expect(cordisBrandLines({ columns: 40, rows: 8 }).join('\n')).toContain('DSH-TUI')
    expect(cordisBrandLines({ columns: 39, rows: 20 })).toEqual([])
    expect(cordisBrandLines({ columns: 80, rows: 7 })).toEqual([])
    expect(cordisBrandLines({ columns: 80, rows: 8 }).join('\n')).toContain('DSH-TUI')
    for (const frame of [full, medium, narrow, short, tiny, active, activeMedium, activeTiny]) {
      expect(frame.lines).toHaveLength(frame.viewport.rows)
      for (const line of frame.lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(frame.viewport.columns)
      }
    }
  })

  it('exposes only safe reasoning metadata in compact and verbose transcripts', () => {
    const frameFor = (
      reasoning: string,
      lastSeq: number,
      reasoningExpanded = false,
      transcriptViewMode: 'compact' | 'verbose' = 'compact',
    ) => {
      const selected = selectSession(createUiState(), 'session-a')
      const session = selected.sessions['session-a']!
      const row: TranscriptRow = {
        kind: 'assistant-draft',
        key: 'draft:1:1',
        firstSeq: 1,
        lastSeq,
        turn: 1,
        step: 1,
        text: '',
        reasoning,
        chunkCount: lastSeq,
      }
      const ui: UiState = {
        ...selected,
        phase: 'ready',
        sessions: {
          ...selected.sessions,
          'session-a': { ...session, rows: [row] },
        },
      }
      return renderDshFrame({
        ui,
        interaction: undefined,
        prompt: createPromptEditorState(),
        reasoningExpanded,
        transcriptViewMode,
      }, { columns: 80, rows: 12 }).conversation?.nodes.find(node => (
        node.kind === 'assistant-draft'
      ))
    }

    expect(frameFor('private trace one', 1)).toBeUndefined()
    expect(frameFor('private trace one and much more hidden work', 2)).toBeUndefined()

    const expanded = frameFor('private trace one', 1, true)
    const expandedLater = frameFor('private trace one and much more hidden work', 2, true)
    expect(expanded).toMatchObject({
      reasoningSummary: 'THOUGHT · LIVE',
    })
    expect(expanded).not.toHaveProperty('reasoning')
    expect(JSON.stringify(expanded)).not.toContain('private trace')
    expect(expandedLater?.revision).toBe(expanded?.revision)
    expect(JSON.stringify(expandedLater)).not.toContain('private trace')

    const verbose = frameFor('private verbose reasoning', 3, false, 'verbose')
    expect(verbose).toMatchObject({ reasoningSummary: 'THOUGHT · LIVE' })
    expect(verbose).not.toHaveProperty('reasoning')
    expect(JSON.stringify(verbose)).not.toContain('private verbose reasoning')

    const selected = selectSession(createUiState(), 'usage-only')
    const session = selected.sessions['usage-only']!
    const usageOnly: TranscriptRow = {
      kind: 'assistant',
      key: 'event:1',
      seq: 1,
      turn: 1,
      step: 1,
      message: message('usage-only', 'assistant', 'Final answer'),
      usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 7 },
      interrupted: false,
    }
    const usageUi: UiState = {
      ...selected,
      sessions: {
        ...selected.sessions,
        'usage-only': { ...session, rows: [usageOnly] },
      },
    }
    const usageNode = (mode: 'compact' | 'verbose') => renderDshFrame({
      ui: usageUi,
      interaction: undefined,
      prompt: createPromptEditorState(),
      reasoningExpanded: true,
      transcriptViewMode: mode,
    }, { columns: 80, rows: 12 }).conversation?.nodes.find(node => (
      node.kind === 'assistant'
    ))

    expect(usageNode('compact')).toMatchObject({
      reasoningSummary: 'THOUGHT · 7 TOKENS · TEXT UNAVAILABLE',
    })
    expect(usageNode('verbose')).toMatchObject({
      reasoningSummary: 'THOUGHT · 7 TOKENS · TEXT UNAVAILABLE',
    })
  })

  it('orders reducer-replaced final answers by durable sequence and keeps active trace behind the Orb', () => {
    let ui = selectSession(createUiState(), 'session-a')
    const apply = (seq: number, event: Parameters<typeof durable>[1]) => {
      ui = reduceUiEvent(ui, durable(seq, event))
    }
    apply(0, { type: 'turn/start', data: { turn: 1 } })
    apply(1, {
      type: 'user/message',
      data: {
        message: message('input-1', 'user', 'inspect'),
        surfaceOp: 'append',
      },
    })
    apply(2, { type: 'step/start', data: { turn: 1, step: 1 } })
    apply(3, {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'I will inspect first.' },
      },
    })
    apply(4, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'read-1', name: 'Read', arguments: '{}' },
    })
    apply(5, {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        callId: 'read-1',
        message: message('tool-1', 'user', 'private result', 'tool'),
        surfaceOp: 'append',
      },
    })

    const active = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      agentRequest: { phase: 'tool', description: 'Reading', turn: 1 },
    }, { columns: 80, rows: 24 }).conversation!
    expect(active.agentRequest).toMatchObject({ phase: 'tool' })
    expect(active.nodes.some(node => (
      (node.kind === 'assistant' || node.kind === 'assistant-draft')
      && node.activitySummary !== undefined
    ))).toBe(false)
    expect(JSON.stringify(active.nodes)).not.toContain('I will inspect first.')

    const writingUi = reduceUiEvent(reduceUiEvent(ui, durable(6, {
      type: 'step/start', data: { turn: 1, step: 2 },
    })), durable(7, {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 2,
        chunk: { type: 'text-delta', index: 0, text: 'Here is' },
      },
    }))
    const writing = renderDshFrame({
      ui: writingUi,
      interaction: undefined,
      prompt: createPromptEditorState(),
      agentRequest: { phase: 'responding', description: 'Writing response', turn: 1 },
    }, { columns: 80, rows: 24 }).conversation!
    expect(writing.agentRequest).toBeUndefined()
    expect(JSON.stringify(writing.nodes)).not.toContain('I will inspect first.')
    expect(writing.nodes.filter(node => (
      (node.kind === 'assistant' || node.kind === 'assistant-draft')
      && node.activitySummary !== undefined
    ))).toHaveLength(1)

    apply(6, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: message('assistant-1', 'assistant', 'FINAL answer'),
        surfaceOp: 'append',
      },
    })
    const physicalRows = ui.sessions['session-a']!.rows
    expect(physicalRows.findIndex(row => row.kind === 'assistant'))
      .toBeLessThan(physicalRows.findIndex(row => row.kind === 'tool'))

    const compact = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      agentRequest: { phase: 'responding', description: 'Writing response', turn: 1 },
    }, { columns: 80, rows: 24 }).conversation!
    expect(compact.agentRequest).toBeUndefined()
    expect(JSON.stringify(compact.nodes)).toContain('FINAL answer')
    expect(JSON.stringify(compact.nodes)).not.toContain('I will inspect first.')
    expect(compact.nodes.filter(node => (
      (node.kind === 'assistant' || node.kind === 'assistant-draft')
      && node.activitySummary !== undefined
    ))).toHaveLength(1)
    const compactAnswer = compact.nodes.find((node): node is ConversationMarkdownNode => (
      (node.kind === 'assistant' || node.kind === 'assistant-draft')
      && node.text === 'FINAL answer'
    ))
    expect(compactAnswer).toMatchObject({
      key: 'assistant:event:6',
      anchorKey: 'tool:1:1:read-1',
    })

    const verbose = renderDshFrame({
      ui,
      interaction: undefined,
      prompt: createPromptEditorState(),
      transcriptViewMode: 'verbose',
    }, { columns: 80, rows: 30 }).conversation!
    const toolIndex = verbose.nodes.findIndex(node => node.kind === 'tool')
    const finalIndex = verbose.nodes.findIndex(node => (
      (node.kind === 'assistant' || node.kind === 'assistant-draft')
      && node.text === 'FINAL answer'
    ))
    expect(toolIndex).toBeGreaterThan(-1)
    expect(finalIndex).toBeGreaterThan(toolIndex)
    expect(verbose.nodes.some(node => node.key === compactAnswer?.anchorKey)).toBe(true)
  })

  it('keeps request activity until the compact turn has a final visible answer', () => {
    const selected = selectSession(createUiState(), 'session-a')
    const session = selected.sessions['session-a']!
    const processMessage: TranscriptRow = {
      kind: 'assistant',
      key: 'event:1',
      seq: 1,
      turn: 1,
      step: 1,
      message: {
        id: 'process',
        role: 'assistant',
        sourceKind: 'model',
        content: [
          { type: 'text', text: 'I will inspect first.' },
          { type: 'tool-call', id: 'read-1', name: 'Read', arguments: '{}' },
        ],
      },
      interrupted: false,
    }
    const tool: TranscriptRow = {
      kind: 'tool',
      key: 'tool:1:1:read-1',
      turn: 1,
      step: 1,
      callId: 'read-1',
      name: 'Read',
      callSeq: 2,
      resultSeq: 2,
    }
    const finalAnswer: TranscriptRow = {
      kind: 'assistant',
      key: 'event:3',
      seq: 3,
      turn: 1,
      step: 2,
      message: message('final', 'assistant', 'Here is the answer.'),
      interrupted: false,
    }
    const frameFor = (
      rows: readonly TranscriptRow[],
      phase: 'responding' | 'failed' | 'succeeded',
      openTurn: number | undefined,
    ) => renderDshFrame({
      ui: {
        ...selected,
        sessions: {
          ...selected.sessions,
          'session-a': { ...session, rows, openTurn },
        },
      },
      interaction: undefined,
      prompt: createPromptEditorState(),
      agentRequest: { phase, description: phase, turn: 1 },
    }, { columns: 80, rows: 24 }).conversation

    const working = frameFor([processMessage, tool], 'responding', 1)
    expect(working?.agentRequest).toMatchObject({ phase: 'responding' })
    expect(JSON.stringify(working?.nodes)).not.toContain('I will inspect first.')
    expect(working?.nodes.some(node => (
      (node.kind === 'assistant' || node.kind === 'assistant-draft')
      && node.activitySummary !== undefined
    ))).toBe(false)

    const answered = frameFor([processMessage, tool, finalAnswer], 'responding', 1)
    expect(answered?.agentRequest).toBeUndefined()
    expect(JSON.stringify(answered?.nodes)).toContain('Here is the answer.')

    const recovered = frameFor([
      processMessage,
      { ...tool, error: { name: 'ReadError', code: 'READ_FAILED' } },
      finalAnswer,
    ], 'responding', 1)
    expect(recovered?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        activitySummary: '× 1 of 1 execution step failed · Ctrl+O for details',
      }),
    ]))

    const failed = frameFor([processMessage, tool], 'failed', undefined)
    expect(failed?.agentRequest).toMatchObject({ phase: 'failed' })
    expect(frameFor([processMessage, tool], 'succeeded', undefined)?.agentRequest)
      .toBeUndefined()

    const unfinishedTool: TranscriptRow = {
      kind: 'tool',
      key: 'tool:1:1:read-unfinished',
      turn: 1,
      step: 1,
      callId: 'read-unfinished',
      name: 'Read',
      callSeq: 2,
    }
    const cancelled = frameFor([processMessage, unfinishedTool], 'failed', undefined)
    expect(cancelled?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        activitySummary: '■ 1 of 1 execution step unfinished · Ctrl+O for details',
      }),
    ]))
    expect(JSON.stringify(cancelled?.nodes)).not.toContain('✓ Completed')

    const priorAnswer: TranscriptRow = {
      kind: 'assistant',
      key: 'event:0',
      seq: 0,
      turn: 0,
      step: 1,
      message: message('prior-final', 'assistant', 'Previous answer.'),
      interrupted: false,
    }
    const rejectedBeforeTurn = renderDshFrame({
      ui: {
        ...selected,
        sessions: {
          ...selected.sessions,
          'session-a': { ...session, rows: [priorAnswer], openTurn: undefined },
        },
      },
      interaction: undefined,
      prompt: createPromptEditorState(),
      agentRequest: { phase: 'failed', description: 'Prompt was not sent' },
    }, { columns: 80, rows: 24 }).conversation
    expect(rejectedBeforeTurn?.agentRequest).toMatchObject({
      phase: 'failed',
      description: 'Prompt was not sent',
    })
  })
})
