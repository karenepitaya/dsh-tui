import {
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { MotionHost } from "./motion-host.js";
import type { OrbSpeed } from "./presets/orbs.js";
import {
  SHIMMER_PERIODS,
  SHIMMER_TICK_MS,
  shimmerEnergyAt,
  shimmerPosition,
  shimmerWeight,
} from "./presets/shimmer.js";
import {
  colorizeHexText,
  interpolateHexColor,
  ORB_THEMES,
  type OrbThemeName,
} from "./themes.js";
import type { MotionComponent, MotionLease } from "./types.js";

export interface StreamingTextOptions {
  readonly text?: string;
  readonly active?: boolean;
  readonly tailLength?: number;
  readonly theme?: OrbThemeName;
  readonly speed?: OrbSpeed;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function sanitizeText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, " ");
}

function validateTailLength(tailLength: number): number {
  if (!Number.isFinite(tailLength) || tailLength < 1) {
    throw new RangeError("Shimmer tail length must be a positive finite number.");
  }
  return Math.max(6, Math.min(10, Math.floor(tailLength)));
}

export class StreamingText implements MotionComponent {
  readonly #host: MotionHost;
  #text: string;
  #theme: OrbThemeName;
  #speed: OrbSpeed;
  #tailLength: number;
  #active: boolean;
  #lease: MotionLease | undefined;
  #anchorAt = 0;
  #disposed = false;

  constructor(host: MotionHost, options: StreamingTextOptions = {}) {
    this.#host = host;
    this.#text = sanitizeText(options.text ?? "");
    this.#theme = options.theme ?? "openai";
    this.#speed = options.speed ?? "normal";
    this.#tailLength = validateTailLength(options.tailLength ?? 8);
    this.#active = options.active ?? false;
    this.#anchorAt = host.now();
    this.#syncLease();
  }

  get running(): boolean {
    return this.#active;
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

  start(): void {
    if (this.#disposed) throw new Error("Motion component has been disposed.");
    if (this.#active) return;
    this.#active = true;
    this.#anchorAt = this.#host.now();
    this.#syncLease();
    this.#host.requestRender();
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#releaseLease();
    this.#host.requestRender();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#active = false;
    this.#releaseLease();
    this.#disposed = true;
  }

  invalidate(): void {
    // Rendering is time-derived and uncached.
  }

  setText(text: string): void {
    const sanitized = sanitizeText(text);
    if (sanitized === this.#text) return;
    this.#text = sanitized;
    this.#anchorAt = this.#host.now();
    this.#syncLease();
    this.#host.requestRender();
  }

  append(delta: string): void {
    const sanitized = sanitizeText(delta);
    if (sanitized.length === 0) return;
    this.#text += sanitized;
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
    this.#speed = speed;
    this.#host.requestRender();
  }

  setTailLength(tailLength: number): void {
    const validated = validateTailLength(tailLength);
    if (validated === this.#tailLength) return;
    this.#tailLength = validated;
    this.#host.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [""];
    if (
      !this.#active
      || this.#host.motion === "reduced"
      || this.#host.color !== "always"
      || this.#text.length === 0
    ) {
      return wrapTextWithAnsi(this.#text, safeWidth);
    }

    const segments = [...graphemeSegmenter.segment(this.#text)].map(({ segment }) => segment);
    let finalContentIndex = segments.length - 1;
    while (finalContentIndex >= 0 && /^\s+$/u.test(segments[finalContentIndex] ?? "")) {
      finalContentIndex -= 1;
    }

    const tailIndices: number[] = [];
    let tailColumns = 0;
    for (let index = finalContentIndex; index >= 0 && tailIndices.length < 10; index -= 1) {
      const segment = segments[index];
      if (segment === undefined || segment === "\n") continue;
      tailIndices.unshift(index);
      tailColumns += Math.max(0, visibleWidth(segment));
      if (
        tailIndices.length >= 6
        && (tailIndices.length >= this.#tailLength || tailColumns >= 12)
      ) break;
    }

    const tailPosition = new Map<number, { readonly center: number }>();
    let columnsBefore = 0;
    for (const segmentIndex of tailIndices) {
      const segmentWidth = Math.max(0, visibleWidth(segments[segmentIndex] ?? ""));
      tailPosition.set(segmentIndex, {
        center: (columnsBefore + (segmentWidth / 2)) / Math.max(1, tailColumns),
      });
      columnsBefore += segmentWidth;
    }
    const sweep = shimmerPosition(
      Math.max(0, this.#host.now() - this.#anchorAt),
      SHIMMER_PERIODS[this.#speed],
      "left-to-right",
      "wrap",
      "linear",
    );
    const center = -0.45 + (1.9 * sweep.position);
    const theme = ORB_THEMES[this.#theme];

    const styled = segments.map((segment, index) => {
      const position = tailPosition.get(index);
      if (position === undefined) return segment;
      const glow = shimmerEnergyAt(position.center, center, 0.18);
      const weight = shimmerWeight(glow);
      if (weight === 0) return segment;
      const color = interpolateHexColor(theme.label, theme.core, weight);
      return colorizeHexText(segment, color);
    }).join("");

    return wrapTextWithAnsi(styled, safeWidth);
  }

  #syncLease(): void {
    const shouldAnimate = (
      this.#active
      && this.#text.length > 0
      && this.#host.motion === "full"
      && this.#host.color === "always"
    );
    if (!shouldAnimate) {
      this.#releaseLease();
      return;
    }
    if (this.#lease !== undefined) return;
    this.#lease = this.#host.retain(SHIMMER_TICK_MS);
  }

  #releaseLease(): void {
    const lease = this.#lease;
    this.#lease = undefined;
    lease?.release();
  }
}
