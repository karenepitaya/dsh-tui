import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { MotionHost } from "./motion-host.js";
import type { OrbSpeed } from "./presets/orbs.js";
import {
  gradientBarCellEnergy,
  gradientBarPosition,
  GRADIENT_BAR_PERIODS,
  GRADIENT_BAR_TICK_MS,
} from "./presets/gradient-bars.js";
import {
  colorizeHexText,
  interpolateHexColor,
  ORB_THEMES,
  type OrbThemeName,
} from "./themes.js";
import type { MotionComponent, MotionLease } from "./types.js";

export interface GradientBarOptions {
  readonly cells?: number;
  readonly autoplay?: boolean;
  readonly theme?: OrbThemeName;
  readonly speed?: OrbSpeed;
}

const MIN_CELLS = 4;
const MAX_CELLS = 32;
const UNICODE_DENSITY = ["▁", "▂", "▄", "▆", "█"] as const;
const ASCII_DENSITY = [" ", ".", ":", "=", "#"] as const;

function validateCells(cells: number): number {
  if (!Number.isInteger(cells) || cells < MIN_CELLS || cells > MAX_CELLS) {
    throw new RangeError(`Gradient bar cells must be an integer from ${MIN_CELLS} to ${MAX_CELLS}.`);
  }
  return cells;
}

function densityIndex(energy: number): number {
  return Math.min(4, Math.max(0, Math.round(Math.max(0, Math.min(1, energy)) * 4)));
}

export class GradientBar implements MotionComponent {
  readonly #host: MotionHost;
  #cells: number;
  #theme: OrbThemeName;
  #speed: OrbSpeed;
  #lease: MotionLease | undefined;
  #phaseAnchorAt = 0;
  #phaseOffset = 0;
  #running = false;
  #disposed = false;

  constructor(host: MotionHost, options: GradientBarOptions = {}) {
    this.#host = host;
    this.#cells = validateCells(options.cells ?? 8);
    this.#theme = options.theme ?? "openai";
    this.#speed = options.speed ?? "normal";
    if (options.autoplay === true) this.start();
  }

  get running(): boolean {
    return this.#running;
  }

  get cells(): number {
    return this.#cells;
  }

  get theme(): OrbThemeName {
    return this.#theme;
  }

  get speed(): OrbSpeed {
    return this.#speed;
  }

  start(): void {
    if (this.#disposed) throw new Error("Motion component has been disposed.");
    if (this.#running) return;
    this.#phaseOffset = 0;
    this.#phaseAnchorAt = this.#host.now();
    this.#running = true;
    if (this.#host.motion === "full") {
      try {
        this.#lease = this.#host.retain(GRADIENT_BAR_TICK_MS);
      } catch (error) {
        this.#running = false;
        throw error;
      }
    } else {
      this.#host.requestRender();
    }
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    const lease = this.#lease;
    this.#lease = undefined;
    lease?.release();
    if (lease === undefined) this.#host.requestRender();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
  }

  invalidate(): void {
    // Rendering is time-derived and uncached.
  }

  setCells(cells: number): void {
    const validated = validateCells(cells);
    if (validated === this.#cells) return;
    this.#cells = validated;
    this.#host.requestRender();
  }

  setTheme(theme: OrbThemeName): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    this.#host.requestRender();
  }

  setSpeed(speed: OrbSpeed): void {
    if (speed === this.#speed) return;
    const now = this.#host.now();
    this.#phaseOffset = this.#currentPhase(now);
    this.#phaseAnchorAt = now;
    this.#speed = speed;
    this.#host.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [""];
    const cellCount = Math.min(this.#cells, safeWidth);
    const animated = (
      this.#running
      && this.#lease !== undefined
      && this.#host.motion === "full"
    );
    const position = animated
      ? gradientBarPosition(
        this.#currentPhase(this.#host.now()) * GRADIENT_BAR_PERIODS[this.#speed],
        GRADIENT_BAR_PERIODS[this.#speed],
      )
      : 0.5;
    const palette = ORB_THEMES[this.#theme];
    const colorsEnabled = this.#host.color === "always";

    const output = Array.from({ length: cellCount }, (_, index) => {
      const energy = gradientBarCellEnergy(index, cellCount, position);
      if (!colorsEnabled) {
        const ramp = this.#host.glyphs === "ascii" ? ASCII_DENSITY : UNICODE_DENSITY;
        return ramp[densityIndex(energy)] ?? ramp[0];
      }
      const glyph = this.#host.glyphs === "ascii" ? "=" : "▄";
      const color = interpolateHexColor(palette.low, palette.core, 0.06 + (0.94 * energy));
      return colorizeHexText(glyph, color);
    }).join("");

    return [colorsEnabled ? output : stripTerminalSequences(output)];
  }

  #currentPhase(now: number): number {
    if (!this.#running || this.#lease === undefined) return this.#phaseOffset;
    const periodMs = GRADIENT_BAR_PERIODS[this.#speed];
    const elapsedPeriods = Math.max(0, now - this.#phaseAnchorAt) / periodMs;
    return (this.#phaseOffset + elapsedPeriods) % 1;
  }
}
