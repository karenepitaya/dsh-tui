import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  EFFORT_METER_COMPACT_WIDTH,
  EFFORT_METER_FULL_WIDTH,
  EffortMeter,
  type ModelEffort,
} from "./effort-meter.js";
import type { MotionHost } from "./motion-host.js";
import { Orb } from "./orb.js";
import type { OrbSpeed } from "./presets/orbs.js";
import {
  colorizeHexText,
  colorizeThemeText,
  ORB_THEMES,
  type OrbThemeName,
  type OrbThemeTextToken,
} from "./themes.js";
import type { MotionComponent } from "./types.js";

export { MODEL_EFFORTS, type ModelEffort } from "./effort-meter.js";

export const MODEL_STATUS_PHASES = ["idle", "active", "complete", "error"] as const;
export type ModelStatusPhase = (typeof MODEL_STATUS_PHASES)[number];

export interface ModelContextUsage {
  readonly used: number;
  readonly limit: number;
}

export interface ModelStatuslineStatus {
  readonly phase: ModelStatusPhase;
  readonly label?: string;
}

export interface ModelStatuslineSnapshot {
  readonly mode: string;
  readonly model: string;
  readonly effort: ModelEffort;
  readonly context: ModelContextUsage;
  readonly status: ModelStatuslineStatus;
}

export interface ModelStatuslineOptions extends ModelStatuslineSnapshot {
  readonly theme?: OrbThemeName;
  readonly speed?: OrbSpeed;
}

type StyledToken = "mode" | "model" | "separator" | "context" | "status";

const CONTEXT_CELLS = 6;
const FULL_MIN_WIDTH = 72;
const COMPACT_MIN_WIDTH = 32;
const FULL_CONTEXT_WIDTH = 27;
const COMPACT_CONTEXT_WIDTH = 15;
const FULL_STATUS_WIDTH = 12;
const DEFAULT_STATUS_LABELS: Readonly<Record<ModelStatusPhase, string>> = Object.freeze({
  idle: "Idle",
  active: "Working",
  complete: "Done",
  error: "Error",
});

const STATIC_STATUS_GLYPHS = Object.freeze({
  unicode: Object.freeze({ idle: "○", complete: "✓", error: "!" }),
  ascii: Object.freeze({ idle: ".", complete: "+", error: "!" }),
});

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function sanitizeInline(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function validateContext(context: ModelContextUsage): ModelContextUsage {
  if (!Number.isFinite(context.used) || context.used < 0) {
    throw new RangeError("Model context usage must be a non-negative finite number.");
  }
  if (!Number.isFinite(context.limit) || context.limit <= 0) {
    throw new RangeError("Model context limit must be a positive finite number.");
  }
  return { used: context.used, limit: context.limit };
}

function sameStatus(left: ModelStatuslineStatus, right: ModelStatuslineStatus): boolean {
  return left.phase === right.phase && left.label === right.label;
}

function sameContext(left: ModelContextUsage, right: ModelContextUsage): boolean {
  return left.used === right.used && left.limit === right.limit;
}

function formatCount(value: number): string {
  const units = [
    { size: 1_000_000_000, suffix: "b" },
    { size: 1_000_000, suffix: "m" },
    { size: 1_000, suffix: "k" },
  ] as const;
  for (const unit of units) {
    if (value < unit.size) continue;
    const scaled = value / unit.size;
    const digits = scaled < 100 && !Number.isInteger(scaled) ? 1 : 0;
    return `${scaled.toFixed(digits)}${unit.suffix}`;
  }
  return String(Math.round(value));
}

export class ModelStatusline implements MotionComponent {
  readonly #host: MotionHost;
  readonly #orb: Orb;
  readonly #effortMeter: EffortMeter;
  #mode: string;
  #model: string;
  #context: ModelContextUsage;
  #status: ModelStatuslineStatus;
  #theme: OrbThemeName;
  #speed: OrbSpeed;
  #disposed = false;

  constructor(host: MotionHost, options: ModelStatuslineOptions) {
    this.#host = host;
    this.#mode = sanitizeInline(options.mode);
    this.#model = sanitizeInline(options.model);
    this.#context = validateContext(options.context);
    this.#status = this.#sanitizeStatus(options.status);
    this.#theme = options.theme ?? "openai";
    this.#speed = options.speed ?? "normal";
    this.#orb = new Orb(host, {
      autoplay: this.#status.phase === "active",
      theme: this.#theme,
      speed: this.#speed,
    });
    this.#effortMeter = new EffortMeter(host, {
      effort: options.effort,
      theme: this.#theme,
    });
  }

  get running(): boolean {
    return this.#orb.running;
  }

  get snapshot(): ModelStatuslineSnapshot {
    return {
      mode: this.#mode,
      model: this.#model,
      effort: this.#effortMeter.effort,
      context: { ...this.#context },
      status: this.#status.label === undefined
        ? { phase: this.#status.phase }
        : { phase: this.#status.phase, label: this.#status.label },
    };
  }

  get mode(): string {
    return this.#mode;
  }

  get model(): string {
    return this.#model;
  }

  get effort(): ModelEffort {
    return this.#effortMeter.effort;
  }

  get context(): ModelContextUsage {
    return { ...this.#context };
  }

  get status(): ModelStatuslineStatus {
    return this.#status.label === undefined
      ? { phase: this.#status.phase }
      : { phase: this.#status.phase, label: this.#status.label };
  }

  get theme(): OrbThemeName {
    return this.#theme;
  }

  get speed(): OrbSpeed {
    return this.#speed;
  }

  start(): void {
    if (this.#disposed) throw new Error("Motion component has been disposed.");
    if (this.#status.phase === "active") this.#orb.start();
  }

  stop(): void {
    this.#orb.stop();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#orb.dispose();
    this.#disposed = true;
  }

  invalidate(): void {
    this.#orb.invalidate();
  }

  update(patch: Partial<ModelStatuslineSnapshot>): void {
    const nextMode = patch.mode === undefined ? this.#mode : sanitizeInline(patch.mode);
    const nextModel = patch.model === undefined ? this.#model : sanitizeInline(patch.model);
    const nextEffort = patch.effort ?? this.#effortMeter.effort;
    const nextContext = patch.context === undefined
      ? this.#context
      : validateContext(patch.context);
    const nextStatus = patch.status === undefined
      ? this.#status
      : this.#sanitizeStatus(patch.status);

    const changed = nextMode !== this.#mode
      || nextModel !== this.#model
      || nextEffort !== this.#effortMeter.effort
      || !sameContext(nextContext, this.#context)
      || !sameStatus(nextStatus, this.#status);
    if (!changed) return;

    const wasActive = this.#status.phase === "active";
    const willBeActive = nextStatus.phase === "active";
    this.#mode = nextMode;
    this.#model = nextModel;
    this.#effortMeter.setEffort(nextEffort, false);
    this.#context = nextContext;
    this.#status = nextStatus;

    let motionRequestedRender = false;
    if (wasActive !== willBeActive) {
      if (willBeActive) {
        const wasRunning = this.#orb.running;
        this.#orb.start();
        motionRequestedRender = !wasRunning;
      } else {
        const wasRunning = this.#orb.running;
        this.#orb.stop();
        motionRequestedRender = wasRunning;
      }
    }
    if (!motionRequestedRender) this.#host.requestRender();
  }

  setTheme(theme: OrbThemeName): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    this.#effortMeter.setTheme(theme, false);
    this.#orb.setTheme(theme);
  }

  setSpeed(speed: OrbSpeed): void {
    if (speed === this.#speed) return;
    this.#speed = speed;
    this.#orb.setSpeed(speed);
  }

  render(width: number): string[] {
    const available = safeWidth(width);
    if (available === 0) return [""];

    if (available >= FULL_MIN_WIDTH) {
      return [this.#renderTier(available, {
        compactEffort: false,
        contextWidth: FULL_CONTEXT_WIDTH,
        includeContextCounts: true,
        includeStatusLabel: true,
        statusWidth: FULL_STATUS_WIDTH,
      })];
    }

    if (available >= COMPACT_MIN_WIDTH) {
      return [this.#renderTier(available, {
        compactEffort: true,
        contextWidth: COMPACT_CONTEXT_WIDTH,
        includeContextCounts: false,
        includeStatusLabel: false,
        statusWidth: 1,
      })];
    }

    const statusGlyph = this.#renderStatus(false);
    const essentials = this.#renderTinyEssentials(available, statusGlyph);
    if (essentials !== undefined) return [this.#finalize(essentials, available)];

    return [this.#finalize(statusGlyph, available)];
  }

  #renderTier(
    width: number,
    options: {
      readonly compactEffort: boolean;
      readonly contextWidth: number;
      readonly includeContextCounts: boolean;
      readonly includeStatusLabel: boolean;
      readonly statusWidth: number;
    },
  ): string {
    const separator = this.#style(" · ", "separator");
    const context = this.#fixedSlot(
      this.#renderContext(options.includeContextCounts),
      options.contextWidth,
    );
    const status = this.#fitSlot(
      this.#renderStatus(options.includeStatusLabel),
      options.statusWidth,
    );
    const reservedRightWidth = options.contextWidth
      + visibleWidth(separator)
      + options.statusWidth;
    const leftWidth = Math.max(0, width - reservedRightWidth - 1);
    const left = this.#renderLeft(leftWidth, options.compactEffort);
    const gap = Math.max(1, width - reservedRightWidth - visibleWidth(left));
    const line = `${left}${" ".repeat(gap)}${context}${separator}${status}`;
    return this.#finalize(line, width);
  }

  #renderLeft(width: number, compactEffort: boolean): string {
    if (width <= 0) return "";
    const separator = this.#style(" · ", "separator");
    const effort = this.#renderEffort(compactEffort);
    const effortBudget = compactEffort
      ? EFFORT_METER_COMPACT_WIDTH
      : EFFORT_METER_FULL_WIDTH;
    const identityWidth = width - visibleWidth(separator) - effortBudget;
    if (identityWidth < 1) return this.#fixedSlot(effort, width);

    const identity = this.#renderIdentity(identityWidth);
    if (visibleWidth(identity) === 0) return this.#fixedSlot(effort, width);
    return `${identity}${separator}${effort}`;
  }

  #renderIdentity(width: number): string {
    if (width <= 0) return "";
    const separator = this.#style(" · ", "separator");
    const separatorWidth = visibleWidth(separator);
    const modeWidth = visibleWidth(this.#mode);
    const modelWidth = visibleWidth(this.#model);

    if (modeWidth === 0) {
      return this.#style(this.#truncatePlain(this.#model, width, true), "model");
    }
    if (modelWidth === 0) {
      return this.#style(this.#truncatePlain(this.#mode, width, true), "mode");
    }
    if (width < separatorWidth + 2) {
      return this.#style(this.#truncatePlain(this.#model, width, true), "model");
    }

    const contentWidth = width - separatorWidth;
    const modeBudget = Math.min(modeWidth, 10, contentWidth - 1);
    const modelBudget = contentWidth - modeBudget;
    const mode = this.#style(this.#truncatePlain(this.#mode, modeBudget, true), "mode");
    const model = this.#style(this.#truncatePlain(this.#model, modelBudget, true), "model");
    return `${mode}${separator}${model}`;
  }

  #fixedSlot(content: string, width: number): string {
    if (width <= 0) return "";
    const fitted = this.#fitSlot(content, width);
    return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
  }

  #fitSlot(content: string, width: number): string {
    if (width <= 0) return "";
    const marker = width > 1 ? (this.#host.glyphs === "ascii" ? "~" : "…") : "";
    return visibleWidth(content) <= width
      ? content
      : truncateToWidth(content, width, marker);
  }

  #sanitizeStatus(status: ModelStatuslineStatus): ModelStatuslineStatus {
    if (status.label === undefined) return { phase: status.phase };
    const label = sanitizeInline(status.label);
    return label.length === 0 ? { phase: status.phase } : { phase: status.phase, label };
  }

  #renderEffort(compact: boolean): string {
    const width = compact ? EFFORT_METER_COMPACT_WIDTH : EFFORT_METER_FULL_WIDTH;
    return this.#effortMeter.render(width)[0] ?? "";
  }

  #renderContext(full: boolean): string {
    const rawRatio = this.#context.used / this.#context.limit;
    const ratio = Math.max(0, Math.min(1, rawRatio));
    const filled = Math.round(ratio * CONTEXT_CELLS);
    const filledGlyph = this.#host.glyphs === "ascii" ? "=" : "━";
    const emptyGlyph = this.#host.glyphs === "ascii" ? "-" : "─";
    const rawFilled = filledGlyph.repeat(filled);
    const rawEmpty = emptyGlyph.repeat(CONTEXT_CELLS - filled);
    const percent = `${Math.round(rawRatio * 100)}%`;
    const percentField = percent.padStart(5);
    const countsField = `${formatCount(this.#context.used)}/${formatCount(this.#context.limit)}`
      .padStart(11);

    if (this.#host.color !== "always") {
      const bar = `${rawFilled}${rawEmpty}`;
      if (!full) return `ctx ${bar}${percentField}`;
      return `ctx ${bar} ${countsField}${percentField}`;
    }

    const theme = ORB_THEMES[this.#theme];
    const activeColor = ratio >= 0.9
      ? theme.error
      : ratio >= 0.7
        ? theme.core
        : theme.high;
    const bar = `${colorizeHexText(rawFilled, activeColor)}${colorizeHexText(rawEmpty, theme.low)}`;
    const styledPercent = colorizeHexText(percentField, activeColor);
    const prefix = colorizeThemeText("ctx", "muted", theme);
    if (!full) return `${prefix} ${bar}${styledPercent}`;
    const counts = colorizeThemeText(
      countsField,
      "muted",
      theme,
    );
    return `${prefix} ${bar} ${counts}${styledPercent}`;
  }

  #renderStatus(includeLabel: boolean): string {
    const glyph = this.#status.phase === "active"
      ? (this.#orb.render(1)[0] ?? "")
      : this.#renderStaticStatusGlyph();
    if (!includeLabel) return glyph;
    const label = this.#status.label ?? DEFAULT_STATUS_LABELS[this.#status.phase];
    return label.length === 0 ? glyph : `${glyph} ${this.#style(label, "status")}`;
  }

  #renderStaticStatusGlyph(): string {
    const phase = this.#status.phase;
    if (phase === "active") return this.#orb.render(1)[0] ?? "";
    const glyph = STATIC_STATUS_GLYPHS[this.#host.glyphs][phase];
    if (this.#host.color !== "always") return glyph;
    const token: OrbThemeTextToken = phase === "error"
      ? "error"
      : phase === "complete"
        ? "high"
        : "muted";
    return colorizeThemeText(glyph, token, ORB_THEMES[this.#theme]);
  }

  #renderTinyEssentials(width: number, status: string): string | undefined {
    const separator = this.#style(" · ", "separator");
    const right = `${this.#style("· ", "separator")}${this.#joinNonEmpty([
      this.#renderPercent(),
      status,
    ], separator)}`;
    const modelWidth = width - visibleWidth(right) - 1;
    if (modelWidth < 1) return undefined;
    const model = this.#truncatePlain(this.#model, modelWidth, true);
    if (visibleWidth(model) === 0) return undefined;
    return this.#layout(this.#style(model, "model"), right, width);
  }

  #renderPercent(): string {
    const rawRatio = this.#context.used / this.#context.limit;
    const ratio = Math.max(0, Math.min(1, rawRatio));
    const percent = `${Math.round(rawRatio * 100)}%`;
    if (this.#host.color !== "always") return percent;
    const theme = ORB_THEMES[this.#theme];
    const color = ratio >= 0.9
      ? theme.error
      : ratio >= 0.7
        ? theme.core
        : theme.high;
    return colorizeHexText(percent, color);
  }

  #truncatePlain(text: string, width: number, ellipsis: boolean): string {
    if (width <= 0) return "";
    const marker = ellipsis && width > 1
      ? (this.#host.glyphs === "ascii" ? "~" : "…")
      : "";
    return stripTerminalSequences(truncateToWidth(text, width, marker));
  }

  #layout(left: string, right: string, width: number): string | undefined {
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    const gap = width - leftWidth - rightWidth;
    if (gap < 1) return undefined;
    return `${left}${" ".repeat(gap)}${right}`;
  }

  #finalize(line: string, width: number): string {
    const output = visibleWidth(line) <= width
      ? line
      : truncateToWidth(line, width, "");
    return this.#host.color === "always" ? output : stripTerminalSequences(output);
  }

  #joinNonEmpty(parts: readonly string[], separator: string): string {
    return parts.filter((part) => visibleWidth(part) > 0).join(separator);
  }

  #style(text: string, token: StyledToken): string {
    if (this.#host.color !== "always" || text.length === 0) return text;
    const theme = ORB_THEMES[this.#theme];
    const mapped: OrbThemeTextToken = token === "mode" || token === "context"
      ? "high"
      : token === "model"
        ? "label"
        : token === "status"
          ? (this.#status.phase === "error" ? "error" : "muted")
          : "muted";
    return colorizeThemeText(text, mapped, theme);
  }
}
