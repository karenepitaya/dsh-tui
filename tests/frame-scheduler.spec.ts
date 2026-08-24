import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FrameScheduler,
  type FrameInvalidationPriority,
} from '../src/ui/frame-scheduler.ts'
import type { UiFrame } from '../src/ui/frame.ts'

function frame(version: number): UiFrame {
  return {
    title: 'DSH-TUI',
    viewport: { columns: version, rows: 1 },
    lines: [String(version)],
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('FrameScheduler', () => {
  it('coalesces a burst into one frame built from the latest state', () => {
    vi.useFakeTimers()
    let version = 0
    const rendered: UiFrame[] = []
    const scheduler = new FrameScheduler({
      buildFrame: () => frame(version),
      render: value => rendered.push(value),
      onFatal: vi.fn(),
    })

    for (let index = 1; index <= 100; index += 1) {
      version = index
      scheduler.invalidate()
    }

    expect(rendered).toEqual([])
    vi.advanceTimersByTime(15)
    expect(rendered).toEqual([])
    vi.advanceTimersByTime(1)
    expect(rendered).toEqual([frame(100)])
  })

  it('upgrades a pending coalesced timer to one immediate microtask', async () => {
    vi.useFakeTimers()
    const rendered: UiFrame[] = []
    const scheduler = new FrameScheduler({
      buildFrame: () => frame(1),
      render: value => rendered.push(value),
      onFatal: vi.fn(),
      frameIntervalMs: 50,
    })

    scheduler.invalidate('coalesced')
    scheduler.invalidate('immediate')
    scheduler.invalidate('coalesced')
    await Promise.resolve()

    expect(rendered).toEqual([frame(1)])
    vi.advanceTimersByTime(50)
    expect(rendered).toHaveLength(1)
  })

  it('queues only one successor when render invalidates repeatedly', async () => {
    vi.useFakeTimers()
    const priorities: FrameInvalidationPriority[] = ['coalesced', 'immediate']
    const rendered: UiFrame[] = []
    let scheduler: FrameScheduler
    scheduler = new FrameScheduler({
      buildFrame: () => frame(rendered.length + 1),
      render: value => {
        rendered.push(value)
        if (rendered.length === 1) {
          for (const priority of priorities) scheduler.invalidate(priority)
          scheduler.invalidate('immediate')
        }
      },
      onFatal: vi.fn(),
    })

    scheduler.invalidate('immediate')
    await Promise.resolve()
    await Promise.resolve()

    expect(rendered).toEqual([frame(1), frame(2)])
    vi.runAllTimers()
    expect(rendered).toHaveLength(2)
  })

  it('samples the newest viewport during a resize storm', async () => {
    vi.useFakeTimers()
    let columns = 80
    const rendered: UiFrame[] = []
    const scheduler = new FrameScheduler({
      buildFrame: () => frame(columns),
      render: value => rendered.push(value),
      onFatal: vi.fn(),
    })

    for (const next of [90, 100, 120]) {
      columns = next
      scheduler.invalidate('immediate')
    }
    await Promise.resolve()

    expect(rendered).toEqual([frame(120)])
  })

  it('cancels timers and guards queued microtasks after close', async () => {
    vi.useFakeTimers()
    const render = vi.fn()
    const scheduler = new FrameScheduler({
      buildFrame: () => frame(1),
      render,
      onFatal: vi.fn(),
    })

    scheduler.invalidate()
    scheduler.close()
    scheduler.close()
    vi.runAllTimers()

    scheduler.invalidate('immediate')
    await Promise.resolve()
    expect(render).not.toHaveBeenCalled()

    const queued = new FrameScheduler({
      buildFrame: () => frame(2),
      render,
      onFatal: vi.fn(),
    })
    queued.invalidate('immediate')
    queued.close()
    await Promise.resolve()
    expect(render).not.toHaveBeenCalled()
  })

  it('closes after a render failure and reports fatal exactly once', async () => {
    vi.useFakeTimers()
    const failure = new Error('render failed')
    const onFatal = vi.fn(() => {
      throw new Error('fatal callback failed')
    })
    const scheduler = new FrameScheduler({
      buildFrame: () => frame(1),
      render: () => {
        throw failure
      },
      onFatal,
    })

    scheduler.invalidate('immediate')
    await Promise.resolve()
    scheduler.invalidate('immediate')
    await Promise.resolve()

    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal).toHaveBeenCalledWith(failure)
  })

  it('treats frame construction failure as fatal and supports a zero delay', () => {
    vi.useFakeTimers()
    const failure = new Error('build failed')
    const onFatal = vi.fn()
    const scheduler = new FrameScheduler({
      buildFrame: () => {
        throw failure
      },
      render: vi.fn(),
      onFatal,
      frameIntervalMs: 0,
    })

    scheduler.invalidate()
    vi.runAllTimers()

    expect(onFatal).toHaveBeenCalledWith(failure)
  })
})
