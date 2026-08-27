import { describe, expect, it } from 'vitest'
import { styleToolCardLines } from '../src/ui/tool-card-styling.ts'

describe('tool-card semantic styling', () => {
  it('styles line numbers and TypeScript tokens without trusting renderer ANSI', () => {
    const styled = styleToolCardLines({
      phase: 'result',
      card: 'read',
      path: 'src/a.ts',
      offset: 1,
      lines: [],
      totalLines: 4,
      lang: 'ts',
    }, [
      'File: src/a.ts',
      'Lines: 1-4 of 4 · ts',
      "1 │ const answer = 'yes' // kept",
      '2 │ return answer + 42',
      '…8 lines hidden',
    ])

    expect(styled).toHaveLength(5)
    expect(styled?.[0]?.segments).toEqual([
      { text: 'File: src/a.ts', tone: 'accent', bold: true },
    ])
    expect(styled?.[2]?.segments).toEqual(expect.arrayContaining([
      { text: '1 │ ', tone: 'muted' },
      { text: 'const', tone: 'accent', bold: true },
      { text: "'yes'", tone: 'success' },
      { text: '// kept', tone: 'muted' },
    ]))
    expect(styled?.[3]?.segments).toEqual(expect.arrayContaining([
      { text: 'return', tone: 'accent', bold: true },
      { text: '42', tone: 'warning' },
    ]))
    expect(styled?.[4]?.segments).toEqual([{ text: '…8 lines hidden', tone: 'muted' }])

    const edgeTokens = styleToolCardLines({
      phase: 'result', card: 'read', path: 'script.py', offset: 1,
      lines: [], totalLines: 3, lang: 'python',
    }, [
      '1 │ # comment',
      '2 │ value = "escaped \\" quote"',
      '3 │ ',
      'Metadata: plain',
    ])
    expect(edgeTokens?.[0]?.segments.at(-1)).toMatchObject({ tone: 'muted' })
    expect(edgeTokens?.[1]?.segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ tone: 'success' }),
    ]))
    expect(edgeTokens?.[2]?.segments.at(-1)).toEqual({ text: '', tone: 'code' })
    expect(edgeTokens?.[3]?.segments).toEqual([{ text: 'Metadata: plain', tone: 'primary' }])

    const inferred = styleToolCardLines({
      phase: 'result', card: 'read', path: 'script', offset: 1,
      lines: [], totalLines: 1,
    }, ['1 │ # inferred shell comment'])
    expect(inferred?.[0]?.segments.at(-1)).toMatchObject({ tone: 'muted' })
  })

  it('styles Markdown headings and unified diff semantics', () => {
    const markdown = styleToolCardLines({
      phase: 'result', card: 'read', path: 'README.md', offset: 1,
      lines: [], totalLines: 1, lang: 'md',
    }, ['1 │ # Heading'])
    expect(markdown?.[0]?.segments).toEqual([
      { text: '1 │ ', tone: 'muted' },
      { text: '# Heading', tone: 'accent', bold: true },
    ])

    const diff = styleToolCardLines({
      phase: 'result', card: 'diff', diffs: [],
    }, [
      'Update a.ts · -1 +1 lines',
      '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-old', '+new', ' same',
      '…12 lines hidden',
    ])
    expect(diff?.map(line => line.segments[0]?.tone)).toEqual([
      'telemetry', 'muted', 'muted', 'accent', 'error', 'success', 'code', 'muted',
    ])
    expect(styleToolCardLines(undefined, ['plain'])).toBeUndefined()
  })
})
