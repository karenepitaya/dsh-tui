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

export type TodoState = "pending" | "active" | "complete" | "error";

export interface TodoItem {
  readonly title: string;
  readonly state: TodoState;
}

export interface TodoListOptions {
  readonly title?: string;
  readonly items?: readonly TodoItem[];
  readonly theme?: OrbThemeName;
  readonly speed?: OrbSpeed;
}

function sanitizeInline(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeItems(items: readonly TodoItem[]): TodoItem[] {
  const normalized = items.map((item) => ({
    title: sanitizeInline(item.title),
    state: item.state,
  }));
  if (normalized.filter((item) => item.state === "active").length > 1) {
    throw new RangeError("TodoList supports at most one active item.");
  }
  return normalized;
}

function stateLabel(state: TodoState): string {
  return `${state[0]?.toUpperCase() ?? ""}${state.slice(1)}`.padEnd(8);
}

export class TodoList implements MotionComponent {
  readonly #host: MotionHost;
  readonly #orb: Orb;
  #title: string;
  #items: TodoItem[];
  #theme: OrbThemeName;
  #enabled = true;
  #disposed = false;

  constructor(host: MotionHost, options: TodoListOptions = {}) {
    this.#host = host;
    this.#title = sanitizeInline(options.title ?? "Todos");
    this.#items = normalizeItems(options.items ?? []);
    this.#theme = options.theme ?? "openai";
    this.#orb = new Orb(host, {
      theme: this.#theme,
      speed: options.speed ?? "normal",
    });
    this.#syncOrb();
  }

  get running(): boolean {
    return this.#orb.running;
  }

  get items(): readonly TodoItem[] {
    return this.#items.map((item) => ({ ...item }));
  }

  start(): void {
    if (this.#disposed) throw new Error("Motion component has been disposed.");
    this.#enabled = true;
    this.#syncOrb();
  }

  stop(): void {
    this.#enabled = false;
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

  setItems(items: readonly TodoItem[]): void {
    const normalized = normalizeItems(items);
    this.#items = normalized;
    this.#syncOrb();
    this.#host.requestRender();
  }

  setTitle(title: string): void {
    const sanitized = sanitizeInline(title);
    if (sanitized === this.#title) return;
    this.#title = sanitized;
    this.#host.requestRender();
  }

  setTheme(theme: OrbThemeName): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    this.#orb.setTheme(theme);
  }

  setSpeed(speed: OrbSpeed): void {
    this.#orb.setSpeed(speed);
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [""];
    const completeCount = this.#items.filter((item) => item.state === "complete").length;
    const title = this.#style(`${this.#title} · ${completeCount}/${this.#items.length}`, "label");
    const lines = [this.#fit(title, safeWidth)];

    for (const item of this.#items) {
      const marker = this.#marker(item.state);
      const stateToken: OrbThemeTextToken = item.state === "error" ? "error" : "muted";
      const state = this.#style(stateLabel(item.state), stateToken);
      const payload = item.state === "complete"
        ? this.#style(item.title, "muted")
        : item.title;
      lines.push(this.#fit(`  ${marker} ${state} ${payload}`, safeWidth));
    }
    return lines;
  }

  #marker(state: TodoState): string {
    if (state === "active") return `[${this.#orb.render(1)[0] ?? ""}]`;
    const ascii = this.#host.glyphs === "ascii";
    const raw = state === "pending"
      ? (ascii ? "[ ]" : "[□]")
      : state === "complete"
        ? (ascii ? "[x]" : "[✓]")
        : "[!]";
    const token: OrbThemeTextToken = state === "error"
      ? "error"
      : state === "complete" ? "high" : "muted";
    return this.#style(raw, token);
  }

  #style(text: string, token: OrbThemeTextToken): string {
    if (this.#host.color !== "always") return text;
    return colorizeThemeText(text, token, ORB_THEMES[this.#theme]);
  }

  #fit(text: string, width: number): string {
    const output = truncateToWidth(text, width, "");
    return this.#host.color === "always" ? output : stripTerminalSequences(output);
  }

  #syncOrb(): void {
    const hasActive = this.#items.some((item) => item.state === "active");
    if (this.#enabled && hasActive) this.#orb.start();
    else this.#orb.stop();
  }
}
