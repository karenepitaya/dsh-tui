import type { UiFrame } from './frame.ts'

const DEFAULT_FRAME_INTERVAL_MS = 16

export type FrameInvalidationPriority = 'coalesced' | 'immediate'

export interface FrameSchedulerOptions {
  readonly buildFrame: () => UiFrame
  readonly render: (frame: UiFrame) => void
  readonly onFatal: (error: unknown) => void
  readonly frameIntervalMs?: number
}

type PendingPriority = FrameInvalidationPriority | 'none'

export class FrameScheduler {
  private readonly frameIntervalMs: number
  private dirty = false
  private priority: PendingPriority = 'none'
  private timer: ReturnType<typeof setTimeout> | undefined
  private microtaskScheduled = false
  private rendering = false
  private closed = false

  constructor(private readonly options: FrameSchedulerOptions) {
    this.frameIntervalMs = options.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS
  }

  invalidate(priority: FrameInvalidationPriority = 'coalesced'): void {
    if (this.closed) return
    this.dirty = true
    if (priority === 'immediate') {
      this.priority = 'immediate'
    } else if (this.priority === 'none') {
      this.priority = 'coalesced'
    }
    this.schedule()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.dirty = false
    this.priority = 'none'
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private schedule(): void {
    if (this.rendering) return
    if (this.priority === 'immediate') {
      if (this.timer !== undefined) {
        clearTimeout(this.timer)
        this.timer = undefined
      }
      if (this.microtaskScheduled) return
      this.microtaskScheduled = true
      queueMicrotask(() => {
        this.microtaskScheduled = false
        this.flush()
      })
      return
    }
    if (this.priority !== 'coalesced' || this.timer !== undefined
      || this.microtaskScheduled) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.frameIntervalMs)
    this.timer.unref?.()
  }

  private flush(): void {
    if (this.closed) return
    this.dirty = false
    this.priority = 'none'
    this.rendering = true
    try {
      this.options.render(this.options.buildFrame())
    } catch (error: unknown) {
      this.fail(error)
    } finally {
      this.rendering = false
      if (this.dirty) this.schedule()
    }
  }

  private fail(error: unknown): void {
    this.close()
    try {
      this.options.onFatal(error)
    } catch {
      // A fatal callback must not escape the queued timer or microtask.
    }
  }
}
