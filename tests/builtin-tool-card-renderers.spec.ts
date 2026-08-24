import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { installBuiltinToolCardRenderers } from '../src/presentation/builtin-tool-card-renderers.ts'
import {
  ToolCardRendererRegistry,
  type ToolCardRendererDisposer,
  type ToolCardRendererEffectOwner,
  type ToolCardRenderRequest,
} from '../src/presentation/tool-card-renderers.ts'
import type { ToolPresentationView } from '../src/presentation/types.ts'

class TestEffectOwner implements ToolCardRendererEffectOwner {
  readonly labels: string[] = []
  private readonly cleanups: ToolCardRendererDisposer[] = []

  effect(setup: () => ToolCardRendererDisposer, label?: string): unknown {
    const cleanup = setup()
    this.cleanups.push(cleanup)
    if (label !== undefined) this.labels.push(label)
    return cleanup
  }

  dispose(): void {
    for (const cleanup of [...this.cleanups].reverse()) cleanup()
  }
}

interface BuiltinCase {
  readonly name: string
  readonly presentation: ToolPresentationView
  readonly expected: readonly string[]
}

const cases: readonly BuiltinCase[] = [
  {
    name: 'call generic',
    presentation: {
      phase: 'call',
      card: 'generic',
      title: 'Read configuration',
      kind: 'read',
      rawInput: { path: 'dsh.yml' },
      content: [{ type: 'text', text: 'inspect' }],
      locations: [{ path: 'dsh.yml', line: 4 }],
    },
    expected: ['Call · Read configuration', 'Kind: read', 'Input: object', 'dsh.yml:4'],
  },
  {
    name: 'call terminal',
    presentation: {
      phase: 'call',
      card: 'terminal',
      title: 'pnpm test',
      description: 'Run the narrow suite',
      cwd: 'D:/project',
    },
    expected: ['Terminal · pnpm test', 'Run the narrow suite', 'Cwd: D:/project'],
  },
  {
    name: 'call diff',
    presentation: {
      phase: 'call',
      card: 'diff',
      title: 'Create config.ts',
      diffs: [{ path: 'config.ts', oldText: null, newText: 'export const ready = true' }],
      locations: [{ path: 'config.ts', line: 1 }],
    },
    expected: ['Diff · Create config.ts', 'Create config.ts', '+1 lines', 'At: config.ts:1'],
  },
  {
    name: 'result generic',
    presentation: {
      phase: 'result',
      card: 'generic',
      title: 'Completed',
      content: [{ type: 'text', text: 'Operation completed' }],
    },
    expected: ['Result · Completed', 'Content blocks: 1', 'Operation completed'],
  },
  {
    name: 'result terminal',
    presentation: {
      phase: 'result',
      card: 'terminal',
      title: 'Tests',
      output: '15 tests passed',
      exitCode: 0,
    },
    expected: ['Terminal · Tests', 'Exit: 0', '15 tests passed'],
  },
  {
    name: 'result diff',
    presentation: {
      phase: 'result',
      card: 'diff',
      title: 'Applied patch',
      diffs: [{ path: 'config.ts', oldText: 'false', newText: 'true' }],
    },
    expected: ['Diff · Applied patch', 'Update config.ts', '-1 +1 lines'],
  },
  {
    name: 'result search matches',
    presentation: {
      phase: 'result',
      card: 'search',
      shape: 'matches',
      title: 'References',
      files: [{ path: 'src/a.ts', matches: [{ lineNumber: 12, line: 'needle' }] }],
      truncated: false,
      total: 1,
    },
    expected: ['Search · References', 'Matches: 1', 'src/a.ts', '12: needle'],
  },
  {
    name: 'result search paths',
    presentation: {
      phase: 'result',
      card: 'search',
      shape: 'paths',
      title: 'TypeScript files',
      paths: ['src/a.ts'],
      truncated: true,
      total: 3,
    },
    expected: ['Search · TypeScript files', 'Paths: 3 (truncated)', 'src/a.ts'],
  },
  {
    name: 'result read',
    presentation: {
      phase: 'result',
      card: 'read',
      title: 'Configuration',
      path: 'src/config.ts',
      offset: 1,
      lines: [{ number: 1, text: 'export const ready = true' }],
      totalLines: 8,
      lang: 'ts',
    },
    expected: ['Read · Configuration', 'File: src/config.ts', 'Lines: 1-1 of 8 · ts', '1 │ export const ready = true'],
  },
  {
    name: 'result web search',
    presentation: {
      phase: 'result',
      card: 'web',
      kind: 'search',
      title: 'Cordis docs',
      sources: [{ url: 'https://example.test/cordis', title: 'Cordis', snippet: 'Plugin lifecycle' }],
      answer: 'Cordis owns plugin effects.',
      truncated: false,
    },
    expected: ['Web search · Cordis docs', 'Sources: 1', 'Answer: Cordis owns plugin effects.', '[1] Cordis', 'https://example.test/cordis'],
  },
  {
    name: 'result web fetch',
    presentation: {
      phase: 'result',
      card: 'web',
      kind: 'fetch',
      title: 'Cordis page',
      url: 'https://example.test/cordis',
      statusCode: 200,
      truncated: true,
    },
    expected: ['Web fetch · Cordis page', 'Status: 200', 'URL: https://example.test/cordis', 'Body: truncated'],
  },
]

function requestFor(presentation: ToolPresentationView): ToolCardRenderRequest {
  return {
    phase: presentation.phase,
    toolName: 'example_tool',
    status: presentation.phase === 'call' ? 'running' : 'done',
    width: 120,
    presentation,
  }
}

describe('builtin tool-card renderers', () => {
  it.each(cases)('renders $name with its title and structured semantics', ({ presentation, expected }) => {
    const owner = new TestEffectOwner()
    const registry = new ToolCardRendererRegistry()
    installBuiltinToolCardRenderers(owner, registry)

    const text = registry.renderSafe(requestFor(presentation)).join('\n')
    for (const fragment of expected) expect(text).toContain(fragment)
    expect(text).not.toContain('\x1b')
  })

  it('owns all nine phase/card registrations independently and preserves unknown fallback', () => {
    const owner = new TestEffectOwner()
    const registry = new ToolCardRendererRegistry()
    installBuiltinToolCardRenderers(owner, registry)

    expect(owner.labels).toHaveLength(9)
    expect(new Set(owner.labels).size).toBe(9)
    expect(owner.labels).toContain('dsh-tui:tool-card-renderer:call:generic')
    expect(owner.labels).toContain('dsh-tui:tool-card-renderer:result:web')

    const unknown: ToolCardRenderRequest = {
      phase: 'result',
      toolName: 'future_tool',
      status: 'done',
      width: 80,
      presentation: { phase: 'result', card: 'future' },
      result: 'raw result',
    }
    expect(registry.renderSafe(unknown)[0]).toBe('Tool future_tool · done')

    owner.dispose()
    expect(registry.renderSafe(requestFor(cases[0]!.presentation))[0])
      .toBe('Tool example_tool · running')
  })

  it('leaves width, line-count, and control-sequence enforcement to renderSafe', () => {
    const owner = new TestEffectOwner()
    const registry = new ToolCardRendererRegistry()
    installBuiltinToolCardRenderers(owner, registry)
    const output = Array.from(
      { length: 20 },
      (_, index) => `output-${index}-is-long\x1b[31mred\x1b[0m`,
    ).join('\n')

    const lines = registry.renderSafe({
      phase: 'result',
      toolName: 'shell',
      status: 'done',
      width: 18,
      presentation: {
        phase: 'result',
        card: 'terminal',
        title: 'Long output',
        output,
        exitCode: 0,
      },
    })

    expect(lines.length - 1).toBeLessThanOrEqual(8)
    expect(lines.join('\n')).toMatch(/lines hidden/u)
    expect(lines.join('\n')).not.toContain('\x1b')
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(18)
  })

  it('renders optional, empty, and non-object call fields without inventing detail', () => {
    const owner = new TestEffectOwner()
    const registry = new ToolCardRendererRegistry()
    installBuiltinToolCardRenderers(owner, registry)
    const render = (presentation: ToolPresentationView): string => (
      registry.renderSafe(requestFor(presentation)).join('\n')
    )

    expect(render({
      phase: 'call',
      card: 'generic',
      title: ' ',
      rawInput: null,
    })).toContain('Call · example_tool · running\nInput: null')

    expect(render({
      phase: 'call',
      card: 'generic',
      title: 'No input',
    })).toBe('Call · No input · running')

    const mixedContent = render({
      phase: 'call',
      card: 'generic',
      title: 'Mixed content',
      rawInput: [],
      content: [
        'plain text',
        null,
        undefined,
        7,
        ['nested', 'array'],
        { type: 'image' },
        { type: 'text', text: 7 },
        {},
        { type: 7 },
      ],
      locations: [],
    })
    expect(mixedContent).toContain('Input: array (0 items)')
    expect(mixedContent).toContain('Content blocks: 9')
    expect(mixedContent).toMatch(/lines hidden/u)

    expect(render({
      phase: 'call',
      card: 'generic',
      title: 'String input',
      rawInput: 'abc',
      locations: [{ path: 'README.md' }],
    })).toContain('Input: string (3 characters)\nAt: README.md')

    expect(render({
      phase: 'call',
      card: 'generic',
      title: 'Scalar input',
      rawInput: 42,
    })).toContain('Input: number')

    expect(render({
      phase: 'call',
      card: 'terminal',
      title: 'pwd',
    })).toBe('Terminal · pwd · running')

    expect(render({
      phase: 'call',
      card: 'diff',
      title: 'Delete and create empty files',
      diffs: [
        { path: 'old.txt', oldText: 'one\r\ntwo', newText: '' },
        { path: 'empty.txt', oldText: null, newText: '' },
      ],
    })).toContain('Delete old.txt · -2 lines\nCreate empty.txt · +0 lines')
  })

  it('renders absent result detail, raw fallbacks, errors, and empty read windows', () => {
    const owner = new TestEffectOwner()
    const registry = new ToolCardRendererRegistry()
    installBuiltinToolCardRenderers(owner, registry)
    const render = (
      presentation: ToolPresentationView,
      overrides: Partial<ToolCardRenderRequest> = {},
    ): string => registry.renderSafe({
      ...requestFor(presentation),
      ...overrides,
      presentation,
    }).join('\n')

    expect(render({ phase: 'result', card: 'generic' }))
      .toBe('Result · example_tool · done')
    expect(render(
      { phase: 'result', card: 'generic' },
      { result: 'raw result', error: 'FAILED' },
    )).toContain('Result: raw result\nError: FAILED')
    expect(render({ phase: 'result', card: 'generic', content: [] }))
      .toContain('Content blocks: 0')

    expect(render({ phase: 'result', card: 'terminal' }))
      .toBe('Terminal · example_tool · done')
    expect(render(
      { phase: 'result', card: 'terminal', signal: 'SIGTERM' },
      { result: 'partial output', error: new Error('terminated') },
    )).toContain('Signal: SIGTERM\nOutput:\npartial output\nError: Error: terminated')

    expect(render({
      phase: 'result',
      card: 'read',
      path: 'empty.ts',
      offset: 5,
      lines: [],
      totalLines: 4,
    }, { error: 'READ_FAILED' })).toContain(
      'Read · empty.ts · done\nFile: empty.ts\nLines: 5-5 of 4\n(no lines returned)\nError: READ_FAILED',
    )
  })

  it('renders complete fetches and sparse truncated web searches', () => {
    const owner = new TestEffectOwner()
    const registry = new ToolCardRendererRegistry()
    installBuiltinToolCardRenderers(owner, registry)

    const fetch = registry.renderSafe({
      phase: 'result',
      toolName: 'web_fetch',
      status: 'failed',
      width: 120,
      error: 'HTTP warning',
      presentation: {
        phase: 'result',
        card: 'web',
        kind: 'fetch',
        url: 'https://example.test/page',
        statusCode: 204,
        truncated: false,
      },
    }).join('\n')
    expect(fetch).toContain('Web fetch · web_fetch · failed')
    expect(fetch).toContain('Body: complete\nError: HTTP warning')

    const search = registry.renderSafe({
      phase: 'result',
      toolName: 'web_search',
      status: 'done',
      width: 120,
      presentation: {
        phase: 'result',
        card: 'web',
        kind: 'search',
        sources: [{
          url: 'https://example.test/source',
          publishedAt: '2026-08-25',
        }],
        truncated: true,
      },
    }).join('\n')
    expect(search).toContain('Web search · web_search · done')
    expect(search).toContain('Sources: 1 (truncated)')
    expect(search).toContain('[1] https://example.test/source')
    expect(search).toContain('Published: 2026-08-25')
  })
})
