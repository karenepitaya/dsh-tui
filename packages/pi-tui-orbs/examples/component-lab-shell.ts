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
  colorizeThemeText,
  type ControlPanel,
  createOrbsRuntime,
  type LabControl,
  type OrbsRuntime,
  ORB_THEMES,
  ORB_THEME_NAMES,
  type OrbThemeName,
} from "../src/index.js";

export interface SpecimenBundle {
  readonly component: Component;
  readonly controls: readonly LabControl[];
  reset(): void;
  dispose?(): void;
}

export interface ComponentDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  create(runtime: OrbsRuntime): SpecimenBundle;
}

const THEME_LABELS: Readonly<Record<OrbThemeName, string>> = Object.freeze({
  catppuccin: "Catppuccin",
  github: "GitHub",
  claude: "Claude",
  openai: "OpenAI",
  clay: "Clay",
});

class ComponentLab implements Component {
  readonly #runtime: OrbsRuntime;
  readonly #host: OrbsRuntime["host"];
  readonly #definition: ComponentDefinition;
  readonly #availableOptions: readonly string[];
  readonly #specimen: SpecimenBundle;
  readonly #panel: ControlPanel;

  constructor(
    runtime: OrbsRuntime,
    definition: ComponentDefinition,
    availableOptions: readonly string[],
  ) {
    this.#runtime = runtime;
    this.#host = runtime.host;
    this.#definition = definition;
    this.#availableOptions = availableOptions;
    this.#specimen = definition.create(runtime);
    this.#panel = runtime.createControlPanel(this.#specimen.controls);
  }

  invalidate(): void {
    this.#specimen.component.invalidate();
    this.#panel.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth === 0) return [""];
    const specimenWidth = Math.max(0, safeWidth - 2);
    const specimenLines = this.#specimen.component
      .render(specimenWidth)
      .map((line) => `  ${line}`);
    const controlsTitle = this.#pair(
      this.#style("Controls", "label"),
      this.#style("↑↓ select · ←→ adjust · Enter toggle", "muted"),
      safeWidth,
    );
    return [
      this.#pair(
        this.#style(`pi-tui-orbs · ${this.#definition.title} Lab`, "label"),
        this.#style(ORB_THEMES[this.#runtime.theme].name, "high"),
        safeWidth,
      ),
      this.#style(this.#definition.description, "muted"),
      "",
      this.#style("Live specimen", "label"),
      ...specimenLines,
      "",
      controlsTitle,
      ...this.#panel.render(safeWidth),
      "",
      this.#themeLegend(),
      this.#style("↑↓ select  ←→ adjust  Enter toggle  1–5 theme  R reset  Q exit", "muted"),
      this.#style(
        `Other labs  ${this.#availableOptions.map((id) => `demo:${id}`).join(" · ")}`,
        "muted",
      ),
    ].map((line) => this.#fit(line, safeWidth));
  }

  handleControlInput(data: string): boolean {
    return this.#panel.handleInput(data);
  }

  setTheme(theme: OrbThemeName): void {
    this.#runtime.setTheme(theme);
  }

  reset(): void {
    this.#specimen.reset();
    this.#host.requestRender();
  }

  dispose(): void {
    this.#specimen.dispose?.();
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

export function runComponentLab(
  definition: ComponentDefinition,
  availableOptions: readonly string[],
): void {
  const tui = new TuiAltScreen(new ProcessTerminal());
  const runtime = createOrbsRuntime({
    requestRender: () => tui.requestRender(),
    theme: "catppuccin",
    motion: "full",
    glyphs: "unicode",
    color: "always",
  });
  const lab = new ComponentLab(runtime, definition, availableOptions);
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
}
