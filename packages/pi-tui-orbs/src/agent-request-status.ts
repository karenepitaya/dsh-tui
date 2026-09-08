import {
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { MotionHost } from "./motion-host.js";
import { Orb } from "./orb.js";
import type { OrbSpeed } from "./presets/orbs.js";
import {
  colorizeThemeText,
  ORB_THEMES,
  type OrbThemeName,
  type OrbThemeTextToken,
} from "./themes.js";
import type { MotionComponent } from "./types.js";

export const AGENT_REQUEST_PHASES = [
  "submitted",
  "waiting",
  "reasoning",
  "tool",
  "responding",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type AgentRequestPhase = (typeof AGENT_REQUEST_PHASES)[number];

export const AGENT_REQUEST_TICK_MS = 100;

export interface AgentRequestStatusOptions {
  readonly phase?: AgentRequestPhase;
  readonly description?: string;
  readonly theme?: OrbThemeName;
  readonly speed?: OrbSpeed;
  readonly tickMs?: number;
}

export interface AgentRequestStatusUpdate {
  readonly phase?: AgentRequestPhase;
  readonly description?: string;
}

const PHASE_LABELS: Readonly<Record<AgentRequestPhase, string>> = Object.freeze({
  submitted: "Submitted",
  waiting: "Waiting",
  reasoning: "Thinking",
  tool: "Working",
  responding: "Responding",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
});

const DESCRIPTION_COLUMN_WIDTH = Math.max(
  ...Object.values(PHASE_LABELS).map((label) => label.length),
);

function isActivePhase(phase: AgentRequestPhase): boolean {
  return phase === "submitted"
    || phase === "waiting"
    || phase === "reasoning"
    || phase === "tool"
    || phase === "responding";
}

function sanitizeDescription(description: string): string {
  return stripTerminalSequences(description)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Presents one agent request from local submission through its terminal state.
 * Correlation and durable request ownership stay with the host application;
 * this component owns only compact presentation state and one shared-host lease.
 */
export class AgentRequestStatus implements MotionComponent {
  readonly #host: MotionHost;
  readonly #orb: Orb;
  #phase: AgentRequestPhase;
  #description: string;
  #theme: OrbThemeName;
  #speed: OrbSpeed;
  #disposed = false;

  constructor(host: MotionHost, options: AgentRequestStatusOptions = {}) {
    this.#host = host;
    this.#phase = options.phase ?? "submitted";
    this.#description = sanitizeDescription(options.description ?? "");
    this.#theme = options.theme ?? "openai";
    this.#speed = options.speed ?? "normal";
    this.#orb = new Orb(host, {
      autoplay: isActivePhase(this.#phase),
      theme: this.#theme,
      speed: this.#speed,
      tickMs: options.tickMs ?? AGENT_REQUEST_TICK_MS,
    });
  }

  get running(): boolean {
    return this.#orb.running;
  }

  get phase(): AgentRequestPhase {
    return this.#phase;
  }

  get description(): string {
    return this.#description;
  }

  get theme(): OrbThemeName {
    return this.#theme;
  }

  get speed(): OrbSpeed {
    return this.#speed;
  }

  start(): void {
    if (this.#disposed) throw new Error("Motion component has been disposed.");
    if (isActivePhase(this.#phase)) this.#orb.start();
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

  update(update: AgentRequestStatusUpdate): void {
    const nextPhase = update.phase ?? this.#phase;
    const nextDescription = update.description === undefined
      ? this.#description
      : sanitizeDescription(update.description);
    if (nextPhase === this.#phase && nextDescription === this.#description) return;

    const wasActive = isActivePhase(this.#phase);
    const willBeActive = isActivePhase(nextPhase);
    this.#phase = nextPhase;
    this.#description = nextDescription;

    if (wasActive && !willBeActive) {
      const wasRunning = this.#orb.running;
      this.#orb.stop();
      if (!wasRunning) this.#host.requestRender();
      return;
    }
    if (!wasActive && willBeActive) {
      this.#orb.start();
      return;
    }
    this.#host.requestRender();
  }

  setPhase(phase: AgentRequestPhase): void {
    this.update({ phase });
  }

  setDescription(description: string): void {
    this.update({ description });
  }

  setTheme(theme: OrbThemeName): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    this.#orb.setTheme(theme);
  }

  setSpeed(speed: OrbSpeed): void {
    if (speed === this.#speed) return;
    this.#speed = speed;
    this.#orb.setSpeed(speed);
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [""];

    const active = isActivePhase(this.#phase);
    const icon = active ? (this.#orb.render(1)[0] ?? "") : this.#settledIcon();
    const label = PHASE_LABELS[this.#phase];
    const labelToken: OrbThemeTextToken = this.#phase === "failed"
      ? "error"
      : this.#phase === "cancelled"
        ? "muted"
        : "high";
    const styledLabel = this.#style(label, labelToken);
    const output = this.#description.length === 0
      ? `${icon} ${styledLabel}`
      : `${icon} ${this.#style(label.padEnd(DESCRIPTION_COLUMN_WIDTH), labelToken)}  ${
        this.#style(this.#description, "muted")
      }`;
    return [this.#fit(output, safeWidth)];
  }

  #settledIcon(): string {
    let glyph: string;
    let token: OrbThemeTextToken;
    if (this.#phase === "succeeded") {
      glyph = this.#host.glyphs === "ascii" ? "+" : "✓";
      token = "high";
    } else if (this.#phase === "failed") {
      glyph = this.#host.glyphs === "ascii" ? "x" : "×";
      token = "error";
    } else {
      glyph = this.#host.glyphs === "ascii" ? "-" : "—";
      token = "muted";
    }
    return this.#style(glyph, token);
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
