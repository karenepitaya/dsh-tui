import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { renderStatusFrame, statusDetailViewport } from '../src/ui/workspace-status.ts'
import { formatRetryDelay } from '../src/ui/workspace-request-recovery.ts'

const chain = { retryId: 'tail-retry-id', turn: 1, step: 1, phase: 'failed' as const,
  provider: 'provider', mode: 'normal' as const, policyKey: 'normal', attempts: [{
    retry: 1, scheduledSeq: 1, scheduledAt: 1, delayMs: 10,
    failure: { code: 'FAIL', message: '很长的失败原因'.repeat(40) + 'MESSAGE-END' },
  }] }
const epoch = { headerSeq: 1, headerTime: 1, reason: 'initial' as const,
  config: { provider: 'provider', model: '很长的模型标识'.repeat(40) + 'MODEL-END' } }

const projection = {
  sessionId: 'session-a',
  context: { available: false },
  attempts: { chains: [chain] },
  routes: { epochs: [epoch] },
}

describe('status page inspector reachability', () => {
  it('keeps empty sections explicit and leaves unused rows blank', () => {
    const empty = {
      sessionId: 'session-a',
      context: { available: false },
    }
    for (const columns of [80, 100]) {
      const viewport = { columns, rows: 20 }
      const frame = renderStatusFrame(empty, viewport)
      expect(frame.lines.join('\n')).toContain('Token meter offline')
      expect(frame.lines.join('\n')).toContain('No provider recovery has been scheduled.')
      expect(frame.lines.join('\n')).toContain('Send a prompt to materialize the official route.')
      expect(frame.lines).toHaveLength(viewport.rows)
    }
    expect(formatRetryDelay(12_000)).toBe('12s')
  })

  it('renders a series-boundary epoch with its own label', () => {
    const seriesEpoch = { headerSeq: 2, headerTime: 2, reason: 'series' as const,
      config: { provider: 'provider', model: 'model' } }
    const frame = renderStatusFrame({
      sessionId: 'session-a',
      context: { available: false },
      routes: { epochs: [seriesEpoch] },
    }, { columns: 100, rows: 30 })
    expect(frame.lines.join('\n')).toContain('SERIES')
  })

  it('reaches every long detail line by scrolling the merged document', () => {
    const viewport = { columns: 80, rows: 9 }
    const viewportInfo = statusDetailViewport(projection, viewport, 0)
    expect(viewportInfo.maxOffset).toBeGreaterThan(0)
    let combined = ''
    for (let offset = 0; offset <= viewportInfo.maxOffset; offset += 1) {
      const frame = renderStatusFrame(projection, viewport, offset)
      combined += frame.lines.join('\n')
      expect(frame.lines).toHaveLength(viewport.rows)
      expect(frame.lines.every(line => visibleWidth(line) <= viewport.columns)).toBe(true)
    }
    expect(combined).toContain('MESSAGE-END')
    expect(combined).toContain('tail-retry-id')
    expect(combined).toContain('MODEL-END')
    expect(combined).toContain('Authority')
    expect(combined).toContain('State  CURRENT')
  })
})
