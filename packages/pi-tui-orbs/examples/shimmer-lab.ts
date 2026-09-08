import {
  type Component,
  Key,
  matchesKey,
  ProcessTerminal,
  stripTerminalSequences,
  truncateToWidth,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  ChoiceControl,
  colorizeThemeText,
  ControlPanel,
  createOrbsRuntime,
  OrbsRuntime,
  ORB_THEMES,
  ORB_THEME_NAMES,
  SHIMMER_VELOCITIES,
  ShimmerText,
  SliderControl,
  ToggleControl,
  type OrbSpeed,
  type OrbThemeName,
  type ShimmerCurve,
  type ShimmerDirection,
  type ShimmerLoop,
} from "../src/index.js";

type LabView = "focus" | "compare";
type PresetId = "a" | "b" | "c";

interface ShimmerPreset {
  readonly name: string;
  readonly speed: OrbSpeed;
  readonly direction: ShimmerDirection;
  readonly loop: ShimmerLoop;
  readonly curve: ShimmerCurve;
  readonly bandWidth: number;
  readonly trailLength: number;
  readonly holdMs: number;
  readonly baseBrightness: number;
  readonly shimmerBrightness: number;
}

const FOCUS_TEXT = "工具调用已经完成，正在整理一段可以直接交付的回答。";
const COMPARE_TEXT = "正在整理工具结果，并生成最终回答。";

const PRESETS: Readonly<Record<PresetId, ShimmerPreset>> = Object.freeze({
  a: Object.freeze({
    name: "Stream",
    speed: "slow",
    direction: "left-to-right",
    loop: "wrap",
    curve: "soft",
    bandWidth: 2,
    trailLength: 12,
    holdMs: 600,
    baseBrightness: 0.10,
    shimmerBrightness: 0.90,
  }),
  b: Object.freeze({
    name: "Comet",
    speed: "fast",
    direction: "right-to-left",
    loop: "once",
    curve: "linear",
    bandWidth: 1,
    trailLength: 7,
    holdMs: 0,
    baseBrightness: 0.05,
    shimmerBrightness: 1,
  }),
  c: Object.freeze({
    name: "Pendulum",
    speed: "slow",
    direction: "left-to-right",
    loop: "ping-pong",
    curve: "soft",
    bandWidth: 3,
    trailLength: 16,
    holdMs: 0,
    baseBrightness: 0.15,
    shimmerBrightness: 0.78,
  }),
});

class ShimmerLab implements Component {
  readonly #runtime: OrbsRuntime;
  readonly #host: OrbsRuntime["host"];
  readonly #focus: ShimmerText;
  readonly #compare: Readonly<Record<PresetId, ShimmerText>>;
  readonly #speedControl: ChoiceControl<OrbSpeed>;
  readonly #directionControl: ChoiceControl<ShimmerDirection>;
  readonly #loopControl: ChoiceControl<ShimmerLoop>;
  readonly #curveControl: ToggleControl;
  readonly #effectControl: ToggleControl;
  readonly #coreControl: SliderControl;
  readonly #trailControl: SliderControl;
  readonly #baseBrightnessControl: SliderControl;
  readonly #shimmerBrightnessControl: SliderControl;
  readonly #holdControl: SliderControl;
  readonly #panel: ControlPanel;
  #view: LabView = "focus";
  #preset: PresetId | undefined = "a";
  #syncingControls = false;

  constructor(runtime: OrbsRuntime) {
    this.#runtime = runtime;
    this.#host = runtime.host;
    this.#focus = runtime.createShimmerText({
      text: FOCUS_TEXT,
      active: true,
      ...this.#motionOptions(PRESETS.a),
    });
    this.#compare = Object.freeze({
      a: this.#createComparison(PRESETS.a),
      b: this.#createComparison(PRESETS.b),
      c: this.#createComparison(PRESETS.c),
    });

    this.#speedControl = runtime.createChoiceControl({
      label: "Speed",
      value: PRESETS.a.speed,
      choices: [
        { value: "slow", label: `Slow · ${SHIMMER_VELOCITIES.slow}c/s` },
        { value: "normal", label: `Normal · ${SHIMMER_VELOCITIES.normal}c/s` },
        { value: "fast", label: `Fast · ${SHIMMER_VELOCITIES.fast}c/s` },
      ],
      onChange: (value) => this.#tune(() => this.#focus.setSpeed(value)),
    });
    this.#directionControl = runtime.createChoiceControl({
      label: "Direction",
      value: PRESETS.a.direction,
      choices: [
        { value: "left-to-right", label: "Left → right" },
        { value: "right-to-left", label: "Right → left" },
      ],
      onChange: (value) => this.#tune(() => this.#focus.setDirection(value)),
    });
    this.#loopControl = runtime.createChoiceControl({
      label: "Loop",
      value: PRESETS.a.loop,
      choices: [
        { value: "wrap", label: "Wrap" },
        { value: "ping-pong", label: "Ping-pong" },
        { value: "once", label: "Once" },
      ],
      onChange: (value) => this.#tune(() => this.#focus.setLoop(value)),
    });
    this.#curveControl = runtime.createToggleControl({
      label: "Soft curve",
      value: PRESETS.a.curve === "soft",
      onLabel: "Soft",
      offLabel: "Linear",
      onChange: (value) => this.#tune(() => this.#focus.setCurve(value ? "soft" : "linear")),
    });
    this.#coreControl = runtime.createSliderControl({
      label: "Core",
      min: 1,
      max: 8,
      step: 1,
      value: PRESETS.a.bandWidth,
      formatValue: (value) => `${value} cells`,
      onChange: (value) => this.#tune(() => this.#focus.setBandWidth(value)),
    });
    this.#trailControl = runtime.createSliderControl({
      label: "Trail",
      min: 2,
      max: 32,
      step: 1,
      value: PRESETS.a.trailLength,
      formatValue: (value) => `${value} cells`,
      onChange: (value) => this.#tune(() => this.#focus.setTrailLength(value)),
    });
    this.#baseBrightnessControl = runtime.createSliderControl({
      label: "Text brightness",
      min: 0,
      max: 1,
      step: 0.05,
      value: PRESETS.a.baseBrightness,
      formatValue: (value) => `${Math.round(value * 100)}%`,
      onChange: (value) => this.#tune(() => this.#focus.setBaseBrightness(value)),
    });
    this.#shimmerBrightnessControl = runtime.createSliderControl({
      label: "Shimmer brightness",
      min: 0,
      max: 1,
      step: 0.05,
      value: PRESETS.a.shimmerBrightness,
      formatValue: (value) => `${Math.round(value * 100)}%`,
      onChange: (value) => this.#tune(() => {
        if (this.#effectControl.value) this.#focus.setShimmerBrightness(value);
      }),
    });
    this.#holdControl = runtime.createSliderControl({
      label: "Hold",
      min: 0,
      max: 2_000,
      step: 100,
      value: PRESETS.a.holdMs,
      formatValue: (value) => `${value} ms`,
      onChange: (value) => this.#tune(() => this.#focus.setHoldMs(value)),
    });
    this.#effectControl = runtime.createToggleControl({
      label: "Effect",
      value: true,
      onChange: (value) => this.#tune(() => {
        this.#focus.setShimmerBrightness(
          value ? this.#shimmerBrightnessControl.value : 0,
        );
      }),
    });
    this.#panel = runtime.createControlPanel([
      this.#speedControl,
      this.#directionControl,
      this.#loopControl,
      this.#curveControl,
      this.#effectControl,
      this.#coreControl,
      this.#trailControl,
      this.#baseBrightnessControl,
      this.#shimmerBrightnessControl,
      this.#holdControl,
    ]);
  }

  invalidate(): void {
    this.#focus.invalidate();
    this.#panel.invalidate();
    for (const specimen of Object.values(this.#compare)) specimen.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [""];
    return this.#view === "focus"
      ? this.#renderFocus(safeWidth)
      : this.#renderCompare(safeWidth);
  }

  applyPreset(id: PresetId): void {
    const preset = PRESETS[id];
    this.#stopCompare();
    this.#view = "focus";
    this.#syncingControls = true;
    try {
      this.#speedControl.setValue(preset.speed);
      this.#directionControl.setValue(preset.direction);
      this.#loopControl.setValue(preset.loop);
      this.#curveControl.setValue(preset.curve === "soft");
      this.#coreControl.setValue(preset.bandWidth);
      this.#trailControl.setValue(preset.trailLength);
      this.#baseBrightnessControl.setValue(preset.baseBrightness);
      this.#shimmerBrightnessControl.setValue(preset.shimmerBrightness);
      this.#holdControl.setValue(preset.holdMs);
      this.#effectControl.setValue(true);
    } finally {
      this.#syncingControls = false;
    }
    this.#focus.setShimmerBrightness(preset.shimmerBrightness);
    this.#preset = id;
    this.#focus.restart();
    this.#host.requestRender();
  }

  setTheme(theme: OrbThemeName): void {
    this.#runtime.setTheme(theme);
  }

  handleControlInput(data: string): boolean {
    return this.#view === "focus" && this.#panel.handleInput(data);
  }

  toggleView(): void {
    if (this.#view === "focus") {
      this.#focus.stop();
      this.#view = "compare";
      for (const specimen of Object.values(this.#compare)) specimen.restart();
    } else {
      this.#stopCompare();
      this.#view = "focus";
      this.#focus.restart();
    }
    this.#host.requestRender();
  }

  togglePause(): void {
    const visible = this.#visibleSpecimens();
    if (visible.some((specimen) => specimen.state === "running")) {
      for (const specimen of visible) specimen.pause();
    } else if (visible.some((specimen) => specimen.state === "paused")) {
      for (const specimen of visible) specimen.resume();
    } else {
      for (const specimen of visible) specimen.restart();
    }
    this.#host.requestRender();
  }

  restart(): void {
    for (const specimen of this.#visibleSpecimens()) specimen.restart();
    this.#host.requestRender();
  }

  dispose(): void {
    this.#runtime.destroy(this.#focus);
    for (const specimen of Object.values(this.#compare)) this.#runtime.destroy(specimen);
  }

  #tune(action: () => void): void {
    action();
    if (!this.#syncingControls) {
      this.#preset = undefined;
      this.#ensureFocusActive();
    }
    this.#host.requestRender();
  }

  #createComparison(preset: ShimmerPreset): ShimmerText {
    return this.#runtime.createShimmerText({
      text: COMPARE_TEXT,
      ...this.#motionOptions(preset),
    });
  }

  #motionOptions(preset: ShimmerPreset): {
    readonly speed: OrbSpeed;
    readonly direction: ShimmerDirection;
    readonly loop: ShimmerLoop;
    readonly curve: ShimmerCurve;
    readonly bandWidth: number;
    readonly trailLength: number;
    readonly holdMs: number;
    readonly baseBrightness: number;
    readonly shimmerBrightness: number;
  } {
    return {
      speed: preset.speed,
      direction: preset.direction,
      loop: preset.loop,
      curve: preset.curve,
      bandWidth: preset.bandWidth,
      trailLength: preset.trailLength,
      holdMs: preset.holdMs,
      baseBrightness: preset.baseBrightness,
      shimmerBrightness: preset.shimmerBrightness,
    };
  }

  #renderFocus(width: number): string[] {
    const presetName = this.#preset === undefined ? "Custom" : PRESETS[this.#preset].name;
    const state = this.#effectControl.value ? this.#focus.state : "effect off";
    const specimenTitle = this.#pair(
      this.#style("Specimen", "label"),
      this.#style(`${presetName} · ${state} · ${ORB_THEMES[this.#runtime.theme].name}`, "muted"),
      width,
    );
    const controlsTitle = this.#pair(
      this.#style("Controls", "label"),
      this.#style("↑↓ select · ←→ adjust · Enter toggle", "muted"),
      width,
    );
    const specimen = this.#focus.render(Math.max(0, width - 2)).map((line) => `  ${line}`);
    return [
      this.#title("Focus", width),
      "",
      specimenTitle,
      `  ${this.#style("Assistant · streaming", "muted")}`,
      ...specimen,
      "",
      controlsTitle,
      ...this.#panel.render(width),
      "",
      this.#fit(
        `Presets  ${this.#presetLabel("a")}   ${this.#presetLabel("b")}   ${this.#presetLabel("c")}`,
        width,
      ),
      this.#fit("Space pause  A/B/C preset  1–5 theme  V compare", width),
      this.#fit("↑↓ select  ←→ adjust  Enter toggle  R replay  Q exit", width),
    ].map((line) => this.#fit(line, width));
  }

  #renderCompare(width: number): string[] {
    const lines = [
      this.#title("Compare", width),
      this.#style("Same sentence · synchronized start · B text / S shimmer brightness.", "muted"),
      "",
    ];
    for (const id of ["a", "b", "c"] as const) {
      const preset = PRESETS[id];
      const specimen = this.#compare[id];
      const arrow = preset.direction === "left-to-right" ? "→" : "←";
      lines.push(this.#fit(
        `${id.toUpperCase()} ${preset.name.padEnd(9)} · ${specimen.state.padEnd(8)} ${arrow} `
        + `${preset.loop}/${preset.curve} · ${SHIMMER_VELOCITIES[preset.speed]}c/s · `
        + `C${preset.bandWidth} T${preset.trailLength} H${preset.holdMs} · `
        + `B${Math.round(preset.baseBrightness * 100)} S${Math.round(preset.shimmerBrightness * 100)}`,
        width,
      ));
      lines.push(...specimen.render(Math.max(0, width - 2)).map((line) => `  ${line}`));
      lines.push("");
    }
    lines.push(this.#style("B = text base · S = moving shimmer. Comet settles after one pass.", "muted"));
    lines.push("");
    lines.push(this.#fit("A/B/C focus preset  1–5 theme  V focus  Space pause  R replay  Q exit", width));
    return lines.map((line) => this.#fit(line, width));
  }

  #title(view: string, width: number): string {
    const left = this.#style("pi-tui-orbs · Shimmer Lab", "label");
    const right = this.#style(view, "high");
    return this.#pair(left, right, width);
  }

  #pair(left: string, right: string, width: number): string {
    const available = width - visibleWidth(left) - visibleWidth(right);
    if (available < 3) return this.#fit(`${left}  ${right}`, width);
    return `${left}${" ".repeat(available)}${right}`;
  }

  #presetLabel(id: PresetId): string {
    const token = id === this.#preset ? "high" : "muted";
    return this.#style(`[${id.toUpperCase()}] ${PRESETS[id].name}`, token);
  }

  #style(text: string, token: "label" | "muted" | "high"): string {
    if (this.#host.color !== "always") return text;
    return colorizeThemeText(text, token, ORB_THEMES[this.#runtime.theme]);
  }

  #fit(text: string, width: number): string {
    const output = truncateToWidth(text, width, "");
    return this.#host.color === "always" ? output : stripTerminalSequences(output);
  }

  #visibleSpecimens(): readonly ShimmerText[] {
    return this.#view === "focus" ? [this.#focus] : Object.values(this.#compare);
  }

  #ensureFocusActive(): void {
    if (this.#focus.state === "idle" || this.#focus.state === "finished") {
      this.#focus.restart();
    }
  }

  #stopCompare(): void {
    for (const specimen of Object.values(this.#compare)) specimen.stop();
  }
}

const tui = new TuiAltScreen(new ProcessTerminal());
const runtime = createOrbsRuntime({
  requestRender: () => tui.requestRender(),
  theme: "catppuccin",
  motion: "full",
  glyphs: "unicode",
  color: "always",
});
const lab = new ShimmerLab(runtime);
let stopped = false;

function stop(): void {
  if (stopped) return;
  stopped = true;
  lab.dispose();
  runtime.dispose();
  tui.stop({ preserveScreen: true });
}

tui.addChild(lab);
tui.addInputListener((data) => {
  if (matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "q") {
    stop();
    return { consume: true };
  }
  if (tui.hasOverlay()) return;
  if (lab.handleControlInput(data)) return { consume: true };

  const key = data.toLowerCase();
  if (/^[1-5]$/u.test(data)) {
    const selected = ORB_THEME_NAMES[Number(data) - 1];
    if (selected !== undefined) lab.setTheme(selected);
  } else if (key === "a" || key === "b" || key === "c") lab.applyPreset(key);
  else if (key === "v") lab.toggleView();
  else if (data === " ") lab.togglePause();
  else if (key === "r") lab.restart();
  else return;
  return { consume: true };
});

process.once("SIGINT", stop);
tui.start();
