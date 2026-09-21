import { AgentStatus, type AgentStatusOptions } from "./agent-status.js";
import {
  AgentRequestStatus,
  type AgentRequestStatusOptions,
} from "./agent-request-status.js";
import { AnimatedFrames, type AnimatedFramesOptions } from "./animated-frames.js";
import { ExecutionStatus, type ExecutionStatusOptions } from "./execution-status.js";
import { EffortMeter, type EffortMeterOptions } from "./effort-meter.js";
import { GradientBar, type GradientBarOptions } from "./gradient-bar.js";
import {
  ChoiceControl,
  ControlPanel,
  SliderControl,
  ToggleControl,
  type ChoiceControlOptions,
  type LabControl,
  type LabControlOptions,
  type SliderControlOptions,
  type ToggleControlOptions,
} from "./lab-controls.js";
import { ModelStatusline, type ModelStatuslineOptions } from "./model-statusline.js";
import { MotionHost, type MotionHostOptions } from "./motion-host.js";
import { Orb, type OrbOptions } from "./orb.js";
import { ShimmerText, type ShimmerTextOptions } from "./shimmer-text.js";
import { StreamingText, type StreamingTextOptions } from "./streaming-text.js";
import { TodoList, type TodoListOptions } from "./todo-list.js";
import type { OrbTheme, OrbThemeName } from "./themes.js";
import type { MotionComponent } from "./types.js";

export interface OrbsRuntimeOptions extends MotionHostOptions {
  readonly requestRender: () => void;
  readonly theme?: OrbThemeName;
}

interface ThemeAware {
  setTheme(theme: OrbThemeName): void;
}

/**
 * Owns the shared motion host and supplies library-wide defaults to components.
 * Motion components created through this facade are disposed with the runtime;
 * static components follow shared defaults without entering motion ownership.
 * Callers can still use `host` directly when they need lower-level composition.
 */
export class OrbsRuntime {
  readonly host: MotionHost;

  #theme: OrbThemeName;
  #disposed = false;
  readonly #motionComponents = new Set<MotionComponent>();
  readonly #themeFollowers = new Set<ThemeAware>();

  constructor(options: OrbsRuntimeOptions) {
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

  setTheme(theme: OrbThemeName): void {
    this.#assertActive();
    if (theme === this.#theme) return;
    this.#theme = theme;
    for (const component of this.#themeFollowers) component.setTheme(theme);
    // Controls do not own a MotionHost, so a runtime-level theme change must
    // request the render that makes their new palette visible.
    this.host.requestRender();
  }

  createAnimatedFrames(options: AnimatedFramesOptions): AnimatedFrames {
    return this.#trackMotion(new AnimatedFrames(this.#activeHost(), options));
  }

  createOrb(options: OrbOptions = {}): Orb {
    const component = new Orb(this.#activeHost(), this.#withTheme(options));
    return this.#trackThemedMotion(component, options.theme === undefined);
  }

  createShimmerText(options: ShimmerTextOptions = {}): ShimmerText {
    const component = new ShimmerText(this.#activeHost(), this.#withTheme(options));
    return this.#trackThemedMotion(component, options.theme === undefined);
  }

  createGradientBar(options: GradientBarOptions = {}): GradientBar {
    const component = new GradientBar(this.#activeHost(), this.#withTheme(options));
    return this.#trackThemedMotion(component, options.theme === undefined);
  }

  createStreamingText(options: StreamingTextOptions = {}): StreamingText {
    const component = new StreamingText(this.#activeHost(), this.#withTheme(options));
    return this.#trackThemedMotion(component, options.theme === undefined);
  }

  createAgentStatus(options: AgentStatusOptions): AgentStatus {
    const component = new AgentStatus(this.#activeHost(), this.#withTheme(options));
    return this.#trackThemedMotion(component, options.theme === undefined);
  }

  createAgentRequestStatus(options: AgentRequestStatusOptions = {}): AgentRequestStatus {
    const component = new AgentRequestStatus(this.#activeHost(), this.#withTheme(options));
    return this.#trackThemedMotion(component, options.theme === undefined);
  }

  createEffortMeter(options: EffortMeterOptions): EffortMeter {
    const component = new EffortMeter(this.#activeHost(), this.#withTheme(options));
    return this.#trackThemed(component, options.theme === undefined);
  }

  createModelStatusline(options: ModelStatuslineOptions): ModelStatusline {
    const component = new ModelStatusline(this.#activeHost(), this.#withTheme(options));
    return this.#trackThemedMotion(component, options.theme === undefined);
  }

  createExecutionStatus(options: ExecutionStatusOptions): ExecutionStatus {
    const component = new ExecutionStatus(this.#activeHost(), this.#withTheme(options));
    return this.#trackThemedMotion(component, options.theme === undefined);
  }

  createTodoList(options: TodoListOptions = {}): TodoList {
    const component = new TodoList(this.#activeHost(), this.#withTheme(options));
    return this.#trackThemedMotion(component, options.theme === undefined);
  }

  createChoiceControl<T extends string>(options: ChoiceControlOptions<T>): ChoiceControl<T> {
    this.#assertActive();
    const control = new ChoiceControl<T>(this.#withControlDefaults(options));
    return this.#trackThemed(control, options.theme === undefined);
  }

  createSliderControl(options: SliderControlOptions): SliderControl {
    this.#assertActive();
    const control = new SliderControl(this.#withControlDefaults(options));
    return this.#trackThemed(control, options.theme === undefined);
  }

  createToggleControl(options: ToggleControlOptions): ToggleControl {
    this.#assertActive();
    const control = new ToggleControl(this.#withControlDefaults(options));
    return this.#trackThemed(control, options.theme === undefined);
  }

  createControlPanel(controls: readonly LabControl[]): ControlPanel {
    this.#assertActive();
    return new ControlPanel(controls, {
      requestRender: () => this.host.requestRender(),
    });
  }

  destroy(component: MotionComponent): boolean {
    if (!this.#motionComponents.delete(component)) return false;
    this.#themeFollowers.delete(component as MotionComponent & ThemeAware);
    component.dispose();
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const component of [...this.#motionComponents]) this.destroy(component);
    this.#themeFollowers.clear();
    this.host.dispose();
  }

  #activeHost(): MotionHost {
    this.#assertActive();
    return this.host;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("OrbsRuntime has been disposed.");
  }

  #withTheme<T extends { readonly theme?: OrbThemeName }>(options: T): T & { theme: OrbThemeName } {
    return { ...options, theme: options.theme ?? this.#theme };
  }

  #withControlDefaults<T extends LabControlOptions>(
    options: T,
  ): T & {
    theme: OrbThemeName | OrbTheme;
    glyphs: "unicode" | "ascii";
    color: "always" | "never";
  } {
    return {
      ...options,
      theme: options.theme ?? this.#theme,
      glyphs: options.glyphs ?? this.host.glyphs,
      color: options.color ?? this.host.color,
    };
  }

  #trackMotion<T extends MotionComponent>(component: T): T {
    this.#motionComponents.add(component);
    return component;
  }

  #trackThemed<T extends ThemeAware>(component: T, followsTheme: boolean): T {
    if (followsTheme) this.#themeFollowers.add(component);
    return component;
  }

  #trackThemedMotion<T extends MotionComponent & ThemeAware>(
    component: T,
    followsTheme: boolean,
  ): T {
    this.#trackMotion(component);
    return this.#trackThemed(component, followsTheme);
  }
}

export function createOrbsRuntime(options: OrbsRuntimeOptions): OrbsRuntime {
  return new OrbsRuntime(options);
}
