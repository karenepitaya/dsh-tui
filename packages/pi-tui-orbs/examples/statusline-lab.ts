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
  type ChoiceControl,
  colorizeThemeText,
  type ControlPanel,
  createOrbsRuntime,
  type ModelStatusline,
  type OrbsRuntime,
  ORB_THEMES,
  ORB_THEME_NAMES,
  type OrbThemeName,
  type SliderControl,
} from "../src/index.js";

type LabMode = "Chat" | "Build" | "Plan" | "Review";
type LabModel = "MiMo-V2.5-Pro" | "Claude-Sonnet" | "GPT-5";
type LabEffort = "low" | "medium" | "high" | "xhigh";
type LabStatus = "idle" | "active" | "complete" | "error";

const CONTEXT_LIMIT = 128_000;
const THEME_LABELS: Readonly<Record<OrbThemeName, string>> = Object.freeze({
  catppuccin: "Catppuccin",
  github: "GitHub",
  claude: "Claude",
  openai: "OpenAI",
  clay: "Clay",
});
const DEFAULTS = Object.freeze({
  mode: "Build" as LabMode,
  model: "MiMo-V2.5-Pro" as LabModel,
  effort: "high" as LabEffort,
  contextPercent: 35,
  status: "active" as LabStatus,
});

function statusLabel(phase: LabStatus): string {
  switch (phase) {
    case "idle": return "Ready";
    case "active": return "Generating";
    case "complete": return "Done";
    case "error": return "Retry needed";
  }
}

class StatuslineLab implements Component {
  readonly #runtime: OrbsRuntime;
  readonly #host: OrbsRuntime["host"];
  readonly #statusline: ModelStatusline;
  readonly #modeControl: ChoiceControl<LabMode>;
  readonly #modelControl: ChoiceControl<LabModel>;
  readonly #effortControl: ChoiceControl<LabEffort>;
  readonly #contextControl: SliderControl;
  readonly #statusControl: ChoiceControl<LabStatus>;
  readonly #panel: ControlPanel;
  #syncing = false;

  constructor(runtime: OrbsRuntime) {
    this.#runtime = runtime;
    this.#host = runtime.host;
    this.#statusline = runtime.createModelStatusline({
      mode: DEFAULTS.mode,
      model: DEFAULTS.model,
      effort: DEFAULTS.effort,
      context: this.#context(DEFAULTS.contextPercent),
      status: this.#status(DEFAULTS.status),
    });

    this.#modeControl = runtime.createChoiceControl({
      label: "Mode",
      value: DEFAULTS.mode,
      choices: [
        { value: "Chat", label: "Chat" },
        { value: "Build", label: "Build" },
        { value: "Plan", label: "Plan" },
        { value: "Review", label: "Review" },
      ],
      onChange: (mode) => this.#update(() => this.#statusline.update({ mode })),
    });
    this.#modelControl = runtime.createChoiceControl({
      label: "Model",
      value: DEFAULTS.model,
      choices: [
        { value: "MiMo-V2.5-Pro", label: "MiMo-V2.5-Pro" },
        { value: "Claude-Sonnet", label: "Claude-Sonnet" },
        { value: "GPT-5", label: "GPT-5" },
      ],
      onChange: (model) => this.#update(() => this.#statusline.update({ model })),
    });
    this.#effortControl = runtime.createChoiceControl({
      label: "Effort",
      value: DEFAULTS.effort,
      choices: [
        { value: "low", label: "low" },
        { value: "medium", label: "medium" },
        { value: "high", label: "high" },
        { value: "xhigh", label: "xhigh" },
      ],
      onChange: (effort) => this.#update(() => this.#statusline.update({ effort })),
    });
    this.#contextControl = runtime.createSliderControl({
      label: "Context",
      min: 0,
      max: 100,
      step: 5,
      value: DEFAULTS.contextPercent,
      formatValue: (value) => `${value}%`,
      onChange: (value) => this.#update(() => {
        this.#statusline.update({ context: this.#context(value) });
      }),
    });
    this.#statusControl = runtime.createChoiceControl({
      label: "Status",
      value: DEFAULTS.status,
      choices: [
        { value: "idle", label: "idle" },
        { value: "active", label: "active" },
        { value: "complete", label: "complete" },
        { value: "error", label: "error" },
      ],
      onChange: (status) => this.#update(() => {
        this.#statusline.update({ status: this.#status(status) });
      }),
    });
    this.#panel = runtime.createControlPanel([
      this.#modeControl,
      this.#modelControl,
      this.#effortControl,
      this.#contextControl,
      this.#statusControl,
    ]);
  }

  invalidate(): void {
    this.#statusline.invalidate();
    this.#panel.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [""];
    const compactWidth = Math.min(48, Math.max(0, safeWidth - 2));
    const liveTitle = this.#pair(
      this.#style("Live specimen", "label"),
      this.#style(`${safeWidth} cells · responsive`, "muted"),
      safeWidth,
    );
    const controlsTitle = this.#pair(
      this.#style("Controls", "label"),
      this.#style("↑↓ select · ←→ adjust", "muted"),
      safeWidth,
    );
    return [
      this.#title(safeWidth),
      this.#style("One snapshot, two widths — inspect hierarchy, truncation and state color.", "muted"),
      "",
      liveTitle,
      this.#componentLine(safeWidth),
      "",
      this.#style(`Compact preview · fixed ${compactWidth} cells`, "label"),
      `  ${this.#componentLine(compactWidth)}`,
      "",
      controlsTitle,
      ...this.#panel.render(safeWidth),
      "",
      this.#themeLegend(),
      this.#style("↑↓ select  ←→ adjust  1–5 theme  R reset  Q exit", "muted"),
    ].map((line) => this.#fit(line, safeWidth));
  }

  handleControlInput(data: string): boolean {
    return this.#panel.handleInput(data);
  }

  setTheme(theme: OrbThemeName): void {
    this.#runtime.setTheme(theme);
  }

  reset(): void {
    this.#syncing = true;
    try {
      this.#modeControl.setValue(DEFAULTS.mode);
      this.#modelControl.setValue(DEFAULTS.model);
      this.#effortControl.setValue(DEFAULTS.effort);
      this.#contextControl.setValue(DEFAULTS.contextPercent);
      this.#statusControl.setValue(DEFAULTS.status);
    } finally {
      this.#syncing = false;
    }
    this.#statusline.update({
      mode: DEFAULTS.mode,
      model: DEFAULTS.model,
      effort: DEFAULTS.effort,
      context: this.#context(DEFAULTS.contextPercent),
      status: this.#status(DEFAULTS.status),
    });
  }

  dispose(): void {
    this.#runtime.destroy(this.#statusline);
  }

  #update(action: () => void): void {
    if (this.#syncing) return;
    action();
  }

  #context(percent: number): { readonly used: number; readonly limit: number } {
    return {
      used: Math.round(CONTEXT_LIMIT * percent / 100),
      limit: CONTEXT_LIMIT,
    };
  }

  #status(phase: LabStatus): { readonly phase: LabStatus; readonly label: string } {
    return { phase, label: statusLabel(phase) };
  }

  #componentLine(width: number): string {
    if (width <= 0) return "";
    return this.#fit(this.#statusline.render(width)[0] ?? "", width);
  }

  #title(width: number): string {
    return this.#pair(
      this.#style("pi-tui-orbs · Model Statusline Lab", "label"),
      this.#style(ORB_THEMES[this.#runtime.theme].name, "high"),
      width,
    );
  }

  #themeLegend(): string {
    const themes = ORB_THEME_NAMES.map((theme, index) => {
      const token = theme === this.#runtime.theme ? "high" : "muted";
      return this.#style(`[${index + 1}] ${THEME_LABELS[theme]}`, token);
    });
    return `Themes  ${themes.join("  ")}`;
  }

  #pair(left: string, right: string, width: number): string {
    const gap = width - visibleWidth(left) - visibleWidth(right);
    if (gap < 2) return this.#fit(`${left}  ${right}`, width);
    return `${left}${" ".repeat(gap)}${right}`;
  }

  #style(text: string, token: "label" | "muted" | "high"): string {
    if (this.#host.color !== "always") return text;
    return colorizeThemeText(text, token, ORB_THEMES[this.#runtime.theme]);
  }

  #fit(text: string, width: number): string {
    const output = truncateToWidth(text, width, "");
    return this.#host.color === "always" ? output : stripTerminalSequences(output);
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
const lab = new StatuslineLab(runtime);
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

  if (/^[1-5]$/u.test(data)) {
    const selected = ORB_THEME_NAMES[Number(data) - 1];
    if (selected !== undefined) lab.setTheme(selected);
  } else if (data.toLowerCase() === "r") lab.reset();
  else return;
  return { consume: true };
});

process.once("SIGINT", stop);
tui.start();
