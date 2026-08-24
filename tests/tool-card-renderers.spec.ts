import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  installToolCardRenderer,
  ToolCardRendererRegistry,
  type ToolCardRendererEffectOwner,
} from '../src/presentation/tool-card-renderers.ts'
import {
  isToolPresentationView,
  type ToolPresentationView,
} from '../src/presentation/types.ts'

const vocabulary: readonly ToolPresentationView[] = [
  { phase: 'call', card: 'generic', title: 'Read file', kind: 'read' },
  { phase: 'call', card: 'terminal', title: 'pnpm test', cwd: 'D:/project' },
  {
    phase: 'call',
    card: 'diff',
    title: 'Write a.ts',
    diffs: [{ path: 'a.ts', oldText: null, newText: 'export {}' }],
  },
  { phase: 'result', card: 'generic', title: 'Done', content: [{ type: 'text', text: 'ok' }] },
  { phase: 'result', card: 'terminal', output: 'ok', exitCode: 0 },
  {
    phase: 'result',
    card: 'diff',
    diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
  },
  {
    phase: 'result',
    card: 'search',
    shape: 'matches',
    files: [{ path: 'a.ts', matches: [{ lineNumber: 2, line: 'needle' }] }],
    truncated: false,
    total: 1,
  },
  {
    phase: 'result',
    card: 'search',
    shape: 'paths',
    paths: ['a.ts'],
    truncated: false,
    total: 1,
  },
  {
    phase: 'result',
    card: 'read',
    path: 'a.ts',
    offset: 1,
    lines: [{ number: 1, text: 'export {}' }],
    totalLines: 1,
    lang: 'ts',
  },
  {
    phase: 'result',
    card: 'web',
    kind: 'search',
    sources: [{ url: 'https://example.test', title: 'Example' }],
    answer: 'answer',
    truncated: false,
  },
  {
    phase: 'result',
    card: 'web',
    kind: 'fetch',
    url: 'https://example.test/page',
    statusCode: 200,
    truncated: false,
  },
]

describe('ToolPresentationView runtime guard', () => {
  it('accepts the complete current call/result card vocabulary', () => {
    for (const view of vocabulary) expect(isToolPresentationView(view)).toBe(true)
  })

  it('rejects unknown cards, phase/card mismatches, and malformed structured fields', () => {
    expect(isToolPresentationView({ phase: 'call', card: 'search' })).toBe(false)
    expect(isToolPresentationView({ phase: 'result', card: 'future' })).toBe(false)
    expect(isToolPresentationView({
      phase: 'call',
      card: 'diff',
      title: 'bad',
      diffs: [{ path: 'a.ts', oldText: 1, newText: 'new' }],
    })).toBe(false)
    expect(isToolPresentationView({
      phase: 'result',
      card: 'terminal',
      exitCode: 0,
      signal: 'SIGTERM',
    })).toBe(false)
    expect(isToolPresentationView(null)).toBe(false)
  })
})

describe('ToolCardRendererRegistry', () => {
  it('dispatches by the exact phase/card pair and disposes registrations idempotently', () => {
    const registry = new ToolCardRendererRegistry()
    const disposeCall = registry.register(
      { phase: 'call', card: 'generic' },
      ({ presentation }) => [`call:${presentation.card}`],
    )
    registry.register(
      { phase: 'result', card: 'generic' },
      ({ presentation }) => [`result:${presentation.card}`],
    )

    expect(registry.renderSafe({
      phase: 'call',
      toolName: 'read',
      status: 'running',
      width: 80,
      presentation: vocabulary[0],
      arguments: { path: 'a.ts' },
    })).toEqual(['call:generic'])
    expect(registry.renderSafe({
      phase: 'result',
      toolName: 'read',
      status: 'done',
      width: 80,
      presentation: vocabulary[3],
      result: 'ok',
    })).toEqual(['result:generic'])

    expect(() => registry.register(
      { phase: 'call', card: 'generic' },
      () => ['duplicate'],
    )).toThrow(/call:generic/u)

    disposeCall()
    disposeCall()
    expect(registry.renderSafe({
      phase: 'call',
      toolName: 'read',
      status: 'running',
      width: 80,
      presentation: vocabulary[0],
      arguments: { path: 'a.ts' },
    })[0]).toBe('Tool read · running')
  })

  it('falls back for missing, unknown, unregistered, empty, invalid, or throwing renderers', () => {
    const missing = new ToolCardRendererRegistry()
    const base = {
      phase: 'call' as const,
      toolName: 'shell',
      status: 'running' as const,
      width: 80,
      arguments: { command: 'pnpm test' },
    }

    for (const presentation of [
      undefined,
      { phase: 'call', card: 'future' },
      vocabulary[1],
      vocabulary[3],
    ]) {
      expect(missing.renderSafe({ ...base, presentation })).toEqual([
        'Tool shell · running',
        'Arguments: {',
        '  "command": "pnpm test"',
        '}',
      ])
    }

    const empty = new ToolCardRendererRegistry()
    empty.register({ phase: 'call', card: 'generic' }, () => [])
    expect(empty.renderSafe({ ...base, presentation: vocabulary[0] })[0])
      .toBe('Tool shell · running')

    const absent = new ToolCardRendererRegistry()
    absent.register({ phase: 'call', card: 'generic' }, () => undefined)
    expect(absent.renderSafe({ ...base, presentation: vocabulary[0] })[0])
      .toBe('Tool shell · running')

    const whitespace = new ToolCardRendererRegistry()
    whitespace.register({ phase: 'call', card: 'generic' }, () => ['   '])
    expect(whitespace.renderSafe({ ...base, presentation: vocabulary[0] })[0])
      .toBe('Tool shell · running')

    const invalid = new ToolCardRendererRegistry()
    invalid.register(
      { phase: 'call', card: 'generic' },
      () => [1] as unknown as readonly string[],
    )
    expect(invalid.renderSafe({ ...base, presentation: vocabulary[0] })[0])
      .toBe('Tool shell · running')

    const throwing = new ToolCardRendererRegistry()
    throwing.register({ phase: 'call', card: 'generic' }, () => {
      throw new Error('renderer failed')
    })
    expect(throwing.renderSafe({ ...base, presentation: vocabulary[0] })[0])
      .toBe('Tool shell · running')
  })

  it('serializes circular, deep, primitive, function, and accessor values safely', () => {
    const registry = new ToolCardRendererRegistry()
    function namedFunction() {}
    const anonymousFunction = function () {}
    Object.defineProperty(anonymousFunction, 'name', { value: '' })

    let getterCalls = 0
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'must-not-be-read'
      },
    })

    const circular: Record<string, unknown> = { label: 'root' }
    circular.self = circular

    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let index = 0; index < 7; index += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }

    const renderArguments = (argumentsValue: unknown) => registry.renderSafe({
      phase: 'result',
      toolName: 'inspect',
      status: 'done',
      width: 16_384,
      arguments: argumentsValue,
      result: 'ok',
    }).join('\n')

    const primitives = renderArguments({
      nil: null,
      enabled: true,
      count: 7,
      big: 12n,
      missing: undefined,
      marker: Symbol('marker'),
      namedFunction,
      anonymousFunction,
      accessor,
    })
    expect(primitives).toContain('"nil":null')
    expect(primitives).toContain('"enabled":true')
    expect(primitives).toContain('"count":7')
    expect(primitives).toContain('"big":"12n"')
    expect(primitives).toContain('"missing":"[undefined]"')
    expect(primitives).toContain('"marker":"Symbol(marker)"')
    expect(primitives).toContain('"namedFunction":"[Function namedFunction]"')
    expect(primitives).toContain('"anonymousFunction":"[Function anonymous]"')
    expect(primitives).toContain('"value":"[Accessor]"')
    expect(getterCalls).toBe(0)

    expect(renderArguments(circular)).toContain('"self":"[Circular]"')
    expect(renderArguments(deep)).toContain('[Max depth]')
  })

  it('bounds arrays and survives sparse, accessor, unreadable, and hostile proxy values', () => {
    const registry = new ToolCardRendererRegistry()
    let arrayGetterCalls = 0
    const accessorArray: unknown[] = []
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      configurable: true,
      get() {
        arrayGetterCalls += 1
        return 'must-not-be-read'
      },
    })
    const unreadableArray = new Proxy(['secret'], {
      getOwnPropertyDescriptor(target, property) {
        if (property === '0') throw new Error('descriptor denied')
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })

    const arrays = registry.renderSafe({
      phase: 'result',
      toolName: 'inspect',
      status: 'done',
      width: 16_384,
      arguments: {
        dense: [1],
        sparse: new Array(1),
        accessor: accessorArray,
        unreadable: unreadableArray,
        bounded: Array.from({ length: 34 }, (_, index) => index),
      },
      result: 'ok',
    }).join('\n')
    expect(arrays).toContain('[Accessor or missing item]')
    expect(arrays).toContain('[Unreadable item]')
    expect(arrays).toContain('… 2 more items')
    expect(arrayGetterCalls).toBe(0)

    const ownKeysFailure = new Proxy({}, {
      ownKeys() {
        throw new Error('keys denied')
      },
    })
    expect(registry.renderSafe({
      phase: 'result',
      toolName: 'inspect',
      status: 'done',
      width: 256,
      arguments: ownKeysFailure,
      result: 'ok',
    }).join('\n')).toContain('[Unserializable object]')

    let descriptorCalls = 0
    const descriptorFailure = new Proxy({}, {
      ownKeys: () => ['value'],
      getOwnPropertyDescriptor() {
        descriptorCalls += 1
        if (descriptorCalls === 1) {
          return { configurable: true, enumerable: true, value: 'safe' }
        }
        throw new Error('descriptor denied')
      },
    })
    expect(registry.renderSafe({
      phase: 'result',
      toolName: 'inspect',
      status: 'done',
      width: 256,
      arguments: descriptorFailure,
      result: 'ok',
    }).join('\n')).toContain('[Unreadable property]')

    let ownKeysCalls = 0
    const totalFailure = new Proxy({}, {
      ownKeys() {
        ownKeysCalls += 1
        if (ownKeysCalls === 1) return ['value']
        throw new Error('total denied')
      },
      getOwnPropertyDescriptor() {
        return { configurable: true, enumerable: true, value: 'retained' }
      },
    })
    expect(registry.renderSafe({
      phase: 'result',
      toolName: 'inspect',
      status: 'done',
      width: 256,
      arguments: totalFailure,
      result: 'ok',
    }).join('\n')).toContain('"value":"retained"')

    let missingDescriptorCalls = 0
    const missingDescriptor = new Proxy({}, {
      ownKeys: () => ['value'],
      getOwnPropertyDescriptor() {
        missingDescriptorCalls += 1
        return missingDescriptorCalls === 1
          ? { configurable: true, enumerable: true, value: 'safe' }
          : undefined
      },
    })
    expect(registry.renderSafe({
      phase: 'result',
      toolName: 'inspect',
      status: 'done',
      width: 256,
      arguments: missingDescriptor,
      result: 'ok',
    }).join('\n')).toContain('[Accessor]')

    const manyProperties = Object.fromEntries(
      Array.from({ length: 34 }, (_, index) => [`key${index}`, index]),
    )
    expect(registry.renderSafe({
      phase: 'result',
      toolName: 'inspect',
      status: 'done',
      width: 16_384,
      arguments: manyProperties,
      result: 'ok',
    }).join('\n')).toContain('"…":"2 more properties"')
  })

  it('handles malformed JSON, oversized strings, absent fields, and invalid widths', () => {
    const registry = new ToolCardRendererRegistry()
    const malformed = registry.renderSafe({
      phase: 'call',
      toolName: '',
      status: 'running',
      width: 80,
      arguments: '{broken',
    })
    expect(malformed).toEqual([
      'Tool unknown · running',
      'Arguments: {broken',
    ])

    expect(registry.renderSafe({
      phase: 'call',
      toolName: 'inspect',
      status: 'running',
      width: 80,
      arguments: '[1]',
    }).join('\n')).toContain('Arguments: [')

    expect(registry.renderSafe({
      phase: 'call',
      toolName: 'inspect',
      status: 'running',
      width: 100_000,
      arguments: `head${'x'.repeat(65_536)}tail`,
    }).join('\n')).toMatch(/\d+ code units hidden/u)

    expect(registry.renderSafe({
      phase: 'call',
      toolName: '',
      status: 'running',
      width: 80,
    })).toEqual([
      'Tool unknown · running',
      'Arguments: (none)',
    ])

    expect(registry.renderSafe({
      phase: 'result',
      toolName: 'inspect',
      status: 'done',
      width: 80,
    })).toEqual([
      'Tool inspect · done',
      'Result: (none)',
    ])

    const invalidWidth = new ToolCardRendererRegistry()
    invalidWidth.register({ phase: 'call', card: 'generic' }, () => ['X', 'Y'])
    const invalidWidthLines = invalidWidth.renderSafe({
      phase: 'call',
      toolName: 'inspect',
      status: 'running',
      width: Number.NaN,
      presentation: vocabulary[0],
    })
    expect(invalidWidthLines).toEqual(['X', 'Y'])
    for (const line of invalidWidthLines) expect(visibleWidth(line)).toBeLessThanOrEqual(1)
  })

  it('preserves explicit blank paragraphs from a valid renderer', () => {
    const registry = new ToolCardRendererRegistry()
    registry.register(
      { phase: 'call', card: 'diff' },
      () => ['Header', 'before\n\nafter'],
    )
    expect(registry.renderSafe({
      phase: 'call',
      toolName: 'write',
      status: 'running',
      width: 80,
      presentation: vocabulary[2],
    })).toEqual(['Header', 'before', '', 'after'])
  })

  it('redacts sensitive values and bounds sanitized fallback output by cells and body lines', () => {
    const registry = new ToolCardRendererRegistry()
    const result = Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n')
      + '\x1b[31mred\x1b[0m\x1b]52;c;owned\x07\u0000'
    const lines = registry.renderSafe({
      phase: 'result',
      toolName: 'unsafe\x1b[2J-tool',
      status: 'failed',
      width: 32,
      presentation: undefined,
      arguments: JSON.stringify({
        password: 'visible-secret',
        nested: { api_key: 'nested-secret' },
      }),
      result,
      error: { authorization: 'Bearer secret', code: 'FAILED' },
    })

    expect(lines[0]).toBe('Tool unsafe-tool · failed')
    expect(lines.join('\n')).not.toContain('visible-secret')
    expect(lines.join('\n')).not.toContain('nested-secret')
    expect(lines.join('\n')).not.toContain('Bearer secret')
    expect(lines.join('\n')).not.toContain('\x1b')
    expect(lines.join('\n')).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u)
    expect(lines.join('\n')).toContain('line-0')
    expect(lines.join('\n')).toContain('line-19')
    expect(lines.join('\n')).toMatch(/\d+ lines hidden/u)
    expect(lines.length - 1).toBeLessThanOrEqual(8)
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(32)
  })

  it('applies the same safety boundary to specialized renderer output', () => {
    const registry = new ToolCardRendererRegistry()
    registry.register(
      { phase: 'result', card: 'terminal' },
      () => [
        '\x1b[31mTerminal\x1b[0m',
        ...Array.from({ length: 20 }, (_, index) => `output-${index}`),
      ],
    )

    const lines = registry.renderSafe({
      phase: 'result',
      toolName: 'shell',
      status: 'done',
      width: 16,
      presentation: vocabulary[4],
      result: 'ignored by specialized renderer',
    })
    expect(lines[0]).toBe('Terminal')
    expect(lines.join('\n')).toContain('output-0')
    expect(lines.join('\n')).toContain('output-19')
    expect(lines.join('\n')).toMatch(/lines hidden/u)
    expect(lines.length - 1).toBeLessThanOrEqual(8)
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(16)
  })

  it('lets an effect owner hold registration lifetime without importing Cordis', () => {
    let cleanup: (() => void) | undefined
    let label: string | undefined
    const owner: ToolCardRendererEffectOwner = {
      effect(setup, effectLabel) {
        cleanup = setup()
        label = effectLabel
        return () => cleanup?.()
      },
    }
    const registry = new ToolCardRendererRegistry()
    installToolCardRenderer(
      owner,
      registry,
      { phase: 'call', card: 'terminal' },
      () => ['rich terminal'],
    )

    const request = {
      phase: 'call' as const,
      toolName: 'shell',
      status: 'running' as const,
      width: 80,
      presentation: vocabulary[1],
      arguments: { command: 'pnpm test' },
    }
    expect(label).toBe('dsh-tui:tool-card-renderer:call:terminal')
    expect(registry.renderSafe(request)).toEqual(['rich terminal'])
    cleanup?.()
    cleanup?.()
    expect(registry.renderSafe(request)[0]).toBe('Tool shell · running')
  })
})
