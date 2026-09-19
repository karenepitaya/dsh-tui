import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { AttemptPanelView } from '../src/llm/attempts.ts'
import type { RoutePanelView } from '../src/llm/routes.ts'
import { formatRetryDelay, renderAttemptFrame } from '../src/ui/workspace-request-recovery.ts'
import { renderRouteFrame } from '../src/ui/workspace-model-route.ts'

const chain = { retryId: 'tail-retry-id', turn: 1, step: 1, phase: 'failed' as const,
  provider: 'provider', mode: 'normal' as const, policyKey: 'normal', attempts: [{
    retry: 1, scheduledSeq: 1, scheduledAt: 1, delayMs: 10,
    failure: { code: 'FAIL', message: '很长的失败原因'.repeat(40) + 'MESSAGE-END' },
  }] }
const attempt: AttemptPanelView = { rows: [chain], selectedIndex: 0, selected: chain,
  selectedAttemptIndex: 0, selectedAttempt: chain.attempts[0]!, omittedChainCount: 0 }
const epoch = { headerSeq: 1, headerTime: 1, reason: 'initial' as const,
  config: { provider: 'provider', model: '很长的模型标识'.repeat(40) + 'MODEL-END' } }
const route: RoutePanelView = { rows: [epoch], selectedIndex: 0, selected: epoch, omittedEpochCount: 0 }

describe('legacy inspector reachability', () => {
  it('keeps empty inspectors explicit and leaves unused rows blank in either layout', () => {
    const emptyAttempt: AttemptPanelView = { rows: [], selectedIndex: -1, selectedAttemptIndex: -1, omittedChainCount: 0 }
    const emptyRoute: RoutePanelView = { rows: [], selectedIndex: -1, omittedEpochCount: 0 }
    for (const columns of [80, 100]) {
      const viewport = { columns, rows: 20 }
      const recovery = renderAttemptFrame(emptyAttempt, viewport, { focus: 'details', detailOffset: 0 })
      const routes = renderRouteFrame(emptyRoute, viewport, { focus: 'details', detailOffset: 0 })
      expect(recovery.lines.join('\n')).toContain('No provider recovery has been scheduled.')
      expect(routes.lines.join('\n')).toContain('Send a prompt to materialize the official route.')
      expect(recovery.lines).toHaveLength(viewport.rows)
      expect(routes.lines).toHaveLength(viewport.rows)
    }
    expect(formatRetryDelay(12_000)).toBe('12s')
  })

  it('renders a series-boundary epoch with its own label', () => {
    const seriesEpoch = { headerSeq: 2, headerTime: 2, reason: 'series' as const,
      config: { provider: 'provider', model: 'model' } }
    const seriesRoute: RoutePanelView = {
      rows: [seriesEpoch], selectedIndex: 0, selected: seriesEpoch, omittedEpochCount: 0,
    }
    const frame = renderRouteFrame(seriesRoute, { columns: 100, rows: 20 }, { focus: 'details', detailOffset: 0 })
    expect(frame.lines.join('\n')).toContain('SERIES')
  })

  it('shows one active region below 100 columns and wraps every selected detail', () => {
    const viewport = { columns: 80, rows: 9 }
    expect(renderAttemptFrame(attempt, viewport).lines.join('\n')).not.toContain('Recovery path')
    expect(renderRouteFrame(route, viewport).lines.join('\n')).not.toContain('State  CURRENT')
    for (const [view, render] of [[attempt, renderAttemptFrame], [route, renderRouteFrame]] as const) {
      let combined = ''
      for (let detailOffset = 0; detailOffset < 100; detailOffset += 1) {
        const frame = render(view as AttemptPanelView & RoutePanelView, viewport, { focus: 'details', detailOffset })
        combined += frame.lines.join('\n')
        expect(frame.lines).toHaveLength(viewport.rows)
        expect(frame.lines.every(line => visibleWidth(line) <= viewport.columns)).toBe(true)
      }
      expect(combined).toContain(view === attempt ? 'MESSAGE-END' : 'MODEL-END')
      expect(combined).toContain(view === attempt ? 'tail-retry-id' : 'Authority')
    }
  })
})
