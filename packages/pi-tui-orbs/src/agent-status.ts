import {
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
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

export const AGENT_STATUS_KINDS = [
  "loading",
  "thinking",
  "tool",
] as const;
export type AgentStatusKind = (typeof AGENT_STATUS_KINDS)[number];
export type AgentStatusPhase = "active" | "complete" | "error";

export interface AgentStatusOptions {
  readonly kind: AgentStatusKind;
  readonly phase?: AgentStatusPhase;
  readonly detail?: string;
  readonly theme?: OrbThemeName;
  readonly speed?: OrbSpeed;
}

const STATUS_LABELS: Readonly<Record<AgentStatusKind, string>> = Object.freeze({
  loading: "Loading",
  thinking: "Thinking",
  tool: "Tool Call",
});

function sanitizeDetail(detail: string): string {
  return stripTerminalSequences(detail)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export class AgentStatus implements MotionComponent {
  readonly #host: MotionHost;
  readonly #orb: Orb;
  #kind: AgentStatusKind;
  #phase: AgentStatusPhase;
  #detail: string;
  #theme: OrbThemeName;
  #speed: OrbSpeed;
  #disposed = false;

  constructor(host: MotionHost, options: AgentStatusOptions) {
    this.#host = host;
    this.#kind = options.kind;
    this.#phase = options.phase ?? "active";
    this.#detail = sanitizeDetail(options.detail ?? "");
    this.#theme = options.theme ?? "openai";
    this.#speed = options.speed ?? "normal";
    this.#orb = new Orb(host, {
      theme: this.#theme,
      speed: this.#speed,
      autoplay: this.#phase === "active",
    });
  }

  get running(): boolean {
    return this.#orb.running;
  }

  get kind(): AgentStatusKind {
    return this.#kind;
  }

  get phase(): AgentStatusPhase {
    return this.#phase;
  }

  get detail(): string {
    return this.#detail;
  }

  get theme(): OrbThemeName {
    return this.#theme;
  }

  get speed(): OrbSpeed {
    return this.#speed;
  }

  start(): void {
    if (this.#disposed) throw new Error("Motion component has been disposed.");
    if (this.#phase === "active") this.#orb.start();
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

  setKind(kind: AgentStatusKind): void {
    if (kind === this.#kind) return;
    this.#kind = kind;
    this.#host.requestRender();
  }

  setPhase(phase: AgentStatusPhase): void {
    if (phase === this.#phase) return;
    this.#phase = phase;
    if (phase === "active") this.#orb.start();
    else this.#orb.stop();
    this.#host.requestRender();
  }

  setDetail(detail: string): void {
    const sanitized = sanitizeDetail(detail);
    if (sanitized === this.#detail) return;
    this.#detail = sanitized;
    this.#host.requestRender();
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

    const theme = ORB_THEMES[this.#theme];
    const colorsEnabled = this.#host.color === "always";
    const icon = this.#phase === "active"
      ? (this.#orb.render(1)[0] ?? "")
      : this.#staticIcon(colorsEnabled);
    const hasDetail = this.#detail.length > 0;
    const rawLabel = hasDetail ? STATUS_LABELS[this.#kind].padEnd(9) : STATUS_LABELS[this.#kind];
    const label = colorsEnabled ? colorizeThemeText(rawLabel, "muted", theme) : rawLabel;
    if (!hasDetail) {
      const output = truncateToWidth(`${icon} ${label}`, safeWidth, "");
      return [colorsEnabled ? output : stripTerminalSequences(output)];
    }

    const prefix = `${icon} ${label} `;
    const prefixWidth = 12;
    if (safeWidth <= prefixWidth) {
      const output = truncateToWidth(`${prefix}${this.#detail}`, safeWidth, "");
      return [colorsEnabled ? output : stripTerminalSequences(output)];
    }

    const detailLines = wrapTextWithAnsi(this.#detail, safeWidth - prefixWidth);
    return detailLines.map((detail, index) => {
      const output = index === 0 ? `${prefix}${detail}` : `${" ".repeat(prefixWidth)}${detail}`;
      return colorsEnabled ? output : stripTerminalSequences(output);
    });
  }

  #staticIcon(colorsEnabled: boolean): string {
    let glyph: string;
    let token: OrbThemeTextToken;

    if (this.#phase === "error") {
      glyph = "!";
      token = "error";
    } else {
      glyph = this.#host.glyphs === "ascii" ? "+" : "✓";
      token = "high";
    }

    if (!colorsEnabled) return glyph;
    return colorizeThemeText(glyph, token, ORB_THEMES[this.#theme]);
  }
}
