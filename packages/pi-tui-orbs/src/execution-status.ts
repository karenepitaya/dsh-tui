import {
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { GradientBar } from "./gradient-bar.js";
import type { MotionHost } from "./motion-host.js";
import type { OrbSpeed } from "./presets/orbs.js";
import {
  colorizeThemeText,
  ORB_THEMES,
  type OrbThemeName,
  type OrbThemeTextToken,
} from "./themes.js";
import type { MotionComponent } from "./types.js";

export type ExecutionPhase = "active" | "complete" | "error" | "cancelled";

export interface ExecutionStatusOptions {
  readonly label: string;
  readonly detail?: string;
  readonly phase?: ExecutionPhase;
  readonly elapsedMs?: number;
  readonly interruptible?: boolean;
  readonly interruptHint?: string;
  readonly cells?: number;
  readonly theme?: OrbThemeName;
  readonly speed?: OrbSpeed;
}

function sanitizeInline(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function validateElapsed(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("Execution elapsed time must be a non-negative finite number.");
  }
  return elapsedMs;
}

function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 1_000) return `${Math.round(elapsedMs)} ms`;
  return `${(elapsedMs / 1_000).toFixed(1)} s`;
}

export class ExecutionStatus implements MotionComponent {
  readonly #host: MotionHost;
  readonly #bar: GradientBar;
  #label: string;
  #detail: string;
  #phase: ExecutionPhase;
  #elapsedMs: number;
  #elapsedAnchorAt = 0;
  #interruptible: boolean;
  #interruptHint: string;
  #theme: OrbThemeName;
  #disposed = false;

  constructor(host: MotionHost, options: ExecutionStatusOptions) {
    this.#host = host;
    this.#label = sanitizeInline(options.label);
    if (this.#label.length === 0) throw new RangeError("Execution label cannot be empty.");
    this.#detail = sanitizeInline(options.detail ?? "");
    this.#phase = options.phase ?? "active";
    this.#elapsedMs = validateElapsed(options.elapsedMs ?? 0);
    this.#interruptible = options.interruptible ?? false;
    this.#interruptHint = sanitizeInline(options.interruptHint ?? "esc interrupt");
    this.#theme = options.theme ?? "openai";
    this.#bar = new GradientBar(host, {
      cells: options.cells ?? 8,
      theme: this.#theme,
      speed: options.speed ?? "normal",
      autoplay: false,
    });
    if (this.#phase === "active") {
      this.#elapsedAnchorAt = host.now();
      this.#bar.start();
    }
  }

  get running(): boolean {
    return this.#phase === "active" && this.#bar.running;
  }

  get phase(): ExecutionPhase {
    return this.#phase;
  }

  get elapsedMs(): number {
    return this.#currentElapsed();
  }

  start(): void {
    if (this.#disposed) throw new Error("Motion component has been disposed.");
    if (this.#phase !== "active" || this.#bar.running) return;
    this.#elapsedAnchorAt = this.#host.now();
    this.#bar.start();
  }

  stop(): void {
    if (this.#phase === "active" && this.#bar.running) {
      this.#elapsedMs = this.#currentElapsed();
    }
    this.#bar.stop();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#bar.dispose();
    this.#disposed = true;
  }

  invalidate(): void {
    this.#bar.invalidate();
  }

  setPhase(phase: ExecutionPhase): void {
    if (phase === this.#phase) return;
    if (this.#phase === "active") this.stop();
    this.#phase = phase;
    if (phase === "active") {
      this.#elapsedMs = 0;
      this.#elapsedAnchorAt = this.#host.now();
      this.#bar.start();
    }
    this.#host.requestRender();
  }

  setLabel(label: string): void {
    const sanitized = sanitizeInline(label);
    if (sanitized.length === 0) throw new RangeError("Execution label cannot be empty.");
    if (sanitized === this.#label) return;
    this.#label = sanitized;
    this.#host.requestRender();
  }

  setDetail(detail: string): void {
    const sanitized = sanitizeInline(detail);
    if (sanitized === this.#detail) return;
    this.#detail = sanitized;
    this.#host.requestRender();
  }

  setInterruptible(interruptible: boolean): void {
    if (interruptible === this.#interruptible) return;
    this.#interruptible = interruptible;
    this.#host.requestRender();
  }

  setTheme(theme: OrbThemeName): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    this.#bar.setTheme(theme);
  }

  setSpeed(speed: OrbSpeed): void {
    this.#bar.setSpeed(speed);
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [""];
    if (this.#phase !== "active") return [this.#renderFinished(safeWidth)];

    const separator = this.#style(" · ", "muted");
    const header = this.#style(this.#label, "high")
      + (this.#detail.length === 0 ? "" : separator + this.#detail);
    const headerLine = this.#fit(header, safeWidth);

    const left = "  · ";
    const right = " ·";
    const rawHint = this.#interruptible && this.#interruptHint.length > 0
      ? ` ${this.#interruptHint}`
      : "";
    const minimumBarWidth = 4;
    const fixedWidth = left.length + right.length;
    const showHint = rawHint.length > 0
      && safeWidth >= fixedWidth + minimumBarWidth + rawHint.length;
    const hint = showHint ? this.#style(rawHint, "muted") : "";
    const hintWidth = showHint ? rawHint.length : 0;
    const availableBarWidth = Math.max(0, safeWidth - fixedWidth - hintWidth);
    const bar = this.#bar.render(availableBarWidth)[0] ?? "";
    const activityLine = this.#fit(`${left}${bar}${right}${hint}`, safeWidth);

    return [headerLine, activityLine];
  }

  #renderFinished(width: number): string {
    let glyph: string;
    let token: OrbThemeTextToken;
    let state = "";
    if (this.#phase === "complete") {
      glyph = this.#host.glyphs === "ascii" ? "+" : "✓";
      token = "high";
    } else if (this.#phase === "error") {
      glyph = this.#host.glyphs === "ascii" ? "x" : "×";
      token = "error";
      state = "error";
    } else {
      glyph = this.#host.glyphs === "ascii" ? "-" : "—";
      token = "muted";
      state = "cancelled";
    }

    const parts = [
      `${this.#style(glyph, token)} ${this.#style(this.#label, "high")}`,
      this.#detail,
      state,
      formatElapsed(this.#currentElapsed()),
    ].filter((part) => part.length > 0);
    const separator = this.#style(" · ", "muted");
    return this.#fit(parts.join(separator), width);
  }

  #currentElapsed(): number {
    if (this.#phase === "active" && this.#bar.running) {
      return this.#elapsedMs + Math.max(0, this.#host.now() - this.#elapsedAnchorAt);
    }
    return this.#elapsedMs;
  }

  #style(text: string, token: OrbThemeTextToken): string {
    if (this.#host.color !== "always") return text;
    return colorizeThemeText(text, token, ORB_THEMES[this.#theme]);
  }

  #fit(text: string, width: number): string {
    const output = truncateToWidth(text, width, "");
    return this.#host.color === "always" ? output : stripTerminalSequences(output);
  }
}
