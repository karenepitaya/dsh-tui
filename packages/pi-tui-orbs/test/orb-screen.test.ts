import { Terminal as HeadlessTerminal } from "@xterm/headless";
import {
  Container,
  ScrollView,
  Text,
  type Terminal,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GradientBar,
  GRADIENT_BAR_PERIODS,
  ModelStatusline,
  MotionHost,
  Orb,
  ORB_SPEEDS,
  SHIMMER_VELOCITIES,
  ShimmerText,
} from "../src/index.js";

class RecordingTerminal implements Terminal {
  readonly writes: string[] = [];
  readonly columns: number;
  readonly rows: number;
  readonly kittyProtocolActive = false;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
  }

  start(): void {}
  stop(): void {}
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.writes.push(data); }
  moveBy(lines: number): void {
    if (lines > 0) this.write(`\x1b[${lines}B`);
    if (lines < 0) this.write(`\x1b[${-lines}A`);
  }
  hideCursor(): void { this.write("\x1b[?25l"); }
  showCursor(): void { this.write("\x1b[?25h"); }
  clearLine(): void { this.write("\x1b[K"); }
  clearFromCursor(): void { this.write("\x1b[J"); }
  clearScreen(): void { this.write("\x1b[2J\x1b[H"); }
  setTitle(): void {}
  setProgress(): void {}
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pi-tui visible screen integration", () => {
  it("updates the visible cell frame through pi-tui differential rendering", async () => {
    let now = 0;
    const terminal = new RecordingTerminal(24, 4);
    const tui = new TuiMainScreen(terminal);
    const host = new MotionHost(() => tui.requestRender(), {
      motion: "full",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const orb = new Orb(host, {
      label: "Thinking",
      theme: "catppuccin",
      speed: "fast",
    });
    tui.addChild(orb);
    orb.start();

    const screen = new HeadlessTerminal({ cols: 24, rows: 4, allowProposedApi: true });
    tui.renderNow(true);
    await writeHeadless(screen, terminal.writes.join(""));
    let consumed = terminal.writes.length;
    expect(lineAt(screen, 0)).toContain("· Thinking");

    now = ORB_SPEEDS.fast * 0.3;
    tui.renderNow();
    const delta = terminal.writes.slice(consumed).join("");
    expect(delta.length).toBeGreaterThan(0);
    expect(delta).not.toContain("\x1b[2J");
    await writeHeadless(screen, delta);
    consumed = terminal.writes.length;
    expect(lineAt(screen, 0)).toContain("● Thinking");
    expect(consumed).toBeGreaterThan(0);

    orb.dispose();
    host.dispose();
    screen.dispose();
  });

  it("moves the gradient beam by cell color without changing visible geometry", async () => {
    let now = 0;
    const terminal = new RecordingTerminal(24, 4);
    const tui = new TuiMainScreen(terminal);
    const host = new MotionHost(() => tui.requestRender(), {
      motion: "full",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const bar = new GradientBar(host, {
      cells: 8,
      theme: "github",
      autoplay: true,
    });
    tui.addChild(bar);

    const screen = new HeadlessTerminal({ cols: 24, rows: 4, allowProposedApi: true });
    tui.renderNow(true);
    await writeHeadless(screen, terminal.writes.join(""));
    let consumed = terminal.writes.length;
    expect(lineAt(screen, 0)).toBe("▄".repeat(8));

    now = GRADIENT_BAR_PERIODS.normal / 2;
    tui.renderNow();
    const delta = terminal.writes.slice(consumed).join("");
    expect(delta).toContain("\x1b[38;2;");
    expect(delta).not.toContain("\x1b[2J");
    await writeHeadless(screen, delta);
    consumed = terminal.writes.length;
    expect(lineAt(screen, 0)).toBe("▄".repeat(8));
    expect(consumed).toBeGreaterThan(0);

    bar.dispose();
    host.dispose();
    screen.dispose();
  });

  it("moves a shimmer through text without changing its visible terminal cells", async () => {
    let now = 0;
    const terminal = new RecordingTerminal(60, 4);
    const tui = new TuiMainScreen(terminal);
    const host = new MotionHost(() => tui.requestRender(), {
      motion: "full",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const shimmer = new ShimmerText(host, {
      text: "正在整理工具结果 · final answer",
      active: true,
      theme: "catppuccin",
      bandWidth: 8,
    });
    tui.addChild(shimmer);

    const screen = new HeadlessTerminal({ cols: 60, rows: 4, allowProposedApi: true });
    tui.renderNow(true);
    await writeHeadless(screen, terminal.writes.join(""));
    const visible = "正在整理工具结果 · final answer";
    expect(lineAt(screen, 0)).toBe(visible);
    const consumed = terminal.writes.length;

    now = (((visibleWidth(visible) + 24) / SHIMMER_VELOCITIES.normal) * 1_000) / 2;
    tui.renderNow();
    const delta = terminal.writes.slice(consumed).join("");
    expect(delta).toContain("\x1b[38;2;");
    expect(delta).not.toContain("\x1b[2J");
    await writeHeadless(screen, delta);
    expect(lineAt(screen, 0)).toBe(visible);

    shimmer.dispose();
    host.dispose();
    screen.dispose();
  });

  it("keeps the five-slot model statusline on one visible row across updates", async () => {
    let now = 0;
    const terminal = new RecordingTerminal(80, 4);
    const tui = new TuiMainScreen(terminal);
    const host = new MotionHost(() => tui.requestRender(), {
      motion: "full",
      glyphs: "unicode",
      color: "always",
      isTTY: true,
      now: () => now,
    });
    const statusline = new ModelStatusline(host, {
      mode: "Build",
      model: "MiMo-V2.5-Pro",
      effort: "high",
      context: { used: 26_641, limit: 128_000 },
      status: { phase: "active", label: "Generating" },
      theme: "github",
    });
    tui.addChild(statusline);

    const screen = new HeadlessTerminal({ cols: 80, rows: 4, allowProposedApi: true });
    tui.renderNow(true);
    await writeHeadless(screen, terminal.writes.join(""));
    let visible = lineAt(screen, 0);
    expect(visible).toContain("Build · MiMo-V2.5-Pro · [━━━─] high");
    expect(visible).toContain("ctx ━");
    expect(visible.trimEnd()).toMatch(/21%\s+· [·•●] Generating$/u);
    expect(visibleWidth(visible)).toBeLessThanOrEqual(80);

    const consumed = terminal.writes.length;
    now = ORB_SPEEDS.normal * 0.3;
    statusline.update({
      model: "模型-Long-Context",
      context: { used: 116_000, limit: 128_000 },
    });
    tui.renderNow();
    const delta = terminal.writes.slice(consumed).join("");
    expect(delta).not.toContain("\x1b[2J");
    await writeHeadless(screen, delta);
    visible = lineAt(screen, 0);
    expect(visible).toContain("模型-Long-Co");
    expect(visible).toContain("…");
    expect(visible).toContain("91%");
    expect(visibleWidth(visible)).toBeLessThanOrEqual(80);
    expect(lineAt(screen, 1)).toBe("");

    statusline.dispose();
    host.dispose();
    screen.dispose();
  });

  it("pins a model statusline below a scrolling agent transcript", async () => {
    const terminal = new RecordingTerminal(50, 12);
    const tui = new TuiAltScreen(terminal);
    const host = new MotionHost(() => tui.requestRender(), {
      motion: "full",
      glyphs: "unicode",
      color: "never",
      isTTY: true,
    });
    const transcriptDocument = new Container();
    for (let index = 0; index < 12; index += 1) {
      transcriptDocument.addChild(new Text(`event ${index}`, 0, 0));
    }
    const transcript = new ScrollView(transcriptDocument, {
      follow: "end",
      primary: true,
    });
    const statusline = new ModelStatusline(host, {
      mode: "Build",
      model: "MiMo-V2.5-Pro",
      effort: "high",
      context: { used: 26_641, limit: 128_000 },
      status: { phase: "idle", label: "Ready" },
    });
    tui.setLayoutRoot(new VStack([
      { component: new Text("Agent", 0, 0), basis: 1, shrink: 0 },
      { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: statusline, basis: 1, shrink: 0 },
      { component: new Text("Q exit", 0, 0), basis: 1, shrink: 0 },
    ]));

    const screen = new HeadlessTerminal({ cols: 50, rows: 12, allowProposedApi: true });
    tui.start();
    tui.renderNow(true);
    await writeHeadless(screen, terminal.writes.join(""));
    expect(lineAt(screen, 0).trimEnd()).toBe("Agent");
    expect(lineAt(screen, 10)).toContain("Build · MiMo-V2.5-Pro");
    expect(lineAt(screen, 10)).toMatch(/21%\s+· ○/u);
    expect(lineAt(screen, 11).trimEnd()).toBe("Q exit");

    const consumed = terminal.writes.length;
    transcriptDocument.addChild(new Text("event 12", 0, 0));
    statusline.update({ status: { phase: "complete", label: "Done" } });
    tui.renderNow();
    const delta = terminal.writes.slice(consumed).join("");
    expect(delta).not.toContain("\x1b[2J");
    await writeHeadless(screen, delta);
    expect(lineAt(screen, 9).trimEnd()).toBe("event 12");
    expect(lineAt(screen, 10)).toMatch(/21%\s+· ✓/u);
    expect(lineAt(screen, 11).trimEnd()).toBe("Q exit");

    tui.stop();
    statusline.dispose();
    host.dispose();
    screen.dispose();
  });
});

function lineAt(terminal: HeadlessTerminal, row: number): string {
  return terminal.buffer.active.getLine(row)?.translateToString(true) ?? "";
}

async function writeHeadless(terminal: HeadlessTerminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}
