import { truncateToWidth } from "@earendil-works/pi-tui";
import { prepareAdaptiveFrames, type PreparedAdaptiveFrames, type PreparedFrame } from "./frame-set.js";
import type { MotionHost } from "./motion-host.js";
import type { AdaptiveFrames, MotionComponent, MotionLease } from "./types.js";

export interface AnimatedFramesOptions {
  readonly frames: AdaptiveFrames;
  readonly intervalMs?: number;
  readonly autoplay?: boolean;
  readonly styleLine?: (line: string, row: number) => string;
}

export class AnimatedFrames implements MotionComponent {
  readonly #host: MotionHost;
  #intervalMs: number;
  readonly #styleLine: ((line: string, row: number) => string) | undefined;
  #frames: PreparedAdaptiveFrames;
  #lease: MotionLease | undefined;
  #phaseOffsetMs = 0;
  #running = false;
  #disposed = false;

  constructor(host: MotionHost, options: AnimatedFramesOptions) {
    if (!Number.isFinite(options.intervalMs ?? 80) || (options.intervalMs ?? 80) <= 0) {
      throw new RangeError("Motion interval must be a positive finite number.");
    }
    this.#host = host;
    this.#intervalMs = options.intervalMs ?? 80;
    this.#styleLine = options.styleLine;
    this.#frames = prepareAdaptiveFrames(options.frames);
    if (options.autoplay === true) this.start();
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#disposed) throw new Error("Motion component has been disposed.");
    if (this.#running) return;
    this.#phaseOffsetMs = 0;
    this.#running = true;
    try {
      this.#lease = this.#host.retain(this.#intervalMs);
    } catch (error) {
      this.#running = false;
      throw error;
    }
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    const lease = this.#lease;
    this.#lease = undefined;
    lease?.release();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
  }

  invalidate(): void {
    // Frames are time-derived and uncached; pi-tui may still call this method.
  }

  render(width: number): string[] {
    return this.currentFrameLines().map((line, row) => this.renderLine(line, row, width));
  }

  protected currentFrameLines(): PreparedFrame {
    const group = this.#host.glyphs === "ascii" ? this.#frames.ascii : this.#frames.unicode;
    if (this.#host.motion === "reduced" || !this.#running || this.#lease === undefined) {
      return group.reduced;
    }

    const elapsedMs = this.#phaseOffsetMs + Math.max(0, this.#host.now() - this.#lease.startedAt);
    const index = Math.floor(elapsedMs / this.#intervalMs) % group.frames.length;
    return group.frames[index] ?? group.reduced;
  }

  protected renderLine(line: string, row: number, width: number): string {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return "";
    const styled = this.#styleLine?.(line, row) ?? line;
    return truncateToWidth(styled, safeWidth, "");
  }

  protected replaceFrames(frames: AdaptiveFrames): void {
    this.#frames = prepareAdaptiveFrames(frames);
    this.#host.requestRender();
  }

  protected replaceIntervalMs(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError("Motion interval must be a positive finite number.");
    }
    if (intervalMs === this.#intervalMs) return;

    if (!this.#running || this.#lease === undefined) {
      this.#intervalMs = intervalMs;
      this.#host.requestRender();
      return;
    }

    const elapsedMs = this.#phaseOffsetMs + Math.max(0, this.#host.now() - this.#lease.startedAt);
    const framePosition = elapsedMs / this.#intervalMs;
    const previousLease = this.#lease;
    this.#lease = undefined;
    previousLease.release();
    this.#intervalMs = intervalMs;
    this.#phaseOffsetMs = framePosition * intervalMs;

    try {
      this.#lease = this.#host.retain(this.#intervalMs);
    } catch (error) {
      this.#running = false;
      throw error;
    }
  }

  protected requestRender(): void {
    this.#host.requestRender();
  }
}
