import {
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { MotionHost } from "./motion-host.js";
import type { OrbSpeed } from "./presets/orbs.js";
import {
  SHIMMER_TICK_MS,
  SHIMMER_VELOCITIES,
  shimmerDirectionalEnergyAt,
  shimmerFrameAt,
  type ShimmerCurve,
  type ShimmerDirection,
  type ShimmerLoop,
} from "./presets/shimmer.js";
import {
  colorizeHexText,
  interpolateHexColor,
  ORB_THEMES,
  type OrbThemeName,
} from "./themes.js";
import type { MotionComponent, MotionLease } from "./types.js";

export type ShimmerState = "idle" | "running" | "paused" | "finished";

export interface ShimmerTextOptions {
  readonly text?: string;
  readonly active?: boolean;
  readonly theme?: OrbThemeName;
  readonly speed?: OrbSpeed;
  readonly direction?: ShimmerDirection;
  readonly loop?: ShimmerLoop;
  readonly curve?: ShimmerCurve;
  readonly bandWidth?: number;
  readonly trailLength?: number;
  readonly holdMs?: number;
  readonly baseBrightness?: number;
  readonly shimmerBrightness?: number;
  /** @deprecated Use `shimmerBrightness` instead. */
  readonly intensity?: number;
}

const MIN_BAND_WIDTH = 1;
const MAX_BAND_WIDTH = 8;
const MIN_TRAIL_LENGTH = 2;
const MAX_TRAIL_LENGTH = 32;
const MAX_HOLD_MS = 2_000;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function sanitizeText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, " ");
}

function validateBandWidth(bandWidth: number): number {
  if (!Number.isFinite(bandWidth) || bandWidth < MIN_BAND_WIDTH || bandWidth > MAX_BAND_WIDTH) {
    throw new RangeError(
      `Shimmer band width must be from ${MIN_BAND_WIDTH} to ${MAX_BAND_WIDTH} terminal cells.`,
    );
  }
  return bandWidth;
}

function validateBrightness(brightness: number, label: string): number {
  if (!Number.isFinite(brightness) || brightness < 0 || brightness > 1) {
    throw new RangeError(`${label} must be from 0 to 1.`);
  }
  return brightness;
}

function validateTrailLength(trailLength: number): number {
  if (
    !Number.isFinite(trailLength)
    || trailLength < MIN_TRAIL_LENGTH
    || trailLength > MAX_TRAIL_LENGTH
  ) {
    throw new RangeError(
      `Shimmer trail length must be from ${MIN_TRAIL_LENGTH} to ${MAX_TRAIL_LENGTH} terminal cells.`,
    );
  }
  return trailLength;
}

function validateHoldMs(holdMs: number): number {
  if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > MAX_HOLD_MS) {
    throw new RangeError(`Shimmer hold must be from 0 to ${MAX_HOLD_MS} milliseconds.`);
  }
  return holdMs;
}

function shimmerColor(
  palette: (typeof ORB_THEMES)[OrbThemeName],
  energy: number,
  baseBrightness: number,
  shimmerBrightness: number,
): string {
  const base = interpolateHexColor(palette.muted, palette.label, baseBrightness);
  const contrast = Math.max(0, Math.min(1, energy * shimmerBrightness));
  if (contrast <= 0.72) {
    return interpolateHexColor(base, palette.core, contrast / 0.72);
  }
  return interpolateHexColor(palette.core, palette.label, (contrast - 0.72) / 0.28);
}

export class ShimmerText implements MotionComponent {
  readonly #host: MotionHost;
  #text: string;
  #theme: OrbThemeName;
  #speed: OrbSpeed;
  #direction: ShimmerDirection;
  #loop: ShimmerLoop;
  #curve: ShimmerCurve;
  #bandWidth: number;
  #trailLength: number;
  #holdMs: number;
  #baseBrightness: number;
  #shimmerBrightness: number;
  #lastTrackWidth: number | undefined;
  #state: ShimmerState = "idle";
  #elapsedBeforeRun = 0;
  #anchorAt = 0;
  #lease: MotionLease | undefined;
  #leaseDeadlineAt: number | undefined;
  #disposed = false;

  constructor(host: MotionHost, options: ShimmerTextOptions = {}) {
    this.#host = host;
    this.#text = sanitizeText(options.text ?? "");
    this.#theme = options.theme ?? "openai";
    this.#speed = options.speed ?? "normal";
    this.#direction = options.direction ?? "left-to-right";
    this.#loop = options.loop ?? "wrap";
    this.#curve = options.curve ?? "soft";
    this.#bandWidth = validateBandWidth(options.bandWidth ?? 2);
    this.#trailLength = validateTrailLength(options.trailLength ?? 12);
    this.#holdMs = validateHoldMs(options.holdMs ?? 600);
    this.#baseBrightness = validateBrightness(
      options.baseBrightness ?? 0.10,
      "Shimmer base brightness",
    );
    this.#shimmerBrightness = validateBrightness(
      options.shimmerBrightness ?? options.intensity ?? 0.90,
      "Shimmer brightness",
    );
    this.#anchorAt = host.now();
    if (options.active === true) this.start();
  }

  get running(): boolean {
    return this.#state === "running";
  }

  get state(): ShimmerState {
    return this.#state;
  }

  get text(): string {
    return this.#text;
  }

  get theme(): OrbThemeName {
    return this.#theme;
  }

  get speed(): OrbSpeed {
    return this.#speed;
  }

  get direction(): ShimmerDirection {
    return this.#direction;
  }

  get loop(): ShimmerLoop {
    return this.#loop;
  }

  get curve(): ShimmerCurve {
    return this.#curve;
  }

  get bandWidth(): number {
    return this.#bandWidth;
  }

  get trailLength(): number {
    return this.#trailLength;
  }

  get holdMs(): number {
    return this.#holdMs;
  }

  /** @deprecated Use `shimmerBrightness` instead. */
  get intensity(): number {
    return this.#shimmerBrightness;
  }

  get baseBrightness(): number {
    return this.#baseBrightness;
  }

  get shimmerBrightness(): number {
    return this.#shimmerBrightness;
  }

  start(): void {
    this.#assertAvailable();
    if (this.#state === "running") return;
    if (this.#state === "paused") {
      this.resume();
      return;
    }
    this.restart();
  }

  restart(): void {
    this.#assertAvailable();
    this.#releaseLease();
    this.#elapsedBeforeRun = 0;
    this.#anchorAt = this.#host.now();
    this.#state = "running";
    this.#syncLease();
    this.#host.requestRender();
  }

  pause(): void {
    if (this.#state !== "running") return;
    this.#elapsedBeforeRun = this.#elapsedAt(this.#host.now());
    this.#state = "paused";
    this.#releaseLease();
    this.#host.requestRender();
  }

  resume(): void {
    this.#assertAvailable();
    if (this.#state !== "paused") return;
    this.#anchorAt = this.#host.now();
    this.#state = "running";
    this.#syncLease();
    this.#host.requestRender();
  }

  stop(): void {
    if (this.#state === "idle") return;
    this.#releaseLease();
    this.#elapsedBeforeRun = 0;
    this.#state = "idle";
    this.#host.requestRender();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#releaseLease();
    this.#state = "idle";
    this.#disposed = true;
  }

  invalidate(): void {
    // Rendering is time-derived and uncached.
  }

  setText(text: string): void {
    const sanitized = sanitizeText(text);
    if (sanitized === this.#text) return;
    this.#text = sanitized;
    this.#lastTrackWidth = undefined;
    this.#resetTimeline();
    this.#syncLease();
    this.#host.requestRender();
  }

  setActive(active: boolean): void {
    if (active) this.start();
    else this.stop();
  }

  setTheme(theme: OrbThemeName): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    this.#host.requestRender();
  }

  setSpeed(speed: OrbSpeed): void {
    if (speed === this.#speed) return;
    const now = this.#host.now();
    const elapsed = this.#elapsedAt(now);
    this.#elapsedBeforeRun = this.#remapElapsedForSpeed(
      elapsed,
      SHIMMER_VELOCITIES[this.#speed],
      SHIMMER_VELOCITIES[speed],
    );
    this.#anchorAt = now;
    this.#speed = speed;
    if (this.#leaseDeadlineAt !== undefined) {
      this.#releaseLease();
      this.#syncLease();
    }
    this.#host.requestRender();
  }

  setDirection(direction: ShimmerDirection): void {
    if (direction === this.#direction) return;
    this.#direction = direction;
    this.#resetTimeline();
    this.#host.requestRender();
  }

  setLoop(loop: ShimmerLoop): void {
    if (loop === this.#loop) return;
    this.#loop = loop;
    this.#resetTimeline();
    this.#syncLease();
    this.#host.requestRender();
  }

  setCurve(curve: ShimmerCurve): void {
    if (curve === this.#curve) return;
    this.#curve = curve;
    this.#resetTimeline();
    this.#host.requestRender();
  }

  setBandWidth(bandWidth: number): void {
    const validated = validateBandWidth(bandWidth);
    if (validated === this.#bandWidth) return;
    this.#bandWidth = validated;
    this.#resetTimeline();
    this.#syncLease();
    this.#host.requestRender();
  }

  setTrailLength(trailLength: number): void {
    const validated = validateTrailLength(trailLength);
    if (validated === this.#trailLength) return;
    this.#trailLength = validated;
    this.#resetTimeline();
    this.#syncLease();
    this.#host.requestRender();
  }

  setHoldMs(holdMs: number): void {
    const validated = validateHoldMs(holdMs);
    if (validated === this.#holdMs) return;
    this.#holdMs = validated;
    this.#resetTimeline();
    this.#syncLease();
    this.#host.requestRender();
  }

  /** @deprecated Use `setShimmerBrightness()` instead. */
  setIntensity(intensity: number): void {
    this.setShimmerBrightness(intensity);
  }

  setBaseBrightness(baseBrightness: number): void {
    const validated = validateBrightness(baseBrightness, "Shimmer base brightness");
    if (validated === this.#baseBrightness) return;
    this.#baseBrightness = validated;
    this.#host.requestRender();
  }

  setShimmerBrightness(shimmerBrightness: number): void {
    const validated = validateBrightness(shimmerBrightness, "Shimmer brightness");
    if (validated === this.#shimmerBrightness) return;
    const wasDisabled = this.#shimmerBrightness === 0;
    this.#shimmerBrightness = validated;
    if (wasDisabled && validated > 0) this.#resetTimeline();
    this.#syncLease();
    this.#host.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) {
      this.#lastTrackWidth = undefined;
      if (this.#state === "running" && this.#loop === "once") this.#finishOnce(0);
      else this.#releaseLease();
      return [""];
    }
    const lines = wrapTextWithAnsi(this.#text, safeWidth);
    const lineWidths = lines.map((line) => visibleWidth(line));
    const trackWidth = Math.max(1, ...lineWidths);
    this.#lastTrackWidth = trackWidth;
    if (this.#state === "running" && this.#loop !== "once") this.#syncLease();
    if (!this.#canRenderBase()) {
      if (this.#state === "running" && this.#loop === "once") this.#finishOnce(0);
      return lines;
    }
    if (this.#state !== "running" && this.#state !== "paused") return lines;

    let frame: ReturnType<typeof shimmerFrameAt> | undefined;
    if (this.#canAnimateFrame()) {
      const now = this.#host.now();
      const elapsed = this.#elapsedAt(now);
      frame = shimmerFrameAt(elapsed, {
        trackWidth,
        velocity: SHIMMER_VELOCITIES[this.#speed],
        coreWidth: this.#bandWidth,
        trailLength: this.#trailLength,
        holdMs: this.#holdMs,
        direction: this.#direction,
        loop: this.#loop,
        curve: this.#curve,
      });
      if (frame.finished) {
        this.#finishOnce(elapsed);
        return lines;
      }
      if (this.#state === "running" && this.#loop === "once") {
        this.#armOnceDeadline(trackWidth, elapsed, now);
      }
    }

    const palette = ORB_THEMES[this.#theme];
    return lines.map((line, lineIndex) => {
      const lineWidth = lineWidths[lineIndex] ?? 0;
      if (lineWidth === 0) return line;
      let column = 0;
      let output = "";
      let runText = "";
      let runColor = "";
      for (const { segment } of graphemeSegmenter.segment(line)) {
        const segmentWidth = Math.max(0, visibleWidth(segment));
        const center = column + (segmentWidth / 2);
        column += segmentWidth;
        const energy = frame?.active === true
          ? shimmerDirectionalEnergyAt(
            center,
            frame.beamCenter,
            frame.heading,
            this.#bandWidth,
            this.#trailLength,
            "soft",
          )
          : 0;
        const color = shimmerColor(
          palette,
          energy,
          this.#baseBrightness,
          this.#shimmerBrightness,
        );
        if (color === runColor) {
          runText += segment;
          continue;
        }
        if (runText.length > 0) output += colorizeHexText(runText, runColor);
        runText = segment;
        runColor = color;
      }
      if (runText.length > 0) output += colorizeHexText(runText, runColor);
      return output;
    });
  }

  #elapsedAt(now: number): number {
    if (this.#state !== "running") return this.#elapsedBeforeRun;
    return this.#elapsedBeforeRun + Math.max(0, now - this.#anchorAt);
  }

  #resetTimeline(): void {
    const hadDeadline = this.#leaseDeadlineAt !== undefined;
    if (hadDeadline) this.#releaseLease();
    this.#elapsedBeforeRun = 0;
    this.#anchorAt = this.#host.now();
    if (this.#state === "finished") this.#state = "idle";
    if (hadDeadline) this.#syncLease();
  }

  #remapElapsedForSpeed(
    elapsed: number,
    previousVelocity: number,
    nextVelocity: number,
  ): number {
    const extent = Math.max(this.#bandWidth, this.#trailLength);
    const distance = (this.#lastTrackWidth ?? 1) + (2 * extent);
    const previousTravelMs = (distance / previousVelocity) * 1_000;
    const nextTravelMs = (distance / nextVelocity) * 1_000;

    if (this.#loop === "once") {
      return Math.min(1, elapsed / previousTravelMs) * nextTravelMs;
    }

    const previousLegMs = previousTravelMs + this.#holdMs;
    const nextLegMs = nextTravelMs + this.#holdMs;
    const legIndex = Math.floor(elapsed / previousLegMs);
    const legElapsed = elapsed - (legIndex * previousLegMs);
    const remappedLegElapsed = legElapsed < previousTravelMs
      ? (legElapsed / previousTravelMs) * nextTravelMs
      : nextTravelMs + (legElapsed - previousTravelMs);
    return (legIndex * nextLegMs) + remappedLegElapsed;
  }

  #canRenderBase(): boolean {
    return (
      this.#text.length > 0
      && this.#host.motion === "full"
      && this.#host.color === "always"
    );
  }

  #canAnimateFrame(): boolean {
    return this.#canRenderBase() && this.#shimmerBrightness > 0;
  }

  #syncLease(): void {
    if (
      this.#state !== "running"
      || this.#lastTrackWidth === undefined
      || !this.#canAnimateFrame()
    ) {
      this.#releaseLease();
      return;
    }
    if (this.#loop === "once") {
      if (this.#leaseDeadlineAt === undefined) {
        const now = this.#host.now();
        this.#armOnceDeadline(this.#lastTrackWidth, this.#elapsedAt(now), now);
      }
      return;
    }
    if (this.#lease !== undefined) return;
    try {
      this.#lease = this.#host.retain(SHIMMER_TICK_MS);
    } catch (error) {
      this.#state = "idle";
      throw error;
    }
  }

  #releaseLease(): void {
    const lease = this.#lease;
    this.#lease = undefined;
    this.#leaseDeadlineAt = undefined;
    lease?.release();
  }

  #armOnceDeadline(trackWidth: number, elapsed: number, now: number): void {
    const extent = Math.max(this.#bandWidth, this.#trailLength);
    const travelMs = ((trackWidth + (2 * extent)) / SHIMMER_VELOCITIES[this.#speed]) * 1_000;
    const remainingMs = travelMs - elapsed;
    if (remainingMs <= 0) {
      this.#finishOnce(travelMs);
      return;
    }

    const deadlineAt = now + remainingMs;
    if (
      this.#lease !== undefined
      && this.#leaseDeadlineAt !== undefined
      && Math.abs(this.#leaseDeadlineAt - deadlineAt) < 0.5
    ) return;

    this.#releaseLease();
    this.#leaseDeadlineAt = deadlineAt;
    try {
      this.#lease = this.#host.retain(SHIMMER_TICK_MS, {
        expiresAt: deadlineAt,
        onExpire: () => {
          if (this.#leaseDeadlineAt !== deadlineAt || this.#state !== "running") return;
          this.#lease = undefined;
          this.#leaseDeadlineAt = undefined;
          this.#elapsedBeforeRun = travelMs;
          this.#state = "finished";
        },
      });
    } catch (error) {
      this.#leaseDeadlineAt = undefined;
      this.#state = "idle";
      throw error;
    }
  }

  #finishOnce(elapsed: number): void {
    this.#elapsedBeforeRun = elapsed;
    this.#state = "finished";
    this.#releaseLease();
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error("Motion component has been disposed.");
  }
}
