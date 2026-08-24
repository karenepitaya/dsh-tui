import { describe, expect, it } from 'vitest'
import { isToolPresentationView } from '../src/presentation/types.ts'

describe('ToolPresentationView guard boundaries', () => {
  it('rejects each invalid search header field before inspecting its shape', () => {
    expect(isToolPresentationView({
      phase: 'result',
      card: 'search',
      shape: 'paths',
      title: 1,
      truncated: false,
      total: 0,
      paths: [],
    })).toBe(false)
    expect(isToolPresentationView({
      phase: 'result',
      card: 'search',
      shape: 'paths',
      truncated: 'no',
      total: 0,
      paths: [],
    })).toBe(false)
    expect(isToolPresentationView({
      phase: 'result',
      card: 'search',
      shape: 'paths',
      truncated: false,
      total: -1,
      paths: [],
    })).toBe(false)
  })

  it('accepts read fallback content and rejects invalid web header fields', () => {
    expect(isToolPresentationView({
      phase: 'result',
      card: 'read',
      path: 'a.ts',
      offset: 1,
      lines: [],
      totalLines: 0,
      content: [],
    })).toBe(true)
    expect(isToolPresentationView({
      phase: 'result',
      card: 'web',
      kind: 'fetch',
      title: 1,
      url: 'https://example.test',
      statusCode: 200,
      truncated: false,
    })).toBe(false)
    expect(isToolPresentationView({
      phase: 'result',
      card: 'web',
      kind: 'fetch',
      url: 'https://example.test',
      statusCode: 200,
      truncated: 'no',
    })).toBe(false)
  })

  it('rejects an otherwise record-shaped value with an unknown phase', () => {
    expect(isToolPresentationView({ phase: 'future', card: 'generic' })).toBe(false)
  })
})
