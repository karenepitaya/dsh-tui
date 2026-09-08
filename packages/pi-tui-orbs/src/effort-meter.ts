import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { MotionHost } from "./motion-host.js";
import {
  colorizeHexText,
  colorizeThemeText,
  ORB_THEMES,
  type OrbThemeName,
} from "./themes.js";

export const MODEL_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export const EFFORT_METER_COMPACT_WIDTH = 6;
export const EFFORT_METER_FULL_WIDTH = 13;

export interface EffortMeterOptions {
  readonly effort: ModelEffort;
  readonly theme?: OrbThemeName;
}

type EffortMeterHost = Pick<MotionHost, "glyphs" | "color" | "requestRender">;

const TRACK_CELLS = 4;
const EFFORT_LEVELS: Readonly<Record<ModelEffort, number>> = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
});

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function validateEffort(effort: ModelEffort): ModelEffort {
  if (!(MODEL_EFFORTS as readonly string[]).includes(effort)) {
    throw new RangeError(`Unknown model effort: ${String(effort)}.`);
  }
  return effort;
}

/** A static, four-level horizontal meter for model reasoning effort. */
export class EffortMeter implements Component {
  readonly #host: EffortMeterHost;
  #effort: ModelEffort;
  #theme: OrbThemeName;

  constructor(host: EffortMeterHost, options: EffortMeterOptions) {
    this.#host = host;
    this.#effort = validateEffort(options.effort);
    this.#theme = options.theme ?? "openai";
  }

  get effort(): ModelEffort {
    return this.#effort;
  }

  get theme(): OrbThemeName {
    return this.#theme;
  }

  invalidate(): void {
    // Rendering is derived directly from the current value.
  }

  setEffort(effort: ModelEffort, requestRender = true): void {
    const validated = validateEffort(effort);
    if (validated === this.#effort) return;
    this.#effort = validated;
    if (requestRender) this.#host.requestRender();
  }

  setTheme(theme: OrbThemeName, requestRender = true): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    if (requestRender) this.#host.requestRender();
  }

  render(width: number): string[] {
    const available = safeWidth(width);
    if (available === 0) return [""];

    const trackCells = Math.min(TRACK_CELLS, Math.max(0, available - 2));
    const meter = this.#renderMeter(trackCells);
    const label = this.#renderLabel();
    const full = `${meter} ${label}`;
    const content = available >= EFFORT_METER_FULL_WIDTH && visibleWidth(full) <= available
      ? full
      : meter;
    const fitted = visibleWidth(content) <= available
      ? content
      : truncateToWidth(content, available, "");
    return [this.#host.color === "always" ? fitted : stripTerminalSequences(fitted)];
  }

  #renderMeter(trackCells: number): string {
    const palette = ORB_THEMES[this.#theme];
    const activeGlyph = this.#host.glyphs === "ascii" ? "=" : "━";
    const inactiveGlyph = this.#host.glyphs === "ascii" ? "-" : "─";
    const filled = trackCells === 0
      ? 0
      : Math.max(1, Math.ceil((EFFORT_LEVELS[this.#effort] / TRACK_CELLS) * trackCells));
    const active = activeGlyph.repeat(filled);
    const inactive = inactiveGlyph.repeat(trackCells - filled);
    if (this.#host.color !== "always") return `[${active}${inactive}]`;

    const effortColor = {
      low: palette.low,
      medium: palette.medium,
      high: palette.high,
      xhigh: palette.core,
    }[this.#effort];
    return `${colorizeThemeText("[", "muted", palette)}`
      + `${colorizeHexText(active, effortColor)}`
      + `${colorizeHexText(inactive, palette.low)}`
      + `${colorizeThemeText("]", "muted", palette)}`;
  }

  #renderLabel(): string {
    if (this.#host.color !== "always") return this.#effort;
    const palette = ORB_THEMES[this.#theme];
    const effortColor = {
      low: palette.low,
      medium: palette.medium,
      high: palette.high,
      xhigh: palette.core,
    }[this.#effort];
    return colorizeHexText(this.#effort, effortColor);
  }
}
