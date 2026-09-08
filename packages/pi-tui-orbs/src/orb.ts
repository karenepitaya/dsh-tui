import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { MotionHost } from "./motion-host.js";
import {
  breathEnergy,
  glyphForBreath,
  ORB_SPEEDS,
  ORB_TICK_MS,
  type OrbSpeed,
} from "./presets/orbs.js";
import {
  colorizeOrbGlyph,
  colorizeOrbLabel,
  ORB_THEMES,
  type OrbThemeName,
} from "./themes.js";
import type { MotionComponent, MotionLease } from "./types.js";

export interface OrbOptions {
  readonly label?: string;
  readonly autoplay?: boolean;
  readonly theme?: OrbThemeName;
  readonly speed?: OrbSpeed;
  readonly tickMs?: number;
  readonly styleLine?: (glyph: string, row: number) => string;
  readonly styleLabel?: (label: string) => string;
}

const MIN_TICK_MS = 16;
const MAX_TICK_MS = 1_000;

function validateTickMs(tickMs: number): number {
  if (!Number.isInteger(tickMs) || tickMs < MIN_TICK_MS || tickMs > MAX_TICK_MS) {
    throw new RangeError(
      `Orb tick interval must be an integer from ${MIN_TICK_MS} to ${MAX_TICK_MS} ms.`,
    );
  }
  return tickMs;
}

function sanitizeLabel(label: string): string {
  return stripTerminalSequences(label)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export class Orb implements MotionComponent {
  readonly #host: MotionHost;
  readonly #styleLine: ((glyph: string, row: number) => string) | undefined;
  readonly #styleLabel: ((label: string) => string) | undefined;
  #label: string;
  #theme: OrbThemeName;
  #speed: OrbSpeed;
  readonly #tickMs: number;
  #lease: MotionLease | undefined;
  #phaseAnchorAt = 0;
  #phaseOffset = 0;
  #running = false;
  #disposed = false;

  constructor(host: MotionHost, options: OrbOptions = {}) {
    this.#host = host;
    this.#label = sanitizeLabel(options.label ?? "");
    this.#theme = options.theme ?? "openai";
    this.#speed = options.speed ?? "normal";
    this.#tickMs = validateTickMs(options.tickMs ?? ORB_TICK_MS);
    this.#styleLine = options.styleLine;
    this.#styleLabel = options.styleLabel;
    if (options.autoplay === true) this.start();
  }

  get running(): boolean {
    return this.#running;
  }

  get label(): string {
    return this.#label;
  }

  get theme(): OrbThemeName {
    return this.#theme;
  }

  get speed(): OrbSpeed {
    return this.#speed;
  }

  get tickMs(): number {
    return this.#tickMs;
  }

  start(): void {
    if (this.#disposed) throw new Error("Motion component has been disposed.");
    if (this.#running) return;
    this.#phaseOffset = 0;
    this.#phaseAnchorAt = this.#host.now();
    this.#running = true;
    try {
      this.#lease = this.#host.retain(this.#tickMs);
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
    // Rendering is time-derived and uncached.
  }

  setLabel(label: string): void {
    const sanitized = sanitizeLabel(label);
    if (sanitized === this.#label) return;
    this.#label = sanitized;
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

    const energy = this.#currentEnergy();
    const glyph = glyphForBreath(energy, this.#host.glyphs);
    const colorsEnabled = this.#host.color === "always";
    const theme = ORB_THEMES[this.#theme];
    const renderedGlyph = colorsEnabled
      ? (this.#styleLine?.(glyph, 0) ?? colorizeOrbGlyph(glyph, energy, theme))
      : glyph;

    if (this.#label.length === 0) {
      const output = truncateToWidth(renderedGlyph, safeWidth, "");
      return [colorsEnabled ? output : stripTerminalSequences(output)];
    }

    const renderedLabel = colorsEnabled
      ? (this.#styleLabel?.(this.#label) ?? colorizeOrbLabel(this.#label, theme))
      : this.#label;
    const output = truncateToWidth(`${renderedGlyph} ${renderedLabel}`, safeWidth, "");
    return [colorsEnabled ? output : stripTerminalSequences(output)];
  }

  #currentEnergy(): number {
    if (this.#host.motion === "reduced" || !this.#running || this.#lease === undefined) return 0.55;
    const phase = this.#currentPhase(this.#host.now());
    return breathEnergy(phase * ORB_SPEEDS[this.#speed], ORB_SPEEDS[this.#speed]);
  }

  #currentPhase(now: number): number {
    if (!this.#running || this.#lease === undefined) return this.#phaseOffset;
    const periodMs = ORB_SPEEDS[this.#speed];
    const elapsedPeriods = Math.max(0, now - this.#phaseAnchorAt) / periodMs;
    return (this.#phaseOffset + elapsedPeriods) % 1;
  }
}
