import {
  AgentRequestStatus,
  type AgentRequestStatusOptions,
} from "./agent-request-status.js";
import { MotionHost, type MotionHostOptions } from "./motion-host.js";
import type { OrbThemeName } from "./themes.js";

export interface AgentRequestRuntimeOptions extends MotionHostOptions {
  readonly requestRender: () => void;
  readonly theme?: OrbThemeName;
}

/**
 * A narrow runtime for hosts that only need request-lifecycle presentation.
 * It intentionally avoids loading the root OrbsRuntime component registry.
 */
export class AgentRequestRuntime {
  readonly host: MotionHost;

  #theme: OrbThemeName;
  #disposed = false;
  readonly #statuses = new Set<AgentRequestStatus>();
  readonly #themeFollowers = new Set<AgentRequestStatus>();

  constructor(options: AgentRequestRuntimeOptions) {
    const {
      requestRender,
      theme = "openai",
      motion,
      glyphs,
      color,
      now,
      env,
      isTTY,
    } = options;
    const hostOptions: MotionHostOptions = {
      ...(motion === undefined ? {} : { motion }),
      ...(glyphs === undefined ? {} : { glyphs }),
      ...(color === undefined ? {} : { color }),
      ...(now === undefined ? {} : { now }),
      ...(env === undefined ? {} : { env }),
      ...(isTTY === undefined ? {} : { isTTY }),
    };
    this.host = new MotionHost(requestRender, hostOptions);
    this.#theme = theme;
  }

  get theme(): OrbThemeName {
    return this.#theme;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  createAgentRequestStatus(options: AgentRequestStatusOptions = {}): AgentRequestStatus {
    this.#assertActive();
    const followsTheme = options.theme === undefined;
    const component = new AgentRequestStatus(this.host, {
      ...options,
      theme: options.theme ?? this.#theme,
    });
    this.#statuses.add(component);
    if (followsTheme) this.#themeFollowers.add(component);
    return component;
  }

  setTheme(theme: OrbThemeName): void {
    this.#assertActive();
    if (theme === this.#theme) return;
    this.#theme = theme;
    for (const component of this.#themeFollowers) component.setTheme(theme);
  }

  destroy(component: AgentRequestStatus): boolean {
    if (!this.#statuses.delete(component)) return false;
    this.#themeFollowers.delete(component);
    component.dispose();
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const component of [...this.#statuses]) this.destroy(component);
    this.#themeFollowers.clear();
    this.host.dispose();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("AgentRequestRuntime has been disposed.");
  }
}

export function createAgentRequestRuntime(
  options: AgentRequestRuntimeOptions,
): AgentRequestRuntime {
  return new AgentRequestRuntime(options);
}

export {
  AGENT_REQUEST_PHASES,
  AGENT_REQUEST_TICK_MS,
  AgentRequestStatus,
  type AgentRequestPhase,
  type AgentRequestStatusOptions,
  type AgentRequestStatusUpdate,
} from "./agent-request-status.js";
export {
  MotionHost,
  type MotionHostOptions,
  type MotionLeaseOptions,
} from "./motion-host.js";
export type {
  ColorPreference,
  GlyphPreference,
  MotionComponent,
  MotionLease,
  MotionPreference,
  ResolvedColorPreference,
  ResolvedGlyphPreference,
  ResolvedMotionPreference,
} from "./types.js";
export type { OrbSpeed } from "./presets/orbs.js";
