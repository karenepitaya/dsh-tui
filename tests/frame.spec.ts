import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPromptEditorState } from '../src/ui/prompt-editor.ts'
import {
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

    const wide = buildStatusLine(model, context, compaction, 100)
    expect(wide?.tone).toBe('accent')
    expect(wide?.text).toContain('compact 8/~12K …')
    expect(wide?.text).toContain('deepseek-v4-pro/high')
    expect(wide?.text).toContain('ctx [━━······] ~32K/128K 25%')
    expect(wide?.text).toContain('cache 67%')
    expect(wide?.text).toContain('tok ↑1.5K ↓25')
    expect(visibleWidth(wide?.text ?? '')).toBeLessThanOrEqual(100)

    const narrow = buildStatusLine(model, context, compaction, 32)
    expect(narrow?.text).toContain('compact')
    expect(narrow?.text).toContain('ctx')
    expect(narrow?.text).not.toContain('tok')
    expect(visibleWidth(narrow?.text ?? '')).toBeLessThanOrEqual(32)

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
    expect(starting?.text).toContain('compact …')

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
    }, undefined, 100)?.text).toBe('tok ↑0 ↓4')
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

    expect(output).toContain('Read · README.md · done')
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

    expect(output).toContain('Result · Read pending · done')
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
    expect(menuFrame.lines.join('\n')).toContain('+-- FOCUS')
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
    expect(compactFocus.lines.join('\n')).toContain('+-- YOU')
    expect(compactFocus.lines.join('\n')).toContain('FOCUS |')
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
    const you = frame.lines.findIndex(line => line.includes('+-- YOU'))
    const dsh = frame.lines.findIndex(line => line.includes('+-- DSH'))
    const tool = frame.lines.findIndex(line => line.includes('+-- TOOL'))
    const command = frame.lines.findIndex(line => line.includes('+-- CMD'))
    const focus = frame.lines.findIndex(line => line.includes('+-- FOCUS'))

    expect(frame.lines[0]).toContain('DSH-TUI')
    expect(frame.lines[0]).toContain('session-a')
    expect(you).toBeGreaterThan(0)
    expect(dsh).toBeGreaterThan(you)
    expect(tool).toBeGreaterThan(dsh)
    expect(command).toBeGreaterThan(tool)
    expect(focus).toBeGreaterThan(command)
    expect(output).toContain('Tool read · done')
    expect(output).toContain('Arguments: {"path":"README.md"}')
    expect(output).toContain('Result: opened')
    expect(frame.lines.at(-2)).toContain('allow? y')
    expect(frame.lines.at(-1)).toContain('Approval:')
    expect(frame.cursor).toEqual({ row: 32, column: 8 })
    expect(output).not.toContain('\u001b')
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u)
    for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)

    const narrow = renderDshFrame({
      ui: visualState(),
      interaction: undefined,
      prompt: createPromptEditorState(),
    }, { columns: 24, rows: 40 }).lines.join('\n')
    expect(narrow).toContain('+-- YOU')
    expect(narrow).toContain('+-- DSH')
    expect(narrow).toContain('+-- TOOL')
    expect(narrow).toContain('+-- CMD')
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

  it('shows a responsive ASCII Cordis Whale only for an empty session with enough space', () => {
    const view = {
      ui: selectSession(createUiState(), 'empty-session'),
      interaction: undefined,
      prompt: createPromptEditorState(),
    }
    const full = renderDshFrame(view, { columns: 80, rows: 18 })
    const medium = renderDshFrame(view, { columns: 50, rows: 10 })
    const narrow = renderDshFrame(view, { columns: 39, rows: 18 })
    const short = renderDshFrame(view, { columns: 80, rows: 7 })

    expect(full.lines.join('\n')).toContain('C O R D I S')
    expect(full.lines.join('\n')).toContain('<__')
    expect(medium.lines.join('\n')).toContain('CORDIS')
    expect(medium.lines.join('\n')).not.toContain('<__')
    expect(narrow.lines.join('\n')).not.toContain('CORDIS')
    expect(short.lines.join('\n')).not.toContain('CORDIS')
    for (const frame of [full, medium, narrow, short]) {
      expect(frame.lines).toHaveLength(frame.viewport.rows)
      for (const line of frame.lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(frame.viewport.columns)
      }
    }
  })
})
